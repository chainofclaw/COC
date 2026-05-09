#!/usr/bin/env bash
# chaos/stop-anchor.sh — Stop an anchor VM (preserves boot disk + static IP).
# Mirrors 30-stop-burst.sh but for the always-on anchors so the churn
# sequence can take them offline too.
#
# Usage:
#   bash stop-anchor.sh anchor-1
#   bash stop-anchor.sh anchor-2

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"
require_gcloud

stop_one() {
  local name="$1" zone="$2"
  local state
  state=$(gcloud compute instances describe "$name" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --format="value(status)" 2>/dev/null || echo MISSING)
  if [[ "$state" == "MISSING" ]]; then
    echo "  $name: not found"; return
  fi
  if [[ "$state" == "TERMINATED" ]]; then
    echo "  $name: already stopped"; return
  fi
  echo "  $name ($zone): stopping..."
  gcloud compute instances stop "$name" --zone="$zone" --project="$COC_GCP_PROJECT" --quiet
}

case "${1:-}" in
  anchor-1) stop_one "$COC_ANCHOR_1_NAME" "$COC_ANCHOR_1_ZONE" ;;
  anchor-2) stop_one "$COC_ANCHOR_2_NAME" "$COC_ANCHOR_2_ZONE" ;;
  *) echo "usage: $0 {anchor-1|anchor-2}" >&2; exit 2 ;;
esac
