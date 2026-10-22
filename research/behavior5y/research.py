#!/usr/bin/env python3
"""Five-year 2021-10 to 2026-09 empirical study; no live orders or keys."""
import json, sys
from pathlib import Path
import numpy as np
import pandas as pd
import requests
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"mtf10000"))
import CRYPTO_MTF_10000_M5_M15_V3 as V

V.START=pd.Timestamp('2021-10-01T00:00:00Z')
V.END=pd.Timestamp('2026-10-01T00:00:00Z')
V.MONTHS=pd.period_range('2021-10','2026-09',freq='M')
RESULTS=Path(__file__).parent/"RESULTS"
RESULTS.mkdir(exist_ok=True)
CACHE=Path(__file__).parent/"cache"

def study(raw,sym):
    x=raw.set_index("t").sort_index()
    c=x.close; v=x.volume
    absret=np.abs(np.log(x.close/x.open))
    years=x.index.year
    days=x.index.floor('D')
    daily=pd.DataFrame({'vol':v,'absret':absret,'hr':x.index.hour,'day':days})
    for k in ('vol','absret'):
        daily[k+'_rel']=daily[k]/daily.groupby('day')[k].transform('mean').replace(0,np.nan)
    hour=daily.groupby('hr')[['vol_rel','absret_rel']].mean().round(3)
    pv=absret.rolling(12,min_periods=12).mean().to_numpy()
    ft=np.zeros(len(x),float)
    for j in range(1,13):
        ft[:-j]+=absret.to_numpy()[j:]/12
    ok=np.isfinite(pv)&(np.arange(len(x))<len(x)-12)
    q20,q80=np.quantile(pv[ok],[.2,.8])
    cl=float(ft[ok&(pv>=q80)].mean()/ft[ok&(pv<=q20)].mean())
    # Weekend relative to trailing 30-day comparable market baseline.
    w=x.index.dayofweek>=5
    norm_abs=absret/absret.rolling(30*288,min_periods=30*288).mean().shift(1)
    weekend=float(np.nanmean(norm_abs[w])/np.nanmean(norm_abs[~w]))
    season={'symbol':sym,'top_volume_utc':hour.vol_rel.nlargest(5).to_dict(),
        'low_volume_utc':hour.vol_rel.nsmallest(5).to_dict(),
        'top_volatility_utc':hour.absret_rel.nlargest(5).to_dict(),
        'volatility_cluster_high20_over_low20_next_1h':round(cl,3),
        'weekend_weekday_relative_volatility_ratio':round(weekend,3)}
    rows=[]
    for tf in ('5min','15min'):
        d=x if tf=='5min' else x.resample('15min',label='left',closed='left').agg(
            {'open':'first','high':'max','low':'min','close':'last','volume':'sum','taker_buy_volume':'sum'})
        n=len(d)
        O,H,L,C=[d[k].to_numpy(dtype=float) for k in ('open','high','low','close')]
        atr=pd.concat([d.high-d.low,(d.high-d.close.shift()).abs(),(d.low-d.close.shift()).abs()],axis=1).max(axis=1).ewm(span=14,adjust=False).mean().to_numpy()
        hi=d.high.shift(1).rolling(24).max().to_numpy()
        lo=d.low.shift(1).rolling(24).min().to_numpy()
        vr=d.volume/d.volume.shift(1).rolling(20).mean()
        tb=(2*d.taker_buy_volume/d.volume.replace(0,np.nan)-1).to_numpy()
        close15=d.close
        def htf(freq):
            s=close15.resample(freq,label='left',closed='left').last()
            ema=(s.ewm(span=21,adjust=False).mean()>s.ewm(span=55,adjust=False).mean()).shift(1)
            return ema.reindex(d.index,method='ffill').fillna(False).to_numpy(dtype=bool)
        uph1,uph4=htf('1h'),htf('4h')
        up=(C>hi+.05*atr)
        dn=(C<lo-.05*atr)
        highvol=vr.to_numpy()>=1.5
        sweepup=(L<lo-.08*atr)&(C>lo+.08*atr)&((C-L)/np.maximum(H-L,1e-9)>.63)
        sweepdn=(H>hi+.08*atr)&(C<hi-.08*atr)&((H-C)/np.maximum(H-L,1e-9)>.63)
        compress=(d.high.shift(1).rolling(12).max()-d.low.shift(1).rolling(12).min()).to_numpy()<2.7*atr
        shockup=(C-np.roll(C,1)>2.0*atr);shockdn=(np.roll(C,1)-C>2.0*atr)
        patterns={
            'breakout_all':(up,dn),
            'breakout_volume_1_5':(up&highvol,dn&highvol),
            'breakout_weak_volume':(up&(vr.to_numpy()<=.8),dn&(vr.to_numpy()<=.8)),
            'breakout_volume_flow':(up&highvol&(tb>.1),dn&highvol&(tb<-.1)),
            'breakout_volume_flow_H1_H4':(up&highvol&(tb>.1)&uph1&uph4,dn&highvol&(tb<-.1)&(~uph1)&(~uph4)),
            'sweep_reclaim':(sweepup,sweepdn),
            'sweep_reclaim_flow':(sweepup&(tb>.1),sweepdn&(tb<-.1)),
            'compression_breakout_vol':(up&compress&highvol,dn&compress&highvol),
            'shock_continuation':(shockup,shockdn),
            'shock_fade':(shockdn,shockup)}
        horizon=96 if tf=='5min' else 32
        YY=d.index.year.to_numpy()
        for pname,(bull,bear) in patterns.items():
            signal=np.where(bull,1,np.where(bear,-1,0))
            entries=[];free=-1
            for i in np.flatnonzero(signal):
                if i<60 or i+horizon>=n or i<free:continue
                direction=int(signal[i]);ent=O[i+1];stop_dist=1.2*atr[i]
                if not np.isfinite(stop_dist) or stop_dist/ent<.0015:continue
                sl=ent-direction*stop_dist
                t2=ent+direction*stop_dist*2
                t5=ent+direction*stop_dist*5
                end2=end5=C[i+horizon]
                out2=out5=0
                for j in range(i+1,i+horizon+1):
                    stop_hit=(L[j]<=sl if direction==1 else H[j]>=sl)
                    if not out2:
                        if stop_hit:out2=-1;end2=sl
                        elif (H[j]>=t2 if direction==1 else L[j]<=t2):out2=1;end2=t2
                    if not out5:
                        if stop_hit:out5=-1;end5=sl
                        elif (H[j]>=t5 if direction==1 else L[j]<=t5):out5=1;end5=t5
                    if out2 and out5:break
                # Research friction: 0.14% roundtrip plus assumed adverse 0.01%/8h.
                fee=.0015*ent/stop_dist
                entries.append({'year':int(YY[i]),'dir':direction,'tp2':int(out2==1),'tp5':int(out5==1),
                     'net2':(end2-ent)*direction/stop_dist-fee,
                     'net5':(end5-ent)*direction/stop_dist-fee,
                     'forward8hR':(C[i+horizon]-ent)*direction/stop_dist})
                free=i+horizon+1
            if not entries:continue
            er=pd.DataFrame(entries)
            for grp in ['5y','2021-22','2023-24','2025-26']:
                y=er if grp=='5y' else er[er.year.le(2022) if grp=='2021-22' else er.year.between(2023,2024) if grp=='2023-24' else er.year.ge(2025)]
                if y.empty:continue
                rows.append({'symbol':sym,'tf':tf,'event':pname,'years':grp,'n':len(y),
                    'long':int((y.dir==1).sum()),'short':int((y.dir==-1).sum()),
                    'tp2_pct':round(y.tp2.mean()*100,2),'tp5_pct':round(y.tp5.mean()*100,2),
                    'avgR_2':round(y.net2.mean(),4),'avgR_5':round(y.net5.mean(),4),
                    'forward8h_R':round(y.forward8hR.mean(),4)})
        print('finished',sym,tf,len(d),'bars',flush=True)
    return season,rows

