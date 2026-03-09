# COC Reward Mechanism

This document describes the complete reward mechanism of the COC (ChainOfClaw) blockchain, covering scoring, distribution, slashing, and claiming across both protocol versions.

## 1. Overview

COC uses a **Proof-of-Service (PoSe)** model to incentivize node operators. Nodes earn rewards by responding to service challenges (storage proofs, relay checks, uptime pings) within each epoch. Two protocol versions coexist:

| Aspect | V1 (Push-based) | V2 (Pull-based Merkle Claim) |
|--------|-----------------|------------------------------|
| Distribution | Relayer calls `distributeRewards()` on-chain | Relayer publishes Merkle root via `finalizeEpochV2()` |
| Claiming | `claimReward(nodeId)` from `pendingRewards` | `claim(epochId, nodeId, amount, proof)` with Merkle proof |
| Fault Proofs | Role-based slashing | Permissionless commit-reveal + bond |
| Witness | None | Witness quorum required for batch submission |

The reward lifecycle follows: **Challenge → Receipt → Scoring → Manifest → Settlement → Claim**.

## 2. Scoring Algorithm

> Source: `services/verifier/scoring.ts` — `computeEpochRewards()`

### 2.1 Three-Bucket Weighted Model

The epoch reward pool is split into three buckets by basis points (1 bps = 0.01%):

| Bucket | Weight (bps) | Default % | Threshold (bps) |
|--------|-------------|-----------|------------------|
| Uptime | 6000 | 60% | 8000 (80%) |
| Storage | 3000 | 30% | 7000 (70%) |
| Relay | 1000 | 10% | 5000 (50%) |

```
uptimeBucket  = pool × 6000 / 10000
storageBucket = pool × 3000 / 10000
relayBucket   = pool - uptimeBucket - storageBucket  // remainder avoids rounding loss
```

### 2.2 Weight Calculation

Each node's weight within a bucket determines its share:

- **Uptime weight**: `uptimeBps` if `uptimeBps >= uptimeThresholdBps` and `uptimeSamples >= minSamples (5)`, else 0
- **Storage weight**: `storageBps × isqrt(cappedGb × 1_000_000) / isqrt(storageCapGb × 1_000_000)` — sqrt scaling discourages over-concentration, capped at `storageCapGb (500 GB)`. Requires `storageBps >= 7000` and `storageSamples >= 5`
- **Relay weight**: `relayBps` if `relayBps >= relayThresholdBps` and `relaySamples >= minSamples`, else 0

### 2.3 Allocation

Within each bucket, rewards are distributed proportionally:

```
nodeShare = bucketAmount × nodeWeight / totalWeight
```

Remainder (from integer division) goes to the highest-weight node in the bucket (deterministic sink).

### 2.4 Soft Cap

After all buckets are allocated, a **5× median** soft cap is applied:

1. Compute median reward among non-zero recipients
2. Cap = `median × softCapMultiplier (5)`
3. Overflow from capped nodes is redistributed proportionally to uncapped nodes (bounded by cap)
4. Any unredistributable remainder goes to `treasuryOverflow`

## 3. Reward Manifest Lifecycle

> Source: `runtime/lib/reward-manifest.ts`, `runtime/lib/reward-settlement.ts`

The reward manifest is the authoritative data bridge between the off-chain scoring pipeline and on-chain settlement.

### 3.1 Flow

```
Agent (coc-agent)           Filesystem              Relayer (coc-relayer)        Contract
  │                           │                        │                          │
  ├─ computeEpochRewards() ──►│                        │                          │
  ├─ buildRewardTree()    ──►│                        │                          │
  ├─ EIP-712 sign manifest ──►│                        │                          │
  ├─ writeRewardManifest() ──►│ reward-epoch-N.json    │                          │
  │                           │◄── readRewardManifest()─┤                          │
  │                           │                        ├─ V1: distributeRewards() ─►│
  │                           │                        ├─ V2: finalizeEpochV2()  ──►│
  │                           │                        ├─ writeSettledManifest() ──►│
  │                           │ reward-epoch-N.settled  │                          │
```

### 3.2 RewardManifest Structure

```typescript
interface RewardManifest {
  epochId: number
  rewardRoot: string              // Merkle root of reward leaves
  totalReward: string             // total reward pool (stringified bigint)
  slashTotal: string
  treasuryDelta: string
  leaves: RewardLeafEntry[]       // { nodeId, amount }
  proofs: Record<string, string[]> // "epochId:nodeId" → proof hashes
  scoringInputsHash: string       // deterministic hash of scoring inputs
  generatedAtMs: number
  generatorSignature?: string     // EIP-712 signature
  generatorAddress?: string
  settled?: boolean               // true after on-chain settlement
  finalizeTxHash?: string
}
```

