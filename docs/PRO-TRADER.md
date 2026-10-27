# Trading Trend 4H as a profession — v6.8 (2026-10-23)

What the app does for a full-time trader, and what the tests say about relying on it. Every number below comes from
`research/pro/pro.js`, `research/pro/robust.js` and `research/pro/sentiment.js`, run on GitHub Actions on real Binance bars (results on branch
`research-results`, built into `web/evidence_trend.js` by `tools/make_evidence_trend.py`).

## How much the tests let us trust the rule

Scale-out mode (the app default: 50% at +3R, the rest by the channel), 0.5% risk per trade. "Confidence" is the
statistical confidence that the average trade in that data is above zero, from the t-statistic with trades taken as
independent (they are not quite: the coins move together), so it reads higher than it is. It is not a forecast.

| Test | Trades | Average | Confidence > 0 | Result |
|---|---|---|---|---|
| App code = research code, and the live 1,500-bar window = full history | 3,461 / 19,196 bars | identical | — | pass |
| Walk-forward evidence 2023-01..2026-09, 12 coins | 1,999 | +0.105R | 99.9% (t 3.25) | pass |
| 25 coins the rule was never chosen on, 2020..2026 (MATIC and FTM since delisted) | 5,168 | +0.116R, 24 of 25 coins positive (23 without TP) | >99.9% (t 5.39) | pass |
| Spot 2017-08..2019-12, before every year used to choose the rule, 15 coins | 815 | +0.282R, every year positive | >99.9% (t 5.38) | pass |
| Fees and slippage doubled | 2,001 | +0.067R (no TP) | 95% (t 1.66) | warn: the edge is thin |
| The last two years, 12 coins | 2025: 554 · 2026: 426 | +0.057R · +0.036R | 88% · 70% | warn: weaker lately |

On the 25 unseen coins the same weakness shows: 2025 +0.027R, 2026 +0.034R.

How a year can turn out (0.5% risk, 12 coins, 20,000 years built from 3-month blocks of the 45 months 2023-01..2026-09):
profitable **79%** of years, a loss over 10% in **10%**, middle year **+20%**, worst 5% **−16%** or worse, best 5% **+71%**
or better. The worst 12 months that actually happened: −3.9%; 9% of rolling 12-month windows ended below zero.

The app shows this as "ความมั่นใจของสูตร": **ปานกลาง–สูง (ผ่าน 4/6 การทดสอบ) · ปีที่กำไร ≈79%**, on the main screen,
on every trade sheet and in every entry alert. A trade's own "โอกาสกำไร" is still the coin's test win rate (~33-43%).

## What is normal (so a bad run is not mistaken for a broken rule)

12 coins, 2023-2026, in exit order: up to **45 losses in a row** (the coins turn together); the sum of 30 consecutive
trades was below −15.2R in 5% of windows (worst −24.6R); at 0.5% risk: 44% of months losing, up to 4 losing months in a
row, worst 3 months −20%, deepest drawdown 32.7%, up to 233 days below a previous peak.
The Paper page ("สมุดผลจริง") compares the live record with these ranges: normal · below the worst 5% · worse than
anything in the test (stop new entries and review). The main screen does the same for the system's last 30 days.

## Stop rules: trade every signal

Rules listed before the run, chosen on 2020-2022 by CAGR / max drawdown, reported on 2023-2026 (scale-out, 0.5% risk):

| Rule | 2020-22 CAGR / DD | 2023-26 CAGR / DD | Trades taken 2023-26 |
|---|---|---|---|
| none (every signal) | 43.6% / 19.9% | **23.3% / 32.7%** | 1,999 |
| the app's old rule (half at 4%, stop for good at 8%, daily 2%) — **chosen** | 32.7% / 8.3% | 3.1% / 8.3% | 175 |
| daily loss stop 2% | 45.1% / 18.6% | 20.3% / 31.5% | 1,957 |
| half risk below −10% / −15% / −20% | 40.1 / 42.3 / 43.6% | 10.1 / 18.7 / 19.3% | 1,999 |
| at most 8 / 6 / 4 positions open (robust.js) — 8 chosen | 42.4 / 31.3 / 22.4% | 18.7 / 15.8 / 9.7% | 1,643 / 1,334 / 955 |

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

