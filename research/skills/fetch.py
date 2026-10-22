#!/usr/bin/env python3
"""Downloads Binance USD-M futures klines (official monthly archives) to bars/<SYMBOL>_<TF>.json."""
import io, json, sys, zipfile
from pathlib import Path
import requests

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]
TFS = ["5m", "15m", "1h", "4h"]
MONTHS = [f"{y}-{m:02d}" for y in (2023, 2024, 2025, 2026) for m in range(1, 13) if "2023-10" <= f"{y}-{m:02d}" <= "2026-09"]
BASE = "https://data.binance.vision/data/futures/um/monthly/klines"
out = Path("bars"); out.mkdir(exist_ok=True)
s = requests.Session()
for sym in SYMBOLS:
    for tf in TFS:
        rows = []
        for ym in MONTHS:
            r = s.get(f"{BASE}/{sym}/{tf}/{sym}-{tf}-{ym}.zip", timeout=60)
            r.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                text = z.read(z.namelist()[0]).decode()
            for line in text.splitlines():
                p = line.split(",")
                if not p[0].isdigit():
                    continue
                t = int(p[0]); t = t // 1000 if t > 1e15 else t
                ct = int(p[6]); ct = ct // 1000 if ct > 1e15 else ct
                rows.append([t, float(p[1]), float(p[2]), float(p[3]), float(p[4]), float(p[5]), ct])
        rows.sort()
        (out / f"{sym}_{tf}.json").write_text(json.dumps(rows))
        print(sym, tf, len(rows), "bars", flush=True)
