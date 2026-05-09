#!/usr/bin/env bash
# 30-stop-burst.sh — Stop a burst VM (preserves boot disk and IP allocation,
# stops compute billing). Restart with 31-start-burst.sh — chain data on the
# persistent disk is intact, so the node resumes snap-sync from its last
# height.
#
# Usage:
#   bash 30-stop-burst.sh burst-1
#   bash 30-stop-burst.sh all-bursts        # stops all 3 bursts at once

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
require_gcloud

stop_one() {
  local name="$1" zone="$2"
  local state
  state=$(gcloud compute instances describe "$name" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --format="value(status)" 2>/dev/null || echo MISSING)
  if [[ "$state" == "MISSING" ]]; then
    echo "  $name: not found"
    return
  fi
  if [[ "$state" == "TERMINATED" ]]; then
    echo "  $name: already stopped"
    return
  fi
  echo "  $name ($zone): stopping..."
  gcloud compute instances stop "$name" --zone="$zone" --project="$COC_GCP_PROJECT" --quiet
}

case "${1:-}" in
  burst-1) stop_one "$COC_BURST_1_NAME" "$COC_BURST_1_ZONE" ;;
  burst-2) stop_one "$COC_BURST_2_NAME" "$COC_BURST_2_ZONE" ;;
  burst-3) stop_one "$COC_BURST_3_NAME" "$COC_BURST_3_ZONE" ;;
  all-bursts)
    while read -r name zone; do
      stop_one "$name" "$zone"
    done < <(burst_nodes)
    ;;
  *) echo "usage: $0 {burst-1|burst-2|burst-3|all-bursts}" >&2; exit 2 ;;
esac
