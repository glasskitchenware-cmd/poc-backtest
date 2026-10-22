/* Swing (4H) backtest of the user's own techniques, operationalised as fixed rules.
 * Source: Trading_Techniques_6_Folders_Original.text (TL-01..TL-07 transcript, Inside Bar 4H,
 * Fibonacci, Breakout + Pullback, Double Bottom). These are proxies, not the teacher's exact rules.
 * Long-only Spot. Signal on a closed bar, entry at the next open, stop checked before target
 * inside a bar, fixed fee + slippage per side. Metrics are in R (risk units) after costs.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Swing = factory();
})(this, function () {
  "use strict";

  var TECHNIQUES = [
    { id: "trendline", name: "ย้อนแตะเทรนด์ไลน์ + แท่งปฏิเสธ", source: "TL-01–TL-03 (ถอดเสียงยืนยัน)" },
    { id: "inside_bar", name: "Inside Bar 4H ทะลุตามเทรนด์", source: "หัวข้อ 17 (ภาพยืนยัน)" },
    { id: "fibo", name: "ย่อ Fibo 38.2–61.8% + แท่งปฏิเสธ", source: "หัวข้อ 13 (ภาพยืนยัน)" },
    { id: "retest", name: "Breakout แล้ว Pullback กลับมาทดสอบ", source: "TL-06 (ถอดเสียงยืนยัน)" },
    { id: "double_bottom", name: "Double Bottom ทะลุ Neckline", source: "หัวข้อ 16 (ภาพยืนยัน)" },
    // CRYPTO_ONE_BEST_COMBO_20261022: locked formula from the user's research package, designed for 1H.
    { id: "squeeze_long", name: "Momentum + Squeeze Breakout (ซื้ออย่างเดียว · Spot)", source: "ONE BEST COMBO 22/10/2569",
      hold: 24, minStopFrac: 0.0015 },
    { id: "squeeze_ls", name: "Momentum + Squeeze Breakout (ซื้อ+ขาย · Futures)", source: "ONE BEST COMBO 22/10/2569",
      hold: 24, minStopFrac: 0.0015 },
    // CRYPTO_FUTURES_10000: chosen on 2024 only, checked on 2025 (Momentum2_Squeeze3, vol >= 1.8x, SL 1.8 ATR, 48h).
    { id: "squeeze3_long", name: "Squeeze v2 · Momentum2 + Squeeze 3 ชม. (ซื้ออย่างเดียว)", source: "FUTURES 10,000 22/10/2569",
      hold: 48, minStopFrac: 0.0015, fundingPer8h: 0.0001, stopAtr: 1.8 },
    { id: "squeeze3_ls", name: "Squeeze v2 · Momentum2 + Squeeze 3 ชม. (ซื้อ+ขาย · Futures)", source: "FUTURES 10,000 22/10/2569",
      hold: 48, minStopFrac: 0.0015, fundingPer8h: 0.0001, stopAtr: 1.8 }
  ];
  var byId = {};
  var DEFAULTS = { fee: 0.001, slippage: 0.0005, risk: 0.01, maxHoldBars: 30, pivotK: 3, takeR: 2 };

  TECHNIQUES.forEach(function (t) { byId[t.id] = t; });

  function ema(values, n) {
    var a = 2 / (n + 1), y = NaN, out = [];
    values.forEach(function (x, i) { y = i ? y + a * (x - y) : x; out.push(i >= n - 1 ? y : NaN); });
    return out;
  }
  function wilder(values, n) {
    var y = NaN, out = [];
    values.forEach(function (x, i) { y = i ? y + (x - y) / n : x; out.push(i >= n - 1 ? y : NaN); });
    return out;
  }

  function indicators(bars, opt) {
    var close = bars.map(function (b) { return b.close; });
    var tr = bars.map(function (b, i) {
      if (!i) return b.high - b.low;
      var pc = bars[i - 1].close;
      return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });
    var e50 = ema(close, 50), e200 = ema(close, 200), atr = wilder(tr, 14), k = opt.pivotK;
    // A pivot at i is only known once k later bars have closed: confirmedAt = i + k.
    var lows = [], highs = [];
    for (var i = k; i < bars.length - k; i++) {
      var isL = true, isH = true;
      for (var j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (bars[j].low <= bars[i].low) isL = false;
        if (bars[j].high >= bars[i].high) isH = false;
      }
      if (isL) lows.push({ i: i, price: bars[i].low, known: i + k });
      if (isH) highs.push({ i: i, price: bars[i].high, known: i + k });
    }
    var sq = squeezeMomentum(bars);
    return { e50: e50, e200: e200, atr: atr, lows: lows, highs: highs, squeeze: sq.squeeze, momentum: sq.momentum,
      momentum2: sq.momentum2, v20: sq.v20, atrEma: sq.atr };
  }

  // Exactly as crypto_best_combo_reproduce_20261022.py: unmasked EMAs seeded at the first bar,
  // ATR = EMA14 of true range, signals from bar 260 on.
  function squeezeMomentum(bars) {
    var n = bars.length, full = function (values, p) {
      var a = 2 / (p + 1), out = [values[0]];
      for (var i = 1; i < values.length; i++) out.push(out[i - 1] + a * (values[i] - out[i - 1]));
      return out;
    };
    var C = bars.map(function (b) { return b.close; }), O = bars.map(function (b) { return b.open; });
    var H = bars.map(function (b) { return b.high; }), L = bars.map(function (b) { return b.low; });
    var V = bars.map(function (b) { return b.volume || 0; });
    var e20 = full(C, 20), e50 = full(C, 50), e200 = full(C, 200), v20 = full(V, 20);
    var tr = bars.map(function (b, i) { return i ? Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])) : H[i] - L[i]; });
    var atr = full(tr, 14), squeeze = new Array(n).fill(0), momentum = new Array(n).fill(0), momentum2 = new Array(n).fill(0);
    for (var i = 260; i < n; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var k = i - 12; k < i; k++) { hi = Math.max(hi, H[k]); lo = Math.min(lo, L[k]); }
      var up = e20[i] > e50[i] && e50[i] > e200[i], down = e20[i] < e50[i] && e50[i] < e200[i];
      if (hi - lo < 3 * atr[i] && V[i] > 1.4 * v20[i]) squeeze[i] = up && C[i] > hi ? 1 : down && C[i] < lo ? -1 : 0;
      var body = Math.abs(C[i] - O[i]);
      var same = up && C[i] > O[i] && C[i - 1] > O[i - 1] ? 1 : down && C[i] < O[i] && C[i - 1] < O[i - 1] ? -1 : 0;
      if (body > 0.7 * atr[i]) momentum[i] = same;
      if (body > 0.75 * atr[i]) momentum2[i] = same;   // crypto_futures_10000_replay: Momentum2
    }
    return { squeeze: squeeze, momentum: momentum, momentum2: momentum2, v20: v20, atr: atr };
  }

  function rejection(b) {
    var range = b.high - b.low;
    return range > 0 && (Math.min(b.open, b.close) - b.low) >= 0.3 * range && b.close >= b.low + 0.6 * range;
  }
  // Pivots confirmed by bar i (lists are sorted by `known`), via binary search.
  function knownBefore(list, i) {
    var lo = 0, hi = list.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (list[m].known <= i) lo = m + 1; else hi = m; }
    return list.slice(Math.max(0, lo - 2), lo);
  }

  /* Returns null or {stop, target} for an entry at the next open, using bars up to i only. */
  function signal(id, bars, ind, i, opt) {
    if (id === "squeeze_long" || id === "squeeze_ls") {
      var dir = ind.momentum[i];
      if (!dir || (id === "squeeze_long" && dir !== 1)) return null;
      for (var j = Math.max(260, i - 8); j <= i; j++) if (ind.squeeze[j] === dir) return { dir: dir, dist: 2.5 * ind.atrEma[i], rr: 5 };
      return null;
    }
    if (id === "squeeze3_long" || id === "squeeze3_ls") {
      // FOMC veto as in the replay script: the UTC date of bar i, i-24h or i+24h is a decision day.
      if (opt.fomcDates && opt.fomcDates.length) {
        var t0 = bars[i].time, day = function (ms) { return new Date(ms).toISOString().slice(0, 10); };
        if ([t0, t0 - 86400000, t0 + 86400000].some(function (ms) { return opt.fomcDates.indexOf(day(ms)) >= 0; })) return null;
      }
      var d2 = ind.momentum2[i];
      if (!d2 || (id === "squeeze3_long" && d2 !== 1) || !((bars[i].volume || 0) >= 1.8 * ind.v20[i])) return null;
      for (var j2 = i - 3; j2 <= i; j2++) if (ind.squeeze[j2] === d2) return { dir: d2, dist: 1.8 * ind.atrEma[i], rr: 5 };
      return null;
    }
    var b = bars[i], atr = ind.atr[i];
    if (!(atr > 0) || isNaN(ind.e200[i])) return null;
    var up = ind.e50[i] > ind.e200[i] && b.close > ind.e200[i];
    if (id === "trendline") {
      if (!up) return null;
      var L = knownBefore(ind.lows, i);
      if (L.length < 2) return null;
      var p1 = L[L.length - 2], p2 = L[L.length - 1];
      if (!(p2.price > p1.price) || i - p2.i > 60) return null;
      var line = p2.price + (p2.price - p1.price) / (p2.i - p1.i) * (i - p2.i);
      if (b.low <= line + 0.25 * atr && b.close > line && rejection(b)) return { stop: Math.min(b.low, line) - 0.5 * atr, rr: opt.takeR };
      return null;
    }
    if (id === "inside_bar") {
      if (!up || i < 2) return null;
      var m = bars[i - 2], ins = bars[i - 1];
      if (!(ins.high <= m.high && ins.low >= m.low) || (m.high - m.low) < 0.45 * atr) return null;
      if (b.close > m.high) return { stop: m.low - 0.1 * atr, rr: opt.takeR };
      return null;
    }
    if (id === "fibo") {
      if (!up || i < 48) return null;
      var lo = Infinity, hi = -Infinity, loI = 0, hiI = 0;
      for (var q = i - 48; q < i; q++) {
        if (bars[q].low < lo) { lo = bars[q].low; loI = q; }
        if (bars[q].high > hi) { hi = bars[q].high; hiI = q; }
      }
      var range = hi - lo;
      if (!(loI < hiI) || range < 4 * atr) return null;
      var f382 = hi - 0.382 * range, f618 = hi - 0.618 * range, f786 = hi - 0.786 * range;
      if (b.low <= f382 && b.low >= f786 && b.close > f618 && rejection(b)) {
        var stop = f786 - 0.25 * atr, entry = b.close, rr = (hi - entry) / (entry - stop);
        return rr >= 1 ? { stop: stop, target: hi } : null;
      }
      return null;
    }
    if (id === "retest") {
      if (!up) return null;
      for (var s = Math.max(37, i - 8); s < i; s++) {
        var prior = -Infinity;
        for (var r = s - 36; r < s; r++) prior = Math.max(prior, bars[r].high);
        if (bars[s].close > prior + 0.08 * atr) {
          var failed = false;
          for (var t = s + 1; t < i; t++) if (bars[t].close < prior - 0.5 * atr) failed = true;
          if (!failed && Math.abs(b.low - prior) <= 0.2 * atr && b.close > prior && rejection(b))
            return { stop: prior - 1.0 * atr, rr: opt.takeR };
          return null;
        }
      }
      return null;
    }
    if (id === "double_bottom") {
      var lows = knownBefore(ind.lows, i);
      if (lows.length < 2) return null;
      var a = lows[lows.length - 2], c = lows[lows.length - 1], gap = c.i - a.i;
      if (gap < 5 || gap > 35 || Math.abs(c.price - a.price) > 0.65 * atr || i - c.i > 20) return null;
      var neck = -Infinity;
      for (var z = a.i; z <= c.i; z++) neck = Math.max(neck, bars[z].high);
      var crossed = b.close > neck + 0.08 * atr && bars[i - 1].close <= neck;
      if (!crossed) return null;
      var bottom = Math.min(a.price, c.price);
      return { stop: bottom - 0.2 * atr, target: neck + (neck - bottom) };
    }
    return null;
  }

  /* One position at a time per technique and coin. A signal on bar i enters at bar i+1's open;
   * exits are checked from the entry bar on, stop before target, with no same-bar re-entry.
   * R uses the risk at entry and includes round-trip costs. */
  function runTechnique(id, bars, ind, from, to, opt) {
    var trades = [], pos = null, cost = 2 * (opt.fee + opt.slippage), spec = byId[id] || {};
    var hold = spec.hold || opt.maxHoldBars, funding = spec.fundingPer8h || 0;
    function close(i, exit, reason) {
      var risk = Math.abs(pos.entry - pos.stop);
      trades.push({ technique: id, side: pos.dir > 0 ? "long" : "short", entry_time: bars[pos.bar].time, exit_time: bars[i].time,
        entry: pos.entry, stop: pos.stop, target: pos.target, exit: exit,
        r: pos.dir * (exit - pos.entry) / risk - (cost + funding * (bars[i].time - bars[pos.bar - 1].time) / 28800000) * pos.entry / risk,
        reason: reason });
      pos = null;
    }
    for (var i = from; i < to; i++) {
      var b = bars[i];
      if (pos) {
        var d = pos.dir, open = d * b.open, low = d > 0 ? b.low : -b.high, high = d > 0 ? b.high : -b.low;
        var stop = d * pos.stop, target = d * pos.target;
        if (open <= stop) close(i, b.open, "stop_gap");
        else if (low <= stop) close(i, pos.stop, "stop");
        else if (open >= target) close(i, pos.target, "target_gap");
        else if (high >= target) close(i, pos.target, "target");
        else if (i - pos.bar + 1 >= hold) close(i, b.close, "time");
        continue;
      }
      if (i + 1 >= to) break;
      var sig = signal(id, bars, ind, i, opt);
      if (!sig) continue;
      var dir = sig.dir || 1, entry = bars[i + 1].open * (1 + dir * opt.slippage), stopPx, targetPx;
      if (sig.dist !== undefined) {
        if (!(sig.dist > 0) || sig.dist / entry < (spec.minStopFrac || 0)) continue;
        stopPx = entry - dir * sig.dist; targetPx = entry + dir * sig.rr * sig.dist;
      } else {
        stopPx = sig.stop;
        if (!(stopPx < entry)) continue;
        targetPx = sig.target !== undefined ? sig.target : entry + sig.rr * (entry - stopPx);
        if (!(targetPx > entry)) continue;
      }
      pos = { bar: i + 1, dir: dir, entry: entry, stop: stopPx, target: targetPx };
    }
    if (pos) close(to - 1, bars[to - 1].close, "end");
    return trades;
  }

  function stats(trades, risk) {
    var n = trades.length, wins = 0, gp = 0, gl = 0, sum = 0, eq = 1, peak = 1, dd = 0;
    trades.slice().sort(function (a, b) { return a.exit_time - b.exit_time; }).forEach(function (t) {
      if (t.r > 0) { wins++; gp += t.r; } else gl -= t.r;
      sum += t.r;
      eq *= 1 + risk * t.r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
    });
    var ci = [null, null];
    if (n) {
      var z = 1.959963984540054, f = wins / n, d = 1 + z * z / n, c = (f + z * z / (2 * n)) / d;
      var h = z * Math.sqrt(f * (1 - f) / n + z * z / (4 * n * n)) / d;
      ci = [100 * (c - h), 100 * (c + h)];
    }
    return { trades: n, win_rate: n ? wins / n * 100 : null, ci: ci, exp_r: n ? sum / n : null,
      pf: gl > 0 ? gp / gl : null, return_pct: (eq - 1) * 100, max_dd_pct: dd * 100 };
  }

  /* data: {symbol: bars[]} on the same timeframe. Splits by time 60/20/20 on each coin's own bars;
   * the winner is chosen on validation (>= 30 trades, positive development and validation
   * expectancy) and then reported once on holdout. */
  function evaluate(data, options) {
    var opt = Object.assign({}, DEFAULTS, options || {}), symbols = Object.keys(data), prepared = {};
    symbols.forEach(function (s) { prepared[s] = indicators(data[s], opt); });
    var results = TECHNIQUES.map(function (tq) {
      var parts = { development: [], validation: [], holdout: [] };
      symbols.forEach(function (s) {
        var bars = data[s], n = bars.length, warm = 210, avail = n - warm;
        if (avail < 300) return;
        var a = warm + Math.floor(0.6 * avail), b = warm + Math.floor(0.8 * avail);
        parts.development = parts.development.concat(runTechnique(tq.id, bars, prepared[s], warm, a, opt).map(tag(s)));
        parts.validation = parts.validation.concat(runTechnique(tq.id, bars, prepared[s], a, b, opt).map(tag(s)));
        parts.holdout = parts.holdout.concat(runTechnique(tq.id, bars, prepared[s], b, n, opt).map(tag(s)));
      });
      var all = parts.development.concat(parts.validation, parts.holdout), years = {};
      all.forEach(function (t) { var y = new Date(t.entry_time).getUTCFullYear(); (years[y] = years[y] || []).push(t); });
      var yearly = Object.keys(years).sort().map(function (y) { return { year: +y, stats: stats(years[y], opt.risk) }; });
      return { id: tq.id, name: tq.name, source: tq.source, trades: parts, yearly: yearly,
        development: stats(parts.development, opt.risk), validation: stats(parts.validation, opt.risk) };
    });
    var chosen = null;
    results.forEach(function (r) {
      var ok = r.validation.trades >= 30 && r.validation.exp_r > 0 && r.development.exp_r > 0;
      if (ok && (!chosen || r.validation.exp_r > chosen.validation.exp_r)) chosen = r;
    });
    return { techniques: results, chosen: chosen ? chosen.id : null,
      holdout: chosen ? stats(chosen.trades.holdout, opt.risk) : null, options: opt };
  }
  function tag(symbol) { return function (t) { t.symbol = symbol; return t; }; }

  return { TECHNIQUES: TECHNIQUES, DEFAULTS: DEFAULTS, indicators: indicators, signal: signal,
    runTechnique: runTechnique, stats: stats, evaluate: evaluate };
});
