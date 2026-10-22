package th.paperbot.backtest;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import android.webkit.WebView;

/** Runs the page's own scan in a hidden WebView, so alerts use exactly the app's rules. */
final class BgScan {
    interface Done {
        void done();
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Context context;
    private WebView web;
    private NativeBridge bridge;
    private Done done;

    BgScan(Context context) {
        this.context = context;
    }

    void start(long timeoutMs, Done onDone) {
        done = onDone;
        web = new WebView(context.getApplicationContext());
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowContentAccess(false);
        bridge = new NativeBridge(context, web, new NativeBridge.Host() {
            @Override
            public void onScanDone(String json) {
                finish(json);
            }

            @Override
            public void onAlertsChanged(boolean enabled) {
                Alerts.setEnabled(context, enabled);
            }
        });
        web.addJavascriptInterface(bridge, "NativeHttp");
        web.loadUrl("file:///android_asset/index.html#bg");
        main.postDelayed(() -> finish(null), timeoutMs);
    }

    void cancel() {
        release();
        done = null;
    }

    private void finish(String json) {
        if (web == null) {
            return;
        }
        if (json != null) {
            Alerts.onScan(context, json);
        }
        release();
        Done callback = done;
        done = null;
        if (callback != null) {
            callback.done();
        }
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
