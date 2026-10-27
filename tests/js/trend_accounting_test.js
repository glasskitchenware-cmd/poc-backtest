#!/usr/bin/env node
// web/trend.js accounting and TP-config regression tests (research/hourly 2026-10-27 findings), synthetic bars only.
// Each expectation is computed here from the raw bar prices, not from trend.js internals (only trade.risk, the stop
// distance, and the entry/exit bar indexes are taken from the trade). Run: node tests/js/trend_accounting_test.js
"use strict";
const path = require("path");
const Trend = require(path.resolve(__dirname, "../../web/trend.js"));
let passed = 0, failed = 0;
function check(ok, what) { if (ok) { passed++; console.log("ok - " + what); } else { failed++; console.log("FAIL - " + what); } }
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const H4 = 4 * 3600000, T0 = Date.UTC(2026, 0, 1);

// 230 flat bars at 100; bar 220 closes 104 above the 5-bar high (a LONG signal), entry at bar 221's open.
// shape(i, bar) may change any later bar.
function bars(shape) {
  const a = [];
  for (let i = 0; i < 230; i++) {
    let x = { time: T0 + i * H4, open: 100, high: 100.5, low: 99.5, close: 100 };
    if (i === 220) x = Object.assign(x, { high: 104.5, close: 104 });
    if (i >= 221) x = Object.assign(x, { open: 104, high: 104.5, low: 103.5, close: 104 });
    if (shape) x = shape(i, x) || x;
    a.push(x);
  }
  return a;
}
const BASE = { trend: false, n: 5, m: 5, k: 1, atrN: 3, emaN: 3, minStopFrac: 0, fee: 0, slippage: 0, funding: 0 };
const throws = (opt, what) => { let e = null; try { Trend.run(bars(), Object.assign({}, BASE, opt)); } catch (err) { e = err; } check(!!e, what + (e ? " (" + e.message + ")" : " (accepted)")); };

// 1. Invalid take-profit configurations are refused, not silently simulated.
throws({ tps: [{ r: 2, frac: 0.3 }, { r: 1, frac: 0.3 }] }, "tps out of order (2R before 1R) is refused");
throws({ tps: [{ r: 1, frac: 0.6 }, { r: 2, frac: 0.6 }] }, "tps fractions summing to 1.2 are refused");
throws({ tps: [{ r: 1, frac: -0.2 }] }, "a negative tps fraction is refused");
throws({ tps: [{ r: 1, frac: 0 }] }, "a zero tps fraction is refused");
throws({ tps: [{ r: 1, frac: 0.3 }, { r: 1, frac: 0.3 }] }, "a duplicate tps target is refused");
throws({ tps: [{ r: NaN, frac: 0.3 }] }, "a NaN tps target is refused");
throws({ tps: [{ r: 1, frac: Infinity }] }, "an infinite tps fraction is refused");
throws({ tps: [{ r: 0, frac: 0.3 }] }, "a tps target at 0R is refused");
let ok = true; try { Trend.run(bars(), Object.assign({}, BASE, { tps: [{ r: 3, frac: 0.5 }] })); } catch (e) { ok = false; }
check(ok, "the app's ladder (3R, 50%) is accepted");

// 2. A full scale-out (fractions summing to 1) closes the position at the last take profit, not at a later stop.
const full = { tps: [{ r: 1, frac: 0.5 }, { r: 2, frac: 0.5 }] };
const up = (i, x) => i === 221 ? Object.assign(x, { high: 115, close: 110 }) : i > 221 ? Object.assign(x, { open: 110, high: 110.5, low: 109.5, close: 110 }) : x;
const live = Trend.run(bars(up), Object.assign({}, BASE, full, { live: true }));
check(live.trades.length === 1 && !live.pos, "full scale-out: the trade closes when the last take profit fills (no open position left)");
const ft = live.trades[0];
check(ft && ft.reason === "tp" && ft.exit_index === 221 && ft.tpHit === 2, "full scale-out: exit reason 'tp' at the bar of the last fill");
check(ft && near(ft.r, 0.5 * 1 + 0.5 * 2), "full scale-out with zero costs: R = 0.5 x 1R + 0.5 x 2R = 1.5");
const gap = (i, x) => (up(i, x), i >= 225 ? Object.assign(x, { open: 90, high: 91, low: 89, close: 90 }) : x);
const later = Trend.run(bars(gap), Object.assign({}, BASE, full)).trades;
check(later.length >= 1 && later[0].reason === "tp" && later[0].exit_index === 221, "full scale-out: no phantom 'stop_gap' exit days later");

