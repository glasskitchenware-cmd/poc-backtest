package th.paperbot.backtest;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Off-device tests for SignalAlerts (the notification rules). Run: tools/java-tests/run.sh
 * Optional arguments: packet JSON files written by tests/js (real payloads from web/app.js) to check the contract.
 */
public class SignalAlertsTest {
    static final String[] COINS = {"BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
        "LINKUSDT", "DOTUSDT", "TRXUSDT", "LTCUSDT"};
    static int passed;

    static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError("FAIL: " + what);
        passed++;
        System.out.println("ok - " + what);
    }

    static JSONObject item(String symbol, String side, String tf, long candle) throws Exception {
        return new JSONObject().put("symbol", symbol).put("side", side).put("tf", tf).put("strategy", "squeeze3_ls")
            .put("candle_close", candle).put("expires", candle + 15 * 60_000L).put("hold_hours", 12)
            .put("entry", "100.00").put("sl", "98.20").put("tp1", "101.80").put("tp2", "103.60").put("tp5", "109.00")
            .put("qty", "0.5").put("margin_usdt", "5.00").put("margin_thb", "165").put("risk_thb", "25")
            .put("leverage", 10).put("leverage_cap", 20).put("liq_est", "91.00").put("mark", "100.01")
            .put("rationale", "momentum after squeeze").put("evidence", "ข้อมูลยืนยัน 2026: 40 ไม้").put("evidence_ok", true).put("experimental", true);
    }

    static String packet(int minutes, long candle, JSONArray signals) throws Exception {
        return new JSONObject().put("v", 2).put("candle", candle).put("interval_minutes", minutes).put("error", "")
            .put("scanned", 12).put("failed", new JSONArray()).put("signals", signals).toString();
    }

    public static void main(String[] args) throws Exception {
        long m15 = 15 * 60_000L;
        long candle = 1_792_000_000_000L / m15 * m15;    // a 15-minute boundary
        long now = candle + 30_000L;
        Map<String, Long> seen = new HashMap<>();
        SignalAlerts.Seen lookup = key -> seen.getOrDefault(key, -1L);

        // 12 coins on the same closed candle -> 12 separate notifications with distinct ids.
        JSONArray all = new JSONArray();
        for (int i = 0; i < COINS.length; i++) all.put(item(COINS[i], i % 2 == 0 ? "LONG" : "SHORT", "M15", candle));
        SignalAlerts.Plan p = SignalAlerts.plan(packet(15, candle, all), now, lookup);
        check(p.ok && p.notes.size() == 12, "12 coins in one candle give 12 notifications");
        Set<Integer> ids = new HashSet<>();
        for (SignalAlerts.Note n : p.notes) ids.add(n.id());
        check(ids.size() == 12, "notification ids are distinct per coin");
        SignalAlerts.Note first = p.notes.get(0);
        check(first.title.startsWith("ทดลอง · BTCUSDT LONG · M15"), "title says trial + symbol + side + timeframe");
        for (String must : new String[]{"UTC+7", "เข้าอ้างอิง 100.00", "SL 98.20", "TP1 101.80 (1R)", "TP2 103.60 (2R)", "TP5 109.00 (5R)",
                "Margin ≈ 5.00 USDT (≈ 165 ฿)", "ถ้าโดน SL เสีย ≈ 25 ฿", "Leverage ≤10x (เพดานที่เลือก 20x)", "Liq ประมาณ 91.00", "squeeze3_ls", "ข้อมูลยืนยัน 2026",
                "ไม่ใช่คำสั่งซื้อขาย", "ยกเลิกถ้ายังไม่เข้าภายใน"}) {
            check(first.body.contains(must), "body contains: " + must);
        }

        // Dedup: once posted, the same coin/side/tf/candle is never posted again (retry, reconnect, reboot).
        for (SignalAlerts.Note n : p.notes) seen.put(n.key, n.candle);
        SignalAlerts.Plan again = SignalAlerts.plan(packet(15, candle, all), now + 60_000L, lookup);
        check(again.ok && again.notes.isEmpty() && again.duplicates == 12, "same candle again -> no repeat, 12 duplicates");

        // Next closed candle notifies again.
        JSONArray next = new JSONArray().put(item("BTCUSDT", "LONG", "M15", candle + m15));
        check(SignalAlerts.plan(packet(15, candle + m15, next), candle + m15 + 20_000L, lookup).notes.size() == 1, "next candle notifies again");

        // Opposite side on the same candle is a different signal.
        JSONArray flip = new JSONArray().put(item("BTCUSDT", "SHORT", "M15", candle));
        check(SignalAlerts.plan(packet(15, candle, flip), now, lookup).notes.size() == 1, "BTC SHORT differs from the posted BTC LONG on the same candle -> notifies");
        JSONArray ethLong = new JSONArray().put(item("ETHUSDT", "LONG", "M15", candle));
        check(SignalAlerts.plan(packet(15, candle, ethLong), now, lookup).notes.size() == 1, "ETH LONG differs from posted ETH SHORT -> notifies");

        // 5m and 15m are separate streams.
        long m5 = 5 * 60_000L, c5 = candle + m5;
        JSONArray five = new JSONArray().put(item("BTCUSDT", "LONG", "M5", c5));
        check(SignalAlerts.plan(packet(5, c5, five), c5 + 10_000L, lookup).notes.size() == 1, "M5 signal is independent of M15 dedup");

        // Stale: older than one candle (M5) or 15 minutes (M15/H1) -> nothing, and the status says so.
        SignalAlerts.Plan stale = SignalAlerts.plan(packet(15, candle, all), candle + m15 + 1, key -> -1L);
        check(!stale.ok && stale.notes.isEmpty() && stale.status.contains("ไม่สด"), "stale M15 candle is refused");
        check(SignalAlerts.plan(packet(5, c5, five), c5 + m5 + 1, key -> -1L).notes.isEmpty(), "stale M5 candle (>5 min) is refused");
        long h1 = 3_600_000L, ch = candle / h1 * h1;
        JSONArray hour = new JSONArray().put(item("BTCUSDT", "LONG", "H1", ch));
        check(SignalAlerts.plan(packet(60, ch, hour), ch + 16 * 60_000L, key -> -1L).notes.isEmpty(), "H1 alert older than 15 minutes is refused");
        check(SignalAlerts.plan(packet(15, candle + 10 * m15, all), now, key -> -1L).notes.isEmpty(), "candle in the future is refused");

        // Failed scans never notify.
        String failed = new JSONObject().put("candle", 0).put("interval_minutes", 15).put("error", "เชื่อมต่อ Binance Futures ไม่ได้").put("signals", all).toString();
        SignalAlerts.Plan f = SignalAlerts.plan(failed, now, key -> -1L);
        check(!f.ok && f.notes.isEmpty() && f.status.contains("สแกนไม่สำเร็จ"), "error packet (offline/blocked) -> no notification, status recorded");
        check(!SignalAlerts.plan("not json", now, key -> -1L).ok, "malformed JSON is refused");
        check(!SignalAlerts.plan(packet(30, candle, all), now, key -> -1L).ok, "unsupported timeframe is refused");

        // Contract violations are dropped item by item.
        JSONArray bad = new JSONArray()
            .put(item("BTCUSD", "LONG", "M15", candle))                    // not a USDT perpetual symbol
            .put(item("ETHUSDT", "BUY", "M15", candle))                    // side
            .put(item("SOLUSDT", "LONG", "M5", candle))                    // timeframe mismatch
            .put(item("XRPUSDT", "LONG", "M15", candle - m15))            // signal from an older candle
            .put(item("ADAUSDT", "LONG", "M15", candle).put("entry", "")) // missing price
            .put(item("DOGEUSDT", "LONG", "M15", candle));                 // valid
        SignalAlerts.Plan b = SignalAlerts.plan(packet(15, candle, bad), now, key -> -1L);
        check(b.notes.size() == 1 && b.invalid == 5, "5 invalid items dropped, 1 valid kept");
        JSONObject noEvidence = item("LINKUSDT", "LONG", "M15", candle);
        noEvidence.remove("evidence");
        check(SignalAlerts.plan(packet(15, candle, new JSONArray().put(noEvidence)), now, key -> -1L).notes.get(0).body.contains("ยังไม่มีข้อมูลยืนยัน"),
            "missing evidence is shown as 'no confirming data', never as a number");
        check(SignalAlerts.plan(packet(15, candle, new JSONArray()), now, key -> -1L).ok, "no signals is a normal, successful scan");

        // Real packets produced by web/app.js in headless Chrome (tests/js) must pass the same contract.
        for (String path : args) {
            JSONObject pkt = new JSONObject(new String(Files.readAllBytes(Paths.get(path)), "UTF-8"));
            long c = pkt.getLong("candle");
            SignalAlerts.Plan real = SignalAlerts.plan(pkt.toString(), c + 20_000L, key -> -1L);
            int expected = pkt.getJSONArray("signals").length();
            check(real.ok && real.invalid == 0 && real.notes.size() == expected, "JS packet " + Paths.get(path).getFileName() + ": " + expected + " valid notification(s)");
        }
        System.out.println("PASSED " + passed + " checks");
    }
}
