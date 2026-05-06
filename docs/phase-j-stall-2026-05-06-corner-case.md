# Phase J Corner Case — 2026-05-06 Post-Deploy Stall

## What happened

After landing Phase M1 (metric emit) and gradual-recreating the four
testnet nodes onto `coc-node:phase-j-local-m1` (2026-05-05 21:29 UTC),
the chain advanced 211366 → 211370 cleanly, then stalled at 211371.
A 24h soak (`runId=phase-j-local-w8b`) was started during the stall
and stopped 4 minutes in. Both Phase M1 metrics emitted correctly
throughout and captured the failure in real time.

## Phase J fingerprints fired in production

- **J2.2 self-stuck force-clear** (first prod observation):
  ```
  21:31:07Z node-2  Phase J2.2: self-stuck proposer — force-clearing local BFT round
  21:31:07Z node-2  Phase J2.1: BFT round force-cleared reason=h15b-self-stuck-proposer
  ```
- **J1.1 early peer-quorum divergence detect**:
  ```
  21:34:52Z node-1  Phase J1.1: early peer-quorum divergence detected — triggering catch-up
  21:34:52Z node-1  BFT peer-quorum divergence — triggering forceSnapSync (H11)
  21:34:52Z node-1  forceSnapSync skipped — sync already in flight
  21:35:02Z node-1  BFT peer-quorum sync skipped (cooldown) remainingMs=49698
  ```

J1.1 detect logic worked. The downstream remediation chain did not.

## Corner case — three-way collision

Three independent self-recovery features collided on the same block:

1. **H10 monitor mode** lets the chain accept blocks whose persisted
   `stateRoot` disagrees with the local re-execution result, only
   logging "stateRoot signature mismatch". Three nodes simultaneously
   restarted from `211370` finalized; each re-executed `211371`
   independently and produced a different `stateRoot`:
   - node-1: `0xf9cad6...`
   - node-2/3: `0x3a67e3...`
2. **H11 forceSnapSync cooldown** (≈50s) is meant to prevent
   ping-pong sync. The first J1.1 fire on `211371` raced an
   already-in-flight sync (`forceSnapSync skipped — sync already in
   flight`); the second fire at the next round boundary hit the
   cooldown wall (`remainingMs=49698`).
3. **J1.1 dedup** (`lastEarlyDivergenceFireHeight`) prevents re-firing
   for the same height once it has fired. After the cooldown elapsed,
   J1.1 had already deduped itself for height `211371` and never
   re-fired, so the cooldown gate never re-evaluated.

Result: node-1 keeps proposing/voting `211371` with its own (wrong)
stateRoot; node-2 and node-3 reject node-1's prepare votes (different
stateRoot), so neither side reaches a 2/3 quorum on a single
(blockHash, stateRoot) pair. The chain sits idle until a human
intervenes.

## Why three nodes diverged in lockstep

A simultaneous `docker compose up -d --force-recreate node-1 node-2 node-3`
restarts all three validators in the same second. Each node's BFT
round at `211371` started before the wire-protocol handshake completed,
so each proposed candidate `211371` block was built on a slightly
different mempool / validator-state snapshot. Block `txCount=0` was
identical (empty block), but the `stateRoot` field differed because of
asynchronous validator-set / fee-distribution accounting that can mutate
in the few milliseconds between the three nodes' first round attempt.

In normal operation only one node restarts at a time, so this collision
is rare. We hit it because the M1 deploy used `--force-recreate node-1
node-2 node-3` in one compose call.

## Why M1 / Phase J still landed

- M1 metric emission **worked**: `coc_bft_equivocations_total` reached 14
  on node-2 within 60s of stall and `coc_fork_choice_max_depth_blocks`
  stayed at 0 — exactly the data the alerts needed but never had.
- J1.1 detect logic **fired** (twice on node-1) — the previously dead
  H4 path is not dead.
- J2.2 self-stuck **fired** (once on node-2) — the previously dead
  H15b stuck-proposer-self path is not dead.

The corner case is downstream: **forceSnapSync rejection paths plus
the J1.1 height dedup leave no second chance** when both rejections
hit on the same height. None of those code sites are J's introduction;
all predate Phase J.

## Resolution (2026-05-06, commit `6cfa622`)

Landed in the same week, not Week 9. The fix follows option 2 from the
list below: callback signature changed to return `boolean | void`,
J1.1 snapshots the prior dedup state before the callback and rolls
back on `false`, and `handleMessage` no longer skips the gate on
buffer-deduped retransmits. Production deploy to 3 native validators
+ light-1 + sync-node verified the chain still advances post-restart;
a follow-up corner-case test would need to inject the cooldown +
in-flight collision deliberately to confirm runtime recovery.

## Required Week 9 fix (originally proposed, retained for context)

`node/src/consensus.ts` `peerQuorumSyncCooldown` + J1.1 dedup must
co-operate: when J1.1 detects divergence and forceSnapSync is rejected
("in flight" or "cooldown"), the dedup `lastEarlyDivergenceFireHeight`
must NOT advance — so the next round at the same height re-evaluates
the gate. Equivalent fixes:

- Move the dedup advance from "J1.1 fired" to "forceSnapSync actually
  started" (i.e. not rejected).
- Or: clear `lastEarlyDivergenceFireHeight` when a J1.1 attempt is
  rejected by a downstream cooldown / in-flight check.

The plan-mode work for this lives in Phase Q (Week 9). It is not a
Phase J regression — Phase J is doing exactly what its plan
specified; the dead path it was designed to bridge is now
demonstrably alive.

## Manual recovery

The nearest equivalent to the 2026-05-05 Plan B (clear `node-1`'s
`leveldb-{chain,state}` so it snap-syncs cleanly from peers) is needed
to advance past `211371`. That action is destructive and is left to
the maintainer's call rather than executed automatically by the
session.

Until manual recovery, the testnet is stalled at `211370`.

## Files referenced

- `node/src/consensus.ts` (cooldown logic, J1.1 dedup advance)
- `node/src/bft-coordinator.ts` (J1.1 detect emission site)
- `node/src/chain-engine-persistent.ts` (H10 monitor-mode warn)
- `ops/alerts/prometheus-rules.yml` (now-live equivocation/fork-depth alerts)
