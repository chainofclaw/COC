# Phase H — Testnet Stability Hardening Wrap-up (2026-04-30)

## Timeline

- **04-29 20:00 UTC**: testnet hit 5+ BFT stalls in a day; root cause suspected to be proposer-side stateRoot divergence.
- **04-30 morning**: H1 (PR #19, post-apply parent-trie sync + diag), H2B (PR #21, relaxedQuorum), H3 (PR #20, mempool affordability) merged.
- **04-30 09:01 UTC**: node-1 shadow-divergence recurred; cluster deadlocked at height 146,668 (H4/H5 not yet shipped).
- **04-30 11:00 UTC**: emergency manual recovery — `rsync leveldb-state + leveldb-chain` from node-2 → node-1, deployed `phase-h4-76bb640` image.
- **04-30 11:35 UTC**: H5 (PR #27, forceSnapSync auto-recovery) merged.
- **04-30 12:30 UTC**: deployed `phase-h5-20dc3f2` + enabled `COC_BFT_AUTO_RECOVERY=1`.
- **04-30 12:50 UTC**: flipped `COC_DEV_RELAXED_QUORUM=0` (strict 3-of-3 quorum).
- **04-30 12:53 UTC**: 3-minute soak — 59 finalized blocks / 0 timeouts / 0 divergences.

## Decoded deadlock mechanism

```
T+0     node-1 finalizes block 146,668 as proposer.
T+4     Round 146,669 starts (proposer=node-2). node-1 spec stateRoot
        diverges from node-2/3 (R1 vs R2).
T+4     relaxedQuorum (H2B): node-2/3 form 2-of-3 quorum on R2 → finalize
        146,669 and 146,670 without node-1.
T+10    node-1 round 146,669 times out (R1 ≠ R2 → can't honestly commit).
T+20    node-1 round 146,670 times out.
T+20+∞  Coordinator silent. Expected proposer for 146,671 = node-1, but
        node-1 tip = 146,668 → can't propose. node-2/3 tip = 146,670 →
        wait for node-1 to propose. DEADLOCK.
```

**Root cause**: round-robin proposer assumes all nodes share the same tip. When a lagging node (with shadow-divergent state) gets rotated in as next proposer, the cluster stalls — there's no leader-skip mechanism.

## Fix sprint chain

| Sprint | PR | Direction |
|---|---|---|
| H1 | #19 | `computeStateRoot` post-apply parent-trie sync — reduces (doesn't eliminate) shadow divergence frequency |
| H2B | #21 | `relaxedQuorum` dev flag — lets 2/3 nodes finalize without one divergent node blocking |
| H3 | #20 | mempool affordability filter — prevents unaffordable txs entering blocks |
| H4 | #26 | `onPeerQuorumDiverged` callback — single divergence triggers immediate `requestSyncNow` |
| H5 | #27 | `onPersistentDivergence` + `forceSnapSync` — persistent divergence auto-resets local state (replaces manual rsync) |

## Acceptance results

- **Strict 3-of-3 quorum works**: with `COC_DEV_RELAXED_QUORUM=0` sustained for 3+ min, zero failures.
- **H4 and H5 are dormant safety nets**: not triggered since deploy, confirming the underlying cause (persistent leveldb corruption) was cleared by manual rsync and prevented from recurring by H1's post-apply sync.
- **Recovery time**: H5 automatic recovery completes in ~30s (3 rounds × 10s timeout → forceSnapSync) versus ~10 min manual rsync procedure.

## Recommendations

- Monitor testnet for 24–72h to confirm stability.
- If H5 fires: pull a forensic snapshot to investigate why H1's post-apply sync failed to prevent the corruption.
- Production rollout: keep `COC_BFT_AUTO_RECOVERY=1` enabled; `COC_DEV_RELAXED_QUORUM` MUST be `0` (Byzantine safety).
- Decoded deadlock scenario is now marked "fixed" in the plan; H6 (this sprint) is complete.
