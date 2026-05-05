#!/usr/bin/env bash
# Phase J3: inject stateRoot corruption into a node's leveldb-chain.
#
# Reproduces the 2026-05-05 production failure: node-1 had block 206803's
# header.stateRoot stored as 0x2a248... while its actual EVM state trie
# computed 0x3d3877... (the value node-2/3 had). The result was a chain
# stall — node-1's EVM trie is correct so block 206804's apply succeeds
# locally, but the BFT prepare vote uses block.stateRoot from leveldb
# (the wrong one), so 2/3 quorum never forms with node-1's vote, and
# strict 3/3 quorum stalls forever.
#
# Strategy: stop the container, mutate the leveldb on disk via a node
# helper script that opens the existing chain DB and rewrites the named
# block's stateRoot to a poisoned value, restart.
#
# Usage: ./inject-stateroot-corruption.sh <node-name> [<height>]
#   node-name: coc-mn-node-1 | coc-mn-node-2 | coc-mn-node-3
#   height:    block number to corrupt (default: 5)

set -euo pipefail

NODE="${1:-coc-mn-node-1}"
HEIGHT="${2:-5}"
POISON_ROOT="0xdeadbeef00000000000000000000000000000000000000000000000000000000"

if ! docker ps --format '{{.Names}}' | grep -q "^${NODE}\$"; then
  echo "ERROR: container ${NODE} not running"
  exit 1
fi

echo "Stopping ${NODE}..."
docker stop "${NODE}" >/dev/null

# Stash the current stateRoot for diagnostic logging
echo "Pre-corruption stateRoot at height ${HEIGHT}:"
docker run --rm \
  -v "$(docker volume ls --format '{{.Name}}' | grep "$(echo "${NODE}" | sed 's/coc-mn-/mn-/')-data" | head -1)":/data:ro \
  -w /work \
  -v "$(pwd)/scripts":/work:ro \
  --entrypoint node \
  ghcr.io/chainofclaw/coc-node:latest \
  --experimental-strip-types /work/leveldb-poke.ts read "${HEIGHT}" || true

echo "Injecting stateRoot=${POISON_ROOT} at height ${HEIGHT} on ${NODE}..."
docker run --rm \
  -v "$(docker volume ls --format '{{.Name}}' | grep "$(echo "${NODE}" | sed 's/coc-mn-/mn-/')-data" | head -1)":/data:rw \
  -w /work \
  -v "$(pwd)/scripts":/work:ro \
  --entrypoint node \
  ghcr.io/chainofclaw/coc-node:latest \
  --experimental-strip-types /work/leveldb-poke.ts write "${HEIGHT}" "${POISON_ROOT}"

echo "Restarting ${NODE}..."
docker start "${NODE}" >/dev/null

echo "Done. ${NODE} block ${HEIGHT} stateRoot has been corrupted."
echo "Verify recovery via:"
echo "  curl -s http://localhost:38780 ... eth_getBlockByNumber for height ${HEIGHT}"
