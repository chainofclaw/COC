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

NODE_TESTS=$(collect_tests "$ROOT_DIR/node/src")
RUNTIME_LIB_TESTS=$(collect_tests "$ROOT_DIR/runtime/lib")
RUNTIME_ROOT_TESTS=$(collect_tests "$ROOT_DIR/runtime" "root-only")
UNIT_TESTS="$(collect_tests "$ROOT_DIR/services") $(collect_tests "$ROOT_DIR/nodeops")"
ROOT_TESTS=$(collect_tests "$ROOT_DIR/tests" "root-only")
INTEGRATION_TESTS=$(collect_tests "$ROOT_DIR/tests/integration")
E2E_TESTS=$(collect_tests "$ROOT_DIR/tests/e2e")
EXT_TESTS=$(collect_tests "$ROOT_DIR/extensions")
WALLET_TESTS=$(collect_tests "$ROOT_DIR/wallet" "root-only")
EXPLORER_TESTS=$(collect_tests "$ROOT_DIR/explorer/src/lib")
FAUCET_TESTS=$(collect_tests "$ROOT_DIR/faucet/src")
CONTRACT_DEPLOY_TESTS=$(collect_tests "$ROOT_DIR/contracts/deploy")

if [[ -n "${NODE_TESTS// }" ]]; then
  echo "[gate] node core tests"
  node --experimental-strip-types --test $NODE_TESTS
fi

if [[ -n "${RUNTIME_LIB_TESTS// }${RUNTIME_ROOT_TESTS// }" ]]; then
  echo "[gate] runtime tests"
  node --experimental-strip-types --test $RUNTIME_LIB_TESTS $RUNTIME_ROOT_TESTS
fi

if [[ -n "${UNIT_TESTS// }" ]]; then
  echo "[gate] service + ops tests"
  node --experimental-strip-types --test $UNIT_TESTS
fi

if [[ -n "${ROOT_TESTS// }" ]]; then
  echo "[gate] root tests"
  node --experimental-strip-types --test $ROOT_TESTS
fi

if [[ -n "${INTEGRATION_TESTS// }" ]]; then
  echo "[gate] integration tests"
  node --experimental-strip-types --test $INTEGRATION_TESTS
fi

if [[ -n "${E2E_TESTS// }" ]]; then
  echo "[gate] e2e tests"
  node --experimental-strip-types --test $E2E_TESTS
fi

if [[ -n "${EXT_TESTS// }" ]]; then
  echo "[gate] extension tests"
  node --experimental-strip-types --test $EXT_TESTS
fi

if [[ -n "${WALLET_TESTS// }" ]]; then
  echo "[gate] wallet tests"
  node --experimental-strip-types --test $WALLET_TESTS
fi

if [[ -n "${EXPLORER_TESTS// }" ]]; then
  echo "[gate] explorer tests"
  node --experimental-default-type=module --experimental-strip-types --test $EXPLORER_TESTS
fi

if [[ -n "${FAUCET_TESTS// }" ]]; then
  echo "[gate] faucet tests"
  node --experimental-strip-types --test $FAUCET_TESTS
fi

if [[ -n "${CONTRACT_DEPLOY_TESTS// }" ]]; then
  echo "[gate] contracts deploy tests"
  node --experimental-default-type=module --experimental-strip-types --test $CONTRACT_DEPLOY_TESTS
fi

echo "[gate] contracts hardhat tests"
cd "$ROOT_DIR/contracts"
npm test
cd "$ROOT_DIR"

echo "[gate] all checks passed"
