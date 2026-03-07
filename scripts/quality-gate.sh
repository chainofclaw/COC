#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

collect_tests() {
  local dir="$1"
  local depth_args=()
  if [[ "${2:-}" == "root-only" ]]; then
    depth_args=(-maxdepth 1)
  fi
  find "$dir" "${depth_args[@]}" -name "*.test.ts" -type f 2>/dev/null | sort | tr '\n' ' '
}

echo "[gate] node core tests"
cd "$ROOT_DIR/node"
node --experimental-strip-types --test --test-force-exit src/*.test.ts src/**/*.test.ts
cd "$ROOT_DIR"

RUNTIME_LIB_TESTS=$(collect_tests "$ROOT_DIR/runtime/lib")
UNIT_TESTS="$(collect_tests "$ROOT_DIR/services") $(collect_tests "$ROOT_DIR/nodeops")"
ROOT_TESTS=$(collect_tests "$ROOT_DIR/tests" "root-only")
INTEGRATION_TESTS=$(collect_tests "$ROOT_DIR/tests/integration")
E2E_TESTS=$(collect_tests "$ROOT_DIR/tests/e2e")
EXT_TESTS=$(collect_tests "$ROOT_DIR/extensions")

if [[ -n "${RUNTIME_LIB_TESTS// }" ]]; then
  echo "[gate] runtime lib tests"
  node --experimental-strip-types --test --test-force-exit $RUNTIME_LIB_TESTS
fi

if [[ -n "${UNIT_TESTS// }" ]]; then
  echo "[gate] service + ops tests"
  node --experimental-strip-types --test --test-force-exit $UNIT_TESTS
fi

if [[ -n "${ROOT_TESTS// }" ]]; then
  echo "[gate] root tests"
  node --experimental-strip-types --test --test-force-exit $ROOT_TESTS
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
