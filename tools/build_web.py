#!/usr/bin/env python3
"""Inline web/ sources into the single-file index.html served by Pages and bundled in the APK.

Edit the files in web/, then run: python3 tools/build_web.py
With --check it fails if index.html is out of date (used by CI)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
NAMES = ("lightweight-charts.standalone.production.js", "engine.js", "swing.js", "evidence.js", "trend.js", "evidence_trend.js", "evidence_ledger.js", "app.js")


def build() -> str:
    html = (WEB / "index.html").read_text(encoding="utf-8")
    for name in NAMES:
        tag = f'<script src="{name}"></script>'
        if html.count(tag) != 1:
            raise SystemExit(f"web/index.html must contain {tag} exactly once")
        source = (WEB / name).read_text(encoding="utf-8").replace("</script", "<\\/script")
        html = html.replace(tag, f"<script>\n{source}\n</script>")
    return html


if __name__ == "__main__":
    built = build()
    target = ROOT / "index.html"
    if "--check" in sys.argv:
        if target.read_text(encoding="utf-8") != built:
            raise SystemExit("index.html is stale: edit web/ and run python3 tools/build_web.py")
        print("index.html matches web/ sources")
    else:
        target.write_text(built, encoding="utf-8")
        print(f"wrote {target} ({len(built):,} bytes)")
