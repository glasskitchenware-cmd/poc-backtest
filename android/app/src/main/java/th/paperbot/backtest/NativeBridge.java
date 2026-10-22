package th.paperbot.backtest;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
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
