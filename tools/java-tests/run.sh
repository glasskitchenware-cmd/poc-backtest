#!/usr/bin/env bash
# Compiles SignalAlerts.java with org.json and runs the off-device tests. Usage: tools/java-tests/run.sh [packet.json ...]
set -euo pipefail
cd "$(dirname "$0")/../.."
JAR=${ORG_JSON_JAR:-build-tools/json-20240303.jar}
if [ ! -f "$JAR" ]; then
  mkdir -p "$(dirname "$JAR")"
  curl -fsSL -o "$JAR" https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
fi
OUT=$(mktemp -d)
javac -encoding UTF-8 -cp "$JAR" -d "$OUT" android/app/src/main/java/th/paperbot/backtest/SignalAlerts.java tools/java-tests/SignalAlertsTest.java
java -Dstdout.encoding=UTF-8 -Dfile.encoding=UTF-8 -cp "$OUT:$JAR" th.paperbot.backtest.SignalAlertsTest "$@"
