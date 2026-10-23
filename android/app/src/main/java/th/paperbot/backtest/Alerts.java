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

import org.json.JSONObject;

/**
 * Read-only multi-symbol signal notification scheduler.
 * Scans on CLOSED 5m/15m/1h/4h candles. Android may delay alarms when power restrictions apply.
 * Never sends any orders or infers that experimental signals have verified accuracy.
 */
final class Alerts {
    private static final int JOB_ID = 15;
    private static final String CHANNEL = "signals";
    private static final String PREFS = "alerts";
    private static final String GROUP = "poc_crypto_signals";
    private static final int SUMMARY_ID = 7_000_001;

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
        return validMinutes(value) ? value : 15;
    }

    static boolean validMinutes(int value) {
        return value == 5 || value == 15 || value == 60 || value == 240;
    }

    static void setScanMinutes(Context context, int value) {
        if (!validMinutes(value)) return;
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
            try {
                scheduler.schedule(job);
            } catch (RuntimeException e) {
                // The exact alarm above is the main schedule; a refused backup job must never crash the app.
                recordStatus(context, false, "ตั้งงานสแกนสำรองไม่ได้: " + e.getClass().getSimpleName());
            }
        }
    }

    /** Schedule shortly after the NEXT candle boundary. Backup JobScheduler is never exact. */
    static void armAlarm(Context context) {
        long interval = scanMinutes(context) * 60_000L;
        armAlarmAt(context, (System.currentTimeMillis() / interval + 1) * interval + 25_000L);
    }

    static void armAlarmAt(Context context, long when) {
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

    /**
     * One notification per coin/side/timeframe/closed candle (see SignalAlerts). A packet that failed, is stale,
     * or arrives while notifications are blocked posts nothing, and the dedup marks are only written for
     * notifications actually posted, so a later scan of the same candle can still deliver them.
     */
    static void onScan(Context context, String json) {
        try {
            SharedPreferences p = prefs(context);
            SignalAlerts.Plan plan = SignalAlerts.plan(json, System.currentTimeMillis(), key -> p.getLong(key, -1));
            if (!plan.ok) {
                recordStatus(context, false, plan.status);
                return;
            }
            if (!plan.notes.isEmpty() && !notificationsAllowed(context)) {
                recordStatus(context, false, plan.status + " · แจ้งเตือนถูกปิดในมือถือ จึงไม่ได้เด้ง " + plan.notes.size() + " สัญญาณ");
                return;
            }
            SharedPreferences.Editor edit = p.edit();
            for (SignalAlerts.Note note : plan.notes) {
                showSignal(context, note.title, note.body, note.id(), note.candle, note.color());
                edit.putLong(note.key, note.candle);
            }
            edit.apply();
            if (plan.notes.size() >= 2) {
                showSummary(context, "สัญญาณทดลอง " + plan.notes.size() + " รายการ", SignalAlerts.summaryText(plan.notes));
            }
            recordStatus(context, true, plan.status);
        } catch (Exception error) {
            // Never crash the scanning service on malformed data.
            recordStatus(context, false, "ประมวลผลผลสแกนไม่ได้: " + error.getClass().getSimpleName());
        }
    }

    /** Last scan outcome, shown in the app so failures are visible instead of silent. */
    static void recordStatus(Context context, boolean ok, String text) {
        prefs(context).edit().putLong("lastScanAt", System.currentTimeMillis()).putBoolean("lastScanOk", ok)
                .putString("lastScanText", text == null ? "" : text).apply();
    }

    static String lastStatusJson(Context context) {
        SharedPreferences p = prefs(context);
        try {
            return new JSONObject().put("at", p.getLong("lastScanAt", 0)).put("ok", p.getBoolean("lastScanOk", false))
                    .put("text", p.getString("lastScanText", "")).toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private static void showSignal(Context context, String title, String text, int id, long when, int color) {
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
                .setWhen(when > 0 ? when : System.currentTimeMillis()).setShowWhen(true)
                .setDefaults(Notification.DEFAULT_ALL)
                .setPriority(Notification.PRIORITY_HIGH)
                .setGroup(GROUP);
            if (color != 0) b.setColor(color);
            manager.notify(id, b.build());
        } catch (Exception ignored) {}
    }

    static void show(Context context, String title, String text) {
        showSignal(context, title, text, (int)(System.currentTimeMillis() / 1000L), 0, 0);
    }

    private static void showSummary(Context context, String title, String text) {
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            ensureChannel(manager);
            Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent tap = PendingIntent.getActivity(context, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
            b.setSmallIcon(R.drawable.ic_notify).setContentTitle(title).setContentText(text)
                .setContentIntent(tap).setAutoCancel(true).setGroup(GROUP).setGroupSummary(true);
            manager.notify(SUMMARY_ID, b.build());
        } catch (Exception ignored) {}
    }

    private static void ensureChannel(NotificationManager m) {
        if (Build.VERSION.SDK_INT >= 26) {
            m.createNotificationChannel(new NotificationChannel(CHANNEL,
                    "Crypto Signal · หลายเหรียญ", NotificationManager.IMPORTANCE_HIGH));
        }
    }
}
