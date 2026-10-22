#!/usr/bin/env python3
"""Mock Binance USD-M futures API for the emulator test. Replays real candles (replay.json) shifted so the
signal candle is always the one that just closed. Control: GET /__mode?m=normal|short|stale|down"""
import json, sys, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

R = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "replay.json"))
STEP = 900_000
MODE = {"m": "normal"}
COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "TRXUSDT", "LTCUSDT"]


def series():
    return R["mirror" if MODE["m"] == "short" else "normal"]


def last_open():
    t = int(time.time() * 1000) // STEP * STEP - STEP
    return t - STEP if MODE["m"] == "stale" else t


def klines(start, end, limit):
    ser, lo, rows = series(), last_open(), []
    n = len(ser)
    for k, (o, h, l, c, v) in enumerate(ser):
        t = lo - (n - 1 - k) * STEP
        if t < start or t + STEP - 1 > end:
            continue
        rows.append([t, str(o), str(h), str(l), str(c), str(v), t + STEP - 1, "0", 1, "0", "0", "0"])
        if len(rows) >= limit:
            break
    return rows


class H(BaseHTTPRequestHandler):
    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        print(time.strftime("%H:%M:%S"), MODE["m"], self.path[:120], flush=True)
        if u.path == "/__mode":
            MODE["m"] = q.get("m", "normal")
            return self.send(200, MODE)
        if MODE["m"] == "down":
            return self.send(503, {"msg": "down"})
        if u.path == "/fapi/v1/time":
            return self.send(200, {"serverTime": int(time.time() * 1000)})
        if u.path == "/fapi/v1/exchangeInfo":
            f = [{"filterType": "PRICE_FILTER", "tickSize": "0.01"}, {"filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001"},
                 {"filterType": "MARKET_LOT_SIZE", "stepSize": "0.001", "minQty": "0.001"}, {"filterType": "MIN_NOTIONAL", "notional": "5"}]
            return self.send(200, {"symbols": [{"symbol": s, "status": "TRADING", "contractType": "PERPETUAL", "quoteAsset": "USDT", "filters": f} for s in COINS]})
        if u.path == "/fapi/v1/klines":
            now = int(time.time() * 1000)
            return self.send(200, klines(int(q.get("startTime", now - 500 * STEP)), int(q.get("endTime", now)), int(q.get("limit", 500))))
        if u.path == "/fapi/v1/premiumIndex":
            return self.send(200, {"symbol": q.get("symbol"), "markPrice": str(series()[-1][3])})
        if u.path == "/fapi/v1/ticker/24hr":
            return self.send(200, {"lastPrice": str(series()[-1][3]), "priceChangePercent": "0.5"})
        if u.path == "/fapi/v1/depth":
            return self.send(200, {"asks": [], "bids": []})
        self.send(404, {"msg": "unmocked"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8765), H).serve_forever()
