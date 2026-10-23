// Professional-style evaluation of trend-following rules on 12 USD-M perpetuals, 2020-01..2026-09.
// Walk-forward: for each test year Y (2022..2026) the parameter set is chosen ONLY on trades that entered
// before Y (expanding window, best t-stat of R with >= 60 trades); trades entered in Y with that set are
// out of sample. Two classic Turtle systems are also reported with no selection at all.
// Execution: signal on a closed bar, entry/exit at the next open, stops checked inside the bar (gaps fill at
// the open), one position per coin. Costs: 0.05% fee + 0.02% slippage per side, funding 0.01%/8h always paid.
// Usage: node pro.js COINS   (bars from ../evidence/bars/<COIN>_<TF>.json)
// The last section checks the app's copy of the chosen rule (web/trend.js) against this file; see qc().
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
const picks = [];
console.log("== WALK-FORWARD (choose on years before, trade the year) ==");
for (const Y of YEARS) {
  const scored = runs.map(r => ({ r, s: stats(r.tr.filter(t => t.t < ms(Y))) })).filter(x => x.s.n >= 60).sort((a, b) => b.s.t - a.s.t);
  const pick = scored[0], test = pick.r.tr.filter(t => t.t >= ms(Y) && t.t < ms(Y + 1));
  oos = oos.concat(test);
  picks.push({ Y, P: pick.r.P });
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

// ---- QC of the rule the app trades: web/trend.js, Donchian 4h 20/10, stop 3 ATR, EMA200 filter ----
// 1. Parity: web/trend.js and backtest() above give identical trades on the full history.
// 2. Live replay: at sampled closed bars, the app's live call on the 1,500 bars it downloads (250 days) returns
//    the same decision (enter / exit / nothing) and the same open position as the full-history backtest.
// 3. Evidence for the years in which the walk-forward chose this rule, with the app's own filter (a signal is
//    not sent when the stop is too wide for 5x after the liquidation buffer), costs x2, open positions at once,
//    stop distance -> leverage, and portfolio results by risk per trade. Ends with one JSON line for the app.
(function qc() {
  const Trend = require("../../web/trend.js");
  const CHOSEN = { fam: "donchian", tf: "4h", n: 20, m: 10, k: 3, trend: true }, W = 1500, MMR_SAFE = 0.01;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const app = c => data[c + "4h"].map(x => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c, close_time: x.ct }));
  const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
  const wilson = (k, n) => {
    if (!n) return [null, null];
    const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [+(100 * (c - h)).toFixed(1), +(100 * (c + h)).toFixed(1)];
  };
  const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
  const summary = tr => {
    const n = tr.length; if (!n) return { n: 0 };
    const m = tr.reduce((a, t) => a + t.r, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
    const w = tr.filter(t => t.r > 0).length, big = tr.filter(t => t.r >= 3).length;
    const gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
    return { n, win: +(100 * w / n).toFixed(1), winCI: wilson(w, n), big3: +(100 * big / n).toFixed(1), big3CI: wilson(big, n),
      avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)], pf: gl ? +(gp / gl).toFixed(2) : null,
      t: +(m / se).toFixed(2), holdDays: +(tr.reduce((a, t) => a + (t.exit_time - t.entry_time), 0) / n / 86400000).toFixed(1) };
  };

  console.log("\n== QC: APP RULE (web/trend.js) ==");
  let bad = 0, total = 0;
  const full = {};
  for (const c of COINS) {
    if (!data[c + "4h"]) continue;
    const a = backtest(data[c + "4h"], CHOSEN, c), b = Trend.run(app(c)).trades;
    full[c] = b; total += a.length;
    const diff = a.length !== b.length ? 0 : a.findIndex((t, i) => t.t !== b[i].entry_time || t.tx !== b[i].exit_time || t.dir !== b[i].dir || t.r !== b[i].r);
    if (a.length !== b.length || diff >= 0) { bad++; console.log("PARITY FAIL", c, "trades", a.length, b.length, "first difference", diff); }
  }
  console.log(bad ? `PARITY FAIL on ${bad} coin(s)` : `PARITY OK: web/trend.js = pro.js on ${Object.keys(full).length} coins, ${total} trades, identical entry/exit times, side and R`);

  let checked = 0, decisions = 0, miss = 0;
  for (const c of Object.keys(full)) {
    const bars = app(c), tr = full[c], dec = new Map();
    for (const t of tr) { dec.set(t.entry_index - 1, t.dir); if (t.reason === "exit") dec.set(t.exit_index - 1, "exit"); }
    const ks = new Set([...dec.keys()].filter(k => k >= W - 1 && k < bars.length - 1));
    for (let k = W - 1; k < bars.length - 1; k += 11) ks.add(k);
    for (const k of ks) {
      const res = Trend.run(bars.slice(k - W + 1, k + 1), { live: true });
      const got = res.pend ? (res.pend.exit ? "exit" : res.pend.dir) : 0, want = dec.get(k) || 0;
      const open = tr.find(t => t.entry_index <= k && k < t.exit_index);
      const gotPos = res.pos ? res.pos.entry_time + ":" + res.pos.dir : "", wantPos = open ? open.entry_time + ":" + open.dir : "";
      const stopOk = !open || !res.pos || Math.abs(res.pos.stop - open.stop) <= 1e-9 * open.entry;
      checked++; if (want) decisions++;
      if (got !== want || gotPos !== wantPos || !stopOk) {
        if (++miss <= 10) console.log("REPLAY MISMATCH", c, new Date(bars[k].time).toISOString(), "decision", got, "want", want, "position", gotPos, "want", wantPos);
      }
    }
  }
  console.log(`LIVE REPLAY ${miss ? "FAIL" : "OK"}: ${checked} closed bars checked with a ${W}-bar window (${decisions} of them enter/exit decisions), ${miss} mismatch(es)`);

  let evYears = picks.filter(p => same(p.P, CHOSEN)).map(p => p.Y);
  console.log("walk-forward chose this rule for:", evYears.join(", ") || "no year (evidence below uses 2023-2026 and is NOT walk-forward)");
  if (!evYears.length) evYears = [2023, 2024, 2025, 2026];
  const contiguous = evYears[evYears.length - 1] === 2026 && evYears.every((y, i) => !i || y === evYears[i - 1] + 1);
  const inYears = (t, ys) => ys.indexOf(new Date(t.entry_time).getUTCFullYear()) >= 0;
  const all = [].concat(...Object.keys(full).map(c => full[c].map(t => Object.assign({ coin: c }, t))));
  const ev = all.filter(t => inYears(t, evYears)), evApp = ev.filter(t => levLiq(t) >= 5);
  console.log("evidence years, all trades:", JSON.stringify(summary(ev)));
  console.log("evidence years, app filter (lev >= 5x):", JSON.stringify(summary(evApp)), `· filtered out ${ev.length - evApp.length} (${(100 * (ev.length - evApp.length) / Math.max(1, ev.length)).toFixed(1)}%)`,
    "· those:", JSON.stringify(summary(ev.filter(t => levLiq(t) < 5))));
  const y2022 = all.filter(t => inYears(t, [2022]) && levLiq(t) >= 5);
  console.log("2022 (rule not chosen that year), app filter:", JSON.stringify(summary(y2022)));
  const years = {};
  for (const Y of YEARS) years[Y] = summary(all.filter(t => inYears(t, [Y]) && levLiq(t) >= 5));
  console.log("per year, app filter:", JSON.stringify(years));
  const rows = {};
  for (const c of Object.keys(full)) rows[c] = summary(evApp.filter(t => t.coin === c));
  console.log("per coin, evidence years, app filter:", Object.keys(rows).map(c => `${c.replace("USDT", "")} ${rows[c].n} ${rows[c].avgR}`).join(" · "));

  const stress = [].concat(...Object.keys(full).map(c => Trend.run(app(c), { fee: 0.001, slippage: 0.0004, funding: 0.0002 }).trades))
    .filter(t => inYears(t, evYears) && levLiq(t) >= 5);
  console.log("costs x2 (fee 0.10% + slippage 0.04% per side, funding 0.02%/8h):", JSON.stringify(summary(stress)));

  const stops = evApp.map(t => 100 * t.risk / t.entry), levs = evApp.map(levLiq);
  const capped = cap => +(100 * levs.filter(l => l < cap).length / Math.max(1, levs.length)).toFixed(0);
  const stopInfo = { p10: +pct(stops, 0.1).toFixed(2), p50: +pct(stops, 0.5).toFixed(2), p90: +pct(stops, 0.9).toFixed(2), max: +Math.max(...stops).toFixed(2) };
  const levInfo = { p10: pct(levs, 0.1), p50: pct(levs, 0.5), p90: pct(levs, 0.9), lowered: { 10: capped(10), 20: capped(20), 50: capped(50) } };
  console.log("stop distance % (p10/p50/p90/max):", JSON.stringify(stopInfo), "· leverage allowed by the liquidation buffer:", JSON.stringify(levInfo));

  const from = Date.UTC(Math.min(...evYears), 0, 1), to = Date.UTC(2026, 9, 1), STEP = 4 * H;
  let maxOpen = 0, sumOpen = 0, bars = 0; const counts = [];
  for (let t = from; t < to; t += STEP) {
    const k = evApp.filter(x => x.entry_time <= t && t < x.exit_time).length;
    maxOpen = Math.max(maxOpen, k); sumOpen += k; bars++; counts.push(k);
  }
  const conc = { max: maxOpen, avg: +(sumOpen / bars).toFixed(1), p95: pct(counts, 0.95) };
  console.log("open positions at the same time (12 coins):", JSON.stringify(conc));
  const flat = evApp.map(t => ({ t: t.entry_time, tx: t.exit_time, r: t.r }));
  const port = {};
  for (const risk of [0.0025, 0.005, 0.01]) port[risk * 100] = portfolio(flat, risk, from, to);
  console.log("portfolio (P&L booked at exit, compounding):", JSON.stringify(port));

  // Reach rates on the same trades: how often the best price before any stop bar got to +kR (what a take profit there
  // would have filled), and how often the stop came before +1R.
  const reach = tr => {
    const n = tr.length || 1, o = { n: tr.length };
    for (const k of [1, 2, 3, 5]) o[k] = +(100 * tr.filter(t => t.mfeR >= k).length / n).toFixed(1);
    o.slFirst = +(100 * tr.filter(t => /^stop/.test(t.reason) && t.mfeR < 1).length / n).toFixed(1);
    return o;
  };
  const reachRows = {};
  for (const c of Object.keys(full)) reachRows[c] = reach(evApp.filter(t => t.coin === c));
  console.log("reach (+1R/+2R/+3R/+5R, stop before +1R), evidence years:", JSON.stringify(reach(evApp)));

  // Scale-out plans. Each keeps a runner, so entries and final exits are those of the rule; chosen by average R on
  // 2020-2022 only (before every evidence year), then reported on the evidence years once.
  const LADDERS = [
    { id: "half2", name: "50% ที่ +2R", tps: [{ r: 2, frac: 0.5 }] },
    { id: "half3", name: "50% ที่ +3R", tps: [{ r: 3, frac: 0.5 }] },
    { id: "third12", name: "1/3 ที่ +1R · 1/3 ที่ +2R", tps: [{ r: 1, frac: 1 / 3 }, { r: 2, frac: 1 / 3 }] },
    { id: "third13", name: "1/3 ที่ +1R · 1/3 ที่ +3R", tps: [{ r: 1, frac: 1 / 3 }, { r: 3, frac: 1 / 3 }] },
    { id: "third24", name: "1/3 ที่ +2R · 1/3 ที่ +4R", tps: [{ r: 2, frac: 1 / 3 }, { r: 4, frac: 1 / 3 }] },
    { id: "quarter123", name: "25% ที่ +1R · 25% ที่ +2R · 25% ที่ +3R", tps: [{ r: 1, frac: 0.25 }, { r: 2, frac: 0.25 }, { r: 3, frac: 0.25 }] }
  ];
  const TRAIN = [2020, 2021, 2022];
  const ladderRuns = LADDERS.map(L => {
    const tr = [].concat(...Object.keys(full).map(c => Trend.run(app(c), { tps: L.tps }).trades.map(t => Object.assign({ coin: c }, t)))).filter(t => levLiq(t) >= 5);
    return { L, tr, train: summary(tr.filter(t => inYears(t, TRAIN))), test: summary(tr.filter(t => inYears(t, evYears))) };
  });
  const baseTrain = summary(all.filter(t => inYears(t, TRAIN) && levLiq(t) >= 5));
  console.log("\n== SCALE-OUT (chosen on 2020-2022, tested on " + evYears.join("/") + ") ==");
  console.log("no take profit (the rule)".padEnd(44), "train", JSON.stringify(baseTrain), "test", JSON.stringify(summary(evApp)));
  for (const x of ladderRuns) console.log(x.L.name.padEnd(44), "train", JSON.stringify(x.train), "test", JSON.stringify(x.test));
  const best = ladderRuns.slice().sort((a, b) => b.train.avgR - a.train.avgR)[0], ladderEv = best.tr.filter(t => inYears(t, evYears));
  const lport = {}, lrows = {};
  for (const risk of [0.0025, 0.005, 0.01]) lport[risk * 100] = portfolio(ladderEv.map(t => ({ t: t.entry_time, tx: t.exit_time, r: t.r })), risk, from, to);
  for (const c of Object.keys(full)) lrows[c] = summary(ladderEv.filter(t => t.coin === c));
  console.log("chosen on 2020-2022:", best.L.name, "· evidence years", JSON.stringify(best.test), "· portfolio", JSON.stringify(lport));

  // Late entry: a trader who sees the rule's open position d bars after it entered, while no take profit has filled and
  // the price is still within 0.5R of the entry, enters at that close with the same SL, take profits and exit. R is in
  // units of the late trader's own risk (distance to the same SL); costs as above.
  const lateRows = {};
  for (const d of [1, 2, 3, 6, 12]) {
    let late = [], orig = [];
    for (const c of Object.keys(full)) {
      const bars = app(c);
      for (const t of best.tr.filter(x => x.coin === c && inYears(x, evYears))) {
        const k = t.entry_index + d - 1;
        if (k >= t.exit_index) continue;                                  // already closed by then
        const fillsBefore = (t.fills || []).filter(f => f.time <= bars[k].time).length;
        if (fillsBefore) continue;                                         // a take profit already filled
        const px = bars[k].close, lateEntry = px * (1 + t.dir * SLIP), lateRisk = Math.abs(lateEntry - t.stop);
        if (Math.abs(px - t.entry) > 0.5 * t.risk || !(lateRisk > 0) || t.dir * (t.stop - lateEntry) >= 0) continue;
        const hours = (bars[t.exit_index].t === undefined ? bars[t.exit_index].time : bars[t.exit_index].t) - bars[k].close_time;
        let gross = 0, left = 1;
        for (const f of t.fills || []) { gross += f.frac * t.dir * (f.px - lateEntry) / lateRisk; left -= f.frac; }
        gross += left * t.dir * (t.exit - lateEntry) / lateRisk;
        late.push({ r: gross - (2 * (FEE + SLIP) * lateEntry + FUNDING * lateEntry * Math.max(0, hours) / H / 8) / lateRisk, entry_time: t.entry_time, exit_time: t.exit_time });
        orig.push(t);
      }
    }
    lateRows[d] = { late: summary(late), original: summary(orig) };
    console.log(`late entry ${d} bar(s) after the rule (within 0.5R, no TP yet):`, JSON.stringify(lateRows[d].late), "· same trades entered on time:", JSON.stringify(lateRows[d].original));
  }

  // ---- What is normal for this rule (for the app's live record) and drawdown rules (for its stop rule) ----
  // Normal range: what happened in the evidence years in exit order, so losses that cluster (the coins turn together)
  // stay clustered. Windows of N consecutive trades give the range a live record of N trades is compared with.
  const byExit = tr => tr.slice().sort((a, b) => a.exit_time - b.exit_time);
  const normalOf = tr => {
    const rs = byExit(tr).map(t => t.r), windows = {};
    let run = 0, worstStreak = 0, cum = 0, top = 0, ddR = 0;
    for (const r of rs) { run = r > 0 ? 0 : run + 1; worstStreak = Math.max(worstStreak, run); cum += r; top = Math.max(top, cum); ddR = Math.max(ddR, top - cum); }
    for (const N of [10, 20, 30, 50, 100]) {
      const sums = []; let acc = 0;
      rs.forEach((r, i) => { acc += r; if (i >= N) acc -= rs[i - N]; if (i >= N - 1) sums.push(acc); });
      windows[N] = { p5: +pct(sums, 0.05).toFixed(1), p50: +pct(sums, 0.5).toFixed(1), min: +Math.min(...sums).toFixed(1) };
    }
    return { n: rs.length, worstStreak, maxDDR: +ddR.toFixed(1), windows };
  };
  // Portfolio with entry decisions: each trade risks risk x f of the realized equity at its entry (f from the rule; 0
  // skips it, -1 stops all later entries), P&L booked at exit. Calendar months without exits count as flat.
  const THAI = 7 * H;
  const simulate = (tr, risk, from, to, rule) => {
    const ev = [], stake = {}, months = {};
    // A trade stopped in the bar it entered exits at its entry time: book the exit just after the entry, so it counts.
    tr.filter(t => t.entry_time >= from && t.entry_time < to).forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, t, i }); ev.push({ time: Math.max(t.exit_time, t.entry_time + 1), k: 0, t, i }); });
    ev.sort((a, b) => a.time - b.time || a.k - b.k);
    let eq = 1, peak = 1, dd = 0, peakTime = from, under = 0, halted = false, day = "", dayStart = 1, dayPnl = 0, taken = 0, offered = 0;
    for (const e of ev) {
      const d = new Date(e.time + THAI).toISOString().slice(0, 10);
      if (d !== day) { day = d; dayStart = eq; dayPnl = 0; }
      if (e.k === 1) {
        offered++;
        const f = halted ? 0 : rule({ dd: 1 - eq / peak, dayLoss: -dayPnl / dayStart });
        if (f < 0) halted = true;
        else if (f > 0) { stake[e.i] = eq * risk * f; taken++; }
      } else if (stake[e.i] !== undefined) {
        const before = eq, pnl = stake[e.i] * e.t.r;
        eq = Math.max(0.01, eq + pnl); dayPnl += pnl;
        if (eq >= peak) { under = Math.max(under, e.time - peakTime); peak = eq; peakTime = e.time; }
        dd = Math.max(dd, 1 - eq / peak);
        const m = new Date(e.time).toISOString().slice(0, 7); months[m] = (months[m] || 1) * (eq / before);
      }
    }
    under = Math.max(under, Math.min(to, Date.now()) - peakTime);
    const mv = [];
    for (let y = new Date(from).getUTCFullYear(), mo = new Date(from).getUTCMonth(); Date.UTC(y, mo, 1) < to; mo === 11 ? (y++, mo = 0) : mo++)
      mv.push(months[`${y}-${String(mo + 1).padStart(2, "0")}`] || 1);
    let lr = 0, worstLosingMonths = 0, worst3 = Infinity;
    mv.forEach((v, i) => { lr = v < 1 ? lr + 1 : 0; worstLosingMonths = Math.max(worstLosingMonths, lr); if (i >= 2) worst3 = Math.min(worst3, v * mv[i - 1] * mv[i - 2]); });
    const yrs = (to - from) / (365.25 * 24 * H), cagr = 100 * (Math.pow(eq, 1 / yrs) - 1);
    return { taken, skipped: offered - taken, cagr: +cagr.toFixed(1), maxDD: +(100 * dd).toFixed(1), mar: dd > 0 ? +(cagr / (100 * dd)).toFixed(2) : null,
      losingMonths: +(100 * mv.filter(v => v < 1).length / mv.length).toFixed(0), worstLosingMonths, worst3m: +(100 * (worst3 - 1)).toFixed(1),
      worstMonth: +(100 * (Math.min(...mv) - 1)).toFixed(1), underDays: Math.round(under / 86400000) };
  };
  // Stop rules, listed before the run: the app's old rule (made for the 15-minute strategy), a daily loss stop, and
  // halving the risk below a drawdown. Chosen on 2020-2022 by CAGR / max drawdown, reported on the evidence years.
  const RULES = [
    { id: "none", name: "ไม่มีกติกาหยุด (เทรดทุกสัญญาณ)", f: () => 1 },
    { id: "app", name: "กติกาเดิม: ลดครึ่งเมื่อลง 4% · หยุดถาวรเมื่อลง 8% · หยุดวันที่ขาดทุน 2%", f: s => s.dd >= 0.08 ? -1 : s.dayLoss >= 0.02 ? 0 : s.dd >= 0.04 ? 0.5 : 1 },
    { id: "day2", name: "หยุดเข้าไม้ใหม่วันที่ขาดทุนถึง 2%", f: s => s.dayLoss >= 0.02 ? 0 : 1 },
    { id: "half10", name: "ลดความเสี่ยงครึ่งหนึ่งเมื่อพอร์ตลง 10%", f: s => s.dd >= 0.10 ? 0.5 : 1 },
    { id: "half15", name: "ลดความเสี่ยงครึ่งหนึ่งเมื่อพอร์ตลง 15%", f: s => s.dd >= 0.15 ? 0.5 : 1 },
    { id: "half20", name: "ลดความเสี่ยงครึ่งหนึ่งเมื่อพอร์ตลง 20%", f: s => s.dd >= 0.20 ? 0.5 : 1 }
  ];
  const trainFrom = Date.UTC(TRAIN[0], 0, 1), trainTo = Date.UTC(TRAIN[TRAIN.length - 1] + 1, 0, 1);
  const modes = { rule: all.filter(t => levLiq(t) >= 5), ladder: best.tr };
  const normal = {}, stopRules = { chosen_on: TRAIN, risk: 0.5, by: "CAGR / max drawdown" };
  console.log("\n== WHAT IS NORMAL (evidence years, exit order) AND STOP RULES ==");
  for (const k of Object.keys(modes)) {
    const evTr = modes[k].filter(t => inYears(t, evYears)), trainTr = modes[k].filter(t => inYears(t, TRAIN));
    normal[k] = normalOf(evTr);
    normal[k].port = {};
    for (const risk of [0.0025, 0.005, 0.01]) normal[k].port[risk * 100] = simulate(evTr, risk, from, to, () => 1);
    console.log(k, "normal:", JSON.stringify(normal[k]));
    const rows = RULES.map(R => ({ id: R.id, name: R.name, train: simulate(trainTr, 0.005, trainFrom, trainTo, R.f), test: simulate(evTr, 0.005, from, to, R.f) }));
    rows.forEach(x => console.log(`  ${k} ${x.id.padEnd(7)} train ${JSON.stringify(x.train)}  test ${JSON.stringify(x.test)}`));
    const pick = rows.slice().sort((a, b) => (b.train.mar || 0) - (a.train.mar || 0))[0];
    stopRules[k] = { rows, chosen: pick.id };
    console.log(`  ${k}: chosen on 2020-2022 -> ${pick.id} (${pick.name})`);
  }

  const out = { strategy: "donchian4h", name: "Trend 4H · Donchian 20/10 · SL 3 ATR · EMA200 · Long/Short",
    period: contiguous ? `${evYears[0]}-01-01..2026-09-30` : evYears.join(", "), years_chosen: evYears,
    selection: "walk-forward: each year the rule was picked using only earlier years (24 candidates)",
    costs: "fee 0.05% + slippage 0.02% per side, funding 0.01%/8h", filter: "signals whose stop needs leverage below 5x are not sent",
    generated: new Date().toISOString().slice(0, 10), all: summary(evApp), y2022: summary(y2022), years, rows, stress: summary(stress), stops: stopInfo, lev: levInfo, open: conc, portfolio: port,
    parity: bad ? "FAIL" : "OK", replay: miss ? "FAIL" : "OK", replay_checked: checked,
    reach: reach(evApp), reachRows, base_train: baseTrain,
    ladder: { id: best.L.id, name: best.L.name, tps: best.L.tps, chosen_on: TRAIN, train: best.train, test: best.test, portfolio: lport, rows: lrows },
    late: lateRows, normal, stopRules,
    ladders: ladderRuns.map(x => ({ id: x.L.id, name: x.L.name, train: { n: x.train.n, win: x.train.win, avgR: x.train.avgR }, test: { n: x.test.n, win: x.test.win, avgR: x.test.avgR, pf: x.test.pf } })) };
  console.log("EVIDENCE_TREND=" + JSON.stringify(out));
  fs.writeFileSync("evidence_trend.json", JSON.stringify(out, null, 1) + "\n");
  if (bad || miss) process.exitCode = 1;
})();
