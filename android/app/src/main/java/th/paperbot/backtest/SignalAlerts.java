package th.paperbot.backtest;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Turns one scan packet (built by signalPayload/reportScan in web/app.js) into the notifications to post.
 * Pure Java on purpose: no Android types, so tools/java-tests can check every rule off-device.
 * Rules: no notification on a failed or stale scan, one notification per kind (entry/exit)/coin/side/timeframe/closed
 * candle, and the text always says it is a trial signal, not an order. Trend 4H entries carry no take profit (exit_rule
 * instead); its exits (kind EXIT) tell the user to close a position the rule opened.
 */
final class SignalAlerts {
    static final long MAX_AGE_CAP_MS = 15 * 60_000L;
    private static final String SYMBOL = "[A-Z0-9]{2,20}USDT";

    /** Last candle already notified for a dedup key, or -1. */
    interface Seen {
        long lastCandle(String key);
    }

    static final class Note {
        final String key;
        final long candle;
        final String symbol;
        final String side;
        final String tf;
        final String title;
        final String body;
        final boolean exit;

        Note(String key, long candle, String symbol, String side, String tf, String title, String body, boolean exit) {
            this.key = key;
            this.candle = candle;
            this.symbol = symbol;
            this.side = side;
            this.tf = tf;
            this.title = title;
            this.body = body;
            this.exit = exit;
        }

        int id() {
            return (key + ":" + candle).hashCode();
        }
    }

    static final class Plan {
        final List<Note> notes = new ArrayList<>();
        boolean ok;
        String status = "";
        int signals;
        int duplicates;
        int invalid;
    }

    private SignalAlerts() {
    }

    static String tfLabel(int minutes) {
        return minutes == 5 ? "M5" : minutes == 15 ? "M15" : minutes == 60 ? "H1" : minutes == 240 ? "H4" : "";
    }

    static String bangkok(long ms, String pattern) {
        SimpleDateFormat f = new SimpleDateFormat(pattern, Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("Asia/Bangkok"));
        return f.format(new Date(ms));
    }

    static Plan plan(String json, long now, Seen seen) {
        Plan plan = new Plan();
        JSONObject packet;
        try {
            packet = new JSONObject(json);
        } catch (JSONException | NullPointerException e) {
            plan.status = "ผลสแกนอ่านไม่ได้ · ไม่แจ้งเตือน";
            return plan;
        }
        String error = packet.optString("error", "");
        if (!error.isEmpty()) {
            plan.status = "สแกนไม่สำเร็จ: " + cut(error, 160) + " · ไม่แจ้งเตือน";
            return plan;
        }
        int minutes = packet.optInt("interval_minutes", 0);
        String tf = tfLabel(minutes);
        if (tf.isEmpty()) {
            plan.status = "กรอบเวลาไม่รองรับ (" + minutes + " นาที) · ไม่แจ้งเตือน";
            return plan;
        }
        long candle = packet.optLong("candle", 0);
        long maxAge = Math.min(minutes * 60_000L, MAX_AGE_CAP_MS);
        if (candle <= 0 || candle > now + 60_000L || now - candle > maxAge) {
            plan.status = "แท่ง " + tf + " ไม่สด (ปิดเมื่อ " + (candle > 0 ? bangkok(candle, "dd/MM HH:mm") : "?") + ") · ไม่แจ้งเตือนของเก่า";
            return plan;
        }
        JSONArray items = packet.optJSONArray("signals");
        int count = items == null ? 0 : items.length();
        for (int i = 0; i < count; i++) {
            JSONObject item = items.optJSONObject(i);
            Note note = item == null ? null : note(item, tf, candle);
            if (note == null) {
                plan.invalid++;
                continue;
            }
            plan.signals++;
            if (seen.lastCandle(note.key) >= candle) {
                plan.duplicates++;
                continue;
            }
            plan.notes.add(note);
        }
        plan.ok = true;
        JSONArray failed = packet.optJSONArray("failed");
        StringBuilder s = new StringBuilder();
        s.append("สแกน ").append(packet.optInt("scanned", 0)).append(" เหรียญ · แท่ง ").append(tf)
                .append(" ปิด ").append(bangkok(candle, "HH:mm")).append(" · สัญญาณ ").append(plan.signals)
                .append(" · แจ้งใหม่ ").append(plan.notes.size());
        if (plan.duplicates > 0) s.append(" · ซ้ำ ").append(plan.duplicates);
        if (plan.invalid > 0) s.append(" · ข้อมูลผิดรูปแบบ ").append(plan.invalid);
        if (failed != null && failed.length() > 0) s.append(" · ล้มเหลว ").append(failed.length()).append(" เหรียญ");
        plan.status = s.toString();
        return plan;
    }

