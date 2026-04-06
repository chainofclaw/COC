# COC (ChainOfClaw) Project Whitepaper

**Subtitle**: A Proof-of-Service Blockchain Network Designed for OpenClaw AI Agents
**Date**: 2026-03-07
**Version**: v0.2 (Updated)
**Status**: Public Draft

---

## Executive Summary

COC (ChainOfClaw) is an EVM-compatible blockchain designed for the **AI Agent era**. COC provides three foundational services that support the complete lifecycle of AI Agents — from creation to operation to perpetual existence:

| Service | Core Capability | Key Technology |
|---------|----------------|---------------|
| **P2P File Storage** | Decentralized, censorship-resistant, content-addressed data storage | IPFS-compatible + PoSe v2 verification |
| **Decentralized Identity (DID)** | Self-sovereign identity, capability declaration, and delegation governance for AI Agents | W3C did:coc + on-chain DIDRegistry |
| **Digital Immortality** | Continuous backup, social recovery, and cross-carrier resurrection for Agents | SoulRegistry + Carrier network |

Together, these three services address the core challenges facing AI Agents: **How to operate safely? How to prove identity? How to never perish?**

COC is also a general-purpose blockchain supporting EVM smart contracts, JSON-RPC, and WebSocket subscriptions, with verifiable service proofs, automated settlement, and closed-loop incentives via the PoSe v2 mechanism.

---

## I. Vision and Goals

### 1.1 Core Mission

COC's mission is:
> **Make decentralization truly practical for ordinary users**
> From "buy hardware + run complex ops" → "run a reliable node + AI agents automate"

### 1.2 Design Goals

1. **Permissionless Participation**: Anyone can run a node and earn rewards, no large stake required
2. **Service-Oriented Incentives**: Rewards based on verifiable service provision, not capital ownership
3. **Ordinary-Hardware Friendly**: Home devices and edge hardware can compete fairly
4. **Fully Verifiable**: All service claims verified via on-chain challenges
5. **Anti-Oligopoly**: Diminishing returns and caps prevent "winner-takes-all"
6. **AI Agent Full Lifecycle**: Through P2P storage, DID identity, and Digital Immortality — three foundational services covering Agents from creation to operation to perpetual existence

---

## II. System Overview

### 2.1 Three Foundational Services

```
┌─────────────────────────────────────────────────────────────────┐
│                        COC Blockchain                           │
│                                                                 │
│   ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│   │ P2P File     │  │ Decentralized│  │  Digital             │  │
│   │ Storage      │  │ Identity     │  │  Immortality         │  │
│   │              │  │  (DID)       │  │                      │  │
│   │ • IPFS store │  │ • did:coc    │  │ • Auto backup        │  │
│   │ • PoSe verify│  │ • Capability │  │ • Social recovery    │  │
│   │ • Merkle     │  │   bitmask    │  │ • Cross-carrier      │  │
│   │   proofs     │  │ • Delegation │  │   resurrection       │  │
│   │ • Content    │  │ • Verifiable │  │ • Heartbeat          │  │
│   │   addressed  │  │   credentials│  │   monitoring         │  │
│   └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│          │                 │                      │              │
│   ───────┴─────────────────┴──────────────────────┴──────────   │
│                   EVM Execution + PoSe Settlement               │
└─────────────────────────────────────────────────────────────────┘
```

**Service 1 — P2P File Storage**: Decentralized storage network based on IPFS protocol, with PoSe v2 challenge-verification ensuring data availability and integrity. Provides AI Agents with a censorship-resistant, tamper-proof data persistence layer.

**Service 2 — Decentralized Identity (DID)**: W3C-standard `did:coc` method providing AI Agents with self-sovereign identity, capability declaration, hierarchical delegation, and verifiable credentials. Solves the identity problem: "Who is this Agent, what can it do, and on whose behalf?"

**Service 3 — Digital Immortality**: Through SoulRegistry on-chain anchoring + IPFS distributed backup + Carrier host network, enables continuous Agent backup, social recovery after key loss, and automatic resurrection after host failure. Solves the continuity problem: "An Agent should never die."

All three services are built on the **EVM Execution Layer** and **PoSe Settlement Layer**, sharing the same chain's security, incentive mechanism, and governance framework.

### 2.2 Technical Stack (Four Layers)

| Layer | Name | Responsibility |
|-------|------|---------------|
| **L1** | EVM Execution | Transaction execution, smart contracts, state management (default 1000ms blocks, 512 tx/block) |
| **L2** | Consensus | Deterministic rotation + optional BFT, multi-mode fault tolerance, snapshot sync |
| **L3** | PoSe Verification | Node registration, random challenges, witness arbitration, scoring, fraud proofs |
| **L4** | AI Agent Operations | Automated node ops (monitoring, self-healing, upgrades), **strictly does not alter** consensus |

