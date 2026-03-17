#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES="${1:-3}"

# Port bases — must match start-devnet.sh
BASE_RPC=28780

# Cleanup on exit (success or failure)
cleanup() {
  "${ROOT}/scripts/stop-devnet.sh" "$NODES" 2>/dev/null || true
}
trap cleanup EXIT

# ── Helper: JSON-RPC call via node (robust JSON parsing) ──
rpc_result() {
  local url=$1 method=$2
  node -e "
    fetch('${url}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: '${method}', params: [] }),
    })
    .then(r => r.json())
    .then(j => { process.stdout.write(j.result ?? ''); })
    .catch(() => { process.exit(1); });
  "
}

# ── 1. Start devnet (start-devnet.sh now includes readiness wait) ──
echo "=== starting ${NODES}-node devnet ==="
"${ROOT}/scripts/start-devnet.sh" "$NODES"

# ── 2. Verify block production ──
echo "=== checking block production ==="
RPC0="http://127.0.0.1:${BASE_RPC}"
HEIGHT0=$(rpc_result "$RPC0" "eth_blockNumber")
if [[ -z "$HEIGHT0" ]]; then
  echo "FAIL: could not get initial block height"
  exit 1
fi

# Wait for at least 2 block intervals (blockTimeMs=3000)
sleep 8

HEIGHT1=$(rpc_result "$RPC0" "eth_blockNumber")
if [[ -z "$HEIGHT1" || "$HEIGHT0" == "$HEIGHT1" ]]; then
  echo "FAIL: block production stalled (height=${HEIGHT0})"
  exit 1
fi
echo "OK: height advanced ${HEIGHT0} -> ${HEIGHT1}"

# ── 3. Verify transaction propagation ──
echo "=== checking tx propagation ==="
PRIVKEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
RECIPIENT="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

TX_HASH=$(node --experimental-strip-types -e "
  import { Wallet, JsonRpcProvider, parseEther } from 'ethers';
  const provider = new JsonRpcProvider('${RPC0}');
  const signer = new Wallet('${PRIVKEY}', provider);
  const tx = await signer.sendTransaction({ to: '${RECIPIENT}', value: parseEther('1') });
  process.stdout.write(tx.hash);
")

if [[ -z "$TX_HASH" ]]; then
  echo "FAIL: could not send transaction"
  exit 1
fi
echo "sent tx: ${TX_HASH}"

# Wait for propagation + block inclusion
sleep 6

LAST_RPC="http://127.0.0.1:$((BASE_RPC + NODES - 1))"
BAL=$(node --experimental-strip-types -e "
  import { JsonRpcProvider, formatEther } from 'ethers';
  const provider = new JsonRpcProvider('${LAST_RPC}');
  const bal = await provider.getBalance('${RECIPIENT}');
  process.stdout.write(formatEther(bal));
")

if [[ -z "$BAL" || "$BAL" == "0.0" || "$BAL" == "0" ]]; then
  echo "FAIL: tx propagation failed (tx=${TX_HASH} balance=${BAL:-empty} on last node)"
  exit 1
fi
echo "OK: tx propagated, recipient balance=${BAL} on node-${NODES}"

# ── 4. Check all node heights ──
echo "=== node heights ==="
for i in $(seq 1 "$NODES"); do
  IDX=$((i - 1))
  RP="http://127.0.0.1:$((BASE_RPC + IDX))"
  H=$(rpc_result "$RP" "eth_blockNumber")
  echo "  node-${i} height=${H}"
done

# ── 5. Check BFT status ──
echo "=== BFT status ==="
for i in $(seq 1 "$NODES"); do
  IDX=$((i - 1))
  RP="http://127.0.0.1:$((BASE_RPC + IDX))"
  BFT=$(curl -sS -X POST "$RP" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":4,"method":"coc_getBftStatus","params":[]}' 2>/dev/null || echo '{}')
  echo "  node-${i} bft=${BFT}"
done

echo "=== verify ok ==="
