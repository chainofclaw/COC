# COC Blockchain Technical Whitepaper

## Executive Summary

COC (ChainOfClaw) is an EVM-compatible blockchain that innovatively combines **on-chain settlement** with **off-chain proofs** through a **Proof-of-Service (PoSe) mechanism** to implement a **storage verification layer**.
COC is not positioned as a generic narrative clone-chain; it is designed to provide verifiable service and automated settlement infrastructure for the OpenClaw AI-agent ecosystem.

Core Innovations:
- **PoSe v2 Protocol**: Permissionless fault proofs using EIP-712 signatures and witness arbitration
- **IPFS-Compatible Storage**: Every blockchain node can store and verify data
- **OpenClaw AI-Agent Native Design**: COC is built as a trust and settlement layer for autonomous agents, with verifiable service proofs, automated rewards/penalties, and identity registration infrastructure (agent-to-agent collaboration orchestration planned for future versions)
- **Multi-Layer Consensus**: Supports deterministic rotation, degraded mode, and optional BFT coordinator
- **Hybrid Networking**: HTTP gossip + TCP Wire protocol + DHT network running simultaneously

---

## I. Core Philosophy

### 1.1 Problem Statement

Traditional blockchains face three critical challenges:

1. **Poor Storage Scalability**: Every node must store all historical data, leading to prohibitive node operation costs
2. **No Data Availability Guarantees**: No mechanism to verify that off-chain storage actually exists
3. **Over-Reliance on Single Consensus**: BFT is too complex, PoW is wasteful, middle-ground solutions are lacking

### 1.2 Solution Architecture

COC adopts a **layered verification architecture**:

```
Layer 1: EVM Layer (on-chain computation)
         ↓
Layer 2: Storage Challenge (IPFS storage challenge)
         ↓
Layer 3: PoSe Proofs (off-chain service proofs)
         ↓
Layer 4: On-Chain Settlement (Merkle verification & settlement)
```

**Core Principles**:
- **IPFS CIDs serve as PoSe storage challenge inputs**, verifying node data availability (not a general-purpose on-chain content ownership registry)
- **Validators prove data existence through PoSe challenges**
- **Off-chain runtime constructs objective fault evidence, and on-chain contracts verify and enforce penalties**
- **No need for full storage, only random sampling for verification**
- **Designed for the OpenClaw AI-agent ecosystem**: provides agent identity registration, node binding, and service proof infrastructure (collaborative scheduling and settlement attribution to be closed in future versions)

---

## II. Technical Architecture

### 2.1 Layered Design

#### Layer 1: Blockchain Engine (`node/src/`)

**Interface-Oriented Design**: All components are built on the `IChainEngine` interface, supporting multiple implementations:

```typescript
interface IChainEngine {
  // Core queries
  getTip(): ChainBlock | null
  getHeight(): bigint
  getBlockByNumber(number: bigint): ChainBlock | null

  // Block production and application
  proposeNextBlock(): Promise<ChainBlock | null>
  applyBlock(block: ChainBlock): Promise<void>

  // Optional: storage layer support
  getLogs?(filter: LogFilter): Promise<IndexedLog[]>
  getTransactionByHash?(hash: Hex): Promise<TxWithReceipt | null>
}
```

**Two Implementations**:
1. **ChainEngine**: Fully in-memory implementation for single-node development
2. **PersistentChainEngine**: LevelDB-backed persistent implementation for production

**EVM Execution**:
- Built on `@ethereumjs/vm`
- Supports **checkpointable state** (for snapshot sync)
- All account state, storage slots, and bytecode are persisted

#### Layer 2: Consensus Engine (`consensus.ts`)

Uses **multi-mode consensus** that automatically transitions between three states:

```
HEALTHY  ←→  DEGRADED  ←→  RECOVERING
  ↓
Normal block production
at blockTimeMs interval
```

**HEALTHY (Normal) Mode**:
- Deterministic rotation: `nextProposer = validators[currentHeight % validatorCount]`
- Each validator takes turns proposing blocks
- Block interval is controlled by `blockTimeMs` (default 3000ms, configurable)

**DEGRADED (Degraded) Mode**:
- Trigger: 5 consecutive proposal or sync failures
- Behavior: Relax requirements, accept proposals from any node
- Purpose: Fault tolerance and failure recovery

**RECOVERING (Recovery) Mode**:
- Trigger: Wait 30 seconds cooldown, then retry
- Behavior: Re-validate chain from scratch, restart consensus

