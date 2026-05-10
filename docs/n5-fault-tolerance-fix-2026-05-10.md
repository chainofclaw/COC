# N=5 Fault-Tolerance Fix Series — 2026-05-10

## Context

The 2026-05-10 N=5 attempt #2 (`docs/n5-attempt-2-2026-05-10.md`) revealed
that BFT freezes immediately on any single validator unavailability —
same as N=3, regardless of N. Five distinct bugs combined to produce a
~1 hour cumulative chain freeze; recovery required manual rsync.

Branch: `fix/bft-n5-fault-tolerance`

## The 5 PRs

| PR | Subject | Files |
|----|---------|-------|
| **1A** | Fast-path proposer skip when slot is unreachable | `consensus.ts`, `bft-coordinator.ts`, `index.ts`, `bft-proposer-skip.test.ts` |
| **1B** | Invalidate `lastProposed` cache on validator set change | `consensus.ts`, `bft-coordinator.ts`, `index.ts`, `consensus-validator-set-change.test.ts` |
| **1C** | Sliding-window evidence cap + monitoring + recency prune | `bft.ts`, `bft-evidence-eviction.test.ts` |
| **1D** | Self-heal tip pointer desync at init | `chain-engine-persistent.ts`, `storage/block-index.ts`, `chain-engine-tip-sync.test.ts` |
| **1E** | Snap-sync per-peer fetch instrumentation + diagnostics | `p2p.ts`, `consensus.ts`, `p2p-snapshot-provider.test.ts` |

### PR-1A — fast-path proposer skip

Old behavior: when the slot proposer was unreachable, BFT round timeouts
fired every 4s but the round-robin kept selecting the dead validator;
chain only progressed via the H15 600s `NO_PROGRESS_TIMEOUT_MS` watchdog.
Producing N blocks where N validators were dead in any window required
N × 600s of waiting.

New behavior: `BftCoordinator.onProposerStuck` callback fires when a
non-self proposer's round times out, marking that validator unreachable
in `ConsensusEngine` for 60s TTL. Plus `reachabilityProvider` exposes
wire-connection-manager's connected peer set as a second evidence source.
When `checkNoProgressWatchdog` sees an unreachable stuck proposer, it
arms the same H15 override at `PROPOSER_UNREACHABLE_FAST_TIMEOUT_MS=15s`
instead of 600s. Rotation stagger preserved (no equivocation storm).
`notifyBftProgress` clears all unreachable marks on each successful
finalize.

### PR-1B — `lastProposed` cache invalidation

Old behavior: `BftCoordinator.updateValidators` only updated the stake
distribution; cache fields (`localPreparedAt`, `localCommittedAt`,
`localPreparedBlock`, `pendingMessages`) survived across membership
changes. The 2026-05-09 attempt #1 fingerprint was a reader-driven
N=3→N=8 change leaving `consensus.lastProposedBlock` pointing at a block
whose proposer was assigned by the OLD rotation; round-timeout re-broadcast
replayed that stale block; Phase R refused as self-equivocation; chain
stalled ~7h.

New behavior: `updateValidators` diffs membership (lowercased,
order-insensitive). On real change, clears all local-state caches and
force-clears the active round (its quorum was snapshotted from old
stakes). `ConsensusEngine.onValidatorSetChange` is a single entry point
that calls `clearLastProposed` AND routes through
`bft.updateValidators`. All 3 reader/governance update sites in
`index.ts` use it. Stake-only rebalancing (non-disruptive) preserves
caches.

### PR-1C — sliding-window evidence cap

Old behavior: `EquivocationDetector` per-validator cap (default 100)
silently dropped NEW evidence when reached. During chain freeze,
`clearEvidenceBefore` (Phase H16) is never called (no finalize). One
validator's cache fills to 100; subsequent rounds' evidence is lost;
slashing decisions on recovery use stale evidence.

New behavior: at cap, evict the OLDEST entry of the same validator and
push the new one (sliding window). Recent evidence is strictly more
useful for slashing than ancient evidence about the same actor. New
`pruneByMaxHeight(keep)` retains only the `keep` most-recent heights
(usable from a watchdog as a recency-based bound when finalize hasn't
advanced). New `getStats()` exposes counters for Prometheus.

### PR-1D — tip pointer self-heal

