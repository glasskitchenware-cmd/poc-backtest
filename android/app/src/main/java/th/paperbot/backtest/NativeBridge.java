package th.paperbot.backtest;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** The page's only native capabilities: public read-only HTTPS GET, and signal alerts. */
final class NativeBridge {
    interface Host {
        void onScanDone(String json);

        void onAlertsChanged(boolean enabled);
    }

    // Market data, the baht rate, and free news without keys: crypto news RSS, Binance announcements, the Fed and the
    // SEC, and the week's economic calendar.
    private static final List<String> ALLOWED_HOSTS = Arrays.asList(
            "data-api.binance.vision", "api.binance.com", "fapi.binance.com", "fapi1.binance.com", "api.bitkub.com", "open.er-api.com",
            "www.coindesk.com", "cointelegraph.com", "decrypt.co", "bitcoinmagazine.com", "www.theblock.co", "cryptoslate.com",
            "siamblockchain.com", "bitcoinaddict.org", "www.binance.com", "www.federalreserve.gov", "www.sec.gov", "nfs.faireconomy.media",
            "api.alternative.me");
    // Emulator tests only: the host machine as seen from the Android emulator, used when the APK is debuggable.
    private static final String DEBUG_MOCK_HOST = "10.0.2.2";

    private final Context context;
    private final WebView web;
    private final Host host;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final Handler main = new Handler(Looper.getMainLooper());

    NativeBridge(Context context, WebView web, Host host) {
        this.context = context.getApplicationContext();
        this.web = web;
        this.host = host;
    }

    void shutdown() {
        pool.shutdownNow();
    }

    @JavascriptInterface
    public void get(final String id, final String address) {
        pool.execute(() -> {
            boolean ok = false;
            String body;
            try {
                URL url = new URL(address);
                boolean debugMock = isDebuggable() && "http".equals(url.getProtocol()) && DEBUG_MOCK_HOST.equals(url.getHost());
                if (!debugMock && (!"https".equals(url.getProtocol()) || !ALLOWED_HOSTS.contains(url.getHost()))) {
                    throw new IllegalArgumentException("host not allowed: " + url.getHost());
                }
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("Accept", "application/json, application/rss+xml, application/xml, text/xml, */*");
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) POCSignal/6.0");
                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                body = stream == null ? "" : read(stream);
                connection.disconnect();
                ok = status >= 200 && status < 300;
                if (!ok) {
                    body = "HTTP " + status + " " + body;
                }
            } catch (Exception error) {
                body = error.getClass().getSimpleName() + ": " + error.getMessage();
            }
            final String script = "window.__nativeDone(" + JSONObject.quote(id) + "," + ok + ","
                    + JSONObject.quote(body) + ")";
            main.post(() -> web.evaluateJavascript(script, null));
        });
    }

    /** Shares text through Android's share sheet (LINE, Drive, e-mail): the journal backup. */
    @JavascriptInterface
    public void share(final String subject, final String text) {
        main.post(() -> {
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, subject).putExtra(Intent.EXTRA_TEXT, text);
            try {
                context.startActivity(Intent.createChooser(send, subject).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                // No app can receive text: nothing to do.
            }
        });
    }

    @JavascriptInterface
    public void openBatterySettings() {
        main.post(() -> {
            Intent intent;
            if (android.os.Build.VERSION.SDK_INT >= 23) {
                intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:" + context.getPackageName()));
            } else {
                intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + context.getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                context.startActivity(intent);
            } catch (Exception error) {
                try {
                    context.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            android.net.Uri.parse("package:" + context.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) {
                    // No settings screen available.
                }
            }
        });
    }

    /** True when Android will not delay the app's alarms to save battery. */
    @JavascriptInterface
    public boolean batteryUnrestricted() {
        if (android.os.Build.VERSION.SDK_INT < 23) {
            return true;
        }
        android.os.PowerManager power = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    /** False when the user has blocked this app's notifications in Android settings. */
    @JavascriptInterface
    public boolean notificationsAllowed() {
        return Alerts.notificationsAllowed(context);
    }

    @JavascriptInterface
    public void testNotification() {
        main.post(() -> Alerts.showSample(context));
    }

    /** The signal channel's own settings page, where floating (heads-up / pop on screen) is switched on. */
    @JavascriptInterface
    public void openSignalChannelSettings() {
        main.post(() -> {
            Intent intent;
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                intent = new Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                        .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, Alerts.CHANNEL);
            } else {
                intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + context.getPackageName()));
            }
            try {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                openNotificationSettings();
            }
        });
    }

    @JavascriptInterface
    public void openNotificationSettings() {
        main.post(() -> {
            Intent intent;
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                intent = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.getPackageName());
            } else {
                intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + context.getPackageName()));
            }
            try {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                // No settings screen available.
            }
        });
    }

    /** Last scan outcome recorded by Alerts as JSON {at, ok, text}. */
    @JavascriptInterface
    public String lastScanStatus() {
        return Alerts.lastStatusJson(context);
    }

    /** Futures API base override for emulator tests; always empty in the release APK. */
    @JavascriptInterface
    public String debugFuturesBase() {
        if (!isDebuggable()) return "";
        return context.getSharedPreferences("alerts", Context.MODE_PRIVATE).getString("debugFuturesBase", "");
    }

    /** Timeframe override for emulator tests (the mock replays 15m candles); always empty in the release APK. */
    @JavascriptInterface
    public String debugTradeTf() {
        if (!isDebuggable()) return "";
        return context.getSharedPreferences("alerts", Context.MODE_PRIVATE).getString("debugTradeTf", "");
    }

    private boolean isDebuggable() {
        return (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @JavascriptInterface
    public boolean alertsEnabled() {
        return Alerts.isEnabled(context);
    }

    @JavascriptInterface
    public void setAlerts(boolean enabled) {
        main.post(() -> host.onAlertsChanged(enabled));
    }

    /** Alert timeframe options are 5m, 15m, 1h and 4h; synchronized with the Android alarm. */
    @JavascriptInterface
    public void setScanMinutes(int minutes) {
        main.post(() -> Alerts.setScanMinutes(context, minutes));
    }

    @JavascriptInterface
    public int scanMinutes() {
        return Alerts.scanMinutes(context);
    }

    @JavascriptInterface
    public void scanDone(String json) {
        main.post(() -> host.onScanDone(json));
    }

    private static String read(InputStream stream) throws Exception {
        try (InputStream in = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int count;
            while ((count = in.read(buffer)) != -1) {
                out.write(buffer, 0, count);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