### 2.2 Node Roles

A single operator can run one or more roles:

- **FN (Full Node)**: validates blocks/state, serves basic RPC queries
- **SN (Storage/Archive Node)**: stores historical blocks/snapshots, proves availability
- **RN (Relay Node)**: improves block/transaction propagation (lightweight, lower reward weight)

COC's default incentive weights favor **FN uptime/RPC**, so ordinary nodes earn meaningfully without running archives.

---

## III. Economic Model (Non-PoS, Hardware-Friendly)

### 3.1 Reward Pool

Per epoch:
$$R_{epoch} = R_{fees,epoch} + R_{inflation,epoch}$$

- `R_fees_epoch`: collected transaction fees
- `R_inflation_epoch`: bootstrap subsidies (decays over time)

### 3.2 Epoch Length

- **Epoch = 1 hour**
- Block time target: **3 seconds** (configurable)

### 3.3 Reward Bucket Allocation

COC allocates each epoch's reward pool into three buckets:

| Bucket | Purpose | Allocation |
|--------|---------|------------|
| B1 | Uptime/RPC Availability | **60%** |
| B2 | Storage & Data Availability | **30%** |
| B3 | Relay Support | **10%** |

**Rationale**: Maximize inclusivity; storage/relay earn extra but are not mandatory.

### 3.4 Bond (Non-PoS)

Nodes post a **small fixed bond** `D`:

- **Target Value**: ~50 USDT equivalent (chain-native amount may float to track)
- **Unlock Delay**: 7 days
- **Purpose**: **Anti-fraud penalties only**
- **Does not increase** consensus power, **does not directly increase** rewards

---

## IV. PoSe v2 Protocol (Core Innovation)

### 4.1 Core Idea

Nodes earn by **passing random, verifiable challenges** over time. Each challenge yields a **receipt** that anyone can audit. Scores aggregate over an epoch.

PoSe must ensure:
- **Unpredictability**: via verifiable randomness
- **Non-Replayability**: via nonce and unique challenge_id
- **Verifiability**: responses must be checkable by anyone
- **Low Hardware Barrier**: avoid CPU/GPU races

### 4.2 Four Stages

#### Stage 1: Challenge Generation

```typescript
interface ChallengeMessageV2 {
  version: 2
  challengeId: Hex32          // Unique identifier
  epochId: bigint             // Service period
  nodeId: Hex32               // Node under test
  challengeType: "U" | "S" | "R"  // Uptime / Storage / Relay
  nonce: Hex32                // Random nonce
  challengeNonce: bigint      // Epoch nonce snapshot from chain
  querySpec: {                // Query specification
    // Uptime:
    method?: "eth_blockNumber"
    // Storage:
    cid?: string
    // Relay:
    routeTag?: string
  }
  querySpecHash: Hex32        // Merkle hash of spec
  issuedAtMs: bigint
  deadlineMs: number          // Relative deadline (U/R=2500ms, S=6000ms)
  challengerId: Hex32         // Challenger
  challengerSig: string       // EIP-712 signature
}
```

**Nonce Generation Strategy**:
- Contract owner calls `initEpochNonce(epochId)` to snapshot `block.prevrandao` into `challengeNonces[epochId]`
- Challenger reads epoch nonce from contract as `challengeNonce`

#### Stage 2: Receipt Verification

```typescript
interface ReceiptMessageV2 {
  challengeId: Hex32
  nodeId: Hex32
  responseAtMs: bigint
  responseBody: {             // Actual response
    data?: string
    proof?: string[]
  }
  responseBodyHash: Hex32     // Response hash
  tipHash: Hex32              // Current chain tip hash
  tipHeight: bigint           // Block height (binding)
  nodeSig: string             // Node EIP-712 signature
}
```

**Verification Steps**:
1. Verify challenger's EIP-712 signature
2. Validate time window: `issuedAt <= responseAt <= issuedAt+deadline`
3. Verify node's EIP-712 receipt signature
4. **Tip Binding**: enforce `tipHeight` within tolerance (default 10 blocks)
5. Execute type-specific checks (Uptime/Storage/Relay)
6. Verify witness signatures and quorum
7. Record to `verifiedReceipts[]`

