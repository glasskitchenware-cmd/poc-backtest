/* Unit tests of web/trend.js (Trend 4H) on hand-built 4h bars: entry, EMA200 filter, live decisions, exit by the
 * 10-bar channel, stops inside the bar and through a gap, costs. Parity with the research backtest on real data is
 * checked by research/pro. Usage: node tests/js/trend_test.js */
"use strict";
const Trend = require("../../web/trend.js");
const H4 = 4 * 3600000;
let passed = 0;
function check(ok, what) {
  if (!ok) { console.error("FAIL: " + what); process.exit(1); }
  passed++; console.log("ok - " + what);
}
function bar(i, open, close, wick) {
  const w = wick === undefined ? 0.002 : wick;
  return { time: i * H4, close_time: (i + 1) * H4 - 1, open, close, high: Math.max(open, close) * (1 + w), low: Math.min(open, close) * (1 - w) };
}
// 240 bars of a slow rise (price above EMA200, the rule goes long), a dip that ends that position, then a tight
// range with no position, then the bar under test.
function base() {
  const b = [];
  let p = 100;
  for (let i = 0; i < 240; i++) { const c = 100 * (1 + 0.001 * (i + 1)); b.push(bar(i, p, c)); p = c; }
  for (let i = 240; i < 270; i++) { const c = i === 245 ? 122 : 124 + 0.3 * Math.sin(i); b.push(bar(i, p, c)); p = c; }
  return b;
}
const last = b => b[b.length - 1].close;
const nextBar = (b, open, close, wick) => b.concat([bar(b.length, open, close, wick)]);

const flat = Trend.run(base(), { live: true });
check(flat.trades.length > 0 && !flat.pos && !flat.pend, "test setup: the rise was traded and closed; the range holds no position");

// Breakout above the 20-bar high, above EMA200 -> enter long at the next open.
const up = nextBar(base(), last(base()), 127);
let res = Trend.run(up, { live: true });
check(res.ready && res.pend && res.pend.dir === 1 && !res.pos, "close above the 20-bar high and EMA200 -> live decision: enter LONG at the next open");
check(Math.abs(res.last.stopDist - 3 * res.last.atr) < 1e-12 && res.last.tested.upper < 127, "stop distance = 3 ATR; the close was tested against the previous 20 highs");
check(Trend.run(up).trades.length === flat.trades.length, "research mode never acts on the last bar (no next open to fill at)");

// Breakdown below the 20-bar low while price is still above EMA200 -> no short; without the filter -> short.
const down = nextBar(base(), last(base()), 123.0);
check(!Trend.run(down, { live: true }).pend, "close below the 20-bar low but above EMA200 -> no SHORT (trend filter)");
check(Trend.run(down, { live: true, trend: false }).pend.dir === -1, "same bar without the EMA200 filter -> SHORT");

// Fill at the next open with slippage; the stop is 3 ATR of the signal bar and never moves.
const atrSignal = res.last.atr;
let b = nextBar(up, 127.1, 127.5);
res = Trend.run(b, { live: true });
const entry = 127.1 * 1.0002;
check(res.pos && res.pos.dir === 1 && Math.abs(res.pos.entry - entry) < 1e-12 && res.pos.entry_time === b[b.length - 1].time, "entry = next open + 0.02% slippage");
check(Math.abs(res.pos.stop - (entry - 3 * atrSignal)) < 1e-12, "stop = entry - 3 x ATR of the signal bar");
const stop = res.pos.stop;
for (let i = 0; i < 9; i++) b = nextBar(b, last(b), last(b) + 0.2);
res = Trend.run(b, { live: true });
check(res.pos && !res.pend && res.pos.stop === stop, "rising closes: position held, stop unchanged");
check(res.last.next.exitLong === Math.min(...b.slice(-10).map(x => x.low)), "exit level for the next close = lowest low of the last 10 bars");

// A close below the 10-bar low (above the stop) -> exit at the next open.
const exitLevel = res.last.next.exitLong;
check(exitLevel - stop > 1, "test setup: the exit level sits well above the stop");
const exitClose = (exitLevel + stop) / 2;
b = nextBar(b, last(b), exitClose, 0.0005);
res = Trend.run(b, { live: true });
check(res.pos && res.pend && res.pend.exit === true && res.last.tested.exitLong === exitLevel, "close below the 10-bar low -> live decision: EXIT at the next open");
b = nextBar(b, exitClose, exitClose + 0.1);
res = Trend.run(b, { live: true });
const t = res.trades[res.trades.length - 1], px = exitClose * (1 - 0.0002), risk = 3 * atrSignal;
const hours = (t.exit_time - t.entry_time) / 3600000;
const r = (px - entry) / risk - (2 * 0.0007 * entry + 0.0001 * entry * hours / 8) / risk;
check(!res.pos && t.reason === "exit" && Math.abs(t.exit - px) < 1e-12, "exit fills at the next open - 0.02% slippage");
check(Math.abs(t.r - r) < 1e-12, "R after fee+slippage both sides and funding 0.01%/8h: " + t.r.toFixed(4));

// Stop inside the bar fills at the stop; a gap through it fills at the open (worse).
const held = nextBar(up, 127.1, 127.5);
const lastTrade = bars => Trend.run(bars).trades.slice(-1)[0];
const inBar = lastTrade(nextBar(held, 127.5, 127.2, (127.2 - stop) / 127.2 + 0.001));
check(inBar.reason === "stop" && inBar.exit === stop && inBar.r < -1, "low through the stop -> closed at the stop, loss a bit over 1R after costs");
const gap = lastTrade(nextBar(held, stop - 1, stop - 0.5));
check(gap.reason === "stop_gap" && gap.exit === stop - 1 && gap.r < inBar.r, "open below the stop -> closed at the open (gap), worse than 1R");

// Research mode closes what is still open at the last close; live mode leaves it open.
check(lastTrade(held).reason === "end" && Trend.run(held, { live: true }).trades.length === flat.trades.length, "research closes at the end; live keeps the position open");

// A stop narrower than 0.2% of the price is not traded.
check(!Trend.run(nextBar(up, 127.1, 127.5), { live: true, k: 0.001 }).pos, "stop under 0.2% of the price -> no position");
console.log(`PASSED ${passed} checks`);
