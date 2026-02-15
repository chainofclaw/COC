#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES="${1:-3}"
if [[ "$NODES" != "3" && "$NODES" != "5" && "$NODES" != "7" ]]; then
  echo "usage: $0 <3|5|7>"
  exit 1
fi

BASE_RPC=28780
BASE_P2P=29780
BASE_IPFS=5001
BASE_WS=18781
RUN_DIR="${ROOT}/.run/devnet-${NODES}"
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

for i in $(seq 1 "$NODES"); do
  IDX=$((i - 1))
  NODE_ID="node-${i}"
  RPC_PORT=$((BASE_RPC + IDX))
  P2P_PORT=$((BASE_P2P + IDX))
  IPFS_PORT=$((BASE_IPFS + IDX))
  WS_PORT=$((BASE_WS + IDX))
  DATA_DIR="${RUN_DIR}/${NODE_ID}"
  mkdir -p "$DATA_DIR"

  PEERS_JSON="[]"
  if [[ "$NODES" -gt 1 ]]; then
    PEERS=""
    for j in $(seq 1 "$NODES"); do
      if [[ "$j" == "$i" ]]; then
        continue
      fi
      JDX=$((j - 1))
      PP=$((BASE_P2P + JDX))
      if [[ -n "$PEERS" ]]; then
        PEERS+=" ,"
      fi
      PEERS+="{\"id\":\"node-${j}\",\"url\":\"http://127.0.0.1:${PP}\"}"
    done
    PEERS_JSON="[${PEERS}]"
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
  "ipfsPort": ${IPFS_PORT},
  "wsPort": ${WS_PORT},
  "peers": ${PEERS_JSON},
  "validators": [${VALIDATORS}],
  "blockTimeMs": 3000,
  "syncIntervalMs": 5000,
  "finalityDepth": 3,
  "maxTxPerBlock": 50,
  "minGasPriceWei": "1",
  "poseEpochMs": 3600000,
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

  COC_NODE_CONFIG="${DATA_DIR}/node-config.json" node --experimental-strip-types "${ROOT}/node/src/index.ts" >"${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  echo "started ${NODE_ID}: rpc=${RPC_PORT} p2p=${P2P_PORT} ws=${WS_PORT} ipfs=${IPFS_PORT} pid=$(cat "${PID_FILE}")"
done

echo "devnet started at ${RUN_DIR}"
