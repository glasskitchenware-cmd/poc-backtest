# Trend 4H — the main strategy since v4.4 (2026-10-22)

## Rule (web/trend.js, identical to research/pro/pro.js)

- Bars: Binance USD-M perpetual, 4-hour, closed candles only. 12 coins, one position per coin, long and short.
- Entry: a 4h close above the highest high of the previous 20 bars and above EMA200 → LONG at the next open.
  A close below the lowest low of the previous 20 bars and below EMA200 → SHORT.
- Stop: 3 × ATR(20) of the signal bar from the entry, never moved. Stops are filled at the stop inside the bar,
  or at the open when the price gaps through it.
- Exit: a 4h close below the lowest low (LONG) / above the highest high (SHORT) of the previous 10 bars → close at the
  next open. There is no fixed take profit; the app sends a "ปิดไม้" (EXIT) notification.
- Costs in every result: fee 0.05% + slippage 0.02% per side, funding 0.01% per 8 h always paid.
- Size: risk per trade (0.25 / 0.5 / 1% of the balance, picker in Settings) ÷ stop distance. Leverage is the user's cap
  (5/10/20/50x), lowered until the estimated liquidation is 1.5 × the stop distance away (maintenance margin 1%);
  a signal that would need less than 5x is not sent.

## How it was chosen

`research/pro/pro.js` tested 24 trend rules (Donchian / EMA crossover, 4h / 1d) on 2020-01..2026-09. Walk-forward:
each year the rule with the best t-statistic on the years **before** it was picked and traded that year only. This rule
was picked for 2023, 2024, 2025 and 2026; those years are its evidence. Caveat: the 24 candidates and the 12 coins
(today's large caps, survivorship bias) were chosen with hindsight.

## QC (GitHub Actions run 39796307401, research/pro/evidence_trend_20261022.json)

| Check | Result |
|---|---|
| Parity: app code vs research backtest | **OK** — 12 coins, 3,461 trades, identical entry/exit times, side and R |
| Live replay: the phone's 1,500-bar window vs full history | **OK** — 19,196 closed bars (5,811 entry/exit decisions), 0 mismatches |
| Trades 2023-01..2026-09 (app filter) | 1,999 · win 33.9% (95% CI 31.9–36.0) · ≥3R 4.4% · avg **+0.131R** (CI +0.051…+0.212) · PF 1.31 · t 3.2 · hold 4.4 days |
| By year | 2023 +0.252R · 2024 +0.172R · 2025 +0.016R (flat) · 2026 (to Sep) +0.094R · 2022 (not chosen) +0.082R |
| Costs × 2 | +0.067R · PF 1.15 · t 1.66 (CI touches 0) — the edge is thin; execution matters |
| Filtered out (needs < 5x) | 53 trades (2.6%), avg −0.14R — the filter does not remove the edge |
| Stop distance | p10 3.1% · median 5.8% · p90 9.2% · max 12.7% |
| Leverage the stop allows | p10 6x · median 10x · p90 17x. A 20x cap is lowered on 94% of trades, 50x on 100% |
| Open positions at once | average 6.4, max 12 (all coins move together) → open risk up to 12 × risk per trade |
| Per coin (avg R) | SOL +0.29 · BTC +0.28 · ETH +0.27 · DOGE +0.21 · TRX +0.16 · AVAX +0.16 · XRP +0.14 · DOT +0.10 · ADA +0.07 · BNB +0.06 · LINK +0.01 · **LTC −0.12** |

Portfolio, 12 coins, compounding, P&L booked at exit (unrealised swings of open positions not included, so real
drawdowns are deeper):

| Risk per trade | CAGR | Max drawdown | Worst month | Positive months |
|---|---|---|---|---|
| 0.25% | 18.5% | 16.4% | −7.2% | 49% |
| 0.5% | 38.9% | 30.4% | −13.9% | 49% |
| 1% | 85.3% | 52.0% | −26.0% | 49% |

Plan on live results well below these (slippage at 4h closes, missed alerts, skipped trades, regime change). Half the
months are losing months; 2025 was flat for the whole year.

## In the app

- Default timeframe is H4 Trend (every install moved once; M5/M15/H1 stay selectable and are labelled as losing in
  the research).
- Notifications: ENTRY (no TP; SL and the exit rule) within 15 minutes of the 4h close, and EXIT for positions the rule
  holds, even while new entries are paused by the drawdown stop.
- Main screen: exits first, then positions the rule holds (stop and exit level), then the evidence for the selected
  coins and the coaching steps (TP left empty).
- Paper: the rule on the selected coins since the start date (1,500 bars of warm-up so its state matches the alerts).

## Tests

- `tests/js/trend_test.js` — 18 checks of the rule on hand-built bars (entry, EMA filter, fills, exits, stops, costs).
- `tests/js/run_tests.py` — H4 entry/exit packets, paused entries with exits, migration to H4, main screen and Paper.
- `tools/java-tests` — H4 entries without TP, EXIT notifications and their dedup.
- `tests/e2e/run_e2e.sh` — H4 entry and exit notifications posted on an Android 14 emulator.

## Known limits

- H4 alerts depend on Android delivering the alarm within 15 minutes of the close (Doze, OEM battery managers).
- The app tracks the **rule's** positions, not the user's; an EXIT says what to do only if the user holds it.
- No exchange account access: the stop on Binance must be set by the user, and the app cannot see fills.
