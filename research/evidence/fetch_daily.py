#!/usr/bin/env python3
"""Append Binance USD-M daily kline archives (days after the last monthly file) to bars/<SYMBOL>_<TF>.json.
Usage: python fetch_daily.py SYMBOL[,SYMBOL...] TF FIRST_DAY LAST_DAY   (days as YYYY-MM-DD; a missing day is reported)"""
import datetime as dt, io, json, sys, zipfile
from pathlib import Path
import requests

syms, tf, first, last = sys.argv[1].split(","), sys.argv[2], dt.date.fromisoformat(sys.argv[3]), dt.date.fromisoformat(sys.argv[4])
s = requests.Session()
for sym in syms:
    p = Path("bars") / f"{sym}_{tf}.json"
    rows = json.loads(p.read_text()) if p.exists() else []
    have = {r[0] for r in rows}
    d, added, missing = first, 0, []
    while d <= last:
        r = s.get(f"https://data.binance.vision/data/futures/um/daily/klines/{sym}/{tf}/{sym}-{tf}-{d}.zip", timeout=60)
        if r.status_code == 404:
            missing.append(str(d))
        else:
            r.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                for line in z.read(z.namelist()[0]).decode().splitlines():
                    q = line.split(",")
                    if not q[0].isdigit():
                        continue
                    t = int(q[0]); t = t // 1000 if t > 1e15 else t
                    ct = int(q[6]); ct = ct // 1000 if ct > 1e15 else ct
                    if t not in have:
                        rows.append([t, float(q[1]), float(q[2]), float(q[3]), float(q[4]), float(q[5]), ct]); have.add(t); added += 1
        d += dt.timedelta(days=1)
    rows.sort()
    p.write_text(json.dumps(rows))
    print(sym, tf, "daily bars added", added, "missing days", ",".join(missing) or "-", flush=True)
