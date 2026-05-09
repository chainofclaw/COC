#!/usr/bin/env bash
# 00-bootstrap-project.sh — Create VPC + subnet + firewall rules + (no static
# IPs — we use ephemeral external IPs and only pin them once VMs come up).
#
# Idempotent: safe to re-run. Existing resources are skipped.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_lib.sh"
require_gcloud

PROJ="$COC_GCP_PROJECT"
NET="$COC_GCP_NETWORK"
SUBNET="$COC_GCP_SUBNET"

echo "==> Project: $PROJ"
gcloud config set project "$PROJ" >/dev/null

echo "==> [1/4] VPC network: $NET"
if ! gcloud compute networks describe "$NET" --project="$PROJ" >/dev/null 2>&1; then
  gcloud compute networks create "$NET" \
    --project="$PROJ" \
    --subnet-mode=custom \
    --bgp-routing-mode=regional
else
  echo "   (already exists)"
fi

echo "==> [2/4] Subnet: $SUBNET (us-central1, 10.10.0.0/20)"
if ! gcloud compute networks subnets describe "$SUBNET" --region=us-central1 --project="$PROJ" >/dev/null 2>&1; then
  gcloud compute networks subnets create "$SUBNET" \
    --project="$PROJ" \
    --network="$NET" \
    --region=us-central1 \
    --range=10.10.0.0/20
else
  echo "   (already exists)"
fi

echo "==> [3/4] Firewall rules"
# RPC (28780-28781) — open for ops convenience. Tighten in production.
if ! gcloud compute firewall-rules describe "${NET}-rpc" --project="$PROJ" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "${NET}-rpc" \
    --project="$PROJ" \
    --network="$NET" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:28780-28781 \
    --source-ranges="$COC_GCP_OPERATOR_IP_CIDR" \
    --target-tags=coc-fullnode
else
  echo "   ${NET}-rpc (already exists)"
fi

# P2P / Wire / IPFS — open globally so upstream testnet validators can reach us.
if ! gcloud compute firewall-rules describe "${NET}-p2p" --project="$PROJ" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "${NET}-p2p" \
    --project="$PROJ" \
    --network="$NET" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:29780,tcp:29781,tcp:28786 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=coc-fullnode
else
  echo "   ${NET}-p2p (already exists)"
fi

# SSH from operator only.
if ! gcloud compute firewall-rules describe "${NET}-ssh" --project="$PROJ" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "${NET}-ssh" \
    --project="$PROJ" \
    --network="$NET" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:22 \
    --source-ranges="$COC_GCP_OPERATOR_IP_CIDR" \
    --target-tags=coc-fullnode
else
  echo "   ${NET}-ssh (already exists)"
fi

# Metrics from operator only — Prometheus scraping.
if ! gcloud compute firewall-rules describe "${NET}-metrics" --project="$PROJ" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "${NET}-metrics" \
    --project="$PROJ" \
    --network="$NET" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:9101 \
    --source-ranges="$COC_GCP_OPERATOR_IP_CIDR" \
    --target-tags=coc-fullnode
else
  echo "   ${NET}-metrics (already exists)"
fi

echo "==> [4/4] Done. Summary:"
gcloud compute networks describe "$NET" --project="$PROJ" --format="table(name,subnetworks.len(),autoCreateSubnetworks)"
echo ""
gcloud compute firewall-rules list --project="$PROJ" --filter="network=$NET" --format="table(name,direction,sourceRanges.list():label=SRC_RANGES,allowed[].map().firewall_rule().list():label=ALLOW)"

cat <<EOF

==> Next: create VMs.
    bash scripts/gcloud/10-create-anchor.sh anchor-1
    bash scripts/gcloud/10-create-anchor.sh anchor-2
    bash scripts/gcloud/20-create-burst.sh burst-1
    bash scripts/gcloud/20-create-burst.sh burst-2
    bash scripts/gcloud/20-create-burst.sh burst-3

EOF
