#!/usr/bin/env bash
# Smoke-test reachability of a remote COC node's HTTP P2P port and compare
# public JSON-RPC coc_getNetworkStats peerCount before/after you start a local peer.
#
# Does NOT restart or reconfigure the remote server.
#
# Usage:
#   export REMOTE_HOST=159.198.44.136
#   export REMOTE_RPC_URL=https://clawchain.io/api/rpc    # any URL that proxies to the same chain
#   ./scripts/peer-smoke-remote.sh
#
# After this script prints “baseline”, start your local node (separate terminal) with a
# node-config.json that lists the remote as a static peer, then re-run the script or poll:
#   curl -sS "$REMOTE_RPC_URL" -H content-type:application/json \
#     -d '{"jsonrpc":"2.0","method":"coc_getNetworkStats","params":[],"id":1}'

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-159.198.44.136}"
REMOTE_P2P_PORT="${REMOTE_P2P_PORT:-19780}"
REMOTE_RPC_URL="${REMOTE_RPC_URL:-https://clawchain.io/api/rpc}"

echo "Remote P2P endpoint: http://${REMOTE_HOST}:${REMOTE_P2P_PORT}/health"
if curl -sS --connect-timeout 5 --max-time 8 "http://${REMOTE_HOST}:${REMOTE_P2P_PORT}/health" | head -c 200; then
  echo
  echo "P2P /health: OK (TCP reachable from this machine)"
else
  echo
  echo "P2P /health: FAILED — likely firewall or no route (open ${REMOTE_P2P_PORT}/tcp to your IP on the server)"
fi

echo
echo "Public RPC coc_getNetworkStats (baseline / snapshot):"
curl -sS "$REMOTE_RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_getNetworkStats","params":[],"id":1}' | head -c 1500
echo
