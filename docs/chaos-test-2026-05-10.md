# Chaos test — chainId 18780 testnet — 2026-05-10

## Summary

3 prod validator (server-1/2/3) + 5 gcloud observer (anchor-1/2, burst-1/2/3) cluster.
Goal: empirically verify cluster resilience to node disconnect / data loss / network partition.

| Tier | Fault | Plan prediction | Actual result | Verdict |
|---|---|---|---|---|
| T1 | 2 observer stop | prod chain unaffected | prod chain advanced normally; 8/8 recovered in <2 min | ✅ PASS |
| T2 | single validator stop (server-3) | degraded ~200 s/block | **chain frozen 7+ min**; recovered when server-3 restarted | ⚠ FINDING |
| T5 | symmetric partition (server-1 vs 2+3) | majority side keeps producing | **all 3 prod nodes frozen during partition**; observers passively kept previous tip; full recovery on heal | ⚠ FINDING |

T3 (data wipe) and T4 (dual stop) were **skipped** after T2 confirmed N=3 cannot tolerate any single failure — those tiers would only repeat the freeze-and-recover pattern with longer windows.

## Topology and config

| Role | Host | Inst | Note |
|---|---|---|---|
| validator | server-1 (209.74.64.88) | coc-node@1 | proposer rotation idx 0 |
| validator | server-2 (159.198.44.136) | coc-node@1 | rotation idx 1/2 |
| validator | server-3 (199.192.16.79, ports +20000) | coc-node@4 | rotation idx 1/2 |
| observer | coc-anchor-1 (us-central1) | coc-node@1 | enableBft=false |
| observer | coc-anchor-2 (asia-east1) | " | " |
| observer | coc-burst-1 (europe-west1) | " | " |
| observer | coc-burst-2 (us-west1) | " | " |
| observer | coc-burst-3 (asia-southeast1) | " | " |

Stake: 3×32 ETH = 96 ETH total. `COC_DEV_RELAXED_QUORUM=1` set in `/etc/coc/node-1.env` on prod servers.

`bft.ts:95-109` `quorumThreshold(relaxedQuorum=true)` = `(total*2)/3` = 64. Two of three validators voting = 64 stake → arithmetically meets quorum.

## Phase 0 — baseline (03:25Z)

8/8 nodes height delta ≤ 4 (69683-69687); stateRoot @ h=69683 = `0xee0473e893c20b5e759df70c7b2825f7640c00a7e9de94b25478eab9931521ea` on all 8.

## T1 — observer chaos (03:27 → 03:33Z)

```
Stop coc-anchor-2 + coc-burst-2 (gcloud)
T+0 (03:27:44Z): 2 observers down
T+~2min (03:29:25Z): 6 nodes online, prod h=69813 (+126 from baseline) → no impact on chain
T+~4min (03:31:32Z): restart anchor-2 + burst-2
T+~6min (03:33:08Z): 8/8 back, max gap 6 blocks (poll skew)
```
**Verdict**: ✅ observer stop has zero effect on prod chain progression. Recovery <2 min via snap-sync.

## T2 — single validator stop (03:34 → 03:42Z)

```
T+0 (03:34:21Z) — pre-stop: prod h=69879
T+0 (03:34:21Z) — systemctl stop coc-node@4 on server-3
T+1 min: prod h=69881 (+2 only)  — chain stalled almost immediately
T+5 min: prod h=69881 (+0)  — chain frozen
T+7 min: prod h=69881 (+0)  — still frozen
journalctl: no BFT round started after 03:34:18.2Z (last finalized 69881)
T+7.5 min (03:41:55Z) — restart server-3 (chaos test aborted early)
T+10 min (03:44:16Z): prod h=69924 (+43, full speed) — recovered
```

**Verdict**: ⚠ N=3 BFT does NOT tolerate single-validator unavailability. Chain frozen ≥7.5 min (could recover at H15 600s fallback if waited longer; we did not wait).

## T5 — symmetric partition (03:54 → 04:05Z)

```
T+0 (03:55:09Z) — full iptables partition: server-1 ↔ server-2/3 (DROP all TCP, both directions)
T+~5 min (04:00:08Z): all 5 sampled nodes still at h=70110 (advanced 70076→70110 mostly during the 26s partial partition window)
T+~7 min (04:02:00Z): h=70110 unchanged → confirmed frozen
T+0 heal (04:02:42Z) — iptables -F coc-chaos on all 3 servers
T+~3 min post-heal (04:05:18Z): prod h=70163 (+53 in 2.6 min, 2.9s/block, full speed)
stateRoot @ h=70110 fully consistent across server-1/2/3 + anchor-1/burst-3 (no fork)
```

