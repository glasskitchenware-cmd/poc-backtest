package th.paperbot.backtest;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Hosts the offline web UI; native help is limited to read-only HTTPS GET and alerts. */
public class MainActivity extends Activity {
    private WebView web;
    private NativeBridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0E11);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowContentAccess(false);
        bridge = new NativeBridge(this, web, new NativeBridge.Host() {
            @Override
            public void onScanDone(String json) {
                // Scans in the open app notify too (same once-per-candle rule as background scans).
                Alerts.onScan(MainActivity.this, json);
            }

            @Override
            public void onAlertsChanged(boolean enabled) {
                if (enabled) {
                    enableAlerts();
                } else {
                    Alerts.setEnabled(MainActivity.this, false);
                }
            }
        });
        web.addJavascriptInterface(bridge, "NativeHttp");
        // Links to other sites (e.g. Google AI Studio for the API key) open in the phone's browser.
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equals(uri.getScheme())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // No browser available: stay in the app.
                }
                return true;
            }
        });
        setContentView(web);
        if (Alerts.isFirstRun(this)) {
            enableAlerts();
        } else if (Alerts.isEnabled(this)) {
            Alerts.armAlarm(this);
        }
        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl("file:///android_asset/index.html");
        }
    }

    private void enableAlerts() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        Alerts.setEnabled(this, true);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        bridge.shutdown();
        web.destroy();
        super.onDestroy();
    }
}
