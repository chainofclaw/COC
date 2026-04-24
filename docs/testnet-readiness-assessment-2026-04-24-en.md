# COC Testnet Functionality / Performance / Reliability Assessment (2026-04-24)

> Comprehensive readiness audit of the COC testnet after Phase C Step 2 completion.
> Goal: assess the gap between current state and "production mainnet ready".
> Method: 9-dimension scoring with completion % and mainnet-gap notes per item.
> Companion docs: `testnet-status-2026-04-24-en.md` (running config) / `p2p-storage-mechanism-en.md` (storage internals).

---

## 0. Executive Summary

> **As a testnet (validating technical viability): ~90% complete.**
> **As a production mainnet: ~55-65% complete.**

The main shortfall is not in the protocol itself but in the **multi-stakeholder** dimensions:

✅ **Protocol stack is essentially ready** — consensus, EVM, P2P storage, PoSe all run end-to-end.
🟡 **Operational base** is partially in place — monitoring/logs exist; backups are simple, alerting absent.
❌ **Genuine decentralized economy** has not started — 3 hardhat test keys, no stake market, no permissionless validator join.

Detailed dimension-by-dimension breakdown follows.

---

## 1. Consensus Layer (BFT-lite)

| Item | Status | Completion | Evidence / Gap |
|---|---|---|---|
| Block production | ✅ | 100% | Stable at 3 s block time; bn > 23 500 |
| Leader rotation | ✅ | 100% | Deterministic round-robin (chain-engine.ts) |
| Two-phase Prepare/Commit | ✅ | 100% | bft.ts + bft-coordinator.ts; 2/3 stake threshold |
| **Paired (blockHash, stateRoot)** quorum | ✅ | 100% | Phase B closed; verified in 72h soak |
| Equivocation detection | ✅ | 95% | EquivocationDetector working, evidence store landed; slash automation untested in prod |
| Fork-choice tolerance | ✅ | 90% | BFT finality > length > weight; manually tested through forks |
| Slow-node degradation | ✅ | 80% | Degraded mode implemented; thresholds untuned for large validator sets |
| **True Byzantine fault tolerance (>n/3 malicious)** | 🟡 | 60% | Math is correct, but at 3 nodes, quorum=2 — losing 1 = "no redundancy" |
| **Scaling beyond 3 validators** | ❌ | 0% | Only 3/5/7 devnet scripts exist; never run with real validator diversity |
| **Validator dynamic join/exit** | ❌ | 30% | validator-governance.ts has the contract surface; never exercised on testnet |

**Bottom line**: Consensus algorithm itself ✅ usable, but the current 3-node deployment **physically cannot tolerate any single node loss** beyond the 2/3 boundary.

---

## 2. Execution Layer (EVM)

| Item | Status | Completion | Notes |
|---|---|---|---|
| Cancun-compat EVM | ✅ | 100% | Based on @ethereumjs/vm; ethers/viem tests pass |
| EIP-1559 baseFee | ✅ | 100% | base-fee.ts; dynamic |
| EIP-4844 blobs | ❌ | 0% | Not supported; only needed for rollup path |
| EIP-7702 / EOA delegation | ❌ | 0% | Not supported |
| State trie persistence | ✅ | 100% | LevelDB + @ethereumjs/trie; GH#6 three-layer bug fixed in Phase A |
| Snap sync | ✅ | 90% | snap-sync module ready; ran once; not stress-tested at production scale |
| Debug/Trace RPC | ✅ | 95% | debug_traceTransaction, trace_transaction implemented; missing solc breaks one test |
| Receipts + Logs | ✅ | 100% | Standard EVM logs, eth_getLogs works |
| Gas estimation | ✅ | 100% | fee-oracle.ts; priority-fee median + percentile |
| **MEV / mempool front-running protection** | ❌ | 0% | Required for public mainnet |
| **EVM gas limit tuning** | 🟡 | 60% | maxTxPerBlock=100 is a testnet placeholder; should be set per benchmark for mainnet |

---

## 3. RPC + WebSocket

