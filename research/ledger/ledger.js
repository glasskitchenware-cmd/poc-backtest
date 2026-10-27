#!/usr/bin/env node
// Independent fill ledger for Trend 4H (web/trend.js), research only: no orders, no app change.
//
// PROTOCOL (fixed 2026-10-27 before any run on market data; do not edit after the first run, add a new file instead)
//  Data: Binance USD-M 4h klines and funding-rate archives, 12 coins (as the app), 2020-01 .. last full day; closed
//        bars only. All of it has been looked at before: this is historical replay, NOT an untouched out-of-sample test.
//  Rule: web/trend.js defaults + the app's ladder (TP 3R, 50%), the app's filter (leverage from the stop >= 5x).
//  1. Reconciliation: every trade is rebuilt here from the raw bars (entry at the next open, stop level, gap at the
//     open, channel exit at the next open, take profit at its level or the gapping open) with this file's own cost
//     arithmetic, for costModel "legacy" and "fills". Pass: |R(ledger) - R(trend.js)| < 1e-9 for every trade.
//  2. Funding signed from the exchange's settlements: a position pays dir x rate x notional (mark = the open of the 4h
//     bar holding the settlement) for each settlement while held: entry time < t <= the fill bar's time (a settlement
//     at a bar's open comes before any fill at that open). Model "fills+signed" = fills with this funding.
//  3. Per period (entry time): 2020-2022, 2023-2024, 2025-01..2026-09, 2026-10 onward; n, win, avg R, sum R, PF.
//  4. Cost stress: fills+signed with fee and slippage x2.
//  5. Portfolio replay 2023-01..2026-09 at 0.25% of equity risked per trade at entry: close drawdown (equity on 4h
//     closes, open positions marked to the close) and an intrabar bound (every open position at its bar's adverse
//     extreme at once), share of positive calendar months, peak open risk (heat) and peak open positions.
//  6. Gate (the locked criteria in research/hourly): untouched OOS >= 200 trades; net PF >= 1.15; two non-overlapping
//     periods profitable; >= 60% positive months; close DD <= 8% with the intrabar bound reported; positive at 2x
//     execution costs; purged walk-forward; forward paper. Items this file cannot test are UNKNOWN, never PASS.
// Usage: node ledger.js COINS NOW_MS   (bars and funding from ../evidence/bars). Writes ledger.json, fills.csv.
"use strict";
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const TREND_JS = process.env.TREND_JS || path.resolve(__dirname, "../../web/trend.js"), Trend = require(TREND_JS);
const COINS = process.argv[2].split(","), NOW = +process.argv[3] || Date.now();
const H = 3600000, DAY = 86400000, Y = y => Date.UTC(y, 0, 1), END_EVIDENCE = Date.UTC(2026, 9, 1), MMR_SAFE = 0.01, RISK = 0.0025;
const LADDER = [{ r: 3, frac: 0.5 }], D = Trend.DEFAULTS;
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const BARDIR = process.env.BARS || path.resolve(__dirname, "../evidence/bars");

