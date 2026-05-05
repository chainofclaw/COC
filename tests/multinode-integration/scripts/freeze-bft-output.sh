#!/usr/bin/env bash
# Phase J3: pause outbound BFT messages from a node for N seconds.
#
# Reproduces the 2026-05-05 testnet "stuck proposer" pattern: node-2 was
# the proposer for height 206804, formed an internal BFT round with 1
# self-vote, but no peer prepares ever arrived (buffered=0). With a
# self-stuck round and strict 3/3 quorum, the chain stalled until docker
# restart was applied manually.
#
# Strategy: disconnect the target node from the docker bridge network for
# DURATION_S seconds, then reconnect. This simulates a partition so peer
# BFT messages can't reach the proposer's BFT coordinator.
#
# Usage: ./freeze-bft-output.sh <node-name> [<duration_s>]

set -euo pipefail

NODE="${1:-coc-mn-node-2}"
DURATION_S="${2:-180}"
NETWORK="coc-multinode"

if ! docker ps --format '{{.Names}}' | grep -q "^${NODE}\$"; then
  echo "ERROR: container ${NODE} not running"
  exit 1
fi

echo "Disconnecting ${NODE} from ${NETWORK} for ${DURATION_S}s..."
docker network disconnect "${NETWORK}" "${NODE}"

echo "Sleeping ${DURATION_S}s..."
sleep "${DURATION_S}"

echo "Reconnecting ${NODE} to ${NETWORK}..."
docker network connect "${NETWORK}" "${NODE}"

echo "Done. Verify recovery:"
echo "  for p in 38780 38782 38784; do curl -s http://localhost:\$p ...eth_blockNumber; done"