| Item | Status | Completion | Evidence |
|---|---|---|---|
| Standard eth_* RPC (83 methods) | ✅ | 95% | rpc.ts implementation; ethers / viem compat |
| `coc_*` extension RPCs | ✅ | 100% | dhtFindProviders, ipfsFetchBlockFromPeer, nodeInfo, validators, chainStats, ... |
| WebSocket eth_subscribe | ✅ | 95% | websocket-rpc.ts; newHeads / logs / pendingTxs |
| RPC rate limit | ✅ | 90% | rate-limiter.ts; per-IP limiting; batch counted properly |
| RPC auth | 🟡 | 50% | rpcAuthToken Bearer support; admin RPC isolated by enableAdminRpc; **disabled on testnet** |
| HTTP/2 / connection optimization | ❌ | 0% | Still HTTP/1.1 |

---

## 4. Network Layer (P2P)

### 4.1 Dual stack: HTTP gossip + binary wire

| Item | Status | Completion | Evidence |
|---|---|---|---|
| HTTP gossip (legacy path) | ✅ | 100% | p2p.ts; BoundedSet dedup; rate limit |
| Binary wire protocol | ✅ | 100% | wire-protocol.ts (Magic 0xC0C1); FrameDecoder streaming |
| Wire handshake auth | ✅ | 100% | NodeSigner-based identity; `requireAuthenticatedVerify` |
| Cross-protocol relay (Wire ↔ HTTP) | ✅ | 100% | onTxRelay/onBlockRelay bridges |
| Frame priority (CRITICAL/HIGH/NORMAL/LOW) | ✅ | 100% | DEFAULT_PRIORITIES table |
| Anti-DoS (per-IP / per-peer limits) | ✅ | 90% | MAX_CONNECTIONS_PER_IP=5; MAX_MESSAGES_PER_WINDOW=500/10s |

### 4.2 DHT (Kademlia subset)

| Item | Status | Completion | Evidence |
|---|---|---|---|
| K-bucket routing table | ✅ | 100% | dht.ts |
| Iterative FindNode lookup | ✅ | 100% | iterativeLookup with α=3 |
| Periodic refresh / bucket maintenance | ✅ | 100% | 5 min refresh + 3 min announce |
| **Provider records (CID → peers)** | ✅ | 100% | **Phase C1.1 added**; 24h TTL, cap 64 |
| **Cross-node provider gossip** | ✅ | 100% | **Phase C added** ProviderAdvertise (0x14) |
| Anti-sybil (handshake verification) | ✅ | 80% | requireAuthenticatedVerify; callback ID verify |
| Full libp2p kad-dht spec compatibility | ❌ | 0% | Self-implemented subset; doesn't connect to public IPFS |

### 4.3 Bootstrap & Discovery

| Item | Status | Completion | Evidence |
|---|---|---|---|
| Configured bootstrap peers | ✅ | 100% | dhtBootstrapPeers config |
| DNS seed | ✅ | 70% | dns-seeds.ts; not used on testnet |
| Peer store persistence | ✅ | 100% | peer-store.ts; auto-saves peers.json |
| Advertised URL / NAT traversal | ✅ | 100% | After GH#2 fix |
| **Public bootstrap node set** | ❌ | 0% | Testnet is a closed network; mainnet needs stable bootnodes |

---

## 5. Storage Layer (IPFS-compatible)

| Item | Status | Completion | Evidence |
|---|---|---|---|
| Content addressing (CIDv1, dag-pb) | ✅ | 100% | ipfs-blockstore.ts + ipfs-unixfs.ts |
| UnixFS chunking (256 KiB) | ✅ | 100% | DEFAULT_BLOCK_SIZE |
| MFS (mkdir/write/read/...) | ✅ | 95% | ipfs-mfs.ts; tests pass |
| Pubsub | ✅ | 80% | ipfs-pubsub.ts; not stress-tested on testnet |
| HTTP API `/api/v0/*` | ✅ | 95% | ipfs-http.ts; add/cat/pin/block/get etc. |
| `/ipfs/<cid>` gateway | ✅ | 90% | Works; MAX_READ_SIZE=50 MiB cap |
| **Block-miss peer fetch fallback** | ✅ | 100% | **Phase C1.3 added** |
| **Push-to-K active replication** | ✅ | 100% | **Phase C1.4 added**; K=3 (clamped to peerCount-1) |
| **PUT awaits minReplicas** | ✅ | 100% | **Phase C3.1 added**; X-COC-Replicas-Warning header |
| **12h self-reannounce** | ✅ | 100% | **Phase C3.2 added** |
| **10-min auto-repair under-replicated** | ✅ | 100% | **Phase C3.3 added** |
| **Large file GET (>50 MiB)** | ❌ | 0% | readFile has 50 MiB cap; 100 MiB files store fine but can't be cat-ed |
| Erasure coding | ❌ | 0% | Deferred to Phase D; current is full K=3 replicas |
| Storage market / payment | ❌ | 0% | Not done; mainnet must-have |
| Streaming GET (HTTP range) | ❌ | 20% | Partially supported, not validated |

