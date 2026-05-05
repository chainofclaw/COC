# Phase J — Consensus Self-Recovery Deadzones (2026-05-05)

## Timeline

- **05-04 21:00 UTC**: testnet chain stalls at height 206803→206804.
  Symptoms: node-2 (proposer) shows `prepareVotes=1, buffered=0` looping;
  node-1 has zero BFT activity for 7+ hours; node-3 inactive too. All
  three RPCs respond, P2P peer count = 2 on each. Strict 3/3 quorum
  cannot form.
- **05-05 04:00 UTC**: investigator session opens, identifies stateRoot
  divergence: node-1 reports `0x2a248…` for block 206803, node-2/3
  report `0x3d3877…`. node-1's `state-snapshot` log shows the *correct*
  `0x3d3877…` — leveldb block-header is corrupted but EVM trie is fine.
- **05-05 04:30 UTC**: ruled out: H1 (post-apply parent-trie sync — runs
  pre-apply only), H4 (`onPeerQuorumDiverged` — needs prepare votes to
  scan, none arriving for 206804), H5 (`forceSnapSync` — depends on H4),
  H15b stagger (only fires when `stuckProposer ≠ self`).
- **05-05 04:46 UTC**: manual recovery: stop coc-node-1, move
  `leveldb-{chain,state}` → `*.broken.20260505T0446Z`, restart. Node-1
  snap-syncs from node-2/3, importing 322 accounts at height 206803.
  stateRoot now matches.
- **05-05 04:48 UTC**: node-2's BFT round still stuck after node-1
  recovery — proposer's internal round state never released. Restart
  coc-node-2 → chain instantly resumes; +30 blocks in 60 s, 0 timeouts.
- **05-05 onwards**: Phase J planning + implementation. This document
  covers the J1 + J2 + J3 + L.2 deliverables.

## Decoded deadzones

### Deadzone 1 — H4/H5 require quorum to fire

H4 (`detectPeerQuorumDivergence`) and H5 (`forceSnapSync`) only run from
the BFT round timeout path (`bft-coordinator.ts:614-654`). They scan
prepareVotes for ≥2/3 OTHER-validator agreement on a (blockHash,
stateRoot) the local node disagrees with. With strict 3/3 quorum:

- node-1's leveldb-corrupted state caused chain-engine to reject the
  parent block validation for incoming proposals.
- BFT coordinator never received a valid block to start a round on →
  no `activeRound` → no prepareVotes → `detectPeerQuorumDivergence`
  scans an empty set → returns null → H4 never fires → H5 counter never
  ticks.
- Even if peer prepares arrived, they sat in `pendingMessages` (line
  108) untouched by the H4 detect path.

**Fix (J1)**: detect divergence from buffered prepares directly, plus
hook chain-engine's stateRoot-mismatch rejection into a snap-sync
trigger.

### Deadzone 2 — H15b stagger leaves self-stuck proposers stranded

`checkNoProgressWatchdog` (`consensus.ts:274-323`) returns immediately
when `stuckProposerId === this.nodeId` (line 296), citing "peers handle
the override". But peers' overrides only fire when `getRoundState().active`
returns false — and the self-stuck proposer's coordinator still holds
an active round with self-only prepareVote. Peers send fresh proposes;
the proposer's BFT layer treats them as duplicates of its own active
round and discards. Result: `docker restart` is the only escape.

**Fix (J2)**: when self IS the stuck proposer AND an active round
exists AND elapsed > NO_PROGRESS_TIMEOUT_MS, call the new public
`bft.forceClearRound()` so the next propose tick can start clean.
Throttled at NO_PROGRESS_TIMEOUT_MS (120 s) to give peers room to
deliver fresh votes.

## Fix landings

| Sprint | What landed | Files |
|---|---|---|
| **J1.1** | `BftCoordinator.tryEarlyDivergenceDetect` — fires on every buffered prepare, no round-active prerequisite. Per-height dedup + 1 s throttle. | `node/src/bft-coordinator.ts` |
| **J1.2** | `cfg.onLocalApplyRejected` callback on stateRoot-mismatch path in both engines. | `node/src/chain-engine-persistent.ts`, `node/src/chain-engine.ts` |
| **J1.3** | `index.ts` wiring routes the new callback to `consensus.requestSyncNow`. | `node/src/index.ts` |
| **J2.1** | `BftCoordinator.forceClearRound(reason)` public + structured log. | `node/src/bft-coordinator.ts` |
| **J2.2** | Watchdog self-stuck-proposer branch with `lastSelfClearRoundAtMs` throttle. | `node/src/consensus.ts` |
| **J3** | `tests/multinode-integration/` — docker-compose harness + 2 fault-injection scenarios. | `tests/multinode-integration/` |
| **J4** | 5 new unit tests (3 J1.1, 2 J2.1, 2 J2.2). | `node/src/bft-coordinator.test.ts`, `node/src/consensus.test.ts` |

