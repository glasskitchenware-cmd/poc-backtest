#!/usr/bin/env python3
"""Headless-Chrome tests of the real index.html against a mock USD-M futures API (mock_futures.js).
Each case loads the app, lets it scan, and checks the JSON packet the app hands to the Android alerts.
Packets with signals are written to tests/js/out/ and re-checked by tools/java-tests (same contract).
Usage: python3 tests/js/run_tests.py"""
import glob, html, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / "out"
COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "TRXUSDT", "LTCUSDT"]
FIELDS = ["symbol", "side", "tf", "strategy", "candle_close", "expires", "entry", "sl", "tp1", "tp2", "tp5", "qty", "margin_usdt",
          "margin_thb", "risk_thb", "leverage", "leverage_cap", "liq_est", "rationale", "evidence", "experimental"]


def evidence_with(normal_rule, chosen="none", max_dd=30.0):
    """The real Trend evidence plus a synthetic 'normal' range and stop rule, so the checks below do not depend on the
    numbers of the latest research run."""
    ev = json.loads((ROOT / "research/pro/evidence_trend_20261022.json").read_text(encoding="utf-8"))
    port = {"taken": 1000, "skipped": 0, "cagr": 30, "maxDD": max_dd, "losingMonths": 42, "worstLosingMonths": 4, "worst3m": -18.5,
            "worstMonth": -12, "underDays": 300}
    nm = dict(normal_rule, port={"0.25": port, "0.5": port, "1": port})
    ev["normal"] = {"rule": nm, "ladder": nm}
    rows = [{"id": i, "name": n, "train": {}, "test": {}} for i, n in [("none", "ไม่มีกติกาหยุด (เทรดทุกสัญญาณ)"), ("half15", "ลดความเสี่ยงครึ่งหนึ่งเมื่อพอร์ตลง 15%")]]
    ev["stopRules"] = {"rule": {"rows": rows, "chosen": chosen}, "ladder": {"rows": rows, "chosen": chosen}}
    return ev


NORMAL = {"n": 1999, "worstStreak": 17, "maxDDR": 40.0, "windows": {str(k): {"p5": -999, "p50": 0, "min": -999} for k in (10, 20, 30, 50, 100)}}


def chrome():
    for c in [os.environ.get("CHROME")] + sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome")) + \
             ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]:
        if c and os.path.exists(c):
            return c
    sys.exit("no Chrome/Chromium found (set CHROME=...)")


def harness():
    page = (ROOT / "index.html").read_text(encoding="utf-8")
    mock = (HERE / "mock_futures.js").read_text(encoding="utf-8")
    driver = (HERE / "driver.js").read_text(encoding="utf-8")
    page = page.replace("<head>", "<head>\n<script>\n" + mock + "\n</script>", 1)
    i = page.rindex("</body>")
    page = page[:i] + "<script>\n" + driver + "\n</script>\n" + page[i:]
    tmp = Path(tempfile.mkdtemp()) / "harness.html"
    tmp.write_text(page, encoding="utf-8")
    return tmp


def run(page, case, cfg, bg=True, virtual_ms=30000):
    q = "?case=" + case + "&cfg=" + urllib.parse.quote(json.dumps(cfg))
    url = page.as_uri() + q + ("#bg" if bg else "")
    prof = tempfile.mkdtemp()
    try:
        r = subprocess.run([chrome(), "--headless", "--no-sandbox", "--disable-gpu", "--allow-file-access-from-files",
                            f"--user-data-dir={prof}", f"--virtual-time-budget={virtual_ms}", "--dump-dom", url],
                           capture_output=True, text=True, timeout=180)
    finally:
        shutil.rmtree(prof, ignore_errors=True)
    m = re.search(r"<title>RESULT (.*?)</title>", r.stdout, re.S)
    if not m:
        raise AssertionError(f"{case}: no result (stderr tail: {r.stderr[-400:]})")
    res = json.loads(html.unescape(m.group(1)))
    p = re.search(r'<pre id="packet">(.*?)</pre>', r.stdout, re.S)
    res["packet"] = json.loads(html.unescape(p.group(1))) if p else None
    return res


passed = 0
def check(ok, what):
    global passed
    if not ok:
        raise AssertionError("FAIL: " + what)
    passed += 1
    print("ok -", what)


def on_grid(text, tick):
    v = float(text.replace(",", ""))
    return abs(round(v / tick) * tick - v) < tick * 1e-6


