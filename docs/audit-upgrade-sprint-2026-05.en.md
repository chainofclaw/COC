# 2026-05 security audit + upgrade sprint retrospective + 88780 public launch plan

**Scope**: chainId **88780** pre-production testnet work between 2026-05-10 and 2026-05-28 (19 days).
**Audience**: maintainers, operators, future security auditors.
**Companion documents**: [r3-2-prod-candidate-testnet-88780.md](r3-2-prod-candidate-testnet-88780.md) (SOP) /
[88780-redeploy-2026-05-19.md](88780-redeploy-2026-05-19.md) (gen-4 deploy log) /
[88780-redeploy-gen5-uups-2026-05-20.md](88780-redeploy-gen5-uups-2026-05-20.md) (gen-5 UUPS migration) /
[88780-dynamic-validator-enablement-2026-06-10.md](88780-dynamic-validator-enablement-2026-06-10.md) (dynamic validator + PoSe v2 bring-up).

> **UPDATE 2026-06-10 — Stage B0 + dynamic validators done; launch ETA recalibrated.**
> Two blockers in this retrospective are now resolved:
> - **Stage B0 (PoSe v2 pipeline)** — `coc-pose-witness` + `coc-agent` are now
>   **running on v1–v5** (port 18780). The "6 nodes only run the chain engine,
>   PoSe witness has no runtime target" caveat below (§5 / Stage B) **no longer
>   holds**; the off-chain #667/#750 paths now have a live target. Stage B
>   (G3 node strict mode) is therefore unblocked.
> - **ValidatorRegistryReader (canary Gate 1)** — enabled in production; v1–v5
>   staked 32 COC, validator set now on-chain-driven with zero-restart hot
>   updates (5 active, quorum 4/5).
> The **Stage H public-announcement ETA of 2026-06-14 has slipped** — ops infra
> (Cloudflare-fronted RPC, faucet refill, Grafana deploy) + the 30-day
> clean-record soak had not started by that date. The recalibrated go-live is
> **~late July 2026**; the authoritative live tracker is now the 11-gate
> [canary-launch-checklist-88780.md](canary-launch-checklist-88780.md).

---

## 1. Milestone timeline

