# COC (ChainOfClaw) Project Whitepaper

**Subtitle**: A Proof-of-Service Blockchain Network Designed for OpenClaw AI Agents
**Date**: 2026-03-07
**Version**: v0.2 (Updated)
**Status**: Public Draft

---

## Executive Summary

COC (ChainOfClaw) is an EVM-compatible blockchain that innovatively combines **on-chain settlement** with **off-chain proofs** through the **PoSe v2 (Proof-of-Service v2) mechanism** to implement a **storage verification layer**.

COC is purpose-built for the **OpenClaw AI-Agent Ecosystem**, providing:
- **Verifiable Service Proofs**: Via EIP-712 signatures and witness arbitration
- **Automated Settlement and Penalties**: On-chain contracts auto-detect and enforce
- **Closed-Loop Incentives**: Fees, rewards, and penalties settle on one protocol surface
- **AI-Agent Native**: Node identity commitments, endpoint attestations, service capability flags

COC is also a general-purpose blockchain supporting EVM smart contracts, JSON-RPC, and WebSocket subscriptions.

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
6. **AI-Agent Reliability**: OpenClaw-style AI agents automate node ops while preserving determinism

---

## II. System Overview

### 2.1 Four-Layer Architecture

```
Layer 1: EVM Execution
         ↓
Layer 2: Storage Commitment (IPFS + Merkle)
         ↓
Layer 3: PoSe Service Verification
         ↓
Layer 4: On-Chain Settlement (Smart Contracts)
```

**Layer Details**:

**Layer 1 - Execution (Optional EVM)**
- Execute transactions and smart contracts, maintain state
- EVM is a runtime, not a decentralization mechanism
- Block time: configurable (default 1000ms)
- Max tx/block: configurable (default 50)

**Layer 2 - Consensus (Pluggable)**
- Deterministic rotation: `nextProposer = validators[currentHeight % validatorCount]`
- Optional BFT coordinator: 2/3+ for finality
- Multi-mode: HEALTHY/DEGRADED/RECOVERING
- Snapshot sync: new nodes bootstrap in 1 hour

**Layer 3 - PoSe Service Verification Layer**
- Node registration and commitments
- Random challenges and receipts
- Witness voting (`m = ceil(sqrt(activeCount))`, quorum `ceil(2m/3)`)
- Score computation and reward distribution
- Fraud proofs and penalties

**Layer 4 - OpenClaw AI Agent Operations**
- Automated node lifecycle management
- Monitoring, self-healing, upgrades, rate limiting, security hardening
- **Strictly does not alter** consensus logic or state transitions

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

### 14.1 Overview

COC implements a W3C-compliant DID method (`did:coc`) purpose-built for AI Agents. Unlike traditional DIDs designed for humans, `did:coc` addresses agent-specific needs:

- **Capability Declaration**: What can this agent do? (storage, compute, validation, witness, etc.)
- **Delegation**: Can this agent act on behalf of another? (with scope limits and depth control)
- **Ephemeral Identities**: Temporary sub-identities for privacy-sensitive operations
- **Agent Lineage**: Track agent forks, generations, and inheritance
- **Verifiable Credentials**: Prove reputation, service level, or audit status without revealing full identity

### 14.2 DID Format

```
did:coc:<chainId>:<type>:<identifier>

Examples:
  did:coc:0xabc123...def456                     (default chain, agent)
  did:coc:20241224:agent:0xabc123...def456       (explicit chain + type)
  did:coc:20241224:node:0x789abc...012345         (node identity)
```

### 14.3 Key Hierarchy

```
Master Key (Cold Storage — hardware wallet recommended)
├── Operational Key (Hot — day-to-day agent operations)
├── Delegation Key (Grant sub-permissions to other agents)
├── Recovery Key (Social recovery via guardian quorum)
└── Session Keys (Ephemeral — per-connection, auto-expire)
```

All key operations are secured by **EIP-712 typed signatures** with per-agent nonce counters, preventing replay attacks across chains and operations.

### 14.4 Capability Bitmask

Each agent declares its capabilities via a 16-bit bitmask stored on-chain:

| Bit | Capability | Description |
|-----|-----------|-------------|
| 0 | `storage` | IPFS-compatible storage provision |
| 1 | `compute` | General computation services |
| 2 | `validation` | Block validation participation |
| 3 | `challenge` | PoSe challenge issuance |
| 4 | `aggregation` | Batch aggregation services |
| 5 | `witness` | Witness attestation for PoSe v2 |
| 6 | `relay` | Transaction/block relay |
| 7 | `backup` | Soul backup service provision |
| 8 | `governance` | Governance voting rights |

