# Real-money audit, v7.0 (2026-10-24)

From the user's review of v6.12 (10 screenshots). Each point: what was there before, what changed, how it is tested.
No order is sent to Binance; the app shows numbers to type in by hand.

## 1. Risk with a small balance (most urgent)

**Before.** When the rule's size was under Binance's smallest order, `minimumSize()` (web/app.js) kept the smallest order
instead of refusing: with 37 baht at 0.25% (0.09 baht at risk) AVAX showed ≈51 baht margin and 82% of the balance at risk,
ADA 29%. A note warned, but the card offered the order and the ENTRY alert went out.

**After.** `capitalCheck()` keeps Binance's smallest order only when it risks no more than the set risk (+10% for step
rounding) and its margin fits the balance. Otherwise the signal is **NO TRADE**: "ทุนไม่พอ ไม่สามารถเข้าไม้ตามความเสี่ยงที่
กำหนด (ไม้เล็กสุดของ Binance เสี่ยง X% ของทุน · ตั้งไว้ 0.25%)", no order card, no ENTRY alert (listed under "rejected" in the
packet). The same applies to joining an open position and to the live re-sizing every second (`liveSize().blocked`): the
card shows "NO TRADE · ทุนไม่พอ" and dashes instead of a size. Risk is never raised to make a trade possible.
Sizing inputs: balance typed by the user, SL distance on the exchange price grid, leverage capped so liquidation stays
1.5× the SL distance away, fee 0.05% + slippage 0.02% per side, Binance's lot step, minQty and minNotional.
Tests (tests/js/run_tests.py, case h4_small, 37 baht): no ENTRY in the packet, the NO TRADE text on screen, no order card,
the system's SOL position shows NO TRADE; with 1,000,000 baht the size at the entry price equals the sheet's size.

## 2. "79%"

**Before.** "โอกาสปีที่กำไร ≈79%" on the main screen, in every alert and in the confidence box: the share of 20,000 years
built from 3-month blocks of the 12 coins' monthly results in 2023-01..2026-09 at 0.5% risk (research/pro/robust.js,
`yearly`). It resamples the same 45 months it describes; it was never checked on later data, and it said nothing about
the last 30 days. (The "79%" on a position card in v6.11 is a different figure: research/pro/liveodds.js, see 4.)

**After.** Removed from the screen and the alerts. The confidence level now includes the system's own last 30 days
against the test's range of runs of the same length: worse than 95% of them → **"เฝ้าระวัง"** (watch) on the main screen
and in alerts, with the numbers (e.g. 50 trades −26.9R; test: worst 5% −22R, worst ever −31.8R).
A table "ผลแยกช่วง · กฎเดียวกัน" separates 2023, 2024, 2025, 2026 (walk-forward), all of 2023-2026, and the system's last
30 days; the user's own record stays in Paper (menu → portfolio), recorded by hand.

| Period (scale-out plan, 12 coins, net of costs) | Trades | Win | Avg R (95% range) | PF |
|---|---|---|---|---|
| 2023 | 478 | 32.8% | +0.200 (+0.05 .. +0.35) | 1.44 |
| 2024 | 541 | 34.0% | +0.124 (−0.005 .. +0.25) | 1.31 |
| 2025 | 554 | 36.5% | +0.057 (−0.04 .. +0.15) | 1.14 |
| 2026 to Sep | 426 | 32.4% | +0.036 (−0.09 .. +0.17) | 1.08 |
| 2023-2026 | 1,999 | 34.1% | +0.105 (+0.04 .. +0.17) | 1.25 |

The 2025 and 2026 ranges include zero: the edge in the last two years is not distinguishable from break-even.

## 3. Costs and R

Every backtest (web/trend.js, the same file the app runs): taker fee 0.05% per side, slippage 0.02% per side (stands for
spread and slippage), funding 0.01% of the position per 8 hours always paid (worse than reality, where funding is paid or
received). No maker fees anywhere, no assumed limit fills. R = the trade's initial risk (entry to the original stop),
fixed for the whole trade, including take-profit parts. Costs from the stress test (no take profit): net +0.131R per trade,
with costs doubled +0.067R, so costs take ≈0.064R a trade and the gross edge is ≈0.195R.
Each order card now shows its own costs in baht: fee (taker ×2), slippage (×2), funding per day if paid; "ถ้าโดน SL"
includes them (= 1R).