#### Layer 3: P2P Network (`p2p.ts`, `wire-protocol.ts`, `dht-network.ts`)

**Three-Layer Networking in Parallel**:

1. **HTTP Gossip Protocol** (Traditional)
   - Connectionless, RESTful endpoints
   - Built-in deduplication (`seenTx=50,000`, `seenBlocks=10,000`)
   - Request body size limit (default 2MB)

2. **Wire Protocol** (Optimized)
   - TCP long connections with frame-based transport
   - Magic byte 0xC0C1, secure handshake
   - Identity signature verification, prevents MITM
   - Configurable connection caps (default outbound 25, inbound 50, and max 5 per IP)

3. **DHT Network** (Discovery)
   - Kademlia routing table (20 nodes per distance bucket)
   - Iterative lookup with k-ary tree traversal
   - Periodic refresh (default 5 min) and announce (default 3 min), with peer persistence

**Cross-Protocol Relaying**:
- Via `onTxRelay`, `onBlockRelay` callbacks
- Cross-validation deduplication (BoundedSet on both layers)
- Prevents message storms

#### Layer 4: PoSe Settlement Layer (`services/`, `contracts/`)

See detailed description below.

### 2.2 Storage Architecture

#### Persistent Storage Layer (`storage/`)

**LevelDB as Foundation**:

1. **BlockIndex** - Block and transaction indexing
   - `b:{height}` → ChainBlock
   - `t:{txHash}` → {blockNumber, index, receipt}
   - `a:{address}:{paddedBlock}:{txHash}` → address history
   - `h:{blockHash}` → block number mapping

2. **StateTrie** - EVM state tree
   - Merkle Patricia Trie implementation
   - Account state (nonce, balance, codeHash)
   - Storage slots (address → slot → value)
   - Bytecode (codeHash → bytecode)
   - Supports checkpoint/rollback

3. **NonceStore** - Replay attack protection
   - Records all executed nonces
   - Auto-cleanup after 7 days
   - Persists across node restarts

#### IPFS-Compatible Storage (`ipfs-*.ts`)

**Design Principle**: Fully IPFS HTTP API compatible, but simplified implementation.

**Subsystems**:

1. **Blockstore** - Content-addressed storage
   - Store blocks by CIDv1 (base32-encoded content hashes)
   - DAG-PB and Raw block types
   - Pin management (pin/unpin/list; garbage collection not yet implemented)

2. **UnixFS** - File layout
   - File metadata (size)
   - DAG organization (file sharding with 256KB chunks)

3. **Mutable FileSystem (MFS)** - Mutable filesystem
   - Support mkdir, write, read, ls, rm, mv, cp, stat, flush
   - In-memory directory tree; write operations compute CID on commit
   - Synchronous flush to blockstore

4. **Pub/Sub** - Publish-subscribe messaging
   - Topic subscriptions
   - P2P relay forwarding
   - Message deduplication (BoundedSet of 50,000 entries)
   - Per-topic ring buffer (default 1,000 recent messages per topic)

5. **HTTP Gateway** - REST API
   - `/ipfs/<cid>` - fetch files
   - `/api/v0/add` - upload files
   - `/api/v0/get` - download + TAR format
   - MFS routes: `/api/v0/files/read`, `/api/v0/files/write`, etc.
   - Pubsub routes: `/api/v0/pubsub/pub`, `/api/v0/pubsub/sub`

---

## III. Unique Features

### 3.1 PoSe v2 Protocol

#### Why PoSe?

1. **Decentralized**: Anyone can become a validator
2. **Verifiable**: On-chain contracts automatically detect and punish failures
3. **Low Cost**: No PoW computation; lower entry barrier than mainstream PoS, but node registration still requires bond
4. **Quality of Service**: Repeated challenges test node reliability

#### Four-Stage Process

**Stage 1: Challenge Generation** (`services/challenger/`)

```typescript
interface ChallengeMessageV2 {
  version: 2
  challengeId: Hex32          // Unique identifier
  epochId: bigint             // Service period
  nodeId: Hex32               // Target node under test
  challengeType: "U" | "S" | "R" // Uptime / Storage / Relay
  nonce: Hex32                // 16-byte random nonce (0x-prefixed)
  challengeNonce: bigint      // Epoch nonce snapshot from chain
  querySpec: {                // Query specification
    // Uptime:
    method?: "eth_blockNumber"
    minBlockNumber?: number
    // Storage:
    cid?: string
    chunkIndex?: number
    merkleRoot?: string
    proofSpec?: "merkle-path"
    // Relay:
    routeTag?: string
    expectedHop?: number
  }
  querySpecHash: Hex32        // Merkle hash of spec
  issuedAtMs: bigint
  deadlineMs: number          // Relative deadline (current defaults: U/R=2500ms, S=6000ms)
  challengerId: Hex32         // Challenger
  challengerSig: string       // EIP-712 signature
}
```

