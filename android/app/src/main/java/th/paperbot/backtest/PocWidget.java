package th.paperbot.backtest;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import java.util.List;

/**
 * Home-screen widget: the last check's signals (SignalAlerts.widgetLines), whether checks are working, and the next
 * 4-hour close. Updated by Alerts after every check (app open or background); tapping it opens the app.
 */
public class PocWidget extends AppWidgetProvider {
    static final long STALE_MS = 5 * 3600_000L;   // a 4-hour rule should have been checked within 5 hours

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        render(context, manager, ids);
    }

    /** Called by Alerts after each check; does nothing when no widget is placed. */
    static void refresh(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, PocWidget.class));
            if (ids.length > 0) render(context, manager, ids);
        } catch (Exception ignored) {
            // A widget must never break a check.
        }
    }

    private static void render(Context context, AppWidgetManager manager, int[] ids) {
        SharedPreferences p = context.getSharedPreferences("alerts", Context.MODE_PRIVATE);
        String json = p.getString("widgetPacket", "");
        long at = p.getLong("lastScanAt", 0);
        boolean ok = p.getBoolean("lastScanOk", false), stale = at > 0 && System.currentTimeMillis() - at > STALE_MS;
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget);
        if (!json.isEmpty()) {
            List<String> lines = SignalAlerts.widgetLines(json);
            v.setTextViewText(R.id.w_lines, android.text.TextUtils.join("\n", lines));
            v.setTextViewText(R.id.w_foot, SignalAlerts.widgetFooter(json, at) + " · แตะเพื่อเปิด");
        }
        String status = at == 0 ? "● รอเช็กแรก" : stale ? "● ข้อมูลเก่า" : ok ? "● ทำงาน" : "● มีปัญหา";
        v.setTextViewText(R.id.w_status, status);
        v.setTextColor(R.id.w_status, at > 0 && ok && !stale ? 0xFF0ECB81 : 0xFFF6465D);
        Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        v.setOnClickPendingIntent(R.id.w_root, PendingIntent.getActivity(context, 7, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        for (int id : ids) manager.updateAppWidget(id, v);
    }
}
