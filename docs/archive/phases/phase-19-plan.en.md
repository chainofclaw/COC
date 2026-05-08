# Phase 19: PoSe Dispute Automation

## Overview

Phase 19 adds automated dispute detection, cumulative penalty tracking, and dispute event logging to the PoSe (Proof of Service) system.

## Components

### DisputeMonitor (`services/dispute/dispute-monitor.ts`)
- Automated batch validation against locally observed receipts
- Detects: missing local receipts for submitted batches, summary hash mismatches
- Skips finalized/disputed batches and avoids re-processing
- Configurable: check interval, max batches per check, auto-challenge toggle
- `validateBatch()` / `validateBatches()` for batch inspection
- `drainDisputes()` for consuming pending dispute results

### PenaltyTracker (`services/dispute/penalty-tracker.ts`)
- Cumulative penalty point tracking per node
- Evidence-based point assignment: ReplayNonce(20), InvalidSig(15), Timeout(5), StorageProof(30), MissingReceipt(10)
- Two-tier penalty system:
  - Suspend threshold (default 50 points): temporary suspension with configurable duration
  - Eject threshold (default 100 points): permanent ejection
- Time-based decay: points reduce at configurable rate per hour
- `isPenalized()` / `isEjected()` / `getPenalizedNodes()` queries

### DisputeLogger (`services/dispute/dispute-logger.ts`)
- Event logging for all dispute activities (challenge, verify, slash, dispute, finalize)
- Query API with filters: type, nodeId, epochId, timestamp range, limit
- Event summary counts grouped by type
- Node history retrieval
- Configurable max event capacity with FIFO eviction

## Test Coverage

- `services/dispute/dispute.test.ts`: 22 tests (7 monitor + 7 penalty + 8 logger)
- All tests passing

## Status: Complete