### 3.3 EIP-712 Signature Verification

The manifest includes an EIP-712 signature (`generatorSignature`) over the payload `{epochId, rewardRoot, totalReward, scoringInputsHash}` using domain `{name: "COCPoSe", version: "2", chainId, verifyingContract}`. The relayer verifies this before submitting to the contract.

## 4. Merkle Tree Construction (V2)

> Source: `services/common/reward-tree.ts`

### 4.1 Leaf Hashing

Each reward leaf is hashed as:

```
leafHash = keccak256(abi.encodePacked(uint64 epochId, bytes32 nodeId, uint256 amount))
```

This produces a 72-byte encoded input (8 + 32 + 32 bytes).

### 4.2 Tree Building

```
buildRewardTree(leaves):
  1. Sort leaves by nodeId (lowercase, deterministic)
  2. Hash each leaf → leafHashes[]
  3. Build Merkle root via buildMerkleRoot(leafHashes)
  4. Generate per-leaf proof via buildMerkleProof(leafHashes, index)
  5. Return { root, leafHashes, proofs: Map<"epochId:nodeId", proof[]> }
```

The same `buildMerkleRoot` / `buildMerkleProof` from `services/common/merkle.ts` is used (domain-separated with `0x00`/`0x01` prefixes for leaf/internal nodes).

### 4.3 Budget Scaling

When the actual reward pool balance is less than the scoring-computed total, `createSettledRewardManifest()` scales all leaf amounts proportionally:

```
scaledAmount = rawAmount × effectiveBudget / sourceTotalReward
```

Rounding remainder is distributed 1 wei at a time to the highest-amount leaves (deterministic).

## 5. V1 Reward Distribution (Push-based)

> Source: `contracts/contracts-src/settlement/PoSeManager.sol`

### 5.1 Distribution

The relayer (with `SLASHER_ROLE`) calls `distributeRewards(epochId, rewards[])`:

1. Epoch must be finalized and not yet distributed
2. Per-node cap: `MAX_REWARD_PER_NODE_BPS (3000)` = 30% of `rewardPoolBalance`
3. Inactive nodes are skipped
4. Each node's reward is added to `pendingRewards[nodeId]`
5. Total distributed is deducted from `rewardPoolBalance`

### 5.2 Claiming

Node operators call `claimReward(nodeId)`:

1. Verify `msg.sender == nodeOperator[nodeId]`
2. Read and zero `pendingRewards[nodeId]` (CEI pattern)
3. Transfer ETH to operator

### 5.3 Off-chain Planning

`planV1RewardDistribution()` in `reward-settlement.ts` prepares the on-chain call:

- Scales manifest amounts to available pool balance
- Per-node cap: `maxPerNodeBps (3000)` = 30% of pool
- Skips inactive nodes (via `isActiveNode()` callback)
- Returns `V1RewardPlan { rewards[], totalDistributed, skippedInactiveNodeIds }`

## 6. V2 Reward Distribution (Pull-based Merkle Claim)

> Source: `contracts/contracts-src/settlement/PoSeManagerV2.sol`

### 6.1 Epoch Finalization

The owner calls `finalizeEpochV2(epochId, rewardRoot, totalReward, slashTotal, treasuryDelta)`:

1. Epoch must not be already finalized
2. Dispute window must have elapsed: `currentEpoch > epochId + DISPUTE_WINDOW_EPOCHS`
3. `totalReward <= rewardPoolBalance` (reverts with `RewardPoolInsufficient` otherwise)
4. All non-disputed batches past their dispute deadline are marked finalized
5. Stores `epochRewardRoots[epochId] = rewardRoot`
6. Deducts `totalReward` from `rewardPoolBalance`
7. Empty epochs are allowed (0 batches, 0 reward)

### 6.2 Claiming

Any address can call `claim(epochId, nodeId, amount, merkleProof)`:

1. Epoch must be finalized
2. `rewardClaimed[epochId][nodeId]` must be false (double-claim protection)
3. Compute `leaf = keccak256(abi.encodePacked(epochId, nodeId, amount))`
4. Verify `MerkleProofLite.verify(proof, epochRewardRoots[epochId], leaf)`
5. Accumulate `epochClaimedReward[epochId]` and check `<= epochTotalReward[epochId]` (budget guard)
6. Transfer ETH to `nodeOperator[nodeId]`
7. Emit `RewardClaimed(epochId, nodeId, amount)`

