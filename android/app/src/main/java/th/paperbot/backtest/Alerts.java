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

/** Scan right after every 1H candle closes (exact alarm), a 15-minute backup job, and one notification per new signal. */
final class Alerts {
    private static final int JOB_ID = 15;
    private static final String CHANNEL = "signals";
    private static final String PREFS = "alerts";

    private Alerts() {
    }

    static boolean isEnabled(Context context) {
        return prefs(context).getBoolean("enabled", false);
    }

    static void setEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean("enabled", enabled).apply();
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (!enabled) {
            scheduler.cancel(JOB_ID);
            alarms(context).cancel(alarmIntent(context));
            return;
        }
        armAlarm(context);
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, ScanJobService.class))
                .setPeriodic(15 * 60 * 1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build();
        scheduler.schedule(job);
    }

    /** Next alarm 40 s after the coming hour, when Binance has the closed 1H candle. */
    static void armAlarm(Context context) {
        long hour = 3600000L, at = (System.currentTimeMillis() / hour + 1) * hour + 40000L;
        AlarmManager manager = alarms(context);
        PendingIntent pending = alarmIntent(context);
        if (Build.VERSION.SDK_INT >= 31 && !manager.canScheduleExactAlarms()) {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } else if (Build.VERSION.SDK_INT >= 23) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } else {
            manager.setExact(AlarmManager.RTC_WAKEUP, at, pending);
        }
    }

    private static AlarmManager alarms(Context context) {
        return (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    }

    private static PendingIntent alarmIntent(Context context) {
        Intent intent = new Intent(context, AlarmReceiver.class).setAction(AlarmReceiver.ACTION_SCAN);
        return PendingIntent.getBroadcast(context, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Notifies once per closed candle and set of coins; scan errors stay silent. */
    static void onScan(Context context, String json) {
        try {
            JSONObject result = new JSONObject(json);
            JSONArray signals = result.optJSONArray("signals");
            if (signals == null || signals.length() == 0) {
                return;
            }
            long candle = result.optLong("candle");
            if (candle > 0 && System.currentTimeMillis() - candle > 20 * 60000L) {
                return;   // the 15-minute entry window has passed: a late alert would only invite chasing
            }
            StringBuilder coins = new StringBuilder();
            StringBuilder detail = new StringBuilder();
            for (int i = 0; i < signals.length(); i++) {
                JSONObject s = signals.getJSONObject(i);
                if (i > 0) {
                    coins.append(", ");
                    detail.append("\n");
                }
                coins.append(s.getString("coin"));
                detail.append(s.getString("coin")).append(" · เข้า ~").append(s.getString("entry"))
                        .append(" · SL ").append(s.getString("stop")).append(" · TP ").append(s.getString("target"));
            }
            String key = candle + ":" + coins;
            SharedPreferences prefs = prefs(context);
            if (key.equals(prefs.getString("last", ""))) {
                return;
            }
            prefs.edit().putString("last", key).apply();
            String note = result.optString("note", "");
            if (!note.isEmpty()) {
                detail.append("\n").append(note);
            }
            if (candle > 0) {
                detail.append("\nเข้าได้ถึง ").append(new java.text.SimpleDateFormat("HH:mm", java.util.Locale.US)
                        .format(new java.util.Date(candle + 15 * 60000L))).append(" น. · เลยเวลานี้ให้ข้าม");
            }
            show(context, "เข้าได้เลย: " + coins, detail.toString());
        } catch (Exception ignored) {
            // A malformed result must never crash the background job.
        }
    }

    private static void show(Context context, String title, String text) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "สัญญาณเทรด",
                    NotificationManager.IMPORTANCE_HIGH));
        }
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(tap)
                .setAutoCancel(true);
        manager.notify((int) (System.currentTimeMillis() / 1000), builder.build());
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
