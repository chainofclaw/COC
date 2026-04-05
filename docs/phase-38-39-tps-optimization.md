# Phase 38–39: EVM Execution Pipeline & State Trie Optimization (English)

**Status**: Completed (2026-04-05)

## Overview

Phase 38–39 continues the TPS optimization journey started in Phase 37. After Phase 37 shifted the bottleneck from IO-bound (402 DB writes/block) to EVM-execution-bound, these phases target the per-transaction overhead in the EVM execution pipeline and the state trie commit cost.

**Result**: Maintained **~130 TPS** on simple ETH transfers (already near the serial EVM ceiling), with architectural improvements that benefit contract-heavy workloads and lay groundwork for parallel execution.

## Bottleneck Analysis (Post-Phase 37)

After Phase 37's mega-batch optimization, profiling revealed the remaining per-transaction overhead:

| Bottleneck | Per-TX Cost | Per-Block (256 tx) |
|------------|-------------|-------------------|
| Redundant VM setup per tx (`createExecutionCommon`, `applyHardforkToVm`, `prepareVmForExecution`) | ~200us | ~51ms |
| ECDSA recovery called 3x per tx (RPC → mempool → EVM) | ~300us (2x redundant) | ~77ms |
| `Common.copy()` allocation per tx | ~50us | ~13ms |
| `createExecutionBlock()` per tx | ~30us | ~8ms |
| Receipt Map cache write+read roundtrip | ~20us | ~5ms |
| State trie `commit()` sequential re-reads | Variable | 640-1024ms (128 dirty accounts) |
| **Total removable overhead** | **~600us** | **~154ms** |

## Phase 38: EVM Execution Pipeline Optimization

### 1. Fast Path: `executeRawTxInBlock()` (Core Optimization)

**Problem**: `executeRawTx()` repeats 3 VM setup calls for every transaction, even though `applyBlockContext()` already performs the same work once per block:
- `createExecutionCommon()` — copies Common object + sets hardfork (constant within a block)
- `applyHardforkToVm()` — redundant hardfork check
- `prepareVmForExecution()` — Beacon roots contract setup (Cancun, constant within a block)
- `createExecutionBlock()` — creates identical Block object for every tx

**Solution**: New `executeRawTxInBlock()` method that accepts pre-computed block-scoped objects:

```typescript
// Called ONCE per block (before tx loop)
const blockCommon = this.evm.getBlockCommon(block.number)
const executionBlock = this.evm.getExecutionBlock(blockCommon, blockContext)

// Called per tx — skips all 4 redundant setup calls
const result = await this.evm.executeRawTxInBlock(
  raw, blockCommon, executionBlock, block.number, i, block.hash, baseFee, blockNumberHex, sender
)
```

The original `executeRawTx()` is untouched for backward compatibility (RPC calls, trace replay, etc.).

**Files**: `node/src/evm.ts` (+`getBlockCommon()`, `getExecutionBlock()`, `executeRawTxInBlock()`)

### 2. `BlockExecutionResult` — Direct Receipt Return

**Problem**: `executeRawTx()` writes receipt/txInfo to Map caches (`this.receipts`, `this.txs`), then `applyBlock()` immediately reads them back via `getReceipt()` / `getTransaction()` — two Map lookups per tx that are unnecessary.

**Solution**: New `BlockExecutionResult` type extends `ExecutionResult` with receipt data returned directly:

```typescript
export interface BlockExecutionResult extends ExecutionResult {
  receipt: TxReceipt     // returned directly, no Map lookup needed
  from: string
  to: string | null
  contractAddress?: string
}
```

Receipt is still written to cache (for RPC queries) but the chain engine consumes it from the return value.

**Files**: `node/src/evm.ts`, `node/src/chain-engine-persistent.ts`

### 3. Batch Cache Eviction: `evictCaches()`

**Problem**: Per-tx receipt/tx cache eviction checks (`this.receipts.size >= MAX_RECEIPT_CACHE`) run on every transaction, including during block execution where cache overflow is impossible within a single block.

**Solution**: Skip eviction in `executeRawTxInBlock()`, call `evictCaches()` once after block execution completes.

**Files**: `node/src/evm.ts` (+`evictCaches()`), both chain engines

### 4. ECDSA Recovery Deduplication

**Problem**: `Transaction.from(rawTx)` (ethers.js ECDSA recovery, ~150us) called 3x per transaction:
1. `chain-engine.ts:addRawTx()` — dedup check
2. `mempool.ts:addRawTx()` — mempool parsing
3. `evm.ts:executeRawTxInBlock()` — `tx.getSenderAddress()`

