#!/usr/bin/env node
'use strict';
// Research-only causal signal regeneration. No orders/network/deploy. Inputs are saved archive.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const E=require(path.join(root,'flow_breakout/engine.js'));
const saved=JSON.parse(fs.readFileSync(path.join(root,'flow_breakout/trades.json'),'utf8')).B_baseline;
const Y=y=>Date.UTC(y,0,1),periods={reference:[Y(2023),Y(2024)],validation:[Y(2024),Y(2025)],test:[Y(2025),Date.UTC(2026,9,1)]};
const out={audit:'independent causal entry-event reconstruction using archived 5m OHLCV and frozen JS engine; NOT fresh OOS or independent exchange validation',source:{},reconstructed:{},prefix_checks:[],mismatch_examples:[],monte_carlo:0,bootstrap:0,permutation:0,validated_for_real_money:false};
const close=(a,b,eps=1e-7)=>Math.abs(a-b)<=eps*Math.max(1,Math.abs(a),Math.abs(b));
for(const coin of ['BTCUSDT','ETHUSDT','SOLUSDT']){
 const p=path.join(root,'four_groups/bars',coin+'_5m.json'),raw=fs.readFileSync(p),rows=JSON.parse(raw),b=rows.map(r=>({time:r[0],open:r[1],high:r[2],low:r[3],close:r[4],volume:r[5]}));
 const I=E.features(b),ev=E.events(b,I);
 out.source[coin]={bars:rows.length,sha256:crypto.createHash('sha256').update(raw).digest('hex'),events:ev.length};
 out.reconstructed[coin]={};
 for(const [period,[lo,hi]] of Object.entries(periods)){
  const end=b.findIndex(x=>x.time>=hi),last=end<0?b.length:end;
  const expected=saved[period].filter(t=>t.coin===coin),actual=[],reject={cost:0,risk:0,reward:0};
  for(const e of ev){const index=e.event_index+1;if(index>=last||b[index].time<lo)continue;
   const s={group:'FlowProbe',dir:e.dir,k:2,rr:1.5,atr:I.atr[e.event_index],maxBars:12};
   const t=E.execute(b,I,index,s,last);
   if(t.rejected){reject[t.rejected]++;continue;}
   actual.push({...t,event_id:e.event_time,bound:e.bound,coin});
  }
  const key=t=>[t.coin,t.entry_time,t.dir].join('|');
  const amap=new Map(actual.map(t=>[key(t),t])),xmap=new Map(expected.map(t=>[key(t),t]));
  let checked=0,bad=0;const fields=['event_id','entry_index','exit_index','entry_time','exit_time','dir','entry','exit','stop','target','risk','grossR','feeR','slipR','fundR','r'];
  for(const [k,t] of xmap){const a=amap.get(k);if(!a){bad++;if(out.mismatch_examples.length<15)out.mismatch_examples.push({coin,period,key:k,error:'missing regenerated trade'});continue;}
   checked++;for(const f of fields){if(typeof t[f]==='number'&&!close(t[f],a[f])){bad++;if(out.mismatch_examples.length<15)out.mismatch_examples.push({coin,period,key:k,field:f,stored:t[f],regen:a[f]});} }
   if(t.reason!==a.reason){bad++;if(out.mismatch_examples.length<15)out.mismatch_examples.push({coin,period,key:k,field:'reason',stored:t.reason,regen:a.reason});}
  }
  for(const k of amap.keys())if(!xmap.has(k)){bad++;if(out.mismatch_examples.length<15)out.mismatch_examples.push({coin,period,key:k,error:'extra regenerated trade'});}
  out.reconstructed[coin][period]={stored:expected.length,regenerated:actual.length,matched_keys:checked,field_mismatches:bad,rejections:reject};
 }
 // Test the same signal computed on a truncated prefix of historical bars, without future data.
 // One representative event in each period (not a random sample; no p-value).
 for(const [period,[lo,hi]] of Object.entries(periods)){
  const eligible=ev.filter(e=>e.event_time>=lo&&e.event_time<hi);if(!eligible.length)continue;
  const e=eligible[Math.floor(eligible.length/2)],idx=e.event_index;
  const prefix=b.slice(0,idx+1),P=E.features(prefix),prefixEvent=E.eventAt(prefix,P,idx);
  const ok=!!prefixEvent&&prefixEvent.event_time===e.event_time&&prefixEvent.dir===e.dir&&close(prefixEvent.bound,e.bound)&&close(P.atr[idx],I.atr[idx]);
  out.prefix_checks.push({coin,period,signal_index:idx,history_bars:prefix.length,ok});
 }
}
out.total_saved=['reference','validation','test'].reduce((s,p)=>s+saved[p].length,0);
out.total_regenerated=Object.values(out.reconstructed).flatMap(v=>Object.values(v)).reduce((s,x)=>s+x.regenerated,0);
out.total_mismatches=Object.values(out.reconstructed).flatMap(v=>Object.values(v)).reduce((s,x)=>s+x.field_mismatches,0);
out.prefix_checks_pass=out.prefix_checks.every(x=>x.ok);
console.log(JSON.stringify(out,null,2));
if(out.total_mismatches||!out.prefix_checks_pass)process.exitCode=1;
