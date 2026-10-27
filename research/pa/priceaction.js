// Price action from the user's course book (Forex City / Elliy, EURUSD examples): a pin bar, an engulfing bar or three
// soldiers at support in the trend's direction, stop beyond the pattern, take profit beyond. Tested mechanically on the
// app's crypto futures. Research only.
//
// PROTOCOL — fixed 2026-10-28 before any run on market data; a change after the first run needs a new file.
//  Trend: close above EMA200 for LONG, below for SHORT (stands in for the book's hand-drawn trendlines).
//  Pullback to support: LONG when the signal bar's low reaches EMA50 + 0.25 ATR(14) and it closes above EMA50 (SHORT mirrored).
//  Patterns on the closed signal bar (LONG; SHORT mirrored):
//    pin   lower wick >= 2 x body and >= 60% of the range, close in the top third.
//    engulf  previous bar down, this bar up, this body covers the previous body.
//    sold  three up bars in a row, each closing higher, each body >= 50% of its range.
//    any   any of the three.
//  Trade: entry at the next bar's open; stop 0.1 ATR beyond the lowest low of the pattern's bars (1 or 2 or 3 bars);
//  stop distance between 0.2% of the price and 3 ATR, else skipped; take profit 2R (limit); out at the close after 20
//  bars. Stop first when a bar touches both; a gap through the stop or target fills at the open. One trade per coin.
//  Costs: 0.05% fee per side on each fill's notional, 0.02% slippage inside market fills (entry, stop, time exit),
//  funding 0.01% per 8 hours always paid.
//  Variants: 4 patterns x 3 timeframes (1h, 4h, 1d) = 12. Selection on the 12 coins 2020-01..2023-12: highest MAR at
//  0.25% risk per trade (compounded) among variants with >= 200 trades. Holdout, looked at once for the chosen variant
//  (all reported): 2024-01 .. last full day, 12 coins. Also reported: 25 unseen coins, 2020-01 .. last day.
//  Gate on the holdout: >= 200 trades; PF >= 1.15; 2024-01..2025-05 and 2025-06..end both profitable; >= 60% positive
//  months; max drawdown <= 8% at 0.25% risk (on closed trades); positive with 2x fee and slippage; forward paper UNKNOWN.
// Usage: node priceaction.js BASE_COINS UNSEEN_COINS NOW_MS   (bars from ../evidence/bars: <COIN>_<tf>.json)
"use strict";
const fs = require("fs"), path = require("path");
const [BASE, UNSEEN] = process.argv.slice(2, 4).map(x => x.split(","));
const NOW = +process.argv[4] || Date.now();
const BARS = process.env.BARS || path.resolve(__dirname, "../evidence/bars");
const H = 3600000, Y = y => Date.UTC(y, 0, 1), RISK = 0.0025, SEL = [Y(2020), Y(2024)], HOLD = [Y(2024), NOW], SPLIT = Date.UTC(2025, 5, 1);
const TFS = ["1h", "4h", "1d"], PATS = ["pin", "engulf", "sold", "any"];
const load = (c, tf) => { const p = path.join(BARS, `${c}_${tf}.json`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).filter(r => r[6] < NOW).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] })) : null; };
function ema(xs, n) { const a = 2 / (n + 1); let y; return xs.map((x, i) => (y = i ? y + a * (x - y) : x)); }
function atr(b, n) { let a; return b.map((x, i) => { const tr = i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low; return (a = i < n ? (i ? (a * i + tr) / (i + 1) : tr) : a + (tr - a) / n); }); }
// Pattern on bar i for direction d (+1 LONG, -1 SHORT): the number of bars it spans, or 0.
function pattern(b, i, d, p) {
  const x = b[i], body = Math.abs(x.close - x.open), range = x.high - x.low;
  const up = k => b[k].close > b[k].open, down = k => b[k].close < b[k].open, dirUp = k => d > 0 ? up(k) : down(k), dirDown = k => d > 0 ? down(k) : up(k);
  const pin = () => { if (!(range > 0)) return 0; const wick = d > 0 ? Math.min(x.open, x.close) - x.low : x.high - Math.max(x.open, x.close);
    const pos = d > 0 ? (x.close - x.low) / range : (x.high - x.close) / range; return wick >= 2 * body && wick >= 0.6 * range && pos >= 2 / 3 ? 1 : 0; };
  const engulf = () => { const y = b[i - 1]; return dirDown(i - 1) && dirUp(i) && Math.max(x.open, x.close) >= Math.max(y.open, y.close) && Math.min(x.open, x.close) <= Math.min(y.open, y.close) ? 2 : 0; };
  const sold = () => { for (let k = i - 2; k <= i; k++) { const r = b[k].high - b[k].low; if (!dirUp(k) || !(r > 0) || Math.abs(b[k].close - b[k].open) < 0.5 * r) return 0; if (k > i - 2 && d * (b[k].close - b[k - 1].close) <= 0) return 0; } return 3; };
  if (p === "pin") return pin(); if (p === "engulf") return engulf(); if (p === "sold") return sold();
  return pin() || engulf() || sold();
}
function backtest(b, p, k) {
  const fee = 0.0005 * k, s = 0.0002 * k, fund = 0.0001;
  const C = b.map(x => x.close), E200 = ema(C, 200), E50 = ema(C, 50), A = atr(b, 14), out = [];
  for (let i = 210; i < b.length - 1; i++) {
    const x = b[i], d = x.close > E200[i] ? 1 : x.close < E200[i] ? -1 : 0;
    if (!d) continue;
    const touch = d > 0 ? x.low <= E50[i] + 0.25 * A[i] && x.close > E50[i] : x.high >= E50[i] - 0.25 * A[i] && x.close < E50[i];
    if (!touch) continue;
    const span = pattern(b, i, d, p);
    if (!span) continue;
    let ext = d > 0 ? Infinity : -Infinity; for (let j = i - span + 1; j <= i; j++) ext = d > 0 ? Math.min(ext, b[j].low) : Math.max(ext, b[j].high);
    const entry = b[i + 1].open * (1 + d * s), stop = ext - d * 0.1 * A[i], risk = d * (entry - stop);
    if (!(risk > 0) || risk / entry < 0.002 || risk > 3 * A[i]) continue;
    const tp = entry + d * 2 * risk;
    let exitPx = null, exitAt = null, j = i + 1;
    for (; j < b.length && j <= i + 20; j++) {
      const y = b[j];
      if (d > 0 ? y.open <= stop : y.open >= stop) { exitPx = y.open * (1 - d * s); exitAt = j; break; }
      if (d > 0 ? y.low <= stop : y.high >= stop) { exitPx = stop * (1 - d * s); exitAt = j; break; }
      if (d > 0 ? y.open >= tp : y.open <= tp) { exitPx = y.open; exitAt = j; break; }
      if (d > 0 ? y.high >= tp : y.low <= tp) { exitPx = tp; exitAt = j; break; }
    }
    if (exitPx === null) { if (j > i + 20) { exitAt = i + 20; exitPx = b[exitAt].close * (1 - d * s); } else break; }
    const hours = (b[exitAt].time + (exitAt === i + 20 ? 0 : 0) - b[i + 1].time) / H;
    const r = (d * (exitPx - entry) - fee * entry - fee * exitPx - fund * entry * Math.max(0, hours) / 8) / risk;
    out.push({ entry_time: b[i + 1].time, exit_time: b[exitAt].time + 1, dir: d, r });
    i = exitAt;   // one trade at a time per coin
  }
  return out;
}
function summary(tr) {
  const n = tr.length; if (!n) return { n: 0 };
  const sum = tr.reduce((a, t) => a + t.r, 0), gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
  return { n, win: +(100 * tr.filter(t => t.r > 0).length / n).toFixed(1), avgR: +(sum / n).toFixed(4), sumR: +sum.toFixed(1), pf: gl ? +(gp / gl).toFixed(3) : null };
}
function port(tr, from, to) {
  const ev = [], stake = {}, months = {};
  tr.forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, i }); ev.push({ time: t.exit_time, k: 0, i, r: t.r }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  let eq = 1, peak = 1, dd = 0;
  for (const e of ev) { if (e.k) { stake[e.i] = eq * RISK; continue; } const g = stake[e.i] * e.r, m = new Date(e.time).toISOString().slice(0, 7); eq = Math.max(0.01, eq + g); months[m] = (months[m] || 0) + g; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
  const yrs = (Math.min(to, NOW) - from) / (365.25 * 24 * H), cagr = Math.pow(eq, 1 / yrs) - 1, mv = Object.values(months);
  return { cagrPct: +(100 * cagr).toFixed(2), maxDDPct: +(100 * dd).toFixed(2), mar: dd > 0 ? +(cagr / dd).toFixed(3) : null, months: mv.length, posMonthsPct: mv.length ? +(100 * mv.filter(v => v > 0).length / mv.length).toFixed(1) : null };
}
const cache = {};
function trades(coins, tf, p, k, from, to) {
  const all = [];
  coins.forEach(c => { const key = c + tf; if (!(key in cache)) cache[key] = load(c, tf); const b = cache[key]; if (!b) return;
    backtest(b, p, k).filter(t => t.entry_time >= from && t.entry_time < to).forEach(t => all.push(t)); });
  return all;
}
const out = { generated: new Date().toISOString(), now: new Date(NOW).toISOString(), status: "RESEARCH ONLY", variants: {} };
for (const tf of TFS) for (const p of PATS) {
  const sel = trades(BASE, tf, p, 1, SEL[0], SEL[1]), hold = trades(BASE, tf, p, 1, HOLD[0], HOLD[1]);
  out.variants[tf + " " + p] = { selection: Object.assign(summary(sel), port(sel, SEL[0], SEL[1])), holdout: Object.assign(summary(hold), port(hold, HOLD[0], HOLD[1])) };
  console.log(tf, p, "sel", JSON.stringify(out.variants[tf + " " + p].selection), "hold", JSON.stringify(out.variants[tf + " " + p].holdout));
}
const pick = Object.entries(out.variants).filter(([, v]) => v.selection.n >= 200).sort((a, b) => (b[1].selection.mar || -9) - (a[1].selection.mar || -9))[0];
out.chosen = pick ? pick[0] : null;
if (pick) {
  const [tf, p] = pick[0].split(" "), h = trades(BASE, tf, p, 1, HOLD[0], HOLD[1]), x2 = trades(BASE, tf, p, 2, HOLD[0], HOLD[1]);
  const a = summary(h.filter(t => t.entry_time < SPLIT)), z = summary(h.filter(t => t.entry_time >= SPLIT)), hs = summary(h), hp = port(h, HOLD[0], HOLD[1]), xs = summary(x2);
  out.unseen = summary(trades(UNSEEN, tf, p, 1, Y(2020), NOW));
  const P = ok => ok ? "PASS" : "FAIL";
  out.gate = { ">= 200 trades": P(hs.n >= 200) + " " + hs.n, "PF >= 1.15": P(hs.pf >= 1.15) + " " + hs.pf, "both halves profitable": P(a.sumR > 0 && z.sumR > 0) + " " + a.sumR + "R / " + z.sumR + "R",
    ">= 60% positive months": P(hp.posMonthsPct >= 60) + " " + hp.posMonthsPct + "%", "max DD <= 8% at 0.25%": P(hp.maxDDPct <= 8) + " " + hp.maxDDPct + "%",
    "positive at 2x costs": P(xs.sumR > 0) + " " + xs.avgR + "R/trade", "forward paper": "UNKNOWN" };
  out.passed = Object.values(out.gate).filter(v => v.startsWith("PASS")).length === 6;
}
fs.writeFileSync("priceaction.json", JSON.stringify(out, null, 1) + "\n");
console.log("chosen", out.chosen, JSON.stringify(out.gate, null, 1), "unseen", JSON.stringify(out.unseen), "passed", out.passed);
