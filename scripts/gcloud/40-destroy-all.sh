#!/usr/bin/env bash
# 40-destroy-all.sh — DESTRUCTIVE. Delete VMs (with their boot disks) and,
# optionally, the entire VPC + firewall rules.
#
# Usage:
#   bash 40-destroy-all.sh vms-only         # delete 5 VMs but keep VPC/firewall
#   bash 40-destroy-all.sh full             # delete everything created by 00/10/20
#   bash 40-destroy-all.sh anchor-only      # delete only anchor-1, anchor-2
#   bash 40-destroy-all.sh bursts-only      # delete only burst-1..3

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
require_gcloud

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "usage: $0 {vms-only|full|anchor-only|bursts-only}" >&2
  exit 2
fi

echo "==> About to destroy mode=$MODE in project $COC_GCP_PROJECT"
echo "    Affected resources:"
case "$MODE" in
  vms-only|full)
    while read -r name zone _ _; do echo "      VM $name ($zone)"; done < <(all_nodes)
    ;;
  anchor-only)
    echo "      VM $COC_ANCHOR_1_NAME ($COC_ANCHOR_1_ZONE)"
    echo "      VM $COC_ANCHOR_2_NAME ($COC_ANCHOR_2_ZONE)"
    ;;
  bursts-only)
    while read -r name zone; do echo "      VM $name ($zone)"; done < <(burst_nodes)
    ;;
  *) echo "ERROR: unknown mode $MODE" >&2; exit 2 ;;
esac
if [[ "$MODE" == "full" ]]; then
  echo "      VPC $COC_GCP_NETWORK + all subnets + firewall rules"
fi

if ! confirm "Type 'yes' to confirm: "; then
  echo "Aborted."; exit 1
fi

delete_vm() {
  local name="$1" zone="$2"
  if gcloud compute instances describe "$name" --zone="$zone" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
    echo "  Deleting $name ($zone)"
    gcloud compute instances delete "$name" --zone="$zone" --project="$COC_GCP_PROJECT" --quiet --delete-disks=all
  else
    echo "  $name not found, skipping"
  fi
}

case "$MODE" in
  vms-only|full)
    while read -r name zone _ _; do delete_vm "$name" "$zone"; done < <(all_nodes)
    ;;
  anchor-only)
    delete_vm "$COC_ANCHOR_1_NAME" "$COC_ANCHOR_1_ZONE"
    delete_vm "$COC_ANCHOR_2_NAME" "$COC_ANCHOR_2_ZONE"
    ;;
  bursts-only)
    while read -r name zone; do delete_vm "$name" "$zone"; done < <(burst_nodes)
    ;;
esac

# Static IPs survive VM deletion and continue to bill. Release them when
# their owning VMs are deleted.
release_static_ip() {
  local name="$1" zone="$2"
  local region="${zone%-*}"
  local addr_name="${name}-static"
  if gcloud compute addresses describe "$addr_name" --region="$region" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
    echo "  Releasing static IP $addr_name"
    gcloud compute addresses delete "$addr_name" --region="$region" --project="$COC_GCP_PROJECT" --quiet
  fi
}

case "$MODE" in
  vms-only|full)
    while read -r name zone _ _; do release_static_ip "$name" "$zone"; done < <(all_nodes)
    ;;
  anchor-only)
    release_static_ip "$COC_ANCHOR_1_NAME" "$COC_ANCHOR_1_ZONE"
    release_static_ip "$COC_ANCHOR_2_NAME" "$COC_ANCHOR_2_ZONE"
    ;;
  bursts-only)
    while read -r name zone; do release_static_ip "$name" "$zone"; done < <(burst_nodes)
    ;;
esac

if [[ "$MODE" == "full" ]]; then
  echo "==> Deleting firewall rules"
  for rule in "${COC_GCP_NETWORK}-rpc" "${COC_GCP_NETWORK}-p2p" "${COC_GCP_NETWORK}-ssh" "${COC_GCP_NETWORK}-metrics"; do
    if gcloud compute firewall-rules describe "$rule" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
      gcloud compute firewall-rules delete "$rule" --project="$COC_GCP_PROJECT" --quiet
    fi
  done
  echo "==> Deleting subnets"
  for region in us-central1 asia-east1 europe-west1 us-west1 asia-southeast1; do
    sn="${COC_GCP_NETWORK}-${region}"
    if gcloud compute networks subnets describe "$sn" --region="$region" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
      gcloud compute networks subnets delete "$sn" --region="$region" --project="$COC_GCP_PROJECT" --quiet
    fi
  done
  if gcloud compute networks subnets describe "$COC_GCP_SUBNET" --region=us-central1 --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
    gcloud compute networks subnets delete "$COC_GCP_SUBNET" --region=us-central1 --project="$COC_GCP_PROJECT" --quiet
  fi
  echo "==> Deleting VPC $COC_GCP_NETWORK"
  if gcloud compute networks describe "$COC_GCP_NETWORK" --project="$COC_GCP_PROJECT" >/dev/null 2>&1; then
    gcloud compute networks delete "$COC_GCP_NETWORK" --project="$COC_GCP_PROJECT" --quiet
  fi
fi

echo "==> Done."