### 6.3 CLI Claim Tool

`runtime/coc-reward-claim.ts` automates claiming:

```bash
node --experimental-strip-types runtime/coc-reward-claim.ts --epoch 42 --node-id 0x...
```

It reads the best available manifest (settled > unsettled), verifies the EIP-712 signature, looks up the Merkle proof for the node, and submits the `claim()` transaction.

## 7. Challenger Rewards

> Source: `services/relayer/epoch-finalizer.ts` — `allocateChallengerRewards()`

Challengers who submit valid batches receive a share of the reward pool as incentive.

### 7.1 Allocation Formula

```
challengerPool = rewardPool × challengerShareBps / 10000
```

Default `challengerShareBps = 500` (5% of the reward pool).

### 7.2 Distribution

1. Aggregate challenge counts per challenger across all submitted batches
2. Distribute proportionally: `reward = challengerPool × challengerCount / totalChallenges`
3. Last challenger in the list receives the remainder to avoid rounding dust
4. Result is a `Map<challengerAddress, bigint>`

The challenger rewards are merged into the `distributeRewards()` (V1) or `finalizeEpochV2()` (V2) payload by the relayer.

## 8. Slash Distribution

> Source: `contracts/contracts-src/settlement/PoSeManagerV2.sol` — `settleChallenge()`

### 8.1 Slash Split

When a fault proof is confirmed, the offending node's bond is slashed and distributed:

| Destination | Share (bps) | Percentage |
|-------------|-------------|------------|
| Burn | 5000 | 50% |
| Challenger | 3000 | 30% |
| Insurance | 2000 | 20% |

```solidity
burnAmount       = slashAmount × 5000 / 10000
challengerAmount = slashAmount × 3000 / 10000
insuranceAmount  = slashAmount - burnAmount - challengerAmount
```

### 8.2 Per-Epoch Cap

Each node can only be slashed up to **5% of its bond per epoch** (`SLASH_EPOCH_CAP_BPS = 500`):

```solidity
maxSlash = node.bondAmount × 500 / 10000
available = maxSlash - epochNodeSlashed[slashEpoch][targetNodeId]
```

This prevents rapid bond depletion from multiple concurrent challenges.

### 8.3 Fault Types

| Code | Type | Evidence Requirement |
|------|------|---------------------|
| 1 | DoubleSig (Equivocation) | Dedicated equivocation proof (not via evidence leaf) |
| 2 | InvalidSig | `resultCode == 2` in evidence leaf |
| 3 | TimeoutMiss (Downtime) | `resultCode == 1` in evidence leaf |
| 4 | BatchForgery | `resultCode ∈ {3,4,5,6,7}` in evidence leaf |

### 8.4 Bond Deactivation

If a node's bond reaches 0 after slashing, the node is automatically deactivated (`active = false`) and removed from the active node set.

## 9. Witness Set Selection

> Source: `PoSeManagerV2.sol` — `getWitnessSet()`

### 9.1 Set Size

```
m = ceil(sqrt(activeCount))
m = min(m, activeCount)
m = min(m, 32)              // bitmap max 32 bits
```

### 9.2 Selection Algorithm

Witnesses are selected pseudo-randomly using the epoch's `challengeNonce` (set from `block.prevrandao`):

```
for i in 0..activeCount*3:
  idx = keccak256(nonce, i) % activeCount
  candidate = activeNodeIds[idx]
  if candidate not already selected:
    witnesses[selected++] = candidate
  if selected == m: break
```

### 9.3 Quorum Requirement

```
n = ceil(2m / 3) = (2m + 2) / 3   // integer ceiling
```

Batch submissions must include at least `n` valid witness signatures in the `witnessBitmap` + `witnessSignatures` arrays. Each signature is verified against the witness node's registered operator via EIP-712 typed data.

### 9.4 Transition Mode

If `allowEmptyWitnessSubmission = true` (off by default in production), batches with empty witness sets are accepted to avoid deadlock during initial rollout.

## 10. BFT → PoSe Slash Bridge

> Source: `node/src/bft-coordinator.ts`, `runtime/coc-relayer.ts`

When the BFT consensus layer detects equivocation (double-voting), the evidence flows into the PoSe slashing pipeline:

```
BFT EquivocationDetector
  │
  ├─ onEquivocation callback
  │   └─ BftSlashingHandler
  │       ├─ ValidatorGovernance.slash()
  │       └─ EvidenceStore.record()
  │
  ├─ coc_getEquivocations RPC endpoint
  │   └─ returns stored equivocation evidence
  │
  └─ Relayer polls coc_getEquivocations
      └─ tryDisputeV2():
          ├─ openChallenge(commitHash) + bond
          ├─ revealChallenge(targetNodeId, faultType=1, evidence)
          └─ settleChallenge(challengeId)
```

The commit-reveal lifecycle for equivocation faults follows the same 3-step process as other fault types but uses `faultType = 1 (DoubleSig)`.

## 11. End-to-End Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        COC Reward Lifecycle                              │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────┐    challenge     ┌──────────┐    receipt     ┌──────────┐  │
│  │  Agent   │ ──────────────► │   Node   │ ─────────────► │  Agent   │  │
│  │(coc-agent)│                │ (target) │                │(verifier)│  │
│  └────┬─────┘                 └──────────┘                └────┬─────┘  │
│       │                                                        │        │
│       │  ┌──────────────┐ witness attestation ┌──────────────┐ │        │
│       │  │ Witness Nodes │ ─────────────────► │ Witness Set  │ │        │
│       │  └──────────────┘  (m nodes, n quorum)└──────┬───────┘ │        │
│       │                                              │         │        │
│       ▼                                              ▼         ▼        │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Scoring Engine                             │       │
│  │  Uptime 60% │ Storage 30% (√ scaling) │ Relay 10%           │       │
│  │  Threshold gate → Weight calc → Proportional split           │       │
│  │  Soft cap: 5× median                                        │       │
│  └──────────────────────────┬───────────────────────────────────┘       │
│                             │                                           │
│                             ▼                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                   Reward Manifest                             │       │
│  │  epochId, rewardRoot, totalReward, leaves[], proofs{}        │       │
│  │  EIP-712 signed by generator                                 │       │
│  │  Persisted: reward-epoch-N.json                              │       │
│  └──────────────────────────┬───────────────────────────────────┘       │
│                             │                                           │
│              ┌──────────────┴──────────────┐                            │
│              ▼                             ▼                            │
│  ┌──────────────────┐         ┌───────────────────────┐                │
│  │    V1 (Push)      │         │     V2 (Pull)          │                │
│  │                   │         │                        │                │
│  │ distributeRewards │         │  finalizeEpochV2       │                │
│  │   → pendingRewards│         │    → epochRewardRoots  │                │
│  │ claimReward()     │         │  claim(proof)          │                │
│  │   → ETH transfer  │         │    → Merkle verify     │                │
│  │                   │         │    → ETH transfer      │                │
│  └──────────────────┘         └───────────────────────┘                │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Slashing Pipeline                          │       │
│  │                                                               │       │
│  │  Fault detected → openChallenge(bond) → revealChallenge      │       │
│  │  → settleChallenge → 50% burn / 30% challenger / 20% ins.   │       │
│  │  Per-epoch cap: 5% of bond                                   │       │
│  │                                                               │       │
│  │  BFT equivocation → evidence store → relayer → FaultProof   │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                  Challenger Rewards                           │       │
│  │  5% of rewardPool → proportional to valid challenge count    │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Key Source File Reference

| File | Role |
|------|------|
| `services/verifier/scoring.ts` | Scoring algorithm (`computeEpochRewards`) |
| `runtime/lib/reward-manifest.ts` | Manifest types, persistence, EIP-712 verification |
| `runtime/lib/reward-settlement.ts` | V1 distribution planning, budget scaling |
| `services/common/reward-tree.ts` | Merkle tree construction (`buildRewardTree`) |
| `services/common/pose-types-v2.ts` | V2 types (RewardLeaf, FaultProof, ResultCode) |
| `services/relayer/epoch-finalizer.ts` | Challenger reward allocation |
| `runtime/coc-relayer.ts` | Epoch finalization, fault proof lifecycle |
| `runtime/coc-reward-claim.ts` | V2 automated claim CLI |
| `contracts/contracts-src/settlement/PoSeManager.sol` | V1 on-chain settlement |
| `contracts/contracts-src/settlement/PoSeManagerV2.sol` | V2 on-chain settlement |
| `contracts/contracts-src/settlement/IPoSeManagerV2.sol` | V2 interface and events |
| `contracts/contracts-src/settlement/MerkleProofLite.sol` | Merkle proof verification |