## Market mood and news as the system's view (v6.3)

The main screen opens with "มุมมองของระบบ", written from rules, not AI: the Crypto Fear & Greed Index (alternative.me,
free) with its change over 7 days, the count of good and bad crypto headlines in 24 hours (a word list: rally, inflow,
approval… against hack, outage, delist, lawsuit…), US releases due before the next close, and what the system does with
each signal, exit and position. Each order and position card shows the coin's good / bad headlines and whether they point
the trade's way. News headlines are green when good, red when bad, plain when neither.

Is mood worth trading on? `research/pro/sentiment.js` gives every Trend 4H trade (12 coins, 2020-01..2026-09) the index
value published before its entry. Five filters were listed before the run and the best on 2020-2022 by t-statistic was
chosen, then reported on 2023-2026 (scale-out, 0.5% risk):

| Filter | 2023-26 avg R | t | CAGR / max DD |
|---|---|---|---|
| none (every signal) | +0.105R | 3.25 | 23.3% / 32.7% |
| LONG only when the index ≥ 50, SHORT only ≤ 50 — **chosen on 2020-2022** | +0.064R | 1.56 | 6.6% / 20.9% |
| no LONG at extreme greed (≥ 75), no SHORT at extreme fear (≤ 25) | +0.140R | 3.98 | 30.3% / 22.7% |
| no entries at all at the extremes (≤ 20 or ≥ 80) | +0.137R | 3.95 | 30.4% / 21.4% |
| LONG when the index rose over 7 days, SHORT when it fell | +0.072R | 1.75 | 7.8% / 20.1% |

The filter chosen in advance did worse than trading every signal, so mood stays context and every signal is taken. The
two extreme filters looked better on 2023-2026, but picking them now would be choosing on the test years; they are
noted as candidates for a future test, not used. The app says this in one line on the main screen, and each card shows
how the rule's past trades in the same mood and direction did (2020-2026, history).

## A second rule that wins more often: mean reversion (tested, not used)

`research/pro/meanrev.js` (GitHub Actions run 39922227435, `research/pro/meanrev_20261023.json`) tried buying dips above
EMA200 and selling rallies below it: 20 candidates listed before the run (RSI(2) below 5 or 10, or a close outside the
Bollinger band 20/2; exit at the 5-bar average, RSI 70 or the band middle; stop 2 or 3 ATR; 4h and 1d bars), the same
12 coins, fees, slippage and funding as Trend 4H. Each year 2022..2026 traded the candidate with the best t-statistic on
the years before it.

| Test | Trades | Win rate | Average | 95% range |
|---|---|---|---|---|
| Walk-forward 2023-01..2026-09 | 826 | 55.7% | −0.088R | −0.147 .. −0.030R |
| 2022 (first walk-forward year) | 969 | 61.9% | −0.025R | −0.052 .. +0.002R |
| 25 coins never used to choose | 1,591 | 54.0% | −0.122R | −0.166 .. −0.078R |
| Fees and slippage doubled | 827 | 54.3% | −0.143R | −0.201 .. −0.085R |

It wins more often than Trend 4H but loses money in every test; even the best candidate on the training years averaged
below zero in four of the five picks. Run beside Trend 4H at 0.5% risk each (2023-2026), the pair grew 11.2% a year
against 23.3% for Trend 4H alone, with the same drawdown (monthly correlation −0.11). It is not added to the app.

## Trying to improve the rule (tested, nothing adopted)

