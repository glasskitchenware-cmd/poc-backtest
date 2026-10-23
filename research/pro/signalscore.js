// A confidence for each Trend 4H signal: can what is known at the signal (its risk, trend strength, volume, mood, ...)
// tell the signals that win more often from the rest? Everything below is fixed before the run.
//  - 10 traits measured on the signal bar (see TRAITS). A logistic regression of "the trade won" (R > 0) on them is fitted
//    on the 12 coins 2020-2022 only (traits standardised with that period's mean and spread); its score splits signals
//    into tiers A / B / C at the 2020-2022 thirds.
//  - Also the simplest risk tiering: the stop distance in % of the price, at the 2020-2022 thirds (tight / mid / wide).
//  - Checked on 2023-2026 (12 coins), the 25 coins never used to choose anything (2020-2026) and spot 2017-2019.
//  - A tiering is shown in the app only if on each of the three: win rate A > B > C, and tier A's average R is above
//    the average of all signals.
// Costs, fills and the leverage filter as the app, scale-out plan.
// Usage: node signalscore.js BASE_COINS UNSEEN_COINS SPOT_COINS   (4h bars from ../evidence/bars, ../evidence/fng.json)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [BASE, UNSEEN, SPOT] = process.argv.slice(2, 5).map(x => x.split(","));
const H = 3600000, MMR_SAFE = 0.01, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1), SPOT_FROM = Date.UTC(2017, 8, 1);
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const load = name => {
  const p = `../evidence/bars/${name}.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], close_time: r[6] })) : null;
};
const fng = fs.existsSync("../evidence/fng.json") ? JSON.parse(fs.readFileSync("../evidence/fng.json", "utf8")).data.map(d => ({ t: +d.timestamp * 1000, v: +d.value })).sort((a, b) => a.t - b.t) : [];
function fngAt(t) {
  let lo = 0, hi = fng.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fng[m].t <= t - 60000) { k = m; lo = m + 1; } else hi = m - 1; }
  return k < 0 || t - fng[k].t > 3 * 24 * H ? null : fng[k].v;
}
function adx(b, n) {
  const out = new Array(b.length).fill(NaN);
  let tr = 0, pdm = 0, ndm = 0, a = NaN; const dxs = [];
  for (let i = 1; i < b.length; i++) {
    const up = b[i].high - b[i - 1].high, dn = b[i - 1].low - b[i].low, p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
    if (i <= n) { tr += t; pdm += p; ndm += m; if (i < n) continue; } else { tr += t - tr / n; pdm += p - pdm / n; ndm += m - ndm / n; }
    const pdi = tr ? 100 * pdm / tr : 0, ndi = tr ? 100 * ndm / tr : 0, dx = pdi + ndi ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0;
    if (isNaN(a)) { dxs.push(dx); if (dxs.length === n) a = dxs.reduce((x, y) => x + y, 0) / n; } else a = (a * (n - 1) + dx) / n;
    out[i] = a;
  }
  return out;
}
const sma = (xs, n) => { const o = new Array(xs.length).fill(NaN); let s = 0; xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; if (i >= n - 1) o[i] = s / n; }); return o; };
const TRAITS = ["stopPct", "atrRatio", "adx", "volRatio", "ext", "emaDist", "btcWith", "fngWith", "width", "slopeWith"];
// The traits of a trade, on its signal bar (the bar before the entry).
function traitsOf(b, btc) {
  const C = b.map(x => x.close), A20 = Trend.atr(b, 20), A100 = Trend.atr(b, 100), E = Trend.ema(C, 200), D = adx(b, 14), V = sma(b.map(x => x.volume || 0), 20);
  const btcAt = {};
  if (btc) { const BE = Trend.ema(btc.map(x => x.close), 200); btc.forEach((x, i) => { if (i >= 200) btcAt[x.time] = x.close > BE[i] ? 1 : -1; }); }
  return t => {
    const s = t.entry_index - 1, x = b[s];
    let hi = -Infinity, lo = Infinity;
    for (let k = s - 20; k < s; k++) { hi = Math.max(hi, b[k].high); lo = Math.min(lo, b[k].low); }
    const f = fngAt(t.entry_time), bd = btcAt[x.time];
    return { stopPct: 100 * t.risk / t.entry, atrRatio: A20[s] / A100[s], adx: D[s], volRatio: V[s - 1] > 0 ? x.volume / V[s - 1] : null,
      ext: (t.dir > 0 ? x.close - hi : lo - x.close) / A20[s], emaDist: t.dir * (x.close - E[s]) / A20[s], btcWith: bd === undefined ? null : bd === t.dir ? 1 : 0,
      fngWith: f === null ? null : t.dir * (f - 50) / 50, width: (hi - lo) / A20[s], slopeWith: t.dir * (E[s] - E[s - 30]) > 0 ? 1 : 0 };
  };
}
const cache = {};
function trades(coins, prefix, from, to) {
  const btc = load(prefix + "BTCUSDT_4h");
  return [].concat(...coins.map(c => {
    const key = prefix + c, b = cache[key] || (cache[key] = load(prefix + c + "_4h"));
    if (!b) return [];
    const tr = traitsOf(b, btc);
    return Trend.run(b, { tps: LADDER }).trades.filter(t => t.entry_time >= from && t.entry_time < to && levLiq(t) >= 5)
      .map(t => ({ coin: c, r: t.r, win: t.r > 0 ? 1 : 0, entry_time: t.entry_time, x: tr(t) }));
  }));
}
const summary = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  const w = tr.filter(t => t.r > 0).length;
  return { n, win: +(100 * w / n).toFixed(1), avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)] };
};
// Standardise with the training period's mean and spread; a missing trait counts as average (0); clipped at ±4.
function scaler(tr) {
  const st = {};
  TRAITS.forEach(k => {
    const xs = tr.map(t => t.x[k]).filter(v => v !== null && isFinite(v)), m = xs.reduce((a, v) => a + v, 0) / xs.length;
    st[k] = { m, s: Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length) || 1 };
  });
  return t => [1].concat(TRAITS.map(k => { const v = t.x[k]; return v === null || !isFinite(v) ? 0 : Math.max(-4, Math.min(4, (v - st[k].m) / st[k].s)); }));
}
// Logistic regression by Newton steps with a small ridge (0.01 * n) on the traits (not the intercept).
function logit(X, y) {
  const p = X[0].length, n = X.length;
  let w = new Array(p).fill(0);
  for (let it = 0; it < 30; it++) {
    const g = new Array(p).fill(0), Hm = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((a, v, j) => a + v * w[j], 0), q = 1 / (1 + Math.exp(-z)), e = y[i] - q, ww = q * (1 - q);
      for (let j = 0; j < p; j++) { g[j] += e * X[i][j]; for (let k = 0; k < p; k++) Hm[j][k] += ww * X[i][j] * X[i][k]; }
    }
    for (let j = 1; j < p; j++) { g[j] -= 0.01 * n * w[j]; Hm[j][j] += 0.01 * n; }
    // Solve Hm d = g (Gaussian elimination).
    const A = Hm.map((row, j) => row.concat([g[j]]));
    for (let c = 0; c < p; c++) {
      let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < p; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k]; }
    }
    const d = A.map((row, j) => row[p] / row[j]);
    w = w.map((v, j) => v + d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-6) break;
  }
  return w;
}
const q = (xs, f) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const tiersOf = (tr, val, cut, labels) => {
  const o = {}; labels.forEach(l => (o[l] = []));
  tr.forEach(t => { const v = val(t); o[v >= cut[1] ? labels[0] : v >= cut[0] ? labels[1] : labels[2]].push(t); });
  return o;
};
const have = (coins, prefix) => coins.filter(c => fs.existsSync(`../evidence/bars/${prefix}${c}_4h.json`));
const SETS = {
  train: trades(BASE, "", Y(2020), Y(2023)), test: trades(BASE, "", Y(2023), END),
  unseen: trades(have(UNSEEN, ""), "", Y(2020), END), spot: trades(have(SPOT, "spot_"), "spot_", SPOT_FROM, Y(2020))
};
console.log("trades:", Object.entries(SETS).map(([k, v]) => k + " " + v.length).join(" · "), "· Fear & Greed days", fng.length);
const z = scaler(SETS.train), w = logit(SETS.train.map(z), SETS.train.map(t => t.win));
const score = t => z(t).reduce((a, v, j) => a + v * w[j], 0);
const cutScore = [q(SETS.train.map(score), 1 / 3), q(SETS.train.map(score), 2 / 3)];
const cutStop = [q(SETS.train.map(t => t.x.stopPct), 1 / 3), q(SETS.train.map(t => t.x.stopPct), 2 / 3)];
const out = { generated: new Date().toISOString().slice(0, 10), traits: TRAITS, model: { weights: w.map(v => +v.toFixed(4)), cut: cutScore }, stopCut: cutStop, sets: {}, perTrait: {} };
const pass = { score: true, stop: true };
for (const [k, tr] of Object.entries(SETS)) {
  const ts = tiersOf(tr, score, cutScore, ["A", "B", "C"]), tp = tiersOf(tr, t => -t.x.stopPct, [-cutStop[1], -cutStop[0]], ["tight", "mid", "wide"]);
  const all = summary(tr), sA = summary(ts.A), sB = summary(ts.B), sC = summary(ts.C), p1 = summary(tp.tight), p2 = summary(tp.mid), p3 = summary(tp.wide);
  out.sets[k] = { all, score: { A: sA, B: sB, C: sC }, stop: { tight: p1, mid: p2, wide: p3 } };
  if (k !== "train") {
    if (!(sA.win > sB.win && sB.win > sC.win && sA.avgR > all.avgR)) pass.score = false;
    // Risk tiers: whichever end wins more must do so in every set the same way as in 2020-2022.
    const trainTight = out.sets.train.stop.tight.win > out.sets.train.stop.wide.win;
    const ordered = trainTight ? p1.win > p2.win && p2.win > p3.win && p1.avgR > all.avgR : p3.win > p2.win && p2.win > p1.win && p3.avgR > all.avgR;
    if (!ordered) pass.stop = false;
  }
  console.log(`\n== ${k} == all ${JSON.stringify(all)}`);
  console.log("  score A", JSON.stringify(sA), "\n  score B", JSON.stringify(sB), "\n  score C", JSON.stringify(sC));
  console.log("  stop tight", JSON.stringify(p1), "\n  stop mid  ", JSON.stringify(p2), "\n  stop wide ", JSON.stringify(p3));
}
// Each trait alone, at its 2020-2022 thirds: win rate of the high third minus the low third, per set (for the record).
TRAITS.forEach(k => {
  const xs = SETS.train.map(t => t.x[k]).filter(v => v !== null && isFinite(v)), c = [q(xs, 1 / 3), q(xs, 2 / 3)];
  out.perTrait[k] = {};
  for (const [name, tr] of Object.entries(SETS)) {
    const ok = tr.filter(t => t.x[k] !== null && isFinite(t.x[k])), hi = summary(ok.filter(t => t.x[k] >= c[1])), lo = summary(ok.filter(t => t.x[k] < c[0]));
    out.perTrait[k][name] = { hiWin: hi.win, loWin: lo.win, hiR: hi.avgR, loR: lo.avgR };
  }
  console.log(`  trait ${k.padEnd(9)} ` + Object.entries(out.perTrait[k]).map(([s, v]) => `${s} hi ${v.hiWin}%/${v.hiR}R lo ${v.loWin}%/${v.loR}R`).join(" | "));
});
out.adopt = pass;
console.log("\nweights (intercept, " + TRAITS.join(", ") + "):", JSON.stringify(out.model.weights));
console.log("ADOPT score tiers:", pass.score, "· risk (stop distance) tiers:", pass.stop);
fs.writeFileSync("signalscore.json", JSON.stringify(out, null, 1) + "\n");
console.log("SIGNALSCORE=" + JSON.stringify(pass));