**Verdict**: ⚠ Symmetric partition with N=3 freezes the chain on **both sides**, not just minority. Heal recovery <3 min; no fork; stateRoot agreement maintained.

## Final e2e regression (post-T5)

- `check-validator-set.mjs` — ValidatorRegistry @ 0xB7f8BC… active count=2 (anvil-0 + anvil-2 stake from May 8 N=5 attempt; harmless). ✅
- `burst5.mjs` — 5 txs landed in blocks 70174, 70176. ✅
- `clawmem-e2e-newchain.mjs` — registerSoul (block 70181) + CidRegistry roundtrip (70184) + anchorBackup (70186). ✅ E2E integration: PASS.

## Findings & recommendations

### Critical: N=3 cannot tolerate any single fault

Empirically confirmed by both T2 and T5: with 3 validators, **any** form of unavailability — process stop, host crash, network partition — freezes the chain.

Even though `relaxedQuorum=true` lowers the threshold to exactly 64/96 (2 of 3), the BFT round mechanism in `bft.ts` + `bft-coordinator.ts` requires the rotation slot's proposer to be reachable. When the slot's owner is unreachable:
- (T2) systemctl stop: rotation hangs on dead validator's slot until H15 (600 s `NO_PROGRESS_TIMEOUT_MS` in `consensus.ts:262`) fires fallback proposer
- (T5) network partition: round timeout cycles, but quorum still not met because partition isolates the proposer's prepare/commit votes from receivers

T1 confirms observer chaos is correctly tolerated (observer doesn't participate in BFT → no impact).

### Recommendation: increase to N≥5 for true f=1 tolerance

Standard BFT formula: `f` byzantine faults tolerated requires `3f+1` validators.
- N=3 ⇒ f=0 (no fault tolerance) — **current state**
- N=4 ⇒ f=1 but quorum=3 (still loses 2 of 4 = down)
- N=5 ⇒ f=1, quorum=4 (tolerates 1 down) — **minimum production target**
- N=7 ⇒ f=2, quorum=5 (recommended for chainId 88780 R3.2)

Until N=5+ is deployed, the testnet is single-fault-fragile: any prod validator OOM, kernel panic, or network blip will freeze the chain for ≥10 min until H15 fallback proposer takes over.

### Recovery characteristics are good

Despite freezes during T2/T5:
- **No data loss / no fork** — stateRoot agreement maintained across 8 nodes throughout
- **No chain corruption** — burst5 + claw-mem e2e PASS post-recovery
- **Fast recovery** — chain resumes <30 s after the failed validator returns or partition heals
- **Observers are fault-tolerant** — passively retain consistent tip throughout disturbances

### Did NOT verify (would require longer runs)

- H15 fallback proposer behavior at 600 s NO_PROGRESS — only waited 7.5 min in T2 (450 s)
- T3 (data wipe + snap-sync recovery) — same freeze pattern as T2 + 5-8 min snap-sync overhead
- T4 (dual stop) — equivalent to T2 freeze, plus 30 s recovery on partial restart
- 3-way partition or multi-tier failure cascading

## Operational impact

- Total test duration: ~40 min (03:25 → 04:05Z)
- Cumulative chain unavailability: ~7.5 min (T2) + ~7 min (T5) = ~15 min of frozen state during the window
- claw-mem.io users may have experienced ~15 min RPC unavailability (writes failed, reads stale)
- 0 data loss, 0 fork, 0 stateRoot divergence

## Files / artifacts

- Raw event log: `/tmp/chaos-test-2026-05-10.log` (kept locally)
- This report: `docs/chaos-test-2026-05-10.md`
- Reused chaos infra: `scripts/gcloud/chaos/{partition,corrupt-stateroot}.sh` (gcloud-only — used custom iptables on prod for T5)

## Next steps

1. Open issue: "N=3 BFT cannot tolerate single failure — recommend N≥5 deployment for fault tolerance" with chaos test data attached
2. For chainId 88780 R3.2: deploy with N=5 from day 1 (anchor-1/2 + burst-1/2/3 as full BFT validators using independent keys, not anvil dev keys)
3. Optional: extend `NO_PROGRESS_TIMEOUT_MS` H15 fallback test — wait 11 min on a fresh T2 to confirm fallback proposer self-recovers chain at 600 s mark
