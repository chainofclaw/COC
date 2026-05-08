# Phase 13.2: Node Integration & Event Indexing

## Overview

Phase 13.2 bridges Phase 13.1's persistent storage layer with the running node, making LevelDB the default production backend. It also adds persistent event/log indexing for efficient `eth_getLogs` queries.

## Goals

1. Abstract chain engine behind `IChainEngine` interface
2. Integrate `PersistentChainEngine` into node startup flow
3. Add persistent event/log indexing to `BlockIndex`
4. Auto-migrate legacy `chain.json` on startup
5. Update RPC server to leverage persistent storage

## Architecture

```
                ┌──────────────┐
                │  IChainEngine │  (interface)
                └──────┬───────┘
           ┌───────────┴───────────┐
           │                       │
    ┌──────▼──────┐    ┌──────────▼──────────┐
    │ ChainEngine │    │ PersistentChainEngine │
    │  (memory)   │    │   (LevelDB)           │
    └─────────────┘    └────────┬──────────────┘
                                │
                    ┌───────────┼──────────┐
                    │           │          │
              ┌─────▼─┐  ┌─────▼────┐ ┌──▼────────┐
              │ Block  │  │  Nonce   │ │   Log     │
              │ Index  │  │  Store   │ │  Index    │
              └────────┘  └──────────┘ └───────────┘
```

## Components

### IChainEngine Interface (`chain-engine-types.ts`)
- Common interface for both engine backends
- `ISnapshotSyncEngine` for legacy sync
- `IBlockSyncEngine` for block-based sync
- Optional `getLogs()` and `getTransactionByHash()` methods

### Event/Log Indexing (`block-index.ts`)
- `IndexedLog` type with full event metadata
- `LogFilter` for address/topic filtering
- `putLogs()` stores logs keyed by block number
- `getLogs()` queries across block ranges with filtering

### Node Entry Point (`index.ts`)
- Config-driven backend selection via `storage.backend`
- Auto-migration of legacy `chain.json` on startup
- Graceful shutdown with LevelDB cleanup

### RPC Server (`rpc.ts`)
- All methods now work with `IChainEngine` interface
- `eth_getLogs` uses persistent index when available
- `eth_getTransactionByHash` falls back from persistent to EVM memory
- Properly handles async/sync return values

## Configuration

```json
{
  "storage": {
    "backend": "leveldb",
    "leveldbDir": "~/.clawdbot/coc/leveldb",
    "cacheSize": 1000,
    "enablePruning": false,
    "nonceRetentionDays": 7
  }
}
```

Set `"backend": "memory"` to use legacy in-memory storage.

## Test Coverage

- `rpc-persistent.test.ts`: 5 tests (block queries, tx receipts, log indexing, restart persistence)
- `block-index.test.ts`: 9 tests (+2 new log index tests)
- All existing tests pass (25 core + 5 persistent engine + 7 integration)

## Migration Path

1. Existing nodes with `chain.json` → auto-migrated to LevelDB on first startup
2. `chain.json` renamed to `chain.json.bak` after successful migration
3. No data loss; migration is idempotent

## Status: Complete
