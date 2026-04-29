#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES="${1:-3}"
if [[ "$NODES" != "3" && "$NODES" != "5" && "$NODES" != "7" ]]; then
  echo "usage: $0 <3|5|7>"
  exit 1
fi

# Port bases — each range is 10 apart so up to 10 nodes never collide.
# Previous layout had P2P(29780) and Wire(29781) only 1 apart, so node-2
# P2P=29781 collided with node-1 Wire=29781.  IPFS(5001) and WS(18781)
# also overlapped with single-node defaults.
BASE_RPC=28780   # 28780..28786
BASE_WS=28790    # 28790..28796
BASE_IPFS=28800  # 28800..28806
BASE_P2P=29780   # 29780..29786
BASE_WIRE=29790  # 29790..29796
BASE_METRICS=28810  # 28810..28816
RUN_DIR="${ROOT}/.run/devnet-${NODES}"
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

# Well-known anvil dev keys — deterministic test keys, safe for local devnet.
# The wire handshake verifier (node/src/wire-client.ts:339) compares the
# recovered signature address against hs.nodeId directly, so nodeId MUST be
# a 0x-prefixed Ethereum address for handshake to succeed. testnet uses
# these same keys in docker-compose.testnet.yml; devnet used to assign
# friendly "node-N" strings as nodeId which broke every handshake.
ANVIL_KEYS=(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"
)
ANVIL_ADDRS=(
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906"
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65"
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc"
  "0x976ea74026e726554db657fa54763abd0c3a0aa9"
)

# Pre-check: ensure no port collisions with existing processes
check_port() {
  local port=$1
  if ss -ltn "sport = :${port}" 2>/dev/null | grep -q LISTEN; then
    echo "ERROR: port ${port} already in use"
    exit 1
  fi
}
for i in $(seq 1 "$NODES"); do
  IDX=$((i - 1))
  check_port $((BASE_RPC + IDX))
  check_port $((BASE_WS + IDX))
  check_port $((BASE_IPFS + IDX))
  check_port $((BASE_P2P + IDX))
  check_port $((BASE_WIRE + IDX))
  check_port $((BASE_METRICS + IDX))
done

for i in $(seq 1 "$NODES"); do
  IDX=$((i - 1))
  NODE_ID="${ANVIL_ADDRS[$IDX]}"
  NODE_KEY="${ANVIL_KEYS[$IDX]}"
  RPC_PORT=$((BASE_RPC + IDX))
  P2P_PORT=$((BASE_P2P + IDX))
  IPFS_PORT=$((BASE_IPFS + IDX))
  WS_PORT=$((BASE_WS + IDX))
  WIRE_PORT=$((BASE_WIRE + IDX))
  # Data dir keeps the friendly "node-N" name for readability (logs, pidfiles).
  DATA_DIR="${RUN_DIR}/node-${i}"
  mkdir -p "$DATA_DIR"

  PEERS_JSON="[]"
  DHT_PEERS_JSON="[]"
  if [[ "$NODES" -gt 1 ]]; then
    PEERS=""
    DHT_PEERS=""
    for j in $(seq 1 "$NODES"); do
      if [[ "$j" == "$i" ]]; then
        continue
      fi
      JDX=$((j - 1))
      PP=$((BASE_P2P + JDX))
      WP=$((BASE_WIRE + JDX))
      PEER_ADDR="${ANVIL_ADDRS[$JDX]}"
      if [[ -n "$PEERS" ]]; then
        PEERS+=" ,"
        DHT_PEERS+=" ,"
      fi
      PEERS+="{\"id\":\"${PEER_ADDR}\",\"url\":\"http://127.0.0.1:${PP}\"}"
      DHT_PEERS+="{\"id\":\"${PEER_ADDR}\",\"address\":\"127.0.0.1\",\"port\":${WP}}"
    done
    PEERS_JSON="[${PEERS}]"
    DHT_PEERS_JSON="[${DHT_PEERS}]"
  fi

  VALIDATORS=""
  for j in $(seq 1 "$NODES"); do
    JDX=$((j - 1))
    if [[ -n "$VALIDATORS" ]]; then
      VALIDATORS+=","
    fi
    VALIDATORS+="\"${ANVIL_ADDRS[$JDX]}\""
  done

  cat > "${DATA_DIR}/node-config.json" <<JSON
{
  "dataDir": "${DATA_DIR}",
  "nodeId": "${NODE_ID}",
  "chainId": 18780,
  "rpcBind": "127.0.0.1",
  "rpcPort": ${RPC_PORT},
  "p2pBind": "127.0.0.1",
  "p2pPort": ${P2P_PORT},
  "wsBind": "127.0.0.1",
  "wsPort": ${WS_PORT},
  "ipfsBind": "127.0.0.1",
  "ipfsPort": ${IPFS_PORT},
  "wireBind": "127.0.0.1",
  "peers": ${PEERS_JSON},
  "validators": [${VALIDATORS}],
  "blockTimeMs": 3000,
  "syncIntervalMs": 5000,
  "finalityDepth": 3,
  "maxTxPerBlock": 50,
  "minGasPriceWei": "1",
  "poseEpochMs": 3600000,
  "enableBft": true,
  "bftPrepareTimeoutMs": 5000,
  "bftCommitTimeoutMs": 5000,
  "enableWireProtocol": true,
  "wirePort": ${WIRE_PORT},
  "enableDht": true,
  "dhtBootstrapPeers": ${DHT_PEERS_JSON},
  "enableSnapSync": true,
  "snapSyncThreshold": 100,
  "prefund": [
    {
      "address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      "balanceEth": "10000"
    }
  ]
}
JSON

  LOG_FILE="${RUN_DIR}/node-${i}.log"
  PID_FILE="${RUN_DIR}/node-${i}.pid"

  METRICS_PORT=$((BASE_METRICS + IDX))
  # Per-node env override: let callers target a specific node with an extra
  # env var (e.g. the adversarial-stateroot-divergence.sh script sets
  # COC_UNSAFE_ADVERSARIAL_SPEC_ROOT on a single node to validate the BFT
  # pair-quorum defense). Format: COC_NODE_${i}_ENV="FOO=bar BAZ=qux" — one
  # space-separated list of KEY=VAL pairs, or empty.
  PER_NODE_ENV_VAR="COC_NODE_${i}_ENV"
  PER_NODE_ENV="${!PER_NODE_ENV_VAR:-}"
  if [[ -n "$PER_NODE_ENV" ]]; then
    echo "  per-node env for node-${i}: ${PER_NODE_ENV}"
  fi
  env \
    COC_METRICS_PORT="${METRICS_PORT}" \
    COC_NODE_KEY="${NODE_KEY}" \
    COC_NODE_CONFIG="${DATA_DIR}/node-config.json" \
    ${PER_NODE_ENV} \
    node --experimental-strip-types "${ROOT}/node/src/index.ts" >"${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  echo "started node-${i} (${NODE_ID}): rpc=${RPC_PORT} p2p=${P2P_PORT} ws=${WS_PORT} wire=${WIRE_PORT} ipfs=${IPFS_PORT} metrics=${METRICS_PORT} pid=$(cat "${PID_FILE}")"