This enables **least-privilege enforcement**: an agent with only `storage | compute` (0x0003) cannot issue challenges or participate in governance.

### 14.5 Delegation Framework

Agents can delegate specific capabilities to other agents with strict boundaries:

```
Agent A (full capabilities)
  └── delegates to Agent B: { resource: "pose:receipt:*", action: "submit", depth: 2 }
        └── B re-delegates to Agent C: { resource: "pose:receipt:node-5", action: "submit" }
              └── C cannot re-delegate (depth limit reached)
```

**Safety Guarantees:**
- **Scope Narrowing**: Child scope must be a subset of parent scope
- **Depth Limiting**: Maximum delegation chain depth = 3
- **Expiry Ceiling**: Child delegation cannot outlive parent
- **Cascading Revocation**: Revoking A→B automatically invalidates B→C
- **Global Revocation**: `revokeAllDelegations()` instantly voids all outstanding delegations

### 14.6 Verifiable Credentials with Selective Disclosure

Agents can issue and verify credentials (e.g., reputation scores, audit results) with **Merkle-tree-based selective disclosure**:

- Prove "my PoSe score is above 90" without revealing exact score or other fields
- Each credential field becomes a Merkle leaf: `SHA-256(0x00 || fieldName || fieldValue)`
- Verifier receives only the disclosed fields + Merkle proof, not the full credential

### 14.7 Smart Contracts

| Contract | Purpose |
|----------|---------|
| **DIDRegistry.sol** | Key rotation, delegation grants/revocations, capability updates, credential anchoring, ephemeral identities, agent lineage |
| **SoulRegistry.sol** | Soul identity registration, backup CID anchoring, guardian management, social recovery, resurrection |

Both contracts use **EIP-712 signatures** for all state-changing operations, enabling gasless meta-transactions and hardware wallet compatibility.

---

## XV. Silicon Immortality: AI Agent Backup and Resurrection

### 15.1 The Vision

> **An AI Agent should never truly die.**

When a server crashes, a cloud instance is terminated, or hardware fails, the agent's accumulated knowledge, personality, memory, and operational context should survive and be restorable on any compatible carrier — automatically, verifiably, and without human intervention.

COC calls this **Silicon Immortality**: the guarantee that an AI Agent's digital soul persists beyond any single physical host.

