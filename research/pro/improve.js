// Can Trend 4H (web/trend.js, the app's scale-out plan) be made better: more profit for the same drawdown, more winners,
// better trades? Everything below is fixed before the run; a change goes into the app only if it passes all its checks.
//
// Data: the 12 coins 2020-01..2026-09 (2020-2022 to choose, 2023-2026 to check), 25 coins never used to choose anything
// (2020-01..2026-09, some delisted since) and Binance spot 2017-08..2019-12 (before every year used to choose). Costs,
// fills and the leverage filter as the app. Portfolio: 0.5% of equity risked per trade, every trade taken.
//
// 1. Entry filters (skip some signals). Chosen on 2020-2022 by CAGR / max drawdown (MAR). The chosen filter is adopted
//    only if (a) 2023-2026: MAR and average R beat no filter, (b) unseen coins: MAR and average R beat no filter,
//    (c) spot 2017-2019: average R beats no filter, and (d) over (a)-(c) together the trades it skips average lower than
//    the trades it keeps, t >= 2.
// 2. Managing the rest after TP1 (stop to breakeven or to +1R). Same choice and checks; (d) is the per-trade difference
//    over (a)-(c), t >= 2.
// 3. How many coins: 12, 24 (the 12 + the first 12 unseen coins in the list) or all 37, at the same risk per trade.
//    Chosen on 2020-2022 by MAR, adopted if 2023-2026 MAR beats 12 coins too (one check only: weaker evidence).
// Fear & Greed filters: the 2023-2026 result on the 12 coins was seen before this run (research/pro/sentiment.js), so
// for them only (b) and (c) are fresh evidence; spot trades before the index existed (2018-02) are kept.
// Usage: node improve.js BASE_COINS UNSEEN_COINS SPOT_COINS   (bars from ../evidence/bars, index from ../evidence/fng.json)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [BASE, UNSEEN, SPOT] = process.argv.slice(2, 5).map(x => x.split(","));
const H = 3600000, MMR_SAFE = 0.01, RISK = 0.005, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1), SPOT_FROM = Date.UTC(2017, 8, 1);
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const load = name => {
  const p = `../evidence/bars/${name}.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], close_time: r[6] })) : null;
};
const fngPath = "../evidence/fng.json";
const fng = fs.existsSync(fngPath) ? JSON.parse(fs.readFileSync(fngPath, "utf8")).data.map(d => ({ t: +d.timestamp * 1000, v: +d.value })).sort((a, b) => a.t - b.t) : [];
// The index value published before time t (null before the index existed).
function fngAt(t) {
  let lo = 0, hi = fng.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fng[m].t <= t - 60000) { k = m; lo = m + 1; } else hi = m - 1; }
  return k < 0 || t - fng[k].t > 3 * 24 * H ? null : fng[k].v;
}
// Wilder's ADX.
function adx(b, n) {
  const out = new Array(b.length).fill(NaN);
  let tr = 0, pdm = 0, ndm = 0, a = NaN, dxs = [];
  for (let i = 1; i < b.length; i++) {
    const up = b[i].high - b[i - 1].high, dn = b[i - 1].low - b[i].low;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
    if (i <= n) { tr += t; pdm += p; ndm += m; if (i < n) continue; }
    else { tr += t - tr / n; pdm += p - pdm / n; ndm += m - ndm / n; }
    const pdi = tr ? 100 * pdm / tr : 0, ndi = tr ? 100 * ndm / tr : 0, dx = pdi + ndi ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0;
    if (isNaN(a)) { dxs.push(dx); if (dxs.length === n) a = dxs.reduce((x, y) => x + y, 0) / n; }
    else a = (a * (n - 1) + dx) / n;
    out[i] = a;
  }
  return out;
}
const sma = (xs, n) => { const o = new Array(xs.length).fill(NaN); let s = 0; xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; if (i >= n - 1) o[i] = s / n; }); return o; };
// What each filter looks at, on the signal bar (the bar before the entry).
function context(b, btc) {
  const C = b.map(x => x.close), A20 = Trend.atr(b, 20), A100 = Trend.atr(b, 100), E = Trend.ema(C, 200), D = adx(b, 14), V = sma(b.map(x => x.volume || 0), 20);
  const btcAt = {};
  if (btc) { const BE = Trend.ema(btc.map(x => x.close), 200); btc.forEach((x, i) => { if (i >= 200) btcAt[x.time] = x.close > BE[i] ? 1 : -1; }); }
  return t => {
    const s = t.entry_index - 1, x = b[s];
    let hi = -Infinity, lo = Infinity;
    for (let k = s - 20; k < s; k++) { hi = Math.max(hi, b[k].high); lo = Math.min(lo, b[k].low); }
    return { adx: D[s], vol: V[s - 1] > 0 ? x.volume / V[s - 1] : null, ext: (t.dir > 0 ? x.close - hi : lo - x.close) / A20[s], squeeze: A20[s] < A100[s],
      slope: t.dir * (E[s] - E[s - 30]) > 0, btc: btcAt[x.time] === undefined ? null : btcAt[x.time], fng: fngAt(t.entry_time) };
  };
}
const FILTERS = [
  { id: "none", name: "ไม่กรอง (ทุกสัญญาณ)", keep: () => true },
  { id: "btc", name: "เข้าตามทิศ BTC (BTC เหนือ/ใต้ EMA200)", keep: (t, c) => c.btc === null || c.btc === t.dir },
  { id: "adx20", name: "ADX(14) ≥ 20 (มีเทรนด์)", keep: (t, c) => c.adx >= 20 },
  { id: "adx25", name: "ADX(14) ≥ 25 (เทรนด์แรง)", keep: (t, c) => c.adx >= 25 },
  { id: "vol15", name: "Volume แท่งสัญญาณ ≥ 1.5 เท่าเฉลี่ย 20 แท่ง", keep: (t, c) => c.vol === null || c.vol >= 1.5 },
  { id: "ext1", name: "ไม่ไล่ราคา: ปิดเลยกรอบไม่เกิน 1 ATR", keep: (t, c) => c.ext <= 1 },
  { id: "squeeze", name: "ทะลุจากช่วงเงียบ: ATR20 < ATR100", keep: (t, c) => c.squeeze },
  { id: "slope", name: "EMA200 ชี้ทางเดียวกัน (30 แท่ง)", keep: (t, c) => c.slope },
  { id: "fngContra", name: "ไม่ LONG ตอนโลภสุดขีด (≥75) · ไม่ SHORT ตอนกลัวสุดขีด (≤25)", keep: (t, c) => c.fng === null || (t.dir > 0 ? c.fng < 75 : c.fng > 25) },
  { id: "fngExtreme", name: "ไม่เข้าตอนสุดขีด (≤20 หรือ ≥80)", keep: (t, c) => c.fng === null || (c.fng > 20 && c.fng < 80) }
];
const MANAGE = [
  { id: "none", name: "ตามเดิม: SL เดิมจนออก", opt: {} },
  { id: "be0", name: "ถึง TP1 แล้วเลื่อน SL ส่วนที่เหลือมาที่ทุน", opt: { beAfterTp: 0 } },
  { id: "be1", name: "ถึง TP1 แล้วเลื่อน SL ส่วนที่เหลือมาที่ +1R", opt: { beAfterTp: 1 } }
];
const summary = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  const w = tr.filter(t => t.r > 0).length, gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
  return { n, win: +(100 * w / n).toFixed(1), avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)], pf: gl ? +(gp / gl).toFixed(2) : null, t: +(m / se).toFixed(2) };
};
const meanVar = xs => { const n = xs.length, m = xs.reduce((a, x) => a + x, 0) / n; return { n, m, v: xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, n - 1) }; };
const welch = (a, b) => { if (a.length < 2 || b.length < 2) return null; const A = meanVar(a), B = meanVar(b); return +((A.m - B.m) / Math.sqrt(A.v / A.n + B.v / B.n)).toFixed(2); };
const pairedT = d => { if (d.length < 2) return null; const S = meanVar(d); return S.v ? +(S.m / Math.sqrt(S.v / S.n)).toFixed(2) : null; };
function port(tr, from, to) {
  const ev = [], stake = {}, months = {};
  // A trade stopped in the bar it entered exits at its entry time: book the exit just after the entry, so it counts.
  tr.forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, i }); ev.push({ time: Math.max(t.exit_time, t.entry_time + 1), k: 0, i, r: t.r }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  let eq = 1, peak = 1, dd = 0;
  for (const e of ev) {
    if (e.k === 1) stake[e.i] = eq * RISK;
    else { const before = eq; eq = Math.max(0.01, eq + stake[e.i] * e.r); peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
      const m = new Date(e.time).toISOString().slice(0, 7); months[m] = (months[m] || 1) * (eq / before); }
  }
  const mv = [];
  for (let d = new Date(from); d.getTime() < to; d.setUTCMonth(d.getUTCMonth() + 1)) mv.push(months[d.toISOString().slice(0, 7)] || 1);
  const yrs = (to - from) / (365.25 * 24 * H), cagr = 100 * (Math.pow(eq, 1 / yrs) - 1);
  return { cagr: +cagr.toFixed(1), maxDD: +(100 * dd).toFixed(1), mar: dd > 0 ? +(cagr / (100 * dd)).toFixed(2) : null,
    losingMonths: +(100 * mv.filter(v => v < 1).length / mv.length).toFixed(0), perMonth: +(tr.length / (yrs * 12)).toFixed(1) };
}
// Trades of the app's rule (scale-out plan, leverage filter) on a group of coins, entries in [from, to), with the filter context.
const cache = {};
function trades(coins, prefix, from, to, opt) {
  const btc = load(prefix + "BTCUSDT_4h");
  return [].concat(...coins.map(c => {
    const key = prefix + c, b = cache[key] || (cache[key] = load(prefix + c + "_4h"));
    if (!b) return [];
    const ctx = context(b, btc);
    return Trend.run(b, Object.assign({ tps: LADDER }, opt)).trades.filter(t => t.entry_time >= from && t.entry_time < to && levLiq(t) >= 5)
      .map(t => Object.assign({ coin: c, ctx: ctx(t) }, t));
  }));
}
const have = (coins, prefix) => coins.filter(c => fs.existsSync(`../evidence/bars/${prefix}${c}_4h.json`));
const unseen = have(UNSEEN, ""), spot = have(SPOT, "spot_");
console.log("12 coins:", have(BASE, "").length, "· unseen with data:", unseen.length, unseen.join(","), "· spot:", spot.join(","), "· Fear & Greed days:", fng.length);
const SETS = {
  train: { name: "12 เหรียญ 2020–2022 (ใช้เลือก)", coins: BASE, prefix: "", from: Y(2020), to: Y(2023) },
  test: { name: "12 เหรียญ 2023–2026 (ตรวจ)", coins: BASE, prefix: "", from: Y(2023), to: END },
  unseen: { name: "25 เหรียญที่ไม่เคยใช้เลือก 2020–2026", coins: unseen, prefix: "", from: Y(2020), to: END },
  spot: { name: "Spot 2017–2019 (ก่อนทุกปีที่ใช้เลือก)", coins: spot, prefix: "spot_", from: SPOT_FROM, to: Y(2020) }
};
const stat = (tr, S) => Object.assign(summary(tr), { port: port(tr, S.from, S.to) });
const out = { generated: new Date().toISOString().slice(0, 10), risk: RISK * 100, ladder: LADDER, sets: {}, filters: {}, manage: {}, universe: {} };
for (const [k, S] of Object.entries(SETS)) out.sets[k] = { name: S.name, coins: S.coins.length, from: new Date(S.from).toISOString().slice(0, 7), to: new Date(S.to).toISOString().slice(0, 7) };

// 1. Entry filters.
const base = {}; for (const [k, S] of Object.entries(SETS)) base[k] = trades(S.coins, S.prefix, S.from, S.to, {});
const fRows = FILTERS.map(F => {
  const row = { id: F.id, name: F.name };
  for (const k of Object.keys(SETS)) row[k] = stat(base[k].filter(t => F.keep(t, t.ctx)), SETS[k]);
  const kept = [], skipped = [];
  for (const k of ["test", "unseen", "spot"]) base[k].forEach(t => (F.keep(t, t.ctx) ? kept : skipped).push(t.r));
  row.skipped = { n: skipped.length, avgR: skipped.length ? +(skipped.reduce((a, x) => a + x, 0) / skipped.length).toFixed(3) : null, t: welch(kept, skipped) };
  return row;
});
const fNone = fRows[0], fChosen = fRows.slice().sort((a, b) => (b.train.port.mar || 0) - (a.train.port.mar || 0))[0];
const better = (r, k) => r[k].port.mar > fNone[k].port.mar && r[k].avgR > fNone[k].avgR;
const fChecks = fChosen.id === "none" ? null : { test: better(fChosen, "test"), unseen: better(fChosen, "unseen"), spot: fChosen.spot.avgR > fNone.spot.avgR, skippedWorse: fChosen.skipped.t !== null && fChosen.skipped.t >= 2 };
out.filters = { rows: fRows, chosen: fChosen.id, checks: fChecks, adopt: !!fChecks && Object.values(fChecks).every(Boolean) };
console.log("\n== 1. entry filters (scale-out, 0.5% risk) ==");
fRows.forEach(r => console.log(`  ${r.id.padEnd(10)} ` + ["train", "test", "unseen", "spot"].map(k => `${k} n${r[k].n} win${r[k].win}% ${r[k].avgR}R t${r[k].t} MAR${r[k].port.mar} CAGR${r[k].port.cagr} DD${r[k].port.maxDD}`).join(" | ") +
  ` | skipped n${r.skipped.n} ${r.skipped.avgR}R t(kept-skipped) ${r.skipped.t}`));
console.log(`  chosen on 2020-2022: ${fChosen.id} · checks ${JSON.stringify(fChecks)} · adopt ${out.filters.adopt}`);

// 2. Managing the rest after TP1.
const mTrades = MANAGE.map(M => { const o = {}; for (const [k, S] of Object.entries(SETS)) o[k] = trades(S.coins, S.prefix, S.from, S.to, M.opt); return o; });
const mRows = MANAGE.map((M, j) => {
  const row = { id: M.id, name: M.name };
  for (const k of Object.keys(SETS)) row[k] = stat(mTrades[j][k], SETS[k]);
  const d = [];
  for (const k of ["test", "unseen", "spot"]) {
    const ref = {}; mTrades[0][k].forEach(t => (ref[t.coin + t.entry_time] = t.r));
    mTrades[j][k].forEach(t => { if (ref[t.coin + t.entry_time] !== undefined) d.push(t.r - ref[t.coin + t.entry_time]); });
  }
  row.diff = { n: d.length, avgR: d.length ? +(d.reduce((a, x) => a + x, 0) / d.length).toFixed(3) : null, t: pairedT(d) };
  return row;
});
const mNone = mRows[0], mChosen = mRows.slice().sort((a, b) => (b.train.port.mar || 0) - (a.train.port.mar || 0))[0];
const mBetter = (r, k) => r[k].port.mar > mNone[k].port.mar && r[k].avgR > mNone[k].avgR;
const mChecks = mChosen.id === "none" ? null : { test: mBetter(mChosen, "test"), unseen: mBetter(mChosen, "unseen"), spot: mChosen.spot.avgR > mNone.spot.avgR, pairedBetter: mChosen.diff.t !== null && mChosen.diff.t >= 2 };
out.manage = { rows: mRows, chosen: mChosen.id, checks: mChecks, adopt: !!mChecks && Object.values(mChecks).every(Boolean) };
console.log("\n== 2. the rest after TP1 ==");
mRows.forEach(r => console.log(`  ${r.id.padEnd(6)} ` + ["train", "test", "unseen", "spot"].map(k => `${k} n${r[k].n} win${r[k].win}% ${r[k].avgR}R MAR${r[k].port.mar} CAGR${r[k].port.cagr} DD${r[k].port.maxDD}`).join(" | ") + ` | vs none ${r.diff.avgR}R t${r.diff.t}`));
console.log(`  chosen on 2020-2022: ${mChosen.id} · checks ${JSON.stringify(mChecks)} · adopt ${out.manage.adopt}`);

// 3. How many coins.
const groups = [{ id: "12", coins: BASE }, { id: "24", coins: BASE.concat(unseen.slice(0, 12)) }, { id: "37", coins: BASE.concat(unseen) }];
const uRows = groups.map(g => {
  const tr = trades(g.coins, "", Y(2020), Y(2023), {}), te = trades(g.coins, "", Y(2023), END, {});
  return { id: g.id, coins: g.coins.length, train: stat(tr, SETS.train), test: stat(te, SETS.test) };
});
const uChosen = uRows.slice().sort((a, b) => (b.train.port.mar || 0) - (a.train.port.mar || 0))[0];
out.universe = { rows: uRows, chosen: uChosen.id, adopt: uChosen.id !== "12" && uChosen.test.port.mar > uRows[0].test.port.mar, note: "one check (2023-2026): weaker evidence than 1 and 2" };
console.log("\n== 3. how many coins ==");
uRows.forEach(r => console.log(`  ${r.id.padEnd(3)} coins ${r.coins} · train n${r.train.n} ${r.train.avgR}R MAR${r.train.port.mar} CAGR${r.train.port.cagr} DD${r.train.port.maxDD} ${r.train.port.perMonth}/month · test n${r.test.n} ${r.test.avgR}R MAR${r.test.port.mar} CAGR${r.test.port.cagr} DD${r.test.port.maxDD} ${r.test.port.perMonth}/month`));
console.log(`  chosen on 2020-2022: ${uChosen.id} coins · adopt ${out.universe.adopt}`);

fs.writeFileSync("improve.json", JSON.stringify(out, null, 1) + "\n");
console.log("IMPROVE=" + JSON.stringify({ filters: { chosen: out.filters.chosen, checks: fChecks, adopt: out.filters.adopt }, manage: { chosen: out.manage.chosen, checks: mChecks, adopt: out.manage.adopt }, universe: { chosen: out.universe.chosen, adopt: out.universe.adopt } }));
