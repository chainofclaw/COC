#!/usr/bin/env bash
# bootstrap-5-fullnode-deploy.sh — Generate per-host deploy bundles for 5 gcloud
# fullnodes joining an existing COC testnet. Run ONCE on operator workstation.
#
# These nodes start as OBSERVER fullnodes (no stake, no BFT votes) — they sync
# the existing chain, relay BFT prepare/commit messages, and participate in DHT
# + IPFS + erasure repair. Two of them (anchor-1, anchor-2) can later be
# promoted to BFT validators via scripts/anchor-stake-register.sh.
#
# The bootstrap renders a full /etc/coc/node-1.json for each host with the
# upstream validator set + peer list baked in, then writes deploy-vars-server-N.sh
# files that base64-encode the JSON so the per-host deploy script does not need
# its own template files.
#
# Inputs (CLI flags or env):
#   --chain-id 18780               existing testnet chainId (REQUIRED)
#   --upstream-validator A:H:P:W   one PER existing validator. format:
#                                   <addr>:<host_or_ip>:<p2p_port>:<wire_port>
#                                  Repeat for each existing validator.
#   --gcloud-host-1..5 HOST        public IP / DNS of each gcloud node (REQUIRED)
#   --gcloud-port-shift-N SHIFT    optional uniform port-shift for node N
#   --node-role-N ROLE             "anchor" | "burst" (default: 1,2=anchor, 3..5=burst)
#   --validator-registry-address ADDR   optional, enables ValidatorRegistry-driven
#                                       BFT (R1.2). Empty = legacy hardcoded set.
#   --validator-registry-from-block N   optional, from-block for event scan (0)
#   --validator-registry-poll-ms N      optional, poll interval (60000, min 5000)
#
# Output dir /tmp/coc-5-fullnode/:
#   keys.txt                        — 5 fresh observer keys (chmod 600, NEVER reuse anvil)
#   deploy-vars-server-N.sh         — per-host (sourceable). Embeds rendered JSON.
#   summary.txt                     — port bundles + roles + reachability hints
#
# Usage example:
#   ./bootstrap-5-fullnode-deploy.sh \
#     --chain-id 18780 \
#     --upstream-validator 0xf39Fd6...:209.74.64.88:29780:29781 \
#     --upstream-validator 0x709979...:159.198.44.136:29780:29781 \
#     --upstream-validator 0x3C44Cd...:199.192.16.79:49780:49781 \
#     --gcloud-host-1 anchor1.example.com \
#     --gcloud-host-2 anchor2.example.com \
#     --gcloud-host-3 burst1.example.com \
#     --gcloud-host-4 burst2.example.com \
#     --gcloud-host-5 burst3.example.com

set -euo pipefail

CHAIN_ID="${CHAIN_ID:-}"
declare -a UPSTREAM_VALIDATORS=()
declare -a GCLOUD_HOSTS=("" "" "" "" "")
declare -a GCLOUD_SHIFTS=(0 0 0 0 0)
declare -a GCLOUD_ROLES=("anchor" "anchor" "burst" "burst" "burst")

# R1.2: optional ValidatorRegistry hookup. When --validator-registry-address is
# set, render_env emits COC_VALIDATOR_REGISTRY_* env vars so the node loads its
# BFT validator set from the on-chain registry instead of the hardcoded
# upstream-validator list. Empty ADDRESS = registry disabled (legacy behavior).
VALIDATOR_REGISTRY_ADDRESS="${VALIDATOR_REGISTRY_ADDRESS:-}"
VALIDATOR_REGISTRY_FROM_BLOCK="${VALIDATOR_REGISTRY_FROM_BLOCK:-0}"
VALIDATOR_REGISTRY_POLL_MS="${VALIDATOR_REGISTRY_POLL_MS:-60000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chain-id) CHAIN_ID="$2"; shift 2 ;;
    --upstream-validator) UPSTREAM_VALIDATORS+=("$2"); shift 2 ;;
    --gcloud-host-1) GCLOUD_HOSTS[0]="$2"; shift 2 ;;
    --gcloud-host-2) GCLOUD_HOSTS[1]="$2"; shift 2 ;;
    --gcloud-host-3) GCLOUD_HOSTS[2]="$2"; shift 2 ;;
    --gcloud-host-4) GCLOUD_HOSTS[3]="$2"; shift 2 ;;
    --gcloud-host-5) GCLOUD_HOSTS[4]="$2"; shift 2 ;;
    --gcloud-port-shift-1) GCLOUD_SHIFTS[0]="$2"; shift 2 ;;
    --gcloud-port-shift-2) GCLOUD_SHIFTS[1]="$2"; shift 2 ;;
    --gcloud-port-shift-3) GCLOUD_SHIFTS[2]="$2"; shift 2 ;;
    --gcloud-port-shift-4) GCLOUD_SHIFTS[3]="$2"; shift 2 ;;
    --gcloud-port-shift-5) GCLOUD_SHIFTS[4]="$2"; shift 2 ;;
    --node-role-1) GCLOUD_ROLES[0]="$2"; shift 2 ;;
    --node-role-2) GCLOUD_ROLES[1]="$2"; shift 2 ;;
    --node-role-3) GCLOUD_ROLES[2]="$2"; shift 2 ;;
    --node-role-4) GCLOUD_ROLES[3]="$2"; shift 2 ;;
    --node-role-5) GCLOUD_ROLES[4]="$2"; shift 2 ;;
    --validator-registry-address) VALIDATOR_REGISTRY_ADDRESS="$2"; shift 2 ;;
    --validator-registry-from-block) VALIDATOR_REGISTRY_FROM_BLOCK="$2"; shift 2 ;;
    --validator-registry-poll-ms) VALIDATOR_REGISTRY_POLL_MS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Validate registry address shape if provided
