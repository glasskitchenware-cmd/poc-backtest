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
