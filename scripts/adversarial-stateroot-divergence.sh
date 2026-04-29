#!/usr/bin/env bash
# adversarial-stateroot-divergence.sh — live-devnet validation that Phase B's
# (blockHash, stateRoot) pair quorum defends against validators whose local
# speculative execution produces a different post-state than the rest of the
# cluster.
#
# Usage:
#   bash scripts/adversarial-stateroot-divergence.sh [5|7]   # default 5
#
# Requires ≥ 5 validators. With 3 validators, `quorumThreshold` in bft.ts
# (floor(2/3 * totalStake) + 1) collapses to "all 3 must agree" so a single
# liar already stalls the round, making Scenario A indistinguishable from
# Scenario B. With 5 equal-stake validators, threshold = 3334 out of 5000
# (needs 4/5 voters on the same pair), so the two scenarios diverge cleanly:
#
#   Scenario A — "single liar, honest majority outvotes" (5 validators):
#     node-1 launched with COC_UNSAFE_ADVERSARIAL_SPEC_ROOT set to a fixed
#     poisoned 0x…deadbeef… value. Its speculativelyComputeStateRoot
#     short-circuits and returns that poison on every block, so its BFT
#     prepare votes land in (blockHash, poisonRoot). Nodes 2-5 run clean
#     and vote (blockHash, realRoot) — 4/5 agreement, above threshold,
#     pair quorum forms on the real root, chain finalizes normally.
#     Node-1's vote is wasted every round but never corrupts state.
#     Pass condition: chain advances ≥ 5 blocks AND nodes 2-5 stateRoots
#     agree at tip.
#
#   Scenario B — "two liars to distinct poisons, no majority on any pair":
#     node-1 and node-2 launched with DIFFERENT poisoned values; nodes 3-5
#     run clean. Prepare votes split 1/1/3 across three distinct pairs.
#     Honest pair only has 3/5 stake (3000 < 3334 threshold) — no quorum.
#     Prepare rounds repeatedly time out, cluster stalls at genesis. This
#     is the correct fail-closed behavior (better to halt than finalize a
#     block whose post-state 2/5 validators disagree with).
#     Pass condition: max observed height stays ≤ 1 for the full window.
#
# Baseline comparison (not run here): on main pre-Phase B, Scenario A would
# pass silently because hash-only quorum ignores the stateRoot entirely —
# node-1's lie has zero effect. Scenario B would ALSO "pass" (chain would
# advance) for the same reason, masking the fact that validators disagreed
# on post-state. This script proves Phase B both (a) fails closed on real
# disagreement and (b) doesn't spuriously fail on a single liar.
#
# Exit code: 0 on both scenarios matching their pass conditions; non-zero
# with a diagnostic otherwise.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODES="${1:-5}"
if [[ "$NODES" -lt 5 ]]; then
  echo "usage: $0 <5|7> — need ≥ 5 validators to distinguish single-liar vs quorum-breaking liars" >&2
  exit 2
fi

BASE_RPC=28780

POISON_A="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
POISON_B="0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe"

# Helpers
rpc() {
  local port=$1 method=$2 params=${3:-'[]'}
  curl -s --max-time 5 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "http://127.0.0.1:${port}"
}

height_of() {
  local port=$1
  local hex
  hex=$(rpc "$port" eth_blockNumber | jq -r '.result // "0x0"')
  printf '%d\n' "$hex"
}

stateroot_at() {
  local port=$1 bn=$2
  rpc "$port" eth_getBlockByNumber "[\"$bn\",false]" | jq -r '.result.stateRoot // "null"'
}

stop_quiet() {
  bash "${ROOT}/scripts/stop-devnet.sh" "$NODES" >/dev/null 2>&1 || true
  # SIGKILL any survivors by matching the index.ts arg — catches cases where
  # pid files were already cleaned up but the process is still alive.
  pkill -9 -f "node --experimental-strip-types ${ROOT}/node/src/index.ts" 2>/dev/null || true
  # Wait for the P2P port range to actually free (up to 10 s). The Linux
  # TCP close-wait can hold ports after kill; without this gate the next
  # start-devnet hits EADDRINUSE and the newly-spawned node dies on bind.
  for _ in $(seq 1 50); do
    local held=0
    for ((n=0; n<NODES; n++)); do
      local port=$((29780 + n))
      if ss -ltn "sport = :${port}" 2>/dev/null | grep -q LISTEN; then held=1; break; fi
    done
    if [[ "$held" -eq 0 ]]; then return 0; fi
    sleep 0.2
  done
  echo "WARN: ports still held after 10 s — restart may fail" >&2
}

trap stop_quiet EXIT INT

