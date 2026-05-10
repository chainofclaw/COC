#!/usr/bin/env bash
# stop-devnet-node.sh — stop a single node from a running devnet cluster.
# Usage: bash scripts/stop-devnet-node.sh <total-nodes> <node-id>
#
# PR-1A chaos drill helper. Used by docs/n5-devnet-drill.md to simulate a
# single validator going offline (T2) without tearing down the rest of the
# cluster. Counterpart: scripts/start-devnet-node.sh restarts a single node.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES="${1:?usage: $0 <total-nodes> <node-id>}"
NODE_ID="${2:?usage: $0 <total-nodes> <node-id>}"
RUN_DIR="${ROOT}/.run/devnet-${NODES}"

if [[ ! -d "$RUN_DIR" ]]; then
  echo "run dir not found: ${RUN_DIR}" >&2
  exit 1
fi

PIDFILE="${RUN_DIR}/node-${NODE_ID}.pid"
if [[ ! -f "$PIDFILE" ]]; then
  echo "pidfile not found: ${PIDFILE} (node-${NODE_ID} not running)" >&2
  exit 1
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" >/dev/null 2>&1; then
  echo "pid ${PID} already dead; cleaning up pidfile"
  rm -f "$PIDFILE"
  exit 0
fi

kill "$PID"
for _ in $(seq 1 100); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "pid ${PID} still alive after 10s, sending SIGKILL"
  kill -9 "$PID" || true
fi
rm -f "$PIDFILE"
echo "stopped node-${NODE_ID} (pid ${PID})"
