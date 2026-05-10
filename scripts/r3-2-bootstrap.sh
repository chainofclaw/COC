#!/usr/bin/env bash
# r3-2-bootstrap.sh — Idempotent host-side setup script for an r3-2
# fullnode VM (Debian 12). Installs Node 22, clones COC, copies the
# pre-rendered config + key into /etc/coc, installs systemd unit, starts
# the service.
#
# Usage on the VM (after scp + chmod):
#   sudo bash /tmp/r3-2-bootstrap.sh <git-rev>
#
# Caller (operator workstation) is responsible for placing these files
# before invoking this script:
#   /tmp/node-1.json   — pre-rendered per-host node config (this script
#                        copies to /etc/coc/node-1.json, mode 644, root)
#   /tmp/node-1.env    — COC_NODE_KEY=... (this script copies to
#                        /etc/coc/node-1.env, mode 600, root)
set -euo pipefail

GIT_REV="${1:-main}"
COC_REPO="${COC_REPO:-https://github.com/chainofclaw/COC.git}"
INSTALL_DIR=/opt/coc
DATA_DIR=/var/lib/coc/node-1
LOG_DIR=/var/log/coc

if [[ "$EUID" -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

if [[ ! -f /tmp/node-1.json || ! -f /tmp/node-1.env ]]; then
  echo "missing /tmp/node-1.json or /tmp/node-1.env" >&2
  echo "scp them in before running this script" >&2
  exit 1
fi

echo "=== Step 1: install Node 22 + git + build tools ==="
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg build-essential
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" != "22" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "node version: $(node --version)"
echo "npm version: $(npm --version)"

echo "=== Step 2: clone or update COC repo at ${INSTALL_DIR} ==="
if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  git clone --depth 50 "$COC_REPO" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" fetch origin
fi
git -C "$INSTALL_DIR" checkout "$GIT_REV"
git -C "$INSTALL_DIR" pull --ff-only || true

echo "=== Step 3: install dependencies ==="
cd "$INSTALL_DIR/node"
npm install --no-audit --no-fund

echo "=== Step 4: prepare data + log dirs ==="
mkdir -p /etc/coc "$DATA_DIR" "$LOG_DIR"
useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin coc 2>/dev/null || true
chown -R coc:coc "$DATA_DIR" "$LOG_DIR"

echo "=== Step 5: install config + key ==="
install -o root -g root -m 644 /tmp/node-1.json /etc/coc/node-1.json
install -o root -g root -m 600 /tmp/node-1.env /etc/coc/node-1.env
shred -u /tmp/node-1.env  # don't leave the key in /tmp

echo "=== Step 6: install systemd unit ==="
cat > /etc/systemd/system/coc-node@.service <<'UNIT'
[Unit]
Description=COC node instance %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=coc
Group=coc
EnvironmentFile=/etc/coc/node-%i.env
Environment=COC_NODE_CONFIG=/etc/coc/node-%i.json
Environment=COC_METRICS_PORT=28810
WorkingDirectory=/opt/coc
ExecStart=/usr/bin/node --experimental-strip-types /opt/coc/node/src/index.ts
Restart=always
RestartSec=5
StandardOutput=append:/var/log/coc/node-%i.log
StandardError=append:/var/log/coc/node-%i.log
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable coc-node@1
systemctl restart coc-node@1

echo "=== Step 7: verify ==="
sleep 3
systemctl is-active coc-node@1 && echo "service active"
echo "tail of log:"
tail -20 "$LOG_DIR/node-1.log" 2>/dev/null || echo "(log not yet populated)"

echo "=== bootstrap complete ==="
echo "RPC: curl -X POST http://$(curl -sS ifconfig.me):28780 -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}'"