// ---- 1. Independent rebuild of one trade from raw bars (no use of trade.entry/exit/fills prices or trade.cost).
// Only the trade's side, entry and exit bar indexes, exit reason and stop distance (trade.risk) are taken from trend.js.
function rebuild(b, t, model, c) {
  const d = t.dir, s = c.slippage, entry = b[t.entry_index].open * (1 + d * s), risk = t.risk, stop = entry - d * risk;
  // Take profits fill in bars the position is open and not stopped; a channel exit leaves at the exit bar's open.
  const lastTpBar = t.reason === "exit" ? t.exit_index - 1 : t.exit_index, parts = [];
  let left = 1, k = t.entry_index;
  for (const tp of c.tps) {
    const level = entry + d * tp.r * risk;
    let filled = false;
    for (; k <= lastTpBar; k++) {
      const x = b[k];
      if (d > 0 ? x.open <= stop || x.low <= stop : x.open >= stop || x.high >= stop) break;   // stop first
      if (d > 0 ? x.high >= level : x.low <= level) {
        const raw = (d > 0 ? x.open >= level : x.open <= level) ? x.open : level;
        parts.push({ frac: tp.frac, raw, px: raw, time: x.time, fee: c.tpFee, tp: true });
        left -= tp.frac; filled = true;
        break;   // the next target may fill in the same bar
      }
    }
    if (!filled) break;
  }
  if (left > 1e-12) {
    const x = b[t.exit_index], raw = { exit: x.open, stop_gap: x.open, stop: stop, end: x.close }[t.reason];
    if (raw === undefined) throw new Error("trade " + t.entry_time + ": reason " + t.reason + " with " + left + " of the position left");
    const slip = model === "fills" ? t.reason !== "end" : t.reason === "exit";   // legacy puts slippage only in the channel exit's price
    parts.push({ frac: left, raw, px: slip ? raw * (1 - d * s) : raw, time: x.time, fee: c.fee, tp: false });
  }
  const t0 = b[t.entry_index].time;
  const move = parts.reduce((a, p) => a + p.frac * d * (p.px - entry), 0);
  const fee = model === "legacy" ? 2 * (c.fee + s) * entry : c.fee * entry + parts.reduce((a, p) => a + p.fee * p.frac * p.px, 0);
  const fund = c.funding === "signed" ? signedFunding(c.rates, d, t0, parts, c.markAt)
    : c.funding * entry * parts.reduce((a, p) => a + p.frac * (p.time - t0) / H, 0) / 8;
  return { r: (move - fee - fund) / risk, entry, parts, feeQ: fee, fundQ: fund, risk };
}
// Funding paid (positive) or received (negative) in quote per unit of position, from exchange settlements: each part
// is held at settlement t when entry time < t <= its fill bar's time (a settlement at a bar's open comes before any
// fill at that open). Mark = the open of the 4h bar holding t.
function signedFunding(rates, d, t0, parts, markAt) {
  let q = 0;
  for (const p of parts) for (const [t, rate] of rates) {
    if (t <= t0) continue;
    if (t > p.time) break;
    const mark = markAt(t);
    if (mark) q += d * rate * mark * p.frac;
  }
  return q;
}