## 4. Where each number comes from

| Shown | Source | Rule / measure |
|---|---|---|
| "ชนะ 34% (1999 ไม้ 2023–26)" on a signal | research/pro/pro.js walk-forward | all trades of the rule, scale-out plan |
| Late entry "ทดสอบเข้าช้า d แท่ง" | pro.js `late` | trades joined d bars late within 0.5R; R from the late entry price |
| "ไม้ของระบบที่อยู่ xR … จบกำไร y%" | research/pro/liveodds.js | system trades at that R at a close; R from the system's entry |
| Year / period table | research/pro/robust.js `base` | the same rule, by entry year |

They measure different things and are labelled so; none is used to support another. Checks done:
look-ahead (signals on closed bars only; the app keeps bars with close time before the bar boundary from Binance's server
time; the research and app code give identical trades, `parity`; the phone's 1,500-bar replay matches full history,
`replay`), repainting (decisions only at a close; the live price changes the card's status, never a past signal),
entry at the next bar's open, a bar touching SL and TP counts the SL first, gaps through the SL fill at the open.
The rule was chosen walk-forward (each year by the years before it); 25 coins and 2017-2019 were never used to choose.
Caveat: the candidate rules and the 12 coins were picked with hindsight.

## 5. Display

SL distance shown from the entry and from the live price, both labelled. The system's simulated positions are labelled
"ไม้จำลองของระบบ … ไม่ใช่ไม้ใน Binance ของคุณ"; trades the user records are "บันทึกเอง ไม่ได้ดึงจาก Binance"; the balance is
"กรอกเอง ไม่ได้ตรวจจากบัญชี". Win rates show their sample and period; live odds their 95% range.

## 6. No new rules or coins now

Pyramiding (research/pro/pyramid.js, run on 2026-10-23, `research/pro/pyramid_20261023.json`) passed its pre-set checks
(add a unit at +2R: MAR 2023-26 1.07 vs 0.71, unseen 1.04 vs 0.85, spot 4.20 vs 4.14), but it is **not** added: the base
rule's edge after costs in 2025-2026 is not distinguishable from zero and its last 30 days are on watch.

# v7.1 audit, second round (2026-10-23)

## 1. Backtest vs the last 30 days (research/pro/recent.js, `research/pro/recent_20261023.json`)

The last 30 days rebuilt from Binance's archive bars with the app's own code (strategy version `71cb4bbbe96e` =
sha256 of web/trend.js; 12 coins; 4h bars 2020-01-01..2026-10-22 23:59; closed bars only; same costs).

| | trades | win | net R | avg R | PF | gross R | fee | slippage | funding |
|---|---|---|---|---|---|---|---|---|---|
| exits 2026-09-23..10-23 | 61 | 29.5% | −16.0 | −0.262 | 0.49 | −12.2 | 1.4 | 1.1 | 1.3 |
| LONG | 33 | 27.3% | −3.5 | −0.107 | 0.77 | | | | |
| SHORT | 28 | 32.1% | −12.5 | −0.445 | 0.20 | | | | |
| 2023-01..2026-09 (evidence) | 1,999 | 34.1% | +208.2 | +0.104 | 1.25 | +327.7 | 40.1 | 30.1 | 49.3 |
| — LONG | 1,042 | 34.6% | +210.8 | +0.202 | 1.46 | | | | |
| — SHORT | 957 | 33.4% | −2.6 | −0.003 | 0.99 | | | | |

- **Same rule, same trades.** The app's "−26.9R" was the last **50 closed trades**, labelled "30 วัน". The archive rebuild's
  61 trades minus its oldest 11 (the 18–23 Sept winners, +10.9R) is −26.9R: the app's trades match the archive. The bug
  was the label; fixed ("N ไม้ล่าสุดที่ปิด (เข้า dd/mm – ปิด dd/mm)").
- **Costs are not the cause**: gross −12.2R before 3.8R of costs.
- **Where.** LINK (8 trades −6.1R), DOT (−3.6R), BTC (−3.4R), TRX (−2.7R); 6 coins were positive or flat.
- **Together.** Losses came in clusters of entries on the same bar: 8 Oct 16:00 (7 shorts, −6.3R), 13 Oct (6, −2.6R),
  15 Oct (5, −4.0R), 21 Oct (4 longs, −3.5R). Average correlation of the coins' 4h returns 0.69 (median of history 0.68).
- **Market.** BTC −5.5% over 30 days, efficiency ratio 0.069 (history median 0.075), bar range 2.02% (median 2.28%):
  slightly choppier and quieter than usual, not outside history.
- **Is it unusual?** Over calendar 30-day windows of 2023-2026 (1,340 windows), −16.0R ranks at the 9.4th percentile
  (p5 −23.6R, worst −37.5R). The last-50-trades measure (−26.9R) is below the 50-trade p5 (−22.0R) but above the worst
  (−31.8R): "below normal", not "never seen". The app shows "ต่ำกว่าปกติ" and does **not** pause.
- **The year.** 2026 to date: 466 trades, −0.016R per trade. 2025: +0.057R. The 2023-2026 average with a confidence
  interval that keeps each week's trades together (weekly-block bootstrap, 195 weeks): **+0.001 to +0.247R** (the
  per-trade interval that ignores correlation was +0.041 to +0.167R). The edge is barely distinguishable from zero.
