#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES="${1:-3}"
RUN_DIR="${ROOT}/.run/devnet-${NODES}"

if [[ ! -d "$RUN_DIR" ]]; then
  echo "run dir not found: ${RUN_DIR}"
  exit 0
fi

for pidfile in "$RUN_DIR"/*.pid; do
  [[ -f "$pidfile" ]] || continue
  PID="$(cat "$pidfile")"
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID" || true
    # Wait for process to exit (max 10s)
    for _ in $(seq 1 100); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    echo "stopped pid ${PID}"
  fi
  rm -f "$pidfile"
done
