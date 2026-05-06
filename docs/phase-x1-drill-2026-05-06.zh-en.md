# Phase X1 — 7-Validator Cluster + Stop-Core Drill Report

**Date / 日期**: 2026-05-06
**Status / 状态**: Infrastructure landed; first stop-core drill identified a propose-loop integration bug that blocked the acceptance criterion. Rolled back to 3-validator topology to keep testnet alive. Drill rerun deferred to a follow-up after the bug is fixed.

---

## 1. What landed / 已完成

| Step | Outcome |
|---|---|
| **X1.1** keys + addresses for 4 external validators | ✅ anvil indices 5, 6, 8, 9 selected (no overlap with 0-4 / 7 already in use) |
| **X1.2** verify validator-set + stake schema | ✅ confirmed `validators: string[]` + `validatorStakes: {id, address, stake}[]` ; added `stakeOverride` map in `node/src/index.ts` so per-validator stake from JSON config flows into BftCoordinator (previously every validator got the hardcoded 1 ETH default) |
| **X1.3** docker-compose.external.yml + 4 ext-N.json configs | ✅ `coc-ext-1..4` services on bridge `coc-ext-net`, host port range 387xx-397xx; reaches native cores via `host.docker.internal:29780/29782/29784`; configs include all 7 validators in the `validators` array and explicit `validatorStakes` (cores @ 100 ETH, ext @ 200 ETH ⇒ total 1100 ETH; relaxed quorum 733.33 ETH; 4 ext alone = 800 ETH suffices) |
| **X1.4** roll out 7-validator cluster | ⚠ partial: all 7 validators online and wire-handshaked, snap-synced to 212633, briefly advanced to 212635, then stalled with no propose activity from external validators |
| **X1.5** stop-core drill | ❌ failed to demonstrate self-finalization by externals; chain remained at 212635 throughout the 90s drill window with all 3 cores stopped |

## 2. Drill timeline / 实验时序

| UTC | Event |
|---|---|
| 04:02:53 | All 7 validators registered as wire peers |
| 04:03:16 | Externals finished snap-sync to height 212633 |
| 04:07:36 | Cluster advanced to height 212635 with the 7-validator set (one cycle of natural propose) then went silent |
| 04:09:15 | Drill start: `systemctl stop coc-node@1 coc-node@2 coc-node@3` |
| 04:09:46 | +30s into drill — heights still 212635 across all externals |
| 04:10:46 | +90s into drill — heights still 212635 across all externals |
| 04:10:50 | Cores restarted; chain still didn't advance |
| 04:13:57 | Even with all 7 back online, chain stalled at 212635 |
| 04:14:30 | **Rolled back to 3-validator config**; chain recovered to 212643 within 35 s |

## 3. Root-cause hypothesis / 根因推测

The 4 external validators **did not propose blocks during their assigned round-robin slots**. ext-2 (the round-robin proposer for height 212636 with index 4 in the 7-validator array) logs show:

- ✅ snap-sync complete @ 04:03:16
- ✅ wire connections established to 6 peers
- ✅ One successful onFinalized at height 212635 @ 04:07:36
- ❌ No `BFT round started` from ext-2 for height 212636 in the next 2+ minutes (consensus loop should tick every 3s = `blockTimeMs`)

Two competing hypotheses, both diagnosable:

1. **Stale `lastProposedBlock` on cores after validator-set swap**: the natives migrated mid-flight from a 3-validator config (where they were producing blocks) to a 7-validator config. The Phase R3 `lastProposedBlock` cache may carry a block built under the old quorum that the new BftCoordinator refuses to re-broadcast (different validators array invalidates `prepareVotes` shape).
2. **Externals' propose loop is gated on a state we haven't initialised**: e.g. the consensus loop checks `chain.expectedProposer(N)` against `nodeId`; if expectedProposer iteration order differs between ext containers and natives (case sensitivity in addresses, sort order on validators array, etc.), externals would silently skip their slot.

Resolution path is at most a couple of hours of focused debugging:
- Add a one-line debug log at `consensus.ts proposeNextBlock` entry showing `nodeId`, `expectedProposer(currentHeight+1)`, and the boolean `forcePropose`. Run the cluster, observe whether ext-2's loop sees itself as the proposer for 212636.
- Inspect `BftCoordinator` snapshot of validators after applyBlock onFinalized — is the new 7-validator set actually plumbed through, or is BftRound created from an older snapshot?

## 4. What this proves and disproves / 结论

✅ **Proven by this drill**:
- 4 docker validators can be deployed alongside 3 native validators on a single host with non-colliding port ranges and host.docker.internal mesh.
- 7 validators with weighted stakes (1100 ETH total) can wire-handshake and snap-sync as a coherent cluster.
- The `stakeOverride` wiring in `node/src/index.ts` correctly carries `validatorStakes` into BftCoordinator.

❌ **Not yet proven**:
- A live cluster of 7 validators sustaining quorum without manual intervention.
- That **stopping the 3 cores results in the 4 externals continuing to finalize blocks** — which is the actual Day-90 acceptance criterion.

The roadmap claim from `docs/testnet-decentralization-analysis-2026-05-06.zh-en.md` ("after Phase X1, stopping cores leaves the chain alive") is therefore **conditional on the propose-loop bug being fixed**. The infrastructure is half the battle; the runtime integration is the other half.

## 5. Operational state after the drill / 演练后状态

- **Testnet**: rolled back to 3-validator native config; chain at 212643 and progressing; sync-node, light-1, relayer, agent, faucet, explorer all healthy.
- **Repo artifacts retained**: `docker/docker-compose.external.yml`, `docker/testnet-configs/ext-{1,2,3,4}.json`, the `stakeOverride` change in `node/src/index.ts`. Re-running the drill is `docker compose -f docker/docker-compose.external.yml up -d` after the fix lands.
- **/etc/coc/node-{1,2,3}.json on server**: rolled back to 3-validator. The 7-validator copies are NOT preserved on server — re-deploy by re-running the `python3` patch from this session if reusing.

## 6. Follow-up / 后续

| Item | Owner | Target |
|---|---|---|
| Add debug logs in consensus.ts proposeNextBlock + bft-coordinator.ts startRound to capture proposer rotation under 7-validator setup | engineering | next session |
| Identify why ext-2 doesn't fire propose at its rotation slot | engineering | next session |
| Re-run stop-core drill after fix; produce drill v2 report | engineering | next session |
| Phase X2 (ValidatorRegistry contract) **not started** — should not start before X1 drill passes | governance + contracts | week 9 |
| Update `docs/testnet-decentralization-analysis-2026-05-06.zh-en.md` § 4.2 X1 row to reflect "infrastructure deployed; runtime drill needs propose-loop fix" | docs | this commit |
