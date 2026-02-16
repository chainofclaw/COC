# COC (ChainOfClaw) Technical Architecture Documentation

> **Version**: v1.1.0
> **Last Updated**: 2026-02-16
> **Status**: Production Ready (190 tests passing)

---

## 1. System Overview

COC is an EVM-compatible blockchain built on PoSe (Proof of Service) consensus. It uses a challenge-response mechanism to verify storage, relay, and uptime services provided by nodes, enabling incentivized and penalized decentralized service networks.

### 1.1 Core Features

- **EVM Compatible**: Full support for Ethereum smart contracts and tooling
- **PoSe Consensus**: Proof of Service replaces traditional PoW/PoS
- **Economic Security**: Bonding, slashing, and inflation mechanisms
- **Sybil Resistant**: Progressive bonding + machine fingerprinting + random challenges

### 1.2 Codebase Statistics

| Component | Lines of Code | Files |
|-----------|--------------|-------|
| TypeScript Runtime | ~9,000 | 95 |
| Solidity Contracts | ~510 | 5 |
| Test Cases | 190 tests | 35 |

---

## 2. Architecture Design

### 2.1 System Layers

```
┌─────────────────────────────────────────────┐
│         Application Layer (Apps)             │
│  DApps, Block Explorer, Wallet, Dashboard   │
└─────────────────────────────────────────────┘
                    ↓ JSON-RPC
┌─────────────────────────────────────────────┐
│          L2 Node Layer (COC Nodes)           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │RPC Service│  │EVM Engine│  │Consensus │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────┘
                    ↓ PoSe Protocol
┌─────────────────────────────────────────────┐
│         PoSe Runtime Layer                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │Challenger│  │Node Server│  │ Relayer  │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────┘
                    ↓ Settlement
┌─────────────────────────────────────────────┐
│      L1 Settlement (Ethereum/Base)           │
│           PoSeManager Contract               │
└─────────────────────────────────────────────┘
```

### 2.2 Core Modules

#### 2.2.1 Node Layer (`node/src/`)