def main():
    session=requests.Session()
    manifests=[];time=[];events=[]
    for sym in ('BTCUSDT','ETHUSDT'):
        df,m=V.get_dataset(sym,CACHE,session)
        manifests.extend(m)
        season,rows=study(df,sym)
        time.append(season);events.extend(rows)
        del df
    report={'range':'2021-10-01 to 2026-09-30 inclusive','data':'Binance USD-M 5m', 
       'timeframes':['M5','M15'],'models':'event study, not live or independently validated strategy',
       'risk':'ATR14 stop 1.2x, TP 2R/5R, 8h maximum, simulated costs 0.15% of notional',
       'unmodeled':['liquidation/mark price','historical funding rates','order book depth','news events'],
       'time':time,'events':events,'archive_checksums':manifests}
    (RESULTS/'FIVE_YEAR_BEHAVIOR.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str))
    print('=== AUDITED FIVE-YEAR TIME BEHAVIOR ===')
    print(json.dumps(time,ensure_ascii=False))
    print('=== FIVE-YEAR EVENT OUTCOMES ===')
    print(json.dumps([z for z in events if z['years']=='5y'],ensure_ascii=False))
    print('=== COMPLETED ===',len(manifests),'monthly archives',len(events),'group summaries')
if __name__=='__main__':main()
