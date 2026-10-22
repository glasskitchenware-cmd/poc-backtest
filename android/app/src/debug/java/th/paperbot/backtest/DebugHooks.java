package th.paperbot.backtest;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;

import java.nio.charset.StandardCharsets;

/**
 * Debug build only. Lets the emulator test drive the same code paths as production:
 * DEBUG_INJECT posts a scan packet (extra json_b64) through Alerts.onScan; DEBUG_SCAN fires the real exact
 * alarm two seconds later (the alarm, not this receiver, may start the foreground scan on Android 14);
 * DEBUG_CONFIG points the futures API at the mock server and sets the scan interval.
 */
public class DebugHooks extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if ("th.paperbot.backtest.DEBUG_INJECT".equals(action)) {
            String b64 = intent.getStringExtra("json_b64");
            Alerts.onScan(context, b64 == null ? "" : new String(Base64.decode(b64, Base64.DEFAULT), StandardCharsets.UTF_8));
        } else if ("th.paperbot.backtest.DEBUG_SCAN".equals(action)) {
            Alerts.armAlarmAt(context, System.currentTimeMillis() + 2000L);
        } else if ("th.paperbot.backtest.DEBUG_CONFIG".equals(action)) {
            String base = intent.getStringExtra("base");
            if (base != null) {
                context.getSharedPreferences("alerts", Context.MODE_PRIVATE).edit().putString("debugFuturesBase", base).apply();
            }
            int minutes = intent.getIntExtra("minutes", 0);
            if (minutes > 0) Alerts.setScanMinutes(context, minutes);
        }
    }
}
