#!/usr/bin/env bash
# chaos/snapshot-cluster.sh — Single-shot cluster observation. Captures peer
# topology, chain sync, and PoSe endpoint health into a timestamped JSON line
# appended to the run's snapshots.jsonl. Designed to be cheap (< 5 s) so the
# churn sequence can call it before/after every event.
#
# Usage:
#   bash snapshot-cluster.sh <event-label> [--out <file>]
#
# Output line schema (one JSON object per call):
#   { ts, label, upstream: {h, ...}, nodes: { name: { ip, h, peers, dht_peers,
#     wire_conns, partial_repl_count, verify_failed_count } } }

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../_lib.sh"

LABEL="${1:-snapshot}"
OUT_FILE="${2:-/tmp/coc-churn-snapshots.jsonl}"
shift || true

# Resolve current external IPs (static, but read fresh in case of mistakes)
resolve_ip() {
  local name="$1" zone="$2"
  gcloud compute instances describe "$name" --zone="$zone" --project="$COC_GCP_PROJECT" \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo ""
}

A1_IP=$(resolve_ip "$COC_ANCHOR_1_NAME" "$COC_ANCHOR_1_ZONE")
A2_IP=$(resolve_ip "$COC_ANCHOR_2_NAME" "$COC_ANCHOR_2_ZONE")
B1_IP=$(resolve_ip "$COC_BURST_1_NAME"  "$COC_BURST_1_ZONE")
B2_IP=$(resolve_ip "$COC_BURST_2_NAME"  "$COC_BURST_2_ZONE")
B3_IP=$(resolve_ip "$COC_BURST_3_NAME"  "$COC_BURST_3_ZONE")

# Upstream height (one validator)
UPSTREAM_H=$(curl -sS --max-time 5 http://209.74.64.88:28780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  2>/dev/null | python3 -c "import sys, json; r=json.loads(sys.stdin.read()).get('result'); print(int(r,16) if r else -1)" 2>/dev/null || echo -1)

# Per-node snapshot. Returns JSON snippet.
node_snap() {
  local name="$1" ip="$2" zone="$3"
  if [[ -z "$ip" ]]; then
    printf '"%s":{"ip":null,"reachable":false}' "$name"
    return
  fi
  local h peer_count chain_stats
  h=$(curl -sS --max-time 4 "http://$ip:28780" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' 2>/dev/null \
    | python3 -c "import sys, json; r=json.loads(sys.stdin.read()).get('result'); print(int(r,16) if r else -1)" 2>/dev/null || echo -1)
  chain_stats=$(curl -sS --max-time 4 "http://$ip:28780" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"coc_chainStats","params":[],"id":1}' 2>/dev/null \
    | python3 -c "import sys, json; r=json.loads(sys.stdin.read()).get('result',{}); print(json.dumps({'bpm':r.get('blocksPerMinute',-1),'pending':r.get('pendingTxCount',-1),'recent':r.get('recentTxCount',-1)}))" 2>/dev/null || echo '{}')
  printf '"%s":{"ip":"%s","reachable":true,"h":%s,"stats":%s}' "$name" "$ip" "${h:-null}" "$chain_stats"
}

NODES_JSON="$(node_snap anchor1 "$A1_IP" "$COC_ANCHOR_1_ZONE"),$(node_snap anchor2 "$A2_IP" "$COC_ANCHOR_2_ZONE"),$(node_snap burst1 "$B1_IP" "$COC_BURST_1_ZONE"),$(node_snap burst2 "$B2_IP" "$COC_BURST_2_ZONE"),$(node_snap burst3 "$B3_IP" "$COC_BURST_3_ZONE")"

TS=$(date -Iseconds)
LINE=$(printf '{"ts":"%s","label":"%s","upstream_h":%s,"nodes":{%s}}' "$TS" "$LABEL" "$UPSTREAM_H" "$NODES_JSON")
echo "$LINE" | tee -a "$OUT_FILE"