Old behavior: server-1 (N=5 attempt #2) reported h=71448 via RPC but
`eth_getBlockByNumber("0x116ba"=71450)` returned a valid block whose
stateRoot matched server-2/3. Disk had `b:71450` written, but
`m:latest-block` (LATEST) stayed at 71448. Recovery required manual
rsync of leveldb-chain. Atomicity of `buildBlockOps` should have
prevented this — but somehow it desynced. Most plausible vector:
snap-sync's per-block `putBlock` loop rewinds LATEST without deleting
stale `b:>peerTip` entries from a prior run.

New behavior: `BlockIndex.repairLatestPointer()` scans `b:` prefix,
parses BigInt suffixes, finds numerically-highest stored block, and
promotes LATEST if it lags. `PersistentChainEngine.init()` invokes the
repair on every boot. A desynced node self-aligns on restart.

### PR-1E — snap-sync diagnostics

Old behavior: `forceSnapSync` repeatedly logged "no peer snapshot
available" with no per-peer attribution. The N=5 attempt #2 cluster
burned 30+ minutes in this state without operators being able to
diagnose whether peers were unreachable, returning 429s, returning empty
bodies, or hitting the 15s aggregate timeout.

New behavior: `P2PNode.fetchSnapshots` tracks per-call counters
(attempts, successes, errors, timeouts, emptyResults) and per-peer-URL
last-failure-reason map. Aggregate timeout marks all peers as
timed-out. fetchSnapshots logs structured warn with first-5 sample
failure reasons whenever the round produced 0 successes. New
`getSnapshotFetchStats()` exposes counters. `consensus.forceSnapSync`'s
"no peer snapshot available" log now includes the stats snapshot.

## Test results

All unit tests passing on this branch:

```
node --experimental-strip-types --test \
  node/src/bft-proposer-skip.test.ts \
  node/src/consensus-validator-set-change.test.ts \
  node/src/bft-evidence-eviction.test.ts \
  node/src/chain-engine-tip-sync.test.ts \
  node/src/p2p-snapshot-provider.test.ts \
  node/src/bft.test.ts \
  node/src/bft-coordinator.test.ts \
  node/src/consensus.test.ts \
  node/src/p2p.test.ts
# 126/126 pass (PR-1A: 7, PR-1B: 7, PR-1C: 7, PR-1D: 5, PR-1E: 3, regression: 97)
```

Storage + persistent engine layer regression also clean:
`node/src/storage/*.test.ts` 106/106 pass.

## Devnet drill caveat (2026-05-10 local run)

A local `bash scripts/start-devnet.sh 5 18780` reproduced an
**unrelated environmental issue**: 5 nodes sharing `127.0.0.1` exhaust
each others' peer-scoring quotas, getting `HTTP 429 peer temporarily
banned` on `/p2p/chain-snapshot` polls. BFT messages are exempt from
ban-checks (`p2p.ts:494`), but the polling pressure plus IP-shared
scoring still degrades cluster behavior on a single host. PR-1E's
instrumentation immediately surfaced the cause — a concrete win for
diagnostic value.

For end-to-end N=5 chaos validation use one of:
- gcloud 5-node cluster (different IPs per node — no scoring collision)
- 5 separate VMs / containers with distinct hostnames
- chainId 88780 R3.2 prod-candidate per `docs/r3-2-prod-candidate-testnet-88780.md`

The local `scripts/start-devnet.sh 5 [chainId]` is fine for **single-node
restart** drills (T2/T4 single-validator stop) when started with
`COC_DEVNET_CHAIN_ID=...` parameterization, but not for sustained N=5
chaos sequences.

## What's next (Phase 2 → Phase 4)

| Phase | Status |
|-------|--------|
| Phase 1: 5 BFT bug PRs + tests | ✅ done (this commit series) |
| Phase 2: cloud / multi-host N=5 chaos drill | ⏳ pending — local devnet caveat above |
| Phase 3: chainId 88780 R3.2 prep (keys, genesis, contracts) | ⏳ pending |
| Phase 4: 88780 deploy + 30-day soak | ⏳ pending |

The 5 PRs are independently mergeable to `main`. Phase 2 cloud drill
becomes the gate for Phase 3 deployment.

## Helper scripts added

- `scripts/start-devnet.sh` — chainId now parameterized via `$2` or
  `COC_DEVNET_CHAIN_ID` env (default 18780 preserved).
- `scripts/stop-devnet-node.sh <total-nodes> <node-id>` — stop a single
  node from a running cluster (T2/T4 chaos helper).
- `scripts/start-devnet-node.sh <total-nodes> <node-id>` — restart a
  single stopped node, preserving its leveldb + config.
