/* Runs after the app: forces Squeeze signals on the last closed bar for the coins in cfg.force
 * (the strategy itself is covered by research/; this tests what happens after a signal), then
 * reports the captured packets in document.title for run_tests.py. */
(function () {
  var cfg = window.__CFG, force = cfg.force || {};
  if (window.__EVIDENCE_OVERRIDE) window.EVIDENCE = window.__EVIDENCE_OVERRIDE;
  var real = Swing.signal;
  Swing.signal = function (id, bars, ind, i, opt) {
    if (i === bars.length - 1) {
      var c = bars[i].close, best = null, d = Infinity;
      Object.keys(window.__SPEC).forEach(function (s) { var x = Math.abs(Math.log(c / window.__SPEC[s][0])); if (x < d) { d = x; best = s; } });
      if (force[best]) return { dir: force[best] === "SHORT" ? -1 : 1, dist: c * (cfg.stopFrac || 0.012), rr: 5 };
      return null;
    }
    return real(id, bars, ind, i, opt);
  };
  if (cfg.capital) { document.getElementById("pfCapital").value = String(cfg.capital); }
  if (cfg.clickTf) setTimeout(function () { var b = document.querySelector('#smMain [data-tf="' + cfg.clickTf + '"]'); if (b) b.click(); }, 200);
  setTimeout(function () {
    var pkt = __T.packets[__T.packets.length - 1] || null;
    var pre = document.createElement("pre"); pre.id = "packet"; pre.textContent = JSON.stringify(pkt); document.body.appendChild(pre);
    document.title = "RESULT " + JSON.stringify({ packets: __T.packets.length, posts: __T.posts.length, scanMinutes: __T.scanMinutes,
      spot: __T.requests.filter(function (r) { return r.indexOf("SPOT") === 0; }), status: (document.getElementById("scanStatus") || {}).textContent || "",
      scanCards: (document.getElementById("scanCards") || {}).textContent || "", smMain: (document.getElementById("smMain") || {}).textContent || "" });
  }, cfg.waitMs || 12000);
})();
