# Phase 40: EVM Engine Abstraction & revm Migration

**Status**: Stage 1-2 Completed (2026-04-05), Stage 3-5 In Progress

## Overview

Phase 40 introduces an engine-agnostic EVM abstraction layer, enabling COC to swap the underlying EVM implementation without affecting the rest of the codebase. The immediate goal is migrating from EthereumJS VM (~133 TPS) to revm (Rust EVM via WASM, targeting **500-1000+ TPS**).

## Motivation

After Phases 37-39 eliminated all non-EVM overhead (mega-batch DB writes, VM setup dedup, ECDSA dedup, state trie batch commit, rollup sequencer mode), the bottleneck is now the **EVM execution engine itself**:

| Component | Time per TX | Share |
|-----------|------------|-------|
| EthereumJS `runTx()` | ~5-7ms | 70-80% |
| State trie read/write | ~1-2ms | 15-20% |
| Other overhead | ~0.5ms | 5-10% |

revm (Rust) executes EVM bytecode 10-50x faster than EthereumJS (JavaScript). Even via WASM (which adds ~2x overhead vs native), a 5-10x speedup is expected.

## Architecture

### Before (EthereumJS Coupled)

```
ChainEngine → EvmChain → EthereumJS VM → @ethereumjs/common
                  ↓           ↓               ↓
              getBlockCommon()  runTx()    Hardfork enum
              (leaks Common type)         (leaks into config)
```

### After (Engine-Agnostic)

```
ChainEngine → IEvmEngine ← EvmChain (EthereumJS)
                  ↑
                  ← RevmEngine (revm WASM)  [Stage 3]
                  ↑
              prepareBlock() → EvmBlockEnv { _internal }
              (engine internals hidden)
```

## Stage 1-2: Abstraction Layer (Completed)

### New Files

**`node/src/evm-types.ts`** — Engine-agnostic types:
- `EvmHardfork` — `"shanghai" | "cancun" | "prague"` (replaces EthereumJS `Hardfork` enum)
- `EvmHardforkScheduleEntry` — Config-level hardfork schedule
- `EvmBlockEnv` — Opaque block environment pre-computed once per block
- `CallParams` / `CallResult` — eth_call parameter types

**`node/src/evm-engine.ts`** — `IEvmEngine` interface:
```typescript
interface IEvmEngine {
  applyBlockContext(context): Promise<void>
  prepareBlock(blockNumber, context?): EvmBlockEnv
  executeRawTx(rawTx, ...): Promise<ExecutionResult>
  getBalance(address, stateRoot?): Promise<bigint>
  getNonce(address, stateRoot?): Promise<bigint>
  getCode(address, stateRoot?): Promise<string>
  getStorageAt(address, slot, stateRoot?): Promise<string>
  prefund(accounts): Promise<void>
  checkpointState(): Promise<void>
  commitState(): Promise<void>
  revertState(): Promise<void>
  getReceipt(txHash): TxReceipt | null
  getTransaction(txHash): TxInfo | null
  evictCaches(): void
  getBlockNumber(): bigint
  getChainId(): number
}
```

### Modified Files

**`node/src/evm.ts`** — Added `prepareBlock()`:
- Wraps `getBlockCommon()` + `getExecutionBlock()` into a single `EvmBlockEnv`
- Engine internals stored in `_internal` (opaque to consumers)
- Existing `executeRawTxInBlock()` signature unchanged for compatibility

**`node/src/chain-engine-persistent.ts`** + **`node/src/chain-engine.ts`**:
- Migrated from `getBlockCommon()` + `getExecutionBlock()` to `prepareBlock()`
- Extract engine internals from `EvmBlockEnv._internal` (temporary, until `executeRawTxInBlock` is fully abstracted)

### Validation

- **1017/1017** node tests passing (zero regression)
- Pure refactoring — no behavioral changes

## Stage 3: revm WASM Bindings (In Progress)

### Approach

1. Install pre-built revm WASM package (avoid Rust toolchain requirement)
2. Create `RevmAdapter` bridging `IStateTrie` to revm's state callback interface
3. Create `RevmEngine implements IEvmEngine`
4. Map EthereumJS types to revm equivalents

### Key Type Mappings

| EthereumJS | revm | Conversion |
|------------|------|-----------|
| `Hardfork.Shanghai` | `SpecId::SHANGHAI` | Enum mapping |
| `runTx(vm, {tx, block})` | `revm.transact(env, tx)` | Adapter |
| `result.totalGasSpent` | `result.gas_used` | Direct |
| `result.execResult.logs` | `result.logs` | Format conversion |
| `Address.fromString()` | `[u8; 20]` | Hex parsing |
| `Account` | `AccountInfo` | Field mapping |

### New Files (Planned)

- `node/src/revm-adapter.ts` — IStateTrie → revm StateDb bridge
- `node/src/revm-engine.ts` — RevmEngine implements IEvmEngine
- `node/src/evm-factory.ts` — Engine factory (select by config)

## Stage 4: Dual-Engine Verification (Planned)

Run both engines in parallel on identical transactions, compare:
- Transaction hashes
- Gas used
- Success/failure status
- Receipt logs
- State roots (critical for chain compatibility)

All results must be **100% identical** before switching the default engine.

## Stage 5: Default Engine Switch (Planned)

- Config: `evmEngine: "revm"` (default), `"ethereumjs"` (fallback)
- Hardfork-based switch: blocks before height N use EthereumJS, after N use revm
- No impact on existing chain data (execution engine is an internal implementation detail)

## Expected TPS Improvement

| Engine | Simple Transfers | Contract Calls | Theoretical Ceiling |
|--------|-----------------|---------------|-------------------|
| EthereumJS (current) | 133 TPS | ~50-80 TPS | ~170 TPS |
| revm WASM | **500-800 TPS** | **200-400 TPS** | **~1000 TPS** |
| revm native (napi-rs, future) | **800-1500 TPS** | **400-800 TPS** | **~2000 TPS** |

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| State root mismatch | Medium | Fatal (chain fork) | Stage 4 dual-engine comparison; EF test vectors |
| revm WASM slower than expected | Low | Reduced gains | WASM still 5-10x faster than JS; can upgrade to napi-rs |
| Debug trace API incompatible | High | Partial feature loss | Keep EthereumJS fallback for tracing |
| Cancun features (beacon roots) | Medium | Feature gap | revm supports Cancun; map SpecId correctly |

## Files Summary

| File | Operation | Stage |
|------|-----------|-------|
| `node/src/evm-types.ts` | **Created** | 1 |
| `node/src/evm-engine.ts` | **Created** | 2 |
| `node/src/evm.ts` | Modified (+`prepareBlock()`) | 1-2 |
| `node/src/chain-engine-persistent.ts` | Modified (use `prepareBlock()`) | 1 |
| `node/src/chain-engine.ts` | Modified (use `prepareBlock()`) | 1 |
| `node/src/revm-adapter.ts` | Planned | 3 |
| `node/src/revm-engine.ts` | Planned | 3 |
| `node/src/evm-factory.ts` | Planned | 4 |
