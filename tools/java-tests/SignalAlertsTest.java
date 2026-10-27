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
        check(first.title.equals("🟢 เข้า LONG BTCUSDT · M15 · x10"), "title: green for LONG, enter + side + symbol + timeframe + leverage");
        check(first.color() == 0xFF0ECB81, "LONG notification accent is green");
        JSONObject sw = item("ETHUSDT", "SHORT", "M15", candle).put("win_pct", "35");
        SignalAlerts.Note sn = SignalAlerts.plan(packet(15, candle, new JSONArray().put(sw)), now, key -> -1L).notes.get(0);
        check(sn.title.equals("🔴 เข้า SHORT ETHUSDT · M15 · x10 · โอกาสกำไร 35%") && sn.color() == 0xFFF6465D, "SHORT: red, with the test win rate in the title");
        check(SignalAlerts.barTitle(sn.title).equals("🔴 SHORT ETH · M15 · x10 · โอกาสกำไร 35%"), "coloured bar: side, coin, leverage and win chance without \"เข้า\"/USDT so it fits one line");
        JSONObject nw = item("SOLUSDT", "LONG", "M15", candle).put("news", "ข่าวแรง USD: CPI m/m 19:30 น.").put("confidence", "ปานกลาง–สูง (ผ่าน 4/6 การทดสอบ) · ปีที่กำไร ≈81%")
                .put("view", "ตลาดกลัว 38 · ข่าว SOL 24 ชม.: ดี 0 · ร้าย 2 → ข่าวสวนทางไม้นี้");
        SignalAlerts.Note nn = SignalAlerts.plan(packet(15, candle, new JSONArray().put(nw)), now, key -> -1L).notes.get(0);
        String[] nl = nn.body.split("\n");
        check(nl[2].equals("📰 ตลาดกลัว 38 · ข่าว SOL 24 ชม.: ดี 0 · ร้าย 2 → ข่าวสวนทางไม้นี้"), "entry: the news read (market mood, the coin's headlines, their direction) under the warning");
        check(nl[1].equals("⚠️ ข่าวแรง USD: CPI m/m 19:30 น.") && nn.body.contains("\nความมั่นใจของสูตร: ปานกลาง–สูง (ผ่าน 4/6 การทดสอบ) · ปีที่กำไร ≈81%"),
                "entry: the news warning right under the order, and the strategy's confidence from the tests");
        check(!SignalAlerts.plan(packet(15, candle, new JSONArray().put(item("SOLUSDT", "LONG", "M15", candle))), now, key -> -1L).notes.get(0).body.contains("⚠️"),
                "no news line when there is no warning");
        check(sn.body.contains("โอกาสกำไร 35% = สัดส่วนไม้แบบนี้ที่ปิดกำไรในช่วงทดสอบ"), "win rate explained as a test statistic, not a promise");
        check(first.body.startsWith("เข้า 100.00 · SL 98.20 · TP 101.80 / 103.60 / 109.00 · x10 · โดน SL เสีย ≈ 25 ฿"), "first line (collapsed view) is the whole order");
        JSONObject withPct = item("BTCUSDT", "LONG", "M15", candle).put("risk_pct", "0.25");
        String fp = SignalAlerts.plan(packet(15, candle, new JSONArray().put(withPct)), now, key -> -1L).notes.get(0).body;
        check(fp.startsWith("เข้า 100.00 · SL 98.20 · TP 101.80 / 103.60 / 109.00 · x10 · เสี่ยง 0.25% (≈ 25 ฿)"), "first line says leverage and risk % of the balance");
        for (String must : new String[]{"UTC+7", "เข้า 100.00", "SL 98.20", "TP1 101.80 (1R)", "TP2 103.60 (2R)", "TP5 109.00 (5R)",
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
        long h4c = (candle / 14_400_000L) * 14_400_000L;
        SignalAlerts.Plan mid = SignalAlerts.plan(packet(240, h4c, new JSONArray()), h4c + 3 * 3_600_000L, key -> -1L);
        check(mid.ok && mid.notes.isEmpty() && mid.status.startsWith("ปกติ · รอแท่ง H4 ถัดไปปิด"),
                "app opened mid-bar: the newest H4 candle past its alert window is normal, not an error (" + mid.status + ")");
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

        // H4 Trend: entries carry no take profit, only the exit rule; exits are their own notification stream.
        long h4 = 4 * 3_600_000L, c4 = candle / h4 * h4, n4 = c4 + 60_000L;
        JSONObject trend = item("BTCUSDT", "LONG", "H4", c4).put("strategy", "donchian4h").put("tp1", "").put("tp2", "").put("tp5", "")
            .put("exit_rule", "ไม่มี TP ตายตัว: ปิดเมื่อแท่ง 4 ชม. ปิดต่ำกว่าจุดต่ำสุด 10 แท่ง");
        SignalAlerts.Plan t4 = SignalAlerts.plan(packet(240, c4, new JSONArray().put(trend)), n4, key -> -1L);
        check(t4.ok && t4.notes.size() == 1 && t4.notes.get(0).title.startsWith("🟢 เข้า LONG BTCUSDT · H4"), "H4 entry without TP is notified, title says H4");
        check(t4.notes.get(0).body.startsWith("เข้า 100.00 · SL 98.20 · ไม่มี TP (ออกตามสูตร) · x10"), "H4 without TP: the first line says so");
        check(t4.notes.get(0).body.contains("ไม่มี TP ตายตัว") && !t4.notes.get(0).body.contains("TP5") && t4.notes.get(0).body.contains("SL 98.20"),
            "H4 entry shows SL and the exit rule instead of TP levels");
        JSONObject laddered = new JSONObject(trend.toString()).put("tp1", "102.00").put("tp2", "104.00")
            .put("tp_plan", "TP แบ่งขาย: TP1 102.00 (+1R ขาย 1/3) · TP2 104.00 (+2R ขาย 1/3) · ที่เหลือถือจนแอปเด้งปิดไม้");
        String lb = SignalAlerts.plan(packet(240, c4, new JSONArray().put(laddered)), n4, key -> -1L).notes.get(0).body;
        check(lb.contains("TP1 102.00 (+1R ขาย 1/3)") && lb.contains("ไม่มี TP ตายตัว"), "H4 entry with a scale-out plan shows the plan and the runner's exit");
        check(lb.startsWith("เข้า 100.00 · SL 98.20 · TP1 102.00 · TP2 104.00"), "scale-out: TP1/TP2 on the first line");
        JSONObject neither = new JSONObject(trend.toString()).put("exit_rule", "");
        check(SignalAlerts.plan(packet(240, c4, new JSONArray().put(neither)), n4, key -> -1L).invalid == 1, "entry with neither TP nor exit rule is dropped");
        check(SignalAlerts.plan(packet(240, c4, new JSONArray().put(trend)), c4 + 16 * 60_000L, key -> -1L).notes.isEmpty(), "H4 alert older than 15 minutes is refused");
        JSONObject exit = new JSONObject().put("kind", "EXIT").put("symbol", "BTCUSDT").put("side", "LONG").put("tf", "H4").put("strategy", "donchian4h")
            .put("candle_close", c4).put("expires", c4 + h4).put("entry", "60000.0").put("sl", "57000.0").put("exit_ref", "66000.0").put("exit_level", "66100.0")
            .put("opened", c4 - 30 * h4).put("r_now", "+2.00").put("rationale", "แท่ง 4 ชม. ปิดต่ำกว่าจุดต่ำสุด 10 แท่ง").put("experimental", true);
        Map<String, Long> seen4 = new HashMap<>();
        SignalAlerts.Seen lookup4 = key -> seen4.getOrDefault(key, -1L);
        SignalAlerts.Plan both = SignalAlerts.plan(packet(240, c4, new JSONArray().put(trend).put(exit)), n4, lookup4);
        check(both.notes.size() == 2 && !both.notes.get(0).key.equals(both.notes.get(1).key), "entry and exit of the same coin/side/candle are separate notifications");
        SignalAlerts.Note ex = both.notes.get(1);
        check(ex.kind.equals("EXIT") && ex.title.equals("🟠 ปิดไม้ LONG BTCUSDT · H4") && ex.color() == 0xFFFF9800, "exit title says close + side + symbol + H4, orange");
        check(ex.body.startsWith("ปิดด้วย Market ตอนนี้ (ถ้าถืออยู่) · ปิดแท่ง 66000.0 · ≈ +2.00R"), "exit first line says what to do");
        for (String must : new String[]{"ที่เข้า 60000.0", "ปิด 66000.0 ต่ำกว่า 66100.0", "≈ +2.00R", "SL เดิม 57000.0", "Close → Market", "ถ้าไม่ได้ถือ", "ไม่ใช่คำสั่งซื้อขาย"}) {
            check(ex.body.contains(must), "exit body contains: " + must);
        }
        check(SignalAlerts.summaryText(both.notes).equals("BTC LONG · ปิด BTC LONG"), "group summary marks exits");
        for (SignalAlerts.Note x : both.notes) seen4.put(x.key, x.candle);
        check(SignalAlerts.plan(packet(240, c4, new JSONArray().put(exit)), n4 + 30_000L, lookup4).duplicates == 1, "exit on the same candle is not repeated");
        check(SignalAlerts.plan(packet(240, c4, new JSONArray().put(new JSONObject(exit.toString()).put("exit_ref", ""))), n4, key -> -1L).invalid == 1,
            "exit without a reference price is dropped");
        check(SignalAlerts.plan(packet(240, c4, new JSONArray().put(new JSONObject(exit.toString()).put("kind", "CLOSE_ALL"))), n4, key -> -1L).invalid == 1,
            "unknown kind is dropped");

        // Capital too small for the rule's risk: an information notification with its own dedup key, never an entry call.
        JSONObject blocked = new JSONObject().put("kind", "BLOCKED").put("symbol", "AVAXUSDT").put("side", "SHORT").put("tf", "H4").put("strategy", "donchian4h")
            .put("candle_close", c4).put("expires", c4 + 900_000L).put("entry", "9.3041").put("sl", "10.0162").put("tp1", "7.1678")
            .put("reason", "ทุน 37 ฿ ไม่พอเข้าตามสูตร: ไม้เล็กสุดของ Binance ถ้าโดน SL เสีย ≈ 10.0 ฿ (27% ของทุน) แต่สูตรให้เสีย 0.25% · ต้องมีทุนอย่างน้อย ≈ 3,950 ฿")
            .put("evidence", "สถิติไม้แบบนี้ (walk-forward 2023–2026): 174 ไม้").put("experimental", true);
        SignalAlerts.Plan bp = SignalAlerts.plan(packet(240, c4, new JSONArray().put(blocked).put(trend)), n4, key -> -1L);
        SignalAlerts.Note bn = bp.notes.get(0);
        check(bp.notes.size() == 2 && bn.title.equals("ทุนไม่พอ · SHORT AVAXUSDT · H4") && bn.key.startsWith("sent:BLOCKED:") && bn.kind.equals("BLOCKED"),
            "capital-blocked signal: own title and dedup key");
        JSONObject paused = new JSONObject(blocked.toString()).put("symbol", "SOLUSDT").put("head", "สัญญาณถูกต้อง แต่ NO TRADE").put("reason", "ระบบเฝ้าระวัง: 50 ไม้ล่าสุดแย่กว่าที่ผลทดสอบเคยเจอ หยุดเข้าไม้ใหม่");
        SignalAlerts.Note pn = SignalAlerts.plan(packet(240, c4, new JSONArray().put(paused)), n4, key -> -1L).notes.get(0);
        check(pn.title.equals("สัญญาณถูกต้อง แต่ NO TRADE · SHORT SOLUSDT · H4") && pn.body.contains("ระบบเฝ้าระวัง") && pn.kind.equals("BLOCKED"),
            "paused signal: BLOCKED with the payload's own heading and reason");

        // Home-screen widget: entries first, then exits, then valid-but-blocked; at most three lines, NO SIGNAL when empty.
        java.util.List<String> wl = SignalAlerts.widgetLines(packet(240, c4, new JSONArray().put(blocked).put(trend)));
        check(wl.size() == 2 && (wl.get(0).startsWith("🔴 เข้า") || wl.get(0).startsWith("🟢 เข้า")), "widget: the entry comes first (" + wl + ")");
        check(wl.get(wl.size() - 1).equals("⚪ SHORT AVAXUSDT".replace("USDT", "") + " · NO TRADE · ทุนไม่พอ"), "widget: a capital-blocked signal says NO TRADE · ทุนไม่พอ");
        check(SignalAlerts.widgetLines(packet(240, c4, new JSONArray())).equals(java.util.Arrays.asList("NO SIGNAL · ไม่มีสัญญาณใหม่")), "widget: no signal says NO SIGNAL");
        check(SignalAlerts.widgetLines("{\"error\":\"timeout\"}").get(0).startsWith("เช็กไม่สำเร็จ: timeout"), "widget: a failed check says so");
        check(SignalAlerts.widgetLines("not json").get(0).equals("อ่านผลเช็กไม่ได้"), "widget: an unreadable packet never crashes");
        JSONArray many = new JSONArray();
        for (String c : new String[]{"BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"}) many.put(new JSONObject(paused.toString()).put("symbol", c));
        java.util.List<String> wm = SignalAlerts.widgetLines(packet(240, c4, many));
        check(wm.size() == 4 && wm.get(3).equals("+2 รายการ · แตะเพื่อดู") && wm.get(0).contains("ระบบเฝ้าระวัง"), "widget: five signals show three and '+2'");
        String foot = SignalAlerts.widgetFooter(packet(240, c4, new JSONArray()), c4 + 60_000L);
        check(foot.equals("เช็กล่าสุด " + SignalAlerts.bangkok(c4 + 60_000L, "HH:mm") + " · แท่งถัดไปปิด " + SignalAlerts.bangkok(c4 + 240 * 60_000L, "HH:mm") + " น."), "widget footer: last check and the next 4-hour close (" + foot + ")");
        check(bn.body.startsWith("สัญญาณ SHORT ที่ 9.3041 · SL 10.0162 · TP1 7.1678 · NO TRADE ไม่มีใบสั่ง"), "blocked first line: the signal and that there is no order");
        for (String must : new String[]{"สัญญาณ SHORT ที่ 9.3041", "SL 10.0162", "TP1 7.1678", "27% ของทุน", "≈ 3,950 ฿", "NO TRADE ไม่มีใบสั่ง"}) {
            check(bn.body.contains(must), "blocked body contains: " + must);
        }
        check(SignalAlerts.plan(packet(240, c4, new JSONArray().put(new JSONObject(blocked.toString()).put("reason", ""))), n4, key -> -1L).invalid == 1,
            "blocked without a reason is dropped");

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