**Nonce Generation Strategy**:
- Contract owner calls `initEpochNonce(epochId)` to snapshot `block.prevrandao` into `challengeNonces[epochId]`
- Challenger reads epoch nonce from contract as `challengeNonce`
- Production should ensure each epoch nonce is initialized before issuing challenges

**Stage 2: Receipt Verification** (`services/verifier/`)

```typescript
interface ReceiptMessageV2 {
  challengeId: Hex32
  nodeId: Hex32
  responseAtMs: bigint
  responseBody: {             // Actual response
    data?: string             // Returned block/data
    proof?: string[]          // Merkle path
  }
  responseBodyHash: Hex32     // Response hash
  tipHash: Hex32              // Node's current chain tip
  tipHeight: bigint           // Block height (binding)
  nodeSig: string             // Node EIP-712 signature
}
```

**Verification Steps** (9-layer pipeline in `receipt-verifier-v2.ts`):
1. Nonce replay check (reject duplicate challenge nonces)
2. Verify challenger's EIP-712 signature on challenge
3. Validate challenge/receipt field match (challengeId, nodeId)
4. Time window check (`issuedAt <= responseAt <= issuedAt+deadline`)
5. Verify node's EIP-712 receipt signature (including `tipHash/tipHeight/responseBodyHash`)
6. Tip binding: enforce `tipHeight` within tolerance window from current chain tip (default 10 blocks)
7. Execute type-specific checks (Uptime/Storage/Relay)
8. Verify witness signatures and quorum
9. Build `EvidenceLeafV2` with appropriate `resultCode`

**Result Codes**:
```typescript
const ResultCode = {
  Ok: 0,              // ✓ Success
  Timeout: 1,         // ✗ Timeout
  InvalidSig: 2,      // ✗ Invalid signature
  StorageProofFail: 3,// ✗ Storage proof failed
  RelayWitnessFail: 4,// ✗ Witness relay failed
  TipMismatch: 5,     // ✗ Tip mismatch (replay attack)
  NonceMismatch: 6,   // ✗ Nonce mismatch
  WitnessQuorumFail: 7, // ✗ Insufficient witnesses
}
```

**Stage 3: Witness Voting** (`runtime/lib/witness-collector.ts` + on-chain witness set)

**Innovation: Distributed Arbitration**

Challenges may experience network delays or temporary failures. We introduce a **witness cluster** to confirm:

1. **Witness Set Size**: `m = ceil(sqrt(activeNodeCount))`, capped at `m <= 32`
   - E.g., 100 active nodes → 10 witnesses
   - Small sample, low cost

2. **Selection Method**: On-chain pseudo-random selection from epoch nonce (`challengeNonces[epochId]`, set via `initEpochNonce` from `block.prevrandao`)
   - `idx = keccak256(abi.encodePacked(epochNonce, i)) % activeCount`, deduplicated until m slots
   - Deterministic under same epoch nonce

3. **Quorum Threshold**: `quorum = ceil(2m / 3)`
   - Requires 2/3+ witness agreement
   - BFT-style fault tolerance

4. **Transition Switch**: contract supports `allowEmptyWitnessSubmission` (default false — strict mode)
   - Set to true during bootstrap to allow batches without witness signatures
   - Production keeps the default (false) to enforce witness quorum

5. **Witness Message**:
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

**Stage 4: Merkle Batching and On-Chain Settlement** (`services/aggregator/`)

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

