// Runs the app's own technique rules (swing.js, unchanged) on 3 years of real futures bars.
const fs = require("fs");
const Swing = require("./swing.js");
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
const fmt = (x, d = 2) => (x === null || x === undefined || !isFinite(x)) ? "-" : x.toFixed(d);
for (const tf of ["5m", "15m", "1h", "4h"]) {
  const data = {};
  for (const s of SYMBOLS) {
    const rows = JSON.parse(fs.readFileSync(`bars/${s}_${tf}.json`, "utf8"));
    data[s] = rows.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], close_time: r[6] }));
  }
  // Futures taker costs as in the app (0.05% fee + 0.02% slippage per side).
  const r = Swing.evaluate(data, { fee: 0.0005, slippage: 0.0002, risk: 0.0025 });
  console.log(`\n===== ${tf} · ${SYMBOLS.length} coins · 2023-10..2026-09 · chosen: ${r.chosen || "none"}` +
    (r.holdout ? ` · holdout ${r.holdout.trades} trades avgR ${fmt(r.holdout.exp_r)} PF ${fmt(r.holdout.pf)}` : ""));
  for (const t of r.techniques) {
    const all = t.trades.development.concat(t.trades.validation, t.trades.holdout);
    const st = Swing.stats(all, 0.0025), ho = Swing.stats(t.trades.holdout, 0.0025);
    const years = t.yearly.map(y => `${y.year}:${y.stats.trades}/${fmt(y.stats.exp_r)}R`).join(" ");
    console.log(`${t.id.padEnd(14)} all ${String(st.trades).padStart(5)} trades win ${fmt(st.win_rate, 0)}% avg ${fmt(st.exp_r)}R PF ${fmt(st.pf)} ret ${fmt(st.return_pct, 1)}% | dev ${fmt(t.development.exp_r)} val ${fmt(t.validation.exp_r)} hold ${fmt(ho.exp_r)} (${ho.trades}) | ${years}`);
  }
}
