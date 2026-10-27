# POC Signal — incremental causal signal audit (27 Oct 2026)

**Status: NOT PASSED / RESEARCH ONLY.** No orders, main push, production change or deployment.

## Sources and prior work
Read `research/hourly/2026-10-27-{1600,1700,1800,1900}.md`, `audit_recent.js`, `audit_cohort.js`, `audit_poc_filter.py`, and Google Doc `POC_SIGNAL_RESEARCH_20261027_1900_TH_NEGATIVE_EVIDENCE` (ID `1sJ-nKwPY1J-uW90qTQygw6fgqmNZkW98N3aZle6lERc`). Before this run, `main` matched `089daf5c8b13b13771108bcc615ea569624877f4`; research HEAD was `e8a8160c975c0504cbaa96ab1048786afe868f42`.

The separate Trend4H 15-trade −4.494R result is not POC. The saved POC B_baseline 2025–Sep2026 test has 2,835 simulated trades, −607.787R, AUC 0.4995, and 50/55/60% all-reject; those are **prior** results, not a new backtest.

Input ZIP SHA-256: POC filter `9a856774501f202521d11acccab939a3cd285ad5004e4702bb15bd47091ddb08`; archived 5m OHLCV `a41a468d66958432327bf3b9360ad7496433d2e7a8f9252b736b42bd6d5efe04`. Saved POC ledger JSON SHA-256 `3249aa85666adeacc8f5d1220793b85ac97fe446ff8a7182c4411994fc6f43d3`. Frozen source `flow_breakout/engine.js` SHA-256 `41569e18fdcff843dc9b312124496e083d9f6d8e04b03e964f6f6f53e107fbfa`; `four_groups/engine.js` SHA-256 `e7521586684dc7a1ccd8d2cc5d373ebe0319de74ae15ccab7b4d382a6617f446`.

## VERIFIED — new signal-generation reproducibility
A new script `research/hourly/audit_signal_causality.js` regenerated the **candidate breakout event stream** from archived 5m OHLCV (394,272 bars each for BTC/ETH/SOL), using frozen 72-bar breakout, ATR, 12-bar cooldown, next-open entry, cost gate, SL/TP, time/day-end/period exits. The script did **not** read saved trade entry times to decide when to generate signals. It then compared all generated trades with saved B_baseline by `coin|entry_time|dir`, and checked event ID, entry/exit indices and times, direction, entry/exit/stop/target/risk, gross/fees/slippage/funding/net R and exit reason.

| Coin | 2023 reference | 2024 validation | 2025–Sep2026 test |
|---|---:|---:|---:|
| BTC | 119 | 335 | 366 |
| ETH | 150 | 534 | 944 |
| SOL | 882 | 1,245 | 1,525 |
| **Total** | **1,151** | **2,114** | **2,835** |

**6,100 / 6,100** historical simulated trades regenerated, **0** key/field/exit-reason mismatches at relative 1e-7 numerical tolerance. Independently counted cost-gate event rejections: reference **2,244**, validation **2,475**, test **5,049**; test accepted 2,835 / 7,884 candidates (**35.96%**). **9/9** deterministic prefix-only checks (one event per coin per period) produced the same event time, direction, bound and ATR when indicators were computed only from bars available at the signal close.

This is new **reproducibility and limited causal-prefix evidence**, not new market data, independent strategy code, untouched OOS, proof that the score feature matrix is causal, or proof of a profitable edge. The ZIPs inspected did not include original `flow/<coin>.json` arrays or `X_flow.f32` needed to reconstruct model scores. Market-bar authenticity, signed funding, bid/ask/tick fills, adverse intrabar portfolio DD, margin tiers and prospective paper trading remain **UNKNOWN**.

## Reproduction and statistics
Run the research-only Node script from the repo after restoring the original archived files under `research/flow_breakout/trades.json` and `research/four_groups/bars/{BTCUSDT,ETHUSDT,SOLUSDT}_5m.json`, and restoring the original frozen `flow_breakout/engine.js`, `four_groups/engine.js`, `short_career/engine.js`. The repository does not bundle these large raw files; a clean clone alone is insufficient. Local run passed, but this commit is not a GitHub CI pass.

Monte Carlo **0**, bootstrap **0**, permutation **0**. Deterministic accepted-trade regenerations **6,100**, rejected event candidates **9,768**, prefix checks **9**. Seed/block size/CI/bias: **N/A**. Estimand: reproducibility of archived simulated signal and fill records, not expected future net R/trade. No repeated resampling was justified on already-studied data.

## Gate
No promotion without genuinely untouched OOS >=200 trades, net PF >=1.15, positive net PnL in >=2 nonoverlapping periods, >=60% profitable months, close DD <=8% with adverse intrabar bound, and positive 2x full execution-cost replay. Require purge/embargo, independent feature/score reconstruction, signed funding and forward paper trades. Preserve negative findings. **NOT PASSED.**
