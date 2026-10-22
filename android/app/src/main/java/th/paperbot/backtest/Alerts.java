package th.paperbot.backtest;

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

/** Background scan every 15 minutes and a notification for each new set of signals. */
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
            return;
        }
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, ScanJobService.class))
                .setPeriodic(15 * 60 * 1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build();
        scheduler.schedule(job);
    }

    /** Notifies once per closed candle and set of coins; scan errors stay silent. */
    static void onScan(Context context, String json) {
        try {
            JSONObject result = new JSONObject(json);
            JSONArray signals = result.optJSONArray("signals");
            if (signals == null || signals.length() == 0) {
                return;
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
                detail.append(s.getString("coin")).append(" ซื้อ ~").append(s.getString("entry"))
                        .append(" · stop ").append(s.getString("stop")).append(" · เป้า ").append(s.getString("target"));
            }
            String key = result.optLong("candle") + ":" + coins;
            SharedPreferences prefs = prefs(context);
            if (key.equals(prefs.getString("last", ""))) {
                return;
            }
            prefs.edit().putString("last", key).apply();
            String note = result.optString("note", "");
            if (!note.isEmpty()) {
                detail.append("\n").append(note);
            }
            show(context, "สัญญาณเข้า: " + coins, detail.toString());
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