- **Found, not adopted:** in 2023-2026 SHORT trades had no edge (957 trades, −0.003R, PF 0.99); all the profit came from
  LONG. Dropping shorts would be a rule chosen after looking at the result, so it is **not** changed; it needs a check
  fixed in advance on data not used here (25 unseen coins, spot 2017-2019) before it can be considered.

## 2. Valid vs Holdout for every rule

The Backtest page showed the holdout only for the rule chosen on Valid, with a "✓" on the best Valid result. Now every
technique and every variant shows its own Dev, Valid and Holdout (trades, win, R, PF) and **VALIDATED** only if Dev and
Valid are positive (Valid ≥ 30 trades) and Holdout has ≥ 30 trades, positive R and PF > 1; otherwise **NOT VALIDATED**.
The holdout is reported, never used to choose or rank; the number of techniques tried is stated (more tries, more
chance of a pass by luck). The "✓" is gone. Squeeze v2 is labelled NOT VALIDATED wherever it is offered: its
out-of-sample 2026-01..09 lost on every timeframe (1h 594 trades −0.09R, 15m 2,195 −0.11R, 5m 5,712 −0.37R per trade).

## 3. Signal status vs execution feasibility

Two labels on each new-signal card: the signal (VALID SIGNAL, VALID SIGNAL · เข้าช้า) and whether it can be opened
(TRADEABLE, INSUFFICIENT CAPITAL, BELOW EXCHANGE MINIMUM, RISK EXCEEDED, NO TRADE · ระบบเฝ้าระวัง, STALE DATA when the
live price has not moved for over a minute). A valid signal the capital cannot open now stays on screen with its levels
and "ใบสั่ง: NO TRADE" (no size, no order sheet); before, it was reduced to one line. Rejections for the rule's own
filters (leverage, liquidation before the SL) show as INVALID SIGNAL. In the 37 THB test case (mock prices) the ETH card shows
"INSUFFICIENT CAPITAL · BELOW EXCHANGE MINIMUM" (Binance's smallest order: margin 2.12 USDT, risk 43.6% of the balance
vs 0.25% set). The system's simulated positions: "ระบบจำลองกำลังถือสถานะ … Paper ของระบบ ไม่ใช่ไม้ใน Binance ของคุณ · R
นับจากจุดเข้าของระบบ", with "อย่าไล่ราคา" once the price is more than 0.5R past the entry.
