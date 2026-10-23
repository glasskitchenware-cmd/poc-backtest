// Robustness of Trend 4H, the app's rule (web/trend.js, unchanged), on data it was never chosen on.
//  1. Unseen coins: USD-M perpetuals outside the 12 the app trades, including coins delisted since (less survivorship
//     bias), 2020-01..2026-09, with the app's filter (no signal when the stop needs leverage below 5x).
//  2. Unseen years: Binance spot 4h bars 2017-08..2019-12, before every year used to choose the rule.
//  3. The 12 coins in the evidence years (2023-2026, walk-forward) for comparison, and how often a year ends in a loss:
//     block bootstrap of the months (3-month blocks keep runs of bad months together) and the worst 12 months that
//     actually happened.
//  4. A cap on positions open at once (12 coins), listed before the run, chosen on 2020-2022, reported on 2023-2026.
// Costs as the app: fee 0.05% + slippage 0.02% per side, funding 0.01%/8h always paid (also on spot: conservative).
// Take profit: none (the rule) and the scale-out plan research/pro chose (the app default).
// Usage: node robust.js BASE_COINS UNSEEN_COINS SPOT_COINS   (bars from ../evidence/bars, written by fetch.py)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [BASE, UNSEEN, SPOT] = process.argv.slice(2, 5).map(x => x.split(","));
const H = 3600000, MMR_SAFE = 0.01, RISK = 0.005;
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261022.json", "utf8")).ladder.tps;
const MODES = { rule: null, ladder: LADDER };
const Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1);
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const load = name => {
  const p = `../evidence/bars/${name}.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], close_time: r[6] })) : null;
};
const wilson = (k, n) => {
  if (!n) return [null, null];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [+(100 * (c - h)).toFixed(1), +(100 * (c + h)).toFixed(1)];
};
const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
const summary = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  const w = tr.filter(t => t.r > 0).length, gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
  return { n, win: +(100 * w / n).toFixed(1), winCI: wilson(w, n), avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)],
    pf: gl ? +(gp / gl).toFixed(2) : null, t: +(m / se).toFixed(2) };
};
// Trades of the app's rule on every coin of a group that has bars, entries in [from, to), app filter.
const trades = (coins, prefix, from, to, tps) => [].concat(...coins.map(c => {
  const b = load(prefix + c + "_4h");
  return b ? Trend.run(b, { tps }).trades.filter(t => t.entry_time >= from && t.entry_time < to && levLiq(t) >= 5).map(t => Object.assign({ coin: c }, t)) : [];
}));
const byYear = tr => {
  const o = {};
  tr.forEach(t => { const y = new Date(t.entry_time).getUTCFullYear(); (o[y] = o[y] || []).push(t); });
  for (const y of Object.keys(o)) o[y] = summary(o[y]);
  return o;
};
const byCoin = tr => {
  const o = {};
  tr.forEach(t => (o[t.coin] = o[t.coin] || []).push(t));
  for (const c of Object.keys(o)) o[c] = summary(o[c]);
  return o;
};
// Portfolio: each trade risks RISK of the realized equity at its entry, P&L at exit; at most maxOpen positions at once.
const simulate = (tr, from, to, maxOpen) => {
  const ev = [], stake = {}, months = {};
  tr.forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, t, i }); ev.push({ time: t.exit_time, k: 0, t, i }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  let eq = 1, peak = 1, dd = 0, open = 0, taken = 0;
  for (const e of ev) {
    if (e.k === 1) {
      if (open < (maxOpen || Infinity)) { stake[e.i] = eq * RISK; open++; taken++; }
    } else if (stake[e.i] !== undefined) {
      const before = eq;
      eq = Math.max(0.01, eq + stake[e.i] * e.t.r); open--;
      peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
      const m = new Date(e.time).toISOString().slice(0, 7); months[m] = (months[m] || 1) * (eq / before);
    }
  }
  const mv = [];
  for (let d = new Date(from); d.getTime() < to; d.setUTCMonth(d.getUTCMonth() + 1)) mv.push(months[d.toISOString().slice(0, 7)] || 1);
  const cagr = 100 * (Math.pow(eq, 1 / ((to - from) / (365.25 * 24 * H))) - 1);
  return { taken, skipped: tr.length - taken, cagr: +cagr.toFixed(1), maxDD: +(100 * dd).toFixed(1), mar: dd > 0 ? +(cagr / (100 * dd)).toFixed(2) : null,
    losingMonths: +(100 * mv.filter(v => v < 1).length / mv.length).toFixed(0), mv };
};
const port = (tr, from, to, maxOpen) => { const p = simulate(tr, from, to, maxOpen); delete p.mv; return p; };
// How a year can turn out: 12 months as 4 blocks of 3 consecutive months drawn from the months that happened.
function yearly(mv) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const years = [];
  for (let k = 0; k < 20000; k++) {
    let y = 1;
    for (let b = 0; b < 4; b++) { const s = Math.floor(rnd() * (mv.length - 2)); y *= mv[s] * mv[s + 1] * mv[s + 2]; }
    years.push(100 * (y - 1));
  }
  const roll = [];
  for (let i = 11; i < mv.length; i++) roll.push(100 * (mv.slice(i - 11, i + 1).reduce((a, v) => a * v, 1) - 1));
  return { pLoss: +(100 * years.filter(v => v < 0).length / years.length).toFixed(1), pLoss10: +(100 * years.filter(v => v < -10).length / years.length).toFixed(1),
    p5: +pct(years, 0.05).toFixed(1), p50: +pct(years, 0.5).toFixed(1), p95: +pct(years, 0.95).toFixed(1),
    worst12: +Math.min(...roll).toFixed(1), best12: +Math.max(...roll).toFixed(1), rollLoss: +(100 * roll.filter(v => v < 0).length / roll.length).toFixed(0), months: mv.length };
}

const out = { generated: new Date().toISOString().slice(0, 10), costs: "fee 0.05% + slippage 0.02% per side, funding 0.01%/8h (also on spot)", risk: RISK * 100,
  ladder: LADDER, base: {}, unseen: { coins: [] }, spot: { coins: [] }, yearly: {}, heat: {} };
const have = (coins, prefix) => coins.filter(c => fs.existsSync(`../evidence/bars/${prefix}${c}_4h.json`));
out.unseen.coins = have(UNSEEN, ""); out.spot.coins = have(SPOT, "spot_");
console.log("unseen coins with data:", out.unseen.coins.join(","), "· spot 2017-2019:", out.spot.coins.join(","));
for (const [k, tps] of Object.entries(MODES)) {
  const base = trades(BASE, "", Y(2023), END, tps), unseen = trades(out.unseen.coins, "", Y(2020), END, tps), spot = trades(out.spot.coins, "spot_", Y(2017), Y(2020), tps);
  out.base[k] = { all: summary(base), years: byYear(trades(BASE, "", Y(2020), END, tps)), port: port(base, Y(2023), END) };
  out.unseen[k] = { all: summary(unseen), years: byYear(unseen), rows: byCoin(unseen), port: port(unseen, Y(2020), END), evYears: summary(unseen.filter(t => t.entry_time >= Y(2023))) };
  out.spot[k] = { all: summary(spot), years: byYear(spot), rows: byCoin(spot), port: port(spot, Date.UTC(2017, 8, 1), Y(2020)) };
  out.yearly[k] = yearly(simulate(base, Y(2023), END).mv);
  console.log(`\n== ${k} ==`);
  console.log("12 coins 2023-2026 (walk-forward evidence):", JSON.stringify(out.base[k].all), JSON.stringify(out.base[k].port));
  console.log("12 coins per year:", JSON.stringify(out.base[k].years));
  console.log("UNSEEN coins 2020-2026:", JSON.stringify(out.unseen[k].all), "· 2023-2026:", JSON.stringify(out.unseen[k].evYears), "· portfolio", JSON.stringify(out.unseen[k].port));
  console.log("UNSEEN per year:", JSON.stringify(out.unseen[k].years));
  console.log("UNSEEN per coin:", Object.entries(out.unseen[k].rows).map(([c, s]) => `${c.replace("USDT", "")} ${s.n} ${s.avgR}`).join(" · "));
  console.log("SPOT 2017-2019 (before any year used to choose):", JSON.stringify(out.spot[k].all), "· portfolio", JSON.stringify(out.spot[k].port));
  console.log("SPOT per year:", JSON.stringify(out.spot[k].years), "· per coin:", Object.entries(out.spot[k].rows).map(([c, s]) => `${c.replace("USDT", "")} ${s.n} ${s.avgR}`).join(" · "));
  console.log("a year at 0.5% risk (block bootstrap of 2023-2026 months):", JSON.stringify(out.yearly[k]));
  // Open positions cap: the 12 coins tend to move together, so many positions are one bet.
  const train = trades(BASE, "", Y(2020), Y(2023), tps), rows = [0, 8, 6, 4].map(K => ({ max: K || null, train: port(train, Y(2020), Y(2023), K), test: port(base, Y(2023), END, K) }));
  rows.forEach(x => console.log(`  max open ${String(x.max || "none").padEnd(4)} train ${JSON.stringify(x.train)} test ${JSON.stringify(x.test)}`));
  const pick = rows.slice().sort((a, b) => (b.train.mar || 0) - (a.train.mar || 0))[0];
  out.heat[k] = { rows, chosen: pick.max, chosen_on: [2020, 2021, 2022] };
  console.log(`  open-positions cap chosen on 2020-2022: ${pick.max || "none"}`);
}
fs.writeFileSync("robust.json", JSON.stringify(out, null, 1) + "\n");
console.log("ROBUST=" + JSON.stringify(out));