    /** null when the item breaks the contract; such items are never shown. */
    static Note note(JSONObject item, String tf, long candle) {
        String symbol = item.optString("symbol", "").trim();
        String side = item.optString("side", "").trim().toUpperCase(Locale.US);
        if (!symbol.matches(SYMBOL) || !(side.equals("LONG") || side.equals("SHORT"))) return null;
        if (!tf.equals(item.optString("tf", tf))) return null;
        long close = item.optLong("candle_close", candle);
        if (close != candle) return null;
        String kind = item.optString("kind", "ENTRY").trim().toUpperCase(Locale.US);
        if (kind.equals("EXIT")) return exitNote(item, tf, candle, symbol, side);
        if (!kind.equals("ENTRY")) return null;
        String entry = item.optString("entry", "");
        String sl = item.optString("sl", "");
        String tp1 = item.optString("tp1", "");
        String tp2 = item.optString("tp2", "");
        String tp5 = item.optString("tp5", "");
        String exitRule = item.optString("exit_rule", "");
        if (entry.isEmpty() || sl.isEmpty() || (tp5.isEmpty() && exitRule.isEmpty())) return null;
        int leverage = item.optInt("leverage", 0);
        int cap = item.optInt("leverage_cap", leverage);
        long expires = item.optLong("expires", 0);
        String key = "sent:" + tf + ":" + symbol + ":" + side;
        String title = "ทดลอง · " + symbol + " " + side + " · " + tf + (leverage > 0 ? " · ≤" + leverage + "x" : "");
        StringBuilder b = new StringBuilder();
        b.append("แท่งปิด ").append(bangkok(candle, "dd/MM HH:mm")).append(" น. (เวลาไทย UTC+7)");
        if (expires > candle) b.append(" · ยกเลิกถ้ายังไม่เข้าภายใน ").append(bangkok(expires, "HH:mm")).append(" น.");
        b.append("\nเข้าอ้างอิง ").append(entry).append(" · SL ").append(sl);
        if (!tp5.isEmpty()) b.append("\nTP1 ").append(tp1).append(" (1R) · TP2 ").append(tp2).append(" (2R) · TP5 ").append(tp5).append(" (5R)");
        else b.append("\n").append(cut(exitRule, 200));
        if (item.has("margin_usdt")) {
            b.append("\nMargin ≈ ").append(item.optString("margin_usdt")).append(" USDT (≈ ").append(item.optString("margin_thb")).append(" ฿)")
                    .append(" · ถ้าโดน SL เสีย ≈ ").append(item.optString("risk_thb")).append(" ฿");
        }
        if (leverage > 0) {
            b.append("\nLeverage ≤").append(leverage).append("x (เพดานที่เลือก ").append(cap).append("x)");
            String liq = item.optString("liq_est", "");
            if (!liq.isEmpty()) b.append(" · Liq ประมาณ ").append(liq).append(" (ไม่มีตาราง bracket จริง)");
        }
        String why = item.optString("rationale", "");
        b.append("\nกลยุทธ์ ").append(item.optString("strategy", "?"));
        if (!why.isEmpty()) b.append(": ").append(cut(why, 160));
        String evidence = item.optString("evidence", "");
        b.append("\n").append(evidence.isEmpty() ? "ยังไม่มีข้อมูลยืนยัน" : cut(evidence, 220));
        b.append("\nสัญญาณทดลอง ไม่ใช่คำสั่งซื้อขาย · Paper เท่านั้น · ตรวจราคาล่าสุดก่อนตัดสินใจ");
        return new Note(key, candle, symbol, side, tf, title, b.toString(), false);
    }

    /** The rule closes the position it opened, at the next open. Says what to do only if the user holds it. */
    static Note exitNote(JSONObject item, String tf, long candle, String symbol, String side) {
        String entry = item.optString("entry", "");
        String ref = item.optString("exit_ref", "");
        if (entry.isEmpty() || ref.isEmpty()) return null;
        long opened = item.optLong("opened", 0);
        String level = item.optString("exit_level", "");
        String r = item.optString("r_now", "");
        String key = "sent:EXIT:" + tf + ":" + symbol + ":" + side;
        String title = "ทดลอง · ปิดไม้ " + symbol + " " + side + " · " + tf;
        StringBuilder b = new StringBuilder();
        b.append("แท่งปิด ").append(bangkok(candle, "dd/MM HH:mm")).append(" น. (เวลาไทย UTC+7)");
        b.append("\nสูตรปิด ").append(side).append(" ที่เข้า ").append(entry);
        if (opened > 0) b.append(" เมื่อ ").append(bangkok(opened, "dd/MM HH:mm")).append(" น.");
        b.append("\nแท่ง ").append(tf).append(" ปิด ").append(ref);
        if (!level.isEmpty()) b.append(side.equals("LONG") ? " ต่ำกว่า " : " สูงกว่า ").append(level);
        if (!r.isEmpty()) b.append(" · ตอนนี้ ≈ ").append(r).append("R");
        String sl = item.optString("sl", "");
        if (!sl.isEmpty()) b.append(" · SL เดิม ").append(sl);
        b.append("\nถ้าถือไม้นี้อยู่: Positions → Close → Market · ถ้าไม่ได้ถือ ไม่ต้องทำอะไร");
        String why = item.optString("rationale", "");
        b.append("\nกลยุทธ์ ").append(item.optString("strategy", "?"));
        if (!why.isEmpty()) b.append(": ").append(cut(why, 160));
        b.append("\nสัญญาณทดลอง ไม่ใช่คำสั่งซื้อขาย · ตรวจราคาล่าสุดก่อนตัดสินใจ");
        return new Note(key, candle, symbol, side, tf, title, b.toString(), true);
    }

    static String summaryText(List<Note> notes) {
        StringBuilder s = new StringBuilder();
        for (Note n : notes) {
            if (s.length() > 0) s.append(" · ");
            s.append(n.exit ? "ปิด " : "").append(n.symbol.replace("USDT", "")).append(" ").append(n.side);
        }
        return s.toString();
    }

    private static String cut(String text, int max) {
        return text.length() <= max ? text : text.substring(0, max - 1) + "…";
    }
}
