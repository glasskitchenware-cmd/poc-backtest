package th.paperbot.backtest;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import android.webkit.WebView;

/** Runs the page's own scan in a hidden WebView, so alerts use exactly the app's rules. */
public class ScanJobService extends JobService {
    private static final long TIMEOUT_MS = 4 * 60 * 1000L;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private NativeBridge bridge;
    private JobParameters params;

    @Override
    public boolean onStartJob(JobParameters jobParameters) {
        params = jobParameters;
        web = new WebView(getApplicationContext());
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowContentAccess(false);
        bridge = new NativeBridge(this, web, new NativeBridge.Host() {
            @Override
            public void onScanDone(String json) {
                finish(json);
            }

            @Override
            public void onAlertsChanged(boolean enabled) {
                Alerts.setEnabled(ScanJobService.this, enabled);
            }
        });
        web.addJavascriptInterface(bridge, "NativeHttp");
        web.loadUrl("file:///android_asset/index.html#bg");
        main.postDelayed(() -> finish(null), TIMEOUT_MS);
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters jobParameters) {
        release();
        return true;
    }

    private void finish(String json) {
        if (web == null) {
            return;
        }
        if (json != null) {
            Alerts.onScan(this, json);
        }
        release();
        jobFinished(params, false);
    }

    private void release() {
        main.removeCallbacksAndMessages(null);
        if (bridge != null) {
            bridge.shutdown();
            bridge = null;
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
    }
}
