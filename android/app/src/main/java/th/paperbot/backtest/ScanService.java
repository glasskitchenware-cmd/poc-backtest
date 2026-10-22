package th.paperbot.backtest;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/** Short foreground scan started by the candle-close alarm, so it runs at once even when the phone sleeps. */
public class ScanService extends Service {
    private static final String CHANNEL = "scan";
    private static final long TIMEOUT_MS = 150 * 1000L;

    private BgScan scan;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat();
        if (scan == null) {
            scan = new BgScan(this);
            scan.start(TIMEOUT_MS, this::stop);
        }
        return START_NOT_STICKY;
    }

    private void startForegroundCompat() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "กำลังเช็กสัญญาณ (เงียบ)",
                    NotificationManager.IMPORTANCE_MIN));
            builder = new Notification.Builder(this, CHANNEL);
        } else {
            builder = new Notification.Builder(this).setPriority(Notification.PRIORITY_MIN);
        }
        Notification note = builder.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("กำลังเช็กสัญญาณแท่งที่เพิ่งปิด…")
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(2, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
        } else {
            startForeground(2, note);
        }
    }

    @Override
    public void onTimeout(int startId) {
        stop();
    }

    private void stop() {
        if (scan != null) {
            scan.cancel();
            scan = null;
        }
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (scan != null) {
            scan.cancel();
            scan = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
