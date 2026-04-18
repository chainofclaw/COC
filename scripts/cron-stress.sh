#!/usr/bin/env bash
# COC Testnet Cron Stress Test
# Runs every minute via cron, sends a batch of signed transactions and logs results.
#
# Install:
#   crontab -e → * * * * * /root/clawd/COC/scripts/cron-stress.sh >> /var/log/coc-stress.log 2>&1
#
# Each run sends 3 signed ETH transfers, waits up to 30s for confirmation,
# checks node sync, and logs a single status line.

set -uo pipefail

# Prevent concurrent runs
LOCKFILE="/tmp/coc-stress.lock"
if [ -f "$LOCKFILE" ]; then
  pid=$(cat "$LOCKFILE" 2>/dev/null)
  if kill -0 "$pid" 2>/dev/null; then
    exit 0  # Previous run still active, skip
  fi
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

RPC_URL="${COC_STRESS_RPC:-http://127.0.0.1:28780}"
LOG_DIR="/var/log/coc-stress"
STATE_FILE="/tmp/coc-stress-state.json"
NODE_BIN="$(which node 2>/dev/null || echo /usr/local/bin/node)"
WORKER_DIR="/root/coc-stress"

mkdir -p "$LOG_DIR"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Run the actual stress test in Node.js (handles signing, nonce, receipt polling)
result=$(cd "$WORKER_DIR" && "$NODE_BIN" --experimental-strip-types worker.ts "$RPC_URL" 2>/dev/null || echo '{"status":"CRASH"}')

# Parse result
status=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status","ERROR"))' 2>/dev/null || echo "ERROR")
height=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("height",0))' 2>/dev/null || echo 0)
blocks=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("blocks",0))' 2>/dev/null || echo 0)
sent=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("sent",0))' 2>/dev/null || echo 0)
confirmed=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("confirmed",0))' 2>/dev/null || echo 0)
peers=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("peers",0))' 2>/dev/null || echo 0)
sync=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("sync","?"))' 2>/dev/null || echo "?")
detail=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("detail",""))' 2>/dev/null || echo "")

# Stall detection
prev_height=0
if [ -f "$STATE_FILE" ]; then
  prev_height=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('height',0))" 2>/dev/null || echo 0)
fi
if [ "$height" -eq "$prev_height" ] && [ "$height" -gt 0 ]; then
  status="STALLED"
fi
python3 -c "import json; json.dump({'height':$height,'ts':'$(ts)'}, open('$STATE_FILE','w'))" 2>/dev/null

# Log
line="$(ts) $status h=$height +$blocks sent=$sent ok=$confirmed peers=$peers sync=$sync $detail"
echo "$line"
echo "$line" >> "$LOG_DIR/stress-$(date -u +%Y%m%d).log"