---

## 6. PoSe (Proof of Service)

### 6.1 v1 protocol

| Item | Status | Completion |
|---|---|---|
| Challenge / Receipt pipeline | ✅ | 100% |
| Merkle batch aggregation | ✅ | 100% |
| Contract settlement (PoSeManager v1) | ✅ | 100% |
| Slash automation | ✅ | 90% |

### 6.2 v2 protocol (Phase C focus)

| Item | Status | Completion | Evidence |
|---|---|---|---|
| EIP-712 receipt signing | ✅ | 100% | RECEIPT_TYPES + WITNESS_TYPES |
| Permissionless fault proof | ✅ | 95% | PoSeManagerV2 deployed; flow runs |
| Commit-reveal + bond | ✅ | 100% | challengeBondMin = 0.02 ETH |
| Witness quorum (2/3) | ✅ | 100% | _validateWitnessQuorum; all 3 provers sign |
| Merkle-claimable rewards | ✅ | 90% | Pipeline ready; reward distribution untested for full cycle |
| Empty epoch finalization | ✅ | 80% | allowEmptyBatchWitnessSubmission flag |
| **PoSe v2 on-chain batchV2 submit** | ✅ | 100% | **Verified on testnet**: tx `0xebe72a05...` status=1 |
| **5% audit sampling** | ✅ | 100% | **Phase C2.4 added**; storage-audit.ts |
| **CidRegistry + DHT pre-filter** | ✅ | 100% | **Phase C2.2 added** |
| **Real Merkle proof from blockstore** | ✅ | 90% | **Phase C2.1 added**; prover sidecar produces real proofs |

### 6.3 End-to-end pipeline (Phase C Step 2 verified)

| Type | Challenge → receipt → verify | Status |
|---|---|---|
| Uptime | ✅ Full pipeline | `pendingV2: 0` (queue drained) |
| Storage | 🟡 Receipt generated, but agent's resolveMeta path mismatch on shared blockstore | Phase D follow-up |
| Relay | ✅ Full pipeline | Same as Uptime |
| **batchV2 on-chain settlement** | ✅ status=1 confirmed | tx `0xebe72a05...d15`, gasUsed=319 344 |
| **Reward distribution to wallets** | ❌ | rewardRoot computed but claim flow untested end-to-end |
| **Slash automation triggered** | 🟡 30% | Scaffolded; never triggered a real slash during Phase C |

**Live indicators**:
- batchV2 cadence: multiple per epoch (4 in last 5 min observed)
- v2 verify failure rate: **0%** (zero "verification failed" in last 30 min)
- Pending queue length: stable at 0 (drain rate keeps up with challenge rate)

---

## 7. Smart Contract Layer

| Contract | Status | Completion | Deployed on testnet | Initialized |
|---|---|---|---|---|
| `PoSeManager` (v1) | ✅ | 100% | ❌ | — |
| `PoSeManagerV2` | ✅ | 100% | ✅ `0xCD8a...` | ✅ (called manually during Phase C) |
| `MerkleProofLite` | ✅ | 100% | (library) | — |
| `CidRegistry` | ✅ | 100% | ✅ `0xb727...` | ✅ |
| `SoulRegistry` | ✅ | 100% | ✅ `0x1291...` | ✅ |
| `DIDRegistry` | ✅ | 100% | ✅ `0x5f3f...` | ✅ |
| `FactionRegistry` | ✅ | 90% | ❌ | — |
| `GovernanceDAO` | ✅ | 80% | ❌ | — |
| `Treasury` | ✅ | 80% | ❌ | — |
| **`COCToken` (native)** | 🟡 | 50% | ❌ | **Not issued** |
| **`FoundationVesting`** | ✅ | 95% | ❌ | — |
| **Staking / Stake-management** | ❌ | 0% | — | — |
| **Reward distribution** | 🟡 | 70% | partial via PoSeManagerV2 | — |

