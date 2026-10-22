package th.paperbot.backtest;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
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

    private static final List<String> ALLOWED_HOSTS = Arrays.asList(
            "data-api.binance.vision", "api.binance.com", "api.bitkub.com", "open.er-api.com");
    private static final List<String> POST_HOSTS = Arrays.asList("generativelanguage.googleapis.com");

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
                if (!"https".equals(url.getProtocol()) || !ALLOWED_HOSTS.contains(url.getHost())) {
                    throw new IllegalArgumentException("host not allowed: " + url.getHost());
                }
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("User-Agent", "POC-Signal-Android/1.1");
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

    /** JSON POST, only to Google's Gemini API, with the user's own key in the URL. */
    @JavascriptInterface
    public void post(final String id, final String address, final String json) {
        pool.execute(() -> {
            boolean ok = false;
            String body;
            try {
                URL url = new URL(address);
                if (!"https".equals(url.getProtocol()) || !POST_HOSTS.contains(url.getHost())) {
                    throw new IllegalArgumentException("host not allowed: " + url.getHost());
                }
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(90000);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                }
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

    /** Text on the clipboard, so the user can paste the API key with one tap. */
    @JavascriptInterface
    public String clipboard() {
        try {
            ClipboardManager manager = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = manager == null ? null : manager.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                return "";
            }
            CharSequence text = clip.getItemAt(0).coerceToText(context);
            return text == null ? "" : text.toString();
        } catch (Exception error) {
            return "";
        }
    }

    /** Opens the screen where the user lets the app run in the background (no battery optimisation). */
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
        main.post(() -> Alerts.show(context, "ทดสอบแจ้งเตือน ✓",
                "ถ้าเห็นข้อความนี้ แปลว่าแจ้งเตือนสัญญาณเด้งได้ · ของจริงจะขึ้นว่า \"เข้าได้เลย: BTC LONG x10\""));
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

    @JavascriptInterface
    public boolean alertsEnabled() {
        return Alerts.isEnabled(context);
    }

    @JavascriptInterface
    public void setAlerts(boolean enabled) {
        main.post(() -> host.onAlertsChanged(enabled));
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
