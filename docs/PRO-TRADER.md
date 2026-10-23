# Trading Trend 4H as a profession — v6.0 (2026-10-23)

What the app does for a full-time trader, and what the tests say about relying on it. Every number below comes from
`research/pro/pro.js` and `research/pro/robust.js`, run on GitHub Actions on real Binance bars (results on branch
`research-results`, built into `web/evidence_trend.js` by `tools/make_evidence_trend.py`).

## How much the tests let us trust the rule

Scale-out mode (the app default: 50% at +3R, the rest by the channel), 0.5% risk per trade. "Confidence" is the
statistical confidence that the average trade in that data is above zero, from the t-statistic with trades taken as
independent (they are not quite: the coins move together), so it reads higher than it is. It is not a forecast.

| Test | Trades | Average | Confidence > 0 | Result |
|---|---|---|---|---|
| App code = research code, and the live 1,500-bar window = full history | 3,461 / 19,196 bars | identical | — | pass |
| Walk-forward evidence 2023-01..2026-09, 12 coins | 1,999 | +0.105R | 99.9% (t 3.25) | pass |
| 25 coins the rule was never chosen on, 2020..2026 (MATIC and FTM since delisted) | 5,168 | +0.116R, 23 of 25 coins positive | >99.9% (t 5.39) | pass |
| Spot 2017-08..2019-12, before every year used to choose the rule, 15 coins | 815 | +0.282R, every year positive | >99.9% (t 5.38) | pass |
| Fees and slippage doubled | 2,001 | +0.067R (no TP) | 95% (t 1.66) | warn: the edge is thin |
| The last two years, 12 coins | 2025: 554 · 2026: 426 | +0.057R · +0.036R | 88% · 70% | warn: weaker lately |

On the 25 unseen coins the same weakness shows: 2025 +0.027R, 2026 +0.034R.

How a year can turn out (0.5% risk, 12 coins, 20,000 years built from 3-month blocks of the 45 months 2023-01..2026-09):
profitable **81%** of years, a loss over 10% in **8%**, middle year **+21%**, worst 5% **−15%** or worse, best 5% **+72%**
or better. The worst 12 months that actually happened: −3.9%; 9% of rolling 12-month windows ended below zero.

The app shows this as "ความมั่นใจของสูตร": **ปานกลาง–สูง (ผ่าน 4/6 การทดสอบ) · ปีที่กำไร ≈81%**, on the main screen,
on every trade sheet and in every entry alert. A trade's own "โอกาสกำไร" is still the coin's test win rate (~33-43%).

## What is normal (so a bad run is not mistaken for a broken rule)

12 coins, 2023-2026, in exit order: up to **45 losses in a row** (the coins turn together); the sum of 30 consecutive
trades was below −15.2R in 5% of windows (worst −24.6R); at 0.5% risk: 42% of months losing, up to 3 losing months in a
row, worst 3 months −20%, deepest drawdown 32.7%, up to 229 days below a previous peak.
The Paper page ("สมุดผลจริง") compares the live record with these ranges: ✅ normal · ⚠️ below the worst 5% · ⛔ worse
than anything in the test (stop new entries and review).

## Stop rules: trade every signal

Rules listed before the run, chosen on 2020-2022 by CAGR / max drawdown, reported on 2023-2026 (scale-out, 0.5% risk):

| Rule | 2020-22 CAGR / DD | 2023-26 CAGR / DD | Trades taken 2023-26 |
|---|---|---|---|
| none (every signal) | 44.0% / 19.9% | **24.8% / 32.7%** | 1,999 |
| the app's old rule (half at 4%, stop for good at 8%, daily 2%) — **chosen** | 33.1% / 8.3% | 3.1% / 8.3% | 175 |
| daily loss stop 2% | 45.6% / 18.6% | 20.9% / 31.5% | 1,957 |
| half risk below −10% / −15% / −20% | 40.5 / 42.7 / 44.0% | 11.9 / 21.8 / 20.8% | 1,999 |
| at most 8 / 6 / 4 positions open (robust.js) — 8 chosen | 39.3 / 27.1 / 17.5% | 6.1 / 4.8 / 5.1% | 442 / 349 / 314 |

The choices made on 2020-2022 kept almost none of the 2023-2026 profit. So the app trades every signal at the set
risk and stops new entries only when the recorded portfolio falls further than the test's deepest drawdown at that risk
(then exits still go out). This is a decision made after seeing 2023-2026, stated here as such.

## News without AI or keys

v6.0 removes Gemini completely (code, keys stored by older versions, the POST channel, the clipboard reader). News comes
from free sources, refreshed every 2 minutes while the app is open and at every background scan:
CoinDesk, Cointelegraph, Decrypt, The Block, CryptoSlate, Bitcoin Magazine, Siam Blockchain, Bitcoin Addict (RSS),
Binance announcements (listings, delistings), the Fed and the SEC (RSS), and this week's economic calendar
(ForexFactory, US releases only). All 13 answered a plain app request from GitHub's servers (news-probe job).
Headlines naming a selected coin or a risk word (hack, delist, SEC, outage, ETF, CPI, FOMC…) are flagged. A high-impact
US release before the next 4-hour close and a risk headline on the coin go into the entry alert. News never changes a
signal: the rule was not tested with news.

## The professional's routine (main screen → "แผนเทรดและกิจวัตรแบบมืออาชีพ")

- Written plan: one rule, the coins, risk per trade, exits, trade every signal, when to stop, what is forbidden.
- Every day: open the app within 15 minutes of each 4-hour close (03, 07, 11, 15, 19, 23 Thai time); every entry with
  Isolated, the app's leverage and size, a Stop Market on Binance at once and TP1 as a limit; record the real fills;
  look at the day's calendar.
- Every week: live record against the test; every signal taken; backup.
- Every month: the month in R against "normal"; the confidence and the date of the evidence (re-run the research yearly);
  no rule changes after a short losing run, never above 1% risk.
- Backup and restore of trades, the live record and settings as one text through Android's share sheet.

## Limits

- No test guarantees the future; the confidence figures describe the past and assume independent trades.
- The edge is thin and weaker in 2025-2026; execution (on time, at the price, every signal) decides much of it.
- Results are for 12 coins at once; fewer coins swing more. Live results are usually worse than tests.
- The app does not place orders and holds no exchange keys.
