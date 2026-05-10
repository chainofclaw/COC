#!/usr/bin/env bash
# render-r3-2-configs.sh — Render 5 per-validator node configs for chainId 88780
# from configs/r3-2-candidate/node-config-template.json + a CSV of host:ip
# pairs. Output drops in /tmp/r3-2-configs/node-{1..5}.json ready for scp.
#
# Usage:
#   bash scripts/render-r3-2-configs.sh \
#     <validator-1-host> <validator-2-host> <validator-3-host> \
#     <validator-4-host> <validator-5-host>
#
# Hosts can be IPs or DNS names — they go into both the `peers[].url` field
# and the `dhtBootstrapPeers[].address` field of each per-host config.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${ROOT}/configs/r3-2-candidate/node-config-template.json"
VALIDATORS_JSON="${ROOT}/configs/r3-2-candidate/validators.json"

if [[ ! -f "$TEMPLATE" || ! -f "$VALIDATORS_JSON" ]]; then
  echo "missing template or validators.json (run from repo root)" >&2
  exit 1
fi

if [[ "$#" -ne 5 ]]; then
  echo "usage: $0 <h1> <h2> <h3> <h4> <h5>" >&2
  exit 1
fi

HOSTS=("$@")
OUT_DIR="${OUT_DIR:-/tmp/r3-2-configs}"
mkdir -p "$OUT_DIR"

# Read validator IDs (lowercase 0x-prefixed addresses, in genesis order)
mapfile -t IDS < <(node -e "
const ids = JSON.parse(require('fs').readFileSync('$VALIDATORS_JSON','utf8'));
for (const id of ids) console.log(id);
")
if [[ "${#IDS[@]}" -ne 5 ]]; then
  echo "expected 5 validators in validators.json, got ${#IDS[@]}" >&2
  exit 1
fi

for self_idx in 1 2 3 4 5; do
  self_n=$((self_idx - 1))
  SELF_ID="${IDS[$self_n]}"
  SELF_HOST="${HOSTS[$self_n]}"
  OUT="${OUT_DIR}/node-${self_idx}.json"

  # Collect peer indices (everyone except self)
  declare -a PEER_IDS=()
  declare -a PEER_HOSTS=()
  for j in 0 1 2 3 4; do
    [[ "$j" == "$self_n" ]] && continue
    PEER_IDS+=("${IDS[$j]}")
    PEER_HOSTS+=("${HOSTS[$j]}")
  done

  # Render via sed (template uses ${PLACEHOLDER} markers). We do it via
  # sed-with-pipes rather than envsubst so we can keep the literal strings
  # inside JSON values intact.
  sed \
    -e "s|\${NODE_ID}|${SELF_ID}|g" \
    -e "s|\${SELF_HOST}|${SELF_HOST}|g" \
    -e "s|\${PEER_1_ID}|${PEER_IDS[0]}|g" \
    -e "s|\${PEER_1_HOST}|${PEER_HOSTS[0]}|g" \
    -e "s|\${PEER_2_ID}|${PEER_IDS[1]}|g" \
    -e "s|\${PEER_2_HOST}|${PEER_HOSTS[1]}|g" \
    -e "s|\${PEER_3_ID}|${PEER_IDS[2]}|g" \
    -e "s|\${PEER_3_HOST}|${PEER_HOSTS[2]}|g" \
    -e "s|\${PEER_4_ID}|${PEER_IDS[3]}|g" \
    -e "s|\${PEER_4_HOST}|${PEER_HOSTS[3]}|g" \
    "$TEMPLATE" > "$OUT"

  echo "rendered ${OUT} (validator-${self_idx} = ${SELF_ID} @ ${SELF_HOST})"
done

echo
echo "All 5 configs in ${OUT_DIR}. Sanity check with:"
echo "  node -e 'JSON.parse(require(\"fs\").readFileSync(\"${OUT_DIR}/node-1.json\",\"utf8\"))'"
echo
echo "Copy to each host as /etc/coc/node-1.json + bring up coc-node service."
