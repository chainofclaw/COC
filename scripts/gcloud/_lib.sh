#!/usr/bin/env bash
# _lib.sh — shared helpers for scripts/gcloud/*. Sourced, never executed.

set -euo pipefail

GCLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COC_REPO_ROOT="$(cd "$GCLOUD_DIR/../.." && pwd)"

if [[ ! -f "$GCLOUD_DIR/config.env" ]]; then
  echo "ERROR: $GCLOUD_DIR/config.env not found." >&2
  echo "       cp config.env.example config.env  and edit." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$GCLOUD_DIR/config.env"

require_gcloud() {
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "ERROR: gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install" >&2
    exit 3
  fi
  local active
  active=$(gcloud config get-value account 2>/dev/null || true)
  if [[ -z "$active" ]]; then
    echo "ERROR: no active gcloud account. Run: gcloud auth login" >&2
    exit 3
  fi
  if [[ -z "${COC_GCP_PROJECT:-}" || "$COC_GCP_PROJECT" == "your-gcp-project-id" ]]; then
    echo "ERROR: set COC_GCP_PROJECT in config.env" >&2
    exit 3
  fi
}

# Print "name zone type role" for each of the 5 nodes — convenient looping.
all_nodes() {
  printf "%s %s %s anchor\n" "$COC_ANCHOR_1_NAME" "$COC_ANCHOR_1_ZONE" "$COC_ANCHOR_1_TYPE"
  printf "%s %s %s anchor\n" "$COC_ANCHOR_2_NAME" "$COC_ANCHOR_2_ZONE" "$COC_ANCHOR_2_TYPE"
  printf "%s %s %s burst\n"  "$COC_BURST_1_NAME"  "$COC_BURST_1_ZONE"  "$COC_BURST_1_TYPE"
  printf "%s %s %s burst\n"  "$COC_BURST_2_NAME"  "$COC_BURST_2_ZONE"  "$COC_BURST_2_TYPE"
  printf "%s %s %s burst\n"  "$COC_BURST_3_NAME"  "$COC_BURST_3_ZONE"  "$COC_BURST_3_TYPE"
}

burst_nodes() {
  printf "%s %s\n" "$COC_BURST_1_NAME" "$COC_BURST_1_ZONE"
  printf "%s %s\n" "$COC_BURST_2_NAME" "$COC_BURST_2_ZONE"
  printf "%s %s\n" "$COC_BURST_3_NAME" "$COC_BURST_3_ZONE"
}

resolve_zone() {
  case "$1" in
    "$COC_ANCHOR_1_NAME") echo "$COC_ANCHOR_1_ZONE" ;;
    "$COC_ANCHOR_2_NAME") echo "$COC_ANCHOR_2_ZONE" ;;
    "$COC_BURST_1_NAME")  echo "$COC_BURST_1_ZONE"  ;;
    "$COC_BURST_2_NAME")  echo "$COC_BURST_2_ZONE"  ;;
    "$COC_BURST_3_NAME")  echo "$COC_BURST_3_ZONE"  ;;
    *) echo "ERROR: unknown node $1" >&2; return 1 ;;
  esac
}

confirm() {
  local prompt="${1:-Are you sure? [yes/N]: }"
  read -r -p "$prompt" ans
  [[ "$ans" == "yes" ]]
}
