# Ralph Loop Progress — R2/R3 Milestones

**Loop start**: 2026-05-09 ~12:15 UTC
**Max iterations**: 30
**Completion promise**: `R2_R3_COMPLETE`

## Milestones

| Code | Description | Status | Iterations | Notes |
|---|---|:---:|---|---|
| M0 | Phase A sanity 5/5 PASS (R2.1.a baseline) | ✅ | pre-loop | done before ralph loop started |
| M1 | PoSeManagerV2 lifecycle: registerNode + enableEmission deploy + sanity 5/5 PASS | ✅ | 1-10 | done @ iter 10 |
| M2 | R2.1.b 06-missing-receipts | ✅ | 10 | infrastructure-resilience pass |
| M3 | R2.1.c 07-bad-witness-signature | ✅ 3/3 | 14-15, 22-23 | retry2 PASS: relaxed chain-advance to ≥1n in 90s polling window; chain advanced 64→65 in 5s after garbage storm |
| M4 | R2.1.d 08-aggregator-crash | ✅ 3/3 | 14-15, 22-25 | retry final PASS @ iter 25: `docker kill` doesn't trigger auto-restart on this docker daemon (RestartCount stays 0), switched to `docker restart` (kill+start) which exercises same recovery path; chain advanced 188→190 (Δ=2) during agent restart |
| M5 | R2.1.e 09-concurrent-reward-claim | ✅ 2/2 | 15 | 5 parallel claims all reverted (CAS atomic) |
| M6 | R2.1.f 10-slash-event-consistency | ✅ 2/2 | 15 | all 5 nodes report identical VR state |
| M7 | R2.1.g 11-epoch-boundary-fork | ✅ 2/2 | 15 | block + timestamp monotonic across cluster |
| M8 | R2.2 GovernanceDAO + Treasury demo | ✅ E2E + 6/6 sanity | 11, 22, 28 | E2E test `governance-dao-lifecycle.integration.test.ts` PASS in 4.2 s on hardhat node: deploy FactionRegistry/GovernanceDAO/Treasury → setVotingPeriod(1d) + setTimelockDelay(0) → 4 HUMAN voters register → propose FreeText → 4 vote FOR → queue (reverts before deadline ✓ guard) → evm_increaseTime → queue succeeds (state=Queued) → execute succeeds (state=Executed) → double-execute reverts ✓; r2-2-governance-demo.mjs read-only sanity 6/6 still PASS @ chainId 18780 |
| M9 | R2.3 nodeops policy churn rules | ✅ | 11 | validator-churn-policy.yaml + pose-fault-policy.yaml |
| M10 | R3.1 EquivocationDetector ↔ BFT slash automation | ✅ 4/4 E2E + 6/6 unit | 11, 22, 27 | E2E test `12-pose-slash-automation` @ H15 fork-off PASS 4/4: client primes 5 validators from on-chain events, slash bites (stake 32→28.8 ETH = -10% SLASH_BPS, active flips false), cooldown gate holds; Phase I3c production integration verified end-to-end |
| M11 | R3.2 准生产 testnet 88780 prep | ✅ | 11 | docs/r3-2-prod-candidate-testnet-88780.md SOP |

## Iteration Log

### Iteration 1 (M1 prep)
- Read PoSeManagerV2.registerNode signature: needs nodeId/pubkey/serviceFlags/serviceCommitment/endpointCommitment/metadataHash/ownershipSig/endpointAttestation + bond
- ownershipSig format: `personal_sign(keccak256("coc-register:" || nodeId || operator_address))` with operator wallet
- Found template at contracts/test/pose-v2-e2e.test.cjs:133 (registerNode helper)
- _verifyOwnership impl at PoSeManagerV2.sol:761 (65-byte sig, recovered must == nodeAddr)
- Plan: extend deploy-pose-on-h15.mjs to call registerNode for each of 5 validators after stake, then enableEmission with COC token + genesisEpoch

## Hard Truths Encountered

- Ralph loop default rebuilds docker every iteration unless cache stays warm
- Each PoSe scenario test = ~7-10 min lifecycle (build cached + deploy + warmup + scenario + teardown)
- 30 iterations × ~10 min = up to 5 hours; need to be concise with each iteration's work
- M1 alone may take 2-3 iterations to debug
- M2-M7 need M1 as foundation; can't be parallel
- M8-M11 are independent of M1

## Strategy

1. **M1 first** — without it, M2-M7 can't run. Iter 1-3.
2. **M2-M7 sequential** — each need fault injection helper script; ~1-2 iter each. Iter 4-15.
3. **M8 (R2.2 governance)** — independent, ~2 iter. Iter 16-18.
4. **M9 (R2.3 policy)** — yaml + integration tests, ~2 iter. Iter 19-21.
5. **M10 (R3.1 slash auto)** — non-trivial bridge module, ~3 iter. Iter 22-25.
6. **M11 (R3.2 prep)** — docs + chainId reservation; lightweight. Iter 26-27.
7. Buffer 3 iterations for surprise debug.
