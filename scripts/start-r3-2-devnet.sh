#!/usr/bin/env bash
# start-r3-2-devnet.sh — Local 5-node 88780 dry-run using the keys generated
# at ~/.coc/keys/88780-prod-candidate/. All 5 nodes bind to 127.0.0.1 with
# port-shifted ranges (same layout as scripts/start-devnet.sh 5).
#
# Purpose: smoke-test that the 88780 genesis + per-host config template
# produce a working 5-validator BFT cluster BEFORE shipping to gcloud.
# Limitation: localhost-shared-IP triggers the peer-scoring 429 ban observed
# in the 2026-05-10 18780 dry run (see docs/n5-fault-tolerance-fix-2026-05-10.md).
# Look for "BFT round started" / "BFT round finalized" in node-1.log to
# confirm the basic chain bring-up; cross-IP gcloud testing is the real gate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYS_DIR="${HOME}/.coc/keys/88780-prod-candidate"
RUN_DIR="${ROOT}/.run/r3-2-devnet-5"
NODES=5

if [[ ! -d "$KEYS_DIR" ]]; then
  echo "missing keys dir: ${KEYS_DIR}" >&2
  echo "run: bash scripts/generate-validator-keys.sh 5 ${KEYS_DIR}" >&2
  exit 1
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

# Same port layout as start-devnet.sh (10-apart ranges so up to 10 nodes
# never collide).
BASE_RPC=28780
BASE_WS=28790
BASE_IPFS=28800
BASE_P2P=29780
BASE_WIRE=29790
BASE_METRICS=28810

