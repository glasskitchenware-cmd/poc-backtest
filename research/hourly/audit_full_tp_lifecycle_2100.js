#!/usr/bin/env node
"use strict";
// Negative regression, synthetic bars only; no exchange calls, orders or production changes.
const assert=require("assert"),path=require("path");
const Trend=require(path.resolve(__dirname,"../../web/trend.js"));
function bars(drop=false){
 const a=[];
 for(let i=0;i<230;i++){
  let open=100,high=100.5,low=99.5,close=100;
  if(i===220){high=104.5;low=99.5;close=104;}
  if(i===221){open=104;high=110;low=103.8;close=109;}
  if(i>=222){open=109;high=109.5;low=108.5;close=109;}
  if(drop&&i===225){open=90;high=91;low=89;close=90;}
  if(drop&&i>=226){open=90;high=90.5;low=89.5;close=90;}
  a.push({time:Date.UTC(2026,0,1)+i*4*3600000,open,high,low,close});
 }return a;
}
const opts={trend:false,n:5,m:5,k:1,atrN:3,emaN:3,fee:0,slippage:0,funding:0,minStopFrac:0,tps:[{r:1,frac:.5},{r:2,frac:.5}]};
const live=Trend.run(bars(),{...opts,live:true});
assert(live.pos&&live.pos.left===0&&live.pos.fills.length===2&&live.trades.length===0);
const drop=Trend.run(bars(true),opts);
assert.strictEqual(drop.trades.length,1);
assert.strictEqual(drop.trades[0].reason,"stop_gap");
assert.strictEqual(drop.trades[0].tpHit,2);
assert(Math.abs(drop.trades[0].r-1.5)<1e-10);
console.log(JSON.stringify({scope:"synthetic full-scale-out lifecycle defect",live_ghost_position:{left:live.pos.left,filled:live.pos.fills.length,closed_trades:live.trades.length},later_stop_gap:{reason:drop.trades[0].reason,r:drop.trades[0].r,exit_index:drop.trades[0].exit_index},market_trades:0,bootstrap:0,monte_carlo:0,permutation:0,passed:"defect reproduced; NOT profitable strategy"},null,2));
