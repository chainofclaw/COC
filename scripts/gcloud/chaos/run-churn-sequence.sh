#!/usr/bin/env bash
# chaos/run-churn-sequence.sh — Drive a 4-hour churn experiment per the
# pre-set timeline in
# /home/bob/.claude/plans/coc-gcloud-3-5-bft-p2p-sleepy-wall.md.
#
# The script wraps existing tools (30-stop-burst, 31-start-burst, stop-anchor,
# start-anchor, partition.sh, corrupt-stateroot.sh, snapshot-cluster.sh,
# pose-roundtrip.sh) into a deterministic sequence so the experiment is
# reproducible. Every event is bracketed by before/after snapshots written
# to a JSONL file the report script can later parse.
#
# Usage:
#   bash run-churn-sequence.sh [--quick]           # full 4 h sequence
#   bash run-churn-sequence.sh --dry-run           # echo events without acting
#   bash run-churn-sequence.sh --pose-only         # skip stop/start, only PoSe
#
# Output: /tmp/coc-churn-run-<UTC-iso>.jsonl

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"

QUICK=0
DRY=0
POSE_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)     QUICK=1; shift ;;
    --dry-run)   DRY=1; shift ;;
    --pose-only) POSE_ONLY=1; shift ;;
    *) shift ;;
  esac
done

RUN_TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG_FILE="/tmp/coc-churn-run-${RUN_TS}.jsonl"
echo "==> Run log: $LOG_FILE"

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
    eval "$cmd" 2>&1 | tee -a "$LOG_FILE.actions" || true
  fi
}

wait_min() {
  local mins="$1" purpose="${2:-}"
  local secs=$(( mins * 60 ))
  if [[ "$QUICK" == "1" ]]; then
    secs=$(( secs / 6 ))   # quick mode: 10x faster (4h → 40min)
  fi
  if [[ "$DRY" == "1" ]]; then secs=2; fi
  echo "  [$(date +%H:%M:%S)] wait ${secs}s ${purpose:+(${purpose})}"
  sleep "$secs"
}