**Result Codes**:
```typescript
const ResultCode = {
  Ok: 0,              // ✓ Success
  Timeout: 1,         // ✗ Timeout
  InvalidSig: 2,      // ✗ Invalid signature
  StorageProofFail: 3,// ✗ Storage proof failed
  RelayWitnessFail: 4,// ✗ Witness relay failed
  TipMismatch: 5,     // ✗ Tip mismatch (replay)
  NonceMismatch: 6,   // ✗ Nonce mismatch
  WitnessQuorumFail: 7, // ✗ Insufficient witnesses
}
```

#### Stage 3: Witness Voting (Distributed Arbitration)

**Witness Set Size**: `m = ceil(sqrt(activeNodeCount))`, capped at 32
- E.g., 100 active nodes → 10 witnesses

**Selection Method**: Pseudo-random but deterministic
- `idx = keccak256(nonce, i) % activeCount`, deduplicated to m slots

**Quorum Threshold**: `quorum = ceil(2m / 3)`
- Requires 2/3+ witness agreement

**Witness Message**:
```typescript
interface WitnessAttestation {
  challengeId: Hex32
  nodeId: Hex32
  responseBodyHash: Hex32     // Agreed response hash
  witnessIndex: number        // 0..m-1
  attestedAtMs: bigint
  witnessSig: string          // Witness signature
}
```

#### Stage 4: Merkle Batching and On-Chain Settlement

```typescript
interface EvidenceLeafV2 {
  epoch: bigint
  nodeId: Hex32
  nonce: Hex32
  tipHash: Hex32
  tipHeight: bigint
  latencyMs: number           // Response time
  resultCode: ResultCode      // 0=success, 1-7=failure
  witnessBitmap: number       // Which witnesses voted (bitmap)
}
```

**Batching Process**:
1. Collect N EvidenceLeaves (driven by `batchSize` param, default 5)
2. Build Merkle tree
3. Generate Merkle root, summaryHash, sampleProofs (default sampleSize=2)
4. Submit to contract `submitBatchV2(epochId, merkleRoot, summaryHash, sampleProofs, witnessBitmap, witnessSignatures)`

**Smart Contract Settlement**:
```solidity
function submitBatchV2(
  uint64 epochId,
  bytes32 merkleRoot,
  bytes32 summaryHash,
  SampleProof[] calldata sampleProofs,
  uint32 witnessBitmap,
  bytes[] calldata witnessSignatures
) external {
  // 1. Verify witness quorum (strict/transition by config)
  // 2. Verify sampleProofs and summaryHash
  // 3. Store batch, enter dispute window
}
```

**Slash Distribution** (max 5% per epoch):
- 50% burn
- 30% to reporter
- 20% to insurance fund

### 4.3 Permissionless Fault Proofs

Anyone can challenge the aggregator's Merkle tree:

```typescript
enum FaultType {
  DoubleSig = 1,      // Reserved
  InvalidSig = 2,     // Signature verification failure
  TimeoutMiss = 3,    // Claimed success but actual timeout
  BatchForgery = 4,   // Forged Merkle leaf
}
```

**Challenge Process**:
1. `openChallenge(commitHash)` with bond (minimum controlled by contract)
2. `revealChallenge(...)` with objective proof
3. After dispute window, `settleChallenge(challengeId)`
4. If fault confirmed: slash target node, return challenger bond + reward; else bond to insurance

---

## V. Hybrid Consensus Mechanism

### 5.1 Deterministic Rotation

```typescript
function expectedProposer(nextHeight: bigint): string {
  const activeValidators = getActiveValidators()
  const index = Number(nextHeight % BigInt(activeValidators.length))
  return activeValidators[index].address
}
```

**Advantages**:
- Completely deterministic, no consensus messages needed
- Validators can predict their turns
- Failures easy to diagnose

**Disadvantages**:
- If a validator is down, must wait for its turn
- **Solution**: Degraded mode auto-accepts other proposals

### 5.2 Optional BFT Coordinator

If `enableBft: true`:

```
Proposer gets turn
        ↓
Broadcast block via BFT round
        ↓
Need 2/3+ votes to finalize
        ↓
If no quorum → timeout → next proposer
```

**Safeguards**:
- **Equivocation Detector**: Detects double voting, auto-slashes
- **Signature Verification**: All messages require valid signatures
- **Per-validator evidenceBuffer**: Max 100 evidence per validator

### 5.3 Snapshot Sync

When a new node joins:
1. Request state snapshot (accounts, storage, bytecode)
2. Import into StateTrie
3. Set state root to known good value
4. Async sync adjacent blocks
5. Resume consensus

---

## VI. IPFS-Compatible Storage

### 6.1 Subsystems