// 3. costModel "fills": slippage once, inside each market fill; fees on each fill's executed notional.
// Entry at bar 221 open (104) + slippage, stop about 101.7; channel exit: bar 228 closes at 102.5, below the 5-bar low
// (103.5) but above the stop, exit at bar 229's open (102).
const drop = (i, x) => i === 228 ? Object.assign(x, { low: 102, close: 102.5 }) : i === 229 ? Object.assign(x, { open: 102, high: 102.5, low: 101.8, close: 102 }) : x;
const f = 0.0005, s = 0.0002, fund = 0.0001;
function one(shape, opt) { const t = Trend.run(bars(shape), Object.assign({}, BASE, opt)).trades; return t[0]; }
let t = one(drop, { fee: f, slippage: s, funding: 0, costModel: "fills" });
let eIn = 104 * (1 + s), eOut = 102 * (1 - s);
check(t && t.reason === "exit" && near(t.entry, eIn) && near(t.exit, eOut), "fills: entry and channel exit carry slippage once in their prices");
check(t && near(t.r, ((eOut - eIn) - f * eIn - f * eOut) / t.risk), "fills: R = price move - fee on entry notional - fee on exit notional (no second slippage charge)");
check(t && near(t.cost.grossR - t.cost.feeR - t.cost.slipR - t.cost.fundR, t.r) && near(t.cost.slipR, (104 * s + 102 * s) / t.risk),
  "fills: cost breakdown adds up (gross before slippage - fee - slippage - funding = R) and slippage is counted once per side");
// Stop: bar 223 trades down through the stop; stop-market fills at the stop less slippage.
const stopHit = (i, x) => i === 223 ? Object.assign(x, { low: 90, close: 95 }) : x;
t = one(stopHit, { fee: f, slippage: s, funding: 0, costModel: "fills" });
const stopPx = t ? t.stop * (1 - s) : NaN;
check(t && t.reason === "stop" && near(t.exit, stopPx) && near(t.r, ((stopPx - t.entry) - f * t.entry - f * stopPx) / t.risk), "fills: a stop fills at the stop less slippage, fees on both fills");
// Gap through the stop: fills at the open less slippage.
const gapStop = (i, x) => i === 223 ? Object.assign(x, { open: 95, high: 95.5, low: 94.5, close: 95 }) : x;
t = one(gapStop, { fee: f, slippage: s, funding: 0, costModel: "fills" });
check(t && t.reason === "stop_gap" && near(t.exit, 95 * (1 - s)), "fills: a gap through the stop fills at the open less slippage");
// Partial take profit (limit order at the level, no slippage) then the rest by the channel exit.
const tpThenDrop = (i, x) => i === 222 ? Object.assign(x, { high: 120 }) : drop(i, x);
t = one(tpThenDrop, { fee: f, slippage: s, funding: 0, costModel: "fills", tps: [{ r: 1, frac: 0.5 }] });
const tpPx = t ? t.entry + t.risk : NaN;
check(t && t.tpHit === 1 && near(t.fills[0].px, tpPx) && near(t.r, (0.5 * (tpPx - t.entry) + 0.5 * (eOut - t.entry) - f * t.entry - f * 0.5 * tpPx - f * 0.5 * eOut) / t.risk),
  "fills: a partial take profit fills at its level; fees on each part's own notional");
// Funding: entry notional x rate per 8 hours held, per part.
t = one(drop, { fee: 0, slippage: 0, funding: fund, costModel: "fills" });
const hrs = t ? (t.exit_time - t.entry_time) / 3600000 : NaN;
check(t && near(t.r, (102 - 104 - fund * 104 * hrs / 8) / t.risk) && near(t.cost.fundR, fund * 104 * hrs / 8 / t.risk), "fills: funding = entry notional x rate x hours / 8, always paid");

// 4. The default (legacy) accounting is unchanged: slippage in prices and again as a cost (more conservative).
t = one(drop, { fee: f, slippage: s, funding: 0 });
check(t && near(t.r, ((102 * (1 - s)) - eIn - 2 * (f + s) * eIn) / t.risk), "default cost model unchanged: legacy R (slippage counted twice) kept for parity with research/pro");
const legacy = t ? t.r : NaN, fills = one(drop, { fee: f, slippage: s, funding: 0, costModel: "fills" });
check(fills && fills.r > legacy && near(fills.r - legacy, (2 * (f + s) * eIn - f * eIn - f * eOut) / fills.risk),
  "the difference between the two models is exactly the second slippage charge and the exit fee basis");
throws({ costModel: "maker" }, "an unknown cost model is refused");

console.log(failed ? `FAILED ${failed} of ${passed + failed} checks` : `PASSED ${passed} checks`);
process.exit(failed ? 1 : 0);
