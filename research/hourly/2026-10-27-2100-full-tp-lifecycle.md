# POC Signal — 21:00 incremental full-TP lifecycle audit, 27 Oct 2026
**NOT PASSED / RESEARCH ONLY / NO ORDERS / NO MAIN PUSH / NO DEPLOY**

## Source and continuity
Read GitHub hourly notes 16:00, 17:00, 18:00, 19:00, 20:33, 20:55, FINAL handoff, and audit_recent.js, audit_cohort.js, audit_poc_filter.py; read Google Drive 19:00 and 20:55 negative evidence. Main commit `089daf5c8b13b13771108bcc615ea569624877f4`, source `web/trend.js` blob `9256dfcd7f2bd75d75c18f23ccc2aaba435d49dc`. Research branch was 17 commits ahead, 0 behind before this addition.

## VERIFIED — new deterministic source execution
Ran actual fetched main `web/trend.js` as JS with 230 synthetic 4h OHLC bars. Fixed LONG entry, `tps=[{r:1,frac:.5},{r:2,frac:.5}]`, zero fee/slippage/funding, no optimization. This TP configuration is within the previously discussed `sum(frac)<=1` allowance, unlike the invalid >1 examples tested at 20:55.

1. `live:true`: both TP targets fill, `pos.left===0` and `pos.fills.length===2`, yet `pos` remains non-null and `trades.length===0` after nine more bars. `run()` continues to treat the fully exited position as active, blocking new entries until a later stop/channel exit.
2. Identical bars with a later synthetic gap down: the fully exited position is eventually reported as `reason="stop_gap"`, `tpHit=2`, `r=+1.5`, `exit_index=225`. This creates a misleading exit timestamp/reason and could distort holding-time, funding and signal availability analyses.
3. This is a **distinct lifecycle correctness defect** from unsorted TP targets or negative/overfull fractions found at 20:55. Default `tps=[]` is unaffected; no inference about POC Breakout 2,835 simulated trades -607.787R, AUC .4995, or separate Trend4H 15 trades -4.494R.

Reproduction: `node research/hourly/audit_full_tp_lifecycle_2100.js`. This source was executed using JS against the fetched main source; GitHub CI is not claimed. **2 new deterministic scenarios, 0 independent market observations, 0 bootstrap, 0 Monte Carlo, 0 permutation**. Seed, block size, CI, bias N/A. Estimand: TP position lifecycle correctness, not market expectancy.

## Claude handoff
Write expected-failing test that full scale-out `sum(frac)==1` immediately closes a position and records TP-completion at the actual fill time without a later phantom stop, and allows subsequent entries; alternatively enforce `sum(frac)<1` at the config boundary and document why. Do not silently change default behavior. Reconcile partial-fill cashflow, signed funding, maker/taker fees, slippage and gap behavior with independent fill ledger. Patch only research branch/PR; do not merge or deploy. Locked profitability gate remains untouched OOS>=200, PF>=1.15, 2 nonoverlapping profitable periods, >=60% positive months, close DD<=8% with intrabar bound, positive at 2x full execution costs, purged walk-forward and forward paper. NOT PASSED.