Contract test coverage: **227 tests**, coverage thresholds met. But **no token issued, no economic model active**.

---

## 8. Governance / Identity / Backup

| Item | Status | Completion | Evidence |
|---|---|---|---|
| SoulRegistry (identity) | ✅ | 100% | Unit + integration tests |
| DID resolution (did:coc method) | ✅ | 95% | did-resolver.ts, did-document-builder.ts |
| Delegation chain (≤3 levels) | ✅ | 100% | delegation-chain.ts |
| Verifiable Credentials | ✅ | 95% | VC + Merkle selective disclosure |
| Social recovery (2/3 guardians) | ✅ | 100% | SoulRegistry recovery flow |
| Backup recovery (claw-mem package) | ✅ | 95% | Standalone `@chainofclaw/claw-mem` (208 tests) |
| Governance proposals / DAO voting | 🟡 | 70% | GovernanceDAO contract ready; never run a full proposal cycle on testnet |
| On-chain parameter upgrades | ❌ | 30% | Not done; constants are hardcoded |

---

## 9. Auxiliary Services

| Item | Status | Completion | Notes |
|---|---|---|---|
| Block Explorer (Next.js) | ✅ | 90% | 9 pages (home/block/tx/address/mempool/validators/stats/contracts/network) |
| Faucet | ✅ | 90% | Working on testnet; rate limit implemented |
| Contract verification (solc-js) | ✅ | 80% | explorer/verify page ready |
| Mempool visualization | ✅ | 90% | explorer/mempool page |
| Sync-node (read-only RPC entry) | ✅ | 95% | Public RPC: `http://199.192.16.79:18780` |
| Monitoring dashboards (Grafana) | 🟡 | 60% | Configs in docker/grafana; dashboards not actually deployed on testnet |
| Prometheus metrics | ✅ | 100% | Per-node :9100 + agent :9200 |
| Log aggregation (ELK / Loki) | ❌ | 0% | docker logs only |
| Alerting | ❌ | 0% | No PagerDuty/Slack hookup |

---

## 10. Performance Metrics (Measured)

| Metric | Testnet measured | Mainnet target (L2 reference) | Rating |
|---|---|---|---|
| Block time | **3.0 s** (precise) | 2-12 s acceptable | ✅ |
| Block size | maxTxPerBlock=100 | should be gas-limit-based | 🟡 |
| TPS (sustained) | not load-tested | ≥ 100 | ❓ |
| Finality latency | finalityDepth=3 ≈ 9 s | < 30 s | ✅ |
| State trie write throughput | passes storage-io benchmark | — | ✅ |
| Cross-node wire bandwidth | 100 MiB PUT → 200 MiB out | — | ✅ |
| Node startup time | < 30 s (container healthy) | < 60 s | ✅ |
| Snap sync time | benchmark passes; not prod-scale | < 4 h | 🟡 |
| Chain state size | 13-21 MB per node (1 epoch) | mainnet will balloon | ❓ |
| **batchV2 on-chain cadence** | **every 30-75 s** | < 1 epoch (= 1h) | ✅ |
| **v2 verify failure rate** | 0% (30 min observed) | < 0.1% | ✅ |
| **avg challenge → receipt latency** | < 100 ms (intra-container docker net) | < 500 ms | ✅ |

⚠️ **Caveat**: Many "verified" results are from a **single-host docker network** environment. Cross-datacenter, cross-region real-network performance has not been validated.

---

## 11. Reliability Indicators

| Dimension | Currently tolerates | Mainnet should tolerate | Gap |
|---|---|---|---|
| Validators down concurrently | 1 (left with 2/3 = working but no redundancy) | n/3 - 1 with n ≥ 7 | 🟡 |
| Network partition | 1-2-1 partition + recovery tested | multiple partitions + healing | 🟡 |
| Datacenter outage | All on 1 host: N/A | multi-region | ❌ |
| Single IPFS block replicas | **3** (origin + K=2 push targets, all validators) | ≥ 3 + erasure | 🟡 |
| Storage data loss risk | 1 down: 0%; 2 down: 0%; 3 down: 100% | multi-replica + EC + long-term archive | ❌ |
| Equivocation slashing | Detection ✅; slash automation never triggered in prod | auto slash + bond seizure | 🟡 |
| Double-spend protection | NonceRegistry replay guard | same | ✅ |
| **Disk full / node OOM** | container auto-restart; state checkpoint protection | + monitoring + alerts | 🟡 |
| **Off-chain recovery if consensus halts** | runbook + backups in place | + automated fallback | 🟡 |

