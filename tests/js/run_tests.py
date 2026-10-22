#!/usr/bin/env python3
"""Headless-Chrome tests of the real index.html against a mock USD-M futures API (mock_futures.js).
Each case loads the app, lets it scan, and checks the JSON packet the app hands to the Android alerts.
Packets with signals are written to tests/js/out/ and re-checked by tools/java-tests (same contract).
Usage: python3 tests/js/run_tests.py"""
import glob, html, json, os, re, shutil, subprocess, sys, tempfile, urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / "out"
COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "TRXUSDT", "LTCUSDT"]
FIELDS = ["symbol", "side", "tf", "strategy", "candle_close", "expires", "entry", "sl", "tp1", "tp2", "tp5", "qty", "margin_usdt",
          "margin_thb", "risk_thb", "leverage", "leverage_cap", "liq_est", "rationale", "evidence", "experimental"]


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


def run(page, case, cfg, bg=True):
    q = "?case=" + case + "&cfg=" + urllib.parse.quote(json.dumps(cfg))
    url = page.as_uri() + q + ("#bg" if bg else "")
    prof = tempfile.mkdtemp()
    try:
        r = subprocess.run([chrome(), "--headless", "--no-sandbox", "--disable-gpu", "--allow-file-access-from-files",
                            f"--user-data-dir={prof}", "--virtual-time-budget=30000", "--dump-dom", url],
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
    store12 = {"alertCoins": json.dumps(COINS), "tradeTf": "15m"}
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

    r = run(page, "smallcap", {"storage": {"alertCoins": json.dumps(["BTCUSDT", "ETHUSDT"]), "tradeTf": "15m"}, "capital": 10000,
                               "force": {"BTCUSDT": "LONG", "ETHUSDT": "SHORT"}})
    pk = r["packet"]
    check([s["symbol"] for s in pk["signals"]] == ["ETHUSDT"], "10,000 THB: BTC under Binance min notional is not notified, ETH is")
    check(any(x.startswith("BTCUSDT") and "ต่ำกว่า" in x for x in pk["rejected"]), "BTC rejection reason recorded (below minQty / min notional)")
    (OUT / "smallcap.json").write_text(json.dumps(pk, ensure_ascii=False), encoding="utf-8")

    r = run(page, "m5", {"storage": {"alertCoins": json.dumps(["SOLUSDT", "XRPUSDT"]), "tradeTf": "5m"}, "capital": 1_000_000,
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

    wide = {"storage": {"alertCoins": json.dumps(["BTCUSDT"]), "tradeTf": "15m", "alertLeverage": "50"}, "capital": 10_000_000, "force": {"BTCUSDT": "LONG"}}
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
    r = run(page, "evidence", {"storage": {"alertCoins": json.dumps(["BTCUSDT", "ETHUSDT"]), "tradeTf": "15m"}, "capital": 10_000_000,
                               "force": {"BTCUSDT": "LONG", "ETHUSDT": "LONG"}, "evidence": ev})
    by = {s["symbol"]: s for s in r["packet"]["signals"]}
    check("95% CI 18.1–45.4%" in by["BTCUSDT"]["evidence"] and "40 ไม้" in by["BTCUSDT"]["evidence"] and by["BTCUSDT"]["evidence_ok"],
          "evidence with n>=30 shows trades, win rate and its 95% Wilson interval")
    check("ขาดทุน" in by["BTCUSDT"]["evidence"], "negative average R is labelled as a loss")
    check(by["ETHUSDT"]["evidence"].startswith("ยังไม่มีข้อมูลยืนยัน") and not by["ETHUSDT"]["evidence_ok"], "n<30 -> 'no confirming data', no percentage")

    r = run(page, "nogemini_bg", {"storage": dict(store12, aiKeys=json.dumps(["AIzaSyTESTKEY_aaaaaaaaaaaaaaaaaaaaaaaa"]), aiAuto="1"),
                                  "capital": 1_000_000, "force": {"BTCUSDT": "LONG"}})
    check(r["posts"] == 0 and len(r["packet"]["signals"]) >= 1, "background scan with a signal and Gemini key: no Gemini request")

    r = run(page, "foreground_tf", {"storage": store12, "capital": 1_000_000, "force": {}, "clickTf": "5m", "waitMs": 15000}, bg=False)
    check(5 in r["scanMinutes"], "main-screen 5m button also moves the Android alarm to 5 minutes")
    check("Paper เท่านั้น" in r["smMain"], "main screen states trial / paper only")
    check(r["spot"] == [], "foreground screen uses futures endpoints only")
    print(f"PASSED {passed} checks; packets in {OUT}")


if __name__ == "__main__":
    main()
