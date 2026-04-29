# Phase B Deploy Runbook — BFT stateRoot pair-quorum

Branch: `fix/reenable-bft-stateroot-vote` (pushed to NGPlateform/COC)
Commits: `ace850b` → `c557952` → `c5d6a2f` → `54e32f7` → `57f740f`
Plan: `/home/baominghao/.claude/plans/coc-phase-b-stateroot-vote.md`

## What changes

Re-enables the `(blockHash, stateRoot)` joint quorum that `fb47d2f`
temporarily disabled. Validators now compute the post-execution
stateRoot on an isolated trie fork (`forkForDryRun`) during BFT
prepare, and vote on `(blockHash, computedRoot)` instead of
`(blockHash)` alone.

Wire-compatible with Phase A: the vote's `stateRoot` field is optional,
and `pickWinningVoteGroup` falls back to hash-only quorum when any voter
returns `undefined`. A single-direction upgrade is safe; a mixed
deployment with some validators on main (hash-only) and some on Phase B
(pair) still finalizes, just without the extra defense during the
transition.

**No LevelDB schema change.** Do NOT wipe volumes. Phase B is a pure
in-memory defense that runs before applyBlock; the forkForDryRun trie
shares the parent's committed state and never persists.

## Pre-flight

Run from your laptop, not the testnet host:

```bash
# Confirm the branch exists upstream on the fork
gh api repos/NGPlateform/COC/branches/fix/reenable-bft-stateroot-vote \
  --jq '.commit.sha' | grep -q "^57f740f" && echo "branch ok"

# Confirm the Phase A merge is already on main (prerequisite)
gh api repos/NGPlateform/COC/commits/main --jq '.sha' | grep -q "^a07a8d8\|" \
  || echo "WARN: expected main at a07a8d8 or descendant"
```

## Deploy to testnet host

SSH to the testnet host and run:

```bash
cd /path/to/COC  # the same dir your Phase A deploy used
git fetch origin
git checkout fix/reenable-bft-stateroot-vote
git pull --ff-only

# Sanity: show the Phase B commits we expect
git log --oneline -6 | head

# Confirm existing chain data is intact — Phase B uses the same LevelDB
# layout as Phase A. Do NOT docker volume rm.
docker compose -f docker/docker-compose.testnet.yml ps

# Rebuild the image. IMAGE_TAG makes the rollback straightforward.
IMAGE_TAG=phase-b-$(git rev-parse --short HEAD) \
  docker compose -f docker/docker-compose.testnet.yml build --no-cache

# Rolling restart: node-1 first, wait for it to re-peer, then 2 and 3.
# (If you'd rather full-restart, stop all then start all; Phase B is
# wire-compatible so there's no coordination requirement.)
for node in node-1 node-2 node-3; do
  echo "==> restarting $node"
  IMAGE_TAG=phase-b-$(git rev-parse --short HEAD) \
    docker compose -f docker/docker-compose.testnet.yml up -d --no-deps "$node"
  # Give each node ~20 s to rejoin before moving to the next.
  sleep 20
done
IMAGE_TAG=phase-b-$(git rev-parse --short HEAD) \
  docker compose -f docker/docker-compose.testnet.yml up -d --no-deps sync-node
```

## Smoke checks — first 5 min

These should all succeed on a healthy cluster. Run from any host that
can reach the testnet RPCs:

```bash
RPCS=( http://<host>:28780 http://<host>:28782 http://<host>:28784 )

# 1. All three validators advancing
for r in "${RPCS[@]}"; do
  curl -s "$r" -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
    | jq -r '.result'
done | uniq -c  # expect 3 identical heights (or off-by-1 mid-block)

# 2. stateRoot agreement at tip-10
TIP=$(curl -s "${RPCS[0]}" -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r .result)
BN=$(printf '0x%x' $((TIP - 10)))
for r in "${RPCS[@]}"; do
  curl -s "$r" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"$BN\",false]}" \
    | jq -r '.result.stateRoot'
done | uniq -c  # expect all 3 equal

# 3. BFT prepare votes carry stateRoot (log inspection — requires ssh)
# On each validator: grep for a recent finalized block; the prepareVotes
# count should read 3 and the per-vote stateRoot field should be present.
docker compose -f docker/docker-compose.testnet.yml logs --tail=200 node-1 \
  | grep -E "BFT round finalized|speculative" | tail -10

# 4. speculative failure rate — must be 0 on a healthy cluster.
for node in node-1 node-2 node-3; do
  count=$(docker compose -f docker/docker-compose.testnet.yml logs --tail=10000 "$node" \
    | grep -c "speculative stateRoot compute failed")
  echo "$node: $count speculative failures"
done

# 5. Production gate: COC_UNSAFE_ADVERSARIAL_SPEC_ROOT must NOT be set.
for node in node-1 node-2 node-3; do
  docker compose -f docker/docker-compose.testnet.yml exec -T "$node" env \
    | grep -q COC_UNSAFE_ADVERSARIAL_SPEC_ROOT \
    && echo "FAIL $node: adversarial env leaked to production!" \
    || echo "ok   $node"
done
```

