# Optimistic Rollup Architecture (Phase 38+)

**Target Release**: Q2 2026

## Executive Summary

COC will evolve from a standalone L1 blockchain into an **Optimistic Rollup** architecture:

```
                          ┌─────────────────────────────────────┐
                          │        Settlement Layer (L1)         │
                          │  PoSe v2 Settlement Contract         │
                          │  - State commitment storage          │
                          │  - Fraud proof game logic            │
                          │  - Withdrawal verification           │
                          └──────────────┬──────────────────────┘
                                         │ state roots + fraud proofs
                                         │
             ┌───────────────────────────────────────────────────┐
             │           Batcher (Off-Chain)                      │
             │  - Aggregates 100+ L2 blocks into 1 L1 tx          │
             │  - Compresses via RLP encoding                     │
             │  - Posts to PoSeManagerV2 batch slot               │
             └──────────────────────────┬──────────────────────┘
                                        │ compressed L2 blocks
                                        │
         ┌──────────────────────────────────────────────────────┐
         │        Sequencer (L2) — Current COC Engine            │
         │   ┌────────────────────────────────────────────────┐  │
         │   │  PersistentChainEngine (1s blocks)             │  │
         │   │  - EVM execution (130+ TPS)                    │  │
         │   │  - User-facing fast finality                   │  │
         │   │  - Reorg risk (1-7 day window)                 │  │
         │   └────────────────────────────────────────────────┘  │
         └──────────────────┬──────────────────────────────────┘
                            │ L2 blocks
         ┌──────────────────────────────────────────────────────┐
         │     Users / dApps / Exchanges                        │
         │  - Fast UX (1s confirmation)                         │
         │  - Lower fees (compression + batch posting)          │
         │  - Delayed inbox for censorship resistance           │
         └──────────────────────────────────────────────────────┘
```

## Architecture Components

### 1. L2 Sequencer (Reuse Current Engine)

**What exists**: `PersistentChainEngine` with Phase 37 optimizations

**Operational properties**:
- **Block time**: 1 second
- **Throughput**: 100-150 TPS (simple transfers; 80-120 TPS mixed workloads)
- **Finality**: Sequencer-determined (fast UX, reorg risk)
- **Canonical chain selection**: Simple height + weight, not BFT

**Role in rollup**:
- Produce L2 blocks in fast cadence
- Execute transactions, compute state roots
- Expose via RPC for user wallets/dApps
- **Do NOT** run BFT consensus (remove for L2 speed)

**Code location**: `node/src/chain-engine-persistent.ts` (main path)

### 2. State Root Proposer (NEW)

**Responsibility**: Periodically submit L2 state commitments to L1

**Frequency**: Every 100-1000 L2 blocks (configurable), e.g., every ~100-1000 seconds

**Operation**:
1. Read L2 chain tip state root (computed by EVM)
2. Batch L2 blocks since last submission
3. Compute aggregated output root (hash of accumulated state changes)
4. Call `submitOutput()` on L1 PoSeManagerV2 contract
5. Emit `OutputSubmitted` event with timestamp

**Implementation sketch**:
```typescript
// runtime/lib/output-proposer.ts (NEW)
class OutputProposer {
  private outputInterval = 100  // blocks
  private lastOutputHeight = 0n
  
  async tryProposeOutput(currentHeight: bigint, stateRoot: Hex): Promise<void> {
    if (currentHeight - this.lastOutputHeight >= this.outputInterval) {
      const outputRoot = computeOutputRoot(currentHeight, stateRoot)
      await this.l1Contract.submitOutput(outputRoot)
      this.lastOutputHeight = currentHeight
    }
  }
}
```

**Storage**: Save last submitted height + root to prevent double-submission

### 3. Fraud Proof Game (Reuse PoSe v2)

**Foundation**: Adapt current PoSe v2 challenge/dispute infrastructure

**Game flow**:
1. **Challenge Phase** (e.g., 1-7 day window):
   - Any staked validator can claim a state commitment is wrong
   - Challenger posts bond + evidence (block height + computed state root diff)
   
2. **Defense Phase**:
   - Sequencer or defender responds with proof
   - Recompute state root at claimed block height
   - Submit counter-evidence (full state root execution trace)

3. **Settlement**:
   - Contract verifies computation against L2 state root
   - If sequencer wrong: slash bond, reward challenger
   - If challenger wrong: seize bond, reward sequencer
   - Finalize state root on-chain

**Reuse from Phase 36+**:
- PoSe v2 challenge-receipt pipeline (already built)
- EIP-712 signed messages (already hardened)
- Merkle proof verification (already implemented)
- Reward tree + aggregation (already working)

**New components**:
- Execution trace encoder (witness format for L2 state roots)
- L2↔L1 state root sync (bridge messages)
- Timelock/challenge window management

### 4. Batcher (NEW)

**Responsibility**: Compress L2 blocks, post to L1

**Operation**:
1. Continuously read from L2 sequencer (via RPC)
2. Collect N blocks into batch (e.g., every 100 blocks or per timeout)
3. Compress via RLP encoding
4. Call `submitBatch()` on L1 (or Batcher contract)
5. Emit `BatchSubmitted` event

**Compression strategy**:
- Batch multiple transactions from multiple blocks
- Delta-encode account nonce/balance changes
- Omit redundant state (same account twice in batch → compress)
- Target: 5-10x compression vs raw block bytes

**Economic model**:
- Batcher pays L1 gas for batch posting
- Sequencer/protocol receives fee revenue from compressed savings
- Lower L1 cost = lower user fees