- **chain-engine**: Block production, finality, state snapshots
- **evm.ts**: EthereumJS VM for smart contract execution
- **rpc.ts**: JSON-RPC service (57+ methods including eth_*, coc_*, txpool_*)
- **websocket-rpc.ts**: WebSocket RPC (eth_subscribe with validation and limits)
- **consensus.ts**: Consensus engine with degraded mode and auto-recovery
- **mempool.ts**: Transaction pool with EIP-1559 effective gas price sorting
- **p2p.ts**: HTTP gossip network with per-peer dedup and body limits
- **base-fee.ts**: EIP-1559 dynamic base fee calculation
- **health.ts**: Health checker with memory/WS/storage diagnostics
- **debug-trace.ts**: Transaction tracing (debug_traceTransaction, trace_transaction)
- **pose-engine**: PoSe protocol engine for challenge verification
- **crypto/signer**: secp256k1 signing and verification
- **storage/**: LevelDB persistence (block index, state trie, nonce store)

#### 2.2.2 Runtime (`runtime/`)

- **coc-agent.ts**: Challenger/aggregator agent, drives epoch validation loop
- **coc-node.ts**: HTTP server, responds to PoSe challenge requests
- **coc-relayer.ts**: L1-L2 relayer, submits epoch finalization and disputes

#### 2.2.3 Services Layer (`services/`)

| Service | Responsibility |
|---------|---------------|
| verifier | Receipt verification, node scoring, inflation, anti-cheat |
| challenger | Challenge factory, quota management, random seed generation |
| aggregator | Batch aggregation, Merkle tree construction |
| relayer | L1-L2 state sync, dispute submission |
| common | Common types, Merkle utilities, role registration |

#### 2.2.4 Node Operations (`nodeops/`)

- **policy-engine**: Operational policy evaluation (capacity, load, health)

#### 2.2.5 Contract Layer (`contracts/settlement/`)

- **PoSeManager.sol**: Main contract (registration, batch submit, slash, unbond)
- **PoSeManagerStorage.sol**: Storage layout and constants
- **PoSeTypes.sol**: Struct definitions
- **IPoSeManager.sol**: Interface and events
- **MerkleProofLite.sol**: Merkle proof verification

---

## 3. PoSe Protocol Deep Dive

### 3.1 Epoch Lifecycle

```
Epoch N (1 hour)
  ├─ 0-50 min: Challenge Phase
  │   ├─ Challengers issue challenges
  │   ├─ Nodes respond with signed receipts
  │   └─ Aggregators collect receipts
  ├─ 50-60 min: Aggregation Phase
  │   ├─ Build Merkle tree
  │   ├─ Calculate node scores
  │   └─ Submit batch to L1
  └─ Move to Epoch N+1

Dispute Window (2 epochs)
  ├─ Slashers can submit disputes
  └─ Batch finalized after timeout
```

### 3.2 Challenge Types

#### 3.2.1 Uptime Challenge

Verifies node is synced with L1 chain.

**Request**:
```json
{
  "type": "Uptime",
  "querySpec": {
    "method": "eth_blockNumber",
    "minBlockNumber": 12345000
  },
  "nonce": "0xabc123...",
  "randSeed": "0x1234...",
  "timestamp": 1707926400
}
```

**Verification Logic**:
```typescript
verifyUptimeResult: (challenge, receipt) => {
  if (!receipt.responseBody?.ok) return false;
  const bn = Number(receipt.responseBody?.blockNumber);
  if (!Number.isFinite(bn) || bn <= 0) return false;
  const minBn = Number(challenge.querySpec?.minBlockNumber ?? 0);
  if (minBn > 0 && bn < minBn) return false;
  return true;
}
```

#### 3.2.2 Storage Challenge

Verifies node stores specific data and can provide Merkle proof.

**Request**:
```json
{
  "type": "Storage",
  "querySpec": {
    "cid": "bafybeiabc123...",
    "offset": 1024,
    "length": 256
  },
  "nonce": "0xdef456...",
  "randSeed": "0x5678...",
  "timestamp": 1707926460
}
```

**Verification Logic**:
- Check receipt merkleProof is valid
- Verify leaf hash matches querySpec
- Accumulate verifiedStorageBytes

#### 3.2.3 Relay Challenge

Verifies node can relay L1 transactions.

**Verification Logic**:
```typescript
verifyRelayResult: (challenge, receipt) => {
  const witness = receipt.responseBody?.witness;
  return !!witness; // P2 TODO: verify witness signature
}
```

### 3.3 Scoring Algorithm

#### 3.3.1 Bucket Weights

```typescript
const buckets = {
  uptime: { weight: 0.6, cap: 100 },   // 60% reward pool
  storage: { weight: 0.3, cap: 1000 }, // 30% reward pool
  relay: { weight: 0.1, cap: 50 }      // 10% reward pool
}
```

#### 3.3.2 Storage Diminishing Returns

Prevents single node from monopolizing storage rewards.

```typescript
function applyDiminishingReturns(storageGb: bigint): bigint {
  const gb = Number(storageGb);
  return BigInt(Math.floor(Math.sqrt(gb) * 10)); // sqrt diminishing
}
```

#### 3.3.3 Soft Cap

Scores exceeding 5x median are capped.

```typescript
function applySoftCap(score: bigint, medianScore: bigint): bigint {
  const cap = medianScore * 5n;
  return score > cap ? cap : score;
}
```

### 3.4 Inflation Calculation

```typescript
const INFLATION_RATE_PER_EPOCH = 0.0001; // 0.01% per epoch
const epochReward = totalSupply * INFLATION_RATE_PER_EPOCH;

// Distribute proportionally by score
nodeReward = (nodeScore / totalScore) * epochReward;
```

---

## 4. Sybil Resistance Mechanisms

> For validator runtime anti-Sybil flow and config baseline, see Section 12 in `docs/anti-sybil-en.md` ("Validator Anti-Sybil Execution Flow").

### 4.1 Economic Barriers (CRITICAL)

#### 4.1.1 Progressive Bonding

Each operator's Nth node requires `MIN_BOND << N` ETH.

| Node # | Bond Required | Cumulative Cost |
|--------|--------------|-----------------|
| 1 | 0.1 ETH | 0.1 ETH |
| 2 | 0.2 ETH | 0.3 ETH |
| 3 | 0.4 ETH | 0.7 ETH |
| 4 | 0.8 ETH | 1.5 ETH |
| 5 | 1.6 ETH | 3.1 ETH |
| **50** | **5.6 × 10¹³ ETH** | **Prohibitive** |

**Contract Implementation**:
```solidity
function _requiredBond(uint8 existingNodeCount) internal pure returns (uint256) {
    return MIN_BOND << existingNodeCount;
}
```

#### 4.1.2 MAX_NODES_PER_OPERATOR

Each address can register max 5 nodes.

```solidity
if (operatorNodeCount[msg.sender] >= MAX_NODES_PER_OPERATOR)
    revert TooManyNodes();
```

### 4.2 Machine Fingerprinting (HIGH)

#### 4.2.1 Global Unique endpointCommitment

Prevents same physical machine from registering multiple virtual nodes.

```typescript
function computeMachineFingerprint(pubkey: string): string {
  const host = hostname();
  const ifaces = networkInterfaces();

  // Get first non-loopback non-zero MAC
  let mac = "00:00:00:00:00:00";
  for (const name of Object.keys(ifaces).sort()) {
    const entries = ifaces[name] ?? [];
    const found = entries.find(e =>
      !e.internal && e.mac !== "00:00:00:00:00:00"
    );
    if (found) { mac = found.mac; break; }
  }

  return `machine:${host}:${mac}:${pubkey}`;
}
```

**Contract Check**:
```solidity
if (endpointCommitmentUsed[endpointCommitment])
    revert EndpointAlreadyRegistered();

endpointCommitmentUsed[endpointCommitment] = true;
```

#### 4.2.2 Release Endpoint on Unbond

Allows legitimate nodes to re-register after exit.

```solidity
function requestUnbond(bytes32 nodeId) external {
    // ...
    endpointCommitmentUsed[node.endpointCommitment] = false;
}
```

### 4.3 Challenge Randomization (P1)

#### 4.3.1 Random Seeds

Each challenge uses `crypto.randomBytes(32)` to prevent prediction.

```typescript
const challenge: ChallengeMessage = {
  // ...
  randSeed: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
};
```

#### 4.3.2 Role Rotation

Deterministic rotation of challengers/aggregators based on L1 blockHash + epoch + pubkey.

```typescript
function isAssignedForRole(
  role: "challenger" | "aggregator",
  epochId: number,
  pubkey: string,
  blockHash: string
): boolean {
  const seed = keccak256(
    toUtf8Bytes(`${role}:${epochId}:${blockHash}`)
  );
  const nodeHash = keccak256(toUtf8Bytes(pubkey));
  return BigInt(nodeHash) % 10n === BigInt(seed) % 10n; // 10% selection rate
}
```

### 4.4 Admission Control (P1)

#### 4.4.1 Challenger Admission

When challengerSet is empty, agent must be a registered active node.

```typescript
function canRunForEpochRole(epochId: number): boolean {
  if (challengerSet.length === 0) {
    return selfNodeRegistered; // Queried from contract each tick
  }
  // ...
}
```

#### 4.4.2 Self-Registration Status Refresh

```typescript
async function refreshSelfNodeStatus(): Promise<void> {
  const nodeId = computeNodeId(pubkey);
  const record = await poseContract.getNode(nodeId);
  selfNodeRegistered = record.active && record.bondAmount > 0n;
}
```

### 4.5 Signature Verification (CRITICAL)

#### 4.5.1 Public Key Ownership Proof

Verifies msg.sender controls the corresponding public key during registration.

```solidity
function _verifyOwnership(
    bytes32 nodeId,
    bytes calldata pubkeyNode,
    bytes calldata sig
) internal view {
    if (sig.length != 65) revert InvalidOwnershipProof();

    bytes32 messageHash = keccak256(
        abi.encodePacked("coc-register:", nodeId, msg.sender)
    );
    bytes32 ethSignedHash = keccak256(
        abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
    );

    uint8 v = uint8(sig[64]);
    bytes32 r; bytes32 s;
    assembly {
        r := calldataload(sig.offset)
        s := calldataload(add(sig.offset, 32))
    }
    if (v < 27) v += 27;

    address recovered = ecrecover(ethSignedHash, v, r, s);
    if (recovered == address(0)) revert InvalidOwnershipProof();

    address nodeAddr = _pubkeyToAddress(pubkeyNode);
    if (recovered != nodeAddr) revert InvalidOwnershipProof();
}
```

#### 4.5.2 Challenge Signature Verification

```typescript
function verifyChallengerSig(
  challenge: ChallengeMessage,
  sig: Signature
): boolean {
  const payload = buildChallengeVerifyPayload(challenge);
  const recovered = recoverMessageAddress({
    message: { raw: payload },
    signature: sig
  });
  return recovered.toLowerCase() === challenge.challenger.toLowerCase();
}
```

#### 4.5.3 Receipt Signature Verification

```typescript
function verifyNodeSig(
  receipt: ReceiptMessage,
  sig: Signature
): boolean {
  const payload = buildReceiptSignMessage(receipt);
  const recovered = recoverMessageAddress({
    message: { raw: toHex(payload) },
    signature: sig
  });
  return recovered.toLowerCase() === receipt.nodeId.slice(0, 42).toLowerCase();
}
```

### 4.6 Nonce Replay Protection

```typescript
class NonceRegistry {
  private used = new Set<string>();

  markUsed(nonce: string): void {
    this.used.add(nonce);
  }

  isUsed(nonce: string): boolean {
    return this.used.has(nonce);
  }
}
```

**Limitation**: In-memory only, lost on restart (P2 TODO: persist to LevelDB).

---

## 5. Slashing Mechanism

### 5.1 Slash Reason Codes

| Code | Reason | Penalty % |
|------|--------|----------|
| 1 | Nonce replay / obvious fraud | 20% |
| 2 | Invalid signature | 15% |
| 3 | Timeout / liveness fault | 5% |
| 4 | Invalid storage proof | 30% |
| 5+ | Generic provable fault | 10% |

### 5.2 Slash Flow

```solidity
function slash(
    bytes32 nodeId,
    PoSeTypes.SlashEvidence calldata evidence
) external onlyRole(SLASHER_ROLE) {
    // 1. Verify evidence
    if (evidence.evidenceHash != keccak256(evidence.rawEvidence))
        revert InvalidSlashEvidence();

    // 2. Replay protection
    bytes32 replayKey = keccak256(
        abi.encodePacked("slash-evidence", nodeId,
                         evidence.reasonCode, evidence.evidenceHash)
    );
    if (usedReplayKeys[replayKey]) revert EvidenceAlreadyUsed();
    usedReplayKeys[replayKey] = true;

    // 3. Deduct bond
    uint16 slashBps = _slashBps(evidence.reasonCode);
    uint256 slashAmount = (node.bondAmount * slashBps) / 10_000;
    node.bondAmount -= slashAmount;

    // 4. Deactivate if bond = 0
    if (node.bondAmount == 0) {
        node.active = false;
    }

    emit NodeSlashed(nodeId, slashAmount, evidence.reasonCode);
}
```

---

## 6. Unbonding and Withdrawal

### 6.1 Unbond Delay

```solidity
uint64 public constant UNBOND_DELAY_EPOCHS = 7 * 24; // 7 days
```

### 6.2 Flow

```solidity
// 1. Request unbond
function requestUnbond(bytes32 nodeId) external {
    node.active = false;
    node.unlockEpoch = currentEpoch + UNBOND_DELAY_EPOCHS;
    unbondRequested[nodeId] = true;
    endpointCommitmentUsed[node.endpointCommitment] = false;
}

// 2. Withdraw after unlock
function withdraw(bytes32 nodeId) external {
    if (currentEpoch < node.unlockEpoch) revert UnlockNotReached();

    uint256 amount = node.bondAmount;
    node.bondAmount = 0;
    unbondRequested[nodeId] = false;

    payable(msg.sender).call{value: amount}("");
}
```

---

## 7. Data Flow Diagrams

### 7.1 Challenge-Response Flow

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│Challenger│         │   Node   │         │Aggregator│
└─────┬────┘         └────┬─────┘         └────┬─────┘
      │                   │                    │
      │ 1. POST /challenge│                    │
      │─────────────────>│                    │
      │                   │                    │
      │ 2. Receipt + Sig  │                    │
      │<─────────────────│                    │
      │                   │                    │
      │ 3. Verify sig     │                    │
      │                   │                    │
      │ 4. Submit receipt │                    │
      │──────────────────────────────────────>│
      │                   │                    │
      │                   │     5. Build Merkle tree
      │                   │                    │
      │                   │     6. submitBatch()
      │                   │                    │
```

### 7.2 Dispute Flow

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│ Slasher  │         │PoSeManager│        │ Relayer  │
└────┬─────┘         └────┬─────┘         └────┬─────┘
     │                    │                    │
     │ 1. Detect fraud    │                    │
     │                    │                    │
     │ 2. challengeBatch()│                    │
     │───────────────────>│                    │
     │                    │                    │
     │                    │ 3. Mark disputed   │
     │                    │                    │
     │                    │      4. Listen event
     │                    │<───────────────────│
     │                    │                    │
     │                    │      5. slash()    │
     │                    │<───────────────────│
     │                    │                    │
```

---

## 8. Security Analysis

### 8.1 Fixed Vulnerabilities (10 total)

| Severity | Count | Vulnerabilities |
|----------|-------|----------------|
| CRITICAL | 4 | Bond collection, MIN_BOND, signature verification, pubkey ownership |
| HIGH | 2 | Sybil registration defense, storageGb hardcoding |
| P1 | 4 | Uptime strictness, randSeed randomization, machine fingerprint, admission control |

### 8.2 Residual Risks (P2)

| Risk | Impact | Priority |
|------|--------|----------|
| Relay witness forgery | False relay rewards | P2 |
| NonceRegistry restart loss | Replay attack window | P2 |
| blockHash seed predictable | Role assignment manipulation | P2 |
| MAC software spoofing | Machine fingerprint bypass | P3 |
| Cross-address Sybil | Multi-wallet progressive bond bypass | P2 |

### 8.3 Attack Cost Assessment

| Attack Type | Cost | Success Rate | Defense Status |
|------------|------|--------------|----------------|
| Single-address multi-node | 3.1 ETH (5 nodes) | 0% | ✅ Blocked |
| Multi-address Sybil | N × 0.1 ETH | Medium | ⚠️ Partial |
| Storage shell | 0.1 ETH | Low | ✅ Blocked |
| Uptime shell | 0.1 ETH | Low | ✅ Blocked |
| Relay forgery | 0.1 ETH | Medium | ⚠️ TODO |

---

## 9. Performance Metrics

### 9.1 Throughput

- **Challenge frequency**: ~100 challenges/epoch/challenger
- **Batch aggregation**: ~1000 receipts/batch
- **L1 gas consumption**: ~500K gas/batch submit

### 9.2 Latency

- **Challenge response**: < 2 seconds
- **Receipt verification**: < 100ms
- **Batch finalization**: 2 epochs (~2 hours)

### 9.3 Storage

- **Node state**: ~200 bytes/node
- **Batch metadata**: ~300 bytes/batch
- **Merkle proof**: ~1KB/sample

---

## 10. Deployment Configuration

### 10.1 Network Parameters

```yaml
network:
  chainId: 2077
  l1RpcUrl: "https://mainnet.base.org"
  l2RpcUrl: "http://localhost:8545"
  poseManagerAddress: "0x..." # L1 contract address

epoch:
  durationSeconds: 3600
  disputeWindowEpochs: 2
  unbondDelayEpochs: 168 # 7 days
```

### 10.2 Node Configuration

```yaml
node:
  privateKey: "0x..." # Node private key
  httpPort: 3000
  bondAmount: "0.1" # ETH

challenge:
  uptimeQuota: 50
  storageQuota: 30
  relayQuota: 20
```

### 10.3 Policy Configuration

```yaml
policy:
  maxConcurrentChallenges: 10
  challengeTimeoutMs: 5000
  retryAttempts: 3

scoring:
  uptimeWeight: 0.6
  storageWeight: 0.3
  relayWeight: 0.1
  storageDiminishingFactor: 0.5 # sqrt
```

---

## 11. Monitoring and Alerting

### 11.1 Key Metrics

| Metric | Threshold | Alert Level |
|--------|-----------|-------------|
| Challenge success rate | < 95% | WARNING |
| Receipt verification failure rate | > 5% | CRITICAL |
| Batch dispute rate | > 10% | WARNING |
| Node slash rate | > 20% | CRITICAL |
| Epoch delay | > 10 minutes | WARNING |

### 11.2 Log Format

```json
{
  "level": "info",
  "timestamp": "2026-02-14T12:34:56Z",
  "module": "coc-agent",
  "event": "challenge_completed",
  "data": {
    "nodeId": "0xabc...",
    "challengeType": "Storage",
    "success": true,
    "latencyMs": 1234
  }
}
```

---

## 12. Future Roadmap

### 12.1 P2 Priorities

1. **Relay witness strict verification** (Q2 2026)
2. **Nonce persistence** (Q2 2026)
3. **VRF role assignment** (Q3 2026)
4. **Cross-address Sybil detection** (Q3 2026)

### 12.2 P3 Long-term Goals

- Data Availability Sampling (DAS)
- TEE hardware fingerprinting
- Decentralized challenger marketplace
- ZK proof optimizations

---

## 13. References

- [EthereumJS VM Documentation](https://github.com/ethereumjs/ethereumjs-monorepo)
- [Merkle Tree Best Practices](https://en.wikipedia.org/wiki/Merkle_tree)
- [EIP-191: Signed Data Standard](https://eips.ethereum.org/EIPS/eip-191)
- [Progressive Bonding Paper](https://arxiv.org/abs/...)

---

**Maintainers**: COC Core Team
**Contact**: dev@chainofclaw.org
**License**: MIT
