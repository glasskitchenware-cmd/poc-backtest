package th.paperbot.backtest;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Date;
import java.text.SimpleDateFormat;
import java.util.Locale;

/**
 * Read-only multi-symbol signal notification scheduler.
 * Scans on CLOSED 5m/15m/1h candles. Android may delay alarms when power restrictions apply.
 * Never sends any orders or infers that experimental signals have verified accuracy.
 */
final class Alerts {
    private static final int JOB_ID = 15;
    private static final String CHANNEL = "signals";
    private static final String PREFS = "alerts";
    private static final String GROUP = "poc_crypto_signals";

    private Alerts() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context context) {
        return prefs(context).getBoolean("enabled", false);
    }

    static boolean isFirstRun(Context context) {
        SharedPreferences p = prefs(context);
        if (p.getBoolean("defaultOn", false)) return false;
        p.edit().putBoolean("defaultOn", true).apply();
        return true;
    }

    static boolean notificationsAllowed(Context context) {
        NotificationManager m = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return m == null || Build.VERSION.SDK_INT < 24 || m.areNotificationsEnabled();
    }

    static int scanMinutes(Context context) {
        int value = prefs(context).getInt("scanMinutes", 15);
        return value == 5 || value == 15 || value == 60 ? value : 15;
    }

    static void setScanMinutes(Context context, int value) {
        if (value != 5 && value != 15 && value != 60) return;
        prefs(context).edit().putInt("scanMinutes", value).apply();
        if (isEnabled(context)) armAlarm(context);
    }

    static void setEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean("enabled", enabled).apply();
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (!enabled) {
            if (scheduler != null) scheduler.cancel(JOB_ID);
            alarms(context).cancel(alarmIntent(context));
            return;
        }
        armAlarm(context);
        if (scheduler != null) {
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, ScanJobService.class))
                    .setPeriodic(15 * 60 * 1000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build();
            scheduler.schedule(job);
        }
    }

    /** Schedule shortly after the NEXT candle boundary. Backup JobScheduler is never exact. */
    static void armAlarm(Context context) {
        long interval = scanMinutes(context) * 60_000L;
        long when = (System.currentTimeMillis() / interval + 1) * interval + 25_000L;
        AlarmManager manager = alarms(context);
        PendingIntent pending = alarmIntent(context);
        if (Build.VERSION.SDK_INT >= 31 && !manager.canScheduleExactAlarms()) {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
        } else if (Build.VERSION.SDK_INT >= 23) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pending);
        } else {
            manager.setExact(AlarmManager.RTC_WAKEUP, when, pending);
        }
    }

    private static AlarmManager alarms(Context context) {
        return (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    }

    private static PendingIntent alarmIntent(Context context) {
        Intent intent = new Intent(context, AlarmReceiver.class).setAction(AlarmReceiver.ACTION_SCAN);
        return PendingIntent.getBroadcast(context, 1, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Each symbol gets its own notification; dedupe independently across foreground / backup scans. */
    static void onScan(Context context, String json) {
        try {
            JSONObject packet = new JSONObject(json);
            if (!packet.optString("error", "").isEmpty()) return;
            JSONArray items = packet.optJSONArray("signals");
            if (items == null || items.length() == 0 || !notificationsAllowed(context)) return;

            long candle = packet.optLong("candle", 0);
            int minutes = packet.optInt("interval_minutes", scanMinutes(context));
            if (minutes != 5 && minutes != 15 && minutes != 60) return;
            long now = System.currentTimeMillis();
            long maxAge = Math.min(minutes * 60_000L, 15 * 60_000L);
            if (candle <= 0 || candle > now + 60_000L || now - candle > maxAge) return;

            SharedPreferences p = prefs(context);
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                String symbol = item.optString("symbol", "").trim();
                String side = item.optString("side", "").trim().toUpperCase(Locale.US);
                if (!symbol.matches("[A-Z0-9]{2,20}USDT") || !(side.equals("LONG") || side.equals("SHORT"))) continue;
                String tf = minutes == 5 ? "M5" : minutes == 15 ? "M15" : "H1";
                String dedup = "sent:" + tf + ":" + symbol + ":" + side;
                if (p.getLong(dedup, -1) >= candle) continue;

                String entry = item.optString("entry", "—");
                String stop = item.optString("sl", "—");
                String tp = item.optString("tp5", "—");
                int leverage = item.optInt("leverage", 0);
                String title = "ทดลอง " + symbol + " " + side + " · " + tf + (leverage > 0 ? " · " + leverage + "x" : "");
                StringBuilder body = new StringBuilder();
                body.append("เข้าอ้างอิง ").append(entry).append("  |  SL ").append(stop)
                    .append("  |  TP 5R ").append(tp);
                int sample = item.optInt("samples", 0);
                double rate = item.optDouble("win_pct", -1);
                if (sample >= 30 && Double.isFinite(rate) && rate >= 0 && rate <= 100) {
                    body.append("\nBacktest ย้อนหลัง ").append(sample).append(" ไม้: ชนะ ")
                        .append(String.format(Locale.US, "%.1f", rate))
                        .append("% (ไม่ใช่โอกาสชนะครั้งนี้)");
                } else {
                    body.append("\nWin rate: ข้อมูลไม่พอ/ยังไม่ผ่านการยืนยัน");
                }
                body.append("\nสัญญาณทดลอง · ตรวจราคา Futures ล่าสุดก่อนตัดสินใจ · ไม่มีการส่งคำสั่ง");
                showSignal(context, title, body.toString(), (dedup + ":" + candle).hashCode());
                p.edit().putLong(dedup, candle).apply();
            }
        } catch (Exception ignored) {
            // Never crash the scanning service on malformed data or disabled notification permissions.
        }
    }

    private static void showSignal(Context context, String title, String text, int id) {
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            ensureChannel(manager);
            Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent tap = PendingIntent.getActivity(context, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
            b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title).setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(tap).setAutoCancel(true)
                .setDefaults(Notification.DEFAULT_ALL)
                .setPriority(Notification.PRIORITY_HIGH)
                .setGroup(GROUP);
            manager.notify(id, b.build());
        } catch (Exception ignored) {}
    }

    static void show(Context context, String title, String text) {
        showSignal(context, title, text, (int)(System.currentTimeMillis() / 1000L));
    }

    private static void ensureChannel(NotificationManager m) {
        if (Build.VERSION.SDK_INT >= 26) {
            m.createNotificationChannel(new NotificationChannel(CHANNEL,
                    "Crypto Signal · หลายเหรียญ", NotificationManager.IMPORTANCE_HIGH));
        }
    }
}
