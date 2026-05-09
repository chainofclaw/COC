#!/usr/bin/env bash
# 50-deploy-node.sh — Push the per-host deploy-vars + run deploy-fullnode.sh on
# a single gcloud VM. Idempotent: re-running re-applies the latest config.
#
# Prereq: bootstrap-5-fullnode-deploy.sh has been run once on this workstation
# and produced /tmp/coc-5-fullnode/deploy-vars-server-N.sh.
#
# Usage:
#   bash 50-deploy-node.sh anchor-1
#   bash 50-deploy-node.sh anchor-2
#   bash 50-deploy-node.sh burst-1 [burst-2|burst-3]
#   bash 50-deploy-node.sh all                # deploy all 5 sequentially

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
require_gcloud

BUNDLE_DIR=/tmp/coc-5-fullnode
DEPLOY_SCRIPT="$COC_REPO_ROOT/scripts/deploy-fullnode.sh"

if [[ ! -d "$BUNDLE_DIR" ]] || ! ls "$BUNDLE_DIR"/deploy-vars-server-*.sh >/dev/null 2>&1; then
  echo "ERROR: $BUNDLE_DIR/deploy-vars-server-N.sh missing." >&2
  echo "       Run bootstrap-5-fullnode-deploy.sh first:"
  echo "         bash $COC_REPO_ROOT/scripts/bootstrap-5-fullnode-deploy.sh \\"
  echo "           --chain-id $COC_UPSTREAM_CHAIN_ID \\"
  for v in "${COC_UPSTREAM_VALIDATORS[@]}"; do
    echo "           --upstream-validator $v \\"
  done
  echo "           --gcloud-host-1 <anchor-1 IP> --gcloud-host-2 <anchor-2 IP> \\"
  echo "           --gcloud-host-3 <burst-1 IP> --gcloud-host-4 <burst-2 IP> --gcloud-host-5 <burst-3 IP>"
  exit 2
fi

deploy_one() {
  local node="$1"
  local idx name zone
  case "$node" in
    anchor-1) idx=1; name="$COC_ANCHOR_1_NAME"; zone="$COC_ANCHOR_1_ZONE" ;;
    anchor-2) idx=2; name="$COC_ANCHOR_2_NAME"; zone="$COC_ANCHOR_2_ZONE" ;;
    burst-1)  idx=3; name="$COC_BURST_1_NAME";  zone="$COC_BURST_1_ZONE"  ;;
    burst-2)  idx=4; name="$COC_BURST_2_NAME";  zone="$COC_BURST_2_ZONE"  ;;
    burst-3)  idx=5; name="$COC_BURST_3_NAME";  zone="$COC_BURST_3_ZONE"  ;;
    *) echo "unknown node: $node" >&2; return 1 ;;
  esac

  local vars_file="$BUNDLE_DIR/deploy-vars-server-$idx.sh"
  if [[ ! -f "$vars_file" ]]; then
    echo "ERROR: $vars_file missing" >&2; return 1
  fi
  if [[ ! -f "$DEPLOY_SCRIPT" ]]; then
    echo "ERROR: $DEPLOY_SCRIPT missing" >&2; return 1
  fi

  echo "==> Deploying $node ($name @ $zone)"
  # Wait for VM to be SSH-ready (initial boot can take ~30s).
  echo "  Waiting for SSH on $name..."
  for i in $(seq 1 12); do
    if gcloud compute ssh "$name" --zone="$zone" --project="$COC_GCP_PROJECT" \
         --command="echo ready" --quiet 2>/dev/null | grep -q ready; then
      break
    fi
    sleep 5
  done

  echo "  Uploading deploy-vars + deploy-fullnode.sh"
  gcloud compute scp \
    "$vars_file" "$DEPLOY_SCRIPT" \
    "$name:/tmp/" \
    --zone="$zone" --project="$COC_GCP_PROJECT" --quiet

  echo "  Executing deploy-fullnode.sh on $name (this takes ~3-5 min on first run)"
  gcloud compute ssh "$name" --zone="$zone" --project="$COC_GCP_PROJECT" --quiet \
    --command="sudo bash -c 'set -e; cd /tmp; chmod +x deploy-fullnode.sh; source deploy-vars-server-$idx.sh; bash deploy-fullnode.sh'"

  echo "==> $node deployed. RPC test from operator workstation:"
  local ip
  ip=$(gcloud compute instances describe "$name" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP)")
  echo "  curl -sS http://$ip:28780 -H 'Content-Type: application/json' \\"
  echo "    -d '{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}' | jq"
}

case "${1:-}" in
  anchor-1|anchor-2|burst-1|burst-2|burst-3) deploy_one "$1" ;;
  all)
    for n in anchor-1 anchor-2 burst-1 burst-2 burst-3; do
      deploy_one "$n"
    done
    ;;
  *) echo "usage: $0 {anchor-1|anchor-2|burst-1|burst-2|burst-3|all}" >&2; exit 2 ;;
esac
