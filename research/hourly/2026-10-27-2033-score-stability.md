# POC Signal — Frozen-score stability audit (2026-10-27 20:33 ICT)

**NOT PASSED / RESEARCH ONLY.** No orders, main/production/deploy changes.

## Sources reviewed
Read prior research notes 16:00/17:00/18:00/19:00 and causal-signal report; reviewed audit_recent.js, audit_cohort.js, audit_poc_filter.py, audit_signal_causality.js and Google Drive 19:00 and 20:00 negative-evidence Docs. Before this new work, main HEAD was unchanged at `089daf5c8b13b13771108bcc615ea569624877f4`, research branch ahead 12/behind 0. The prior POC 2,835 simulated trades −607.787R (AUC 0.4995) are separate from Trend4H 15 trades −4.494R.

## NEW EXPLORATORY fixed-score-cut diagnostic
Input: archived POC `CRYPTO_FUTURES_FILTER_TEST_20261027.zip`, not fresh OHLCV. Do not refit model or change entries, SL or TP. Derive five cutpoints from *2023 Oct–Dec* score distribution (n=414), apply identical cutpoints to 2024 validation and historical 2025–Sep2026 pseudo-test. Since these periods were studied previously, this is NOT untouched OOS, even though the cuts use only 2023 calibration scores.

Cuts Q10 0.35743513, Q25 0.35994698, Q50 0.36246368, Q75 0.36491877, Q90 0.36662822. Retain score >= cut.

| Cut | 2024 retained | 2024 net R | 2024 PF | 2025–Sep2026 retained | Test net R | Test PF |
|---|---:|---:|---:|---:|---:|---:|
| Q10 | 1606 | -409.278 | .567 | 1873 | -408.405 | .609 |
| Q25 | 1156 | -290.532 | .572 | 1180 | -243.881 | .627 |
| Q50 | 619 | -117.998 | .656 | 559 | -124.346 | .601 |
| Q75 | 224 | -41.155 | .663 | 186 | -42.002 | .587 |
| Q90 | 85 | -12.785 | .716 | 59 | -10.792 | .649 |

All five cuts lose in both periods and all PF <1. Q75/Q90 test counts <200. This does NOT prove that every possible threshold fails, and no post-hoc cut may be promoted. Baselines: 2024 n=2114, -549.163R PF=.559; test n=2835, -607.787R PF=.609.

## Provenance / reproducibility
ZIP SHA256 `9a856774501f202521d11acccab939a3cd285ad5004e4702bb15bd47091ddb08`; decisions JSON SHA256 `46ab858d2c1c7ea7fd038c7413edb0e7ca30d39a1aff9744c5682398f28841c0`; trade ledger JSON SHA256 `3249aa85666adeacc8f5d1220793b85ac97fe446ff8a7182c4411994fc6f43d3`.
Local executed Python audit SHA256 `840178eca61396c747be1b65171ad9dfb3677e6fc65a5adb28b4d7878f0a0beb`; JSON result SHA256 `d39fb05b777b48ad9807b68bdf03df82c3f72bebda033ebe2aeb843e7b4d7bfd`. The equivalent GitHub research script `research/hourly/audit_score_stability.py` was committed at `1e9227e5fec13a4a0056b5eb5b4a6ec79660334f`; GitHub CI execution NOT claimed. The complete executed script and JSON are saved as Drive research artifacts when upload succeeds.

6,100 archived decisions read, 414 calibration rows, 15 deterministic score-cut/period calculations. New bootstrap=0, Monte Carlo=0, permutation=0; seed/block size/CI/bias=N/A. No new independent observations. Resampling 1m–10m times would not remedy reused historical periods.

## Frozen gate
Untouched OOS >=200 trades, net PF>=1.15, >=2 nonoverlapping positive periods, >=60% profitable months, close DD<=8% plus adverse intrabar bound, positive 2x full execution-cost replay, purged walk-forward, verified funding/fills, prospective paper trades. **NOT PASSED**. No real-money or career-income recommendation.
