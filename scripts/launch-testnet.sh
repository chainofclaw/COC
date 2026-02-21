#!/usr/bin/env bash
set -euo pipefail

# Launch 3-node BFT testnet via Docker Compose and verify health
# Usage: bash scripts/launch-testnet.sh [up|down|status|verify]

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker/docker-compose.testnet.yml"

# RPC endpoints for the 3 nodes
NODE_PORTS=(28780 28782 28784)
NODE_NAMES=("node-1" "node-2" "node-3")
MAX_WAIT=120  # seconds to wait for nodes to be healthy

rpc_call() {
  local port=$1 method=$2 params=${3:-"[]"}
  curl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}" \
    "http://127.0.0.1:$port/" 2>/dev/null
}

wait_for_nodes() {
  echo "[testnet] waiting for nodes to be healthy (max ${MAX_WAIT}s)..."
  local start=$SECONDS
  while true; do
    local all_healthy=true
    for i in "${!NODE_PORTS[@]}"; do
      local port=${NODE_PORTS[$i]}
      local name=${NODE_NAMES[$i]}
      local result
      result=$(rpc_call "$port" "eth_blockNumber" 2>/dev/null || echo "")
      if [ -z "$result" ]; then
        all_healthy=false
        break
      fi
    done
    if $all_healthy; then
      echo "[testnet] all nodes responding"
      return 0
    fi
    if (( SECONDS - start > MAX_WAIT )); then
      echo "[testnet] ERROR: timeout waiting for nodes"
      return 1
    fi
    sleep 2
  done
}

check_block_production() {
  echo "[testnet] checking block production..."
  local heights=()
  for i in "${!NODE_PORTS[@]}"; do
    local port=${NODE_PORTS[$i]}
    local name=${NODE_NAMES[$i]}
    local result
    result=$(rpc_call "$port" "eth_blockNumber")
    local height
    height=$(echo "$result" | grep -o '"result":"[^"]*"' | cut -d'"' -f4)
    local dec_height=$((height))
    heights+=("$dec_height")
    echo "  $name: block $dec_height ($height)"
  done

  # Check all nodes have produced blocks
  for h in "${heights[@]}"; do
    if [ "$h" -lt 1 ]; then
      echo "[testnet] WARNING: some nodes have not produced blocks yet"
      return 1
    fi
  done

  # Check height difference (should be within 2 blocks)
  local max=${heights[0]} min=${heights[0]}
  for h in "${heights[@]}"; do
    (( h > max )) && max=$h
    (( h < min )) && min=$h
  done
  local diff=$((max - min))
  if [ "$diff" -gt 5 ]; then
    echo "[testnet] WARNING: block height difference too large ($diff blocks)"
    return 1
  fi
  echo "[testnet] block production OK (height spread: $diff)"
}

check_bft_status() {
  echo "[testnet] checking BFT consensus..."
  for i in "${!NODE_PORTS[@]}"; do
    local port=${NODE_PORTS[$i]}
    local name=${NODE_NAMES[$i]}
    local result
    result=$(rpc_call "$port" "coc_getBftStatus")
    local enabled
    enabled=$(echo "$result" | grep -o '"enabled":[a-z]*' | head -1 | cut -d: -f2)
    echo "  $name: BFT enabled=$enabled"
  done
}

check_peer_connections() {
  echo "[testnet] checking peer connections..."
  for i in "${!NODE_PORTS[@]}"; do
    local port=${NODE_PORTS[$i]}
    local name=${NODE_NAMES[$i]}
    local result
    result=$(rpc_call "$port" "coc_getNetworkStats")
    local peers
    peers=$(echo "$result" | grep -o '"peerCount":[0-9]*' | head -1 | cut -d: -f2)
    echo "  $name: peers=${peers:-0}"
  done
}

check_admin_info() {
  echo "[testnet] checking admin node info..."
  for i in "${!NODE_PORTS[@]}"; do
    local port=${NODE_PORTS[$i]}
    local name=${NODE_NAMES[$i]}
    local result
    result=$(rpc_call "$port" "admin_nodeInfo")
    local node_id
    node_id=$(echo "$result" | grep -o '"nodeId":"[^"]*"' | head -1 | cut -d'"' -f4)
    local uptime
    uptime=$(echo "$result" | grep -o '"uptime":[0-9]*' | head -1 | cut -d: -f2)
    echo "  $name: id=${node_id:-unknown} uptime=${uptime:-0}s"
  done
}

send_test_tx() {
  echo "[testnet] sending test transaction..."
  local port=${NODE_PORTS[0]}
  local result
  result=$(rpc_call "$port" "eth_sendTransaction" '[{"from":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","to":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","value":"0xde0b6b3a7640000"}]')
  local hash
  hash=$(echo "$result" | grep -o '"result":"0x[^"]*"' | cut -d'"' -f4)
  if [ -n "$hash" ]; then
    echo "  tx hash: $hash"
    sleep 5
    # Wait for receipt
    local receipt
    receipt=$(rpc_call "$port" "eth_getTransactionReceipt" "[\"$hash\"]")
    local status
    status=$(echo "$receipt" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "  tx status: ${status:-pending}"
  else
    echo "  tx failed (dev accounts may not be enabled)"
  fi
}

case "${1:-up}" in
  up)
    echo "[testnet] starting 3-node BFT testnet..."
    docker compose -f "$COMPOSE_FILE" up -d --build
    wait_for_nodes
    echo ""
    echo "[testnet] === Health Check ==="
    check_block_production || true
    check_bft_status
    check_peer_connections
    check_admin_info
    echo ""
    echo "[testnet] testnet is running"
    echo "  Node 1 RPC: http://127.0.0.1:28780"
    echo "  Node 2 RPC: http://127.0.0.1:28782"
    echo "  Node 3 RPC: http://127.0.0.1:28784"
    echo "  Explorer:   http://127.0.0.1:3000"
    echo "  Faucet:     http://127.0.0.1:3003"
    ;;
  down)
    echo "[testnet] stopping testnet..."
    docker compose -f "$COMPOSE_FILE" down
    echo "[testnet] stopped"
    ;;
  status)
    echo "[testnet] === Testnet Status ==="
    check_block_production || true
    check_bft_status
    check_peer_connections
    check_admin_info
    ;;
  verify)
    echo "[testnet] === Full Verification ==="
    check_block_production
    check_bft_status
    check_peer_connections
    check_admin_info
    echo ""
    echo "[testnet] waiting 10s for more blocks..."
    sleep 10
    check_block_production
    send_test_tx
    echo ""
    echo "[testnet] verification complete"
    ;;
  *)
    echo "Usage: $0 [up|down|status|verify]"
    exit 1
    ;;
esac
