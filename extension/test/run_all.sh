#!/usr/bin/env bash
# Runs every extension test: the node:test unit suites, plus the
# golden-master comparison against Python for every fixture config.
# No npm install needed — node:test and vanilla JS only.
set -euo pipefail
cd "$(dirname "$0")/.."   # extension/

echo "=== unit tests (node:test) ==="
# Every *.test.js in this directory, by glob. Listing them by hand meant a
# new suite could sit in the tree passing locally and never run here — which
# is exactly what happened to the snake-turn and board-identity guards.
node --test test/*.test.js

echo
echo "=== golden-master: JS engine vs Python engine ==="
node test/compare_with_python.js test/golden_draft.json
node test/compare_with_python.js test/fixtures/with_kicker_golden.json
node test/compare_with_python.js test/fixtures/robust_rb_golden.json
node test/compare_with_python.js test/fixtures/zero_rb_golden.json

echo
echo "=== golden-master: JS weekly engine vs Python weekly engine ==="
node test/compare_weekly_with_python.js test/weekly_golden.json

echo
echo "=== browser checks (skipped without playwright) ==="
if node -e "require.resolve('playwright')" 2>/dev/null; then
  node test/domActions.check.js
  node test/load_check.js
else
  echo "playwright not installed — run: npm install playwright && npx playwright install chromium"
fi

echo
echo "ALL EXTENSION TESTS PASSED"
