#!/usr/bin/env bash
# R1.4: poll all 5 H15 fork validators until each reports block height >= TARGET.
# Usage: TARGET=10 MAX_WAIT_S=240 bash wait-ready-h15.sh

set -euo pipefail

TARGET="${TARGET:-10}"
MAX_WAIT_S="${MAX_WAIT_S:-300}"
PORTS=(38790 38792 38794 38796 38798)

start_ms=$(date +%s%3N)

block_height_dec() {
  local port="$1"
  curl -fsS -m 2 "http://localhost:${port}" \
    -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    2>/dev/null | python3 -c 'import sys,json
try: print(int(json.load(sys.stdin)["result"], 16))
except: print(-1)' 2>/dev/null || echo -1
}

while true; do
  elapsed_s=$(( ($(date +%s%3N) - start_ms) / 1000 ))
  if (( elapsed_s > MAX_WAIT_S )); then
    echo "TIMEOUT: validators not ready after ${MAX_WAIT_S}s"
    for port in "${PORTS[@]}"; do
      echo "  port ${port} height=$(block_height_dec "$port")"
    done
    exit 1
  fi

  ready=true
  heights=""
  for port in "${PORTS[@]}"; do
    h=$(block_height_dec "$port")
    heights+="${port}=${h} "
    if (( h < TARGET )); then ready=false; fi
  done

  if $ready; then
    echo "READY: ${heights}"
    exit 0
  fi

  echo "[${elapsed_s}s] heights: ${heights}"
  sleep 5
done
