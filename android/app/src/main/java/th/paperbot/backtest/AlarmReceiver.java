package th.paperbot.backtest;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Fires just after every signal candle closes (5m/15m/1h/4h); also re-arms the alarm after a reboot or an app update. */
public class AlarmReceiver extends BroadcastReceiver {
    static final String ACTION_SCAN = "th.paperbot.backtest.SCAN";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Alerts.isEnabled(context)) {
            return;
        }
        Alerts.armAlarm(context);
        if (!ACTION_SCAN.equals(intent.getAction())) {
            return;
        }
        Intent service = new Intent(context, ScanService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception ignored) {
            // Not allowed right now (e.g. aggressive battery saver): the 15-minute backup job still runs.
        }
    }
}
