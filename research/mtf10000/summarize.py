#!/usr/bin/env python3
"""Prints a compact summary of the 10,000-combo run to the log (closest candidates and their 2026 result).
Ranking uses only development + validation; 2026 is shown for those candidates without re-selecting."""
import json
from pathlib import Path

import pandas as pd
import requests

import CRYPTO_MTF_10000_M5_M15_V3 as V

session = requests.Session()
data = {}
for symbol in ("BTCUSDT", "ETHUSDT"):
    raw, _ = V.get_dataset(symbol, "./crypto3y_data", session)
    data[symbol] = {"5min": V.make_features(V.pair_to_tf(raw, "5min"), "5min"),
                    "15min": V.make_features(V.pair_to_tf(raw, "15min"), "15min")}
out = Path("./CRYPTO_MTF_10000_RESULTS"); out.mkdir(exist_ok=True)
report = V.run_search(data, out, verbose=False)
df = pd.read_csv(out / "ALL_10000_BACKTEST_RESULTS.csv")
both = df[(df.dev_trades >= 30) & (df.val_trades >= 30)]
print("== COUNTS ==")
print(json.dumps({
    "configs": len(df),
    "dev_avgR_pos": int((df.dev_avg_net_R > 0).sum()),
    "val_avgR_pos": int((df.val_avg_net_R > 0).sum()),
    "both_pos_30trades": int(((both.dev_avg_net_R > 0) & (both.val_avg_net_R > 0)).sum()),
    "both_pf_gt_1.15_60trades": int(((df.dev_trades >= 60) & (df.val_trades >= 60) & (df.dev_profit_factor > 1.15) & (df.val_profit_factor > 1.15)).sum()),
    "median_dev_avgR": round(float(df.dev_avg_net_R.median()), 3),
    "median_val_avgR": round(float(df.val_avg_net_R.median()), 3),
    "median_dev_tp5": round(float(df.dev_actual_tp5_rate.median()), 1),
    "max_dev_tp5": float(df.dev_actual_tp5_rate.max()),
    "by_tf_val_pos_share": {tf: round(float((g.val_avg_net_R > 0).mean()), 3) for tf, g in df.groupby("timeframe")},
}))
both = both.assign(score=both[["dev_avg_net_R", "val_avg_net_R"]].min(axis=1)).sort_values("score", ascending=False)
print("== TOP 12 BY min(dev,val) avg R (>=30 trades each) + 2026 check ==")
for _, r in both.head(12).iterrows():
    D = data[r.symbol][r.timeframe]
    hold = V.execute(D, r.strategy, V.FILTERS.index(r["filter"]), float(r.stopATR), int(r.hold_bars), *V.phase_bounds(D)[2])
    print(json.dumps({"sym": r.symbol, "tf": r.timeframe, "strat": r.strategy, "filter": r["filter"], "stopATR": r.stopATR, "hold": int(r.hold_bars),
        "dev": [int(r.dev_trades), r.dev_win_rate, r.dev_actual_tp5_rate, r.dev_avg_net_R, r.dev_profit_factor],
        "val": [int(r.val_trades), r.val_win_rate, r.val_actual_tp5_rate, r.val_avg_net_R, r.val_profit_factor, r.val_max_dd_pct],
        "y2026": [hold["trades"], hold["win_rate"], hold["actual_tp5_rate"], hold["avg_net_R"], hold["profit_factor"], hold["return_pct"]]}))
print("== BEST PER STRATEGY FAMILY (min of dev/val avg R) ==")
for name, g in both.groupby("strategy"):
    r = g.iloc[0]
    print(name, r.timeframe, r.symbol, r["filter"], "dev", round(r.dev_avg_net_R, 3), "val", round(r.val_avg_net_R, 3))
