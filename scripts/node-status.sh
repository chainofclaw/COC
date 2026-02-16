#!/usr/bin/env bash
# Query COC node status via RPC
# Usage: bash scripts/node-status.sh [rpc_url]
set -euo pipefail

RPC_URL="${1:-${COC_RPC_URL:-http://127.0.0.1:18780}}"

rpc_call() {
  local method="$1"
  local params="${2:-[]}"
  curl -sf -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}" 2>/dev/null
}

echo "=== COC Node Status ==="
echo "RPC: $RPC_URL"
echo ""

# Block height
RESP=$(rpc_call "eth_blockNumber")
if [[ -z "$RESP" ]]; then
  echo "Error: cannot connect to $RPC_URL"
  exit 1
fi
HEX=$(echo "$RESP" | grep -o '"result":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
if [[ -n "$HEX" ]]; then
  HEIGHT=$((HEX))
  echo "Block Height: $HEIGHT ($HEX)"
fi

# Chain ID
RESP=$(rpc_call "eth_chainId")
CHAIN_HEX=$(echo "$RESP" | grep -o '"result":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
if [[ -n "$CHAIN_HEX" ]]; then
  CHAIN_ID=$((CHAIN_HEX))
  echo "Chain ID:     $CHAIN_ID"
fi

# Peer count
RESP=$(rpc_call "net_peerCount")
PEER_HEX=$(echo "$RESP" | grep -o '"result":"0x[0-9a-fA-F]*"' | cut -d'"' -f4)
if [[ -n "$PEER_HEX" ]]; then
  PEERS=$((PEER_HEX))
  echo "Peers:        $PEERS"
fi

# Tx pool
RESP=$(rpc_call "txpool_status")
if echo "$RESP" | grep -q '"result"'; then
  echo "Tx Pool:      $(echo "$RESP" | grep -o '"result":{[^}]*}')"
fi

# Syncing status
RESP=$(rpc_call "eth_syncing")
if echo "$RESP" | grep -q '"result":false'; then
  echo "Syncing:      false (synced)"
else
  echo "Syncing:      true"
fi

echo ""
echo "=== Health Check ==="
HEALTH=$(curl -sf "$RPC_URL/health" 2>/dev/null || echo "unreachable")
echo "Health: $HEALTH"