## Acceptance results

- **Unit tests**: 22/22 in `bft-coordinator.test.ts` (5 new), 21/21 in
  `consensus.test.ts` (2 new), 26/26 in `chain-engine-persistent.test.ts`
  unchanged. Full node-layer suite: 1222/1224 passing; the 2 failures
  (`Benchmark: 100 eth_call invocations`, `Block Production Throughput`)
  are pre-existing performance flakes per
  `docs/90-day-release-roadmap.zh-en.md` line 47, unrelated to J.
- **Type check**: `node --experimental-strip-types --check` clean on all
  modified files.
- **Integration fixture**: docker-compose stack + scenario tests
  type-check; live execution is the J3 manual lane (`docker compose up`
  + scenario runner) and runs in the next dedicated session — these are
  defined as the "Phase 3 Verification" gate before public testnet
  launch.

## Side deliverables (Week 8/9 alignment)

- **K.1 — economics-v1 docs**: `docs/economics-v1.{en,zh}.md` freezes
  testnet block-reward (2 COC initial, 4-year halving), EIP-1559 fee
  distribution (priority fee → proposer), equivocation slashing (100%
  testnet rate, 1000-block cooldown), Treasury/InsuranceFund routing
  (testnet 100/0 default).
- **K.2 — rollout playbook**: `docs/operators/economics-rollout.zh-en.md`
  documents Strategy A coordinated atomic flip, per-feature acceptance
  windows, rollback procedure.
- **L.1 — skills v0.2 spec**: `docs/openclaw-skills-v0.2-spec.md`
  freezes the contract for `pose-status` / `chain-stats` / `health` /
  `upgrade` (CLI, JSON schema, exit codes, error envelopes).
- **L.2 — pose-status skeleton**:
  `extensions/coc-nodeops/skills/pose-status/` ships the canonical
  reference implementation with 3/3 unit tests passing.

## Acceptance — Production J1.1 fingerprint (2026-05-06 W8)

Phase J shipped to clawchain-server as `coc-node:phase-j-local` on
2026-05-05 17:06 UTC. Within 6 minutes of deploy, node-2 emitted:

```
"Phase J1.1: early peer-quorum divergence detected — triggering catch-up"
"BFT peer-quorum divergence — triggering forceSnapSync (H11)"
"forceSnapSync: starting state-snapshot import from peers"
"forceSnapSync: complete"
```

That is the J1.1 → H11 → snap-sync recovery path firing in production
without an operator restart. It confirms the dead H4 path (waiting for
OTHER prepareVotes that never arrive when the local engine refuses
the block) is now bypassed by the buffered-prepare scan from
`addMessage`. Forty minutes of subsequent `phase-j-local` operation
finalized blocks 209233 → 209257 with `prepareVotes=3 commitVotes=2/3`
and zero stalls.

J3 fixture (tests/multinode-integration/) cluster has a config-side
wire-handshake mismatch: validator addresses declared in
`configs/<node>.json` do not match the keys the wire layer signs with,
so the cluster fails BFT bootstrap before J1/J2 paths can be
exercised. This is a fixture issue, not a J runtime issue, and is
queued as a Week 9 followup. The production fingerprint above is the
acceptance signal for J landing on testnet.

## Recommendations

- Fix J3 fixture wire-handshake key alignment (Week 9). Until then the
  scenarios cannot regression-guard J1+J2 in CI.
- Run J3 fixture on a dedicated CI runner weekly (separate lane,
  non-blocking for PRs) before exiting Phase 2 (Week 8 end). The
  scenarios are the only thing currently certifying that J1+J2 stop
  another 2026-05-05.
- Schedule the I1 / I2 atomic flip (K.2 Strategy A) once K.1 § 8 open
  questions are closed by governance — target 2026-05-18.
- Do NOT ship `chain-stats` / `health` / `upgrade` skills until L.1
  spec is reviewed by the OpenClaw plugin reviewer; the
  `schemaVersion: "0.2"` envelope is a public contract.
- Leave `COC_DEV_RELAXED_QUORUM=0` in production. Phase H/J are
  designed around that invariant.
