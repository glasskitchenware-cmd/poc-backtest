// "How sure is each open trade?": of the Trend 4H trades (scale-out plan, app filter) that were at a given R at a 4-hour
// close, how many ended in profit, and what did they end with on average? Fixed before the run:
//  - States: the R at the close (bands below), and whether TP1 has sold. Rates estimated on the 12 coins 2020-2022.
//  - Shown in the app only if, for every band with at least 100 trades, the rate on 2023-2026 (12 coins) and on the 25
//    unseen coins is within 10 percentage points of 2020-2022.
//  - The app shows the 2020-2026 rate of the 12 coins (each trade counted once per band: its first close in the band).
// Usage: node liveodds.js BASE_COINS UNSEEN_COINS   (4h bars from ../evidence/bars)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [BASE, UNSEEN] = process.argv.slice(2, 4).map(x => x.split(","));
const MMR_SAFE = 0.01, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1);
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const BANDS = [[-Infinity, -0.75], [-0.75, -0.25], [-0.25, 0.25], [0.25, 0.75], [0.75, 1.5], [1.5, 3], [3, Infinity]];
const bandOf = r => BANDS.findIndex(b => r >= b[0] && r < b[1]);
const load = c => { const p = `../evidence/bars/${c}_4h.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] })) : null; };
// Each trade once per (band, TP1 sold) state it passed through at a 4-hour close while open.
function states(coins, from, to) {
  const out = [];
  coins.forEach(c => {
    const b = load(c); if (!b) return;
    Trend.run(b, { tps: LADDER }).trades.filter(t => t.entry_time >= from && t.entry_time < to && levLiq(t) >= 5).forEach(t => {
      const seen = {};
      for (let k = t.entry_index; k < t.exit_index; k++) {
        const r = t.dir * (b[k].close - t.entry) / t.risk, tp = (t.fills || []).some(f => f.time <= b[k].time) ? 1 : 0, key = bandOf(r) + ":" + tp;
        if (!seen[key]) { seen[key] = 1; out.push({ key, final: t.r }); }
      }
    });
  });
  return out;
}
const rate = xs => { const o = {}; xs.forEach(s => { const x = o[s.key] || (o[s.key] = { n: 0, w: 0, sum: 0 }); x.n++; x.w += s.final > 0 ? 1 : 0; x.sum += s.final; });
  Object.values(o).forEach(x => { x.win = +(100 * x.w / x.n).toFixed(1); x.avgR = +(x.sum / x.n).toFixed(3); delete x.w; delete x.sum; }); return o; };
const train = rate(states(BASE, Y(2020), Y(2023))), test = rate(states(BASE, Y(2023), END)), unseen = rate(states(UNSEEN, Y(2020), END)), all = rate(states(BASE, Y(2020), END));
let ok = true;
const rows = Object.keys(all).sort().map(k => {
  const [bi, tp] = k.split(":").map(Number), row = { band: BANDS[bi].map(v => isFinite(v) ? v : null), tp1: !!tp, all: all[k], train: train[k], test: test[k], unseen: unseen[k] };
  if (train[k] && train[k].n >= 100) for (const o of [test[k], unseen[k]]) if (o && o.n >= 100 && Math.abs(o.win - train[k].win) > 10) ok = false;
  console.log(`R ${JSON.stringify(row.band)} TP1 ${row.tp1 ? "sold" : "no"} · all ${JSON.stringify(all[k])} · 2020-22 ${JSON.stringify(train[k])} · 2023-26 ${JSON.stringify(test[k])} · unseen ${JSON.stringify(unseen[k])}`);
  return row;
});
fs.writeFileSync("liveodds.json", JSON.stringify({ generated: new Date().toISOString().slice(0, 10), bands: BANDS.map(b => b.map(v => isFinite(v) ? v : null)), rows, adopt: ok }, null, 1) + "\n");
console.log("LIVEODDS adopt=" + ok);
