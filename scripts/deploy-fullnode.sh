#!/usr/bin/env bash
# deploy-fullnode.sh — Install + start a COC fullnode that joins an existing
# testnet. Designed for gcloud VMs (Ubuntu 22.04+). Idempotent.
#
# Inputs (env vars, source from deploy-vars-server-N.sh produced by
# bootstrap-5-fullnode-deploy.sh):
#   NODE_ROLE              "anchor" | "burst" — informational
#   NODE_INDEX             1..5 — used in logs only (instance ID always 1)
#   PUBLIC_HOST            advertised hostname/IP
#   NODE_ADDR              this fullnode's observer address (informational)
#   SELF_*_PORT            port bundle (RPC/WS/P2P/Wire/IPFS/Metrics)
#   COC_FULLNODE_ENV_B64   base64-encoded /etc/coc/node-1.env
#   COC_FULLNODE_CONFIG_B64 base64-encoded /etc/coc/node-1.json
#
# Optional:
#   COC_REPO_URL  (default: https://github.com/chainofclaw/COC.git)
#   COC_REPO_REF  (default: main)
#   COC_INSTALL_DIR (default: /opt/coc)
#
# Run as root.

set -euo pipefail

required=(NODE_ROLE NODE_INDEX PUBLIC_HOST NODE_ADDR
  SELF_RPC_PORT SELF_WS_PORT SELF_P2P_PORT SELF_WIRE_PORT SELF_IPFS_PORT SELF_METRICS_PORT
  COC_FULLNODE_ENV_B64 COC_FULLNODE_CONFIG_B64)
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: env var $v missing — did you source deploy-vars-server-N.sh?" >&2
    exit 2
  fi
done

REPO_URL="${COC_REPO_URL:-https://github.com/chainofclaw/COC.git}"
REPO_REF="${COC_REPO_REF:-main}"
INSTALL_DIR="${COC_INSTALL_DIR:-/opt/coc}"
INSTANCE_ID=1   # one node per VM, always instance 1

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2; exit 2
fi

echo "==> [1/9] System packages"
apt-get update -qq
apt-get install -y -qq curl git ufw chrony ca-certificates build-essential python3 jq >/dev/null
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

echo "==> [5/9] npm install"
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5

# Apply optional Phase X1.6 follow-up patch shipped via the deploy bundle.
# Without this, fullnodes joining an existing testnet stall at the first
# remote-proposer block they try to verify (mixed-case proposer vs lowercase
# validators[] config). See chain-engine-persistent.ts:1362-1376.
if [[ -n "${COC_PATCH_CHAIN_ENGINE_PERSISTENT_B64:-}" ]]; then
  echo "    applying chain-engine-persistent.ts patch (case-insensitive proposer check)"
  printf "%s" "$COC_PATCH_CHAIN_ENGINE_PERSISTENT_B64" | base64 -d > "$INSTALL_DIR/node/src/chain-engine-persistent.ts"
fi

chown -R coc:coc "$INSTALL_DIR"

echo "==> [6/9] Decode and install /etc/coc/node-1.{env,json}"
mkdir -p /etc/coc "/var/lib/coc/node-${INSTANCE_ID}" /var/log/coc
chown coc:coc "/var/lib/coc/node-${INSTANCE_ID}" /var/log/coc

printf "%s" "$COC_FULLNODE_ENV_B64" | base64 -d > "/etc/coc/node-${INSTANCE_ID}.env"
chmod 640 "/etc/coc/node-${INSTANCE_ID}.env"
chown root:coc "/etc/coc/node-${INSTANCE_ID}.env"

printf "%s" "$COC_FULLNODE_CONFIG_B64" | base64 -d > "/etc/coc/node-${INSTANCE_ID}.json"
chmod 644 "/etc/coc/node-${INSTANCE_ID}.json"

# Validate JSON to fail fast on a corrupted base64 payload
if ! jq . "/etc/coc/node-${INSTANCE_ID}.json" >/dev/null; then
  echo "ERROR: rendered config is not valid JSON" >&2
  cat "/etc/coc/node-${INSTANCE_ID}.json" >&2
  exit 5
fi

echo "==> [7/9] Firewall"
ufw --force enable >/dev/null
for port in 22 "$SELF_RPC_PORT" "$SELF_WS_PORT" "$SELF_P2P_PORT" "$SELF_WIRE_PORT" "$SELF_IPFS_PORT"; do
  ufw allow "${port}/tcp" >/dev/null
done

echo "==> [8/9] systemd unit"
cp "$INSTALL_DIR/docker/systemd/coc-node@.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "coc-node@${INSTANCE_ID}" >/dev/null
systemctl restart "coc-node@${INSTANCE_ID}"

echo "==> [9/9] Health check (waiting 30s for snap-sync handshake)"
sleep 30
if ! systemctl is-active --quiet "coc-node@${INSTANCE_ID}"; then
  echo "ERROR: coc-node@${INSTANCE_ID} not active"
  systemctl status "coc-node@${INSTANCE_ID}" --no-pager | tail -20
  exit 3
fi
echo "service active"

if ! curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' \
     --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
     "http://localhost:${SELF_RPC_PORT}" | grep -q '"result"'; then
  echo "ERROR: local RPC not responding on port $SELF_RPC_PORT"
  tail -20 "/var/log/coc/node-${INSTANCE_ID}.log"
  exit 4
fi

local_height=$(curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  "http://localhost:${SELF_RPC_PORT}" | jq -r '.result')

cat <<EOF

==> Fullnode (${NODE_ROLE} #${NODE_INDEX}) deployment complete.
    nodeAddr (observer): ${NODE_ADDR}
    public: ${PUBLIC_HOST}:${SELF_RPC_PORT} (RPC), :${SELF_P2P_PORT} (P2P), :${SELF_WIRE_PORT} (Wire), :${SELF_IPFS_PORT} (IPFS)
    repo:   ${INSTALL_DIR} @ ${REPO_REF}
    logs:   /var/log/coc/node-${INSTANCE_ID}.log
    local height: ${local_height} (will catch up via snap-sync within minutes)

==> Watch sync progress:
    journalctl -u coc-node@${INSTANCE_ID} -f | grep -E 'snap-sync|height|finalized'
EOF
