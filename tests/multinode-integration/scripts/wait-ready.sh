#!/usr/bin/env bash
# Phase J3: poll all 3 validators until each reports block height >= TARGET.
# Bails out after MAX_WAIT_S seconds; prints heights every 5s for visibility.

set -euo pipefail

TARGET="${TARGET:-5}"
MAX_WAIT_S="${MAX_WAIT_S:-180}"
PORTS=(38780 38782 38784)

start_ms=$(date +%s%3N)

block_height_dec() {
  local port="$1"
  local hex
  hex=$(curl -fsS -m 2 "http://localhost:${port}" \
    -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    2>/dev/null | python3 -c 'import sys,json
try: print(int(json.load(sys.stdin)["result"], 16))
except: print(-1)' 2>/dev/null || echo -1)
  echo "$hex"
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