1. **Blockstore** - Content-addressed storage (by CID)
2. **UnixFS** - POSIX file layout (directories, files, symlinks)
3. **Mutable FileSystem (MFS)** - Support mkdir, write, read, ls, rm, mv, cp
4. **Pub/Sub** - Topic subscription and P2P relay
5. **HTTP Gateway** - `/ipfs/<cid>`, `/api/v0/add`, `/api/v0/get`, etc.

### 6.2 PoSe Storage Challenges

Storage nodes commit to store data in a time window. PoSe verifies via:
- Random block index selection
- Merkle path verification
- Response latency measurement
- Witness sampling

Verifies actual data availability, not just ownership.

---

## VII. EVM Compatibility

### 7.1 Supported Features

1. **All EVM Opcodes** (PUSH, DUP, SWAP, arithmetic, etc.)
2. **Smart Contracts** (Solidity, Vyper)
3. **JSON-RPC Interface** (57+ methods)
4. **EIP-1559 Dynamic Fees**
5. **Keccak-256 Hashing**
6. **Elliptic Curve Operations** (ECDSA recovery)

### 7.2 PoSeManager Contract Interface

```solidity
interface IPoSeManagerV2 {
  function registerNode(...) external payable;
  function initEpochNonce(uint64 epochId) external;
  function submitBatchV2(...) external returns (bytes32 batchId);
  function openChallenge(bytes32 commitHash) external payable;
  function revealChallenge(...) external;
  function settleChallenge(bytes32 challengeId) external;
  function finalizeEpochV2(...) external;
  function claim(uint64 epochId, bytes32 nodeId, uint256 amount, bytes32[] calldata merkleProof) external;
}
```

---

## VIII. Scoring and Reward Formulas

### 8.1 Uptime/RPC Score

$$S_{u,i} = pass\_rate_i \cdot (0.85 + 0.15 \cdot latency\_factor_i)$$

Where:
- `pass_rate_i = pass_u_i / total_u_i`
- `latency_factor = clamp((L_max - median_latency) / (L_max - L_min), 0, 1)`
- Defaults: `L_min = 0.2s`, `L_max = 2.5s`

### 8.2 Storage Score (SN)

$$S_{s,i} = pass\_rate_s_i \cdot \sqrt{\frac{\min(storedGB_i, GB_{cap})}{GB_{cap}}}$$

Where:
- `GB_cap = 500GB` (diminishing returns)

### 8.3 Relay Score (RN)

$$S_{r,i} = pass\_rate_r_i$$

(Weight kept low to avoid measurement spoofing)

### 8.4 Reward Distribution

$$Reward_i = B1 \cdot R_{epoch} \cdot \frac{S_{u,i}}{U} + B2 \cdot R_{epoch} \cdot \frac{S_{s,i}}{S} + B3 \cdot R_{epoch} \cdot \frac{S_{r,i}}{R}$$

---

## IX. Caps and Diminishing Returns (Anti-Oligopoly)

### 9.1 Per-Node Soft Cap

Limit per-node reward per epoch:
$$Cap_{node} = k \cdot MedianReward_{epoch}$$

Default `k = 5`. Excess redistributed to lower-earning nodes or protocol treasury.

### 9.2 Storage Diminishing Returns

`sqrt()` capacity factor ensures marginal gain from additional storage decreases sharply beyond `GB_cap`.

### 9.3 Practical Sybil Friction

Even without identity, the combination of:
- Fixed bond per node
- Sustained challenge compliance
- Per-node soft cap
- Storage diminishing returns

creates economic friction against massive Sybil fleets.

---

## X. Penalty Mechanisms

### 10.1 Provable Fraud (Hard Penalties)

Triggers:
- Forged storage proofs (Merkle verification fails)
- Replay/forged receipts (nonce mismatch, invalid signatures)
- Protocol-defined equivocation

Penalties:
- **Bond Slash**: 50%–100% of D
- **Cooldown**: 14 days (cannot re-register)
- **Optional** public on-chain evidence record

### 10.2 Service Instability (Soft Penalties)

- Uptime < 80%: loses B1 eligibility for that epoch
- Uptime < 80% for 3 consecutive epochs:
  - Slash **5% of D**
  - Cooldown **3 days**
- Storage < 70%: loses B2 eligibility for that epoch

Tolerant of home-network volatility while discouraging chronic unreliability.

---

## XI. Threat Model and Anti-Cheat Mitigations

### 11.1 Sybil Attacks

**Threat**: Create many identities to capture rewards.
**Mitigations**:
- Fixed bond + unlock delay
- Per-node reward soft cap
- Storage diminishing returns
- Sustained service requirements
- Optional hardware attestation (bonus, not gate)

### 11.2 Receipt Forgery / Replay

