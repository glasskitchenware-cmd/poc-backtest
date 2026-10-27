// Does Trend 4H do better taking LONG signals only? Found on 2023-2026 (SHORT 957 trades -0.003R, PF 0.99; LONG
// +0.202R, research/pro/recent_20261023.json), so it is tested only on data that played no part in finding it.
// FIXED BEFORE THE RUN (2026-10-28):
//  - Candidates: "both" (the app now) and "long" (LONG signals only; nothing else changes: entries, stop, scale-out,
//    channel exit, costs, leverage filter as the app). "short" is reported for information.
//  - Decision sets: the 12 coins 2020-2022; 25 coins never used to choose anything, 2020-01..2026-09; spot 2017-09..2019
//    (12 coins, before the rule was chosen). Not used to decide: 2023-01..2026-09 (where it was found) and 2026-10 on.
//  - Adopt LONG-only only if, in every decision set, it beats "both" in average R per trade AND in MAR (CAGR / max
//    drawdown at 0.25% risk per trade, equity-compounded). Otherwise the app keeps both sides. Reported either way.
// Usage: node longonly.js BASE_COINS UNSEEN_COINS SPOT_COINS NOW_MS   (4h bars from ../evidence/bars)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [BASE, UNSEEN, SPOT] = process.argv.slice(2, 5).map(x => x.split(","));
const NOW = +process.argv[5] || Date.now();
const H = 3600000, MMR_SAFE = 0.01, RISK = 0.0025, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1), SPOT_FROM = Date.UTC(2017, 8, 1);
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const load = name => { const p = `../evidence/bars/${name}.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], close_time: r[6] })).filter(x => x.close_time < NOW) : null; };
function trades(coins, prefix, from, to) {
  const out = [];
  coins.forEach(c => { const b = load(prefix + c + "_4h"); if (!b) return;
    Trend.run(b, { tps: LADDER }).trades.filter(t => t.entry_time >= from && t.entry_time < to && levLiq(t) >= 5 && t.reason !== "end").forEach(t => out.push(Object.assign({ coin: c }, t))); });
  return out;
}
function summary(tr) {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  const gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
  return { n, win: +(100 * tr.filter(t => t.r > 0).length / n).toFixed(1), avgR: +m.toFixed(4), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)], sumR: +(m * n).toFixed(1), pf: gl ? +(gp / gl).toFixed(3) : null };
}
function port(tr, from, to) {
  const ev = [], stake = {}, months = {};
  tr.forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, i }); ev.push({ time: Math.max(t.exit_time, t.entry_time + 1), k: 0, i, r: t.r }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  let eq = 1, peak = 1, dd = 0;
  for (const e of ev) {
    if (e.k === 1) { stake[e.i] = eq * RISK; continue; }
    const pnl = stake[e.i] * e.r, mk = new Date(e.time).toISOString().slice(0, 7);
    eq = Math.max(0.01, eq + pnl); months[mk] = (months[mk] || 0) + pnl; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
  }
  const years = (to - from) / (365.25 * 24 * H), cagr = 100 * (Math.pow(eq, 1 / years) - 1), mv = Object.values(months);
  return { cagr: +cagr.toFixed(2), maxDD: +(100 * dd).toFixed(2), mar: dd > 0 ? +(cagr / (100 * dd)).toFixed(3) : null, posMonths: mv.length ? +(100 * mv.filter(v => v > 0).length / mv.length).toFixed(1) : null, months: mv.length };
}
const have = (coins, prefix) => coins.filter(c => fs.existsSync(`../evidence/bars/${prefix}${c}_4h.json`));
const SETS = {
  "2020-2022 (decides)": [BASE, "", Y(2020), Y(2023), true],
  "unseen 25 coins 2020-01..2026-09 (decides)": [have(UNSEEN, ""), "", Y(2020), END, true],
  "spot 2017-09..2019 (decides)": [have(SPOT, "spot_"), "spot_", SPOT_FROM, Y(2020), true],
  "2023-01..2026-09 (where it was found; not deciding)": [BASE, "", Y(2023), END, false],
  "2026-10 on (live; not deciding)": [BASE, "", END, NOW, false]
};
const out = { generated: new Date().toISOString(), now: new Date(NOW).toISOString(), risk: RISK * 100, sets: {}, checks: {} };
for (const [name, [coins, prefix, from, to, decides]] of Object.entries(SETS)) {
  const all = trades(coins, prefix, from, to), sides = { both: all, long: all.filter(t => t.dir > 0), short: all.filter(t => t.dir < 0) };
  out.sets[name] = { coins: coins.length, decides };
  for (const [k, tr] of Object.entries(sides)) out.sets[name][k] = Object.assign(summary(tr), { port: port(tr, from, to) });
  const s = out.sets[name];
  if (decides) out.checks[name] = { avgR: s.long.avgR > s.both.avgR, mar: (s.long.port.mar || -Infinity) > (s.both.port.mar || -Infinity) };
  console.log("==", name, coins.length, "coins");
  for (const k of ["both", "long", "short"]) console.log("  ", k.padEnd(5), JSON.stringify(s[k]));
}
out.adopt = Object.values(out.checks).every(c => c.avgR && c.mar);
console.log("checks", JSON.stringify(out.checks), "ADOPT LONG-ONLY:", out.adopt);
fs.writeFileSync("longonly.json", JSON.stringify(out, null, 1) + "\n");