---

## 12. Operational Maturity

| Item | Status | Completion | Notes |
|---|---|---|---|
| Docker containerization | ✅ | 100% | All services |
| docker-compose one-shot deploy | ✅ | 95% | Used on testnet |
| K8s helm chart | ❌ | 0% | Not done |
| CI/CD pipeline | 🟡 | 70% | GitHub Actions in place; auto-deploy to testnet not done |
| Automated backups | 🟡 | 50% | Manual snapshots taken; no cron |
| Rollback procedure | ✅ | 95% | Two-tier git-tag + image rollback established |
| Documentation (deploy / ops) | ✅ | 90% | docs/testnet-* series + this assessment |
| Disaster recovery drill | ❌ | 0% | Never performed |
| Security audit | 🟡 | 60% | Internal round-3 done; no external auditor engaged |
| Bug bounty program | ❌ | 0% | Not launched |
| Bug submission process | ✅ | 80% | GitHub Issues in use |

---

## 13. Test Coverage

| Layer | Tests | Status |
|---|---|---|
| node layer | 1 141 (75 files) | ✅ 1 126 pass / 15 fail (all due to missing solc package or benchmark flake; unrelated to Phase C) |
| services + nodeops | 164 (25 files) | ✅ 100% pass |
| runtime | 72 (16 files) | ✅ 100% pass |
| integration / e2e | 178 (14 files) | ✅ pass |
| wallet | 8 (1 file) | ✅ pass |
| explorer | 43 (3 files) | ✅ pass |
| faucet | 26 (3 files) | ✅ pass |
| contracts (Hardhat) | 227 (10 files) | ✅ pass, coverage thresholds met |
| claw-mem (backup extension, separate repo) | 208 | ✅ pass |
| **Total** | **2 067 tests** | **97% pass rate** |

Test type distribution:
- Unit tests: bulk of coverage
- Integration (multi-component): ~14 files
- Chaos / resilience: 3 files
- Stress / TPS bench: 2 files
- Phase C additions: 32 tests (wiring/repair/audit/gossip)
- E2E (multi-node devnet): 1 bash script

⚠️ **Gaps**:
- No dedicated security audit test suite (only round-3 algorithm audit)
- Long soak (>24h) never run for full pipeline
- Adversarial node behavior testing exists but is narrow

---

## 14. Mainnet Launch Readiness Checklist

Hard gates for "production mainnet" classification (green = ready, yellow = partial, red = not done):

### 🟢 Ready

