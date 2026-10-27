// "A system steady enough to trade for a living": three portfolio candidates, built differently from Trend 4H, tested
// against the approval gate locked on 2026-10-27 (research/hourly). Research only: no orders, no app change.
//
// PROTOCOL — fixed 2026-10-28 before any run on market data; a change after the first run needs a new file.
//  Data: Binance USD-M daily klines, 37 coins (the app's 12 + the 25 never used to choose anything), 2020-01 .. last
//        full day; Binance spot daily, 15 coins, 2017-09 .. 2019-12 (robustness only). Trend 4H uses the 12 coins' 4h bars.
//  Positions are decided on a day's close and earn the next day's close-to-close return. Costs: 0.05% fee + 0.02%
//  slippage per side on traded notional (turnover), funding 0.03% per day on every long held (0.01%/8h, always paid;
//  spot: none). Parameters below are fixed from common practice; nothing is fitted.
//  C1 XSMOM: every Monday close, coins with >= 120 days of history ranked by return over days t-28..t-1; hold the top 5
//     with a positive return, weights proportional to 1 / 30-day volatility, gross 100%; all cash when BTC closes below
//     its 100-day average.
//  C2 TSMOM: daily, a coin is held when the average of its 20-, 60- and 120-day returns is positive; weight = (1/37) x
//     (40% annual vol / its 30-day annualised vol), capped at 20% per coin and 100% gross; a weight is only changed when
//     it moves by more than 25% of itself (fewer trades).
//  C3 BLEND: Trend 4H (the app's rule, ladder and filter, marked to market at each daily close at 0.25% risk per trade)
//     and C1, each scaled to the same daily volatility over the selection period, summed.
//  Selection: each candidate is scaled so its selection-period (2020-01..2024-12) max drawdown is 8%; the candidate with
//     the highest selection MAR (CAGR / max DD) whose spot 2017-2019 result is positive (C3: its C1 part) is chosen.
//  Holdout (looked at once, for the chosen candidate; all three are reported): 2025-01 .. last full day, same scale.
//  Gate on the holdout: >= 200 trades (a trade = a continuous holding of one coin); PF >= 1.15; 2025 and 2026 both
//     profitable; >= 60% positive months; max DD <= 8% (daily closes; Trend 4H marked at closes); positive with 2x fee and
//     slippage; walk-forward: N/A (nothing fitted; 1 of 3 chosen on 2020-2024); forward paper: UNKNOWN until it exists.
//  Deterministic: no bootstrap, Monte Carlo or permutation.
// Usage: node career.js FUT_COINS SPOT_COINS TREND_COINS NOW_MS   (bars from ../evidence/bars)
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const Trend = require("../../web/trend.js");
const [FUT, SPOT, TRENDC] = process.argv.slice(2, 5).map(x => x.split(","));
const NOW = +process.argv[5] || Date.now();
const DAY = 86400000, Y = y => Date.UTC(y, 0, 1), SEL = [Y(2020), Y(2025)], HOLD = [Y(2025), NOW], SPOTP = [Date.UTC(2017, 8, 1), Y(2020)];
const FEE = 0.0005, SLIP = 0.0002, FUND = 0.0003, TREND_RISK = 0.0025, MMR_SAFE = 0.01;
const BARS = process.env.BARS || path.resolve(__dirname, "../evidence/bars");
const LADDER = [{ r: 3, frac: 0.5 }];
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
const loadRows = f => { const p = path.join(BARS, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).filter(r => r[6] < NOW) : null; };
const sources = {};
function daily(coins, prefix) {   // {coin: Map(dayTime -> close)}
  const out = {};
  coins.forEach(c => { const f = `${prefix}${c}_1d.json`, rows = loadRows(f); if (!rows || rows.length < 130) return; out[c] = new Map(rows.map(r => [r[0], r[4]])); sources[f] = sha(path.join(BARS, f)); });
  return out;
}
// ---- Candidate weights per day. closes: {coin: Map}; days: sorted day times.
function c1Weights(closes, days, btc) {
  const W = [], coins = Object.keys(closes);
  let cur = {};
  days.forEach((d, i) => {
    if (new Date(d).getUTCDay() === 1) {   // Monday close
      cur = {};
      const b = closes[btc], bt = [], ok = b && b.has(d);
      for (let k = 0; k < 100 && ok; k++) { const v = b.get(d - k * DAY); if (v) bt.push(v); }
      if (ok && bt.length === 100 && b.get(d) >= bt.reduce((a, v) => a + v, 0) / 100) {
        const ranked = coins.map(c => {
          const m = closes[c], h = m.get(d - 120 * DAY), a = m.get(d - 28 * DAY), z = m.get(d - DAY);
          if (!m.has(d) || !h || !a || !z) return null;
          const rets = []; for (let k = 0; k < 30; k++) { const p1 = m.get(d - k * DAY), p0 = m.get(d - (k + 1) * DAY); if (p1 && p0) rets.push(Math.log(p1 / p0)); }
          if (rets.length < 25) return null;
          const mu = rets.reduce((x, v) => x + v, 0) / rets.length, vol = Math.sqrt(rets.reduce((x, v) => x + (v - mu) ** 2, 0) / (rets.length - 1));
          return { c, mom: z / a - 1, vol };
        }).filter(x => x && x.mom > 0 && x.vol > 0).sort((p, q) => q.mom - p.mom).slice(0, 5);
        const inv = ranked.reduce((x, r) => x + 1 / r.vol, 0);
        ranked.forEach(r => { cur[r.c] = (1 / r.vol) / inv; });
      }
    }
    Object.keys(cur).forEach(c => { if (!closes[c].has(d)) delete cur[c]; });   // delisted: out
    W.push(Object.assign({}, cur));
  });
  return W;
}
function c2Weights(closes, days) {
  const W = [], coins = Object.keys(closes), cur = {};
  days.forEach(d => {
    const want = {};
    coins.forEach(c => {
      const m = closes[c], p = m.get(d);
      if (!p) return;
      const r = [20, 60, 120].map(k => { const q = m.get(d - k * DAY); return q ? p / q - 1 : null; });
      if (r.some(x => x === null) || (r[0] + r[1] + r[2]) / 3 <= 0) return;
      const rets = []; for (let k = 0; k < 30; k++) { const p1 = m.get(d - k * DAY), p0 = m.get(d - (k + 1) * DAY); if (p1 && p0) rets.push(Math.log(p1 / p0)); }
      if (rets.length < 25) return;
      const mu = rets.reduce((x, v) => x + v, 0) / rets.length, vol = Math.sqrt(rets.reduce((x, v) => x + (v - mu) ** 2, 0) / (rets.length - 1)) * Math.sqrt(365);
      if (vol > 0) want[c] = Math.min(0.2, (1 / coins.length) * (0.4 / vol));
    });
    const gross = Object.values(want).reduce((a, v) => a + v, 0);
    if (gross > 1) Object.keys(want).forEach(c => { want[c] /= gross; });
    Object.keys(cur).forEach(c => { if (!(c in want)) delete cur[c]; });
    Object.keys(want).forEach(c => { if (!(c in cur) || Math.abs(want[c] - cur[c]) > 0.25 * cur[c]) cur[c] = want[c]; });
    W.push(Object.assign({}, cur));
  });
  return W;
}
// Daily returns of a weight path, costs on turnover, funding on longs; trades = continuous holdings of one coin.
function simulate(closes, days, W, k, funding) {
  const ret = [], trades = [], open = {};
  for (let i = 0; i < days.length - 1; i++) {
    const w = W[i], prev = i ? W[i - 1] : {}, d = days[i], n = days[i + 1];
    let turn = 0;
    new Set(Object.keys(w).concat(Object.keys(prev))).forEach(c => { turn += Math.abs((w[c] || 0) - (prev[c] || 0)); });
    let r = -turn * k * (FEE + SLIP);
    Object.keys(prev).forEach(c => { if (!(c in w) && open[c]) { open[c].pnl -= (prev[c] || 0) * k * (FEE + SLIP); trades.push(open[c].pnl); delete open[c]; } });
    Object.keys(w).forEach(c => {
      const p0 = closes[c].get(d), p1 = closes[c].get(n), x = w[c] * ((p1 && p0 ? p1 / p0 - 1 : 0) - funding);
      r += x;
      if (!open[c]) open[c] = { pnl: -w[c] * k * (FEE + SLIP) }; else open[c].pnl -= Math.abs(w[c] - (prev[c] || 0)) * k * (FEE + SLIP);
      open[c].pnl += x;
    });
    ret.push({ t: n, r });
  }
  Object.values(open).forEach(o => trades.push(o.pnl));
  return { ret, trades };
}
// Trend 4H at 0.25% risk per trade, marked at each daily close; the trades' R for PF.
function trendDaily(k) {
  const byDay = new Map(), rs = [];
  TRENDC.forEach(c => {
    const rows = loadRows(`${c}_4h.json`); if (!rows) return;
    sources[`${c}_4h.json`] = sha(path.join(BARS, `${c}_4h.json`));
    const b = rows.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] }));
    const res = Trend.run(b, { tps: LADDER, fee: k * 0.0005, slippage: k * 0.0002 });
    const idx = new Map(b.map((x, i) => [x.time, i]));
    res.trades.filter(t => t.reason !== "end" && levLiq(t) >= 5).forEach(t => {
      rs.push({ t: t.exit_time, r: t.r * TREND_RISK });
      let last = 0;
      for (let d = Math.floor(t.entry_time / DAY) * DAY + DAY; d <= Math.floor(t.exit_time / DAY) * DAY + DAY; d += DAY) {
        let mark;
        if (d > t.exit_time) mark = t.r;
        else { const i = idx.get(d - 4 * 3600000); if (i === undefined) continue; const px = b[i].close, done = t.fills.filter(f => f.time < d);
          mark = done.reduce((a, f) => a + f.frac * t.dir * (f.px - t.entry), 0) / t.risk + (1 - done.reduce((a, f) => a + f.frac, 0)) * t.dir * (px - t.entry) / t.risk; }
        byDay.set(d, (byDay.get(d) || 0) + (mark - last) * TREND_RISK); last = mark;
      }
    });
  });
  return { ret: [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, r]) => ({ t, r })), trades: rs };
}
// ---- Metrics on a scaled daily series within [from, to).
function metrics(ret, trades, L, from, to) {
  const rr = ret.filter(x => x.t >= from && x.t < to);
  let eq = 1, peak = 1, dd = 0; const months = {};
  rr.forEach(x => { const g = L * x.r; eq *= 1 + g; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); const m = new Date(x.t).toISOString().slice(0, 7); months[m] = (months[m] || 1) * (1 + g); });
  const yrs = Math.max(1e-9, (Math.min(to, rr.length ? rr[rr.length - 1].t + DAY : to) - from) / (365.25 * DAY)), cagr = rr.length ? Math.pow(eq, 1 / yrs) - 1 : 0;
  const mv = Object.values(months), tr = trades.filter(x => (x.t || 0) >= from && (x.t || 0) < to).map(x => x.r * L);
  const gp = tr.reduce((a, v) => a + Math.max(0, v), 0), gl = tr.reduce((a, v) => a - Math.min(0, v), 0);
  const byYear = {}; rr.forEach(x => { const y = new Date(x.t).getUTCFullYear(); byYear[y] = (byYear[y] || 1) * (1 + L * x.r); });
  return { days: rr.length, cagrPct: +(100 * cagr).toFixed(2), maxDDPct: +(100 * dd).toFixed(2), mar: dd > 0 ? +(cagr / dd).toFixed(3) : null, months: mv.length,
    positiveMonthsPct: mv.length ? +(100 * mv.filter(v => v > 1).length / mv.length).toFixed(1) : null, trades: tr.length, pf: gl ? +(gp / gl).toFixed(3) : null,
    yearsPct: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, +(100 * (v - 1)).toFixed(2)])) };
}
function scaleForDD(ret, from, to, target) {   // largest L with max DD <= target over [from, to)
  let lo = 0, hi = 20;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (metrics(ret, [], mid, from, to).maxDDPct / 100 <= target) lo = mid; else hi = mid; }
  return lo;
}
// ---- Build.
const futD = daily(FUT, ""), spotD = daily(SPOT, "spot_");
const daysOf = m => [...new Set(Object.values(m).flatMap(x => [...x.keys()]))].sort((a, b) => a - b);
const fDays = daysOf(futD), sDays = daysOf(spotD);
function withTradeTimes(closes, days, W, k, funding) {   // trades carry their end time for period filtering
  const sim = simulate(closes, days, W, k, funding), times = [], open = {};
  for (let i = 0; i < days.length - 1; i++) { const w = W[i], prev = i ? W[i - 1] : {};
    Object.keys(prev).forEach(c => { if (!(c in w) && open[c] !== undefined) { times.push(days[i]); delete open[c]; } });
    Object.keys(w).forEach(c => { if (open[c] === undefined) open[c] = days[i]; }); }
  Object.keys(open).forEach(() => times.push(days[days.length - 1]));
  return { ret: sim.ret, trades: sim.trades.map((r, j) => ({ r, t: times[j] })) };
}
const W1 = c1Weights(futD, fDays, "BTCUSDT"), W2 = c2Weights(futD, fDays);
const run = k => {
  const c1 = withTradeTimes(futD, fDays, W1, k, FUND), c2 = withTradeTimes(futD, fDays, W2, k, FUND), tr = trendDaily(k);
  return { C1: c1, C2: c2, T: tr };
};
const base = run(1), dbl = run(2);
const volOf = (ret, from, to) => { const r = ret.filter(x => x.t >= from && x.t < to).map(x => x.r), m = r.reduce((a, v) => a + v, 0) / r.length; return Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (r.length - 1)); };
function blend(set, a1, aT) {   // Trend and C1 summed by day
  const m = new Map(); set.T.ret.forEach(x => m.set(x.t, (m.get(x.t) || 0) + aT * x.r)); set.C1.ret.forEach(x => m.set(x.t, (m.get(x.t) || 0) + a1 * x.r));
  return { ret: [...m.entries()].sort((p, q) => p[0] - q[0]).map(([t, r]) => ({ t, r })), trades: set.C1.trades.map(x => ({ t: x.t, r: a1 * x.r })).concat(set.T.trades.map(x => ({ t: x.t, r: aT * x.r }))) };
}
const vT = volOf(base.T.ret, SEL[0], SEL[1]), v1 = volOf(base.C1.ret, SEL[0], SEL[1]);
base.C3 = blend(base, 1 / v1, 1 / vT); dbl.C3 = blend(dbl, 1 / v1, 1 / vT);
const spot = { C1: withTradeTimes(spotD, sDays, c1Weights(spotD, sDays, "BTCUSDT"), 1, 0), C2: withTradeTimes(spotD, sDays, c2Weights(spotD, sDays), 1, 0) };
const out = { generated: new Date().toISOString(), now: new Date(NOW).toISOString(), status: "RESEARCH ONLY", sources, candidates: {} };
for (const c of ["C1", "C2", "C3"]) {
  const L = scaleForDD(base[c].ret, SEL[0], SEL[1], 0.08);
  const sp = c === "C3" ? spot.C1 : spot[c], Ls = c === "C3" ? scaleForDD(spot.C1.ret, SPOTP[0], SPOTP[1], 0.08) : scaleForDD(sp.ret, SPOTP[0], SPOTP[1], 0.08);
  out.candidates[c] = { scale: +L.toFixed(4), selection: metrics(base[c].ret, base[c].trades, L, SEL[0], SEL[1]),
    spot: metrics(sp.ret, sp.trades, Ls || 1, SPOTP[0], SPOTP[1]), spotUnscaledCagrPct: metrics(sp.ret, sp.trades, 1, SPOTP[0], SPOTP[1]).cagrPct,
    holdout: metrics(base[c].ret, base[c].trades, L, HOLD[0], HOLD[1]), holdoutX2: metrics(dbl[c].ret, dbl[c].trades, L, HOLD[0], HOLD[1]) };
}
const eligible = Object.entries(out.candidates).filter(([, v]) => v.spotUnscaledCagrPct > 0).sort((a, b) => (b[1].selection.mar || -9) - (a[1].selection.mar || -9));
out.chosen = eligible.length ? eligible[0][0] : null;
if (out.chosen) {
  const h = out.candidates[out.chosen].holdout, x2 = out.candidates[out.chosen].holdoutX2, y = h.yearsPct;
  const P = ok => ok ? "PASS" : "FAIL";
  out.gate = { ">= 200 trades": P(h.trades >= 200) + " " + h.trades, "PF >= 1.15": P(h.pf >= 1.15) + " " + h.pf, "2025 and 2026 profitable": P(y["2025"] > 0 && y["2026"] > 0) + " " + y["2025"] + "% / " + y["2026"] + "%",
    ">= 60% positive months": P(h.positiveMonthsPct >= 60) + " " + h.positiveMonthsPct + "%", "max DD <= 8%": P(h.maxDDPct <= 8) + " " + h.maxDDPct + "%",
    "positive at 2x costs": P(x2.cagrPct > 0) + " " + x2.cagrPct + "%/yr", "walk-forward": "N/A (nothing fitted; 1 of 3 chosen on 2020-2024)", "forward paper": "UNKNOWN" };
  out.passed = Object.values(out.gate).filter(v => v.startsWith("PASS")).length === 6;
}
fs.writeFileSync("career.json", JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ candidates: out.candidates, chosen: out.chosen, gate: out.gate, passed: out.passed }, null, 1));
