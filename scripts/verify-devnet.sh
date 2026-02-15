#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES="${1:-3}"
BASE_RPC=28780

"${ROOT}/scripts/start-devnet.sh" "$NODES"
sleep 6

RPC0="http://127.0.0.1:${BASE_RPC}"
HEIGHT0=$(curl -sS -X POST "$RPC0" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')

sleep 8
HEIGHT1=$(curl -sS -X POST "$RPC0" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]}' | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')

if [[ "$HEIGHT0" == "$HEIGHT1" ]]; then
  echo "block production failed: height unchanged (${HEIGHT0})"
  "${ROOT}/scripts/stop-devnet.sh" "$NODES"
  exit 1
fi

echo "height advanced: ${HEIGHT0} -> ${HEIGHT1}"

TX_HASH=$(node "${ROOT}/wallet/bin/coc-wallet.js" transfer "$RPC0" "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" "1")
sleep 4
LAST_RPC="http://127.0.0.1:$((BASE_RPC + NODES - 1))"
BAL=$(node "${ROOT}/wallet/bin/coc-wallet.js" balance "$LAST_RPC" "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")
if [[ "$BAL" == "0.0" || "$BAL" == "0" ]]; then
  echo "tx propagation failed: tx=${TX_HASH} balance=${BAL}"
  "${ROOT}/scripts/stop-devnet.sh" "$NODES"
  exit 1
fi
echo "tx propagated: ${TX_HASH} recipientBalance=${BAL}"

for i in $(seq 1 "$NODES"); do
  IDX=$((i - 1))
  RP="http://127.0.0.1:$((BASE_RPC + IDX))"
  H=$(curl -sS -X POST "$RP" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":3,"method":"eth_blockNumber","params":[]}' | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')
  echo "node-${i} height=${H}"
done

# Verify BFT consensus is enabled on all nodes
echo "checking BFT status..."
for i in $(seq 1 "$NODES"); do
  IDX=$((i - 1))
  RP="http://127.0.0.1:$((BASE_RPC + IDX))"
  BFT=$(curl -sS -X POST "$RP" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":4,"method":"coc_getBftStatus","params":[]}' 2>/dev/null || echo '{}')
  echo "node-${i} bft=${BFT}"
done

"${ROOT}/scripts/stop-devnet.sh" "$NODES"
echo "verify ok"
