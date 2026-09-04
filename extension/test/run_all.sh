#!/usr/bin/env bash
# Runs every extension test: the node:test unit suites, plus the
# golden-master comparison against Python for every fixture config.
# No npm install needed — node:test and vanilla JS only.
set -euo pipefail
cd "$(dirname "$0")/.."   # extension/

echo "=== unit tests (node:test) ==="
node --test test/textMatch.test.js test/tradeTargeter.test.js test/turnDetect.test.js test/topPicks.test.js

echo
echo "=== golden-master: JS engine vs Python engine ==="
node test/compare_with_python.js test/golden_draft.json
node test/compare_with_python.js test/fixtures/with_kicker_golden.json
node test/compare_with_python.js test/fixtures/robust_rb_golden.json
node test/compare_with_python.js test/fixtures/zero_rb_golden.json

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
