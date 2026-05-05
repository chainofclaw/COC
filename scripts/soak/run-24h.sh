#!/usr/bin/env bash
# Phase M2.2 — soak launcher.
#
# Wraps scripts/soak/collect.ts under nohup, sets up PID + log files in
# docs/soak-reports/raw/<runId>.{pid,log}, and self-terminates after the
# requested duration so an unattended 24h run cleans itself up.
#
# Usage: bash scripts/soak/run-24h.sh <runId> [host] [metrics-port] [duration-hours]
#
# Defaults: host=199.192.16.79  port=9101  duration=24
#
# Exits non-zero if pre-flight checks fail (disk space, existing run).
set -euo pipefail

RUN_ID="${1:-}"
HOST="${2:-199.192.16.79}"
PORT="${3:-9101}"
HOURS="${4:-24}"

if [[ -z "$RUN_ID" ]]; then
  echo "usage: $0 <runId> [host=199.192.16.79] [port=9101] [hours=24]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RAW_DIR="$REPO_ROOT/docs/soak-reports/raw"
PID_FILE="$RAW_DIR/$RUN_ID.pid"
LOG_FILE="$RAW_DIR/$RUN_ID.log"
JSONL_FILE="$RAW_DIR/$RUN_ID.jsonl"

mkdir -p "$RAW_DIR"

# Pre-flight: refuse to overwrite an active soak.
if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "error: soak runId=$RUN_ID already active (PID $EXISTING_PID)" >&2
    exit 3
  fi
  echo "[soak] stale PID file detected, removing" >&2
  rm -f "$PID_FILE"
fi

# Pre-flight: require >=2 GB free in repo's filesystem.
FREE_GB="$(df -BG --output=avail "$REPO_ROOT" | tail -1 | tr -d 'G ')"
if [[ -z "$FREE_GB" ]] || [[ "$FREE_GB" -lt 2 ]]; then
  echo "error: insufficient disk space (${FREE_GB:-unknown}G < 2G)" >&2
  exit 4
fi

DURATION_SECS=$(( HOURS * 3600 ))

cd "$REPO_ROOT"

echo "[soak] launching collector runId=$RUN_ID host=$HOST:$PORT duration=${HOURS}h" >&2

# nohup the collector with a self-timeout so it dies cleanly after HOURS.
# stdout/stderr -> $LOG_FILE; collector itself appends to $JSONL_FILE.
nohup timeout --preserve-status "${DURATION_SECS}s" \
  node --experimental-strip-types scripts/soak/collect.ts \
    --run-id "$RUN_ID" \
    --host "$HOST" \
    --port "$PORT" \
  > "$LOG_FILE" 2>&1 &

COLLECTOR_PID=$!
echo "$COLLECTOR_PID" > "$PID_FILE"

# Sanity: verify the process is actually running after a brief settle.
sleep 1
if ! kill -0 "$COLLECTOR_PID" 2>/dev/null; then
  echo "error: collector exited immediately, see $LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 5
fi

echo "[soak] collector running PID=$COLLECTOR_PID jsonl=$JSONL_FILE log=$LOG_FILE" >&2
echo "[soak] expected end: $(date -u -d "+${HOURS} hours" +%Y-%m-%dT%H:%M:%SZ)" >&2
echo "$RUN_ID"
