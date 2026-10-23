// Pyramiding, as trend followers do: add a second unit to a Trend 4H trade once it is in profit, with the same stop, so the
// trades that run carry more. Fixed before the run:
//  - Candidates: none; add 1 unit at +1R; add 1 unit at +2R; add half a unit at +1R. The added unit risks (as a share of
//    the first unit's risk) its size x its distance to the original stop; it leaves with the trade (channel exit or
//    stop), no take profit of its own. The first unit is the app's trade (scale-out plan). Fill at the level, or at the
//    open when the bar gaps past it; costs as the app (fee, slippage, funding).
//  - Chosen on the 12 coins 2020-2022 by CAGR / max drawdown at 0.5% risk per first unit; adopted only if it also beats
//    no pyramiding on 2023-2026, the 25 unseen coins and spot 2017-2019 in MAR and in R per trade.
// Usage: node pyramid.js BASE_COINS UNSEEN_COINS SPOT_COINS   (4h bars from ../evidence/bars)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [BASE, UNSEEN, SPOT] = process.argv.slice(2, 5).map(x => x.split(","));
const H = 3600000, MMR_SAFE = 0.01, RISK = 0.005, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1), SPOT_FROM = Date.UTC(2017, 8, 1);
const D = Trend.DEFAULTS, LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const CANDS = [{ id: "none", at: null, size: 0 }, { id: "add1", at: 1, size: 1 }, { id: "add2", at: 2, size: 1 }, { id: "half1", at: 1, size: 0.5 }];
const load = name => { const p = `../evidence/bars/${name}.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] })) : null; };
// R of the added unit in units of the first unit's risk, or 0 when the trade never reached the level while open.
function added(b, t, C) {
  if (!C.at) return 0;
  const level = t.entry + t.dir * C.at * t.risk;
  for (let k = t.entry_index; k < t.exit_index; k++) {
    const x = b[k];
    if (t.dir > 0 ? x.high < level : x.low > level) continue;
    const fill = (t.dir > 0 ? x.open >= level : x.open <= level) ? x.open : level, px = fill * (1 + t.dir * D.slippage);
    const exitPx = t.exit, hours = (t.exit_time - x.time) / H;
    const gross = t.dir * (exitPx - px), cost = 2 * D.fee * px + D.slippage * px + D.funding * px * Math.max(0, hours) / 8;
    return C.size * (gross - cost) / t.risk;   // same stop: a stopped trade loses the distance from the add to the stop
  }
  return 0;
}
function trades(coins, prefix, from, to) {
  const out = [];
  coins.forEach(c => {
    const b = load(prefix + c + "_4h"); if (!b) return;
    Trend.run(b, { tps: LADDER }).trades.filter(t => t.entry_time >= from && t.entry_time < to && levLiq(t) >= 5)
      .forEach(t => out.push({ entry_time: t.entry_time, exit_time: t.exit_time, r1: t.r, add: CANDS.map(C => added(b, t, C)) }));
  });
  return out;
}
const summary = (tr, j) => {
  const rs = tr.map(t => t.r1 + t.add[j]), n = rs.length; if (!n) return { n: 0 };
  const m = rs.reduce((a, v) => a + v, 0) / n, sd = Math.sqrt(rs.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  return { n, win: +(100 * rs.filter(v => v > 0).length / n).toFixed(1), avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)],
    added: +(100 * tr.filter(t => t.add[j] !== 0).length / n).toFixed(1) };
};
function port(tr, j, from, to) {
  const ev = [], stake = {};
  tr.forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, i }); ev.push({ time: Math.max(t.exit_time, t.entry_time + 1), k: 0, i, r: t.r1 + t.add[j] }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  let eq = 1, peak = 1, dd = 0;
  for (const e of ev) { if (e.k === 1) stake[e.i] = eq * RISK; else { eq = Math.max(0.01, eq + stake[e.i] * e.r); peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); } }
  const cagr = 100 * (Math.pow(eq, 1 / ((to - from) / (365.25 * 24 * H))) - 1);
  return { cagr: +cagr.toFixed(1), maxDD: +(100 * dd).toFixed(1), mar: dd > 0 ? +(cagr / (100 * dd)).toFixed(2) : null };
}
const have = (coins, prefix) => coins.filter(c => fs.existsSync(`../evidence/bars/${prefix}${c}_4h.json`));
const SETS = { train: [BASE, "", Y(2020), Y(2023)], test: [BASE, "", Y(2023), END], unseen: [have(UNSEEN, ""), "", Y(2020), END], spot: [have(SPOT, "spot_"), "spot_", SPOT_FROM, Y(2020)] };
const out = { generated: new Date().toISOString().slice(0, 10), risk: RISK * 100, candidates: CANDS, sets: {} };
const T = {};
for (const [k, [coins, prefix, from, to]] of Object.entries(SETS)) {
  T[k] = trades(coins, prefix, from, to);
  out.sets[k] = CANDS.map((C, j) => ({ id: C.id, s: summary(T[k], j), port: port(T[k], j, from, to) }));
  console.log(`== ${k} (${T[k].length} trades)`); out.sets[k].forEach(x => console.log(`  ${x.id.padEnd(6)} ${JSON.stringify(x.s)} ${JSON.stringify(x.port)}`));
}
const pick = out.sets.train.slice().sort((a, b) => (b.port.mar || 0) - (a.port.mar || 0))[0], j = CANDS.findIndex(C => C.id === pick.id);
const checks = pick.id === "none" ? null : Object.fromEntries(["test", "unseen", "spot"].map(k => [k, out.sets[k][j].port.mar > out.sets[k][0].port.mar && out.sets[k][j].s.avgR > out.sets[k][0].s.avgR]));
out.chosen = pick.id; out.checks = checks; out.adopt = !!checks && Object.values(checks).every(Boolean);
console.log("chosen on 2020-2022:", pick.id, "checks", JSON.stringify(checks), "adopt", out.adopt);
fs.writeFileSync("pyramid.json", JSON.stringify(out, null, 1) + "\n");
