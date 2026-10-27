#!/usr/bin/env python3
"""Research-only audit of saved POC Futures Filter ZIP; no network/orders.

Run: python audit_poc_filter.py CRYPTO_FUTURES_FILTER_TEST_20261027.zip
Requires numpy and scikit-learn. Trade ledger and score files must be in ZIP.
The 2025-Sep2026 test was previously examined; results are NOT untouched OOS.
"""
import sys,json,zipfile,hashlib,collections,datetime,math
from pathlib import Path
import numpy as np
from sklearn.metrics import roc_auc_score,brier_score_loss

seed=20261027
n_draws=100000
auc_draws=2000
rng=np.random.default_rng(seed)
zip_path=Path(sys.argv[1]);z=zipfile.ZipFile(zip_path)
def load(name):
    key='poc-backtest/research/'+name
    raw=z.read(key)
    return json.loads(raw),hashlib.sha256(raw).hexdigest()
ledger,ledger_sha=load('flow_breakout/trades.json')
decisions,decision_sha=load('futures_filter/decisions.json')
results,result_sha=load('futures_filter/results.json')
ledger=ledger['B_baseline']
assert len(decisions)==6100
out={'source':{'zip':zip_path.name,'zip_sha256':hashlib.sha256(zip_path.read_bytes()).hexdigest(),'ledger_sha256':ledger_sha,'decisions_sha256':decision_sha,'filter_results_sha256':result_sha},'scope':'POC B_baseline BTCUSDT ETHUSDT SOLUSDT LONG/SHORT, saved simulated trades; not user account orders','seed':seed,'draws':{'weekly_bootstrap_meanR':n_draws,'weekly_bootstrap_auc':auc_draws}}
for period in ['reference','validation','test']:
    t=ledger[period];d=[x for x in decisions if x['period']==period]
    lookup={}
    for x in t:
        key=(x['coin'],x['entry_time'],x['dir'])
        assert key not in lookup,('duplicate trade key',key)
        lookup[key]=x
    assert len(t)==len(d)
    errors=[];cost_errors=[];bad_dates=[];p=[];rr=[];ts=[];coins=[];sides=[]
    for x in d:
        key=(x['coin'],x['entry_time'],x['dir'])
        q=lookup.get(key)
        if q is None or abs(q['r']-x['netR'])>1e-9:errors.append(key);continue
        if abs(q['r']-(q['grossR']-q['feeR']-q['slipR']-q['fundR']))>1e-8:cost_errors.append(key)
        if not (q['exit_time']>q['entry_time']):bad_dates.append(key)
        assert x['keep'] is False
        p.append(x['predictedProfitProbability']);rr.append(x['netR']);ts.append(q['entry_time']);coins.append(q['coin']);sides.append(q['dir'])
    assert not(errors or cost_errors or bad_dates),(errors[:3],cost_errors[:3],bad_dates[:3])
    p=np.asarray(p);r=np.asarray(rr);y=(r>0).astype(int);ts=np.asarray(ts,dtype='int64')
    assert np.isfinite(p).all() and np.isfinite(r).all()
    win=r[r>0];loss=-r[r<0]
    gross=sum(x['grossR'] for x in t);fee=sum(x['feeR'] for x in t);slip=sum(x['slipR'] for x in t);fund=sum(x['fundR'] for x in t)
    groups=collections.defaultdict(list)
    for i,time in enumerate(ts):
        dt=datetime.datetime.fromtimestamp(int(time)/1000,datetime.timezone.utc)
        week=(dt.date()-datetime.timedelta(days=dt.weekday())).isoformat()
        groups[week].append(i)
    bins=[]
    for i,ids in enumerate(np.array_split(np.argsort(p,kind='stable'),5)):
        bins.append({'quintile':i+1,'n':len(ids),'p_min':float(p[ids].min()),'p_max':float(p[ids].max()),'win_rate':float(y[ids].mean()),'mean_net_R':float(r[ids].mean()),'net_R':float(r[ids].sum())})
    vals={'n':len(t),'matched_rows':len(d),'duplicate_keys':0,'cost_reconciliation_errors':0,'score_nan':0,'win_count':len(win),'loss_count':len(loss),'net_R':float(r.sum()),'mean_net_R':float(r.mean()),'gross_R':gross,'fee_R':fee,'slippage_R':slip,'funding_R':fund,'zero_cost_net_R_scenario':gross,'double_cost_net_R_scenario':gross-2*(fee+slip+fund),'p_win_actual':float(y.mean()),'mean_win_R':float(win.mean()),'mean_loss_R':float(loss.mean()),'break_even_p_at_realized_payoffs':float(loss.mean()/(win.mean()+loss.mean())),'probability':{'min':float(p.min()),'mean':float(p.mean()),'median':float(np.median(p)),'max':float(p.max()),'std':float(p.std()),'n_above_50pct':int((p>=.5).sum()),'roc_auc':float(roc_auc_score(y,p)),'brier':float(brier_score_loss(y,p)),'constant_base_brier':float(y.mean()*(1-y.mean()))},'quintiles':bins,'weeks':len(groups)}
    vals['by_coin']={c:{'n':sum(x['coin']==c for x in t),'net_R':sum(x['r'] for x in t if x['coin']==c),'gross_R':sum(x['grossR'] for x in t if x['coin']==c)} for c in ['BTCUSDT','ETHUSDT','SOLUSDT']}
    vals['by_side']={s:{'n':sum(x['dir']==v for x in t),'net_R':sum(x['r'] for x in t if x['dir']==v),'gross_R':sum(x['grossR'] for x in t if x['dir']==v)} for s,v in [('LONG',1),('SHORT',-1)]}
    months=collections.defaultdict(float)
    for x in t:
        dt=datetime.datetime.fromtimestamp(x['exit_time']/1000,datetime.timezone.utc)
        months[dt.strftime('%Y-%m')]+=x['r']
    vals['exit_months']={'count':len(months),'positive':sum(v>0 for v in months.values()),'negative':sum(v<0 for v in months.values()),'monthly_net_R':dict(sorted(months.items()))}
    if period=='test':
        # Preserve week-level cross-coin dependence. Zero-trade weeks are not added because
        # the estimand is mean R conditional on a trade, not return per calendar week.
        blocks=np.array([(len(ids),r[ids].sum()) for ids in groups.values()],dtype='float64')
        means=np.empty(n_draws)
        batch=10000
        for start in range(0,n_draws,batch):
            size=min(batch,n_draws-start)
            idx=rng.integers(0,len(blocks),size=(size,len(blocks)))
            samples=blocks[idx]
            means[start:start+size]=samples[:,:,1].sum(axis=1)/samples[:,:,0].sum(axis=1)
        vals['weekly_bootstrap_mean_R']={'draws':n_draws,'seed':seed,'block':'UTC Monday entry week, same weeks shared across 3 coins','estimand':'mean stored simulated net R per trade','ci95_percentile':[float(x) for x in np.quantile(means,[.025,.975])],'fraction_means_above_zero':float(np.mean(means>0)),'warning':'Bootstrap resamples are not independent observations or evidence of untouched OOS.'}
        # Weighted AUC resamples by entry-week; this preserves whole weeks without duplicating rows.
        wks=list(groups);which=np.zeros(len(t),dtype='int32')
        # decisions may not match trade order; groups already use decisions indices.
        for j,week in enumerate(wks):which[groups[week]]=j
        aucs=[]
        for _ in range(auc_draws):
            w=np.bincount(rng.integers(0,len(wks),size=len(wks)),minlength=len(wks))
            weights=w[which]
            if len(np.unique(y[weights>0]))<2:continue
            aucs.append(roc_auc_score(y,p,sample_weight=weights))
        vals['weekly_bootstrap_auc']={'draws':len(aucs),'seed':seed,'ci95_percentile':[float(x) for x in np.quantile(aucs,[.025,.975])],'estimand':'ROC AUC of stored logistic-calibrated score vs net R>0; cluster bootstrap by entry week'}
    out[period]=vals
print(json.dumps(out,indent=2,ensure_ascii=False))
