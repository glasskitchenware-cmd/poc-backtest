// "Only the signals that win often": does a coin's win rate under Trend 4H (web/trend.js, the app's scale-out plan and
// leverage filter) carry over to later years, so that trading only high-win-rate coins wins more often and earns more?
// Fixed before the run:
//  1. Rank coins by win rate on 2020-2022; keep the top half (and the top third). Report 2023-2026 win rate, average R and
//     the portfolio at 0.5% risk against all coins. Done on the 12 coins and, separately, on the 25 unseen coins.
//  2. Across all 37 coins: the rank correlation of a coin's win rate in 2020-2022 with its win rate in 2023-2026.
//  3. The same by coin and side (LONG / SHORT): top half of the 74 coin-sides by 2020-2022 win rate.
// A filter is worth offering only if its 2023-2026 win rate is higher than all coins' on both coin groups and its average
// R and MAR are not lower.
// Usage: node winrate.js BASE_COINS UNSEEN_COINS   (4h bars from ../evidence/bars)
const fs = require("fs");
const Trend = require("../../web/trend.js");
const [BASE, UNSEEN] = process.argv.slice(2, 4).map(x => x.split(","));
const H = 3600000, MMR_SAFE = 0.01, RISK = 0.005, Y = y => Date.UTC(y, 0, 1), END = Date.UTC(2026, 9, 1);
const LADDER = JSON.parse(fs.readFileSync("evidence_trend_20261023.json", "utf8")).ladder.tps;
const levLiq = t => Math.max(1, Math.floor(1 / (1.5 * t.risk / t.entry + MMR_SAFE)));
const load = c => {
  const p = `../evidence/bars/${c}_4h.json`;
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], close_time: r[6] })) : null;
};
const summary = tr => {
  const n = tr.length; if (!n) return { n: 0 };
  const m = tr.reduce((a, t) => a + t.r, 0) / n, sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - m) ** 2, 0) / Math.max(1, n - 1)), se = sd / Math.sqrt(n);
  const w = tr.filter(t => t.r > 0).length;
  return { n, win: +(100 * w / n).toFixed(1), avgR: +m.toFixed(3), avgRCI: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)], t: +(m / se).toFixed(2) };
};
function port(tr, from, to) {
  const ev = [], stake = {};
  tr.forEach((t, i) => { ev.push({ time: t.entry_time, k: 1, i }); ev.push({ time: Math.max(t.exit_time, t.entry_time + 1), k: 0, i, r: t.r }); });
  ev.sort((a, b) => a.time - b.time || a.k - b.k);
  let eq = 1, peak = 1, dd = 0, streak = 0, worst = 0;
  for (const e of ev) {
    if (e.k === 1) stake[e.i] = eq * RISK;
    else { eq = Math.max(0.01, eq + stake[e.i] * e.r); peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); streak = e.r > 0 ? 0 : streak + 1; worst = Math.max(worst, streak); }
  }
  const cagr = 100 * (Math.pow(eq, 1 / ((to - from) / (365.25 * 24 * H))) - 1);
  return { cagr: +cagr.toFixed(1), maxDD: +(100 * dd).toFixed(1), mar: dd > 0 ? +(cagr / (100 * dd)).toFixed(2) : null, worstStreak: worst };
}
const all = {};
for (const c of BASE.concat(UNSEEN)) {
  const b = load(c);
  if (!b) continue;
  all[c] = Trend.run(b, { tps: LADDER }).trades.filter(t => t.entry_time >= Y(2020) && t.entry_time < END && levLiq(t) >= 5).map(t => ({ coin: c, dir: t.dir, r: t.r, entry_time: t.entry_time, exit_time: t.exit_time }));
}
const train = tr => tr.filter(t => t.entry_time < Y(2023)), test = tr => tr.filter(t => t.entry_time >= Y(2023));
const out = { generated: new Date().toISOString().slice(0, 10), risk: RISK * 100, groups: {} };
const rank = xs => { const s = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), r = new Array(xs.length); s.forEach(([, i], k) => (r[i] = k + 1)); return r; };
const spearman = (a, b) => { const ra = rank(a), rb = rank(b), n = a.length, d2 = ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0); return +(1 - 6 * d2 / (n * (n * n - 1))).toFixed(2); };
for (const [name, coins] of [["base", BASE.filter(c => all[c])], ["unseen", UNSEEN.filter(c => all[c])]]) {
  const rows = coins.map(c => ({ coin: c, train: summary(train(all[c])), test: summary(test(all[c])) })).sort((a, b) => (b.train.win || 0) - (a.train.win || 0));
  const pick = k => { const keep = rows.slice(0, k).map(x => x.coin), tr = [].concat(...keep.map(c => test(all[c]))); return { coins: keep, test: Object.assign(summary(tr), { port: port(tr, Y(2023), END) }) }; };
  const every = [].concat(...coins.map(c => test(all[c])));
  const g = { rows, all: Object.assign(summary(every), { port: port(every, Y(2023), END) }), topHalf: pick(Math.ceil(coins.length / 2)), topThird: pick(Math.ceil(coins.length / 3)) };
  g.topHalf.better = g.topHalf.test.win > g.all.win && g.topHalf.test.avgR >= g.all.avgR && g.topHalf.test.port.mar >= g.all.port.mar;
  g.topThird.better = g.topThird.test.win > g.all.win && g.topThird.test.avgR >= g.all.avgR && g.topThird.test.port.mar >= g.all.port.mar;
  out.groups[name] = g;
  console.log(`\n== ${name} (${coins.length} coins) ==`);
  rows.forEach(x => console.log(`  ${x.coin.padEnd(10)} 2020-22 win ${x.train.win}% ${x.train.avgR}R (n${x.train.n}) · 2023-26 win ${x.test.win}% ${x.test.avgR}R (n${x.test.n})`));
  console.log("  all:", JSON.stringify(g.all));
  console.log("  top half by 2020-22 win rate:", g.topHalf.coins.join(","), JSON.stringify(g.topHalf.test), "better", g.topHalf.better);
  console.log("  top third:", g.topThird.coins.join(","), JSON.stringify(g.topThird.test), "better", g.topThird.better);
}
const coins = Object.keys(all), wTrain = coins.map(c => summary(train(all[c])).win || 0), wTest = coins.map(c => summary(test(all[c])).win || 0);
out.spearmanCoins = { n: coins.length, rho: spearman(wTrain, wTest) };
const sides = [];
coins.forEach(c => [1, -1].forEach(d => { const tr = all[c].filter(t => t.dir === d); sides.push({ key: c + (d > 0 ? " LONG" : " SHORT"), train: summary(train(tr)), testTr: test(tr) }); }));
const ok = sides.filter(s => s.train.n >= 20);
out.spearmanSides = { n: ok.length, rho: spearman(ok.map(s => s.train.win), ok.map(s => summary(s.testTr).win || 0)) };
ok.sort((a, b) => b.train.win - a.train.win);
const half = ok.slice(0, Math.ceil(ok.length / 2)), keepTr = [].concat(...half.map(s => s.testTr)), allTr = [].concat(...ok.map(s => s.testTr));
out.sides = { kept: half.map(s => s.key), test: Object.assign(summary(keepTr), { port: port(keepTr, Y(2023), END) }), all: Object.assign(summary(allTr), { port: port(allTr, Y(2023), END) }) };
console.log("\nrank correlation of win rate 2020-22 vs 2023-26 · coins:", JSON.stringify(out.spearmanCoins), "· coin-sides:", JSON.stringify(out.spearmanSides));
console.log("top half of coin-sides:", JSON.stringify(out.sides.test), "vs all", JSON.stringify(out.sides.all));
fs.writeFileSync("winrate.json", JSON.stringify(out, null, 1) + "\n");
console.log("WINRATE=" + JSON.stringify({ base: out.groups.base && { half: out.groups.base.topHalf.better, third: out.groups.base.topThird.better }, unseen: out.groups.unseen && { half: out.groups.unseen.topHalf.better, third: out.groups.unseen.topThird.better }, rho: out.spearmanCoins.rho }));
