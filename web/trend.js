/* Trend 4H: Donchian channel breakout, long and short, one position per coin (research/pro/pro.js,
 * "Donchian 4h 20/10 stop 3ATR +EMA200", chosen walk-forward). research/pro runs this file next to its own
 * backtest and fails unless both give identical trades.
 * Entry: a 4h close above the highest high (below the lowest low) of the previous 20 bars, on the side of EMA200.
 * Stop: 3 x ATR(20) from the entry, never moved. Exit: a 4h close below the lowest low (above the highest high)
 * of the previous 10 bars. No fixed take profit. Signals on a closed bar fill at the next open; the stop is
 * checked inside the bar and a gap through it fills at the open. Costs: fee + slippage per side, funding always paid.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Trend = factory();
})(this, function () {
  "use strict";

  var DEFAULTS = { n: 20, m: 10, k: 3, atrN: 20, emaN: 200, trend: true, fee: 0.0005, slippage: 0.0002, funding: 0.0001, minStopFrac: 0.002 };
  var H = 3600000;

  function ema(xs, n) { var a = 2 / (n + 1), y = NaN; return xs.map(function (x, i) { return (y = i ? y + a * (x - y) : x); }); }
  function atr(b, n) {
    var a = NaN;
    return b.map(function (x, i) {
      var tr = i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low;
      return (a = i < n ? (i ? (a * i + tr) / (i + 1) : tr) : a + (tr - a) / n);
    });
  }
  function rollMax(xs, n, i) { var m = -Infinity; for (var k = i - n; k < i; k++) m = Math.max(m, xs[k]); return m; }
  function rollMin(xs, n, i) { var m = Infinity; for (var k = i - n; k < i; k++) m = Math.min(m, xs[k]); return m; }

  // bars: closed candles {time, open, high, low, close}. With opt.live the last bar is evaluated too and an open
  // position is left open, so `pend` is the decision for the bar that opens next: {dir} enter, {exit} close.
  function run(bars, opt) {
    var o = Object.assign({}, DEFAULTS, opt || {}), b = bars, n = b.length;
    var A = atr(b, o.atrN), C = b.map(function (x) { return x.close; }), Hh = b.map(function (x) { return x.high; }), Ll = b.map(function (x) { return x.low; });
    var e200 = ema(C, o.emaN), warm = Math.max(210, o.n + 2, o.m + 2), trades = [], pos = null, pend = null;
    function close(i, px, reason) {
      var risk = pos.risk, hours = (b[i].time - pos.entry_time) / H;
      var r = pos.dir * (px - pos.entry) / risk - (2 * (o.fee + o.slippage) * pos.entry + o.funding * pos.entry * hours / 8) / risk;
      trades.push({ dir: pos.dir, entry: pos.entry, stop: pos.stop, risk: risk, entry_time: pos.entry_time, entry_index: pos.entry_index,
        exit: px, exit_time: b[i].time, exit_index: i, reason: reason, r: r });
      pos = null;
    }
    for (var i = warm; i < n; i++) {
      var x = b[i];
      if (pend) {
        if (pend.exit && pos) close(i, x.open * (1 - pos.dir * o.slippage), "exit");
        if (pend.dir && !pos) {
          var entry = x.open * (1 + pend.dir * o.slippage), risk = o.k * A[i - 1];
          if (risk > 0 && risk / entry >= o.minStopFrac) pos = { dir: pend.dir, entry: entry, risk: risk, stop: entry - pend.dir * risk, entry_time: x.time, entry_index: i };
        }
        pend = null;
      }
      if (pos) {
        if (pos.dir > 0 ? x.open <= pos.stop : x.open >= pos.stop) { close(i, x.open, "stop_gap"); continue; }
        if (pos.dir > 0 ? x.low <= pos.stop : x.high >= pos.stop) { close(i, pos.stop, "stop"); continue; }
      }
      if (i + 1 >= n && !o.live) break;
      if (pos) {
        if (pos.dir > 0 ? x.close < rollMin(Ll, o.m, i) : x.close > rollMax(Hh, o.m, i)) pend = { exit: true };
        continue;
      }
      var dir = 0;
      if (x.close > rollMax(Hh, o.n, i)) dir = 1; else if (x.close < rollMin(Ll, o.n, i)) dir = -1;
      if (dir && o.trend && (dir > 0 ? x.close < e200[i] : x.close > e200[i])) dir = 0;
      if (dir) pend = { dir: dir };
    }
    if (!o.live) {
      if (pos) close(n - 1, b[n - 1].close, "end");
      return { trades: trades };
    }
    // Channel levels the last close was tested against, and the ones the next close will be tested against.
    var levels = function (i) { return { upper: rollMax(Hh, o.n, i), lower: rollMin(Ll, o.n, i), exitLong: rollMin(Ll, o.m, i), exitShort: rollMax(Hh, o.m, i) }; };
    return { trades: trades, pos: pos, pend: pend, ready: n > warm,
      last: n > warm ? { atr: A[n - 1], stopDist: o.k * A[n - 1], ema: e200[n - 1], tested: levels(n - 1), next: levels(n) } : null };
  }

  return { DEFAULTS: DEFAULTS, run: run, ema: ema, atr: atr };
});