**Implementation**:
```typescript
// runtime/lib/batcher.ts (NEW)
class Batcher {
  async submitBatch(l2Blocks: Block[]): Promise<TxHash> {
    const compressed = compressBlocks(l2Blocks)
    const tx = await l1.submitBatch(compressed)
    return tx.hash
  }
}
```

### 5. Delayed Inbox (Censorship Resistance)

**Responsibility**: Force-include mechanism for sequencer bypass

**Operation**:
1. User submits transaction directly to L1 DelayedInbox contract
2. After delay (e.g., 7 days) without L2 inclusion, user can execute on-chain
3. L2 sequencer must include delayed-inbox txs in canonical L2 chain

**Safety**:
- Prevents sequencer censorship (liveness guarantee)
- Forced inclusion at worst-case time
- Works alongside fast sequencer path

**Implementation**:
```solidity
// contracts/DelayedInbox.sol (NEW)
contract DelayedInbox {
  mapping(bytes32 txHash => uint timestamp) public enqueued;
  
  function enqueueTransaction(bytes calldata tx) external {
    enqueued[keccak256(tx)] = block.timestamp;
  }
  
  function executeForced(bytes calldata tx) external {
    require(block.timestamp > enqueued[keccak256(tx)] + 7 days);
    // Execute (settle account state directly on L1)
  }
}
```

## Transition Plan

### Phase 37 (Done)
- [x] Single-node sequencer reaches 100+ TPS
- [x] Mega-batch DB optimization
- [x] Remove per-tx IO overhead

### Phase 38 (Q2 2026)
- [ ] Add output proposer (submit state roots to L1 every 100 blocks)
- [ ] Add delayed inbox contract to L1
- [ ] Integrate L2↔L1 messaging (state root sync)

### Phase 39 (Q2-Q3 2026)
- [ ] Add fraud proof game (reuse PoSe v2 challenge logic)
- [ ] Implement execution trace encoding
- [ ] Integrate L1 challenge resolution into L2 state

### Phase 40 (Q3 2026)
- [ ] Add batcher (compress L2 blocks, post to L1)
- [ ] Optimize compression codec
- [ ] Monitor L1 gas costs + fee efficiency

### Phase 41+ (Q3-Q4 2026)
- [ ] DA layer abstraction (EIP-4844 blobs or Celestia)
- [ ] Withdrawals / L2↔L1 asset bridge
- [ ] Multi-sequencer / shared sequencing

## What Doesn't Change

**Keep existing**:
- `PersistentChainEngine` block production loop
- EVM execution + state root computation
- P2P gossip (for L2 block propagation)
- RPC API (add L2-specific fields if needed)
- PoSe v2 challenge/receipt pipeline

**Remove/Disable**:
- BFT consensus (1s block time → no time for consensus rounds)
- Multi-validator settlement (sequencer is single point, by design)
- P2P block validation (trust sequencer at L2 level)

## Risk Mitigation

1. **Sequencer downtime**: Delayed inbox provides fallback
2. **Sequencer censorship**: Delayed inbox forces inclusion
3. **Sequencer greed (high fees)**: Users fall back to delayed inbox
4. **State commitment wrong**: Fraud proof game catches + slashes
5. **Batcher failure**: Multiple batchers can run independently

## Rollup vs Standalone L1

| Aspect | Standalone L1 | Optimistic Rollup |
|--------|---------------|-------------------|
| **Throughput** | 100-150 TPS (capped by full history) | 100+ TPS (unlimited via compression) |
| **Latency** | 1s block time (fast UX) | 1s block time (same) |
| **Settlement cost** | Per-block on consensus | 1 L1 tx per 100 blocks (1% cost) |
| **Finality** | Weight-based (subjective) | 7-day challenge window (objective) |
| **Censorship** | Network-dependent | Delayed inbox guarantee |
| **State commitment** | None (full replay) | Output roots on-chain |

## Dependencies

**From existing codebase**:
- `PersistentChainEngine` (reuse)
- PoSe v2 challenge/receipt/witness types (reuse)
- EIP-712 signing (reuse)
- Merkle proof verification (reuse)
- Reward tree aggregation (adapt)

**New L1 contracts**:
- `DelayedInbox.sol` — Force-include queue
- `OutputProposer.sol` — State root submission + timelock
- `FraudProofGame.sol` — Challenge-response game

**New off-chain services**:
- `output-proposer.ts` — Propose state roots
- `batcher.ts` — Compress + post blocks
- `challenger.ts` — Challenge incorrect states (reuse PoSe v2 logic)
- `fraud-proof-game.ts` — Fraud proof orchestration

## Success Metrics

- **Phase 38**: Output roots published to L1 every 100 blocks ✓
- **Phase 39**: Fraud proof game resolves a test challenge ✓
- **Phase 40**: Batcher achieves 5x compression vs raw blocks ✓
- **Phase 41**: Mainnet rollup with 7-day challenge window ✓

## Roadmap to Production

```
Phase 37 ✓ (done) — 100+ TPS single sequencer
       ↓
Phase 38 (6 weeks) — Output root submission + delayed inbox
       ↓
Phase 39 (8 weeks) — Fraud proof game
       ↓
Phase 40 (4 weeks) — Batcher + compression
       ↓
Phase 41+ (ongoing) — DA layer, withdrawals, multi-sequencer
```

**Target**: Q4 2026 for mainnet optimistic rollup.
