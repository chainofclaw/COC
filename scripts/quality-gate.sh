#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[gate] node core tests"
cd "$ROOT_DIR/node"
node --experimental-strip-types --test --test-force-exit src/*.test.ts src/**/*.test.ts
cd "$ROOT_DIR"

UNIT_TESTS=$(find "$ROOT_DIR/services" "$ROOT_DIR/nodeops" -name "*.test.ts" 2>/dev/null | tr '\n' ' ')
INTEGRATION_TESTS=$(find "$ROOT_DIR/tests/integration" -name "*.test.ts" 2>/dev/null | tr '\n' ' ' || true)
E2E_TESTS=$(find "$ROOT_DIR/tests/e2e" -name "*.test.ts" 2>/dev/null | tr '\n' ' ' || true)
EXT_TESTS=$(find "$ROOT_DIR/extensions" -name "*.test.ts" 2>/dev/null | tr '\n' ' ' || true)

if [[ -n "${UNIT_TESTS// }" ]]; then
  echo "[gate] service + ops tests"
  node --experimental-strip-types --test --test-force-exit $UNIT_TESTS
fi

if [[ -n "${INTEGRATION_TESTS// }" ]]; then
  echo "[gate] integration tests"
  node --experimental-strip-types --test --test-force-exit $INTEGRATION_TESTS
fi

if [[ -n "${E2E_TESTS// }" ]]; then
  echo "[gate] e2e tests"
  node --experimental-strip-types --test --test-force-exit $E2E_TESTS
fi

if [[ -n "${EXT_TESTS// }" ]]; then
  echo "[gate] extension tests"
  node --experimental-strip-types --test --test-force-exit $EXT_TESTS
fi

echo "[gate] all checks passed"
