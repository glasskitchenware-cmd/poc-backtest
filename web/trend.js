/* Trend 4H: Donchian channel breakout, long and short, one position per coin (research/pro/pro.js,
 * "Donchian 4h 20/10 stop 3ATR +EMA200", chosen walk-forward). research/pro runs this file next to its own
 * backtest and fails unless both give identical trades.
 * Entry: a 4h close above the highest high (below the lowest low) of the previous 20 bars, on the side of EMA200.
 * Stop: 3 x ATR(20) from the entry, never moved. Exit: a 4h close below the lowest low (above the highest high)
 * of the previous 10 bars. No fixed take profit. Signals on a closed bar fill at the next open; the stop is
 * checked inside the bar and a gap through it fills at the open. Costs: fee + slippage per side, funding always paid.
 * Optional scale-out (opt.tps = [{r, frac}], fractions summing to less than 1): part of the position is sold at
 * entry + r x risk; the rest still leaves by the stop or the channel, so entries are the same as without it. When a bar
 * touches both the stop and a take profit, the stop is assumed to come first.
 * Take profits must be strictly ascending in r (> 0), each fraction in (0, 1], fractions summing to at most 1; anything
 * else throws. When they sum to 1 the trade closes at the last take profit (reason "tp").
 * Optional opt.beAfterTp (research only, off by default): once the first take profit fills, the stop of the rest moves to
 * entry + beAfterTp x risk from the next bar on.
 * opt.costModel: "legacy" (default, kept for parity with research/pro): slippage inside the entry and channel-exit prices
 * and charged again as 2 x slippage x entry, fees on the entry notional for both sides. "fills" (research): every market
 * fill (entry, channel exit, stop, gap) carries slippage once in its price, take profits fill at their level (limit),
 * fees are paid on each fill's own notional (opt.tpFee for take profits, default opt.fee); funding as in legacy.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Trend = factory();
})(this, function () {
  "use strict";

  var DEFAULTS = { n: 20, m: 10, k: 3, atrN: 20, emaN: 200, trend: true, fee: 0.0005, slippage: 0.0002, funding: 0.0001, minStopFrac: 0.002 };
  var H = 3600000, EPS = 1e-12;

  function checkTps(tps) {
    if (!Array.isArray(tps)) throw new Error("tps must be an array");
    var sum = 0;
    tps.forEach(function (t, k) {
      if (!t || !isFinite(t.r) || !(t.r > 0)) throw new Error("tps[" + k + "].r must be a finite number above 0");
      if (!isFinite(t.frac) || !(t.frac > 0) || t.frac > 1) throw new Error("tps[" + k + "].frac must be in (0, 1]");
      if (k && !(t.r > tps[k - 1].r)) throw new Error("tps must be strictly ascending in r (tps[" + k + "])");
      sum += t.frac;
    });
    if (sum > 1 + EPS) throw new Error("tps fractions sum to " + sum + ", more than 1");
  }

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
    var tps = o.tps || [];
    checkTps(tps);
    if (o.costModel == null) o.costModel = "legacy";
    if (o.costModel !== "legacy" && o.costModel !== "fills") throw new Error("unknown costModel " + o.costModel);
    var fills = o.costModel === "fills", tpFee = o.tpFee != null ? o.tpFee : o.fee;
    // A market exit's fill: in "fills" every market exit carries slippage; in legacy only the channel exit does.
    function marketExit(px, dir, reason) { return fills || reason === "exit" ? px * (1 - dir * o.slippage) : px; }
    function closeFills(i, px, reason) {
      var risk = pos.risk, hours = (b[i].time - pos.entry_time) / H, d = pos.dir, s = o.slippage;
      var rawEntry = pos.entry / (1 + d * s), rawPx = reason === "tp" ? px : px / (1 - d * s);
      var move = pos.left * d * (px - pos.entry), raw = pos.left * d * (rawPx - rawEntry), fee = o.fee * pos.entry + o.fee * pos.left * px, fH = pos.left * hours;
      pos.fills.forEach(function (f) { move += f.frac * d * (f.px - pos.entry); raw += f.frac * d * (f.px - rawEntry); fee += tpFee * f.frac * f.px; fH += f.frac * f.hours; });
      var fund = o.funding * pos.entry * fH / 8, r = (move - fee - fund) / risk;
      trades.push({ dir: d, entry: pos.entry, stop: pos.stop, risk: risk, entry_time: pos.entry_time, entry_index: pos.entry_index,
        exit: px, exit_time: b[i].time, exit_index: i, reason: reason, r: r, mfeR: d * (pos.best - pos.entry) / risk, tpHit: pos.fills.length, fills: pos.fills,
        cost: { model: "fills", grossR: raw / risk, slipInPriceR: 0, feeR: fee / risk, slipR: (raw - move) / risk, fundR: fund / risk } });
      pos = null;
    }
    function close(i, px, reason) {
      if (fills) return closeFills(i, px, reason);
      var risk = pos.risk, hours = (b[i].time - pos.entry_time) / H, r;
      if (!pos.fills.length) r = pos.dir * (px - pos.entry) / risk - (2 * (o.fee + o.slippage) * pos.entry + o.funding * pos.entry * hours / 8) / risk;
      else {
        var gross = pos.left * pos.dir * (px - pos.entry) / risk, fundH = pos.left * hours;
        pos.fills.forEach(function (f) { gross += f.frac * pos.dir * (f.px - pos.entry) / risk; fundH += f.frac * f.hours; });
        r = gross - (2 * (o.fee + o.slippage) * pos.entry + o.funding * pos.entry * fundH / 8) / risk;
      }
      // Where r goes, in R of the initial risk: the move on prices before slippage, the slippage already inside the fill
      // prices (entry; channel exit), the fee, the slippage charged again as a cost, and funding. r = gross - the rest.
      var rawEntry = pos.entry / (1 + pos.dir * o.slippage), rawPx = reason === "exit" ? px / (1 - pos.dir * o.slippage) : px, rawGross = pos.left * pos.dir * (rawPx - rawEntry) / risk, fH = pos.left * hours;
      pos.fills.forEach(function (f) { rawGross += f.frac * pos.dir * (f.px - rawEntry) / risk; fH += f.frac * f.hours; });
      var feeR = 2 * o.fee * pos.entry / risk, slipR = 2 * o.slippage * pos.entry / risk, fundR = o.funding * pos.entry * fH / 8 / risk;
      trades.push({ dir: pos.dir, entry: pos.entry, stop: pos.stop, risk: risk, entry_time: pos.entry_time, entry_index: pos.entry_index,
        exit: px, exit_time: b[i].time, exit_index: i, reason: reason, r: r, mfeR: pos.dir * (pos.best - pos.entry) / risk, tpHit: pos.fills.length, fills: pos.fills,
        cost: { grossR: rawGross, slipInPriceR: rawGross - (r + feeR + slipR + fundR), feeR: feeR, slipR: slipR, fundR: fundR } });
      pos = null;
    }
    for (var i = warm; i < n; i++) {
      var x = b[i];
      if (pend) {
        if (pend.exit && pos) { pos.best = pos.dir > 0 ? Math.max(pos.best, x.open) : Math.min(pos.best, x.open); close(i, marketExit(x.open, pos.dir, "exit"), "exit"); }
        if (pend.dir && !pos) {
          var entry = x.open * (1 + pend.dir * o.slippage), risk = o.k * A[i - 1];
          if (risk > 0 && risk / entry >= o.minStopFrac) {
            pos = { dir: pend.dir, entry: entry, risk: risk, stop: entry - pend.dir * risk, entry_time: x.time, entry_index: i, best: entry, left: 1, fills: [] };
          }
        }
        pend = null;
      }
      if (pos) {
        if (pos.dir > 0 ? x.open <= pos.stop : x.open >= pos.stop) { close(i, marketExit(x.open, pos.dir, "stop_gap"), "stop_gap"); continue; }
        if (pos.dir > 0 ? x.low <= pos.stop : x.high >= pos.stop) { close(i, marketExit(pos.stop, pos.dir, "stop"), "stop"); continue; }
        // Not stopped in this bar: its best price counts (MFE), and take profits it reached are filled (a gap at the open).
        pos.best = pos.dir > 0 ? Math.max(pos.best, x.high) : Math.min(pos.best, x.low);
        while (pos.fills.length < tps.length) {
          var t = tps[pos.fills.length], level = pos.entry + pos.dir * t.r * pos.risk;
          if (pos.dir > 0 ? x.high < level : x.low > level) break;
          var fill = (pos.dir > 0 ? x.open >= level : x.open <= level) ? x.open : level;
          pos.fills.push({ px: fill, frac: t.frac, hours: (x.time - pos.entry_time) / H, time: x.time });
          pos.left -= t.frac;
        }
        // Fully scaled out: the trade ends at the last take profit, not at a later stop or channel exit.
        if (pos.fills.length && pos.left <= EPS) { pos.left = 0; close(i, pos.fills[pos.fills.length - 1].px, "tp"); continue; }
        if (o.beAfterTp != null && pos.fills.length) {
          var moved = pos.entry + pos.dir * o.beAfterTp * pos.risk;
          if (pos.dir > 0 ? moved > pos.stop : moved < pos.stop) pos.stop = moved;
        }
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
