// Professional-style evaluation of trend-following rules on 12 USD-M perpetuals, 2020-01..2026-09.
// Walk-forward: for each test year Y (2022..2026) the parameter set is chosen ONLY on trades that entered
// before Y (expanding window, best t-stat of R with >= 60 trades); trades entered in Y with that set are
// out of sample. Two classic Turtle systems are also reported with no selection at all.
// Execution: signal on a closed bar, entry/exit at the next open, stops checked inside the bar (gaps fill at
// the open), one position per coin. Costs: 0.05% fee + 0.02% slippage per side, funding 0.01%/8h always paid.
// Usage: node pro.js COINS   (bars from ../evidence/bars/<COIN>_<TF>.json)
const fs = require("fs");
const COINS = process.argv[2].split(",");
const FEE = 0.0005, SLIP = 0.0002, FUNDING = 0.0001, H = 3600000;
const YEARS = [2022, 2023, 2024, 2025, 2026];
const ms = y => Date.UTC(y, 0, 1);

function load(c, tf) {
  const p = `../evidence/bars/${c}_${tf}.json`;
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], ct: r[6] }));
}
function ema(xs, n) { const a = 2 / (n + 1); let y = NaN; return xs.map((x, i) => (y = i ? y + a * (x - y) : x)); }
function atr(b, n) {
  let a = NaN; return b.map((x, i) => {
    const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l;
    return (a = i < n ? (i ? (a * i + tr) / (i + 1) : tr) : a + (tr - a) / n);
  });
}
function rollMax(xs, n, i) { let m = -Infinity; for (let k = i - n; k < i; k++) m = Math.max(m, xs[k]); return m; }
function rollMin(xs, n, i) { let m = Infinity; for (let k = i - n; k < i; k++) m = Math.min(m, xs[k]); return m; }

// P: {fam:"donchian"|"ema", n, m, k, trend, fast, slow}
function backtest(b, P, coin) {
  const n = b.length, A = atr(b, 20), C = b.map(x => x.c), Hh = b.map(x => x.h), Ll = b.map(x => x.l);
  const e200 = ema(C, 200), ef = P.fam === "ema" ? ema(C, P.fast) : null, es = P.fam === "ema" ? ema(C, P.slow) : null;
  const warm = Math.max(210, (P.n || 0) + 2, (P.slow || 0) + 2), out = [];
  let pos = null, pend = null;
  const close = (i, px) => {
    const risk = pos.risk, hours = (b[i].t - pos.t) / H;
    const r = pos.dir * (px - pos.entry) / risk - (2 * (FEE + SLIP) * pos.entry + FUNDING * pos.entry * hours / 8) / risk;
    out.push({ coin, t: pos.t, tx: b[i].t, dir: pos.dir, r }); pos = null;
  };
  for (let i = warm; i < n; i++) {
    const x = b[i];
    if (pend) {                                   // decided at the previous close, executed at this open
      if (pend.exit && pos) close(i, x.o * (1 - pos.dir * SLIP));
      if (pend.dir && !pos) {
        const entry = x.o * (1 + pend.dir * SLIP), risk = P.k * A[i - 1];
        if (risk > 0 && risk / entry >= 0.002) pos = { dir: pend.dir, entry, risk, stop: entry - pend.dir * risk, t: x.t, best: entry };
      }
      pend = null;
    }
    if (pos) {                                    // protective stop inside the bar
      const d = pos.dir;
      if (d > 0 ? x.o <= pos.stop : x.o >= pos.stop) { close(i, x.o); continue; }
      if (d > 0 ? x.l <= pos.stop : x.h >= pos.stop) { close(i, pos.stop); continue; }
    }
    if (i + 1 >= n) break;
    if (pos) {                                    // exits and trailing, decided on the close
      const d = pos.dir;
      if (P.fam === "donchian") {
        if (d > 0 ? x.c < rollMin(Ll, P.m, i) : x.c > rollMax(Hh, P.m, i)) pend = { exit: true };
      } else {
        pos.best = d > 0 ? Math.max(pos.best, x.c) : Math.min(pos.best, x.c);
        const trail = pos.best - d * P.k * A[i];
        if (d > 0 ? trail > pos.stop : trail < pos.stop) pos.stop = trail;
        if (d > 0 ? ef[i] < es[i] : ef[i] > es[i]) pend = { exit: true };
      }
      continue;
    }
    let dir = 0;
    if (P.fam === "donchian") {
      if (x.c > rollMax(Hh, P.n, i)) dir = 1; else if (x.c < rollMin(Ll, P.n, i)) dir = -1;
    } else {
      if (ef[i] > es[i] && ef[i - 1] <= es[i - 1]) dir = 1; else if (ef[i] < es[i] && ef[i - 1] >= es[i - 1]) dir = -1;
    }
    if (dir && P.trend && (dir > 0 ? x.c < e200[i] : x.c > e200[i])) dir = 0;
    if (dir) pend = { dir };
  }
  if (pos) close(n - 1, b[n - 1].c);
  return out;
}

