# POC Signal — independent fill ledger on market data (Claude, 27 Oct 2026)

**NOT PASSED / RESEARCH ONLY.** No orders. Historical replay of data already studied: NOT untouched OOS.

## Source
- Branch `research/hourly-20261027` at `46ec0e7`; workflow run 40518508133 (job `ledger`), finished 2026-10-27 14:23 UTC.
- `web/trend.js` sha256 `6502962e24df…` (this branch, with costModel), `research/ledger/ledger.js` sha256 `35fb90091550…`.
- Data: Binance USD-M 4h klines 12 coins (first bar per coin as listed, last 2026-10-26 20:00 UTC), funding-rate archives
  through 2026-09 (7,395 settlements for BTC). **October 2026 funding is not in the monthly archive yet**, so the
  "2026-10 on" rows under the signed models carry no funding.
- Output: branch `research-results`, `results/ledger.json`, `results/ledger_fills.gz` (every fill). Copy on main:
  `research/ledger/ledger_20261027.json`.
- Deterministic: bootstrap 0, Monte Carlo 0, permutation 0, seed N/A.

## 1. Reconciliation — PASS
Every trade rebuilt from raw bars with the ledger's own arithmetic: 3,186 trades (2020-01 .. 2026-10, app filter),
max |R(ledger) − R(trend.js)| = 3.6e-15 (legacy), 0 (fills), 1.8e-15 (signed, prices and fees). Legacy 2023-01..2026-09
reproduces the app's evidence exactly: 1,999 trades, +208.17R.

## 2. Cost models, 2023-01 .. 2026-09 (entry time), 1,999 trades
| model | avg R | sum R | PF | win |
|---|---|---|---|---|
| legacy (app: slippage twice, fees on entry notional, funding 0.01%/8h always paid) | +0.1041 | +208.17 | 1.246 | 34.1% |
| fills (slippage once, fees on executed notional) | +0.1114 | +222.63 | 1.265 | 34.3% |
| fills + signed exchange funding | +0.1245 | +248.96 | 1.301 | 34.9% |
| fills + signed, fee and slippage x2 (2,001 trades) | +0.0954 | +190.85 | 1.221 | 33.9% |

By period, fills + signed: 2020-2022 +0.2035R (1,145); 2023-2024 +0.1781R (1,019); 2025-01..2026-09 +0.0689R (980);
2026-10 on −0.5073R (42 trades, −21.31R).

## 3. Portfolio, 0.25% of equity per trade, 2023-01 .. 2026-09 (fills + signed)
End equity ×1.737; close drawdown 16.51%; intrabar bound 17.02%; 46 months, 56.5% positive; peak open risk 3.02%,
peak 12 open positions. (Legacy: DD 18.08%, ×1.569.)

## 4. Locked gate
| item | result |
|---|---|
| untouched OOS ≥ 200 trades | UNKNOWN (none exists) |
| net PF ≥ 1.15 | PASS 1.301 |
| two non-overlapping periods profitable | PASS +181.46R / +67.50R |
| ≥ 60% positive months | **FAIL 56.5%** |
| close DD ≤ 8% (0.25% risk) | **FAIL 16.51%** (intrabar 17.02%) |
| positive at 2x execution costs | PASS +0.0954R/trade |
| purged walk-forward | UNKNOWN (not run) |
| forward paper | UNKNOWN |

**NOT PASSED.** The accounting fixes and real funding raise the historical mean (+0.104 → +0.125R) but do not change the
verdict: drawdown is twice the limit and positive months are below 60%. Lowering risk per trade does not fix positive
months; no leverage or sizing change is proposed to mask this.

## 5. Notes
- The app (main, v8.0) still uses costModel legacy (more conservative); its Results tab now shows this gate.
- The 2x model has 2 more trades because the leverage filter uses the slipped entry price.
- Next: purged walk-forward; a prospective paper ledger from today (the only clean OOS available); filter experiments
  with frozen entry/SL/TP measured as avoided losers vs discarded winners.