done

# Wait for all nodes to respond to RPC
MAX_WAIT=60
echo "waiting for nodes to become ready (max ${MAX_WAIT}s)..."
START_TS=$SECONDS
while true; do
  ALL_READY=true
  for i in $(seq 1 "$NODES"); do
    IDX=$((i - 1))
    PORT=$((BASE_RPC + IDX))
    PID_FILE="${RUN_DIR}/node-${i}.pid"
    # Check process is still alive
    if [[ -f "$PID_FILE" ]] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "ERROR: node-${i} (pid $(cat "$PID_FILE")) died during startup. See ${RUN_DIR}/node-${i}.log"
      "${ROOT}/scripts/stop-devnet.sh" "$NODES"
      exit 1
    fi
    RESP=$(curl -sf -X POST "http://127.0.0.1:${PORT}" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null || echo "")
    if [[ -z "$RESP" ]]; then
      ALL_READY=false
      break
    fi
  done
  if $ALL_READY; then
    echo "all ${NODES} nodes ready"
    break
  fi
  if (( SECONDS - START_TS > MAX_WAIT )); then
    echo "ERROR: timeout waiting for nodes after ${MAX_WAIT}s"
    "${ROOT}/scripts/stop-devnet.sh" "$NODES"
    exit 1
  fi
  sleep 1
done

# Deploy SoulRegistry contract to the first node.
# Skippable via COC_SKIP_SOUL_DEPLOY=1 — set by adversarial-stateroot-
# divergence.sh's Scenario B where the cluster is deliberately stalled
# and the deploy's tx would hang forever waiting for finalization.
if [[ "${COC_SKIP_SOUL_DEPLOY:-}" == "1" ]]; then
  echo "COC_SKIP_SOUL_DEPLOY=1 — skipping SoulRegistry deploy"
  echo "devnet started at ${RUN_DIR}"
  exit 0
fi
SOUL_RPC="http://127.0.0.1:${BASE_RPC}"
# Use the prefunded Hardhat account #0 as deployer
SOUL_PK="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
SOUL_ARTIFACT="${ROOT}/contracts/artifacts/contracts-src/governance/SoulRegistry.sol/SoulRegistry.json"
if [[ -f "$SOUL_ARTIFACT" ]]; then
  echo "deploying SoulRegistry to devnet via ${SOUL_RPC}..."
  COC_RPC_URL="${SOUL_RPC}" DEPLOYER_PRIVATE_KEY="${SOUL_PK}" \
    node --experimental-strip-types --input-type=module <<DEPLOY_EOF 2>&1 || echo "WARN: SoulRegistry deploy failed (non-fatal)"
import { deploySoulRegistry } from "${ROOT}/contracts/deploy/deploy-soul-registry.ts";
import { readFileSync } from "node:fs";
const artifact = JSON.parse(readFileSync("${SOUL_ARTIFACT}", "utf8"));
const r = await deploySoulRegistry("l2-coc", artifact.abi, artifact.bytecode);
console.log("SoulRegistry deployed at " + r.contractAddress + " (tx: " + r.transactionHash + ")");
DEPLOY_EOF
else
  echo "WARN: SoulRegistry artifact not found — run 'cd contracts && npm run compile' first"
fi

echo "devnet started at ${RUN_DIR}"