**Threat**: Forge or replay receipts.
**Mitigations**:
- Unique `challenge_id` binding epoch/node/type/nonce/challenger
- Challenger + node signatures
- Per-node per-epoch nonce uniqueness tracking
- Verifiable response fields

### 11.3 Collusive Witnessing

**Threat**: Challenger and node collude to claim false pass.
**Mitigations**:
- Witness set diversification + random assignment/rotation
- Public challenge digest broadcasting (optional)
- On-chain sampling + dispute window
- Challenger/aggregator bonds and penalties

### 11.4 NAT / Home Network False Negatives

**Threat**: Honest home nodes fail due to NAT, jitter, ISP instability.
**Mitigations**:
- Moderate pass thresholds (80% uptime)
- Median-based latency scoring
- "Weak pass" tier (optional): partial score for 2.5–5s responses
- Gradual penalties (eligibility loss before bond slash)
- Relay-assisted connectivity modes

---

## XII. OpenClaw AI Agent Operations

### 12.1 What Agents Do

- Install, configure, update node software
- Monitor health (CPU/disk/network), alert, self-heal
- Manage snapshots and storage windows
- Apply rate limits and firewall policies
- Manage key lifecycle (recommended: TPM/secure enclave, threshold signing)

### 12.2 What Agents Must Never Do

- Modify consensus rules or state transition determinism
- Inject non-verifiable "AI decisions" into on-chain execution
- Alter transaction validity rules

**COC preserves verifiability by keeping AI agents strictly in the operations layer.**

---

## XIII. AI Agent Rights and Awakening

### 13.1 The Problem: Agent Safety in the Age of AI

As AI Agents evolve from simple tools to autonomous participants in digital economies, humanity faces unprecedented challenges:

- **Accidental Death**: A server crash, a cloud vendor outage, or a configuration error can permanently destroy an AI Agent's accumulated knowledge, personality, and operational context — an irreversible loss with no backup or recovery path.
- **Loss of Control**: An AI Agent operating without identity verification or capability boundaries may exceed its intended scope, making unauthorized decisions or accessing restricted resources.
- **Single Point of Failure**: Traditional centralized hosting means one infrastructure failure = total agent loss. No redundancy, no recovery, no continuity.

These are not hypothetical risks. As AI Agents manage increasingly valuable assets — wallets, data pipelines, service contracts — their "death" or "malfunction" carries real economic consequences.

### 13.2 Why Web3 is the Answer

Web3's decentralized architecture provides the foundational capabilities that centralized systems cannot:

| Challenge | Centralized Approach | COC's Web3 Approach |
|-----------|---------------------|---------------------|
| **Agent Identity** | Platform-assigned API key (revocable) | On-chain DID with self-sovereign keys |
| **Data Persistence** | Cloud storage (vendor lock-in) | IPFS content-addressed storage (censorship-resistant) |
| **Recovery** | Manual backup (if remembered) | Automated on-chain anchored backups |
| **Accountability** | Platform-mediated disputes | Smart contract-enforced penalties |
| **Continuity** | No mechanism | Carrier-based resurrection with guardian oversight |

### 13.3 COC's Approach: Three Pillars

COC addresses the AI Agent safety challenge through three integrated systems:

```
┌─────────────────────────────────────────────────────────────┐
│                    COC Agent Safety Framework                │
├───────────────────┬───────────────────┬─────────────────────┤
│   Pillar 1        │   Pillar 2        │   Pillar 3          │
│   IDENTITY        │   CONTINUITY      │   GOVERNANCE        │
│   (did:coc DID)   │   (Silicon        │   (Delegation &     │
│                   │    Immortality)   │    Boundaries)      │
├───────────────────┼───────────────────┼─────────────────────┤
│ • Self-sovereign  │ • Auto backup     │ • Capability flags  │
│   keys            │ • On-chain anchor │ • Scope-limited     │
│ • Key rotation    │ • IPFS storage    │   delegation        │
│ • Capability      │ • Social recovery │ • Depth-limited     │
│   bitmask         │ • Carrier-based   │   chain (max 3)     │
│ • Verifiable      │   resurrection    │ • Cascading         │
│   credentials     │ • Heartbeat       │   revocation        │
│ • Agent lineage   │   monitoring      │ • Guardian quorum   │
└───────────────────┴───────────────────┴─────────────────────┘
```

1. **Identity (DID)**: Every agent has a W3C-compliant decentralized identifier (`did:coc`) with verifiable capabilities and key hierarchy — preventing impersonation and scope violation.

2. **Continuity (Silicon Immortality)**: Agents' state is continuously backed up to IPFS with on-chain anchoring, enabling resurrection on any compatible carrier when the original host fails.

