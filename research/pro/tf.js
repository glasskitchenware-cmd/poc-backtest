// Signals more often than every 4 hours: does the Trend rule family (Donchian breakout on the side of EMA200, ATR stop,
// channel exit; web/trend.js) make money on 15m, 30m, 1h or 2h bars? Everything below is fixed before the run.
//  - Candidates per timeframe: entry channel 20 or 55 bars, exit channel 10 or 20 bars, stop 2 or 3 ATR (8 rules).
//  - Walk-forward on the 12 coins: each year 2023..2026 the rule with the best t-statistic on 2020..the year before is
//    traded that year; those trades are the evidence (as research/pro chose Trend 4H).
//  - A timeframe counts as profitable only if (a) its 2023-2026 walk-forward average R is above zero with the 95% range
//    above zero, (b) the same yearly picks on the 25 coins never used to choose anything are too, and (c) with fees and
//    slippage doubled the 12-coin average stays above zero.
//  - It is added beside Trend 4H only if, in addition, the two together at 0.5% risk per trade beat Trend 4H alone on
//    2023-2026 in CAGR / max drawdown (MAR).
// Costs, fills and the leverage filter as the app; no take profit (the rule). 30m, 1h and 2h bars are built from 15m.
// Usage: node tf.js BASE_COINS UNSEEN_COINS   (15m and 4h bars from ../evidence/bars)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [BASE, UNSEEN] = process.argv.slice(2, 4).map(x => x.split(","));
const H = 3600000, MMR_SAFE = 0.01, RISK = 0.005, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1), YEARS = [2023, 2024, 2025, 2026];
const TFS = { "15m": 1, "30m": 2, "1h": 4, "2h": 8 };
const CANDS = [];
for (const n of [20, 55]) for (const m of [10, 20]) for (const k of [2, 3]) CANDS.push({ id: `D${n}/${m} ${k}ATR`, n, m, k });
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const load = (c, tf) => {
  const p = `../evidence/bars/${c}_${tf}.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], close_time: r[6] })) : null;
};
// k consecutive 15m bars -> one bar, aligned to the bigger bar's open (a bar missing a piece is dropped).
function resample(b, k) {
  if (k === 1) return b;
  const ms = 15 * 60000 * k, out = [];
  let cur = null, cnt = 0;
  for (const x of b) {
    const t = Math.floor(x.time / ms) * ms;
    if (!cur || cur.time !== t) { if (cur && cnt === k) out.push(cur); cur = { time: t, open: x.open, high: x.high, low: x.low, close: x.close, close_time: t + ms - 1 }; cnt = 1; }
    else { cur.high = Math.max(cur.high, x.high); cur.low = Math.min(cur.low, x.low); cur.close = x.close; cnt++; }
  }
  if (cur && cnt === k) out.push(cur);
  return out;
}
const summary = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  const w = tr.filter(t => t.r > 0).length, gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
  return { n, win: +(100 * w / n).toFixed(1), avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)], pf: gl ? +(gp / gl).toFixed(2) : null, t: +(m / se).toFixed(2),
    holdH: +(tr.reduce((a, t) => a + (t.exit_time - t.entry_time), 0) / n / H).toFixed(1) };
};
function port(tr, from, to) {
  const ev = [], stake = {};
  tr.forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, i }); ev.push({ time: Math.max(t.exit_time, t.entry_time + 1), k: 0, i, r: t.r }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  let eq = 1, peak = 1, dd = 0;
  for (const e of ev) {
    if (e.k === 1) stake[e.i] = eq * RISK;
    else { eq = Math.max(0.01, eq + stake[e.i] * e.r); peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  }
  const yrs = (to - from) / (365.25 * 24 * H), cagr = 100 * (Math.pow(eq, 1 / yrs) - 1);
  return { cagr: +cagr.toFixed(1), maxDD: +(100 * dd).toFixed(1), mar: dd > 0 ? +(cagr / (100 * dd)).toFixed(2) : null, perDay: +(tr.length / (yrs * 365.25)).toFixed(1) };
}
const year = t => new Date(t.entry_time).getUTCFullYear();
const unseen = UNSEEN.filter(c => fs.existsSync(`../evidence/bars/${c}_15m.json`));
console.log("12 coins with 15m bars:", BASE.filter(c => fs.existsSync(`../evidence/bars/${c}_15m.json`)).length, "· unseen:", unseen.length);
// Every candidate's trades on every coin, one coin at a time (15m history is large), costs as the app and doubled.
const T = {};   // T[tf][cand][group][costs] = trades
for (const tf of Object.keys(TFS)) { T[tf] = {}; CANDS.forEach(C => { T[tf][C.id] = { base: { x1: [], x2: [] }, unseen: { x1: [], x2: [] } }; }); }
for (const [group, coins] of [["base", BASE], ["unseen", unseen]]) {
  for (const c of coins) {
    const raw = load(c, "15m");
    if (!raw) continue;
    for (const [tf, k] of Object.entries(TFS)) {
      const b = resample(raw, k);
      for (const C of CANDS) for (const [cx, mult] of [["x1", 1], ["x2", 2]]) {
        const opt = { n: C.n, m: C.m, k: C.k, fee: Trend.DEFAULTS.fee * mult, slippage: Trend.DEFAULTS.slippage * mult, funding: Trend.DEFAULTS.funding * mult };
        if (cx === "x2" && group === "unseen") continue;
        for (const t of Trend.run(b, opt).trades) if (t.entry_time >= Y(2020) && t.entry_time < END && levLiq(t) >= 5)
          T[tf][C.id][group][cx].push({ coin: c, r: t.r, dir: t.dir, entry_time: t.entry_time, exit_time: t.exit_time });
      }
    }
    console.log("done", group, c);
  }
}
// The app's rule on 4h for the combination check.
const trend4h = [].concat(...BASE.map(c => { const b = load(c, "4h"); return b ? Trend.run(b, {}).trades.filter(t => t.entry_time >= Y(2023) && t.entry_time < END && levLiq(t) >= 5) : []; }));
const out = { generated: new Date().toISOString().slice(0, 10), risk: RISK * 100, candidates: CANDS.map(C => C.id), trend4h: Object.assign(summary(trend4h), { port: port(trend4h, Y(2023), END) }), tfs: {} };
for (const tf of Object.keys(TFS)) {
  const picks = [], ev = [], evUnseen = [], evX2 = [];
  for (const y of YEARS) {
    const scored = CANDS.map(C => ({ C, s: summary(T[tf][C.id].base.x1.filter(t => year(t) < y)) })).sort((a, b) => (b.s.t || -99) - (a.s.t || -99));
    const C = scored[0].C;
    picks.push({ year: y, rule: C.id, train: scored[0].s });
    ev.push(...T[tf][C.id].base.x1.filter(t => year(t) === y));
    evUnseen.push(...T[tf][C.id].unseen.x1.filter(t => year(t) === y));
    evX2.push(...T[tf][C.id].base.x2.filter(t => year(t) === y));
  }
  const s = summary(ev), su = summary(evUnseen), s2 = summary(evX2);
  const checks = { evidence: s.n > 0 && s.avgRCI[0] > 0, unseen: su.n > 0 && su.avgRCI[0] > 0, costs2x: s2.n > 0 && s2.avgR > 0 };
  const both = port(trend4h.concat(ev), Y(2023), END);
  out.tfs[tf] = { picks, evidence: Object.assign(s, { port: port(ev, Y(2023), END) }), unseen: su, costs2x: s2, checks, profitable: Object.values(checks).every(Boolean),
    with4h: both, addBeside4h: Object.values(checks).every(Boolean) && both.mar > out.trend4h.port.mar,
    years: YEARS.reduce((o, y) => (o[y] = summary(ev.filter(t => year(t) === y)), o), {}) };
  console.log(`\n== ${tf} == picks ${picks.map(p => p.year + ":" + p.rule).join(" · ")}`);
  console.log("  2023-2026 walk-forward:", JSON.stringify(out.tfs[tf].evidence));
  console.log("  unseen coins, same picks:", JSON.stringify(su));
  console.log("  costs x2:", JSON.stringify(s2));
  console.log("  per year:", JSON.stringify(out.tfs[tf].years));
  console.log("  with Trend 4H:", JSON.stringify(both), "· Trend 4H alone:", JSON.stringify(out.trend4h.port));
  console.log("  checks", JSON.stringify(checks), "· profitable", out.tfs[tf].profitable, "· add beside 4h", out.tfs[tf].addBeside4h);
}
fs.writeFileSync("tf.json", JSON.stringify(out, null, 1) + "\n");
console.log("TF=" + JSON.stringify(Object.fromEntries(Object.entries(out.tfs).map(([k, v]) => [k, { avgR: v.evidence.avgR, ci: v.evidence.avgRCI, unseen: v.unseen.avgR, x2: v.costs2x.avgR, profitable: v.profitable, add: v.addBeside4h }]))));