if [[ -n "$VALIDATOR_REGISTRY_ADDRESS" ]]; then
  if ! [[ "$VALIDATOR_REGISTRY_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: --validator-registry-address must be 0x + 40 hex chars" >&2
    exit 2
  fi
  if ! [[ "$VALIDATOR_REGISTRY_FROM_BLOCK" =~ ^[0-9]+$ ]]; then
    echo "ERROR: --validator-registry-from-block must be a non-negative integer" >&2
    exit 2
  fi
  if ! [[ "$VALIDATOR_REGISTRY_POLL_MS" =~ ^[0-9]+$ ]] || (( VALIDATOR_REGISTRY_POLL_MS < 5000 )); then
    echo "ERROR: --validator-registry-poll-ms must be ≥ 5000" >&2
    exit 2
  fi
fi

if [[ -z "$CHAIN_ID" ]]; then
  echo "ERROR: --chain-id is required (existing testnet chainId, e.g. 18780)" >&2
  exit 2
fi
if [[ "${#UPSTREAM_VALIDATORS[@]}" -lt 1 ]]; then
  echo "ERROR: at least one --upstream-validator A:H:P2P:WIRE required" >&2
  exit 2
fi
for i in 0 1 2 3 4; do
  if [[ -z "${GCLOUD_HOSTS[$i]}" ]]; then
    echo "ERROR: --gcloud-host-$((i+1)) required" >&2
    exit 2
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node (>=18) required on operator workstation to derive observer addresses" >&2
  exit 2
fi
if ! command -v openssl >/dev/null 2>&1 || ! command -v base64 >/dev/null 2>&1; then
  echo "ERROR: openssl and base64 required" >&2
  exit 2
fi

OUT_DIR=/tmp/coc-5-fullnode
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

ports_for() {
  local s=$1
  echo "$((28780+s)) $((28781+s)) $((29780+s)) $((29781+s)) $((28786+s)) $((9101+s))"
}

declare -a RPC WS P2P WIRE IPFS METRICS
for i in 0 1 2 3 4; do
  read -r r w p wi ip me <<< "$(ports_for "${GCLOUD_SHIFTS[$i]}")"
  RPC[$i]=$r; WS[$i]=$w; P2P[$i]=$p; WIRE[$i]=$wi; IPFS[$i]=$ip; METRICS[$i]=$me
done

# Generate 5 fresh observer keys (NEVER reuse anvil keys for observers — those
# correspond to the existing validator set and would collide on identity).
declare -a KEY_ADDRS KEY_PRIVS
echo "# COC 5-fullnode gcloud testnet observer keys (generated $(date -Iseconds))" > "$OUT_DIR/keys.txt"
for i in 0 1 2 3 4; do
  K=$(openssl rand -hex 32)
  ADDR=$(node -e "
    const { Wallet } = require('ethers');
    console.log(new Wallet('0x' + process.argv[1]).address);
  " "$K")
  KEY_ADDRS[$i]="$ADDR"
  KEY_PRIVS[$i]="0x$K"
  echo "node_$((i+1))_role=${GCLOUD_ROLES[$i]}" >> "$OUT_DIR/keys.txt"
  echo "node_$((i+1))_addr=$ADDR" >> "$OUT_DIR/keys.txt"
  echo "node_$((i+1))_priv=0x$K" >> "$OUT_DIR/keys.txt"
done
chmod 600 "$OUT_DIR/keys.txt"

# Render the JSON config for one gcloud node (full mesh: 4 gcloud peers + N upstream)
render_config() {
  local self=$1  # 0-indexed
  local node_id="${KEY_ADDRS[$self]}"
  local public_host="${GCLOUD_HOSTS[$self]}"
  local rpc=${RPC[$self]} ws=${WS[$self]} p2p=${P2P[$self]} wire=${WIRE[$self]} ipfs=${IPFS[$self]}

  # Validators array = upstream existing validator addresses (lowercased). The
  # observer node will not be in this list, so it does not produce blocks; it
  # only verifies BFT messages signed by these addresses.
  local validators_json=""
  for entry in "${UPSTREAM_VALIDATORS[@]}"; do
    IFS=":" read -r addr _host _p2p _wire <<< "$entry"
    addr=$(echo "$addr" | tr '[:upper:]' '[:lower:]')
    validators_json+="    \"$addr\","$'\n'
  done
  validators_json="${validators_json%,$'\n'}"

  # Peers + dhtBootstrap: every upstream validator + every other gcloud node
  local peers_json=""
  local boot_json=""
  for entry in "${UPSTREAM_VALIDATORS[@]}"; do
    IFS=":" read -r addr host p2pp wirep <<< "$entry"
    addr=$(echo "$addr" | tr '[:upper:]' '[:lower:]')
    peers_json+="    { \"id\": \"$addr\", \"url\": \"http://$host:$p2pp\" },"$'\n'
    boot_json+="    { \"id\": \"$addr\", \"address\": \"$host\", \"port\": $wirep },"$'\n'
  done
  for j in 0 1 2 3 4; do
    [[ $j == "$self" ]] && continue
    peers_json+="    { \"id\": \"${KEY_ADDRS[$j]}\", \"url\": \"http://${GCLOUD_HOSTS[$j]}:${P2P[$j]}\" },"$'\n'
    boot_json+="    { \"id\": \"${KEY_ADDRS[$j]}\", \"address\": \"${GCLOUD_HOSTS[$j]}\", \"port\": ${WIRE[$j]} },"$'\n'
  done
  peers_json="${peers_json%,$'\n'}"
  boot_json="${boot_json%,$'\n'}"

  cat <<EOF
{
  "_role": "${GCLOUD_ROLES[$self]} fullnode joining chainId $CHAIN_ID — observer until stake-registered",
  "nodeId": "$node_id",
  "chainId": $CHAIN_ID,
  "rpcBind": "0.0.0.0", "rpcPort": $rpc,
  "p2pBind": "0.0.0.0", "p2pPort": $p2p,
  "wsBind": "0.0.0.0",  "wsPort": $ws,
  "ipfsBind": "0.0.0.0","ipfsPort": $ipfs,
  "wireBind": "0.0.0.0","wirePort": $wire,
  "advertisedP2pUrl": "http://$public_host:$p2p",
  "validators": [
$validators_json
  ],
  "peers": [
$peers_json
  ],
  "dhtBootstrapPeers": [
$boot_json
  ],
  "enableBft": true,
  "enableWireProtocol": true,
  "enableDht": true,
  "enableSnapSync": true,
  "enableAdminRpc": false,
  "blockTimeMs": 3000,
  "finalityDepth": 3,
  "maxTxPerBlock": 100,
  "p2pInboundAuthMode": "enforce",
  "poseInboundAuthMode": "enforce",
  "dhtRequireAuthenticatedVerify": true,
  "poseUseGovernanceChallengerAuth": true,
  "bftPrepareTimeoutMs": 1500,
  "bftCommitTimeoutMs": 1500
}
EOF
}

# Render env file for one gcloud node
render_env() {
  local self=$1
  cat <<EOF
COC_DATA_DIR=/var/lib/coc/node-1
COC_NODE_CONFIG=/etc/coc/node-1.json
COC_NODE_KEY=${KEY_PRIVS[$self]}
COC_RPC_BIND=0.0.0.0
COC_RPC_PORT=${RPC[$self]}
COC_WS_BIND=0.0.0.0
COC_WS_PORT=${WS[$self]}
COC_P2P_BIND=0.0.0.0
COC_P2P_PORT=${P2P[$self]}
COC_WIRE_BIND=0.0.0.0
COC_WIRE_PORT=${WIRE[$self]}
COC_IPFS_BIND=0.0.0.0
COC_IPFS_PORT=${IPFS[$self]}
COC_METRICS_PORT=${METRICS[$self]}
COC_DEV_RELAXED_QUORUM=0
COC_BFT_AUTO_RECOVERY=1
COC_NODE_MODE=archive
EOF
  if [[ -n "$VALIDATOR_REGISTRY_ADDRESS" ]]; then
    cat <<EOF
COC_VALIDATOR_REGISTRY_ADDRESS=$VALIDATOR_REGISTRY_ADDRESS
COC_VALIDATOR_REGISTRY_FROM_BLOCK=$VALIDATOR_REGISTRY_FROM_BLOCK
COC_VALIDATOR_REGISTRY_POLL_INTERVAL_MS=$VALIDATOR_REGISTRY_POLL_MS
EOF
  fi
}

write_deploy_vars() {
  local self=$1
  local idx=$((self+1))
  local out="$OUT_DIR/deploy-vars-server-$idx.sh"

  local cfg env_b64 cfg_b64
  cfg=$(render_config "$self")
  env_b64=$(render_env "$self" | base64 -w 0)
  cfg_b64=$(printf "%s" "$cfg" | base64 -w 0)

  # Phase X1.6 follow-up: case-insensitive proposer check in chain-engine-persistent.ts
  # is required for fullnodes to verify mixed-case block.proposer fields against
  # a lowercased validators[] config. Until this lands upstream, ship the patched
  # file directly in the deploy bundle and overwrite the git-clone version.
  local repo_root patch_file patch_b64=""
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  patch_file="$repo_root/node/src/chain-engine-persistent.ts"
  if [[ -f "$patch_file" ]] && grep -q "Phase X1.6 (2026-05-08): case-insensitive" "$patch_file"; then
    patch_b64=$(base64 -w 0 "$patch_file")
  fi

  cat > "$out" <<EOF
# Source me on gcloud-node-$idx (${GCLOUD_ROLES[$self]} role), then run
# bash /opt/coc/scripts/deploy-fullnode.sh
#
# All connection info, including base64-encoded /etc/coc/node-1.json and
# /etc/coc/node-1.env, is embedded here. The deploy script only decodes,
# installs prereqs, and starts systemd.

export NODE_ROLE="${GCLOUD_ROLES[$self]}"
export NODE_INDEX="$idx"
export PUBLIC_HOST="${GCLOUD_HOSTS[$self]}"
export NODE_ADDR="${KEY_ADDRS[$self]}"
export SELF_RPC_PORT=${RPC[$self]}
export SELF_WS_PORT=${WS[$self]}
export SELF_P2P_PORT=${P2P[$self]}
export SELF_WIRE_PORT=${WIRE[$self]}
export SELF_IPFS_PORT=${IPFS[$self]}
export SELF_METRICS_PORT=${METRICS[$self]}

# Embedded pre-rendered files (base64). Decoded by deploy-fullnode.sh.
export COC_FULLNODE_ENV_B64="$env_b64"
export COC_FULLNODE_CONFIG_B64="$cfg_b64"

# Optional patch: chain-engine-persistent.ts with case-insensitive proposer check.
# Empty if local repo doesn't carry the Phase X1.6 follow-up patch.
export COC_PATCH_CHAIN_ENGINE_PERSISTENT_B64="$patch_b64"
EOF
  chmod 600 "$out"
}

for i in 0 1 2 3 4; do
  write_deploy_vars "$i"
done

# Summary
{
  echo "# COC 5-fullnode bootstrap summary"
  echo "Generated:        $(date -Iseconds)"
  echo "ChainId:          $CHAIN_ID"
  echo "Upstream validators (existing testnet):"
  for entry in "${UPSTREAM_VALIDATORS[@]}"; do
    IFS=":" read -r addr host p2pp wirep <<< "$entry"
    echo "  - $addr  $host  p2p=$p2pp  wire=$wirep"
  done
  echo ""
  echo "GCloud fullnodes:"
  for i in 0 1 2 3 4; do
    echo "  $((i+1)). [${GCLOUD_ROLES[$i]}] ${GCLOUD_HOSTS[$i]}  addr=${KEY_ADDRS[$i]}  RPC=${RPC[$i]}  P2P=${P2P[$i]}  Wire=${WIRE[$i]}  IPFS=${IPFS[$i]}"
  done
  echo ""
  echo "Anchor nodes (eligible for stake-register to join BFT):"
  for i in 0 1 2 3 4; do
    if [[ "${GCLOUD_ROLES[$i]}" == "anchor" ]]; then
      echo "  - ${GCLOUD_HOSTS[$i]}  addr=${KEY_ADDRS[$i]}"
    fi
  done
} > "$OUT_DIR/summary.txt"

cat "$OUT_DIR/summary.txt"
echo ""
echo "==> Artifacts in $OUT_DIR (chmod 700, contains private keys):"
ls -la "$OUT_DIR"
echo ""
echo "==> Next steps:"
echo "  1. scp /tmp/coc-5-fullnode/deploy-vars-server-N.sh root@host-N:/root/"
echo "  2. On EACH gcloud VM:"
echo "     source /root/deploy-vars-server-N.sh && bash /opt/coc/scripts/deploy-fullnode.sh"
echo "  3. Wait ~5 min for snap-sync to catch up to upstream chain head."
echo "  4. To promote anchor-1/anchor-2 to BFT validators:"
echo "     bash scripts/anchor-stake-register.sh --anchor-key 0x... --upstream-rpc http://...:28780"