If any of 1-4 fails on a node, see **Rollback** below.

## 24-48 h soak monitoring

Leave running on your laptop or a side host:

```bash
#!/usr/bin/env bash
# save as monitor-phase-b.sh
RPCS=( http://<host>:28780 http://<host>:28782 http://<host>:28784 )
LOG=phase-b-soak-$(date -u +%Y%m%dT%H%MZ).log
echo "time|tip|stateRoot_agree|speculative_failures|blocks_since_last_sample" > "$LOG"

prev_tip=0
while true; do
  now=$(date -u +%FT%TZ)
  tip=$(curl -s --max-time 5 "${RPCS[0]}" -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r '.result // "ERR"')
  [[ "$tip" == "ERR" ]] && { sleep 30; continue; }
  tip_dec=$((tip))
  # Sample stateRoot at tip-5 across all nodes
  bn=$(printf '0x%x' $((tip_dec - 5)))
  agree=1
  first=""
  for r in "${RPCS[@]}"; do
    sr=$(curl -s --max-time 5 "$r" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"$bn\",false]}" | jq -r '.result.stateRoot // "ERR"')
    [[ -z "$first" ]] && first="$sr"
    [[ "$sr" != "$first" ]] && agree=0
  done
  # SSH to a validator to count speculative failures (needs ssh access)
  spec_fail=$(ssh <host> "cd /path/to/COC && docker compose -f docker/docker-compose.testnet.yml logs --since=1m node-1 | grep -c 'speculative stateRoot compute failed'" 2>/dev/null || echo "N/A")
  delta=$((tip_dec - prev_tip))
  echo "$now|$tip_dec|$agree|$spec_fail|$delta" >> "$LOG"
  [[ "$agree" != "1" ]] && echo "$now DIVERGE at $bn"
  [[ "$spec_fail" != "0" && "$spec_fail" != "N/A" ]] && echo "$now SPECULATIVE_FAILURES=$spec_fail"
  prev_tip=$tip_dec
  sleep 60
done
```

### Alert thresholds (ping Claude with the log snippet if any trip)

- **stateRoot agreement** drops to 0 even briefly → Phase B detected a
  divergence, check `speculative stateRoot compute failed` logs + do a
  Phase A-style incident response. This is the exact situation Phase B
  was built to catch; collect logs before rolling back.
- **Speculative failure count** non-zero on a healthy block → a real
  bug. Collect the `persistent-engine` warn log entry with `height` +
  `error` fields and ping for diagnosis.
- **`blocks_since_last_sample`** drops to 0 for more than 2 minutes →
  cluster stalled. Could be Phase B rejecting unanimously (collusion
  scenario — extremely unlikely) OR network issue OR applyBlock hang.
  Collect `applyBlock phase` logs from all three nodes.
- **BFT round time p95** > 2× Phase A baseline → perf regression. Phase
  B5 (empty-block short-circuit, timeout wrapper) goes live. Plan:
  `coc-phase-b-stateroot-vote.md` §B5.

## Rollback

Phase B is wire-compatible both directions, so partial rollback works:

```bash
# Roll back a single node that's misbehaving
IMAGE_TAG=<previous-phase-a-tag> \
  docker compose -f docker/docker-compose.testnet.yml up -d --no-deps node-<N>
```

The rolled-back node will vote hash-only (stateRoot undefined). Quorum
will still form with the two Phase-B-enabled validators as long as they
agree with each other; hasQuorum allows `undefined` votes to join any
pair group (legacy compat in `pickWinningVoteGroup` at bft.ts:91).

Full rollback (all 3 nodes back to Phase A main):

```bash
git checkout a07a8d8   # Phase A merge commit on main
IMAGE_TAG=phase-a-rollback \
  docker compose -f docker/docker-compose.testnet.yml build --no-cache
IMAGE_TAG=phase-a-rollback \
  docker compose -f docker/docker-compose.testnet.yml up -d
```

No LevelDB wipe needed either direction — Phase B and Phase A share
schema.

## Soak success criteria (72 h)

Declare Phase B stable when all of these hold for ≥ 72 h:

1. `stateRoot` 100% agreement across 3 validators at every sampled block
   (same bar as Phase A soak).
2. `eth_getTransactionCount` agreement after any submitted tx (same).
3. Zero `"speculative stateRoot compute failed"` warnings in validator
   logs (a non-zero count means Phase B's fork path has an edge case we
   haven't covered).
4. BFT round p95 latency ≤ 2× Phase A baseline. If higher, decide
   between Phase B5 optimizations or accepting the cost.
5. No `applyBlock phase` logs show `trie revert failed` or `stateRoot
   mismatch` (would indicate Phase A regression, not a Phase B issue,
   but still reason to rollback and investigate).

Record the closeout in `project_coc_gh6_divergence.md` memory with
"Phase B结案" once the above hold.
