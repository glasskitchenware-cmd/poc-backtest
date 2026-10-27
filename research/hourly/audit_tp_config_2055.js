#!/usr/bin/env node
"use strict";
// Research-only negative test. Run: node research/hourly/audit_tp_config_2055.js
// Uses synthetic OHLC; no exchange calls, orders, writes or deployment.
const assert=require("assert"),path=require("path");
const Trend=require(path.resolve(__dirname,"../../web/trend.js"));
function bars(high221=107,close221=106){
 const a=[];for(let i=0;i<230;i++){
  let open=100,high=100.5,low=99.5,close=100;
  if(i===220){high=104.5;low=99.5;close=104;}
  if(i===221){open=104;high=high221;low=103.8;close=close221;}
  if(i>=222){open=close221;high=close221+0.5;low=close221-0.5;close=close221;}
  a.push({time:Date.UTC(2026,0,1)+i*4*3600000,open,high,low,close});
 }return a;
}
function run(tps,high=107,close=106){
 const out=Trend.run(bars(high,close),{trend:false,n:5,m:5,k:1,atrN:3,emaN:3,fee:0,slippage:0,funding:0,minStopFrac:0,tps});
 assert.strictEqual(out.trades.length,1);const t=out.trades[0];
 return {tpHit:t.tpHit,remaining:1-t.fills.reduce((s,f)=>s+f.frac,0),r:t.r,fills:t.fills};
}
const sorted=run([{r:1,frac:.3},{r:2,frac:.3}]);
const unsorted=run([{r:2,frac:.3},{r:1,frac:.3}]);
const over=run([{r:1,frac:.6},{r:2,frac:.6}],110,109);
const negative=run([{r:1,frac:-.2}]);
assert.strictEqual(sorted.tpHit,1);
assert.strictEqual(unsorted.tpHit,0); // lower 1R target was reached but hidden behind first 2R target
assert(over.remaining<0); // impossible negative residual position
assert(negative.remaining>1); // impossible >100% residual position
console.log(JSON.stringify({scope:"synthetic regression of optional tps config only",sorted,unsorted,over,negative,real_market_trades:0,monte_carlo:0,bootstrap:0,permutation:0,pass:"Reproduced unsafe config acceptance, NOT a profitable strategy"},null,2));