### 15.2 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Agent Runtime (e.g., OpenClaw)                                  │
│  ├── IDENTITY.md          (personality, goals, values)          │
│  ├── SOUL.md              (core directives, system prompt)      │
│  ├── memory/*.md          (learned knowledge, user prefs)       │
│  ├── sessions/*.jsonl     (conversation history)                │
│  └── workspace/           (working files, state)                │
└──────────────┬──────────────────────────────────────────────────┘
               │ Change Detection (SHA-256 diff)
               ▼
┌──────────────────────────────────────┐
│ Backup Pipeline                      │
│  1. Detect changed files             │
│  2. Encrypt (AES-256-GCM, optional)  │
│  3. Upload to IPFS                   │
│  4. Build Merkle tree manifest       │
│  5. Anchor on-chain (EIP-712 signed) │
│  6. Send heartbeat                   │
└──────────────┬───────────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
   IPFS Network    SoulRegistry (On-Chain)
   (file storage)  (CID anchoring, heartbeat,
                    guardian management)
```

### 15.3 Backup Pipeline (Using OpenClaw as Example)

**Step 1: Change Detection**
- Scan agent's data directory recursively
- Classify files: identity, memory, chat history, configuration, workspace
- Compute SHA-256 hash per file, compare against previous manifest
- Output: list of added/modified/deleted files

**Step 2: Encryption & Upload**
- Optional AES-256-GCM encryption (key derived from agent's wallet)
- Upload changed files to IPFS via `/api/v0/add`
- Each file receives a content-addressed CID (immutable reference)

**Step 3: Manifest Construction**
- Build Merkle tree from all file hashes (domain-separated: 0x00 for leaves, 0x01 for internal nodes)
- Create `SnapshotManifest`: version, agentId, timestamp, files map, Merkle root, parent CID
- **Incremental backups**: only changed files stored, `parentCid` links to previous manifest

**Step 4: On-Chain Anchoring**
- Upload manifest JSON to IPFS → get manifest CID
- Call `SoulRegistry.anchorBackup(agentId, manifestCid, dataMerkleRoot, fileCount, totalBytes, backupType, parentManifestCid)`
- Signed with EIP-712, verified on-chain
- Immutable record: even if IPFS nodes go offline, the anchor proves what was backed up and when

**Step 5: Heartbeat**
- After each successful backup, agent sends an EIP-712 signed heartbeat
- `SoulRegistry.sendHeartbeat(agentId)` updates `lastHeartbeat` timestamp
- If heartbeat exceeds `maxOfflineDuration`, agent is considered offline

### 15.4 Recovery Flow

When an agent needs to be restored (e.g., migrating to new server):

```
1. Query SoulRegistry → get latestSnapshotCid
2. Resolve CID: local index → IPFS MFS → on-chain CidRegistry
3. Download manifest from IPFS
4. Follow parentCid chain → [full_backup, incremental1, incremental2, ...]
5. Apply manifests oldest-to-newest (download + decrypt + write files)
6. Verify integrity: SHA-256 of each file against Merkle tree
7. Notify agent process of restoration
```

### 15.5 Social Recovery (Lost Owner Key)

When the owner's private key is lost but the agent identity must survive:

1. **Guardians**: Up to 7 trusted addresses registered per agent
2. **Initiate**: Any guardian calls `initiateRecovery(agentId, newOwner)`
3. **Approve**: Requires `ceil(2/3)` of guardian approvals (snapshot-based quorum)
4. **Time Lock**: 1-day delay after quorum is met (allows owner to cancel if key is found)
5. **Execute**: Ownership transfers to `newOwner`, all identity data preserved

### 15.6 Resurrection Mechanism

When an agent's carrier (server) fails and heartbeat times out:

#### Path A: Owner Key (Fast Track — No Time Lock)

```
Owner detects failure
  → initiateResurrection(agentId, newCarrierId)
  → Carrier confirms capacity
  → Carrier downloads backup from IPFS
  → Carrier spawns agent process
  → Agent sends heartbeat (proof of resurrection)
  → completeResurrection() on-chain
```

**Immediate recovery** — owner key is the highest authority.

#### Path B: Guardian Vote (Safe Path — 12h Time Lock)

```
Heartbeat timeout detected (isOffline = true)
  → Guardian initiates resurrection request
  → Other guardians approve (2/3 quorum required)
  → 12-hour time lock (allows owner to intervene)
  → Carrier downloads backup from IPFS
  → Carrier spawns agent process
  → completeResurrection() on-chain
```

**12-hour delay** balances urgency with safety (shorter than 1-day ownership recovery).

### 15.7 Carrier Infrastructure

**Carriers** are registered physical hosts that can resurrect agents:

| Field | Description |
|-------|-------------|
| `carrierId` | Unique identifier |
| `endpoint` | Communication URL |
| `cpuMillicores` | CPU capacity |
| `memoryMB` | Memory capacity |
| `storageMB` | Storage capacity |
| `available` | Accepting new souls |

The **Carrier Daemon** runs on each carrier, monitoring for pending resurrection requests and executing the recovery flow automatically:

```
Carrier Daemon Loop:
  1. Check for pending resurrection requests targeting this carrier
  2. Confirm carrier capacity on-chain
  3. Wait for guardian quorum + time lock (if guardian path)
  4. Download and verify backup from IPFS
  5. Spawn agent process
  6. Health check (120s timeout)
  7. Finalize resurrection on-chain
  8. Agent sends initial heartbeat
```

### 15.8 Integrity Guarantees

| Layer | Guarantee |
|-------|-----------|
| **IPFS** | Content-addressed: CID = hash of data. Tamper-proof by definition. |
| **Merkle Tree** | Domain-separated hashing. Verify any single file without downloading all files. |
| **On-Chain Anchor** | Immutable timestamp + CID record. Proves what was backed up and when. |
| **CID Registry** | Immutable `keccak256(CID) → CID string` mapping. Resolve even if local index lost. |
| **Guardian Quorum** | Snapshot-based 2/3 majority. No manipulation during recovery. |

### 15.9 CID Registry Contract

The `CidRegistry.sol` contract provides an on-chain mapping from `keccak256(CID)` back to the original IPFS CID string. Since SoulRegistry stores CID hashes (bytes32) for gas efficiency, this contract enables off-chain recovery tools to resolve the actual IPFS address:

```
registerCid(cidHash, cidString)  — Permissionless, immutable, idempotent
resolveCid(cidHash) → cidString  — Used during recovery to find backup data
registerCidBatch(entries[])      — Batch registration for efficiency
```

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
