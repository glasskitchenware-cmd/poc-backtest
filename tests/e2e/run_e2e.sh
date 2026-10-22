#!/usr/bin/env bash
# End-to-end test on an Android emulator (debug APK + mock_server.py on the host at 10.0.2.2:8765).
# Drives the production path: exact alarm -> ScanService -> hidden WebView (index.html#bg) -> mock USD-M API
# -> Alerts.onScan -> notifications. Writes evidence to tests/e2e/out/.
set -uo pipefail
PKG=th.paperbot.backtest
OUT=tests/e2e/out
mkdir -p "$OUT"
LOG="$OUT/e2e.log"
: > "$LOG"
FAILS=0
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
check() { if [ "$1" = "1" ]; then log "PASS $2"; else log "FAIL $2"; FAILS=$((FAILS + 1)); fi; }
mode() { curl -s "http://127.0.0.1:8765/__mode?m=$1" > /dev/null; log "mock mode -> $1"; }
hook() { adb shell am broadcast -n "$PKG/.DebugHooks" -a "th.paperbot.backtest.$1" "${@:2}" > /dev/null; }
titles() { adb shell dumpsys notification --noredact | grep -o 'android.title=String ([^)]*)' | sed 's/android.title=String (//; s/)$//' | grep 'ทดลอง ·' | sort -u; }
ntitles() { titles | grep -c . || true; }
prefs() { adb shell run-as "$PKG" cat shared_prefs/alerts.xml 2>/dev/null; }
status_text() { prefs | grep -o 'name="lastScanText">[^<]*' | sed 's/name="lastScanText">//'; }
status_at() { prefs | grep -o 'name="lastScanAt" value="[0-9]*"' | grep -o '[0-9]*' || echo 0; }
wait_scan() {  # wait until lastScanAt moves past $1 (max $2 seconds)
  local before=$1 limit=$2 t=0
  while [ $t -lt "$limit" ]; do
    [ "$(status_at)" -gt "$before" ] && return 0
    sleep 5; t=$((t + 5))
  done
  return 1
}
scan() {  # trigger the real alarm path and wait for the scan to finish
  local before; before=$(status_at)
  hook DEBUG_SCAN
  wait_scan "$before" 150 || log "scan did not finish in time"
  log "status: $(status_text)"
}
inject() {  # $1 = JSON packet, sent through the same Alerts.onScan the scanner uses
  hook DEBUG_INJECT --es json_b64 "$(printf '%s' "$1" | base64 -w0)"
  sleep 3
}
packet() {  # $1 symbol, $2 side, candle = the 15m candle that just closed (host clock)
  python3 - "$1" "$2" <<'EOF'
import json, sys, time
c = int(time.time() * 1000) // 900000 * 900000
print(json.dumps({"v": 2, "candle": c, "interval_minutes": 15, "error": "", "scanned": 1, "failed": [], "signals": [{
    "symbol": sys.argv[1], "side": sys.argv[2], "tf": "M15", "strategy": "squeeze3_ls", "candle_close": c, "expires": c + 900000,
    "entry": "100.00", "sl": "98.20", "tp1": "101.80", "tp2": "103.60", "tp5": "109.00", "qty": "1", "margin_usdt": "10.00",
    "margin_thb": "330", "risk_thb": "25", "leverage": 10, "leverage_cap": 10, "liq_est": "91.00", "rationale": "e2e inject",
    "evidence": "ยังไม่มีข้อมูลยืนยัน", "evidence_ok": False, "experimental": True}]}, ensure_ascii=False))
EOF
}

log "device: $(adb shell getprop ro.build.version.release) sdk $(adb shell getprop ro.build.version.sdk)"
adb install -r -g app-debug.apk >> "$LOG" 2>&1
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null
adb shell cmd notification allow_listener com.android.systemui 2>/dev/null || true

# First launch: alerts switch on by default and the alarm is armed.
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" >> "$LOG"
sleep 25
adb exec-out screencap -p > "$OUT/01_app_main.png"
FOCUS=$(adb shell dumpsys window | grep -m1 -E 'mCurrentFocus|mFocusedApp' | tr -d '\r')
log "focus after first launch: $FOCUS"
adb logcat -d -b crash > "$OUT/crash_first_launch.txt"
adb logcat -d | grep -E "AndroidRuntime|th.paperbot|ActivityTaskManager|chromium" | tail -80 > "$OUT/logcat_first_launch.txt"
check "$( [ -s "$OUT/crash_first_launch.txt" ] && echo 0 || echo 1)" "no crash on first launch"
check "$(echo "$FOCUS" | grep -q "$PKG" && echo 1 || echo 0)" "app is in the foreground 25 s after first launch"
hook DEBUG_CONFIG --es base "http://10.0.2.2:8765"
check "$(adb shell dumpsys alarm | grep -c "$PKG" | awk '{print ($1>0)}')" "alarm armed after first launch"
check "$(prefs | grep -c 'name="enabled" value="true"' | awk '{print ($1>0)}')" "alerts enabled by default"
adb shell input keyevent KEYCODE_HOME

