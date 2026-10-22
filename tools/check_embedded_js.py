#!/usr/bin/env python3
"""Fail the APK build if inlined web JavaScript is broken after patching the 12-coin alerts UI."""
from pathlib import Path
import re
import subprocess
import tempfile

html = Path(__file__).resolve().parents[1].joinpath("index.html").read_text(encoding="utf-8")
scripts = re.findall(r"<script(?:\s[^>]*)?>([\s\S]*?)</script>", html, re.IGNORECASE)
assert scripts, "No scripts in index.html"
for marker in ['id="alertTf"', 'id="alertCoinList"', 'id="alertLev"', 'futuresApi("/fapi/v1/time")',
               "window.NativeHttp.scanDone", 'function selectedCoins()', 'function initSignalSettings()',
               'function signalPayload(', 'function evidenceFor(', 'function setTradeTf(', 'window.EVIDENCE = {',
               'root.Trend = factory()', 'Trend.run(bars, { live: true })', 'function exitPayload(', 'window.EVIDENCE_TREND =']:
    assert marker in html, f"Alert feature missing: {marker}"
ids = re.findall(r'\bid="([^"]+)"', html)
assert len(ids) == len(set(ids)), "Duplicate id(s): " + repr([i for i in ids if ids.count(i)>1])
count=0
with tempfile.TemporaryDirectory() as dirname:
    for i, js in enumerate(scripts):
        if not js.strip():
            continue
        path=Path(dirname)/f"inline_{i}.js"
        path.write_text(js, encoding="utf-8")
        p=subprocess.run(["node","--check",str(path)],capture_output=True,text=True)
        if p.returncode:
            raise SystemExit(f"Embedded script #{i} syntax invalid: {p.stderr}")
        count+=1
print(f"Validated {count} inline JavaScript blocks, no duplicate IDs, and alert data contract anchors.")
