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

  function httpGet(url) {
    if (window.NativeHttp) {
      return new Promise(function (resolve, reject) {
        var id = "r" + (++nextId);
        pending[id] = { resolve: resolve, reject: reject };
        window.NativeHttp.get(id, url);
      });
    }
    return fetch(url).then(function (r) {
      return r.text().then(function (t) { if (!r.ok) throw new Error("HTTP " + r.status + " " + t); return t; });
    });
  }

  function httpPost(url, body) {
    if (window.NativeHttp && window.NativeHttp.post) {
      return new Promise(function (resolve, reject) {
        var id = "p" + (++nextId);
        pending[id] = { resolve: resolve, reject: reject };
        window.NativeHttp.post(id, url, body);
      });
    }
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body }).then(function (r) {
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
  function tone(v) { return !isFinite(v) || v === 0 ? "" : v > 0 ? "up" : "down"; }
  function thai(ms) {
    var d = new Date(ms + THAI_OFFSET_S * 1000);
    function p(n) { return String(n).padStart(2, "0"); }
    return p(d.getUTCDate()) + "/" + p(d.getUTCMonth() + 1) + "/" + String(d.getUTCFullYear()).slice(2) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }

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
    $("variants").innerHTML = rs.variants.map(function (v) {
      var d = v.development, a = v.validation;
      return "<tr><td>" + esc(VARIANT_NAMES[v.name]) + (v.name === rs.chosen ? " ✓" : "") + "</td><td>" + fmt(d.win_rate_pct, 1) + "%</td><td>" +
        fmt(d.profit_factor, 2) + "</td><td>" + a.trade_count + "</td><td>" + fmt(a.win_rate_pct, 1) + "%</td><td>" + fmt(a.profit_factor, 2) + "</td></tr>";
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
      if (dd >= HARD_STOP_DD) { state = "stop"; riskPct = 0; message = "หยุดเทรด: ยอดลงจากจุดสูงสุด " + fmt(dd, 1) + "% (เกณฑ์ " + HARD_STOP_DD + "%) ทบทวนระบบก่อนเทรดต่อ"; }
      else if (todayPnl <= -dayStart * DAILY_STOP / 100) { state = "day"; riskPct = 0; message = "หยุดวันนี้: ขาดทุนวันนี้ถึง " + DAILY_STOP + "% แล้ว พรุ่งนี้ค่อยเทรดใหม่"; }
      else if (dd >= HALF_RISK_DD) { state = "half"; riskPct = st.risk / 2; message = "ยอดลง " + fmt(dd, 1) + "% จากจุดสูงสุด: ลดความเสี่ยงเหลือครึ่งหนึ่ง (" + fmt(riskPct, 2) + "% ต่อไม้) จนกว่าจะกลับมา"; }
      return { settings: st, balance: balance, peak: peak, dd: dd, riskPct: riskPct, riskThb: balance * riskPct / 100,
        state: state, message: message, closed: closed, todayPnl: todayPnl };
    }

    function open(sig) {
      data.trades.push({ id: data.nextId++, symbol: sig.symbol, entry: sig.entry, stop: sig.stop, target: sig.target,
        qty: sig.qty, fx: sig.fx, risk: sig.risk, dir: sig.dir || 1, fee: sig.fee, lev: sig.lev, tps: sig.tps,
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
        ["ลงจากจุดสูงสุด", fmt(p.dd, 1) + "%", "ลดเสี่ยงที่ " + HALF_RISK_DD + "% · หยุดที่ " + HARD_STOP_DD + "%"]
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
          '<br><small>SL <span class="down">' + price(t.stop) + "</span> · " + (t.tps ? "TP " + t.tps.map(price).join(" / ") : 'เป้า <span class="up">' + price(t.target) + "</span>") +
          " · เสี่ยง " + fmt(t.risk, 0) + " ฿ · ปิดภายใน " + thai(t.entry_time + (t.hold_hours || 4) * 3600000).slice(0, 14) + ' น.</small><div class="inline"><input type="number" inputmode="decimal" step="any" placeholder="ราคาที่ปิด" id="exit' + t.id +
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
    return { plan: plan, open: open, render: render };
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

  // ---- Google Gemini analysis (user's own API key, stored on this device only) ----
  var AI = (function () {
    var BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
    // Several keys: when one is out of quota or rejected, the next one is tried and remembered.
    function keys() {
      try { var a = JSON.parse(localStorage.getItem("aiKeys") || "[]"); if (Array.isArray(a)) return a; } catch (e) { /* ignore */ }
      return [];
    }
    var idx = 0;
    try { idx = parseInt(localStorage.getItem("aiKeyIdx") || "0", 10) || 0; } catch (e) { /* ignore */ }
    function key() { var a = keys(); return a.length ? a[idx % a.length] : ""; }
    function useKey(k) {
      idx = Math.max(0, keys().indexOf(k));
      try { localStorage.setItem("aiKeyIdx", String(idx)); } catch (e) { /* ignore */ }
    }
    function saveKeys(a) {
      try { localStorage.setItem("aiKeys", JSON.stringify(a)); } catch (e) { /* ignore */ }
      $("aiKey").value = a[0] || "";
      renderKeys();
    }
    var keyState = {};
    function renderKeys() {
      var a = keys();
      $("aiKeyList").innerHTML = a.length ? a.map(function (k, i) {
        var st = keyState[k];
        return '<div class="keyrow"><span>คีย์ ' + (i + 1) + '</span><code>' + esc(k.slice(0, 4) + "…" + k.slice(-4)) + "</code>" +
          (st ? '<span class="st ' + (st.ok ? "up" : "down") + '">' + esc(st.text) + "</span>" : "") +
          '<button class="x" data-delkey="' + i + '" type="button">✕</button></div>';
      }).join("") : '<p class="muted" style="margin:0;font-size:13px">ยังไม่มีคีย์ · ไม่ใส่ก็ใช้แอปได้ แค่ไม่มี AI ช่วยเช็กข่าว</p>';
      Array.prototype.forEach.call(document.querySelectorAll("[data-delkey]"), function (b) {
        b.onclick = function () { var list = keys(); list.splice(+b.getAttribute("data-delkey"), 1); saveKeys(list); };
      });
    }
    function addKey(text) {
      var k = (text || "").trim();
      if (!/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) return false;
      var a = keys();
      if (a.indexOf(k) < 0) a.push(k);
      saveKeys(a);
      return true;
    }
    var FALLBACK = "gemini-flash-latest";
    function model() { return ($("aiModel").value || FALLBACK).trim(); }
    function status(t, err) { $("aiStatus").textContent = t; $("aiStatus").className = "status-line" + (err ? " err" : ""); }

    // Google retires models; when it answers 404 and names a replacement ("use models/xyz"), switch to it, remember it and retry once.
    function post(m, retry, body, k, left) {
      k = k || key();
      if (left === undefined) left = keys().length - 1;
      return httpPost(BASE + encodeURIComponent(m) + ":generateContent?key=" + encodeURIComponent(k), JSON.stringify(body)).then(function (t) {
        useKey(k);
        return t;
      }, function (e) {
        var msg = String(e.message || e);
        if (left > 0 && /HTTP (429|403)|HTTP 400[\s\S]*API.?key|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
          var a = keys(), next = a[(a.indexOf(k) + 1) % a.length];
          return post(m, retry, body, next, left - 1);
        }
        var gone = /HTTP 404|no longer available|not found/i.test(msg);
        if (!retry || !gone) throw friendly(msg);
        var hint = (msg.match(/models\/([A-Za-z0-9._-]+)/g) || []).map(function (x) { return x.slice(7); }).filter(function (x) { return x !== m; })[0];
        var next = hint || (m !== FALLBACK ? FALLBACK : null);
        if (!next) throw friendly(msg);
        $("aiModel").value = next;
        try { localStorage.setItem("aiModel", next); } catch (x) { /* ignore */ }
        return post(next, false, body, k, left);
      });
    }
    function friendly(msg) {
      var j = null; try { j = JSON.parse(msg.slice(msg.indexOf("{"))); } catch (e) { /* not JSON */ }
      var code = /HTTP (\d+)/.exec(msg), text = j && j.error && j.error.message ? j.error.message : msg;
      var th = code && code[1] === "400" && /API key/i.test(text) ? "คีย์ไม่ถูกต้อง ลบแล้ววางคีย์ใหม่" :
        code && code[1] === "403" ? "คีย์นี้ใช้ Gemini ไม่ได้ (ยังไม่เปิดสิทธิ์)" : code && code[1] === "429" ? "โควตาฟรีหมด รอสักพักหรือเพิ่มคีย์" :
        code && code[1] === "404" ? "หาโมเดลไม่เจอ ลองล้างช่อง Model ให้ว่างแล้วกดทดสอบใหม่" : "";
      return new Error((th ? th + " · " : "") + (code ? "HTTP " + code[1] + " · " : "") + text.slice(0, 200));
    }

    function ask(prompt, search) {
      if (!key()) return Promise.reject(new Error("ยังไม่ได้ใส่ Gemini API key (หน้าแรก → AI)"));
      var body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1200 } };
      if (search) body.tools = [{ google_search: {} }];
      return post(model(), true, body).then(JSON.parse).then(function (res) {
          var c = res.candidates && res.candidates[0];
          var text = c && c.content && c.content.parts ? c.content.parts.map(function (x) { return x.text || ""; }).join("") : "";
          if (!text) throw new Error("Gemini ไม่ตอบข้อความ" + (res.promptFeedback ? " (" + JSON.stringify(res.promptFeedback).slice(0, 120) + ")" : ""));
          var chunks = (c.groundingMetadata && c.groundingMetadata.groundingChunks) || [];
          var sources = chunks.map(function (g) { return g.web; }).filter(Boolean).slice(0, 5);
          var m = /คำตัดสิน\s*[:：]\s*(เข้า|รอ|ข้าม)/.exec(text);
          return { text: text.trim(), sources: sources, verdict: m ? m[1] : "ดูรายละเอียด" };
        });
    }

    function box(res) {
      var tone = res.verdict === "เข้า" ? "go" : res.verdict === "ข้าม" ? "stop" : "wait";
      return '<div class="ai"><span class="pill ' + (tone === "go" ? "go" : tone === "stop" ? "no" : "wait") + '">AI: ' + esc(res.verdict) + "</span>\n" + esc(res.text) +
        (res.sources.length ? "\n\nแหล่งข่าว:\n" + res.sources.map(function (w) { return '• <a href="' + esc(w.uri) + '" target="_blank" rel="noopener">' + esc(w.title || w.uri) + "</a>"; }).join("\n") : "") +
        '\n<small class="muted">ความเห็น AI ไม่ได้ผ่าน backtest ใช้ประกอบการตัดสินใจเท่านั้น</small></div>';
    }

    function signalPrompt(r) {
      var g = r.signal, coin = r.symbol.replace("USDT", "");
      return [
        "คุณคือผู้ช่วยตรวจความเสี่ยงก่อนเปิดไม้ Crypto Futures ตอบเป็นภาษาไทย สั้น กระชับ",
        "กฎ: ใช้ตัวเลขที่ให้มาเท่านั้น ห้ามแต่งราคาหรือสถิติเพิ่ม; ใช้ Google Search หาข่าวใน 24 ชม. ล่าสุดของ " + coin +
          " และตลาด crypto/เศรษฐกิจสหรัฐที่กระทบราคา (CPI, FOMC, ETF, hack, delist, liquidation ใหญ่) ถ้าไม่พบให้บอกว่าไม่พบ ห้ามเดาข่าว",
        "สัญญาณทดลองจากระบบ (" + g.stratName + " แท่ง " + TF[g.tf].name + " ยังไม่พิสูจน์ว่าทำกำไร):",
        "- เหรียญ " + r.symbol + " ฝั่ง " + (g.dir > 0 ? "LONG" : "SHORT") + " เข้า " + price(g.entry) + " SL " + price(g.stop) + " (" + fmt(g.stopPct, 2) + "%)",
        "- TP1/TP2/TP3 " + g.tps.map(price).join(" / ") + " ถือไม่เกิน " + g.hold + " ชม.",
        "- แนวโน้ม EMA50/200 แท่งเดียวกัน: " + (g.trend > 0 ? "ขาขึ้น" : g.trend < 0 ? "ขาลง" : "ไม่ชัด"),
        "- หลักฐานย้อนหลังของสูตรนี้กับเหรียญนี้: " + evidenceFor(r.symbol, g.tf).text,
        "- Leverage เพดาน x" + g.lev + ", ราคา Liquidate ประมาณ " + price(g.liq) + " (ไม่มีตาราง bracket จริง)",
        "ห้ามให้ตัวเลขความน่าจะเป็นหรือ % โอกาสชนะของไม้นี้ ห้ามแต่งสถิติ ถ้าข้อมูลไม่พอให้บอกว่าไม่พอ",
        "ตอบตามรูปแบบนี้เท่านั้น:",
        "คำตัดสิน: เข้า หรือ รอ หรือ ข้าม (เลือกคำเดียว)",
        "เหตุผล: 3 ข้อสั้น",
        "ข่าว: 1–3 ข่าวสำคัญพร้อมเวลา หรือ \"ไม่พบข่าวสำคัญ\"",
        "ความเสี่ยง: 1–2 ข้อ",
        "Leverage: ยืนยัน x" + g.lev + " หรือแนะนำให้ต่ำลง พร้อมเหตุผลสั้น"
      ].join("\n");
    }

    function analyseSignal(r, manual) {
      var el = $("ai-" + r.symbol);
      if (el) el.innerHTML = '<div class="ai muted">AI กำลังวิเคราะห์และค้นข่าว…</div>';
      return ask(signalPrompt(r), true).then(function (res) {
        r.ai = res;
        if ($("ai-" + r.symbol)) $("ai-" + r.symbol).innerHTML = box(res);
      }).catch(function (e) {
        if ($("ai-" + r.symbol)) $("ai-" + r.symbol).innerHTML = '<div class="ai down">AI: ' + esc(e.message) + "</div>";
        if (manual) status(e.message, true);
      });
    }

    function auto(results) {
      if (!$("aiAuto").checked || !key()) return Promise.resolve();
      var list = results.filter(function (r) { return r.signal; });
      return list.reduce(function (chain, r) { return chain.then(function () { return analyseSignal(r, false); }); }, Promise.resolve());
    }

    function analyseChart(ctx) {
      var a = ctx.a, prompt = [
        "คุณคือผู้ช่วยวิเคราะห์กราฟ Crypto Futures ตอบภาษาไทย สั้น กระชับ ใช้ตัวเลขที่ให้มาเท่านั้น และใช้ Google Search หาข่าว 24 ชม. ล่าสุดของ " + ctx.symbol.replace("USDT", ""),
        "กราฟ " + ctx.symbol + " timeframe " + ctx.tf + " ราคา " + price(a.price),
        "EMA20 " + price(a.e20) + " EMA50 " + price(a.e50) + " EMA200 " + price(a.e200) + " RSI14 " + fmt(a.rsi, 1),
        "Swing ล่าสุด: สูง " + price(a.hi) + " ต่ำ " + price(a.lo) + " (" + (a.upSwing ? "ขาขึ้นจากต่ำไปสูง" : "ขาลงจากสูงไปต่ำ") + ")",
        "Fibonacci: " + Object.keys(a.fib).map(function (k) { return k + "=" + price(a.fib[k]); }).join(", ") + " · Ext 1.272=" + price(a.ext[1.272]) + " 1.618=" + price(a.ext[1.618]),
        "เทรนด์ไลน์: แนวรับ " + (a.sup === null ? "ไม่มี" : price(a.sup)) + ", แนวต้าน " + (a.res === null ? "ไม่มี" : price(a.res)),
        "แท่งล่าสุด (เวลา UTC, O/H/L/C): " + ctx.recent,
        "ตอบตามรูปแบบนี้:",
        "คำตัดสิน: เข้า หรือ รอ หรือ ข้าม",
        "ฝั่ง: LONG หรือ SHORT หรือ ไม่มี",
        "แผน: จุดเข้า / SL / TP1 / TP2 / TP3 อ้างอิงระดับข้างบนเท่านั้น",
        "Leverage แนะนำ: x? โดย Liquidate ต้องไกลกว่า SL อย่างน้อย 1.5 เท่า (สมมติ maintenance margin 0.5%)",
        "ข่าว: 1–3 ข่าว หรือ \"ไม่พบข่าวสำคัญ\"",
        "ความเสี่ยง: 1–2 ข้อ"
      ].join("\n");
      $("cvAiOut").innerHTML = '<div class="ai muted">AI กำลังวิเคราะห์และค้นข่าว…</div>';
      ask(prompt, true).then(function (res) { $("cvAiOut").innerHTML = box(res); })
        .catch(function (e) { $("cvAiOut").innerHTML = '<div class="ai down">AI: ' + esc(e.message) + "</div>"; });
    }

    try {
      var old = localStorage.getItem("aiKey");
      if (old && !keys().length) localStorage.setItem("aiKeys", JSON.stringify([old]));
      localStorage.removeItem("aiKey");
    } catch (e) { /* ignore */ }
    saveKeys(keys());
    ["aiModel", "aiAuto"].forEach(function (id) {
      try {
        var v = localStorage.getItem(id);
        if (v !== null) { if (id === "aiAuto") $(id).checked = v === "1"; else $(id).value = v; }
      } catch (e) { /* ignore */ }
      $(id).addEventListener("change", function () {
        try { localStorage.setItem(id, id === "aiAuto" ? ($(id).checked ? "1" : "0") : $(id).value.trim()); } catch (e) { /* ignore */ }
      });
    });
    $("aiPaste").onclick = function () {
      var done = function (text) {
        if (!addKey(text)) { status("ในคลิปบอร์ดยังไม่มีคีย์ที่ขึ้นต้นด้วย AIza · ไปกด ① คัดลอกคีย์ก่อน", true); return; }
        status("เพิ่มคีย์แล้ว (" + keys().length + " คีย์) · กดทดสอบคีย์ได้เลย");
      };
      if (window.NativeHttp && window.NativeHttp.clipboard) { done(window.NativeHttp.clipboard()); return; }
      if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(done, function () { done(""); });
      else done("");
    };
    $("aiTest").onclick = function () {
      var a = keys();
      if (!a.length) { status("ยังไม่มีคีย์ · กด ① เอาคีย์ แล้ว ② วางคีย์", true); return; }
      status("กำลังทดสอบ " + a.length + " คีย์…");
      var body = { contents: [{ role: "user", parts: [{ text: "ตอบคำเดียวว่า พร้อม" }] }], generationConfig: { temperature: 0, maxOutputTokens: 20 } }, good = 0;
      a.reduce(function (chain, k) {
        return chain.then(function () {
          return post(model(), true, body, k, 0).then(function () { good++; keyState[k] = { ok: true, text: "ใช้ได้" }; },
            function (e) { keyState[k] = { ok: false, text: e.message.split(" · ")[0].slice(0, 40) }; }).then(renderKeys);
        });
      }, Promise.resolve()).then(function () {
        status(good ? "ใช้ได้ " + good + "/" + a.length + " คีย์ · โมเดล " + model() : "ไม่มีคีย์ที่ใช้ได้", !good);
      });
    };
    return { ask: ask, auto: auto, analyseSignal: analyseSignal, analyseChart: analyseChart };
  })();

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
      var el = $("ppChart");
      el.classList.toggle("hidden", rows.length < 2);
      if (chart) { chart.remove(); chart = null; }
      if (rows.length >= 2) {
        chart = LightweightCharts.createChart(el, baseOptions(el));
        var line = chart.addAreaSeries({ lineColor: profit >= 0 ? "#0ecb81" : "#f6465d", topColor: profit >= 0 ? "rgba(14,203,129,.3)" : "rgba(246,70,93,.3)",
          bottomColor: "rgba(0,0,0,0)", lineWidth: 2, priceFormat: { type: "price", precision: 0, minMove: 1 } });
        var seen = {}, data = [];
        curve.forEach(function (pt) { if (seen[pt.time]) data[data.length - 1].value = pt.value; else { seen[pt.time] = 1; data.push(pt); } });
        line.setData(data);
        line.createPriceLine({ price: capital, color: "#848e9c", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "ทุน" });
        chart.timeScale().fitContent();
      }
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
  // The Android scanner and the visible scanner share persisted M5/M15/H1 settings.
  var TF = { "1h": { ms: 3600000, days: 100, name: "1 ชม." }, "15m": { ms: 900000, days: 30, name: "15 นาที" }, "5m": { ms: 300000, days: 14, name: "5 นาที" } };
  // One place that changes the signal timeframe, so the visible scanner and the Android alarm never disagree.
  function setTradeTf(v) {
    if (!TF[v]) return;
    try { localStorage.setItem("tradeTf", v); } catch (e) { /* ignore */ }
    if ($("alertTf")) $("alertTf").value = v;
    if (window.NativeHttp && window.NativeHttp.setScanMinutes) window.NativeHttp.setScanMinutes(TF[v].ms / 60000);
  }
  function curTf() {
    var t = "15m";
    try { t = localStorage.getItem("tradeTf") || "15m"; } catch (e) { /* ignore */ }
    return TF[t] ? t : "15m";
  }

  var lastFutures = [];

  // ---- Main screen: a Binance-Futures look-alike that coaches every tap, sized from the user's own money ----
  var Simple = (function () {
    var lastScan = 0, timer = null, results = [], fx = 33, pick = 0, step = 0, live = null, liveSym = "", busyNow = false;
    function money() { return readNumber("pfCapital", 10000); }
    function signals() {
      var now = Date.now();
      return results.filter(function (r) { return r.signal && !r.signal.below_minimum && now < r.signal.expires; })
        .sort(function (a, b) { return (b.symbol === LOCK.symbol) - (a.symbol === LOCK.symbol); });
    }
    // Sizes scale linearly with the balance, so a new amount needs no rescan.
    function sized(g) {
      var f = money() / (g.balanceUsdt * fx), qty = g.qty * f, notional = qty * g.entry;
      var cost = notional * 2 * (FUT.fee + FUT.slippage);
      return { qty: qty, notional: notional, marginB: notional / g.lev * fx, lossB: g.riskUsdt * f * fx,
        winB: (qty * Math.abs(g.tps[2] - g.entry) - cost) * fx, avbl: money() / fx };
    }
    function qtyTxt(q) { return q >= 1 ? fmt(q, 3) : q.toPrecision(3); }
    function stepsFor(r, g, z) {
      var coin = r.symbol.replace("USDT", ""), long = g.dir > 0, pct = Math.max(0.1, g.sliderPct), pctTxt = fmt(pct, pct < 10 ? 1 : 0) + "%";
      return [
        { t: "nav", text: "เปิดแอป Binance แตะ <b>Futures</b> ที่แถบล่าง (ไม่ใช่ Spot)" },
        { t: "sym", text: "แตะชื่อเหรียญด้านบน พิมพ์ค้นหา <b>" + r.symbol + "</b> แล้วเลือกตัวที่มีคำว่า <b>Perp</b>" },
        { t: "mode", text: "แตะ <b>Cross</b> → เลือก <b>Isolated</b> → กด Confirm" },
        { t: "lev", text: "แตะตัวเลข Leverage → ตั้งเป็น <b>" + g.lev + "x</b> → กด Confirm" },
        { t: "type", text: "แตะแท็บ <b>Open</b> แล้วเลือกชนิดคำสั่ง <b>Market</b>" },
        { t: "size", text: "ลากสไลเดอร์ไปที่ <b>" + pctTxt + "</b> หรือพิมพ์ Size <b>" + qtyTxt(z.qty) + " " + coin + "</b><br>= ลงเงิน (Margin) ประมาณ <b>" + fmt(z.marginB, 0) + " บาท</b>" },
        { t: "tpsl", text: "ติ๊ก <b>TP/SL</b> แล้วใส่ Take Profit <b class=\"up\">" + price(g.tps[2]) + "</b> และ Stop Loss <b class=\"down\">" + price(g.stop) + "</b>" },
        { t: "buy", text: "กด <b class=\"" + (long ? "up" : "down") + "\">" + (long ? "Buy/Long" : "Sell/Short") + "</b> ถ้ามีหน้ายืนยัน กด <b>Confirm</b>" },
        { t: "done", text: "เสร็จแล้ว! ถ้าโดน SL เสียประมาณ <b class=\"down\">" + fmt(z.lossB, 0) + " ฿</b> · ถ้าถึง TP ได้ประมาณ <b class=\"up\">" + fmt(z.winB, 0) +
          " ฿</b><br>ถ้าครบ " + fmt(g.hold, g.hold < 10 ? 1 : 0) + " ชม. ยังไม่ชน ให้ไปที่ Positions กด Close" }
      ];
    }
    function screen(r, g, z) {
      var sym = r ? r.symbol : LOCK.symbol, coin = sym.replace("USDT", ""), on = function (k) { return g && steps[step] && steps[step].t === k ? " coach-on" : ""; };
      var past = function (k) { if (!g) return false; for (var i = 0; i < step; i++) if (steps[i].t === k) return true; return steps[step] && steps[step].t === "done"; };
      var long = g ? g.dir > 0 : true, pct = g ? Math.max(0.1, Math.min(100, g.sliderPct)) : 0, slid = past("size") ? pct : 0;
      var ticks = [0, 25, 50, 75, 100].map(function (x) { return '<span class="tick" style="left:' + x + '%"></span>'; }).join("");
      return '<div class="tx' + (g ? "" : " idle") + '">' +
        '<div class="tx-top"><div class="tx-seg"><span>Spot</span><span class="on' + on("nav") + '" data-k="nav">Futures</span></div></div>' +
        '<div class="tx-hd' + on("sym") + '" data-k="sym"><b>' + sym + '</b> <small>Perp ▾</small> <span id="txChg" class="tx-chg">—</span></div>' +
        '<div class="tx-body"><div class="tx-form">' +
          '<div class="tx-chips"><span class="' + on("mode") + '" data-k="mode">' + (past("mode") ? "Isolated" : "Cross") + '</span><span class="' + on("lev") + '" data-k="lev">' + (past("lev") ? g.lev : 20) + "x</span></div>" +
          '<div class="tx-tabs' + on("type") + '" data-k="type"><span class="on">Open</span><span>Close</span></div>' +
          '<div class="tx-avbl"><small>Avbl</small><span>' + fmt(z ? z.avbl : money() / fx, 2) + " USDT</span></div>" +
          '<div class="tx-fld' + on("type") + '" data-k="type"><span>' + (past("type") ? "Market" : "Limit") + "</span><small>▾</small></div>" +
          '<div class="tx-fld' + on("size") + '" data-k="size"><small>Size</small><span>' + (past("size") ? qtyTxt(z.qty) : "") + " <small>" + coin + "</small></span></div>" +
          '<div class="tx-sl' + on("size") + '" data-k="size"><span class="ln"></span><span class="fill" style="width:' + slid + '%"></span>' + ticks + '<span class="kb" style="left:' + slid + '%"></span></div>' +
          (g ? '<div class="tx-pct">' + (past("size") ? fmt(pct, pct < 10 ? 1 : 0) + "%" : "&nbsp;") + "</div>" : "") +
          '<div class="tx-ck' + on("tpsl") + '" data-k="tpsl"><i>' + (past("tpsl") ? "✓" : "") + "</i>TP/SL</div>" +
          (past("tpsl") ? '<div class="tx-fld sm"><small>Take Profit</small><span class="up">' + price(g.tps[2]) + '</span></div><div class="tx-fld sm"><small>Stop Loss</small><span class="down">' + price(g.stop) + "</span></div>" : "") +
          '<div class="tx-btn buy' + (long ? on("buy") : " dim") + '"' + (long ? ' data-k="buy"' : "") + ">Buy/Long</div>" +
          '<div class="tx-btn sell' + (long ? " dim" : on("buy")) + '"' + (long ? "" : ' data-k="buy"') + ">Sell/Short</div>" +
        '</div><div class="tx-book" id="txBook"><div class="bk-h"><span>Price</span><span>Amount</span></div><div id="txAsks"></div><div class="bk-mid" id="txPrice">' +
          (r ? price(r.close) : "—") + '</div><div id="txBids"></div></div></div>' +
        '<div class="tx-pos"><span class="on">Positions (0)</span><span>Open Orders (0)</span></div>' +
        '<div class="tx-nav"><span>Home</span><span>Markets</span><span>Trade</span><span class="on' + on("nav") + '" data-k="nav">Futures</span><span>Assets</span></div>' +
        "</div>";
    }
    var steps = [];
    function draw() {
      var list = signals(), r = list[pick] || null, g = r && r.signal, z = g ? sized(g) : null;
      steps = g ? stepsFor(r, g, z) : [];
      var tf = curTf(), head = '<div class="sm-tf">' + ["1h", "15m", "5m"].map(function (k) {
        return '<button type="button" data-tf="' + k + '" class="' + (k === tf ? "on" : "") + '">' + TF[k].name + (k === "1h" ? " (สูตรเดิม)" : " (ทดลอง)") + "</button>";
      }).join("") + "</div>";
      // Research evidence (2026, data the rule never saw) for the selected coins on this timeframe; never in-sample numbers.
      var E = window.EVIDENCE, n = 0, sumR = 0, tp = 0, used = [];
      selectedCoins().forEach(function (c) {
        var o = E && E.rows && E.rows[c + "|" + tf] && E.rows[c + "|" + tf].oos;
        if (o && o.n) { n += o.n; sumR += o.n * o.avgR; tp += o.n * o.tp5 / 100; used.push(c.replace("USDT", "")); }
      });
      var baht = sumR * money() * LOCK.riskPct / 100;
      head += '<div class="sm-exp">โหมดทดลอง · Paper เท่านั้น · สัญญาณไม่ใช่คำสั่งซื้อขาย</div>' +
        '<div class="sm-bt ' + (n >= 30 ? (sumR > 0 ? "good" : "bad") : "") + '">' + (n >= 30
          ? "หลักฐาน " + E.periods.oos + " (" + used.join(", ") + " · " + TF[tf].name + "): " + n + " ไม้ · ถึง TP 5R " + fmt(tp / n * 100, 0) + "% · เฉลี่ย " +
            fmt(sumR / n, 2, true) + "R/ไม้ = <b>" + (baht >= 0 ? "ได้ +" : "เสีย ") + fmt(baht, 0) + " ฿</b> ถ้าเสี่ยง 0.25%/ไม้" +
            (sumR <= 0 ? "<br><small>ผลย้อนหลังขาดทุน: อย่าใช้เงินจริงกับกราฟนี้</small>" : "")
          : "ยังไม่มีข้อมูลยืนยันสำหรับเหรียญ/กราฟที่เลือก") + "</div>";
      if (list.length) {
        head += '<div class="sm-pick">' + list.map(function (x, i) {
          var d = x.signal.dir > 0;
          return '<button type="button" class="' + (i === pick ? "on " : "") + (d ? "l" : "s") + '" data-pick="' + i + '">' + x.symbol.replace("USDT", "") + " " + (d ? "LONG" : "SHORT") + "</button>";
        }).join("") + "</div>" +
          '<div class="sm-sum">ลงเงิน <b>' + fmt(z.marginB, 0) + ' ฿</b> · โดน SL เสีย <b class="down">' + fmt(z.lossB, 0) + ' ฿</b> · ถึง TP ได้ <b class="up">' + fmt(z.winB, 0) + " ฿</b>" +
          "<br><small>สัญญาณ " + TF[tf].name + " · หมดอายุ " + thai(g.expires).slice(9) + " น." +
          (r.ai ? " · AI เช็กข่าว: " + esc(r.ai.verdict) : "") + "</small>" +
          (function (ev) { return '<div class="ev ' + (ev.ok && ev.avgR > 0 ? "good" : "bad") + '">' + esc(ev.text) + "</div>"; })(evidenceFor(r.symbol, tf)) + "</div>";
      } else {
        head += '<div class="sm-wait"><b>' + (busyNow ? "กำลังเช็ก " + selectedCoins().length + " เหรียญ…" : "ยังไม่มีสัญญาณทดลอง") + "</b><small>" +
          (busyNow ? "ประมาณ 30 วินาที" : "แอปจะเด้งแจ้งเตือนเมื่อมีสัญญาณ · เช็กรอบถัดไป " + thai(Math.floor(Date.now() / TF[tf].ms) * TF[tf].ms + TF[tf].ms).slice(9) + " น.") + "</small></div>";
      }
      $("smMain").innerHTML = head + screen(r, g, z) + '<p class="sm-note" style="text-align:center">ภาพจำลองหน้า Binance Futures (ไม่ใช่แอปจริง) · ราคาจริงจาก Binance</p>';
      Array.prototype.forEach.call(document.querySelectorAll("[data-tf]"), function (b) {
        if (!b.closest("#smMain")) return;
        b.onclick = function () {
          setTradeTf(b.getAttribute("data-tf"));
          results = []; pick = 0; step = 0; schedule(); scan();
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-pick]"), function (b) {
        b.onclick = function () { pick = +b.getAttribute("data-pick"); step = 0; draw(); };
      });
      Array.prototype.forEach.call(document.querySelectorAll("#smMain [data-k]"), function (el) {
        el.onclick = function () { if (steps[step] && steps[step].t === el.getAttribute("data-k")) go(step + 1); };
      });
      coach(r, g);
      watch(r ? r.symbol : LOCK.symbol);
    }
    function coach(r, g) {
      var box = $("coach");
      document.body.classList.toggle("coaching", !!g);
      if (!g) { box.classList.add("hidden"); return; }
      var st = steps[step], last = step === steps.length - 1;
      box.classList.remove("hidden");
      box.innerHTML = '<div class="co-n">ขั้นที่ ' + (step + 1) + "/" + steps.length + '</div><div class="co-t">' + st.text + "</div>" +
        '<div class="co-b"><button type="button" class="mini ghost" id="coBack"' + (step ? "" : " disabled") + '>◀ ย้อน</button>' +
        (last ? '<button type="button" class="mini" id="coSave">เข้าแล้ว · บันทึก</button>' : '<button type="button" class="mini" id="coNext">ทำแล้ว ▶</button>') + "</div>";
      $("coBack").onclick = function () { go(step - 1); };
      if (last) {
        $("coSave").onclick = function () {
          var z = sized(g);
          Portfolio.open({ symbol: r.symbol, dir: g.dir, entry: g.entry, stop: g.stop, target: g.tps[2], tps: g.tps, qty: z.qty, fx: fx,
            risk: z.lossB, fee: FUT.fee + FUT.slippage, lev: g.lev, hold_hours: g.hold });
          $("coSave").textContent = "บันทึกแล้ว ✓"; $("coSave").disabled = true;
        };
      } else $("coNext").onclick = function () { go(step + 1); };
      var hl = document.querySelector("#smMain .coach-on");
      if (hl && step > 0) setTimeout(function () { hl.scrollIntoView({ behavior: "smooth", block: "center" }); }, 50);
    }
    function go(n) { step = Math.max(0, Math.min(steps.length - 1, n)); draw(); }
    // Real price, 24h change and order book from Binance while the screen is open.
    function watch(sym) {
      if (liveSym === sym && live) return;
      clearInterval(live); liveSym = sym;
      var pull = function () {
        if (document.hidden || !document.body.classList.contains("simple")) return;
        futuresApi("/fapi/v1/ticker/24hr?symbol=" + sym).then(function (t) {
          if (!$("txPrice") || liveSym !== sym) return;
          var c = +t.priceChangePercent;
          $("txPrice").textContent = price(+t.lastPrice); $("txPrice").className = "bk-mid " + (c >= 0 ? "up" : "down");
          $("txChg").textContent = (c >= 0 ? "+" : "") + c.toFixed(2) + "%"; $("txChg").className = "tx-chg " + (c >= 0 ? "up" : "down");
        }).catch(function () { /* keep the last value */ });
        futuresApi("/fapi/v1/depth?symbol=" + sym + "&limit=5").then(function (d) {
          if (!$("txAsks") || liveSym !== sym || !d.asks) return;
          var row = function (x, cls) { return '<div class="bk-r"><span class="' + cls + '">' + price(+x[0]) + "</span><span>" + (+x[1]).toFixed(3) + "</span></div>"; };
          $("txAsks").innerHTML = d.asks.slice(0, 5).reverse().map(function (x) { return row(x, "down"); }).join("");
          $("txBids").innerHTML = d.bids.slice(0, 5).map(function (x) { return row(x, "up"); }).join("");
        }).catch(function () { /* keep the last value */ });
      };
      pull(); live = setInterval(pull, 4000);
    }
    function show(simple) {
      document.body.classList.toggle("simple", simple);
      $("simpleView").classList.toggle("hidden", !simple);
      $("fullView").classList.toggle("hidden", simple);
      $("coach").classList.toggle("hidden", !simple || !steps.length);
      document.body.classList.toggle("coaching", simple && steps.length > 0);
      $("menuBtn").textContent = simple ? "☰ เมนู" : "← กลับ";
      if (!simple && !Guide.render()) document.querySelector('[data-tab="guideTab"]').click();
      if (simple) { $("smCap").value = money(); draw(); }
      window.scrollTo(0, 0);
    }
    function busy() { busyNow = true; if (!signals().length) { results = []; draw(); } }
    function render(res, error, rate) {
      lastScan = Date.now(); busyNow = false;
      if (error) {
        $("smMain").innerHTML = '<div class="sm-wait"><b>เช็กไม่สำเร็จ</b><small>' + esc(error).slice(0, 160) + " · ตรวจเน็ตแล้วกด เช็กอีกครั้ง</small></div>";
        return;
      }
      var prev = signals()[pick];
      results = res; fx = rate || fx;
      var list = signals(), keep = prev ? list.map(function (x) { return x.symbol; }).indexOf(prev.symbol) : -1;
      if (keep < 0) { pick = 0; step = 0; } else pick = keep;
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
    return { show: show, render: render, busy: busy };
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
          results.push(futuresCard(s, bars, fxInfo.rate, lev, tf, rule));
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
      Simple.render(results, null, fxInfo.rate);
      // Gemini runs only on demand in the open app, never inside background scans.
      return location.hash === "#bg" ? null : AI.auto(results);
    }).then(function () {
      Simple.render(results, null, fxInfo.rate);
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
    var E = window.EVIDENCE, row = E && E.rows && E.rows[symbol + "|" + tf], o = row && row.oos;
    var head = "ข้อมูลยืนยัน " + (E ? E.periods.oos : "") + ": ";
    if (!o || !(o.n >= 30)) return { ok: false, n: o ? o.n : 0, text: "ยังไม่มีข้อมูลยืนยัน" + (o ? " (ช่วงทดสอบมีแค่ " + o.n + " ไม้)" : "") };
    return { ok: true, n: o.n, win: o.win, tp5: o.tp5, avgR: o.avgR, pf: o.pf,
      text: head + o.n + " ไม้ · ปิดกำไร " + o.win + "% (95% CI " + o.winCI[0] + "–" + o.winCI[1] + "%) · ถึง TP 5R " + o.tp5 + "% (CI " + o.tp5CI[0] + "–" + o.tp5CI[1] +
        "%) · เฉลี่ย " + (o.avgR >= 0 ? "+" : "") + o.avgR + "R/ไม้" + (o.avgR <= 0 ? " (ขาดทุน)" : "") + " · ไม่ใช่โอกาสชนะของไม้นี้" };
  }

  function newsFilterLabel() {
    return "ตัวกรองข่าว: งดเฉพาะวัน FOMC จากรายการที่ใส่เอง (ปี 2026 ยังไม่ยืนยัน) · CPI/NFP ไม่มีฟีดข่าว จึงไม่ได้กรอง";
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
    var plan = Portfolio.plan(), dir = sig.dir, tick = rule.tick, cost = 2 * (FUT.fee + FUT.slippage);
    // Reference entry is the close of the signal candle on the exchange's price grid; the stop is rounded
    // away from the entry so the planned risk is never smaller than the rule says.
    var entry = toGrid(last.close, tick), stop = toGrid(entry - dir * sig.dist, tick, dir > 0 ? "floor" : "ceil"), dist = Math.abs(entry - stop);
    var riskPct = locked() ? Math.min(LOCK.riskPct, plan.riskPct || LOCK.riskPct) : plan.riskPct;
    var balance = plan.balance / fx, riskUsdt = balance * riskPct / 100, stopFrac = dist / entry;
    var qty = riskUsdt / (dist + cost * entry), notional;
    // Leverage is a cap chosen by the user (5/10/20/50x), never a target. Lower it until a conservative
    // liquidation estimate stays 1.5x the stop distance away.
    var levLiq = Math.max(1, Math.floor(1 / (1.5 * stopFrac + FUT.mmrSafe))), rec = Math.min(levLiq, lev), sizeLimited = false;
    if (qty * entry / rec > LOCK.marginShare * balance) {
      sizeLimited = true;
      qty = LOCK.marginShare * balance * rec / entry;
    }
    qty = toGrid(qty, rule.step, "floor");
    notional = qty * entry; riskUsdt = qty * (dist + cost * entry);
    // No bracket table without an API key, so liquidation uses a pessimistic maintenance margin and is only an estimate.
    var liq = dir > 0 ? entry * (1 - 1 / rec + FUT.mmrSafe) : entry * (1 + 1 / rec - FUT.mmrSafe);
    var volRatio = ind.v20[n - 1] > 0 ? last.volume / ind.v20[n - 1] : NaN;
    out.signal = { dir: dir, entry: entry, stop: stop, tps: [1, 2, 5].map(function (r) { return toGrid(entry + dir * r * dist, tick); }),
      qty: qty, notional: notional, margin: notional / rec, liq: liq, riskUsdt: riskUsdt, lev: rec, levCapUser: lev, levLiq: levLiq,
      sliderPct: notional / rec * (1 + FUT.fee * rec) / balance * 100, balanceUsdt: balance, fx: fx, dp: decimalsOf(tick),
      sizeLimited: sizeLimited, expires: last.close_time + 1 + Math.min(FUT.enterWithinMin * 60000, tfMs), stopPct: stopFrac * 100,
      candle: last.close_time + 1, trend: out.trend, hist: hist, stratName: spec.name, hold: spec.hold * tfMs / 3600000, tf: tf || "1h", stopAtr: spec.stopAtr || 2.5,
      why: "แท่ง " + TF[tf].name + " ปิดแล้ว: โมเมนตัม 2 แท่ง" + (dir > 0 ? "ขึ้น" : "ลง") + " หลังบีบตัว (squeeze) ใน 3 แท่ง · Volume " + fmt(volRatio, 1) +
        "x ค่าเฉลี่ย 20 แท่ง (เกณฑ์ ≥1.8x) · SL " + (spec.stopAtr || 1.8) + " ATR" };
    var g = out.signal;
    if (rec < 5) rejectSignal(g, "SL กว้างเกินไปสำหรับ Leverage ขั้นต่ำ 5x");
    else if (dir > 0 ? liq >= stop : liq <= stop) rejectSignal(g, "Liquidation (ประมาณ) อาจมาก่อน SL");
    else if (!(qty > 0) || qty < (rule.minQty || 0)) rejectSignal(g, "ขนาดไม้ต่ำกว่า minQty ของ Binance (" + (rule.minQty || "?") + ")");
    else if (notional < (rule.minNotional || 0)) rejectSignal(g, "มูลค่าไม้ " + fmt(notional, 1) + " USDT ต่ำกว่าขั้นต่ำ Binance " + rule.minNotional + " USDT");
    return out;
  }

  // A look-alike of the Binance Futures order panel with every field filled in and numbered.
  function orderPanel(r, g) {
    var coin = r.symbol.replace("USDT", ""), long = g.dir > 0, pct = Math.max(0.1, Math.min(100, g.sliderPct));
    var pctTxt = fmt(pct, pct < 10 ? 1 : 0) + "%";
    var ticks = [0, 25, 50, 75, 100].map(function (x) { return '<span class="tick" style="left:' + x + '%"></span>'; }).join("");
    return '<div class="bx">' +
      '<div class="hd"><span class="sym">' + r.symbol + ' <small style="color:#848e9c;font-weight:400">Perp</small></span><small style="color:#848e9c">Futures · USDⓈ-M</small></div>' +
      '<div class="row2"><div class="chip hl">Isolated<span class="n">1</span></div><div class="chip hl">' + g.lev + 'x<span class="n">2</span></div></div>' +
      '<div class="tabs2"><div class="on">Open</div><div>Close</div></div>' +
      '<div class="fld hl"><span>Market</span><small>▾</small><span class="n">3</span></div>' +
      '<div class="fld hl"><small>Size</small><span class="val">' + g.qty + " " + coin + '</span><span class="n">4</span></div>' +
      '<div class="sl">' + '<span class="ln"></span><span class="fill" style="width:' + pct + '%"></span>' + ticks + '<span class="kb" style="left:' + pct + '%"></span></div>' +
      '<div style="text-align:center;margin:-4px 0 8px;color:#f0b90b;font-weight:700">ลากไปที่ ' + pctTxt + "</div>" +
      '<div class="ck"><i>✓</i><span>TP/SL</span><span class="n" style="position:static;margin-left:auto">5</span></div>' +
      '<div class="fld"><small>Take Profit</small><span class="val" style="color:#2ebd85">' + price(g.tps[2]) + "</span></div>" +
      '<div class="fld"><small>Stop Loss</small><span class="val" style="color:#f6465d">' + price(g.stop) + '</span></div>' +
      '<div class="row2" style="margin-top:4px"><div class="btn2 buy ' + (long ? "hl" : "dim") + '">Buy/Long' + (long ? '<span class="n">6</span>' : "") + "</div>" +
      '<div class="btn2 sell ' + (long ? "dim" : "hl") + '">Sell/Short' + (long ? "" : '<span class="n">6</span>') + "</div></div></div>" +
      '<ul class="bx-steps">' +
      '<li><b class="k">1</b><span>แตะ <b>Cross</b> แล้วเปลี่ยนเป็น <b>Isolated</b></span></li>' +
      '<li><b class="k">2</b><span>แตะตัวเลข Leverage แล้วตั้งเป็น <b>' + g.lev + 'x</b> กดยืนยัน</span></li>' +
      '<li><b class="k">3</b><span>ประเภทคำสั่งเลือก <b>Market</b> (อยู่แท็บ <b>Open</b>)</span></li>' +
      '<li><b class="k">4</b><span>พิมพ์ขนาด <b>' + g.qty + " " + coin + "</b> หรือลากสไลเดอร์ไปที่ <b>" + pctTxt + '</b></span></li>' +
      '<li><b class="k">5</b><span>ติ๊ก <b>TP/SL</b> ใส่ Take Profit <b>' + price(g.tps[2]) + "</b> และ Stop Loss <b>" + price(g.stop) + '</b></span></li>' +
      '<li><b class="k">6</b><span>กด <b>' + (long ? "Buy/Long (สีเขียว)" : "Sell/Short (สีแดง)") + "</b> แล้วกลับมากด \"เข้าแล้ว · บันทึกลงพอร์ต\"</span></li>" +
      '<li><b class="k">⏱</b><span>ถ้าครบ <b>' + g.hold + ' ชม.</b> แล้วยังไม่ชน TP/SL ให้ไปที่ Positions กด <b>Close → Market</b></span></li></ul>' +
      '<small class="muted">ภาพนี้เป็นตัวช่วยตั้งค่า ไม่ใช่แอป Binance จริง ตำแหน่งปุ่มในแอปจริงอาจต่างเล็กน้อย ต้องอยู่ในแท็บ <b>Futures</b> (แถบล่างของ Binance) ไม่ใช่ Spot</small>';
  }

  // Step-by-step for the Binance app, filled in with this signal's numbers.
  function binanceHowTo(r, g) {
    var coin = r.symbol.replace("USDT", ""), long = g.dir > 0;
    var lowNotional = g.notional < ({ BTCUSDT: 100, ETHUSDT: 20 }[r.symbol] || 5);
    return '<button class="mini ghost" data-how="' + r.symbol + '" style="width:100%">ดูหน้าตั้งค่าใน Binance (ทำตามภาพ)</button><div class="how hidden" id="how-' + r.symbol + '">' +
      '<b>ช่วง Paper Trading ยังไม่ต้องทำ</b> แอปจดผลให้เอง ใช้หน้านี้เมื่อพร้อมใช้เงินจริง' + orderPanel(r, g) +
      '<details style="margin-top:8px"><summary class="muted" style="font-size:13px">ขั้นตอนแบบข้อความ</summary><ol>' +
      "<li>เปิดแอป Binance → แท็บ <b>Futures</b> → <b>USDⓈ-M</b> → เลือก <b>" + r.symbol + " Perpetual</b></li>" +
      "<li>กดปุ่มโหมด Margin เลือก <b>Isolated</b> และกดปุ่ม Leverage ตั้งเป็น <b>" + g.lev + "x</b></li>" +
      "<li>ประเภทคำสั่งเลือก <b>Market</b> แล้ว<b>ลากสไลเดอร์ไปที่ " + fmt(Math.max(g.sliderPct, 0.1), g.sliderPct < 10 ? 1 : 0) + "%</b> หรือพิมพ์จำนวน <b>" + g.qty + " " + coin +
        "</b> (≈ " + fmt(g.notional, 0) + " USDT · Margin ≈ " + fmt(g.margin, 1) + " USDT) — ถ้าเงินใน Futures wallet ไม่เท่ากับทุนในแอป ให้ใช้วิธีพิมพ์จำนวน</li>" +
      "<li>ติ๊ก <b>TP/SL</b>: Take Profit <b>" + price(g.tps[2]) + "</b> (TP3 = 5R ตามสูตร) · Stop Loss <b>" + price(g.stop) + "</b> · Trigger เลือก <b>Mark Price</b></li>" +
      "<li>กด <b>" + (long ? "Buy/Long (สีเขียว)" : "Sell/Short (สีแดง)") + "</b> แล้วตรวจในแท็บ Positions ว่า TP/SL ขึ้นครบ</li>" +
      "<li>กลับมาแอปนี้ กด <b>เข้าแล้ว · บันทึกลงพอร์ต</b></li>" +
      "<li>ถ้าครบ <b>" + g.hold + " ชม.</b> แล้วยังไม่ชน TP/SL ให้ปิดเองด้วย Market (ภายใน " + thai(g.expires + (g.hold - 1) * 3600000).slice(0, 14) + " น.)</li></ol>" +
      (lowNotional ? '<small class="down">มูลค่าไม้ต่ำ อาจต่ำกว่าขั้นต่ำของ Binance สำหรับ ' + r.symbol + ' ถ้าเปิดไม่ได้แปลว่าทุนยังน้อยเกินสำหรับความเสี่ยง 0.25% อย่าเพิ่มขนาดไม้เอง</small><br>' : "") +
      '<small class="muted">TP1/TP2 ในการ์ดเป็นระดับอ้างอิง งานวิจัยทดสอบเฉพาะ TP 5R + ออกเมื่อครบเวลา ชื่อปุ่มใน Binance อาจต่างเล็กน้อยตามเวอร์ชันแอป</small></details></div>';
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
      var detail = "เหตุผล: " + esc(g.why) + "<br>TP1 = 1R · TP2 = 2R · TP3 = 5R · ถือไม่เกิน " + fmt(g.hold, g.hold < 10 ? 1 : 0) + " ชม.<br>" +
        "ขนาด " + g.qty + " " + name + " (≈ " + fmt(g.notional, 0) + " USDT) · Margin ≈ " + fmt(g.margin, 1) + " USDT · Leverage ≤" + g.lev + "x (เพดานที่เลือก " + g.levCapUser + "x)" +
        "<br>Liquidation ประมาณ " + price(g.liq) + " (สมมติ maintenance margin 1% · ไม่มีตาราง bracket จริง จึงไม่ใช่ตัวเลขที่ปลอดภัยแน่นอน)" +
        (g.mark ? "<br>Mark price ตอนสแกน " + price(g.mark) : "") +
        "<br>ต้นทุนที่สมมติ: ค่าธรรมเนียม 0.05% + slippage 0.02% ต่อข้าง + funding 0.01%/8 ชม.";
      return '<div class="coin go"><div class="coin-head"><span><b>' + r.symbol + '</b> <small class="tag">Perp</small>' +
        ' <small class="tag" style="color:var(--yel)">ทดลอง</small></span>' + pill + "</div>" +
        '<div class="ev ' + (ev.ok && ev.avgR > 0 ? "good" : "bad") + '">' + esc(ev.text) + "</div>" +
        '<div class="levels"><div><small>เข้าอ้างอิง</small><b>' + price(g.entry) + '</b></div><div><small>SL</small><b class="down">' + price(g.stop) +
        '</b></div><div><small>TP1 · TP2 · TP3</small><b class="up" style="font-size:13px">' + g.tps.map(price).join("<br>") + "</b></div></div>" +
        '<div class="slider-tip">ลากสไลเดอร์ไปที่ <b style="font-size:20px">' + fmt(Math.max(g.sliderPct, 0.1), g.sliderPct < 10 ? 1 : 0) +
          "%</b> · โดน SL เสีย ≈ " + fmt(g.riskUsdt * fx, 0) + " ฿ · เข้าก่อน " + thai(g.expires).slice(9) + " น.</div>" +
        (g.sizeLimited ? '<div class="banner wait" style="margin:8px 0 0;font-size:13px">ลดขนาดให้ Margin ไม่เกิน ' + (locked() ? "5" : "25") + "% ของทุน</div>" : "") +
        '<div id="ai-' + r.symbol + '"></div>' + binanceHowTo(r, g) +
        '<div class="btnrow"><button class="mini" data-record="' + esc(JSON.stringify({ symbol: r.symbol, dir: g.dir, entry: g.entry, stop: g.stop, target: g.tps[2], tps: g.tps,
          qty: g.qty, fx: fx, risk: g.riskUsdt * fx, fee: FUT.fee + FUT.slippage, lev: g.lev, hold_hours: g.hold })) + '">เข้าแล้ว · บันทึก</button>' +
        '<button class="mini ghost" data-ai="' + r.symbol + '">AI วิเคราะห์</button><button class="mini ghost" data-chart="' + r.symbol + '">กราฟ</button></div>' +
        '<details style="margin-top:8px"><summary>รายละเอียด</summary><small>' + detail + "</small></details></div>";
    }).join("");
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
    Array.prototype.forEach.call(document.querySelectorAll("[data-how]"), function (b) {
      b.onclick = function () { $("how-" + b.getAttribute("data-how")).classList.toggle("hidden"); };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-ai]"), function (b) {
      b.onclick = function () {
        var r = lastFutures.filter(function (x) { return x.symbol === b.getAttribute("data-ai"); })[0];
        if (r) AI.analyseSignal(r, true);
      };
    });
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
  var TF_LABEL = { "5m": "M5", "15m": "M15", "1h": "H1" };
  function pxDp(v, dp) {
    if (!isFinite(v)) return "";
    return dp === undefined ? price(v) : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function signalPayload(r, tf) {
    var g = r.signal, ev = evidenceFor(r.symbol, tf), fx = g.fx || 33;
    return { symbol: r.symbol, side: g.dir > 0 ? "LONG" : "SHORT", tf: TF_LABEL[tf], strategy: "squeeze3_ls",
      candle_close: g.candle, expires: g.expires, hold_hours: g.hold,
      entry: pxDp(g.entry, g.dp), sl: pxDp(g.stop, g.dp), tp1: pxDp(g.tps[0], g.dp), tp2: pxDp(g.tps[1], g.dp), tp5: pxDp(g.tps[2], g.dp),
      qty: String(g.qty), margin_usdt: g.margin.toFixed(2), margin_thb: String(Math.round(g.margin * fx)), risk_thb: String(Math.round(g.riskUsdt * fx)),
      leverage: g.lev, leverage_cap: g.levCapUser, liq_est: pxDp(g.liq, g.dp), mark: g.mark ? pxDp(g.mark, g.dp) : "",
      rationale: g.why, evidence: ev.text, evidence_ok: ev.ok, experimental: true };
  }
  function reportScan(results, end, error, extra) {
    if (!window.NativeHttp || !window.NativeHttp.scanDone || $("sgMode").value !== "futures") return;
    var plan = Portfolio.plan(), tf = curTf();
    var sigs = (plan.state === "ok" ? results : []).filter(function (r) { return r.signal && !r.signal.below_minimum; });
    window.NativeHttp.scanDone(JSON.stringify({ v: 2, candle: end, interval_minutes: TF[tf].ms / 60000, error: error || "",
      scanned: extra && extra.scanned || 0, failed: extra && extra.failed || [],
      rejected: results.filter(function (r) { return r.signal && r.signal.below_minimum; }).map(function (r) { return r.symbol + ": " + r.signal.reject; }),
      note: plan.state === "ok" ? "" : plan.message, news_filter: newsFilterLabel(),
      signals: sigs.map(function (r) { return signalPayload(r, tf); }) }));
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
    $("autoScanLabel").textContent = "เด้งแยกเหรียญเมื่อมีสัญญาณ (M5/M15/H1 · Android อาจหน่วงแจ้งเตือนเมื่อประหยัดแบต)";
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
    var show = false;
    try { show = nativeAlerts && $("autoScan").checked && window.NativeHttp.batteryUnrestricted && !window.NativeHttp.batteryUnrestricted(); } catch (e) { /* ignore */ }
    $("batteryBox").classList.toggle("hidden", !show);
  }
  $("notifBtn").onclick = function () { try { window.NativeHttp.openNotificationSettings(); } catch (e) { /* ignore */ } };
  $("notifTest").onclick = function () { try { window.NativeHttp.testNotification(); } catch (e) { /* ignore */ } setTimeout(batteryCheck, 800); };
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
  function modeHelp() {
    var lock = locked();
    $("sgStrat").disabled = $("sgLev").disabled = lock;
    var v2 = lock || $("sgStrat").value === "squeeze3_ls";
    $("sgHelp").textContent = $("sgMode").value === "futures"
      ? (v2 ? "Squeeze v2 แท่ง 1 ชม.: เทรนด์ EMA20/50/200 + บีบตัวแล้วทะลุภายใน 3 ชม. + แท่งโมเมนตัม 2 แท่ง + Volume ≥ 1.8 เท่า · SL 1.8 ATR · TP1/2/3 = 1R/2R/5R · ถือไม่เกิน 48 ชม."
          : "Squeeze v1 แท่ง 1 ชม.: เทรนด์ EMA20/50/200 + บีบตัวแล้วทะลุภายใน 8 ชม. + แท่งโมเมนตัม · SL 2.5 ATR · TP1/2/3 = 1R/2R/5R · ถือไม่เกิน 24 ชม.") +
        " · ขนาดไม้คิดจาก % เสี่ยงในแท็บพอร์ต ไม่ใช่จาก Leverage"
      : "Spot: สแกนแนวโน้ม 1 ชม. เลือกกลยุทธ์ที่ได้ผลดีสุดใน 90 วันล่าสุดของแต่ละเหรียญ แล้วดูแท่ง 15 นาทีที่เพิ่งปิด";
    if ($("sgMode").value !== "futures") $("sgLev").disabled = $("sgStrat").disabled = true;
    if (lock && $("sgMode").value === "futures") $("sgHelp").textContent = "สูตร Squeeze v2 เดิมพัฒนาบน H1 · ใช้ M5/M15 เป็นสัญญาณทดลอง ยังไม่ผ่าน Backtest · เลือกเหรียญ/กราฟด้านบน · จำกัดเสี่ยงเป้าหมาย 0.25%/ไม้";
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
    var STREAMS = ["wss://fstream.binance.com/ws/"];   // USD-M futures streams, same market as the signals
    var chart = null, rsiChart = null, series = {}, priceLines = [], bars = [], socket = null, pollTimer = null,
      symbol = "BTCUSDT", tf = "4h", lastDraw = 0, token = 0;

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
      var opened = false;
      ws.onopen = function () { opened = true; if (my === token) { $("cvLive").textContent = "● Realtime"; $("cvLive").className = "up"; } };
      ws.onmessage = function (m) { if (my !== token) return; try { onKline(JSON.parse(m.data).k); } catch (e) { /* ignore bad frame */ } };
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
      var pl = function (price, color, title, style) {
        priceLines.push(series.candle.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: style === undefined ? 2 : style, axisLabelVisible: true, title: title }));
      };
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
      if (trendUp && a.upSwing) {
        var zoneHi = a.fib[0.5], zoneLo = a.fib[0.618], entry = (zoneHi + zoneLo) / 2, sl = a.fib[0.786] - (a.fib[0.618] - a.fib[0.786]) * 0.25;
        var tps = [a.hi, a.ext[1.272], a.ext[1.618]], rr = tps.map(function (tp) { return (tp - entry) / (entry - sl); });
        var inZone = a.price <= zoneHi && a.price >= zoneLo;
        plan = '<div class="levels"><div><small>โซนรอซื้อ (Fib 0.5–0.618)</small><b>' + price(zoneLo) + " – " + price(zoneHi) + '</b></div><div><small>Stop (ใต้ 0.786)</small><b class="down">' +
          price(sl) + '</b></div><div><small>TP1 · TP2 · TP3</small><b class="up" style="font-size:13px">' + tps.map(price).join("<br>") + "</b></div></div>" +
          "<small>R:R ถ้าเข้ากลางโซน: TP1 " + fmt(rr[0], 1) + " · TP2 " + fmt(rr[1], 1) + " · TP3 " + fmt(rr[2], 1) + "</small><br>" +
          (inZone ? '<b class="up">ราคาอยู่ในโซนรอซื้อแล้ว</b> — รอแท่งยืนยัน (แท่งเขียวกลืน/ไส้ล่างยาว) ก่อนเข้า' :
            a.price > zoneHi ? "ราคายังสูงกว่าโซน รอย่อลงมาก่อน ไม่ไล่ราคา" : '<span class="down">ราคาหลุดโซนแล้ว</span> ถ้าปิดใต้ ' + price(a.fib[0.786]) + " ถือว่าโครงสร้างขาขึ้นเสีย");
      } else if (trendUp) {
        plan = "ขาขึ้นแต่รอบล่าสุดเป็นการย่อจากจุดสูง รอให้ทำจุดต่ำใหม่ยืนได้และกลับขึ้นก่อน ค่อยตี Fibonacci รอบใหม่";
      } else if (trendDown) {
        plan = "ขาลง: Spot ไม่ซื้อ ถือ USDT รอราคากลับขึ้นเหนือ EMA200 · แนวรับถัดไปตาม Fib " + price(a.fib[1]) + (a.ext ? " และ Ext 1.272 ที่ " + price(a.ext[1.272]) : "");
      } else {
        plan = "ยังไม่มีแนวโน้มชัด รอ EMA50 ตัดขึ้นเหนือ EMA200 หรือราคายืนเหนือเทรนด์ไลน์แนวต้าน";
      }
      var tl = [];
      if (a.sup !== null) tl.push("แนวรับเทรนด์ไลน์ ≈ " + price(a.sup) + (a.price < a.sup ? ' <span class="down">(หลุดแล้ว)</span>' : ""));
      if (a.res !== null) tl.push("แนวต้านเทรนด์ไลน์ ≈ " + price(a.res) + (a.price > a.res ? ' <span class="up">(ทะลุแล้ว)</span>' : ""));
      $("cvAnalysis").innerHTML = '<ul style="margin:0;padding-left:18px;font-size:14px"><li>แนวโน้ม: ' + trend + "</li><li>RSI: " + rsiText + "</li><li>" + pos + "</li>" +
        (tl.length ? "<li>" + tl.join("<br>") + "</li>" : "") + '</ul><div style="margin-top:10px">' + plan + "</div>";
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
  $("cvAi").onclick = function () {
    var c = ChartView.context();
    if (c) AI.analyseChart(c); else $("cvAiOut").innerHTML = '<div class="ai">รอกราฟโหลดก่อน</div>';
  };

  // ---- Step-by-step guide ----
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
      { id: "paper", title: "เริ่ม Paper Trading", how: "แท็บพอร์ต → ปุ่ม \"เริ่ม Paper วันนี้\" แอปจะจดผลให้เองนับจากวันนี้",
        tab: "portTab", target: "ppStart", done: function () { return has("paper.v2"); } },
      { id: "alerts", title: "เปิดแจ้งเตือนสัญญาณ", how: "หน้าแรก → ตั้งค่า → ติ๊ก \"เด้งเมื่อมีสัญญาณเข้าได้\" แล้วกดอนุญาตการแจ้งเตือน (ในแอป Android ตั้งแบตเตอรี่เป็น \"ไม่จำกัด\" ด้วย)",
        tab: "guideTab", target: "autoScan", done: function () { return $("autoScan").checked; } },
      { id: "ai", title: "(ไม่บังคับ) ใส่ Gemini API key ให้ AI ช่วยเช็กข่าว", how: "แตะ \"พาไป\" → กดปุ่ม ① เปิดหน้าเอาคีย์ → Create API key → คัดลอก → กลับมากด ② วางคีย์ → ทดสอบคีย์",
        tab: "guideTab", target: "aiGetKey", done: function () { return !!$("aiKey").value.trim(); }, optional: true },
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

    // Sticky "next step" bar on every tab until the required steps are done.
    function renderBar(required, doneCount) {
      var next = STEPS.filter(function (s) { return !s.optional && !s.info && !s.done(); })[0], bar = $("guideBar");
      bar.classList.toggle("hidden", !next);
      document.body.classList.toggle("has-guide", !!next);
      if (!next) return;
      $("guideBarStep").textContent = "ขั้นต่อไป " + (doneCount + 1) + "/" + required.length + (next.confirm ? " · เสร็จแล้วกด \"" + next.confirm + "\"" : next.id === "capital" ? " · พิมพ์ทุนแล้วแตะที่อื่น" : "");
      $("guideBarTitle").textContent = next.title;
      bar.onclick = function () { go(next); };
    }
    setInterval(function () { if (!document.hidden) render(); }, 1500);
    $("pfCapital").addEventListener("change", function () { mark("capital"); });
    $("pfCapital").addEventListener("blur", function () { mark("capital"); });
    $("sgFomcOk").addEventListener("click", function () { mark("fomc"); $("sgFomcOk").textContent = "ตรวจแล้ว ✓ (บันทึกแล้ว)"; });
    $("pp2026").addEventListener("click", function () { mark("test2026"); });
    ["sgMode", "sgLock", "autoScan", "aiKey"].forEach(function (id) { $(id).addEventListener("change", render); });
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
        html = '<div class="banner wait">ยังไม่ผ่าน</div><small>' + esc(best.name) + " ดีสุดช่วง Valid แต่ Holdout: " + h.trades + " ไม้ · win " + fmt(h.win_rate, 1) +
          "% · " + fmt(h.exp_r, 2, true) + "R/ไม้ · PF " + fmt(h.pf, 2) + "</small>";
      } else {
        html = '<div class="banner wait">ยังไม่มีเทคนิคที่ได้เปรียบ</div><small>ไม่มีเทคนิคไหนกำไรเฉลี่ยต่อไม้เป็นบวกทั้ง Dev และ Valid (และ Valid ≥ 30 ไม้) หลังหักค่าธรรมเนียม</small>';
      }
      $("swBest").innerHTML = html;
      $("swTable").innerHTML = r.techniques.map(function (t) {
        var d = t.development, v = t.validation;
        return "<tr><td>" + esc(t.name) + (t.id === r.chosen ? " ✓" : "") + '<br><small class="muted">' + esc(t.source) + "</small></td><td>" + d.trades + " · " + fmt(d.win_rate, 0) +
          "%<br>" + fmt(d.exp_r, 2, true) + "R</td><td>" + v.trades + " · " + fmt(v.win_rate, 0) + "%<br>" + fmt(v.exp_r, 2, true) + "R</td><td>" + fmt(v.pf, 2) + "</td></tr>";
      }).join("");
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
  else { Simple.show(true); scan(); }
})();