1. Collect N EvidenceLeaves (N driven by agent `batchSize`, current default 5)
2. Build Merkle tree
3. Generate Merkle root, summaryHash, and sampleProofs (current default sampleSize=2)
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
  // 3. Store batch and enter dispute window
}
```

**Slash Distribution** (max 5% per epoch):
- 50% burn
- 30% to reporter
- 20% to insurance fund

#### Permissionless Fault Proofs

Anyone can challenge the aggregator's Merkle tree:

```typescript
enum FaultType {
  DoubleSig = 1,      // Reserved: currently not accepted in reveal path
  InvalidSig = 2,     // Signature verification failure
  TimeoutMiss = 3,    // Claimed success but actual timeout
  BatchForgery = 4,   // Forged Merkle leaf
}
```

**Challenge Process**:
1. `openChallenge(commitHash)` with challenge bond (minimum controlled by contract parameter)
2. `revealChallenge(...)` with objective proof payload (batch/merkle/leaf)
3. After adjudication window, call `settleChallenge(challengeId)`
4. If fault confirmed: slash target node and return challenger bond + reward; otherwise bond goes to insurance

### 3.2 Hybrid Consensus Mechanism

#### Deterministic Rotation

```typescript
function expectedProposer(nextHeight: bigint): string {
  const activeValidators = getActiveValidators()
  const index = Number((nextHeight - 1n) % BigInt(activeValidators.length))
  return activeValidators[index].address
}
```

> When validator governance is enabled, stake-weighted proposer selection replaces simple rotation.

**Advantages**:
- Completely deterministic, no consensus messages needed
- Validators can predict their turns
- Failures easy to diagnose

**Disadvantages**:
- If a validator is down, must wait for its turn
- Solution: Degraded mode automatically accepts other proposals

#### Optional BFT Coordinator

If `enableBft: true`, BFT layering runs atop deterministic rotation:

```
Proposer gets turn
        ↓
Broadcast block via BFT round
        ↓
Need 2/3+ votes to finalize
        ↓
If no quorum → timeout → next proposer
```

**BFT Messages**:
```typescript
interface BftMessage {
  height: bigint
  round: number
  type: "Propose" | "Prepare" | "Commit"
  blockHash: string
  signature: string           // Signature prevents tampering
}
```

**PBFT-Style Flow**:
1. **Prepare** - Collect 2/3+ votes, confirm block validity
2. **Commit** - Collect 2/3+ commitments, finalize block
3. **Timeout** - configurable per-phase (default: prepare 5s + commit 5s = 10s total) → skip proposer

**Safeguards**:
- **Equivocation Detector**: Detects double voting, auto-slashes
- **Signature Verification**: All messages must have valid signatures
- **Per-validator evidenceBuffer**: Max 100 evidence per validator (prevents Sybil)

#### Snapshot Sync

When a new node joins:

```
1. Request state snapshot (accounts, storage, bytecode)
2. Import state into StateTrie
3. Set state root to known good value
4. Async sync adjacent blocks
5. Resume consensus
```

**Snapshot Contents**:
```typescript
interface StateSnapshot {
  stateRoot: string
  blockHeight: string
  blockHash: string
  accounts: Array<{
    address: string
    nonce: string
    balance: string
    storageRoot: string
    codeHash: string
    storage: Array<{ slot: string; value: string }>
    code?: string
  }>
  validators?: ValidatorRecord[]
}
```

**Verification**:
- Block hash must be on local chain
- State root hash must verify
- Governance consistency check

### 3.3 EVM Compatibility

#### Supported Features

1. **All EVM Opcodes** (PUSH, DUP, SWAP, arithmetic, etc.)
2. **Smart Contracts** (Solidity, Vyper)
3. **JSON-RPC Interface** (77+ methods)
   - `eth_call` - stateless call
   - `eth_sendTransaction` - submit transaction
   - `eth_getBalance`, `eth_getCode` - queries
   - `debug_traceTransaction` - transaction tracing
   - `eth_subscribe` - WebSocket subscription

4. **EIP-1559 Dynamic Fees**
   - Base fee: `baseFee = prevBaseFee + (parentGasUsed - targetGas) / targetGas * baseFee / 8` (targetGas = gasLimit * 50%)
   - Priority fee: `maxPriorityFeePerGas`
   - Max fee: `maxFeePerGas`

5. **Keccak-256 Hashing**
6. **Elliptic Curve Operations** (ECDSA recovery)
7. **ABI Encoding/Decoding**

#### PoSe-Specific Contract Interface

```solidity
interface IPoSeManagerV2 {
  function registerNode(
    bytes32 nodeId,
    bytes calldata pubkeyNode,
    uint8 serviceFlags,
    bytes32 serviceCommitment,
    bytes32 endpointCommitment,
    bytes32 metadataHash,
    bytes calldata ownershipSig,
    bytes calldata endpointAttestation
  ) external payable;

  function initEpochNonce(uint64 epochId) external;

  function submitBatchV2(
    uint64 epochId,
    bytes32 merkleRoot,
    bytes32 summaryHash,
    SampleProof[] calldata sampleProofs,
    uint32 witnessBitmap,
    bytes[] calldata witnessSignatures
  ) external returns (bytes32 batchId);

  function openChallenge(bytes32 commitHash) external payable returns (bytes32 challengeId);