`research/pro/improve.js` (GitHub Actions run 39929350368, `research/pro/improve_20261023.json`): candidates and pass rules
written before the run; chosen on the 12 coins 2020-2022 by CAGR / max drawdown (MAR) at 0.5% risk; adopted only if it
also beats the current rule on 2023-2026, on the 25 unseen coins and on spot 2017-2019, and the trades it skips are
clearly worse than the ones it keeps.

| Candidate | 2020-22 MAR | 2023-26 avg R / MAR | Unseen coins avg R / MAR | Spot 2017-19 avg R / MAR |
|---|---|---|---|---|
| none (the app) | 2.19 | +0.105 / 0.71 | +0.116 / 0.85 | +0.282 / 4.14 |
| trade only in BTC's direction (BTC vs its EMA200) — **chosen** | 3.20 | +0.130 / 0.95 | +0.140 / **0.73** | +0.301 / 1.86 |
| breakout bar volume ≥ 1.5× its 20-bar average | 3.18 | +0.140 / 0.90 | +0.154 / 1.28 | **+0.243** / 3.14 |
| ADX(14) ≥ 20 | 1.64 | +0.098 / 0.56 | +0.126 / 0.60 | +0.355 / 3.46 |
| ADX(14) ≥ 25 | 0.42 | +0.053 / 0.14 | +0.136 / 0.44 | +0.339 / 2.38 |
| close no more than 1 ATR past the channel | 1.76 | +0.060 / 0.41 | +0.078 / 0.49 | +0.290 / 3.41 |
| breakout from a quiet market (ATR20 < ATR100) | 2.36 | +0.137 / 0.76 | +0.101 / 0.50 | +0.229 / 2.67 |
| EMA200 sloping the trade's way | 1.89 | +0.104 / 0.66 | +0.101 / 0.49 | +0.341 / 3.14 |
| no LONG at greed ≥ 75, no SHORT at fear ≤ 25 | 1.98 | +0.140 / 1.34 | +0.127 / 0.83 | +0.316 / 4.52 |
| no entries at Fear & Greed ≤ 20 or ≥ 80 | 1.17 | +0.137 / 1.42 | +0.128 / 0.86 | +0.326 / 4.75 |
| after TP1, the rest's stop to breakeven | 2.20 | +0.104 / 0.70 | +0.114 / 0.83 | +0.277 / 4.06 |
| after TP1, the rest's stop to +1R | 2.14 | +0.101 / 0.68 | +0.112 / 0.81 | +0.266 / 3.97 |
| 24 coins instead of 12, same risk per trade | 1.74 | +0.112 / 0.85, drawdown 45.6% | — | — |
| 37 coins instead of 12, same risk per trade | 1.82 | +0.108 / 0.79, drawdown 60.8% | — | — |

