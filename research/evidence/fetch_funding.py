#!/usr/bin/env python3
"""Download Binance USD-M funding rates (official monthly archives) into bars/<SYMBOL>_funding.json as [[time_ms, rate], ...].
Usage: python fetch_funding.py SYMBOL[,SYMBOL...] FIRST_MONTH LAST_MONTH
Months before a coin's first file are skipped; a missing month after data started is reported (not filled in)."""
import io, json, sys, zipfile
from pathlib import Path
import requests

SYMBOLS = sys.argv[1].split(",")
FIRST, LAST = sys.argv[2], sys.argv[3]
MONTHS = [f"{y}-{m:02d}" for y in range(2019, 2027) for m in range(1, 13) if FIRST <= f"{y}-{m:02d}" <= LAST]
BASE = "https://data.binance.vision/data/futures/um/monthly/fundingRate"
out = Path("bars"); out.mkdir(exist_ok=True)
s = requests.Session()
for sym in SYMBOLS:
    rows, missing = [], []
    for ym in MONTHS:
        r = s.get(f"{BASE}/{sym}/{sym}-fundingRate-{ym}.zip", timeout=60)
        if r.status_code == 404:
            if rows:
                missing.append(ym)
            continue
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            text = z.read(z.namelist()[0]).decode()
        for line in text.splitlines():
            p = line.split(",")
            if not p[0].isdigit():
                continue
            t = int(p[0]); t = t // 1000 if t > 1e15 else t
            rows.append([t, float(p[2])])
    rows.sort()
    (out / f"{sym}_funding.json").write_text(json.dumps(rows))
    print(sym, "funding", len(rows), "settlements", rows[0][0] if rows else "-", "..", rows[-1][0] if rows else "-", "missing months", ",".join(missing) or "-", flush=True)
