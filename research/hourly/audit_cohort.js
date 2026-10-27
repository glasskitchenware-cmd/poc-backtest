#!/usr/bin/env node
// Research-only deterministic cohort/fragility audit; no network, orders, or writes.
// Run from repo root: node research/hourly/audit_cohort.js
"use strict";
const fs=require("fs"),path=require("path"),crypto=require("crypto"),assert=require("assert");
const root=path.resolve(__dirname,"../.."),file=path.join(root,"research/pro/recent_20261023.json");
const raw=fs.readFileSync(file),j=JSON.parse(raw.toString("utf8"));
const symbols=["BTCUSDT","ETHUSDT","SOLUSDT"],trades=j.last30.trades.filter(t=>symbols.includes(t.coin));
const sum=a=>a.reduce((s,x)=>s+x,0),total=ts=>sum(ts.map(t=>t.r));
assert.strictEqual(trades.length,15,"Unexpected trade count; re-audit before comparing.");
const ids=new Set();
for(const t of trades){
  assert(["LONG","SHORT"].includes(t.side));
  assert(Number.isFinite(t.r)&&Date.parse(t.entry)<Date.parse(t.exit));
  assert(t.exit>=j.last30.window[0]&&t.exit<j.last30.window[1],"Exit outside report window");
  const id=[t.coin,t.side,t.entry,t.exit].join("|");
  assert(!ids.has(id),"Duplicate trade key");ids.add(id);
}
const netR=total(trades);
assert(Math.abs(netR-(-4.494))<1e-8,"Baseline changed");
const pre=trades.filter(t=>t.entry<j.last30.window[0]),inside=trades.filter(t=>t.entry>=j.last30.window[0]);
const durations=trades.map(t=>(Date.parse(t.exit)-Date.parse(t.entry))/3600000).sort((a,b)=>a-b);
const week=s=>{const d=new Date(s);d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);};
const weeks=new Map();
for(const t of trades){const w=week(t.entry);if(!weeks.has(w))weeks.set(w,[]);weeks.get(w).push(t);}
const leaveOneWeekOut=[...weeks].map(([w,ts])=>({excluded_entry_week:w,excluded_n:ts.length,excluded_R:total(ts),remaining_n:trades.length-ts.length,remaining_R:netR-total(ts),remaining_mean_R:(netR-total(ts))/(trades.length-ts.length)}));
const bySide=Object.fromEntries(["LONG","SHORT"].map(s=>[s,{n:trades.filter(t=>t.side===s).length,netR:total(trades.filter(t=>t.side===s))}]));
const byCoin=Object.fromEntries(symbols.map(s=>[s,{n:trades.filter(t=>t.coin===s).length,netR:total(trades.filter(t=>t.coin===s))}]));
const costs=symbols.map(s=>j.last30.byCoin[s]);
const gross=sum(costs.map(c=>c.gross)),fee=sum(costs.map(c=>c.fee)),slip=sum(costs.map(c=>c.slip)),funding=sum(costs.map(c=>c.funding));
const events=[];
for(const t of trades){events.push({ts:t.entry,d:1});events.push({ts:t.exit,d:-1});}
events.sort((a,b)=>a.ts.localeCompare(b.ts)||a.d-b.d);
let concurrent=0,maxConcurrent=0;
for(const e of events){concurrent+=e.d;maxConcurrent=Math.max(maxConcurrent,concurrent);}
assert.strictEqual(concurrent,0);
const out={
  provenance:{source:"research/pro/recent_20261023.json",source_sha256:crypto.createHash("sha256").update(raw).digest("hex"),stored_blob_sha:"4c71f82bf892b40dbf834c4bf7554762deb10f96",generated:j.generated,strategy:j.strategy_version,scope:"saved Trend4H 4h simulated trades, NOT POC Breakout"},
  exit_window:j.last30.window,trade_count:trades.length,net_R:netR,mean_R:netR/trades.length,
  cohort_boundary:{entered_before_exit_window_n:pre.length,entered_before_exit_window_R:total(pre),entered_within_exit_window_n:inside.length,entered_within_exit_window_R:total(inside),warning:"Exit-window report includes older entries; not an error and not an OOS test."},
  leave_one_entry_week_out:leaveOneWeekOut,
  all_leave_one_week_out_negative:leaveOneWeekOut.every(x=>x.remaining_R<0),
  by_side:bySide,by_coin:byCoin,
  duration_hours:{median:durations[Math.floor(durations.length/2)],mean:sum(durations)/durations.length,gt_24h:durations.filter(h=>h>24).length,lte_24h:durations.filter(h=>h<=24).length},
  max_concurrent_positions_from_stored_trades:maxConcurrent,
  aggregate_cost_sensitivity_rounded:{gross_R:gross,fee_R:fee,slip_R:slip,funding_R:funding,net_R_from_rounded_components:gross-fee-slip-funding,zero_cost_gross_R_approx:gross,double_all_cost_R_approx:gross-2*(fee+slip+funding),warning:"By-coin aggregates are rounded; this is NOT a rerun, does not correct potential double-counted slippage, and cannot reconstruct trade-level costs."},
  resampling:{bootstrap_draws:0,monte_carlo_draws:0,permutations:0,reason:"Prior 6-week exhaustive bootstrap already enumerated all 46656 resamples; no new independent POC ledger."},
  validated_for_real_money:false
};
process.stdout.write(JSON.stringify(out,null,2)+"\n");
