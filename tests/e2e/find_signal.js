// Picks the most recent real ETHUSDT 15m candle where the app's rule (squeeze3_ls) fires LONG on the exact
// 30-day window the app downloads, and where the price-mirrored series fires SHORT on the same candle.
// Writes replay.json for mock_server.py. Usage: node find_signal.js bars/ETHUSDT_15m.json
const fs = require("fs");
const Swing = require("../../web/swing.js");
const W = 2880;   // 30 days of 15m bars = what the app requests (TF["15m"].days)
const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const bars = raw.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], close_time: r[6] }));
const ref = Math.max(...bars.map(b => b.high));
const mirror = bars.map(b => ({ time: b.time, close_time: b.close_time, open: 2 * ref - b.open, high: 2 * ref - b.low, low: 2 * ref - b.high, close: 2 * ref - b.close, volume: b.volume }));
const opt = Object.assign({}, Swing.DEFAULTS, { fee: 0.0005, slippage: 0.0002 });
function fires(series, i) {
  const win = series.slice(i - W + 1, i + 1), ind = Swing.indicators(win, opt), s = Swing.signal("squeeze3_ls", win, ind, W - 1, opt);
  return s && s.dist / win[W - 1].close >= 0.0015 ? s.dir : 0;
}
for (let i = bars.length - 1; i >= W; i--) {
  if (fires(bars, i) !== 1) continue;
  if (fires(mirror, i) !== -1) continue;
  const pick = s => s.slice(i - W + 1, i + 1).map(b => [b.open, b.high, b.low, b.close, b.volume]);
  fs.writeFileSync("replay.json", JSON.stringify({ source: "ETHUSDT 15m USD-M", signal_candle_utc: new Date(bars[i].close_time + 1).toISOString(), normal: pick(bars), mirror: pick(mirror) }));
  console.log("replay candle", new Date(bars[i].close_time + 1).toISOString(), "close", bars[i].close);
  process.exit(0);
}
console.error("no candle where both the series and its mirror fire");
process.exit(1);