def main():
    page = harness()
    shutil.rmtree(OUT, ignore_errors=True); OUT.mkdir()
    store12 = {"alertCoins": json.dumps(COINS), "tradeTf": "15m", "trendDefault": "1"}
    sides = {c: ("LONG" if i % 2 == 0 else "SHORT") for i, c in enumerate(COINS)}
    ticks = {"BTCUSDT": 0.1, "ETHUSDT": 0.01, "XRPUSDT": 0.0001, "DOGEUSDT": 0.00001}

    r = run(page, "all12", {"storage": store12, "capital": 10_000_000, "force": sides})
    pk = r["packet"]
    check(r["packets"] == 1 and pk and pk["error"] == "", "12 coins M15: one packet, no error")
    check(pk["interval_minutes"] == 15 and pk["scanned"] == 12 and pk["candle"] % 900000 == 0, "packet: 15-minute closed candle, 12 coins scanned")
    check(sorted(s["symbol"] for s in pk["signals"]) == sorted(COINS), "all 12 coins produce their own signal entry")
    check(all(s["side"] == sides[s["symbol"]] for s in pk["signals"]), "LONG and SHORT sides preserved per coin")
    check(all(all(f in s for f in FIELDS) for s in pk["signals"]), "every signal carries the full field contract")
    check(all(s["tf"] == "M15" and s["candle_close"] == pk["candle"] and s["expires"] == pk["candle"] + 900000 for s in pk["signals"]),
          "signal candle = packet candle, expiry = one candle (15 min)")
    check(all(s["experimental"] is True and s["strategy"] == "squeeze3_ls" for s in pk["signals"]), "signals flagged experimental with strategy id")
    for s in pk["signals"]:
        if s["symbol"] in ticks:
            t = ticks[s["symbol"]]
            check(all(on_grid(s[k], t) for k in ("entry", "sl", "tp1", "tp2", "tp5")), f"{s['symbol']} prices on tick grid {t}")
    btc = next(s for s in pk["signals"] if s["symbol"] == "BTCUSDT")
    e, sl, tp5 = (float(btc[k].replace(",", "")) for k in ("entry", "sl", "tp5"))
    check(sl < e < tp5 and abs((tp5 - e) / (e - sl) - 5) < 0.01, "BTC LONG: SL below, TP5 = 5R above")
    check(5 <= btc["leverage"] <= btc["leverage_cap"] and btc["leverage_cap"] == 10, "leverage within user cap (default 10x), never above")
    check(r["spot"] == [], "no Spot endpoints used for futures signals")
    (OUT / "all12.json").write_text(json.dumps(pk, ensure_ascii=False), encoding="utf-8")

    r = run(page, "smallcap", {"storage": {"alertCoins": json.dumps(["BTCUSDT", "ETHUSDT"]), "tradeTf": "15m", "trendDefault": "1"}, "capital": 10000,
                               "force": {"BTCUSDT": "LONG", "ETHUSDT": "SHORT"}})
    pk = r["packet"]
    check([s["symbol"] for s in pk["signals"]] == ["ETHUSDT"], "10,000 THB: BTC under Binance min notional is not notified, ETH is")
    check(any(x.startswith("BTCUSDT") and "ต่ำกว่า" in x for x in pk["rejected"]), "BTC rejection reason recorded (below minQty / min notional)")
    (OUT / "smallcap.json").write_text(json.dumps(pk, ensure_ascii=False), encoding="utf-8")

    r = run(page, "m5", {"storage": {"alertCoins": json.dumps(["SOLUSDT", "XRPUSDT"]), "tradeTf": "5m", "trendDefault": "1"}, "capital": 1_000_000,
                         "force": {"SOLUSDT": "LONG", "XRPUSDT": "SHORT"}})
    pk = r["packet"]
    check(pk["interval_minutes"] == 5 and pk["candle"] % 300000 == 0, "M5: 5-minute closed candle")
    check(len(pk["signals"]) == 2 and all(s["tf"] == "M5" and s["expires"] == pk["candle"] + 300000 for s in pk["signals"]),
          "M5 signals expire after one 5-minute candle")
    (OUT / "m5.json").write_text(json.dumps(pk, ensure_ascii=False), encoding="utf-8")

    r = run(page, "nosignal", {"storage": store12, "capital": 1_000_000, "force": {}})
    check(r["packet"]["error"] == "" and r["packet"]["signals"] == [], "no signals: successful packet with an empty list")

    r = run(page, "stale", {"storage": store12, "capital": 1_000_000, "force": sides, "stale": True})
    check(r["packet"]["signals"] == [] and "ไม่สด" in r["packet"]["error"], "exchange one candle behind: no signals, error says stale")

    r = run(page, "offline", {"storage": store12, "capital": 1_000_000, "force": sides, "offline": True})
    check(r["packet"]["signals"] == [] and r["packet"]["error"] != "", "network offline: error packet, no signals")

    r = run(page, "markfar", {"storage": store12, "capital": 1_000_000, "force": sides, "markFar": True})
    pk = r["packet"]
    check(pk["signals"] == [] and len(pk["rejected"]) == 12 and all("mark" in x for x in pk["rejected"]), "mark price 2% away: all 12 rejected")

    wide = {"storage": {"alertCoins": json.dumps(["BTCUSDT"]), "tradeTf": "15m", "trendDefault": "1", "alertLeverage": "50"}, "capital": 10_000_000, "force": {"BTCUSDT": "LONG"}}
    r = run(page, "stop8", dict(wide, stopFrac=0.08))
    s8 = r["packet"]["signals"][0]
    check(s8["leverage_cap"] == 50 and s8["leverage"] == 7, "8% stop with a 50x cap: leverage lowered to 7x so liquidation stays beyond SL")
    check(float(s8["liq_est"].replace(",", "")) < float(s8["sl"].replace(",", "")), "estimated liquidation sits below the LONG stop")
    r = run(page, "stop15", dict(wide, stopFrac=0.15))
    pk = r["packet"]
    check(pk["signals"] == [] and any("Leverage" in x for x in pk["rejected"]), "15% stop: no leverage >=5x is safe -> rejected, not notified")

    ev = {"periods": {"oos": "2026-01-01..2026-09-30"}, "costs": "x", "rows": {
        "BTCUSDT|15m": {"oos": {"n": 40, "win": 30.0, "winCI": [18.1, 45.4], "tp5": 15.0, "tp5CI": [7.1, 29.1], "avgR": -0.05, "pf": 0.9}},
        "ETHUSDT|15m": {"oos": {"n": 12, "win": 40.0, "winCI": [15, 70], "tp5": 20.0, "tp5CI": [5, 50], "avgR": 0.3, "pf": 1.4}}}}
    r = run(page, "evidence", {"storage": {"alertCoins": json.dumps(["BTCUSDT", "ETHUSDT"]), "tradeTf": "15m", "trendDefault": "1"}, "capital": 10_000_000,
                               "force": {"BTCUSDT": "LONG", "ETHUSDT": "LONG"}, "evidence": ev})
    by = {s["symbol"]: s for s in r["packet"]["signals"]}
    check("95% CI 18.1–45.4%" in by["BTCUSDT"]["evidence"] and "40 ไม้" in by["BTCUSDT"]["evidence"] and by["BTCUSDT"]["evidence_ok"],
          "evidence with n>=30 shows trades, win rate and its 95% Wilson interval")
    check("ขาดทุน" in by["BTCUSDT"]["evidence"], "negative average R is labelled as a loss")
    check(by["ETHUSDT"]["evidence"].startswith("ยังไม่มีข้อมูลยืนยัน") and not by["ETHUSDT"]["evidence_ok"], "n<30 -> 'no confirming data', no percentage")

    r = run(page, "no_ai", {"storage": dict(store12, aiKeys=json.dumps(["AIzaSyTESTKEY_aaaaaaaaaaaaaaaaaaaaaaaa"]), aiAuto="1"),
                            "capital": 1_000_000, "force": {"BTCUSDT": "LONG"}})
    check(r["aiLeft"] is None and len(r["packet"]["signals"]) >= 1, "v6 has no AI: Gemini keys left by older versions are erased, the scan still alerts")

    r = run(page, "foreground_tf", {"storage": store12, "capital": 1_000_000, "force": {}, "clickTf": "5m", "waitMs": 15000}, bg=False)
    check(5 in r["scanMinutes"], "main-screen 5m button also moves the Android alarm to 5 minutes")
    check("Paper เท่านั้น" in r["smMain"], "main screen states trial / paper only")
    check(r["spot"] == [], "foreground screen uses futures endpoints only")
    # ---- Trend 4H (main strategy since v4.4) ----
    three = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    h4 = {"alertCoins": json.dumps(three), "tradeTf": "4h", "trendDefault": "1"}
    h4n = dict(h4, tpMode="none")   # no take profit: the contract checked below; the scale-out plan has its own cases
    r = run(page, "h4_entry", {"storage": h4n, "capital": 10_000_000, "trendForce": {"BTCUSDT": "LONG", "ETHUSDT": "SHORT"}})
    pk = r["packet"]
    check(pk and pk["error"] == "" and pk["interval_minutes"] == 240 and pk["candle"] % 14_400_000 == 0 and pk["scanned"] == 3,
          "H4: packet for the 4-hour candle that just closed, 3 coins scanned")
    sig = {s["symbol"]: s for s in pk["signals"]}
    check(sorted(sig) == ["BTCUSDT", "ETHUSDT"] and all(s["kind"] == "ENTRY" and s["tf"] == "H4" and s["strategy"] == "donchian4h" for s in sig.values()),
          "H4: one ENTRY per coin the rule enters, strategy donchian4h")
    check(all(all(f in s for f in FIELDS) for s in sig.values()), "H4 entries carry the full field contract")
    check(all(s["tp1"] == s["tp2"] == s["tp5"] == "" and "ไม่มี TP ตายตัว" in s["exit_rule"] for s in sig.values()), "H4 entries: no take profit, the exit rule instead")
    check(all(s["expires"] == pk["candle"] + 900000 for s in sig.values()), "H4 entries: enter within 15 minutes of the close")
    b, e = sig["BTCUSDT"], sig["ETHUSDT"]
    bE, bS, eE, eS = (float(x[k].replace(",", "")) for x in (b, e) for k in ("entry", "sl"))
    check(bS < bE and eS > eE and 0.002 < (bE - bS) / bE < 0.2, "LONG stop below, SHORT stop above, stop = 3 ATR of the real bars")
    check(on_grid(b["entry"], 0.1) and on_grid(b["sl"], 0.1), "H4 BTC prices on tick grid 0.1")
    check(5 <= b["leverage"] <= 10 and b["leverage_cap"] == 10, "H4 leverage within the user cap")
    check("ทะลุจุดสูงสุด 20 แท่ง" in b["rationale"] and "EMA200" in b["rationale"], "H4 rationale names the 20-bar breakout and EMA200")
    check(b["evidence"].startswith("ยังไม่มีข้อมูลยืนยัน") or "walk-forward" in b["evidence"], "H4 evidence: walk-forward table or 'no confirming data'")
    (OUT / "h4_entry.json").write_text(json.dumps(pk, ensure_ascii=False), encoding="utf-8")

    r = run(page, "h4_exit", {"storage": h4n, "capital": 10_000_000, "trendForce": {"BTCUSDT": "EXIT_LONG", "ETHUSDT": "HOLD_SHORT"}})
    pk = r["packet"]
    check(len(pk["signals"]) == 1 and pk["signals"][0]["kind"] == "EXIT" and pk["signals"][0]["symbol"] == "BTCUSDT" and pk["signals"][0]["side"] == "LONG",
          "H4: the rule closing BTC LONG gives one EXIT; a held position gives nothing")
    x = pk["signals"][0]
    check(x["tf"] == "H4" and x["candle_close"] == pk["candle"] and x["opened"] < pk["candle"] and x["r_now"] == "+1.00" and x["exit_ref"] and x["exit_level"],
          "EXIT carries entry, open time, reference close, channel level and R now")
    check("ปิดไม้ BTC LONG" in r["scanCards"] and "ไม้ที่สูตรถืออยู่" in r["scanCards"] and "ETH" in r["scanCards"], "signal tab shows the exit and the held ETH SHORT")
    check(not r["floatShown"], "the background scan's hidden page never pops (or uses up) the in-app floating bar")
    (OUT / "h4_exit.json").write_text(json.dumps(pk, ensure_ascii=False), encoding="utf-8")

    now = int(time.time() * 1000)
    loss = {"trades": [{"id": 1, "symbol": "BTCUSDT", "entry": 1, "stop": 0.9, "qty": 1, "fx": 33, "risk": 1000, "dir": 1, "fee": 0.0007, "lev": 10,
                        "entry_time": now - 3 * 86_400_000, "exit_time": now - 2 * 86_400_000, "exit": 0.85, "pnl": -500_000, "r": -500, "closed": True}], "nextId": 2}
    r = run(page, "h4_paused", {"storage": dict(h4, **{"portfolio.v1": json.dumps(loss)}), "capital": 1_000_000,
                                "trendForce": {"BTCUSDT": "EXIT_LONG", "ETHUSDT": "LONG"}})
    pk = r["packet"]
    check(pk["note"] != "" and [s["kind"] for s in pk["signals"]] == ["EXIT"], "drawdown stop: new entries paused, the exit still goes out")

    # Trend 4H stop rule from research/pro: a 15% drawdown is inside the test's range (normal for trend following),
    # so entries go on; past the test's deepest drawdown they stop.
    loss15 = json.loads(json.dumps(loss)); loss15["trades"][0]["pnl"] = -150_000
    ev = evidence_with(NORMAL, "none", 30.0)
    r = run(page, "h4_stop_normal", {"storage": dict(h4, **{"portfolio.v1": json.dumps(loss15)}), "capital": 1_000_000, "trendEvidence": ev,
                                     "trendForce": {"ETHUSDT": "LONG"}})
    check(r["packet"]["note"] == "" and [s["kind"] for s in r["packet"]["signals"]] == ["ENTRY"], "Trend: 15% drawdown is within the test's range -> entries continue")
    r = run(page, "h4_stop_deep", {"storage": dict(h4, **{"portfolio.v1": json.dumps(loss)}), "capital": 1_000_000, "trendEvidence": ev,
                                   "trendForce": {"BTCUSDT": "EXIT_LONG", "ETHUSDT": "LONG"}})
    check("เกินที่ผลทดสอบเคยเจอ (30.0%)" in r["packet"]["note"] and [s["kind"] for s in r["packet"]["signals"]] == ["EXIT"],
          "Trend: drawdown beyond the test's deepest -> new entries stop, exits still go out")
    r = run(page, "h4_stop_half", {"storage": dict(h4, **{"portfolio.v1": json.dumps(loss15)}), "capital": 1_000_000, "trendEvidence": evidence_with(NORMAL, "half15", 30.0),
                                   "trendForce": {"ETHUSDT": "LONG"}})
    sg = r["packet"]["signals"]
    check(r["packet"]["note"] == "" and len(sg) == 1 and sg[0]["risk_pct"] == "0.25",
          "Trend: whatever rule 2020-2022 picked, the app trades every signal at the set risk (risk-cutting rules lost the 2023-2026 profit)")

    r = run(page, "h4_default", {"storage": {"alertCoins": json.dumps(["BTCUSDT"]), "tradeTf": "15m"}, "capital": 1_000_000, "trendForce": {}})
    check(r["packet"]["interval_minutes"] == 240 and 240 in r["scanMinutes"], "update moves an old M15 install to Trend 4H once, alarm to 240 minutes")

    r = run(page, "h4_ladder", {"storage": h4, "capital": 10_000_000, "trendForce": {"BTCUSDT": "LONG"}})
    b = r["packet"]["signals"][0]
    check(b["win_pct"] and 20 <= float(b["win_pct"]) <= 60 and b["grade"] in ("good", "weak", "bad"), "packet carries the coin's test win rate and grade (not an invented confidence)")
    check(b["tp_plan"].startswith("TP แบ่งขาย: TP1 ") and b["tp1"] and on_grid(b["tp1"], 0.1) and b["tp5"] == "" and b["exit_rule"].startswith("ส่วนที่เหลือ"),
          "scale-out mode: packet carries TP1 on the tick grid, the plan text and the runner's exit")
    check(float(b["tp1"].replace(",", "")) > float(b["entry"].replace(",", "")), "LONG take profit above the entry")
    (OUT / "h4_ladder.json").write_text(json.dumps(r["packet"], ensure_ascii=False), encoding="utf-8")

    r = run(page, "h4_coach", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "LONG", "ETHUSDT": "SHORT", "SOLUSDT": "HOLD_LONG"}, "clickTf": "4h",
                               "waitMs": 15000, "justClosed": 14_400_000}, bg=False)
    shown = r["smMain"] + r["coach"]
    check("สัญญาณน่าเข้า 2 ตัว" in r["smMain"] and "BTCUSDT Perp" in r["smMain"] and "ETHUSDT Perp" in r["smMain"], "every signal worth entering is shown (BTC and ETH)")
    check(r["charts"] >= 3, "a 4h chart per signal plus one for the held position (" + str(r["charts"]) + ")")
    check("ไม้ที่เปิดอยู่ตอนนี้ 1 ไม้" in r["smMain"] and "SOL" in r["smMain"], "open SOL position listed")
    for must in ["LONG x", "SHORT x", "โอกาสกำไร", "เสี่ยง ", "ไม้ที่ชนะได้เฉลี่ย", "เป็นสถิติ ไม่ใช่การรับประกัน", "Leverage", "ความเสี่ยงต่อไม้", "Margin ที่วาง", "ทำไม x", "ความเสี่ยง", "LONG (Buy)", "SHORT (Sell)", "แท่งสัญญาณปิด", "เข้าภายใน", "ราคาเข้าอ้างอิง", "Stop Loss", "TP1 · ขาย", "ส่วนที่เหลือ", "Liquidation (ประมาณ)",
                 "Isolated", "Leverage", "ขนาด (Size)", "มูลค่าสัญญา", "Margin ที่ใช้", "ค่าธรรมเนียม+slippage", "ราคาขยับ 1%", "ผิดทาง: โดน SL ทั้งไม้",
                 "ถึง TP1 แล้วกลับมาโดน SL", "ถึงทุก TP แล้วส่วนที่เหลือวิ่งถึง +5R", "ปิดกำไร", "ราคาไปถึง +1R", "ไม่ถึง +1R เลย", "กำไรเฉลี่ยต่อไม้",
                 "เข้าแล้ว · บันทึกลงพอร์ต"]:
        check(must in r["smMain"], "trade sheet shows: " + must)
    fa = r["floatAlert"]
    check(r["floatShown"] and "🟢 LONG BTC x" in fa and "🔴 SHORT ETH x" in fa and fa.count("เสี่ยง ") == 2 and "SL " in fa and "แตะดู" in fa,
          "new signals pop a floating bar: side, coin, leverage, risk, entry/SL")
    check(sorted(r["floatCls"]) == ["fa l", "fa s"], "floating bars coloured by side (green LONG, red SHORT)")
    check(sorted(r["sheets"]) == ["sm-sum sm-sheet l", "sm-sum sm-sheet l", "sm-sum sm-sheet s"], "trade sheets and the open SOL LONG card are framed in their side's colour")
    check("⏰ แท่ง 4 ชม. ปิด 03:00 · 07:00 · 11:00 · 15:00 · 19:00 · 23:00 น." in r["smMain"] and "รอบถัดไป" in r["smMain"], "main screen: the day's 4h closes in Thai time and the next one")
    check("ขั้นที่" not in shown and "ภาพจำลองหน้า Binance" not in shown and "ทำตามภาพ" not in shown, "no coaching steps or Binance look-alike")
    check("NaN" not in shown and "undefined" not in shown, "main screen has no NaN/undefined for a signal without TP")

    r = run(page, "h4_small", {"storage": h4, "capital": 37, "trendForce": {"ETHUSDT": "SHORT", "SOLUSDT": "HOLD_SHORT"}, "clickTf": "4h", "waitMs": 15000,
                               "justClosed": 14_400_000}, bg=False)
    sg = r["packet"]["signals"]
    check(len(sg) == 1 and sg[0]["kind"] == "ENTRY" and sg[0]["symbol"] == "ETHUSDT" and float(sg[0]["qty"]) >= 0.001 and float(sg[0]["risk_pct"]) > 1,
          "37 THB: the signal is still sent, sized at Binance's smallest order")
    check("ETHUSDT Perp" in r["smMain"] and "(ขั้นต่ำที่ Binance ยอม)" in r["smMain"] and "ทุนไม่พอ" not in r["smMain"] and "ยังเทรดตามสูตรไม่ได้" not in r["smMain"],
          "37 THB: full trade sheet at the smallest order, no capital lecture")
    check("ไม้ที่เปิดอยู่ตอนนี้ 1 ไม้" in r["smMain"] and "สัญญาณ 7 วันล่าสุด" in r["smMain"] and "สแกนล่าสุด" in r["smMain"],
          "open positions, the last 7 days and the status line are shown")
    check(r["chart"] or r["charts"] >= 2, "charts drawn for the signal and the open position")
    check("NaN" not in r["smMain"] and "undefined" not in r["smMain"], "37 THB: no NaN/undefined")
    (OUT / "h4_minsize.json").write_text(json.dumps(r["packet"], ensure_ascii=False), encoding="utf-8")

    r = run(page, "h4_float_exit", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "EXIT_LONG"}, "clickTf": "4h", "waitMs": 15000,
                                    "justClosed": 14_400_000}, bg=False)
    check(r["floatShown"] and r["floatCls"] == ["fa x"] and "🟠 ปิดไม้ LONG BTC ตอนนี้" in r["floatAlert"] and "+1.00R" in r["floatAlert"],
          "an exit pops an orange floating bar: close BTC LONG now, R now")
    check("🟠 ปิดไม้ BTC LONG" in r["smMain"], "the exit is the orange bar on the main screen")

    r = run(page, "h4_open", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "NEAR_LONG", "ETHUSDT": "HOLD_SHORT"}, "clickTf": "4h", "waitMs": 15000,
                              "justClosed": 14_400_000}, bg=False)
    s = r["smMain"]
    check("สัญญาณเข้าใหม่: ไม่มี" in s and "ไม้ที่เปิดอยู่ตอนนี้ 2 ไม้" in s, "no new entry, but the 2 open positions are listed right after")
    check("ถ้ายังไม่ได้เข้า" in s and "ราคาห่างจุดเข้าเกิน 0.5R" in s, "a position already +1R away: do not join late")
    check(("เข้าตามได้" in s) or ("ไม่แนะนำให้เข้าตาม" in s) or ("ยังไม่มีผลทดสอบการเข้าตาม" in s), "a position 0.2R from its entry: the late-entry test decides")
    check(r["charts"] >= 2 and "Stop Loss" in s and "TP1" in s, "each open position has its SL/TP and its chart")

    # A native reply that never comes back must not hang the scan: it fails with a timeout and is reported.
    # (two futures hosts are tried in turn, 50 s each)
    r = run(page, "hang", {"storage": h4n, "capital": 1_000_000, "hang": "/fapi/v1/exchangeInfo", "waitMs": 115000}, virtual_ms=135000)
    check(r["packet"] and "หมดเวลารอ" in r["packet"]["error"], "lost native reply: scan ends with a timeout error instead of hanging")
    check("Trend 4H" in r["help"] and "SL 3 ATR" in r["help"], "settings explain the Trend 4H rule")

    r = run(page, "chart_hold", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "HOLD_SHORT"}, "clickTab": "chartTab", "waitMs": 15000}, bg=False)
    c = r["chartPlan"]
    check("แผน Trend 4H · BTC" in c and "สูตรถือ SHORT อยู่" in c and "จุดเข้า" in c and "Stop Loss" in c and "TP1" in c and "ไม่ต้องเข้าตาม" in c,
          "chart tab: the rule's position on BTC with entry, SL and TP")
    check("โซนรอซื้อ" not in c and "Spot ไม่ซื้อ" not in c, "chart tab: the untested Fibonacci buy-zone plan is gone")
    r = run(page, "chart_flat", {"storage": h4, "capital": 1_000_000, "trendForce": {}, "clickTab": "chartTab", "waitMs": 15000}, bg=False)
    c = r["chartPlan"]
    check("จุดเข้า LONG" in c and "จุดเข้า SHORT" in c and "แท่ง 4 ชม. ปิดเหนือ" in c and "SL ถ้าเข้า LONG" in c and "NaN" not in c,
          "chart tab, no position: the 4h closes that would start a LONG or a SHORT, with SL and TP")

    # Free news, no keys: headlines, Binance announcements and the US calendar on the main screen, the sheet and the alert.
    r = run(page, "news_main", {"storage": h4, "capital": 1_000_000, "trendForce": {"SOLUSDT": "LONG"}, "clickTf": "4h", "waitMs": 15000,
                                "justClosed": 14_400_000}, bg=False)
    n, s = r["news"], r["smMain"]
    check("⚠️ ข่าวเศรษฐกิจแรงใน 24 ชม.: CPI m/m" in r["newsTop"], "main screen: a high-impact US release in the next 24 h is flagged at the top")
    check("ปฏิทินเศรษฐกิจสหรัฐ" in n and "CPI m/m" in n and "Unemployment Claims" in n and "GDP q/q" not in n, "calendar: US releases only, with their Thai times")
    check("Solana network outage" in n and "Binance · Delisting" in n and "SOL" in n and "ไม่มี AI" in n, "headlines from the free sources, coins tagged, no AI")
    check("ข่าว SOL 24 ชม." in s and "⚠️ ข่าวแรงก่อนแท่งถัดไปปิด: CPI m/m" in s, "trade sheet: the coin's headlines and the release due before the next close")
    pk = r["packet"]["signals"][0]
    check("ข่าวแรง USD: CPI m/m" in pk["news"] and "Solana network outage" in pk["news"], "entry alert carries the news warning: " + pk["news"][:80])
    check(r["conf"] and pk["confidence"].startswith(("สูง", "ปานกลาง", "ต่ำ")) and "การทดสอบ" in pk["confidence"], "confidence of the rule on the screen and in the alert: " + pk["confidence"])
    # The professional's routine: the written plan, ticks per day, and the backup through Android's share sheet.
    saved = {"trades": [{"id": 1, "symbol": "SOLUSDT", "entry": 150, "stop": 140, "qty": 1, "fx": 33, "risk": 330, "dir": 1, "fee": 0.0007, "lev": 10,
                         "entry_time": int(time.time() * 1000) - 86_400_000, "closed": False}], "nextId": 2}
    r = run(page, "routine", {"storage": dict(h4, **{"portfolio.v1": json.dumps(saved)}), "capital": 1_000_000, "trendForce": {}, "clickTf": "4h",
                              "waitMs": 15000, "justClosed": 14_400_000, "routine": 6000}, bg=False)
    rt = r["routine"]
    check("แผนเทรดและกิจวัตรแบบมืออาชีพ" in rt and "วันนี้ 1/4" in rt and "เทรดทุกสัญญาณ" in rt and "ทุกสัปดาห์" in rt and "ทุกเดือน" in rt,
          "main screen: the written plan and the daily / weekly / monthly checklists, today's tick kept (1/4)")
    b = json.loads(r["shared"]) if r["shared"] else {}
    check(b.get("app") == "POC Signal" and "SOLUSDT" in b.get("data", {}).get("portfolio.v1", "") and "routine.v1" in b.get("data", {}),
          "backup: the saved trades, the routine and the settings go out as one text through the share sheet")
    check("กู้คืนไม่ได้: ไม่ใช่ข้อความสำรองของแอปนี้" in r["rtStatus"], "restore refuses a text that is not this app's backup")
    # Trades already entered: live P&L at Binance's mark price (WebSocket every second, REST every 3 s when it fails).
    now_ms = int(time.time() * 1000)
    held = {"trades": [
        {"id": 1, "symbol": "SOLUSDT", "entry": 150, "stop": 147, "qty": 10, "fx": 33, "risk": 1000, "dir": 1, "fee": 0.0007, "lev": 10, "tp1": 159, "entry_time": now_ms - 3_600_000, "closed": False},
        {"id": 2, "symbol": "BTCUSDT", "entry": 60000, "stop": 61500, "qty": 0.01, "fx": 33, "risk": 500, "dir": -1, "fee": 0.0007, "lev": 5, "entry_time": now_ms - 3_600_000, "closed": False}], "nextId": 3}
    r = run(page, "live_pnl", {"storage": dict(h4, **{"portfolio.v1": json.dumps(held)}), "capital": 100_000, "trendForce": {}, "clickTf": "4h",
                               "waitMs": 15000, "justClosed": 14_400_000, "livePct": 2}, bg=False)
    lv = r["live"]
    check("ไม้ที่เข้าแล้ว 2 ไม้" in lv and "+20.00%" in lv and "ราคา 150.0000 → 153.0000 (+2.00%) · +990 ฿ · +0.92R" in lv,
          "entered LONG SOL x10: price +2% at mark -> ROI +20.00% like Binance, +990 baht, +0.92R after fees")
    check("-10.00%" in lv and "(-2.00%)" in lv and "-396 ฿" in lv, "entered SHORT BTC x5, price up 2% -> ROI -10.00%, -396 baht")
    check("TP1 159.0000 (อีก +3.92%)" in lv and "SL 147.0000 (ห่าง -3.92%)" in lv, "distance to SL and TP1 from the live price")
    check("รวม +496 ฿" in lv and "ราคาสดทุก 1 วินาที" in lv and "markPrice@1s" in r["ws"] and "btcusdt" in r["ws"] and "solusdt" in r["ws"],
          "total after fees, fed by Binance's mark-price WebSocket every second")
    r = run(page, "live_rest", {"storage": dict(h4, **{"portfolio.v1": json.dumps(held)}), "capital": 100_000, "trendForce": {}, "clickTf": "4h",
                                "waitMs": 15000, "justClosed": 14_400_000, "wsDown": True}, bg=False)
    check("ราคาทุก 3 วินาที" in r["live"] and "ROI" in r["live"] and "—" not in r["live"].split("ไม้ที่เข้าแล้ว")[1][:200],
          "WebSocket refused -> live P&L from REST mark price every 3 seconds")
    r = run(page, "news_down", {"storage": h4, "capital": 1_000_000, "trendForce": {"ETHUSDT": "LONG"}, "newsDown": True})
    check([x["kind"] for x in r["packet"]["signals"]] == ["ENTRY"] and r["packet"]["signals"][0]["news"] == "", "every news source down: the entry alert still goes out")

    r = run(page, "paper_trend", {"storage": h4, "capital": 100_000, "clickId": "pp2026", "waitMs": 20000}, bg=False)
    check("Trend 4H · 3 เหรียญ" in r["paperTitle"] and "บาท" in r["paper"] and "อัปเดต" in r["paperStatus"], "Paper runs Trend 4H on the selected coins: " + r["paperStatus"][:60])
    check("NaN" not in r["paper"] and "undefined" not in r["paper"], "Paper Trend view has no NaN/undefined")
    check(r["spot"] == [], "Paper uses futures endpoints only")
    # The mock's 2026 bars give the rule a long losing run: against a wide test range it reads as normal, against the
    # real-looking range (17 losses in a row at most, 30% drawdown) as worse than anything the test showed.
    r = run(page, "paper_check_ok", {"storage": h4, "capital": 100_000, "clickId": "pp2026", "waitMs": 20000,
                                     "trendEvidence": evidence_with(dict(NORMAL, worstStreak=999), "none", 99.0)}, bg=False)
    chk = r["paperCheck"]
    check("ผลจริงเทียบผลทดสอบ" in chk and "✅ ปกติ" in chk and "ทดสอบแพ้ติดกันสูงสุด 999 ไม้" in chk and "ทดสอบลงลึกสุด 99.0%" in chk and "100 ไม้ล่าสุดรวม" in chk,
          "Paper: live record checked against the test's normal range: " + chk[:90])
    check("แพ้ติดกันได้ถึง 999 ไม้" in chk and "อยู่ใต้จุดสูงสุดนานสุด 300 วัน" in chk, "Paper: what is normal for the rule (losing streak, time below the peak)")
    r = run(page, "paper_check_broken", {"storage": h4, "capital": 100_000, "clickId": "pp2026", "waitMs": 20000, "trendEvidence": evidence_with(NORMAL)}, bg=False)
    check("⛔ แย่กว่าที่ผลทดสอบเคยเจอ" in r["paperCheck"] and "ทดสอบแพ้ติดกันสูงสุด 17 ไม้" in r["paperCheck"],
          "Paper: a record worse than anything in the test says stop new entries and review")
    r = run(page, "main_normal", {"storage": h4, "capital": 1_000_000, "trendForce": {}, "clickTf": "4h", "waitMs": 15000, "trendEvidence": evidence_with(NORMAL)}, bg=False)
    check("ปกติของสูตรนี้" in r["smMain"] and "แพ้ติดกันได้ถึง 17 ไม้" in r["smMain"] and "ไม่ใช่สูตรพัง" in r["smMain"], "main screen: what is normal for the rule")
    print(f"PASSED {passed} checks; packets in {OUT}")


if __name__ == "__main__":
    main()
