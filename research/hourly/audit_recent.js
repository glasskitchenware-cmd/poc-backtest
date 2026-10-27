#!/usr/bin/env node
// Reproducible research-only audit. Run from repository root: node research/hourly/audit_recent.js
// No API calls, no orders, no writes. Uses saved simulation ledger, NOT raw market data.
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "../..");
const j = JSON.parse(fs.readFileSync(path.join(root, "research/pro/recent_20261023.json"), "utf8"));
const coins = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
const trades = j.last30.trades.filter(t => coins.has(t.coin));
const sum = xs => xs.reduce((s,x) => s+x, 0);
const win = trades.filter(t=>t.r>0), loss=trades.filter(t=>t.r<0);
const week = iso => { const d = new Date(iso); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate() - (d.getUTCDay()+6)%7); return d.toISOString().slice(0,10); };
const groups = new Map();
for (const t of trades) { const k=week(t.entry); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
const blocks = [...groups.entries()].map(([week,ts])=>({week,n:ts.length,r:sum(ts.map(t=>t.r))}));
const k=blocks.length, means=[];
function enumerate(depth,n,r) { if(depth===k) { means.push(r/n); return; } for(const b of blocks) enumerate(depth+1,n+b.n,r+b.r); }
enumerate(0,0,0);
means.sort((a,b)=>a-b);
const quantile = p => means[Math.floor(p*(means.length-1))];
const sorted = [...trades].sort((a,b)=>a.exit.localeCompare(b.exit)||a.coin.localeCompare(b.coin));
let equity=0,peak=0,maxRDrawdown=0;
for(const t of sorted) { equity+=t.r; peak=Math.max(peak,equity); maxRDrawdown=Math.max(maxRDrawdown,peak-equity); }
const Trend = require(path.join(root, "web/trend.js"));
const candles=[];
for(let i=0;i<250;i++){
  let open=100,high=100.5,low=99.5,close=100;
  if(i===220){close=104;high=104.5;low=99.5;}
  if(i>=221&&i<=234){open=104;high=105;low=103;close=104;}
  if(i===235){open=104;high=104.2;low=101;close=101;}
  if(i===236){open=101;high=101.5;low=100.5;close=101;}
  candles.push({time:Date.UTC(2026,0,1)+i*4*3600000,open,high,low,close});
}
const execution = [0,0.0002].map(slippage => {
  const t = Trend.run(candles,{slippage,fee:0.0005,funding:0,tps:[]}).trades[0];
  if(!t) throw Error("Synthetic trade missing");
  return {slippage,entry:t.entry,exit:t.exit,r:t.r,reason:t.reason,cost:t.cost};
});
const out={
  provenance:{generated:j.generated,archive:j.dataset,strategy_version:j.strategy_version},
  scope:"3 coins, LONG+SHORT, saved 30-day 4h simulated trades, not user's 2835-trade POC Breakout",
  trades:trades.length,
  win_count:win.length,loss_count:loss.length,
  total_net_R:sum(trades.map(t=>t.r)),mean_net_R:sum(trades.map(t=>t.r))/trades.length,
  avoided_loss_R_if_reject_all:-sum(loss.map(t=>t.r)),
  discarded_win_R_if_reject_all:sum(win.map(t=>t.r)),
  exit_order_max_drawdown_R_not_portfolio:maxRDrawdown,
  exhaustive_weekly_bootstrap:{
    weeks:k,blocks,enumerated:means.length,
    ci95_mean_R:[quantile(.025),quantile(.975)],
    fraction_resampled_means_le_zero:means.filter(x=>x<=0).length/means.length,
    warning:"Resamples are not independent market observations. This is not a p-value or proof of a profitable strategy."
  },
  synthetic_execution_cost_test:execution,
  validated_for_real_money:false
};
process.stdout.write(JSON.stringify(out,null,2)+"\\n");
