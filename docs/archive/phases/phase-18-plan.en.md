# Phase 18: Explorer WebSocket Integration

## Overview

Phase 18 adds real-time WebSocket subscriptions to the block explorer, enabling live block and pending transaction updates without page refresh.

## Components

### WebSocket Hook (`use-websocket.ts`)
- Manages WebSocket connection lifecycle with auto-reconnect
- JSON-RPC request/response handling via WebSocket
- `eth_subscribe`/`eth_unsubscribe` wrapper
- Subscription tracking with callback dispatch
- RPC timeout handling (10s)
- Reconnection with 3s delay on disconnect

### LiveBlocks Component (`LiveBlocks.tsx`)
- Subscribes to `newHeads` for real-time block notifications
- Displays latest 10 blocks with number, hash, gas, timestamp
- Green pulse indicator for live connection
- Yellow indicator when connecting

### LiveTransactions Component (`LiveTransactions.tsx`)
- Subscribes to `newPendingTransactions` for mempool visibility
- Shows latest 20 pending transaction hashes
- Deduplication of tx hashes
- Pending status badge

### ConnectionStatus Component (`ConnectionStatus.tsx`)
- Header indicator showing WebSocket connection state
- Green/Red dot with Live/Offline text

### Updated Pages
- Homepage: real-time blocks + pending txs grid above historical blocks
- Layout: navigation links + connection status in header
- Connection info: displays both HTTP RPC and WebSocket endpoints

## Configuration

- `NEXT_PUBLIC_WS_URL`: WebSocket endpoint (default: `ws://127.0.0.1:18781`)
- `NEXT_PUBLIC_RPC_URL`: HTTP RPC endpoint (default: `http://127.0.0.1:28780`)

## Status: Complete