# Read the 5 generated validator addresses (lowercase, in genesis order)
mapfile -t VALIDATORS < <(node -e "
const ids = JSON.parse(require('fs').readFileSync('${ROOT}/configs/r3-2-candidate/validators.json','utf8'));
for (const id of ids) console.log(id);
")
if [[ "${#VALIDATORS[@]}" -ne 5 ]]; then
  echo "expected 5 validators, got ${#VALIDATORS[@]}" >&2
  exit 1
fi

# Pre-check ports
check_port() {
  if ss -ltn "sport = :${1}" 2>/dev/null | grep -q LISTEN; then
    echo "ERROR: port ${1} already in use"
    exit 1
  fi
}
for i in 0 1 2 3 4; do
  check_port $((BASE_RPC + i))
  check_port $((BASE_WS + i))
  check_port $((BASE_IPFS + i))
  check_port $((BASE_P2P + i))
  check_port $((BASE_WIRE + i))
  check_port $((BASE_METRICS + i))
done

for i in 1 2 3 4 5; do
  IDX=$((i - 1))
  NODE_ID="${VALIDATORS[$IDX]}"
  KEY=$(grep "^COC_NODE_KEY=" "${KEYS_DIR}/validator-${i}.env" | cut -d= -f2)

  RPC_PORT=$((BASE_RPC + IDX))
  P2P_PORT=$((BASE_P2P + IDX))
  IPFS_PORT=$((BASE_IPFS + IDX))
  WS_PORT=$((BASE_WS + IDX))
  WIRE_PORT=$((BASE_WIRE + IDX))
  METRICS_PORT=$((BASE_METRICS + IDX))
  DATA_DIR="${RUN_DIR}/node-${i}"
  mkdir -p "$DATA_DIR"

  # Build peers (everyone except self) using localhost + offset ports
  PEERS=""
  DHT_PEERS=""
  for j in 1 2 3 4 5; do
    [[ "$j" == "$i" ]] && continue
    JDX=$((j - 1))
    PP=$((BASE_P2P + JDX))
    WP=$((BASE_WIRE + JDX))
    PEER_ADDR="${VALIDATORS[$JDX]}"
    [[ -n "$PEERS" ]] && PEERS+=","
    [[ -n "$DHT_PEERS" ]] && DHT_PEERS+=","
    PEERS+="{\"id\":\"${PEER_ADDR}\",\"url\":\"http://127.0.0.1:${PP}\"}"
    DHT_PEERS+="{\"id\":\"${PEER_ADDR}\",\"address\":\"127.0.0.1\",\"port\":${WP}}"
  done

  # Build validators array
  VLIST=""
  VSTAKES=""
  for k in 0 1 2 3 4; do
    [[ -n "$VLIST" ]] && VLIST+=","
    [[ -n "$VSTAKES" ]] && VSTAKES+=","
    VLIST+="\"${VALIDATORS[$k]}\""
    VSTAKES+="{\"id\":\"${VALIDATORS[$k]}\",\"address\":\"${VALIDATORS[$k]}\",\"stake\":\"32000000000000000000\"}"
  done

  cat > "${DATA_DIR}/node-config.json" <<JSON
{
  "dataDir": "${DATA_DIR}",
  "nodeId": "${NODE_ID}",
  "chainId": 88780,
  "rpcBind": "127.0.0.1",
  "rpcPort": ${RPC_PORT},
  "p2pBind": "127.0.0.1",
  "p2pPort": ${P2P_PORT},
  "wsBind": "127.0.0.1",
  "wsPort": ${WS_PORT},
  "ipfsBind": "127.0.0.1",
  "ipfsPort": ${IPFS_PORT},
  "wireBind": "127.0.0.1",
  "wirePort": ${WIRE_PORT},
  "peers": [${PEERS}],
  "dhtBootstrapPeers": [${DHT_PEERS}],
  "validators": [${VLIST}],
  "validatorStakes": [${VSTAKES}],
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
  "enableDht": true,
  "enableSnapSync": true,
  "snapSyncThreshold": 100,
  "prefund": [
    { "address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "balanceEth": "10000000" },
    { "address": "${VALIDATORS[0]}", "balanceEth": "100" },
    { "address": "${VALIDATORS[1]}", "balanceEth": "100" },
    { "address": "${VALIDATORS[2]}", "balanceEth": "100" },
    { "address": "${VALIDATORS[3]}", "balanceEth": "100" },
    { "address": "${VALIDATORS[4]}", "balanceEth": "100" }
  ]
}
JSON

  LOG_FILE="${RUN_DIR}/node-${i}.log"
  PID_FILE="${RUN_DIR}/node-${i}.pid"

  env \
    COC_METRICS_PORT="${METRICS_PORT}" \
    COC_NODE_KEY="${KEY}" \
    COC_NODE_CONFIG="${DATA_DIR}/node-config.json" \
    node --experimental-strip-types "${ROOT}/node/src/index.ts" >"${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  echo "started validator-${i} (${NODE_ID:0:10}…): rpc=${RPC_PORT} p2p=${P2P_PORT} wire=${WIRE_PORT} pid=$(cat "${PID_FILE}")"
done

# Wait for RPC readiness
echo "waiting for nodes to become ready (max 60s)..."
START_TS=$SECONDS
while true; do
  ALL_READY=true
  for i in 1 2 3 4 5; do
    IDX=$((i - 1))
    PORT=$((BASE_RPC + IDX))
    PID="${RUN_DIR}/node-${i}.pid"
    if [[ -f "$PID" ]] && ! kill -0 "$(cat "$PID")" 2>/dev/null; then
      echo "ERROR: validator-${i} (pid $(cat "$PID")) died during startup. See ${RUN_DIR}/node-${i}.log"
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
    echo "all 5 nodes ready (took $((SECONDS - START_TS))s)"
    break
  fi
  if (( SECONDS - START_TS > 60 )); then
    echo "timeout waiting for nodes" >&2
    exit 1
  fi
  sleep 1
done

echo
echo "88780 dry-run cluster up at ${RUN_DIR}"
echo "  validator-1 RPC: http://127.0.0.1:28780"
echo "  validator-N RPC: http://127.0.0.1:2878${0..4}  (28780..28784)"
echo "  logs: ${RUN_DIR}/node-{1..5}.log"
echo "stop with: for f in ${RUN_DIR}/*.pid; do kill \"\$(cat \$f)\" 2>/dev/null; done; rm -f ${RUN_DIR}/*.pid"