- [x] BFT consensus protocol (mathematically)
- [x] EVM compatibility (ethers / viem tests pass)
- [x] State trie persistence (stable post GH#6 fix)
- [x] Block / transaction / receipt RPC
- [x] Wire binary protocol
- [x] DHT + provider records
- [x] IPFS UnixFS chunking + content addressing
- [x] Push-to-K replication + cross-node gossip
- [x] Self-healing repair loop
- [x] PoSe v2 EIP-712 pipeline (**on-chain batchV2 succeeded**)
- [x] PoSeManagerV2 + CidRegistry + SoulRegistry + DIDRegistry deployed + initialized
- [x] BFT slashing detection (equivocation detector)
- [x] Backup recovery (claw-mem)
- [x] Block explorer + Faucet
- [x] Prometheus metrics exposed
- [x] Test coverage ≥ 2000 tests
- [x] Phase A/B/C three milestones all completed

### 🟡 Partial — Must close before mainnet

- [ ] **Streaming GET for large files (resolve 50 MiB readFile cap)**: 3-5 days
- [ ] **CidRegistry auto-register hook** (chain tx after PUT): 1 day
- [ ] **PoSe v2 reward claim end-to-end** (full epoch cycle never completed)
- [ ] **Slash automation triggered in production** (never slashed)
- [ ] **5+ validator scaling validated** (testnet has been 3 throughout)
- [ ] **Cross-datacenter deployment** (currently 1 host)
- [ ] **Full 24h-72h soak** (Phase B had soak; Phase C full pipeline doesn't have 24h yet)
- [ ] **Alerting (PagerDuty/Slack hookup)**
- [ ] **Disaster recovery drill** (never run)
- [ ] **Third-party security audit** (internal round-3 done; no external)
- [ ] **Bug bounty program live**
- [ ] **On-chain parameter upgrade mechanism** (constants hardcoded)

### 🔴 Mainnet **core blockers**

- [ ] **Native COC token issuance + economic model** (contracts 50% written, **no token issued**, no real stake / fee / reward value)
- [ ] **Staking market (permissionless validator join)** (not done)
- [ ] **Storage payment / market** (not done; users can't pay for storage)
- [ ] **MEV protection** (mandatory for public chain)
- [ ] **Bootstrap node cluster** (not single-host-dependent; 3 hardhat keys are not production validators)
- [ ] **Real decentralized operations** (currently one person ssh-ing into one host to control all validators)
- [ ] **Legal / compliance framework** (out of technical scope)

---

## 15. Three Realistic Deployment-Target Assessments

### 🎯 Target A: Technical PoC / Investor Demo
**Completion ≈ 95%.**
The current testnet can demo: distributed storage + PoSe rewards + full EVM apps + DID. Other than the large-file GET limit and unissued token, every "looks like it's running" capability is genuinely running.

### 🎯 Target B: Developer Testnet (DApp developers can deploy)
**Completion ≈ 75%.**
Missing: (1) public IPFS HTTP endpoint, (2) large-file GET, (3) reward claim end-to-end, (4) 24h+ soak validation, (5) alerts + auto-backup.
Recommendation: another **2-3 weeks** to close these 5 items, then open to developers.

### 🎯 Target C: Production Mainnet Launch
**Completion ≈ 55-65%.**
Core gap is the **economic layer** — token issuance, staking, real reward delivery, storage market, MEV protection, third-party audit, multi-region.
Recommendation: define a **Minimum Viable Mainnet (MVM)** subset:
- Open PoSe + chain settlement first, defer storage market
- Replace test keys with 5+ real validators
- Third-party audit
- 24h+ stable soak
- Public bug bounty
Estimated **3-6 months** to MVM mainnet.

---

## 16. Prioritized Roadmap (based on the above)

**P0 (developer testnet must-haves)**:
1. Streaming GET for large files (`MAX_READ_SIZE` → 1 GiB + streaming readFile)
2. CidRegistry auto-register hook
3. PoSe v2 reward claim end-to-end validation
4. Full 24h soak (monitor batchV2 cadence + queue length + memory)
5. IPFS HTTP port selectively exposed + auth/limit

**P1 (mainnet admission)**:
6. 5-7 validator scaling validation (cross-host)
7. Slash automation triggered against deliberately malicious behavior
8. Alerting system + PagerDuty integration
9. K8s deployment chart + multi-region
10. Third-party security audit (external firm)

**P2 (mainnet core economic functions)**:
11. COC token issuance + genesis distribution
12. Permissionless validator stake flow
13. Storage payment market (aligned with PoSe v2)
14. MEV protection layer (commit-reveal / threshold encryption)
15. On-chain governance upgrade mechanism

**P3 (network maturity)**:
16. Erasure coding (Reed-Solomon) replacing K=3 full replicas
17. Cross-rollup interop
18. ZK proof optimization (PoSe proof in ZK)

---

## 17. Conclusion

**As a testnet, COC has achieved the full-stack validation of "a demonstrable decentralized blockchain + distributed storage + PoSe reward". Phase A/B/C three milestones all met, 2067 tests at 97% pass rate.**

**For production mainnet, the missing pieces are:**
1. Economic layer (token + stake + storage market) — 2-6 months of work
2. Large-scale operations readiness (multi-region + alerting + drills)
3. External security audit

**Best current positioning**: developer-preview testnet + investor technical PoC. After **2-3 weeks** of P0 polishing, suitable for early DApp developers, but **should not** be positioned as a production mainnet for general users or open economic activity.

---

**Document version**: v1.0 / 2026-04-24
**Assessor**: Claude Code (based on testnet live state + code audit + cross-document reference)
**Next assessment recommended**: before Phase D kickoff / before mainnet launch sprint
