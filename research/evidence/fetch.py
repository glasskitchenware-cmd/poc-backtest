#!/usr/bin/env python3
"""Download Binance USD-M futures klines (official monthly archives) into bars/<SYMBOL>_<TF>.json.
Usage: python fetch.py SYMBOL[,SYMBOL...] TF[,TF...]"""
import io, json, sys, zipfile
from pathlib import Path
import requests

SYMBOLS = sys.argv[1].split(",")
TFS = sys.argv[2].split(",")
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
        gaps = sum(1 for a, b in zip(rows, rows[1:]) if b[0] - a[0] != rows[1][0] - rows[0][0])
        (out / f"{sym}_{tf}.json").write_text(json.dumps(rows))
        print(sym, tf, len(rows), "bars", "gaps", gaps, flush=True)
