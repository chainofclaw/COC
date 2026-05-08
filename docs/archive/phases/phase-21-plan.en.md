# Phase 21: Storage Pruning

## Overview

Phase 21 adds a storage pruner for managing data lifecycle, removing old blocks/logs below a configurable retention height, and providing storage statistics.

## Components

### StoragePruner (`storage/pruner.ts`)
- Configurable retention: keep N blocks from chain tip (default 10,000)
- Batch pruning: process up to N blocks per run (default 100)
- Removes block data (by number and hash index), logs
- Persists pruning height to DB for recovery across restarts
- Auto-prune mode with configurable interval (default 5 minutes)
- Storage statistics: latest block, pruning height, retained blocks
- `prune()` returns detailed results (blocks/txs/logs removed, duration)

### Configuration
- `retentionBlocks`: how many blocks to keep (default 10,000)
- `pruneIntervalMs`: auto-prune interval (default 300,000ms)
- `batchSize`: max blocks per prune run (default 100)
- `enableAutoPrune`: enable interval-based pruning

## Test Coverage

- `storage/pruner.test.ts`: 8 tests (all passing)
- Covers: basic pruning, batch limits, no-op when current, persistence, stats, hash index cleanup, empty DB, duration tracking

## Status: Complete
