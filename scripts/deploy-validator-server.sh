#!/usr/bin/env bash
# deploy-validator-server.sh — One-shot deployment of a single COC validator
# on a fresh Ubuntu 22.04+ server. Idempotent — safe to re-run.
#
# Inputs (env vars, source from deploy-vars-server-N.sh):
#   INSTANCE_ID, CHAIN_ID, PUBLIC_HOST, NODE_ID, NODE_KEY
#   SELF_RPC_PORT, SELF_WS_PORT, SELF_P2P_PORT, SELF_WIRE_PORT, SELF_IPFS_PORT, SELF_METRICS_PORT
#   PEER_1_ID, PEER_1_HOST, PEER_1_P2P_PORT, PEER_1_WIRE_PORT
#   PEER_2_ID, PEER_2_HOST, PEER_2_P2P_PORT, PEER_2_WIRE_PORT
#   VALIDATOR_1_ADDR, VALIDATOR_2_ADDR, VALIDATOR_3_ADDR
#
# Optional:
#   COC_REPO_URL      — git URL (default: https://github.com/chainofclaw/COC.git)
#   COC_REPO_REF      — branch/tag (default: main)
#   COC_INSTALL_DIR   — install path (default: /opt/coc)
#
# Run as root.

set -euo pipefail

required=(INSTANCE_ID CHAIN_ID PUBLIC_HOST NODE_ID NODE_KEY
  SELF_RPC_PORT SELF_WS_PORT SELF_P2P_PORT SELF_WIRE_PORT SELF_IPFS_PORT SELF_METRICS_PORT
  PEER_1_ID PEER_1_HOST PEER_1_P2P_PORT PEER_1_WIRE_PORT
  PEER_2_ID PEER_2_HOST PEER_2_P2P_PORT PEER_2_WIRE_PORT
  VALIDATOR_1_ADDR VALIDATOR_2_ADDR VALIDATOR_3_ADDR)
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: env var $v missing" >&2
    exit 2
  fi
done

REPO_URL="${COC_REPO_URL:-https://github.com/chainofclaw/COC.git}"
REPO_REF="${COC_REPO_REF:-main}"
INSTALL_DIR="${COC_INSTALL_DIR:-/opt/coc}"

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2; exit 2
fi

echo "==> [1/9] System packages"
apt-get update -qq
# Phase Q.4: build-essential + python3 are needed by @ronomon/reed-solomon
# (native addon — Reed-Solomon erasure coding library). Without these the
# `npm install` step below fails with node-gyp errors. ~200 MB extra disk.
apt-get install -y -qq curl git ufw chrony ca-certificates build-essential python3 >/dev/null
systemctl enable --now chrony >/dev/null

echo "==> [2/9] Node.js 22"
if ! command -v node >/dev/null || ! node --version | grep -qE "^v(2[2-9]|[3-9][0-9])"; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node version: $(node --version)"

echo "==> [3/9] coc:coc system user"
if ! id coc >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/coc --shell /usr/sbin/nologin coc
fi

echo "==> [4/9] Repo at $INSTALL_DIR"
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
else
  cd "$INSTALL_DIR" && git fetch --depth 1 origin "$REPO_REF" && git reset --hard "origin/$REPO_REF"
fi

echo "==> [5/9] npm install (root workspace, no lockfile in repo)"
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
chown -R coc:coc "$INSTALL_DIR"

echo "==> [6/9] /etc/coc and /var/lib/coc"
mkdir -p /etc/coc /var/lib/coc/node-${INSTANCE_ID} /var/log/coc
chown coc:coc /var/lib/coc/node-${INSTANCE_ID} /var/log/coc

# Render env file
sed \
  -e "s|__INSTANCE__|${INSTANCE_ID}|g" \
  -e "s|__NODE_KEY__|${NODE_KEY}|g" \
  -e "s|__RPC_PORT__|${SELF_RPC_PORT}|g" \
  -e "s|__WS_PORT__|${SELF_WS_PORT}|g" \
  -e "s|__P2P_PORT__|${SELF_P2P_PORT}|g" \
  -e "s|__WIRE_PORT__|${SELF_WIRE_PORT}|g" \
  -e "s|__IPFS_PORT__|${SELF_IPFS_PORT}|g" \
  -e "s|__METRICS_PORT__|${SELF_METRICS_PORT}|g" \
  "$INSTALL_DIR/docker/systemd/native-env/node-multiserver.env.template" \
  > /etc/coc/node-${INSTANCE_ID}.env
chmod 640 /etc/coc/node-${INSTANCE_ID}.env
chown root:coc /etc/coc/node-${INSTANCE_ID}.env