**Solution**:
- `mempool.addRawTx(rawTx, preDecoded?)` accepts optional pre-decoded Transaction
- `chain-engine.ts:addRawTx()` passes decoded Transaction to mempool (eliminates 2nd ECDSA)
- `executeRawTxInBlock(..., knownSender?)` accepts pre-computed sender from mempool
- `proposeNextBlock()` builds `senderByRawTx` Map from `pickForBlock()` results

**Security constraint**: Remote blocks still perform full ECDSA verification.

**Files**: `node/src/mempool.ts`, `node/src/evm.ts`, `node/src/chain-engine.ts`, `node/src/chain-engine-persistent.ts`

### 5. Pre-computed Hex Strings & Indexed Push

**Problem**: `0x${appliedBlock.toString(16)}` computed ~6x per tx (identical within a block). `push(...spread)` on large arrays risks call stack overflow.

**Solution**:
- `blockNumberHex` pre-computed once per block, passed to `executeRawTxInBlock()`
- `gasPriceHex`, `txIdxHex` computed once per tx and reused across receipt + txInfo
- `push(...spread)` replaced with indexed `for` loops for `allDbOps` accumulation

**Files**: `node/src/evm.ts`, `node/src/chain-engine-persistent.ts`

### 6. Configuration Tuning

| Parameter | Before | After | File |
|-----------|--------|-------|------|
| `maxTxPerBlock` | 256 | **512** | `config.ts:368` |
| `DEFAULT_MAX_ACCOUNT_CACHE` | 10,000 | **50,000** | `state-trie.ts:128` |
| `DEFAULT_MAX_CACHED_TRIES` | 128 | **512** | `state-trie.ts:127` |
| `MAX_CODE_CACHE_SIZE` | 500 | **2,000** | `persistent-state-manager.ts:14` |

## Phase 39: State Trie Commit Optimization

### Batch Commit (Inspired by Monad/Aptos State Management)

