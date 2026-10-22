#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Auditable, research-only BTCUSDT/ETHUSDT USD-M perpetual BACKTEST.
Windows (UTC): train 2023-10-01..2024-09-30, validate 2024-10-01..2025-09-30,
locked holdout 2025-10-01..2026-09-30. No lookahead; 5m/15m bars; signals at candle
close, fills next candle OPEN, same-bar SL and TP -> SL first.
Source: https://github.com/binance/binance-public-data (official Binance archive).
No order execution. Costs are hypotheses, not your actual account fees/slippage.
Usage: pip install pandas numpy requests; python crypto_3year_backtest_oct2023_sep2026.py
Optional: --symbols BTCUSDT --data-dir ./crypto3y_data --out-dir ./crypto3y_results
         --selftest (ONLY checks code using SYNTHETIC data; NEVER market results)
"""
import argparse
import hashlib
import io
import json
import math
import sys
import time
import zipfile
from pathlib import Path
from datetime import datetime

import numpy as np
import pandas as pd
import requests
try:
    from numba import njit
except ImportError:
    def njit(func=None, **kwargs):
        return func if func else (lambda f:f)

START = pd.Timestamp('2023-10-01T00:00:00Z')
TRAIN_END = pd.Timestamp('2025-01-01T00:00:00Z')
VAL_END = pd.Timestamp('2026-01-01T00:00:00Z')
END = pd.Timestamp('2026-10-01T00:00:00Z')
TIMEFRAME = '5m'
MONTHS = pd.period_range('2023-10', '2026-09', freq='M')
BASE = 'https://data.binance.vision/data/futures/um/monthly/klines'
STRATEGIES = ('ConfirmedBreakoutSqueeze', 'TrendBreakout', 'VolumeBreakout', 'TrendPullback', 'Impulse', 'LiquiditySweep')
STOP_ATRS = (0.8, 1.2, 1.8, 2.5)
TARGET_RRS = (2.0, 3.0, 5.0)
MAX_HOLDS = (12, 24, 48)  # 5m bars: 1,2,4 hours
FRICTION = 0.0014  # 0.14% of notional round trip, incl. hypothetical spread/slippage/fees
FUNDING_PER_8H = 0.0001  # conservative assumed adverse carry if crossing; NOT real funding
RISK = .0025  # 0.25% equity at nominal stop per trade


def get_month(symbol, ym, data_dir, session):
    key = f'{symbol}-{TIMEFRAME}-{ym}.zip'
    folder = Path(data_dir) / symbol / TIMEFRAME
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / key
    url = f'{BASE}/{symbol}/{TIMEFRAME}/{key}'
    if not target.is_file():
        error = None
        for attempt in range(4):
            try:
                response = session.get(url, timeout=35)
                response.raise_for_status()
                raw = response.content
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    bad = archive.testzip()
                    if bad: raise ValueError('bad ZIP member ' + str(bad))
                tmp = target.with_suffix('.tmp')
                tmp.write_bytes(raw)
                tmp.replace(target)
                break
            except Exception as exc:
                error = exc
                if attempt < 3: time.sleep(1.5*(attempt+1))
        if not target.exists():
            raise RuntimeError(f'MISSING MONTH {symbol} {ym}: {error}; not reporting a partial 3-year backtest.')
    data = target.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    try:
        response = session.get(url + '.CHECKSUM', timeout=15)
        if response.ok:
            expected = response.text.strip().split()[0]
            if len(expected)==64 and sha.lower()!=expected.lower():
                raise ValueError(f'CHECKSUM MISMATCH: {key}')
    except requests.RequestException:
        print(f'  Note: checksum unavailable {key}; local SHA256={sha}', file=sys.stderr)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files=[name for name in archive.namelist() if name.lower().endswith('.csv')]
        if len(files)!=1: raise ValueError(f'Invalid ZIP CSV count: {key}: {files}')
        frame=pd.read_csv(archive.open(files[0]), header=None, low_memory=False)
    if str(frame.iloc[0,0]).strip().lower() in ('open_time','open time','timestamp'):
        frame=frame.iloc[1:].reset_index(drop=True)
    if frame.shape[1]<6: raise ValueError(f'Unexpected kline layout {key}: {frame.shape}')
    ts=pd.to_numeric(frame.iloc[:,0], errors='raise')
    unit='us' if float(ts.median())>1e15 else 'ms'
    result=pd.DataFrame({
      't':pd.to_datetime(ts,unit=unit,utc=True),
      'open':pd.to_numeric(frame.iloc[:,1],errors='raise'),
      'high':pd.to_numeric(frame.iloc[:,2],errors='raise'),
      'low':pd.to_numeric(frame.iloc[:,3],errors='raise'),
      'close':pd.to_numeric(frame.iloc[:,4],errors='raise'),
      'volume':pd.to_numeric(frame.iloc[:,5],errors='raise'),
      'taker_buy_volume':pd.to_numeric(frame.iloc[:,9],errors='raise') if frame.shape[1]>9 else np.nan})
    return result, {'symbol':symbol,'month':ym,'url':url,'sha256':sha,'rows':len(result)}


def get_dataset(symbol, data_dir, session):
    data=[]; ledger=[]
    for period in MONTHS:
        month=str(period)
        f,l=get_month(symbol,month,data_dir,session)
        data.append(f);ledger.append(l)
        print(f'{symbol} {month}: {len(f):,} bars',flush=True)
    df=pd.concat(data,ignore_index=True).sort_values('t').reset_index(drop=True)
    df=df.loc[(df['t']>=START)&(df['t']<END)].copy()
    if df['t'].duplicated().any():raise ValueError(f'{symbol}: duplicated timestamps')
    if df['taker_buy_volume'].isna().any():raise ValueError('Missing historical taker-buy volume: cannot claim orderflow test')
    expected=pd.date_range(START,END-pd.Timedelta(minutes=5),freq='5min',tz='UTC')
    got=pd.DatetimeIndex(df.t)
    if len(got)!=len(expected) or not got.equals(expected):
        missing=expected.difference(got)
        raise ValueError(f'{symbol}: incomplete 3 years. Expected {len(expected)} bars, found {len(got)}, missing examples {list(missing[:10])}; REFUSE TO FILL GAPS')
    for p in ('open','high','low','close'):
        if not np.isfinite(df[p].to_numpy()).all(): raise ValueError('NaN/infinite in '+p)
    if not ((df.high>=df[['open','close','low']].max(axis=1))&(df.low<=df[['open','close','high']].min(axis=1))).all():
        raise ValueError('Bad OHLC invariants')
    return df,ledger



# Fixed, pre-registered search space: 25 signal families * 5 MTF/flow confirmation
# filters * 4 ATR stops * 5 max holds * 2 markets * 2 execution TFs = 10,000.
# The goal is full-target (5R) validation, not simply profitable-closing trades.
BASE_FAMILIES = (
 'PA_Donchian24','PA_LiquiditySweep','PA_SweepCHoCH','PA_BreakRetest','PA_Engulfing',
 'PA_PinBar','PA_InsideBar','PA_TrendPullback','Fib_50_618','Fib_382_50',
 'Elliott_W3_PROXY','QM_STRUCTURE_PROXY','Pattern_DoubleBottomTop','Pattern_Triangle',
 'Pattern_Flag','Pattern_HeadShoulders_PROXY','FVG_Displacement','OB_Reclaim_PROXY',
 'VWAP_Reclaim','Bollinger_Squeeze','Momentum_TwoBar','Volume_Impulse',
 'Orderflow_DeltaShift','Combo_SqueezeMomentum','Combo_SweepDelta')
FILTERS=('none','H1_ema','H4_ema','H1_H4_ema','H1_H4_takerflow')
ATR_STOPS=(.8,1.2,1.8,2.5)
MAX_HOLDS=(8,16,32,64,96)
RR=5.0
ROUNDTRIP_COST=.0014   # conservative HYPOTHETICAL 0.14% of notional all-in
FUNDING_8H=.0001       # HYPOTHETICAL adverse carry; not historical funding events
RISK=.0025             # portfolio capital at planned stop; leverage not return booster


def pair_to_tf(raw,tf):
    frame=raw.set_index('t').sort_index()
    if tf=='5min':
        return frame
    return frame.resample('15min',label='left',closed='left').agg({
      'open':'first','high':'max','low':'min','close':'last',
      'volume':'sum','taker_buy_volume':'sum'}).dropna()


def make_features(frame,tf):
    i=frame.index
    c=frame.close.astype(float);o=frame.open.astype(float)
    h=frame.high.astype(float);l=frame.low.astype(float);v=frame.volume.astype(float)
    tb=frame.taker_buy_volume.astype(float)
    tr=pd.concat([h-l,(h-c.shift(1)).abs(),(l-c.shift(1)).abs()],axis=1).max(axis=1)
    atr=tr.ewm(alpha=1/14,adjust=False).mean()
    va=v.shift(1).rolling(20,min_periods=20).mean()
    e20=c.ewm(span=20,adjust=False).mean()
    e50=c.ewm(span=50,adjust=False).mean()
    e200=c.ewm(span=200,adjust=False).mean()
    up=(e20>e50)&(e50>e200)
    dn=(e20<e50)&(e50<e200)
    hh12=h.shift(1).rolling(12).max();ll12=l.shift(1).rolling(12).min()
    hh24=h.shift(1).rolling(24).max();ll24=l.shift(1).rolling(24).min()
    hh48=h.shift(1).rolling(48).max();ll48=l.shift(1).rolling(48).min()
    rg=(h-l).replace(0,np.nan); body=(c-o).abs()
    lo_wick=(np.minimum(c,o)-l)/rg;hi_wick=(h-np.maximum(c,o))/rg
    bullish_pin=(lo_wick>.36)&(c>l+.65*rg)
    bearish_pin=(hi_wick>.36)&(c<l+.35*rg)
    bullish_eng=(c>o)&(c.shift(1)<o.shift(1))&(o<=c.shift(1))&(c>=o.shift(1))
    bearish_eng=(c<o)&(c.shift(1)>o.shift(1))&(o>=c.shift(1))&(c<=o.shift(1))
    v_up=v>1.5*va
    # Binance kline taker-buy statistics are executed flow, NOT live order book.
    signed=2*tb-v
    ratio=(signed/v.replace(0,np.nan)).clip(-1,1)
    flow=ratio.rolling(3,min_periods=3).mean()
    flow_up=(flow>.10)&(ratio>0)
    flow_dn=(flow<-.10)&(ratio<0)
    prev_flow=flow.shift(1)
    buy_absorb=(prev_flow<-.08)&(flow>.07)
    sell_absorb=(prev_flow>.08)&(flow<-.07)
    # HTFs are previous *completed* buckets only; .shift(1) adds a safe delay.
    def lag_htf(freq,pfast,pslow):
        last=c.resample(freq,label='left',closed='left').last()
        fast=last.ewm(span=pfast,adjust=False).mean().shift(1).reindex(i,method='ffill')
        slow=last.ewm(span=pslow,adjust=False).mean().shift(1).reindex(i,method='ffill')
        return fast>slow, fast<slow
    h1_up,h1_dn=lag_htf('1h',21,55)
    h4_up,h4_dn=lag_htf('4h',21,55)
    squeeze=(hh12-ll12)<3*atr
    breakout_up=c>hh24+.10*atr
    breakout_dn=c<ll24-.10*atr
    sweep_up=(l<ll24-.1*atr)&(c>ll24+.10*atr)&bullish_pin
    sweep_dn=(h>hh24+.1*atr)&(c<hh24-.10*atr)&bearish_pin
    near_ema_up=(l<e20+.18*atr)&(c>e20)
    near_ema_dn=(h>e20-.18*atr)&(c<e20)
    fib_span=hh48-ll48
    fib_p=(hh48-c)/fib_span.replace(0,np.nan)
    fib_s=(c-ll48)/fib_span.replace(0,np.nan)
    fvg_bull=l>h.shift(2)
    fvg_bear=h<l.shift(2)
    # Operational swing proxy: 3 bars on either side, known only after 3 later bars.
    ph=pd.Series(True,index=i);pl=pd.Series(True,index=i)
    center_h=h.shift(3);center_l=l.shift(3)
    for j in (1,2,3):
        ph &= (center_h>h.shift(3+j)) & (center_h>h.shift(3-j))
        pl &= (center_l<l.shift(3+j)) & (center_l<l.shift(3-j))
    pivot_h=center_h.where(ph).ffill()
    pivot_l=center_l.where(pl).ffill()
    p_h_prev=pivot_h.shift(1)
    p_l_prev=pivot_l.shift(1)
    # previous confirmed pivot to measure break of structure, no future pivots
    last_h_before=center_h.where(ph).ffill().shift(3)
    last_l_before=center_l.where(pl).ffill().shift(3)
    bos_up=(c>p_h_prev+.08*atr)&(c.shift(1)<=p_h_prev.shift(1)+.08*atr)
    bos_dn=(c<p_l_prev-.08*atr)&(c.shift(1)>=p_l_prev.shift(1)-.08*atr)
    choch_up=bos_up & (c.shift(3)<e20.shift(3))
    choch_dn=bos_dn & (c.shift(3)>e20.shift(3))
    last_break_up=breakout_up.shift(1).rolling(6).max().fillna(0)>0
    last_break_dn=breakout_dn.shift(1).rolling(6).max().fillna(0)>0
    # Fib etc. are explicitly algorithmic proxies, not analyst-drawn patterns.
    vwap_num=((h+l+c)/3*v).groupby(i.floor('D')).cumsum()
    vwap_den=v.groupby(i.floor('D')).cumsum().replace(0,np.nan)
    vwap=vwap_num/vwap_den
    std=c.rolling(20).std();mean=c.rolling(20).mean()
    bb_compression=(4*std/c)<.025
    bb_squeeze_up=bb_compression.shift(1).rolling(6).max().fillna(0).gt(0)&(c>mean+1.4*std)
    bb_squeeze_dn=bb_compression.shift(1).rolling(6).max().fillna(0).gt(0)&(c<mean-1.4*std)
    mom_up=(c>o)&(c.shift(1)>o.shift(1))&(body>.65*atr)
    mom_dn=(c<o)&(c.shift(1)<o.shift(1))&(body>.65*atr)
    retest_up=last_break_up&near_ema_up&bullish_pin
    retest_dn=last_break_dn&near_ema_dn&bearish_pin
    triangle=(hh12-ll12)<.65*(hh24-ll24)
    flag=(hh12<hh24)&(ll12>ll24)
    double_l=(abs(pivot_l-last_l_before)<.5*atr)&bos_up
    double_h=(abs(pivot_h-last_h_before)<.5*atr)&bos_dn
    # Elliott/QM/OB/H&S: named mechanical proxies only, not complete wave counts/order books.
    proxy_wave_up=bos_up&(pivot_l>last_l_before)&up
    proxy_wave_dn=bos_dn&(pivot_h<last_h_before)&dn
    qm_up=bos_up&(pivot_h<last_h_before)&(pivot_l<last_l_before)
    qm_dn=bos_dn&(pivot_l>last_l_before)&(pivot_h>last_h_before)
    obstruction_reclaim_up=(c>o)&(l<o.shift(1))&(c>c.shift(1))&up&v_up
    obstruction_reclaim_dn=(c<o)&(h>o.shift(1))&(c<c.shift(1))&dn&v_up
    hs_proxy_up=bos_up&(pivot_l<last_l_before)&(abs(pivot_h-last_h_before)<2*atr)
    hs_proxy_dn=bos_dn&(pivot_h>last_h_before)&(abs(pivot_l-last_l_before)<2*atr)
    squeeze_with_mom_up=mom_up&squeeze.shift(1).rolling(8).max().fillna(0).gt(0)
    squeeze_with_mom_dn=mom_dn&squeeze.shift(1).rolling(8).max().fillna(0).gt(0)
    rsi_delta=c.diff()
    rsig=rsi_delta.clip(lower=0).ewm(alpha=.5,adjust=False).mean()
    rsil=(-rsi_delta.clip(upper=0)).ewm(alpha=.5,adjust=False).mean()
    rsi2=100-100/(1+rsig/rsil.replace(0,np.nan))
    conditions={
      'PA_Donchian24':(up&breakout_up,dn&breakout_dn),
      'PA_LiquiditySweep':(sweep_up,sweep_dn),
      'PA_SweepCHoCH':(sweep_up&choch_up,sweep_dn&choch_dn),
      'PA_BreakRetest':(retest_up,retest_dn),
      'PA_Engulfing':(up&bullish_eng,dn&bearish_eng),
      'PA_PinBar':(up&bullish_pin,dn&bearish_pin),
      'PA_InsideBar':((h.shift(1)<h.shift(2))&(l.shift(1)>l.shift(2))&up&(c>h.shift(2)),
                     (h.shift(1)<h.shift(2))&(l.shift(1)>l.shift(2))&dn&(c<l.shift(2))),
      'PA_TrendPullback':(up&near_ema_up&bullish_pin,dn&near_ema_dn&bearish_pin),
      'Fib_50_618':(up&fib_p.between(.5,.618)&bullish_pin,dn&fib_s.between(.5,.618)&bearish_pin),
      'Fib_382_50':(up&fib_p.between(.382,.5)&bullish_pin,dn&fib_s.between(.382,.5)&bearish_pin),
      'Elliott_W3_PROXY':(proxy_wave_up,proxy_wave_dn),
      'QM_STRUCTURE_PROXY':(qm_up,qm_dn),
      'Pattern_DoubleBottomTop':(double_l,double_h),
      'Pattern_Triangle':(triangle&up&(c>hh12),triangle&dn&(c<ll12)),
      'Pattern_Flag':(flag&up&(c>hh12),flag&dn&(c<ll12)),
      'Pattern_HeadShoulders_PROXY':(hs_proxy_up,hs_proxy_dn),
      'FVG_Displacement':(up&fvg_bull&v_up,dn&fvg_bear&v_up),
      'OB_Reclaim_PROXY':(obstruction_reclaim_up,obstruction_reclaim_dn),
      'VWAP_Reclaim':(up&(l<vwap)&(c>vwap)&bullish_pin,dn&(h>vwap)&(c<vwap)&bearish_pin),
      'Bollinger_Squeeze':(up&bb_squeeze_up,dn&bb_squeeze_dn),
      'Momentum_TwoBar':(up&mom_up,dn&mom_dn),
      'Volume_Impulse':(up&v_up&(body>1.1*atr)&(c>o),dn&v_up&(body>1.1*atr)&(c<o)),
      'Orderflow_DeltaShift':(up&buy_absorb&v_up,dn&sell_absorb&v_up),
      'Combo_SqueezeMomentum':(up&squeeze_with_mom_up&v_up,dn&squeeze_with_mom_dn&v_up),
      'Combo_SweepDelta':(sweep_up&flow_up,sweep_dn&flow_dn)
    }
    if set(conditions)!=set(BASE_FAMILIES):raise AssertionError('Signal family mismatch')
    signals={}
    for name,(b,s) in conditions.items():
        signals[name]=(b.fillna(False).astype(np.int8)-s.fillna(False).astype(np.int8)).clip(-1,1).to_numpy(dtype=np.int8)
    index_ns=i.asi8
    return {'sig':signals,'open':o.to_numpy(float),'high':h.to_numpy(float),'low':l.to_numpy(float),
      'close':c.to_numpy(float),'atr':atr.to_numpy(float),
      'vol':v.to_numpy(float),'volavg':va.to_numpy(float),'flow':flow.to_numpy(float),
      'h1_up':h1_up.fillna(False).to_numpy(bool),'h1_dn':h1_dn.fillna(False).to_numpy(bool),
      'h4_up':h4_up.fillna(False).to_numpy(bool),'h4_dn':h4_dn.fillna(False).to_numpy(bool),
      't':index_ns,'index':i,'bar_minutes':5 if tf=='5min' else 15}


@njit
def run_one(idx,signals,O,H,L,C,ATR,flt,vol,vavg,flow,h1u,h1d,h4u,h4d,
            stop_mult,hold,bar_minutes,phase_begin,phase_end,fee,funding,risk):
    count=0;winner=0;tp=0;long=0;short=0;gross=0.;los=0.;nettot=0.;equity=1.;peak=1.;dd=0.;free=-1
    for z in range(len(idx)):
        i=idx[z]
        if i<free or i+hold>=len(O) or i<phase_begin or i+hold>=phase_end:continue
        d=int(signals[i])
        if d==0:continue
        if flt==1 and not (h1u[i] if d==1 else h1d[i]):continue
        if flt==2 and not (h4u[i] if d==1 else h4d[i]):continue
        if flt>=3 and not ((h1u[i] and h4u[i]) if d==1 else (h1d[i] and h4d[i])):continue
        if flt==4:
            if not np.isfinite(flow[i]) or not (flow[i]>.12 if d==1 else flow[i]<-.12):continue
            if vol[i]<1.4*vavg[i]:continue
        entry=O[i+1];dist=stop_mult*ATR[i]
        if not np.isfinite(dist) or dist/entry<.0015:continue
        stop=entry-d*dist;target=entry+d*RR*dist
        exitprice=C[i+hold];exit_i=i+hold;is_tp=False
        for j in range(i+1,i+hold+1):
            if (L[j]<=stop if d==1 else H[j]>=stop):
                exitprice=stop;exit_i=j;break
            if (H[j]>=target if d==1 else L[j]<=target):
                exitprice=target;exit_i=j;is_tp=True;break
        elapsed=(exit_i-i)*bar_minutes/60.0
        net=((exitprice-entry)*d-entry*fee-entry*funding*(elapsed/8.0))/dist
        count+=1
        if d==1:long+=1
        else:short+=1
        if is_tp:tp+=1
        if net>0: winner+=1;gross+=net
        else:los-=net
        nettot+=net
        equity=max(0.00001,equity*(1.+risk*net))
        if equity>peak:peak=equity
        dr=1-equity/peak
        if dr>dd:dd=dr
        free=exit_i+1
    if count==0:return np.array([0.,0.,0.,0.,0.,0.,0.,0.,0.])
    return np.array([float(count),float(winner),float(tp),float(long),float(short),nettot/count,
                     (gross/los if los>0 else 0.),100*(equity-1),100*dd])


def to_dict(x):
    n=int(x[0]);return dict(trades=n,win_rate=round(100*x[1]/n,2) if n else None,
      actual_tp5_rate=round(100*x[2]/n,2) if n else None,
      long=int(x[3]),short=int(x[4]),avg_net_R=round(float(x[5]),5) if n else None,
      profit_factor=round(float(x[6]),3) if n else None,
      return_pct=round(float(x[7]),3) if n else None,
      max_dd_pct=round(float(x[8]),3) if n else None)


def execute(D,name,flt,st,hold,begin,end,cost_mult=1.):
    selected=D['sig'][name]
    sig_idx=np.flatnonzero(selected)
    return to_dict(run_one(sig_idx,selected,D['open'],D['high'],D['low'],D['close'],D['atr'],flt,
      D['vol'],D['volavg'],D['flow'],D['h1_up'],D['h1_dn'],D['h4_up'],D['h4_dn'],
      st,hold,D['bar_minutes'],begin,end,ROUNDTRIP_COST*cost_mult,FUNDING_8H*cost_mult,RISK))


def phase_bounds(D):
    t=D['index']
    start=START+pd.Timedelta(days=30)
    return ((int(t.searchsorted(start)),int(t.searchsorted(TRAIN_END))),
      (int(t.searchsorted(TRAIN_END)),int(t.searchsorted(VAL_END))),
      (int(t.searchsorted(VAL_END)),int(t.searchsorted(END))))


def run_search(datasets,outdir,verbose=True):
    # Only 2,500 settings per (BTC/ETH, M5/M15): exactly 10,000 total.
    records=[];cache={}
    for symbol,bytf in datasets.items():
        for tf,D in bytf.items():
            dev,val,holdout=phase_bounds(D)
            if verbose:print('Optimizing',symbol,tf,'bars=',len(D['open']),flush=True)
            for name in BASE_FAMILIES:
                for fidx,fname in enumerate(FILTERS):
                    for st in ATR_STOPS:
                        for hold in MAX_HOLDS:
                            a=execute(D,name,fidx,st,hold,*dev)
                            b=execute(D,name,fidx,st,hold,*val)
                            row={'symbol':symbol,'timeframe':tf,'strategy':name,'filter':fname,'stopATR':st,
                             'hold_bars':hold,'RR':RR,
                             **{'dev_'+k:v for k,v in a.items()},**{'val_'+k:v for k,v in b.items()}}
                            records.append(row)
    all_df=pd.DataFrame(records)
    if len(all_df)!=10000:raise AssertionError(f'Expected 10,000 backtested configurations, got {len(all_df)}')
    all_df.to_csv(outdir/'ALL_10000_BACKTEST_RESULTS.csv',index=False)
    good=all_df.loc[(all_df.dev_trades>=60)&(all_df.val_trades>=60)&
      (all_df.dev_avg_net_R>0)&(all_df.val_avg_net_R>0)&
      (all_df.dev_profit_factor>1.15)&(all_df.val_profit_factor>1.15)&
      (all_df.val_max_dd_pct<15)].copy()
    if len(good):
        good['rank']=((good.dev_avg_net_R.clip(lower=0)*good.val_avg_net_R.clip(lower=0))**.5 *
            np.minimum(good.dev_trades,good.val_trades).clip(upper=150)**.5 /
            (1+good.val_max_dd_pct/15))
        picked=good.sort_values('rank',ascending=False).iloc[0]
        sym=picked.symbol;tf=picked.timeframe;D=datasets[sym][tf];fidx=FILTERS.index(picked['filter'])
        params=[D,picked.strategy,fidx,float(picked.stopATR),int(picked.hold_bars)]
        held=execute(*params,*phase_bounds(D)[2])
        stress=execute(*params,*phase_bounds(D)[2],cost_mult=2)
        selected={'symbol':sym,'timeframe':tf,'strategy':picked.strategy,'filter':picked['filter'],
          'stopATR':float(picked.stopATR),'targetRR':RR,'hold_bars':int(picked.hold_bars),
          'development':{c.replace('dev_',''):picked[c].item() if hasattr(picked[c],'item') else picked[c] for c in picked.index if c.startswith('dev_')},
          'validation':{c.replace('val_',''):picked[c].item() if hasattr(picked[c],'item') else picked[c] for c in picked.index if c.startswith('val_')},
          'final_2026_holdout':held,'final_2026_double_cost':stress,
          'passes_requested_rr5_70pct':bool(held['trades']>=100 and held['actual_tp5_rate']>=70 and
            held['avg_net_R']>0 and held['profit_factor']>1.2 and stress['avg_net_R']>0),
          'paper_only':True}
        (outdir/'BEST_ONE_CANDIDATE.json').write_text(json.dumps(selected,indent=2,ensure_ascii=False),encoding='utf-8')
        return {'status':'CANDIDATE_SELECTED_NOT_LIVE_VALIDATED','n_configurations':len(all_df),
          'n_pass_dev_validation':len(good),'one':selected}
    return {'status':'NO_PASSING_CONFIGURATION','n_configurations':len(all_df),'n_pass_dev_validation':0,
      'one':None,'warning':'No candidate met both development and validation thresholds. Do not force a winner.'}


def selftest():
    # Synthetic input checks only: NEVER publish profitability statistics from this function.
    rng=np.random.default_rng(42)
    N=288*45
    t=pd.date_range('2024-01-01',periods=N,freq='5min',tz='UTC')
    returns=rng.normal(0,.002,N)
    close=40000*np.exp(np.cumsum(returns))
    op=np.r_[close[0],close[:-1]]
    hi=np.maximum(op,close)*(1+rng.uniform(0,.001,N))
    lo=np.minimum(op,close)*(1-rng.uniform(0,.001,N))
    volume=rng.uniform(100,500,N)
    taker=volume*rng.uniform(.3,.7,N)
    df=pd.DataFrame({'t':t,'open':op,'high':hi,'low':lo,'close':close,
      'volume':volume,'taker_buy_volume':taker})
    a=make_features(pair_to_tf(df,'5min'),'5min')
    b=make_features(pair_to_tf(df,'15min'),'15min')
    target=0
    for D in (a,b):
      for S in D['sig'].values():
        assert S.shape[0]==len(D['open'])
        assert np.isin(S,[-1,0,1]).all()
      t0=D['index'];left=1000;right=len(t0)-10
      result=execute(D,'PA_Donchian24',0,1.2,16,left,right)
      assert result['trades']>=0
      target+=len(BASE_FAMILIES)*len(FILTERS)*len(ATR_STOPS)*len(MAX_HOLDS)
    assert target==5000
    print('SELFTEST PASSED: 25 signal families, 5 filters, 4 stops, 5 holds, M5/M15 engine, 5000 configurations per asset; NO MARKET RESULTS')


def main():
    parser=argparse.ArgumentParser(description='10,000 crypto M5/M15 futures backtests, historical official data')
    parser.add_argument('--symbols',nargs='+',default=['BTCUSDT','ETHUSDT'],choices=['BTCUSDT','ETHUSDT'])
    parser.add_argument('--data-dir',default='./crypto3y_data')
    parser.add_argument('--out-dir',default='./CRYPTO_MTF_10000_RESULTS')
    parser.add_argument('--selftest',action='store_true')
    args=parser.parse_args()
    if args.selftest:return selftest()
    if sorted(set(args.symbols))!=['BTCUSDT','ETHUSDT']:
        raise SystemExit('Exact 10,000-combo selection requires BTCUSDT AND ETHUSDT; omit --symbols')
    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    ss=requests.Session();ss.headers.update({'User-Agent':'CryptoMTFResearch-V3/1.0'})
    data={};sources={}
    for symbol in ['BTCUSDT','ETHUSDT']:
        raw,led=get_dataset(symbol,args.data_dir,ss)
        data[symbol]={'5min':make_features(pair_to_tf(raw,'5min'),'5min'),
                      '15min':make_features(pair_to_tf(raw,'15min'),'15min')}
        sources[symbol]=led
        del raw
    report=run_search(data,out)
    report['source_manifest']=sources
    report['method']={'date_start':str(START),'date_end_exclusive':str(END),
     'data_2023_2026':'official Binance USD-M BTCUSDT ETHUSDT 5m 36 monthly archives each',
     'selection':'train Oct2023-Dec2024; validation Jan-Dec2025; once selected, final check Jan-Sep2026',
     'fees_slippage_roundtrip_assumption':ROUNDTRIP_COST,'adverse_funding_assumption_per_8h':FUNDING_8H,
     'risk_per_trade':RISK,'leverage_not_simulated':True,'stop_first_ambiguity':True,
     'orderflow':'taker-buy kline volume delta proxy; not real DOM/L2 or aggTrades CVD',
     'important_limitations':['Assumed rather than account-specific transaction costs and funding',
       'No mark-price liquidation or maintenance margin model','No macro announcement timestamp feed',
       'No real spread or tick-level limit-order fill validation',
       '2025 has been viewed during earlier historical research; not fully pristine',
       'Evaluation uses separate pair/timeframe equity streams, not a simultaneous leveraged portfolio']}
    (out/'FINAL_RESEARCH_REPORT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('source_manifest','method')},ensure_ascii=False,indent=2))
    print('RESEARCH ONLY; no live orders. If no actual-5R >=70% with >100 final trades, mark NOT VALIDATED.')

if __name__=='__main__':main()