scenario() {
  local name=$1 ; shift
  echo "================================================================"
  echo "Scenario ${name}"
  echo "================================================================"
  stop_quiet
  sleep 1
  # COC_SKIP_SOUL_DEPLOY=1 is essential: Scenario B deliberately stalls the
  # cluster, and start-devnet's final SoulRegistry deploy step waits for tx
  # finalization that will never come. Skipping keeps start-devnet.sh from
  # hanging the whole harness in those scenarios. Safe for A too — neither
  # scenario exercises the SoulRegistry contract.
  env COC_SKIP_SOUL_DEPLOY=1 "$@" bash "${ROOT}/scripts/start-devnet.sh" "$NODES" 2>&1 | sed -u 's/^/  start-devnet: /'
}

# ── Scenario A: single liar, chain should advance ───────────────────────
scenario "A: single liar (node-1 poisoned to ${POISON_A})" \
  "COC_NODE_1_ENV=COC_UNSAFE_ADVERSARIAL_SPEC_ROOT=${POISON_A}"

echo
echo "Watching chain for 20 s …"
start_ts=$SECONDS
max_wait=30
while (( SECONDS - start_ts < max_wait )); do
  hs=()
  for ((n=0; n<NODES; n++)); do
    hs+=("$(height_of $((BASE_RPC + n)))")
  done
  # Honest nodes are indexes 2..NODES-1 (0-based indexes 1..NODES-1).
  # For scenario A, "honest" = all nodes except node-1 (index 0).
  min_honest=${hs[1]}
  for ((n=2; n<NODES; n++)); do
    if (( hs[n] < min_honest )); then min_honest=${hs[n]}; fi
  done
  printf "  t=%2ds heights: %s\n" "$((SECONDS - start_ts))" "$(IFS=,; echo "${hs[*]}")"
  if (( min_honest >= 5 )); then break; fi
  sleep 2
done

# Re-sample tip heights and stateRoots.
hs=()
for ((n=0; n<NODES; n++)); do
  hs+=("$(height_of $((BASE_RPC + n)))")
done
min_honest=${hs[1]}
for ((n=2; n<NODES; n++)); do
  if (( hs[n] < min_honest )); then min_honest=${hs[n]}; fi
done

echo
echo "Scenario A final heights: $(IFS=,; echo "${hs[*]}")"
if (( min_honest < 5 )); then
  echo "FAIL (A): honest majority should have produced ≥ 5 blocks despite node-1's lie." >&2
  exit 1
fi

# stateRoot agreement across honest nodes at the lowest honest tip.
bn_hex=$(printf '0x%x' "$min_honest")
srs=()
for ((n=1; n<NODES; n++)); do
  srs+=("$(stateroot_at $((BASE_RPC + n)) "$bn_hex")")
done
echo "  stateRoot @ block $bn_hex on honest nodes:"
for ((n=0; n<${#srs[@]}; n++)); do
  printf "    node-%d: %s\n" "$((n + 2))" "${srs[n]:0:20}…"
done
first_sr="${srs[0]}"
for sr in "${srs[@]}"; do
  if [[ "$sr" != "$first_sr" ]]; then
    echo "FAIL (A): honest validators disagree on stateRoot — Phase B supposed to keep them aligned." >&2
    exit 1
  fi
done
echo "PASS (A): chain advanced, honest stateRoots agree, node-1's poisoned vote was outvoted."

# ── Scenario B: two liars (distinct poisons) — cluster should stall ─────
scenario "B: two liars (node-1→${POISON_A:0:18}…, node-2→${POISON_B:0:18}…)" \
  "COC_NODE_1_ENV=COC_UNSAFE_ADVERSARIAL_SPEC_ROOT=${POISON_A}" \
  "COC_NODE_2_ENV=COC_UNSAFE_ADVERSARIAL_SPEC_ROOT=${POISON_B}"

echo
echo "Watching chain for 30 s …"
start_ts=$SECONDS
max_wait=30
h_max=0
while (( SECONDS - start_ts < max_wait )); do
  hs=()
  for ((n=0; n<NODES; n++)); do
    hs+=("$(height_of $((BASE_RPC + n)))")
  done
  printf "  t=%2ds heights: %s\n" "$((SECONDS - start_ts))" "$(IFS=,; echo "${hs[*]}")"
  for h in "${hs[@]}"; do if (( h > h_max )); then h_max=$h; fi; done
  sleep 2
done

echo
echo "Scenario B max height observed: ${h_max}"
# Chain starts at height 1 after genesis, so ≤ 1 is "no post-genesis progress".
if (( h_max > 1 )); then
  echo "FAIL (B): cluster advanced past genesis despite 2/3 validators disagreeing on stateRoot." >&2
  echo "  Phase B pair quorum should have kept the round timing out — a finalized block here" >&2
  echo "  means either the defense isn't wired, or the poison values are unintentionally matching." >&2
  exit 1
fi
echo "PASS (B): cluster correctly stalled at genesis — no pair reached 2/3 quorum."

echo
echo "================================================================"
echo "All scenarios pass. Phase B pair quorum works as specified."
echo "================================================================"
