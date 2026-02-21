#!/usr/bin/env bash
# Query COC node status via RPC
# Usage: bash scripts/node-status.sh [rpc_url]
set -euo pipefail

RPC_URL="${1:-http://127.0.0.1:18780}"

rpc() {
  local method="$1"
  local params="${2:-[]}"
  curl -sf -X POST -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"${method}\",\"params\":${params},\"id\":1}" \
    "$RPC_URL" 2>/dev/null
}

extract() { node --experimental-strip-types -e "const r=JSON.parse(process.argv[1]); $2" "$1"; }

echo "=== COC Node Status ==="
echo "RPC: ${RPC_URL}"
echo ""

# Block height
BLOCK_RESP=$(rpc "eth_blockNumber")
if [[ -z "$BLOCK_RESP" ]]; then
  echo "ERROR: Cannot connect to ${RPC_URL}"
  exit 1
fi
BLOCK_HEX=$(echo "$BLOCK_RESP" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).result||'0x0')")
BLOCK_NUM=$((${BLOCK_HEX}))
echo "Block height:  ${BLOCK_NUM}"

# Chain ID
CHAIN_RESP=$(rpc "eth_chainId")
CHAIN_HEX=$(echo "$CHAIN_RESP" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).result||'0x0')")
CHAIN_ID=$((${CHAIN_HEX}))
echo "Chain ID:      ${CHAIN_ID}"

# Peer count
PEER_RESP=$(rpc "net_peerCount")
PEER_HEX=$(echo "$PEER_RESP" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).result||'0x0')")
PEER_COUNT=$((${PEER_HEX}))
echo "Peers:         ${PEER_COUNT}"

# Gas price
GAS_RESP=$(rpc "eth_gasPrice")
GAS_HEX=$(echo "$GAS_RESP" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).result||'0x0')")
GAS_PRICE=$((${GAS_HEX}))
echo "Gas price:     ${GAS_PRICE} wei"

# Mempool
POOL_RESP=$(rpc "coc_mempoolStats")
if echo "$POOL_RESP" | node -e "const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); process.exit(r.result?0:1)" 2>/dev/null; then
  POOL_INFO=$(echo "$POOL_RESP" | node -e "
    const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).result;
    console.log('Mempool:       ' + (r.size||r.pending||0) + ' pending');
  ")
  echo "$POOL_INFO"
fi

echo ""

# BFT status
BFT_RESP=$(rpc "coc_getBftStatus")
if echo "$BFT_RESP" | node -e "const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); process.exit(r.result?0:1)" 2>/dev/null; then
  echo "=== BFT Consensus ==="
  echo "$BFT_RESP" | node -e "
    const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).result;
    console.log('Enabled:       ' + r.enabled);
    console.log('Active:        ' + r.active);
    if (r.height) console.log('Round height:  ' + parseInt(r.height, 16));
    if (r.phase) console.log('Phase:         ' + r.phase);
    if (r.equivocations !== undefined) console.log('Equivocations: ' + r.equivocations);
  "
  echo ""
fi

# Network stats
NET_RESP=$(rpc "coc_getNetworkStats")
if echo "$NET_RESP" | node -e "const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); process.exit(r.result?0:1)" 2>/dev/null; then
  echo "=== Network Stats ==="
  echo "$NET_RESP" | node -e "
    const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).result;
    if (r.height) console.log('Height:        ' + parseInt(r.height, 16));
    if (r.peerCount !== undefined) console.log('P2P peers:     ' + r.peerCount);
    if (r.wireConnections !== undefined) console.log('Wire conns:    ' + r.wireConnections);
    if (r.dhtSize !== undefined) console.log('DHT size:      ' + r.dhtSize);
  "
  echo ""
fi

# Chain stats
STATS_RESP=$(rpc "coc_chainStats")
if echo "$STATS_RESP" | node -e "const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); process.exit(r.result?0:1)" 2>/dev/null; then
  echo "=== Chain Stats ==="
  echo "$STATS_RESP" | node -e "
    const r=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).result;
    if (r.blockHeight) console.log('Block height:  ' + parseInt(r.blockHeight, 16));
    if (r.totalTxs) console.log('Total txs:     ' + parseInt(r.totalTxs, 16));
    if (r.avgBlockTimeMs) console.log('Avg block:     ' + r.avgBlockTimeMs + 'ms');
    if (r.validatorCount) console.log('Validators:    ' + r.validatorCount);
  "
fi