# Render config file
sed \
  -e "s|__NODE_ID__|${NODE_ID}|g" \
  -e "s|__PUBLIC_HOST__|${PUBLIC_HOST}|g" \
  -e "s|__SELF_RPC_PORT__|${SELF_RPC_PORT}|g" \
  -e "s|__SELF_WS_PORT__|${SELF_WS_PORT}|g" \
  -e "s|__SELF_P2P_PORT__|${SELF_P2P_PORT}|g" \
  -e "s|__SELF_WIRE_PORT__|${SELF_WIRE_PORT}|g" \
  -e "s|__SELF_IPFS_PORT__|${SELF_IPFS_PORT}|g" \
  -e "s|__PEER_1_ID__|${PEER_1_ID}|g" \
  -e "s|__PEER_1_HOST__|${PEER_1_HOST}|g" \
  -e "s|__PEER_1_P2P_PORT__|${PEER_1_P2P_PORT}|g" \
  -e "s|__PEER_1_WIRE_PORT__|${PEER_1_WIRE_PORT}|g" \
  -e "s|__PEER_2_ID__|${PEER_2_ID}|g" \
  -e "s|__PEER_2_HOST__|${PEER_2_HOST}|g" \
  -e "s|__PEER_2_P2P_PORT__|${PEER_2_P2P_PORT}|g" \
  -e "s|__PEER_2_WIRE_PORT__|${PEER_2_WIRE_PORT}|g" \
  -e "s|__VALIDATOR_1_ADDR__|${VALIDATOR_1_ADDR}|g" \
  -e "s|__VALIDATOR_2_ADDR__|${VALIDATOR_2_ADDR}|g" \
  -e "s|__VALIDATOR_3_ADDR__|${VALIDATOR_3_ADDR}|g" \
  "$INSTALL_DIR/docker/systemd/native-configs/node-multiserver.json.template" \
  > /etc/coc/node-${INSTANCE_ID}.json
chmod 644 /etc/coc/node-${INSTANCE_ID}.json

echo "==> [7/9] Firewall (open ports: 22, $SELF_RPC_PORT, $SELF_WS_PORT, $SELF_P2P_PORT, $SELF_WIRE_PORT, $SELF_IPFS_PORT)"
ufw --force enable >/dev/null
for port in 22 $SELF_RPC_PORT $SELF_WS_PORT $SELF_P2P_PORT $SELF_WIRE_PORT $SELF_IPFS_PORT; do
  ufw allow "$port/tcp" >/dev/null
done

echo "==> [8/9] systemd unit"
cp "$INSTALL_DIR/docker/systemd/coc-node@.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable coc-node@${INSTANCE_ID} >/dev/null
systemctl restart coc-node@${INSTANCE_ID}

echo "==> [9/9] Health check (waiting 30s)"
sleep 30
if systemctl is-active --quiet coc-node@${INSTANCE_ID}; then
  echo "service active"
else
  echo "ERROR: coc-node@${INSTANCE_ID} not active"
  systemctl status coc-node@${INSTANCE_ID} --no-pager | tail -20
  exit 3
fi

if ! curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' \
     --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
     "http://localhost:${SELF_RPC_PORT}" | grep -q '"result"'; then
  echo "ERROR: local RPC not responding on port $SELF_RPC_PORT"
  tail -20 /var/log/coc/node-${INSTANCE_ID}.log
  exit 4
fi
echo "local RPC OK on port $SELF_RPC_PORT"

echo "==> Peer reachability check:"
for peer in "${PEER_1_HOST}:${PEER_1_P2P_PORT}" "${PEER_2_HOST}:${PEER_2_P2P_PORT}"; do
  host=${peer%:*}; port=${peer#*:}
  # Use a different port for the actual RPC check — peers expose RPC on the same offset relative to P2P
  # peer P2P is at base+1000, peer RPC is at base — so RPC = P2P - 1000
  rpc_port=$((port - 1000))
  if curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
        "http://${host}:${rpc_port}" | grep -q '"result"'; then
    echo "  ${host}:${rpc_port}: REACHABLE"
  else
    echo "  ${host}:${rpc_port}: not yet reachable (expected if other servers not deployed yet)"
  fi
done

cat <<EOF

==> Deployment of validator instance ${INSTANCE_ID} complete.
    nodeId: ${NODE_ID}
    public: ${PUBLIC_HOST}:${SELF_RPC_PORT} (RPC), :${SELF_P2P_PORT} (P2P), :${SELF_WIRE_PORT} (Wire)
    repo:   ${INSTALL_DIR} @ ${REPO_REF}
    logs:   /var/log/coc/node-${INSTANCE_ID}.log

After all 3 servers are deployed, run scripts/verify-multi-server-ipfs.sh from any operator
machine to confirm cross-server P2P + IPFS work end-to-end.
EOF