  function revealChallenge(
    bytes32 challengeId,
    bytes32 targetNodeId,
    uint8 faultType,
    bytes32 evidenceLeafHash,
    bytes32 salt,
    bytes calldata evidenceData,
    bytes calldata challengerSig
  ) external;

  function settleChallenge(bytes32 challengeId) external;

  function finalizeEpochV2(
    uint64 epochId,
    bytes32 rewardRoot,
    uint256 totalReward,
    uint256 slashTotal,
    uint256 treasuryDelta
  ) external;

  function claim(uint64 epochId, bytes32 nodeId, uint256 amount, bytes32[] calldata merkleProof) external;
}
```

### 3.4 Performance Optimizations

#### 1. Mempool Optimization

**EIP-1559 Sorting**:
- Sort by effective gas price (min(maxFeePerGas, baseFee + maxPriorityFeePerGas))
- O(n log n) initial sort, incremental updates thereafter

**Eviction Strategy**:
- Evict lowest-fee transactions when pool capacity is reached (default capacity 4096, configurable)
- O(n) quickselect (not O(n log n) sort)

#### 2. Block Proposal Acceleration

**Parallel Nonce Prefetch**:
```typescript
// Order matters, but can prefetch all account nonces
const nonces = await Promise.all(
  accounts.map(a => getPendingNonce(a))
)
```

#### 3. DHT Optimization

**Concurrent Peer Verification**:
- Iterative lookup parallelism uses `ALPHA=3`
- Candidate peer verification is batched concurrently (default concurrency 5)

**Periodic Refresh**:
- Refresh DHT routing table every 5 minutes
- Remove dead nodes, discover new neighbors

#### 4. Request Size Limits

```typescript
const P2P_MAX_REQUEST_BODY = 2 * 1024 * 1024     // 2MB
const P2P_MAX_RESPONSE_BODY = 4 * 1024 * 1024    // 4MB
const POSE_MAX_BODY = 1024 * 1024                // 1MB
const IPFS_MAX_UPLOAD_SIZE = 10 * 1024 * 1024    // 10MB
const RPC_BATCH_MAX = 100                        // 100 items per batch
```

#### 5. Buffer Management

**FrameDecoder Buffer Compaction**:
```typescript
// If usage < 1/4, reallocate
if (buffer.byteLength > 4 * bytesUsed) {
  buffer = new Uint8Array(buffer.buffer, offset, usedLength)
}
```

---

## IV. Security Design

### 4.1 Replay Attack Prevention

#### 1. Nonce Registry

```typescript
class PersistentNonceStore {
  async recordTx(address: string, nonce: bigint, height: bigint): Promise<void>
  async hasBeenUsed(address: string, nonce: bigint): Promise<boolean>
  async cleanup(beforeHeight: bigint): Promise<void>  // Cleanup after 7 days
}
```

**How It Works**:
- Record (address, nonce) when transaction executes
- Reject any subsequent transaction with same nonce
- Auto-cleanup after 7 days (survives node restarts)

#### 2. Tip Binding

PoSe receipts must include the node's current chain tip:

```typescript
interface ReceiptMessageV2 {
  tipHash: Hex32      // Current block hash
  tipHeight: bigint   // Current block height
  ...
}
```

Verification:
```typescript
// Tolerance window: tipHeight difference from current tip must stay within threshold (default 10)
const diff = abs(receipt.tipHeight - currentTipHeight)
if (diff > tipToleranceBlocks) {
  return ResultCode.TipMismatch
}
```

#### 3. Timestamp Verification

```typescript
const issuedAt = challenge.issuedAtMs
const deadline = challenge.deadlineMs
const receivedAt = receipt.responseAtMs

if (receivedAt > issuedAt + deadline) {
  return ResultCode.Timeout
}
```

### 4.2 Signatures and Identity

#### EIP-712 Typed Signing

```typescript
// Define signature types
const types = {
  ChallengeMessage: [
    { name: 'version', type: 'uint8' },
    { name: 'challengeId', type: 'bytes32' },
    { name: 'epochId', type: 'uint64' },
    { name: 'nodeId', type: 'bytes32' },
    { name: 'querySpecHash', type: 'bytes32' },
    // ... more fields
  ]
}

// Sign
const signature = await signer.signMessage(
  types,
  challenge
)

