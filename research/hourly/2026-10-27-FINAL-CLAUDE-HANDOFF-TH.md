# POC Signal — Claude handoff 2026-10-27 (final research checkpoint)

**NOT PASSED. Research only. No orders, main push, merge, production changes or deployment.**

## Reproducible sources
- Main: `089daf5c8b13b13771108bcc615ea569624877f4`. Research branch: `research/hourly-20261027` (16 commits ahead, 0 behind at last compare, including this checkpoint's prior two files).
- Review all hourly notes `research/hourly/2026-10-27-1600.md`, `-1700.md`, `-1800.md`, `-1900.md`, `2026-10-27-causal-signal.md`, `2026-10-27-2033-score-stability.md`, `2026-10-27-2055-tp-config.md` and audit scripts in the same directory before rerunning anything.
- Drive evidence folder: https://drive.google.com/drive/folders/1TddMOq93eOK_omMoccsU_sEC1yPd1urb
- Master Thai Doc: https://docs.google.com/document/d/1_BYTHTzRPcPUij5wlJnf1NOJa2b8Nlap1JVVT4rPST4/edit
- New 20:55 negative-evidence Doc: https://docs.google.com/document/d/1ZwH7XJghkpQY9ncbp9bt0whAPLs2l1nooM_M0mVocMI/edit

## Verified from prior saved simulated records
- POC Breakout B_baseline 2025–Sep2026: **2,835 trades, -607.787R, gross -90.919R, AUC 0.4995**, thresholds 50/55/60% reject all. The 2023–2026 simulation replay regenerated 6,100/6,100 trades and passed 9/9 causal-prefix spot checks, but this does not prove actual exchange fills or an edge.
- Trend4H is **different**: last30 exit-window 15 trades, -4.494R, with 3 pre-window entries +2.903R and 12 in-window entries -7.397R. Do not merge samples.
- 16 relative-value, 8 1h breakout, 8 fade and 8 VWAP-reversion policies failed 2024 validation. Previously studied 2024–Sep2026 data is historical pseudo-OOS, not untouched.
- Trend4H `web/trend.js` accounting showed double-slippage/fee-reconciliation issues on synthetic fixtures. Source blob SHA `9256dfcd7f2bd75d75c18f23ccc2aaba435d49dc`.
- **New 20:55 deterministic tests** executed the actual `web/trend.js` on 4 synthetic 230-bar cases. Optional `tps` silently accepts unsorted targets (misses reached 1R target), fractions summing to 1.2 (negative residual -20%), and negative fraction -0.2 (residual 120%). This affects optional TP configurations, not default `tps=[]`; it does not explain POC Breakout losses. See `audit_tp_config_2055.js` and `2026-10-27-2055-tp-config.md`.

## Statistical accounting
- Prior POC weekly bootstrap 100,000 mean-R draws plus 2,000 AUC draws; 95% mean net-R CI [-0.25684,-0.17300]. Prior forecast weekly bootstrap 40,000 draws, seed 20261027. Resamples are not independent observations.
- **20:55 run:** 4 synthetic deterministic executions; new bootstrap 0, Monte Carlo 0, permutation 0; seed, block size, CI and bias N/A; estimand TP configuration correctness. No 1,000,000-repeat claim; no new independent market sample.

## Claude action list
1. Write expected-failing tests and reject invalid `tps`: `r>0`, `0<frac<=1`, strictly ascending `r`, sum fractions <=1 (or <1 by policy), finite numbers, no duplicate targets. Patch only on research branch or PR; do not deploy.
2. Independently reconcile fill-level PnL and fees (executed notional), slippage once, signed funding, stop-first collisions, gap, partial TP, portfolio open/close/intrabar DD.
3. Freeze entry/SL/TP while testing probability filters; separately evaluate volatility-aware exits. Measure avoided losers/discarded winners, net expectancy, portfolio heat and correlation clusters, calendar regimes and liquidity.
4. Require untouched OOS >=200 trades, net PF>=1.15, positive >=2 non-overlapping periods, >=60% positive months, close DD<=8% with intrabar bound, positive 2x fee/slippage execution replay, purged walk-forward and prospective paper trades.
5. No leverage escalation to mask negative edge, no career-income claim, no live orders.

**VERIFIED:** source consistency, negative archived results, synthetic config defects. **EXPLORATORY:** hypotheses and portfolio scenarios. **UNKNOWN:** genuine future edge, signed exchange funding, tick/orderbook fills, real liquidation and prospective paper.
