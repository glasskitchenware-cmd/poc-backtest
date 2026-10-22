// Evidence table shown in the app: the app's live rule (Squeeze v2, squeeze3_ls, unchanged swing.js)
// replayed on real USD-M futures bars per coin and timeframe. Parameters were fixed by the earlier
// research (chosen on BTC 1H 2024), so 2026-01..2026-09 is data the rule never saw.
const fs = require("fs");
const Swing = require("../skills/swing.js");
const SYMBOLS = process.argv[2].split(","), TFS = process.argv[3].split(",");
const PERIODS = [["dev", "2023-10-01", "2025-01-01"], ["val", "2025-01-01", "2026-01-01"], ["oos", "2026-01-01", "2026-10-01"]];
const COST = { fee: 0.0005, slippage: 0.0002 };   // per side, as in the app; funding 0.01%/8h is in swing.js
function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [+(100 * (c - h)).toFixed(1), +(100 * (c + h)).toFixed(1)];
}
function summary(trades) {
  const n = trades.length, wins = trades.filter(t => t.r > 0).length, tp = trades.filter(t => /^target/.test(t.reason)).length;
  const sum = trades.reduce((a, t) => a + t.r, 0), gp = trades.reduce((a, t) => a + Math.max(0, t.r), 0), gl = trades.reduce((a, t) => a - Math.min(0, t.r), 0);
  return { n, win: n ? +(100 * wins / n).toFixed(1) : null, winCI: wilson(wins, n), tp5: n ? +(100 * tp / n).toFixed(1) : null, tp5CI: wilson(tp, n),
    avgR: n ? +(sum / n).toFixed(3) : null, pf: gl > 0 ? +(gp / gl).toFixed(2) : null };
}
const rows = {};
for (const s of SYMBOLS) for (const tf of TFS) {
  const raw = JSON.parse(fs.readFileSync(`bars/${s}_${tf}.json`, "utf8"));
  const bars = raw.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], close_time: r[6] }));
  const opt = Object.assign({}, Swing.DEFAULTS, COST, { risk: 0.0025 });
  const trades = Swing.runTechnique("squeeze3_ls", bars, Swing.indicators(bars, opt), 210, bars.length, opt);
  const row = {};
  for (const [k, a, b] of PERIODS) {
    const lo = Date.parse(a + "T00:00:00Z"), hi = Date.parse(b + "T00:00:00Z");
    row[k] = summary(trades.filter(t => t.entry_time >= lo && t.entry_time < hi));
  }
  rows[`${s}|${tf}`] = row;
  console.log(s, tf, JSON.stringify(row.oos), "val", row.val.avgR, "dev", row.dev.avgR);
}
const out = { strategy: "squeeze3_ls (Squeeze v2)", source: "Binance USD-M futures monthly klines (data.binance.vision)",
  periods: { dev: "2023-10-01..2024-12-31", val: "2025-01-01..2025-12-31", oos: "2026-01-01..2026-09-30" },
  costs: "fee 0.05% + slippage 0.02% per side, funding 0.01%/8h, no FOMC filter", generated: new Date().toISOString().slice(0, 10), rows };
fs.writeFileSync("evidence.json", JSON.stringify(out));
console.log("EVIDENCE_JSON_BEGIN");
console.log(JSON.stringify(out));
console.log("EVIDENCE_JSON_END");
