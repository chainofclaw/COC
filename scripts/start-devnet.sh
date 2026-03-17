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
  NODE_ID="node-${i}"
  RPC_PORT=$((BASE_RPC + IDX))
  P2P_PORT=$((BASE_P2P + IDX))
  IPFS_PORT=$((BASE_IPFS + IDX))
  WS_PORT=$((BASE_WS + IDX))
  WIRE_PORT=$((BASE_WIRE + IDX))
  DATA_DIR="${RUN_DIR}/${NODE_ID}"
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
      if [[ -n "$PEERS" ]]; then
        PEERS+=" ,"
        DHT_PEERS+=" ,"
      fi
      PEERS+="{\"id\":\"node-${j}\",\"url\":\"http://127.0.0.1:${PP}\"}"
      DHT_PEERS+="{\"id\":\"node-${j}\",\"address\":\"127.0.0.1\",\"port\":${WP}}"
    done
    PEERS_JSON="[${PEERS}]"
    DHT_PEERS_JSON="[${DHT_PEERS}]"
  fi

  VALIDATORS=""
  for j in $(seq 1 "$NODES"); do
    if [[ -n "$VALIDATORS" ]]; then
      VALIDATORS+=","
    fi
    VALIDATORS+="\"node-${j}\""
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

  LOG_FILE="${RUN_DIR}/${NODE_ID}.log"
  PID_FILE="${RUN_DIR}/${NODE_ID}.pid"

  METRICS_PORT=$((BASE_METRICS + IDX))
  COC_METRICS_PORT=${METRICS_PORT} COC_NODE_CONFIG="${DATA_DIR}/node-config.json" node --experimental-strip-types "${ROOT}/node/src/index.ts" >"${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  echo "started ${NODE_ID}: rpc=${RPC_PORT} p2p=${P2P_PORT} ws=${WS_PORT} wire=${WIRE_PORT} ipfs=${IPFS_PORT} metrics=${METRICS_PORT} pid=$(cat "${PID_FILE}")"
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

echo "devnet started at ${RUN_DIR}"
