# Phase 36: Testnet Operational Hardening

## 1. Goal

Harden the COC blockchain node for testnet deployment with production-grade operational features:
- Graceful shutdown on SIGTERM (container/systemd compatibility)
- Configurable bind addresses via environment variables
- LevelDB corruption detection and auto-repair
- RPC authentication middleware (Bearer token)
- Admin RPC namespace for runtime peer management

## 2. Features

### 2.1 SIGTERM Graceful Shutdown
- Shared shutdown handler for both SIGINT and SIGTERM signals
- Properly stops: consensus, metrics, WebSocket, wire server/clients, DHT, pubsub, persistent storage
- Idempotent (prevents double-shutdown race)

### 2.2 Configurable Bind Addresses
| Env Var | Config Key | Default (production) | Default (dev) |
|---------|-----------|---------------------|---------------|
| COC_RPC_BIND | rpcBind | 0.0.0.0 | 127.0.0.1 |
| COC_P2P_BIND | p2pBind | 0.0.0.0 | 127.0.0.1 |
| COC_WS_BIND | wsBind | 0.0.0.0 | 127.0.0.1 |
| COC_IPFS_BIND | ipfsBind | 0.0.0.0 | 127.0.0.1 |
| COC_WIRE_BIND | wireBind | 0.0.0.0 | 127.0.0.1 |

Dev mode: `COC_DEV_MODE=1` switches defaults to 127.0.0.1.

### 2.3 LevelDB Corruption Recovery
- Detects corruption-related errors during `open()`
- Automatically calls `ClassicLevel.repair()` on the database path
- Re-creates and re-opens the database after successful repair
- Static `LevelDatabase.repair(path)` method for manual recovery

### 2.4 RPC Authentication
- Optional Bearer token authentication via `COC_RPC_AUTH_TOKEN` env var
- When configured, all RPC requests must include `Authorization: Bearer <token>` header
- Unauthorized requests receive 401 with structured JSON-RPC error
- Auth check runs before body parsing (early rejection)

### 2.5 Admin RPC Namespace
| Method | Params | Description |
|--------|--------|-------------|
| admin_nodeInfo | none | Returns node ID, version, chain ID, block height, peer count, uptime, system info |
| admin_addPeer | [url, id?] | Adds a peer to the discovery pool |
| admin_removePeer | [id] | Removes a peer from the discovery pool |
| admin_peers | none | Lists all connected peers |

Gated by `COC_ENABLE_ADMIN_RPC=1` or `enableAdminRpc: true` in config.

## 3. Files

| Action | Path | Description |
|--------|------|-------------|
| **MOD** | `node/src/index.ts` | SIGTERM handler, auth options |
| **MOD** | `node/src/config.ts` | Bind env vars, auth config |
| **MOD** | `node/src/storage/db.ts` | Corruption recovery |
| **MOD** | `node/src/rpc.ts` | Auth middleware, admin namespace |
| **MOD** | `node/src/peer-discovery.ts` | removePeer method |
| **NEW** | `node/src/phase36.test.ts` | 6 tests |

## 4. Tests (6 tests, 1 file)

| Suite | Tests | Coverage |
|-------|-------|----------|
| LevelDatabase.repair | 2 | Repair static method, normal open |
| Config bind env vars | 1 | Validation acceptance |
| RPC auth middleware | 1 | No auth / wrong token / correct token |
| Admin RPC namespace | 1 | admin_nodeInfo, admin_addPeer |
| PeerDiscovery.removePeer | 1 | Add and remove peers |

## 5. Verification

```bash
# 1. SIGTERM test
COC_DATA_DIR=/tmp/coc-sigterm node --experimental-strip-types node/src/index.ts &
PID=$!
kill -TERM $PID  # Should log "received SIGTERM, shutting down..." and exit cleanly

# 2. Bind address test
COC_RPC_BIND=0.0.0.0 COC_DATA_DIR=/tmp/coc-bind node --experimental-strip-types node/src/index.ts
# RPC should listen on 0.0.0.0:18780

# 3. RPC auth test
COC_RPC_AUTH_TOKEN=secret COC_DATA_DIR=/tmp/coc-auth node --experimental-strip-types node/src/index.ts
curl -X POST http://127.0.0.1:18780 -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'
# -> 401 unauthorized
curl -X POST -H "Authorization: Bearer secret" http://127.0.0.1:18780 -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'
# -> 200 with block number

# 4. Admin RPC test
COC_ENABLE_ADMIN_RPC=1 COC_DATA_DIR=/tmp/coc-admin node --experimental-strip-types node/src/index.ts
curl -X POST http://127.0.0.1:18780 -d '{"jsonrpc":"2.0","id":1,"method":"admin_nodeInfo"}'
# -> node info JSON

# 5. Run tests
cd node && node --experimental-strip-types --test --test-force-exit src/phase36.test.ts
```