# Resolve IPs once for partition payloads
A1_IP=$(gcloud compute instances describe "$COC_ANCHOR_1_NAME" --zone="$COC_ANCHOR_1_ZONE" --project="$COC_GCP_PROJECT" --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")
A2_IP=$(gcloud compute instances describe "$COC_ANCHOR_2_NAME" --zone="$COC_ANCHOR_2_ZONE" --project="$COC_GCP_PROJECT" --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")
B1_IP=$(gcloud compute instances describe "$COC_BURST_1_NAME"  --zone="$COC_BURST_1_ZONE"  --project="$COC_GCP_PROJECT" --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")
B2_IP=$(gcloud compute instances describe "$COC_BURST_2_NAME"  --zone="$COC_BURST_2_ZONE"  --project="$COC_GCP_PROJECT" --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")
B3_IP=$(gcloud compute instances describe "$COC_BURST_3_NAME"  --zone="$COC_BURST_3_ZONE"  --project="$COC_GCP_PROJECT" --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")

cat <<EOF
==> Cluster IPs at run start:
    anchor-1: $A1_IP
    anchor-2: $A2_IP
    burst-1:  $B1_IP
    burst-2:  $B2_IP
    burst-3:  $B3_IP

==> Mode: $( [[ $QUICK == 1 ]] && echo "QUICK (1/6 timing)" || echo "FULL (4h)" )$( [[ $DRY == 1 ]] && echo " DRY-RUN" )$( [[ $POSE_ONLY == 1 ]] && echo " POSE-ONLY" )
EOF

# === T+0: baseline ============================================================
snap "t0-baseline"

if [[ "$POSE_ONLY" == "0" ]]; then
  # === T+5: stop burst-3 ====================================================
  wait_min 5 "until t+5"
  snap "t5-before-stop-burst3"
  run "bash $SCRIPT_DIR/../30-stop-burst.sh burst-3"
  wait_min 1 "burst-3 settle"
  snap "t5-after-stop-burst3"

  # === T+15: start burst-3 ==================================================
  wait_min 9 "until t+15"
  snap "t15-before-start-burst3"
  run "bash $SCRIPT_DIR/../31-start-burst.sh burst-3"
  wait_min 2 "wait wire reconnect + snap-sync"
  snap "t15-after-start-burst3"

  # === T+30: stop burst-1 + burst-2 (concurrent) ============================
  wait_min 13 "until t+30"
  snap "t30-before-stop-2"
  run "bash $SCRIPT_DIR/../30-stop-burst.sh burst-1"
  run "bash $SCRIPT_DIR/../30-stop-burst.sh burst-2"
  wait_min 1 "settle"
  snap "t30-after-stop-2-quorum-lost"

  # === T+40: start burst-1 (recover quorum) =================================
  wait_min 9 "until t+40"
  snap "t40-before-start-b1"
  run "bash $SCRIPT_DIR/../31-start-burst.sh burst-1"
  wait_min 2 "wait wire reconnect"
  snap "t40-after-start-b1-quorum-restored"

  # === T+50: start burst-2 ==================================================
  wait_min 8 "until t+50"
  snap "t50-before-start-b2"
  run "bash $SCRIPT_DIR/../31-start-burst.sh burst-2"
  wait_min 2 "wait reconnect"
  snap "t50-full-recovery"

  # === T+70: partition ======================================================
  wait_min 19 "until t+70"
  snap "t70-before-partition"
  run "bash $SCRIPT_DIR/partition.sh apply $COC_ANCHOR_1_NAME,$COC_BURST_1_NAME vs $COC_ANCHOR_2_NAME,$COC_BURST_2_NAME,$COC_BURST_3_NAME"
  wait_min 1 "partition settle"
  snap "t70-during-partition"

  # === T+75: repair partition ===============================================
  wait_min 4 "partition duration"
  snap "t75-before-repair"
  run "bash $SCRIPT_DIR/partition.sh repair $COC_ANCHOR_1_NAME,$COC_BURST_1_NAME,$COC_ANCHOR_2_NAME,$COC_BURST_2_NAME,$COC_BURST_3_NAME"
  wait_min 2 "wire reconnect"
  snap "t75-after-repair"

  # === T+95: corrupt-stateroot anchor-2 =====================================
  wait_min 18 "until t+95"
  snap "t95-before-corrupt"
  run "bash $SCRIPT_DIR/corrupt-stateroot.sh $COC_ANCHOR_2_NAME"
  wait_min 2 "snap-sync recovery"
  snap "t95-after-corrupt-recovery"

  # === T+120: stop burst-1 for >NO_PROGRESS_TIMEOUT (12 min) ================
  wait_min 23 "until t+120"
  snap "t120-before-stop-b1-long"
  run "bash $SCRIPT_DIR/../30-stop-burst.sh burst-1"
  # Wait 12 min during stop. NO_PROGRESS_TIMEOUT default is 600s (10 min).
  wait_min 12 "burst-1 offline >NO_PROGRESS_TIMEOUT"
  snap "t132-during-long-offline-h15-fallback-expected"

  # === T+135: start burst-1 =================================================
  snap "t135-before-start-b1-long"
  run "bash $SCRIPT_DIR/../31-start-burst.sh burst-1"
  wait_min 3 "wait recovery + snap-sync"
  snap "t135-after-start-b1-long"
fi

# === T+180: PoSe roundtrip window =============================================
if [[ "$POSE_ONLY" == "1" ]]; then
  WAIT_TO_POSE=0
else
  WAIT_TO_POSE=42   # roughly t+180 minus current
fi
wait_min "$WAIT_TO_POSE" "until t+180 PoSe window"
snap "t180-before-pose-window"

for kind in U R S; do
  for ip in "$A1_IP" "$A2_IP" "$B1_IP" "$B2_IP" "$B3_IP"; do
    [[ -z "$ip" ]] && continue
    if [[ "$DRY" == "1" ]]; then
      echo "{\"dry\":true,\"pose\":\"$ip\",\"kind\":\"$kind\"}" >> "$LOG_FILE"
    else
      result=$(bash "$SCRIPT_DIR/pose-roundtrip.sh" "$ip" --kind "$kind" 2>/dev/null || echo '{"err":true}')
      printf '{"ts":"%s","label":"pose","ip":"%s","kind":"%s","result":%s}\n' \
        "$(date -Iseconds)" "$ip" "$kind" "$result" >> "$LOG_FILE"
    fi
  done
done
snap "t180-after-pose-window"

if [[ "$POSE_ONLY" == "0" ]]; then
  # === T+210: PoSe + churn (stop anchor-2 mid-pose) =========================
  wait_min 30 "until t+210"
  snap "t210-before-anchor2-stop-during-pose"
  run "bash $SCRIPT_DIR/stop-anchor.sh anchor-2"
  wait_min 1 "settle"
  # Issue PoSe to remaining 4 nodes
  for ip in "$A1_IP" "$B1_IP" "$B2_IP" "$B3_IP"; do
    [[ -z "$ip" ]] && continue
    if [[ "$DRY" != "1" ]]; then
      result=$(bash "$SCRIPT_DIR/pose-roundtrip.sh" "$ip" --kind U 2>/dev/null || echo '{"err":true}')
      printf '{"ts":"%s","label":"pose-churn","ip":"%s","result":%s}\n' \
        "$(date -Iseconds)" "$ip" "$result" >> "$LOG_FILE"
    fi
  done
  snap "t210-after-pose-during-churn"

  # === T+240: final snapshot + restart anchor-2 =============================
  wait_min 28 "until t+240"
  snap "t240-final-pre-restart"
  run "bash $SCRIPT_DIR/start-anchor.sh anchor-2"
  wait_min 3 "anchor-2 recovery"
  snap "t240-final"
fi

echo ""
echo "==> Run finished. Log: $LOG_FILE"
echo "==> Lines: $(wc -l < "$LOG_FILE")"
echo "==> Action log: $LOG_FILE.actions"
