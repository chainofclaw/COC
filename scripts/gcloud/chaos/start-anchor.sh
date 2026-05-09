#!/usr/bin/env bash
# chaos/start-anchor.sh — Counterpart to stop-anchor.sh. systemd auto-starts
# coc-node@1 on boot (Restart=always); the static IP is unchanged.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"
require_gcloud

start_one() {
  local name="$1" zone="$2"
  local state
  state=$(gcloud compute instances describe "$name" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --format="value(status)" 2>/dev/null || echo MISSING)
  if [[ "$state" == "MISSING" ]]; then
    echo "  $name: not found"; return
  fi
  if [[ "$state" == "RUNNING" ]]; then
    echo "  $name: already running"; return
  fi
  echo "  $name ($zone): starting..."
  gcloud compute instances start "$name" --zone="$zone" --project="$COC_GCP_PROJECT" --quiet
}

case "${1:-}" in
  anchor-1) start_one "$COC_ANCHOR_1_NAME" "$COC_ANCHOR_1_ZONE" ;;
  anchor-2) start_one "$COC_ANCHOR_2_NAME" "$COC_ANCHOR_2_ZONE" ;;
  *) echo "usage: $0 {anchor-1|anchor-2}" >&2; exit 2 ;;
esac
