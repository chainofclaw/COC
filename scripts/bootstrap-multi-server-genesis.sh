#!/usr/bin/env bash
# bootstrap-multi-server-genesis.sh — Generate canonical genesis + 3 validator
# keys for a fresh multi-server testnet. Run ONCE on the operator workstation.
#
# Each server can have its own port shift (useful when a host already runs
# another COC instance). Default port bundle: 28780/RPC, 28781/WS, 29780/P2P,
# 29781/Wire, 28786/IPFS, 9101/metrics. Shift adds the same delta to all.
#
# Outputs in /tmp/coc-multi-server/:
#   keys.txt              — 3 private keys + addresses (chmod 600)
#   genesis.json          — chain genesis (identical for all 3 servers)
#   deploy-vars-server-N.sh — one per server, sourceable
#
# Usage:
#   ./bootstrap-multi-server-genesis.sh \
#     --validator-1-host server-a.example.com \
#     --validator-2-host server-b.example.com \
#     --validator-3-host server-c.example.com \
#     [--validator-3-port-shift 10000] \
#     [--chain-id 18780] [--reuse-anvil-keys]
#
# After this runs, scp the per-server deploy-vars then run deploy-validator-server.sh.

set -euo pipefail

CHAIN_ID="${CHAIN_ID:-18780}"
HOST_1=""; HOST_2=""; HOST_3=""
SHIFT_1=0; SHIFT_2=0; SHIFT_3=0
REUSE_ANVIL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --validator-1-host) HOST_1="$2"; shift 2 ;;
    --validator-2-host) HOST_2="$2"; shift 2 ;;
    --validator-3-host) HOST_3="$2"; shift 2 ;;
    --validator-1-port-shift) SHIFT_1="$2"; shift 2 ;;
    --validator-2-port-shift) SHIFT_2="$2"; shift 2 ;;
    --validator-3-port-shift) SHIFT_3="$2"; shift 2 ;;
    --chain-id) CHAIN_ID="$2"; shift 2 ;;
    --reuse-anvil-keys) REUSE_ANVIL=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$HOST_1" || -z "$HOST_2" || -z "$HOST_3" ]]; then
  echo "ERROR: must supply --validator-1-host, --validator-2-host, --validator-3-host" >&2
  exit 2
fi

# Compute per-validator port bundle from base 28780 + shift
ports_for() {
  local shift=$1
  echo "$((28780+shift)) $((28781+shift)) $((29780+shift)) $((29781+shift)) $((28786+shift)) $((9101+shift))"
}
read -r RPC_1 WS_1 P2P_1 WIRE_1 IPFS_1 METRICS_1 <<< "$(ports_for $SHIFT_1)"
read -r RPC_2 WS_2 P2P_2 WIRE_2 IPFS_2 METRICS_2 <<< "$(ports_for $SHIFT_2)"
read -r RPC_3 WS_3 P2P_3 WIRE_3 IPFS_3 METRICS_3 <<< "$(ports_for $SHIFT_3)"

OUT_DIR=/tmp/coc-multi-server
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

if [[ "$REUSE_ANVIL" == "1" ]]; then
  cat > "$OUT_DIR/keys.txt" <<'EOF'
