# Phase 14: WebSocket Subscriptions & Real-time Events

## Overview

Phase 14 adds WebSocket JSON-RPC support for real-time event streaming, implementing `eth_subscribe` and `eth_unsubscribe` methods. This enables clients to receive push notifications for new blocks, pending transactions, and log events.

## Goals

1. Create a typed chain event emitter for block, transaction, and log events
2. Implement WebSocket JSON-RPC server with subscription management
3. Support `newHeads`, `newPendingTransactions`, and `logs` subscription types
4. Integrate WebSocket server into the node entry point
5. Maintain backward compatibility with existing HTTP RPC

## Architecture

```
                ┌──────────────────┐
                │   IChainEngine   │
                │  (events field)  │
                └────────┬─────────┘
                         │
              ┌──────────▼──────────┐
              │  ChainEventEmitter  │
              │  (newBlock/pendingTx│
              │   /log emissions)   │
              └──────────┬──────────┘
                         │
           ┌─────────────┼─────────────┐
           │             │             │
    ┌──────▼──────┐ ┌────▼─────┐ ┌────▼─────┐
    │  newHeads   │ │ pending  │ │   logs   │
    │ subscribers │ │ tx subs  │ │  subs    │
    └─────────────┘ └──────────┘ └──────────┘
           │             │             │
    ┌──────▼─────────────▼─────────────▼──────┐
    │          WebSocket RPC Server            │
    │  (ws://host:port, eth_subscribe/unsub)   │
    └──────────────────────────────────────────┘
```

## Components

### ChainEventEmitter (`chain-events.ts`)
- Wraps Node.js `EventEmitter` with typed event methods
- Event types: `BlockEvent`, `PendingTxEvent`, `LogEvent`
- Helper formatters: `formatNewHeadsNotification()`, `formatLogNotification()`
- Max listeners set to 1000 for high-concurrency scenarios

### WebSocket RPC Server (`websocket-rpc.ts`)
- Built on `ws` package for production-grade WebSocket support
- Handles `eth_subscribe` and `eth_unsubscribe` methods
- Delegates standard RPC methods to the shared `handleRpcMethod()` handler
- Per-client subscription tracking with automatic cleanup on disconnect
- Subscription filter matching for `logs` type (address + topics)

### Engine Integration
- Both `ChainEngine` (memory) and `PersistentChainEngine` (LevelDB) emit events
- `IChainEngine` interface includes `events: ChainEventEmitter` field
- Events emitted in `addRawTx()` (pending tx) and `applyBlock()` (block + logs)

### Node Entry Point (`index.ts`)
- WebSocket server starts alongside HTTP RPC server
- Configurable via `wsPort` and `wsBind` settings
- Graceful shutdown stops WebSocket server and cleans up subscriptions

## Configuration

```json
{
  "wsBind": "127.0.0.1",
  "wsPort": 18781
}
```

Default WebSocket port is `18781` (HTTP RPC port + 1).

## Subscription Types

### newHeads
Receives block header notifications in Ethereum-compatible format:
```json
{
  "jsonrpc": "2.0",
  "method": "eth_subscription",
  "params": {
    "subscription": "0x...",
    "result": {
      "number": "0x1",
      "hash": "0x...",
      "parentHash": "0x...",
      "timestamp": "0x..."
    }
  }
}
```

### newPendingTransactions
Receives transaction hashes as they enter the mempool.

### logs
Receives filtered log events with optional address and topics filtering.

## Test Coverage

- `websocket-rpc.test.ts`: 5 tests
  - Standard RPC method forwarding over WebSocket
  - newHeads subscription with block notification
  - newPendingTransactions subscription
  - Unsubscribe stops notifications
  - Client disconnect cleanup
- All existing tests pass (54 total)

## Status: Complete
