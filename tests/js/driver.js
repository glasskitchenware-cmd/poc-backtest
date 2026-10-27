/* Runs after the app: forces Squeeze signals (cfg.force) or Trend 4H decisions (cfg.trendForce) on the last closed bar
 * (the rules themselves are covered by research/ and tests/js/trend_test.js; this tests what happens after a decision),
 * then reports the captured packets in document.title for run_tests.py. */
(function () {
  var cfg = window.__CFG, force = cfg.force || {};
  if (window.__EVIDENCE_OVERRIDE) window.EVIDENCE = window.__EVIDENCE_OVERRIDE;
  if (cfg.trendEvidence) window.EVIDENCE_TREND = cfg.trendEvidence;
  // The mock's bars make the system's last 30 days all losses; unless a case checks that (cfg.realRecent), widen the
  // test's normal range so the other cases still see signals.
  if (!cfg.realRecent && !cfg.trendEvidence && window.EVIDENCE_TREND && window.EVIDENCE_TREND.normal) Object.values(window.EVIDENCE_TREND.normal).forEach(function (n) {
    Object.values(n.windows || {}).forEach(function (w) { w.p5 = -999; w.min = -9999; });
  });
  // The same for the calendar 30-day band; cfg.calendar sets it instead (a case that checks it).
  var C = window.EVIDENCE_LEDGER && window.EVIDENCE_LEDGER.calendar30;
  if (C && cfg.calendar) Object.assign(C, cfg.calendar);
  else if (C && !cfg.realRecent) { C.p5 = -999; C.min = -9999; }
  function coinOf(c) {
    var best = null, d = Infinity;
    Object.keys(window.__SPEC).forEach(function (s) { var x = Math.abs(Math.log(c / window.__SPEC[s][0])); if (x < d) { d = x; best = s; } });
    return best;
  }
  var real = Swing.signal;
  Swing.signal = function (id, bars, ind, i, opt) {
    if (i === bars.length - 1) {
      var c = bars[i].close, best = coinOf(c);
      if (force[best]) return { dir: force[best] === "SHORT" ? -1 : 1, dist: c * (cfg.stopFrac || 0.012), rr: 5 };
      return null;
    }
    return real(id, bars, ind, i, opt);
  };
  // LONG/SHORT: enter at the next open. EXIT_LONG/EXIT_SHORT: the rule closes a position opened 20 bars ago (+1R now).
  // HOLD_LONG/HOLD_SHORT: the rule holds that position; NEAR_LONG/NEAR_SHORT: one opened 2 bars ago, price near the entry.
  // Unlisted coins: nothing.
  if (cfg.trendForce) {
    var realTrend = Trend.run;
    Trend.run = function (bars, opt) {
      var res = realTrend(bars, opt);
      if (!opt || !opt.live) return res;
      var n = bars.length, c = bars[n - 1].close, f = cfg.trendForce[coinOf(c)] || "";
      res.pend = null; res.pos = null;
      if (cfg.stopFrac && res.last) res.last.stopDist = c * cfg.stopFrac;
      if (f === "LONG" || f === "SHORT") res.pend = { dir: f === "LONG" ? 1 : -1 };
      else if (f) {
        // NEAR_*: the rule entered 2 bars ago and price is still 0.2R from the entry (a late entry may apply).
        var d = /LONG$/.test(f) ? 1 : -1, risk = c * 0.05, near = /^NEAR/.test(f), entry = near ? c - d * 0.2 * risk : c - d * risk, ago = near ? 2 : 20;
        res.pos = { dir: d, entry: entry, risk: risk, stop: entry - d * risk, entry_time: bars[n - ago].time, entry_index: n - ago, best: c, left: 1, fills: [] };
        if (/^EXIT/.test(f)) res.pend = { exit: true };
      }
      return res;
    };
  }
  if (cfg.capital) { document.getElementById("pfCapital").value = String(cfg.capital); }
  if (cfg.clickTf) setTimeout(function () { var b = document.querySelector('#smMain [data-tf="' + cfg.clickTf + '"]'); if (b) b.click(); }, 200);
  if (cfg.clickId) setTimeout(function () { var b = document.getElementById(cfg.clickId); if (b) b.click(); }, 300);
  if (cfg.clickTab) setTimeout(function () { var b = document.querySelector('[data-tab="' + cfg.clickTab + '"]'); if (b) b.click(); }, 300);
  var text = function (id) { return (document.getElementById(id) || {}).textContent || ""; };
  // Open every folded chart section, as a user tapping "กราฟ" would (charts draw when opened).
  // The cards live in the Signals pane (v8 bottom bar): go there first, as a user would.
  if (cfg.openDetails) setTimeout(function () {
    var nav = document.querySelector('#smNav [data-pane="sig"]'); if (nav) nav.click();
    Array.prototype.forEach.call(document.querySelectorAll("#smMain details[data-draw]"), function (d) { d.open = true; });
  }, cfg.openDetails);
  // Routine: tick the first daily item, back up through the share sheet, then try to restore from a wrong text.
  if (cfg.routine) setTimeout(function () {
    var t = document.querySelector('[data-rt="day:0"]');
    if (t) { t.checked = true; t.dispatchEvent(new Event("change")); }
    setTimeout(function () {
      var b = document.getElementById("rtBackup"); if (b) b.click();
      var box = document.getElementById("rtRestoreBox"), r = document.getElementById("rtRestore");
      if (box && r) { box.value = '{"app":"other"}'; r.click(); }
    }, 300);
  }, cfg.routine);
  setTimeout(function () {
    var pkt = __T.packets[__T.packets.length - 1] || null;
    var pre = document.createElement("pre"); pre.id = "packet"; pre.textContent = JSON.stringify(pkt); document.body.appendChild(pre);
    document.title = "RESULT " + JSON.stringify({ packets: __T.packets.length, scanMinutes: __T.scanMinutes,
      spot: __T.requests.filter(function (r) { return r.indexOf("SPOT") === 0; }), status: (document.getElementById("scanStatus") || {}).textContent || "",
      scanCards: text("scanCards"), smMain: text("smMain"), coach: text("coach"), paper: text("ppSimple") + " | " + text("ppHero") + " | " + text("ppTrades"),
      paperStatus: text("ppStatus"), paperTitle: text("ppTitle"), help: text("sgHelp"), chartPlan: text("cvAnalysis"), news: text("smNews"), newsTone: Array.prototype.map.call(document.querySelectorAll("#smNews .nw-row"), function (el) { return [el.className, el.querySelector("a").textContent, getComputedStyle(el.querySelector("a")).color]; }), newsTop: text("smNewsTop"), aiLeft: localStorage.getItem("aiKeys"), conf: text("smMain").indexOf("ความมั่นใจของสูตร") >= 0, chart: !!document.querySelector("#smChart canvas"),
      charts: Array.prototype.filter.call(document.querySelectorAll("#smMain .sm-chart"), function (el) { return !!el.querySelector("canvas"); }).length,
      paperCheck: text("ppCheck"), tfButtons: document.querySelectorAll("#smMain [data-tf]").length,
      holds: Array.prototype.map.call(document.querySelectorAll("#smMain .hold"), function (el) { return el.className; }), live: text("smLive"), ws: __T.ws || "", routine: text("smRoutine"), rtStatus: text("rtStatus"), shared: __T.shared || "", floatAlert: text("floatAlert"), floatShown: !document.getElementById("floatAlert").classList.contains("hidden"),
      floatCls: Array.prototype.map.call(document.querySelectorAll("#floatAlert .fa"), function (el) { return el.className; }),
      badge: text("liveBadge"), badgeCls: (document.getElementById("liveBadge") || {}).className || "",
      acts: Array.prototype.map.call(document.querySelectorAll("#smMain .act"), function (el) { return el.className; }),
      sheets: Array.prototype.map.call(document.querySelectorAll("#smMain .sm-sheet"), function (el) { return el.className; }),
      home: (document.querySelector('#smMain [data-pane="home"]') || {}).textContent || "", res: (document.querySelector('#smMain [data-pane="res"]') || {}).textContent || "",
      homeRows: Array.prototype.filter.call(document.querySelectorAll("#smMain [data-mini]"), function (el) { return !el.classList.contains("hidden"); }).map(function (el) { return el.textContent; }),
      navPanes: Array.prototype.map.call(document.querySelectorAll("#smNav [data-pane]"), function (b) { return b.getAttribute("data-pane"); }),
      paneOn: document.getElementById("simpleView").getAttribute("data-on"), more: text("smMoreDyn") });
  }, cfg.waitMs || 12000);
})();
