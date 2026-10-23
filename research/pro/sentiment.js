// Does market mood help Trend 4H? The Crypto Fear & Greed Index (alternative.me, daily since 2018, free) is the one news
// and sentiment series with a long enough history to test. Each trade of the app's rule (web/trend.js, 12 coins, the
// app's leverage filter) gets the index value published before its entry (no look-ahead).
//  1. What happened by mood: average R of LONG and SHORT trades by index band, 2020-2026.
//  2. Filters listed before the run, chosen on 2020-2022 by the t-statistic of the average trade, reported on 2023-2026
//     with the scale-out plan the app uses, and as a portfolio at 0.5% risk.
// Usage: node sentiment.js COINS   (bars from ../evidence/bars, index from ../evidence/fng.json)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const COINS = process.argv[2].split(",");
const H = 3600000, MMR_SAFE = 0.01, RISK = 0.005, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1);
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const fng = JSON.parse(fs.readFileSync("../evidence/fng.json", "utf8")).data
  .map(d => ({ t: +d.timestamp * 1000, v: +d.value })).sort((a, b) => a.t - b.t);
console.log("Fear & Greed:", fng.length, "days,", new Date(fng[0].t).toISOString().slice(0, 10), "..", new Date(fng[fng.length - 1].t).toISOString().slice(0, 10));
// The latest value published before time t, and the one seven days earlier.
function moodAt(t) {
  let lo = 0, hi = fng.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fng[m].t <= t - 60000) { k = m; lo = m + 1; } else hi = m - 1; }
  return k < 7 ? null : { v: fng[k].v, prev7: fng[k - 7].v };
}
const summary = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  const w = tr.filter(t => t.r > 0).length;
  return { n, win: +(100 * w / n).toFixed(1), avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)], sumR: +(m * n).toFixed(1), t: +(m / se).toFixed(2) };
};
const port = (tr, from, to) => {
  const ev = [], stake = {}; let eq = 1, peak = 1, dd = 0;
  // A trade stopped in the bar it entered exits at its entry time: book the exit just after the entry, so it counts.
  tr.forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, i }); ev.push({ time: Math.max(t.exit_time, t.entry_time + 1), k: 0, i, r: t.r }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  for (const e of ev) {
    if (e.k === 1) stake[e.i] = eq * RISK;
    else { eq = Math.max(0.01, eq + stake[e.i] * e.r); peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  }
  const cagr = 100 * (Math.pow(eq, 1 / ((to - from) / (365.25 * 24 * H))) - 1);
  return { cagr: +cagr.toFixed(1), maxDD: +(100 * dd).toFixed(1) };
};
const out = { generated: new Date().toISOString().slice(0, 10), source: "alternative.me Crypto Fear & Greed Index (daily)", days: fng.length, modes: {} };
const FILTERS = [
  { id: "none", name: "ไม่กรอง (เข้าทุกสัญญาณ)", keep: () => true },
  { id: "align50", name: "LONG เมื่อดัชนี ≥ 50 · SHORT เมื่อ ≤ 50 (ตามอารมณ์ตลาด)", keep: (t, m) => t.dir > 0 ? m.v >= 50 : m.v <= 50 },
  { id: "contra", name: "ไม่ LONG ตอนโลภสุดขีด (≥ 75) · ไม่ SHORT ตอนกลัวสุดขีด (≤ 25)", keep: (t, m) => t.dir > 0 ? m.v < 75 : m.v > 25 },
  { id: "extreme", name: "ไม่เข้าเลยตอนสุดขีด (≤ 20 หรือ ≥ 80)", keep: (t, m) => m.v > 20 && m.v < 80 },
  { id: "trend7", name: "LONG เมื่อดัชนีขึ้นใน 7 วัน · SHORT เมื่อลง", keep: (t, m) => t.dir > 0 ? m.v >= m.prev7 : m.v <= m.prev7 }
];
const BANDS = [[0, 25, "กลัวสุดขีด 0-24"], [25, 45, "กลัว 25-44"], [45, 56, "กลาง 45-55"], [56, 76, "โลภ 56-75"], [76, 101, "โลภสุดขีด 76-100"]];
for (const [mode, tps] of Object.entries({ ladder: LADDER, rule: null })) {
  const all = [];
  for (const c of COINS) {
    const p = `../evidence/bars/${c}_4h.json`;
    if (!fs.existsSync(p)) continue;
    const bars = JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], close_time: r[6] }));
    for (const t of Trend.run(bars, { tps }).trades) {
      const m = moodAt(t.entry_time);
      if (m && levLiq(t) >= 5 && t.entry_time >= Y(2020) && t.entry_time < END) all.push(Object.assign({ coin: c, mood: m }, t));
    }
  }
  const train = all.filter(t => t.entry_time < Y(2023)), test = all.filter(t => t.entry_time >= Y(2023));
  const bands = {};
  for (const [lo, hi, name] of BANDS) for (const d of [1, -1]) bands[(d > 0 ? "LONG " : "SHORT ") + name] = summary(all.filter(t => t.dir === d && t.mood.v >= lo && t.mood.v < hi));
  const rows = FILTERS.map(F => {
    const tr = train.filter(t => F.keep(t, t.mood)), te = test.filter(t => F.keep(t, t.mood));
    return { id: F.id, name: F.name, train: summary(tr), test: summary(te), port: port(te, Y(2023), END) };
  });
  const chosen = rows.slice().sort((a, b) => (b.train.t || 0) - (a.train.t || 0))[0];
  out.modes[mode] = { bands, rows, chosen: chosen.id, chosen_on: [2020, 2021, 2022] };
  console.log(`\n== ${mode} ==`);
  Object.entries(bands).forEach(([k, v]) => console.log(`  ${k.padEnd(26)} ${JSON.stringify(v)}`));
  rows.forEach(x => console.log(`  ${x.id.padEnd(8)} train ${JSON.stringify(x.train)}  test ${JSON.stringify(x.test)}  port ${JSON.stringify(x.port)}`));
  console.log(`  chosen on 2020-2022: ${chosen.id} · its 2023-2026 avgR ${chosen.test.avgR} vs none ${rows[0].test.avgR}`);
}
fs.writeFileSync("sentiment.json", JSON.stringify(out, null, 1) + "\n");
console.log("SENTIMENT=" + JSON.stringify(out));