// Verify
const recoveredAddress = verifier.recoverAddress(
  types,
  challenge,
  signature
)
```

**Advantages**:
- Prevents accidental signing (clear type info)
- Human-readable (Metamask can parse)
- Safe off-chain verification

#### Wire Protocol Handshake

```typescript
// 1. Client sends identity
ClientHandshake {
  publicKey: string
  timestamp: bigint
  clientSignature: string     // sign(publicKey + timestamp)
}

// 2. Server verifies and responds
ServerHandshake {
  publicKey: string
  timestamp: bigint
  serverSignature: string
}

// 3. Prevent identity switch
if (peer.handshakeComplete && newHandshake.publicKey !== peer.publicKey) {
  socket.destroy()  // Disconnect
}
```

### 4.3 Byzantine Fault Tolerance

#### Equivocation Detection

Two-vote algorithm: Did a validator vote for different blocks?

```typescript
class EquivocationDetector {
  onBftVote(vote: BftVote): { slashable: boolean; evidence: EquivocationEvidence | null } {
    // Same (height, round) with different blockHash
    if (seenVotes.has(key)) {
      const previous = seenVotes.get(key)
      if (previous.blockHash !== vote.blockHash && previous.signature !== vote.signature) {
        return { slashable: true, evidence: { vote1, vote2 } }
      }
    }
    seenVotes.set(key, vote)
    return { slashable: false, evidence: null }
  }
}
```

**Auto-Slashing**:
```typescript
const validator = governance.getValidator(evidence.signer)
governance.applySlash(validator.id, slashAmount)
governance.deactivateValidator(validator.id)
```

#### Per-Validator Evidence Cap

```typescript
// Prevent storage exhaustion
const maxPerValidator = 100

class EquivocationDetector {
  recordEvidence(validatorId: string, evidence: Evidence): void {
    if (!evidenceByValidator[validatorId]) {
      evidenceByValidator[validatorId] = []
    }
    const buf = evidenceByValidator[validatorId]
    buf.push(evidence)
    if (buf.length > maxPerValidator) {
      buf.shift()  // Remove oldest
    }
  }
}
```

### 4.4 HTTP Server Hardening

```typescript
const server = http.createServer(...)

// Slowloris protection
server.headersTimeout = 10_000      // 10s
server.requestTimeout = 30_000      // 30s
server.keepAliveTimeout = 5_000     // 5s

// Request body limits per subsystem
const p2pMaxBody = 2 * 1024 * 1024      // 2MB
const poseMaxBody = 1024 * 1024         // 1MB
const ipfsMaxUpload = 10 * 1024 * 1024  // 10MB

