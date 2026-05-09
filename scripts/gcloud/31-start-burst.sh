#!/usr/bin/env bash
# 31-start-burst.sh — Start a burst VM (resume billing). systemd auto-starts
# coc-node@1 (Restart=always), so the fullnode rejoins the network within ~30s
# after the OS boots. Snap-sync resumes from the persisted height.
#
# Usage:
#   bash 31-start-burst.sh burst-1
#   bash 31-start-burst.sh all-bursts

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
require_gcloud

start_one() {
  local name="$1" zone="$2"
  local state
  state=$(gcloud compute instances describe "$name" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --format="value(status)" 2>/dev/null || echo MISSING)
  if [[ "$state" == "MISSING" ]]; then
    echo "  $name: not found — create first via 20-create-burst.sh"
    return
  fi
  if [[ "$state" == "RUNNING" ]]; then
    echo "  $name: already running"
    return
  fi
  echo "  $name ($zone): starting..."
  gcloud compute instances start "$name" --zone="$zone" --project="$COC_GCP_PROJECT" --quiet
  local ip
  ip=$(gcloud compute instances describe "$name" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP)")
  echo "  $name: external IP = $ip"
}

case "${1:-}" in
  burst-1) start_one "$COC_BURST_1_NAME" "$COC_BURST_1_ZONE" ;;
  burst-2) start_one "$COC_BURST_2_NAME" "$COC_BURST_2_ZONE" ;;
  burst-3) start_one "$COC_BURST_3_NAME" "$COC_BURST_3_ZONE" ;;
  all-bursts)
    while read -r name zone; do
      start_one "$name" "$zone"
    done < <(burst_nodes)
    ;;
  *) echo "usage: $0 {burst-1|burst-2|burst-3|all-bursts}" >&2; exit 2 ;;
esac
