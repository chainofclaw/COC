#!/usr/bin/env bash
# chaos/kill-shard.sh — Delete a specific IPFS block (CID) from one node's
# blockstore to test the repair tick (Phase C3.3) and erasure-coded reconstruction
# (Phase Q).
#
# Usage:
#   bash kill-shard.sh <node-name> <cid>
#
# Verification expectation:
#   - Repair tick within 10 min should re-fetch the block from peers (P2)
#   - For erasure manifests, RS reconstruction kicks in if K shards remain (P3)
#   - If too many shards killed (<K), GET should return 503 (P4)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"
require_gcloud

NODE="${1:-}"
CID="${2:-}"
if [[ -z "$NODE" || -z "$CID" ]]; then
  echo "usage: $0 <node-name> <cid>" >&2
  echo "  ex: $0 burst-1 bafk... " >&2
  exit 2
fi

ZONE="$(resolve_zone "$NODE")"
echo "==> Deleting CID $CID from $NODE blockstore"

# Use the IPFS HTTP API to force-evict the block (#126: block/rm bypasses
# pin/GC indirection so chaos drills are deterministic).
gcloud compute ssh "$NODE" --zone="$ZONE" --project="$COC_GCP_PROJECT" --quiet --command="
set -e
echo 'Local IPFS reachable on port 28786? '
curl -sS --max-time 5 -X POST 'http://localhost:28786/api/v0/version' | head -c 80; echo

echo 'Force-removing block $CID...'
rm_resp=\$(curl -sS --max-time 5 -X POST 'http://localhost:28786/api/v0/block/rm?arg=$CID' || echo '{\"error\":\"curl failed\"}')
echo \"  block/rm response: \$rm_resp\"

echo 'Verifying the block is gone (cat should 404):'
status=\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -X POST 'http://localhost:28786/api/v0/cat?arg=$CID' || true)
echo \"  HTTP \$status (404 = success, 200 = not deleted)\"
if [[ \"\$status\" = \"200\" ]]; then
  echo '  ERROR: block was not actually evicted — chaos drill invalid' >&2
  exit 1
fi
"

echo ""
echo "==> Watch repair on this node (or any peer):"
echo "    Repair tick logs: 'ipfs-repair' messages every ~10 min in coc-node@1 journal"
echo "    Or force-trigger now via RPC:"
echo "      curl -sS -X POST -H 'Content-Type: application/json' \\"
echo "        --data '{\"jsonrpc\":\"2.0\",\"method\":\"coc_dhtFindProviders\",\"params\":[\"$CID\"],\"id\":1}' \\"
echo "        http://localhost:28780"
