/* UI for the Android backtest app: download closed Binance 15m candles, run engine.js, chart results. */
(function () {
  "use strict";

  var BASES = ["https://data-api.binance.vision", "https://api.binance.com"];
  var FUTURES_BASES = ["https://fapi.binance.com", "https://fapi1.binance.com"];
  var THAI_OFFSET_S = 7 * 3600;
  var REASONS = { stop: "ชน stop", stop_gap: "เปิดกระโดดผ่าน stop", target: "ถึงเป้า", target_gap: "เปิดเหนือเป้า",
    trend_exit: "สัญญาณออก", time_exit: "ครบ 240 นาที", utc_day_end: "ปิดรอบวัน", evaluation_end: "จบช่วงทดสอบ",
    soft_drawdown: "หยุด drawdown", maximum_drawdown: "หยุด drawdown", daily_loss: "ขาดทุนรายวัน" };
  var $ = function (id) { return document.getElementById(id); };
  var pending = {}, nextId = 0, last = null, candleChart = null, equityChart = null;

  window.__nativeDone = function (id, ok, body) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    ok ? p.resolve(body) : p.reject(new Error(body));
  };

  // Every native request settles within NATIVE_TIMEOUT_MS even if its reply is lost, so a scan can never hang.
  var NATIVE_TIMEOUT_MS = 50000;
  function httpGet(url) {
    if (window.NativeHttp) {
      return new Promise(function (resolve, reject) {
        var id = "r" + (++nextId);
        pending[id] = { resolve: resolve, reject: reject };
        setTimeout(function () {
          if (!pending[id]) return;
          delete pending[id];
          reject(new Error("หมดเวลารอ " + NATIVE_TIMEOUT_MS / 1000 + " วินาที: " + url.replace(/^https?:\/\/([^/]+).*$/, "$1")));
        }, NATIVE_TIMEOUT_MS);
        window.NativeHttp.get(id, url);
      });
    }
    return fetch(url).then(function (r) {
      return r.text().then(function (t) { if (!r.ok) throw new Error("HTTP " + r.status + " " + t); return t; });
    });
  }

  function binance(path) {
    var errors = [];
    return BASES.reduce(function (chain, base) {
      return chain.catch(function (e) {
        if (e) errors.push(e.message);
        return httpGet(base + path).then(JSON.parse);
      });
    }, Promise.reject(null)).catch(function (e) {
      errors.push(e.message);
      throw new Error("เชื่อมต่อ Binance ไม่ได้: " + errors.join(" | ").slice(0, 300));
    });
  }

  function futuresApi(path) {
    var errors = [];
    var dbg = "";
    try { dbg = window.NativeHttp && window.NativeHttp.debugFuturesBase ? window.NativeHttp.debugFuturesBase() : ""; } catch (e) { /* release build */ }
    return (dbg ? [dbg] : FUTURES_BASES).reduce(function (chain, base) {
      return chain.catch(function (e) {
        if (e) errors.push(String(e.message || e));
        return httpGet(base + path).then(JSON.parse);
      });
    }, Promise.reject(null)).catch(function (e) {
      errors.push(String(e.message || e));
      throw new Error("เชื่อมต่อ Binance Futures ไม่ได้: " + errors.join(" | ").slice(0, 280));
    });
  }

  // USD-M symbol rules (tick size, lot step, minimum notional) from /fapi/v1/exchangeInfo, cached for 6 hours.
  var futRulesCache = null;
  function futuresRules() {
    if (futRulesCache && Date.now() - futRulesCache.at < 6 * 3600000) return Promise.resolve(futRulesCache.map);
    return futuresApi("/fapi/v1/exchangeInfo").then(function (info) {
      var map = {};
      (info.symbols || []).forEach(function (x) {
        if (x.contractType !== "PERPETUAL" || x.quoteAsset !== "USDT") return;
        var f = {};
        (x.filters || []).forEach(function (y) { f[y.filterType] = y; });
        map[x.symbol] = { status: x.status, tick: +(f.PRICE_FILTER || {}).tickSize, step: +(f.MARKET_LOT_SIZE || f.LOT_SIZE || {}).stepSize,
          minQty: +(f.MARKET_LOT_SIZE || f.LOT_SIZE || {}).minQty, minNotional: +(f.MIN_NOTIONAL || {}).notional || 0 };
      });
      if (!Object.keys(map).length) throw new Error("exchangeInfo ว่าง");
      futRulesCache = { at: Date.now(), map: map };
      return map;
    });
  }
  // Round to the exchange grid; decimals from the step itself so 0.1 + 0.2 noise never leaks into the display.
  function decimalsOf(step) { var t = String(step); if (t.indexOf("e-") > 0) return +t.split("e-")[1]; var i = t.indexOf("."); return i < 0 ? 0 : t.replace(/0+$/, "").length - i - 1; }
  function toGrid(v, step, mode) {
    if (!(step > 0)) return v;
    var k = v / step, n = mode === "floor" ? Math.floor(k + 1e-9) : mode === "ceil" ? Math.ceil(k - 1e-9) : Math.round(k);
    return +(n * step).toFixed(decimalsOf(step));
  }

  function status(text, isError) {
    var el = $("status");
    el.textContent = text;
    el.className = isError ? "err" : "";
  }

  function readNumber(id, fallback) {
    var v = parseFloat($(id).value);
    return isFinite(v) ? v : fallback;
  }

  function saveSettings() {
    try {
      localStorage.setItem("settings", JSON.stringify({ btc: $("btc").checked, eth: $("eth").checked, days: $("days").value,
        capital: $("capital").value, fx: $("fx").value, fee: $("fee").value, slip: $("slip").value, risk: $("risk").value }));
    } catch (e) { /* storage is optional */ }
  }
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem("settings") || "null");
      if (!s) return;
      $("btc").checked = s.btc; $("eth").checked = s.eth;
      ["days", "capital", "fx", "fee", "slip", "risk"].forEach(function (k) { if (s[k] !== undefined) $(k).value = s[k]; });
    } catch (e) { /* ignore */ }
  }

  function fetchRules(symbol) {
    return binance("/api/v3/exchangeInfo?symbol=" + symbol).then(function (info) {
      var item = info.symbols && info.symbols[0];
      if (!item || item.symbol !== symbol || item.status !== "TRADING") throw new Error(symbol + ": ไม่มีกติกาซื้อขาย spot");
      var filters = {};
      item.filters.forEach(function (f) { filters[f.filterType] = f; });
      var mins = ["NOTIONAL", "MIN_NOTIONAL"].filter(function (k) { return filters[k]; })
        .map(function (k) { return parseFloat(filters[k].minNotional); });
      if (!filters.LOT_SIZE || !mins.length) throw new Error(symbol + ": ไม่มี LOT_SIZE / minimum notional");
      return { step_size: parseFloat(filters.LOT_SIZE.stepSize), min_qty: parseFloat(filters.LOT_SIZE.minQty),
        min_notional: Math.max.apply(null, mins) };
    });
  }

  function fetchCandles(symbol, start, end, progress, interval, perpetual) {
    interval = interval || "15m";
    var step = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 }[interval];
    var rows = [];
    function page(from) {
      if (from >= end) return Promise.resolve(rows);
      return (perpetual ? futuresApi("/fapi/v1/klines?symbol=" + symbol + "&interval=" + interval + "&startTime=" + from +
          "&endTime=" + (end - 1) + "&limit=1000") : binance("/api/v3/klines?symbol=" + symbol + "&interval=" + interval + "&startTime=" + from +
          "&endTime=" + (end - 1) + "&limit=1000")).then(function (batch) {
        if (!Array.isArray(batch)) throw new Error(symbol + ": ข้อมูลแท่งผิดรูปแบบ");
        batch.forEach(function (k) {
          var row = { time: k[0], close_time: k[6], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
          if (row.close_time < end) rows.push(row);
        });
        progress(rows.length);
        if (!batch.length) return rows;
        var nextFrom = batch[batch.length - 1][0] + step;
        return nextFrom <= from ? rows : page(nextFrom);
      });
    }
    return page(start).then(function (all) {
      for (var i = 0; i < all.length; i++) {
        var r = all[i];
        if (r.close_time !== r.time + step - 1 || !(r.low <= Math.min(r.open, r.close) && r.high >= Math.max(r.open, r.close)) || !(r.volume >= 0))
          throw new Error(symbol + ": แท่งไม่ถูกต้องที่ " + new Date(r.time).toISOString());
        if (i && r.time !== all[i - 1].time + step)
          throw new Error(symbol + ": ข้อมูลขาดช่วงที่ " + new Date(all[i - 1].time).toISOString() + " ลองเลือกช่วงวันอื่น");
      }
      if (!all.length || all[0].time !== start) throw new Error(symbol + ": ข้อมูลเริ่มไม่ตรงช่วงที่ขอ");
      return all;
    });
  }

  function fetchFx() {
    var manual = parseFloat($("fx").value);
    if (isFinite(manual) && manual > 0) return Promise.resolve({ rate: manual, source: "กรอกเอง" });
    return httpGet("https://api.bitkub.com/api/v3/market/ticker?sym=usdt_thb").then(JSON.parse).then(function (list) {
      var m = (list || []).filter(function (x) { return x && x.symbol === "USDT_THB"; });
      var rate = m.length === 1 ? parseFloat(m[0].last) : NaN;
      if (!(rate > 0)) throw new Error("bad");
      return { rate: rate, source: "Bitkub ล่าสุด" };
    }).catch(function () {
      // Fallback: USD/THB reference rate; USDT usually trades near USD but is not guaranteed to.
      return httpGet("https://open.er-api.com/v6/latest/USD").then(JSON.parse).then(function (d) {
        var rate = d && d.result === "success" && d.rates ? parseFloat(d.rates.THB) : NaN;
        if (!(rate > 0)) throw new Error("bad");
        return { rate: rate, source: "USD/THB จาก open.er-api.com ใช้แทน USDT/THB" };
      });
    }).catch(function () {
      throw new Error("ดึงอัตรา USDT/THB ไม่ได้ กรุณากรอกอัตราที่ตรวจสอบแล้วในช่อง USDT/THB");
    });
  }

  function fmt(v, d, sign) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    var s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    return (v < 0 ? "-" : sign ? "+" : "") + s;
  }
  // Colours everywhere: positive green, negative red, neutral (zero, middle, no direction) yellow.
  // Holdout status of a rule; every rule shows it, whether or not it was chosen.
  function validBadge(ok) {
    return ok ? '<b class="up">VALIDATED</b>' : '<b class="down">NOT VALIDATED</b><br><small class="muted">Holdout ไม่ผ่าน</small>';
  }
  function tone(v) { return !isFinite(v) ? "" : Math.abs(v) < 0.005 ? "neu" : v > 0 ? "up" : "down"; }
  function thai(ms) {
    var d = new Date(ms + THAI_OFFSET_S * 1000);
    function p(n) { return String(n).padStart(2, "0"); }
    return p(d.getUTCDate()) + "/" + p(d.getUTCMonth() + 1) + "/" + String(d.getUTCFullYear()).slice(2) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  // The app version (android/app/build.gradle versionName; tests/js/run_tests.py checks they match).
  var APP_VERSION = "7.1";
  // One line-icon family for the screen (24px grid, 1.8 stroke, round ends), drawn in the text colour.
  var ICONS = { check: '<path d="M5 12.5l4.2 4.2L19 7"/>', alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.3v.2"/>',
    news: '<rect x="3.5" y="5" width="13" height="14" rx="2"/><path d="M16.5 9h3v7.5a2.5 2.5 0 0 1-5 0"/><path d="M7 9h6M7 12.5h6M7 16h3.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>', minus: '<path d="M6 12h12"/>', info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.2"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' };
  function ic(n) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[n] + "</svg>"; }

  function run() {
    var symbols = [];
    if ($("btc").checked) symbols.push("BTCUSDT");
    if ($("eth").checked) symbols.push("ETHUSDT");
    if (!symbols.length) return status("เลือกอย่างน้อย 1 คู่", true);
    saveSettings();
    $("run").disabled = true;
    var days = parseInt($("days").value, 10), counts = {}, fxInfo, rules = {}, data = {};
    status("กำลังตรวจเวลา Binance และอัตราแลกเปลี่ยน…");
    Promise.all([binance("/api/v3/time"), fetchFx()]).then(function (res) {
      fxInfo = res[1];
      var end = Math.floor(res[0].serverTime / Engine.BAR_MS) * Engine.BAR_MS, start = end - days * 86400000;
      return Promise.all(symbols.map(function (s) {
        return Promise.all([fetchRules(s), fetchCandles(s, start, end, function (n) {
          counts[s] = n;
          status("ดาวน์โหลดแท่ง 15 นาที: " + symbols.map(function (x) { return x + " " + (counts[x] || 0).toLocaleString(); }).join(" · "));
        })]).then(function (r) { rules[s] = r[0]; data[s] = r[1]; });
      }));
    }).then(function () {
      status("กำลังคำนวณ… (อาจใช้เวลาหลายวินาที)");
      return new Promise(function (resolve) { setTimeout(resolve, 50); });
    }).then(function () {
      var cfg = Engine.config({ symbols: symbols, usdt_thb: fxInfo.rate, initial_thb: readNumber("capital", 10000),
        fee: readNumber("fee", 0.1) / 100, slippage: readNumber("slip", 0.05) / 100, risk_fraction: readNumber("risk", 0.25) / 100 });
      var t0 = Date.now(), result = Engine.evaluate(data, cfg, rules);
      var research = Engine.research(result, rules);
      last = { result: result, research: research, fx: fxInfo, symbols: symbols, symbol: symbols[0] };
      render();
      status("เสร็จใน " + ((Date.now() - t0) / 1000).toFixed(1) + " วินาที · " + result.bars.toLocaleString() + " แท่ง/คู่ · USDT/THB " +
        fxInfo.rate.toFixed(2) + " (" + fxInfo.source + ", คงที่ตลอดการทดสอบ)");
    }).catch(function (e) {
      status(e.message || String(e), true);
    }).then(function () { $("run").disabled = false; });
  }

  function render() {
    var r = last.result, fx = last.fx.rate, h = r.splits.holdout, m = h.metrics;
    $("results").classList.remove("hidden");
    $("holdoutRange").textContent = thai(h.start) + " – " + thai(h.end);
    var ci = m.win_rate_ci95_pct;
    var cards = [
      ["Win rate", fmt(m.win_rate_pct, 1) + "%", "ช่วงเชื่อมั่น 95%: " + fmt(ci[0], 1) + "–" + fmt(ci[1], 1) + "%", "big"],
      ["ปิดสถานะ", fmt(m.trade_count, 0) + " ไม้", m.trade_count < 30 ? "น้อยกว่า 30 ไม้ ยังสรุปไม่ได้" : "ช่วง 20% ล่าสุดของข้อมูล", "big"],
      ["กำไรสุทธิ", '<span class="' + tone(m.return_pct) + '">' + fmt(m.return_pct, 2, true) + "%</span>",
        fmt(m.net_profit * fx, 0, true) + " บาท หลังต้นทุน"],
      ["Profit factor", fmt(m.profit_factor, 2), "กำไรรวม ÷ ขาดทุนรวม"],
      ["Max drawdown", fmt(m.max_drawdown_pct, 2) + "%", m.halted ? "หยุดเพราะถึงเกณฑ์ความเสี่ยง" : "จากจุดสูงสุด"],
      ["เฉลี่ยต่อไม้", fmt(m.expectancy * fx, 2, true) + " ฿", "ถือ " + fmt(h.exposure_bar_pct, 1) + "% ของเวลา"]
    ];
    $("hero").innerHTML = cards.map(function (c) {
      return '<div class="stat ' + (c[3] || "") + '"><small>' + c[0] + "</small><b>" + c[1] + "</b><small>" + c[2] + "</small></div>";
    }).join("");
    $("warnings").innerHTML = r.warnings.map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("");

    var names = { development: "Dev", validation: "Valid", holdout: "Holdout" };
    var rows = Object.keys(r.splits).map(function (k) { return [names[k], r.splits[k].metrics]; });
    rows.push(["ต้นทุนสูง", r.stress.metrics]);
    rows.push(["ซื้อถือ", r.benchmark.metrics]);
    $("splits").innerHTML = rows.map(function (x) {
      var mm = x[1];
      return "<tr><td>" + x[0] + "</td><td>" + (x[0] === "ซื้อถือ" ? "—" : fmt(mm.trade_count, 0)) + "</td><td>" + (mm.win_rate_pct === null ? "—" : fmt(mm.win_rate_pct, 1) + "%") +
        '</td><td class="' + tone(mm.return_pct) + '">' + fmt(mm.return_pct, 2, true) + "%</td><td>" + fmt(mm.profit_factor, 2) +
        "</td><td>" + fmt(mm.max_drawdown_pct, 2) + "%</td></tr>";
    }).join("");

    renderResearch(fx);

    $("trades").innerHTML = h.trades.slice(-30).reverse().map(function (t) {
      return '<div class="trade"><div><b>' + t.symbol.replace("USDT", "") + "</b> " + thai(t.entry_time) + " → " + thai(t.exit_time) +
        '<br><small>' + (REASONS[t.reason] || esc(t.reason)) + " · เข้า " + fmt(t.entry_price, 2) + " ออก " + fmt(t.exit_price, 2) +
        '</small></div><div class="' + tone(t.pnl) + '">' + fmt(t.pnl * fx, 2, true) + " ฿</div></div>";
    }).join("") || '<p class="muted">ไม่มีรายการปิดสถานะในช่วงนี้</p>';

    $("symbolTabs").innerHTML = last.symbols.map(function (s) {
      return '<button data-s="' + s + '" class="' + (s === last.symbol ? "on" : "") + '">' + s.replace("USDT", "/USDT") + "</button>";
    }).join("");
    Array.prototype.forEach.call($("symbolTabs").children, function (b) {
      b.onclick = function () { last.symbol = b.getAttribute("data-s"); render(); };
    });
    drawCandles();
    drawEquity();
  }

  var VARIANT_NAMES = {};
  Engine.VARIANTS.forEach(function (v) { VARIANT_NAMES[v[0]] = v[1]; });

  function renderResearch(fx) {
    var rs = last.research, wf = rs.walk_forward;
    if (wf) {
      var m = wf.metrics, ci = m.win_rate_ci95_pct;
      $("wfHero").innerHTML = [
        ["Win rate", fmt(m.win_rate_pct, 1) + "%", m.trade_count ? "95%: " + fmt(ci[0], 1) + "–" + fmt(ci[1], 1) + "%" : "ยังไม่มีไม้"],
        ["ปิดสถานะ", fmt(m.trade_count, 0) + " ไม้", m.trade_count < 30 ? "น้อยกว่า 30 ไม้ ยังสรุปไม่ได้" : wf.windows.length + " รอบ × 30 วัน"],
        ["กำไรสุทธิ", '<span class="' + tone(m.return_pct) + '">' + fmt(m.return_pct, 2, true) + "%</span>", fmt(m.net_profit * fx, 0, true) + " บาท"],
        ["PF · Max DD", fmt(m.profit_factor, 2) + " · " + fmt(m.max_drawdown_pct, 1) + "%", "PF > 1 = กำไรมากกว่าขาดทุน"]
      ].map(function (c) { return '<div class="stat"><small>' + c[0] + "</small><b>" + c[1] + "</b><small>" + c[2] + "</small></div>"; }).join("");
      $("wfWindows").innerHTML = wf.windows.map(function (w) {
        return "<tr><td>" + thai(w.start).slice(0, 8) + "</td><td>" + (w.variant ? esc(VARIANT_NAMES[w.variant] || w.variant) : '<span class="muted">ถือเงินสด</span>') +
          "</td><td>" + w.trade_count + '</td><td class="' + tone(w.return_pct) + '">' + fmt(w.return_pct, 2, true) + "%</td></tr>";
      }).join("");
    } else {
      $("wfHero").innerHTML = '<p class="muted">ต้องใช้ข้อมูลมากกว่า 100 วัน เลือก 365 หรือ 730 วัน</p>';
      $("wfWindows").innerHTML = "";
    }
    var h = rs.chosen_holdout && rs.chosen_holdout.metrics;
    // Verdict: chosen on validation and confirmed once on holdout; plus what walk-forward picked most.
    var counts = {};
    (wf ? wf.windows : []).forEach(function (w) { if (w.variant) counts[w.variant] = (counts[w.variant] || 0) + 1; });
    var favourite = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    var passed = h && h.trade_count >= 30 && h.return_pct > 0 && (h.profit_factor || 0) > 1;
    var wfOk = wf && wf.metrics.trade_count >= 30 && wf.metrics.return_pct > 0;
    var box;
    if (passed) {
      box = '<div class="banner go">ผู้ชนะ: ' + esc(VARIANT_NAMES[rs.chosen]) + "</div><small>เลือกจากช่วง Valid แล้วผ่าน Holdout ที่ไม่เคยใช้: " +
        h.trade_count + " ไม้ · win " + fmt(h.win_rate_pct, 1) + "% · กำไร " + fmt(h.return_pct, 2, true) + "% · PF " + fmt(h.profit_factor, 2) +
        " · Max DD " + fmt(h.max_drawdown_pct, 1) + "%<br>ขั้นต่อไป: ตามสัญญาณด้วยเงินจำลองหรือเงินน้อย 1–2 เดือน แล้วเทียบผลจริงกับตัวเลขนี้</small>";
    } else if (rs.chosen) {
      box = '<div class="banner wait">ยังไม่มีผู้ชนะ</div><small>' + esc(VARIANT_NAMES[rs.chosen]) + " ดีที่สุดในช่วง Valid แต่ตกช่วง Holdout (" +
        fmt(h.trade_count, 0) + " ไม้ · " + fmt(h.return_pct, 2, true) + "% · PF " + fmt(h.profit_factor, 2) + ") — ข้อได้เปรียบไม่คงที่ ยังไม่ควรใช้เงินจริง</small>";
    } else {
      box = '<div class="banner wait">ยังไม่มีผู้ชนะ</div><small>ไม่มีกลยุทธ์ไหนกำไรเฉลี่ยต่อไม้เป็นบวกทั้งช่วง Dev และ Valid — ช่วงข้อมูลนี้ยังไม่พบสัญญาณที่ได้เปรียบ ลองเลือก 730 วัน หรือรอข้อมูลเพิ่ม</small>';
    }
    box += '<p class="muted" style="font-size:13px;margin:8px 0 0">Walk-forward: ' + (wf ? (wfOk ? "<span class=\"up\">กำไร</span> " : "ยังไม่ผ่าน ") +
      fmt(wf.metrics.return_pct, 2, true) + "% จาก " + wf.metrics.trade_count + " ไม้" +
      (favourite ? " · ถูกเลือกบ่อยสุด: " + esc(VARIANT_NAMES[favourite]) + " (" + counts[favourite] + "/" + wf.windows.length + " รอบ)" : " · ถือเงินสดทุกรอบ") : "ข้อมูลไม่พอ") + "</p>";
    $("bestBox").innerHTML = box;
    $("researchVerdict").innerHTML = !rs.chosen
      ? "ไม่มีกลยุทธ์ไหนผ่านเกณฑ์ (กำไรเฉลี่ยต่อไม้เป็นบวกทั้ง Dev และ Valid และ Valid ≥ 30 ไม้) — ยังไม่ควรใช้เงินจริง"
      : "เลือกจาก Valid: <b>" + esc(VARIANT_NAMES[rs.chosen]) + "</b> → ทดสอบ Holdout ครั้งเดียว: " + fmt(h.trade_count, 0) + " ไม้ · win " +
        fmt(h.win_rate_pct, 1) + '% · <span class="' + tone(h.return_pct) + '">' + fmt(h.return_pct, 2, true) + "%</span> · PF " + fmt(h.profit_factor, 2);
    var vcell = function (m) { return m.trade_count + " · " + fmt(m.win_rate_pct, 0) + "%<br>PF " + fmt(m.profit_factor, 2); };
    $("variants").innerHTML = rs.variants.map(function (v) {
      return "<tr><td>" + esc(VARIANT_NAMES[v.name]) + (v.name === rs.chosen ? '<br><small class="muted">ถูกเลือกจาก Valid</small>' : "") + "</td><td>" + vcell(v.development) + "</td><td>" +
        vcell(v.validation) + "</td><td>" + vcell(v.holdout) + "</td><td>" + validBadge(v.validated) + "</td></tr>";
    }).join("");
  }

  function sec(ms) { return Math.floor(ms / 1000) + THAI_OFFSET_S; }

  function baseOptions(el) {
    return { width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: "solid", color: "#181a20" }, textColor: "#848e9c", fontSize: 11 },
      grid: { vertLines: { color: "#202630" }, horzLines: { color: "#202630" } },
      rightPriceScale: { borderColor: "#2b3139" }, timeScale: { borderColor: "#2b3139", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 } };
  }

  function drawCandles() {
    var el = $("chart"), s = last.symbol, rows = last.result.prepared[s];
    if (candleChart) candleChart.remove();
    candleChart = LightweightCharts.createChart(el, baseOptions(el));
    var candles = candleChart.addCandlestickSeries({ upColor: "#0ecb81", downColor: "#f6465d", borderVisible: false,
      wickUpColor: "#0ecb81", wickDownColor: "#f6465d" });
    candles.setData(rows.map(function (r) { return { time: sec(r.time), open: r.open, high: r.high, low: r.low, close: r.close }; }));
    var line = function (key, color) {
      var series = candleChart.addLineSeries({ color: color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      series.setData(rows.filter(function (r) { return isFinite(r[key]); }).map(function (r) { return { time: sec(r.time), value: r[key] }; }));
    };
    line("ema50", "#ffb74d");
    line("poc", "#4dd0e1");
    var markers = [];
    Object.keys(last.result.splits).forEach(function (k) {
      last.result.splits[k].trades.forEach(function (t) {
        if (t.symbol !== s) return;
        markers.push({ time: sec(Math.floor(t.entry_time / Engine.BAR_MS) * Engine.BAR_MS), position: "belowBar", color: "#0ecb81", shape: "arrowUp" });
        markers.push({ time: sec(Math.floor(t.exit_time / Engine.BAR_MS) * Engine.BAR_MS), position: "aboveBar",
          color: t.pnl > 0 ? "#0ecb81" : "#f6465d", shape: "arrowDown" });
      });
    });
    markers.sort(function (a, b) { return a.time - b.time; });
    candles.setMarkers(markers);
    var n = rows.length;
    candleChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 200), to: n + 5 });
  }

  function drawEquity() {
    var el = $("equity"), fx = last.fx.rate;
    if (equityChart) equityChart.remove();
    equityChart = LightweightCharts.createChart(el, baseOptions(el));
    var plot = function (curve, color) {
      var series = equityChart.addLineSeries({ color: color, lineWidth: 2, priceLineVisible: false });
      var seen = {}, data = [];
      curve.forEach(function (p) { var t = sec(Math.ceil(p.time / 60000) * 60000); if (!seen[t]) { seen[t] = 1; data.push({ time: t, value: p.equity * fx }); } else data[data.length - 1].value = p.equity * fx; });
      series.setData(data);
    };
    plot(last.result.benchmark.curve, "#86a9ff");
    plot(last.result.splits.holdout.curve, "#0ecb81");
    equityChart.timeScale().fitContent();
  }

  window.addEventListener("resize", function () {
    [[candleChart, "chart"], [equityChart, "equity"]].forEach(function (x) {
      if (x[0]) x[0].applyOptions({ width: $(x[1]).clientWidth });
    });
  });

  // ---- My portfolio: balance, money management, monthly goal (stored on this device) ----
  var Portfolio = (function () {
    var KEY = "portfolio.v1", FEE = 0.001, DAILY_STOP = 2, HALF_RISK_DD = 4, HARD_STOP_DD = 8;
    function load() {
      try { var v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v && v.trades) return v; } catch (e) { /* ignore */ }
      return { trades: [], nextId: 1 };
    }
    var data = load();
    function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* storage optional */ } }
    function settings() {
      return { capital: readNumber("pfCapital", 10000), risk: readNumber("pfRisk", 0.5), target: readNumber("pfTarget", 3) };
    }
    function thaiDay(ms) { return new Date(ms + THAI_OFFSET_S * 1000).toISOString().slice(0, 10); }

    function plan() {
      var st = settings(), closed = data.trades.filter(function (t) { return t.closed; });
      closed.sort(function (a, b) { return a.exit_time - b.exit_time; });
      var balance = st.capital, peak = st.capital, today = thaiDay(Date.now()), dayStart = null, todayPnl = 0;
      closed.forEach(function (t) {
        if (thaiDay(t.exit_time) === today) { if (dayStart === null) dayStart = balance; todayPnl += t.pnl; }
        balance += t.pnl; peak = Math.max(peak, balance);
      });
      if (dayStart === null) dayStart = balance;
      var dd = peak > 0 ? (1 - balance / peak) * 100 : 0, riskPct = st.risk, state = "ok", message = "";
      // Trend 4H: the stop rule research/pro chose on 2020-2022 (trend losing runs are long and normal, so the old
      // 4% / 8% stops would quit before the recoveries), and no new entries beyond the deepest drawdown of the test.
      var tr = isTrend(curTf()) ? trendNormal() : null, half = tr && tr.stop && /^half(\d+)$/.exec(tr.stop.id);
      if (tr && tr.stop && tr.stop.id !== "app") {
        if (tr.port && dd > tr.port.maxDD) {
          state = "stop"; riskPct = 0;
          message = "หยุดเข้าไม้ใหม่: พอร์ตลง " + fmt(dd, 1) + "% จากจุดสูงสุด เกินที่ผลทดสอบเคยเจอ (" + fmt(tr.port.maxDD, 1) + "%) · ถือไม้เดิมตามสูตร แล้วทบทวนก่อนเทรดต่อ";
        } else if (tr.stop.id === "day2" && todayPnl <= -dayStart * 0.02) {
          state = "day"; riskPct = 0; message = "หยุดวันนี้: ขาดทุนวันนี้ถึง 2% แล้ว (กติกาที่ผลทดสอบเลือก) พรุ่งนี้เทรดต่อ";
        } else if (half && dd >= +half[1]) {
          state = "half"; riskPct = st.risk / 2; message = "พอร์ตลง " + fmt(dd, 1) + "% จากจุดสูงสุด: ลดความเสี่ยงเหลือครึ่งหนึ่ง (" + fmt(riskPct, 2) + "% ต่อไม้) จนกว่าจะกลับขึ้นมา (กติกาที่ผลทดสอบเลือก)";
        }
        return { settings: st, balance: balance, peak: peak, dd: dd, riskPct: riskPct, riskThb: balance * riskPct / 100,
          state: state, message: message, closed: closed, todayPnl: todayPnl,
          rule: tr.stop.id === "none" && tr.port ? "เทรดทุกสัญญาณ · หยุดเข้าไม้ใหม่ถ้าลงเกิน " + fmt(tr.port.maxDD, 1) + "%" : tr.stop.name };
      }
      if (dd >= HARD_STOP_DD) { state = "stop"; riskPct = 0; message = "หยุดเทรด: ยอดลงจากจุดสูงสุด " + fmt(dd, 1) + "% (เกณฑ์ " + HARD_STOP_DD + "%) ทบทวนระบบก่อนเทรดต่อ"; }
      else if (todayPnl <= -dayStart * DAILY_STOP / 100) { state = "day"; riskPct = 0; message = "หยุดวันนี้: ขาดทุนวันนี้ถึง " + DAILY_STOP + "% แล้ว พรุ่งนี้ค่อยเทรดใหม่"; }
      else if (dd >= HALF_RISK_DD) { state = "half"; riskPct = st.risk / 2; message = "ยอดลง " + fmt(dd, 1) + "% จากจุดสูงสุด: ลดความเสี่ยงเหลือครึ่งหนึ่ง (" + fmt(riskPct, 2) + "% ต่อไม้) จนกว่าจะกลับมา"; }
      return { settings: st, balance: balance, peak: peak, dd: dd, riskPct: riskPct, riskThb: balance * riskPct / 100,
        state: state, message: message, closed: closed, todayPnl: todayPnl };
    }

    function open(sig) {
      data.trades.push({ id: data.nextId++, symbol: sig.symbol, entry: sig.entry, stop: sig.stop, target: sig.target,
        qty: sig.qty, fx: sig.fx, risk: sig.risk, dir: sig.dir || 1, fee: sig.fee, lev: sig.lev, tps: sig.tps, exit_rule: sig.exit_rule,
        hold_hours: sig.hold_hours || 4, entry_time: Date.now(), closed: false });
      save(); render();
    }
    function close(id, exitPrice) {
      var t = data.trades.filter(function (x) { return x.id === id; })[0];
      if (!t || !(exitPrice > 0)) return;
      var dir = t.dir || 1, fee = t.fee === undefined ? FEE : t.fee;
      var usdt = (dir * (exitPrice - t.entry) - fee * (exitPrice + t.entry)) * t.qty;
      t.exit = exitPrice; t.exit_time = Date.now(); t.pnl = usdt * t.fx; t.r = t.risk > 0 ? t.pnl / t.risk : null; t.closed = true;
      save(); render();
    }
    function remove(id) { data.trades = data.trades.filter(function (x) { return x.id !== id; }); save(); render(); }

    // Side-by-side: "drag 10% every trade" habits vs the app's fixed-risk sizing over a losing streak.
    function renderMM(p) {
      var n = parseInt($("mmN").value, 10), cap = p.balance, stop = 0.012, cost = 0.0014;
      var appRisk = (locked() ? Math.min(LOCK.riskPct, p.settings.risk) : p.settings.risk) / 100;
      $("mmNLabel").textContent = n;
      $("mmLoss").textContent = fmt(cap * appRisk, 0) + " บาท (" + fmt(appRisk * 100, 2) + "% ของทุน)";
      var ways = [
        ["ตามแอป (เสี่ยงไม้ละ " + fmt(appRisk * 100, 2) + "%)", appRisk, "app"],
        ["ลาก 10% ทุกไม้ · x10", 0.10 * 10 * (stop + cost), ""],
        ["ลาก 10% ทุกไม้ · x20", 0.10 * 20 * (stop + cost), ""],
        ["ลาก 10% ทุกไม้ · x50", 0.10 * 50 * (stop + cost), ""],
        ["ลาก 10% ทุกไม้ · ไม่ตั้ง Stop (โดน Liquidate)", 0.10, ""]
      ];
      $("mmCompare").innerHTML = ways.map(function (w) {
        var left = Math.max(0, Math.pow(1 - Math.min(w[1], 1), n)), color = left > 0.9 ? "#0ecb81" : left > 0.7 ? "#f0b90b" : "#f6465d";
        return '<div class="mmrow ' + w[2] + '"><div class="lbl"><span>' + esc(w[0]) + "</span><b>เหลือ " + fmt(cap * left, 0) + " ฿ (" + fmt((left - 1) * 100, 0) + "%)</b></div>" +
          '<div class="track"><i style="width:' + (left * 100).toFixed(1) + "%;background:" + color + '"></i></div></div>';
      }).join("");
    }

    function render() {
      var p = plan(), st = p.settings, now = Date.now(), month = thaiDay(now).slice(0, 7);
      renderMM(p);
      $("pfState").innerHTML = p.state === "ok" ? "" : '<div class="banner stop">' + esc(p.message) + "</div>";
      var wins = p.closed.filter(function (t) { return t.pnl > 0; }).length;
      $("pfHero").innerHTML = [
        ["ยอดคงเหลือ", fmt(p.balance, 0) + " ฿", '<span class="' + tone(p.balance - st.capital) + '">' + fmt(p.balance - st.capital, 0, true) + " ฿ (" + fmt((p.balance / st.capital - 1) * 100, 2, true) + "%)</span>"],
        ["เสี่ยงไม้ถัดไป", fmt(p.riskThb, 0) + " ฿", fmt(p.riskPct, 2) + "% ของยอด" + (p.state === "half" ? " (ลดครึ่ง)" : "")],
        ["Win rate ของฉัน", p.closed.length ? fmt(wins / p.closed.length * 100, 0) + "%" : "—", p.closed.length + " ไม้ที่ปิดแล้ว"],
        ["ลงจากจุดสูงสุด", fmt(p.dd, 1) + "%", p.rule ? "กติกา: " + esc(p.rule) : "ลดเสี่ยงที่ " + HALF_RISK_DD + "% · หยุดที่ " + HARD_STOP_DD + "%"]
      ].map(function (c) { return '<div class="stat"><small>' + c[0] + "</small><b>" + c[1] + "</b><small>" + c[2] + "</small></div>"; }).join("");

      // Monthly goal: what it takes in R, and what the record so far projects.
      var monthTrades = p.closed.filter(function (t) { return thaiDay(t.exit_time).slice(0, 7) === month; });
      var monthPnl = monthTrades.reduce(function (a, t) { return a + t.pnl; }, 0);
      var monthStart = p.balance - monthPnl, goal = monthStart * st.target / 100;
      var progress = goal > 0 ? Math.max(0, Math.min(100, monthPnl / goal * 100)) : 0;
      var needR = st.risk > 0 ? st.target / st.risk : Infinity;
      var rs = p.closed.filter(function (t) { return t.r !== null && isFinite(t.r); }).map(function (t) { return t.r; });
      var avgR = rs.length ? rs.reduce(function (a, b) { return a + b; }, 0) / rs.length : null;
      var firstMs = p.closed.length ? p.closed[0].entry_time : now, months = Math.max((now - firstMs) / (30 * 86400000), 0.25);
      var perMonth = p.closed.length / months;
      var projection = avgR === null || p.closed.length < 10
        ? "ยังคาดการณ์ไม่ได้: ต้องมีไม้ที่ปิดแล้วอย่างน้อย 10 ไม้ (ตอนนี้ " + p.closed.length + ")"
        : "ถ้าผลเหมือนที่ผ่านมา (เฉลี่ย " + fmt(avgR, 2, true) + "R/ไม้, ~" + fmt(perMonth, 0) + " ไม้/เดือน) เดือนหน้าคาดว่า ≈ " +
          fmt(avgR * perMonth * st.risk, 1, true) + "% (" + fmt(avgR * perMonth * p.riskThb, 0, true) + " ฿) — ค่าเฉลี่ย ไม่ใช่สัญญา ช่วงจริงกว้างกว่านี้มาก";
      $("pfGoal").innerHTML = "<div>เดือนนี้ " + '<b class="' + tone(monthPnl) + '">' + fmt(monthPnl, 0, true) + " ฿</b> จากเป้า " + fmt(goal, 0) + " ฿ (" + st.target + "%)</div>" +
        '<div class="bar"><i style="width:' + progress.toFixed(1) + '%"></i></div>' +
        "<small>เป้า " + st.target + "% ที่เสี่ยง " + st.risk + "%/ไม้ = ต้องได้สุทธิ +" + fmt(needR, 1) + "R ต่อเดือน เช่น " + fmt(needR / 0.2, 0) +
        " ไม้ที่เฉลี่ย +0.2R หรือ " + fmt(needR / 0.5, 0) + " ไม้ที่เฉลี่ย +0.5R" + (needR > 15 ? " — สูงเกินจริงสำหรับระบบนี้ ลดเป้าลง" : "") + "</small>" +
        "<p class=\"muted\" style=\"font-size:13px;margin:8px 0 0\">" + projection + "</p>";

      var openTrades = data.trades.filter(function (t) { return !t.closed; });
      $("pfOpen").innerHTML = openTrades.map(function (t) {
        var side = (t.dir || 1) > 0 ? '<span class="up">LONG</span>' : '<span class="down">SHORT</span>';
        return '<div class="trade" style="display:block"><b>' + t.symbol.replace("USDT", "") + "</b> " + side + (t.lev ? " x" + t.lev : "") + " · " + t.qty + " เหรียญ · เข้า " + price(t.entry) +
          '<br><small>SL <span class="down">' + price(t.stop) + "</span> · " + (t.exit_rule ? esc(t.exit_rule) : t.tps ? "TP " + t.tps.map(price).join(" / ") : 'เป้า <span class="up">' + price(t.target) + "</span>") +
          " · เสี่ยง " + fmt(t.risk, 0) + " ฿" + (t.exit_rule ? "" : " · ปิดภายใน " + thai(t.entry_time + (t.hold_hours || 4) * 3600000).slice(0, 14) + " น.") + '</small><div class="inline"><input type="number" inputmode="decimal" step="any" placeholder="ราคาที่ปิด" id="exit' + t.id +
          '"><button class="mini" data-close="' + t.id + '">ปิดไม้</button><button class="mini ghost" data-del="' + t.id + '">ลบ</button></div></div>';
      }).join("") || '<p class="muted">ไม่มีไม้ที่ถืออยู่ กด "ซื้อแล้ว · บันทึกลงพอร์ต" ที่การ์ดสัญญาณเพื่อเพิ่ม</p>';
      $("pfClosed").innerHTML = p.closed.slice(-20).reverse().map(function (t) {
        return '<div class="trade"><div><b>' + t.symbol.replace("USDT", "") + "</b> " + price(t.entry) + " → " + price(t.exit) + "<br><small>" + thai(t.exit_time) +
          (t.r !== null ? " · " + fmt(t.r, 2, true) + "R" : "") + '</small></div><div class="' + tone(t.pnl) + '">' + fmt(t.pnl, 0, true) + " ฿</div></div>";
      }).join("") || '<p class="muted">ยังไม่มีไม้ที่ปิด</p>';
      Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function (b) {
        b.onclick = function () { var id = +b.getAttribute("data-close"); close(id, parseFloat($("exit" + id).value)); };
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-del]"), function (b) {
        b.onclick = function () {
          if (b.textContent === "ยืนยันลบ") remove(+b.getAttribute("data-del")); else b.textContent = "ยืนยันลบ";
        };
      });
    }

    $("mmN").addEventListener("input", function () { renderMM(plan()); });
    ["pfCapital", "pfRisk", "pfTarget"].forEach(function (id) {
      try { var v = localStorage.getItem(id); if (v !== null) $(id).value = v; } catch (e) { /* ignore */ }
      $(id).addEventListener("input", function () { try { localStorage.setItem(id, $(id).value); } catch (e) { /* ignore */ } render(); });
    });
    // The price actually filled replaces the signal's reference price; the risk follows (distance to the same SL).
    function setEntry(id, px) {
      var t = data.trades.filter(function (x) { return x.id === id; })[0];
      if (!t || !(px > 0)) return;
      t.entry = px; t.risk = Math.abs(px - t.stop) * t.qty * t.fx + (t.fee || 0) * 2 * px * t.qty * t.fx;
      save(); render();
    }
    return { plan: plan, open: open, render: render, close: close, setEntry: setEntry,
      openTrades: function () { return data.trades.filter(function (t) { return !t.closed; }); } };
  })();

  // ---- Live signal scan ----
  var COINS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
    "LINKUSDT", "DOTUSDT", "TRXUSDT", "LTCUSDT"];
  function selectedCoins() {
    try {
      var stored = localStorage.getItem("alertCoins");
      if (stored) {
        var enabled = JSON.parse(stored);
        if (Array.isArray(enabled)) return COINS.filter(function (x) { return enabled.indexOf(x) >= 0; });
      }
    } catch (e) { /* fallback */ }
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  }
  function initSignalSettings() {
    var tf = $("alertTf"), lev = $("alertLev"), box = $("alertCoinList");
    tf.value = curTf();
    try { lev.value = localStorage.getItem("alertLeverage") || "10"; } catch (e) { lev.value = "10"; }
    if (!/^(5|10|20|50)$/.test(lev.value)) lev.value = "10";
    var active = selectedCoins();
    box.innerHTML = COINS.map(function (symbol) {
      return '<label style="display:flex;align-items:center;gap:4px;margin:0;min-width:74px;color:#eaecef"><input type="checkbox" data-coin="' + symbol + '" ' +
        (active.indexOf(symbol) >= 0 ? "checked" : "") + ' style="width:auto">' + symbol.replace("USDT", "") + '</label>';
    }).join("");
    function saveCoins() {
      var selected = Array.prototype.map.call(box.querySelectorAll("input:checked"), function (x) { return x.getAttribute("data-coin"); });
      try { localStorage.setItem("alertCoins", JSON.stringify(selected)); } catch (e) {}
    }
    box.addEventListener("change", saveCoins);
    $("alertAllCoins").onclick = function () { box.querySelectorAll("input").forEach(function (x) { x.checked = true; }); saveCoins(); };
    $("alertCoreCoins").onclick = function () {
      box.querySelectorAll("input").forEach(function (x) { x.checked = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].indexOf(x.getAttribute("data-coin")) >= 0; });
      saveCoins();
    };
    tf.onchange = function () { setTradeTf(tf.value); modeHelp(); scheduleAuto(); };
    // Risk per trade lives in the portfolio setting (pfRisk); this picker is its visible control.
    var risk = $("riskSel"), P = window.EVIDENCE_TREND && window.EVIDENCE_TREND.portfolio;
    Array.prototype.forEach.call(risk.options, function (o) {
      var x = P && P[o.value];
      if (x) o.textContent = o.value + "% · ทดสอบ Trend 4H: ปีละ ~" + fmt(x.cagr, 0) + "% · ลงลึกสุด ~" + fmt(x.maxDD, 0) + "%";
    });
    risk.value = String(trendRiskPct());
    // Take-profit mode for Trend 4H: the scale-out plan chosen in research/pro, or none (the channel exit only).
    var tpSel = $("tpModeSel"), T = window.EVIDENCE_TREND;
    if (T && T.ladder) {
      tpSel.options[0].textContent = "แบ่งขาย: " + T.ladder.name + " · ทดสอบ: ชนะ " + T.ladder.test.win + "% · เฉลี่ย " + fmt(T.ladder.test.avgR, 2, true) + "R";
      tpSel.options[1].textContent = "ไม่ตั้ง TP ถือตามเทรนด์ · ทดสอบ: ชนะ " + T.all.win + "% · เฉลี่ย " + fmt(T.all.avgR, 2, true) + "R";
    }
    tpSel.value = tpMode();
    tpSel.onchange = function () { try { localStorage.setItem("tpMode", tpSel.value); } catch (e) { /* ignore */ } scan(); };
    if (!risk.value) risk.value = "0.25";
    risk.onchange = function () { $("pfRisk").value = risk.value; $("pfRisk").dispatchEvent(new Event("input")); modeHelp(); };
    lev.onchange = function () { try { localStorage.setItem("alertLeverage", lev.value); } catch (e) {} };
    if (window.NativeHttp && window.NativeHttp.setScanMinutes) window.NativeHttp.setScanMinutes(TF[tf.value].ms / 60000);
  }
  var scanning = false, autoTimer = null;

  function price(v) {
    if (!isFinite(v)) return "—";
    var d = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function scanStatus(text, isError) { var el = $("scanStatus"); el.textContent = text; el.className = "status-line" + (isError ? " err" : ""); }

  // ---- News: free sources only, no keys and no AI ----
  // Crypto news RSS (English and Thai), Binance announcements (listings, delistings), the Fed and the SEC, and this
  // week's economic calendar (ForexFactory). Headlines that name a coin or a risk word are flagged. News never changes a
  // signal: the rule was not tested with news. It is there so the trader knows what is moving the market, and so an
  // entry alert says when a high-impact US release is due before the next 4-hour close.
  var News = (function () {
    var FEEDS = [
      ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"], ["Cointelegraph", "https://cointelegraph.com/rss"],
      ["Decrypt", "https://decrypt.co/feed"], ["The Block", "https://www.theblock.co/rss.xml"], ["CryptoSlate", "https://cryptoslate.com/feed/"],
      ["Bitcoin Magazine", "https://bitcoinmagazine.com/feed"], ["Siam Blockchain", "https://siamblockchain.com/feed/"],
      ["Bitcoin Addict", "https://bitcoinaddict.org/feed/"], ["Fed", "https://www.federalreserve.gov/feeds/press_all.xml"],
      ["SEC", "https://www.sec.gov/news/pressreleases.rss"]
    ];
    var BINANCE = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=10";
    // Market mood: the Crypto Fear & Greed Index (free, daily), and a fixed word list that reads each headline as good or
    // bad news (no AI: the same words always give the same reading).
    var FNG = "https://api.alternative.me/fng/?limit=8";
    var BULL = /surg|soar|rall(y|ies)|jump|record high|all-time high|\bATH\b|breakout|bullish|approv|inflow|adopt|partnership|upgrade|buys?\b|buying|accumulat|rate cut|เพิ่มขึ้น|พุ่ง|ทะยาน|ทำสถิติ|อนุมัติ|ไหลเข้า|ขาขึ้น/i;
    var BEAR = /plung|crash|tumbl|outage|\bhalt|\bdrops?\b|\bfalls?\b|slump|sell-?off|bearish|hack|exploit|lawsuit|\bsues?\b|charged|\bban(s|ned)?\b|delist|outflow|liquidat|bankrupt|fraud|probe|rate hike|tariff|ร่วง|ดิ่ง|ทรุด|ลดลง|ขาลง|แฮ็ก|ฟ้อง|ถอดถอน|ไหลออก/i;
    function toneOf(title) { var b = BULL.test(title) ? 1 : 0, d = BEAR.test(title) ? 1 : 0; return b - d; }
    var CALENDAR = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
    var NAMES = { BTC: "bitcoin", ETH: "ethereum", BNB: "bnb", SOL: "solana", XRP: "xrp|ripple", DOGE: "dogecoin", ADA: "cardano",
      AVAX: "avalanche", LINK: "chainlink", DOT: "polkadot", TRX: "tron", LTC: "litecoin" };
    var RISK = /hack|exploit|delist|lawsuit|\bsues?\b|charged|\bban(s|ned)?\b|bankrupt|insolven|\bhalt|outage|suspend|liquidat|\bETF\b|FOMC|\bCPI\b|rate (cut|hike)|tariff|แฮ็ก|ถอดถอน|ระงับ|ฟ้อง/i;
    var KEY = "news.v1", HOUR = 3600000, s = { items: [], events: [], at: 0, calAt: 0, errors: [] }, inflight = null, timer = null;
    try { var c = JSON.parse(localStorage.getItem(KEY) || "null"); if (c && c.items) s = c; } catch (e) { /* first run */ }
    function coinsIn(text) {
      return Object.keys(NAMES).filter(function (k) { return new RegExp("\\b" + k + "\\b").test(text) || new RegExp("\\b(" + NAMES[k] + ")\\b", "i").test(text); });
    }
    function item(src, title, link, time) {
      title = String(title || "").replace(/\s+/g, " ").trim();
      return { src: src, title: title, link: link || "", time: time || 0, coins: coinsIn(title), risk: RISK.test(title) };
    }
    function rss(src, xml) {
      var d = new DOMParser().parseFromString(xml, "text/xml"), nodes = d.getElementsByTagName("item");
      if (!nodes.length) nodes = d.getElementsByTagName("entry");
      var get = function (n, tag) { var e = n.getElementsByTagName(tag)[0]; return e ? e.textContent : ""; };
      return Array.prototype.slice.call(nodes, 0, 20).map(function (n) {
        var linkEl = n.getElementsByTagName("link")[0], link = linkEl ? (linkEl.getAttribute("href") || linkEl.textContent) : "";
        return item(src, get(n, "title"), link.trim(), Date.parse(get(n, "pubDate") || get(n, "updated") || get(n, "published")) || 0);
      }).filter(function (x) { return x.title; });
    }
    function binance(json) {
      var out = [];
      ((JSON.parse(json).data || {}).catalogs || []).forEach(function (cat) {
        (cat.articles || []).forEach(function (a) {
          out.push(item("Binance · " + (cat.catalogName || ""), a.title, "https://www.binance.com/en/support/announcement/" + a.code, a.releaseDate));
        });
      });
      return out;
    }
    function calendar(json) {
      return JSON.parse(json).filter(function (e) { return e.country === "USD" && (e.impact === "High" || e.impact === "Medium"); })
        .map(function (e) { return { title: e.title, time: Date.parse(e.date), impact: e.impact, forecast: e.forecast || "", previous: e.previous || "" }; });
    }
    // All sources at once; each failure is listed and the others still show. The calendar is fetched once an hour.
    function refresh(force) {
      if (inflight) return inflight;
      if (!force && Date.now() - s.at < 90000) return Promise.resolve(s);
      var errors = [], items = [], wantCal = force || Date.now() - s.calAt > HOUR;
      var jobs = FEEDS.map(function (f) {
        return httpGet(f[1]).then(function (t) { items = items.concat(rss(f[0], t)); }, function (e) { errors.push(f[0] + ": " + String(e.message).slice(0, 60)); });
      });
      jobs.push(httpGet(BINANCE).then(function (t) { items = items.concat(binance(t)); }, function (e) { errors.push("Binance: " + String(e.message).slice(0, 60)); }));
      if (wantCal || !s.fng) jobs.push(httpGet(FNG).then(function (t) {
        var d = (JSON.parse(t).data || []).map(function (x) { return +x.value; });
        if (d.length) s.fng = { v: d[0], prev7: d[7] !== undefined ? d[7] : d[d.length - 1], at: Date.now() };
      }, function (e) { errors.push("Fear & Greed: " + String(e.message).slice(0, 60)); }));
      if (wantCal) jobs.push(httpGet(CALENDAR).then(function (t) { s.events = calendar(t); s.calAt = Date.now(); }, function (e) { errors.push("ปฏิทินเศรษฐกิจ: " + String(e.message).slice(0, 60)); }));
      return (inflight = Promise.all(jobs).then(function () {
        if (items.length) {
          var seen = {};
          s.items = items.filter(function (x) { var k = x.title.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; })
            .sort(function (a, b) { return b.time - a.time; }).slice(0, 120);
        }
        s.at = Date.now(); s.errors = errors; inflight = null;
        try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* the next refresh fills it again */ }
        return s;
      }));
    }
    function forCoin(symbol, hours) {
      var k = symbol.replace("USDT", ""), from = Date.now() - hours * HOUR;
      return s.items.filter(function (x) { return x.time >= from && x.coins.indexOf(k) >= 0; });
    }
    // High-impact US releases from an hour ago to `hours` ahead (the calendar's own times, shown in Thai time).
    function upcoming(hours, all) {
      var now = Date.now();
      return s.events.filter(function (e) { return (all || e.impact === "High") && e.time >= now - HOUR && e.time <= now + hours * HOUR; })
        .sort(function (a, b) { return a.time - b.time; });
    }
    // One line for an entry alert: high-impact US releases before the next 4-hour close, and risk headlines on the coin.
    function warnFor(symbol) {
      var ev = upcoming(4).map(function (e) { return e.title + " " + thai(e.time).slice(9, 14) + " น."; });
      var hot = forCoin(symbol, 24).filter(function (x) { return x.risk; }).slice(0, 1).map(function (x) { return x.title.slice(0, 90); });
      return (ev.length ? "ข่าวแรง USD: " + ev.join(", ") : "") + (ev.length && hot.length ? " · " : "") + (hot.length ? "ข่าว: " + hot[0] : "");
    }
    function ago(t) {
      var m = Math.max(0, Math.round((Date.now() - t) / 60000));
      return m < 60 ? m + " นาที" : m < 1440 ? Math.round(m / 60) + " ชม." : Math.round(m / 1440) + " วัน";
    }
    // A headline: green when the word list reads it as good news, red as bad news, plain otherwise.
    function row(x, mine) {
      var t = toneOf(x.title), cls = t > 0 ? "good" : t < 0 ? "bad" : "", tags = x.coins.filter(function (k) { return mine.indexOf(k) >= 0; });
      return '<div class="nw-row ' + cls + '"><a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a><div class="nw-meta">' +
        (cls ? '<span class="chip ' + cls + '">' + (t > 0 ? "ข่าวดี" : "ข่าวร้าย") + "</span>" : "") + (tags.length ? '<span class="chip sym">' + tags.join(" ") + "</span>" : "") +
        "<small>" + esc(x.src) + " · " + ago(x.time) + "ที่แล้ว</small></div></div>";
    }
    function eventsHtml(hours) {
      var list = upcoming(hours, true);
      return list.length ? list.map(function (e) {
        return '<div class="nw-ev"><span class="ev-time">' + thai(e.time).slice(0, 5) + " " + thai(e.time).slice(9, 14) + '</span><div><b>' + esc(e.title) + '</b><div class="nw-meta"><span class="chip">USD</span>' +
          (e.impact === "High" ? '<span class="chip bad">แรง</span>' : "") + (e.forecast || e.previous ? "<small>คาด " + esc(e.forecast || "—") + " · ครั้งก่อน " + esc(e.previous || "—") + "</small>" : "") + "</div></div></div>";
      }).join("") : '<small class="muted">ไม่มีข่าวเศรษฐกิจสหรัฐแรงๆ ใน ' + hours + " ชม. ข้างหน้า</small>";
    }
    // Main screen: high-impact releases soon (top), and the headlines with the user's coins first (bottom).
    function topHtml() {
      var soon = upcoming(24);
      return soon.length ? '<div class="callout warn">' + ic("alert") + "<div><b>ข่าวเศรษฐกิจแรงใน 24 ชม.: " + soon.map(function (e) { return esc(e.title) + " " + thai(e.time).slice(9, 14) + " น."; }).join(" · ") +
        "</b><small>ราคามักกระชากตอนข่าวออก · ใส่ SL ไว้ใน Binance เสมอ · สัญญาณไม่เปลี่ยนตามข่าว (สูตรไม่ได้ทดสอบกับข่าว)</small></div></div>" : "";
    }
    function listHtml(mine, n) {
      var day = Date.now() - 48 * HOUR, list = s.items.filter(function (x) { return x.time >= day; });
      // Binance's own notices (delistings, new contracts) first, then risk words and the user's coins, newest first.
      var score = function (x) { return (/^Binance/.test(x.src) ? 2 : 0) + (x.risk || x.coins.some(function (k) { return mine.indexOf(k) >= 0; }) ? 1 : 0); };
      var first = list.filter(function (x) { return score(x) > 0; }).sort(function (a, b) { return score(b) - score(a) || b.time - a.time; }).slice(0, n);
      var rest = list.filter(function (x) { return first.indexOf(x) < 0; });
      return '<div class="card nw"><div class="card-hd"><b>ข่าว</b><small>ฟรี ไม่มี AI · ' + (s.at ? "อัปเดต " + thai(s.at).slice(9, 14) + " น. · " + list.length + " ข่าวใน 48 ชม." : "กำลังโหลด…") +
        (s.errors.length ? " · โหลดไม่ได้ " + s.errors.length + " แหล่ง" : "") + '</small></div><div class="chips"><span class="chip good">ข่าวดี = เขียว</span><span class="chip bad">ข่าวร้าย = แดง</span></div>' +
        '<div class="nw-sec">ปฏิทินเศรษฐกิจสหรัฐ 48 ชม.</div>' + eventsHtml(48) +
        '<div class="nw-sec">ข่าวที่เกี่ยวกับเหรียญของคุณ / ความเสี่ยง</div>' + (first.map(function (x) { return row(x, mine); }).join("") || '<small class="muted">ไม่มี</small>') +
        "<details><summary>ข่าวอื่น " + rest.length + " ข่าว</summary>" + rest.slice(0, 40).map(function (x) { return row(x, mine); }).join("") + "</details></div>";
    }
    function start(onChange) {
      var tick = function () { if (!document.hidden && location.hash !== "#bg") refresh().then(onChange); };
      clearInterval(timer); timer = setInterval(tick, 120000); tick();
      document.addEventListener("visibilitychange", tick);
    }
    function fngLabel(v) { return v < 25 ? "กลัวสุดขีด" : v < 45 ? "กลัว" : v <= 55 ? "กลาง" : v <= 75 ? "โลภ" : "โลภสุดขีด"; }
    // The mood a trader reads before acting: the index today and its week, and good / bad headlines (24 h) for the market
    // and for one coin.
    function mood(symbol) {
      var day = Date.now() - 24 * HOUR, count = function (list) {
        var o = { good: 0, bad: 0, n: list.length };
        list.forEach(function (x) { var t = toneOf(x.title); if (t > 0) o.good++; else if (t < 0) o.bad++; });
        o.tone = o.good > o.bad ? 1 : o.bad > o.good ? -1 : 0;
        return o;
      };
      var f = s.fng;
      return { fng: f ? { v: f.v, label: fngLabel(f.v), change: f.v - f.prev7 } : null,
        market: count(s.items.filter(function (x) { return x.time >= day; })), coin: symbol ? count(forCoin(symbol, 24)) : null };
    }
    return { refresh: refresh, forCoin: forCoin, upcoming: upcoming, warnFor: warnFor, topHtml: topHtml, listHtml: listHtml, row: row, start: start, mood: mood, toneOf: toneOf,
      fngLabel: fngLabel, state: function () { return s; } };
  })();
  // v6 removed the AI: forget the keys and settings it kept on this phone.
  try { ["aiKeys", "aiKeyIdx", "aiModel", "aiAuto", "aiKey"].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* nothing stored */ }

  // ---- The user's chosen strategy (locked) and its automatic paper trading ----
  var FOMC_DEFAULT = [
    // 2024–2025: from CRYPTO_FUTURES_10000 research. 2026: from memory, NOT verified — check federalreserve.gov.
    "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18",
    "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"
  ];
  var LOCK = { symbol: "BTCUSDT", tech: "squeeze3_ls", lev: 10, riskPct: 0.25, marginShare: 0.05 };
  function locked() { return $("sgLock").checked; }
  function fomcDates() {
    return ($("sgFomc").value.match(/\d{4}-\d{2}-\d{2}/g) || []);
  }

  var Paper = (function () {
    var KEY = "paper.v2", lastFx = 33, chart = null;
    function load() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
    function status(t, err) { $("ppStatus").textContent = t; $("ppStatus").className = "status-line" + (err ? " err" : ""); }

    // Same rules and costs as the research: fee 0.07%/side, no extra slippage, funding 0.01%/8h,
    // risk = min(0.25%, 5% margin x 10x x stop fraction) per trade, compounding.
    function run(startMs, label) {
      if (isTrend(curTf())) return runTrend(startMs, label);
      $("ppTitle").textContent = "BTC · Squeeze v2 · 10x";
      $("ppResearch").textContent = "งานวิจัยปี 2025: 61 ไม้ · win 32.8% · +0.38R · PF 1.50 · Max DD 2.52% · ต้องมี 30 ไม้ก่อนสรุป";
      var opt = Object.assign({}, Swing.DEFAULTS, { fee: 0.0007, slippage: 0, fomcDates: fomcDates() });
      status("กำลังดึงแท่ง 1 ชม. ของ BTCUSDT…");
      var fx = 33;
      return Promise.all([futuresApi("/fapi/v1/time"), fetchFx().catch(function () { return { rate: 33 }; })]).then(function (res) {
        fx = res[1].rate;
        var end = Math.floor(res[0].serverTime / 3600000) * 3600000, from = Math.floor(startMs / 3600000) * 3600000 - 2000 * 3600000;
        return fetchCandles(LOCK.symbol, from, end, function (k) { status("ดึงแล้ว " + k + " แท่ง…"); }, "1h", true);
      }).then(function (bars) {
        lastFx = fx;
        var ind = Swing.indicators(bars, opt), first = 0;
        while (first < bars.length && bars[first].time < startMs) first++;
        var trades = Swing.runTechnique(LOCK.tech, bars, ind, Math.max(first, 260), bars.length, opt);
        render(trades, bars, startMs, label);
        status("อัปเดต " + thai(Date.now()) + " น. · ใช้แท่งที่ปิดแล้วถึง " + thai(bars[bars.length - 1].close_time + 1) + " น.");
      }).catch(function (e) { status(e.message || String(e), true); });
    }

    // Balance curve in baht, one point per closed trade.
    function drawCurve(curve, capital, profit) {
      var el = $("ppChart");
      el.classList.toggle("hidden", curve.length < 3);
      if (chart) { chart.remove(); chart = null; }
      if (curve.length >= 3) {
        chart = LightweightCharts.createChart(el, baseOptions(el));
        var line = chart.addAreaSeries({ lineColor: profit >= 0 ? "#0ecb81" : "#f6465d", topColor: profit >= 0 ? "rgba(14,203,129,.3)" : "rgba(246,70,93,.3)",
          bottomColor: "rgba(0,0,0,0)", lineWidth: 2, priceFormat: { type: "price", precision: 0, minMove: 1 } });
        var seen = {}, data = [];
        curve.forEach(function (pt) { if (seen[pt.time]) data[data.length - 1].value = pt.value; else { seen[pt.time] = 1; data.push(pt); } });
        line.setData(data);
        line.createPriceLine({ price: capital, color: "#848e9c", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "ทุน" });
        chart.timeScale().fitContent();
      }
    }

    // Trend 4H paper: web/trend.js on every selected coin, with 1,500 earlier bars so the rule's state matches the alerts.
    // Only trades that entered after the start count. Risk per trade from the setting, compounding, P&L booked at exit
    // (as in research/pro).
    function runTrend(startMs, label) {
      var coins = selectedCoins(), riskPct = trendRiskPct(), step = TF[TREND.tf].ms, fx = 33, list = [], errors = [];
      $("ppTitle").textContent = "Trend 4H · " + coins.length + " เหรียญ · เสี่ยง " + riskPct + "%/ไม้ · " + (trendLadder() ? "TP แบ่งขาย" : "ไม่ตั้ง TP");
      var A = window.EVIDENCE_TREND && window.EVIDENCE_TREND.all, P = window.EVIDENCE_TREND && window.EVIDENCE_TREND.portfolio;
      $("ppResearch").textContent = A ? "ทดสอบ walk-forward " + trendPeriod() + " (12 เหรียญ): " + A.n + " ไม้ · ชนะ " + A.win + "% · เฉลี่ย " + fmt(A.avgR, 2, true) + "R · PF " + A.pf +
        (P && P[String(riskPct)] ? " · เสี่ยง " + riskPct + "%: ลงลึกสุด " + P[String(riskPct)].maxDD + "%" : "") + " · ต้องมี 30 ไม้ก่อนสรุป" : "";
      if (!coins.length) { status("เลือกเหรียญในแท็บสัญญาณก่อน", true); return Promise.resolve(); }
      status("กำลังดึงแท่ง 4 ชม. ของ " + coins.length + " เหรียญ…");
      return Promise.all([futuresApi("/fapi/v1/time"), fetchFx().catch(function () { return { rate: 33 }; })]).then(function (res) {
        fx = res[1].rate;
        var end = Math.floor(res[0].serverTime / step) * step, from = Math.floor(startMs / step) * step - 1500 * step, queue = coins.slice(), done = 0;
        function worker() {
          var sym = queue.shift();
          if (!sym) return Promise.resolve();
          return fetchCandles(sym, from, end, function () {}, TREND.tf, true).then(function (bars) {
            var lad = trendLadder(), out = Trend.run(bars, { live: true, tps: lad ? lad.tps : null });
            list.push({ symbol: sym, close: bars[bars.length - 1].close, trades: out.trades.filter(function (t) { return t.entry_time >= startMs; }),
              pos: out.pos && out.pos.entry_time >= startMs ? out.pos : null });
          }).catch(function (e) { errors.push(sym.replace("USDT", "") + ": " + e.message); }).then(function () {
            done++; status("ดึงแล้ว " + done + "/" + coins.length + " เหรียญ…");
            return worker();
          });
        }
        return Promise.all([worker(), worker(), worker()]).then(function () { return end; });
      }).then(function (end) {
        if (!list.length) throw new Error("ดึงข้อมูลไม่ได้ทุกเหรียญ: " + errors.join(" · "));
        lastFx = fx;
        renderTrend(list, startMs, label, riskPct);
        status("อัปเดต " + thai(Date.now()) + " น. · แท่ง 4 ชม. ที่ปิดแล้วถึง " + thai(end) + " น." + (errors.length ? " · ข้าม " + errors.join(" · ") : ""));
      }).catch(function (e) { status(e.message || String(e), true); });
    }

    function renderTrend(list, startMs, label, riskPct) {
      var closed = [], open = [];
      list.forEach(function (x) {
        x.trades.forEach(function (t) { closed.push(Object.assign({ symbol: x.symbol }, t)); });
        if (x.pos) open.push(Object.assign({ symbol: x.symbol, now: x.close }, x.pos));
      });
      closed.sort(function (a, b) { return a.exit_time - b.exit_time; });
      var risk = riskPct / 100, capital = readNumber("pfCapital", 10000), money = capital, peak = capital, dd = 0, wins = 0, big = 0, sumR = 0, gp = 0, gl = 0;
      var curve = [{ time: Math.floor(startMs / 1000) + THAI_OFFSET_S, value: capital }];
      var rows = closed.map(function (t) {
        var baht = money * risk * t.r;
        money += baht; peak = Math.max(peak, money); dd = Math.max(dd, 1 - money / peak);
        if (t.r > 0) { wins++; gp += t.r; } else gl -= t.r;
        if (t.r >= 3) big++;
        sumR += t.r;
        curve.push({ time: Math.floor(t.exit_time / 1000) + THAI_OFFSET_S, value: money });
        return { t: t, baht: baht };
      });
      var n = closed.length, days = (Date.now() - startMs) / 86400000, profit = money - capital, pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
      var openB = open.reduce(function (a, t) { return a + money * risk * t.dir * (t.now - t.entry) / t.risk; }, 0);
      var A = window.EVIDENCE_TREND && window.EVIDENCE_TREND.all;
      $("ppHero").innerHTML = [
        [label, fmt(days, 0) + " วัน", "เริ่ม " + thai(startMs).slice(0, 8)],
        ["ปิดแล้ว", n + " ไม้", n < 30 ? "ยังน้อยกว่า 30 ไม้ สรุปไม่ได้" : "พอเริ่มประเมินได้"],
        ["Win rate", n ? fmt(wins / n * 100, 1) + "%" : "—", "ได้ ≥3R " + (n ? fmt(big / n * 100, 1) : "—") + "%"],
        ["R เฉลี่ย · PF", n ? fmt(sumR / n, 2, true) + "R · " + fmt(pf, 2) : "—", A ? "ทดสอบ: " + fmt(A.avgR, 2, true) + "R · " + A.pf : ""],
        ["กำไรพอร์ต", '<span class="' + tone(profit) + '">' + fmt(profit / capital * 100, 2, true) + "%</span>", "เสี่ยง " + riskPct + "%/ไม้ ทบต้น"],
        ["Max DD", fmt(dd * 100, 2) + "%", "ไม้ที่ยังถือ " + open.length]
      ].map(function (c) { return '<div class="stat"><small>' + c[0] + "</small><b>" + c[1] + "</b><small>" + c[2] + "</small></div>"; }).join("");
      var cls, headline, advice;
      if (!n) {
        cls = "wait"; headline = "ยังไม่มีไม้ที่ปิด"; advice = "สูตรนี้เข้าไม่บ่อยและถือหลายวัน แอปจะจดให้เองเมื่อมีไม้";
      } else if (n < 30) {
        cls = "wait"; headline = (profit >= 0 ? "กำไร " : "ขาดทุน ") + fmt(Math.abs(profit), 0) + " บาท";
        advice = "ยังเร็วไปที่จะสรุป มีแค่ " + n + " ไม้ ต้องรอให้ครบ 30 ไม้ก่อน (อีก " + (30 - n) + " ไม้) ระหว่างนี้ยังไม่ควรใช้เงินจริง";
      } else if (profit > 0 && pf > 1) {
        cls = "good"; headline = "กำไร " + fmt(profit, 0) + " บาท ✅";
        advice = "ครบ " + n + " ไม้แล้ว และยังได้กำไร ถ้าจะใช้เงินจริง เริ่มน้อยๆ เสี่ยงไม่เกินที่ตั้งไว้ และตามสัญญาณทุกไม้ (ข้ามบางไม้ = พลาดไม้ใหญ่)";
      } else {
        cls = "bad"; headline = "ขาดทุน " + fmt(Math.abs(profit), 0) + " บาท ❌";
        advice = "ครบ " + n + " ไม้แต่ยังขาดทุน: ตลาดช่วงนี้ไม่มีเทรนด์ สูตรตามเทรนด์ขาดทุนเป็นช่วงๆ ได้ อย่าเพิ่มความเสี่ยง และอย่าใช้เงินจริงจนกว่า Paper จะกลับมาบวก";
      }
      $("ppSimple").innerHTML = '<div class="verdict ' + cls + '"><small>' + esc(label) + " · ใช้ทุนสมมติ " + fmt(capital, 0) + " บาท</small>" +
        '<div class="big ' + (n ? tone(profit) : "") + '">' + headline + "</div>" +
        "<div>ตอนนี้จะมีเงิน <b>" + fmt(money, 0) + " บาท</b>" + (n ? " (" + fmt((money / capital - 1) * 100, 1, true) + "%)" : "") + "</div>" +
        (n ? "<div>เทรด " + n + " ไม้ · ชนะ " + wins + " · แพ้ " + (n - wins) + "</div>" : "") +
        (open.length ? "<div>ไม้ที่ยังถือ " + open.length + ' ไม้ · ยังไม่ปิด <b class="' + tone(openB) + '">' + fmt(openB, 0, true) + " ฿</b></div>" : "") +
        "<p>" + esc(advice) + "</p>" +
        '<p class="muted" style="font-size:12px">สูตรตามเทรนด์แพ้บ่อยกว่าชนะเป็นเรื่องปกติ (ทดสอบชนะราว 1 ใน 3) กำไรมาจากไม้ใหญ่ไม่กี่ไม้ที่วิ่งหลายวัน ให้ดูยอดเงินรวม ไม่ใช่จำนวนครั้งที่ชนะ</p></div>';
      // The live record against what the test showed as normal; the main screen shows the last verdict.
      var chk = liveCheck(closed.map(function (t) { return t.r; }), dd * 100);
      if (chk) {
        $("ppSimple").innerHTML += '<div class="live-chk ' + chk.level + '" id="ppCheck"><b>ผลจริงเทียบผลทดสอบ</b><div>' + chk.text + "</div><small>" + chk.rows.join("<br>") + "</small>" +
          '<small class="muted">' + esc(normalText()) + "</small></div>";
        try { localStorage.setItem("liveCheck", JSON.stringify({ level: chk.level, text: chk.text, n: n, at: Date.now(), label: label })); } catch (e) { /* optional */ }
      }
      drawCurve(curve, capital, profit);
      var why = { exit: "ออกตามสูตร", stop: "โดน SL", stop_gap: "โดน SL (ราคากระโดด)" };
      var side = function (d) { return d > 0 ? "Long" : "Short"; };
      $("ppTrades").innerHTML = open.map(function (t) {
        var r = t.dir * (t.now - t.entry) / t.risk;
        return '<div class="trade"><div><b>' + t.symbol.replace("USDT", "") + " " + side(t.dir) + "</b> · ถืออยู่<br><small>เข้า " + thai(t.entry_time).slice(0, 8) + " ที่ " + price(t.entry) +
          " · SL " + price(t.stop) + '</small></div><div class="' + tone(r) + '" style="font-weight:600">' + fmt(r, 2, true) + "R</div></div>";
      }).join("") + rows.slice(-40).reverse().map(function (x) {
        return '<div class="trade"><div><b>' + x.t.symbol.replace("USDT", "") + " " + side(x.t.dir) + "</b><br><small>" + thai(x.t.entry_time).slice(0, 8) + " → " + thai(x.t.exit_time).slice(0, 8) +
          " · " + (x.t.tpHit ? "ขาย TP " + x.t.tpHit + " ขั้น แล้ว" : "") + (why[x.t.reason] || x.t.reason) + " · " + fmt(x.t.r, 2, true) + 'R</small></div><div class="' + tone(x.baht) + '" style="font-weight:600">' +
          (x.baht >= 0 ? "ได้ +" : "เสีย ") + fmt(Math.abs(x.baht), 0) + " ฿</div></div>";
      }).join("") || '<p class="muted">ยังไม่มีไม้ตั้งแต่วันเริ่ม</p>';
    }

    function render(trades, bars, startMs, label) {
      var closed = trades.filter(function (t) { return t.reason !== "end"; }), open = trades.filter(function (t) { return t.reason === "end"; })[0];
      var eq = 1, peak = 1, dd = 0, wins = 0, tps = 0, sumR = 0, gp = 0, gl = 0;
      closed.forEach(function (t) {
        var frac = Math.abs(t.entry - t.stop) / t.entry, risk = Math.min(LOCK.riskPct / 100, LOCK.marginShare * LOCK.lev * frac);
        eq *= 1 + risk * t.r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
        if (t.r > 0) { wins++; gp += t.r; } else gl -= t.r;
        if (t.reason === "target" || t.reason === "target_gap") tps++;
        sumR += t.r;
      });
      var n = closed.length, days = (Date.now() - startMs) / 86400000;
      $("ppHero").innerHTML = [
        [label, fmt(days, 0) + " วัน", "เริ่ม " + thai(startMs).slice(0, 8)],
        ["ปิดแล้ว", n + " ไม้", n < 30 ? "ยังน้อยกว่า 30 ไม้ สรุปไม่ได้" : "พอเริ่มประเมินได้"],
        ["Win rate", n ? fmt(wins / n * 100, 1) + "%" : "—", "ถึง TP5R " + (n ? fmt(tps / n * 100, 1) : "—") + "%"],
        ["R เฉลี่ย · PF", n ? fmt(sumR / n, 2, true) + "R · " + fmt(gl > 0 ? gp / gl : NaN, 2) : "—", "งานวิจัย 2025: +0.38R · 1.50"],
        ["กำไรพอร์ต", '<span class="' + tone(eq - 1) + '">' + fmt((eq - 1) * 100, 2, true) + "%</span>", "เสี่ยง 0.25%/ไม้ ทบต้น"],
        ["Max DD", fmt(dd * 100, 2) + "%", "งานวิจัย 2025: 2.52%"]
      ].map(function (c) { return '<div class="stat"><small>' + c[0] + "</small><b>" + c[1] + "</b><small>" + c[2] + "</small></div>"; }).join("");
      var reason = { stop: "SL", stop_gap: "SL (gap)", target: "TP5R", target_gap: "TP5R", time: "ครบ 48 ชม." };
      // Plain-language view in baht: what the user's own capital would be now.
      var capital = readNumber("pfCapital", 10000), money = capital, curve = [{ time: Math.floor(startMs / 1000) + THAI_OFFSET_S, value: capital }];
      var rows = closed.map(function (t) {
        var frac = Math.abs(t.entry - t.stop) / t.entry, risk = Math.min(LOCK.riskPct / 100, LOCK.marginShare * LOCK.lev * frac);
        var baht = money * risk * t.r;
        money += baht;
        curve.push({ time: Math.floor(t.exit_time / 1000) + THAI_OFFSET_S, value: money });
        return { t: t, baht: baht };
      });
      var profit = money - capital, losses = n - wins, pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0), cls, headline, advice;
      if (!n) {
        cls = "wait"; headline = "ยังไม่มีไม้"; advice = "รอสัญญาณก่อน สูตรนี้มีประมาณ 5 ไม้ต่อเดือน แอปจะจดให้เองเมื่อมีไม้";
      } else if (n < 30) {
        cls = "wait"; headline = (profit >= 0 ? "กำไร " : "ขาดทุน ") + fmt(Math.abs(profit), 0) + " บาท";
        advice = "ยังเร็วไปที่จะสรุป มีแค่ " + n + " ไม้ ต้องรอให้ครบ 30 ไม้ก่อน (อีก " + (30 - n) + " ไม้) ระหว่างนี้ยังไม่ควรใช้เงินจริง";
      } else if (profit > 0 && pf > 1) {
        cls = "good"; headline = "กำไร " + fmt(profit, 0) + " บาท ✅";
        advice = "ครบ " + n + " ไม้แล้ว และยังได้กำไร สูตรนี้ใช้ได้ในช่วงนี้ ถ้าจะลองเงินจริง เริ่มน้อยๆ และตามกฎเดิมเท่านั้น";
      } else {
        cls = "bad"; headline = "ขาดทุน " + fmt(Math.abs(profit), 0) + " บาท ❌";
        advice = "ครบ " + n + " ไม้แล้วแต่ขาดทุน สูตรนี้ใช้ไม่ได้ในช่วงนี้ อย่าใช้เงินจริง";
      }
      $("ppSimple").innerHTML = '<div class="verdict ' + cls + '"><small>' + esc(label) + " · ใช้ทุนสมมติ " + fmt(capital, 0) + " บาท</small>" +
        '<div class="big ' + (n ? tone(profit) : "") + '">' + headline + "</div>" +
        "<div>ตอนนี้จะมีเงิน <b>" + fmt(money, 0) + " บาท</b>" + (n ? " (" + fmt((money / capital - 1) * 100, 1, true) + "%)" : "") + "</div>" +
        (n ? "<div>เทรด " + n + " ไม้ · ชนะ " + wins + " · แพ้ " + losses + "</div>" : "") +
        "<p>" + esc(advice) + "</p>" +
        '<p class="muted" style="font-size:12px">สูตรนี้แพ้บ่อยเป็นเรื่องปกติ (ชนะราว 1 ใน 3) แต่ไม้ที่ชนะได้มากกว่าไม้ที่แพ้หลายเท่า ให้ดูยอดเงินรวม ไม่ใช่จำนวนครั้งที่ชนะ</p></div>';
      drawCurve(curve, capital, profit);
      var sideTh = function (side) { return side === "long" ? "ซื้อ (Long)" : "ขาย (Short)"; };
      var why = { stop: "โดนตัดขาดทุน", stop_gap: "โดนตัดขาดทุน", target: "ถึงเป้ากำไร", target_gap: "ถึงเป้ากำไร", time: "ครบ 48 ชม. ปิดเอง" };
      var openHtml = "";
      if (open) {
        // Binance "Positions" card: sized from the simulated balance with the same risk rule as the closed trades.
        var now = bars[bars.length - 1].close, side = open.side === "long" ? 1 : -1, risk = Math.abs(open.entry - open.stop);
        var riskB = money * Math.min(LOCK.riskPct / 100, LOCK.marginShare * LOCK.lev * risk / open.entry), qty = riskB / risk;
        var marginB = qty * open.entry / LOCK.lev, pnlB = side * (now - open.entry) * qty, roi = marginB ? pnlB / marginB * 100 : 0;
        var liq = open.entry * (1 - side * (1 / LOCK.lev - 0.005)), pc = pnlB >= 0 ? "up" : "down";
        var cell = function (k, v, cls) { return "<div><small>" + k + '</small><b class="' + (cls || "") + '">' + v + "</b></div>"; };
        openHtml = '<div class="pos"><div class="pos-hd"><span class="side ' + (side > 0 ? "l" : "s") + '">' + (side > 0 ? "L" : "S") + "</span><b>" + LOCK.symbol +
          '</b> <small>Perp</small><span class="tag">Isolated ' + LOCK.lev + 'x</span><span class="tag">จำลอง</span></div>' +
          '<div class="pos-pnl"><div><small>Unrealized PNL (฿)</small><b class="' + pc + '">' + fmt(pnlB, 2, true) + '</b></div><div style="text-align:right"><small>ROI</small><b class="' + pc + '">' + fmt(roi, 2, true) + "%</b></div></div>" +
          '<div class="pos-grid">' + cell("ขนาด (฿)", fmt(qty * open.entry, 0)) + cell("Margin (฿)", fmt(marginB, 2)) + cell("Risk", fmt(side * (now - open.entry) / risk, 2, true) + "R", pc) +
          cell("Entry Price", price(open.entry)) + cell("Mark Price", price(now)) + cell("Liq. Price", price(liq), "warn") + "</div>" +
          '<div class="pos-tpsl">TP/SL <span class="up">' + price(open.entry + side * 5 * risk) + '</span> / <span class="down">' + price(open.stop) + "</span></div>" +
          "<small>เข้าเมื่อ " + thai(open.entry_time) + " · ปิดเองภายใน " + thai(open.entry_time + 47 * 3600000) + "</small></div>";
      }
      $("ppTrades").innerHTML = openHtml + rows.slice(-30).reverse().map(function (x) {
        return '<div class="trade"><div><b>' + sideTh(x.t.side) + "</b><br><small>" + thai(x.t.entry_time).slice(0, 8) + " · " + (why[x.t.reason] || x.t.reason) +
          '</small></div><div class="' + tone(x.baht) + '" style="font-weight:600">' + (x.baht >= 0 ? "ได้ +" : "เสีย ") + fmt(x.baht, 0) + " ฿</div></div>";
      }).join("") || (openHtml ? "" : '<p class="muted">ยังไม่มีไม้ตั้งแต่วันเริ่ม</p>');
    }

    $("ppStart").onclick = function () {
      var cur = load();
      if (cur && $("ppStart").textContent !== "ยืนยันเริ่มใหม่") { $("ppStart").textContent = "ยืนยันเริ่มใหม่"; return; }
      var state = { start: Date.now() };
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
      $("ppStart").textContent = "เริ่มใหม่ (ล้างผลเดิม)";
      run(state.start, "Paper ตั้งแต่เริ่ม");
    };
    $("pp2026").onclick = function () { run(Date.UTC(2026, 0, 1), "ปี 2026 ถึงวันนี้"); };
    function refresh() { var st = load(); if (st) { $("ppStart").textContent = "เริ่มใหม่ (ล้างผลเดิม)"; run(st.start, "Paper ตั้งแต่เริ่ม"); } }
    return { refresh: refresh };
  })();

  // ---- Futures: ONE BEST COMBO (Momentum + Squeeze, 1H) long/short with leverage-aware sizing ----
  var FUT = { fee: 0.0005, slippage: 0.0002, mmr: 0.005, mmrSafe: 0.01, enterWithinMin: 15, marginShare: 0.25 };
  // The Android scanner and the visible scanner share persisted H4/H1/M15/M5 settings.
  // H4 runs Trend 4H (250 days = 1,500 bars, the window research/pro replays); the others run Squeeze v2.
  var TF = { "4h": { ms: 14400000, days: 250, name: "4 ชม." }, "1h": { ms: 3600000, days: 100, name: "1 ชม." },
    "15m": { ms: 900000, days: 30, name: "15 นาที" }, "5m": { ms: 300000, days: 14, name: "5 นาที" } };
  // Trend 4H (web/trend.js): the main strategy since v4.4. Risk per trade comes from the portfolio setting, at most 1%.
  var TREND = { tf: "4h", id: "donchian4h", name: "Trend 4H · Donchian 20/10 · SL 3 ATR · EMA200", maxRiskPct: 1 };
  function isTrend(tf) { return tf === TREND.tf; }
  function hasTp(g) { return !!(g.tps && g.tps.length); }
  function trendRiskPct() { return Math.max(0.1, Math.min(TREND.maxRiskPct, readNumber("pfRisk", 0.25))); }
  function tpMode() { try { return localStorage.getItem("tpMode") || "ladder"; } catch (e) { return "ladder"; } }
  // The scale-out plan research/pro chose on 2020-2022 (null: no take profit, the channel exit only).
  function trendLadder() {
    var T = window.EVIDENCE_TREND;
    return tpMode() === "ladder" && T && T.ladder && T.ladder.tps ? T.ladder : null;
  }
  // The rule's test record for the chosen take-profit mode, for one coin or (no symbol) all 12, with reach rates.
  // The whole system's record (12 coins). A coin's own win rate and average R did not carry over from 2020-2022 to
  // 2023-2026 (research/pro/winrate.js: rank correlation -0.07 and -0.14 over 32 coins), so no coin is shown as better.
  function trendStats() {
    var T = window.EVIDENCE_TREND, L = trendLadder();
    if (!T) return null;
    var row = L ? L.test : T.all;
    return row ? Object.assign({}, row, { reach: T.reach || null }) : null;
  }
  // What the test showed as normal for the chosen take-profit mode (research/pro "normal"): losing streaks, the range of
  // N consecutive trades, and the portfolio at the user's risk; plus the stop rule research/pro chose on 2020-2022.
  function trendNormal() {
    var T = window.EVIDENCE_TREND, k = trendLadder() ? "ladder" : "rule", nm = T && T.normal && T.normal[k];
    if (!nm) return null;
    // The rules chosen on 2020-2022 (the old 4% / 8% stops, a cap on open positions) cut most of the 2023-2026 profit,
    // and so did every other risk-cutting rule tested; the app trades every signal and stops new entries only past the
    // deepest drawdown of the test (research/pro stopRules, research/pro/robust.js heat).
    var sr = T.stopRules && T.stopRules[k], none = sr && sr.rows.filter(function (x) { return x.id === "none"; })[0];
    return { normal: nm, port: nm.port && nm.port[String(trendRiskPct())], stop: none || null, studied: sr || null };
  }
  // The 4-hour closes in Thai time (03:00, 07:00, ... 23:00) and the next one.
  function trendSchedule(now) {
    var ms = TF[TREND.tf].ms, next = Math.floor(now / ms) * ms + ms, times = [];
    for (var t = 0; t < 86400000; t += ms) times.push(thai(next + t).slice(9, 14));
    return { times: times.sort(), next: next };
  }
  // The rule's live record (R of closed trades in exit order) against the test: the sum of the last N trades against
  // the range of N consecutive test trades, the losing streak now, and the drawdown at this risk.
  // ok: within the test's range · watch: below its worst 5% · broken: worse than anything the test showed.
  function liveCheck(rs, ddPct) {
    var nm = trendNormal();
    if (!nm) return null;
    var w = nm.normal.windows, N = [100, 50, 30, 20, 10].filter(function (k) { return rs.length >= k && w[k]; })[0], streak = 0, rows = [], level = "few";
    for (var i = rs.length - 1; i >= 0 && !(rs[i] > 0); i--) streak++;
    if (N) {
      var sum = rs.slice(-N).reduce(function (a, r) { return a + r; }, 0), b = w[N];
      level = sum < b.min ? "broken" : sum < b.p5 ? "watch" : "ok";
      rows.push(N + " ไม้ล่าสุดรวม " + fmt(sum, 1, true) + "R · ทดสอบ " + N + " ไม้ติดกัน: ปกติ " + fmt(b.p50, 1, true) + "R · แย่ 5% ล่างสุด " + fmt(b.p5, 1, true) + "R · แย่สุด " + fmt(b.min, 1, true) + "R");
    }
    rows.push("แพ้ติดกันตอนนี้ " + streak + " ไม้ · ทดสอบแพ้ติดกันสูงสุด " + nm.normal.worstStreak + " ไม้");
    if (streak > nm.normal.worstStreak) level = "broken";
    if (nm.port) {
      rows.push("ลงจากจุดสูงสุด " + fmt(ddPct, 1) + "% · ทดสอบลงลึกสุด " + fmt(nm.port.maxDD, 1) + "% (เสี่ยง " + trendRiskPct() + "%/ไม้)");
      if (ddPct > nm.port.maxDD) level = "broken";
    }
    var text = { few: "ยังมีไม้ไม่ถึง 10 ไม้ เทียบกับผลทดสอบไม่ได้",
      ok: "ปกติ: อยู่ในช่วงที่ผลทดสอบเคยเจอ · เทรดต่อตามสูตร",
      watch: "ต่ำกว่าปกติ: แย่กว่า 95% ของช่วงในผลทดสอบ แต่ยังไม่เกินที่เคยเจอ · เทรดต่อได้ ห้ามเพิ่มความเสี่ยง",
      broken: "แย่กว่าที่ผลทดสอบเคยเจอ: หลักฐานไม่ครอบคลุมแล้ว สูตรอาจเสื่อม · หยุดเข้าไม้ใหม่ ถือไม้เดิมตามสูตร แล้วทบทวน" }[level];
    return { level: level, text: text, rows: rows };
  }
  // One line of what is normal for the rule, so a losing run in that range is read as the rule working, not breaking.
  function normalText() {
    var nm = trendNormal(), p = nm && nm.port;
    if (!nm) return "";
    return "ปกติของสูตรนี้ (ทดสอบ " + trendPeriod() + "): แพ้ติดกันได้ถึง " + nm.normal.worstStreak + " ไม้" +
      (p ? " · เดือนที่ติดลบ " + p.losingMonths + "% · ติดลบติดกันนานสุด " + p.worstLosingMonths + " เดือน · 3 เดือนแย่สุด " + fmt(p.worst3m, 1, true) + "% · พอร์ตลงลึกสุด " +
        fmt(p.maxDD, 1) + "% · อยู่ใต้จุดสูงสุดนานสุด " + p.underDays + " วัน (เสี่ยง " + trendRiskPct() + "%/ไม้)" : "");
  }
  // Statistical confidence that an average is above zero, from its t-statistic (normal approximation). Trades are taken as
  // independent, which they are not quite (the coins move together), so it reads higher than it is.
  function normCdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z)), p = 0.3989423 * Math.exp(-z * z / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  function sure(t) { var p = normCdf(t) * 100; return p >= 99.95 ? ">99.9%" : fmt(p, p >= 99 ? 1 : 0) + "%"; }
  // How much the tests let us trust the rule, test by test (pass / warn / fail), and how often a year ended in profit.
  // Every number comes from research/pro and research/pro/robust.js; nothing here is a forecast for one trade.
  // The system's last 30 days on the selected coins against the test's normal range (set by the main screen).
  var RECENT = null;
  // NO TRADE for new entries while the system's own last 30 days are worse than anything the test ever had over the same
  // number of trades (the evidence no longer covers it); exits still go out.
  function systemPaused() { return !!(RECENT && RECENT.N && RECENT.lvl === "bad"); }
  function recentFrom(results) {
    var all = [];
    results.forEach(function (r) { (r.recent || []).forEach(function (t) { all.push(Object.assign({ symbol: r.symbol }, t)); }); });
    var closed = all.filter(function (t) { return !t.open; }).sort(function (a, b) { return b.exit_time - a.exit_time; });
    var nm = trendNormal(), w = nm && nm.normal.windows, N = w ? [100, 50, 30, 20, 10].filter(function (k) { return closed.length >= k && w[k]; })[0] : null;
    if (!N) return { closed: closed, N: 0 };
    var last = closed.slice(0, N).reduce(function (a, t) { return a + t.r; }, 0), b = w[N];
    return { closed: closed, N: N, last: last, band: b, lvl: last < b.min ? "bad" : last < b.p5 ? "warn" : "ok" };
  }
  function trendConfidence() {
    var T = window.EVIDENCE_TREND;
    if (!T || !T.all) return null;
    var lad = trendLadder(), k = lad ? "ladder" : "rule", main = lad && T.ladder.test ? T.ladder.test : T.all, R = T.robust, rows = [];
    var add = function (ok, text) { rows.push({ ok: ok, text: text }); };
    var r3 = function (v) { return fmt(v, 3, true) + "R"; };
    add(T.parity === "OK" && T.replay === "OK" ? "pass" : "fail", "โค้ดในแอปให้ไม้ตรงกับโค้ดวิจัยทุกไม้ และตรงกับการคำนวณสดทีละแท่ง");
    add(main.t >= 2 ? "pass" : "fail", "ทดสอบล่วงหน้า " + trendPeriod() + " · 12 เหรียญ · " + main.n + " ไม้: เฉลี่ย " + r3(main.avgR) + " ต่อไม้ · มั่นใจว่ากำไรเฉลี่ยเป็นบวก " + sure(main.t));
    if (R && R.unseen && R.unseen[k]) {
      var u = R.unseen[k], coins = Object.keys(u.rows || {}), pos = coins.filter(function (c) { return u.rows[c].avgR > 0; }).length, sp = R.spot[k].all;
      add(u.all.t >= 2 && pos >= 0.75 * coins.length ? "pass" : "fail", "เหรียญที่สูตรไม่เคยเห็น " + coins.length + " เหรียญ (รวมเหรียญที่ถูกถอดแล้ว) · " + u.all.n + " ไม้: " + r3(u.all.avgR) +
        " · บวก " + pos + "/" + coins.length + " เหรียญ · มั่นใจ " + sure(u.all.t));
      add(sp.t >= 2 ? "pass" : "fail", "ปีก่อนเลือกสูตร 2017–2019 · " + R.spot.coins.length + " เหรียญ · " + sp.n + " ไม้: " + r3(sp.avgR) + " · มั่นใจ " + sure(sp.t));
    }
    if (T.stress) add(T.stress.t >= 2 ? "pass" : T.stress.t >= 1.64 ? "warn" : "fail", "ค่าธรรมเนียม+slippage ×2: " + r3(T.stress.avgR) + " · มั่นใจ " + sure(T.stress.t) + " · ความได้เปรียบบาง ต้องเข้าให้ตรงเวลาและราคา");
    var yrs = R && R.base && R.base[k] ? R.base[k].years : T.years, recent = [2025, 2026].filter(function (y) { return yrs && yrs[y]; });
    if (recent.length) add(recent.every(function (y) { return yrs[y].t >= 2; }) ? "pass" : "warn",
      "2 ปีล่าสุด: " + recent.map(function (y) { return y + " " + r3(yrs[y].avgR); }).join(" · ") + " → ความได้เปรียบอ่อนลง (แทบเท่าทุน)");
    // Live results come first: a recent run worse than 95% of the test's runs of the same length puts the system on watch.
    if (RECENT && RECENT.N) add(RECENT.lvl === "ok" ? "pass" : "fail", "ผลจริงของระบบ " + RECENT.N + " ไม้ล่าสุด (30 วัน): " + fmt(RECENT.last, 1, true) + "R · ผลทดสอบช่วงเท่ากัน แย่ 5% ล่างสุด " +
      fmt(RECENT.band.p5, 1, true) + "R · แย่สุดที่เคยเจอ " + fmt(RECENT.band.min, 1, true) + "R");
    var fails = rows.filter(function (r) { return r.ok === "fail"; }).length, warns = rows.filter(function (r) { return r.ok === "warn"; }).length;
    var watch = RECENT && RECENT.N && RECENT.lvl !== "ok";
    // The share of profitable years (block bootstrap of 2023-2026 months) is not shown: it was never checked on later data.
    return { level: watch ? "เฝ้าระวัง" : fails ? "ต่ำ" : warns ? "ปานกลาง" : "สูง", cls: watch || fails ? "bad" : warns ? "weak" : "good", rows: rows, watch: watch,
      passed: rows.length - fails - warns, total: rows.length, year: null };
  }
  // How the news reads for one trade, as a trader would put it: market mood (Fear & Greed and its week), the coin's good
  // and bad headlines of 24 h, and whether they point the way of the trade. Facts from the free sources and the word list.
  function moodRead(symbol, dir) {
    var m = News.mood(symbol), coin = symbol.replace("USDT", ""), parts = [];
    if (m.fng) parts.push("ตลาด" + m.fng.label + " " + m.fng.v + (m.fng.change ? " (" + (m.fng.change > 0 ? "↑" : "↓") + Math.abs(m.fng.change) + " ใน 7 วัน)" : ""));
    parts.push(m.coin && m.coin.n ? "ข่าว " + coin + " 24 ชม.: ดี " + m.coin.good + " · ร้าย " + m.coin.bad : "ไม่มีข่าว " + coin + " ใน 24 ชม.");
    var fit = m.coin && m.coin.tone ? (m.coin.tone === dir ? "with" : "against") : "none";
    // Trades of the rule taken in the same mood and direction, 2020-2026 (research/pro/sentiment.js): history, not a filter.
    var S = window.EVIDENCE_TREND && window.EVIDENCE_TREND.sentiment, B = S && S.modes && S.modes[trendLadder() ? "ladder" : "rule"], past = null;
    if (B && m.fng) {
      var name = (dir > 0 ? "LONG " : "SHORT ") + m.fng.label + " ", key = Object.keys(B.bands).filter(function (k) { return k.indexOf(name) === 0; })[0], b = key && B.bands[key];
      if (b && b.n >= 30) past = "ในอดีต (2020–2026) " + (dir > 0 ? "LONG" : "SHORT") + " ตอนตลาด" + m.fng.label + ": " + b.n + " ไม้ · ชนะ " + b.win + "% · เฉลี่ย " + fmt(b.avgR, 2, true) + "R";
    }
    return { text: parts.join(" · "), past: past, fit: fit, fitText: { with: "ข่าวไปทางเดียวกับไม้นี้", against: "ข่าวสวนทางไม้นี้", none: "ข่าวไม่ชี้ทาง" }[fit], m: m };
  }
  // What the mood study found (research/pro/sentiment.js, filters chosen on 2020-2022, checked on 2023-2026): a filter is
  // used only if it beat "no filter" on 2023-2026 in average R and in portfolio growth; otherwise the news is context.
  function moodRule() {
    var S = window.EVIDENCE_TREND && window.EVIDENCE_TREND.sentiment, k = trendLadder() ? "ladder" : "rule", M = S && S.modes && S.modes[k];
    if (!M) return { apply: false, text: "ข่าวและอารมณ์ตลาดยังไม่ได้ทดสอบกับสูตร จึงใช้ประกอบเท่านั้น · เข้าตามระบบ" };
    var none = M.rows.filter(function (x) { return x.id === "none"; })[0], ch = M.rows.filter(function (x) { return x.id === M.chosen; })[0];
    var apply = ch && ch.id !== "none" && ch.test.avgR > none.test.avgR && ch.port.cagr > none.port.cagr;
    return { apply: apply, filter: apply ? ch.id : null, row: ch, none: none,
      text: apply ? "ใช้อารมณ์ตลาดกรองตามผลทดสอบ: " + ch.name
        : ch && ch.id !== "none" ? "ทดสอบกับดัชนี Fear & Greed " + S.days + " วัน: ตัวกรองที่ดีที่สุดในปี 2020–2022 (" + ch.name + ") ทำปี 2023–2026 แย่ลง (เฉลี่ย " +
            fmt(ch.test.avgR, 3, true) + "R เทียบ " + fmt(none.test.avgR, 3, true) + "R ถ้าไม่กรอง) → ข่าวใช้ประกอบ เข้าตามระบบ"
          : "ทดสอบกับดัชนี Fear & Greed " + S.days + " วัน: ไม่กรองดีที่สุดในปี 2020–2022 → ข่าวใช้ประกอบ เข้าตามระบบ" };
  }
  // One line for alerts and sheets: "ปานกลาง–สูง (ผ่าน 4/6 การทดสอบ) · ปีที่กำไร ≈81%".
  function confidenceLine() {
    var c = trendConfidence();
    return c ? c.level + " (ผ่าน " + c.passed + "/" + c.total + " การทดสอบ)" : "";
  }
  function confidenceHtml() {
    var c = trendConfidence(), mark = { pass: ic("check"), warn: ic("alert"), fail: ic("x") };
    if (!c) return "";
    return '<div class="conf-box ' + c.cls + '"><div class="conf-hd"><span>ความมั่นใจของสูตร</span><b>' + c.level + "</b><small>ผ่าน " + c.passed + "/" + c.total + " การทดสอบ</small></div>" +
      (c.year ? '<div class="conf-year">โอกาสปีที่กำไร <b>≈' + c.year.win + '%</b> · ปีที่ขาดทุนเกิน 10% ≈' + fmt(c.year.loss10, 0) + "% · ปีกลางๆ " + fmt(c.year.p50, 0, true) +
        "% <small>(เสี่ยง 0.5%/ไม้ 12 เหรียญ จำลองจากเดือนจริง 2023–2026 · 5% แย่สุด " + fmt(c.year.p5, 0, true) + "% · 5% ดีสุด " + fmt(c.year.p95, 0, true) + "%)</small></div>" : "") +
      "<details><summary>ดูผลทดสอบทีละข้อ</summary>" + c.rows.map(function (r) { return '<div class="conf-row ' + r.ok + '"><i>' + mark[r.ok] + "</i>" + esc(r.text) + "</div>"; }).join("") +
      '<div class="conf-row info"><i>' + ic("info") + '</i>กติกาลดความเสี่ยงและการจำกัดจำนวนไม้ที่เลือกจากปี 2020–2022 ทำกำไรปี 2023–2026 หายเกือบหมด จึงเทรดทุกสัญญาณ และหยุดเข้าไม้ใหม่เฉพาะเมื่อพอร์ตลงลึกกว่าที่ทดสอบเคยเจอ</div>' +
      '<small class="muted">"มั่นใจ" = ความมั่นใจทางสถิติว่ากำไรเฉลี่ยต่อไม้ในข้อมูลทดสอบเป็นบวก (คิดแบบไม้อิสระ จึงอาจสูงเกินจริง) ไม่ใช่การรับประกันอนาคต</small></details></div>';
  }
  // Headline numbers for a trade: how often trades like it closed in profit in the test (win %), how much bigger the
  // average win was than the average loss, a grade by the average result, and the risk band. Never an invented confidence.
  function verdictOf(symbol, tf, riskPct) {
    var st = isTrend(tf) ? trendStats() : null, E = !isTrend(tf) && window.EVIDENCE, o = E && E.rows && E.rows[symbol + "|" + tf] && E.rows[symbol + "|" + tf].oos;
    var row = st || o, ok = row && row.n >= 30, w = ok ? row.win / 100 : NaN;
    return { win: ok ? row.win : null, n: ok ? row.n : 0, avgR: ok ? row.avgR : null, payoff: ok && row.pf && w > 0 && w < 1 ? row.pf * (1 - w) / w : null,
      grade: !ok ? "none" : row.avgR >= 0.1 ? "good" : row.avgR > 0 ? "weak" : "bad", risk: riskPct, riskBand: riskPct <= 0.5 ? "low" : riskPct <= 1 ? "mid" : "high" };
  }
  var GRADE_TXT = { good: "ดี", weak: "พอใช้", bad: "อ่อน", none: "ยังไม่มีข้อมูล" };
  function headline(dir, lev, v) {
    return '<div class="sm-head"><span class="side ' + (dir > 0 ? "l" : "s") + '">' + (dir > 0 ? "LONG" : "SHORT") + " x" + lev + "</span>" +
      '<span class="conf ' + v.grade + '">' + (v.win !== null ? "โอกาสกำไร " + fmt(v.win, 0) + "%" : "ยังไม่มีสถิติ") + "<small>" + GRADE_TXT[v.grade] + "</small></span>" +
      '<span class="risk ' + v.riskBand + '">เสี่ยง ' + fmt(v.risk, 2) + "%<small>ของทุน</small></span></div>" +
      (v.win !== null ? '<small class="muted">โอกาสกำไร = ไม้แบบนี้ที่ปิดกำไรในช่วงทดสอบ (' + v.n + " ไม้)" + (v.payoff ? " · ไม้ที่ชนะได้เฉลี่ย " + fmt(v.payoff, 1) + " เท่าของไม้ที่แพ้" : "") +
        " · เป็นสถิติ ไม่ใช่การรับประกัน</small>" : "");
  }
  function fracTxt(f) { return Math.abs(f - 1 / 3) < 1e-6 ? "1/3" : fmt(f * 100, 0) + "%"; }
  function ladderText(lad) {
    return "TP แบ่งขาย: " + lad.map(function (t, k) { return "TP" + (k + 1) + " " + price(t.price) + " (+" + t.r + "R ขาย " + fracTxt(t.frac) + ")"; }).join(" · ") +
      " · ที่เหลือถือจนแอปเด้งปิดไม้";
  }
  // One place that changes the signal timeframe, so the visible scanner and the Android alarm never disagree.
  function setTradeTf(v) {
    if (!TF[v]) return;
    try { localStorage.setItem("tradeTf", v); } catch (e) { /* ignore */ }
    if ($("alertTf")) $("alertTf").value = v;
    if (window.NativeHttp && window.NativeHttp.setScanMinutes) window.NativeHttp.setScanMinutes(TF[v].ms / 60000);
  }
  // v6.2: one timeframe, Trend 4H, for every install (earlier choices are ignored); debug builds may pin another for tests.
  function curTf() {
    var dbg = "";
    try { dbg = window.NativeHttp && window.NativeHttp.debugTradeTf ? window.NativeHttp.debugTradeTf() : ""; } catch (e) { /* release build */ }
    return TF[dbg] ? dbg : TREND.tf;
  }
  // v4.4 moves every install to Trend 4H once; the user can switch back to the trial timeframes afterwards.
  try {
    if (!localStorage.getItem("trendDefault")) { localStorage.setItem("trendDefault", "1"); localStorage.setItem("tradeTf", TREND.tf); }
  } catch (e) { /* storage is optional */ }

  var lastFutures = [];

  // ---- Main screen: what to trade now and every number of the trade, sized from the user's own money ----
  var Simple = (function () {
    var lastScan = 0, timer = null, results = [], fx = 33, busyNow = false, meta = null, lastError = "";
    function money() { return readNumber("pfCapital", 10000); }
    function signals() {
      var now = Date.now();
      if (isTrend(curTf()) && systemPaused()) return [];
      var score = function (r) { var st = isTrend(curTf()) ? trendStats() : null; return st && st.n >= 30 ? st.avgR : -9; };
      return results.filter(function (r) { return r.signal && !r.signal.below_minimum && now < r.signal.expires; })
        .sort(function (a, b) { return score(b) - score(a) || (b.symbol === LOCK.symbol) - (a.symbol === LOCK.symbol); });
    }
    // Sizes scale linearly with the balance, so a new amount needs no rescan.
    function sized(g) {
      var f = g.minSize ? 1 : money() / (g.balanceUsdt * fx), qty = g.qty * f, notional = qty * g.entry;
      var cost = notional * 2 * (FUT.fee + FUT.slippage);
      return { qty: qty, notional: notional, marginB: notional / g.lev * fx, lossB: g.riskUsdt * f * fx,
        winB: hasTp(g) ? (qty * Math.abs(g.tps[2] - g.entry) - cost) * fx : NaN, avbl: money() / fx };
    }
    function qtyTxt(q) { return q >= 1 ? fmt(q, 3) : q.toPrecision(3); }
    // Squeeze evidence (2026, data the rule never saw) for the selected coins on this timeframe; never in-sample numbers.
    function squeezeHead(tf) {
      var E = window.EVIDENCE, n = 0, sumR = 0, tp = 0, used = [];
      selectedCoins().forEach(function (c) {
        var o = E && E.rows && E.rows[c + "|" + tf] && E.rows[c + "|" + tf].oos;
        if (o && o.n) { n += o.n; sumR += o.n * o.avgR; tp += o.n * o.tp5 / 100; used.push(c.replace("USDT", "")); }
      });
      var baht = sumR * money() * LOCK.riskPct / 100;
      return '<div class="sm-exp">โหมดทดลอง · Paper เท่านั้น · สัญญาณไม่ใช่คำสั่งซื้อขาย</div>' +
        '<div class="sm-bt ' + (n >= 30 ? (sumR > 0 ? "good" : "bad") : "") + '">' + (n >= 30
          ? "หลักฐาน " + E.periods.oos + " (" + used.join(", ") + " · " + TF[tf].name + "): " + n + " ไม้ · ถึง TP 5R " + fmt(tp / n * 100, 0) + "% · เฉลี่ย " +
            fmt(sumR / n, 2, true) + "R/ไม้ = <b>" + (baht >= 0 ? "ได้ +" : "เสีย ") + fmt(baht, 0) + " ฿</b> ถ้าเสี่ยง 0.25%/ไม้" +
            (sumR <= 0 ? "<br><small>ผลย้อนหลังขาดทุน: อย่าใช้เงินจริงกับกราฟนี้</small>" : "")
          : "ยังไม่มีข้อมูลยืนยันสำหรับเหรียญ/กราฟที่เลือก") + "</div>";
    }
    // Trend 4H plans the chart can show, most urgent first: a valid entry, exits, refused entries, positions the rule holds.
    function planItems() {
      var items = [];
      results.forEach(function (r) {
        if (!r.bars) return;
        var it = { symbol: r.symbol, bars: r.bars, now: r.close };
        if (r.signal) {
          var g = r.signal;
          items.push(Object.assign(it, { kind: g.below_minimum ? "blocked" : "entry", rank: g.below_minimum ? 2 : 0, dir: g.dir, entry: g.entry, stop: g.stop, exitLevel: g.exitLevel,
            tpLevels: (g.ladder || []).map(function (t, k) { return { price: t.price, label: "TP" + (k + 1), done: false }; }) }));
        } else if (r.exit || r.position) {
          var x = r.exit || r.position;
          items.push(Object.assign(it, { kind: r.exit ? "exit" : "hold", rank: r.exit ? 1 : 3, dir: x.dir, entry: x.entry, stop: x.stop,
            exitLevel: r.exit ? x.level : x.exitLevel, entryTime: x.entry_time, r: x.r, tpLevels: x.tpLevels || [], left: x.left, barsSince: x.barsSince }));
        }
      });
      items.forEach(function (it) {
        // The channel exit matters only while it is closer than the stop; once past the entry it locks in profit.
        it.exitOn = isFinite(it.exitLevel) && (it.dir > 0 ? it.exitLevel > it.stop : it.exitLevel < it.stop);
        it.locks = it.exitOn && (it.dir > 0 ? it.exitLevel > it.entry : it.exitLevel < it.entry);
      });
      return items.sort(function (a, b) { return a.rank - b.rank; });
    }
    function exitText(it) {
      return it.exitOn ? (it.locks ? "TP เลื่อน: ปิดเมื่อแท่ง 4 ชม. ปิด" : "ออกเมื่อแท่ง 4 ชม. ปิด") + (it.dir > 0 ? "ต่ำกว่า " : "สูงกว่า ") + price(it.exitLevel) +
        " หรือแตะ SL " + price(it.stop) : "ออกเมื่อแตะ SL " + price(it.stop) + " (ตั้งไว้ใน Binance)";
    }
    function planLegend(it) {
      var side = it.dir > 0 ? "LONG" : "SHORT", pct = function (v) { return fmt((v / it.entry - 1) * 100, 1, true) + "%"; };
      var head = { entry: "สัญญาณเข้า " + side, blocked: "สัญญาณ " + side + " (ไม่แนะนำให้เข้า)", exit: "ปิดไม้ " + side + " ตอนนี้", hold: "สูตรถือ " + side + " อยู่" }[it.kind];
      var chip = function (color, text) { return '<span><i style="background:' + color + '"></i>' + text + "</span>"; };
      return '<div class="sm-legend"><b>' + it.symbol.replace("USDT", "") + " · " + head + "</b>" + chip("#f0b90b", "เข้า " + price(it.entry)) +
        chip("#f6465d", "SL " + price(it.stop) + " (" + pct(it.stop) + ")") +
        (it.tpLevels || []).map(function (t) { return chip(t.done ? "#5e6673" : "#0ecb81", t.label + " " + price(t.price) + " (" + pct(t.price) + ")" + (t.done ? " ✓ ขายแล้ว" : "")); }).join("") +
        (it.exitOn ? chip(it.locks ? "#0ecb81" : "#ff9800", (it.locks ? "TP เลื่อน " : "จุดออก ") + price(it.exitLevel) + " (" + pct(it.exitLevel) + ")") : "") +
        ((it.kind === "entry" || it.kind === "blocked") && !(it.tpLevels || []).length ? '<span>TP: ไม่ตั้ง · ออกเมื่อแอปเด้ง "ปิดไม้"</span>' : "") +
        "<span>ราคาตอนนี้ " + price(it.now) + (it.kind === "hold" || it.kind === "exit" ? " (" + fmt(it.r, 2, true) + "R)" : "") + "</span>" +
        '<small>' + exitText(it) + "</small></div>";
    }
    // Trend 4H screen around the order box: capital check, exits and refused entries above it; the rule's positions and the
    // evidence below it.
    // Late entry into an open position: research/pro measured joining d bars late (price within 0.5R of the entry, no take
    // profit filled yet) with the rule's SL and take profits. The bucket at or below the bars since entry decides.
    function lateVerdict(it) {
      var T = window.EVIDENCE_TREND, L = T && T.late, d = it.barsSince, k = null;
      if (!L) return null;
      [1, 2, 3, 6, 12].forEach(function (b) { if (d >= b && L[b]) k = b; });
      return k ? Object.assign({ bars: k }, L[k].late) : null;
    }
    // Margin is more than the balance typed at the top: the numbers are for that balance, so say where to fix it.
    function marginNote(m) {
      var cap = money();
      return m > cap ? '<div class="callout warn sm">' + ic("alert") + "<span>Margin ≈ " + fmt(m, 0) + " ฿ มากกว่าทุนที่ใส่ไว้ (" + fmt(cap, 0) + " ฿) · ใส่ทุนจริงในช่องด้านบน ขนาดไม้จะคำนวณใหม่</span></div>" : "";
    }
    // Whether someone without the position can still join it now (research/pro "late entry"): the evidence and the order
    // sized at the last 4-hour close; paintLive re-checks the price and re-sizes the order every second.
    function joinInfo(it, r) {
      var x = r.position, lg = x.late, v = lateVerdict(it), near = lg && Math.abs(it.now - it.entry) <= 0.5 * Math.abs(it.entry - it.stop);
      var no = function (html) { return { ok: false, html: html, order: lg && !lg.below_minimum ? lg : null, ev: v }; };
      if (it.tpLevels.some(function (t) { return t.done; })) return no("ไม่ครบ: ระบบขาย TP ไปแล้ว");
      if (!lg) return { ok: false, html: "ราคาเลย SL แล้ว" };
      if (lg.below_minimum) return { ok: false, html: "NO TRADE: " + esc(lg.reject) };
      if (!near) return no("ไม่ครบ: ราคาห่างจุดเข้าเกิน 0.5R");
      if (lg.below_minimum) return { ok: false, html: "NO TRADE: " + esc(lg.reject) };
      if (!v || !(v.n >= 30)) return no("ไม่ครบ: ยังไม่มีผลทดสอบการเข้าช้าเท่านี้");
      if (!(v.avgR > 0)) return no("ไม่ครบ: ทดสอบเข้าช้า " + v.bars + " แท่ง เฉลี่ย " + fmt(v.avgR, 2, true) + "R");
      // Only where the test shows joining this late was clearly profitable (its 95% range above zero): 1-2 bars.
      if (!(v.avgRCI && v.avgRCI[0] > 0)) return no("ไม่ครบ: เข้าช้า " + it.barsSince + " แท่งแล้ว ผลทดสอบไม่ชัดว่ากำไร (เข้าช้า " + v.bars + " แท่ง: เฉลี่ย " +
        fmt(v.avgR, 2, true) + "R ช่วง 95% " + fmt(v.avgRCI[0], 2, true) + " ถึง " + fmt(v.avgRCI[1], 2, true) + "R)");
      return { ok: true, order: lg, ev: v };
    }
    // Joining in the 4-hour bar the system entered, after the 15 minutes: the test's nearest case is joining 1 bar late.
    function lateFirstBar() {
      var v = lateVerdict({ barsSince: 1 });
      return v && v.n >= 30 && v.avgRCI && v.avgRCI[0] > 0 ? v : null;
    }
    function sidePill(dir, prefix, solid) {
      var cls = dir === 0 ? "x" : dir > 0 ? "l" : "s";
      return '<span class="side-pill ' + cls + (solid ? " solid" : "") + '">' + (prefix ? prefix + " " : "") + (dir === 0 ? "" : dir > 0 ? "LONG" : "SHORT") + "</span>";
    }
    function fact(k, v) { return "<div><small>" + k + "</small><b>" + v + "</b></div>"; }
    // The live cards of the main screen (new signals and the system's positions), by element id: what paintLive needs to
    // put each one under "follow now", "holding, too late to follow" or "ended", and to refresh its numbers.
    var LC = {}, LCended = 0, noteOf = { list: [], held: [] };
    // An order re-sized at the live price p: the same money at risk to the same SL (Binance's step and minimum), so a
    // price that moved since the 4-hour close does not change what a stop costs.
    function liveSize(g, p) {
      var f = g.minSize ? 1 : money() / (g.balanceUsdt * fx), k = 2 * (FUT.fee + FUT.slippage), cost = k * p, dist = Math.abs(p - g.stop), st = g.step || 0;
      var q = g.minSize ? g.qty : Math.min(g.qty * f * (Math.abs(g.entry - g.stop) + k * g.entry) / (dist + cost), LOCK.marginShare * money() / fx * g.lev / p);
      if (st) q = Math.max(1, Math.round(q / st)) * st;   // the nearest size Binance takes, as the sheet shows it
      var minQ = Math.max(g.minQty || 0, (g.minNotional || 0) / p);
      if (q < minQ) q = st ? Math.ceil(minQ / st - 1e-9) * st : minQ;
      var lossB = q * (dist + cost) * fx, target = money() * (g.riskPctTarget || trendRiskPct()) / 100;
      return { qty: q, marginB: q * p / g.lev * fx, lossB: lossB, blocked: lossB > target * 1.1 || q * p / g.lev * fx > money() };
    }
    // Of the system's trades that stood at this R at a 4-hour close (TP1 sold or not), how many ended in profit, measured
    // from the system's entry (research/pro/liveodds.js; held within 10 points on 2023-2026 and unseen coins).
    function oddsAt(r, tp1) {
      var L = window.EVIDENCE_TREND && window.EVIDENCE_TREND.liveodds;
      if (!L) return null;
      var row = L.rows.filter(function (x) { return x.tp1 === !!tp1 && (x.band[0] === null || r >= x.band[0]) && (x.band[1] === null || r < x.band[1]); })[0];
      return row && row.n >= 30 ? row : null;
    }
    // The status line and the live price line every live card carries.
    function liveHead(sym, p0) {
      return '<div class="live-row"><span class="chip" data-st>…</span><span class="live-px">ตอนนี้ <b data-now="' + sym + '">' + price(p0) + '</b> <small data-off></small></span></div>' +
        '<p class="fine live-why" data-why></p><p class="odds" data-odds></p><details class="fit"><summary data-fit>…</summary><ul class="fit-list" data-fitlist></ul></details>';
    }
    // One position the system holds: live move and R, its levels and exit, and whether to join it now. Chart on request.
    function holdCard(it, r, i) {
      var long = it.dir > 0, coin = it.symbol.replace("USDT", ""), mv = it.dir * (it.now - it.entry) / it.entry * 100, k = Math.abs(it.entry - it.stop), j = joinInfo(it, r);
      var tp = it.tpLevels.filter(function (t) { return !t.done; })[0], done = it.tpLevels.filter(function (t) { return t.done; }).length, hid = "smHoldCard" + i;
      LC[hid] = { kind: "hold", sym: r.symbol, dir: it.dir, e: it.entry, k: k, sl: it.stop, tp: tp ? tp.price : null, tpDone: done > 0, joinOk: j.ok, order: j.order, noCap: !!(r.position.late && r.position.late.noCapital), lateOk: !!(j.ev && j.ev.n >= 30 && j.ev.avgRCI && j.ev.avgRCI[0] > 0),
        since: it.entryTime, p0: it.now, ord: 100 + i };
      var cap = money(), z = j.order ? sized(j.order) : null;
      return '<div class="card hold ' + (long ? "l" : "s") + '" id="' + hid + '"><div class="card-hd">' + sidePill(it.dir) + ' <b class="sym">' + coin + '</b> <b class="big ' + tone(mv) + '" data-livepos="' + r.symbol +
          '" data-e="' + it.entry + '" data-d="' + it.dir + '" data-k="' + k + '" data-big="1">' + fmt(mv, 2, true) + "% (" + fmt(it.dir * (it.now - it.entry) / k, 2, true) + "R)</b></div>" + liveHead(r.symbol, it.now) +
        '<div class="facts">' + fact("ระบบเข้า " + thai(it.entryTime).slice(0, 5) + " " + thai(it.entryTime).slice(9, 14), price(it.entry)) +
          fact("Stop Loss", '<span class="down">' + price(it.stop) + '</span><small data-dsl></small>') +
          (tp ? fact(tp.label + (done ? " (TP" + done + " ขายแล้ว)" : ""), '<span class="up">' + price(tp.price) + '</span><small data-dtp></small>')
            : it.tpLevels.length ? fact("TP", "ขายครบแล้ว") : fact("TP", "ไม่ตั้ง")) +
          fact(it.locks ? "TP เลื่อน (ปิดแท่ง)" : "จุดออก (ปิดแท่ง)", it.exitOn ? price(it.exitLevel) : "—") + "</div>" +
        '<p class="fine">' + exitText(it) + " · ถ้าถืออยู่: ถือต่อ ห้ามเลื่อน SL</p>" +
        (j.order ? '<div class="follow join-order">' + ic("check") + '<div><b data-jhead>ถ้ายังไม่ได้เข้า</b> ที่ราคาตลาด ≈ <span data-now="' + r.symbol + '">' + price(it.now) + "</span> · SL " +
            price(j.order.stop) + (tp ? " · " + tp.label + " " + price(tp.price) : " · ส่วนที่เหลือออกตามจุดออก") + " · x" + j.order.lev + ' · <span data-q>' + qtyTxt(z.qty) + "</span> " + coin +
            ' · Margin ≈ <span data-m>' + fmt(z.marginB, 0) + '</span> ฿ · เสี่ยง <span data-rk>' + fmt(z.lossB / cap * 100, 2) + "%</span>" + (j.order.minSize ? " (ขนาดขั้นต่ำ Binance)" : "") +
            marginNote(z.marginB) + (j.ev ? "<small>ทดสอบเข้าช้า " + j.ev.bars + " แท่ง (2023–2026 · R นับจากราคาที่เข้าช้าเอง): " + j.ev.n + " ไม้ · ชนะ " + j.ev.win + "% · เฉลี่ย " + fmt(j.ev.avgR, 2, true) +
              "R" + (j.ev.avgRCI ? " (ช่วง 95% " + fmt(j.ev.avgRCI[0], 2, true) + " ถึง " + fmt(j.ev.avgRCI[1], 2, true) + ")" : "") + "</small>" : "") +
            (j.ok ? "" : '<small class="yel">' + esc(j.html) + "</small>") + "</div></div>"
          : '<div class="follow no join-no">' + ic("minus") + "<div><b>ถ้ายังไม่ได้เข้า</b> <span data-jno>" + j.html + "</span></div></div>") +
        moodLine(r.symbol, it.dir) +
        '<details class="more-chart" data-draw="hold:' + i + '"><summary>กราฟ</summary><div id="smHold' + i + '" class="sm-chart" style="height:220px;margin-top:6px"></div></details></div>';
    }
    // What this trade can cost, from the test: how often a trade like it lost, the baht at the SL, the longest losing run
    // and the deepest drawdown the system had at this risk per trade (2023-2026, 12 coins), and how far liquidation is.
    function wilsonPct(w, n) {
      var z = 1.96, p = w / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
      return [100 * (c - h), 100 * (c + h)];
    }
    // The same rule, period by period: the walk-forward test years (scale-out plan, 12 coins) and the system's own last 30
    // days on the selected coins, so a bad stretch is not hidden behind the long average.
    function periodsHtml() {
      var T = window.EVIDENCE_TREND, k = trendLadder() ? "ladder" : "rule", R = T && T.robust && T.robust.base && T.robust.base[k], all = T && (k === "ladder" ? T.ladder.test : T.all);
      if (!R || !all) return "";
      var row = function (name, s, extra) {
        return "<tr><td>" + name + "</td><td>" + s.n + "</td><td>" + fmt(s.win, 1) + "%</td><td class=\"" + tone(s.avgR) + "\">" + fmt(s.avgR, 3, true) + "R" +
          (s.avgRCI ? "<small> (" + fmt(s.avgRCI[0], 2, true) + " ถึง " + fmt(s.avgRCI[1], 2, true) + ")</small>" : "") + "</td><td>" + (s.pf ? fmt(s.pf, 2) : "—") + "</td><td>" + (extra || "—") + "</td></tr>";
      };
      var cl = (RECENT && RECENT.closed) || [], gp = cl.reduce(function (a, t) { return a + Math.max(0, t.r); }, 0), gl = cl.reduce(function (a, t) { return a - Math.min(0, t.r); }, 0);
      var rec = cl.length ? { n: cl.length, win: 100 * cl.filter(function (t) { return t.r > 0; }).length / cl.length, avgR: cl.reduce(function (a, t) { return a + t.r; }, 0) / cl.length, pf: gl ? gp / gl : null } : null;
      var port = T.normal && T.normal[k] && T.normal[k].port && T.normal[k].port[String(trendRiskPct())];
      return '<div class="card periods"><div class="card-hd"><b>ผลแยกช่วง · กฎเดียวกัน</b><small>หักค่าธรรมเนียม slippage funding แล้ว · R = ความเสี่ยงเริ่มต้นของไม้</small></div>' +
        '<div class="tbl"><table><tr><th>ช่วง</th><th>ไม้</th><th>ชนะ</th><th>เฉลี่ย (ช่วง 95%)</th><th>PF</th><th>ลงลึกสุด</th></tr>' +
        [2023, 2024, 2025, 2026].filter(function (y) { return R.years && R.years[y]; }).map(function (y) { return row(String(y) + (y === 2026 ? " (ถึง ก.ย.)" : ""), R.years[y]); }).join("") +
        row("รวม 2023–2026", all, port ? "−" + fmt(port.maxDD, 1) + "% ที่ " + trendRiskPct() + "%" : "") +
        (rec ? row("30 วันล่าสุด (สดของระบบ)", rec, RECENT && RECENT.N ? { ok: "ปกติ", warn: "ต่ำกว่าปกติ", bad: "แย่กว่าที่เคยเจอ" }[RECENT.lvl] : "") : "") + "</table></div>" +
        costRow(cl) + '<p class="fine">ปี 2023–2026 = ผล walk-forward (กฎถูกเลือกจากปีก่อนหน้าเท่านั้น) · 30 วัน = ไม้ของระบบบนข้อมูลจริงล่าสุด ข้อมูลน้อย ผันผวนสูง · ผลของคุณเอง (บันทึกเอง): เมนู → พอร์ต → Paper</p></div>';
    }
    // Gross R and where it went, for the system's closed trades of the last 30 days (web/trend.js cost fields).
    function costRow(cl) {
      var c = cl.filter(function (t) { return t.cost; });
      if (!c.length) return "";
      var sum = function (k) { return c.reduce(function (a, t) { return a + t.cost[k]; }, 0); }, net = c.reduce(function (a, t) { return a + t.r; }, 0);
      return '<p class="fine cost-row">30 วัน (' + c.length + " ไม้): ก่อนหักต้นทุน " + fmt(sum("grossR"), 1, true) + "R · ค่าธรรมเนียม Taker −" + fmt(sum("feeR"), 1) + "R · slippage −" +
        fmt(sum("slipR") + sum("slipInPriceR"), 1) + "R (ในราคาเข้า/ออก " + fmt(sum("slipInPriceR"), 1) + " + คิดซ้ำเป็นต้นทุน " + fmt(sum("slipR"), 1) + ") · funding −" + fmt(sum("fundR"), 1) +
        "R → สุทธิ " + fmt(net, 1, true) + "R</p>";
    }
    function riskBox(g, z, v) {
      var cap = money(), nm = trendNormal(), streak = nm && nm.normal.worstStreak, dd = nm && nm.port && nm.port.maxDD, pct = z.lossB / cap * 100;
      var rows = [
        ["โอกาสแพ้", v.win !== null ? '<span class="down">' + fmt(100 - v.win, 0) + "%</span> ของไม้แบบนี้ในผลทดสอบ" : "ยังไม่มีข้อมูลพอ"],
        ["ถ้าโดน SL", '<span class="down" data-rb2>−' + fmt(z.lossB, 0) + " ฿</span> (" + fmt(pct, 2) + "% ของทุน · รวมต้นทุนแล้ว = 1R)"],
        ["ต้นทุนไป-กลับ", "ค่าธรรมเนียม Taker ≈ " + fmt(z.notional * FUT.fee * 2 * fx, 2) + " ฿ · slippage ≈ " + fmt(z.notional * FUT.slippage * 2 * fx, 2) + " ฿ · funding ≈ " +
          fmt(z.notional * FUT.funding * 3 * fx, 2) + " ฿/วัน ถ้าต้องจ่าย"],
        streak ? ["ระบบเคยแพ้ติดกัน", streak + ' ไม้ ≈ <span class="down">−' + fmt(streak * pct, 1) + "%</span> ของทุน"] : null,
        dd ? ["พอร์ตเคยลงลึกสุด", '<span class="down">−' + fmt(dd, 1) + "%</span> (เสี่ยง " + trendRiskPct() + "%/ไม้)"] : null,
        g.liq ? ["Liquidation (ประมาณ)", price(g.liq) + " (ห่าง " + fmt(Math.abs(g.liq / g.entry - 1) * 100, 1) + "% · SL ห่าง " + fmt(g.stopPct, 1) + "%)"] : null
      ].filter(Boolean);
      return '<div class="risk-box"><div class="risk-hd">' + ic("alert") + "<b>ความเสี่ยงของไม้นี้</b></div>" +
        rows.map(function (x) { return '<div class="risk-row"><span>' + x[0] + "</span><b>" + x[1] + "</b></div>"; }).join("") + "</div>";
    }
    // A new signal as an order to copy: side, leverage, entry, SL, TP1, size, margin, risk, deadline. Size, margin and risk
    // follow the live price; once the 15 minutes pass the card stays while joining is still within the test. The full
    // sheet folds.
    function orderCard(r, g, z, i) {
      var long = g.dir > 0, coin = r.symbol.replace("USDT", ""), cap = money(), v = verdictOf(r.symbol, TREND.tf, z.lossB / cap * 100), tp1 = g.ladder && g.ladder[0];
      var late = lateFirstBar(), aid = "smAct" + i;
      LC[aid] = { kind: "entry", sym: r.symbol, dir: g.dir, e: g.entry, k: Math.abs(g.entry - g.stop), sl: g.stop, tp: tp1 ? tp1.price : null, tpDone: false, until: g.expires,
        joinOk: !!late, late: late, order: g, since: g.candle, p0: r.close, ord: i };
      return '<div class="card act ' + (long ? "l" : "s") + '" id="' + aid + '"><div class="card-hd">' + sidePill(g.dir, "เข้า", true) + ' <b class="sym">' + coin + '</b> <span class="lev">x' + g.lev + "</span>" +
          (v.win !== null ? '<span class="chip">ชนะ ' + fmt(v.win, 0) + "% (" + v.n + " ไม้ 2023–26)</span>" : "") + "</div>" + liveHead(r.symbol, r.close) +
        '<div class="facts three">' + fact("ราคาเข้า ≈", price(g.entry)) + fact("Stop Loss", '<span class="down">' + price(g.stop) + '</span><small data-dsl></small>') +
          (tp1 ? fact("TP1 ขาย " + fracTxt(tp1.frac), '<span class="up">' + price(tp1.price) + "</span>") : fact("Take Profit", "ไม่ตั้ง")) +
          fact("ขนาด", '<span data-q>' + qtyTxt(z.qty) + "</span><small>" + coin + "</small>") +
          fact("Margin", '<span data-m>' + fmt(z.marginB, 0) + "</span><small>บาท</small>") +
          fact("เสี่ยง", '<span data-rk>' + fmt(z.lossB / cap * 100, 2) + '%</span><small data-rb>≈ ' + fmt(z.lossB, 0) + " บาท</small>") + "</div>" +
        '<p class="fine">Isolated x' + g.lev + " · เข้าภายใน " + thai(g.expires).slice(9, 14) + " น. · ตั้ง SL ใน Binance ทันที · ที่เหลือปิดเมื่อแอปเด้ง \"ปิดไม้\"" +
          (g.minSize ? " · ขนาดขั้นต่ำของ Binance" : " · ขนาดคิดจากราคาตอนนี้ ให้เสี่ยงเท่าเดิมถึง SL") + "</p>" + riskBox(g, z, v) + marginNote(z.marginB) + moodLine(r.symbol, g.dir) +
        '<details class="more-chart" data-draw="sig:' + i + '"><summary>รายละเอียดทั้งหมด + กราฟ</summary>' + tradeSheet(r, g, z, TREND.tf, i) + "</details></div>";
    }
    // A trade's news read: the coin's good and bad headlines, whether they point the trade's way, and how the rule's past
    // trades did in the same market mood. The market mood and what the mood study found are in the system's note.
    function moodLine(symbol, dir) {
      var r = moodRead(symbol, dir), m = r.m, coin = symbol.replace("USDT", "");
      var fitCls = { with: "good", against: "bad", none: "warn" }[r.fit];
      return '<div class="mood"><div class="mood-hd">' + ic("news") + "<b>ข่าว " + coin + " 24 ชม.</b>" +
          (m.coin && m.coin.n ? '<span class="chip good">ดี ' + m.coin.good + '</span><span class="chip bad">ร้าย ' + m.coin.bad + "</span>" : '<span class="chip warn">ไม่มีข่าว</span>') +
          '<span class="chip ' + fitCls + '">' + r.fitText + "</span></div>" + (r.past ? '<p class="fine">' + esc(r.past) + "</p>" : "") + "</div>";
    }
    // The system's note for now, written from rules like a trader's read: market mood and headlines, releases due, then
    // what it does with each signal, exit and position.
    function traderNote(list, held, stopped) {
      var m = News.mood(null), soon = News.upcoming(4), day = News.upcoming(24), lines = [], coin = function (s) { return s.replace("USDT", ""); };
      var add = function (kind, text) { lines.push('<li class="' + kind + '">' + esc(text) + "</li>"); };
      if (m.fng && (m.fng.v < 25 || m.fng.v > 75)) add("warn", "ตลาด" + m.fng.label + ": ราคามักแกว่งแรง ทุกไม้ต้องมี SL ใน Binance");
      if (soon.length) add("warn", "ข่าวแรงก่อนแท่งถัดไปปิด: " + soon.map(function (e) { return e.title + " " + thai(e.time).slice(9, 14) + " น."; }).join(", ") + " · ราคาอาจกระชาก");
      else if (day.length) add("info", "ข่าวแรงใน 24 ชม.: " + day.map(function (e) { return e.title + " " + thai(e.time).slice(9, 14) + " น."; }).join(", "));
      (stopped || []).forEach(function (c) { add("x", (c.dir > 0 ? "LONG " : "SHORT ") + coin(c.sym) + " แตะ SL แล้ว · จบสัญญาณ (ระบบ ≈ −1R)"); });
      results.filter(function (r) { return r.exit; }).forEach(function (r) { add("x", "ปิด " + (r.exit.dir > 0 ? "LONG " : "SHORT ") + coin(r.symbol) + " ตามระบบ (ระบบได้ " + fmt(r.exit.r, 2, true) + "R)"); });
      list.forEach(function (x) {
        var g = x.signal, mr = moodRead(x.symbol, g.dir);
        add(g.dir > 0 ? "l" : "s", (g.dir > 0 ? "เข้า LONG " : "เข้า SHORT ") + coin(x.symbol) + " ตามระบบ · " + mr.fitText + (mr.fit === "against" ? " (ข่าวไม่ได้ทดสอบว่าช่วย จึงยังเข้า)" : ""));
      });
      if (held.length) add("info", "ถือ " + held.length + " ไม้ต่อตามระบบ (" + held.map(function (it) { return coin(it.symbol) + " " + (it.dir > 0 ? "LONG" : "SHORT"); }).join(", ") + ") · ห้ามเลื่อน SL");
      if (!list.length && !results.some(function (r) { return r.exit; }) && !(stopped || []).length) add("info", "ไม่มีไม้ใหม่ · รอแท่ง 4 ชม. ถัดไป");
      var moodCls = m.fng ? (m.fng.v < 45 ? "bad" : m.fng.v > 55 ? "good" : "warn") : "";
      return '<div class="card note"><div class="card-hd"><b>มุมมองของระบบ</b><small>อ่านจากข่าวและอารมณ์ตลาด</small></div><div class="chips">' +
          (m.fng ? '<span class="chip ' + moodCls + '">ตลาด' + m.fng.label + " " + m.fng.v + (m.fng.change ? " " + (m.fng.change > 0 ? "↑" : "↓") + Math.abs(m.fng.change) + " ใน 7 วัน" : "") + "</span>" : "") +
          '<span class="chip good">ข่าวดี ' + m.market.good + '</span><span class="chip bad">ข่าวร้าย ' + m.market.bad + '</span><span class="chip">' + m.market.n + " ข่าว 24 ชม.</span></div>" +
        '<ul class="note-list">' + lines.join("") + '</ul><p class="fine">' + esc(moodRule().text) + "</p></div>";
    }
    // The system's own record: its closed trades of the last 30 days on the selected coins, in R and in % at the set risk.
    function perfHtml() {
      var risk = trendRiskPct(), closed = (RECENT && RECENT.closed) || [];
      var sumR = closed.reduce(function (a, t) { return a + t.r; }, 0), wins = closed.filter(function (t) { return t.r > 0; }).length;
      var why = { exit: "ออกตามสูตร", stop: "SL", stop_gap: "SL", end: "" };
      var nm = trendNormal(), w = nm && nm.normal.windows, N = w ? [100, 50, 30, 20, 10].filter(function (k) { return closed.length >= k && w[k]; })[0] : null, verdict = "";
      if (N) {
        var b = w[N], last = closed.slice(0, N).reduce(function (a, t) { return a + t.r; }, 0);
        var lvl = last < b.min ? "bad" : last < b.p5 ? "warn" : "ok";
        verdict = '<div class="callout ' + lvl + '">' + ic(lvl === "ok" ? "check" : "alert") + "<div><b>" + { ok: "อยู่ในช่วงปกติของผลทดสอบ", warn: "ต่ำกว่าปกติ: แย่กว่า 95% ของช่วงในผลทดสอบ แต่ยังไม่แย่เท่าที่เคยเจอ",
          bad: "แย่กว่าที่ผลทดสอบเคยเจอ: สูตรอาจเสื่อม หยุดเข้าไม้ใหม่และทบทวน" }[lvl] + "</b><small>" + N + " ไม้ล่าสุดรวม " + fmt(last, 1, true) + "R · ผลทดสอบ " + N +
          " ไม้ติดกัน: ปกติ " + fmt(b.p50, 1, true) + "R · แย่ 5% ล่างสุด " + fmt(b.p5, 1, true) + "R · แย่สุดที่เคยเจอ " + fmt(b.min, 1, true) + "R" +
          (lvl === "ok" ? "" : " · ช่วงแบบนี้ควรเสี่ยงต่ำสุด (0.25%) หรือรอให้กลับเข้ากรอบปกติก่อนใช้เงินเพิ่ม") + "</small></div></div>";
      }
      return '<div class="sec-hd">ผลงานระบบ 30 วัน</div><div class="card perf">' +
        (closed.length ? '<div class="card-hd"><b>' + closed.length + ' ไม้ที่ปิด</b><small>ชนะ ' + wins + " · แพ้ " + (closed.length - wins) + '</small><b class="big ' + tone(sumR) + '">' + fmt(sumR, 1, true) + "R</b></div>" +
            '<p class="fine">≈ <b class="' + tone(sumR) + '">' + fmt(sumR * risk, 1, true) + "% ของทุน</b> ที่เสี่ยง " + risk + "%/ไม้</p>" + verdict +
            closed.slice(0, 8).map(function (t) {
              return '<div class="perf-row">' + sidePill(t.dir) + " <b>" + t.symbol.replace("USDT", "") + "</b> <small>" + thai(t.entry_time).slice(0, 5) + " → " + thai(t.exit_time).slice(0, 5) +
                " · " + (why[t.reason] || "") + '</small><b class="r ' + tone(t.r) + '">' + fmt(t.r, 2, true) + "R</b></div>";
            }).join("")
          : "<p>ยังไม่มีไม้ที่ปิดใน 30 วันของเหรียญที่เลือก</p>") +
        '<p class="fine">สูตรชนะราว 1 ใน 3 กำไรมาจากไม้ใหญ่ไม่กี่ไม้ · ดูยอดรวม ไม่ใช่จำนวนครั้งที่ชนะ</p></div>';
    }
    // Trend 4H for someone who follows the system: its status, the system's read, then its signals and positions in three
    // groups that follow the live price (paintLive moves the cards): can follow now, ended, holding but too late to follow;
    // then its last 30 days. Everything else (confidence, news, plan and routine, what is normal) folds into one section.
    function followView(list, items) {
      RECENT = recentFrom(results);
      var sch = trendSchedule(Date.now()), c = trendConfidence(), bg = {}, lc = null, coin = function (r) { return r.symbol.replace("USDT", ""); };
      try { bg = window.NativeHttp && window.NativeHttp.lastScanStatus ? JSON.parse(window.NativeHttp.lastScanStatus() || "{}") : {}; } catch (e) { /* none */ }
      try { lc = JSON.parse(localStorage.getItem("liveCheck") || "null"); } catch (e) { /* none yet */ }
      var bad = bg.at && bg.ok === false, problem = bad || lastError;
      var h = '<div class="card sys"><div class="card-hd"><b>ระบบเทรด Trend 4H</b><span class="status ' + (problem ? "bad" : "ok") + '"><i></i>' +
          (problem ? "มีปัญหา" : busyNow ? "กำลังเช็ก…" : "ทำงานอยู่") + "</span></div>" +
        '<div class="facts four">' + fact("เช็กครั้งถัดไป", thai(sch.next).slice(9, 14) + " น.") + fact("เหรียญ", selectedCoins().length) + fact("เสี่ยงต่อไม้", trendRiskPct() + "%") +
          fact("ความมั่นใจ", c ? '<span class="yel">' + c.level + "</span>" : "—") + "</div>" +
        '<p class="fine">' + (lastScan ? "เช็กล่าสุด " + thai(lastScan).slice(9, 14) + " น. · " : "") + "แอป v" + APP_VERSION + "</p>" +
        (bad ? '<p class="fine down">แจ้งเตือนเบื้องหลัง: ' + esc(bg.text || "").slice(0, 140) + "</p>" : "") +
        (lastError ? '<p class="fine down">เช็กไม่สำเร็จ: ' + esc(lastError).slice(0, 120) + "</p>" : "") +
        (lc && (lc.level === "watch" || lc.level === "broken") ? '<div class="callout ' + (lc.level === "broken" ? "bad" : "warn") + ' sm">' + ic("alert") + "<span>" + esc(lc.text) + "</span></div>" : "") + "</div>";
      LC = {};
      var now = Date.now(), held = items.filter(function (it) { return it.kind === "hold"; }), resOf = function (sym) { return results.filter(function (r) { return r.symbol === sym; })[0]; };
      // Entries past their 15 minutes: the system has been in since this bar's open; the card stays (as joining late).
      var entries = list.concat(results.filter(function (r) { return r.signal && !r.signal.below_minimum && now >= r.signal.expires; }));
      var cards = entries.map(function (x, i) { return orderCard(x, x.signal, sized(x.signal), i); }).join("") +
        held.map(function (it, i) { return holdCard(it, resOf(it.symbol), i); }).join("");
      var exits = results.filter(function (r) { return r.exit; }).map(function (r) {
        var x = r.exit;
        return '<div class="card act x" id="smExit' + r.symbol + '"><div class="card-hd">' + sidePill(x.dir, "ปิด", true) + ' <b class="sym">' + coin(r) + "</b>" +
          '<span class="chip ' + (x.r >= 0 ? "good" : "bad") + '">ระบบได้ ' + fmt(x.r, 2, true) + "R</span></div><p>จบสัญญาณ · ถ้ายังถืออยู่: ปิดด้วย Market ตอนนี้ · ถ้าไม่ได้ถือ ไม่ต้องทำอะไร</p>" +
          '<p class="fine">แท่ง 4 ชม. ปิด ' + price(x.close) + (x.dir > 0 ? " ต่ำกว่า " : " สูงกว่า ") + price(x.level) + " · ระบบเข้าเมื่อ " + thai(x.entry_time).slice(0, 14) + " น. ที่ " + price(x.entry) + "</p></div>";
      }).join("");
      // Signals that ended in the last 24 hours (stop or the channel exit), newest first.
      var why = { exit: "ออกตามสูตร", stop: "โดน SL", stop_gap: "โดน SL", end: "" }, ended = [];
      results.forEach(function (r) { (r.recent || []).forEach(function (t) { if (!t.open && now - t.exit_time < 86400000) ended.push(Object.assign({ symbol: r.symbol }, t)); }); });
      ended.sort(function (a, b) { return b.exit_time - a.exit_time; });
      var endedRows = ended.map(function (t) {
        return '<div class="perf-row">' + sidePill(t.dir) + " <b>" + t.symbol.replace("USDT", "") + "</b> <small>จบ " + thai(t.exit_time).slice(9, 14) + " น. · " + (why[t.reason] || "") +
          '</small><b class="r ' + tone(t.r) + '">' + fmt(t.r, 2, true) + "R</b></div>";
      }).join("");
      var idle = '<div class="card idle" id="emptyFollow">' + (busyNow ? ic("clock") + "<div><b>กำลังเช็ก " + selectedCoins().length + " เหรียญ…</b></div></div>"
        : ic("check") + "<div><b>ตอนนี้ไม่ต้องทำอะไร</b><p>ยังไม่มีไม้ที่ตามได้ · แอปจะเด้งแจ้งเตือนเองเมื่อมีไม้ใหม่หรือต้องปิดไม้" +
          (entries.length + held.length ? "" : " · ระบบยังไม่มีไม้เปิด") + "</p></div></div>");
      noteOf = { list: list, held: held };
      h += '<div id="smNote">' + traderNote(list, held) + "</div>";
      if (systemPaused()) h += '<div class="callout bad">' + ic("alert") + "<div><b>NO TRADE · ระบบหยุดเข้าไม้ใหม่</b><small>" + RECENT.N + " ไม้ล่าสุดของระบบรวม " +
        fmt(RECENT.last, 1, true) + "R แย่กว่าที่ผลทดสอบเคยเจอในช่วงยาวเท่ากัน (" + fmt(RECENT.band.min, 1, true) + "R) · ผลทดสอบไม่ครอบคลุมสภาพนี้แล้ว · ไม้ที่ถืออยู่ยังแจ้งปิดตามปกติ · กลับมาแจ้งเข้าเมื่อกลับเข้ากรอบ</small></div></div>";
      h += '<div class="sec-hd">ตามได้ตอนนี้ <span class="cnt" id="cntFollow"></span><small id="feedSt">กำลังต่อราคาสด…</small></div><div id="smNewsTop">' + News.topHtml() + "</div>" +
        '<div id="grpFollow">' + cards + "</div>" + idle +
        results.filter(function (r) { return r.signal && r.signal.below_minimum; }).map(function (r) {
          return '<p class="fine">' + coin(r) + " " + (r.signal.dir > 0 ? "LONG" : "SHORT") + " มีสัญญาณแต่ไม่ผ่าน: " + esc(r.signal.reject) + "</p>";
        }).join("");
      h += '<div id="secEnded"><div class="sec-hd">จบสัญญาณแล้ว <span class="cnt" id="cntEnded"></span><small>ถ้ายังถืออยู่ ปิดตามนี้</small></div>' + exits + '<div id="grpEnded"></div>' +
        (endedRows ? '<div class="card ended-list"><div class="card-hd"><b>จบใน 24 ชม.</b></div>' + endedRows + "</div>" : "") + "</div>";
      // Coins with nothing open: how far the price is from the close that would start a trade, live. A bar that is past the
      // level now is not a signal until it closes there (the rule, tested; mid-bar entries on 15m-1h bars lost).
      var watch = results.filter(function (r) { return r.watch && !r.position && !r.exit && !r.signal; });
      if (watch.length) h += '<div class="sec-hd">ใกล้จุดเข้า <span class="cnt">' + watch.length + '</span><small>เข้าเมื่อแท่ง 4 ชม. ปิด ' + thai(watch[0].watch.closeAt).slice(9, 14) +
        ' น. เลยเส้น</small></div><div class="card watch" id="smWatch">' + watch.map(function (r) {
          var w = r.watch, dir = r.close >= w.ema ? 1 : -1, lvl = dir > 0 ? w.upper : w.lower;
          return '<div class="watch-row" data-watch="' + r.symbol + '" data-lvl="' + lvl + '" data-dir="' + dir + '">' + sidePill(dir) + " <b>" + coin(r) + "</b>" +
            '<small>ถ้าปิด' + (dir > 0 ? "เหนือ " : "ใต้ ") + price(lvl) + '</small><span class="watch-now" data-now="' + r.symbol + '">' + price(r.close) + '</span><b class="watch-d" data-wd>—</b></div>';
        }).join("") + '<p class="fine">ระหว่างแท่งราคาอาจทะลุแล้วกลับ สูตรนับเฉพาะราคาปิด · แอปเด้งแจ้งเตือนเองทันทีที่แท่งปิดเข้าเงื่อนไข</p></div>';
      h += '<div id="secHold"><div class="sec-hd">ไม้จำลองของระบบ · ตามไม่ทันแล้ว <span class="cnt" id="cntHold"></span><small>ระบบถือในการจำลอง ไม่ใช่ไม้ใน Binance ของคุณ</small></div><div id="grpHold"></div></div>';
      var endedStatic = (exits ? results.filter(function (r) { return r.exit; }).length : 0) + ended.length;
      h += periodsHtml() + perfHtml();
      var T = window.EVIDENCE_TREND, port = T && T.portfolio && T.portfolio[String(trendRiskPct())];
      h += '<details class="sm-more" id="smMore"><summary>ข้อมูลเพิ่มเติม · ความมั่นใจ · ข่าว · แผนเทรด · ปกติของสูตร</summary>' + confidenceHtml() +
        (normalText() ? '<div class="card"><p>' + esc(normalText()) + '</p><p class="fine">ผลจริงอยู่ในกรอบนี้ = สูตรทำงานปกติ ไม่ใช่สูตรพัง · เทียบผลจริงได้ที่ เมนู → พอร์ต → Paper' +
          (lc ? " (ล่าสุด: " + esc(lc.text.split(":")[0]) + ", " + lc.n + " ไม้)" : "") + "</p></div>" : "") +
        (port ? '<div class="card"><p>ผลทดสอบ ' + trendPeriod() + " (12 เหรียญ, walk-forward): เสี่ยง " + trendRiskPct() + "%/ไม้ → พอร์ตโตเฉลี่ยปีละ " +
          fmt(port.cagr, 1, true) + "% · ช่วงแย่สุด −" + fmt(port.maxDD, 1) + "% · ชนะ " + fmt(T.all.win, 0) + '% ของไม้</p><p class="fine">ผลจริงมักแย่กว่าทดสอบ · สัญญาณไม่ใช่คำสั่งซื้อขาย</p></div>' : "") +
        Routine.html() + newsBox() + "</details>";
      LCended = endedStatic;
      return { html: h, held: held, entries: entries };
    }
    // Everything about one trade: the signal, the price levels and take profits, the size in coins / USDT / baht at the
    // user's balance and risk, how often trades like it went right in the test (with its 95% range), and what the user
    // gets if it goes right or wrong.
    // The three numbers to type and check in Binance: leverage, risk of the balance, margin.
    function keyBox(g, z, cap) {
      var cell = function (k, v, sub) { return "<div><small>" + k + "</small><b>" + v + "</b><small>" + sub + "</small></div>"; };
      return '<div class="sm-key">' + cell("Leverage", "x" + g.lev, "Isolated") +
        cell("ความเสี่ยงต่อไม้", fmt(z.lossB / cap * 100, 2) + "%", "≈ " + fmt(z.lossB, 0) + " ฿ ถ้าโดน SL") +
        cell("Margin ที่วาง", fmt(z.marginB, 0) + " ฿", fmt(z.marginB / cap * 100, 1) + "% ของทุน") + "</div>";
    }
    function levWhy(g) {
      return "SL ห่าง " + fmt(g.stopPct, 2) + "% → Leverage สูงสุดที่จุด Liquidation ยังไกลกว่า SL 1.5 เท่า = " + g.levLiq + "x · เพดานที่ตั้ง " + g.levCapUser + "x → ใช้ " + g.lev +
        "x · Leverage ไม่เปลี่ยนเงินที่เสียถ้าโดน SL (กำหนดจาก % ความเสี่ยง) แค่เปลี่ยน Margin ที่ต้องวาง";
    }
    function tradeSheet(r, g, z, tf, i) {
      var coin = r.symbol.replace("USDT", ""), long = g.dir > 0, cap = money(), usd = function (v) { return fmt(v, v < 10 ? 2 : 1) + " USDT"; };
      var row = function (k, v) { return "<div><span>" + k + "</span><b>" + v + "</b></div>"; }, sec = function (t) { return '<div class="sm-sec">' + t + "</div>"; };
      var dist = function (v) { return fmt((v / g.entry - 1) * 100, 2, true) + "%"; }, left = Math.max(0, Math.round((g.expires - Date.now()) / 60000));
      var baht = function (v) { return '<span class="' + (v >= 0 ? "up" : "down") + '">' + (v >= 0 ? "+" : "−") + fmt(Math.abs(v), 0) + " ฿</span> (" + fmt(v / cap * 100, 2, true) + "%)"; };
      var marginU = z.notional / g.lev, feeB = z.notional * 2 * (FUT.fee + FUT.slippage) * fx, oneR = z.lossB, trend = isTrend(tf);
      var st = trend ? trendStats() : null, ev = evidenceFor(r.symbol, tf);
      var risk = trend ? Math.min(TREND.maxRiskPct, Portfolio.plan().riskPct || LOCK.riskPct) : null;
      var floorQ = function (q) { return g.step > 0 ? toGrid(q, g.step, "floor") : q; };
      var lad = g.ladder ? g.ladder.map(function (t) { var q = floorQ(z.qty * t.frac); return Object.assign({ q: q, gain: q * Math.abs(t.price - g.entry) * fx }, t); }) : null;
      var rest = lad ? 1 - lad.reduce(function (a, t) { return a + t.frac; }, 0) : 1;
      var restQ = lad ? z.qty - lad.reduce(function (a, t) { return a + t.q; }, 0) : z.qty;
      var exitTxt = "แท่ง 4 ชม. ปิด" + (long ? "ต่ำกว่า " : "สูงกว่า ") + price(g.exitLevel) + " (" + dist(g.exitLevel) + ") หรือ SL · ระดับนี้เลื่อนตามราคา · แอปเด้ง \"ปิดไม้\"";
      var tpRows = hasTp(g)
        ? row("Take Profit", '<span class="up">TP1 ' + price(g.tps[0]) + " (1R) · TP2 " + price(g.tps[1]) + " (2R) · TP3 " + price(g.tps[2]) + " (5R)</span>") +
          row("ถือไม่เกิน", fmt(g.hold, g.hold < 10 ? 1 : 0) + " ชม.")
        : lad
          ? lad.map(function (t, k) {
              return row("TP" + (k + 1) + " · ขาย " + fracTxt(t.frac), '<span class="up">' + price(t.price) + "</span> (" + dist(t.price) + " · +" + t.r + "R) · " + qtyTxt(t.q) + " " + coin +
                " → +" + fmt(t.gain, 0) + " ฿");
            }).join("") + row("ส่วนที่เหลือ " + fracTxt(rest), qtyTxt(restQ) + " " + coin + " · ออกเมื่อ" + exitTxt) +
            (lad.some(function (t) { return t.q < (g.minQty || 0) || !(t.q > 0); }) ? row("หมายเหตุ", "ทุนเล็ก: บางขั้นต่ำกว่าขนาดขั้นต่ำ " + g.minQty + " " + coin + " แบ่งขายไม่ได้ครบ") : "")
          : row("Take Profit", "ไม่ตั้ง (โหมดถือตามเทรนด์)") + row("จุดออก", exitTxt);
      // Outcomes at this size: 1R = the loss at the SL (fees included); partial fills then the rest at the SL or at +5R.
      var outcomes = row("ผิดทาง: โดน SL ทั้งไม้", baht(-oneR));
      if (lad) {
        var sold = 0, gotR = 0;
        lad.forEach(function (t, k) {
          sold += t.frac; gotR += t.frac * t.r;
          outcomes += row("ถึง TP" + (k + 1) + " แล้วกลับมาโดน SL", baht((gotR - (1 - sold)) * oneR));
        });
        outcomes += row("ถึงทุก TP แล้วส่วนที่เหลือวิ่งถึง +5R", baht((gotR + rest * 5) * oneR));
      } else if (hasTp(g)) {
        outcomes += row("ถูกทาง: ถึง TP3 (+5R)", baht(z.winB));
      } else {
        outcomes += row("ถูกทาง: ออกที่ +2R", baht(2 * oneR)) + row("ถูกทาง: วิ่งถึง +5R", baht(5 * oneR));
      }
      var R = st && st.reach, conf = !trend ? '<div class="ev ' + (ev.ok && ev.avgR > 0 ? "good" : "bad") + '">' + esc(ev.text) + "</div>"
        : st && st.n >= 30
          ? row("ปิดกำไร", "<b>" + st.win + "%</b> ของไม้ (ช่วง 95%: " + st.winCI[0] + "–" + st.winCI[1] + "%)") +
            (R ? row("ราคาไปถึง +1R", R[1] + "%") + row("ราคาไปถึง +2R", R[2] + "%") + row("ราคาไปถึง +3R", R[3] + "%") + row("ราคาไปถึง +5R", R[5] + "%") +
              row("ไม่ถึง +1R เลย", fmt(100 - R[1], 1) + "% (โดน SL " + R.slFirst + "% · ออกตามสูตร " + fmt(100 - R[1] - R.slFirst, 1) + "%)") : "") +
            row("กำไรเฉลี่ยต่อไม้", fmt(st.avgR, 2, true) + "R ≈ " + baht(st.avgR * oneR).replace(/ \(.*\)$/, "") + " (ช่วง 95%: " + fmt(st.avgRCI[0], 2, true) + " ถึง " + fmt(st.avgRCI[1], 2, true) + "R)") +
            (isFinite(st.t) ? row("มั่นใจว่ากำไรเฉลี่ยเป็นบวก", sure(st.t)) : "") +
            row("ไม้ที่ใช้คำนวณ", st.n + " ไม้ (ทุกเหรียญรวม · " + (trendLadder() ? "แบ่งขาย" : "ไม่ตั้ง TP") + ") · สถิติรายเหรียญไม่ซ้ำเดิมในปีถัดไป จึงใช้ของทั้งระบบ")
          : row("ความมั่นใจ", "ยังไม่มีข้อมูลยืนยัน (ไม้ทดสอบน้อยกว่า 30)");
      return '<div class="sm-sum sm-sheet ' + (long ? "l" : "s") + '" id="smSheet' + i + '"><div class="sm-sheet-hd"><b>' + (i + 1) + ". " + r.symbol + ' <small>Perp</small></b><span class="pill ' + (long ? "go" : "short") + '">' +
          (long ? "LONG" : "SHORT") + "</span></div>" + headline(g.dir, g.lev, verdictOf(r.symbol, tf, z.lossB / cap * 100)) +
          (trend && confidenceLine() ? '<div class="conf-line">ความมั่นใจของสูตร: <b>' + confidenceLine() + "</b></div>" : "") + keyBox(g, z, cap) + "<div class=\"sm-order\">" +
        sec("สัญญาณ") +
        row("ฝั่ง", '<span class="' + (long ? "up" : "down") + '">' + (long ? "LONG (Buy)" : "SHORT (Sell)") + "</span>") +
        row("สูตร", esc(g.stratName)) + row("กรอบเวลา", TF[tf].name) +
        row("แท่งสัญญาณปิด", thai(g.candle) + " น.") +
        row("เข้าภายใน", thai(g.expires).slice(9) + " น. (เหลือ " + left + " นาที)") +
        row("เหตุผล", esc(g.why)) +
        sec("ราคา") +
        row("ราคาตอนนี้", '<span data-now="' + r.symbol + '">' + price(r.close) + "</span>") +
        row("ราคาเข้าอ้างอิง", price(g.entry) + " (ปิดแท่ง" + (g.mark ? " · Mark " + price(g.mark) : "") + ")") +
        row("Stop Loss", '<span class="down">' + price(g.stop) + "</span> (" + dist(g.stop) + " · " + g.stopAtr + " ATR)") + tpRows +
        row("Liquidation (ประมาณ)", price(g.liq) + " (" + dist(g.liq) + ")") +
        sec("ขนาดไม้ · ทุน " + fmt(cap, 0) + " ฿" + (risk ? " · เสี่ยง " + risk + "%/ไม้" : "")) +
        row("Margin mode", "Isolated") +
        row("ทำไม x" + g.lev, levWhy(g)) +
        row("ความเสี่ยง", g.minSize ? "จริง " + fmt(z.lossB / cap * 100, 2) + "% (ขนาดขั้นต่ำของ Binance) · ตั้งไว้ " + (risk || LOCK.riskPct) + "%"
          : fmt(z.lossB / cap * 100, 2) + "% ของทุน ตามที่ตั้งไว้ (เปลี่ยนได้ในตั้งค่า \"เสี่ยงต่อไม้\")") +
        row("ขนาด (Size)", qtyTxt(z.qty) + " " + coin + (g.minSize ? " (ขั้นต่ำที่ Binance ยอม)" : "")) +
        row("มูลค่าสัญญา", usd(z.notional) + " ≈ " + fmt(z.notional * fx, 0) + " ฿") +
        row("Margin ที่ใช้", usd(marginU) + " ≈ " + fmt(z.marginB, 0) + " ฿ (" + fmt(z.marginB / cap * 100, 1) + "% ของทุน)") +
        row("ค่าธรรมเนียม+slippage", "≈ " + fmt(feeB, 1) + " ฿ ไป-กลับ") +
        row("ราคาขยับ 1%", "≈ ±" + fmt(z.notional * 0.01 * fx, 1) + " ฿") +
        (g.sizeLimited ? row("หมายเหตุ", "ลดขนาดให้ Margin ไม่เกิน " + LOCK.marginShare * 100 + "% ของทุน") : "") +
        sec("ผลลัพธ์ถ้าถูกทาง / ผิดทาง") + outcomes +
        sec(trend ? "ความมั่นใจ · สถิติไม้ของระบบ (walk-forward " + trendPeriod() + ")" : "ความมั่นใจ · สถิติไม้แบบนี้ของ " + coin) + conf + "</div>" +
        '<small class="muted">ความมั่นใจคือสถิติของไม้ลักษณะเดียวกันในช่วงทดสอบ ไม่ใช่การรับประกันไม้นี้ · ผลลัพธ์คิดจากขนาดไม้นี้ รวมค่าธรรมเนียมโดยประมาณ</small>' +
        newsFor(r.symbol) +
        '<div class="sm-chart-hd" style="margin-top:8px">กราฟ 4 ชม. · ' + coin + '</div><div id="smChart' + i + '" class="sm-chart"></div>' +
        (Portfolio.openTrades().some(function (t) { return t.symbol === r.symbol && (t.dir || 1) === g.dir && t.entry_time >= g.candle; })
          ? '<button type="button" class="mini" disabled style="width:100%;margin-top:8px">บันทึกแล้ว ✓ ดูกำไร/ขาดทุนสดด้านบน</button></div>'
          : '<button type="button" class="mini" data-save="' + i + '" style="width:100%;margin-top:8px">เข้าแล้ว · บันทึกลงพอร์ต (ดูกำไร/ขาดทุนสด)</button></div>');
    }
    // The coin's headlines of the last 24 hours and high-impact US releases before the next 4-hour close.
    function newsFor(symbol) {
      var list = News.forCoin(symbol, 24), soon = News.upcoming(4), mine = selectedCoins().map(function (c) { return c.replace("USDT", ""); });
      return '<div class="sm-sec">ข่าว ' + symbol.replace("USDT", "") + " 24 ชม. · ข่าวไม่เปลี่ยนสัญญาณ</div>" +
        (soon.length ? '<div class="callout warn sm">' + ic("alert") + "<span>ข่าวแรงก่อนแท่งถัดไปปิด: " + soon.map(function (e) { return esc(e.title) + " " + thai(e.time).slice(9, 14) + " น."; }).join(" · ") + "</span></div>" : "") +
        (list.length ? list.slice(0, 4).map(function (x) { return News.row(x, mine); }).join("") : '<small class="muted">ไม่มีข่าวที่พูดถึงเหรียญนี้</small>');
    }
    function newsBox() { return '<div id="smNews">' + newsList() + "</div>"; }
    function newsList() { return News.listHtml(selectedCoins().map(function (c) { return c.replace("USDT", ""); }), 8); }
    // New headlines every 2 minutes: only the news boxes change, so the sheets, charts and scroll position stay.
    function redrawNews() {
      if ($("smNewsTop")) $("smNewsTop").innerHTML = News.topHtml();
      if ($("smNote") && isTrend(curTf())) $("smNote").innerHTML = traderNote(signals(), planItems().filter(function (it) { return it.kind === "hold"; }));
      if ($("smNews")) $("smNews").innerHTML = newsList();
    }
    // Proof of life: when the app last scanned here, what it found, and the last background scan Android ran.
    function statusLine() {
      var bg = {}, blocked = results.filter(function (r) { return r.signal && r.signal.below_minimum; }).length;
      try { bg = window.NativeHttp && window.NativeHttp.lastScanStatus ? JSON.parse(window.NativeHttp.lastScanStatus() || "{}") : {}; } catch (e) { /* none */ }
      return '<div class="sm-status">' + (lastScan ? "สแกนล่าสุด " + thai(lastScan).slice(9) + " น." + (meta ? " · แท่งที่ปิด " + thai(meta.end).slice(9) + " น." : "") +
          " · " + results.length + " เหรียญ" + (meta && meta.failed ? " (ล้มเหลว " + meta.failed + ")" : "") + " · สัญญาณใหม่ " + signals().length +
          (blocked ? " · ทุนไม่พอ/ไม่ผ่าน " + blocked : "") : busyNow ? "กำลังสแกน…" : "ยังไม่ได้สแกน") +
        (lastError ? '<br><span class="down">สแกนไม่สำเร็จ: ' + esc(lastError).slice(0, 120) + "</span>" : "") +
        (bg.at ? '<br><span class="' + (bg.ok ? "" : "down") + '">เบื้องหลัง ' + thai(bg.at).slice(9) + " น.: " + esc(bg.text || "").slice(0, 140) + "</span>" : "") + "</div>";
    }
    function draw() {
      clearPlans();
      if (isTrend(curTf())) RECENT = recentFrom(results);
      var list = signals(), tf = curTf(), cap = money(), items = isTrend(tf) ? planItems() : [], held = [], ents = list, head;
      var rtOpen = $("smRoutine") && $("smRoutine").open, moreOpen = $("smMore") && $("smMore").open;
      if (isTrend(tf)) {
        var view = followView(list, items);
        head = '<div id="smLive">' + liveHtml() + "</div>" + view.html;
        held = view.held; ents = view.entries;
      } else {
        // Debug builds only (the app trades Trend 4H): the trial strategies' full sheets.
        head = statusLine() + squeezeHead(tf) + (list.length ? list.map(function (x, i) { return tradeSheet(x, x.signal, sized(x.signal), tf, i); }).join("")
          : '<div class="sm-bt" style="font-size:13px"><b>สัญญาณเข้าใหม่: ไม่มี</b> (แท่ง ' + TF[tf].name + " ที่ปิดล่าสุด)</div>") + newsBox();
      }
      $("smMain").innerHTML = head;
      if (rtOpen && $("smRoutine")) $("smRoutine").open = true;
      if (moreOpen && $("smMore")) $("smMore").open = true;
      Routine.bind(draw);
      bindLive();
      paintLive();
      // Charts draw when their section is opened (a folded chart has no width yet).
      Array.prototype.forEach.call(document.querySelectorAll("#smMain details[data-draw]"), function (d) {
        d.addEventListener("toggle", function () {
          if (!d.open || d.getAttribute("data-drawn")) return;
          d.setAttribute("data-drawn", "1");
          var p = d.getAttribute("data-draw").split(":"), i = +p[1];
          try {
            if (p[0] === "sig") drawPlan($("smChart" + i), items.filter(function (y) { return y.symbol === ents[i].symbol && y.kind === "entry"; })[0]);
            else drawPlan($("smHold" + i), held[i]);
          } catch (e) { /* the chart is a convenience; the numbers are complete */ }
        });
      });
      floatAlerts(list, tf, cap);
      Array.prototype.forEach.call(document.querySelectorAll("#smMain [data-save]"), function (b) {
        b.onclick = function () {
          // At the live price when there is one: the size that keeps the set risk to the SL from there.
          var x = ents[+b.getAttribute("data-save")], live = px[x.symbol] > 0 && isTrend(tf) ? px[x.symbol] : 0, z = live ? liveSize(x.signal, live) : sized(x.signal);
          Portfolio.open(Object.assign(recordOf(x, x.signal, fx), { qty: z.qty, risk: z.lossB }, live ? { entry: live } : {}));
          draw();
          if ($("smLive")) $("smLive").scrollIntoView({ behavior: "smooth", block: "start" });
        };
      });
      watch();
    }
    // New entries and exits pop a coloured bar over the screen (green LONG / red SHORT / orange close), once per signal
    // even across restarts; tap scrolls to the trade, it hides by itself after 25 s.
    var floatSeen = {}, floatTimer = null;
    try { floatSeen = JSON.parse(localStorage.getItem("floatSeen") || "{}") || {}; } catch (e) { floatSeen = {}; }
    function floatAlerts(list, tf, cap) {
      var now = Date.now(), fresh = [], coin = function (s) { return s.replace("USDT", ""); };
      results.filter(function (r) { return r.exit; }).forEach(function (r) {
        var x = r.exit, key = "X:" + tf + ":" + r.symbol + ":" + x.dir + ":" + x.candle;
        if (!floatSeen[key]) fresh.push({ key: key, cls: "x", go: "smExit" + r.symbol,
          head: "ปิดไม้ " + (x.dir > 0 ? "LONG " : "SHORT ") + coin(r.symbol) + " ตอนนี้ (ถ้าถืออยู่)", body: "ปิดด้วย Market · ตอนนี้ " + fmt(x.r, 2, true) + "R · " + TF[tf].name });
      });
      list.forEach(function (r, i) {
        var g = r.signal, key = "E:" + tf + ":" + r.symbol + ":" + g.dir + ":" + g.candle, long = g.dir > 0;
        if (floatSeen[key]) return;
        var v = verdictOf(r.symbol, tf, sized(g).lossB / cap * 100), tp1 = g.ladder && g.ladder[0] ? g.ladder[0].price : hasTp(g) ? g.tps[0] : null;
        fresh.push({ key: key, cls: long ? "l" : "s", go: isTrend(tf) ? "smAct" + i : "smSheet" + i,
          head: (long ? "LONG " : "SHORT ") + coin(r.symbol) + " x" + g.lev + (v.win !== null ? " · โอกาสกำไร " + fmt(v.win, 0) + "%" : "") + " · เสี่ยง " + fmt(v.risk, 2) + "%",
          body: "เข้า " + price(g.entry) + " · SL " + price(g.stop) + (tp1 ? " · TP1 " + price(tp1) : " · ไม่มี TP") + " · " + TF[tf].name });
      });
      // The background scan's hidden page shares storage with the app and must not use up the in-app alert.
      if (!fresh.length || location.hash === "#bg") return;
      fresh.forEach(function (f) { floatSeen[f.key] = now; });
      Object.keys(floatSeen).forEach(function (k) { if (now - floatSeen[k] > 3 * 86400000) delete floatSeen[k]; });
      try { localStorage.setItem("floatSeen", JSON.stringify(floatSeen)); } catch (e) { /* shown again next time */ }
      var el = $("floatAlert"), hide = function () { el.classList.add("hidden"); };
      el.innerHTML = fresh.slice(0, 3).map(function (f) {
        return '<div class="fa ' + f.cls + '" data-go="' + f.go + '"><b>' + esc(f.head) + "</b><small>" + esc(f.body) + " · แตะดู</small></div>";
      }).join("") + (fresh.length > 3 ? '<div class="fa more">+ อีก ' + (fresh.length - 3) + " สัญญาณด้านล่าง</div>" : "") +
        '<button type="button" class="fa-x" aria-label="ปิด">' + ic("x") + "</button>";
      el.classList.remove("hidden");
      el.querySelector(".fa-x").onclick = hide;
      Array.prototype.forEach.call(el.querySelectorAll("[data-go]"), function (d) {
        d.onclick = function () { hide(); var t = $(d.getAttribute("data-go")); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); };
      });
      clearTimeout(floatTimer); floatTimer = setTimeout(hide, 25000);
    }
    // Live mark prices (the price Binance uses for unrealized P&L): Binance's free WebSocket, every second, for the coins on
    // screen and the trades entered; when it cannot connect, one REST request per coin every 3 seconds. Only while open.
    var px = {}, ws = null, wsKey = "", poll = null, wsFail = 0, paintTimer = null, feed = "", ticker = null, barHL = {}, lastTick = 0, wsSince = 0;
    // Binance moved USD-M futures market streams (mark price, klines) to /market on 2026-04-23; the old /stream address
    // still connects but sends nothing, so a socket silent for 8 s is dropped for REST polling.
    var FSTREAM = "wss://fstream.binance.com/market/stream?streams=";
    // The 4-hour bar now forming: the system's stop or take profit counts as soon as the price touches it in this bar, so
    // its high and low since the open (from Binance once, then every live price) decide "ended" and "TP1 sold".
    function barOpen() { return Math.floor(Date.now() / 14400000) * 14400000; }
    function loadBars() {
      var t = barOpen();
      Object.keys(LC).forEach(function (id) {
        var sym = LC[id].sym;
        if (barHL[sym] && barHL[sym].t === t && barHL[sym].full) return;
        barHL[sym] = barHL[sym] && barHL[sym].t === t ? barHL[sym] : { t: t, hi: -Infinity, lo: Infinity };
        futuresApi("/fapi/v1/klines?symbol=" + sym + "&interval=4h&limit=1").then(function (rows) {
          var k = rows && rows[rows.length - 1], b = barHL[sym];
          if (!k || +k[0] !== t || !b || b.t !== t) return;
          b.hi = Math.max(b.hi, +k[2]); b.lo = Math.min(b.lo, +k[3]); b.full = true;
          paintLive();
        }, function () { /* the live prices still count */ });
      });
    }
    function liveSymbols() {
      var s = {};
      Array.prototype.forEach.call(document.querySelectorAll("#smMain [data-now]"), function (el) { s[el.getAttribute("data-now")] = 1; });
      Portfolio.openTrades().forEach(function (t) { s[t.symbol] = 1; });
      return Object.keys(s).sort();
    }
    function onPrice(sym, p) {
      if (!(p > 0)) return;
      px[sym] = p; lastTick = Date.now();
      var b = barHL[sym];
      if (b && b.t === barOpen()) { b.hi = Math.max(b.hi, p); b.lo = Math.min(b.lo, p); }
      if (!paintTimer) paintTimer = setTimeout(function () { paintTimer = null; paintLive(); }, 200);
    }
    function stopFeed() {
      if (ws) { try { ws.onclose = ws.onerror = null; ws.close(); } catch (e) { /* already closed */ } ws = null; }
      clearInterval(poll); poll = null; wsKey = "";
      clearInterval(ticker); ticker = null;
    }
    function startPoll(syms) {
      if (poll) return;
      var busy = false, pull = function () {
        if (busy || document.hidden) return;
        busy = true;
        Promise.all(syms.map(function (s) {
          return futuresApi("/fapi/v1/premiumIndex?symbol=" + s).then(function (r) { feed = "rest"; onPrice(s, +r.markPrice); }, function () { /* keep the last price */ });
        })).then(function () { busy = false; });
      };
      pull(); poll = setInterval(pull, 3000);
    }
    function watch() {
      var syms = liveSymbols(), key = syms.join(",");
      if (!syms.length || document.hidden || !document.body.classList.contains("simple")) { stopFeed(); return; }
      loadBars();
      if (key === wsKey && (ws || poll)) return;
      stopFeed(); wsKey = key;
      // Countdowns and statuses move every second even when the price does not.
      ticker = setInterval(function () {
        if (document.hidden) return;
        if (ws && Date.now() - Math.max(lastTick, wsSince) > 8000) {   // connected but silent
          try { ws.onclose = ws.onerror = null; ws.close(); } catch (e) { /* already closed */ }
          ws = null; wsFail++; feed = ""; startPoll(syms);
        }
        paintLive();
      }, 1000);
      if (window.WebSocket && wsFail < 3) {
        try {
          ws = new WebSocket(FSTREAM + syms.map(function (s) { return s.toLowerCase() + "@markPrice@1s"; }).join("/"));
          wsSince = Date.now();
          ws.onmessage = function (m) { try { var d = JSON.parse(m.data).data; if (d && d.s) { feed = "ws"; onPrice(d.s, +d.p); } } catch (e) { /* not a price */ } };
          ws.onerror = ws.onclose = function () { ws = null; wsFail++; feed = ""; startPoll(syms); };
          return;
        } catch (e) { wsFail++; }
      }
      startPoll(syms);
    }
    document.addEventListener("visibilitychange", function () { if (document.hidden) stopFeed(); else if (document.body.classList.contains("simple")) watch(); });
    // One entered trade at mark price p: price move, ROI on margin as Binance shows it (before fees), baht, R after fees.
    function pnlOf(t, p) {
      var d = t.dir || 1, move = d * (p - t.entry) / t.entry, gross = d * (p - t.entry) * t.qty * t.fx, fee = (t.fee || 0) * (p + t.entry) * t.qty * t.fx;
      return { move: move * 100, roi: move * (t.lev || 1) * 100, baht: gross, fee: fee, r: t.risk > 0 ? (gross - fee) / t.risk : null, stopped: d * (p - t.stop) <= 0 };
    }
    // The trades the user entered (recorded with "เข้าแล้ว"), at the top of the screen; the numbers fill in live.
    function liveHtml() {
      var open = Portfolio.openTrades();
      if (!open.length) return "";
      return '<div class="card lv"><div class="card-hd"><b>ไม้ที่คุณบันทึกว่าเข้าแล้ว ' + open.length + ' ไม้</b><small>บันทึกเอง ไม่ได้ดึงจาก Binance</small><b class="big" id="lvTotal">…</b></div><p class="fine" id="lvFeed">กำลังต่อราคาสด…</p>' + open.map(function (t) {
        var long = (t.dir || 1) > 0;
        return '<div class="lv-card" id="lvCard' + t.id + '"><div class="card-hd">' + sidePill(long ? 1 : -1) + ' <b class="sym">' + t.symbol.replace("USDT", "") + "</b>" +
          (t.lev ? ' <span class="lev">x' + t.lev + "</span>" : "") + '<b class="lv-roi" id="lvRoi' + t.id + '">—</b></div>' +
          '<div class="lv-line" id="lvLine' + t.id + '">เข้า ' + price(t.entry) + " · รอราคาสด</div><div class=\"lv-line\" id=\"lvDist" + t.id + '"></div>' +
          '<details class="lv-act"><summary>แก้ราคาเข้าจริง · ปิดไม้</summary>' +
          '<div class="inline"><input type="number" inputmode="decimal" step="any" id="lvEntry' + t.id + '" value="' + t.entry + '"><button class="mini ghost" type="button" data-lvfix="' + t.id + '">บันทึกราคาเข้าจริง</button></div>' +
          '<div class="inline"><input type="number" inputmode="decimal" step="any" id="lvExit' + t.id + '" placeholder="ราคาที่ปิด (ว่าง = ราคาตอนนี้)"><button class="mini" type="button" data-lvclose="' + t.id + '">ปิดไม้</button></div></details></div>';
      }).join("") + '<p class="fine">ROI = กำไร/ขาดทุนเทียบ Margin แบบใน Binance (ยังไม่หักค่าธรรมเนียม) · ราคา Mark ของ Binance · R และยอดรวมหักค่าธรรมเนียมแล้ว · ถ้าขาย TP1 ไปแล้ว ตัวเลขจริงจะต่างจากนี้</p></div>';
    }
    function setText(id, text, cls) { var el = $(id); if (!el) return; el.textContent = text; if (cls !== undefined) el.className = cls; }
    function paintLive() {
      // A price that changed flashes green (up) or red (down) for a moment, so the screen visibly runs.
      Array.prototype.forEach.call(document.querySelectorAll("#smMain [data-now]"), function (el) {
        var v = px[el.getAttribute("data-now")], was = +el.getAttribute("data-v");
        if (!(v > 0)) return;
        el.textContent = price(v);
        if (was && v !== was) { el.classList.remove("tick-up", "tick-down"); void el.offsetWidth; el.classList.add(v > was ? "tick-up" : "tick-down"); }
        el.setAttribute("data-v", v);
      });
      // The rule's open positions: move and R since its entry.
      Array.prototype.forEach.call(document.querySelectorAll("#smMain [data-livepos]"), function (el) {
        var v = px[el.getAttribute("data-livepos")], e = +el.getAttribute("data-e"), d = +el.getAttribute("data-d"), k = +el.getAttribute("data-k");
        if (!(v > 0)) return;
        var mv = d * (v - e) / e * 100;
        if (el.getAttribute("data-big")) { el.textContent = fmt(mv, 2, true) + "% (" + fmt(d * (v - e) / k, 2, true) + "R)"; el.className = "big " + tone(Math.round(mv * 100) / 100); }
        else { el.textContent = " · " + fmt(mv, 2, true) + "% · " + fmt(d * (v - e) / k, 2, true) + "R"; el.className = mv >= 0 ? "up" : "down"; }
      });
      placeCards();
      // Distance from the live price to each watched level; closest first.
      var wl = $("smWatch");
      if (wl) {
        var rows = Array.prototype.slice.call(wl.querySelectorAll("[data-watch]"));
        rows.forEach(function (el) {
          var v = px[el.getAttribute("data-watch")], lvl = +el.getAttribute("data-lvl"), d = +el.getAttribute("data-dir");
          if (!(v > 0)) return;
          var gap = d * (lvl - v) / v * 100, x = el.querySelector("[data-wd]");
          el.setAttribute("data-gap", gap);
          x.textContent = gap <= 0 ? "เลยเส้นแล้ว · รอปิดแท่ง" : "อีก " + fmt(gap, 2) + "%";
          x.className = "watch-d " + (gap <= 0 ? "up" : gap < 1 ? "neu" : "");
        });
        var gapOf = function (el) { var g = parseFloat(el.getAttribute("data-gap")); return isNaN(g) ? 99 : g; };
        rows.sort(function (a, b) { return gapOf(a) - gapOf(b); }).forEach(function (el) { wl.insertBefore(el, wl.querySelector(".fine")); });
      }
      var cap = money(), tot = 0, n = 0, open = Portfolio.openTrades();
      open.forEach(function (t) {
        var p = px[t.symbol];
        if (!(p > 0) || !$("lvCard" + t.id)) return;
        var x = pnlOf(t, p), c = x.baht >= 0 ? "up" : "down", d = t.dir || 1;
        tot += x.baht - x.fee; n++;
        $("lvCard" + t.id).className = "lv-card " + c;
        setText("lvRoi" + t.id, fmt(x.roi, 2, true) + "%", "lv-roi " + c);
        setText("lvLine" + t.id, "ราคา " + price(t.entry) + " → " + price(p) + " (" + fmt(x.move, 2, true) + "%) · " + fmt(x.baht, 0, true) + " ฿" +
          (x.r !== null ? " · " + fmt(x.r, 2, true) + "R" : "") + " · " + fmt((x.baht - x.fee) / cap * 100, 2, true) + "% ของทุน");
        setText("lvDist" + t.id, x.stopped ? "ราคาเลย SL " + price(t.stop) + " แล้ว: ใน Binance น่าจะโดน SL ไปแล้ว กดปิดไม้เพื่อบันทึก"
          : "SL " + price(t.stop) + " (ห่าง " + fmt((t.stop / p - 1) * 100, 2, true) + "%)" +
            (t.tp1 || (t.tps && t.tps[0]) ? " · TP1 " + price(t.tp1 || t.tps[0]) + " (อีก " + fmt(((t.tp1 || t.tps[0]) / p - 1) * 100 * d, 2, true) + "%)" : ""), "lv-line" + (x.stopped ? " down" : ""));
      });
      if (n) setText("lvTotal", "รวม " + fmt(tot, 0, true) + " ฿ (" + fmt(tot / cap * 100, 2, true) + "% ของทุน)", "big " + (tot >= 0 ? "up" : "down"));
      // Whether the numbers are live: the feed, and the time of the last price received.
      var age = lastTick ? Date.now() - lastTick : null, at = lastTick ? new Date(lastTick + 7 * 3600000).toISOString().slice(11, 19) : "";
      var fs = age === null ? "กำลังต่อราคาสด…" : age > 15000 ? "ราคาสดขาด · ล่าสุด " + at + " น." : (feed === "ws" ? "ราคาสดทุก 1 วินาที" : "ราคาทุก 3 วินาที") + " · " + at + " น.";
      setText("feedSt", fs, age !== null && age > 15000 ? "down" : age !== null ? "live" : "");
      // The same, pinned to a corner so it shows wherever the screen is scrolled.
      var badge = $("liveBadge"), on = document.body.classList.contains("simple") && liveSymbols().length > 0;
      if (badge) {
        badge.classList.toggle("hidden", !on);
        badge.className = "live-badge" + (on ? "" : " hidden") + (age === null ? " wait" : age > 15000 ? " off" : age > 5000 ? " slow" : " on");
        badge.textContent = age === null ? "● กำลังต่อราคาสด…" : age > 15000 ? "● ราคาสดขาด · " + at : "● " + (feed === "ws" ? "สด" : "ทุก 3 วิ") + " " + at;
      }
      if (open.length) setText("lvFeed", fs + " (Binance Mark)", "fine " + (age !== null && age <= 15000 ? "live" : age !== null ? "down" : ""));
    }
    // Where a live card belongs now. follow: a new signal within its 15 minutes, or joining late is within the test (price
    // within 0.5R of the entry, no take profit yet); hold: the system is in but it is too late to follow; ended: the price
    // touched the system's stop in this 4-hour bar (the 4-hour close decides the channel exit, the alert says so).
    function cardState(c, p, now) {
      var b = barHL[c.sym], hi = Math.max(p, b && b.t === barOpen() ? b.hi : p), lo = Math.min(p, b && b.t === barOpen() ? b.lo : p), d = c.dir;
      var off = d * (p - c.e) / c.k, tp = c.tpDone || (c.tp && (d > 0 ? hi >= c.tp : lo <= c.tp));
      if (c.ended || (d > 0 ? lo <= c.sl : hi >= c.sl)) return { g: "ended", why: "sl", off: off, x: d > 0 ? lo : hi };
      if (c.kind === "entry" && now < c.until) return !tp && Math.abs(off) <= 0.5 ? { g: "follow", why: "window", off: off } : { g: "hold", why: tp ? "tp" : "far", off: off };
      if (tp) return { g: "hold", why: "tp", off: off };
      if (!c.joinOk) return { g: "hold", why: Math.abs(off) > 0.5 ? "far" : c.kind === "entry" ? "expired" : "nojoin", off: off };
      return Math.abs(off) <= 0.5 ? { g: "follow", why: "late", off: off } : { g: "hold", why: "far", off: off };
    }
    function placeCards() {
      var grp = { follow: $("grpFollow"), hold: $("grpHold"), ended: $("grpEnded") };
      if (!grp.follow) return;
      var now = Date.now(), cnt = { follow: 0, hold: 0, ended: 0 }, moved = false, ids = Object.keys(LC).sort(function (a, b) { return LC[a].ord - LC[b].ord; });
      ids.forEach(function (id) {
        var c = LC[id], el = $(id);
        if (!el) return;
        var p = px[c.sym] > 0 ? px[c.sym] : c.p0, st = cardState(c, p, now), pc = function (v) { return fmt((v / p - 1) * 100 * c.dir, 2, true) + "%"; };
        // Capital: the order at the live price must keep the set risk; Binance's smallest order above it is NO TRADE.
        var zz = c.order ? liveSize(c.order, p) : null;
        if (zz && zz.blocked && st.g === "follow") st = { g: "hold", why: "nocap", off: st.off };
        if (systemPaused() && st.g === "follow") st = { g: "hold", why: "paused", off: st.off };
        if (st.g === "ended") {
          c.ended = true;
          var big = el.querySelector("[data-livepos]");
          if (big) { big.removeAttribute("data-livepos"); big.textContent = "แตะ SL ≈ −1.00R"; big.className = "big down"; }
        }
        cnt[st.g]++;
        if (c.at !== st.g) { c.at = st.g; moved = true; }
        el.classList.remove("st-follow", "st-hold", "st-ended"); el.classList.add("st-" + st.g);
        var q = function (sel) { return el.querySelector(sel); }, set = function (sel, text, cls) { var x = q(sel); if (x) { x.textContent = text; if (cls !== undefined) x.className = cls; } };
        var chip = { follow: st.why === "window" ? "ตามได้" : "ตามได้ (เข้าช้า)", hold: st.why === "paused" ? "NO TRADE · ระบบหยุดเข้าไม้" : st.why === "nocap" ? "NO TRADE · ทุนไม่พอ" : st.why === "tp" ? "ถืออยู่ · ขาย TP1 แล้ว" : "ถืออยู่ · ตามไม่ทัน", ended: "จบแล้ว · แตะ SL" }[st.g];
        set("[data-st]", chip, "chip " + { follow: "good", hold: "warn", ended: "bad" }[st.g]);
        set("[data-off]", "(" + fmt(c.dir * (p / c.e - 1) * 100, 2, true) + "% · " + fmt(st.off, 2, true) + "R จากจุดเข้า)", tone(Math.round(st.off * 100) / 100));
        var left = c.until - now, mm = function (ms) { var t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ":" + ("0" + t % 60).slice(-2); };
        set("[data-why]", {
          window: "เหลือเวลาเข้า " + mm(left) + " นาที (ถึง " + thai(c.until).slice(9, 14) + " น.) · ตามได้ถ้าราคาห่างจุดเข้าไม่เกิน 0.5R",
          late: c.kind === "entry" ? "เลยเวลาเข้ามา " + Math.max(1, Math.round(-left / 60000)) + " นาที แต่ราคายังห่างจุดเข้าไม่เกิน 0.5R · ผลทดสอบเข้าช้า 1 แท่ง: " + (c.late ? c.late.n + " ไม้ เฉลี่ย " + fmt(c.late.avgR, 2, true) + "R" : "")
            : "ระบบเข้าเมื่อ " + thai(c.since).slice(0, 5) + " " + thai(c.since).slice(9, 14) + " น. · ราคายังห่างจุดเข้าไม่เกิน 0.5R",
          far: "ราคาห่างจุดเข้า " + fmt(st.off, 2, true) + "R (เกิน 0.5R) · อย่าไล่ราคา · ถ้าเข้าไปแล้ว ถือต่อ ห้ามเลื่อน SL",
          tp: "ราคาถึง TP1 แล้ว: ระบบขายส่วนแรก ส่วนที่เหลือถือต่อ · ไม่ต้องเข้าตาม",
          expired: "หมดเวลาเข้าแล้ว · ถ้าเข้าไปแล้ว ถือต่อ ห้ามเลื่อน SL",
          nojoin: "ถ้าเข้าไปแล้ว ถือต่อ ห้ามเลื่อน SL",
          paused: "NO TRADE: ระบบหยุดเข้าไม้ใหม่ ผล 30 วันล่าสุดแย่กว่าที่ผลทดสอบเคยเจอ · ถ้าเข้าไปแล้ว ถือต่อตามแผน SL เดิม",
          nocap: "ทุนไม่พอ ไม่สามารถเข้าไม้ตามความเสี่ยงที่กำหนด: ไม้เล็กสุดของ Binance เสี่ยง " + (zz ? fmt(zz.lossB / money() * 100, 2) : "?") + "% ของทุน (ตั้งไว้ " + trendRiskPct() + "%) · ไม่เพิ่มความเสี่ยงให้อัตโนมัติ",
          sl: "ราคาแตะ SL " + price(c.sl) + " ในแท่ง 4 ชม. นี้ (ไปถึง " + price(st.x) + ") · ระบบออกที่ราว −1R · ถ้ายังถือ เช็กใน Binance ว่าโดน SL แล้ว"
        }[st.why], "fine live-why" + (st.g === "ended" ? " down" : ""));
        // How completely the rule's conditions for entering now are met: a checklist, not a win chance.
        var plan = Portfolio.plan(), inTime = c.kind === "entry" ? now < c.until || c.joinOk : c.lateOk;
        var items = [
          ["แท่ง 4 ชม. ปิดทะลุกรอบ 20 แท่ง (สัญญาณของสูตร)", true],
          ["อยู่ฝั่งเดียวกับ EMA200", true],
          ["Leverage ≥ 5x และ Liquidation ไกลกว่า SL", true],
          [c.kind === "entry" ? "ยังอยู่ในเวลาเข้า 15 นาที (หรือผลทดสอบเข้าช้ายังกำไร)" : "ผลทดสอบเข้าช้าเท่านี้ยังกำไร", !!inTime],
          ["ราคาห่างจุดเข้าไม่เกิน 0.5R", Math.abs(st.off) <= 0.5],
          ["ราคายังไม่แตะ SL", st.g !== "ended"],
          ["ยังไม่ถึง TP1", !(st.why === "tp")],
          ["ทุนพอ: ไม้เล็กสุดของ Binance ไม่เสี่ยงเกินที่ตั้ง และ Margin ไม่เกินทุน", !c.noCap && !(zz && zz.blocked)],
          ["พอร์ตไม่ได้หยุดเข้าไม้ใหม่ (ไม่ลงลึกเกินผลทดสอบ)", plan.state === "ok" || plan.state === "half"],
          ["ผลจริง 30 วันของระบบไม่แย่กว่าที่ผลทดสอบเคยเจอ", !systemPaused()]
        ], met = items.filter(function (x) { return x[1]; }).length;
        set("[data-fit]", "ครบองค์ประกอบสูตร " + met + "/" + items.length + " (" + Math.round(100 * met / items.length) + "%)", met === items.length ? "fit-all" : "fit-part");
        var fl = q("[data-fitlist]");
        if (fl) fl.innerHTML = items.map(function (x) { return '<li class="' + (x[1] ? "ok" : "no") + '">' + ic(x[1] ? "check" : "x") + esc(x[0]) + "</li>"; }).join("") +
          '<li class="note">นี่คือความครบของเงื่อนไขสูตร ไม่ใช่โอกาสชนะ · ไม้ที่ครบ 100% ในอดีตชนะราว 1 ใน 3 กำไรมาจากไม้ใหญ่</li>';
        var od = st.g === "ended" ? null : oddsAt(st.off, st.why === "tp" || c.tpDone);
        var ci = od ? wilsonPct(Math.round(od.win * od.n / 100), od.n) : null;
        set("[data-odds]", od ? "ไม้ของระบบที่อยู่ " + fmt(st.off, 2, true) + "R แบบนี้ จบกำไร " + fmt(od.win, 0) + "% (ช่วง 95% " + fmt(ci[0], 0) + "–" + fmt(ci[1], 0) +
          "%) · เฉลี่ยจบ " + fmt(od.avgR, 2, true) + "R · " + od.n + " ครั้ง 12 เหรียญ 2020–2026 · นับ R จากจุดเข้าของระบบ ไม่ใช่ของคนที่เข้าตอนนี้" : "", "odds " + (od ? od.win >= 55 ? "up" : od.win <= 45 ? "down" : "neu" : ""));
        set("[data-dsl]", "จากราคาตอนนี้ " + pc(c.sl) + " · จากจุดเข้า " + fmt(-c.k / c.e * 100, 2) + "%");
        if (c.tp) set("[data-dtp]", "อีก " + pc(c.tp));
        if (st.g !== "ended" && c.order && zz && zz.blocked) {
          ["[data-q]", "[data-m]", "[data-rk]"].forEach(function (sel) { set(sel, "—"); }); set("[data-rb]", "NO TRADE"); set("[data-rb2]", "NO TRADE");
        } else if (st.g !== "ended" && c.order) {
          var z = zz, cap = money();
          set("[data-q]", qtyTxt(z.qty)); set("[data-m]", fmt(z.marginB, 0)); set("[data-rk]", fmt(z.lossB / cap * 100, 2) + "%"); set("[data-rb]", "≈ " + fmt(z.lossB, 0) + " บาท");
          set("[data-rb2]", "−" + fmt(z.lossB, 0) + " ฿");
        }
        set("[data-jhead]", zz && zz.blocked ? "NO TRADE · ทุนไม่พอ" : st.g === "follow" ? "ครบองค์ประกอบ · เข้าตามได้" : "ถ้าจะเข้าเอง (ครบ " + met + "/" + items.length + " · ดูข้อที่ขาดด้านบน)");
        if (c.met !== met) { c.met = met; moved = true; }
        if (st.g === "hold" && st.why !== "nojoin" && !c.noCap) set("[data-jno]", st.why === "tp" ? "ไม่ต้องตาม: ระบบขาย TP ไปแล้ว รอไม้ใหม่" : st.why === "expired" ? "ไม่ต้องตาม: หมดเวลาเข้าแล้ว รอไม้ใหม่" : "ไม่ต้องตาม: ราคาห่างจุดเข้าเกิน 0.5R แล้ว รอไม้ใหม่");
      });
      if (moved) {
        // Within a group, the most complete first.
        ids.slice().sort(function (a, b) { return (LC[b].met || 0) - (LC[a].met || 0) || LC[a].ord - LC[b].ord; })
          .forEach(function (id) { var el = $(id); if (el && grp[LC[id].at]) grp[LC[id].at].appendChild(el); });
        // The system's note follows: a position that touched its stop is no longer "held", a signal that did is no entry.
        var gone = ids.filter(function (id) { return LC[id].ended; }).map(function (id) { return LC[id]; }), out = function (sym) { return gone.some(function (c) { return c.sym === sym; }); };
        if (gone.length && $("smNote")) $("smNote").innerHTML = traderNote(noteOf.list.filter(function (x) { return !out(x.symbol); }), noteOf.held.filter(function (it) { return !out(it.symbol); }), gone);
      }
      var show = function (id, on) { var x = $(id); if (x) x.classList.toggle("hidden", !on); };
      show("emptyFollow", !cnt.follow); show("secHold", cnt.hold > 0); show("secEnded", cnt.ended + LCended > 0);
      setText("cntFollow", cnt.follow ? String(cnt.follow) : ""); setText("cntHold", String(cnt.hold)); setText("cntEnded", cnt.ended + LCended ? String(cnt.ended + LCended) : "");
    }
    function bindLive() {
      Array.prototype.forEach.call(document.querySelectorAll("[data-lvfix]"), function (b) {
        b.onclick = function () { var id = +b.getAttribute("data-lvfix"); Portfolio.setEntry(id, parseFloat($("lvEntry" + id).value)); draw(); };
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-lvclose]"), function (b) {
        b.onclick = function () {
          var id = +b.getAttribute("data-lvclose"), t = Portfolio.openTrades().filter(function (x) { return x.id === id; })[0], v = parseFloat($("lvExit" + id).value);
          if (!t) return;
          Portfolio.close(id, v > 0 ? v : px[t.symbol]);
          draw();
        };
      });
    }
    function show(simple) {
      document.body.classList.toggle("simple", simple);
      $("simpleView").classList.toggle("hidden", !simple);
      $("fullView").classList.toggle("hidden", simple);
      $("menuBtn").textContent = simple ? "☰ เมนู" : "← กลับ";
      if (!simple) Guide.render();
      if (simple) { $("smCap").value = money(); draw(); }
      window.scrollTo(0, 0);
    }
    function busy() { busyNow = true; if (!signals().length) { results = []; draw(); } }
    function render(res, error, rate, info) {
      lastScan = Date.now(); busyNow = false; lastError = error || ""; meta = info || meta;
      if (error) {
        $("smMain").innerHTML = '<div class="sm-wait"><b>เช็กไม่สำเร็จ</b><small>' + esc(error).slice(0, 160) + " · ตรวจเน็ตแล้วกด เช็กอีกครั้ง</small></div>";
        return;
      }
      results = res; fx = rate || fx;
      draw();
    }
    function schedule() {
      clearTimeout(timer);
      var ms = TF[curTf()].ms, wait = ms - (Date.now() % ms) + (ms > 900000 ? 45000 : 15000);
      timer = setTimeout(function () { if (!document.hidden) scan(); schedule(); }, wait);
    }
    if (location.hash !== "#bg") {
      $("menuBtn").onclick = function () { show(!document.body.classList.contains("simple")); };
      $("smScan").onclick = function () { scan(); };
      $("smCap").addEventListener("change", function () {
        $("pfCapital").value = $("smCap").value;
        $("pfCapital").dispatchEvent(new Event("change"));
        draw();
      });
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden && document.body.classList.contains("simple") && Date.now() - lastScan > 5 * 60000) scan();
      });
      schedule();
    }
    return { show: show, render: render, busy: busy, redrawNews: redrawNews };
  })();

  function futuresScan() {
    var results = [], errors = [], done = 0, fxInfo, end, rules, lev = Math.max(5, Math.min(50, readNumber("alertLev", 10)));
    var coins = selectedCoins();  // user-selected coins; only BTC/ETH have research behind the rule
    var tf = curTf(), tfMs = TF[tf].ms;
    scanStatus("กำลังดึงแท่ง " + TF[tf].name + " (Binance USDⓈ-M Futures)…");
    if (!coins.length) return Promise.reject(new Error("เลือกเหรียญอย่างน้อย 1 เหรียญก่อนสแกน"));
    return Promise.all([futuresApi("/fapi/v1/time"), fetchFx().catch(function () { return { rate: 33, fallback: true }; }), futuresRules()]).then(function (res) {
      fxInfo = res[1]; rules = res[2];
      end = Math.floor(res[0].serverTime / tfMs) * tfMs;
      var start = end - TF[tf].days * 86400000, queue = coins.slice();
      function worker() {
        var s = queue.shift();
        if (!s) return Promise.resolve();
        return fetchCandles(s, start, end, function () {}, tf, true).then(function (bars) {
          var last = bars[bars.length - 1], rule = rules[s];
          // Only a fully closed candle that ends exactly at the latest boundary may produce a signal.
          if (!last || last.close_time + 1 !== end) throw new Error("แท่งล่าสุดไม่สด (ไม่ใช่แท่งที่เพิ่งปิด)");
          if (!rule || rule.status !== "TRADING") throw new Error("ไม่มีสัญญา Perpetual ที่เปิดเทรด");
          results.push(isTrend(tf) ? trendCard(s, bars, fxInfo.rate, lev, rule) : futuresCard(s, bars, fxInfo.rate, lev, tf, rule));
        }).catch(function (e) { errors.push(s.replace("USDT", "") + ": " + e.message); }).then(function () {
          done++; scanStatus("สแกนแล้ว " + done + "/" + coins.length + " เหรียญ…");
          return worker();
        });
      }
      return Promise.all([worker(), worker(), worker()]);
    }).then(function () {
      if (!results.length) throw new Error("สแกนไม่สำเร็จทุกเหรียญ: " + errors.join(" · "));
      // Mark price for every candidate: refuse the signal when it is missing or far from the candle close.
      return Promise.all(results.filter(function (r) { return r.signal; }).map(function (r) {
        return futuresApi("/fapi/v1/premiumIndex?symbol=" + r.symbol).then(function (m) {
          var g = r.signal, mark = +m.markPrice;
          g.mark = mark;
          if (!(mark > 0)) rejectSignal(g, "ไม่มี mark price");
          else if (Math.abs(mark - g.entry) / g.entry > 0.005) rejectSignal(g, "ราคา mark ห่างจากราคาปิดเกิน 0.5% (ตลาดวิ่งไปแล้ว)");
        }).catch(function () { rejectSignal(r.signal, "ดึง mark price ไม่ได้"); });
      }));
    }).then(function () {
      renderFutures(results, fxInfo, lev, end);
      lastFutures = results;
      Simple.render(results, null, fxInfo.rate, { end: end, failed: errors.length });
      // News for the alert lines (the calendar is cached for an hour); a failure or a slow source never holds the alerts
      // back more than 15 seconds.
      return Promise.race([News.refresh().catch(function () { return null; }), new Promise(function (res) { setTimeout(res, 15000); })]);
    }).then(function () {
      Simple.render(results, null, fxInfo.rate, { end: end, failed: errors.length });
      reportScan(results, end, null, { scanned: results.length, failed: errors });
      scanStatus("สแกนล่าสุด " + thai(Date.now()) + " น. · แท่ง " + TF[tf].name + " ที่ปิดเมื่อ " + thai(end) + " น. · Binance USDⓈ-M Futures" +
        (fxInfo.fallback ? " · ใช้อัตรา 33 ฿/USDT (ดึงอัตราจริงไม่ได้)" : "") +
        (errors.length ? "\nข้ามบางเหรียญ: " + errors.join(" · ") : ""), false);
    });
  }

  function rejectSignal(g, reason) {
    if (!g || g.below_minimum) return;
    g.below_minimum = true;
    g.reject = reason;
  }

  // Research evidence for the live rule (research/evidence, real USD-M bars). null-safe: no row -> no claim.
  function evidenceFor(symbol, tf) {
    if (isTrend(tf)) return trendEvidenceFor(symbol);
    var E = window.EVIDENCE, row = E && E.rows && E.rows[symbol + "|" + tf], o = row && row.oos;
    var head = "ข้อมูลยืนยัน " + (E ? E.periods.oos : "") + ": ";
    if (!o || !(o.n >= 30)) return { ok: false, n: o ? o.n : 0, text: "ยังไม่มีข้อมูลยืนยัน" + (o ? " (ช่วงทดสอบมีแค่ " + o.n + " ไม้)" : "") };
    return { ok: true, n: o.n, win: o.win, tp5: o.tp5, avgR: o.avgR, pf: o.pf,
      text: head + o.n + " ไม้ · ปิดกำไร " + o.win + "% (95% CI " + o.winCI[0] + "–" + o.winCI[1] + "%) · ถึง TP 5R " + o.tp5 + "% (CI " + o.tp5CI[0] + "–" + o.tp5CI[1] +
        "%) · เฉลี่ย " + (o.avgR >= 0 ? "+" : "") + o.avgR + "R/ไม้" + (o.avgR <= 0 ? " (ขาดทุน)" : "") + " · ไม่ใช่โอกาสชนะของไม้นี้" };
  }

  // Trend 4H evidence (research/pro, walk-forward years, with the app's leverage filter); n < 30 -> no claim.
  function trendPeriod() {
    var y = (window.EVIDENCE_TREND && window.EVIDENCE_TREND.years_chosen) || [];
    return y.length ? y[0] + (y.length > 1 ? "–" + y[y.length - 1] : "") + (y[y.length - 1] === 2026 ? " (ถึง ก.ย.)" : "") : "";
  }
  function trendEvidenceFor(symbol) {
    var o = trendStats(), R = o && o.reach;
    if (!o || !(o.n >= 30)) return { ok: false, n: o ? o.n : 0, text: "ยังไม่มีข้อมูลยืนยัน" + (o ? " (ช่วงทดสอบมีแค่ " + o.n + " ไม้)" : "") };
    return { ok: true, n: o.n, win: o.win, avgR: o.avgR, pf: o.pf,
      text: "สถิติไม้แบบนี้ (walk-forward " + trendPeriod() + "): " + o.n + " ไม้ · ปิดกำไร " + o.win + "% (CI " + o.winCI[0] + "–" + o.winCI[1] + "%) · " +
        (R ? "ถึง +1R " + R[1] + "% · ถึง +2R " + R[2] + "% · SL ก่อน +1R " + R.slFirst + "% · " : "ได้ ≥3R " + o.big3 + "% · ") +
        "เฉลี่ย " + (o.avgR >= 0 ? "+" : "") + o.avgR + "R/ไม้" + (o.avgR <= 0 ? " (ขาดทุน)" : "") };
  }

  function newsFilterLabel() {
    return isTrend(curTf()) ? "ข่าว: CPI/NFP/FOMC และข่าวเหรียญจากแหล่งฟรีแสดงประกอบ ไม่ได้ใช้กรองสัญญาณ (สูตรไม่ได้ทดสอบกับข่าว)"
      : "ตัวกรองข่าว: งดเฉพาะวัน FOMC จากรายการที่ใส่เอง (ปี 2026 ยังไม่ยืนยัน) · CPI/NFP แสดงในปฏิทินข่าว แต่ไม่ได้ใช้กรอง";
  }

  // Order size from the stop distance: risk % of the balance; leverage is a cap chosen by the user (5/10/20/50x), never
  // a target, lowered until a conservative liquidation estimate stays 1.5x the stop distance away; margin at most
  // LOCK.marginShare of the balance. The reference entry is the close on the exchange's price grid and the stop is
  // rounded away from it, so the planned risk is never smaller than the rule says.
  function sizeOrder(close, dir, dist, fx, lev, rule, riskPct) {
    var plan = Portfolio.plan(), tick = rule.tick, cost = 2 * (FUT.fee + FUT.slippage);
    var entry = toGrid(close, tick), stop = toGrid(entry - dir * dist, tick, dir > 0 ? "floor" : "ceil");
    dist = Math.abs(entry - stop);
    var balance = plan.balance / fx, riskUsdt = balance * riskPct / 100, riskTarget = riskUsdt, stopFrac = dist / entry;
    var qty = riskUsdt / (dist + cost * entry), notional;
    var levLiq = Math.max(1, Math.floor(1 / (1.5 * stopFrac + FUT.mmrSafe))), rec = Math.min(levLiq, lev), sizeLimited = false;
    if (qty * entry / rec > LOCK.marginShare * balance) {
      sizeLimited = true;
      qty = LOCK.marginShare * balance * rec / entry;
    }
    qty = toGrid(qty, rule.step, "floor");
    notional = qty * entry; riskUsdt = qty * (dist + cost * entry);
    // No bracket table without an API key, so liquidation uses a pessimistic maintenance margin and is only an estimate.
    var liq = dir > 0 ? entry * (1 - 1 / rec + FUT.mmrSafe) : entry * (1 + 1 / rec - FUT.mmrSafe);
    return { dir: dir, entry: entry, stop: stop, dist: dist, qty: qty, notional: notional, margin: notional / rec, liq: liq, riskUsdt: riskUsdt,
      lev: rec, levCapUser: lev, levLiq: levLiq, sliderPct: notional / rec * (1 + FUT.fee * rec) / balance * 100, balanceUsdt: balance, fx: fx,
      dp: decimalsOf(tick), sizeLimited: sizeLimited, stopPct: stopFrac * 100, riskTarget: riskTarget, riskPctTarget: riskPct };
  }
  function checkOrder(g, rule) {
    if (g.lev < 5) rejectSignal(g, "SL กว้างเกินไปสำหรับ Leverage ขั้นต่ำ 5x");
    else if (g.dir > 0 ? g.liq >= g.stop : g.liq <= g.stop) rejectSignal(g, "Liquidation (ประมาณ) อาจมาก่อน SL");
    else if (!(g.qty > 0) || g.qty < (rule.minQty || 0)) { g.tooSmall = true; rejectSignal(g, "ขนาดไม้ต่ำกว่า minQty ของ Binance (" + (rule.minQty || "?") + ")"); }
    else if (g.notional < (rule.minNotional || 0)) { g.tooSmall = true; rejectSignal(g, "มูลค่าไม้ " + fmt(g.notional, 1) + " USDT ต่ำกว่าขั้นต่ำ Binance " + rule.minNotional + " USDT"); }
  }
  // When the rule's size is under Binance's smallest order: the smallest order is kept only if it risks no more than the
  // set risk (10% over for rounding) and its margin fits the balance; otherwise the signal is NO TRADE ("ทุนไม่พอ"). The
  // risk is never raised to make a trade possible.
  function capitalCheck(g, rule) {
    var cost = 2 * (FUT.fee + FUT.slippage), qty = toGrid(Math.max(rule.minQty || 0, (rule.minNotional || 0) / g.entry), rule.step, "ceil");
    var risk = qty * (g.dist + cost * g.entry), margin = qty * g.entry / g.lev, pct = risk / g.balanceUsdt * 100;
    if (risk > g.riskTarget * 1.1 || margin > g.balanceUsdt) {
      g.tooSmall = true; g.noCapital = true; g.minRiskPct = pct; g.reject = ""; g.below_minimum = false;
      rejectSignal(g, "ทุนไม่พอ ไม่สามารถเข้าไม้ตามความเสี่ยงที่กำหนด (ไม้เล็กสุดของ Binance เสี่ยง " + fmt(pct, 2) + "% ของทุน · ตั้งไว้ " +
        fmt(g.riskPctTarget, 2) + "%" + (margin > g.balanceUsdt ? " · Margin " + fmt(margin, 2) + " USDT เกินทุน" : "") + ")");
      return;
    }
    minimumSize(g, rule);
  }
  function minimumSize(g, rule) {
    var cost = 2 * (FUT.fee + FUT.slippage), qty = toGrid(Math.max(rule.minQty || 0, (rule.minNotional || 0) / g.entry), rule.step, "ceil");
    g.qty = qty; g.notional = qty * g.entry; g.margin = g.notional / g.lev; g.riskUsdt = qty * (g.dist + cost * g.entry);
    g.sliderPct = g.margin * (1 + FUT.fee * g.lev) / g.balanceUsdt * 100;
    g.minSize = true; g.tooSmall = false; g.below_minimum = false; g.reject = "";
  }

  function futuresCard(symbol, bars, fx, lev, tf, rule) {
    var tfMs = TF[tf || "1h"].ms;
    var opt = Object.assign({}, Swing.DEFAULTS, { fee: FUT.fee, slippage: FUT.slippage, fomcDates: locked() ? fomcDates() : [] }), n = bars.length;
    var ind = Swing.indicators(bars, opt), last = bars[n - 1];
    var tech = locked() ? LOCK.tech : $("sgStrat").value, spec = Swing.TECHNIQUES.filter(function (t) { return t.id === tech; })[0];
    var hist = Swing.stats(Swing.runTechnique(tech, bars, ind, 270, n, opt), 0.01);
    var e = ind.e50[n - 1], e2 = ind.e200[n - 1];
    var out = { symbol: symbol, close: last.close, trend: e > e2 && last.close > e2 ? 1 : e < e2 && last.close < e2 ? -1 : 0, hist: hist, signal: null };
    var sig = Swing.signal(tech, bars, ind, n - 1, opt);
    if (!sig || !(sig.dist / last.close >= 0.0015)) return out;
    rule = rule || {};
    var plan = Portfolio.plan(), dir = sig.dir;
    var riskPct = locked() ? Math.min(LOCK.riskPct, plan.riskPct || LOCK.riskPct) : plan.riskPct;
    var g = sizeOrder(last.close, dir, sig.dist, fx, lev, rule, riskPct), dist = g.dist;
    var volRatio = ind.v20[n - 1] > 0 ? last.volume / ind.v20[n - 1] : NaN;
    Object.assign(g, { tps: [1, 2, 5].map(function (r) { return toGrid(g.entry + dir * r * dist, rule.tick); }),
      expires: last.close_time + 1 + Math.min(FUT.enterWithinMin * 60000, tfMs),
      candle: last.close_time + 1, trend: out.trend, hist: hist, stratName: spec.name, hold: spec.hold * tfMs / 3600000, tf: tf || "1h", stopAtr: spec.stopAtr || 2.5,
      why: "แท่ง " + TF[tf].name + " ปิดแล้ว: โมเมนตัม 2 แท่ง" + (dir > 0 ? "ขึ้น" : "ลง") + " หลังบีบตัว (squeeze) ใน 3 แท่ง · Volume " + fmt(volRatio, 1) +
        "x ค่าเฉลี่ย 20 แท่ง (เกณฑ์ ≥1.8x) · SL " + (spec.stopAtr || 1.8) + " ATR" });
    out.signal = g;
    checkOrder(g, rule);
    return out;
  }

  // Trend 4H on the last closed 4h bar (web/trend.js replays the coin's 1,500 bars, so the app knows which positions the
  // rule holds). signal = ENTRY at the next open; exit = the rule closes its open position at the next open;
  // position = what the rule holds now, with its stop and the close that would end it.
  function trendCard(symbol, bars, fx, lev, rule) {
    rule = rule || {};
    var lad = trendLadder(), res = Trend.run(bars, { live: true, tps: lad ? lad.tps : null }), n = bars.length, last = bars[n - 1], L = res.last, tfMs = TF[TREND.tf].ms;
    if (!res.ready) throw new Error("แท่ง 4 ชม. ไม่พอ (" + n + " แท่ง)");
    var plan = Portfolio.plan(), riskPct = Math.min(TREND.maxRiskPct, plan.riskPct || LOCK.riskPct), week = last.close_time + 1 - 30 * 86400000;
    var out = { symbol: symbol, close: last.close, trend: last.close > L.ema ? 1 : last.close < L.ema ? -1 : 0, signal: null, exit: null, position: null,
      // The levels the 4-hour bar now forming must close beyond for an entry (channel of the 20 bars before it).
      watch: { upper: L.next.upper, lower: L.next.lower, ema: L.ema, closeAt: last.close_time + 1 + tfMs },
      bars: bars.slice(-90),
      // The rule's entries in the last 30 days, closed or still open: the system's own record on the main screen.
      recent: res.trades.filter(function (t) { return t.entry_time >= week; }).map(function (t) {
        return { dir: t.dir, entry: t.entry, entry_time: t.entry_time, exit_time: t.exit_time, r: t.r, open: false, reason: t.reason, cost: t.cost };
      }).concat(res.pos && res.pos.entry_time >= week ? [{ dir: res.pos.dir, entry: res.pos.entry, entry_time: res.pos.entry_time, open: true,
        r: res.pos.dir * (last.close - res.pos.entry) / res.pos.risk }] : []) };
    var candle = last.close_time + 1, dp = decimalsOf(rule.tick);
    if (res.pos) {
      var p = res.pos;
      out.position = { dir: p.dir, entry: p.entry, stop: p.stop, risk: p.risk, entry_time: p.entry_time, dp: dp, left: p.left, fills: p.fills,
        exitLevel: p.dir > 0 ? L.next.exitLong : L.next.exitShort, r: p.dir * (last.close - p.entry) / p.risk,
        tpLevels: (lad ? lad.tps : []).map(function (t, k) { return { price: p.entry + p.dir * t.r * p.risk, label: "TP" + (k + 1), done: k < p.fills.length }; }) };
      if (res.pend && res.pend.exit) {
        out.exit = Object.assign({}, out.position, { candle: candle, expires: candle + tfMs, close: last.close,
          level: p.dir > 0 ? L.tested.exitLong : L.tested.exitShort });
      } else if (p.dir * (last.close - p.stop) > 0) {
        // An order to join at the last close with the rule's SL and take profits, sized like a signal; whether joining
        // now is within the late-entry test (within 0.5R, no take profit yet) is shown per condition on the card.
        // Joining late at the last close with the rule's SL and take profits (research/pro "late entry"), sized like a signal.
        var lg = sizeOrder(last.close, p.dir, Math.abs(last.close - p.stop), fx, lev, rule, riskPct);
        checkOrder(lg, rule);
        if (lg.tooSmall) capitalCheck(lg, rule);
        Object.assign(lg, { step: rule.step, minQty: rule.minQty, minNotional: rule.minNotional });
        out.position.late = lg;
      }
      out.position.barsSince = Math.round((candle - p.entry_time) / tfMs);
    }
    if (res.pend && res.pend.dir) {
      var dir = res.pend.dir, g = sizeOrder(last.close, dir, L.stopDist, fx, lev, rule, riskPct);
      var ladder = lad ? lad.tps.map(function (t) { return { r: t.r, frac: t.frac, price: toGrid(g.entry + dir * t.r * g.dist, rule.tick) }; }) : null;
      Object.assign(g, { kind: "entry", tps: [], ladder: ladder, tpPlan: ladder ? ladderText(ladder) : "", step: rule.step, minQty: rule.minQty, minNotional: rule.minNotional,
        expires: candle + Math.min(FUT.enterWithinMin * 60000, tfMs), candle: candle, trend: out.trend,
        exitLevel: dir > 0 ? L.next.exitLong : L.next.exitShort,
        stratName: TREND.name, hold: 0, tf: TREND.tf, stopAtr: 3,
        exitRule: (ladder ? "ส่วนที่เหลือ" : "ไม่มี TP ตายตัว") + ": ปิดเมื่อแท่ง 4 ชม. ปิด" + (dir > 0 ? "ต่ำกว่าจุดต่ำสุด" : "สูงกว่าจุดสูงสุด") + " 10 แท่ง (ตอนนี้ " +
          price(dir > 0 ? L.next.exitLong : L.next.exitShort) + " ขยับตามราคา) · แอปจะเด้งเตือนให้ปิด",
        why: "แท่ง 4 ชม. ปิด " + price(last.close) + (dir > 0 ? " ทะลุจุดสูงสุด" : " หลุดจุดต่ำสุด") + " 20 แท่ง (" + price(dir > 0 ? L.tested.upper : L.tested.lower) +
          ") · " + (dir > 0 ? "เหนือ" : "ใต้") + " EMA200 (" + price(L.ema) + ") · SL 3 ATR = " + fmt(g.stopPct, 2) + "%" });
      out.signal = g;
      checkOrder(g, rule);
      if (g.tooSmall) capitalCheck(g, rule);
    }
    return out;
  }

  // What "entered, save it" stores in the portfolio; Trend 4H trades have no target and no time limit.
  function recordOf(r, g, fx) {
    return hasTp(g) ? { symbol: r.symbol, dir: g.dir, entry: g.entry, stop: g.stop, target: g.tps[2], tps: g.tps, qty: g.qty, fx: fx, risk: g.riskUsdt * fx,
      fee: FUT.fee + FUT.slippage, lev: g.lev, hold_hours: g.hold }
      : { symbol: r.symbol, dir: g.dir, entry: g.entry, stop: g.stop, qty: g.qty, fx: fx, risk: g.riskUsdt * fx, fee: FUT.fee + FUT.slippage, lev: g.lev,
        tp1: g.ladder && g.ladder[0] ? g.ladder[0].price : null,
        exit_rule: (g.ladder ? ladderText(g.ladder) + " · " : "") + "ออกเมื่อแอปเด้งปิดไม้ (แท่ง 4 ชม. ปิดหลุด 10 แท่ง)" };
  }

  // Trend 4H plan from a coin's closed 4h bars (same rule and take profit as the alerts): the position the rule holds
  // (hold / exit), a new signal, or, when flat, the 4h closes that would start a LONG or a SHORT with their SL and TPs.
  function trendPlan(b4) {
    var lad = trendLadder(), res = Trend.run(b4, { live: true, tps: lad ? lad.tps : null }), L = res.last, last = b4[b4.length - 1];
    if (!res.ready) return { error: "แท่ง 4 ชม. ไม่พอ" };
    var tpsFor = function (entry, dir, risk) {
      return (lad ? lad.tps : []).map(function (t, k) { return { price: entry + dir * t.r * risk, label: "TP" + (k + 1), r: t.r, frac: t.frac }; });
    };
    var p = { close: last.close, candle: last.close_time + 1, stopDist: L.stopDist, ema: L.ema };
    if (res.pos) {
      var x = res.pos, ex = x.dir > 0 ? L.next.exitLong : L.next.exitShort;
      return Object.assign(p, { kind: res.pend && res.pend.exit ? "exit" : "hold", dir: x.dir, entry: x.entry, stop: x.stop, entryTime: x.entry_time, left: x.left,
        tps: tpsFor(x.entry, x.dir, x.risk).map(function (t, k) { return Object.assign(t, { done: k < x.fills.length }); }),
        exitLevel: ex, exitOn: x.dir > 0 ? ex > x.stop : ex < x.stop, r: x.dir * (last.close - x.entry) / x.risk });
    }
    if (res.pend && res.pend.dir) {
      var d = res.pend.dir;
      return Object.assign(p, { kind: "signal", dir: d, entry: last.close, stop: last.close - d * L.stopDist, tps: tpsFor(last.close, d, L.stopDist) });
    }
    var longAt = Math.max(L.next.upper, L.ema), shortAt = Math.min(L.next.lower, L.ema);
    return Object.assign(p, { kind: "flat", longAt: longAt, shortAt: shortAt, longStop: longAt - L.stopDist, shortStop: shortAt + L.stopDist,
      longTps: tpsFor(longAt, 1, L.stopDist), shortTps: tpsFor(shortAt, -1, L.stopDist) });
  }

  // Mini 4h chart with the plan drawn on it: entry (yellow), SL (red) and, while it is closer than the SL, the close that
  // ends the trade (orange; green once it locks in profit). The entry bar is marked and every level is kept in view.
  var planCharts = [];
  function clearPlans() { planCharts.forEach(function (c) { c.remove(); }); planCharts = []; }
  function drawPlan(el, it) {
    if (!el || !it || !window.LightweightCharts || !el.clientWidth) return;
    var tpl = it.tpLevels || [], d = it.now >= 1000 ? 2 : it.now >= 1 ? 4 : 6;
    var levels = [it.entry, it.stop].concat(it.exitOn ? [it.exitLevel] : []).concat(tpl.map(function (t) { return t.price; }));
    var planChart = LightweightCharts.createChart(el, baseOptions(el));
    planCharts.push(planChart);
    var s = planChart.addCandlestickSeries({ upColor: "#0ecb81", downColor: "#f6465d", borderVisible: false, wickUpColor: "#0ecb81", wickDownColor: "#f6465d",
      priceFormat: { type: "price", precision: d, minMove: Math.pow(10, -d) },
      autoscaleInfoProvider: function (base) {
        var r = base();
        if (r && r.priceRange) {
          r.priceRange.minValue = Math.min.apply(null, levels.concat([r.priceRange.minValue]));
          r.priceRange.maxValue = Math.max.apply(null, levels.concat([r.priceRange.maxValue]));
        }
        return r;
      } });
    s.setData(it.bars.map(function (b) { return { time: sec(b.time), open: b.open, high: b.high, low: b.low, close: b.close }; }));
    s.createPriceLine({ price: it.entry, color: "#f0b90b", lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: "เข้า" });
    s.createPriceLine({ price: it.stop, color: "#f6465d", lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: "SL" });
    if (it.exitOn) s.createPriceLine({ price: it.exitLevel, color: it.locks ? "#0ecb81" : "#ff9800", lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: it.locks ? "TP เลื่อน" : "จุดออก" });
    tpl.forEach(function (t) {
      s.createPriceLine({ price: t.price, color: t.done ? "#5e6673" : "#0ecb81", lineWidth: t.done ? 1 : 2, lineStyle: t.done ? 1 : 0, axisLabelVisible: true, title: t.label + (t.done ? " ✓" : "") });
    });
    var mark = it.entryTime || it.bars[it.bars.length - 1].time;
    if (mark >= it.bars[0].time) {
      s.setMarkers([{ time: sec(mark), position: it.dir > 0 ? "belowBar" : "aboveBar", color: "#f0b90b", shape: it.dir > 0 ? "arrowUp" : "arrowDown",
        text: it.entryTime ? "เข้า" : "สัญญาณ" }]);
    }
    planChart.timeScale().fitContent();
  }

  // Trend 4H: exits to act on now, then the positions the rule holds. The rule's positions exist whether or not the user
  // entered them, so every line says what to do only if the user holds it.
  function trendBoard(results) {
    var exits = results.filter(function (r) { return r.exit; }), held = results.filter(function (r) { return r.position && !r.exit; });
    var side = function (d) { return d > 0 ? '<span class="up">LONG</span>' : '<span class="down">SHORT</span>'; };
    return exits.map(function (r) {
      var x = r.exit;
      return '<div class="banner stop" style="margin:8px 0 0">ปิดไม้ ' + r.symbol.replace("USDT", "") + " " + (x.dir > 0 ? "LONG" : "SHORT") + " ตอนนี้ด้วย Market" +
        '<br><small style="font-weight:400">แท่ง 4 ชม. ปิด ' + price(x.close) + (x.dir > 0 ? " ต่ำกว่าจุดต่ำสุด" : " สูงกว่าจุดสูงสุด") + " 10 แท่ง (" + price(x.level) + ") · สูตรเข้าเมื่อ " +
        thai(x.entry_time) + " ที่ " + price(x.entry) + " · ตอนนี้ " + fmt(x.r, 2, true) + "R · ถ้าไม่ได้ถือไม้นี้ ไม่ต้องทำอะไร</small></div>";
    }).join("") + (held.length ? '<div class="sm-bt" style="font-size:13px"><b>ไม้ที่สูตรถืออยู่</b> <small>(ถ้าคุณถือ ให้ถือต่อ ห้ามเลื่อน SL)</small>' + held.map(function (r) {
      var x = r.position;
      return "<div>" + r.symbol.replace("USDT", "") + " " + side(x.dir) + " เข้า " + price(x.entry) + " (" + thai(x.entry_time).slice(0, 8) + ") · " +
        '<span class="' + tone(x.r) + '">' + fmt(x.r, 2, true) + "R</span> · SL " + price(x.stop) + " · ออกถ้าปิด" + (x.dir > 0 ? "ต่ำกว่า " : "สูงกว่า ") + price(x.exitLevel) + "</div>";
    }).join("") + "</div>" : "");
  }

  function renderFutures(results, fxInfo, lev, end) {
    var fx = fxInfo.rate, sigs = results.filter(function (r) { return r.signal; }), live = sigs.filter(function (r) { return !r.signal.below_minimum; });
    results.sort(function (a, b) { return (b.signal ? 1 : 0) - (a.signal ? 1 : 0) || a.symbol.localeCompare(b.symbol); });
    $("scanSummary").innerHTML = (live.length
      ? '<div class="banner wait">พบ ' + live.length + " สัญญาณทดลอง (" + TF[curTf()].name + "): " + live.map(function (r) { return r.symbol.replace("USDT", "") + " " + (r.signal.dir > 0 ? "LONG" : "SHORT"); }).join(", ") + " · Paper เท่านั้น ไม่ใช่คำสั่งซื้อขาย</div>"
      : '<div class="banner wait">ยังไม่มีสัญญาณที่ผ่านเงื่อนไข · สแกนอีกครั้งเมื่อแท่ง ' + TF[curTf()].name + ' ถัดไปปิด</div>') +
      '<p class="muted" style="font-size:12px;margin:4px 2px 0">' + newsFilterLabel() + "</p>";
    // Coins with a signal get a full card; the rest are one-line rows.
    var cards = sigs.map(function (r) {
      var name = r.symbol.replace("USDT", ""), g = r.signal, ev = evidenceFor(r.symbol, curTf());
      var pill = '<span class="pill ' + (g.dir > 0 ? "go" : "short") + '">' + (g.dir > 0 ? "LONG" : "SHORT") + " ≤" + g.lev + "x</span>";
      if (g.below_minimum) {
        return '<div class="coin"><div class="coin-head"><span><b>' + r.symbol + '</b> <small class="tag">Perp</small></span>' + pill + "</div>" +
          '<div class="banner stop" style="margin:8px 0 0;font-size:13px">ไม่แจ้งเตือนไม้นี้: ' + esc(g.reject) + "</div></div>";
      }
      var detail = "เหตุผล: " + esc(g.why) + "<br>" + (hasTp(g) ? "TP1 = 1R · TP2 = 2R · TP3 = 5R · ถือไม่เกิน " + fmt(g.hold, g.hold < 10 ? 1 : 0) + " ชม." : esc(g.exitRule)) + "<br>" +
        "ขนาด " + g.qty + " " + name + " (≈ " + fmt(g.notional, 0) + " USDT) · Margin ≈ " + fmt(g.margin, 1) + " USDT · Leverage ≤" + g.lev + "x (เพดานที่เลือก " + g.levCapUser + "x)" +
        "<br>Liquidation ประมาณ " + price(g.liq) + " (สมมติ maintenance margin 1% · ไม่มีตาราง bracket จริง จึงไม่ใช่ตัวเลขที่ปลอดภัยแน่นอน)" +
        (g.mark ? "<br>Mark price ตอนสแกน " + price(g.mark) : "") +
        "<br>ต้นทุนที่สมมติ: ค่าธรรมเนียม 0.05% + slippage 0.02% ต่อข้าง + funding 0.01%/8 ชม.";
      return '<div class="coin go"><div class="coin-head"><span><b>' + r.symbol + '</b> <small class="tag">Perp</small>' +
        ' <small class="tag" style="color:var(--yel)">ทดลอง</small></span>' + pill + "</div>" +
        '<div class="ev ' + (ev.ok && ev.avgR > 0 ? "good" : "bad") + '">' + esc(ev.text) + "</div>" +
        '<div class="levels"><div><small>เข้าอ้างอิง</small><b>' + price(g.entry) + '</b></div><div><small>SL</small><b class="down">' + price(g.stop) +
        (hasTp(g) ? '</b></div><div><small>TP1 · TP2 · TP3</small><b class="up" style="font-size:13px">' + g.tps.map(price).join("<br>") + "</b></div></div>"
          : '</b></div><div><small>TP</small><b style="font-size:13px">ไม่มี · ออกเมื่อแอปเตือน</b></div></div>') +
        '<div class="slider-tip">ลากสไลเดอร์ไปที่ <b style="font-size:20px">' + fmt(Math.max(g.sliderPct, 0.1), g.sliderPct < 10 ? 1 : 0) +
          "%</b> · โดน SL เสีย ≈ " + fmt(g.riskUsdt * fx, 0) + " ฿ · เข้าก่อน " + thai(g.expires).slice(9) + " น.</div>" +
        (g.sizeLimited ? '<div class="banner wait" style="margin:8px 0 0;font-size:13px">ลดขนาดให้ Margin ไม่เกิน ' + (locked() ? "5" : "25") + "% ของทุน</div>" : "") +
        '<div class="btnrow"><button class="mini" data-record="' + esc(JSON.stringify(recordOf(r, g, fx))) + '">เข้าแล้ว · บันทึก</button>' +
        '<button class="mini ghost" data-chart="' + r.symbol + '">กราฟ</button></div>' +
        '<details style="margin-top:8px"><summary>รายละเอียด</summary><small>' + detail + "</small></details></div>";
    }).join("");
    cards = trendBoard(results) + cards;
    var rows = results.filter(function (r) { return !r.signal; }).map(function (r) {
      var t = r.trend > 0 ? ["up", "ขาขึ้น"] : r.trend < 0 ? ["down", "ขาลง"] : ["", "ไม่ชัด"];
      return '<div class="mkt" data-chart="' + r.symbol + '"><b>' + r.symbol.replace("USDT", "") + '</b><small>/USDT</small><span class="' + t[0] + '">' + price(r.close) +
        '</span><small class="' + t[0] + '">' + t[1] + "</small></div>";
    }).join("");
    $("scanCards").innerHTML = cards + (rows ? '<section style="padding:6px 14px"><div class="mkthead"><span>ยังไม่มีสัญญาณ</span><span>ราคา · แนวโน้ม</span></div>' + rows + "</section>" : "");
    bindCardButtons();
    var plan = Portfolio.plan();
    if (plan.state !== "ok") $("scanSummary").innerHTML = '<div class="banner stop">' + esc(plan.message) + "</div>" + $("scanSummary").innerHTML;
    if (sigs.length && window.Notification && Notification.permission === "granted") {
      try { new Notification("Signal: " + sigs.map(function (r) { return r.symbol.replace("USDT", "") + " " + (r.signal.dir > 0 ? "LONG" : "SHORT"); }).join(", ")); } catch (e) { /* optional */ }
    }
  }

  function bindCardButtons() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-chart]"), function (b) {
      b.onclick = function () { $("cvSymbol").value = b.getAttribute("data-chart"); document.querySelector('[data-tab="chartTab"]').click(); ChartView.open(b.getAttribute("data-chart")); };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-record]"), function (b) {
      b.onclick = function () { Portfolio.open(JSON.parse(b.getAttribute("data-record"))); b.textContent = "บันทึกแล้ว ✓"; b.disabled = true; };
    });
  }

  function scan() {
    if (scanning) return;
    if ($("sgMode").value === "futures") {
      scanning = true; $("scan").disabled = true;
      Simple.busy();
      futuresScan().catch(function (e) { scanStatus(e.message || String(e), true); Simple.render(null, e.message || String(e)); reportScan([], 0, e.message || String(e)); })
        .then(function () { scanning = false; $("scan").disabled = false; });
      return;
    }
    scanning = true; $("scan").disabled = true;
    var results = [], errors = [], done = 0, fxInfo, end;
    scanStatus("กำลังดึงเวลา Binance และอัตราแลกเปลี่ยน…");
    Promise.all([binance("/api/v3/time"), fetchFx()]).then(function (res) {
      fxInfo = res[1];
      end = Math.floor(res[0].serverTime / Engine.BAR_MS) * Engine.BAR_MS;
      var start = end - 101 * 86400000, queue = COINS.slice();
      function worker() {
        var s = queue.shift();
        if (!s) return Promise.resolve();
        return Promise.all([fetchRules(s), fetchCandles(s, start, end, function () {})]).then(function (r) {
          var plan = Portfolio.plan();
          results.push(Engine.scanSymbol(s, r[1], r[0], { usdt_thb: fxInfo.rate, initial_thb: Math.max(plan.balance, 1),
            fee: readNumber("fee", 0.1) / 100, slippage: readNumber("slip", 0.05) / 100,
            risk_fraction: Math.max(plan.riskPct, 0.0001) / 100 }));
        }).catch(function (e) { errors.push(s.replace("USDT", "") + ": " + e.message); }).then(function () {
          done++; scanStatus("สแกนแล้ว " + done + "/" + COINS.length + " เหรียญ…");
          return worker();
        });
      }
      return Promise.all([worker(), worker(), worker()]);
    }).then(function () {
      renderScan(results, fxInfo, end);
      reportScan(results, end, null);
      scanStatus("สแกนล่าสุด " + thai(Date.now()) + " น. · ใช้แท่งที่ปิดเมื่อ " + thai(end) + " น." + (errors.length ? "\nข้ามบางเหรียญ: " + errors.join(" · ") : ""), !results.length);
    }).catch(function (e) { scanStatus(e.message || String(e), true); reportScan([], 0, e.message || String(e)); })
      .then(function () { scanning = false; $("scan").disabled = false; });
  }

  // Every scan (foreground or background) hands its result to the native alerts as one JSON packet.
  // Contract (checked by tests/payload and SignalAlerts.java): see signalPayload().
  var TF_LABEL = { "5m": "M5", "15m": "M15", "1h": "H1", "4h": "H4" };
  function pxDp(v, dp) {
    if (!isFinite(v)) return "";
    return dp === undefined ? price(v) : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function signalPayload(r, tf) {
    var g = r.signal, ev = evidenceFor(r.symbol, tf), fx = g.fx || 33, tp = hasTp(g);
    return { kind: "ENTRY", symbol: r.symbol, side: g.dir > 0 ? "LONG" : "SHORT", tf: TF_LABEL[tf], strategy: isTrend(tf) ? TREND.id : "squeeze3_ls",
      candle_close: g.candle, expires: g.expires, hold_hours: g.hold,
      entry: pxDp(g.entry, g.dp), sl: pxDp(g.stop, g.dp), tp1: tp ? pxDp(g.tps[0], g.dp) : g.ladder ? pxDp(g.ladder[0].price, g.dp) : "",
      tp2: tp ? pxDp(g.tps[1], g.dp) : g.ladder && g.ladder[1] ? pxDp(g.ladder[1].price, g.dp) : "",
      tp5: tp ? pxDp(g.tps[2], g.dp) : "", exit_rule: tp ? "" : g.exitRule, tp_plan: g.tpPlan || "",
      qty: String(g.qty), margin_usdt: g.margin.toFixed(2), margin_thb: String(Math.round(g.margin * fx)), risk_thb: String(Math.round(g.riskUsdt * fx)),
      risk_pct: (g.riskUsdt * fx / Math.max(1e-9, Portfolio.plan().balance) * 100).toFixed(2),
      win_pct: (function (v) { return v.win !== null ? fmt(v.win, 0) : ""; })(verdictOf(r.symbol, tf, 0)), grade: verdictOf(r.symbol, tf, 0).grade,
      news: News.warnFor(r.symbol), confidence: isTrend(tf) ? confidenceLine() : "",
      view: (function (v) { return v.text + " → " + v.fitText; })(moodRead(r.symbol, g.dir)),
      leverage: g.lev, leverage_cap: g.levCapUser, liq_est: pxDp(g.liq, g.dp), mark: g.mark ? pxDp(g.mark, g.dp) : "",
      rationale: g.why, evidence: ev.text, evidence_ok: ev.ok, experimental: true };
  }
  // Trend 4H exit: the rule closes its position at the next open. Sent even while new entries are paused.
  function exitPayload(r, tf) {
    var x = r.exit;
    return { kind: "EXIT", symbol: r.symbol, side: x.dir > 0 ? "LONG" : "SHORT", tf: TF_LABEL[tf], strategy: TREND.id, candle_close: x.candle, expires: x.expires,
      entry: pxDp(x.entry, x.dp), sl: pxDp(x.stop, x.dp), exit_ref: pxDp(x.close, x.dp), exit_level: pxDp(x.level, x.dp), opened: x.entry_time,
      r_now: (x.r >= 0 ? "+" : "") + x.r.toFixed(2), experimental: true,
      rationale: "แท่ง 4 ชม. ปิด" + (x.dir > 0 ? "ต่ำกว่าจุดต่ำสุด" : "สูงกว่าจุดสูงสุด") + " 10 แท่ง: สูตรออกที่ราคาเปิดแท่งถัดไป" +
        (x.left < 1 ? " · ปิดส่วนที่เหลือ " + fmt(x.left * 100, 0) + "% (ขาย TP ไปแล้ว " + x.fills.length + " ขั้น)" : "") };
  }
  function reportScan(results, end, error, extra) {
    if (!window.NativeHttp || !window.NativeHttp.scanDone || $("sgMode").value !== "futures") return;
    var plan = Portfolio.plan(), tf = curTf();
    if (isTrend(tf)) RECENT = recentFrom(results);
    // "half" trades on at half the risk (the sizes already use plan.riskPct); "stop" and "day" pause new entries.
    var sigs = (plan.state === "ok" || plan.state === "half") && !(isTrend(tf) && systemPaused()) ? results.filter(function (r) { return r.signal && !r.signal.below_minimum; }) : [];
    var exits = results.filter(function (r) { return r.exit; });
    window.NativeHttp.scanDone(JSON.stringify({ v: 2, candle: end, interval_minutes: TF[tf].ms / 60000, error: error || "",
      scanned: extra && extra.scanned || 0, failed: extra && extra.failed || [],
      rejected: results.filter(function (r) { return r.signal && r.signal.below_minimum; }).map(function (r) { return r.symbol + ": " + r.signal.reject; }),
      note: plan.state === "ok" ? "" : plan.message, news_filter: newsFilterLabel(),
      signals: sigs.map(function (r) { return signalPayload(r, tf); }).concat(exits.map(function (r) { return exitPayload(r, tf); })) }));
  }

  function rank(r) { return r.signal ? 0 : r.trend_up && r.strategy ? 1 : r.trend_up ? 2 : 3; }

  function renderScan(results, fxInfo, end) {
    var fx = fxInfo.rate, signals = results.filter(function (r) { return r.signal && !r.signal.below_minimum; });
    results.sort(function (a, b) { return rank(a) - rank(b) || ((b.stats && b.stats.profit_factor) || 0) - ((a.stats && a.stats.profit_factor) || 0); });
    $("scanSummary").innerHTML = signals.length
      ? '<div class="banner go">มีสัญญาณเข้า ' + signals.length + " เหรียญ: " + signals.map(function (r) { return r.symbol.replace("USDT", ""); }).join(", ") + "</div>"
      : '<div class="banner wait">ตอนนี้ยังไม่มีสัญญาณเข้า — รอ แล้วสแกนใหม่หลังแท่ง 15 นาทีถัดไปปิด</div>';
    $("scanCards").innerHTML = results.map(function (r) {
      var name = r.symbol.replace("USDT", ""), pill, body = "";
      if (r.signal && !r.signal.below_minimum) pill = '<span class="pill go">เข้าได้</span>';
      else if (r.signal) pill = '<span class="pill wait">สัญญาณ แต่ทุนเล็กเกินขั้นต่ำ</span>';
      else if (!r.trend_up) pill = '<span class="pill no">ขาลง/ไม่ชัด · ไม่เทรด</span>';
      else if (!r.strategy) pill = '<span class="pill no">ขาขึ้น แต่ช่วงนี้ไม่มีกลยุทธ์ที่ได้ผล</span>';
      else pill = '<span class="pill wait">ขาขึ้น · รอจุดเข้า</span>';
      if (r.signal) {
        var g = r.signal;
        body = '<div class="levels"><div><small>ซื้อประมาณ</small><b>' + price(g.entry) + '</b></div><div><small>Stop</small><b class="down">' + price(g.stop) +
          '</b></div><div><small>เป้า ' + g.take_profit_r + 'R</small><b class="up">' + price(g.target) + "</b></div></div>" +
          "<small>จำนวน " + g.qty + " " + name + " (≈ " + fmt(g.notional * fx, 0) + " ฿) · ถ้าโดน stop เสีย ≈ " + fmt(g.risk * fx, 0) +
          " ฿ · ซื้อก่อน " + thai(g.expires).slice(9) + " น.</small>" +
          (g.below_minimum ? "" : '<br><button class="mini" data-record="' + esc(JSON.stringify({ symbol: r.symbol, entry: g.entry, stop: g.stop,
            target: g.target, qty: g.qty, fx: fx, risk: g.risk * fx })) + '">ซื้อแล้ว · บันทึกลงพอร์ต</button>');
      }
      var stats = r.stats ? "<br><small>กลยุทธ์: " + esc(VARIANT_NAMES[r.strategy]) + " · 90 วันล่าสุด " + r.stats.trade_count + " ไม้ win " +
        fmt(r.stats.win_rate_pct, 0) + "% PF " + fmt(r.stats.profit_factor, 2) + "</small>" : "";
      return '<div class="coin' + (r.signal && !r.signal.below_minimum ? " go" : "") + '"><div class="coin-head"><b>' + name + "</b>" + pill + "</div>" +
        "<small>ราคา " + price(r.close) + ' USDT</small> <button class="mini ghost" data-chart="' + r.symbol + '">ดูกราฟ</button>' + stats + body + "</div>";
    }).join("");
    bindCardButtons();
    var plan = Portfolio.plan();
    if (plan.state !== "ok") $("scanSummary").innerHTML = '<div class="banner stop">' + esc(plan.message) + "</div>" + $("scanSummary").innerHTML;
    if (signals.length && window.Notification && Notification.permission === "granted") {
      try { new Notification("POC Signal: " + signals.map(function (r) { return r.symbol.replace("USDT", ""); }).join(", ")); } catch (e) { /* optional */ }
    }
  }

  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!$("autoScan").checked) return;
    var bar = $("sgMode").value === "futures" ? TF[curTf()].ms : Engine.BAR_MS, wait = bar - (Date.now() % bar) + 25000;
    autoTimer = setTimeout(function () { scan(); scheduleAuto(); }, wait);
  }
  var nativeAlerts = !!(window.NativeHttp && window.NativeHttp.setAlerts);
  if (nativeAlerts) {
    $("autoScanLabel").textContent = "เด้งแยกเหรียญเมื่อมีสัญญาณเข้า/ปิดไม้ (H4/H1/M15/M5 · Android อาจหน่วงแจ้งเตือนเมื่อประหยัดแบต)";
    try { $("autoScan").checked = window.NativeHttp.alertsEnabled(); } catch (e) { /* ignore */ }
  }
  function batteryCheck() {
    // Last background scan as recorded by Android (time, outcome, reason) so failures are visible, not silent.
    try {
      var st = window.NativeHttp && window.NativeHttp.lastScanStatus ? JSON.parse(window.NativeHttp.lastScanStatus() || "{}") : {};
      $("scanLog").textContent = st.at ? "สแกนเบื้องหลังล่าสุด " + thai(st.at) + " น.: " + (st.text || "") : (nativeAlerts ? "ยังไม่มีการสแกนเบื้องหลัง" : "");
      $("scanLog").className = st.at && !st.ok ? "down" : "muted";
    } catch (e) { /* ignore */ }
    var blocked = false;
    try { blocked = nativeAlerts && window.NativeHttp.notificationsAllowed && !window.NativeHttp.notificationsAllowed(); } catch (e) { /* ignore */ }
    $("notifBox").classList.toggle("hidden", !blocked);
    $("notifTest").classList.toggle("hidden", !(nativeAlerts && window.NativeHttp.testNotification));
    $("popupBox").classList.toggle("hidden", !(nativeAlerts && window.NativeHttp.openSignalChannelSettings));
    var show = false;
    try { show = nativeAlerts && $("autoScan").checked && window.NativeHttp.batteryUnrestricted && !window.NativeHttp.batteryUnrestricted(); } catch (e) { /* ignore */ }
    $("batteryBox").classList.toggle("hidden", !show);
  }
  $("notifBtn").onclick = function () { try { window.NativeHttp.openNotificationSettings(); } catch (e) { /* ignore */ } };
  $("notifTest").onclick = function () { try { window.NativeHttp.testNotification(); } catch (e) { /* ignore */ } setTimeout(batteryCheck, 800); };
  $("popupBtn").onclick = function () { try { window.NativeHttp.openSignalChannelSettings(); } catch (e) { /* ignore */ } };
  $("batteryBtn").onclick = function () { try { window.NativeHttp.openBatterySettings(); } catch (e) { /* ignore */ } };
  document.addEventListener("visibilitychange", function () { if (!document.hidden) batteryCheck(); });
  setTimeout(batteryCheck, 500);
  $("autoScan").onchange = function () {
    if (nativeAlerts) { window.NativeHttp.setAlerts($("autoScan").checked); batteryCheck(); return; }
    if ($("autoScan").checked && window.Notification && Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (e) { /* optional */ }
    }
    scheduleAuto();
  };
  $("scan").onclick = scan;
  // Squeeze v2 out-of-sample 2026-01..09, 12 coins (web/evidence.js): 1h 594 trades -0.09R, 15m 2,195 -0.11R, 5m 5,712 -0.37R per trade.
  var SQZ_NOT_VALIDATED = " · NOT VALIDATED: ช่วงทดสอบนอกตัวอย่าง ม.ค.–ก.ย. 2026 ขาดทุนทุกกราฟ (1 ชม. 594 ไม้ −0.09R/ไม้) ใช้ดูเท่านั้น";
  function modeHelp() {
    var lock = locked();
    $("sgStrat").disabled = $("sgLev").disabled = lock;
    var v2 = lock || $("sgStrat").value === "squeeze3_ls";
    $("sgHelp").textContent = $("sgMode").value === "futures"
      ? (v2 ? "Squeeze v2 แท่ง 1 ชม.: เทรนด์ EMA20/50/200 + บีบตัวแล้วทะลุภายใน 3 ชม. + แท่งโมเมนตัม 2 แท่ง + Volume ≥ 1.8 เท่า · SL 1.8 ATR · TP1/2/3 = 1R/2R/5R · ถือไม่เกิน 48 ชม."
          : "Squeeze v1 แท่ง 1 ชม.: เทรนด์ EMA20/50/200 + บีบตัวแล้วทะลุภายใน 8 ชม. + แท่งโมเมนตัม · SL 2.5 ATR · TP1/2/3 = 1R/2R/5R · ถือไม่เกิน 24 ชม.") +
        " · ขนาดไม้คิดจาก % เสี่ยงในแท็บพอร์ต ไม่ใช่จาก Leverage" + SQZ_NOT_VALIDATED
      : "Spot: สแกนแนวโน้ม 1 ชม. เลือกกลยุทธ์ที่ได้ผลดีสุดใน 90 วันล่าสุดของแต่ละเหรียญ แล้วดูแท่ง 15 นาทีที่เพิ่งปิด";
    if ($("sgMode").value !== "futures") $("sgLev").disabled = $("sgStrat").disabled = true;
    if (lock && $("sgMode").value === "futures") $("sgHelp").textContent = "สูตร Squeeze v2 เดิมพัฒนาบน H1 · ใช้ M5/M15 เป็นสัญญาณทดลอง ผลย้อนหลังขาดทุน · เลือกเหรียญ/กราฟด้านบน · จำกัดเสี่ยงเป้าหมาย 0.25%/ไม้" + SQZ_NOT_VALIDATED;
    if (isTrend(curTf())) $("sgHelp").textContent = "Trend 4H: Long เมื่อแท่ง 4 ชม. ปิดทะลุจุดสูงสุด 20 แท่งและอยู่เหนือ EMA200 · Short เมื่อปิดหลุดจุดต่ำสุด 20 แท่งและอยู่ใต้ EMA200 · " +
      "SL 3 ATR ไม่เลื่อน · ไม่มี TP ตายตัว ออกเมื่อแท่ง 4 ชม. ปิดหลุดจุดต่ำสุด/สูงสุด 10 แท่ง (แอปเด้งเตือน) · เสี่ยง " + trendRiskPct() +
      "%/ไม้ · Leverage = เพดานที่เลือก แต่แอปลดให้เองจน Liquidation ห่างกว่า SL 1.5 เท่า (SL 4H กว้าง 3–8% จึงมักได้ราว 8–15x)";
  }
  ["sgMode", "sgLev", "sgStrat"].forEach(function (id) {
    try { var v = localStorage.getItem(id); if (v !== null) $(id).value = v; } catch (e) { /* ignore */ }
    $(id).addEventListener("change", function () { try { localStorage.setItem(id, $(id).value); } catch (e) { /* ignore */ } modeHelp(); });
  });
  // The market/strategy pickers are hidden: the app always runs the chosen futures setup.
  $("sgMode").value = "futures"; $("sgLock").checked = true;
  $("sgLock").addEventListener("change", function () { try { localStorage.setItem("sgLock", $("sgLock").checked ? "1" : "0"); } catch (e) { /* ignore */ } modeHelp(); });
  try { $("sgFomc").value = localStorage.getItem("sgFomc") || FOMC_DEFAULT.join("\n"); } catch (e) { $("sgFomc").value = FOMC_DEFAULT.join("\n"); }
  $("sgFomc").addEventListener("change", function () { try { localStorage.setItem("sgFomc", $("sgFomc").value); } catch (e) { /* ignore */ } });
  modeHelp();
  initSignalSettings();

  // ---- Realtime chart: EMA, Bollinger, RSI, auto Fibonacci, trendlines, plan ----
  var ChartView = (function () {
    var TF_MS = { "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
    var STREAMS = ["wss://fstream.binance.com/market/ws/"];   // USD-M futures market streams (moved to /market on 2026-04-23)
    var chart = null, rsiChart = null, series = {}, priceLines = [], bars = [], socket = null, pollTimer = null,
      symbol = "BTCUSDT", tf = "4h", lastDraw = 0, token = 0, tplan = null;

    // The Trend 4H plan for the coin on screen, from its last 1,500 closed 4h bars (what the alerts replay), refreshed
    // every 10 minutes. Drawn on whatever timeframe is shown.
    function loadPlan(sym) {
      if (tplan && tplan.symbol === sym && Date.now() - tplan.at < 600000) return;
      var step = TF[TREND.tf].ms, end = Math.floor(Date.now() / step) * step;
      tplan = { symbol: sym, at: Date.now(), loading: true };
      fetchCandles(sym, end - 1500 * step, end, function () {}, TREND.tf, true).then(function (b4) {
        tplan = Object.assign({ symbol: sym, at: Date.now() }, trendPlan(b4));
      }).catch(function (e) { tplan = { symbol: sym, at: Date.now(), error: e.message || String(e) }; })
        .then(function () { if (sym === symbol && bars.length) draw(false); });
    }
    function planLines(pl) {
      var P = tplan, side = function (d) { return d > 0 ? "LONG" : "SHORT"; };
      if (!P || P.symbol !== symbol || P.loading || P.error) return;
      if (P.kind === "flat") {
        pl(P.longAt, "#0ecb81", "LONG ถ้าปิด 4H เหนือ", 2, 2);
        pl(P.shortAt, "#f6465d", "SHORT ถ้าปิด 4H ใต้", 2, 2);
        return;
      }
      pl(P.entry, "#f0b90b", "เข้า " + side(P.dir), 0, 2);
      pl(P.stop, "#f6465d", "SL", 0, 2);
      P.tps.forEach(function (t) { pl(t.price, t.done ? "#5e6673" : "#0ecb81", t.label + (t.done ? " ✓" : ""), t.done ? 1 : 0, 2); });
      if (P.exitOn) pl(P.exitLevel, "#ff9800", "จุดออก", 2, 2);
    }
    function planHtml() {
      var P = tplan, row = function (k, v) { return "<div><span>" + k + "</span><b>" + v + "</b></div>"; };
      var tpRows = function (tps, coinRisk) {
        return tps.map(function (t) { return row(t.label + " · ขาย " + fracTxt(t.frac), '<span class="up">' + price(t.price) + "</span> (+" + t.r + "R)" + (t.done ? " ✓ ขายแล้ว" : "")); }).join("");
      };
      var head = '<div class="sm-sec">แผน Trend 4H · ' + symbol.replace("USDT", "") + " (สูตรหลัก ตรงกับการแจ้งเตือน)</div>";
      if (!P || P.symbol !== symbol || P.loading) return head + "<p class=\"muted\">กำลังคำนวณจากแท่ง 4 ชม.…</p>";
      if (P.error) return head + '<p class="down">คำนวณไม่ได้: ' + esc(P.error) + "</p>";
      var dist = function (v, ref) { return fmt((v / ref - 1) * 100, 2, true) + "%"; }, rows;
      if (P.kind === "flat") {
        rows = row("ตอนนี้", "ยังไม่มีไม้ · รอแท่ง 4 ชม. ปิดทะลุ") +
          row('<span class="up">จุดเข้า LONG</span>', "แท่ง 4 ชม. ปิดเหนือ " + price(P.longAt) + " (" + dist(P.longAt, P.close) + ")") +
          row("SL ถ้าเข้า LONG", "≈ " + price(P.longStop) + " · " + (P.longTps.length ? P.longTps.map(function (t) { return t.label + " ≈ " + price(t.price); }).join(" · ") : "ไม่ตั้ง TP")) +
          row('<span class="down">จุดเข้า SHORT</span>', "แท่ง 4 ชม. ปิดใต้ " + price(P.shortAt) + " (" + dist(P.shortAt, P.close) + ")") +
          row("SL ถ้าเข้า SHORT", "≈ " + price(P.shortStop) + " · " + (P.shortTps.length ? P.shortTps.map(function (t) { return t.label + " ≈ " + price(t.price); }).join(" · ") : "ไม่ตั้ง TP")) +
          row("หมายเหตุ", "ระดับคำนวณใหม่ทุกแท่ง 4 ชม. (" + thai(P.candle + TF[TREND.tf].ms).slice(9) + " น. ถัดไป) · แอปเด้งเตือนเมื่อเข้าเงื่อนไข");
      } else {
        var side = P.dir > 0 ? "LONG" : "SHORT";
        rows = row("ตอนนี้", P.kind === "signal" ? '<span class="' + (P.dir > 0 ? "up" : "down") + '">สัญญาณเข้า ' + side + " (แท่งปิด " + thai(P.candle).slice(9) + " น.)</span>"
            : P.kind === "exit" ? '<span class="down">สูตรปิดไม้ ' + side + " ที่ราคาเปิดแท่งถัดไป</span>"
            : "สูตรถือ " + side + " อยู่ · " + fmt(P.r, 2, true) + "R" + (P.left < 1 ? " · เหลือ " + fmt(P.left * 100, 0) + "%" : "")) +
          row("จุดเข้า", price(P.entry) + (P.entryTime ? " (" + thai(P.entryTime) + ")" : " (ราคาปิดแท่ง)")) +
          row("Stop Loss", '<span class="down">' + price(P.stop) + "</span> (" + dist(P.stop, P.entry) + ")") +
          (P.tps.length ? tpRows(P.tps) : row("Take Profit", "ไม่ตั้ง (โหมดถือตามเทรนด์)")) +
          row("จุดออก", P.exitOn ? "แท่ง 4 ชม. ปิด" + (P.dir > 0 ? "ต่ำกว่า " : "สูงกว่า ") + price(P.exitLevel) + " หรือแตะ SL" : "แตะ SL (ตั้งไว้ใน Binance)") +
          (P.kind === "hold" ? row("ถ้าคุณไม่ได้ถือ", "ไม่ต้องเข้าตาม รอสัญญาณใหม่") : "") +
          (P.kind === "signal" ? row("ขนาดไม้", "ดูหน้าแรก (คิดจากทุนและความเสี่ยงของคุณ)") : "");
      }
      return head + '<div class="sm-order">' + rows + "</div>";
    }

    function emaArr(values, n) { var a = 2 / (n + 1), y = NaN, out = []; values.forEach(function (x, i) { y = i ? y + a * (x - y) : x; out.push(i >= n - 1 ? y : NaN); }); return out; }
    function rsiArr(values, n) {
      var up = NaN, dn = NaN, out = [NaN];
      for (var i = 1; i < values.length; i++) {
        var d = values[i] - values[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
        up = i === 1 ? u : up + (u - up) / n; dn = i === 1 ? w : dn + (w - dn) / n;
        out.push(i >= n ? (dn === 0 ? 100 : 100 - 100 / (1 + up / dn)) : NaN);
      }
      return out;
    }
    function bbArr(values, n) {
      return values.map(function (_, i) {
        if (i < n - 1) return null;
        var w = values.slice(i - n + 1, i + 1), m = w.reduce(function (a, b) { return a + b; }, 0) / n;
        var sd = Math.sqrt(w.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / n);
        return [m + 2 * sd, m, m - 2 * sd];
      });
    }
    function pivots(k) {
      var highs = [], lows = [];
      for (var i = k; i < bars.length - k; i++) {
        var h = bars[i].high, l = bars[i].low, isH = true, isL = true;
        for (var j = i - k; j <= i + k; j++) {
          if (j === i) continue;
          if (bars[j].high >= h) isH = false;
          if (bars[j].low <= l) isL = false;
        }
        if (isH) highs.push(i);
        if (isL) lows.push(i);
      }
      return { highs: highs, lows: lows };
    }
    function t(ms) { return Math.floor(ms / 1000) + THAI_OFFSET_S; }

    function build() {
      if (chart) { chart.remove(); rsiChart.remove(); }
      var el = $("cvChart"), re = $("cvRsi");
      chart = LightweightCharts.createChart(el, baseOptions(el));
      rsiChart = LightweightCharts.createChart(re, Object.assign(baseOptions(re), { timeScale: { visible: false } }));
      series.candle = chart.addCandlestickSeries({ upColor: "#0ecb81", downColor: "#f6465d", borderVisible: false, wickUpColor: "#0ecb81", wickDownColor: "#f6465d" });
      series.volume = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      var line = function (c, w, style) { return chart.addLineSeries({ color: c, lineWidth: w || 1, lineStyle: style || 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); };
      series.e20 = line("#ffb74d"); series.e50 = line("#ba68c8"); series.e200 = line("#90a4ae", 2);
      series.bbU = line("#5c6bc0", 1, 2); series.bbM = line("#5c6bc0", 1, 1); series.bbL = line("#5c6bc0", 1, 2);
      series.sup = line("#4dd0e1", 2); series.res = line("#ff8a65", 2);
      series.rsi = rsiChart.addLineSeries({ color: "#86a9ff", lineWidth: 1, priceLineVisible: false });
      series.rsi.createPriceLine({ price: 70, color: "#f6465d", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      series.rsi.createPriceLine({ price: 30, color: "#0ecb81", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      chart.timeScale().subscribeVisibleLogicalRangeChange(function (r) { if (r) rsiChart.timeScale().setVisibleLogicalRange(r); });
    }

    function load() {
      var my = ++token;
      loadPlan(symbol);
      if (socket) { try { socket.close(); } catch (e) { /* ignore */ } socket = null; }
      clearInterval(pollTimer);
      $("cvLive").textContent = "● กำลังโหลด…";
      $("cvLive").className = "";
      futuresApi("/fapi/v1/klines?symbol=" + symbol + "&interval=" + tf + "&limit=500").then(function (rows) {
        if (my !== token) return;
        bars = rows.map(function (k) { return { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closed: true }; });
        if (bars.length) bars[bars.length - 1].closed = false;
        draw(true);
        connect(my, 0);
      }).catch(function (e) { $("cvLive").textContent = "● " + e.message; $("cvLive").className = "down"; });
    }

    function onKline(k) {
      var bar = { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closed: k.x };
      var last = bars[bars.length - 1];
      if (last && last.time === bar.time) bars[bars.length - 1] = bar;
      else if (!last || bar.time > last.time) { bars.push(bar); if (bars.length > 600) bars.shift(); }
      var now = Date.now();
      if (bar.closed || now - lastDraw > 3000) draw(false);
      else series.candle.update({ time: t(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    }

    function connect(my, attempt) {
      if (!window.WebSocket || attempt >= STREAMS.length) return poll(my);
      var ws;
      try { ws = new WebSocket(STREAMS[attempt] + symbol.toLowerCase() + "@kline_" + tf); } catch (e) { return connect(my, attempt + 1); }
      socket = ws;
      var opened = false, heard = false;
      ws.onopen = function () {
        opened = true;
        // An address that connects but sends nothing is no feed: poll instead.
        setTimeout(function () { if (my === token && socket === ws && !heard) { ws.onclose = null; try { ws.close(); } catch (e) { /* closed */ } poll(my); } }, 10000);
      };
      ws.onmessage = function (m) {
        if (my !== token) return;
        if (!heard) { heard = true; $("cvLive").textContent = "● Realtime"; $("cvLive").className = "up"; }
        try { onKline(JSON.parse(m.data).k); } catch (e) { /* ignore bad frame */ }
      };
      ws.onclose = function () { if (my !== token) return; if (!opened) connect(my, attempt + 1); else setTimeout(function () { if (my === token) connect(my, 0); }, 3000); };
      ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
    }

    function poll(my) {
      $("cvLive").textContent = "● อัปเดตทุก 10 วินาที";
      pollTimer = setInterval(function () {
        if (my !== token) return;
        futuresApi("/fapi/v1/klines?symbol=" + symbol + "&interval=" + tf + "&limit=2").then(function (rows) {
          rows.forEach(function (k) { onKline({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5], x: k[6] < Date.now() }); });
        }).catch(function () { /* keep last chart */ });
      }, 10000);
    }

    function draw(fit) {
      lastDraw = Date.now();
      var closes = bars.map(function (b) { return b.close; });
      series.candle.setData(bars.map(function (b) { return { time: t(b.time), open: b.open, high: b.high, low: b.low, close: b.close }; }));
      series.volume.setData(bars.map(function (b) { return { time: t(b.time), value: b.volume, color: b.close >= b.open ? "rgba(14,203,129,.35)" : "rgba(246,70,93,.35)" }; }));
      var e20 = emaArr(closes, 20), e50 = emaArr(closes, 50), e200 = emaArr(closes, 200), rsi = rsiArr(closes, 14), bb = bbArr(closes, 20);
      var put = function (s, arr, on) {
        s.setData(on ? bars.map(function (b, i) { return { time: t(b.time), value: arr[i] }; }).filter(function (p) { return isFinite(p.value); }) : []);
      };
      var showEma = $("cvEma").checked, showBb = $("cvBb").checked;
      put(series.e20, e20, showEma); put(series.e50, e50, showEma); put(series.e200, e200, showEma);
      put(series.bbU, bb.map(function (x) { return x ? x[0] : NaN; }), showBb);
      put(series.bbM, bb.map(function (x) { return x ? x[1] : NaN; }), showBb);
      put(series.bbL, bb.map(function (x) { return x ? x[2] : NaN; }), showBb);
      series.rsi.setData(bars.map(function (b, i) { return { time: t(b.time), value: rsi[i] }; }).filter(function (p) { return isFinite(p.value); }));

      priceLines.forEach(function (l) { series.candle.removePriceLine(l); });
      priceLines = [];
      var n = bars.length, look = Math.min(150, n), lo = Infinity, hi = -Infinity, loI = 0, hiI = 0;
      for (var i = n - look; i < n; i++) {
        if (bars[i].low < lo) { lo = bars[i].low; loI = i; }
        if (bars[i].high > hi) { hi = bars[i].high; hiI = i; }
      }
      var upSwing = loI < hiI, range = hi - lo, fib = {};
      [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].forEach(function (r) { fib[r] = upSwing ? hi - r * range : lo + r * range; });
      var ext = { 1.272: upSwing ? lo + 1.272 * range : hi - 1.272 * range, 1.618: upSwing ? lo + 1.618 * range : hi - 1.618 * range };
      var pl = function (price, color, title, style, width) {
        priceLines.push(series.candle.createPriceLine({ price: price, color: color, lineWidth: width || 1, lineStyle: style === undefined ? 2 : style, axisLabelVisible: true, title: title }));
      };
      planLines(pl);
      if ($("cvFib").checked && range > 0) {
        Object.keys(fib).forEach(function (r) { pl(fib[r], r === "0.618" || r === "0.5" ? "#f0b90b" : "#6b7c93", "Fib " + r); });
        pl(ext[1.272], "#0ecb81", "Ext 1.272"); pl(ext[1.618], "#0ecb81", "Ext 1.618");
      }

      // Trendlines through the last two confirmed pivots (5 bars each side).
      var pv = pivots(5), sup = null, res = null, L = pv.lows, H = pv.highs;
      if (L.length >= 2 && bars[L[L.length - 1]].low > bars[L[L.length - 2]].low) sup = [L[L.length - 2], L[L.length - 1], "low"];
      if (H.length >= 2 && bars[H[H.length - 1]].high < bars[H[H.length - 2]].high) res = [H[H.length - 2], H[H.length - 1], "high"];
      var lineData = function (tl) {
        if (!tl || !$("cvTrend").checked) return [];
        var a = tl[0], b = tl[1], va = bars[a][tl[2]], slope = (bars[b][tl[2]] - va) / (b - a);
        return [a, n - 1].map(function (k) { return { time: t(bars[k].time), value: va + slope * (k - a) }; });
      };
      series.sup.setData(lineData(sup)); series.res.setData(lineData(res));
      var lineAt = function (tl) { if (!tl) return null; var a = tl[0], b = tl[1], va = bars[a][tl[2]]; return va + (bars[b][tl[2]] - va) / (b - a) * (n - 1 - a); };

      analyse({ price: bars[n - 1].close, e20: e20[n - 1], e50: e50[n - 1], e200: e200[n - 1], rsi: rsi[n - 1], upSwing: upSwing,
        hi: hi, lo: lo, fib: fib, ext: ext, sup: lineAt(sup), res: lineAt(res), bb: bb[n - 1] });
      if (fit) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 3 });
    }

    var lastA = null;
    function context() {
      if (!lastA || !bars.length) return null;
      var recent = bars.slice(-12).map(function (b) {
        return new Date(b.time).toISOString().slice(5, 16).replace("T", " ") + " " + [b.open, b.high, b.low, b.close].map(price).join("/");
      }).join("; ");
      return { symbol: symbol, tf: tf, a: lastA, recent: recent };
    }
    function analyse(a) {
      lastA = a;
      var trendUp = a.e50 > a.e200 && a.price > a.e200, trendDown = a.e50 < a.e200 && a.price < a.e200, plan = "", pos;
      var trend = trendUp ? '<b class="up">ขาขึ้น</b> (ราคาเหนือ EMA200 และ EMA50 > EMA200)' :
        trendDown ? '<b class="down">ขาลง</b> (ราคาใต้ EMA200 และ EMA50 < EMA200)' : "<b>ไซด์เวย์/ไม่ชัด</b> (EMA ยังไม่เรียงตัว)";
      var rsiText = !isFinite(a.rsi) ? "—" : a.rsi >= 70 ? fmt(a.rsi, 0) + " ร้อนแรง/ซื้อมากเกิน ระวังย่อ" : a.rsi <= 30 ? fmt(a.rsi, 0) + " ขายมากเกิน อาจเด้ง" :
        fmt(a.rsi, 0) + (a.rsi >= 50 ? " ฝั่งซื้อคุม" : " ฝั่งขายคุม");
      var levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map(function (r) { return [r, a.fib[r]]; });
      levels.sort(function (x, y) { return x[1] - y[1]; });
      var below = levels.filter(function (l) { return l[1] <= a.price; }).pop(), above = levels.filter(function (l) { return l[1] > a.price; })[0];
      pos = "ราคา " + price(a.price) + " อยู่ระหว่าง " + (below ? "Fib " + below[0] + " (" + price(below[1]) + ")" : "ใต้กรอบ") + " และ " + (above ? "Fib " + above[0] + " (" + price(above[1]) + ")" : "เหนือกรอบ");
      plan = planHtml();
      var tl = [];
      if (a.sup !== null) tl.push("แนวรับเทรนด์ไลน์ ≈ " + price(a.sup) + (a.price < a.sup ? ' <span class="down">(หลุดแล้ว)</span>' : ""));
      if (a.res !== null) tl.push("แนวต้านเทรนด์ไลน์ ≈ " + price(a.res) + (a.price > a.res ? ' <span class="up">(ทะลุแล้ว)</span>' : ""));
      $("cvAnalysis").innerHTML = plan + '<div class="sm-sec">ข้อมูลประกอบ (ไม่ใช่สูตรที่ทดสอบ)</div><ul style="margin:0;padding-left:18px;font-size:14px"><li>แนวโน้ม: ' + trend +
        "</li><li>RSI: " + rsiText + "</li><li>" + pos + "</li>" + (tl.length ? "<li>" + tl.join("<br>") + "</li>" : "") + "</ul>";
      $("cvTime").textContent = "อัปเดต " + thai(Date.now()).slice(9) + " น.";
    }

    function open(sym) {
      if (sym) { symbol = sym; $("cvSymbol").value = sym; }
      if (!chart) build();
      load();
    }
    function stop() { token++; if (socket) { try { socket.close(); } catch (e) { /* ignore */ } socket = null; } clearInterval(pollTimer); }

    $("cvSymbol").innerHTML = COINS.map(function (c) { return '<option value="' + c + '">' + c.replace("USDT", "/USDT") + "</option>"; }).join("");
    $("cvSymbol").onchange = function () { symbol = $("cvSymbol").value; load(); };
    $("cvTf").onchange = function () { tf = $("cvTf").value; load(); };
    Array.prototype.forEach.call($("cvTfBar").children, function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call($("cvTfBar").children, function (x) { x.classList.toggle("on", x === b); });
        $("cvTf").value = b.getAttribute("data-tf"); tf = $("cvTf").value; load();
      };
    });
    // Binance-style header: last price coloured by the 24h change.
    setInterval(function () {
      if (!bars || !bars.length) return;
      var last = bars[bars.length - 1], ref = bars.filter(function (b) { return b.time <= last.time - 86400000; }).pop() || bars[0];
      var chg = (last.close / ref.open - 1) * 100, cls = chg >= 0 ? "up" : "down";
      $("cvPrice").textContent = last.close.toLocaleString("en-US", { maximumFractionDigits: last.close >= 100 ? 2 : 4 });
      $("cvPrice").className = cls;
      $("cvChg").innerHTML = '24h <span class="' + cls + '">' + (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%</span>";
    }, 1000);
    ["cvEma", "cvFib", "cvTrend", "cvBb"].forEach(function (id) { $(id).onchange = function () { if (bars.length) draw(false); }; });
    window.addEventListener("resize", function () {
      if (chart) { chart.applyOptions({ width: $("cvChart").clientWidth }); rsiChart.applyOptions({ width: $("cvRsi").clientWidth }); }
    });
    return { open: open, stop: stop, context: context };
  })();

  // ---- Step-by-step guide ----
  // ---- How a professional trades this rule: the written plan, daily / weekly / monthly checklists, and a backup ----
  // The plan is the rule's own facts (research/pro); the checklists keep their ticks per day / week / month on this phone.
  var Routine = (function () {
    var KEY = "routine.v1";
    var LISTS = {
      day: ["หลังแท่ง 4 ชม. ปิด (03:00 · 07:00 · 11:00 · 15:00 · 19:00 · 23:00 น.) เปิดแอปภายใน 15 นาที เข้า / ปิดไม้ตามที่แอปบอกทุกไม้",
        "ทุกไม้ที่เข้า: Isolated · Leverage และขนาดตามแอป · ตั้ง Stop Loss (Stop Market) ใน Binance ทันที · ตั้ง TP1 เป็น Limit",
        "บันทึกไม้ลงพอร์ตด้วยราคาที่ได้จริง (เพื่อวัดว่าเข้าห่างจากสัญญาณแค่ไหน)",
        "ดูปฏิทินข่าววันนี้ · ข่าวแรงไม่ใช่เหตุให้ข้ามไม้ แต่ต้องมี SL อยู่ใน Binance แล้ว"],
      week: ["เทียบสมุดผลจริงกับผลทดสอบ (ปกติ / ต่ำกว่าปกติ / แย่กว่าที่เคยเจอ)",
        "ตรวจว่าทุกสัญญาณ 7 วันได้เข้าครบ ไม่ได้ข้ามไม้ และไม่มีไม้นอกระบบ",
        "สำรองข้อมูลพอร์ตและสมุด (ปุ่มด้านล่าง)"],
      month: ["สรุปเดือนเป็น R: ชนะ / แพ้ / เฉลี่ยต่อไม้ เทียบกับ \"ปกติของสูตร\"",
        "ดูความมั่นใจของสูตรอีกครั้ง และวันที่ของผลทดสอบในแอป (ควรอัปเดตทุกปี)",
        "ห้ามเปลี่ยนกติกากลางทางเพราะขาดทุนช่วงสั้น · ห้ามเพิ่มความเสี่ยงเกิน 1% ต่อไม้"]
    };
    function load() { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } }
    function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* ticks are a convenience */ } }
    function period(kind, now) {
      var d = new Date(now + THAI_OFFSET_S * 1000), day = d.toISOString().slice(0, 10);
      if (kind === "day") return day;
      if (kind === "month") return day.slice(0, 7);
      var monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
      return "w" + monday.toISOString().slice(0, 10);
    }
    function done(kind) { var v = load()[kind]; return v && v.p === period(kind, Date.now()) ? v.done || [] : []; }
    function toggle(kind, i) {
      var all = load(), cur = done(kind).slice(), k = cur.indexOf(i);
      if (k >= 0) cur.splice(k, 1); else cur.push(i);
      all[kind] = { p: period(kind, Date.now()), done: cur };
      save(all);
    }
    // The written plan: what is traded, how much, when it stops. Numbers from the rule's tests.
    function planHtml() {
      var nm = trendNormal(), lad = trendLadder(), risk = trendRiskPct(), dd = nm && nm.port ? fmt(nm.port.maxDD, 1) + "%" : "—";
      var li = function (t) { return "<li>" + t + "</li>"; };
      return "<ol class=\"rt-plan\">" +
        li("<b>สูตรเดียว:</b> Trend 4H · Binance USDⓈ-M Perpetual · เข้าและออกตามแอปเท่านั้น ทั้ง LONG และ SHORT") +
        li("<b>เหรียญ:</b> ผลทดสอบคิดจาก 12 เหรียญ ยิ่งเลือกน้อย ผลยิ่งแกว่ง · เลือกไว้ตอนนี้ " + selectedCoins().length + " เหรียญ") +
        li("<b>ความเสี่ยง:</b> " + risk + "% ของทุนต่อไม้ (ไม่เกิน 1%) · Isolated · Leverage ตามที่แอปคำนวณ (Liquidation ไกลกว่า SL 1.5 เท่า)") +
        li("<b>ออก:</b> SL ตั้งใน Binance ทันที ห้ามเลื่อน · " + (lad ? "ขาย 50% ที่ +3R · ที่เหลือปิดเมื่อแอปเด้ง \"ปิดไม้\"" : "ไม่ตั้ง TP · ปิดเมื่อแอปเด้ง \"ปิดไม้\"")) +
        li("<b>เทรดทุกสัญญาณ:</b> สูตรชนะราว 1 ใน 3 กำไรมาจากไม้ใหญ่ไม่กี่ไม้ การเลือกข้ามไม้ทำให้พลาดไม้ใหญ่") +
        li("<b>หยุด:</b> หยุดเข้าไม้ใหม่เมื่อพอร์ตลงเกิน " + dd + " จากจุดสูงสุด (เกินที่ทดสอบเคยเจอ) หรือสมุดผลจริงขึ้นสีแดง (แย่กว่าที่ทดสอบเคยเจอ) แล้วทบทวนก่อนเทรดต่อ") +
        li("<b>ห้าม:</b> เพิ่มขนาดหลังแพ้ · เทรดนอกสูตร · เปลี่ยนกติกาเพราะแพ้ติดกัน (แพ้ติดกันหลายสิบไม้เคยเกิดขึ้นแล้วในทดสอบ)") + "</ol>";
    }
    function listHtml(kind, title) {
      var d = done(kind);
      return '<div class="rt-list"><div class="rt-hd">' + title + ' <small>' + d.length + "/" + LISTS[kind].length + "</small></div>" + LISTS[kind].map(function (t, i) {
        return '<label class="rt-item' + (d.indexOf(i) >= 0 ? " done" : "") + '"><input type="checkbox" data-rt="' + kind + ":" + i + '"' + (d.indexOf(i) >= 0 ? " checked" : "") + "> " + t + "</label>";
      }).join("") + "</div>";
    }
    function html() {
      var d = done("day").length, n = LISTS.day.length;
      return '<details class="sm-bt rt" id="smRoutine"><summary><b>แผนเทรดและกิจวัตรแบบมืออาชีพ</b> <small>วันนี้ ' + d + "/" + n + (d >= n ? " ✓" : "") + "</small></summary>" +
        '<div class="rt-sec">แผนการเทรด (เขียนไว้ก่อน ทำตามทุกวัน)</div>' + planHtml() +
        listHtml("day", "ทุกวัน") + listHtml("week", "ทุกสัปดาห์") + listHtml("month", "ทุกเดือน") +
        '<div class="rt-sec">สำรอง / กู้คืนข้อมูล</div><small class="muted">ไม้ที่บันทึก สมุดผลจริง และการตั้งค่า อยู่ในมือถือเครื่องนี้เท่านั้น ลบแอป = หาย</small>' +
        '<div class="row" style="margin-top:6px"><button type="button" class="mini" id="rtBackup" style="width:100%;margin:0">สำรองข้อมูล (ส่งเข้า LINE / Drive / อีเมล)</button></div>' +
        '<textarea id="rtRestoreBox" rows="3" placeholder="กู้คืน: วางข้อความสำรองที่นี่" style="width:100%;margin-top:6px;background:var(--deep);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:8px;font:12px ui-monospace,monospace"></textarea>' +
        '<button type="button" class="mini ghost" id="rtRestore" style="width:100%;margin-top:6px">กู้คืนจากข้อความที่วาง</button><div id="rtStatus" class="status-line"></div></details>';
    }
    // Everything the trader built up on this phone, as one JSON text (no keys: the app has none).
    var KEEP = ["portfolio.v1", "paper.v2", "liveCheck", "routine.v1", "alertCoins", "tradeTf", "tpMode", "pfCapital", "pfRisk", "pfTarget", "alertLev", "guide.flags", "floatSeen"];
    function backup() {
      var out = { app: "POC Signal", v: 1, at: Date.now(), data: {} };
      KEEP.forEach(function (k) { try { var v = localStorage.getItem(k); if (v !== null) out.data[k] = v; } catch (e) { /* skip */ } });
      ["pfCapital", "pfRisk", "pfTarget"].forEach(function (id) { if ($(id)) out.data[id] = $(id).value; });
      return JSON.stringify(out);
    }
    function restore(text) {
      var j = JSON.parse(text);
      if (!j || j.app !== "POC Signal" || !j.data) throw new Error("ไม่ใช่ข้อความสำรองของแอปนี้");
      var n = 0;
      Object.keys(j.data).forEach(function (k) { if (KEEP.indexOf(k) >= 0) { localStorage.setItem(k, j.data[k]); n++; } });
      return n;
    }
    function bind(redraw) {
      Array.prototype.forEach.call(document.querySelectorAll("[data-rt]"), function (b) {
        b.onchange = function () { var p = b.getAttribute("data-rt").split(":"); toggle(p[0], +p[1]); redraw(); };
      });
      var st = function (t, err) { if ($("rtStatus")) { $("rtStatus").textContent = t; $("rtStatus").className = "status-line" + (err ? " err" : ""); } };
      if ($("rtBackup")) $("rtBackup").onclick = function () {
        var text = backup();
        if (window.NativeHttp && window.NativeHttp.share) { window.NativeHttp.share("POC Signal สำรองข้อมูล " + thai(Date.now()), text); st("เปิดหน้าส่งแล้ว เลือก LINE / Drive / อีเมล เก็บข้อความไว้"); }
        else { $("rtRestoreBox").value = text; st("คัดลอกข้อความในช่องด้านบนเก็บไว้"); }
      };
      if ($("rtRestore")) $("rtRestore").onclick = function () {
        try { var n = restore($("rtRestoreBox").value.trim()); st("กู้คืนแล้ว " + n + " รายการ · กำลังโหลดใหม่…"); setTimeout(function () { location.reload(); }, 800); }
        catch (e) { st("กู้คืนไม่ได้: " + e.message, true); }
      };
    }
    return { html: html, bind: bind, backup: backup, restore: restore };
  })();

  var Guide = (function () {
    var KEY = "guide.flags";
    function flags() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } }
    function mark(name) { var f = flags(); f[name] = 1; try { localStorage.setItem(KEY, JSON.stringify(f)); } catch (e) { /* ignore */ } render(); }
    function has(key) { try { return !!localStorage.getItem(key); } catch (e) { return false; } }
    var STEPS = [
      { id: "capital", title: "ใส่เงินทุนที่จะใช้เทรด", how: "หน้าแรก → ตั้งค่า → \"เงินทุน (บาท)\" ใส่เงินที่เสียได้ทั้งหมดโดยไม่เดือดร้อน",
        tab: "guideTab", target: "pfCapital", done: function () { return !!flags().capital; } },
      { id: "fomc", title: "ตรวจวันประกาศ FOMC ปี 2026", how: "เปิด federalreserve.gov/monetarypolicy/fomccalendars.htm เทียบกับรายการวันในแอป ผิดตรงไหนแก้ได้เลย แล้วกดปุ่ม \"ตรวจแล้ว ✓\" ใต้รายการ",
        tab: "guideTab", target: "sgFomc", done: function () { return !!flags().fomc; }, confirm: "ตรวจแล้ว ✓" },
      { id: "test2026", title: "ดูผลปี 2026 ว่าสูตรยังได้กำไรไหม", how: "แท็บพอร์ต → ปุ่ม \"ดูผลปี 2026 (ข้อมูลใหม่)\" ถ้า R เฉลี่ยเป็นบวกและ PF มากกว่า 1 = ยังดี แคปส่งให้ผู้ช่วยดูได้",
        tab: "portTab", target: "pp2026", done: function () { return !!flags().test2026; } },
      { id: "paper", title: "เริ่ม Paper Trading", how: "แท็บพอร์ต → ปุ่ม \"เริ่มสมุดผลจริงวันนี้\" แอปจะจดผลของสูตรให้เองนับจากวันนี้ และเทียบกับผลทดสอบ",
        tab: "portTab", target: "ppStart", done: function () { return has("paper.v2"); } },
      { id: "alerts", title: "เปิดแจ้งเตือนสัญญาณ", how: "หน้าแรก → ตั้งค่า → ติ๊ก \"เด้งเมื่อมีสัญญาณเข้าได้\" แล้วกดอนุญาตการแจ้งเตือน (ในแอป Android ตั้งแบตเตอรี่เป็น \"ไม่จำกัด\" ด้วย)",
        tab: "guideTab", target: "autoScan", done: function () { return $("autoScan").checked; } },
      { id: "wait", title: "รอแจ้งเตือน แล้วเปิดดูการ์ดสัญญาณ", how: "สูตรนี้มีสัญญาณประมาณ 5 ครั้งต่อเดือน ช่วง Paper แค่เปิดแท็บพอร์ตดูผลเป็นระยะ ไม่ต้องเปิดไม้จริง",
        tab: "portTab", target: "ppHero", done: function () { return false; }, info: true }
    ];
    function go(step) {
      var btn = document.querySelector('[data-tab="' + step.tab + '"]');
      if (btn) btn.click();
      var el = $(step.target);
      if (!el) return;
      var d = el.closest("details");
      if (d) d.open = true;
      setTimeout(function () {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("flash");
        if (el.focus && /INPUT|TEXTAREA|SELECT/.test(el.tagName) && el.type !== "checkbox") el.focus();
        setTimeout(function () { el.classList.remove("flash"); }, 2500);
      }, 150);
    }
    function render() {
      var required = STEPS.filter(function (s) { return !s.optional && !s.info; });
      var doneCount = required.filter(function (s) { return s.done(); }).length, nextFound = false;
      $("guideProgress").firstChild.style.width = (doneCount / required.length * 100).toFixed(0) + "%";
      $("guideSteps").innerHTML = STEPS.map(function (s, k) {
        var done = s.done(), next = !done && !nextFound && !s.optional;
        if (next) nextFound = true;
        return '<div class="guide-step' + (done ? " done" : "") + (next ? " next" : "") + '"><div class="dot">' + (done ? "✓" : k + 1) + '</div><div class="body"><b>' +
          esc(s.title) + "</b>" + (next ? ' <span class="pill wait">ทำขั้นนี้ต่อ</span>' : "") + "<small class=\"muted\">" + esc(s.how) + '</small><button class="mini' + (next ? "" : " ghost") +
          '" data-go="' + s.id + '">พาไป</button>' + (s.confirm && !done ? ' <button class="mini ghost" data-confirm="' + s.id + '">' + s.confirm + "</button>" : "") + "</div></div>";
      }).join("");
      Array.prototype.forEach.call(document.querySelectorAll(".guide-step"), function (row, k) {
        row.onclick = function (ev) { if (!ev.target.hasAttribute("data-confirm")) go(STEPS[k]); };
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-confirm]"), function (b) {
        b.onclick = function () { mark(b.getAttribute("data-confirm")); };
      });
      renderBar(required, doneCount);
      return doneCount === required.length;
    }

    // The sticky "next step" bar stays off: the user asked for plain trade data, not tutorials (the checklist tab remains).
    function renderBar() {
      $("guideBar").classList.add("hidden");
      document.body.classList.remove("has-guide");
    }
    setInterval(function () { if (!document.hidden) render(); }, 1500);
    $("pfCapital").addEventListener("change", function () { mark("capital"); });
    $("pfCapital").addEventListener("blur", function () { mark("capital"); });
    $("sgFomcOk").addEventListener("click", function () { mark("fomc"); $("sgFomcOk").textContent = "ตรวจแล้ว ✓ (บันทึกแล้ว)"; });
    $("pp2026").addEventListener("click", function () { mark("test2026"); });
    ["sgMode", "sgLock", "autoScan"].forEach(function (id) { $(id).addEventListener("change", render); });
    $("ppStart").addEventListener("click", function () { setTimeout(render, 50); });
    return { render: render };
  })();

  Array.prototype.forEach.call($("mainTabs").children, function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call($("mainTabs").children, function (x) {
        x.classList.toggle("on", x === b);
        $(x.getAttribute("data-tab")).classList.toggle("hidden", x !== b);
      });
      if (last && b.getAttribute("data-tab") === "backtestTab") render();
      if (b.getAttribute("data-tab") === "chartTab") ChartView.open(); else ChartView.stop();
      if (b.getAttribute("data-tab") === "portTab") Paper.refresh();
      if (b.getAttribute("data-tab") === "guideTab") Guide.render();
    };
  });

  // ---- 4H backtest of the user's own techniques (swing.js) ----
  (function () {
    var box = $("swCoins");
    box.innerHTML = COINS.map(function (c, k) {
      return '<label><input type="checkbox" value="' + c + '"' + (k < 5 ? " checked" : "") + "> " + c.replace("USDT", "") + "</label>";
    }).join("");
    $("swRun").onclick = function () {
      var coins = Array.prototype.filter.call(box.querySelectorAll("input"), function (x) { return x.checked; }).map(function (x) { return x.value; });
      if (!coins.length) { $("swStatus").textContent = "เลือกอย่างน้อย 1 เหรียญ"; return; }
      var days = parseInt($("swDays").value, 10), data = {}, done = 0, tf = $("swTf").value, step = tf === "1h" ? 3600000 : 14400000;
      $("swRun").disabled = true; $("swStatus").className = "status-line"; $("swStatus").textContent = "กำลังดึงแท่ง " + tf + "…";
      futuresApi("/fapi/v1/time").then(function (t) {
        var end = Math.floor(t.serverTime / step) * step, start = end - days * 86400000;
        return Promise.all(coins.map(function (c) {
          return fetchCandles(c, start, end, function () {}, tf, true).then(function (rows) {
            data[c] = rows; done++; $("swStatus").textContent = "ดึงแล้ว " + done + "/" + coins.length + " เหรียญ";
          }).catch(function (e) { $("swStatus").textContent = c + ": " + e.message; });
        }));
      }).then(function () {
        var r = Swing.evaluate(data, { fee: FUT.fee, slippage: FUT.slippage, risk: 0.01 });
        renderSwing(r, Object.keys(data));
        $("swStatus").textContent = "เสร็จ · " + Object.keys(data).length + " เหรียญ · " + days + " วัน · กราฟ " + tf;
      }).catch(function (e) { $("swStatus").className = "status-line err"; $("swStatus").textContent = e.message; })
        .then(function () { $("swRun").disabled = false; });
    };
    function renderSwing(r, coins) {
      var best = r.chosen && r.techniques.filter(function (x) { return x.id === r.chosen; })[0], h = r.holdout;
      var html;
      if (best && h.trades >= 30 && h.exp_r > 0 && (h.pf || 0) > 1) {
        html = '<div class="banner go">ผ่าน: ' + esc(best.name) + "</div><small>เลือกจาก Valid แล้วผ่าน Holdout: " + h.trades + " ไม้ · win " + fmt(h.win_rate, 1) +
          "% · เฉลี่ย " + fmt(h.exp_r, 2, true) + "R/ไม้ · PF " + fmt(h.pf, 2) + " · ถ้าเสี่ยง 1%/ไม้: " + fmt(h.return_pct, 1, true) + "% (DD " + fmt(h.max_dd_pct, 1) + "%)</small>";
      } else if (best) {
        html = '<div class="banner wait">NOT VALIDATED · ยังไม่ผ่าน</div><small>' + esc(best.name) + " ถูกเลือกจากช่วง Valid แต่ Holdout: " + h.trades + " ไม้ · win " + fmt(h.win_rate, 1) +
          "% · " + fmt(h.exp_r, 2, true) + "R/ไม้ · PF " + fmt(h.pf, 2) + "</small>";
      } else {
        html = '<div class="banner wait">ยังไม่มีเทคนิคที่ได้เปรียบ</div><small>ไม่มีเทคนิคไหนกำไรเฉลี่ยต่อไม้เป็นบวกทั้ง Dev และ Valid (และ Valid ≥ 30 ไม้) หลังหักค่าธรรมเนียม</small>';
      }
      $("swBest").innerHTML = html;
      var cell = function (x) { return x.trades + " · " + fmt(x.win_rate, 0) + '%<br><span class="' + tone(x.exp_r) + '">' + fmt(x.exp_r, 2, true) + "R</span> · PF " + fmt(x.pf, 2); };
      $("swTable").innerHTML = r.techniques.map(function (t) {
        return "<tr><td>" + esc(t.name) + (t.id === r.chosen ? '<br><small class="muted">ถูกเลือกจากช่วง Valid (ก่อนดู Holdout)</small>' : "") + '<br><small class="muted">' + esc(t.source) +
          "</small></td><td>" + cell(t.development) + "</td><td>" + cell(t.validation) + "</td><td>" + cell(t.holdout) + "</td><td>" + validBadge(t.validated) + "</td></tr>";
      }).join("");
      $("swNote").textContent = "Holdout ของทุกเทคนิคแสดงเพื่อตรวจสอบเท่านั้น ไม่ได้ใช้เลือกหรือจัดอันดับ · VALIDATED = Dev และ Valid เป็นบวก (Valid ≥ 30 ไม้) และ Holdout ≥ 30 ไม้ R เฉลี่ยเป็นบวก PF > 1 · ทดสอบ " +
        r.techniques.length + " เทคนิคพร้อมกัน ยิ่งลองมากยิ่งมีโอกาสผ่านโดยบังเอิญ";
      var years = {};
      r.techniques.forEach(function (t) { t.yearly.forEach(function (y) { years[y.year] = 1; }); });
      years = Object.keys(years).sort();
      $("swYearHead").innerHTML = "<tr><th>เทคนิค</th>" + years.map(function (y) { return "<th>" + y + "</th>"; }).join("") + "</tr>";
      $("swYears").innerHTML = r.techniques.map(function (t) {
        var map = {};
        t.yearly.forEach(function (y) { map[y.year] = y.stats; });
        return "<tr><td>" + esc(t.name) + "</td>" + years.map(function (y) {
          var st = map[y];
          return st ? '<td class="' + tone(st.exp_r) + '">' + fmt(st.exp_r, 2, true) + "R<br><small>" + st.trades + " · " + fmt(st.win_rate, 0) + "%</small></td>" : "<td>—</td>";
        }).join("") + "</tr>";
      }).join("");
      $("swResults").classList.remove("hidden");
    }
  })();

  loadSettings();
  Portfolio.render();
  $("run").onclick = run;
  if (location.hash === "#bg") scan();
  else { Simple.show(true); scan(); News.start(Simple.redrawNews); }
})();