The filter chosen on 2020-2022 (BTC's direction) raised the average trade everywhere but made the unseen coins'
portfolio worse (MAR 0.73 against 0.85, drawdown 43.6%), so it fails. The volume filter, nearly tied in 2020-2022, failed
on 2017-2019. Moving the stop after TP1 cut profit everywhere. More coins added profit and more drawdown, and in
2020-2022 the drawdown grew faster. The Fear & Greed "extremes" filters did better on every period except 2020-2022,
the period they would have been chosen on; they stay a candidate to re-test as more data comes, not a rule.

Win rate: the only lever that raises it is taking profit earlier, and that lowers profit (research/pro, 2023-2026:
1/3 at +1R and 1/3 at +2R wins 40.4% of trades but averages +0.064R; the app's 50% at +3R wins 34.1% and averages
+0.105R). The app keeps the plan that earns more.

## Faster timeframes: 15m / 30m / 1h / 2h (tested, not added)

`research/pro/tf.js` (GitHub Actions run 39965080700, `research/pro/tf_20261023.json`): the Trend rule family (8 Donchian
rules per timeframe, entry 20/55, exit 10/20, stop 2/3 ATR, EMA200), walk-forward on the 12 coins, the same yearly picks
on the 25 unseen coins, costs doubled, no take profit; rules fixed before the run. Trend 4H on the same terms: +0.131R per
trade, CAGR 28.7% / max drawdown 31.8% at 0.5% risk (MAR 0.90), 1.5 trades a day.

| Timeframe | Trades/day | 2023-26 avg R (95% range) | Unseen coins | Costs ×2 | CAGR / max DD at 0.5% |
|---|---|---|---|---|---|
| 15m | 15 | −0.104 (−0.131 .. −0.077) | −0.095 | −0.269 | −66.5% / 99.3% |
| 30m | 10.2 | −0.041 (−0.079 .. −0.004) | −0.040 | −0.181 | −62.8% / 99.3% |
| 1h | 5.6 | +0.015 (−0.049 .. +0.080) | +0.005 | −0.119 | −44.4% / 96.3% |
| 2h | 1.8 | +0.101 (+0.009 .. +0.193) | +0.115 | +0.019 | +17.1% / 56.1% |

15m to 1h lose: fees and slippage take more than the trend gives on short bars. 2h passes the profit checks but with
almost twice Trend 4H's drawdown, a losing 2025, and an edge that is gone when costs double; run beside Trend 4H it makes
the portfolio worse (CAGR 25.8%, drawdown 71.7%, MAR 0.36 against 0.90), so it is not added.

## Only the coins that win often? (tested: no)

`research/pro/winrate.js` (GitHub Actions run 39965794562, `research/pro/winrate_20261023.json`): coins ranked by their
2020-2022 win rate under Trend 4H (scale-out plan), the top half / third kept, checked on 2023-2026; rules fixed before.

| Coins | 2023-26 win | avg R | CAGR / max DD at 0.5% |
|---|---|---|---|
| all 12 | 34.1% | +0.105 | 23.3% / 32.7% |
| top half by 2020-22 win rate (AVAX, LTC, BTC, DOT, SOL, XRP) | 34.6% | +0.103 | 12.4% / 18.8% |
| top third (AVAX, LTC, BTC, DOT) | 34.5% | +0.075 | 6.0% / 15.2% |
| all 25 unseen | 36.5% | +0.109 | 40.2% / 42.7% |
| unseen, top half | 36.0% | +0.080 | 15.0% / 32.6% |

A coin's win rate in 2020-2022 said nothing about 2023-2026 (rank correlation −0.07 over 32 coins; average R −0.14):
LTC won 43% then 31%, XRP 40% then 26%, TRX 31% then 38%. Coin and side together did no better (top half: +0.039R
against +0.107R). So v6.8 shows the whole system's win rate and average on every signal (34%, +0.105R) instead of a
per-coin figure that looked meaningful but was luck, and every order card carries a risk box (chance of losing, baht at
the SL, the longest losing run and the deepest drawdown at the set risk, liquidation).

## A confidence tier per signal (tested: win rate not separable)

`research/pro/signalscore.js` (run 39968011646, `research/pro/signalscore_20261023.json`): a logistic score of "the trade
won" on 10 traits known at the signal, fitted on 2020-2022, tiers A/B/C at that period's thirds; and tiers by stop
distance alone. Rule fixed before: shown only if win rate A > B > C and A beats the average on all three later sets.

| Set | All: win / avg R | A | B | C | Tight stop | Mid | Wide |
|---|---|---|---|---|---|---|---|
| 2023-26, 12 coins | 34.1% / +0.105 | 35.3% / +0.191 | 34.6% / +0.146 | 32.8% / +0.009 | 34.5% / +0.175 | 35.3% / −0.007 | 29.1% / −0.071 |
| unseen coins | 36.6% / +0.116 | 36.3% / +0.204 | 36.2% / +0.139 | 37.3% / +0.045 | 37.2% / +0.274 | 33.6% / −0.018 | 39.0% / +0.102 |
| spot 2017-19 | 38.0% / +0.282 | 39.3% / +0.272 | 38.7% / +0.354 | 36.5% / +0.232 | 39.5% / +0.468 | 37.8% / +0.188 | 36.2% / +0.118 |

Win rates barely differ between tiers (32.8-37.3%), so no per-signal win chance is shown. What the tiers do separate
is the size of the wins: tier A and tight stops earned more per trade on 2023-2026 and unseen coins (tight stops on all
three). That was not the rule fixed before this run, so it is not used; it is the candidate to test again, stated in
advance, when 2027 data exists.

## How sure is an open trade? (v6.11, tested)

`research/pro/liveodds.js` (run 39970652200, `research/pro/liveodds_20261023.json`): of the system's trades that stood at a
given R at a 4-hour close, how many ended in profit (from the system's entry). Rates from 2020-2022 held within 10 points
on 2023-2026 and the 25 unseen coins, so each card shows its line, live: below −0.75R 4%, −0.75..−0.25R 16%, ±0.25R 35%,
+0.25..+0.75R 54%, +0.75..+1.5R 79%, +1.5..+3R 95%, TP1 sold 100% (2020-2026, 12 coins). It is measured from the system's
entry, so it describes the trade for someone who followed it, not a fresh entry at today's price.

## The professional's routine (main screen → "แผนเทรดและกิจวัตรแบบมืออาชีพ")

- Written plan: one rule, the coins, risk per trade, exits, trade every signal, when to stop, what is forbidden.
- Every day: open the app within 15 minutes of each 4-hour close (03, 07, 11, 15, 19, 23 Thai time); every entry with
  Isolated, the app's leverage and size, a Stop Market on Binance at once and TP1 as a limit; record the real fills;
  look at the day's calendar.
- Every week: live record against the test; every signal taken; backup.
- Every month: the month in R against "normal"; the confidence and the date of the evidence (re-run the research yearly);
  no rule changes after a short losing run, never above 1% risk.
- Backup and restore of trades, the live record and settings as one text through Android's share sheet.

## Follow the system (v6.2 main screen)

One timeframe (Trend 4H) for every install; the timeframe buttons are gone. The main screen is what a follower needs:
the system's status (next 4-hour check, coins, risk, confidence), **what to do now** (an orange card to close a position,
an order card per new signal with leverage, entry, SL, TP1, size, margin, risk and the deadline; or "nothing to do"),
**what the system holds** with its live move and R and whether to join it now, and **the system's last 30 days**
(closed trades in R and in % at the set risk). Confidence details, news, the plan and routine, and what is normal fold
into one section; full trade sheets and charts open on tap. Opening the app mid-bar no longer reports "stale": Android
now tells that apart from a lagging exchange.

## Live statuses: follow now, holding, ended (v6.4)

The system's signals and positions sit in three groups that follow Binance's mark price every second, and a card moves
between them as the price moves. v6.5: Binance moved USD-M futures market streams to `wss://fstream.binance.com/market/...`
on 2026-04-23; the old `/stream` address still connects but sends nothing, which froze the numbers in v6.1-v6.4. The app
now uses the new address, drops a socket that is silent for 8 seconds for REST mark prices every 3 seconds, and shows the
feed and the time of the last price under "ตามได้ตอนนี้" (red when no price came for 15 seconds). The chart tab likewise.
- **ตามได้ตอนนี้ (can follow now)**: a new signal within its 15 minutes and within 0.5R of the entry, with a live
  countdown; or a position still within 0.5R of the system's entry, no take profit yet, where the late-entry test was
  clearly profitable (95% range above zero; a signal past its 15 minutes uses the 1-bar-late test, 1,874 trades, +0.10R).
  Size, margin and risk are re-sized at the live price so a stop still costs the set risk.
- **ถืออยู่ · ตามไม่ทันแล้ว (holding, too late to follow)**: the price is more than 0.5R from the entry, TP1 has sold,
  or the test does not support joining this late; for those already in: hold, never move the SL.
- **จบสัญญาณแล้ว (ended)**: the system's exit (close now if still holding), a position whose stop was touched in the
  4-hour bar now forming (its high and low from Binance, then every live price; shown as ≈ −1R), and signals that ended
  in the last 24 hours. The system's note at the top follows.

## Live P&L of the trades entered (v6.1)

Trades recorded with "เข้าแล้ว · บันทึกลงพอร์ต" sit at the top of the main screen with their P&L at Binance's mark price
(the price Binance uses for unrealized P&L), from Binance's free WebSocket every second (`<symbol>@markPrice@1s`), or
from `/fapi/v1/premiumIndex` every 3 seconds when the socket cannot connect. Per trade: ROI on margin as Binance shows it
(price move × leverage, before fees), the price move, baht, R after fees, % of the balance, distance to SL and TP1, and a
warning once the price is past the SL. The real fill can replace the signal price, and a trade is closed at the live price
or a typed one. The rule's open positions show their live move and R next to the price. Only while the app is open.

## Limits

- No test guarantees the future; the confidence figures describe the past and assume independent trades.
- The edge is thin and weaker in 2025-2026; execution (on time, at the price, every signal) decides much of it.
- Results are for 12 coins at once; fewer coins swing more. Live results are usually worse than tests.
- The app does not place orders and holds no exchange keys.

## Looking for a system to trade for a living (28 Oct 2026, nothing passed)

Both studies had their candidates and pass rules written into the script before the run; neither was re-run with other
settings after the result.

**LONG only** (`research/pro/longonly.js`, `research/pro/longonly_20261027.json`). In 2023-2026 the SHORT half had no
edge (957 trades, −0.003R), so taking LONG signals only was tested on data that played no part in that finding. Rejected:
SHORT made money in every deciding set — 2020-2022 +0.114R (551 trades), 25 unseen coins +0.096R (2,745), spot 2017-2019
+0.313R (461) — and both sides together had the better MAR in all three (2.03 / 0.87 / 3.85 against 1.49 / 0.49 / 1.06).
The weak SHORT side is a 2023-2026 feature, not a rule. The app keeps both sides.

**Three portfolio candidates** (`research/career/career.js`, `research/career/career_20261027.json`), each scaled to an 8%
drawdown on 2020-2024, the one with the best 2020-2024 MAR among those positive on spot 2017-2019 tested once on
2025-01..2026-10:

| | 2020-24 CAGR / DD / positive months | spot 2017-19 CAGR (unscaled) | 2025-01..2026-10 CAGR / DD / positive months | 2x costs |
|---|---|---|---|---|
| C1 cross-sectional momentum (top 5 of 37, weekly, BTC above its 100-day average) | 13.1% / 8% / 50% | −9.6% (not eligible) | +2.5% / 4.1% / 36% | +2.3% |
| C2 time-series momentum (20/60/120 days, volatility-sized) — **chosen** | 7.9% / 8% / 45% | +6.3% | **−1.0%** / 6.2% / **36%** | −1.2% |
| C3 Trend 4H + C1 at equal volatility | 23.3% / 8% / 60% | −9.6% (its C1 part) | +3.3% / 8.0% / 55% | +0.7% |

Gate on C2's holdout: 543 trades PASS; 2025 −2.9% FAIL; positive months 36% FAIL; drawdown 6.2% PASS; 2x costs −1.2%/yr
FAIL; forward paper UNKNOWN. **Not passed.** C3, the smoothest in 2020-2024 (60% positive months), fell to 55% and +3.3% a
year in the holdout. Known defect: the per-trade profit factor in this script is not reliable (C2 shows PF 1.88 while its
returns are negative: the per-holding bookkeeping does not match the daily returns); the gate failures above do not use
it.

What this means: none of the systems tested here (Trend 4H and its filters, faster timeframes, mean reversion, LONG only,
three momentum portfolios; and the other researcher's 40 policies) gives returns steady enough to live on. At the risk
that kept Trend 4H's 2023-2026 drawdown near 17%, it earned about 13-16% a year (cost model dependent) at 0.25% risk per trade, with 2025-2026 far weaker.