// Rate limiting per subsystem (per IP)
const p2pRateLimiter = new RateLimiter(60_000, 240)
const poseRateLimiter = new RateLimiter(60_000, 60)
const ipfsRateLimiter = new RateLimiter(60_000, 100)
if (!p2pRateLimiter.allow(clientIp)) {
  res.writeHead(429)
  return
}
```

---

## V. Scalability Roadmap

### Near Term (Phase 36-40)

1. **Multi-Chain Bridges**: Support cross-chain assets from other L1s
2. **Smart Contract Optimization**: Inline caching, bytecode pre-compilation
3. **Parallel Execution**: Multi-threaded EVM execution (non-shared state)

### Medium Term (Phase 41-50)

1. **Rollup Integration**: Support OP Stack / Arbitrum Orbit
2. **Data Availability Sampling**: DAS (Data Availability Sampling)
3. **Homomorphic Encryption**: Private transactions

### Long Term (Phase 51+)

1. **Quantum-Safe Cryptography**
2. **Cross-Chain Atomic Composition**
3. **zk-SNARK Batch Proofs**

---

## VI. Comparison with Other Solutions

### 6.1 Methodology and Scope

To keep comparisons defensible and auditable, this section follows three rules:

1. Compare **protocol design and public mechanisms**, not short-term token prices or marketing claims.
2. Throughput, fees, and validator counts on external networks are dynamic; avoid freezing transient values as permanent facts.
3. Conclusions are framed as **fitness by use case**, not universal superiority claims.
4. Key factual anchors are aligned to official docs or widely used ecosystem specifications (e.g., Ethereum staking threshold, Polygon PoS checkpoint model, optimistic-rollup withdrawal windows, Filecoin FVM, Arweave SmartWeave/AO).

### 6.2 Mainstream Chain Comparison (Architecture Trade-offs)

| Dimension | COC | Ethereum | Solana | Polygon PoS | Arbitrum / Optimism |
|-----------|-----|----------|--------|-------------|---------------------|
| **Architecture Layer** | L1 | L1 | L1 | Ethereum sidechain (PoS, checkpointed to Ethereum) | Optimistic Rollup (L2) |
| **Execution Environment** | EVM | EVM | SVM | EVM | EVM |
| **Core Consensus / Ordering** | Deterministic rotation + optional BFT + PoSe settlement | PoS (Gasper) | PoH + PoS (Tower BFT) | PoS validator set + Bor/Heimdall | L2 sequencer + fraud-proof pipeline |
| **Node Participation Constraints** | Permissionless with bond and protocol constraints | Solo validator requires 32 ETH stake | No fixed protocol minimum stake, but validator competitiveness depends on hardware, vote cost, and delegated stake | Validator admission follows staking and active-set policies | Operational roles are constrained by rollup governance and bridge/proof rules |
| **Off-Chain Service Verifiability** | Native PoSe (challenge / witness / slash) | No native off-chain storage QoS proof | No native off-chain storage QoS proof | No native off-chain storage QoS proof | Primarily proves state-transition correctness, not storage QoS |
| **Finality / Withdrawal Semantics** | Native finality via `blockTimeMs` + `finalityDepth` | PoS economic finality | Fast probabilistic finality | In-chain finality + Ethereum checkpoint semantics | Withdrawals usually gated by challenge windows (commonly around 7 days on mainnet) |
| **Ecosystem Positioning** | OpenClaw AI-agent-native + EVM compatibility | Security and liquidity base layer | High-throughput, low-latency execution | Cost-efficient EVM ecosystem extension | Lower-cost Ethereum execution with shared liquidity context |

**Defensible takeaways (non-absolute):**
1. If your core requirement is “objective AI-agent service proofs + enforceable penalties + reward closure,” COC is structurally aligned.
2. If your top priority is deepest liquidity and conservative base-layer security assumptions, Ethereum (+ major L2s) remains the default.
3. If you prioritize high-throughput low-latency execution and accept a non-EVM toolchain, Solana is strong.
4. If you prioritize low-cost EVM deployment, Polygon and Arbitrum/Optimism are mature choices, but they do not natively provide storage-service QoS proofs.

**Positioning Statement:**
COC does not claim to dominate every mainstream chain on generic throughput, ecosystem scale, or base-layer security prestige; its actual innovation is bringing **verifiable service proofs, objectively enforceable penalties, and closed-loop rewards** directly into the protocol surface for AI-agent infrastructure.

### 6.3 Storage-Network Comparison (Filecoin / Arweave / Storj)

| Dimension | COC | Filecoin | Arweave | Storj |
|-----------|-----|----------|---------|-------|
| **Primary Goal** | General execution + service proofs + storage commitments | Decentralized storage market | Permanent data network | Decentralized object storage service |
| **Programmability** | EVM smart contracts | FVM/FEVM smart contracts | SmartWeave/AO-style programmability | Not a chain-native smart-contract platform |
| **Persistence Model** | Incentive/governance-driven storage continuity | Deal-based storage duration and renewal | Long-term/permanent data economics | Erasure coding + audits + repair |
| **Proof / Audit Focus** | Service availability and QoS | Storage commitment and temporal proofs (PoRep/PoSt) | Long-term retrievability and permanence economics | Node auditability and data availability operations |
| **Typical Workloads** | OpenClaw AI-agent state + service settlement | Cold/warm storage and retrieval market | Long-lived archival publishing | Private file/object storage |

**Conclusion:**
1. Filecoin and Arweave are stronger on storage-economics specialization; COC is stronger where execution and service-verifiable settlement must be integrated.
2. Storj is an engineering-focused decentralized storage service, not a general-purpose L1 execution layer.
3. COC is not positioned to replace all storage networks; it is positioned to provide an executable, verifiable, incentive-closed substrate for the OpenClaw AI-agent ecosystem.

### 6.4 Decision Matrix

```
                 ┌──────────────────────────────────────────────────┐
                 │   Requirement-Driven Choice (AI-Agent Context)   │
                 └──────────────────────────────────────────────────┘

Need objective evidence + enforceable penalties + reward closure?
│
├─ Yes → Also need on-chain contract orchestration?
│        ├─ Yes → COC (OpenClaw AI-agent-native)
│        └─ No  → specialized storage network + external arbitration stack
│
└─ No  → Is EVM liquidity and ecosystem depth the priority?
         ├─ Yes → Ethereum / Arbitrum / Optimism / Polygon
         └─ No  → evaluate Solana or storage-first networks by workload
