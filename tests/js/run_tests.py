#!/usr/bin/env python3
"""Headless-Chrome tests of the real index.html against a mock USD-M futures API (mock_futures.js).
Each case loads the app, lets it scan, and checks the JSON packet the app hands to the Android alerts.
Packets with signals are written to tests/js/out/ and re-checked by tools/java-tests (same contract).
Usage: python3 tests/js/run_tests.py   (SOFT=1: report failed checks and go on; DUMP=<dir>: write each case's result there)"""
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
    if os.environ.get("DUMP"):
        (Path(os.environ["DUMP"]) / (case + ".json")).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return res


passed = 0
def check(ok, what):
    global passed
    if not ok:
        if os.environ.get("SOFT"):
            print("FAIL -", what); return
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

    r = run(page, "release_4h", {"storage": store12, "capital": 1_000_000, "trendForce": {}, "waitMs": 15000, "releaseTf": True}, bg=False)
    check(r["tfButtons"] == 0 and 240 in r["scanMinutes"] and 15 not in r["scanMinutes"] and "ระบบเทรด Trend 4H" in r["smMain"],
          "v6.2: no timeframe choice; an install that had M15 runs Trend 4H, alarm every 240 minutes")
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
    check(pk["note"] != "" and [s["kind"] for s in pk["signals"]] == ["EXIT", "BLOCKED"], "drawdown stop: new entries paused (the ETH signal notifies as BLOCKED, no order), the exit still goes out")

    # Trend 4H stop rule from research/pro: a 15% drawdown is inside the test's range (normal for trend following),
    # so entries go on; past the test's deepest drawdown they stop.
    loss15 = json.loads(json.dumps(loss)); loss15["trades"][0]["pnl"] = -150_000
    ev = evidence_with(NORMAL, "none", 30.0)
    r = run(page, "h4_stop_normal", {"storage": dict(h4, **{"portfolio.v1": json.dumps(loss15)}), "capital": 1_000_000, "trendEvidence": ev,
                                     "trendForce": {"ETHUSDT": "LONG"}})
    check(r["packet"]["note"] == "" and [s["kind"] for s in r["packet"]["signals"]] == ["ENTRY"], "Trend: 15% drawdown is within the test's range -> entries continue")
    r = run(page, "h4_stop_deep", {"storage": dict(h4, **{"portfolio.v1": json.dumps(loss)}), "capital": 1_000_000, "trendEvidence": ev,
                                   "trendForce": {"BTCUSDT": "EXIT_LONG", "ETHUSDT": "LONG"}})
    check("เกินที่ผลทดสอบเคยเจอ (30.0%)" in r["packet"]["note"] and [s["kind"] for s in r["packet"]["signals"]] == ["EXIT", "BLOCKED"],
          "Trend: drawdown beyond the test's deepest -> new entries stop (signal notifies as BLOCKED), exits still go out")
    r = run(page, "h4_stop_half", {"storage": dict(h4, **{"portfolio.v1": json.dumps(loss15)}), "capital": 1_000_000, "trendEvidence": evidence_with(NORMAL, "half15", 30.0),
                                   "trendForce": {"ETHUSDT": "LONG"}})
    sg = r["packet"]["signals"]
    check(r["packet"]["note"] == "" and len(sg) == 1 and sg[0]["risk_pct"] == "0.25",
          "Trend: whatever rule 2020-2022 picked, the app trades every signal at the set risk (risk-cutting rules lost the 2023-2026 profit)")

    r = run(page, "h4_default", {"storage": {"alertCoins": json.dumps(["BTCUSDT"]), "tradeTf": "15m"}, "capital": 1_000_000, "trendForce": {}, "releaseTf": True})
    check(r["packet"]["interval_minutes"] == 240 and 240 in r["scanMinutes"], "update moves an old M15 install to Trend 4H once, alarm to 240 minutes")

    r = run(page, "h4_ladder", {"storage": h4, "capital": 10_000_000, "trendForce": {"BTCUSDT": "LONG"}})
    b = r["packet"]["signals"][0]
    check(b["win_pct"] and 20 <= float(b["win_pct"]) <= 60 and b["grade"] in ("good", "weak", "bad"), "packet carries the coin's test win rate and grade (not an invented confidence)")
    check(b["tp_plan"].startswith("TP แบ่งขาย: TP1 ") and b["tp1"] and on_grid(b["tp1"], 0.1) and b["tp5"] == "" and b["exit_rule"].startswith("ส่วนที่เหลือ"),
          "scale-out mode: packet carries TP1 on the tick grid, the plan text and the runner's exit")
    check(float(b["tp1"].replace(",", "")) > float(b["entry"].replace(",", "")), "LONG take profit above the entry")
    (OUT / "h4_ladder.json").write_text(json.dumps(r["packet"], ensure_ascii=False), encoding="utf-8")

    r = run(page, "h4_coach", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "LONG", "ETHUSDT": "SHORT", "SOLUSDT": "HOLD_LONG"}, "clickTf": "4h",
                               "waitMs": 15000, "justClosed": 14_400_000, "openDetails": 8000}, bg=False)
    shown = r["smMain"] + r["coach"]
    follow = r["smMain"].split("สัญญาณใหม่ · ยังอยู่ในจุดเข้า", 1)[-1].split("จบสัญญาณแล้ว", 1)[0]
    check("เข้า LONG BTC x" in follow and "เข้า SHORT ETH x" in follow and "BTCUSDT Perp" in follow and r["acts"] == ["card act l st-follow", "card act s st-follow"],
          "can follow now: one order card per signal (BTC LONG, ETH SHORT), the full sheet folded inside")
    check("เหลือเวลาเข้า 13:" in follow and re.search(r"\(ถึง \d\d:15 น\.\)", follow) and re.search(r"ตอนนี้ [\d,.]+ \([+-]0\.00% · [+-]0\.00R จากจุดเข้า\)", follow),
          "live: entry countdown and the price against the entry, every second")
    check(r["navPanes"] == ["home", "sig", "chart", "res", "more"], "v8: a bottom bar with five panes (home, signals, chart, results, more)")
    hm = r["home"]
    check(len(r["homeRows"]) == 2 and all("VALID SIGNAL" in x and "TRADEABLE" in x for x in r["homeRows"]) and any("BTC" in x for x in r["homeRows"]) and any("ETH" in x for x in r["homeRows"]),
          "home: one row per valid signal (BTC, ETH) with its signal status and whether it can be opened")
    check("เช็กครั้งถัดไป" in hm and "ราคาสด" in hm and "ผล 30 วันของระบบ" in hm and "ความเสี่ยงของไม้นี้" not in hm and "ข่าวดี" not in hm,
          "home: status, live feed, next check and the 30-day line; no order sheets or news")
    check("NOT VALIDATED" in r["res"] and "สถานะก่อนใช้เงินจริง" in r["res"] and "ผลแยกช่วง · กฎเดียวกัน" in r["res"], "results pane: validation status (NOT VALIDATED) and results by period")
    check("ข่าว" in r["more"] and r["routine"], "more pane: the trading plan and the news")
    check(follow.count("VALID SIGNAL") == 2 and follow.count("TRADEABLE") == 2, "signal status (VALID SIGNAL) and execution feasibility (TRADEABLE) are two separate labels")
    check(follow.count("ครบองค์ประกอบสูตร 10/10 (100%)") == 2 and "ไม่ใช่โอกาสชนะ" in follow, "each followable signal shows how completely the rule's conditions are met (10/10)")
    check("ไม้ของระบบที่อยู่ +0.00R แบบนี้ จบกำไร 35%" in follow, "live odds: a trade at its entry ended in profit 35% of the time in 2020-2026")
    check("30 วัน (" in r["smMain"] and "ก่อนหักต้นทุน" in r["smMain"] and "ค่าธรรมเนียม Taker −" in r["smMain"] and "คิดซ้ำเป็นต้นทุน" in r["smMain"] and "→ สุทธิ" in r["smMain"],
          "the last 30 days split into gross R, taker fees, slippage (in prices and charged again), funding and net R")
    check("ปีที่กำไร" not in r["smMain"] and "79%" not in r["smMain"].split("สัญญาณใหม่ · ยังอยู่ในจุดเข้า")[0], "the untested 'profitable years ≈79%' figure is gone")
    check("ผลแยกช่วง · กฎเดียวกัน" in r["smMain"] and all(y in r["smMain"] for y in ["2023", "2024", "2025", "2026 (ถึง ก.ย.)", "รวม 2023–2026", "30 วันล่าสุด (สดของระบบ)"]),
          "results by period with the same rule: each year, all of 2023-2026 and the system's last 30 days")
    check("ต้นทุนไป-กลับ" in follow and "ค่าธรรมเนียม Taker ≈" in follow and "funding ≈" in follow, "order cards show fee, slippage and funding in baht")
    wins = re.findall(r"โอกาสกำไร (\d+)%", follow)
    check(len(wins) >= 2 and len(set(wins)) == 1, "every coin shows the system's win rate (" + ",".join(sorted(set(wins))) + "%): coin win rates did not carry over in the test")
    check(all(k in follow for k in ["ความเสี่ยงของไม้นี้", "% ของไม้แบบนี้ในผลทดสอบ", "ถ้าโดน SL", "ระบบเคยแพ้ติดกัน", "พอร์ตเคยลงลึกสุด", "Liquidation (ประมาณ)"]),
          "each order card says what the trade can cost: chance of losing, baht at the SL, the worst losing run and drawdown, liquidation")
    card_q, sheet_q = re.search(r"ขนาด([\d.]+)BTC", follow), re.search(r"ขนาด \(Size\)([\d.]+) BTC", follow)
    check(card_q and sheet_q and float(card_q.group(1)) == float(sheet_q.group(1)), "live size at the entry price equals the sheet's size")
    check(all(k in r["smMain"] for k in ["ราคาเข้า ≈", "Stop Loss", "TP1 ขาย 50%", "ขนาด", "Margin", "เสี่ยง", "เข้าภายใน"]), "the order card holds every number to type in Binance")
    check(r["charts"] >= 3, "charts draw when opened: one per signal and one for the held position (" + str(r["charts"]) + ")")
    check("ระบบจำลองกำลังถือสถานะ 1" in r["smMain"] and "LONG SOL +" in r["smMain"].split("ระบบจำลองกำลังถือสถานะ", 1)[1] and "(เกิน 0.5R)" in r["smMain"],
          "the system's SOL position, +1R from its entry, sits under holding / too late to follow, with how far it is")
    for must in ["LONG x", "SHORT x", "โอกาสกำไร", "เสี่ยง ", "ไม้ที่ชนะได้เฉลี่ย", "เป็นสถิติ ไม่ใช่การรับประกัน", "Leverage", "ความเสี่ยงต่อไม้", "Margin ที่วาง", "ทำไม x", "ความเสี่ยง", "LONG (Buy)", "SHORT (Sell)", "แท่งสัญญาณปิด", "เข้าภายใน", "ราคาเข้าอ้างอิง", "Stop Loss", "TP1 · ขาย", "ส่วนที่เหลือ", "Liquidation (ประมาณ)",
                 "Isolated", "Leverage", "ขนาด (Size)", "มูลค่าสัญญา", "Margin ที่ใช้", "ค่าธรรมเนียม+slippage", "ราคาขยับ 1%", "ผิดทาง: โดน SL ทั้งไม้",
                 "ถึง TP1 แล้วกลับมาโดน SL", "ถึงทุก TP แล้วส่วนที่เหลือวิ่งถึง +5R", "ปิดกำไร", "ราคาไปถึง +1R", "ไม่ถึง +1R เลย", "กำไรเฉลี่ยต่อไม้",
                 "เข้าแล้ว · บันทึกลงพอร์ต"]:
        check(must in r["smMain"], "trade sheet shows: " + must)
    fa = r["floatAlert"]
    check(r["floatShown"] and "LONG BTC x" in fa and "SHORT ETH x" in fa and fa.count("เสี่ยง ") == 2 and "SL " in fa and "แตะดู" in fa,
          "new signals pop a floating bar: side, coin, leverage, risk, entry/SL")
    check(sorted(r["floatCls"]) == ["fa l", "fa s"], "floating bars coloured by side (green LONG, red SHORT)")
    check(sorted(r["sheets"]) == ["sm-sum sm-sheet l", "sm-sum sm-sheet s"] and r["holds"] == ["card hold l st-hold"], "sheets and the held SOL LONG card in their side's colour")
    check(r["tfButtons"] == 0 and "ระบบเทรด Trend 4H" in r["smMain"] and "เช็กครั้งถัดไป" in r["smMain"] and "ผลงานระบบ 30 วัน" in r["smMain"],
          "main screen: the system's status and next check, no timeframe buttons, its 30-day record")
    check("ขั้นที่" not in shown and "ภาพจำลองหน้า Binance" not in shown and "ทำตามภาพ" not in shown, "no coaching steps or Binance look-alike")
    check("NaN" not in shown and "undefined" not in shown, "main screen has no NaN/undefined for a signal without TP")

    r = run(page, "h4_small", {"storage": h4, "capital": 37, "trendForce": {"ETHUSDT": "SHORT", "SOLUSDT": "HOLD_SHORT"}, "clickTf": "4h", "waitMs": 15000,
                               "justClosed": 14_400_000, "openDetails": 8000}, bg=False)
    sg = r["packet"]["signals"]
    check(not [x for x in sg if x["kind"] == "ENTRY"], "37 THB: Binance's smallest ETH order would risk far more than 0.25% -> no ENTRY alert (NO TRADE)")
    bl = [x for x in sg if x["kind"] == "BLOCKED"]
    check(len(bl) == 1 and bl[0]["symbol"] == "ETHUSDT" and bl[0]["side"] == "SHORT" and "ทุนไม่พอ" in bl[0]["reason"] and bl[0]["entry"] and bl[0]["sl"] and "qty" not in bl[0],
          "37 THB: the valid ETH signal still notifies, as BLOCKED (levels and why, no order size)")
    check("ทุนไม่พอ ไม่สามารถเข้าไม้ตามความเสี่ยงที่กำหนด" in r["smMain"] and "ETHUSDT Perp" not in r["smMain"] and r["acts"] == ["card act blocked s st-follow"],
          "37 THB: the screen says capital is not enough for the set risk; no order to copy, risk never raised")
    check("VALID SIGNAL" in r["smMain"] and "BELOW EXCHANGE MINIMUM" in r["smMain"] and "ใบสั่ง: NO TRADE" in r["smMain"] and "TRADEABLE" not in r["smMain"],
          "37 THB: the ETH signal stays visible as VALID SIGNAL, marked BELOW EXCHANGE MINIMUM, never as tradeable")
    check("NO TRADE: ทุนไม่พอ" in r["smMain"], "37 THB: the system's SOL position offers no order either (NO TRADE)")
    check("ระบบจำลองกำลังถือสถานะ 1" in r["smMain"] and "ผลงานระบบ 30 วัน" in r["smMain"] and "เช็กล่าสุด" in r["smMain"],
          "the system's open position, its 30-day record and the status line are shown")
    check(r["chart"] or r["charts"] >= 1, "chart drawn for the open position")
    check("NaN" not in r["smMain"] and "undefined" not in r["smMain"], "37 THB: no NaN/undefined")

    r = run(page, "h4_float_exit", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "EXIT_LONG"}, "clickTf": "4h", "waitMs": 15000,
                                    "justClosed": 14_400_000}, bg=False)
    check(r["floatShown"] and r["floatCls"] == ["fa x"] and "ปิดไม้ LONG BTC ตอนนี้" in r["floatAlert"] and "+1.00R" in r["floatAlert"],
          "an exit pops an orange floating bar: close BTC LONG now, R now")
    ended = r["smMain"].split("จบสัญญาณแล้ว", 1)[-1]
    check(ended.find("ปิด LONG BTC") >= 0 and ended.find("ปิด LONG BTC") < 60 and "ถ้ายังถืออยู่: ปิดด้วย Market ตอนนี้" in ended and r["acts"] == ["card act x"],
          "the exit is the first orange card under signals that ended")

    r = run(page, "h4_open", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "NEAR_LONG", "ETHUSDT": "HOLD_SHORT"}, "clickTf": "4h", "waitMs": 15000,
                              "justClosed": 14_400_000, "openDetails": 8000}, bg=False)
    s = r["smMain"]
    check(r["holds"] == ["card hold l st-follow", "card hold s st-hold"] and "ระบบจำลองถืออยู่ · ราคายังใกล้จุดเข้า" in s and "ระบบจำลองกำลังถือสถานะ 1" in s,
          "BTC 0.2R from its entry can still be followed; ETH +1R is holding, too late to follow")
    check("ถ้าจะเข้าเอง (ครบ 8/10" in s and "ไม่ครบ: ราคาห่างจุดเข้าเกิน 0.5R" in s,
          "a position already +1R away: still an order to join at the market, with how complete the rule is (8/10) and what is missing")
    check(("เข้าตามได้" in s) or ("ไม่แนะนำให้เข้าตาม" in s) or ("ยังไม่มีผลทดสอบการเข้าตาม" in s) or ("ผลทดสอบไม่ชัดว่ากำไร" in s), "a position 0.2R from its entry: the late-entry test decides")
    check("ผลทดสอบบวกน้อย" not in s, "joining late is offered only where the test was clearly profitable, never 'small and unclear'")
    check(r["charts"] >= 2 and "Stop Loss" in s and "TP1" in s, "each open position has its SL/TP and its chart")

    # Live statuses: the price touches the system's SL in the 4-hour bar now forming -> ended; it runs past 0.5R -> too late;
    # 20 minutes after the close a new signal is still followable while the price is within 0.5R (the test of joining late).
    r = run(page, "live_sl", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "NEAR_LONG"}, "clickTf": "4h", "waitMs": 15000,
                              "justClosed": 14_400_000, "forming": {"BTCUSDT": -7}}, bg=False)
    ended = r["smMain"].split("จบสัญญาณแล้ว", 1)[-1]
    check(r["holds"] == ["card hold l st-ended"] and "จบสัญญาณ · แตะ SL" in ended and re.search(r"ราคาแตะ SL [\d,.]+ ในแท่ง 4 ชม\. นี้ \(ไปถึง [\d,.]+\)", ended),
          "live: the forming 4-hour bar touched the system's SL -> the BTC card moves under ended, with the price reached")
    note = r["smMain"].split("สัญญาณใหม่ · ยังอยู่ในจุดเข้า", 1)[0]
    check("แตะ SL ≈ −1.00R" in ended and "LONG BTC แตะ SL แล้ว · จบสัญญาณ" in note and "ถือ 1 ไม้ต่อ" not in note,
          "the ended card shows its result, and the system's note no longer says it holds BTC")
    r = run(page, "home_none", {"storage": h4, "capital": 1_000_000, "trendForce": {}, "clickTf": "4h", "waitMs": 15000, "justClosed": 14_400_000}, bg=False)
    check(r["homeRows"] == [] and "NO SIGNAL" in r["home"] and r["paneOn"] == "home", "home with no signal says NO SIGNAL and lists nothing")
    r = run(page, "live_far", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "NEAR_LONG"}, "clickTf": "4h", "waitMs": 15000,
                               "justClosed": 14_400_000, "liveMove": {"BTCUSDT": 3}}, bg=False)
    check(r["holds"] == ["card hold l st-hold"] and "ราคาห่างจุดเข้า +0.80R (เกิน 0.5R)" in r["smMain"] and "ตอนนี้ไม่ต้องทำอะไร" in r["smMain"],
          "live: price 3% up = 0.8R from the entry -> too late to follow, nothing to follow now")
    check("ไม้ของระบบที่อยู่ +0.80R แบบนี้ จบกำไร 79%" in r["smMain"], "live odds follow the live R: +0.8R ended in profit 79% of the time")
    check("ใกล้จุดเข้า" in r["smMain"] and re.search(r"ถ้าปิด(เหนือ|ใต้) [\d,.]+", r["smMain"]) and ("อีก " in r["smMain"] or "เลยเส้นแล้ว" in r["smMain"]),
          "coins with nothing open: live distance to the close that would start a trade")
    check("ครบองค์ประกอบสูตร 9/10 (90%)" in r["smMain"], "a position 0.8R from its entry misses one condition (within 0.5R): 9/10")
    r = run(page, "live_late", {"storage": h4, "capital": 1_000_000, "trendForce": {"ETHUSDT": "SHORT"}, "clickTf": "4h", "waitMs": 15000,
                                "justClosed": 14_400_000, "afterCloseMs": 20 * 60000}, bg=False)
    check(r["acts"] == ["card act s st-follow"] and "VALID SIGNAL · เข้าช้า" in r["smMain"] and "เลยเวลาเข้ามา 5 นาที" in r["smMain"] and "ผลทดสอบเข้าช้า 1 แท่ง: 1874 ไม้" in r["smMain"],
          "20 minutes after the close: the ETH SHORT card stays, followable late within 0.5R, with the late-entry test")
    check(not r["floatShown"], "a signal past its 15 minutes does not pop the floating bar")

    # The system's own last 30 days worse than anything in the test (the mock's bars): watch, and NO TRADE for new entries.
    r = run(page, "watch_mode", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "LONG", "ETHUSDT": "EXIT_SHORT"}, "realRecent": True})
    check([x["kind"] for x in r["packet"]["signals"]] == ["EXIT", "BLOCKED"], "recent record worse than the test ever had: no ENTRY alert, the EXIT still goes out, the BTC signal notifies as BLOCKED")
    check(r["packet"]["signals"][1]["head"] == "สัญญาณถูกต้อง แต่ NO TRADE" and "ระบบเฝ้าระวัง" in r["packet"]["signals"][1]["reason"], "on watch: the BLOCKED alert says why")
    check(r["packet"]["signals"][0]["kind"] == "EXIT", "exits are never paused")
    r = run(page, "watch_screen", {"storage": h4, "capital": 1_000_000, "trendForce": {"BTCUSDT": "LONG"}, "clickTf": "4h", "waitMs": 15000, "justClosed": 14_400_000,
                                   "realRecent": True}, bg=False)
    check("NO TRADE · ระบบหยุดเข้าไม้ใหม่" in r["smMain"] and "เฝ้าระวัง" in r["smMain"].split("มุมมองของระบบ")[0] and r["acts"] == ["card act blocked l st-follow"] and "BTCUSDT Perp" not in r["smMain"],
          "on watch: confidence 'เฝ้าระวัง', a NO TRADE banner, the BTC signal shown without an order")
    check("NO TRADE · ระบบเฝ้าระวัง" in r["smMain"] and "TRADEABLE" not in r["smMain"], "on watch: the signal's execution label is NO TRADE, not tradeable")

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
    check("ข่าวเศรษฐกิจแรงใน 24 ชม.: CPI m/m" in r["newsTop"], "main screen: a high-impact US release in the next 24 h is flagged at the top")
    check("ปฏิทินเศรษฐกิจสหรัฐ" in n and "CPI m/m" in n and "Unemployment Claims" in n and "GDP q/q" not in n, "calendar: US releases only, with their Thai times")
    check("Solana network outage" in n and "Binance · Delisting" in n and "SOL" in n and "ไม่มี AI" in n, "headlines from the free sources, coins tagged, no AI")
    check("ข่าว SOL 24 ชม." in s and "ข่าวแรงก่อนแท่งถัดไปปิด: CPI m/m" in s.split("รายละเอียดทั้งหมด", 1)[-1], "trade sheet: the coin's headlines and the release due before the next close")
    tone = {t[1]: t for t in r["newsTone"]}
    good, bad = tone.get("Bitcoin ETF inflows hit a record as BTC rallies"), tone.get("Solana network outage halts block production on www.coindesk.com")
    neutral = tone.get("Markets wait for the Fed (www.coindesk.com)")
    check(good and "good" in good[0].split() and good[2] == "rgb(14, 203, 129)" and bad and "bad" in bad[0].split() and bad[2] == "rgb(246, 70, 93)"
          and neutral and neutral[2] not in (good[2], bad[2]), "news: good headlines green, bad headlines red, neutral ones plain")
    check("ข่าวดี = เขียว" in n and "ข่าวร้าย = แดง" in n, "news: the colour key is shown")
    pk = r["packet"]["signals"][0]
    check("ข่าวแรง USD: CPI m/m" in pk["news"] and "Solana network outage" in pk["news"], "entry alert carries the news warning: " + pk["news"][:80])
    check("มุมมองของระบบ" in s and "ตลาดกลัว 38 ↓9 ใน 7 วัน" in s and "ข่าวดี 1" in s and "ข่าวร้าย 11" in s and "เข้า LONG SOL ตามระบบ · ข่าวสวนทางไม้นี้" in s,
          "the system's note: market mood with its week, headline count, and what it does with the SOL signal")
    check("ข่าว SOL 24 ชม.ดี 0ร้าย 10ข่าวสวนทางไม้นี้" in s and s.count("ยังไม่ได้ทดสอบกับสูตร") + s.count("ทดสอบกับดัชนี Fear & Greed") == 1 and ("ทดสอบกับดัชนี Fear & Greed" in s or "ยังไม่ได้ทดสอบกับสูตร" in s),
          "order card: the coin's news read; what the mood study found is said once, in the system's note")
    check("ทำปี 2023–2026 แย่ลง" in s and "→ ข่าวใช้ประกอบ เข้าตามระบบ" in s and "ในอดีต (2020–2026) LONG ตอนตลาดกลัว: " in s,
          "the mood study: the filter chosen on 2020-2022 did worse on 2023-2026, so news is context; past trades in this mood shown as history")
    check(pk["view"].startswith("ตลาดกลัว 38") and pk["view"].endswith("ข่าวสวนทางไม้นี้"), "entry alert carries the news read: " + pk["view"])
    check(r["conf"] and pk["confidence"].startswith(("สูง", "ปานกลาง", "ต่ำ", "เฝ้าระวัง")) and "การทดสอบ" in pk["confidence"], "confidence of the rule on the screen and in the alert: " + pk["confidence"])
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
    check("ไม้ที่คุณบันทึกว่าเข้าแล้ว 2 ไม้" in lv and "+20.00%" in lv and "ราคา 150.0000 → 153.0000 (+2.00%) · +990 ฿ · +0.92R" in lv,
          "entered LONG SOL x10: price +2% at mark -> ROI +20.00% like Binance, +990 baht, +0.92R after fees")
    check("-10.00%" in lv and "(-2.00%)" in lv and "-396 ฿" in lv, "entered SHORT BTC x5, price up 2% -> ROI -10.00%, -396 baht")
    check("TP1 159.0000 (อีก +3.92%)" in lv and "SL 147.0000 (ห่าง -3.92%)" in lv, "distance to SL and TP1 from the live price")
    check("รวม +496 ฿" in lv and "ราคาสดทุก 1 วินาที" in lv and "markPrice@1s" in r["ws"] and "btcusdt" in r["ws"] and "solusdt" in r["ws"],
          "total after fees, fed by Binance's mark-price WebSocket every second")
    check("wss://fstream.binance.com/market/stream?streams=" in r["ws"], "mark prices from Binance's /market stream address (the old /stream one went silent on 2026-04-23)")
    check("ราคาสดทุก 1 วินาที · " in r["smMain"], "the main screen says the numbers are live and when the last price came")
    check(r["badge"].startswith("● สด ") and r["badgeCls"] == "live-badge on", "a badge pinned to the corner shows the live feed and the last price's time: " + r["badge"])
    gv = re.search(r"versionName '([\d.]+)'", (ROOT / "android/app/build.gradle").read_text(encoding="utf-8")).group(1)
    check("แอป v" + gv in r["smMain"], "the main screen shows the app version, the same as the APK's (" + gv + ")")
    r = run(page, "live_silent", {"storage": dict(h4, **{"portfolio.v1": json.dumps(held)}), "capital": 100_000, "trendForce": {}, "clickTf": "4h",
                                  "waitMs": 20000, "justClosed": 14_400_000, "wsSilent": True}, bg=False)
    check("ราคาทุก 3 วินาที" in r["live"] and "+20.00%" not in r["live"] and "ROI" in r["live"] and "ราคาทุก 3 วินาที · " in r["smMain"],
          "a socket that connects but sends nothing is dropped after 8 s for REST mark prices every 3 seconds")
    r = run(page, "live_rest", {"storage": dict(h4, **{"portfolio.v1": json.dumps(held)}), "capital": 100_000, "trendForce": {}, "clickTf": "4h",
                                "waitMs": 15000, "justClosed": 14_400_000, "wsDown": True}, bg=False)
    check("ราคาทุก 3 วินาที" in r["live"] and "ROI" in r["live"] and "—" not in r["live"].split("ไม้ที่คุณบันทึกว่าเข้าแล้ว")[1][:200],
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
    check("ผลจริงเทียบผลทดสอบ" in chk and "ปกติ: อยู่ในช่วงที่ผลทดสอบเคยเจอ" in chk and "ทดสอบแพ้ติดกันสูงสุด 999 ไม้" in chk and "ทดสอบลงลึกสุด 99.0%" in chk and "100 ไม้ล่าสุดรวม" in chk,
          "Paper: live record checked against the test's normal range: " + chk[:90])
    check("แพ้ติดกันได้ถึง 999 ไม้" in chk and "อยู่ใต้จุดสูงสุดนานสุด 300 วัน" in chk, "Paper: what is normal for the rule (losing streak, time below the peak)")
    r = run(page, "paper_check_broken", {"storage": h4, "capital": 100_000, "clickId": "pp2026", "waitMs": 20000, "trendEvidence": evidence_with(NORMAL)}, bg=False)
    check("แย่กว่าที่ผลทดสอบเคยเจอ" in r["paperCheck"] and "ทดสอบแพ้ติดกันสูงสุด 17 ไม้" in r["paperCheck"],
          "Paper: a record worse than anything in the test says stop new entries and review")
    r = run(page, "main_normal", {"storage": h4, "capital": 1_000_000, "trendForce": {}, "clickTf": "4h", "waitMs": 15000, "trendEvidence": evidence_with(NORMAL)}, bg=False)
    check("เฝ้าระวัง" not in r["smMain"].split("มุมมองของระบบ")[0], "a recent record within the test's range does not put the system on watch")
    check("ปกติของสูตรนี้" in r["smMain"] and "แพ้ติดกันได้ถึง 17 ไม้" in r["smMain"] and "ไม่ใช่สูตรพัง" in r["smMain"], "main screen: what is normal for the rule")
    print(f"PASSED {passed} checks; packets in {OUT}")


if __name__ == "__main__":
    main()
