#!/usr/bin/env python3
"""Research-only fixed-2023-calibration-score-cut audit. No orders or model refitting.
Run: python research/hourly/audit_score_stability.py CRYPTO_FUTURES_FILTER_TEST_20261027.zip
The 2024 and 2025-Sep2026 periods have already been studied: NOT untouched OOS.
"""
import sys, zipfile, json, hashlib, datetime
import numpy as np

zip_path=sys.argv[1]
with open(zip_path,'rb') as f: zip_sha=hashlib.sha256(f.read()).hexdigest()
with zipfile.ZipFile(zip_path) as z:
    name='poc-backtest/research/futures_filter/decisions.json'
    raw=z.read(name)
    decisions=json.loads(raw)
    decisions_sha=hashlib.sha256(raw).hexdigest()
by={p:[x for x in decisions if x['period']==p] for p in ('reference','validation','test')}
cal=[x for x in by['reference'] if datetime.datetime.fromtimestamp(x['entry_time']/1000,datetime.timezone.utc).month>=10]
cuts={str(q):float(np.quantile([x['predictedProfitProbability'] for x in cal],q)) for q in (.1,.25,.5,.75,.9)}
def stats(rows):
    r=np.array([x['netR'] for x in rows],dtype=float)
    if not len(r): return {'n':0,'netR':None,'meanR':None,'PF':None}
    gains=float(np.maximum(r,0).sum()); losses=float(-np.minimum(r,0).sum())
    return {'n':len(r),'netR':float(r.sum()),'meanR':float(r.mean()),'PF':gains/losses if losses else None}
out={'source_zip_sha256':zip_sha,'decisions_sha256':decisions_sha,
     'calibration_2023Q4_n':len(cal),'cuts_from_2023Q4':cuts,'periods':{},
     'status':'EXPLORATORY; past validation/test periods are not untouched OOS'}
for p,rows in by.items():
    out['periods'][p]={'all':stats(rows),'high_score_cuts':{}}
    for q,t in cuts.items():
        selected=[x for x in rows if x['predictedProfitProbability']>=t]
        out['periods'][p]['high_score_cuts'][q]=stats(selected)
print(json.dumps(out,indent=2))