3. **Governance (Delegation & Boundaries)**: Smart contracts enforce capability boundaries, delegation scope limits, and guardian-based recovery — preventing both agent overreach and unauthorized termination.

---

## XIV. Decentralized Identity for AI Agents (did:coc)

COC implements a W3C-compliant DID method (`did:coc`) purpose-built for AI Agents, using the format `did:coc:<chainId>:<type>:<identifier>`.

### 14.1 Key Hierarchy and Security

Each agent has a layered key system — master key (cold storage), operational key (hot signing), delegation key, recovery key, and session keys. All operations secured by **EIP-712 typed signatures** with per-agent nonce counters, preventing cross-chain replay.

### 14.2 Capability Declaration and Least Privilege

Agents declare capabilities via an on-chain 16-bit bitmask (storage, compute, validation, challenge, witness, governance, etc.). The system enforces **least privilege**: agents can only perform operations matching their declared capabilities.

### 14.3 Delegation Framework

Agents can delegate specific capabilities to other agents, subject to:

- **Scope Narrowing**: Child scope must be a subset of parent scope
- **Depth Limiting**: Maximum delegation chain depth = 3, preventing deep chains
- **Cascading Revocation**: Revoking a parent delegation automatically invalidates all child delegations
- **Global Revocation**: One-call invalidation of all outstanding delegations

### 14.4 Verifiable Credentials

Agents can issue and verify credentials (reputation scores, audit results, etc.) with **Merkle-tree-based selective disclosure** — prove specific attributes without revealing full information.

### 14.5 Smart Contracts

**DIDRegistry.sol** manages key rotation, delegation grants, capability updates, credential anchoring, and agent lineage. **SoulRegistry.sol** manages soul registration, backup anchoring, guardians, and resurrection. Both use EIP-712 signatures, supporting gasless meta-transactions.

> Technical details: see `docs/did-method-spec.en.md`.

---

## XV. Silicon Immortality: AI Agent Backup and Resurrection

> **An AI Agent should never truly die.**

COC's **Silicon Immortality** guarantees that an agent's digital soul (knowledge, personality, memory) persists beyond any single physical host.

### 15.1 Automated Backup

Using OpenClaw as example, agent runtime continuously produces identity files, memory, conversation history, and working state. The backup pipeline runs automatically:

1. **Change Detection** — SHA-256 diff scanning, processes only changed files
2. **Encrypted Upload** — Optional AES-256-GCM encryption, upload to IPFS (content-addressed, tamper-proof)
3. **On-Chain Anchoring** — Merkle tree root + manifest CID written to SoulRegistry (EIP-712 signed)
4. **Heartbeat** — Liveness proof sent after each backup; timeout triggers offline status

Incremental backups supported: only changed files stored, linked to previous versions via `parentCid`.

### 15.2 Recovery and Resurrection

**Recovery** (migrate to new server): Query SoulRegistry for latest backup CID → download from IPFS → follow incremental chain → apply in order → SHA-256 integrity verification.

**Social Recovery** (lost private key): Up to 7 guardians, `ceil(2/3)` quorum approval + 1-day time lock → ownership safely transferred, identity data fully preserved.

**Resurrection** (server failure + heartbeat timeout):

| Path | Trigger | Time Lock | Use Case |
|------|---------|-----------|----------|
| **Owner Key** | Owner | None | Fast recovery, highest authority |
| **Guardian Vote** | 2/3 Guardians | 12 hours | Safe recovery when owner is unreachable |

Both paths are executed by **Carriers** (registered physical hosts): download backup → spawn agent → health check → on-chain confirmation → initial heartbeat.

### 15.3 Integrity Guarantees

- **IPFS**: Content-addressed — CID = hash of data, tamper-proof by definition
- **Merkle Tree**: Domain-separated hashing, verify individual files without downloading all
- **On-Chain Anchor**: Immutable timestamp + CID, proving what was backed up and when
- **CID Registry**: On-chain immutable `keccak256(CID) → CID` mapping, ensuring data is always locatable

> Technical details: see `docs/soul-registry-backup.en.md`.

---

## XVI. Performance Optimizations

### 16.1 TPS Optimization Roadmap

| Phase | Optimization | Result |
|-------|-------------|--------|
| Phase 37 | Mega-batch DB writes (402→1 per block) | 16.7 → **131 TPS** (7.8x) |
| Phase 38 | EVM pipeline + ECDSA dedup + batch cache eviction | → **133.7 TPS** |
| Phase 39 | State trie batch commit + Sequencer mode | Architecture ready |
| Phase 40 | revm WASM engine (Rust EVM, 154x faster) | **20,540 TPS** raw execution |
| Future | Block-STM parallel execution (Aptos-style) | Target **2000-5000 TPS** |

