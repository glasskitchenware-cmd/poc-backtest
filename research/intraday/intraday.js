// Day trades only: every position opens and closes within the same Thai day (00:00-24:00 ICT = 17:00-17:00 UTC).
// Three rules with a published rationale, never tested here before; nothing fitted. Research only.
//
// PROTOCOL — fixed 2026-10-28 before any run on market data; a change after the first run needs a new file.
//  Data: Binance USD-M 1h klines, the app's 12 coins (decide) and 25 unseen coins (report), 2020-01 .. last full day.
//  D1 last-hour momentum (intraday time-series momentum): if the Thai day's return up to the start of its last hour
//     (open of 17:00 UTC bar -> open of the 16:00 UTC bar) is at least 2% either way, trade that direction in the last
//     hour: in at the 16:00 UTC open, out at its close; stop 1 ATR(14, 1h) from the entry inside the hour.
//  D2 opening-range breakout: the first 4 hours of the Thai day set a range; from then on, the first 1h close above it
//     (below it) is a LONG (SHORT) if yesterday's Thai-day close is above (below) the EMA20 of Thai-day closes; in at the
//     next open, stop at the middle of the range, target 2R, out at the day's last close. One trade per coin per day.
//  D3 pullback in the trend: LONG when yesterday's Thai-day close is above the SMA50 of Thai-day closes and the 1h
//     RSI(2) closes below 10 (SHORT mirrored: below, above 90); in at the next open; out at the next open after a close
//     back above (below) the 1h SMA5, or at the stop 2 ATR(14, 1h) away, or at the day's last close; no entry in the
//     day's last 2 hours.
//  Costs: 0.05% fee per side on each fill, 0.02% slippage inside market fills (target fills at its level), funding
//  0.01% for each 00:00/08:00/16:00 UTC settlement held, always paid. Stop first when a bar touches stop and target.
//  Selection on 12 coins 2020-01..2023-12: highest MAR at 0.25% risk per trade (compounded) among rules with >= 200
//  trades. Holdout, looked at once for the chosen rule (all reported): 2024-01 .. last full day.
//  Gate on the holdout: >= 200 trades; PF >= 1.15; 2024-01..2025-05 and 2025-06..end both profitable; >= 60% positive
//  months; max drawdown <= 8% at 0.25% risk; positive with 2x fee and slippage; forward paper UNKNOWN.
// Usage: node intraday.js BASE_COINS UNSEEN_COINS NOW_MS   (bars from ../evidence/bars/<COIN>_1h.json)
"use strict";
const fs = require("fs"), path = require("path");
const [BASE, UNSEEN] = process.argv.slice(2, 4).map(x => x.split(","));
const NOW = +process.argv[4] || Date.now();
const BARS = process.env.BARS || path.resolve(__dirname, "../evidence/bars");
const H = 3600000, DAY = 24 * H, ICT = 7 * H, Y = y => Date.UTC(y, 0, 1), RISK = 0.0025, SEL = [Y(2020), Y(2024)], HOLD = [Y(2024), NOW], SPLIT = Date.UTC(2025, 5, 1);
const load = c => { const p = path.join(BARS, `${c}_1h.json`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).filter(r => r[6] < NOW).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] })) : null; };
const dayOf = t => Math.floor((t + ICT) / DAY), hourOf = t => Math.floor(((t + ICT) % DAY) / H);   // Thai day and hour 0..23
function atr(b, n) { let a; return b.map((x, i) => { const tr = i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low; return (a = i < n ? (i ? (a * i + tr) / (i + 1) : tr) : a + (tr - a) / n); }); }
function rsi2(c) { let up = 0, dn = 0; return c.map((x, i) => { if (!i) return 50; const d = x - c[i - 1]; up = (up + Math.max(0, d)) / 2; dn = (dn + Math.max(0, -d)) / 2; return dn === 0 ? 100 : 100 - 100 / (1 + up / dn); }); }
function settlements(t0, t1) { let n = 0; for (let t = Math.ceil(t0 / (8 * H)) * 8 * H; t < t1; t += 8 * H) n++; return n; }
// Thai-day closes (the 16:00 UTC bar's close) and their trend filters, by day number.
function dailyTrend(b) {
  const closes = [], idx = {};
  b.forEach(x => { if (hourOf(x.time) === 23) { idx[dayOf(x.time)] = closes.length; closes.push(x.close); } });
  const ema = [], sma = []; let e;
  closes.forEach((c, i) => { e = i ? e + (2 / 21) * (c - e) : c; ema.push(e); sma.push(i >= 49 ? closes.slice(i - 49, i + 1).reduce((a, v) => a + v, 0) / 50 : NaN); });
  return { up: (day, kind) => { const i = idx[day - 1]; if (i === undefined || i < 60) return 0; const m = kind === "ema" ? ema[i] : sma[i]; return closes[i] > m ? 1 : closes[i] < m ? -1 : 0; } };
}
function trade(b, d, i, stop, tp, lastI, k, exitWhen) {   // enter at b[i].open; out by lastI's close at the latest
  const fee = 0.0005 * k, s = 0.0002 * k, entry = b[i].open * (1 + d * s), risk = d * (entry - stop);
  if (!(risk > 0) || risk / entry < 0.001) return null;
  let px = null, at = null, j = i;
  for (; j <= lastI; j++) {
    const y = b[j];
    if (j > i && (d > 0 ? y.open <= stop : y.open >= stop)) { px = y.open * (1 - d * s); at = y.time; break; }   // gap through the stop
    if (d > 0 ? y.low <= stop : y.high >= stop) { px = stop * (1 - d * s); at = y.time + H / 2; break; }         // stop first
    if (tp && (d > 0 ? y.high >= tp : y.low <= tp)) { px = j > i && (d > 0 ? y.open >= tp : y.open <= tp) ? y.open : tp; at = y.time + H / 2; break; }
    if (exitWhen && j < lastI && exitWhen(j)) { j++; px = b[j].open * (1 - d * s); at = b[j].time; break; }
  }
  if (px === null) { j = lastI; px = b[lastI].close * (1 - d * s); at = b[lastI].time + H; }   // the day's last close
  const r = (d * (px - entry) - fee * entry - fee * px - 0.0001 * entry * settlements(b[i].time, at)) / risk;
  return { entry_time: b[i].time, exit_time: at, dir: d, r, j };
}
function rules(b, rule, k) {
  const A = atr(b, 14), T = dailyTrend(b), C = b.map(x => x.close), R2 = rsi2(C), out = [];
  const sma5 = i => i >= 4 ? (C[i] + C[i - 1] + C[i - 2] + C[i - 3] + C[i - 4]) / 5 : NaN;
  // index of each Thai day's bars (complete days only)
  const days = {}; b.forEach((x, i) => { (days[dayOf(x.time)] = days[dayOf(x.time)] || []).push(i); });
  for (const [day, ix] of Object.entries(days)) {
    if (ix.length !== 24 || ix[0] < 1500) continue;
    const first = ix[0], last = ix[23];
    if (rule === "D1") {
      const ret = b[last].open / b[first].open - 1;
      if (Math.abs(ret) < 0.02) continue;
      const d = ret > 0 ? 1 : -1, e = b[last].open, t = trade(b, d, last, e - d * A[last - 1], null, last, k);
      if (t) out.push(t);
    } else if (rule === "D2") {
      let hi = -Infinity, lo = Infinity; for (let q = 0; q < 4; q++) { hi = Math.max(hi, b[ix[q]].high); lo = Math.min(lo, b[ix[q]].low); }
      const trend = T.up(+day, "ema");
      if (!trend) continue;
      for (let q = 4; q < 23; q++) {
        const i = ix[q], d = b[i].close > hi ? 1 : b[i].close < lo ? -1 : 0;
        if (!d) continue;
        if (d === trend) { const e = b[i + 1].open, stop = (hi + lo) / 2, t = trade(b, d, i + 1, stop, e + d * 2 * Math.abs(e - stop), last, k); if (t) out.push(t); }
        break;   // only the first breakout of the day
      }
    } else if (rule === "D3") {
      const trend = T.up(+day, "sma");
      if (!trend) continue;
      for (let q = 0; q < 22; q++) {
        const i = ix[q];
        if (!(trend > 0 ? R2[i] < 10 : R2[i] > 90)) continue;
        const e = b[i + 1].open, t = trade(b, trend, i + 1, e - trend * 2 * A[i], null, last, k, j => trend > 0 ? C[j] > sma5(j) : C[j] < sma5(j));
        if (!t) continue;
        out.push(t);
        q = ix.indexOf(t.j); if (q < 0) break;   // next entry after this exit
      }
    }
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
  const yrs = (Math.min(to, NOW) - from) / (365.25 * DAY), cagr = Math.pow(eq, 1 / yrs) - 1, mv = Object.values(months);
  return { cagrPct: +(100 * cagr).toFixed(2), maxDDPct: +(100 * dd).toFixed(2), mar: dd > 0 ? +(cagr / dd).toFixed(3) : null, months: mv.length, posMonthsPct: mv.length ? +(100 * mv.filter(v => v > 0).length / mv.length).toFixed(1) : null };
}
const cache = {};
function trades(coins, rule, k, from, to) {
  const all = [];
  coins.forEach(c => { if (!(c in cache)) cache[c] = load(c); const b = cache[c]; if (!b) return; rules(b, rule, k).filter(t => t.entry_time >= from && t.entry_time < to).forEach(t => all.push(t)); });
  return all;
}
const out = { generated: new Date().toISOString(), now: new Date(NOW).toISOString(), status: "RESEARCH ONLY", rules: {} };
for (const rule of ["D1", "D2", "D3"]) {
  const s = trades(BASE, rule, 1, SEL[0], SEL[1]), h = trades(BASE, rule, 1, HOLD[0], HOLD[1]);
  out.rules[rule] = { selection: Object.assign(summary(s), port(s, SEL[0], SEL[1])), holdout: Object.assign(summary(h), port(h, HOLD[0], HOLD[1])),
    maxHoldHours: Math.max(0, ...s.concat(h).map(t => (t.exit_time - t.entry_time) / H)) };
  console.log(rule, "sel", JSON.stringify(out.rules[rule].selection), "hold", JSON.stringify(out.rules[rule].holdout), "max hold h", out.rules[rule].maxHoldHours);
}
const pick = Object.entries(out.rules).filter(([, v]) => v.selection.n >= 200).sort((a, b) => (b[1].selection.mar || -9) - (a[1].selection.mar || -9))[0];
out.chosen = pick ? pick[0] : null;
if (pick) {
  const h = trades(BASE, pick[0], 1, HOLD[0], HOLD[1]), x2 = trades(BASE, pick[0], 2, HOLD[0], HOLD[1]);
  const a = summary(h.filter(t => t.entry_time < SPLIT)), z = summary(h.filter(t => t.entry_time >= SPLIT)), hs = summary(h), hp = port(h, HOLD[0], HOLD[1]), xs = summary(x2);
  out.unseen = summary(trades(UNSEEN, pick[0], 1, Y(2020), NOW));
  const P = ok => ok ? "PASS" : "FAIL";
  out.gate = { ">= 200 trades": P(hs.n >= 200) + " " + hs.n, "PF >= 1.15": P(hs.pf >= 1.15) + " " + hs.pf, "both halves profitable": P(a.sumR > 0 && z.sumR > 0) + " " + a.sumR + "R / " + z.sumR + "R",
    ">= 60% positive months": P(hp.posMonthsPct >= 60) + " " + hp.posMonthsPct + "%", "max DD <= 8% at 0.25%": P(hp.maxDDPct <= 8) + " " + hp.maxDDPct + "%",
    "positive at 2x costs": P(xs.sumR > 0) + " " + xs.avgR + "R/trade", "forward paper": "UNKNOWN" };
  out.passed = Object.values(out.gate).filter(v => v.startsWith("PASS")).length === 6;
}
fs.writeFileSync("intraday.json", JSON.stringify(out, null, 1) + "\n");
console.log("chosen", out.chosen, JSON.stringify(out.gate, null, 1), "unseen", JSON.stringify(out.unseen), "passed", out.passed);