# COC multi-server testnet validator keys (anvil idx 0,1,2)
# WARNING: insecure for any production use
key_1_addr=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
key_1_priv=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
key_2_addr=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
key_2_priv=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
key_3_addr=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
key_3_priv=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
EOF
else
  # Generate 3 fresh secp256k1 keys via openssl + node ethers
  echo "# COC multi-server testnet validator keys (freshly generated $(date -Iseconds))" > "$OUT_DIR/keys.txt"
  for i in 1 2 3; do
    KEY=$(openssl rand -hex 32)
    ADDR=$(node -e "
      const { Wallet } = require('ethers');
      console.log(new Wallet('0x' + process.argv[1]).address);
    " "$KEY")
    echo "key_${i}_addr=$ADDR" >> "$OUT_DIR/keys.txt"
    echo "key_${i}_priv=0x$KEY" >> "$OUT_DIR/keys.txt"
  done
fi
chmod 600 "$OUT_DIR/keys.txt"
. "$OUT_DIR/keys.txt"

# Genesis config — identical bytes, deployed to all 3 servers
cat > "$OUT_DIR/genesis.json" <<EOF
{
  "chainId": $CHAIN_ID,
  "validators": [
    "$key_1_addr",
    "$key_2_addr",
    "$key_3_addr"
  ],
  "prefund": [
    { "address": "$key_1_addr", "balanceEth": "10000" },
    { "address": "$key_2_addr", "balanceEth": "10000" },
    { "address": "$key_3_addr", "balanceEth": "10000" }
  ]
}
EOF

# Per-server deploy vars — source on the server before running deploy-validator-server.sh
write_deploy_vars() {
  local idx=$1
  local self_host=$2
  local self_addr=$3
  local self_key=$4
  local self_rpc=$5 self_ws=$6 self_p2p=$7 self_wire=$8 self_ipfs=$9 self_metrics=${10}
  local peer_a_id=${11} peer_a_host=${12} peer_a_p2p=${13} peer_a_wire=${14}
  local peer_b_id=${15} peer_b_host=${16} peer_b_p2p=${17} peer_b_wire=${18}
  cat > "$OUT_DIR/deploy-vars-server-$idx.sh" <<EOF
# Source me on server-$idx, then run deploy-validator-server.sh
export INSTANCE_ID=1
export CHAIN_ID=$CHAIN_ID
export PUBLIC_HOST="$self_host"
export NODE_ID="$self_addr"
export NODE_KEY="$self_key"

# Self port bundle
export SELF_RPC_PORT=$self_rpc
export SELF_WS_PORT=$self_ws
export SELF_P2P_PORT=$self_p2p
export SELF_WIRE_PORT=$self_wire
export SELF_IPFS_PORT=$self_ipfs
export SELF_METRICS_PORT=$self_metrics

# Peer 1
export PEER_1_ID="$peer_a_id"
export PEER_1_HOST="$peer_a_host"
export PEER_1_P2P_PORT=$peer_a_p2p
export PEER_1_WIRE_PORT=$peer_a_wire

# Peer 2
export PEER_2_ID="$peer_b_id"
export PEER_2_HOST="$peer_b_host"
export PEER_2_P2P_PORT=$peer_b_p2p
export PEER_2_WIRE_PORT=$peer_b_wire

# Canonical validator set
export VALIDATOR_1_ADDR="$key_1_addr"
export VALIDATOR_2_ADDR="$key_2_addr"
export VALIDATOR_3_ADDR="$key_3_addr"
EOF
  chmod 600 "$OUT_DIR/deploy-vars-server-$idx.sh"
}

write_deploy_vars 1 "$HOST_1" "$key_1_addr" "$key_1_priv" \
  "$RPC_1" "$WS_1" "$P2P_1" "$WIRE_1" "$IPFS_1" "$METRICS_1" \
  "$key_2_addr" "$HOST_2" "$P2P_2" "$WIRE_2" \
  "$key_3_addr" "$HOST_3" "$P2P_3" "$WIRE_3"
write_deploy_vars 2 "$HOST_2" "$key_2_addr" "$key_2_priv" \
  "$RPC_2" "$WS_2" "$P2P_2" "$WIRE_2" "$IPFS_2" "$METRICS_2" \
  "$key_1_addr" "$HOST_1" "$P2P_1" "$WIRE_1" \
  "$key_3_addr" "$HOST_3" "$P2P_3" "$WIRE_3"
write_deploy_vars 3 "$HOST_3" "$key_3_addr" "$key_3_priv" \
  "$RPC_3" "$WS_3" "$P2P_3" "$WIRE_3" "$IPFS_3" "$METRICS_3" \
  "$key_1_addr" "$HOST_1" "$P2P_1" "$WIRE_1" \
  "$key_2_addr" "$HOST_2" "$P2P_2" "$WIRE_2"

cat <<EOF

==> Generated artifacts in $OUT_DIR:
$(ls -la "$OUT_DIR")

==> Port bundles:
  server-1 ($HOST_1, shift=$SHIFT_1): RPC=$RPC_1 WS=$WS_1 P2P=$P2P_1 Wire=$WIRE_1 IPFS=$IPFS_1
  server-2 ($HOST_2, shift=$SHIFT_2): RPC=$RPC_2 WS=$WS_2 P2P=$P2P_2 Wire=$WIRE_2 IPFS=$IPFS_2
  server-3 ($HOST_3, shift=$SHIFT_3): RPC=$RPC_3 WS=$WS_3 P2P=$P2P_3 Wire=$WIRE_3 IPFS=$IPFS_3

==> Next steps:
  1. scp deploy-vars-server-N.sh to each server
  2. On EACH server: source /root/deploy-vars-server-N.sh && bash /opt/coc/scripts/deploy-validator-server.sh
  3. After all 3 are up: SERVER_A=... SERVER_B=... SERVER_C=... bash scripts/verify-multi-server-ipfs.sh

==> SECURITY: keys.txt + deploy-vars-server-*.sh contain validator private keys.
    Treat $OUT_DIR as secret. chmod 700, deletable after deployment.
EOF