// ---- Data.
const data = {};
for (const c of COINS) {
  const pb = path.join(BARDIR, `${c}_4h.json`), pf = path.join(BARDIR, `${c}_funding.json`);
  if (!fs.existsSync(pb)) continue;
  const bars = JSON.parse(fs.readFileSync(pb, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], close_time: r[6] })).filter(x => x.close_time < NOW);
  const rates = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, "utf8")) : [];
  const openAt = new Map(bars.map(x => [x.time, x.open]));
  data[c] = { bars, rates, markAt: t => openAt.get(t - (t % (4 * H))), shaBars: sha(pb), shaFunding: fs.existsSync(pf) ? sha(pf) : null };
}
const MODELS = {
  legacy: { costModel: "legacy", fee: D.fee, slippage: D.slippage, funding: D.funding },
  fills: { costModel: "fills", fee: D.fee, slippage: D.slippage, funding: D.funding },
  "fills+signed": { costModel: "fills", fee: D.fee, slippage: D.slippage, funding: "signed" },
  "fills+signed x2": { costModel: "fills", fee: 2 * D.fee, slippage: 2 * D.slippage, funding: "signed" }
};
const all = {}, recon = {}, csv = ["model,coin,side,entry_time,exit_time,reason,risk,fill_frac,fill_raw,fill_px,fill_time,market,r_trendjs,r_ledger,fee_q,funding_q"];
const iso = t => new Date(t).toISOString().replace(".000Z", "Z");
for (const [name, m] of Object.entries(MODELS)) {
  all[name] = []; recon[name] = { trades: 0, maxAbsDiff: 0, scope: m.funding === "signed" ? "prices and fees (funding comes from the ledger only)" : "prices, fees and funding" };
  for (const [c, dt] of Object.entries(data)) {
    const opt = { tps: LADDER, costModel: m.costModel, fee: m.fee, slippage: m.slippage, funding: m.funding === "signed" ? 0 : m.funding };
    for (const t of Trend.run(dt.bars, opt).trades) {
      if (t.reason === "end" || levLiq(t) < 5) continue;
      const L = rebuild(dt.bars, t, m.costModel, { fee: m.fee, tpFee: m.fee, slippage: m.slippage, tps: LADDER, funding: m.funding, rates: dt.rates, markAt: dt.markAt });
      // trend.js funding is turned off for the signed model, so its R plus the ledger's funding must match.
      const rLedger = L.r, rTrend = m.funding === "signed" ? t.r - L.fundQ / L.risk : t.r;
      recon[name].trades++; recon[name].maxAbsDiff = Math.max(recon[name].maxAbsDiff, Math.abs(rLedger - rTrend));
      all[name].push({ coin: c, dir: t.dir, entry_time: t.entry_time, exit_time: t.exit_time, r: rLedger, risk: t.risk, entry: L.entry, parts: L.parts, entry_index: t.entry_index, exit_index: t.exit_index, fundR: L.fundQ / L.risk });
      if (name !== "fills+signed x2") L.parts.forEach(p => csv.push([name, c, t.dir > 0 ? "LONG" : "SHORT", iso(t.entry_time), iso(t.exit_time), t.reason, t.risk, p.frac, p.raw, p.px, iso(p.time), !p.tp, t.r.toFixed(6), rLedger.toFixed(6), L.feeQ.toFixed(8), L.fundQ.toFixed(8)].join(",")));
    }
  }
}
// ---- 3. Per period.
const S = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const sum = tr.reduce((a, t) => a + t.r, 0), gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
  return { n, win: +(100 * tr.filter(t => t.r > 0).length / n).toFixed(1), avgR: +(sum / n).toFixed(4), sumR: +sum.toFixed(2), pf: gl ? +(gp / gl).toFixed(3) : null };
};
const PERIODS = { "2020-2022": [Y(2020), Y(2023)], "2023-2024": [Y(2023), Y(2025)], "2025-01..2026-09": [Y(2025), END_EVIDENCE], "2026-10 on": [END_EVIDENCE, Infinity], "2023-01..2026-09": [Y(2023), END_EVIDENCE] };
const periods = {};
for (const [name, tr] of Object.entries(all)) periods[name] = Object.fromEntries(Object.entries(PERIODS).map(([p, [a, z]]) => [p, S(tr.filter(t => t.entry_time >= a && t.entry_time < z))]));
// ---- 5. Portfolio replay on the 4h grid.
function portfolio(tr, from, to) {
  const trades = tr.filter(t => t.entry_time >= from && t.entry_time < to).sort((a, b) => a.entry_time - b.entry_time);
  const times = [...new Set(Object.values(data).flatMap(d => d.bars.map(x => x.time)).filter(t => t >= from && t < to + 60 * DAY))].sort((a, b) => a - b);
  const barOf = {}; for (const [c, d] of Object.entries(data)) barOf[c] = new Map(d.bars.map(x => [x.time, x]));
  let eq = 1, peak = 1, dd = 0, ddIntra = 0, k = 0, heatMax = 0, openMax = 0;
  const open = [], months = {};
  for (const t of times) {
    while (k < trades.length && trades[k].entry_time <= t) { const x = trades[k++]; open.push(Object.assign({ stake: eq * RISK }, x)); }
    let mClose = 0, mAdverse = 0;
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i], bar = barOf[p.coin].get(t);
      if (p.exit_time <= t) {   // closed at this bar's time: realise R
        eq += p.stake * p.r; const mk = iso(p.exit_time).slice(0, 7); months[mk] = (months[mk] || 0) + p.stake * p.r; open.splice(i, 1); continue;
      }
      if (!bar) continue;
      const done = p.parts.filter(q => q.tp && q.time <= t), leftFrac = 1 - done.reduce((a, q) => a + q.frac, 0);
      const locked = done.reduce((a, q) => a + q.frac * p.dir * (q.px - p.entry), 0);
      const at = px => (locked + leftFrac * p.dir * (px - p.entry)) / p.risk * p.stake;
      mClose += at(bar.close); mAdverse += at(p.dir > 0 ? bar.low : bar.high);
    }
    heatMax = Math.max(heatMax, open.reduce((a, p) => a + p.stake, 0) / eq); openMax = Math.max(openMax, open.length);
    const eClose = eq + mClose, eLow = eq + mAdverse;
    peak = Math.max(peak, eClose); dd = Math.max(dd, 1 - eClose / peak); ddIntra = Math.max(ddIntra, 1 - eLow / peak);
  }
  const mv = Object.values(months);
  return { trades: trades.length, endEquity: +eq.toFixed(4), closeDDPct: +(100 * dd).toFixed(2), intrabarDDBoundPct: +(100 * ddIntra).toFixed(2),
    months: mv.length, positiveMonthsPct: mv.length ? +(100 * mv.filter(v => v > 0).length / mv.length).toFixed(1) : null, peakHeatPct: +(100 * heatMax).toFixed(2), peakOpen: openMax };
}
const port = Object.fromEntries(Object.keys(MODELS).map(m => [m, portfolio(all[m], Y(2023), END_EVIDENCE)]));
// ---- 6. Gate on fills+signed, 2023-01..2026-09 (historical, already seen).
const P = periods["fills+signed"], X = periods["fills+signed x2"], G = port["fills+signed"];
const gate = {
  "untouched OOS >= 200 trades": "UNKNOWN (none exists: all of 2020-2026 has been looked at)",
  "net PF >= 1.15": (P["2023-01..2026-09"].pf >= 1.15 ? "PASS " : "FAIL ") + P["2023-01..2026-09"].pf,
  "two non-overlapping periods profitable": (P["2023-2024"].sumR > 0 && P["2025-01..2026-09"].sumR > 0 ? "PASS " : "FAIL ") + P["2023-2024"].sumR + "R / " + P["2025-01..2026-09"].sumR + "R",
  ">= 60% positive months": (G.positiveMonthsPct >= 60 ? "PASS " : "FAIL ") + G.positiveMonthsPct + "%",
  "close DD <= 8% (0.25% risk)": (G.closeDDPct <= 8 ? "PASS " : "FAIL ") + G.closeDDPct + "% (intrabar bound " + G.intrabarDDBoundPct + "%)",
  "positive at 2x execution costs": (X["2023-01..2026-09"].sumR > 0 ? "PASS " : "FAIL ") + X["2023-01..2026-09"].avgR + "R/trade",
  "purged walk-forward": "UNKNOWN (not run here)",
  "forward paper": "UNKNOWN (no forward record)"
};
const out = {
  generated: new Date().toISOString(), now: iso(NOW), status: "RESEARCH ONLY - historical replay, not untouched OOS",
  sources: { trendJs: sha(TREND_JS), ledgerJs: sha(__filename), coins: Object.fromEntries(Object.entries(data).map(([c, d]) => [c, { bars: d.bars.length, first: iso(d.bars[0].time), last: iso(d.bars[d.bars.length - 1].time), funding: d.rates.length, shaBars: d.shaBars, shaFunding: d.shaFunding }])) },
  counts: { coins: Object.keys(data).length, randomDraws: 0, seed: null, note: "deterministic; no bootstrap, Monte Carlo or permutation" },
  reconciliation: recon, periods, portfolio: port, gate
};
fs.writeFileSync("ledger.json", JSON.stringify(out, null, 1) + "\n");
fs.writeFileSync("fills.csv", csv.join("\n") + "\n");
console.log(JSON.stringify({ reconciliation: recon, periods: Object.fromEntries(Object.entries(periods).map(([m, p]) => [m, p["2023-01..2026-09"]])), portfolio: port, gate }, null, 1));