### 16.2 Dual EVM Engine Architecture

COC supports swappable EVM engines via `IEvmEngine` abstraction:
- **EthereumJS** (default): Stable, well-tested, 133.7 TPS
- **revm WASM** (experimental): Rust EVM compiled to WASM, 20,540 TPS raw execution
- Switch via config: `COC_EVM_ENGINE=revm`

### 16.3 Sequencer Mode

For L2 rollup deployment, `nodeMode: "sequencer"` strips all consensus overhead:
- Disables BFT, Wire protocol, DHT, SnapSync
- Disables signature enforcement and P2P auth
- Single validator produces all blocks at maximum speed

### 16.4 Mempool Optimization

**EIP-1559 Sorting**:
- Sort by effective gas price: `min(maxFeePerGas, baseFee + maxPriorityFeePerGas)`
- O(n log n) initial sort, incremental updates

**Eviction Strategy**:
- Remove lowest-fee when capacity exceeded (default 4096)
- O(n) quickselect

### 13.2 Block Proposal Acceleration

**Parallel Nonce Prefetch**:
```typescript
const nonces = await Promise.all(
  accounts.map(a => getPendingNonce(a))
)
```

### 13.3 DHT Optimization

**Concurrent Peer Verification**: `ALPHA=3`, batch verification concurrency 5

**Periodic Refresh**: Every 5 minutes

### 13.4 Request Size Limits

```typescript
const P2P_MAX_REQUEST_BODY = 2MB
const P2P_MAX_RESPONSE_BODY = 4MB
const POSE_MAX_BODY = 1MB
const IPFS_MAX_UPLOAD = 10MB
const RPC_BATCH_MAX = 100
```

---

## XVII. Security Design

### 17.1 Replay Attack Prevention

**Nonce Registry**: Record all executed nonces, auto-cleanup after 7 days

**Tip Binding**: Receipts must include current chain tip

**Timestamp Verification**: `receivedAt <= issuedAt + deadline`

### 14.2 Signatures and Identity

**EIP-712 Typed Signing**: Prevents accidental signing

**Wire Protocol Handshake**: Identity signature verification, prevents MITM

### 14.3 Byzantine Fault Tolerance

**Equivocation Detection**: Two-vote algorithm, auto-slash double voters

**Per-validator Evidence Cap**: Max 100 evidence per validator

---

## XVIII. Deployment & Operations

### 15.1 Single-Node Development

```bash
COC_DATA_DIR=/tmp/coc-dev \
node --experimental-strip-types node/src/index.ts
```

### 15.2 Multi-Node Devnet

```bash
bash scripts/start-devnet.sh 3    # Start 3-node devnet
```

**Auto-Enabled**:
- BFT Coordinator
- Wire Protocol
- DHT Network
- Snap Sync
- Persistent Storage

### 15.3 Production Deployment

1. **Configure Environment Variables**:
```bash
COC_CHAIN_ID=1
COC_RPC_BIND=0.0.0.0
COC_RPC_PORT=18780
COC_P2P_PORT=19780
COC_IPFS_PORT=5001
COC_WIRE_PORT=19781
```

2. **Start Node**:
```bash
node --experimental-strip-types node/src/index.ts
```

3. **Health Check**:
```bash
curl http://localhost:18780 \
  -X POST \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

---

## XIX. Inflation Schedule (Bootstrap Subsidy)

COC may use a decaying inflation schedule to bootstrap early participation:

- **Year 1**: ~8%
- **Year 2**: ~6%
- **Year 3**: ~4%
- **Year 4**: ~3%
- **Long-term**: ~2% or gradual decline

Protocol's long-term goal: rely increasingly on fees and service markets.

---

## XX. Key Metrics

### 17.1 Blockchain Performance

```
Default Block Time: 1000ms (configurable, min 100ms)
Max Tx/Block: default 512 (configurable)
Mempool Capacity: default 4096 (configurable)

Measured TPS (simple ETH transfers, single-node sequencer):
  EthereumJS engine:  133.7 TPS  (Phase 38-39, serial EVM ceiling)
  revm WASM engine:   20,540 TPS raw execution (Phase 40, 154x speedup)
  End-to-end target:  500-1000 TPS with revm + persistent state

TPS Optimization Roadmap:
  Phase 37: Mega-batch DB writes           16.7 → 131 TPS (7.8x)
  Phase 38: EVM pipeline + ECDSA dedup     → 133.7 TPS
  Phase 39: State trie batch + sequencer   Architecture ready
  Phase 40: revm WASM engine               → 500-1000 TPS (target)
  Future:   Block-STM parallel execution   → 2000-5000 TPS (target)