**Problem**: `state-trie.ts:commit()` performs 3 async operations per dirty account:
1. `await this.get(address)` — re-reads account from trie (even though it's in `accountCache`)
2. `storageTrie.root()` — compute new storage root (sync, fast)
3. `await this.put(address, updatedAccount)` — writes back to trie, which triggers:
   - `evictAccountCache()` — unnecessary during commit
   - `dirtyAddresses.add(address)` — re-dirties the address (requires snapshot iteration pattern)
   - `lastStateRoot = null` — invalidates root on every put

For 128 dirty accounts: 128 × (trie read + trie write + cache eviction) = **significant overhead**.

**Solution**: Rewritten `commit()` with 4 optimizations:

```typescript
async commit(): Promise<string> {
  // 1. Clear dirty set upfront — direct trie.put won't re-dirty
  const dirtySnapshot = [...this.dirtyAddresses]
  this.dirtyAddresses.clear()

  for (const address of dirtySnapshot) {
    const storageTrie = this.storageTries.get(address)
    if (!storageTrie) continue

    // 2. Read from accountCache directly — skip async trie.get()
    const cached = this.accountCache.get(address)
    if (!cached) continue

    // 3. Skip unchanged storageRoot — avoid unnecessary trie.put
    const newRoot = bytesToHex(storageTrie.root())
    if (cached.storageRoot === newRoot) continue

    // 4. Direct trie.put — bypass this.put() (no re-dirty, no eviction, no root invalidation)
    await this.trie.put(hexToBytes(address), encoder.encode(JSON.stringify({...})))
    this.accountCache.set(address, updatedAccount)
  }
  // ... persistRoot + state root persistence
}
```

**Improvements**:
- `this.get()` → `accountCache.get()`: async → sync, no copy allocation
- `this.put()` → `this.trie.put()`: no re-dirty, no cache eviction, no stateRoot invalidation
- Skip unchanged `storageRoot`: avoid trie write when only balance/nonce changed
- Clear `dirtyAddresses` upfront: no snapshot iteration workaround needed

**Files**: `node/src/storage/state-trie.ts`

### Infrastructure: `BlockIndex.updateBlockStateRoot()`

Added `updateBlockStateRoot(hash, stateRoot)` method to `BlockIndex` for future deferred stateRoot scenarios.

**Files**: `node/src/storage/block-index.ts`

## Architecture Reference: Public Chain Techniques

Phase 39 was designed by studying high-TPS chains:

| Chain | TPS | Core Technique | Applied to COC |
|-------|-----|---------------|---------------|
| **Monad** | 10K | Deferred stateRoot + async I/O | Batch commit optimization, `updateBlockStateRoot` infrastructure |
| **Aptos** | 160K | Block-STM optimistic parallel + MVCC | Existing `fork()`/`merge()` infrastructure ready |
| **Solana** | 65K | 4-stage pipeline + Sealevel parallel | Block pipeline design (future Phase C) |

### Existing Infrastructure for Future Parallel Execution

COC already has the foundation for Block-STM style parallel execution:
- `state-trie.ts:fork()` — COW branch via `trie.shallowCopy(true)`
- `state-trie.ts:merge()` — merge branch changes back
- `state-trie.ts:checkpoint()/revert()` — speculative execution support
- `evm.ts:checkpointState()/commitState()/revertState()` — VM-level speculation

**Prerequisite for parallel execution**: `merge()` must be optimized from full iteration to diff-based (only merge dirty accounts).

## Performance Results (2026-04-05)

### TPS & Throughput Benchmarks

| Metric | Phase 37 | Phase 38-39 | Change |
|--------|----------|-------------|--------|
| **1000 tx / 10 blocks TPS** | 131 | **133.7** | +2% |
| **200 tx / 1 block latency** | 1500ms | **1552ms** | ~same |
| **50 tx sequential** | — | **58.9 tx/sec** | — |
| **Block production rate** | — | **9.3 blocks/sec** | — |
| **pickForBlock(256) latency** | 1.26ms | **0.93ms** | **-26%** |
| **pickForBlock(50) latency** | — | **0.41ms** | — |
| **Mempool add (64 txs)** | — | **38 tx/sec** | — |
| **Storage IO (100 blocks)** | 3ms | **3ms** | same |
| **Storage IO (200 txs)** | 5ms | **6ms** | ~same |
| Benchmark tests | 11/11 | **11/11** | ✅ |

### EVM Operation Benchmarks

| Operation | Throughput | Avg Latency |
|-----------|-----------|-------------|
| `eth_call` | 572 ops/sec | **1.75ms** |
| `eth_estimateGas` | 680 ops/sec | **1.47ms** |
| `ecrecover` (precompile) | 862 ops/sec | **1.16ms** |
| `sha256` (precompile) | 840 ops/sec | **1.19ms** |
| `eth_getBalance` | 13,020 ops/sec | **0.077ms** |
| 20x parallel `eth_call` | — | **19ms total** |
| 20x parallel `estimateGas` | — | **22ms total** |

### P2P / Wire Protocol Benchmarks

| Operation | Throughput |
|-----------|-----------|
| Wire frame encode/decode | **235,294 ops/sec** |
| JSON payload roundtrip | **128,338 ops/sec** |
| DHT `findClosest` (1000 lookups) | **710 ops/sec** |
| Wire 64B payload | 437,046 ops/sec |
| Wire 256B payload | 486,957 ops/sec |
| Wire 1KB payload | 428,932 ops/sec |
| Wire 4KB payload | 128,361 ops/sec |
| Wire 16KB payload | 35,812 ops/sec |

### Analysis

Simple ETH transfers (21K gas) are near the **serial EVM execution ceiling** (~7.5ms/tx → theoretical max ~133 TPS at 1000ms block time). The optimizations primarily benefit:
- **Contract interactions** — VM setup and storageRoot overhead proportionally larger
- **Large blocks** — 512 tx/block amortizes per-block costs better
- **High ingestion rate** — ECDSA dedup reduces mempool latency
- **Sequencer mode** — eliminates BFT/sync/DHT/auth overhead for L2 rollup deployment

### Regression Testing

| Test Suite | Count | Status |
|------------|-------|--------|
| Node layer | 1017 | ✅ |
| Services + NodeOps | 164 | ✅ |
| Runtime | 89 | ✅ |
| Integration | 41 | ✅ |
| Benchmarks (TPS + EVM + P2P) | 21 | ✅ |
| **Total** | **1332** | **✅ Zero failures** |

## Phase 39 Rollup Mode

### Sequencer Mode (`nodeMode: "sequencer"`)

Strips all consensus overhead for maximum L2 throughput:

| Component | Default Mode | Sequencer Mode |
|-----------|-------------|----------------|
| BFT consensus | Enabled (3+ validators) | **Disabled** |
| Wire protocol (TCP) | Enabled | **Disabled** |
| DHT peer discovery | Enabled | **Disabled** |
| Snap sync | Enabled | **Disabled** |
| Block signature enforcement | `"enforce"` | **`"off"`** |
| P2P auth verification | `"enforce"` | **`"off"`** |
| Sync timer (5s interval) | Running | **Not started** |
| Degraded mode timer (10s) | Running | **Not started** |

**Usage**: `COC_NODE_MODE=sequencer node --experimental-strip-types node/src/index.ts`

### Runtime Services

| Service | File | Status |
|---------|------|--------|
| **Output Proposer** | `runtime/lib/output-proposer.ts` | ✅ Ready |
| **Batcher** | `runtime/lib/batcher.ts` | ✅ Ready |
| Batch codec | `runtime/lib/rollup-batch-codec.ts` | ✅ Pre-existing |
| Output root calc | `runtime/lib/rollup-output-root.ts` | ✅ Pre-existing |
| Type definitions | `runtime/lib/rollup-types.ts` | ✅ Pre-existing |

### Rollup RPC Methods

| Method | Description |
|--------|-------------|
| `rollup_getOutputAtBlock(blockNumber)` | Returns output root proposal for a given L2 block |
| `rollup_getSequencerMode()` | Returns current node mode and sequencer status |

### L1 Smart Contracts (Pre-existing)

| Contract | Purpose | Status |
|----------|---------|--------|
| `RollupStateManager.sol` | Output proposal + challenge game + finalization | ✅ Deployed |
| `DelayedInbox.sol` | Force-include queue (censorship resistance) | ✅ Deployed |

## Code Changes Summary

### Phase 38 (7 files, +215/-39 lines)

| File | Changes |
|------|---------|
| `node/src/evm.ts` | +`BlockExecutionResult`, `executeRawTxInBlock()`, `getBlockCommon()`, `getExecutionBlock()`, `evictCaches()` |
| `node/src/chain-engine-persistent.ts` | Pre-compute block objects, sender passthrough, direct receipt consumption, indexed push |
| `node/src/chain-engine.ts` | Same fast path, pre-decoded Transaction to mempool, batch eviction |
| `node/src/mempool.ts` | `addRawTx(rawTx, preDecoded?)` signature |
| `node/src/config.ts` | `maxTxPerBlock`: 256 → 512 |
| `node/src/storage/state-trie.ts` | Cache sizes: 10K→50K accounts, 128→512 tries |
| `node/src/storage/persistent-state-manager.ts` | Code cache: 500→2000 |

### Phase 39 — State Trie + Rollup Mode

| File | Changes |
|------|---------|
| `node/src/storage/state-trie.ts` | Rewritten `commit()` with batch optimization |
| `node/src/storage/block-index.ts` | +`updateBlockStateRoot()` |
| `node/src/config.ts` | +`nodeMode: "sequencer"`, sequencer mode auto-overrides |
| `node/src/consensus.ts` | +`sequencerMode` config, skip sync/degraded/BFT in sequencer |
| `node/src/index.ts` | Pass `sequencerMode` to ConsensusEngine |
| `node/src/rpc.ts` | +`rollup_getOutputAtBlock`, `rollup_getSequencerMode` |
| `runtime/lib/output-proposer.ts` | NEW: Output Proposer service |
| `runtime/lib/batcher.ts` | NEW: Batcher service |

## TPS Evolution Summary

| Phase | Optimization | TPS | Improvement |
|-------|-------------|-----|-------------|
| Baseline | No optimization | 16.7 | — |
| **Phase 37** | Mega-batch DB writes | **131** | 7.8x |
| **Phase 38** | EVM pipeline + ECDSA dedup + config | **133.7** | +2% |
| **Phase 39** | State trie batch commit + Rollup mode | **133.7** | Architecture ready |
| **Rollup mode** | L2 sequencer + L1 batch settlement | **1000+** (user-perceived) | Batching amplifier |

## Next Steps

| Priority | Technique | Source | Expected Impact | Effort |
|----------|-----------|--------|----------------|--------|
| 1 | Block pipeline (overlap mempool prep + broadcast) | Solana | +30-50 TPS | 3-5 days |
| 2 | Worker thread ECDSA pool | — | +15-25 TPS | 2-3 days |
| 3 | Block-STM optimistic parallel execution | Aptos | 300-500 TPS | 2-4 weeks |
| 4 | Replace EthereumJS with revm/evmone (FFI) | — | 2-5x raw EVM speed | 4+ weeks |
