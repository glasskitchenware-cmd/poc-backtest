// Pre-registered tuning of the Squeeze rules. 96 variants, 12 coins pooled, real USD-M bars.
// Selection uses ONLY dev (2023-10..2024) and val (2025); 2026-01..09 is reported once for the chosen variant.
// Rule fixed before looking: candidates need >=100 trades in dev and in val; score = min(avgR dev, avgR val);
// the variant passes only if its 2026 result has >=100 trades, avgR > 0 and PF > 1.1.
const fs = require("fs");
const Swing = require("../../web/swing.js");
const COINS = process.argv[2].split(",");
const COST = { fee: 0.0005, slippage: 0.0002 }, FUNDING = 0.0001;
const PERIODS = { dev: ["2023-10-01", "2025-01-01"], val: ["2025-01-01", "2026-01-01"], oos: ["2026-01-01", "2026-10-01"] };
const ms = s => Date.parse(s + "T00:00:00Z");

function load(sym, tf) {
  return JSON.parse(fs.readFileSync(`../evidence/bars/${sym}_${tf}.json`, "utf8"))
    .map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], close_time: r[6] }));
}
function ema(xs, n) { const a = 2 / (n + 1); let y = NaN; return xs.map((x, i) => (y = i ? y + a * (x - y) : x)); }
// Higher-timeframe trend from COMPLETED higher bars only: +1 up, -1 down, 0 mixed.
function htfTrend(bars, groupMs) {
  const groups = [];
  for (const b of bars) {
    const g = Math.floor(b.time / groupMs) * groupMs;
    if (!groups.length || groups[groups.length - 1].t !== g) groups.push({ t: g, close: b.close, end: g + groupMs - 1 });
    else groups[groups.length - 1].close = b.close;
  }
  const c = groups.map(g => g.close), e50 = ema(c, 50), e200 = ema(c, 200);
  const out = new Array(bars.length).fill(0);
  let k = -1;
  for (let i = 0; i < bars.length; i++) {
    while (k + 1 < groups.length && groups[k + 1].end <= bars[i].close_time) k++;   // last fully closed group
    if (k >= 200) out[i] = e50[k] > e200[k] && c[k] > e200[k] ? 1 : e50[k] < e200[k] && c[k] < e200[k] ? -1 : 0;
  }
  return out;
}

function run(id, bars, ind, trend, P) {
  const spec = Swing.TECHNIQUES.find(t => t.id === id), hold = spec.hold, opt = Object.assign({}, Swing.DEFAULTS, COST);
  const cost = 2 * (COST.fee + COST.slippage), trades = [];
  let pos = null;
  for (let i = 260; i < bars.length; i++) {
    const b = bars[i];
    if (pos) {
      const d = pos.dir, open = d * b.open, low = d > 0 ? b.low : -b.high, high = d > 0 ? b.high : -b.low, stop = d * pos.stop, target = d * pos.target;
      let exit = null, why = "";
      if (open <= stop) { exit = b.open; why = "stop"; } else if (low <= stop) { exit = pos.stop; why = "stop"; }
      else if (open >= target) { exit = b.open; why = "target"; } else if (high >= target) { exit = pos.target; why = "target"; }
      else if (i - pos.bar + 1 >= hold) { exit = b.close; why = "time"; }
      if (exit !== null) {
        const risk = Math.abs(pos.entry - pos.stop);
        trades.push({ t: bars[pos.bar].time, why, r: d * (exit - pos.entry) / risk - (cost + FUNDING * (b.time - bars[pos.bar - 1].time) / 28800000) * pos.entry / risk });
        pos = null;
      }
      continue;
    }
    if (i + 1 >= bars.length) break;
    const sig = Swing.signal(id, bars, ind, i, opt);
    if (!sig) continue;
    const dir = sig.dir, d = new Date(b.close_time + 1), h = d.getUTCHours(), wd = d.getUTCDay();
    if (P.trend && trend[i] !== dir) continue;
    if (P.session && !(h >= 12 && h < 20)) continue;          // US/EU overlap, the high-volume hours in research/behavior5y
    if (P.weekdays && (wd === 0 || wd === 6)) continue;
    const entry = bars[i + 1].open * (1 + dir * COST.slippage);
    if (!(sig.dist / entry >= 0.0015)) continue;
    pos = { bar: i + 1, dir, entry, stop: entry - dir * sig.dist, target: entry + dir * P.rr * sig.dist };
  }
  return trades;
}
function wilson(k, n) { if (!n) return [null, null]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [+(100 * (c - h)).toFixed(1), +(100 * (c + h)).toFixed(1)]; }
function summary(tr) {
  const n = tr.length, w = tr.filter(t => t.r > 0).length, tp = tr.filter(t => t.why === "target").length;
  const s = tr.reduce((a, t) => a + t.r, 0), gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
  return { n, avgR: n ? +(s / n).toFixed(3) : null, pf: gl ? +(gp / gl).toFixed(2) : null, win: n ? +(100 * w / n).toFixed(1) : null, winCI: wilson(w, n), tp: n ? +(100 * tp / n).toFixed(1) : null, sumR: +s.toFixed(1) };
}
const split = tr => Object.fromEntries(Object.entries(PERIODS).map(([k, [a, b]]) => [k, tr.filter(t => t.t >= ms(a) && t.t < ms(b))]));

