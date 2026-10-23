/* Test prelude injected before the app: a fake Android NativeHttp that serves a deterministic
 * Binance USD-M futures API and records every packet the app hands to the native alerts. */
(function () {
  var Q = new URLSearchParams(location.search), CASE = Q.get("case") || "all";
  var cfg = JSON.parse(Q.get("cfg") || "{}");   // URLSearchParams has decoded it already (cfg text may contain "%")
  // cfg.justClosed (ms): the page sees a clock one minute after the latest candle of that size closed, so a foreground
  // test can show a signal that is still within its entry window.
  if (cfg.justClosed) {
    var realNow = Date.now.bind(Date), shift = realNow() % cfg.justClosed - 60000;
    Date.now = function () { return realNow() - shift; };
  }
  localStorage.clear();
  Object.keys(cfg.storage || {}).forEach(function (k) { localStorage.setItem(k, cfg.storage[k]); });
  // name, base price, tick, lot step, min notional
  var SPEC = { BTCUSDT: [60000, 0.1, 0.001, 100], ETHUSDT: [3000, 0.01, 0.001, 20], BNBUSDT: [600, 0.01, 0.01, 5], SOLUSDT: [150, 0.01, 0.01, 5],
    XRPUSDT: [0.6, 0.0001, 0.1, 5], DOGEUSDT: [0.15, 0.00001, 1, 5], ADAUSDT: [0.4, 0.0001, 1, 5], AVAXUSDT: [30, 0.001, 1, 5],
    LINKUSDT: [15, 0.001, 0.01, 5], DOTUSDT: [6, 0.001, 0.1, 5], TRXUSDT: [0.12, 0.00001, 1, 5], LTCUSDT: [80, 0.01, 0.001, 5] };
  window.__SPEC = SPEC;
  window.__T = { packets: [], posts: [], scanMinutes: [], requests: [] };
  function price(sym, t) { var b = SPEC[sym][0], k = t / 900000; return b * (1 + 0.01 * Math.sin(k / 37) + 0.004 * Math.sin(k / 5.3)); }
  function klines(sym, interval, start, end, limit) {
    var step = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 }[interval], out = [];
    var lastOpen = Math.floor((end + 1) / step) * step - step;            // latest bar that closes by endTime
    if (cfg.stale) lastOpen -= step;                                      // exchange lags one candle
    for (var t = Math.ceil(start / step) * step; t <= lastOpen && out.length < limit; t += step) {
      var o = price(sym, t), c = price(sym, t + step), h = Math.max(o, c) * 1.001, l = Math.min(o, c) * 0.999;
      out.push([t, String(o), String(h), String(l), String(c), "100", t + step - 1, "0", 1, "50", "0", "0"]);
    }
    return out;
  }
  function reply(id, ok, body, delay) { setTimeout(function () { window.__nativeDone(id, ok, typeof body === "string" ? body : JSON.stringify(body)); }, delay || 1); }
  // Binance's mark-price WebSocket: every requested coin at cfg.livePct % above its base price, once a second.
  // cfg.wsDown: the socket fails at once, so the app falls back to REST polling.
  window.WebSocket = function (url) {
    var self = this, syms = (url.split("streams=")[1] || "").split("/").map(function (x) { return x.split("@")[0].toUpperCase(); });
    __T.ws = url;
    setTimeout(function () {
      if (cfg.wsDown) { if (self.onerror) self.onerror({}); return; }
      var tick = function () {
        syms.forEach(function (sy) {
          if (SPEC[sy] && self.onmessage) self.onmessage({ data: JSON.stringify({ stream: sy.toLowerCase() + "@markPrice@1s", data: { e: "markPriceUpdate", s: sy, p: String(SPEC[sy][0] * (1 + (cfg.livePct || 0) / 100)) } }) });
        });
      };
      tick(); self._t = setInterval(tick, 1000);
    }, 50);
  };
  window.WebSocket.prototype.close = function () { clearInterval(this._t); };
  window.NativeHttp = {
    get: function (id, url) {
      var u = new URL(url), p = u.searchParams, sym = p.get("symbol");
      __T.requests.push(u.host + u.pathname);
      if (cfg.offline) return reply(id, false, "UnknownHostException: fapi.binance.com");
      if (cfg.hang && u.pathname === cfg.hang) return;   // the native side never answers
      if (u.host === "api.bitkub.com") return reply(id, true, { THB_USDT: { last: 33 } });
      // Free news: every RSS host gets two headlines (one names SOL with a risk word), Binance one delisting notice,
      // the calendar a high-impact US CPI two hours from now. cfg.newsDown: every news source fails.
      if (/coindesk|cointelegraph|decrypt|bitcoinmagazine|theblock|cryptoslate|siamblockchain|bitcoinaddict|federalreserve|sec\.gov/.test(u.host)) {
        if (cfg.newsDown) return reply(id, false, "HTTP 503 down");
        var t0 = new Date(Date.now() - 20 * 60000).toUTCString(), t1 = new Date(Date.now() - 3 * 3600000).toUTCString();
        return reply(id, true, '<?xml version="1.0"?><rss version="2.0"><channel><title>' + u.host + "</title>" +
          "<item><title>Solana network outage halts block production on " + u.host + "</title><link>https://" + u.host + "/a1</link><pubDate>" + t0 + "</pubDate></item>" +
          "<item><title>Markets wait for the Fed (" + u.host + ")</title><link>https://" + u.host + "/a2</link><pubDate>" + t1 + "</pubDate></item>" +
          (u.host === "www.coindesk.com" ? "<item><title>Bitcoin ETF inflows hit a record as BTC rallies</title><link>https://" + u.host + "/a3</link><pubDate>" + t1 + "</pubDate></item>" : "") +
          "</channel></rss>");
      }
      if (cfg.newsDown && (u.host === "www.binance.com" || u.host === "nfs.faireconomy.media" || u.host === "api.alternative.me")) return reply(id, false, "HTTP 503 down");
      if (u.host === "www.binance.com") return reply(id, true, { code: "000000", data: { catalogs: [{ catalogId: 161, catalogName: "Delisting",
        articles: [{ code: "abc123", title: "Binance Futures Will Delist XYZUSDT USDⓈ-M Perpetual Contract", releaseDate: Date.now() - 3600000 }] }] } });
      // Fear & Greed: today cfg.fng (default 38, "fear"), 47 a week ago.
      if (u.host === "api.alternative.me") return reply(id, true, { data: [cfg.fng || 38, 40, 42, 44, 45, 46, 46, 47].map(function (v, k) {
        return { value: String(v), value_classification: "x", timestamp: String(Math.floor((Date.now() - k * 86400000) / 1000)) }; }) });
      if (u.host === "nfs.faireconomy.media") return reply(id, true, [
        { title: "CPI m/m", country: "USD", date: new Date(Date.now() + 2 * 3600000).toISOString(), impact: "High", forecast: "0.3%", previous: "0.4%" },
        { title: "Unemployment Claims", country: "USD", date: new Date(Date.now() + 30 * 3600000).toISOString(), impact: "Medium", forecast: "220K", previous: "218K" },
        { title: "GDP q/q", country: "EUR", date: new Date(Date.now() + 3600000).toISOString(), impact: "High", forecast: "", previous: "" }]);
      if (u.host === "open.er-api.com") return reply(id, true, { rates: { THB: 33 } });
      if (u.pathname === "/fapi/v1/time") return reply(id, true, { serverTime: Date.now() });
      if (u.pathname === "/fapi/v1/exchangeInfo") return reply(id, true, { symbols: Object.keys(SPEC).map(function (s) {
        var x = SPEC[s];
        return { symbol: s, status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", filters: [
          { filterType: "PRICE_FILTER", tickSize: String(x[1]) }, { filterType: "LOT_SIZE", stepSize: String(x[2]), minQty: String(x[2]) },
          { filterType: "MARKET_LOT_SIZE", stepSize: String(x[2]), minQty: String(x[2]) }, { filterType: "MIN_NOTIONAL", notional: String(x[3]) }] };
      }) });
      if (u.pathname === "/fapi/v1/klines") return reply(id, true, klines(sym, p.get("interval"), +p.get("startTime") || (Date.now() - 500 * 900000), +p.get("endTime") || Date.now(), +p.get("limit")));
      if (u.pathname === "/fapi/v1/premiumIndex") {
        var step = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 }[localStorage.getItem("tradeTf") || "4h"];
        var close = price(sym, Math.floor(Date.now() / step) * step);
        return reply(id, true, { symbol: sym, markPrice: String(close * (cfg.markFar ? 1.02 : 1.0002)) });
      }
      if (u.pathname === "/fapi/v1/ticker/24hr") return reply(id, true, { lastPrice: "1", priceChangePercent: "0" });
      if (u.pathname === "/fapi/v1/ticker/price") return reply(id, true, Object.keys(SPEC).map(function (s) { return { symbol: s, price: String(SPEC[s][0]) }; }));
      if (u.pathname === "/fapi/v1/depth") return reply(id, true, { asks: [], bids: [] });
      if (u.pathname.indexOf("/api/v3/") === 0) { __T.requests.push("SPOT " + u.pathname); return reply(id, false, "spot endpoint used in test"); }
      reply(id, false, "unmocked " + url);
    },
    scanDone: function (json) { __T.packets.push(JSON.parse(json)); },
    share: function (subject, text) { __T.shared = text; },
    setScanMinutes: function (m) { __T.scanMinutes.push(m); },
    scanMinutes: function () { return 15; },
    alertsEnabled: function () { return true; }, setAlerts: function () {}, notificationsAllowed: function () { return true; },
    lastScanStatus: function () { return JSON.stringify({ at: Date.now(), ok: false, text: "test status" }); },
    debugFuturesBase: function () { return ""; }, testNotification: function () {},
    // Debug builds may pin a trial timeframe (the legacy cases store it); cfg.releaseTf behaves like the release app.
    debugTradeTf: function () { return cfg.releaseTf ? "" : (localStorage.getItem("tradeTf") || ""); },
    batteryUnrestricted: function () { return true; }, openBatterySettings: function () {}, openNotificationSettings: function () {}
  };
  window.__CFG = cfg;
  // Evidence table under test (the real one is built from research/evidence).
  if (cfg.evidence) window.__EVIDENCE_OVERRIDE = cfg.evidence;
})();
