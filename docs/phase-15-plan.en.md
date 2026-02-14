# Phase 15: Enhanced Mempool

## Overview

Phase 15 upgrades the mempool with EIP-1559 fee market support, transaction replacement, capacity-based eviction, per-sender limits, TTL expiry, and replay protection.

## Features

- **EIP-1559 support**: Tracks maxFeePerGas and maxPriorityFeePerGas fields
- **Transaction replacement**: Same sender+nonce with 10% minimum gas price bump
- **Capacity eviction**: Drops lowest-fee txs when pool reaches maxSize (default 4096)
- **Per-sender limit**: Max 64 pending txs per address (configurable)
- **TTL expiry**: Auto-evicts transactions older than 6 hours
- **Replay protection**: Validates chain ID on incoming transactions
- **Pool statistics**: Size, sender count, oldest tx metrics

## Configuration

```typescript
interface MempoolConfig {
  maxSize: number           // default: 4096
  maxPerSender: number      // default: 64
  minGasBump: number        // default: 10 (percent)
  evictionBatchSize: number // default: 16
  txTtlMs: number           // default: 6 hours
  chainId: number           // default: 18780
}
```

## Test Coverage

- `mempool.test.ts`: 10 tests covering all features
- All 64 existing tests pass

## Status: Complete
