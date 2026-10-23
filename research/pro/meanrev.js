// A second rule with a higher win rate, to pair with Trend 4H: mean reversion inside the trend (buy a dip above EMA200,
// sell a rally below it), long and short, on 12 USD-M perpetuals. Same discipline as pro.js:
//  - candidates listed before the run (below), each traded on 4h and 1d bars;
//  - walk-forward: each year 2022..2026 the candidate with the best t-statistic on the years before it is traded that
//    year only; those trades are the evidence;
//  - the same yearly picks on 25 coins never used to choose, fees and slippage doubled;
//  - monthly returns against Trend 4H (web/trend.js, the app's scale-out plan) and the two together.
// Execution as the app: signal on a closed bar, fill at the next open with slippage, stop inside the bar (a gap fills at
// the open), exit on a close at the next open, at most MAXH bars held; fee 0.05% + slippage 0.02% per side, funding
// 0.01%/8h always paid. Usage: node meanrev.js COINS UNSEEN_COINS   (bars from ../evidence/bars)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [COINS, UNSEEN] = process.argv.slice(2, 4).map(x => x.split(","));
const H = 3600000, RISK = 0.005, MMR_SAFE = 0.01, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1), YEARS = [2022, 2023, 2024, 2025, 2026];
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const load = (c, tf) => {
  const p = `../evidence/bars/${c}_${tf}.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], ct: r[6] })) : null;
};
const ema = (xs, n) => { const a = 2 / (n + 1); let y = NaN; return xs.map((x, i) => (y = i ? y + a * (x - y) : x)); };
const sma = (xs, n) => xs.map((x, i) => { if (i < n - 1) return NaN; let s = 0; for (let k = i - n + 1; k <= i; k++) s += xs[k]; return s / n; });
const sd = (xs, n) => { const m = sma(xs, n); return xs.map((x, i) => { if (i < n - 1) return NaN; let s = 0; for (let k = i - n + 1; k <= i; k++) s += (xs[k] - m[i]) ** 2; return Math.sqrt(s / n); }); };
const atr = (b, n) => { let a = NaN; return b.map((x, i) => { const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l; return (a = i < n ? (i ? (a * i + tr) / (i + 1) : tr) : a + (tr - a) / n); }); };
const rsi = (xs, n) => {
  let g = 0, l = 0; return xs.map((x, i) => {
    if (!i) return NaN; const d = x - xs[i - 1], up = Math.max(0, d), dn = Math.max(0, -d);
    if (i <= n) { g += up / n; l += dn / n; return i < n ? NaN : (l === 0 ? 100 : 100 - 100 / (1 + g / l)); }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  });
};
// P: {fam: "rsi2"|"bb", tf, thr, exit: "sma5"|"rsi70", k}
function backtest(b, P, coin, cost) {
  const fee = cost.fee, slip = cost.slip, fund = cost.fund, C = b.map(x => x.c), A = atr(b, 20), E = ema(C, 200);
  const R2 = rsi(C, 2), S5 = sma(C, 5), M20 = sma(C, 20), D20 = sd(C, 20), MAXH = P.tf === "4h" ? 30 : 10, out = [];
  let pos = null, pend = null;
  const close = (i, px, why) => {
    const hours = (b[i].t - pos.t) / H;
    out.push({ coin, t: pos.t, tx: Math.max(b[i].t, pos.t + 1), dir: pos.dir, why,
      r: pos.dir * (px - pos.entry) / pos.risk - (2 * (fee + slip) * pos.entry + fund * pos.entry * hours / 8) / pos.risk, lev: Math.floor(1 / (1.5 * pos.risk / pos.entry + MMR_SAFE)) });
    pos = null;
  };
  for (let i = 210; i < b.length; i++) {
    const x = b[i];
    if (pend) {
      if (pend.exit && pos) close(i, x.o * (1 - pos.dir * slip), "exit");
      if (pend.dir && !pos) {
        const entry = x.o * (1 + pend.dir * slip), risk = P.k * A[i - 1];
        if (risk / entry >= 0.002) pos = { dir: pend.dir, entry, risk, stop: entry - pend.dir * risk, t: x.t, i };
      }
      pend = null;
    }
    if (pos) {
      if (pos.dir > 0 ? x.o <= pos.stop : x.o >= pos.stop) { close(i, x.o, "stop"); continue; }
      if (pos.dir > 0 ? x.l <= pos.stop : x.h >= pos.stop) { close(i, pos.stop, "stop"); continue; }
    }
    if (i + 1 >= b.length) break;
    if (pos) {
      const d = pos.dir, back = P.exit === "sma5" ? (d > 0 ? x.c > S5[i] : x.c < S5[i]) : P.exit === "rsi70" ? (d > 0 ? R2[i] > 70 : R2[i] < 30) : (d > 0 ? x.c > M20[i] : x.c < M20[i]);
      if (back || i - pos.i >= MAXH) pend = { exit: true };
      continue;
    }
    let dir = 0;
    if (P.fam === "rsi2") { if (x.c > E[i] && R2[i] < P.thr) dir = 1; else if (x.c < E[i] && R2[i] > 100 - P.thr) dir = -1; }
    else { if (x.c > E[i] && x.c < M20[i] - 2 * D20[i]) dir = 1; else if (x.c < E[i] && x.c > M20[i] + 2 * D20[i]) dir = -1; }
    if (dir) pend = { dir };
  }
  return out;
}
const stats = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, s = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = s / Math.sqrt(n);
  const gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0), w = tr.filter(t => t.r > 0).length;
  return { n, win: +(100 * w / n).toFixed(1), avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)], pf: gl ? +(gp / gl).toFixed(2) : null, t: +(m / se).toFixed(2) };
};
// Monthly growth factors at RISK per trade (stake from equity at entry, P&L at exit), from..to.
const months = (tr, from, to, risk) => {
  const ev = [], stake = {}, mv = {}; let eq = 1;
  tr.forEach((t, i) => { ev.push({ time: t.t, k: 1, i }); ev.push({ time: t.tx, k: 0, i, r: t.r }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  for (const e of ev) {
    if (e.k === 1) stake[e.i] = eq * risk;
    else if (stake[e.i] !== undefined) { const before = eq; eq = Math.max(0.01, eq + stake[e.i] * e.r); const m = new Date(e.time).toISOString().slice(0, 7); mv[m] = (mv[m] || 1) * eq / before; }
  }
  const list = [];
  for (let d = new Date(from); d.getTime() < to; d.setUTCMonth(d.getUTCMonth() + 1)) list.push(mv[d.toISOString().slice(0, 7)] || 1);
  return list;
};
const portOf = (mv, from, to) => {
  let eq = 1, peak = 1, dd = 0; mv.forEach(v => { eq *= v; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); });
  return { cagr: +(100 * (Math.pow(eq, 1 / ((to - from) / (365.25 * 24 * H))) - 1)).toFixed(1), maxDD: +(100 * dd).toFixed(1), losingMonths: +(100 * mv.filter(v => v < 1).length / mv.length).toFixed(0) };
};
const corr = (a, b) => { const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return +(s / Math.sqrt(sa * sb)).toFixed(2); };

const grid = [];
for (const tf of ["4h", "1d"]) {
  for (const thr of [5, 10]) for (const exit of ["sma5", "rsi70"]) for (const k of [2, 3]) grid.push({ fam: "rsi2", tf, thr, exit, k });
  for (const k of [2, 3]) grid.push({ fam: "bb", tf, exit: "mid", k });
}
const label = P => P.fam === "rsi2" ? `RSI2<${P.thr} ${P.tf} exit ${P.exit} stop ${P.k}ATR` : `BB(20,2) ${P.tf} exit mid stop ${P.k}ATR`;
const NORMAL = { fee: 0.0005, slip: 0.0002, fund: 0.0001 }, DOUBLE = { fee: 0.001, slip: 0.0004, fund: 0.0002 };
const run = (coins, P, cost) => [].concat(...coins.map(c => { const b = load(c, P.tf); return b ? backtest(b, P, c, cost).filter(t => t.lev >= 5) : []; }));
const runs = grid.map(P => ({ P, tr: run(COINS, P, NORMAL) }));
const out = { generated: new Date().toISOString().slice(0, 10), candidates: grid.map(label), picks: [], years: {} };
let oos = [], oosUnseen = [], oos2x = [];
console.log("== WALK-FORWARD (choose on years before, trade the year) ==");
for (const Yr of YEARS) {
  const scored = runs.map(r => ({ r, s: stats(r.tr.filter(t => t.t < Y(Yr))) })).filter(x => x.s.n >= 60).sort((a, b) => b.s.t - a.s.t);
  const pick = scored[0], inYear = t => t.t >= Y(Yr) && t.t < Math.min(Y(Yr + 1), END);
  const test = pick.r.tr.filter(inYear);
  oos = oos.concat(test);
  oosUnseen = oosUnseen.concat(run(UNSEEN, pick.r.P, NORMAL).filter(inYear));
  oos2x = oos2x.concat(run(COINS, pick.r.P, DOUBLE).filter(inYear));
  out.picks.push({ year: Yr, rule: label(pick.r.P), train: pick.s });
  out.years[Yr] = stats(test);
  console.log(`${Yr}: ${label(pick.r.P)} (train n=${pick.s.n} avgR ${pick.s.avgR} t ${pick.s.t}) -> ${JSON.stringify(stats(test))}`);
}
const ev = t => t.t >= Y(2023);
out.oos = stats(oos.filter(ev)); out.oos2022 = stats(oos.filter(t => !ev(t)));
out.unseen = stats(oosUnseen.filter(ev)); out.costs2x = stats(oos2x.filter(ev));
console.log("OOS 2023-2026:", JSON.stringify(out.oos), "· unseen coins:", JSON.stringify(out.unseen), "· costs x2:", JSON.stringify(out.costs2x));
// Trend 4H (the app's rule and scale-out plan) on the same coins and years, and the pair.
const trend = [].concat(...COINS.map(c => {
  const b = load(c, "4h"); if (!b) return [];
  return Trend.run(b.map(x => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, close_time: x.ct })), { tps: LADDER }).trades
    .filter(t => t.entry_time >= Y(2023) && t.entry_time < END && Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)) >= 5)
    .map(t => ({ t: t.entry_time, tx: Math.max(t.exit_time, t.entry_time + 1), r: t.r }));
}));
const mvT = months(trend, Y(2023), END, RISK), mvM = months(oos.filter(ev), Y(2023), END, RISK);
const mvHalf = mvT.map((v, i) => (1 + (v - 1) / 2) * (1 + (mvM[i] - 1) / 2));
out.pair = { corr: corr(mvT, mvM), trend: portOf(mvT, Y(2023), END), meanrev: portOf(mvM, Y(2023), END),
  both_half_risk: portOf(mvHalf, Y(2023), END), both_full_risk: portOf(mvT.map((v, i) => v * mvM[i]), Y(2023), END) };
console.log("monthly correlation with Trend 4H:", out.pair.corr, "· portfolios (0.5% risk):", JSON.stringify(out.pair));
fs.writeFileSync("meanrev.json", JSON.stringify(out, null, 1) + "\n");
console.log("MEANREV=" + JSON.stringify(out));