function stats(tr) {
  const n = tr.length; if (!n) return { n: 0 };
  const s = tr.reduce((a, t) => a + t.r, 0), m = s / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1));
  const gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0), w = tr.filter(t => t.r > 0).length;
  return { n, avgR: +m.toFixed(3), t: +(m / (sd / Math.sqrt(n))).toFixed(2), pf: gl ? +(gp / gl).toFixed(2) : null, win: +(100 * w / n).toFixed(1), sumR: +s.toFixed(1) };
}
// Portfolio: each trade risks `risk` of equity at its entry; P&L booked at exit (concurrent positions allowed).
function portfolio(tr, risk, from, to) {
  const ev = tr.filter(t => t.t >= from && t.t < to).slice().sort((a, b) => a.tx - b.tx);
  let eq = 1, peak = 1, dd = 0; const months = {};
  for (const t of ev) {
    const before = eq; eq *= 1 + risk * t.r; if (eq < 0.01) eq = 0.01;
    peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
    const k = new Date(t.tx).toISOString().slice(0, 7); months[k] = (months[k] || 1) * (eq / before);
  }
  const yrs = (to - from) / (365.25 * 24 * H), mv = Object.values(months);
  return { trades: ev.length, total: +(100 * (eq - 1)).toFixed(1), cagr: +(100 * (Math.pow(eq, 1 / yrs) - 1)).toFixed(1), maxDD: +(100 * dd).toFixed(1),
    worstMonth: mv.length ? +(100 * (Math.min(...mv) - 1)).toFixed(1) : null, posMonths: mv.length ? +(100 * mv.filter(v => v > 1).length / mv.length).toFixed(0) : null };
}

const grid = [];
for (const tf of ["4h", "1d"]) {
  for (const n of [20, 55]) for (const m of [10, 20]) for (const k of [2, 3]) for (const trend of [false, true])
    grid.push({ fam: "donchian", tf, n, m, k, trend });
  for (const [fast, slow] of [[20, 100], [50, 200]]) for (const k of [3, 4]) for (const trend of [false])
    grid.push({ fam: "ema", tf, fast, slow, k, trend });
}
const label = P => P.fam === "donchian" ? `Donchian ${P.tf} ${P.n}/${P.m} stop ${P.k}ATR${P.trend ? " +EMA200" : ""}` : `EMA ${P.tf} ${P.fast}/${P.slow} trail ${P.k}ATR`;
const data = {};
for (const tf of ["4h", "1d"]) for (const c of COINS) data[c + tf] = load(c, tf);
const runs = grid.map(P => {
  let tr = [];
  for (const c of COINS) if (data[c + P.tf]) tr = tr.concat(backtest(data[c + P.tf], P, c));
  return { P, tr };
});

// Walk-forward selection.
let oos = [];
console.log("== WALK-FORWARD (choose on years before, trade the year) ==");
for (const Y of YEARS) {
  const scored = runs.map(r => ({ r, s: stats(r.tr.filter(t => t.t < ms(Y))) })).filter(x => x.s.n >= 60).sort((a, b) => b.s.t - a.s.t);
  const pick = scored[0], test = pick.r.tr.filter(t => t.t >= ms(Y) && t.t < ms(Y + 1));
  oos = oos.concat(test);
  console.log(`${Y}: chose ${label(pick.r.P)} (train n=${pick.s.n} avgR ${pick.s.avgR} t ${pick.s.t}) -> ${Y} ${JSON.stringify(stats(test))}`);
}
const from = ms(2022), to = Date.UTC(2026, 9, 1);
console.log("WALK-FORWARD OOS 2022-01..2026-09:", JSON.stringify(stats(oos)));
for (const risk of [0.0025, 0.005, 0.01]) console.log(`  portfolio risk ${risk * 100}%/trade:`, JSON.stringify(portfolio(oos, risk, from, to)));

// Classic Turtle systems, no selection (daily bars, 2N stop, as published).
console.log("\n== CLASSIC TURTLE, NO SELECTION ==");
for (const P of [{ fam: "donchian", tf: "1d", n: 20, m: 10, k: 2, trend: false }, { fam: "donchian", tf: "1d", n: 55, m: 20, k: 2, trend: false }]) {
  const r = runs.find(x => JSON.stringify(x.P) === JSON.stringify(P));
  console.log(label(P), "2022-2026:", JSON.stringify(stats(r.tr.filter(t => t.t >= from))));
  for (const Y of YEARS) console.log(`   ${Y}:`, JSON.stringify(stats(r.tr.filter(t => t.t >= ms(Y) && t.t < ms(Y + 1)))));
  for (const risk of [0.005, 0.01]) console.log(`   portfolio risk ${risk * 100}%:`, JSON.stringify(portfolio(r.tr, risk, from, to)));
}

console.log("\n== ALL VARIANTS 2022-2026 (for reference only; not used to choose) ==");
for (const r of runs) console.log(label(r.P).padEnd(40), JSON.stringify(stats(r.tr.filter(t => t.t >= from))));
console.log("\nper coin (walk-forward OOS):", COINS.map(c => { const s = stats(oos.filter(t => t.coin === c)); return `${c.replace("USDT", "")} ${s.n} ${s.avgR}`; }).join(" · "));