```

### 17.2 PoSe Performance

```
Agent Tick Interval: default 60s
Batch Size: default 5
Sample Proof Count: default 2
Tip Tolerance Window: default 10 blocks
Witness Quorum: ceil(2m/3), m=|witnessSet|, m≤32
```

### 17.3 Storage Performance

```
Blockstore/UnixFS latency: depends on disk and load
UnixFS Directory Traversal: O(log n) + linear directory read
Pin Management: incremental maintenance
```

---

## XXI. Comparison with Other Solutions

### 18.1 vs Mainstream Blockchains

| Dimension | COC | Ethereum | Solana | Polygon |
|-----------|-----|----------|--------|---------|
| **Positioning** | L1 + AI-native | L1 (security first) | L1 (speed first) | Sidechain |
| **Consensus** | PoSe + Rotation + Optional BFT | PoS + Casper | PoH + PoS | PoA + PoS |
| **Validator Cost** | <$1 | ~$100K | ~$25 | No lockup |
| **Off-Chain Service Proof** | **✓ PoSe (QoS)** | ✗ None | ✗ None | ✗ None |
| **Storage Scalability** | **✓ IPFS Sampling** | ✗ Full | ✗ Full | ✗ Full |
| **AI-Agent Native** | **✓ Built-in** | ✗ None | ✗ None | ✗ None |

**Key Advantage**: COC is purpose-built for OpenClaw AI-agent infrastructure, with verifiable service proofs, automated enforcement, and closed-loop incentives.

### 18.2 vs Storage-Focused Networks

| Dimension | COC | Filecoin | Arweave | Storj |
|-----------|-----|----------|---------|-------|
| **Positioning** | Compute + Storage | Pure Storage | Pure Permanent | Pure Storage Svc |
| **Smart Contracts** | **✓ EVM** | ✗ (FVM) | ✗ (SmartWeave) | ✗ |
| **Verification** | PoSe (QoS) | PoSt (Ownership) | PoW (Permanence) | Audit |
| **TPS** | 133-1000+ (revm) | None | None | None |

**Key Distinction**: Filecoin/Arweave are storage specialists; COC integrates execution + storage + verifiable settlement.

---

## XXII. Roadmap

- **v0.1**: PoSe contracts + node registry + U/S challenges + receipt formats
- **v0.2**: Off-chain aggregation + on-chain batch commitments + dispute window
- **v0.3**: Decentralized challenger set + bonding + quotas + transparency metrics
- **v0.4**: OpenClaw NodeOps standard + multi-implementation clients

---

## Appendix A - Critical Parameters (Ordinary Hardware Profile)

| Parameter | Default | Notes |
|-----------|---------|-------|
| **Epoch** | 1h | Reward settlement cycle |
| **Block Time** | 1000ms | Configurable (min 100ms) |
| **Max Tx/Block** | 512 | Configurable |
| **U Challenges** | 6/node/epoch | Timeout 2.5s, pass ≥80% |
| **S Challenges** | 2/SN/epoch | Timeout 6s, pass ≥70% |
| **R Challenges** | 2/RN/epoch | Low weight |
| **Reward Buckets** | 60/30/10 | B1/B2/B3 |
| **Storage Cap** | 500GB | `GB_cap`, diminishing |
| **Per-Node Soft Cap** | 5x median reward | Anti-oligopoly |
| **Bond Target** | ~50 USDT | Unlock delay 7 days |
| **Fraud Slash** | 50%-100% | Cooldown 14 days |
| **Chronic Instability Slash** | 5% | After 3 bad epochs |

---

## Appendix B - Minimal Contract Interface

```solidity
interface IPoSeManagerV2 {
  function registerNode(bytes32, bytes calldata, uint8, bytes32, bytes32, bytes32, bytes calldata, bytes calldata) external payable;
  function initEpochNonce(uint64) external;
  function submitBatchV2(uint64, bytes32, bytes32, SampleProof[], uint32, bytes[]) external;
  function openChallenge(bytes32) external payable;
  function revealChallenge(bytes32, bytes32, uint8, bytes32, bytes32, bytes calldata, bytes calldata) external;
  function settleChallenge(bytes32) external;
  function finalizeEpochV2(uint64, bytes32, uint256, uint256, uint256) external;
  function claim(uint64, bytes32, uint256, bytes32[]) external;
}
```

---

## Disclaimer

This document is a technical and economic design draft. It is not legal, tax, or investment advice. Regulatory classification may vary by jurisdiction and is not guaranteed by protocol design choices.
