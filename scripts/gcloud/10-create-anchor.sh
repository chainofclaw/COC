#!/usr/bin/env bash
# 10-create-anchor.sh — Create one anchor VM (e2-standard-2, persistent SSD).
# Anchors are intended to stay running 24/7 and may later be promoted to BFT
# validators via scripts/anchor-stake-register.sh.
#
# Usage:
#   bash 10-create-anchor.sh anchor-1
#   bash 10-create-anchor.sh anchor-2

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
require_gcloud

case "${1:-}" in
  anchor-1) NAME="$COC_ANCHOR_1_NAME"; ZONE="$COC_ANCHOR_1_ZONE"; TYPE="$COC_ANCHOR_1_TYPE" ;;
  anchor-2) NAME="$COC_ANCHOR_2_NAME"; ZONE="$COC_ANCHOR_2_ZONE"; TYPE="$COC_ANCHOR_2_TYPE" ;;
  *) echo "usage: $0 {anchor-1|anchor-2}" >&2; exit 2 ;;
esac

if gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
  echo "==> $NAME already exists in $ZONE — skipping create."
  echo "    To recreate: bash 40-destroy-all.sh anchor-only && bash 10-create-anchor.sh $1"
  exit 0
fi

# Anchor zones are not in the primary subnet (us-central1) for anchor-2; we use
# the auto-created subnet in their region. The custom-mode VPC needs an explicit
# subnet per region — create one if missing.
SUBNET_REGION="${ZONE%-*}"   # e2-standard-2 -> us-central1-a -> us-central1
# us-central1 reuses the primary subnet created by 00-bootstrap-project.sh
if [[ "$SUBNET_REGION" == "us-central1" ]]; then
  ANCHOR_SUBNET="$COC_GCP_SUBNET"
else
  ANCHOR_SUBNET="${COC_GCP_NETWORK}-${SUBNET_REGION}"
fi
if ! gcloud compute networks subnets describe "$ANCHOR_SUBNET" --region="$SUBNET_REGION" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
  # Allocate a /20 in 10.X.0.0/20 keyed by region. anchor-1=us-central1=already
  # exists as primary; anchor-2 etc. get a new range.
  case "$SUBNET_REGION" in
    us-central1)        RANGE="10.10.0.0/20" ;;
    asia-east1)         RANGE="10.20.0.0/20" ;;
    europe-west1)       RANGE="10.30.0.0/20" ;;
    us-west1)           RANGE="10.40.0.0/20" ;;
    asia-southeast1)    RANGE="10.50.0.0/20" ;;
    *) echo "ERROR: unknown region $SUBNET_REGION — extend script" >&2; exit 2 ;;
  esac
  echo "==> Creating subnet $ANCHOR_SUBNET in $SUBNET_REGION ($RANGE)"
  gcloud compute networks subnets create "$ANCHOR_SUBNET" \
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

echo "==> Creating anchor VM: $NAME ($TYPE) in $ZONE with static IP $STATIC_IP"
gcloud compute instances create "$NAME" \
  --project="$COC_GCP_PROJECT" \
  --zone="$ZONE" \
  --machine-type="$TYPE" \
  --network="$COC_GCP_NETWORK" \
  --subnet="$ANCHOR_SUBNET" \
  --address="$STATIC_IP" \
  --image-family="$COC_VM_IMAGE_FAMILY" \
  --image-project="$COC_VM_IMAGE_PROJECT" \
  --boot-disk-size="$COC_BOOT_DISK_SIZE_ANCHOR" \
  --boot-disk-type="$COC_BOOT_DISK_TYPE" \
  --tags="coc-fullnode,coc-anchor" \
  --labels="$COC_VM_LABELS,role=coc-anchor" \
  --metadata=enable-oslogin=TRUE \
  --scopes=cloud-platform

echo ""
echo "==> $NAME created. External IP:"
gcloud compute instances describe "$NAME" --zone="$ZONE" --project="$COC_GCP_PROJECT" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)"

echo ""
echo "==> Next: deploy COC fullnode onto this VM with:"
echo "    bash scripts/gcloud/50-deploy-node.sh $1"
