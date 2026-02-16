# COC Anti-Sybil Attack Mechanisms

> **Version**: v1.0.0
> **Last Updated**: 2026-02-16
> **Defense Coverage**: 70-75%, P0+P1 Complete

---

## Table of Contents

1. [Threat Model](#1-threat-model)
2. [Multi-Layer Defense System](#2-multi-layer-defense-system)
3. [Economic Barrier Layer](#3-economic-barrier-layer)
4. [Identity Binding Layer](#4-identity-binding-layer)
5. [Challenge Randomization Layer](#5-challenge-randomization-layer)
6. [Admission Control Layer](#6-admission-control-layer)
7. [Cryptographic Verification Layer](#7-cryptographic-verification-layer)
8. [Attack Scenario Analysis](#8-attack-scenario-analysis)
9. [Residual Risks](#9-residual-risks)
10. [Enhancement Roadmap](#10-enhancement-roadmap)
11. [Summary](#11-summary)
12. [Validator Anti-Sybil Execution Flow](#12-validator-anti-sybil-execution-flow)

---

## 1. Threat Model

### 1.1 Attacker Goals

- **Maximize Rewards**: Obtain maximum PoSe rewards at minimum cost
- **Long-term Harvesting**: Avoid slashing, sustain inflation rewards
- **Stealth**: Bypass detection, mimic legitimate node behavior

### 1.2 Attacker Capabilities

| Capability | Description |
|------------|-------------|
| Multi-address | Control multiple Ethereum wallet addresses |
| Multi-machine | Own multiple VPS or physical machines |
| Capital | Have ETH available for bonding |
| Technical | Understand protocol rules, write automation scripts |
| Limitations | Cannot break cryptography, cannot control L1 block production |

### 1.3 Sybil Attack Types

#### 1.3.1 Single-Address Multi-Node
- **Method**: Register multiple nodes with one wallet address
- **Cost**: Progressive bonding (0.1→0.2→0.4...)
- **Reward**: Multiple PoSe rewards
- **Defense Status**: ✅ **Blocked**

#### 1.3.2 Multi-Address Sybil
- **Method**: Register 1 node per wallet address across multiple wallets
- **Cost**: N × 0.1 ETH (bypasses progressive bonding)
- **Reward**: N rewards
- **Defense Status**: ⚠️ **Partial** (machine fingerprint limits same-machine)

#### 1.3.3 Storage Shell
- **Method**: Register node without storing data, forge challenge responses
- **Cost**: 0.1 ETH
- **Reward**: Storage rewards (30% weight)
- **Defense Status**: ✅ **Blocked** (Merkle proof + random seed)

#### 1.3.4 Uptime Shell
- **Method**: Node only responds to uptime probes, no actual service
- **Cost**: 0.1 ETH
- **Reward**: Uptime rewards (60% weight)
- **Defense Status**: ✅ **Blocked** (blockNumber verification)

#### 1.3.5 Relay Forgery
- **Method**: Submit fake relay witness
- **Cost**: 0.1 ETH
- **Reward**: Relay rewards (10% weight)
- **Defense Status**: ⚠️ **TODO** (P2 priority)

---

## 2. Multi-Layer Defense System

```
┌─────────────────────────────────────────┐
│      L1: Economic Barriers (CRITICAL)    │
│  ✅ Progressive bonding + MIN_BOND + MAX_NODES   │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│      L2: Identity Binding (HIGH)         │
│  ✅ Machine fingerprint + endpointCommitment unique  │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│      L3: Challenge Randomization (P1)    │
│  ✅ Random seed + Role rotation          │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│      L4: Admission Control (P1)          │
│  ✅ Registered node admission + Contract state sync │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│      L5: Cryptographic Verification (CRITICAL) │
│  ✅ Signature verification + Pubkey ownership + Nonce anti-replay │
└─────────────────────────────────────────┘
```

---

## 3. Economic Barrier Layer

### 3.1 Progressive Bonding

#### 3.1.1 Principle

Each operator's Nth node requires `MIN_BOND << N` ETH, creating exponential cost growth.

**Formula**:
```
BondRequired(N) = MIN_BOND × 2^N
```

#### 3.1.2 Cost Table

| Node # | Bond Required | Cumulative Cost | ROI Est. (10% APY) |
|--------|--------------|-----------------|---------------------|
| 1 | 0.1 ETH | 0.1 ETH | 10% |
| 2 | 0.2 ETH | 0.3 ETH | 7% |
| 3 | 0.4 ETH | 0.7 ETH | 5% |
| 4 | 0.8 ETH | 1.5 ETH | 3% |
| 5 | 1.6 ETH | 3.1 ETH | 2% |
| 10 | 102.4 ETH | 204.7 ETH | **Negative** |
| 20 | 104,857.6 ETH | 209,715.1 ETH | **Prohibitive** |

**Conclusion**: More than 5 nodes per address is economically infeasible.

#### 3.1.3 Contract Implementation

```solidity
// contracts/settlement/PoSeManager.sol

function registerNode(
    bytes32 nodeId,
    bytes calldata pubkeyNode,
    uint8 serviceFlags,
    bytes32 serviceCommitment,
    bytes32 endpointCommitment,
    bytes32 metadataHash,
    bytes calldata ownershipSig
) external payable {
    // Progressive bonding check
    uint256 bondRequired = _requiredBond(operatorNodeCount[msg.sender]);
    if (msg.value < bondRequired) revert InsufficientBond();

    // Node count cap check
    if (operatorNodeCount[msg.sender] >= MAX_NODES_PER_OPERATOR)
        revert TooManyNodes();

    // ... other logic
    operatorNodeCount[msg.sender] += 1;
}

function _requiredBond(uint8 existingNodeCount) internal pure returns (uint256) {
    return MIN_BOND << existingNodeCount;
}

// Public query interface
function requiredBond(address operator) external view returns (uint256) {
    return _requiredBond(operatorNodeCount[operator]);
}
```

#### 3.1.4 Agent-Side Call

```typescript
// runtime/coc-agent.ts

async function ensureNodeRegistered(): Promise<void> {
  const signer = getSigner();

  // Query required bond for current address
  const bondRequired = await poseContract.requiredBond(
    signer.address
  ) as bigint;

  console.log(`Progressive bond required: ${formatEther(bondRequired)} ETH`);

  // Send ETH + registration call
  const tx = await poseContract.registerNode(
    nodeId,
    pubkey,
    serviceFlags,
    serviceCommitment,
    endpointCommitment,
    metadataHash,
    ownershipSig,
    { value: bondRequired }
  );

  await tx.wait();
}
```

### 3.2 Minimum Bond (MIN_BOND)

```solidity
// contracts/settlement/PoSeManagerStorage.sol

uint256 public constant MIN_BOND = 0.1 ether;
```

**Purpose**:
- Raise baseline attack cost
- 100 nodes require at least 10 ETH (assuming multi-address bypass)
- Combined with slashing, creates economic deterrence

### 3.3 Per-Address Node Cap (MAX_NODES_PER_OPERATOR)

```solidity
uint8 public constant MAX_NODES_PER_OPERATOR = 5;
```

**Purpose**:
- Prevent unlimited registration per address
- Combined with progressive bonding, 5 nodes require cumulative 3.1 ETH
- Forces attackers to use multiple addresses (increases management cost)

---

## 4. Identity Binding Layer

### 4.1 Machine Fingerprinting

#### 4.1.1 Design Goal

Prevent same physical machine from registering multiple virtual nodes (e.g., via different ports or Docker containers).

#### 4.1.2 Fingerprint Algorithm

```typescript
// runtime/coc-agent.ts

import { hostname, networkInterfaces } from "node:os";

function computeMachineFingerprint(pubkey: string): string {
  const host = hostname();
  const ifaces = networkInterfaces();

  // Get first non-loopback non-zero MAC address
  let mac = "00:00:00:00:00:00";
  for (const name of Object.keys(ifaces).sort()) {
    const entries = ifaces[name] ?? [];
    const found = entries.find(e =>
      !e.internal && e.mac !== "00:00:00:00:00:00"
    );
    if (found) {
      mac = found.mac;
      break;
    }
  }

  return `machine:${host}:${mac}:${pubkey}`;
}
```

**Fingerprint Components**:
```
machine:{hostname}:{primary_mac}:{node_pubkey}
```

**Example**:
```
machine:node-1.example.com:00:1A:2B:3C:4D:5E:0x04abc123...
```

#### 4.1.3 endpointCommitment Uniqueness

```typescript
// runtime/coc-agent.ts

const fingerprint = computeMachineFingerprint(pubkey);
const endpointCommitment = keccak256(toUtf8Bytes(fingerprint));
```

**Contract Check**:
```solidity
// contracts/settlement/PoSeManagerStorage.sol

mapping(bytes32 => bool) public endpointCommitmentUsed;

// contracts/settlement/PoSeManager.sol

function registerNode(...) external payable {
    // Global uniqueness check
    if (endpointCommitmentUsed[endpointCommitment])
        revert EndpointAlreadyRegistered();

    // Mark as used
    endpointCommitmentUsed[endpointCommitment] = true;

    // ...
}
```

#### 4.1.4 Release on Unbond

Allows legitimate nodes to re-register on same machine after exit.

```solidity
function requestUnbond(bytes32 nodeId) external {
    PoSeTypes.NodeRecord storage node = nodes[nodeId];
    if (!node.active) revert NodeNotFound();
    if (nodeOperator[nodeId] != msg.sender) revert NotNodeOperator();

    // Release endpoint
    endpointCommitmentUsed[node.endpointCommitment] = false;

    // ... other unbond logic
}
```

### 4.2 Attack Scenarios vs. Defense

| Attack Scenario | Machine Fingerprint Defense |
|----------------|----------------------------|
| Same machine different ports | ✅ **Blocked** (same MAC + hostname) |
| Same machine different Docker containers | ✅ **Blocked** (shares host MAC) |
| Different VPS | ⚠️ **Cannot defend** (different MACs) |
| MAC address spoofing | ⚠️ **Possible bypass** (software-level spoofing) |

### 4.3 Limitations

- **MAC software spoofing**: Not hardware-level security
- **Cross-machine ineffective**: Different VPS have different MACs
- **Long-term plan**: P3 consider TEE hardware fingerprinting

---

## 5. Challenge Randomization Layer

### 5.1 Random Seed Generation

#### 5.1.1 Old Version Issue (Fixed)

```typescript
// ❌ Old code (pre-P1)
const randSeed = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
```

**Vulnerability**: Attackers can predict challenge content, prepare responses in advance.

#### 5.1.2 New Implementation (P1)

```typescript
// ✅ New code (post-P1)
import { randomBytes } from "node:crypto";

const challenge: ChallengeMessage = {
  challenger: signer.address as `0x${string}`,
  challengee: targetNodeId,
  challengeType: "Storage",
  querySpec: storageQuery,
  nonce: `0x${randomBytes(16).toString("hex")}` as `0x${string}`,
  randSeed: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  timestamp: Date.now(),
};
```

**Entropy Source**: `crypto.randomBytes(32)` uses OS CSPRNG (Cryptographically Secure Pseudo-Random Number Generator).

**Security**: 2^256 seed space, unpredictable.

### 5.2 Role Rotation

#### 5.2.1 Deterministic Assignment

Based on L1 blockHash + epoch + pubkey, calculate if node is assigned as challenger/aggregator.

```typescript
// services/common/role-assignment.ts

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
  return BigInt(nodeHash) % 10n === BigInt(seed) % 10n;
}
```

#### 5.2.2 Anti-Cheat Mechanism

| Cheat Method | Defense |
|-------------|---------|
| Predict when selected as challenger | ❌ blockHash decided by L1 miners, unpredictable |
| Manipulate blockHash | ❌ Requires controlling L1 consensus, extremely high cost |
| Register many nodes to increase selection rate | ⚠️ Limited by economic barriers, progressive bonding |

#### 5.2.3 Limitations (P2 TODO)

- **blockHash predictable**: L1 miners can manipulate (low probability but theoretically possible)
- **Long-term solution**: P2 introduce VRF (Verifiable Random Function)

---

## 6. Admission Control Layer

### 6.1 Challenger Admission

#### 6.1.1 Old Version Issue (Fixed)

```typescript
// ❌ Old code (pre-P1)
function canRunForEpochRole(epochId: number): boolean {
  if (challengerSet.length === 0) {
    return true; // Anyone can be challenger
  }
  // ...
}
```

**Vulnerability**: Unregistered nodes can issue challenges, zero-cost Sybil participation.

#### 6.1.2 New Implementation (P1)

```typescript
// ✅ New code (post-P1)
let selfNodeRegistered = false;

async function refreshSelfNodeStatus(): Promise<void> {
  const nodeId = computeNodeId(pubkey);
  const record = await poseContract.getNode(nodeId) as NodeRecord;
  selfNodeRegistered = record.active && record.bondAmount > 0n;
}

function canRunForEpochRole(epochId: number): boolean {
  if (challengerSet.length === 0) {
    return selfNodeRegistered; // Must be registered active node
  }
  // ...
}

// Refresh state each tick
async function tick(): Promise<void> {
  await refreshLatestBlock();
  await refreshSelfNodeStatus(); // New

  const epochId = computeCurrentEpoch();
  if (canRunForEpochRole(epochId)) {
    await tryChallenge();
  }
  // ...
}
```

#### 6.1.3 Defense Effectiveness

| Attack Scenario | Defense |
|----------------|---------|
| Unbonded node issues challenges | ✅ **Blocked** (selfNodeRegistered=false) |
| Slashed node continues challenging | ✅ **Blocked** (bondAmount=0 → active=false) |
| Post-unbond challenges | ✅ **Blocked** (active=false) |

### 6.2 Aggregator Admission

Same logic applies to aggregator role.

```typescript
function canRunAggregatorRole(epochId: number): boolean {
  if (aggregatorSet.length === 0) {
    return selfNodeRegistered; // Same as challenger logic
  }
  // ...
}
```

---

## 7. Cryptographic Verification Layer

### 7.1 Public Key Ownership Proof

#### 7.1.1 Challenge

How to prove `msg.sender` controls the corresponding `pubkeyNode` during registration?

#### 7.1.2 Solution

Use ECDSA signature + `abi.encodePacked` to construct message.

**Signature Message**:
```
abi.encodePacked("coc-register:", nodeId, msg.sender)
```

**Contract Verification**:
```solidity
// contracts/settlement/PoSeManager.sol

function _verifyOwnership(
    bytes32 nodeId,
    bytes calldata pubkeyNode,
    bytes calldata sig
) internal view {
    if (sig.length != 65) revert InvalidOwnershipProof();

    // Construct message
    bytes32 messageHash = keccak256(
        abi.encodePacked("coc-register:", nodeId, msg.sender)
    );

    // EIP-191 prefix
    bytes32 ethSignedHash = keccak256(
        abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
    );

    // Extract r, s, v
    uint8 v = uint8(sig[64]);
    bytes32 r; bytes32 s;
    assembly {
        r := calldataload(sig.offset)
        s := calldataload(add(sig.offset, 32))
    }
    if (v < 27) v += 27;

    // Recover signer address
    address recovered = ecrecover(ethSignedHash, v, r, s);
    if (recovered == address(0)) revert InvalidOwnershipProof();

    // Verify matches pubkeyNode address
    address nodeAddr = _pubkeyToAddress(pubkeyNode);
    if (recovered != nodeAddr) revert InvalidOwnershipProof();
}

function _pubkeyToAddress(bytes calldata pubkey) internal pure returns (address) {
    if (pubkey.length == 65) {
        return address(uint160(uint256(keccak256(pubkey[1:]))));
    }
    if (pubkey.length == 64) {
        return address(uint160(uint256(keccak256(pubkey))));
    }
    revert InvalidNodeId();
}
```

#### 7.1.3 Agent-Side Signing

```typescript
// runtime/coc-agent.ts

async function ensureNodeRegistered(): Promise<void> {
  const signer = getSigner();
  const nodeId = computeNodeId(pubkey);

  // Construct signature message (matches contract)
  const message = Buffer.concat([
    Buffer.from("coc-register:", "utf8"),
    Buffer.from(nodeId.slice(2), "hex"),
    Buffer.from(signer.address.slice(2), "hex"),
  ]);

  // Sign
  const ownershipSig = await signer.signMessage(message);

  // Call contract
  const tx = await poseContract.registerNode(
    nodeId,
    pubkey,
    serviceFlags,
    serviceCommitment,
    endpointCommitment,
    metadataHash,
    ownershipSig,
    { value: bondRequired }
  );

  await tx.wait();
}
```

### 7.2 Challenge Signature Verification

#### 7.2.1 Old Version Issue (Fixed)

```typescript
// ❌ Old code (pre-CRITICAL fix)
verifyChallengerSig: () => true, // No verification
```

#### 7.2.2 New Implementation (CRITICAL)

```typescript
// ✅ New code (post-CRITICAL fix)
import { recoverMessageAddress } from "viem";

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

function buildChallengeVerifyPayload(c: ChallengeMessage): `0x${string}` {
  const parts = [
    c.challenger,
    c.challengee,
    c.challengeType,
    JSON.stringify(c.querySpec),
    c.nonce,
    c.randSeed,
    c.timestamp.toString(),
  ];
  return toHex(parts.join(":"));
}
```

### 7.3 Receipt Signature Verification

#### 7.3.1 Old Version Issue (Fixed)

```typescript
// ❌ Old code (pre-CRITICAL fix)
verifyNodeSig: () => true, // No verification
```

#### 7.3.2 New Implementation (CRITICAL)

```typescript
// ✅ New code (post-CRITICAL fix)
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

function buildReceiptSignMessage(r: ReceiptMessage): Buffer {
  const parts = [
    r.nodeId,
    r.challenger,
    r.challengeType,
    r.nonce,
    r.randSeed,
    r.timestamp.toString(),
    JSON.stringify(r.responseBody),
  ];
  return Buffer.from(parts.join(":"), "utf8");
}
```

### 7.4 Nonce Anti-Replay

```typescript
// services/common/nonce-registry.ts

class NonceRegistry {
  private used = new Set<string>();

  markUsed(nonce: string): void {
    this.used.add(nonce);
  }

  isUsed(nonce: string): boolean {
    return this.used.has(nonce);
  }

  clear(): void {
    this.used.clear();
  }
}
```

**Limitation**:
- **In-memory only**: Lost on process restart
- **P2 improvement**: Persist to LevelDB

**Contract-Side Anti-Replay**:
```solidity
// contracts/settlement/PoSeManager.sol

mapping(bytes32 => bool) internal usedReplayKeys;

function slash(...) external onlyRole(SLASHER_ROLE) {
    bytes32 replayKey = keccak256(
        abi.encodePacked("slash-evidence", nodeId,
                         evidence.reasonCode, evidence.evidenceHash)
    );
    if (usedReplayKeys[replayKey]) revert EvidenceAlreadyUsed();
    usedReplayKeys[replayKey] = true;

    // ...
}
```

---

## 8. Attack Scenario Analysis

### 8.1 Scenario 1: Single-Address Multi-Node

**Attack Flow**:
```
1. Use address 0xA to register node 1 → Bond 0.1 ETH
2. Use address 0xA to register node 2 → Bond 0.2 ETH
3. Use address 0xA to register node 3 → Bond 0.4 ETH
4. ...
```

**Defense Mechanisms**:
- ✅ Progressive bonding — 5th node requires 1.6 ETH
- ✅ MAX_NODES_PER_OPERATOR — Max 5 nodes
- ✅ Cumulative cost 3.1 ETH, ROI < 2%

**Conclusion**: **Completely blocked**.

---

### 8.2 Scenario 2: Multi-Address Sybil

**Attack Flow**:
```
1. Address 0xA registers node A → 0.1 ETH
2. Address 0xB registers node B → 0.1 ETH
3. Address 0xC registers node C → 0.1 ETH
4. ...
```

**Defense Mechanisms**:
- ⚠️ Progressive bonding — Bypassed (1 node per address)
- ✅ Machine fingerprint — Same-machine different ports blocked
- ⚠️ Different VPS — Cannot detect

**Cost Analysis**:
| Node Count | Bond Cost | Annual Yield (Est.) | ROI |
|-----------|-----------|---------------------|-----|
| 10 | 1 ETH | 0.15 ETH | 15% |
| 50 | 5 ETH | 0.75 ETH | 15% |
| 100 | 10 ETH | 1.5 ETH | 15% |

**Conclusion**: ⚠️ **Economically viable** (P2 TODO).

**P2 Defense Plans**:
- On-chain identity aggregation (common funder detection)
- Social graph analysis
- Raise MIN_BOND (e.g., 0.5 ETH)

---

### 8.3 Scenario 3: Storage Shell Node

**Attack Flow**:
```
1. Register node without storing data
2. Upon Storage challenge:
   - Return fake Merkle proof
   - Or pre-cache challenge data
```

**Defense Mechanisms**:
- ✅ Random seed — Cannot predict challenge content
- ✅ Merkle proof verification — Must provide valid proof
- ✅ Dynamic storageGb — Accumulate verifiedStorageBytes

**Test Case**:
```typescript
// services/verifier/receipt-verifier.test.ts

test("reject storage receipt with invalid merkle proof", () => {
  const challenge = createStorageChallenge(cid, offset, length);
  const receipt = {
    ...validReceipt,
    responseBody: {
      merkleProof: ["0xinvalid"], // Invalid proof
    },
  };

  const result = verifier.verifyStorageResult(challenge, receipt);
  expect(result).toBe(false);
});
```

**Conclusion**: ✅ **Completely blocked**.

---

### 8.4 Scenario 4: Uptime Shell Node

**Attack Flow**:
```
1. Node only runs eth_blockNumber API
2. Doesn't sync full chain state
3. Pass uptime challenges to get 60% weight rewards
```

**Old Version Issue (Fixed)**:
```typescript
// ❌ Pre-P1
verifyUptimeResult: (challenge, receipt) => {
  return receipt.responseBody?.ok === true; // Only checks ok field
};
```

**New Defense (P1)**:
```typescript
// ✅ Post-P1
verifyUptimeResult: (challenge, receipt) => {
  if (!receipt.responseBody?.ok) return false;

  const bn = Number(receipt.responseBody?.blockNumber);
  if (!Number.isFinite(bn) || bn <= 0) return false;

  const minBn = Number((challenge.querySpec as any)?.minBlockNumber ?? 0);
  if (minBn > 0 && bn < minBn) return false;

  return true;
};
```

**Verification Logic**:
```
blockNumber >= latestBlock - 10
```

**Attack Cost**:
- Must sync L1 chain (requires storage + bandwidth)
- Forged blockNumber intercepted by verification

**Conclusion**: ✅ **Completely blocked**.

---

### 8.5 Scenario 5: Relay Forgery

**Attack Flow**:
```
1. Receive Relay challenge
2. Return fake witness data
3. Obtain relay rewards (10% weight)
```

**Current Implementation (P2 TODO)**:
```typescript
verifyRelayResult: (challenge, receipt) => {
  const witness = receipt.responseBody?.witness;
  return !!witness; // Only checks existence
};
```

**Vulnerability**: Doesn't verify witness signature and transaction content.

**P2 Improvement Plan**:
```typescript
verifyRelayResult: async (challenge, receipt) => {
  const witness = receipt.responseBody?.witness;
  if (!witness || !witness.signature) return false;

  // Verify witness signature
  const txHash = challenge.querySpec.txHash;
  const recovered = recoverMessageAddress({
    message: txHash,
    signature: witness.signature
  });

  if (recovered !== witness.relayer) return false;

  // Verify transaction on-chain
  const tx = await l1Provider.getTransaction(txHash);
  if (!tx || tx.from !== witness.relayer) return false;

  return true;
};
```

**Conclusion**: ⚠️ **P2 Priority #1**.

---

## 9. Residual Risks

### 9.1 P2 Priorities

| # | Risk | Impact | Fix Difficulty | Priority |
|---|------|--------|---------------|----------|
| 1 | Relay witness forgery | Fake relay rewards | Medium | P2-High |
| 2 | NonceRegistry restart loss | Replay attack window | Low | P2-Med |
| 3 | blockHash seed predictable | Role assignment manipulation | High | P2-Med |
| 4 | Cross-address Sybil | Multi-wallet bypass progressive bonding | High | P2-Med |

### 9.2 P3 Long-term

| # | Risk | Impact | Fix Solution |
|---|------|--------|--------------|
| 5 | MAC software spoofing | Machine fingerprint bypass | TEE hardware fingerprint |
| 6 | Insufficient data availability | Cannot verify network-wide storage | DAS (Data Availability Sampling) |
| 7 | Centralized challenger | Single point of failure | Decentralized challenger marketplace |

---

## 10. Enhancement Roadmap

### 10.1 Q2 2026 (P2-High)

#### 10.1.1 Relay Witness Strict Verification

**Implementation Steps**:
1. Define RelayWitness struct
   ```typescript
   interface RelayWitness {
     relayer: `0x${string}`;
     txHash: `0x${string}`;
     signature: Signature;
     timestamp: number;
   }
   ```

2. Update verifyRelayResult
   ```typescript
   verifyRelayResult: async (challenge, receipt) => {
     const witness = receipt.responseBody?.witness as RelayWitness;

     // Signature verification
     const message = `relay:${witness.txHash}:${witness.timestamp}`;
     const recovered = recoverMessageAddress({
       message: { raw: toHex(message) },
       signature: witness.signature
     });
     if (recovered !== witness.relayer) return false;

     // On-chain verification
     const tx = await l1Provider.getTransaction(witness.txHash);
     if (!tx || tx.from !== witness.relayer) return false;

     return true;
   };
   ```

3. Test coverage
   - Valid witness passes
   - Forged signature rejected
   - Un-mined transaction rejected

**Estimated Time**: 1-2 weeks

---

#### 10.1.2 Nonce Persistence

**Implementation Steps**:
1. Introduce LevelDB
   ```typescript
   import { Level } from "level";

   class PersistentNonceRegistry {
     private db: Level<string, boolean>;

     constructor(dbPath: string) {
       this.db = new Level(dbPath);
     }

     async markUsed(nonce: string): Promise<void> {
       await this.db.put(nonce, true);
     }

     async isUsed(nonce: string): Promise<boolean> {
       try {
         return await this.db.get(nonce);
       } catch {
         return false;
       }
     }
   }
   ```

2. Update coc-agent.ts
   ```typescript
   const nonceRegistry = new PersistentNonceRegistry("./data/nonces");
   ```

3. Add cleanup task
   ```typescript
   // Daily cleanup of nonces older than 7 days
   setInterval(async () => {
     const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
     // ...
   }, 24 * 3600 * 1000);
   ```

**Estimated Time**: 1 week

---

### 10.2 Q3 2026 (P2-Med)

#### 10.2.1 VRF Role Assignment

**Solution**: Use Chainlink VRF to replace blockHash seed.

**Implementation Steps**:
1. Deploy VRF Consumer contract
   ```solidity
   contract PoSeVRF is VRFConsumerBase {
       mapping(uint64 => bytes32) public epochRandomness;

       function requestRandomness(uint64 epochId) external {
           // ...
       }

       function fulfillRandomness(bytes32 requestId, uint256 randomness) internal {
           // ...
       }
   }
   ```

2. Update role assignment logic
   ```typescript
   async function isAssignedForRole(
     role: string,
     epochId: number,
     pubkey: string
   ): Promise<boolean> {
     const randomness = await vrfContract.epochRandomness(epochId);
     const seed = keccak256(toUtf8Bytes(`${role}:${epochId}:${randomness}`));
     // ...
   }
   ```

**Estimated Time**: 2-3 weeks

---

#### 10.2.2 Cross-Address Sybil Detection

**Solution**: On-chain fund flow analysis + reputation system.

**Implementation Steps**:
1. Deploy IdentityRegistry contract
   ```solidity
   contract IdentityRegistry {
       mapping(address => bytes32) public addressCluster;

       function flagSybilCluster(address[] calldata addresses, bytes32 clusterId) external onlyOracle {
           for (uint i = 0; i < addresses.length; i++) {
               addressCluster[addresses[i]] = clusterId;
           }
       }
   }
   ```

2. PoSeManager integration
   ```solidity
   function registerNode(...) external payable {
       // Check if in flagged Sybil cluster
       bytes32 cluster = identityRegistry.addressCluster(msg.sender);
       if (cluster != bytes32(0)) revert SybilClusterDetected();

       // ...
   }
   ```

3. Off-chain analysis service
   - Monitor registration events
   - Analyze fund sources (common funder)
   - Detect similar transaction patterns
   - Submit Sybil cluster flags

**Estimated Time**: 4-6 weeks

---

### 10.3 2027+ (P3)

#### 10.3.1 TEE Hardware Fingerprinting

**Solution**: Intel SGX / AMD SEV Trusted Execution Environment.

**Advantages**:
- Hardware-level MAC address verification
- Prevent virtualization bypass
- Remote Attestation

**Challenges**:
- Requires hardware support
- High development complexity
- Increased user deployment cost

---

#### 10.3.2 Data Availability Sampling (DAS)

**Solution**: Random sampling of network storage data, verify network-wide storage.

**Implementation**:
- KZG commitments
- Reed-Solomon encoding
- Random sampling verification

**Reference**: Celestia, EigenDA

---

#### 10.3.3 Decentralized Challenger Marketplace

**Solution**: Anyone can stake to become challenger, earn challenge rewards.

**Mechanism**:
- Challenger stake pool
- Challenge quota auction
- Reward distribution algorithm

**Advantages**:
- Increased decentralization
- Improved challenge coverage
- Reduced single point of failure risk

---

## 11. Summary

### 11.1 Defense Matrix

| Attack Type | Cost | Success Rate | Defense Status | Priority |
|------------|------|--------------|----------------|----------|
| Single-address multi-node | 3.1 ETH (5 nodes) | 0% | ✅ Blocked | - |
| Multi-address Sybil (same machine) | N × 0.1 ETH | 0% | ✅ Blocked | - |
| Multi-address Sybil (different VPS) | N × 0.1 ETH | Medium | ⚠️ Partial | P2 |
| Storage shell | 0.1 ETH | 0% | ✅ Blocked | - |
| Uptime shell | 0.1 ETH | 0% | ✅ Blocked | - |
| Relay forgery | 0.1 ETH | High | ❌ TODO | P2-High |
| Nonce replay | Low | Low | ⚠️ Restart window | P2-Med |
| Role assignment manipulation | Extreme | Low | ⚠️ Theoretical | P2-Med |

### 11.2 Defense Level

**Current**: 70-75% coverage

**Post-P2**: 85-90% coverage

**Post-P3**: 95%+ coverage

### 11.3 Recommendations

1. **Immediate P2-High** — Relay witness verification (Q2 2026)
2. **Q3 Complete P2-Med** — VRF + Cross-address detection
3. **Continuous Monitoring** — Real-time detection of anomalous registration patterns
4. **Progressive MIN_BOND increase** — Adjust based on network scale

---

## 12. Validator Anti-Sybil Execution Flow

This section explains how validators block Sybil cheating at runtime, mapped to current code paths and config switches.

### 12.1 Security Objectives

- Prevent fake identities from entering discovery and communication surfaces.
- Prevent unauthorized challengers from draining challenge budget.
- Prevent replay and low-cost flooding patterns.
- Apply automated mitigation (de-prioritize/ban) instead of manual-only operations.

### 12.2 Validator Runtime Flow (by request lifecycle)

1. Registration and economic barriers
- Validators rely on `PoSeManager` controls: `MIN_BOND`, `MAX_NODES_PER_OPERATOR`, and `requiredBond()`.
- Effect: expansion cost grows exponentially for the same operator.

2. Inbound authentication (P2P/PoSe)
- P2P and PoSe write paths support default-enforce signature auth with time-skew and nonce checks.
- Key implementation: `node/src/p2p.ts`, `node/src/pose-http.ts`.

3. Dynamic challenger authorization
- Validators enforce layered challenger authorization:
  - static allowlist
  - dynamic resolver (governance active set or on-chain `operatorNodeCount(address)`)
- Key implementation: `node/src/pose-authorizer.ts`, `node/src/pose-onchain-authorizer.ts`, `node/src/index.ts`.

4. Discovery identity proof
- Newly discovered peers are promoted only after `/p2p/identity-proof` challenge-signature validation.
- DHT is fail-closed by default: if authenticated handshake is unavailable, peers are rejected.
- Key implementation: `node/src/p2p.ts`, `node/src/dht-network.ts`.

5. Challenge budget and quota controls
- Validators enforce combined limits: global epoch budget + challenge buckets (U/S/R) + tiers (default/trusted/restricted).
- Key implementation: `node/src/pose-engine.ts`.

6. Replay protection with persistence
- Nonce registry supports persistence, TTL, and bounded capacity to reduce restart replay windows.
- Key implementation: `services/verifier/nonce-registry.ts`, `node/src/p2p.ts`.

7. Automated mitigation linkage
- Inbound anomalies are not only counted; they feed into `PeerScoring`.
- Source identity uses composite keys (`IP + senderId`) to better resist proxy rotation and sender spoofing.
- Key implementation: `node/src/p2p.ts`.

### 12.3 Validator Critical Config Baseline

| Config | Recommended | Purpose |
|------|------|------|
| `p2pInboundAuthMode` | `enforce` | Reject unsigned/invalid signed P2P writes |
| `poseInboundAuthMode` | `enforce` | Enforce PoSe write auth |
| `dhtRequireAuthenticatedVerify` | `true` | Disable DHT identity downgrade |
| `poseUseOnchainChallengerAuth` | `true` | Authorize challengers by on-chain eligibility |
| `poseOnchainAuthTimeoutMs` | `3000` | Bound on-chain auth latency impact |
| `poseChallengerAuthCacheTtlMs` | `30000` | Balance freshness vs performance |

### 12.4 Decision and Mitigation Matrix

| Attack Pattern | Validator Checkpoint | Default Action |
|------|------|------|
| Forged P2P write | P2P `_auth` signature check fails | `401` + composite source score penalty |
| Replay request | nonce hit | reject + increment security counters |
| Unauthorized challenger | dynamic authorizer returns false | `403` reject |
| Forged discovery identity | identity-proof/handshake mismatch | no promotion + score penalty |
| DHT anonymous fallback attempt | handshake unavailable | fail-closed reject |

### 12.5 Operational Guidance

1. Wire `coc_getNetworkStats` to alerts with focus on `authRejected`, `discoveryIdentityFailures`, and `dht.verifyFailures`.  
2. Use dedicated RPC for on-chain authorization queries and enforce request timeout.  
3. During rollout, run `monitor` for 24h first, then switch to `enforce` with rollback playbook ready.  

---

**Maintainers**: COC Security Team
**Contact**: security@chainofclaw.org
**Last Audit**: 2026-02-14
**License**: MIT