```

### 6.5 COC Innovation and Distinct Positioning (Argument-Ready)

| Innovation | Mechanism | Key Difference vs Common Approaches | Verifiable Outcome |
|------------|-----------|-------------------------------------|--------------------|
| **Verifiable Evidence** | EIP-712 challenge/receipt + witness quorum + Merkle evidence leaves | No reliance on subjective ops reports for service quality | Evidence can be replay-verified on-chain and off-chain |
| **Objectively Enforceable Penalties** | commit-reveal-settle challenge flow + configurable slash cap | Penalties are triggered by objective proofs, not manual arbitration | Malicious or negligent behavior can be penalized automatically |
| **Closed-Loop Rewards** | `finalizeEpochV2` + reward root + Merkle claim | Rewards and fault outcomes settle in one coherent surface | Contribution, penalties, and claims remain fully auditable |
| **AI-Agent Identity Infrastructure** | node identity commitments, endpoint attestations, service capability flags (`serviceFlags`), FactionRegistry | Built for OpenClaw agent identity and registration workflows | Agent identities are verifiable on-chain; collaborative orchestration and settlement attribution remain future work |
| **Operational Security Posture** | tip binding, nonce registry, inbound auth, replay resistance | Covers both on-chain and P2P/PoSe channel risks | Reduced replay, forgery, and delay-injection attack surface |

**Why this argument is stronger:**
1. Every “advantage” is tied to a concrete protocol mechanism, not a slogan.
2. Every mechanism maps to an observable outcome (replay-verifiable, enforceable, settleable, auditable).
3. Conclusions are framed by workload fit, avoiding static claims on dynamic market metrics.

### 6.6 Factual Reference Links (Official + Ecosystem Specs)

- Ethereum Staking: https://ethereum.org/en/staking/
- Solana Validators: https://solana.com/validators
- Polygon PoS Docs: https://docs.polygon.technology/pos/
- Optimism Bridging/Messaging: https://docs.optimism.io/app-developers/guides/bridging/messaging
- Arbitrum Withdrawal Window (official support): https://support.arbitrum.io/hc/en-us/articles/18237449094555-Why-does-it-take-7-days-to-complete-an-L2-to-L1-withdrawal
- Filecoin FVM: https://fvm.filecoin.io/
- Filecoin Smart Contracts: https://docs.filecoin.io/smart-contracts/
- Arweave Docs: https://docs.arweave.org/
- Arweave SmartWeave: https://cookbook.arweave.net/concepts/smartweave.html
- Storj Architecture: https://storj.dev/node/get-started/architecture

---

## VII. Key Metrics

### Blockchain Performance

```
Default Block Time: 1000ms (configurable, min 100ms)
Max Transactions per Block: default 512 (maxTxPerBlock)
Mempool Capacity: default 4096 (configurable)

Measured TPS (simple ETH transfers, single-node):
  EthereumJS engine:  133.7 TPS  (serial EVM ceiling)
  revm WASM engine:   20,540 TPS raw / 500-1000 TPS end-to-end (target)
  With Block-STM:     2000-5000 TPS (future target)
```

### PoSe Performance

```
Agent Tick Interval: default 60s
Batch Size: default 5 (batchSize)
Sample Proof Count: default 2 (sampleSize)
Tip Tolerance Window: default 10 blocks
Witness Quorum: ceil(2m/3), m=|witnessSet|, m<=32
```

### Storage Performance

```
Blockstore/UnixFS latency depends on disk and load
MFS Directory Listing: O(n) in-memory map scan
Pin Management: pin/unpin/list (GC not yet implemented)
```

---

## VIII. Deployment & Operations

### Single-Node Development

```bash
COC_DATA_DIR=/tmp/coc-dev \
node --experimental-strip-types node/src/index.ts
```

### Multi-Node Development Network (Devnet)

```bash
bash scripts/start-devnet.sh 3    # Start 3-node devnet
```

**Auto-Enabled**:
- BFT Coordinator
- Wire Protocol
- DHT Network
- Snap Sync
- Persistent Storage

### Production Deployment

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

## IX. Summary

COC is a blockchain **purpose-built for data services**:

1. **PoSe v2**: Permissionless distributed fault proofs via witness arbitration
2. **IPFS Compatible**: Every node can store, anyone can verify
3. **Hybrid Consensus**: Deterministic + Optional BFT + Snapshot Sync
4. **EVM Compatible**: Use Solidity, zero migration cost
5. **Production-Ready**: LevelDB persistence, complete RPC API, comprehensive security checks

Its design goal is to become the **settlement layer for trust-minimized data networks**.
