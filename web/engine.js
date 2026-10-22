/* JavaScript port of bot/strategy.py, bot/core.py (Portfolio) and bot/backtest.py.
 * Same fixed rules, fills and metrics as the Python CLI; parity is checked by
 * tests/test_js_engine.py. Price-only: news/calendar gates are NOT simulated.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Engine = factory();
})(this, function () {
  "use strict";

  var BAR_MS = 15 * 60 * 1000, HOUR_MS = 3600000, DAY_MS = 86400000, WARMUP_BARS = 800;
  var NAME = "15m POC rejection + bullish candle + closed 1h trend (Spot)";

  var DEFAULTS = {
    usdt_thb: null, initial_thb: 10000, symbols: ["BTCUSDT", "ETHUSDT"], interval: "15m",
    fee: 0.001, slippage: 0.0005, risk_fraction: 0.0025, soft_drawdown: 0.08, max_drawdown: 0.10,
    daily_loss: 0.02, max_position_fraction: 0.25, max_total_fraction: 0.5, stop_atr: 2.0,
    take_profit_r: 1.5, max_holding_minutes: 240, max_entry_delay_seconds: 300, flatten_minutes_before_utc_day_end: 15,
    poc_lookback_bars: 96, poc_bins: 48, poc_tolerance_atr: 0.25
  };

  function config(values) {
    var cfg = {}, k;
    for (k in DEFAULTS) cfg[k] = DEFAULTS[k];
    for (k in values || {}) if (values[k] !== undefined) cfg[k] = values[k];
    if (!(cfg.usdt_thb > 0) || !isFinite(cfg.usdt_thb)) throw new Error("ต้องมีอัตรา USDT/THB ที่ตรวจสอบได้");
    if (!(cfg.initial_thb > 0)) throw new Error("ทุนต้องมากกว่า 0");
    return cfg;
  }

  // pandas ewm(adjust=False, min_periods=n) over a series without NaN.
  function ewm(values, alpha, minPeriods) {
    var out = new Array(values.length), y = NaN, count = 0;
    for (var i = 0; i < values.length; i++) {
      var x = values[i];
      if (!isNaN(x)) {
        y = count === 0 ? x : (1 - alpha) * y + alpha * x;
        count++;
      }
      out[i] = count >= minPeriods ? y : NaN;
    }
    return out;
  }

  function searchLeft(a, v) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }
  function searchRight(a, v) { var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; } return lo; }

  // numpy.histogram(prices, bins=linspace(low, high, bins+1), weights) + argmax.
  function volumeProfilePoc(prices, volumes, bins) {
    var n = prices.length, low = Infinity, high = -Infinity, total = 0, i;
    if (!n) return NaN;
    for (i = 0; i < n; i++) {
      if (!isFinite(prices[i]) || !isFinite(volumes[i]) || volumes[i] < 0) return NaN;
      if (prices[i] < low) low = prices[i];
      if (prices[i] > high) high = prices[i];
      total += volumes[i];
    }
    if (!(total > 0) || !(high > low)) return NaN;
    var step = (high - low) / bins, edges = new Array(bins + 1);
    for (i = 0; i <= bins; i++) edges[i] = i * step + low;
    edges[bins] = high;
    var order = prices.map(function (_, j) { return j; });
    order.sort(function (a, b) { return prices[a] - prices[b] || a - b; });
    var sorted = order.map(function (j) { return prices[j]; });
    var cw = [0], acc = 0;
    for (i = 0; i < n; i++) { acc += volumes[order[i]]; cw.push(acc); }
    var cum = new Array(bins + 1);
    for (i = 0; i < bins; i++) cum[i] = cw[searchLeft(sorted, edges[i])];
    cum[bins] = cw[searchRight(sorted, edges[bins])];
    var winner = 0, best = -Infinity;
    for (i = 0; i < bins; i++) { var h = cum[i + 1] - cum[i]; if (h > best) { best = h; winner = i; } }
    return (edges[winner] + edges[winner + 1]) / 2;
  }

  function hourlyTrend(rows) {
    // Complete hours only (four aligned 15m closes); as-of join with 45 minute tolerance.
    var n = rows.length, groups = [], current = null, i;
    for (i = 0; i < n; i++) {
      var available = rows[i].close_time + 1;
      if (available % BAR_MS !== 0 || (i && available <= rows[i - 1].close_time + 1))
        throw new Error("แท่งต้องเรียงเวลา ไม่ซ้ำ และตรงรอบ 15 นาที");
      var label = Math.ceil(available / HOUR_MS) * HOUR_MS;
      if (!current || current.label !== label) { current = { label: label, count: 0, close: NaN }; groups.push(current); }
      current.count++;
      current.close = rows[i].close;
    }
    var hours = groups.filter(function (g) { return g.count === 4; });
    var closes = hours.map(function (h) { return h.close; });
    var e50 = ewm(closes, 2 / 51, 50), e200 = ewm(closes, 2 / 201, 200);
    var out = [], j = -1;
    for (i = 0; i < n; i++) {
      var at = rows[i].close_time + 1;
      while (j + 1 < hours.length && hours[j + 1].label <= at) j++;
      if (j >= 0 && at - hours[j].label <= 45 * 60000)
        out.push({ ema50: e50[j], ema200: e200[j], close: hours[j].close });
      else out.push({ ema50: NaN, ema200: NaN, close: NaN });
    }
    return out;
  }

  function addIndicators(rows, cfg) {
    cfg = cfg || DEFAULTS;
    var lookback = cfg.poc_lookback_bars, bins = cfg.poc_bins, tol = cfg.poc_tolerance_atr;
    var n = rows.length, i;
    var close = rows.map(function (r) { return r.close; });
    var ema50 = ewm(close, 2 / 51, 50), ema20 = ewm(close, 2 / 21, 20);
    var delta = close.map(function (c, k) { return k ? c - close[k - 1] : NaN; });
    var up = ewm(delta.map(function (d) { return isNaN(d) ? NaN : Math.max(d, 0); }), 1 / 14, 14);
    var down = ewm(delta.map(function (d) { return isNaN(d) ? NaN : -Math.min(d, 0); }), 1 / 14, 14);
    var rsi = up.map(function (u, k) {
      var d = down[k];
      if (isNaN(u) || isNaN(d)) return NaN;
      if (d === 0) return u > 0 ? 100 : 50;
      return 100 - 100 / (1 + u / d);
    });
    var tr = rows.map(function (r, k) {
      if (!k) return r.high - r.low;
      var pc = rows[k - 1].close;
      return Math.max(r.high - r.low, Math.abs(r.high - pc), Math.abs(r.low - pc));
    });
    var atr = ewm(tr, 1 / 14, 14);
    var trend = hourlyTrend(rows);
    var typical = rows.map(function (r) { return (r.high + r.low + r.close) / 3; });
    var volumes = rows.map(function (r) { return r.volume; });
    var out = new Array(n);
    for (i = 0; i < n; i++) {
      var r = rows[i], t = trend[i];
      var poc = i >= lookback ? volumeProfilePoc(typical.slice(i - lookback, i), volumes.slice(i - lookback, i), bins) : NaN;
      var ready = !isNaN(t.ema200);
      var trendOk = ready && t.ema50 > t.ema200 && t.close > t.ema200;
      var body = Math.abs(r.close - r.open), lowerWick = Math.min(r.open, r.close) - r.low, range = r.high - r.low;
      var bullish = r.close > r.open;
      var pin = bullish && range > 0 && lowerWick >= 2 * body && r.close >= r.low + 2 * range / 3;
      var p = i ? rows[i - 1] : null;
      var engulf = bullish && !!p && p.close < p.open && r.open <= p.close && r.close >= p.open;
      var touches = r.low <= poc + tol * atr[i] && r.high >= poc - tol * atr[i];
      var entry = trendOk && !isNaN(poc) && !isNaN(atr[i]) && atr[i] > 0 && touches && r.close > poc && (pin || engulf);
      var exit = ready && (r.close < ema50[i] || r.close < poc - 0.5 * atr[i]);
      out[i] = { time: r.time, close_time: r.close_time, open: r.open, high: r.high, low: r.low,
        close: r.close, volume: r.volume, ema20: ema20[i], ema50: ema50[i], rsi: rsi[i], atr: atr[i], poc: poc,
        trend_confirmed: trendOk, pattern: pin ? "bullish_pin" : engulf ? "bullish_engulfing" : "",
        entry: entry, exit: exit };
    }
    return out;
  }

  // Python float(Decimal(str(qty)) / step rounded down * step), done in exact decimal.
  function decimalParts(x) {
    var s = String(x), m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(s);
    if (!m) throw new Error("Invalid decimal " + s);
    var digits = m[1] + (m[2] || ""), scale = (m[2] || "").length - (m[3] ? parseInt(m[3], 10) : 0);
    if (scale < 0) { digits += "0".repeat(-scale); scale = 0; }
    return { value: BigInt(digits), scale: scale };
  }
  function floorToStep(qty, step) {
    if (!(qty > 0)) return 0;
    var a = decimalParts(qty), b = decimalParts(step), scale = Math.max(a.scale, b.scale);
    var av = a.value * 10n ** BigInt(scale - a.scale), bv = b.value * 10n ** BigInt(scale - b.scale);
    var q = (av / bv) * bv, text = q.toString();
    if (scale) { text = text.padStart(scale + 1, "0"); text = text.slice(0, -scale) + "." + text.slice(-scale); }
    return Number(text);
  }

  function Portfolio(cfg, rules) {
    this.cfg = cfg; this.rules = rules;
    this.initial_equity = cfg.initial_thb / cfg.usdt_thb;
    this.cash = this.initial_equity; this.positions = {}; this.peak_equity = this.initial_equity;
    this.halted = false; this.halt_reason = ""; this.day = null; this.day_equity = this.initial_equity;
    this.day_blocked = false; this.trades = []; this.events = [];
  }
  Portfolio.prototype.symbols = function () { return Object.keys(this.positions); };
  Portfolio.prototype.equity = function (prices) {
    var value = this.cash, cfg = this.cfg, self = this;
    this.symbols().forEach(function (s) {
      var mark = prices[s];
      if (!isFinite(mark) || mark <= 0) throw new Error("Invalid mark for " + s);
      value += self.positions[s].qty * mark * (1 - cfg.slippage) * (1 - cfg.fee);
    });
    return value;
  };
  Portfolio.prototype.risk_check = function (prices, now) {
    var cfg = this.cfg, eq = this.equity(prices), day = Math.floor(now / DAY_MS), self = this;
    if (day !== this.day) { this.day = day; this.day_equity = eq; this.day_blocked = false; }
    this.peak_equity = Math.max(this.peak_equity, eq);
    var dd = 1 - eq / this.peak_equity;
    if (!this.halted && dd >= cfg.soft_drawdown - 1e-12) {
      this.halted = true;
      this.halt_reason = dd >= cfg.max_drawdown ? "maximum_drawdown" : "soft_drawdown";
      this.events.push({ time: now, type: "halt", reason: this.halt_reason, drawdown: dd });
      this.symbols().forEach(function (s) { self.close(s, prices[s], now, self.halt_reason); });
    }
    if (!this.halted && !this.day_blocked && eq <= this.day_equity * (1 - cfg.daily_loss)) {
      this.day_blocked = true;
      this.events.push({ time: now, type: "daily_halt", reason: "daily_loss" });
      this.symbols().forEach(function (s) { self.close(s, prices[s], now, "daily_loss"); });
    }
    return !this.halted && !this.day_blocked;
  };
  Portfolio.prototype.open = function (symbol, rawPrice, atr, now, signalMs, marks) {
    var cfg = this.cfg, self = this;
    if (cfg.symbols.indexOf(symbol) < 0 || this.positions[symbol]) return false;
    if (!(isFinite(rawPrice) && rawPrice > 0 && isFinite(atr) && atr > 0)) return false;
    if (signalMs >= now) throw new Error("Signal must precede fill");
    if (!this.risk_check(marks, now)) return false;
    var eq = this.equity(marks), price = rawPrice * (1 + cfg.slippage), stopDistance = cfg.stop_atr * atr;
    var stop = price - stopDistance;
    if (stop <= 0) return false;
    var lossPerUnit = price * (1 + cfg.fee) - stop * (1 - cfg.slippage) * (1 - cfg.fee);
    var exposure = 0;
    this.symbols().forEach(function (s) { exposure += self.positions[s].qty * marks[s]; });
    var maxNotional = Math.min(eq * cfg.max_position_fraction, Math.max(0, eq * cfg.max_total_fraction - exposure),
      this.cash / (1 + cfg.fee));
    var qty = Math.min(eq * cfg.risk_fraction / lossPerUnit, maxNotional / price);
    var rule = this.rules[symbol];
    if (!(rule.step_size > 0)) throw new Error("Invalid lot step");
    qty = floorToStep(qty, rule.step_size);
    var notional = qty * price;
    if (qty < rule.min_qty || notional < rule.min_notional || qty <= 0) {
      this.events.push({ time: now, type: "skip", symbol: symbol, reason: "below_exchange_minimum" });
      return false;
    }
    var fee = notional * cfg.fee;
    this.cash -= notional + fee;
    this.positions[symbol] = { symbol: symbol, qty: qty, entry_price: price, entry_fee: fee, stop: stop,
      target: price + cfg.take_profit_r * stopDistance, entry_time: now, entry_signal_time: signalMs,
      entry_notional: notional };
    this.events.push(Object.assign({ time: now, type: "buy" }, this.positions[symbol]));
    return true;
  };
  Portfolio.prototype.close = function (symbol, rawPrice, now, reason) {
    var pos = this.positions[symbol], cfg = this.cfg;
    if (!pos) return;
    if (!isFinite(rawPrice) || rawPrice <= 0) throw new Error("Invalid exit price");
    delete this.positions[symbol];
    var price = rawPrice * (1 - cfg.slippage), notional = pos.qty * price, fee = notional * cfg.fee;
    var pnl = notional - fee - pos.entry_notional - pos.entry_fee;
    this.cash += notional - fee;
    var trade = { symbol: symbol, entry_time: pos.entry_time, exit_time: now, signal_time: pos.entry_signal_time,
      entry_price: pos.entry_price, exit_price: price, qty: pos.qty, pnl: pnl, fees: pos.entry_fee + fee, reason: reason };
    this.trades.push(trade);
    this.events.push(Object.assign({ time: now, type: "sell" }, trade));
  };

  function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }

  function metrics(curve, trades, initial, halted, haltReason) {
    var peak = initial, worst = 0, months = [], last = null;
    curve.forEach(function (p) {
      peak = Math.max(peak, p.equity);
      worst = Math.max(worst, 1 - p.equity / peak);
      var key = monthKey(p.time);
      if (key !== last) { months.push(p.equity); last = key; } else months[months.length - 1] = p.equity;
    });
    var monthReturns = [], previous = initial;
    months.forEach(function (v) { monthReturns.push((v / previous - 1) * 100); previous = v; });
    var end = curve.length ? curve[curve.length - 1].equity : initial, n = trades.length;
    var wins = 0, gp = 0, gl = 0, sum = 0;
    trades.forEach(function (t) { if (t.pnl > 0) wins++; gp += Math.max(0, t.pnl); gl += -Math.min(0, t.pnl); sum += t.pnl; });
    var ci = [null, null];
    if (n) {
      var z = 1.959963984540054, f = wins / n, d = 1 + z * z / n, c = (f + z * z / (2 * n)) / d;
      var h = z * Math.sqrt(f * (1 - f) / n + z * z / (4 * n * n)) / d;
      ci = [100 * (c - h), 100 * (c + h)];
    }
    return { starting_equity: initial, ending_equity: end, return_pct: (end / initial - 1) * 100,
      max_drawdown_pct: worst * 100, trade_count: n, win_rate_pct: n ? wins / n * 100 : null,
      win_rate_ci95_pct: ci, profit_factor: gl > 0 ? gp / gl : null, expectancy: n ? sum / n : null,
      net_profit: end - initial, worst_month_pct: monthReturns.length ? Math.min.apply(null, monthReturns) : 0,
      halted: !!halted, halt_reason: haltReason || "" };
  }

  function runWindow(prepared, start, end, cfg, rules) {
    var first = prepared[cfg.symbols[0]], times = first.map(function (r) { return r.time; });
    if (!(WARMUP_BARS <= start && start < end && end <= times.length)) throw new Error("Window needs 800 warmup candles");
    var p = new Portfolio(cfg, rules), curve = [{ time: times[start], equity: p.initial_equity }], holding = 0;
    for (var i = start; i < end; i++) {
      var rows = {}, prev = {}, opens = {}, marks = {};
      cfg.symbols.forEach(function (s) { rows[s] = prepared[s][i]; prev[s] = prepared[s][i - 1]; opens[s] = rows[s].open; });
      var now = times[i];
      var flatten = now % DAY_MS >= DAY_MS - cfg.flatten_minutes_before_utc_day_end * 60000;
      var closedThisBar = {}, before = p.symbols();
      p.risk_check(opens, now);
      before.forEach(function (s) { if (!p.positions[s]) closedThisBar[s] = true; });
      p.symbols().forEach(function (s) {
        var pos = p.positions[s];
        if (opens[s] <= pos.stop) p.close(s, opens[s], now, "stop_gap");
        else if (opens[s] >= pos.target) p.close(s, pos.target, now, "target_gap");
        else if (prev[s].exit) p.close(s, opens[s], now, "trend_exit");
        else if (now - pos.entry_time >= cfg.max_holding_minutes * 60000) p.close(s, opens[s], now, "time_exit");
        else if (flatten) p.close(s, opens[s], now, "utc_day_end");
        else return;
        closedThisBar[s] = true;
      });
      cfg.symbols.forEach(function (s) {
        if (!flatten && !closedThisBar[s] && prev[s].entry) p.open(s, opens[s], prev[s].atr, now, prev[s].close_time, opens);
      });
      if (p.symbols().length) holding++;
      p.symbols().forEach(function (s) {
        var r = rows[s], pos = p.positions[s];
        if (r.low <= pos.stop) p.close(s, Math.min(r.open, pos.stop), r.close_time, "stop");
        else if (r.high >= pos.target) p.close(s, pos.target, r.close_time, "target");
      });
      cfg.symbols.forEach(function (s) { marks[s] = rows[s].close; });
      var closeTime = rows[cfg.symbols[0]].close_time;
      p.risk_check(marks, closeTime);
      curve.push({ time: closeTime, equity: p.equity(marks) });
    }
    var lastRows = {};
    cfg.symbols.forEach(function (s) { lastRows[s] = prepared[s][end - 1]; });
    p.symbols().forEach(function (s) { p.close(s, lastRows[s].close, lastRows[s].close_time, "evaluation_end"); });
    curve[curve.length - 1].equity = p.cash;
    return { start: times[start], end: lastRows[cfg.symbols[0]].close_time,
      metrics: metrics(curve, p.trades, p.initial_equity, p.halted, p.halt_reason),
      curve: curve, trades: p.trades, events: p.events, exposure_bar_pct: holding / (end - start) * 100 };
  }

  function buyAndHold(prepared, start, end, cfg) {
    var initial = cfg.initial_thb / cfg.usdt_thb, allocation = 0.5, cash = initial * (1 - allocation), positions = {};
    cfg.symbols.forEach(function (s) {
      var buy = prepared[s][start].open * (1 + cfg.slippage);
      positions[s] = initial * allocation / cfg.symbols.length / (buy * (1 + cfg.fee));
    });
    var curve = [{ time: prepared[cfg.symbols[0]][start].time, equity: initial }];
    for (var i = start; i < end; i++) {
      var eq = cash;
      cfg.symbols.forEach(function (s) { eq += positions[s] * prepared[s][i].close * (1 - cfg.slippage) * (1 - cfg.fee); });
      curve.push({ time: prepared[cfg.symbols[0]][i].close_time, equity: eq });
    }
    return { metrics: metrics(curve, [], initial), curve: curve };
  }

  function evaluate(data, cfg, rules) {
    var prepared = {};
    cfg.symbols.forEach(function (s) { prepared[s] = addIndicators(data[s], cfg); });
    var times = data[cfg.symbols[0]].map(function (r) { return r.time; });
    cfg.symbols.forEach(function (s) {
      var other = data[s];
      if (other.length !== times.length || other.some(function (r, k) { return r.time !== times[k]; }))
        throw new Error("ทุกคู่ต้องมีเวลาแท่งตรงกันครบทุกแท่ง");
    });
    var n = times.length, available = n - WARMUP_BARS;
    if (available < 1000) throw new Error("ต้องมีอย่างน้อย 1,800 แท่ง (ประมาณ 19 วัน)");
    var a = WARMUP_BARS + Math.floor(0.6 * available), b = WARMUP_BARS + Math.floor(0.8 * available);
    var splits = { development: runWindow(prepared, WARMUP_BARS, a, cfg, rules),
      validation: runWindow(prepared, a, b, cfg, rules), holdout: runWindow(prepared, b, n, cfg, rules) };
    var stressCfg = Object.assign({}, cfg, { fee: 0.0015, slippage: 0.002 });
    var holdout = splits.holdout.metrics, warnings = [
      "ผลทดสอบกฎราคาอย่างเดียว ไม่ได้จำลองตัวกรองข่าว/ปฏิทินเศรษฐกิจย้อนหลัง",
      "POC เป็นค่าประมาณจาก HLC3 × volume ของแท่งก่อนหน้า ไม่ใช่ Volume Profile ระดับรายการซื้อขาย",
      "ค่าธรรมเนียมและ slippage เป็นสมมติฐาน ไม่ใช่ค่าจริงของบัญชี",
      "ผลในอดีตไม่รับประกันผลในอนาคต"];
    if (holdout.trade_count < 30) warnings.push("Holdout ปิดสถานะน้อยกว่า 30 ครั้ง: ตัวอย่างน้อยเกินไปสำหรับสรุป win rate");
    if (holdout.return_pct <= 0) warnings.push("กำไรสุทธิช่วง holdout ไม่เป็นบวก: ยังไม่แสดงว่ากลยุทธ์ทำกำไรได้");
    return { strategy: NAME, config: cfg, prepared: prepared, bars: n, splits: splits,
      stress: runWindow(prepared, b, n, stressCfg, rules), benchmark: buyAndHold(prepared, b, n, cfg),
      news_backtest: "not_simulated", warnings: warnings };
  }

  // ---- bot/research.py ----
  var VARIANTS = [
    ["poc_base", "POC rejection · เป้า 1.5R (กติกาเดิม)", "poc", 1.5, false, true],
    ["poc_high_wr", "POC rejection · เป้าใกล้ 0.8R", "poc", 0.8, false, true],
    ["poc_calm", "POC rejection · กรองความผันผวน", "poc", 1.5, true, true],
    ["ema20_pullback", "ย่อ EMA20 · เป้า 1R", "pullback", 1.0, true, true],
    ["pullback_or_poc", "POC หรือย่อ EMA20 · เป้า 1.2R", "either", 1.2, true, true],
    ["poc_hold", "POC · ถือจนชน stop/เป้า · 1R", "poc", 1.0, true, false],
    ["pullback_hold", "ย่อ EMA20 · ถือจนชน stop/เป้า · 1R", "pullback", 1.0, true, false],
    ["trend_breakout", "Breakout 24 ชม. ขาขึ้นรายวัน · 2R · ถือ ≤ 1 วัน", "breakout", 2.0, true, false,
      { daily: true, max_holding_minutes: 1440, flatten_minutes_before_utc_day_end: 0 }],
    ["daily_poc_hold", "POC เฉพาะขาขึ้นรายวัน · ถือจนชน stop/เป้า · 1R", "poc", 1.0, true, false, { daily: true }],
    ["daily_pullback_swing", "ย่อ EMA20 ขาขึ้นรายวัน · 2R · ถือ ≤ 1 วัน", "pullback", 2.0, true, false,
      { daily: true, max_holding_minutes: 1440, flatten_minutes_before_utc_day_end: 0 }],
    ["rsi2_dip", "ย่อแรง RSI(2)<10 รายชม. · ขายเมื่อเด้งเหนือ SMA5", "rsi2", 10.0, true, true,
      { daily: true, rsi_max: 10, stop_atr: 6.0, max_holding_minutes: 2880, flatten_minutes_before_utc_day_end: 0 }],
    ["rsi2_deep", "ย่อแรงมาก RSI(2)<5 รายชม. · ขายเมื่อเด้งเหนือ SMA5", "rsi2", 10.0, true, true,
      { daily: true, rsi_max: 5, stop_atr: 6.0, max_holding_minutes: 2880, flatten_minutes_before_utc_day_end: 0 }],
    ["bb_dip", "ปิดใต้ Bollinger ล่าง · ขายเมื่อกลับเส้นกลาง", "bb", 10.0, true, true,
      { daily: true, stop_atr: 4.0, max_holding_minutes: 1440, flatten_minutes_before_utc_day_end: 0 }]
  ];
  var BREAKOUT_BARS = 96;

  // Per bar: hourly RSI(2), SMA5 and close of the last complete hour (<= 45 min old), and
  // whether that hour completed on this bar. Same arithmetic as bot/research.py.
  function hourlyRsi2(base) {
    var hours = [];
    base.forEach(function (r) {
      var label = Math.ceil((r.close_time + 1) / HOUR_MS) * HOUR_MS, last = hours[hours.length - 1];
      if (!last || last.label !== label) { last = { label: label, count: 0, close: NaN }; hours.push(last); }
      last.count++; last.close = r.close;
    });
    var complete = hours.filter(function (h) { return h.count === 4; });
    var closes = complete.map(function (h) { return h.close; });
    var delta = closes.map(function (c, k) { return k ? c - closes[k - 1] : NaN; });
    var up = ewm(delta.map(function (d) { return isNaN(d) ? NaN : Math.max(d, 0); }), 0.5, 2);
    var down = ewm(delta.map(function (d) { return isNaN(d) ? NaN : -Math.min(d, 0); }), 0.5, 2);
    var rsi = up.map(function (u, k) {
      var d = down[k];
      if (isNaN(u) || isNaN(d)) return NaN;
      if (d === 0) return u > 0 ? 100 : 50;
      return 100 - 100 / (1 + u / d);
    });
    var sma = closes.map(function (c, k) {
      if (k < 4) return NaN;
      var sum = 0;
      for (var q = k - 4; q <= k; q++) sum += closes[q];
      return sum / 5;
    });
    var out = [], j = -1;
    base.forEach(function (r) {
      var at = r.close_time + 1;
      while (j + 1 < complete.length && complete[j + 1].label <= at) j++;
      if (j >= 0 && at - complete[j].label <= 45 * 60000) out.push([rsi[j], sma[j], closes[j], at === complete[j].label]);
      else out.push([NaN, NaN, NaN, false]);
    });
    return out;
  }

  function bollinger(base) {
    return base.map(function (r, i) {
      if (i < 19) return [NaN, NaN];
      var sum = 0, sq = 0, k;
      for (k = i - 19; k <= i; k++) sum += base[k].close;
      var mean = sum / 20;
      for (k = i - 19; k <= i; k++) sq += Math.pow(base[k].close - mean, 2);
      return [mean, mean - 2 * Math.sqrt(sq / 19)];
    });
  }

  // Last complete UTC day closed above its daily EMA50; known only after that day ends.
  function dailyUptrend(base) {
    var days = [];
    base.forEach(function (r) {
      var day = Math.floor(r.time / DAY_MS), last = days[days.length - 1];
      if (!last || last.day !== day) { last = { day: day, count: 0, close: NaN }; days.push(last); }
      last.count++; last.close = r.close;
    });
    var complete = days.filter(function (d) { return d.count === 96; });
    var ema = ewm(complete.map(function (d) { return d.close; }), 2 / 51, 50), up = {};
    complete.forEach(function (d, k) { up[d.day] = !isNaN(ema[k]) && d.close > ema[k]; });
    return base.map(function (r) { return !!up[Math.floor((r.close_time + 1) / DAY_MS) - 1]; });
  }

  function breakout(base) {
    return base.map(function (r, i) {
      if (i < BREAKOUT_BARS) return false;
      var prior = -Infinity;
      for (var k = i - BREAKOUT_BARS; k < i; k++) if (base[k].high > prior) prior = base[k].high;
      return r.trend_confirmed && r.atr > 0 && r.close > prior;
    });
  }
  var VOL_LOOKBACK = 2880, VOL_RATIO = 2.5, MIN_VALIDATION_TRADES = 30;
  var WF_STEP = 2880, WF_LOOKBACK = 8640, WF_MIN_TRADES = 10;

  // pandas Series.shift(1).rolling(w, min_periods=w/2).median(), NaN skipped.
  function priorRollingMedian(values, w) {
    var out = new Array(values.length), win = [];
    function insert(v) { var lo = 0, hi = win.length; while (lo < hi) { var m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 0, v); }
    function remove(v) { var lo = 0, hi = win.length; while (lo < hi) { var m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 1); }
    for (var i = 0; i < values.length; i++) {
      if (i >= 1 && !isNaN(values[i - 1])) insert(values[i - 1]);
      var leaving = i - 1 - w;
      if (leaving >= 0 && !isNaN(values[leaving])) remove(values[leaving]);
      var n = win.length;
      out[i] = n >= w / 2 ? (n % 2 ? win[(n - 1) / 2] : (win[n / 2 - 1] + win[n / 2]) / 2) : NaN;
    }
    return out;
  }

  function variantRows(base, rule, calm, signalExit, daily, rsiMax) {
    var typical = calm ? priorRollingMedian(base.map(function (r) { return r.atr; }), VOL_LOOKBACK) : null;
    var breakouts = rule === "breakout" ? breakout(base) : null, dailyUp = daily ? dailyUptrend(base) : null;
    var hourly = rule === "rsi2" ? hourlyRsi2(base) : null, bands = rule === "bb" ? bollinger(base) : null;
    return base.map(function (r, i) {
      var pullback = r.trend_confirmed && !isNaN(r.ema20) && !isNaN(r.atr) && r.atr > 0 && r.low <= r.ema20 &&
        r.close > r.ema20 && r.close > r.open && r.rsi >= 40 && r.rsi <= 65;
      var entry = rule === "poc" ? r.entry : rule === "pullback" ? pullback : rule === "breakout" ? breakouts[i] :
        rule === "rsi2" ? (!!r.trend_confirmed && hourly[i][3] && hourly[i][0] < rsiMax) :
        rule === "bb" ? (!!r.trend_confirmed && r.atr > 0 && r.close < bands[i][1]) : (r.entry || pullback);
      if (daily) entry = entry && dailyUp[i];
      if (calm) entry = entry && r.atr <= VOL_RATIO * typical[i];
      var row = Object.assign({}, r);
      row.entry = !!entry;
      if (!signalExit) row.exit = false;
      if (rule === "rsi2") row.exit = hourly[i][3] && hourly[i][2] > hourly[i][1];
      if (rule === "bb") row.exit = r.close > bands[i][0];
      return row;
    });
  }

  function research(evaluated, rules) {
    var cfg = evaluated.config, n = evaluated.bars, available = n - WARMUP_BARS;
    var a = WARMUP_BARS + Math.floor(0.6 * available), b = WARMUP_BARS + Math.floor(0.8 * available);
    var variants = buildVariants(evaluated.prepared, cfg).map(function (v) {
      v.development = runWindow(v.prepared, WARMUP_BARS, a, v.config, rules).metrics;
      v.validation = runWindow(v.prepared, a, b, v.config, rules).metrics;
      return v;
    });
    var chosen = null;
    variants.forEach(function (v) {
      var ok = v.validation.trade_count >= MIN_VALIDATION_TRADES && (v.validation.expectancy || 0) > 0 && (v.development.expectancy || 0) > 0;
      if (ok && (!chosen || v.validation.expectancy > chosen.validation.expectancy)) chosen = v;
    });
    return { variants: variants, chosen: chosen ? chosen.name : null,
      chosen_holdout: chosen ? runWindow(chosen.prepared, b, n, chosen.config, rules) : null,
      walk_forward: walkForward(variants, n, rules) };
  }

  // Best variant over the LOOKBACK bars before `begin`, or null when none qualifies.
  function chooseVariant(variants, begin, rules) {
    var best = null, bestScore = null, bestMetrics = null;
    variants.forEach(function (v) {
      var m = runWindow(v.prepared, begin - WF_LOOKBACK, begin, v.config, rules).metrics;
      if (m.trade_count < WF_MIN_TRADES || (m.expectancy || 0) <= 0 || (m.profit_factor || 0) <= 1) return;
      var score = m.expectancy / m.starting_equity;
      if (bestScore === null || score > bestScore) { best = v; bestScore = score; bestMetrics = m; }
    });
    return { best: best, metrics: bestMetrics };
  }

  function buildVariants(prepared, cfg) {
    return VARIANTS.map(function (v) {
      var rows = {};
      var options = Object.assign({}, v[6] || {}), daily = !!options.daily;
      var rsiMax = options.rsi_max === undefined ? 10 : options.rsi_max;
      delete options.daily; delete options.rsi_max;
      cfg.symbols.forEach(function (s) { rows[s] = variantRows(prepared[s], v[2], v[4], v[5], daily, rsiMax); });
      return { name: v[0], description: v[1], prepared: rows, config: Object.assign({}, cfg, { take_profit_r: v[3] }, options) };
    });
  }

  /* Live scan of one coin: choose the strategy from the last 90 days (same rule as
   * walk-forward), then check whether the latest *closed* candle gives its entry. */
  function scanSymbol(symbol, rows, rule, cfgValues) {
    var cfg = config(Object.assign({}, cfgValues, { symbols: [symbol] }));
    var rules = {}; rules[symbol] = rule;
    var prepared = {}; prepared[symbol] = addIndicators(rows, cfg);
    var n = rows.length;
    if (n < WARMUP_BARS + WF_LOOKBACK) throw new Error(symbol + ": ข้อมูลไม่พอ");
    var variants = buildVariants(prepared, cfg), pick = chooseVariant(variants, n, rules);
    var latest = prepared[symbol][n - 1];
    var out = { symbol: symbol, close: latest.close, close_time: latest.close_time, atr: latest.atr,
      trend_up: !!latest.trend_confirmed, ema50: latest.ema50, poc: latest.poc, strategy: null, stats: null, signal: null };
    if (!pick.best) return out;
    out.strategy = pick.best.name; out.stats = pick.metrics;
    var row = pick.best.prepared[symbol][n - 1];
    if (row.entry) {
      var price = latest.close, stopDistance = cfg.stop_atr * latest.atr, r = pick.best.config.take_profit_r;
      var equity = cfg.initial_thb / cfg.usdt_thb, lossPerUnit = price * (1 + cfg.fee) - (price - stopDistance) * (1 - cfg.slippage) * (1 - cfg.fee);
      var qty = Math.min(equity * cfg.risk_fraction / lossPerUnit, equity * cfg.max_position_fraction / price);
      qty = floorToStep(qty, rule.step_size);
      out.signal = { entry: price, stop: price - stopDistance, target: price + r * stopDistance, take_profit_r: r,
        qty: qty, notional: qty * price, risk: qty * lossPerUnit, below_minimum: qty < rule.min_qty || qty * price < rule.min_notional,
        expires: latest.close_time + 1 + cfg.max_entry_delay_seconds * 1000 };
    }
    return out;
  }

  function walkForward(variants, n, rules) {
    var start = WARMUP_BARS + WF_LOOKBACK;
    if (start >= n) return null;
    var windows = [], trades = [], curve = [], factor = 1, initial = null;
    for (var begin = start; begin < n; begin += WF_STEP) {
      var end = Math.min(begin + WF_STEP, n), best = chooseVariant(variants, begin, rules).best;
      var first = variants[0], times = first.prepared[first.config.symbols[0]];
      if (!best) {
        initial = initial || first.config.initial_thb / first.config.usdt_thb;
        curve.push({ time: times[begin].time, equity: initial * factor });
        windows.push({ start: times[begin].time, end: times[end - 1].time + BAR_MS, variant: null, trade_count: 0, return_pct: 0 });
        continue;
      }
      var result = runWindow(best.prepared, begin, end, best.config, rules), m = result.metrics, scale = factor;
      initial = m.starting_equity;
      result.curve.forEach(function (p) { curve.push({ time: p.time, equity: p.equity * scale }); });
      result.trades.forEach(function (t) { trades.push(Object.assign({}, t, { variant: best.name, pnl: t.pnl * scale, fees: t.fees * scale })); });
      factor *= m.ending_equity / m.starting_equity;
      windows.push({ start: result.start, end: result.end, variant: best.name, trade_count: m.trade_count, return_pct: m.return_pct });
    }
    return { step_days: WF_STEP / 96, lookback_days: WF_LOOKBACK / 96, windows: windows,
      metrics: metrics(curve, trades, initial), trades: trades, curve: curve };
  }

  return { BAR_MS: BAR_MS, VARIANTS: VARIANTS, research: research, scanSymbol: scanSymbol, WF_LOOKBACK: WF_LOOKBACK, priorRollingMedian: priorRollingMedian, WARMUP_BARS: WARMUP_BARS, DEFAULTS: DEFAULTS, config: config, ewm: ewm,
    volumeProfilePoc: volumeProfilePoc, addIndicators: addIndicators, floorToStep: floorToStep,
    Portfolio: Portfolio, metrics: metrics, runWindow: runWindow, evaluate: evaluate };
});
