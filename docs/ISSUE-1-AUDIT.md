# Issue #1 — audit and changes (2026-10-22)

Baseline: `c743109`. Scope: notification-only USD-M futures signals, 12 coins, M5/M15 (H1 as comparator), paper only.

## Audit findings on the baseline

| # | Area | Finding | Fix |
|---|------|---------|-----|
| 1 | Source of truth | The commits after `3f57fe7` edited the built `index.html` directly; the scripts' sources lived elsewhere and had drifted. | Sources now live in `web/`; `tools/build_web.py` builds `index.html`; CI fails if `index.html` is stale (`--check`). |
| 2 | Spot vs futures | Signals used `/fapi`, but the main screen's price and order book (`/api/v3/ticker`, `/api/v3/depth`), the chart (Spot klines and the `stream.binance.com` socket), Paper trading and the backtest tab still read **Spot** data while showing a Futures screen. | All of them now use USD-M endpoints (`/fapi/v1/*`, `wss://fstream.binance.com`). The JS tests fail if any `/api/v3/*` request is made. |
| 3 | Candle freshness | Nothing checked that the last bar was the candle that had just closed; a lagging API could produce a signal from an older bar. | A coin is skipped unless `last.close_time + 1 == latest boundary` (server time). Native side also refuses packets older than one candle (max 15 min) or from the future. |
| 4 | Exchange rules | Prices and sizes were not on the exchange grid; minQty and minNotional were not checked (only a hint text). | `/fapi/v1/exchangeInfo` (cached 6 h): prices rounded to `tickSize` (stop rounded away from entry), quantity floored to the lot step, and signals below `minQty` or `minNotional` are rejected and listed, not notified. |
| 5 | Leverage and liquidation | Liquidation used maintenance margin 0.5% and no mark price. | Leverage is a cap (5/10/20/50x) and is lowered until a pessimistic liquidation estimate (MMR 1%) stays 1.5× the stop distance away; otherwise the signal is rejected. The mark price (`/fapi/v1/premiumIndex`) is required and must be within 0.5% of the close. Bracket tables need an API key, so the app never calls a leverage "safe". |
| 6 | Confidence numbers | The notification showed a win rate from the same 30–100 days the scan just downloaded (in-sample for the alert). | Replaced by the research table `research/evidence` (real USD-M bars, 12 coins × M5/M15/H1): 2026-01..09 is out of sample for the rule. Shows trades, win rate with 95% Wilson interval, TP5R hit rate, average R and cost assumptions; fewer than 30 trades → "ยังไม่มีข้อมูลยืนยัน". |
| 7 | Timeframe sync bug | The main-screen 1H/15m/5m buttons wrote `tradeTf` but did not move the Android alarm, so background scans kept the old interval. | `setTradeTf()` is the only place that changes it and also calls `NativeHttp.setScanMinutes`. Tested. |
| 8 | Silent failures | A failed/blocked/timed-out background scan left no trace. | `Alerts.recordStatus` stores the last outcome (time, ok, reason); the app shows it in Settings. Timeouts are recorded too. |
| 9 | Notification content | Entry/SL/TP5 only. | Symbol, side, timeframe, close time (Asia/Bangkok, UTC+7), expiry, entry, SL, TP1/2/5 with R, margin in USDT/THB, loss at SL, leverage and cap, liquidation estimate, strategy id, rationale, evidence, "trial signal, not an order". Group summary when 2+ coins fire together. |
| 10 | Permission denied | The baseline skipped posting while notifications were blocked, but recorded nothing, so the user could not see why. | Nothing is posted and no dedup mark is consumed while notifications are blocked; the status says so; after the permission is granted the same candle is delivered. |
| 11 | News filter | Wording implied a news filter. | Labelled precisely: only a hand-entered FOMC date list (2026 dates unverified); CPI/NFP not filtered (no timestamped feed). |
| 12 | Gemini | Already skipped in background scans. | Kept; covered by a test. The prompt now forbids per-trade probabilities. |
| 13 | HTF alignment | The live rule (squeeze3_ls) uses only the signal timeframe; no H1/H4 inputs, so no lookahead from unfinished higher-timeframe candles. | No change needed. |

## Research evidence (why every alert is labelled experimental)

From `research/evidence/evidence_20261022.json` (run 39779737193), out of sample 2026-01..09, costs 0.05% fee + 0.02% slippage per side + funding 0.01%/8h:

| Timeframe | Trades (12 coins) | Average R per trade |
|-----------|-------------------|---------------------|
| M5 | 5,712 | −0.37 (all 12 coins negative) |
| M15 | 2,195 | −0.11 |
| H1 | 594 | −0.09 |

Positive combinations: BTC M15 (+0.006R, flat), BTC H1, ETH H1, ADA M15, LINK H1, LTC H1. TP5R was hit in about 4–13% of trades, never close to 70%. Multiple-comparison note: 36 combinations were measured with one fixed rule, so a few positive cells are expected by chance; none is used to select or tune anything.

## Tests

- `tests/js/run_tests.py` — the real `index.html` in headless Chrome against a mock USD-M API (12 coins, LONG+SHORT, M5/M15, tick grid, min notional, stale data, offline, mark price, leverage/liquidation, evidence display, no Gemini in background, timeframe → alarm sync, no Spot requests).
- `tools/java-tests/run.sh` — `SignalAlerts` rules (dedup, expiry, stale/future candles, error packets, contract violations, message content) plus the packets produced by the JS tests.
- `.github/workflows/android-e2e.yml` — debug APK on an Android 14 emulator: real alarm → foreground scan → WebView → mock API replaying real ETHUSDT candles → notifications; dedup, LONG then SHORT, stale, API down, airplane mode and recovery, permission revoke/grant, screen off + Doze + killed process, reboot. Evidence: release `e2e-evidence`.

## Known limits

- Physical phones with OEM battery managers (OPPO/realme/Xiaomi) can still delay or kill alarms; the emulator does not reproduce those.
- In Doze, Android rate-limits "allow while idle" alarms (roughly one per 9 minutes); an M5 alert can then arrive after its candle expired and is deliberately dropped.
- Always-on delivery independent of the phone would need a server + FCM; not built (cost/maintenance and privacy trade-off, see issue).
- Liquidation is an estimate without the account's bracket table.