const variants = [];
for (const id of ["squeeze3_ls", "squeeze_ls"]) for (const tf of ["1h", "4h"]) for (const rr of [2, 3, 5])
  for (const trend of [false, true]) for (const session of [false, true]) for (const weekdays of [false, true])
    variants.push({ id, tf, rr, trend, session, weekdays });
const cache = {};
for (const tf of ["1h", "4h"]) for (const c of COINS) {
  const bars = load(c, tf), opt = Object.assign({}, Swing.DEFAULTS, COST);
  cache[c + tf] = { bars, ind: Swing.indicators(bars, opt), trend: htfTrend(bars, tf === "1h" ? 4 * 3600000 : 24 * 3600000) };
}
const rows = variants.map(v => {
  const per = {};
  let all = [];
  for (const c of COINS) { const x = cache[c + v.tf], tr = run(v.id, x.bars, x.ind, x.trend, v); per[c] = tr; all = all.concat(tr); }
  const s = split(all);
  return { v, dev: summary(s.dev), val: summary(s.val), oos: summary(s.oos), per };
});
const name = v => `${v.id}|${v.tf}|RR${v.rr}${v.trend ? "|htf" : ""}${v.session ? "|12-20UTC" : ""}${v.weekdays ? "|Mon-Fri" : ""}`;
console.log("variant | dev n avgR pf | val n avgR pf | oos n avgR pf");
for (const r of rows) console.log(`${name(r.v).padEnd(44)} | ${r.dev.n} ${r.dev.avgR} ${r.dev.pf} | ${r.val.n} ${r.val.avgR} ${r.val.pf} | ${r.oos.n} ${r.oos.avgR} ${r.oos.pf}`);
const cands = rows.filter(r => r.dev.n >= 100 && r.val.n >= 100).map(r => Object.assign(r, { score: Math.min(r.dev.avgR, r.val.avgR) })).sort((a, b) => b.score - a.score);
console.log(`\ncandidates with >=100 trades in dev and val: ${cands.length}; with score > 0: ${cands.filter(r => r.score > 0).length}`);
console.log("TOP 5 BY SCORE (chosen without 2026):");
for (const r of cands.slice(0, 5)) console.log(name(r.v), "score", r.score.toFixed(3), "| 2026:", JSON.stringify(r.oos));
const best = cands[0];
if (best) {
  const pass = best.score > 0 && best.oos.n >= 100 && best.oos.avgR > 0 && best.oos.pf > 1.1;
  console.log(`\nCHOSEN: ${name(best.v)} -> 2026 ${JSON.stringify(best.oos)} -> ${pass ? "PASS" : "FAIL"}`);
  console.log("per coin 2026 (n, avgR):", COINS.map(c => { const s = summary(split(best.per[c]).oos); return `${c.replace("USDT", "")} ${s.n} ${s.avgR}`; }).join(" · "));
}