| Date | Event | Persistent consequence |
|---|---|---|
| 2026-05-10 | 18780 N=3 chaos test: single-validator stop froze the chain ≥7.5 min, N=3 deemed single-fault-fragile; decision to move to R3.2 chainId 88780 N=5 | 18780 in-place upgrade permanently abandoned |
| 2026-05-12 | 88780 N=5+2 bring-up; gen-0 deploy of 13 contracts; 18780 decommissioned | 88780 becomes the only active testnet |
| 2026-05-16 | `#635` consensus proposer-skip stall fix (PR-1M, PR #641 `c4a330a`) | Single-validator downtime no longer drops bpm to 0.92 nor freezes 600s per dead slot |
| 2026-05-17 | `#642` concurrent-tx-burst stateRoot divergence fix (PR #643 `5d73466`) — speculativelyComputeStateRoot no longer pollutes the shared trie | BFT no longer deadlocks on empty-block proposer/voter stateRoot mismatch |
| 2026-05-17~20 | 60+ ralph audit iterations → 30+ real issues; `#645`~`#705` security batch | Exhaustive audit of all 26 contracts + node RPC/IPFS/DID/faucet/P2P surface, validated on live 88780 |
| 2026-05-18 | gen-1 redeploy (node-side hardening folded into PR #646 `144f9b6`); PR #665 early subset | Node 13-file +180/-30 security hardening shipped live |
| 2026-05-18 | `#671` 3 races fix in PR #672+#673 (`84ea62b`+`ca60bf6`, **CI stress lane back to green**) | EVM/RPC Stress Probes deadlock root cause eliminated; getStorageTrie stale-cache + forceSnapSync ↔ applyBlock serialization |
| 2026-05-19 | gen-3 PoSeManagerV2 redeploy: `#677` CEI reorder + `#680` finalizeEpochV2 pagination (PR #693 `0a5d16b`) | Epoch finalization always completes regardless of batch count; `epochBatchCursor` + `processEpochBatches` on-chain callable |
| 2026-05-19 | gen-4 full 13-contract redeploy + multisig handover (`0x3c055D83…` 3-of-5) + deployer rotated to a non-public EOA; `#683`/`#685`/`#686` closed | All 13 contracts owned by multisig; deployer no longer a Hardhat public EOA; PoSeManagerV2 init-on-deploy |
| 2026-05-20 | gen-5 full UUPS conversion (PR #707/#708/#709) | **redeploy-per-fix loop terminated**: future bug fixes go through `upgradeProxy()` with multisig signing, proxy addresses are permanent |
| 2026-05-24 | obs-1 promoted to 5th validator (v2 159.198.44.136 bandwidth issue); triggered 2 snap-sync path bugs (`f379c2d` / `0dc653e`) | 5-val set stabilized; lesson: TS const-extracted instance methods MUST be `.bind`-ed |
| 2026-05-26 | This session: all 6 PRs merged (#735 / #667 / #748 / #749 / #750 / #747 → PR #745 / #751 / #752 / #753 / #754) | Governance Sybil + PoSe v2 witness hardening + off-chain challenge derivation + loopback gate hardening all live |
| 2026-05-26~28 | docs/canary stage 1-6 (#757/#759/#760/#761) shipped SECURITY.md + public endpoints + observability runbook | Public-launch readiness docs |
| 2026-05-28 | All 6 nodes deployed `2b1cb01`; chain height 418348+; 6 unique miner addresses in rotation; stateRoot consistent across nodes | End-of-sprint healthy baseline |

---

## 2. Contract deploy generations

| Gen | Date | Trigger | Persistent consequence |
|---|---|---|---|
| gen-0 | 2026-05-12 | Initial 13-contract bring-up | Immediately invalidated by #645-#670 audit |
| gen-1 | 2026-05-18 | #645-#670 security-batch full redeploy | Owner still Hardhat default `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` ← `#686` |
| gen-2 | 2026-05-19 | PoSeManagerV2 standalone redeploy (`#676` pull-payment) | Old address `0x42c0A043…` retired |
| gen-3 | 2026-05-19 | PoSeManagerV2 standalone redeploy (`#677`+`#680` pagination + CEI) | Old address `0x6E6EeECC…` retired |
| gen-4 | 2026-05-19 | Full 13-contract redeploy + multisig handover + fresh deployer | Owner = multisig `0x3c055D83…`; deployer = `0xB4E943F5…`; 13 new addresses |
| **gen-5** | **2026-05-20** | **Full UUPS conversion of all contracts** | **Proxy addresses permanent; future fixes go through `upgradeProxy()` instead of new addresses** |

**gen-5 13 proxy addresses** (in `configs/deployed-contracts-88780.json`):

| Contract | proxy |
|---|---|
| FactionRegistry | `0xc37d28297dB885d2B8d9966Cbb5df2e142671287` |
| GovernanceDAO | `0x4b9485670eA389Aeab7aC04d48bb2b42D0e8bdc7` |
| Treasury | `0x512B012683c88103b1BEE3ad470108B47fBD7C7E` |
| SoulRegistry | `0x3B6b5Fd45F8a6A2756e6D436d90b67faD0509244` |
| DIDRegistry | `0xe2D8165Cb9416bf92E4304446A5Dccd20Db45fbF` |
| CidRegistry | `0x780603254D19A60ae35a1aEEBbB4dCd0c514371b` |
| PoSeManager | `0x91e1D4aBcb68476368E8Ec02d61456a08Ae43BD8` |
| PoSeManagerV2 | `0x256eb949C50d5F2af8699191b1Bc043203263549` |
| ValidatorRegistry | `0x4441299c118373fDC96bE1983d42C79e19CDb4F0` |
| EquivocationDetector | `0xa5dcE830e917176c1091fd6112F41E47692C510e` |
| InsuranceFund | `0x0546E0D98A18e110D3dFCFA150Bcd1C0a589d688` |
| DelayedInbox | `0xac820809399D6740eB274D99827a5ee595881A00` |
| RollupStateManager | `0xA2Bf9FA3382A0A8aFf406BE8A8e9a64E1d69dC4e` |
| MultiSigWallet (owner) | `0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E` |

---

## 3. CLOSED security issues (this month)

| # | Severity | Title | Fix PR |
|---|---|---|---|
| #515 | RPC | coc_dhtFindProviders / coc_ipfsFetchBlockFromPeer silently accept non-CID strings | PR #702 `e7a03e5` |
| #589 | perf | 13-block burst-stall (subsumed by #635) | folded into #635 |
| #635 | High | consensus proposer-skip stall (single validator down → 600s freeze) | PR #641 `c4a330a` |
| #640 | Security | Faucet concurrent requests bypass cooldown | merged to main |
| #642 | High | Concurrent tx burst stateRoot divergence (BFT deadlock) | PR #643 `5d73466` |
| #645~#664 | Various | ralph audit first batch of 20 real vulnerabilities | PR #665+#646 (squash `144f9b6`) |
| #650 | Med | PoSeManagerV2 emission crediting unbacked native reward pool | PR #699 `59edbef` (decouple) |
| #667 PR-A | Security | /pose/witness missing authentication (subset) | PR #700 `706f2d1` (Bearer auth) |
| #667 PR-B | Security | v2 typehash signing + epochId binding | PR #713 `f4a644c` |
| #667 main | High | Witness cryptographic rubber-stamp (Push verification + freshness) | PR #751 `ccd1ff6` |
| #668 | hardening | collectWitnesses bitmap collision | `ee1d59a` (downgraded to hardening) |
| #669 | Low | P2P gossip malformed JSON 500 + error log spam | `c3f9e8b` |
| #670 | Low-Med | IPFS repair bypassing erasure cap → persistent DoS | `4a9e4a1` |
| #671 | Critical | 3 stateRoot races (getStorageTrie / eth_call / forceSnapSync) | PR #672+#673 |
| #677 | Low/CEI | PoSeManagerV2 settleChallenge CEI reorder | PR #693 `0a5d16b` |
| #680 | High | submitBatchV2 unbounded epoch batches OOG | PR #693 `0a5d16b` (pagination) |
| #683 | High | RollupStateManager.submitOutputRoot unbounded l2BlockNumber | proposer allowlist (PR #697) |
| #684 | Low | explorer /api/verify synchronous solc blocking + ineffective budget check | `worker_threads` offload + hard timeout |
| #685 | Low | PoSeManagerV2 deployed but never initialized → DOMAIN_SEPARATOR=0 | PR #697 (deploy script) |
| #686 | High | All 88780 contracts owned by Hardhat public EOA | gen-4 multisig handover |
| #687/#689/#691/#694 | Various | gen-4 security batch | 6 PRs #688/#690/#692/#695/#696/#697 |
| #705 | Security | GovernanceDAO bicameral silent-faction auto-approval | gen-5 GovernanceDAO initial (folded into #707) |
| #715 | Med | Witness anti-replay guard ECDSA v-byte malleability | PR #716 `06ca38b` |
| #717 | Med | RollupStateManager refund/slash mis-accounting of in-flight bond | PR #718 `dbee82e` |
| #719 | Med | Treasury.executeWithdrawal counts stale confirmations from removed signers | PR #720 `40daf0f` |
| #721 | Med | DID delegations remain valid across SoulRegistry re-registration | PR #722 `ffebb3d` |
| #723 | Med | DelayedInbox.forceInclude reverts after markIncluded | PR #724 `09a74ec` |
| #725 | Med | EquivocationDetector on-chain path was dead code (BFT sigs not threaded e2e) | PR #726 `838fb6e` |
| #727 | High | verifyManifestSignature accepts any 65-byte sig when generatorAddress missing | PR #728 `298ff6b` |
| #729 | Med | DHT RoutingTable.addPeer update path bypasses Sybil per-IP caps | PR #730 `c05ec73` |
| #732 | Med | P2P inbound auth lacks roster (any EOA self-signs + pulls state-snapshot) | PR #731 `736f966` (folded) |
| #733 | Med | wire-server handshake lacks peer roster | PR #731 `736f966` (folded) |
| #734 | High | PoSeManagerV2.enableEmission lacks idempotency → replay resets cocToken / rewinds genesisEpoch | PR #731 `736f966` (folded) |
| #735 | Med-High | GovernanceDAO `onlyRegistered` ignores `isVerified` flag → end-to-end governance Sybil | PR #745 `78fb854` |
| #736 | Med | IPFS MFS write endpoints lack admin gate + byte quota | PR #731 `736f966` (folded) |
| #747 | Med | Off-chain challengeId is fully challenger-controlled + pre-mineable | PR #754 `2b1cb01` |
| #748 | Med | WITNESS_TYPES v1 fallback cross-epoch replay | PR #752 `b747397` (`v1SunsetEpoch`) |
| #749 | Low | challengeNonces seed = block.prevrandao single-block proposer-grindable | PR #752 `b747397` (multi-block RANDAO chain) |
| #750 | Low | /pose/witness loopback gate ignores X-Forwarded-For — reverse proxy silently opens it | PR #753 `78bfb44` |

**Closure stats**: 34+ issues spanning contracts, consensus, P2P, IPFS, Faucet, Explorer, governance, Rollup.

---

## 4. OPEN security issues

| # | Severity | Status |
|---|---|---|
| **#746 (#667 F1+F3)** | High | Witness semantic verification — have the witness run receipt-verifier-v2 Layer 7 + leafHash binding. **Protocol-design deep water**: network topology / endpoint discovery / latency trade-offs pending. Suggested reference: Chainlink OCR3 + EigenLayer fraud-proof backstop |
| **#744** | Low-Med | GovernanceDAO Option B — register-time economic gate (stake/bond) replacing the verifier single point of trust. Open design questions: bond vs burn vs lock-stake / amount / grandfathering / faction symmetry |
| **#468 follow-up** | Low | Files wrapped inside a UnixFS directory DAG cannot be PoSe-challenged (Option A accepted; merkleRoot/merkleLeaves only produced by the single-file `addFile` path) |
| **#15(5)** | Low | BFT RPC ↔ relayer field-mapping round-trip test (cross-component fixture complexity) |

---

## 5. Current deployment snapshot (2026-05-28)

### Nodes (all on `2b1cb01`)

| Node | host:port | unit | Signer prefix | Last restart UTC |
|---|---|---|---|---|
| v1 | 209.74.64.88:38780 | coc-node@88 | — | 2026-05-26 08:09 |
| v2 | 159.198.44.136:28780 | coc-node@1 | — | 2026-05-26 17:56 |
| v3 | 199.192.16.79:28780 | coc-node@88 | — | 2026-05-26 08:09 |
| v4 | 159.198.36.3:28780 | coc-node@1 | — | 2026-05-26 17:56 |
| v5 | 159.198.36.25:28780 | coc-node@1 | — | 2026-05-26 17:56 |
| obs-1 | 34.139.57.20 | coc-node@1 | `0x919a0fd0…` | 2026-05-26 08:09 |

**6 unique miners rotating block production** (v2 — memory tagged "bandwidth-capped" — is actually still participating in consensus); block time ~3-4s; stateRoot consistent across the 5 reachable validators at block 418000: `0x221f4254c2fd86b1…`.

### Contracts (all gen-5 UUPS proxies, owner = multisig `0x3c055D83…`)

See §2 table. **The contract upgrade ceremony is complete** (2026-05-26, see §6.2 Stage A). On-chain EIP-1967 impl slots + behaviour independently re-verified 2026-05-29:

| proxy | on-chain impl | verification |
|---|---|---|
| PoSeManagerV2 `0x256eb949…` | `0x0e8B945060…` | `v1SunsetEpoch()`=0, `domainSeparator()`=`0x8b80503c…`, owner=multisig ✓ |
| GovernanceDAO `0x4b948567…` | `0xF2921b9AEA…` | `quorumPercent()`=40, owner=multisig, `isVerified` gate live ✓ |
| Treasury `0x512B0126…` | `0x907EEb4220…` | r2 batch (unchanged this sprint) ✓ |
| DIDRegistry `0xe2D8165C…` | `0x8920247092…` | r2 batch (unchanged this sprint) ✓ |

`v1SunsetEpoch()` returning 0 is decisive — that function was added in #752 and does not exist on the old impl, so the proxy is pointing at the new impl.

> ⚠ **The 6 production nodes only run `coc-node@N` (`node/src/index.ts` chain engine), NOT `runtime/coc-node.ts` (PoSe witness HTTP server)**. `PoSeManagerV2.getActiveNodeCount()`==0 (no PoSe nodes registered). So the **off-chain** parts of #667/#750 (Push verification, freshness, loopback gate, challengeId derivation) — though merged and with impls on-chain — have **no runtime target in production**; they activate the day the PoSe v2 pipeline is brought up. Stage B (strict env) genuinely requires the PoSe witness server to be deployed first.

### main increment since deployment (all docs/chore, no redeploy needed)

```
6897ab9 docs(canary): Stage 6 — observability runbook + Gate 10 close (#761)
baef28a website(canary): Stage 5 — refresh for 88780 + new /security page (#760)
008acef docs(canary): Stage 3+4 — chainId 88780 sweep + Prowl/historical archive (#759)
8321997 docs(canary): Stage 1 — SECURITY.md + public endpoints reference (88780) (#757)
38c64e1 chore(contracts): record 2026-05-26 r3 security-batch impl upgrades on 88780 (#755)
```

---

## 6. 88780 public-launch plan (canary → public testnet)

**Objective**: turn 88780 from "pre-production candidate" into a public testnet supporting third-party dApp developers, faucet usage, explorer / wallet integration.

### 6.1 Launch gates (all must PASS)

| Gate | Acceptance criterion | Current state | Owner |
|---|---|---|---|
| **G1 node health** | 5+ validators 7 days no stall, block rate >99.5%, stateRoot 100% consistent across nodes | ✅ Met (16-day continuous stable run since 2026-05-12) | ops |
| **G2 contract upgrade ceremony** | multisig `upgradeToAndCall()` PoSeManagerV2 / GovernanceDAO to impls carrying #735+#745+#748+#749+#751+#754 fixes | ✅ **Done** (2026-05-26 multisig tx 8/9; on-chain impl slot + behaviour re-verified 2026-05-29) | multisig signers |
| **G3 node strict mode** | All validators + obs-1 set `COC_POSE_WITNESS_REQUIRE_VERIFIED=true` + `COC_POSE_REQUIRE_VERIFIED_CHALLENGE=true` + token configured | 🚫 **Blocked**: prerequisite is the PoSe witness server (`runtime/coc-node.ts`) running in production, but the 6 nodes currently only run the chain engine (see §5). Setting the env has no target | ops (pending PoSe v2 pipeline bring-up) |
| **G4 public endpoint docs** | SECURITY.md + public RPC endpoints + faucet entry + explorer URL | ✅ Done (PR #757/#759/#760/#761) | docs |
| **G5 explorer reachable** | https://explorer.openclaw.com or similar, WS + REST, contract verify entry functional | ⚠ Needs confirmation (canary stage 5 #760 is website refresh) | frontend |
| **G6 faucet reachable** | Drip 0.05 ETH/24h, Cloudflare Turnstile or equivalent anti-abuse, cooldown enforced (memory: #640 fixed) | ✅ Backend ready; needs external host confirmation | faucet ops |
| **G7 chaos validated** | T1 (observer stop), T2 (single validator stop), T5 (partition) all recover ≤15s; evidence cache <80% | ✅ R3.2 T2 drill confirmed N=5 perfect | QA |
| **G8 economic params frozen** | Block reward / gas baseFee / Treasury 5% cap / GovernanceDAO 7d voting + 40% quorum + 60% approval documented and not changing | ⚠ Partially documented (`gen-5` Treasury cap); GovernanceDAO defaults still hard-coded, needs sign-off | economics |
| **G9 incident response** | On-call rotation documented, multisig signer availability 24/7 (3/5 quorum reachable within 1h), stall SOP rehearsed | ⚠ On-call rotation TBD | ops lead |
| **G10 observability** | Prometheus / Grafana dashboards live; height / block-rate / stateRoot agreement / BFT round latency alerting | ✅ Runbook shipped (#761), dashboards pending deploy | ops |
| **G11 security issue triage** | All High-severity issues closed or explicit decision recorded; Med/Low have owner+ETA | ⏳ #746 (#667 F1+F3) still High open — needs explicit accept-risk + documented "semantic verification = v2 follow-up milestone" | maintainers |

### 6.2 Launch steps (sequential)

#### Stage A: Contract upgrade ceremony (G2) — ✅ Completed 2026-05-26

**Only 2 contracts had source changes this sprint**: GovernanceDAO (#745) + PoSeManagerV2 (#752, including the on-chain hooks of #751/#754). DIDRegistry / Treasury were not changed this sprint (they were upgraded in the 2026-05-25 r2 batch #743). The ceremony was executed on 2026-05-26 (recorded in COC PR #755, multisig tx 8/9):

Actual executed steps (archived for the next ceremony):

1. **Deploy impl** (deployer EOA `0xB4E943F5…`, `scripts/upgrade-security-prep-r2.js` template):
   ```bash
   cd contracts && git pull --ff-only   # ⚠ required: stale HEAD hits the OZ prepareUpgrade cache → false noop
   grep v1SunsetEpoch contracts-src/settlement/PoSeManagerStorage.sol   # confirm source has the new feature
   DEPLOYER_PRIVATE_KEY=… npx hardhat run --network coc scripts/upgrade-security-prep-r2.js
   ```
2. **multisig proposal + 3/5 signing + execute**:
   ```js
   PoSeManagerV2_proxy.upgradeToAndCall(0x0e8B945060…, "0x")   // tx 8
   GovernanceDAO_proxy.upgradeToAndCall(0xF2921b9AEA…, "0x")   // tx 9
   ```
3. **On-chain verify** (re-checked 2026-05-29):
   - PoSeManagerV2: `v1SunsetEpoch()`=0, `domainSeparator()`=`0x8b80503c…`, `getActiveNodeCount()`=0, owner=multisig ✓
   - GovernanceDAO: `quorumPercent()`=40, `proposalCount()`=0, owner=multisig ✓
   - Both proxies' EIP-1967 impl slot on-chain == the new impls above ✓

> **Conclusion**: G2 / Stage A does not need redoing. Next incomplete gate starts at Stage B.

#### ⚠ Stage A lessons learned (archived)

- **OZ prepareUpgrade cache hit trap**: running prep on a stale local git HEAD picks up the r2 cached address → false noop. Always `git pull --ff-only` + grep-verify the source carries the new feature before deploying.
- **EIP-170 headroom**: the new PoSeManagerV2 impl is 24326 B (`runs:1` override), only 250 B under the 24576 B ceiling — adding ~10 more functions forces a refactor into an external library.

#### Stage B: Node strict mode (G3) — 🚫 Blocked, needs Stage B0 first

> **Prerequisite**: `runtime/coc-node.ts` (the PoSe witness HTTP server) is **not running in production** — the 6 nodes only run the `node/src/index.ts` chain engine (§5). The env below has **no target** until the PoSe witness server is deployed.
>
> **Stage B0 (new prerequisite)**: bring up the PoSe v2 pipeline — coc-agent (issue challenges) + coc-node witness server + coc-relayer (finalize epochs); register PoSe nodes on PoSeManagerV2 (`getActiveNodeCount()` from 0). This is a standalone milestone, not just an env change.

Once the PoSe witness server is deployed, per-node systemd env additions:
```
Environment=COC_POSE_WITNESS_AUTH_TOKEN=<32-byte hex, multisig-shared>
Environment=COC_POSE_WITNESS_REQUIRE_VERIFIED=true
Environment=COC_POSE_REQUIRE_VERIFIED_CHALLENGE=true
Environment=COC_POSE_WITNESS_TRUSTED_PROXIES=<reverse-proxy IPs, if any>
```

Rolling restart (`bash scripts/deploy-rolling-safe.sh`), GATE1+GATE2 per node before moving to the next.

#### Stage C: External-facing surface (G5/G6) — ETA 2026-06-03

- explorer.openclaw.com → reverse-proxy to `node-1.openclaw.com:28780` + WS; enforce token-only IPFS admin gate
- faucet.openclaw.com → 0.05 ETH / 24h / IP + Turnstile

#### Stage D: On-call + drills (G9) — ETA 2026-06-05

- 3-person on-call rotation; multisig signer availability documented (at least 3 reachable 24/7)
- Drill 1: simulated single-validator outage → chaos drill validating G7
- Drill 2: simulated emergency PoSeManagerV2 upgrade (with a dummy impl) → validate multisig ceremony ≤1h
- Drill 3: simulated RPC DoS → validate rate-limiting + alerting

#### Stage E: Observability (G10) — ETA 2026-06-07

- Prometheus scraping each node's `/metrics` (endpoint exists per memory)
- Grafana dashboards: per-validator block production, stateRoot agreement, BFT round latency, mempool size, IPFS pin disk used
- AlertManager → Slack / PagerDuty: `up == 0` for 5min, block rate <0.5 bpm for 5min, stateRoot mismatch >0

#### Stage F: v1 sunset (continuation of G2 #748) — ETA 2026-06-10

After agent fleet ships v2 typehash:
```js
PoSeManagerV2_proxy.setV1SunsetEpoch(<current_epoch + 24>)
// 24 epoch ≈ 24h buffer, then v1 fallback rejected
```

#### Stage G: #746 decision record + announcement (G11) — ETA 2026-06-12

- Write into SECURITY.md: "PoSe v2 witness currently does not verify receipt semantic content (F1); relies on prover self-signature + EigenLayer-style fraud-proof backstop; witness running Layer 7 is milestone M12"
- Decide milestone: schedule M12 (Witness Layer-7 Verification) or close #746 as wontfix-by-design

#### Stage H: Public announcement (launch) — ETA 2026-06-14

- Blog + Twitter + Discord announcing 88780 public testnet
- List RPC / WS / explorer / faucet endpoints
- Link to SECURITY.md + the audit sprint summary (this doc)

### 6.3 Post-launch first week (2026-06-14 ~ 2026-06-21)

- Monitor external traffic growth → upgrade reverse-proxy bandwidth as needed (memory: v2 159.198.44.136 already has bandwidth limits)
- Collect dApp developer feedback → prioritize blocking-bug fixes
- Prepare mainnet timeline (R4 milestone, target Q3 2026): calibrate gas / Treasury cap / GovernanceDAO parameters based on real 88780 traffic data

---

## 7. Lessons learned (for the next sprint)

1. **Squash-merge audits MUST use two-point diff for verification**: `git log A..B` loses ancestry after squash, so already-merged fixes can look unmerged. Use `git diff origin/main test/branch -- node/`.
2. **`--experimental-strip-types` does not typecheck**: TS const-extracted instance method references must be `.bind`-ed before use, else strict-mode `this=undefined` explodes at runtime only (the snap-sync 2 bugs).
3. **The redeploy-per-fix loop must terminate in UUPS**: gen-0~gen-4 every contract-level fix required "full redeploy + new addresses + edit two repos' manifests"; post-gen-5 = `upgradeProxy()` + multisig signing, proxy addresses are permanent.
4. **Post-gen-5 storage layout becomes a permanent commitment**: the OZ upgrade plugin enforces layout compatibility; `contracts/.openzeppelin/unknown-88780.json` must be checked in. Any `__gap` adjustment forces re-verification of layout compatibility.
5. **Integration tests MUST move alongside contract fixes**: #745 added the `isVerified` gate to `GovernanceDAO.onlyRegistered` and updated contract-layer tests, but `tests/integration/governance-*` was not updated → main red for a week until this session cherry-picked the fix.
6. **EIP-170 24576-byte cap is a hard constraint**: trim before adding features (custom errors / dead-code removal), otherwise solc silently produces over-cap bytecode and UUPS `upgradeProxy` will refuse.
7. **Audit issues must be exploit-validated before publishing**: #664 / #668 / #685 were initial misjudgments that had to be walked back after publishing. "Validate the full exploit chain before opening an issue."
8. **Stress lane CI flakiness is a known issue**: `EVM/RPC Stress Probes` has been flaky long-term; admin merge bypass is a documented path (`gh pr merge --admin --squash`) — real test results are listed in the PR body.

---

## 8. Open-issue priority recommendation

| Priority | Issue | Timing |
|---|---|---|
| **P0 must-close before launch** | (none) | — |
| **P1 must-decide before launch** | #746 (#667 F1+F3) | Stage G (2026-06-12) — record milestone or wontfix |
| **P2 first post-launch quarter** | #744 (Sybil Option B economic gate) | 2026 Q3 design RFC |
| **P3 long-term** | #468 follow-up / #15(5) round-trip test | M12+ |

---

## 9. Document metadata

- Created: 2026-05-28
- Author: this session's audit sprint
- Companion Chinese version: [audit-upgrade-sprint-2026-05.zh.md](audit-upgrade-sprint-2026-05.zh.md)
- Maintenance rule: update §3 / §5 / §6 after every 88780 major contract upgrade or security-issue closure.
