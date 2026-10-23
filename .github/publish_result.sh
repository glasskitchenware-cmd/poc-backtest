#!/usr/bin/env bash
# Commits one research result to the branch research-results as results/<name>.json (with the run that made it), so
# it can be fetched with git even when creating a release is refused. Usage: publish_result.sh NAME FILE
set -euo pipefail
name="$1"; file="$2"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
for attempt in 1 2 3; do
  if git fetch -q origin research-results 2>/dev/null; then
    git checkout -qf -B research-results origin/research-results
  else
    git checkout -q --orphan research-results
    git rm -rq --cached . 2>/dev/null || true
  fi
  mkdir -p results
  cp "$file" "results/$name.json"
  echo "run ${GITHUB_RUN_ID} attempt ${GITHUB_RUN_ATTEMPT} on ${GITHUB_SHA} at $(date -u +%FT%TZ)" > "results/$name.run.txt"
  git add "results/$name.json" "results/$name.run.txt"
  git commit -qm "research result: $name (run ${GITHUB_RUN_ID})"
  if git push origin research-results; then exit 0; fi
  sleep $((attempt * 5))
done
exit 1
