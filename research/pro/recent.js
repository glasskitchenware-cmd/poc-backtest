// Why is Trend 4H losing lately? Rebuilds the last 30 days from Binance's archive bars with the app's own code
// (web/trend.js, scale-out plan, leverage filter) and compares them with 2023-2026, without assuming a cause.
//  - Every trade 2020-01..now as CSV (tradelist.csv): times, coin, side, entry, SL, TP1, exit, reason, gross R, fee,
//    slippage (in prices and charged), funding, net R, strategy and dataset versions.
//  - The last 30 days: by coin, by side, by entry day (how many lost together), and the market around them (BTC's 30-day
//    move, how straight it moved (efficiency ratio), the coins' ATR in % and their correlation) against 2023-2026.
//  - Where 30-day stretches of 2023-2026 stood: calendar 30-day windows (not trade counts), sum of R.
//  - Average R with a confidence interval that allows for coins losing together: bootstrap of whole weeks.
// Usage: node recent.js COINS NOW_MS   (4h bars from ../evidence/bars, including October 2026 from daily files)
const fs = require("fs"), crypto = require("crypto");
const Trend = require("../../web/trend.js");
const COINS = process.argv[2].split(","), NOW = +process.argv[3] || Date.now();
const H = 3600000, DAY = 86400000, MMR_SAFE = 0.01, Y = y => Date.UTC(y, 0, 1);
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const VERSION = crypto.createHash("sha256").update(fs.readFileSync("../../web/trend.js")).digest("hex").slice(0, 12);
const load = c => { const p = `../evidence/bars/${c}_4h.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], close_time: r[6] })) : null; };
const bars = {}, all = [];
for (const c of COINS) {
  const b = load(c); if (!b) continue;
  // Closed bars only, as the app: a bar is used once its close time has passed.
  bars[c] = b.filter(x => x.close_time < NOW);
  for (const t of Trend.run(bars[c], { tps: LADDER }).trades) if (t.entry_time >= Y(2020) && levLiq(t) >= 5 && t.reason !== "end") all.push(Object.assign({ coin: c }, t));
}
all.sort((a, b) => a.exit_time - b.exit_time);
const first = Math.min(...Object.values(bars).map(b => b[0].time)), last = Math.max(...Object.values(bars).map(b => b[b.length - 1].close_time));
const DATASET = `binance-um-4h ${new Date(first).toISOString().slice(0, 10)}..${new Date(last).toISOString().slice(0, 16)} ${Object.keys(bars).length} coins`;
const iso = t => new Date(t).toISOString().replace(".000Z", "Z");
const csv = ["entry_time,exit_time,coin,side,entry,stop,tp1,exit,reason,gross_r,fee_r,slip_in_price_r,slip_charged_r,funding_r,net_r,period,strategy,strategy_version,dataset"];
const period = t => t.entry_time < Y(2023) ? "train 2020-2022" : t.entry_time < Date.UTC(2026, 9, 1) ? "walk-forward evidence 2023-01..2026-09" : "after the evidence (live period)";
for (const t of all) csv.push([iso(t.entry_time), iso(t.exit_time), t.coin, t.dir > 0 ? "LONG" : "SHORT", t.entry, t.stop, t.entry + t.dir * LADDER[0].r * t.risk, t.exit, t.reason,
  t.cost.grossR.toFixed(4), t.cost.feeR.toFixed(4), t.cost.slipInPriceR.toFixed(4), t.cost.slipR.toFixed(4), t.cost.fundR.toFixed(4), t.r.toFixed(4), period(t),
  "Trend 4H Donchian 20/10 SL 3ATR EMA200 + 50% at 3R", VERSION, DATASET].join(","));
fs.writeFileSync("tradelist.csv", csv.join("\n") + "\n");
const S = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, gp = tr.reduce((a, t) => a + Math.max(0, t.r), 0), gl = tr.reduce((a, t) => a - Math.min(0, t.r), 0);
  const sum = k => +tr.reduce((a, t) => a + t.cost[k], 0).toFixed(2);
  return { n, win: +(100 * tr.filter(t => t.r > 0).length / n).toFixed(1), sumR: +(m * n).toFixed(2), avgR: +m.toFixed(3), pf: gl ? +(gp / gl).toFixed(2) : null,
    gross: sum("grossR"), fee: sum("feeR"), slip: +(sum("slipR") + sum("slipInPriceR")).toFixed(2), funding: sum("fundR") };
};
const from30 = NOW - 30 * DAY, rec = all.filter(t => t.exit_time >= from30), ev = all.filter(t => t.entry_time >= Y(2023) && t.entry_time < Date.UTC(2026, 9, 1));
const group = (tr, key) => { const o = {}; tr.forEach(t => (o[key(t)] = o[key(t)] || []).push(t)); return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, S(v)])); };
// Market around a time: BTC's 30-day move and efficiency ratio (net move / sum of moves), the coins' median ATR%, and the
// average pairwise correlation of the coins' 4h returns over the 30 days.
function market(t0) {
  const win = (b) => b.filter(x => x.time >= t0 - 30 * DAY && x.time < t0);
  const btc = win(bars.BTCUSDT || []);
  if (btc.length < 50) return null;
  const move = btc[btc.length - 1].close / btc[0].open - 1, path = btc.reduce((a, x, i) => a + (i ? Math.abs(x.close - btc[i - 1].close) : 0), 0);
  const rets = Object.keys(bars).map(c => { const w = win(bars[c]); return w.slice(1).map((x, i) => x.close / w[i].close - 1); }).filter(r => r.length > 50);
  const atrs = Object.keys(bars).map(c => { const w = win(bars[c]); return w.reduce((a, x) => a + (x.high - x.low) / x.close, 0) / Math.max(1, w.length); }).sort((a, b) => a - b);
  const corr = (a, b) => { const n = Math.min(a.length, b.length), ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n, mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
    let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return sab / Math.sqrt(sa * sb); };
  let cs = 0, k = 0; for (let i = 0; i < rets.length; i++) for (let j = i + 1; j < rets.length; j++) { cs += corr(rets[i], rets[j]); k++; }
  return { btcMovePct: +(100 * move).toFixed(1), btcEfficiency: +(Math.abs(btc[btc.length - 1].close - btc[0].open) / path).toFixed(3), medianBarRangePct: +(100 * atrs[atrs.length >> 1]).toFixed(2), avgCorr: +(cs / k).toFixed(2) };
}
// Calendar 30-day windows of 2023-2026 (stepping a day): sum of R of trades that exited in each.
const winSums = [];
for (let t = Y(2023) + 30 * DAY; t <= Date.UTC(2026, 9, 1); t += DAY) winSums.push({ end: t, sum: ev.filter(x => x.exit_time >= t - 30 * DAY && x.exit_time < t).reduce((a, x) => a + x.r, 0), m: null });
const sorted = winSums.map(w => w.sum).sort((a, b) => a - b), recSum = rec.reduce((a, t) => a + t.r, 0);
const markets = []; for (let i = 0; i < winSums.length; i += 7) { const m = market(winSums[i].end); if (m) markets.push(Object.assign({ sum: +winSums[i].sum.toFixed(1) }, m)); }
// Weekly block bootstrap of the 2023-2026 average R (coins that lose together stay together).
const weeks = {}; ev.forEach(t => { const w = Math.floor(t.entry_time / (7 * DAY)); (weeks[w] = weeks[w] || []).push(t.r); });
const blocks = Object.values(weeks); let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const boots = []; for (let k = 0; k < 4000; k++) { let s = 0, n = 0; for (let i = 0; i < blocks.length; i++) { const b = blocks[Math.floor(rnd() * blocks.length)]; s += b.reduce((a, v) => a + v, 0); n += b.length; } boots.push(s / n); }
boots.sort((a, b) => a - b);
const naive = S(ev), sd = Math.sqrt(ev.reduce((a, t) => a + (t.r - naive.avgR) ** 2, 0) / (ev.length - 1));
const out = {
  generated: new Date().toISOString(), now: iso(NOW), strategy_version: VERSION, dataset: DATASET,
  last30: { window: [iso(from30), iso(NOW)], all: S(rec), byCoin: group(rec, t => t.coin), bySide: group(rec, t => t.dir > 0 ? "LONG" : "SHORT"),
    byEntryDay: group(rec, t => iso(t.entry_time).slice(0, 10)), market: market(NOW), trades: rec.map(t => ({ coin: t.coin, side: t.dir > 0 ? "LONG" : "SHORT", entry: iso(t.entry_time), exit: iso(t.exit_time), reason: t.reason, r: +t.r.toFixed(3) })) },
  evidence: { all: S(ev), bySide: group(ev, t => t.dir > 0 ? "LONG" : "SHORT"), byYear: group(all, t => String(new Date(t.entry_time).getUTCFullYear())),
    byMonth: group(all.filter(t => t.entry_time >= Y(2025)), t => iso(t.entry_time).slice(0, 7)) },
  windows30: { n: winSums.length, p1: +sorted[Math.floor(0.01 * sorted.length)].toFixed(1), p5: +sorted[Math.floor(0.05 * sorted.length)].toFixed(1), p50: +sorted[sorted.length >> 1].toFixed(1),
    min: +sorted[0].toFixed(1), last30: +recSum.toFixed(1), rankPct: +(100 * sorted.filter(v => v < recSum).length / sorted.length).toFixed(1) },
  marketHistory: { recent: market(NOW), worst30: markets.slice().sort((a, b) => a.sum - b.sum).slice(0, 8), median: (k => { const v = markets.map(m => m[k]).sort((a, b) => a - b); return v[v.length >> 1]; }) },
  ci: { naive: [+(naive.avgR - 1.96 * sd / Math.sqrt(ev.length)).toFixed(3), +(naive.avgR + 1.96 * sd / Math.sqrt(ev.length)).toFixed(3)],
    weeklyBlocks: [+boots[Math.floor(0.025 * boots.length)].toFixed(3), +boots[Math.floor(0.975 * boots.length)].toFixed(3)], weeks: blocks.length }
};
const med = k => { const v = markets.map(m => m[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
out.marketHistory.median = { btcMovePct: med("btcMovePct"), btcEfficiency: med("btcEfficiency"), medianBarRangePct: med("medianBarRangePct"), avgCorr: med("avgCorr") };
fs.writeFileSync("recent.json", JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ last30: out.last30.all, bySide: out.last30.bySide, byCoin: out.last30.byCoin, market: out.last30.market, windows30: out.windows30, ci: out.ci, median: out.marketHistory.median }, null, 1));
