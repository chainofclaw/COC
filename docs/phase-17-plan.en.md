# Phase 17: Debug/Trace APIs

## Overview

Phase 17 adds debug and trace APIs for transaction-level inspection, compatible with Ethereum's `debug_traceTransaction`, `debug_traceBlockByNumber`, and OpenEthereum's `trace_transaction` format.

## Components

### Debug Trace Module (`debug-trace.ts`)

- `traceTransaction()`: simplified execution trace from receipt data
  - Tries persistent storage first, falls back to EVM memory
  - Returns `TransactionTrace` with gas, failed status, and structLogs
- `traceBlockByNumber()`: trace all transactions in a block
  - Parses raw tx data to extract hashes
  - Collects traces for each transaction
- `traceTransactionCalls()`: OpenEthereum-compatible call trace
  - Returns `CallTrace[]` with from/to/value/gas/input/output
  - Includes error field for failed transactions

### RPC Integration (`rpc.ts`)

- `debug_traceTransaction(txHash, options?)` → `TransactionTrace`
- `debug_traceBlockByNumber(blockNumber)` → `Array<{txHash, result}>`
- `trace_transaction(txHash)` → `CallTrace[]`

### Bug Fix: getReceiptsByBlock

Fixed `PersistentChainEngine.getReceiptsByBlock()` to properly parse raw transaction data to extract tx hashes before looking up receipts, instead of incorrectly using raw tx hex as hash.

## Test Coverage

- `debug-trace.test.ts`: 5 tests (all passing)
- Tests cover: trace confirmed tx, non-existent tx error, block tracing, non-existent block error, call trace format

## Status: Complete
