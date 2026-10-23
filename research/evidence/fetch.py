#!/usr/bin/env python3
"""Download Binance USD-M futures klines (official monthly archives) into bars/<SYMBOL>_<TF>.json.
Usage: python fetch.py SYMBOL[,SYMBOL...] TF[,TF...] [FIRST_MONTH] [LAST_MONTH] [um|spot]
(default 2023-10..2026-09, um; months before a coin was listed are skipped; after a coin's last month (delisted) the
rest must be missing too, any other missing month is an error; spot bars go to bars/spot_<SYMBOL>_<TF>.json;
a symbol with no data at all is reported and skipped)"""
import io, json, sys, zipfile
from pathlib import Path
import requests

SYMBOLS = sys.argv[1].split(",")
TFS = sys.argv[2].split(",")
FIRST = sys.argv[3] if len(sys.argv) > 3 else "2023-10"
LAST = sys.argv[4] if len(sys.argv) > 4 else "2026-09"
MARKET = sys.argv[5] if len(sys.argv) > 5 else "um"
MONTHS = [f"{y}-{m:02d}" for y in range(2017, 2027) for m in range(1, 13) if FIRST <= f"{y}-{m:02d}" <= LAST]
BASE = "https://data.binance.vision/data/" + ("spot" if MARKET == "spot" else "futures/um") + "/monthly/klines"
PREFIX = "spot_" if MARKET == "spot" else ""
out = Path("bars"); out.mkdir(exist_ok=True)
s = requests.Session()
for sym in SYMBOLS:
    for tf in TFS:
        rows, ended = [], None
        for ym in MONTHS:
            r = s.get(f"{BASE}/{sym}/{tf}/{sym}-{tf}-{ym}.zip", timeout=60)
            if r.status_code == 404 and not rows:
                continue   # not listed yet
            if r.status_code == 404:
                ended = ended or ym   # delisted from here on, unless a later month exists (then it is a gap)
                continue
            if ended:
                raise SystemExit(f"{sym} {tf}: month {ended} missing but {ym} exists")
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
        if len(rows) < 2:
            print(sym, tf, "no data on", MARKET, "- skipped", flush=True)
            continue
        rows.sort()
        gaps = sum(1 for a, b in zip(rows, rows[1:]) if b[0] - a[0] != rows[1][0] - rows[0][0])
        (out / f"{PREFIX}{sym}_{tf}.json").write_text(json.dumps(rows))
        print(MARKET, sym, tf, len(rows), "bars", "gaps", gaps, "ended", ended or "-", flush=True)