# 1. Real scan of 3 default coins (BTC, ETH, SOL) on a real ETH candle where the rule fired LONG.
mode normal
scan
T=$(titles); log "titles:"; echo "$T" | tee -a "$LOG"
check "$(echo "$T" | grep -c 'LONG · M15' | awk '{print ($1==3)}')" "3 coins signal on the same candle -> 3 separate LONG notifications"
adb shell cmd statusbar expand-notifications; sleep 3
adb exec-out screencap -p > "$OUT/02_notifications_long.png"
adb shell cmd statusbar collapse

# 2. Same candle again (retry / reconnect): no repeats.
N=$(ntitles); scan
check "$( [ "$(ntitles)" = "$N" ] && status_text | grep -q 'ซ้ำ 3' && echo 1 || echo 0)" "rescanning the same closed candle posts nothing new (dedup 3)"

# 3. Mirrored market: SHORT on the same candle is a different signal.
mode short; scan
check "$(titles | grep -c 'SHORT · M15' | awk '{print ($1==3)}')" "mirrored series -> 3 SHORT notifications"
adb shell cmd statusbar expand-notifications; sleep 3
adb exec-out screencap -p > "$OUT/03_notifications_long_short.png"
adb shell cmd statusbar collapse

# 4. Exchange one candle behind: refuse, record failure, no notification.
N=$(ntitles); mode stale; scan
check "$( [ "$(ntitles)" = "$N" ] && status_text | grep -q 'ไม่สด' && echo 1 || echo 0)" "stale candles -> no notification, status says stale"

# 5. API down.
mode down; scan
check "$( [ "$(ntitles)" = "$N" ] && status_text | grep -q 'สแกนไม่สำเร็จ' && echo 1 || echo 0)" "API down -> no notification, failure recorded"

# 6. Airplane mode then reconnect.
mode normal
adb shell cmd connectivity airplane-mode enable; sleep 5; scan
check "$( [ "$(ntitles)" = "$N" ] && status_text | grep -q 'สแกนไม่สำเร็จ' && echo 1 || echo 0)" "airplane mode -> failure recorded, nothing posted"
adb shell cmd connectivity airplane-mode disable; sleep 15; scan
check "$(status_text | grep -q '^สแกน 3 เหรียญ' && echo 1 || echo 0)" "after reconnect the next scan succeeds"

# 7. Notification permission denied, then granted: nothing posted while denied, delivered after.
adb shell pm revoke "$PKG" android.permission.POST_NOTIFICATIONS; sleep 2
inject "$(packet DOGEUSDT LONG)"
check "$( titles | grep -q DOGEUSDT && echo 0 || echo 1)" "permission denied -> DOGE not shown"
check "$(status_text | grep -q 'แจ้งเตือนถูกปิด' && echo 1 || echo 0)" "permission denied is recorded in the status"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS; sleep 2
inject "$(packet DOGEUSDT LONG)"
check "$( titles | grep -q 'DOGEUSDT LONG' && echo 1 || echo 0)" "after granting, the same candle's DOGE alert is delivered (dedup not consumed)"

# 8. Screen off + Doze + background-killed process: the real 5-minute alarm still runs a scan.
hook DEBUG_CONFIG --ei minutes 5
adb shell am kill "$PKG"
adb shell input keyevent KEYCODE_SLEEP
adb shell dumpsys deviceidle force-idle >> "$LOG" 2>&1
B=$(status_at)
if wait_scan "$B" 720; then check 1 "screen off + doze + killed process: scheduled alarm ran a scan ($(status_text))"
else check 0 "screen off + doze + killed process: no scan within 12 min"; fi
adb shell dumpsys deviceidle unforce >> "$LOG" 2>&1
adb shell input keyevent KEYCODE_WAKEUP

# 9. Reboot: the alarm is re-armed by BOOT_COMPLETED without opening the app.
adb reboot
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 3; done
sleep 30
check "$(adb shell dumpsys alarm | grep -c "$PKG" | awk '{print ($1>0)}')" "alarm re-armed after reboot"

adb shell am start -W -n "$PKG/.MainActivity" >> "$LOG"; sleep 20
adb exec-out screencap -p > "$OUT/04_app_after_reboot.png"
log "final status: $(status_text)"
log "RESULT: $FAILS failure(s)"
exit $FAILS
