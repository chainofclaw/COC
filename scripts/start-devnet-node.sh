#!/usr/bin/env bash
# start-devnet-node.sh — restart a single node within an existing devnet
# cluster (preserving its leveldb + config). Use after stop-devnet-node.sh
# to simulate a validator coming back online during chaos drills (T2/T4
# recovery).
#
# Usage: bash scripts/start-devnet-node.sh <total-nodes> <node-id>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES="${1:?usage: $0 <total-nodes> <node-id>}"
NODE_ID_ARG="${2:?usage: $0 <total-nodes> <node-id>}"
RUN_DIR="${ROOT}/.run/devnet-${NODES}"
DATA_DIR="${RUN_DIR}/node-${NODE_ID_ARG}"
CONFIG="${DATA_DIR}/node-config.json"
PIDFILE="${RUN_DIR}/node-${NODE_ID_ARG}.pid"
LOG_FILE="${RUN_DIR}/node-${NODE_ID_ARG}.log"

if [[ ! -f "$CONFIG" ]]; then
  echo "config not found: ${CONFIG}" >&2
  echo "(was the devnet started with this NODES count?)" >&2
  exit 1
fi
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "node-${NODE_ID_ARG} is already running (pid $(cat "$PIDFILE"))" >&2
  exit 1
fi

# Re-derive anvil key by index (same table as start-devnet.sh)
IDX=$((NODE_ID_ARG - 1))
ANVIL_KEYS=(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"
)
NODE_KEY="${ANVIL_KEYS[$IDX]}"
METRICS_PORT=$((28810 + IDX))

env \
  COC_METRICS_PORT="${METRICS_PORT}" \
  COC_NODE_KEY="${NODE_KEY}" \
  COC_NODE_CONFIG="${CONFIG}" \
  node --experimental-strip-types "${ROOT}/node/src/index.ts" >>"${LOG_FILE}" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"
echo "started node-${NODE_ID_ARG} (pid ${PID}); log: ${LOG_FILE}"
