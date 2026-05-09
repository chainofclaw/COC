#!/usr/bin/env bash
# chaos/run-t120-fallback.sh — Standalone full-timing rerun of the t120-t135
# segment from the churn sequence to validate H15 staggered-fallback proposer.
#
# Why this exists: run-churn-sequence.sh --quick compresses 4h to ~58 min by
# dividing every wait by 6, so the t120 "stop burst-1 for 12 min" became
# 2 min — well below the default NO_PROGRESS_TIMEOUT (600s = 10 min). Quick
# mode therefore cannot exercise the H15 staggered fallback path. This
# script does only the t120-t135 segment with full timing.
#
# Sequence:
#   t+0   baseline snapshot
#   t+1   stop burst-1
#   t+2   snapshot (during stop)
#   t+13  snapshot (>NO_PROGRESS_TIMEOUT — H15 fallback should be active)
#   t+14  start burst-1
#   t+17  snapshot (post-recovery)
#
# PASS criteria:
#   - At t+13, chain height on remaining 4 nodes increased vs t+2 (H15 took over)
#   - No `verifyBlockChain failed` log spike during the offline window
#   - At t+17, burst-1 catches up via snap-sync
#
# Usage:
#   bash run-t120-fallback.sh [--dry-run]

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

RUN_TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG_FILE="/tmp/coc-t120-fallback-${RUN_TS}.jsonl"
ACTION_LOG="${LOG_FILE}.actions"
echo "==> Run log: $LOG_FILE"
echo "==> Action log: $ACTION_LOG"

snap() {
  local label="$1"
  echo "  [$(date +%H:%M:%S)] snapshot: $label"
  if [[ "$DRY" == "1" ]]; then
    echo "{\"dry\":true,\"label\":\"$label\"}" >> "$LOG_FILE"
  else
    bash "$SCRIPT_DIR/snapshot-cluster.sh" "$label" "$LOG_FILE" >/dev/null
  fi
}

run() {
  local cmd="$1"
  echo "  [$(date +%H:%M:%S)] action: $cmd"
  if [[ "$DRY" == "1" ]]; then
    echo "{\"dry\":true,\"action\":\"$cmd\"}" >> "$LOG_FILE"
  else
    eval "$cmd" 2>&1 | tee -a "$ACTION_LOG" || true
  fi
}

wait_min() {
  local mins="$1" purpose="${2:-}"
  local secs=$(( mins * 60 ))
  if [[ "$DRY" == "1" ]]; then secs=2; fi
  echo "  [$(date +%H:%M:%S)] wait ${secs}s ${purpose:+(${purpose})}"
  sleep "$secs"
}

cat <<EOF
==> H15 fallback validation (full timing)
==> Total runtime: ~17 min (vs 2.83 min in quick mode)
==> NO_PROGRESS_TIMEOUT default: 600s (10 min)
EOF

# === t+0 baseline ============================================================
snap "fb-t0-baseline"

# === t+1 stop burst-1 ========================================================
wait_min 1 "settle baseline"
snap "fb-t1-before-stop-burst1"
run "bash $SCRIPT_DIR/../30-stop-burst.sh burst-1"
wait_min 1 "let burst-1 finish stopping"
snap "fb-t2-after-stop-burst1-active=4"

# === t+13 cross NO_PROGRESS_TIMEOUT ==========================================
# 11 minute wait → total offline = 12 min ≥ 10 min NO_PROGRESS_TIMEOUT
wait_min 11 "burst-1 offline >NO_PROGRESS_TIMEOUT, H15 fallback should engage"
snap "fb-t13-during-long-offline-h15-expected"

# === t+14 restart burst-1 ====================================================
run "bash $SCRIPT_DIR/../31-start-burst.sh burst-1"
wait_min 3 "wait recovery + snap-sync"
snap "fb-t17-after-start-burst1"

echo ""
echo "==> Run finished. Log: $LOG_FILE"
echo "==> Lines: $(wc -l < "$LOG_FILE")"
echo "==> To analyze:"
echo "    jq -r '[.label, .upstream.h, (.nodes | to_entries[] | \"  \" + .key + \" h=\" + (.value.h|tostring))] | join(\"\\n\")' $LOG_FILE"
