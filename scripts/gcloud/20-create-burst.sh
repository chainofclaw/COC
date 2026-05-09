#!/usr/bin/env bash
# 20-create-burst.sh — Create one burst VM (e2-medium, smaller SSD, dynamic).
# Bursts are observer fullnodes that join during validation windows and stop
# between runs. Their persistent disks are kept by default — restart picks up
# where they left off, no re-sync.
#
# Usage:
#   bash 20-create-burst.sh burst-1
#   bash 20-create-burst.sh burst-2
#   bash 20-create-burst.sh burst-3

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
require_gcloud

case "${1:-}" in
  burst-1) NAME="$COC_BURST_1_NAME"; ZONE="$COC_BURST_1_ZONE"; TYPE="$COC_BURST_1_TYPE" ;;
  burst-2) NAME="$COC_BURST_2_NAME"; ZONE="$COC_BURST_2_ZONE"; TYPE="$COC_BURST_2_TYPE" ;;
  burst-3) NAME="$COC_BURST_3_NAME"; ZONE="$COC_BURST_3_ZONE"; TYPE="$COC_BURST_3_TYPE" ;;
  *) echo "usage: $0 {burst-1|burst-2|burst-3}" >&2; exit 2 ;;
esac

if gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
  echo "==> $NAME already exists in $ZONE — skipping create."
  exit 0
fi

SUBNET_REGION="${ZONE%-*}"
if [[ "$SUBNET_REGION" == "us-central1" ]]; then
  BURST_SUBNET="$COC_GCP_SUBNET"
else
  BURST_SUBNET="${COC_GCP_NETWORK}-${SUBNET_REGION}"
fi
if ! gcloud compute networks subnets describe "$BURST_SUBNET" --region="$SUBNET_REGION" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
  case "$SUBNET_REGION" in
    us-central1)        RANGE="10.10.0.0/20" ;;
    asia-east1)         RANGE="10.20.0.0/20" ;;
    europe-west1)       RANGE="10.30.0.0/20" ;;
    us-west1)           RANGE="10.40.0.0/20" ;;
    asia-southeast1)    RANGE="10.50.0.0/20" ;;
    *) echo "ERROR: unknown region $SUBNET_REGION — extend script" >&2; exit 2 ;;
  esac
  echo "==> Creating subnet $BURST_SUBNET in $SUBNET_REGION ($RANGE)"
  gcloud compute networks subnets create "$BURST_SUBNET" \
    --project="$COC_GCP_PROJECT" \
    --network="$COC_GCP_NETWORK" \
    --region="$SUBNET_REGION" \
    --range="$RANGE"
fi

# Reserve a static external IP per VM. Without this, GCP assigns ephemeral
# IPs that change on stop+start — breaking the peers[] config baked into
# the deploy bundle. Idempotent: skips if address already exists.
ADDR_NAME="${NAME}-static"
if ! gcloud compute addresses describe "$ADDR_NAME" --region="$SUBNET_REGION" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
  gcloud compute addresses create "$ADDR_NAME" --region="$SUBNET_REGION" --project="$COC_GCP_PROJECT" >/dev/null
fi
STATIC_IP=$(gcloud compute addresses describe "$ADDR_NAME" --region="$SUBNET_REGION" --project="$COC_GCP_PROJECT" --format="value(address)")

echo "==> Creating burst VM: $NAME ($TYPE) in $ZONE with static IP $STATIC_IP"
gcloud compute instances create "$NAME" \
  --project="$COC_GCP_PROJECT" \
  --zone="$ZONE" \
  --machine-type="$TYPE" \
  --network="$COC_GCP_NETWORK" \
  --subnet="$BURST_SUBNET" \
  --address="$STATIC_IP" \
  --image-family="$COC_VM_IMAGE_FAMILY" \
  --image-project="$COC_VM_IMAGE_PROJECT" \
  --boot-disk-size="$COC_BOOT_DISK_SIZE_BURST" \
  --boot-disk-type="$COC_BOOT_DISK_TYPE" \
  --tags="coc-fullnode,coc-burst" \
  --labels="$COC_VM_LABELS,role=coc-burst" \
  --metadata=enable-oslogin=TRUE \
  --scopes=cloud-platform

echo ""
echo "==> $NAME created. External IP:"
gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$COC_GCP_PROJECT" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
