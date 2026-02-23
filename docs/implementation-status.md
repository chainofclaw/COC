# COC Implementation Status (English)

This document maps the whitepaper scope to the current codebase and test coverage. It is intended as a concise engineering status report.

## Legend
- **Implemented**: present in code and exercised in devnet scripts
- **Partial**: present but simplified, stubbed, or not yet hardened
- **Missing**: not implemented

## 1) Execution Layer (EVM)
**Status: Partial (Enhanced in Phase 13.1 + 13.2 + 14 + 17 + 26)**

Implemented:
- In-memory EVM execution using `@ethereumjs/vm`
- Transaction execution with receipts and basic logs
- JSON-RPC methods: eth_call, eth_estimateGas, eth_getCode, eth_getStorageAt, eth_getLogs, eth_sendTransaction
- **Phase 13.1**: Persistent state trie with Merkle Patricia Trie
- **Phase 13.1**: Account state and storage slots persistence
- **Phase 13.2**: `IChainEngine` interface for engine abstraction
- **Phase 13.2**: Persistent event/log indexing with address/topic filtering
- **Phase 13.2**: RPC transparent backend switching (memory ↔ LevelDB)
- **Phase 13.2**: Transaction receipt persistence across restarts
- **Phase 14**: WebSocket JSON-RPC server (eth_subscribe/eth_unsubscribe)
- **Phase 14**: Real-time subscriptions: newHeads, newPendingTransactions, logs
- **Phase 14**: Chain event emitter with typed event system
- **Phase 17**: Debug/trace APIs (debug_traceTransaction, debug_traceBlockByNumber, trace_transaction)
- **Phase 20**: State trie optimization (LRU cache, dirty tracking, account cache, root persistence)
- **Phase 26**: EVM state persistence via PersistentStateManager adapter
- **Phase 26**: State survives node restart (no replay needed when state root exists)
- **Phase 26**: Snapshot restore via setStateRoot

Missing/Partial:
- Proper block header fields (receiptsRoot, stateRoot from real state)

Code:
- `COC/node/src/evm.ts`
- `COC/node/src/rpc.ts`
- `COC/node/src/debug-trace.ts`
- `COC/node/src/chain-engine-types.ts` (NEW - Phase 13.2)
- `COC/node/src/chain-engine-persistent.ts`
- `COC/node/src/storage/state-trie.ts`
- `COC/node/src/storage/persistent-state-manager.ts` (NEW - Phase 26)

## 2) Consensus & Block Production
**Status: Partial (Enhanced in Phase 13.2 + 22 + 26 + 28 + 32)**

Implemented:
- Deterministic round‑robin proposer rotation
- Simple finality depth marking
- Block hash calculation and link validation
- **Phase 13.2**: ConsensusEngine works with both memory and persistent backends
- **Phase 13.2**: Support for both snapshot-based and block-based sync
- **Phase 22**: Validator governance with proposal-based set management
- **Phase 22**: Stake-weighted voting and epoch-based transitions
- **Phase 26**: ValidatorGovernance connected to PersistentChainEngine
- **Phase 26**: Stake-weighted proposer selection (cumulative threshold algorithm)
- **Phase 26**: Block signature and stateRoot fields in ChainBlock
- **Phase 26**: Governance RPC methods (coc_getValidators, coc_submitProposal, coc_voteProposal)
- **Phase 28**: BFT-lite consensus round state machine (three-phase commit: propose/prepare/commit)
- **Phase 28**: Stake-weighted quorum threshold (`floor(2/3 * totalStake) + 1`)
- **Phase 28**: BFT coordinator lifecycle management (round start, message handling, timeout)
- **Phase 28**: `coc_getBftStatus` RPC endpoint
- **Phase 28**: GHOST-inspired fork choice rule (BFT finality > chain length > cumulative weight > hash)
- **Phase 28**: `shouldSwitchFork()` for deterministic chain selection

- **Phase 29**: BFT coordinator integrated into ConsensusEngine `tryPropose()` (BFT round instead of direct broadcast when enabled)
- **Phase 29**: Fork choice rule (`shouldSwitchFork()`) integrated into ConsensusEngine `trySync()`
- **Phase 29**: Snap sync provider support in ConsensusEngine for state snapshot fetching

- **Phase 32**: BFT messages broadcast via dual transport (HTTP gossip + wire protocol TCP)

- **Phase 34**: BFT slashing handler: equivocation → stake slash → treasury deposit → auto-remove
- **Phase 34**: ValidatorGovernance slashing API (applySlash, deactivateValidator, getMinStake)

Missing/Partial:
- On-chain slashing via PoSeManager contract integration

Code:
- `COC/node/src/chain-engine.ts`
- `COC/node/src/chain-engine-persistent.ts`
- `COC/node/src/hash.ts`
- `COC/node/src/consensus.ts` (UPDATED - Phase 29: BFT + fork choice + snap sync integration)
- `COC/node/src/bft.ts` (NEW - Phase 28)
- `COC/node/src/bft-coordinator.ts` (NEW - Phase 28)
- `COC/node/src/fork-choice.ts` (NEW - Phase 28)

## 3) P2P Networking
**Status: Partial (Enhanced in Phase 16 + 26 + 28 + 32)**

Implemented:
- HTTP-based gossip for tx and blocks
- Snapshot sync from peers
- **Phase 16**: Peer discovery via peer exchange protocol
- **Phase 16**: Reputation-based peer scoring (success/failure/invalid/timeout)
- **Phase 16**: Automatic ban/unban with configurable thresholds
- **Phase 16**: Periodic health checking and score decay
- **Phase 16**: `/p2p/peers` endpoint for peer list exchange
- **Phase 16**: Active peer selection for broadcasting
- **Phase 26**: Peer persistence to disk (peers.json with auto-save)
- **Phase 26**: DNS seed discovery (TXT record resolution)
- **Phase 26**: Peer expiration filtering (configurable TTL, default 7 days)
- **Phase 26**: Failure tracking with auto-removal after threshold
- **Phase 26**: Pubsub message forwarding via `/p2p/pubsub-message`
- **Phase 28**: Binary wire protocol with frame encoding/decoding (Magic 0xC0C1, type/length/payload)
- **Phase 28**: `FrameDecoder` streaming accumulator for TCP partial reads
- **Phase 28**: Kademlia DHT routing table with XOR distance metric and 256 K-buckets (K=20)
- **Phase 28**: `findClosest(target, K)` for nearest-peer lookup
- **Phase 28**: BFT message routing via `/p2p/bft-message` endpoint + `broadcastBft()`

- **Phase 29**: Wire server TCP transport (accept inbound connections, handshake with chain ID validation, frame dispatch)
- **Phase 29**: Wire client TCP transport (outbound connections, exponential backoff reconnect 1s-30s)
- **Phase 29**: DHT network layer (bootstrap from seeds, iterative FIND_NODE with alpha=3, periodic refresh every 5 min)
- **Phase 29**: State snapshot P2P endpoint (`GET /p2p/state-snapshot`)

- **Phase 32**: Wire protocol Block/Tx dedup via BoundedSet (seenTx 50K, seenBlocks 10K)
- **Phase 32**: Cross-protocol relay: Wire→HTTP (onTxRelay/onBlockRelay callbacks)
- **Phase 32**: BFT message broadcast via wire protocol TCP (dual HTTP+TCP transport)
- **Phase 32**: DHT FIND_NODE uses wireClientByPeerId map (O(1) lookup) → wireClients scan → local routing table fallback
- **Phase 32**: Per-peer wire port from dhtBootstrapPeers config (no longer uses local wirePort for all peers)
- **Phase 32**: broadcastFrame supports excludeNodeId parameter

Missing/Partial:
- HTTP gossip still primary transport; wire protocol is opt-in alternative

Code:
- `COC/node/src/p2p.ts` (UPDATED - Phase 29: state snapshot endpoint)
- `COC/node/src/peer-store.ts` (NEW - Phase 26)
- `COC/node/src/dns-seeds.ts` (NEW - Phase 26)
- `COC/node/src/peer-discovery.ts`
- `COC/node/src/wire-protocol.ts` (NEW - Phase 28)
- `COC/node/src/wire-server.ts` (NEW - Phase 29)
- `COC/node/src/wire-client.ts` (NEW - Phase 29)
- `COC/node/src/dht.ts` (NEW - Phase 28)
- `COC/node/src/dht-network.ts` (NEW - Phase 29)

## 4) Storage & Persistence
**Status: Implemented (Phase 13.1 + 13.2 + 21 + 26 Complete)**

Implemented:
- Chain snapshot persistence (JSON, legacy)
- Rebuild from snapshot / persisted blocks
- **Phase 13.1**: LevelDB-backed persistent storage
- **Phase 13.1**: Block and transaction indexing (by hash, by number)
- **Phase 13.1**: Nonce registry persistence (anti-replay)
- **Phase 13.1**: EVM state trie persistence
- **Phase 13.2**: Persistent event/log indexing with filtering
- **Phase 13.2**: Legacy chain.json auto-migration
- **Phase 13.2**: Config-driven backend selection (memory/leveldb)
- **Phase 13.2**: Graceful shutdown with LevelDB cleanup
- **Phase 21**: Block/log pruning with configurable retention and batch processing
- **Phase 21**: Pruning height persistence and storage statistics
- IPFS-compatible blockstore + UnixFS file layout
- IPFS HTTP API subset

- **Phase 26**: IPFS MFS (Mutable File System) - mkdir/write/read/ls/rm/mv/cp/stat/flush
- **Phase 26**: IPFS Pubsub - topic-based messaging with deduplication and P2P forwarding
- **Phase 26**: MFS HTTP routes (`/api/v0/files/*`)
- **Phase 26**: Pubsub HTTP routes (`/api/v0/pubsub/*`) with ndjson streaming
- **Phase 28**: IPFS tar archive for `/api/v0/get` (POSIX USTAR format)
- **Phase 28**: EVM state snapshot export/import for fast sync

Missing/Partial:
- Full incremental compaction (tx-level pruning)

Code:
- `COC/node/src/storage.ts` (legacy)
- `COC/node/src/storage/db.ts`
- `COC/node/src/storage/block-index.ts`
- `COC/node/src/storage/nonce-store.ts`
- `COC/node/src/storage/state-trie.ts`
- `COC/node/src/storage/migrate-legacy.ts`
- `COC/node/src/storage/snapshot-manager.ts`
- `COC/node/src/ipfs-blockstore.ts`
- `COC/node/src/ipfs-unixfs.ts`
- `COC/node/src/ipfs-http.ts`
- `COC/node/src/ipfs-mfs.ts` (NEW - Phase 26)
- `COC/node/src/ipfs-pubsub.ts` (NEW - Phase 26)
- `COC/node/src/ipfs-tar.ts` (NEW - Phase 28)
- `COC/node/src/state-snapshot.ts` (NEW - Phase 28)

## 5) Mempool & Fee Market
**Status: Implemented (Phase 15)**

Implemented:
- Gas price priority + nonce continuity
- Mempool → block selection
- **Phase 15**: EIP-1559 fee market (maxFeePerGas, maxPriorityFeePerGas)
- **Phase 15**: Transaction replacement with 10% gas price bump
- **Phase 15**: Capacity-based eviction (4096 max pool size)
- **Phase 15**: Per-sender tx limit (64 max)
- **Phase 15**: TTL-based expiry (6 hours)
- **Phase 15**: Replay protection via chain ID validation
- **Phase 15**: Pool statistics API

Code:
- `COC/node/src/mempool.ts`

## 6) PoSe Protocol (Off‑chain)
**Status: Partial (Enhanced in Phase 19)**

Implemented:
- Challenge/Receipt types + nonce registry
- Receipt verification (U/S/R hooks)
- Batch aggregation (Merkle root + sample proofs)
- Epoch scoring and reward calculation
- Storage proof generation from IPFS file metadata
- **Phase 19**: Automated batch validation (DisputeMonitor)
- **Phase 19**: Cumulative penalty tracking with suspend/eject (PenaltyTracker)
- **Phase 19**: Dispute event logging and query API (DisputeLogger)

Missing/Partial:
- Batch challenge on-chain automation (agent → contract integration)
- Challenger reward mechanism

Code:
- `COC/services/challenger/*`
- `COC/services/verifier/*`
- `COC/services/aggregator/*`
- `COC/runtime/coc-node.ts`

## 7) PoSe Settlement (On‑chain)
**Status: Implemented**

Implemented:
- `PoSeManager` contract: register, update commitment, submit batch, challenge, finalize epoch, slash

Code:
- `COC/contracts/settlement/PoSeManager.sol`

## 8) Runtime Services
**Status: Partial**

Implemented:
- `coc-node` HTTP endpoints for PoSe challenge/receipt
- `coc-agent` for challenge generation, batch submission, node registration
- `coc-relayer` for epoch finalization and slash hooks

Missing/Partial:
- Full integration with a real L1/L2 network
- Secure key management and production‑grade retries

Code:
- `COC/runtime/coc-node.ts`
- `COC/runtime/coc-agent.ts`
- `COC/runtime/coc-relayer.ts`

## 9) Wallet CLI
**Status: Implemented (Minimal)**

Implemented:
- Create address
- Transfer
- Query balance

Code:
- `COC/wallet/bin/coc-wallet.js`

## 10) Devnet & Tests
**Status: Implemented**

Implemented:
- 3/5/7 node devnet scripts
- End‑to‑end verify script: block production + tx propagation
- Quality gate script for automated testing (unit + integration + e2e)
- Comprehensive test coverage (91 test files, 924 tests across all modules)

Code:
- `COC/scripts/start-devnet.sh`
- `COC/scripts/stop-devnet.sh`
- `COC/scripts/verify-devnet.sh`
- `COC/scripts/quality-gate.sh`

Tests:
- `COC/contracts/test/PoSeManager.test.js`
- `COC/tests/integration/pose-pipeline.integration.test.ts`
- `COC/tests/integration/dispute-pipeline.integration.test.ts`
- `COC/tests/e2e/epoch-settlement.e2e.test.ts`
- Unit tests distributed across all modules (`services/*`, `nodeops/*`, `node/src/*`)

## 11) Blockchain Explorer
**Status: Implemented (Enhanced in Phase 18 + 25 + 27)**

Implemented:
- Next.js 15 web application with React 19
- Block explorer with pagination and details
- Transaction viewer with receipt and logs
- Address explorer with balance and transaction history
- Real-time data from JSON-RPC endpoint
- Responsive UI with Tailwind CSS
- **Phase 18**: WebSocket real-time block updates (newHeads subscription)
- **Phase 18**: Live pending transactions display (newPendingTransactions subscription)
- **Phase 18**: Connection status indicator with auto-reconnect
- **Phase 18**: WebSocket hook for client-side subscriptions
- **Phase 25**: Address transaction history with direction/type filtering
- **Phase 25**: Contract view with bytecode, storage reader, event logs
- **Phase 25**: Global search bar (address/tx hash/block number)
- **Phase 25**: Address-to-transaction index in BlockIndex (backend)
- **Phase 25**: `coc_getTransactionsByAddress` custom RPC method
- **Phase 27**: Contract registry index with `coc_getContractsByPage` RPC
- **Phase 27**: Contract call history component (incoming transactions to contract)
- **Phase 27**: Address tx history with operation type classification (transfer/contract_call/contract_creation/token_transfer)
- **Phase 27**: Contract deployment metadata on address page
- **Phase 27**: Internal transactions trace display in tx detail
- **Phase 27**: Validators page with governance stake and voting power
- **Phase 27**: Enhanced stats page with `coc_chainStats` RPC
- **Phase 27**: Mempool page sorting/filtering with pending/queued tabs
- **Phase 27**: WebSocket exponential backoff with jitter and reconnecting state indicator
- **Phase 27**: Error boundaries and loading states
- **Phase 27**: Homepage optimization using `coc_chainStats`
- **Phase 27**: RPC error handling (HTTP status checks, network error catch)

Missing/Partial:
- Contract ABI verification and decoding
- Historical analytics and charts

Code:
- `COC/explorer/src/app/page.tsx` (home with latest blocks)
- `COC/explorer/src/app/block/[id]/page.tsx` (block details with proposer/stateRoot)
- `COC/explorer/src/app/tx/[hash]/page.tsx` (transaction details with internal traces)
- `COC/explorer/src/app/address/[address]/page.tsx` (address explorer with tx type classification)
- `COC/explorer/src/app/contracts/page.tsx` (indexed contract listing with pagination)
- `COC/explorer/src/lib/provider.ts` (ethers.js provider)
- `COC/explorer/src/lib/rpc.ts` (custom RPC calls with error handling)
- `COC/explorer/src/lib/use-websocket.ts` (WebSocket hook with exponential backoff)
- `COC/explorer/src/components/SearchBar.tsx` (global search with tx/block disambiguation)
- `COC/explorer/src/components/TxHistory.tsx` (transaction history)
- `COC/explorer/src/components/ContractView.tsx` (contract viewer)
- `COC/explorer/src/components/ContractCallHistory.tsx` (contract call history)
- `COC/explorer/src/components/ConnectionStatus.tsx` (live/reconnecting/offline indicator)

## 12) Node Operations & Policy Engine
**Status: Implemented**

Implemented:
- YAML-based policy configuration system
- Policy engine for evaluating node behavior rules
- Policy loader with validation and error handling
- Agent lifecycle hooks (onChallengeIssued, onReceiptVerified, onBatchSubmitted)
- Example policies: default, home-lab, alerts

Missing/Partial:
- Real-time policy hot-reload
- Policy conflict detection
- Advanced policy DSL features

Code:
- `COC/nodeops/policy-engine.ts`
- `COC/nodeops/policy-loader.ts`
- `COC/nodeops/agent-hooks.ts`
- `COC/nodeops/policy-types.ts`
- `COC/nodeops/policies/*.yaml`

## 13) Performance & Benchmarking
**Status: Implemented (Enhanced in Phase 23)**

Implemented:
- EVM execution benchmarks
- Gas consumption profiling for common operations
- **Phase 23**: Block production throughput benchmarks (~8.7 blocks/sec)
- **Phase 23**: Transaction processing rate tests (~52 tx/sec)
- **Phase 23**: Mempool operations load testing
- **Phase 23**: Storage I/O performance tests (sub-ms)
- **Phase 23**: Concurrent EVM operations benchmarks

Missing/Partial:
- P2P network throughput benchmarks (requires live network)

Code:
- `COC/node/src/benchmarks/evm-benchmark.test.ts`

## 14) Phase 13.1: Persistent Storage Layer
**Status: Implemented (2026-02-15)**

Implemented:
- LevelDB storage abstraction with async API
- In-memory database for testing
- Block/transaction indexing with multiple query patterns
- Persistent nonce registry (7-day cleanup threshold)
- EVM state trie using Merkle Patricia Trie
- Account state and storage slot persistence
- Contract code storage with hash-based indexing
- Batch operations for atomic writes
- Comprehensive test coverage across storage test files

Missing/Partial:
- State trie checkpoint/revert optimization
- Cross-instance state root verification
- Pruning and archival node modes

Code:
- `COC/node/src/storage/db.ts` + tests
- `COC/node/src/storage/block-index.ts` + tests
- `COC/node/src/storage/nonce-store.ts` + tests
- `COC/node/src/storage/state-trie.ts` + tests

Documentation:
- `COC/docs/phase-13.1-plan.en.md`
- `COC/docs/phase-13.1-plan.zh.md`

## 15) Phase 13.2: Node Integration & Event Indexing
**Status: Implemented (2026-02-15)**

Implemented:
- `IChainEngine` interface abstracting memory and persistent backends
- Node entry point supports config-driven backend selection
- Auto-migration of legacy `chain.json` to LevelDB on startup
- Persistent event/log indexing with address/topic filtering
- RPC `eth_getLogs` uses persistent index when available
- RPC `eth_getTransactionByHash` + `eth_getTransactionReceipt` fall back to persistent storage
- ConsensusEngine works with both engine backends
- Graceful shutdown with LevelDB cleanup
- 5 new RPC-persistent integration tests

Code:
- `COC/node/src/chain-engine-types.ts` (NEW)
- `COC/node/src/index.ts` (UPDATED)
- `COC/node/src/rpc.ts` (UPDATED)
- `COC/node/src/consensus.ts` (UPDATED)
- `COC/node/src/storage/block-index.ts` (UPDATED - log indexing)
- `COC/node/src/rpc-persistent.test.ts` (NEW)

Documentation:
- `COC/docs/phase-13.2-plan.en.md`
- `COC/docs/phase-13.2-plan.zh.md`

## 16) Phase 14: WebSocket Subscriptions & Real-time Events
**Status: Implemented (2026-02-15)**

Implemented:
- `ChainEventEmitter` with typed event emission (newBlock, pendingTx, log)
- WebSocket JSON-RPC server using `ws` package
- `eth_subscribe` / `eth_unsubscribe` methods
- Subscription types: newHeads, newPendingTransactions, logs (with address/topic filtering)
- Per-client subscription management with automatic cleanup
- Both ChainEngine and PersistentChainEngine emit events
- `IChainEngine` interface includes `events` field
- Standard RPC methods forwarded over WebSocket
- Helper formatters for Ethereum-compatible notification format

Code:
- `COC/node/src/chain-events.ts` (NEW)
- `COC/node/src/websocket-rpc.ts` (NEW)
- `COC/node/src/chain-engine.ts` (UPDATED - events)
- `COC/node/src/chain-engine-persistent.ts` (UPDATED - events)
- `COC/node/src/chain-engine-types.ts` (UPDATED - events field)
- `COC/node/src/index.ts` (UPDATED - WS server startup)
- `COC/node/src/config.ts` (UPDATED - wsPort/wsBind)
- `COC/node/src/rpc.ts` (UPDATED - exported handleRpcMethod)
- `COC/node/src/websocket-rpc.test.ts` (NEW - 5 tests)

Documentation:
- `COC/docs/phase-14-plan.en.md`
- `COC/docs/phase-14-plan.zh.md`

## 17) Production Hardening
**Status: Implemented (Phase 24 + 27 + 33)**

Implemented:
- Health check probes (healthy/degraded/unhealthy) with chain, block freshness, peer, mempool checks
- Configuration validator with field validation and severity levels
- Token bucket rate limiter for RPC endpoints with per-client isolation
- Latency measurement per health check
- Stale bucket cleanup for memory efficiency
- **Phase 27**: Config validation function (`validateConfig`) with comprehensive field checks
- **Phase 27**: RPC parameter validation (hex format, required params)
- **Phase 27**: Structured JSON-RPC error codes (-32602, -32603)
- **Phase 27**: PoSe HTTP endpoint field validation
- **Phase 27**: Snapshot JSON import validation
- **Phase 27**: Merkle path index bounds checking
- **Phase 33**: IPFS upload size limit (10MB default)
- **Phase 33**: MFS path traversal prevention (`..` / `.` component check)
- **Phase 33**: Wire server per-IP connection limit (max 5 per IP)
- **Phase 33**: Block timestamp validation (parent ordering + 60s future drift limit)
- **Phase 33**: Node identity authentication (wire handshake signing via NodeSigner/SignatureVerifier)
- **Phase 33**: BFT message signature verification (mandatory signing, reject unsigned/forged votes)
- **Phase 33**: DHT peer verification (TCP connect probe before routing table insertion)
- **Phase 33**: State snapshot stateRoot verification (compare imported root vs expected)
- **Phase 33**: Exponential peer ban duration (base * 2^min(banCount, 10), max 24h)
- **Phase 33**: WebSocket idle timeout (1h inactivity → close)
- **Phase 33**: Dev accounts gated behind `COC_DEV_ACCOUNTS=1` env var
- **Phase 33**: Default bind address changed to `127.0.0.1`
- **Phase 33**: Shared rate limiter for RPC/IPFS/PoSe endpoints
- **Phase 33**: Governance self-vote removal (proposer no longer auto-votes)
- **Phase 33**: PoSeManager ecrecover v-value validation (`v == 27 || v == 28`)

Code:
- `COC/node/src/health.ts`
- `COC/node/src/config.ts` (UPDATED - validateConfig, nodePrivateKey, resolveNodeKey)
- `COC/node/src/rpc.ts` (UPDATED - parameter validation, dev accounts gate)
- `COC/node/src/pose-http.ts` (UPDATED - field validation, rate limiting)
- `COC/node/src/storage/snapshot-manager.ts` (UPDATED - JSON validation)
- `COC/node/src/ipfs-merkle.ts` (UPDATED - bounds check)
- `COC/node/src/ipfs-http.ts` (UPDATED - upload size limit, rate limiting)
- `COC/node/src/ipfs-mfs.ts` (UPDATED - path traversal check)
- `COC/node/src/wire-server.ts` (UPDATED - per-IP limit, handshake signing, default bind)
- `COC/node/src/wire-client.ts` (UPDATED - handshake signing/verification)
- `COC/node/src/chain-engine.ts` (UPDATED - timestamp validation)
- `COC/node/src/bft.ts` (UPDATED - mandatory signature field)
- `COC/node/src/bft-coordinator.ts` (UPDATED - sign/verify BFT messages)
- `COC/node/src/dht-network.ts` (UPDATED - peer verification, stale peer filtering)
- `COC/node/src/state-snapshot.ts` (UPDATED - stateRoot verification)
- `COC/node/src/peer-scoring.ts` (UPDATED - exponential ban, banCount)
- `COC/node/src/websocket-rpc.ts` (UPDATED - idle timeout)
- `COC/node/src/validator-governance.ts` (UPDATED - remove self-vote)
- `COC/node/src/rate-limiter.ts` (NEW - shared rate limiter)
- `COC/node/src/security-hardening.test.ts` (NEW - 34 security tests)
- `COC/contracts/settlement/PoSeManager.sol` (UPDATED - v-value check)

Documentation:
- `COC/docs/phase-24-plan.en.md`
- `COC/docs/phase-24-plan.zh.md`

## 18) Phase 26: Four Limitations Resolution
**Status: Implemented (2026-02-15)**

### 26.1 EVM State Persistence
- `PersistentStateManager` adapts `IStateTrie` to EthereumJS `StateManagerInterface`
- EVM state (accounts, storage, code) persists across node restarts
- `PersistentChainEngine` skips block replay when valid state root exists
- Snapshot restore via `setStateRoot()`

### 26.2 P2P Enhancement
- `PeerStore` saves/loads peers to `peers.json` with auto-save (5 min interval)
- `DnsSeedResolver` resolves TXT records (`coc-peer:<id>:<url>` format)
- Peer expiration filtering (configurable TTL, default 7 days)
- Failure tracking with auto-removal after threshold (10 failures)

### 26.3 Consensus Enhancement
- `ValidatorGovernance` connected to `PersistentChainEngine`
- Stake-weighted proposer selection (cumulative threshold algorithm)
- `signature` and `stateRoot` fields added to `ChainBlock`
- Governance RPC: `coc_getValidators`, `coc_submitProposal`, `coc_voteProposal`

### 26.4 IPFS Enhancement
- MFS (Mutable File System): mkdir/write/read/ls/rm/mv/cp/stat/flush
- Pubsub: topic-based messaging with deduplication, P2P forwarding, max topics/message size limits
- HTTP routes: `/api/v0/files/*` (MFS), `/api/v0/pubsub/*` (Pubsub with ndjson streaming)

Code:
- `COC/node/src/storage/persistent-state-manager.ts` (NEW)
- `COC/node/src/peer-store.ts` (NEW)
- `COC/node/src/dns-seeds.ts` (NEW)
- `COC/node/src/ipfs-mfs.ts` (NEW)
- `COC/node/src/ipfs-pubsub.ts` (NEW)
- `COC/node/src/evm.ts` (UPDATED)
- `COC/node/src/chain-engine-persistent.ts` (UPDATED)
- `COC/node/src/blockchain-types.ts` (UPDATED)
- `COC/node/src/peer-discovery.ts` (UPDATED)
- `COC/node/src/p2p.ts` (UPDATED)
- `COC/node/src/ipfs-http.ts` (UPDATED)
- `COC/node/src/rpc.ts` (UPDATED)
- `COC/node/src/config.ts` (UPDATED)
- `COC/node/src/index.ts` (UPDATED)
- `COC/node/src/storage/state-trie.ts` (UPDATED)
- `COC/node/src/storage/snapshot-manager.ts` (UPDATED)

Tests (49 new tests):
- `COC/node/src/storage/persistent-state-manager.test.ts` (10 tests)
- `COC/node/src/peer-store.test.ts` (9 tests)
- `COC/node/src/dns-seeds.test.ts` (5 tests)
- `COC/node/src/ipfs-mfs.test.ts` (13 tests)
- `COC/node/src/ipfs-pubsub.test.ts` (12 tests)

## 19) Phase 27: Production Hardening & Test Coverage
**Status: Implemented (2026-02-15)**

### 27.1 RPC & Input Validation
- RPC parameter validation with `requireHexParam`/`optionalHexParam` helpers
- Structured JSON-RPC error responses (codes -32602 invalid params, -32603 internal error)
- PoSe HTTP endpoint field validation (challengeId, epochId, nodeId, nodeSig)
- BigInt conversion for epoch and timestamp fields in PoSe routes
- Config validation function with comprehensive field checks

### 27.2 Consensus & Reliability
- Fixed consensus recovery state transitions (degraded → recovering → healthy)
- Isolated block production from P2P broadcast failures (block applied regardless of broadcast)
- Replaced 3 silent catch blocks in PersistentChainEngine with structured diagnostic logging
- Replaced `console.warn` with structured logging in snapshot-manager

### 27.3 Type Safety & Code Quality
- Eliminated `as any` casts from evm.ts, pruner.ts, index.ts, chain-engine-persistent.ts, health.ts
- Added `EvmLog` type definition for typed receipt log handling
- Used `Parameters<typeof fn>[0]` pattern for external API type compatibility
- Imported `BatchOp`, `PubsubMessage` types for proper typing

### 27.4 IPFS & Merkle Robustness
- Merkle path index bounds validation (throws on out-of-bounds index)
- Snapshot JSON import validation (rejects malformed/missing-field JSON)

### 27.5 Explorer Enhancement
- Contract registry index with `coc_getContractsByPage` RPC method
- Contract call history component
- Address tx history with operation type classification
- Contract deployment metadata display
- Real stateRoot in block headers after EVM execution
- Internal transactions trace display
- Validators page with governance stake and voting power
- coc_chainStats RPC method and enhanced stats page
- Mempool page sorting/filtering with pending/queued tabs
- Error boundaries and loading states
- Homepage optimization using coc_chainStats (reduced block fetches)
- WebSocket exponential backoff with jitter
- Reconnecting state indicator (live/reconnecting/offline)
- Explorer RPC error handling (HTTP status checks, network error catch)
- SearchBar tx/block hash disambiguation
- WebSocket subscription cleanup on component unmount

### 27.6 Test Coverage (12 new test files, ~90 new tests)
- `chain-events.test.ts` - ChainEventEmitter typed events
- `base-fee.test.ts` - EIP-1559 base fee calculator
- `peer-discovery.test.ts` (8 tests) - bootstrap, banning, peer exchange
- `pose-engine.test.ts` (5 tests) - challenge issuance, quota, receipt verification
- `config.test.ts` (13 tests) - config validation
- `ipfs-blockstore.test.ts` (10 tests) - blockstore CRUD, pinning
- `storage.test.ts` (7 tests) - ChainStorage integration
- `hash.test.ts` (12 tests) - hash functions and block validation
- `ipfs-unixfs.test.ts` (8 tests) - UnixFS builder, Merkle proofs
- `ipfs-merkle.test.ts` (16 tests) - Merkle tree, root, path, bounds
- `ipfs-http.test.ts` (11 tests) - IPFS HTTP API integration
- Health test fixes (mempool stats mock, timestampMs, boundary conditions)

Code:
- `COC/node/src/rpc.ts` (UPDATED - parameter validation)
- `COC/node/src/pose-http.ts` (UPDATED - field validation)
- `COC/node/src/config.ts` (UPDATED - validateConfig function)
- `COC/node/src/consensus.ts` (UPDATED - recovery logic, broadcast isolation)
- `COC/node/src/chain-engine-persistent.ts` (UPDATED - diagnostic logging)
- `COC/node/src/evm.ts` (UPDATED - type safety)
- `COC/node/src/storage/pruner.ts` (UPDATED - BatchOp type)
- `COC/node/src/storage/snapshot-manager.ts` (UPDATED - structured logging, JSON validation)
- `COC/node/src/ipfs-merkle.ts` (UPDATED - index bounds check)
- `COC/node/src/index.ts` (UPDATED - PubsubMessage type)
- `COC/explorer/src/` (multiple files updated)

## 20) Phase 28: Core Protocol Modules
**Status: Implemented (2026-02-15)**

### 28.1 BFT-lite Consensus
- `BftRound` state machine: propose → prepare → commit → finalized
- Stake-weighted quorum: `floor(2/3 * totalStake) + 1`
- `BftCoordinator` lifecycle management with timeout handling
- `coc_getBftStatus` RPC endpoint for round inspection

### 28.2 Binary Wire Protocol
- Frame format: `[Magic 0xC0C1] [Type 1B] [Length 4B BE] [Payload NB]`
- Max payload: 16 MiB
- `FrameDecoder` streaming accumulator for TCP partial reads
- Message types: Handshake, Block, Transaction, BFT, Ping/Pong

### 28.3 Kademlia DHT
- 256-bit node IDs with XOR distance metric
- 256 K-buckets (K=20) with LRU eviction
- `findClosest(target, K)` nearest-peer lookup

### 28.4 Fork Choice
- GHOST-inspired deterministic selection: BFT finality > chain length > cumulative weight > hash
- `shouldSwitchFork()` for sync chain adoption

### 28.5 EVM State Snapshot
- `exportStateSnapshot()` / `importStateSnapshot()` for accounts, storage, code
- `validateSnapshot()` with structural verification
- BigInt-safe serialization for cross-node transfer

### 28.6 IPFS Tar Archive
- POSIX USTAR tar format for `/api/v0/get` endpoint
- Proper header checksums, 512-byte block alignment, EOF markers

### 28.7 P2P BFT Integration
- `/p2p/bft-message` POST endpoint for consensus message routing
- `broadcastBft()` with per-peer deduplication
- `BftMessagePayload` type (prepare/commit votes)

Code:
- `COC/node/src/bft.ts` (NEW)
- `COC/node/src/bft-coordinator.ts` (NEW)
- `COC/node/src/wire-protocol.ts` (NEW)
- `COC/node/src/dht.ts` (NEW)
- `COC/node/src/fork-choice.ts` (NEW)
- `COC/node/src/state-snapshot.ts` (NEW)
- `COC/node/src/ipfs-tar.ts` (NEW)
- `COC/node/src/p2p.ts` (UPDATED - BFT routing)
- `COC/node/src/rpc.ts` (UPDATED - BFT status)
- `COC/node/src/ipfs-http.ts` (UPDATED - tar archive)

Tests (114 new tests across 7 files):
- `COC/node/src/bft.test.ts` (20 tests)
- `COC/node/src/wire-protocol.test.ts` (18 tests)
- `COC/node/src/dht.test.ts` (22 tests)
- `COC/node/src/fork-choice.test.ts` (14 tests)
- `COC/node/src/bft-coordinator.test.ts` (7 tests)
- `COC/node/src/state-snapshot.test.ts` (13 tests)
- `COC/node/src/ipfs-tar.test.ts` (13 tests)
- `COC/node/src/debug-trace.test.ts` (7 tests, updated)

## 22) Phase 29: Protocol Integration
**Status: Implemented (2026-02-15)**

### 29.1 Consensus Engine Integration
- BFT coordinator wired into `tryPropose()`: starts BFT round instead of direct broadcast when `enableBft=true`
- BFT fallback to direct broadcast on round failure
- Fork choice rule (`shouldSwitchFork()`) integrated into `trySync()` for deterministic chain adoption
- Snap sync provider interface (`SnapSyncProvider`) for state snapshot fetching from peers

### 29.2 TCP Transport Layer
- `WireServer`: TCP server accepting inbound connections, handshake with chain ID validation, frame dispatch for Block/Transaction/BFT messages, connected peer tracking, broadcast to all peers
- `WireClient`: outbound TCP with exponential backoff reconnect (1s → 30s cap), handshake negotiation, typed JSON send, automatic reconnection on disconnect

### 29.3 DHT Network Layer
- `DhtNetwork`: wraps `RoutingTable` with network operations
- Bootstrap from seed peers (add to routing table + self-lookup)
- Iterative FIND_NODE lookup with alpha=3 parallelism
- Periodic bucket refresh every 5 minutes (random target lookup)
- Peer discovery callback integration

### 29.4 Node Startup Integration
- BFT coordinator initialization when `enableBft=true` and validators >= 3
- Wire server/client setup when `enableWireProtocol=true`
- DHT network setup when `enableDht=true`
- State snapshot export/import handlers
- `onBftMessage` handler in P2P for consensus message routing
- `onStateSnapshotRequest` handler for snapshot serving

### 29.5 Configuration
- `enableBft` / `bftPrepareTimeoutMs` / `bftCommitTimeoutMs`: BFT consensus opt-in
- `enableWireProtocol` / `wirePort`: TCP transport opt-in
- `enableDht` / `dhtBootstrapPeers`: DHT peer discovery opt-in
- `enableSnapSync` / `snapSyncThreshold`: State snapshot sync opt-in
- `bftFinalized` field added to `ChainBlock` type

Code:
- `COC/node/src/consensus.ts` (UPDATED - BFT + fork choice + snap sync integration)
- `COC/node/src/index.ts` (UPDATED - full protocol integration)
- `COC/node/src/config.ts` (UPDATED - new config options)
- `COC/node/src/p2p.ts` (UPDATED - state snapshot endpoint)
- `COC/node/src/blockchain-types.ts` (UPDATED - bftFinalized field)
- `COC/node/src/wire-server.ts` (NEW)
- `COC/node/src/wire-client.ts` (NEW)
- `COC/node/src/dht-network.ts` (NEW)

Tests (4 new test files):
- `COC/node/src/consensus-bft.test.ts` - ConsensusEngine + BFT coordinator integration
- `COC/node/src/wire-server.test.ts` - TCP handshake, chain ID mismatch, frame dispatch
- `COC/node/src/dht-network.test.ts` - Bootstrap, iterative lookup, self-lookup
- `COC/node/src/snap-sync.test.ts` - State snapshot sync export/import

## 23) Phase 30: Protocol Hardening & Metrics
**Status: Implemented (2026-02-15)**

### 30.1 Wire Protocol FIND_NODE
- `FindNode` (0x40) and `FindNodeResponse` (0x41) message types added to wire protocol
- `WireClient.findNode()` async method with request/response correlation and timeout
- `WireServer` handles FIND_NODE requests and responds with closest peers from DHT routing table
- DHT iterative lookup now uses wire protocol FIND_NODE instead of local routing table fallback

### 30.2 BFT Equivocation Detection
- `EquivocationDetector` class tracks validator votes per height/phase
- Detects conflicting votes (different block hash for same height+phase) as slashing evidence
- `EquivocationEvidence` interface: validatorId, height, phase, blockHash1, blockHash2, detectedAtMs
- Integrated into `BftCoordinator` with `onEquivocation` callback
- Height-based pruning to limit memory (configurable `maxTrackedHeights`)

### 30.3 Wire Connection Manager
- `WireConnectionManager` class for outbound WireClient lifecycle management
- Max connection limits (default 25), peer add/remove, broadcast to all connected
- Connection state tracking, remote node ID lookup, stats reporting

### 30.4 Network Stats RPC
- `coc_getNetworkStats` RPC endpoint: returns P2P, wire, DHT, BFT, and consensus stats
- Fixed `bftCoordinator` parameter threading through `handleRpc`/`handleOne`/`handleRpcMethod`
- Added `equivocations` count to `coc_getBftStatus` response

### 30.5 Dual HTTP+TCP Block Propagation
- `wireBroadcast` callback in `ConsensusEngine` constructor opts
- `broadcastBlock()` sends via both HTTP gossip and wire protocol TCP
- Late binding pattern for wire broadcast function (bound after wire server setup)

### 30.6 DHT Node Announcement
- `announce()` method sends FIND_NODE for own ID to all connected wire clients
- Periodic announce timer (3-minute interval) alongside existing 5-minute refresh
- `localAddress` added to `DhtNetworkConfig` for self-identification

### 30.7 Consensus Metrics Tracking
- `ConsensusMetrics` interface: blocksProposed, blocksAdopted, proposeFailed, syncAttempts, syncAdoptions, snapSyncs, avgProposeMs, avgSyncMs, lastProposeMs, lastSyncMs, startedAtMs, uptimeMs
- `getMetrics()` method on ConsensusEngine with timing instrumentation in tryPropose/trySync

### 30.8 Wire Protocol Transaction Relay
- `wireTxRelayFn` bound to wire server for dual HTTP+TCP transaction propagation
- P2P `onTx` handler relays accepted transactions to wire-connected peers
- `onFindNode` handler wired from wire server to DHT routing table in index.ts

Code:
- `COC/node/src/wire-protocol.ts` (UPDATED - FindNode/FindNodeResponse)
- `COC/node/src/wire-server.ts` (UPDATED - FindNode handler, tx broadcast test)
- `COC/node/src/wire-client.ts` (UPDATED - findNode async method)
- `COC/node/src/dht-network.ts` (UPDATED - announce, localAddress)
- `COC/node/src/bft.ts` (UPDATED - EquivocationDetector)
- `COC/node/src/bft-coordinator.ts` (UPDATED - equivocation integration)
- `COC/node/src/consensus.ts` (UPDATED - metrics, wireBroadcast)
- `COC/node/src/rpc.ts` (UPDATED - coc_getNetworkStats, bftCoordinator fix)
- `COC/node/src/index.ts` (UPDATED - wireTxRelay, onFindNode, dual broadcast)
- `COC/node/src/wire-connection-manager.ts` (NEW)

Tests (28 new tests across 4 files):
- `COC/node/src/consensus-bft.test.ts` (5 new: dual broadcast, metrics tracking)
- `COC/node/src/wire-server.test.ts` (2 new: tx dispatch, broadcast)
- `COC/node/src/wire-connection-manager.test.ts` (9 new)
- `COC/node/src/wire-protocol.test.ts` (2 new: FindNode encode/decode)
- `COC/node/src/bft.test.ts` (8 new: equivocation detection)
- `COC/node/src/rpc-extended.test.ts` (2 new: network stats, BFT status)

## 25) Phase 33: Security Hardening
**Status: Implemented (2026-02-15)**

Comprehensive security audit addressing 15 vulnerabilities (5 CRITICAL, 5 HIGH, 5 MEDIUM):

### 33.1 Immediate Protections (Phase A)
- IPFS upload size limit (10MB default, `readBody()` maxSize parameter)
- MFS path traversal prevention (`..` / `.` component rejection in `normalizePath()`)
- Wire server per-IP connection limit (max 5 per IP via `connsByIp` map)
- Block timestamp validation (must be after parent, within 60s future drift)

### 33.2 Protocol Authentication (Phase B)
- Node identity authentication via `NodeSigner`/`SignatureVerifier` from `crypto/signer.ts`
- Wire handshake includes nonce + signature, verified against claimed nodeId
- `nodePrivateKey` auto-generated from `COC_NODE_KEY` env / `dataDir/node-key` file
- BFT message signature now mandatory (`BftMessage.signature: Hex`)
- BFT coordinator signs outgoing votes and verifies incoming prepare/commit messages

### 33.3 Network Robustness (Phase C)
- DHT peer verification: TCP connect probe (3s timeout) before routing table insertion
- Skip verification for peers already connected via wire client (optimization)
- State snapshot stateRoot verification after import
- Peer scoring exponential ban: `baseBanMs * 2^min(banCount-1, 10)`, max 24h
- No decay during ban period

### 33.4 Resource Management (Phase D)
- WebSocket idle timeout: 1h inactivity → close + cleanup
- Dev accounts gated behind `COC_DEV_ACCOUNTS=1` (no longer auto-enabled)
- Default wire/IPFS bind changed to `127.0.0.1`
- Shared `RateLimiter` class for RPC (200/min), IPFS (100/min), PoSe (60/min)
- Governance self-vote removed (proposer must explicitly vote)

### 33.5 Contract Layer (Phase E)
- PoSeManager `ecrecover` v-value validation (`require(v == 27 || v == 28)`)

### 33.6 P2P HTTP Auth Hardening (Phase E+)
- P2P write endpoints support signed auth envelope (`_auth`) with sender/timestamp/nonce/signature
- Signature verification binds to endpoint path + canonical payload hash
- Timestamp window validation (`p2pAuthMaxClockSkewMs`) and nonce replay guard (bounded cache)
- Inbound auth mode supports phased rollout: `off` / `monitor` / `enforce`
- Auth observability counters exposed in `/p2p/node-info` stats (`authAccepted`, `authMissing`, `authInvalid`, `authRejected`)

Code:
- `COC/node/src/rate-limiter.ts` (NEW)
- `COC/node/src/security-hardening.test.ts` (NEW - 34 tests)
- `COC/node/src/p2p.ts` (UPDATED - auth envelope + mode + counters)
- `COC/node/src/p2p-auth.test.ts` (NEW)
- Multiple files updated (see Production Hardening section for full list)

## 26) Phase 34: Public Testnet Go/No-Go Readiness
**Status: Conditional Go (2026-02-22)**

### 34.1 Security Closure Items
- Relay witness strict verification: 17 security tests covering forged witnesses, timestamp manipulation, replay protection, cross-node witness reuse
- BFT malicious-behavior penalty: `BftSlashingHandler` connecting EquivocationDetector → ValidatorGovernance (slash stake, deposit treasury, auto-remove)
- BFT slashing integration: 9 tests covering full equivocation → slash → penalty pipeline

### 34.2 Operations Infrastructure
- Prometheus alert rules: 12 rules across 4 groups (availability, security, performance, network)
- On-call runbook with triage flowchart, troubleshooting sections, escalation matrix
- Rollback runbook with 4 procedures (Docker rollback, binary rollback, snapshot recovery, genesis reset)
- Testnet configs with full security fields (`ops/testnet/node-config-{1,2,3}.json`)

### 34.3 ValidatorGovernance Slashing API
- `applySlash(validatorId, amount)`: Direct stake reduction for slashing penalties
- `deactivateValidator(validatorId)`: Immediate validator removal
- `getMinStake()`: Minimum stake threshold accessor

Code:
- `COC/services/verifier/relay-witness-security.test.ts` (NEW - 17 tests)
- `COC/node/src/bft-slashing.ts` (NEW)
- `COC/node/src/bft-slashing.integration.test.ts` (NEW - 9 tests)
- `COC/node/src/validator-governance.ts` (UPDATED - slashing API)
- `COC/ops/alerts/prometheus-rules.yml` (NEW)
- `COC/ops/runbooks/testnet-oncall.md` (NEW)
- `COC/ops/runbooks/testnet-rollback.md` (NEW)
- `COC/ops/testnet/node-config-{1,2,3}.json` (NEW)
- `COC/docker/testnet-configs/node-{1,2,3}.json` (UPDATED - security fields)

Documentation:
- `COC/docs/phase-34-plan.en.md`
- `COC/docs/phase-34-plan.zh.md`

## 28) Phase 35: Node Installation, Configuration & Type Selection
**Status: Implemented (2026-02-22)**

OpenClaw `coc-nodeops` extension expanded with node type presets, interactive setup wizard, and multi-node instance management.

### 35.1 Node Type System
- 5 node type presets: `validator`, `fullnode`, `archive`, `gateway`, `dev`
- Each preset defines config overrides (BFT, wire, DHT, snap sync, storage backend) and attached services
- Validator: BFT + wire + DHT + snap sync + leveldb + agent service
- Full node: wire + DHT + snap sync + leveldb, no block production
- Archive: same as fullnode with pruning disabled
- Gateway: memory backend, no protocols, lightweight RPC proxy
- Dev: single-node, test accounts prefunded, no protocols

### 35.2 Network Presets
- 4 network configurations: `testnet`, `mainnet`, `local`, `custom`
- Testnet: chainId 18780, public bootstrap peers
- Local: chainId 18780, localhost, auto ports
- Custom: user specifies all parameters interactively

### 35.3 Interactive Init Wizard
- `openclaw coc init` interactive wizard using `@clack/prompts`
- Step-by-step: node type → network → name → RPC port → (validator key / custom params)
- Also supports non-interactive: `openclaw coc init --type validator --network testnet --name val-1`
- Generates `node-config.json`, `node-key`, registers to `nodes.json`

### 35.4 Multi-Node Manager
- `NodeManager` class with persistent registry (`~/.clawdbot/coc/nodes.json`)
- Per-node data directories under `~/.clawdbot/coc/nodes/<name>/`
- Node lifecycle: start/stop/restart with per-service process management
- Status with live RPC queries (block height, peer count)
- Node removal with optional data deletion

### 35.5 CLI Commands
- `coc init` - Initialize new node (interactive or parametric)
- `coc list` - List all managed node instances
- `coc start [name]` - Start specific or all nodes
- `coc stop [name]` - Stop specific or all nodes
- `coc restart [name]` - Restart specific or all nodes
- `coc status [name]` - Status with RPC stats
- `coc remove <name>` - Remove node instance
- `coc config show [name]` - Display node configuration
- `coc config edit <name>` - Edit config in $EDITOR
- `coc logs <name>` - View node logs (with --follow)

Code:
- `COC/extensions/coc-nodeops/src/node-types.ts` (NEW)
- `COC/extensions/coc-nodeops/src/network-presets.ts` (NEW)
- `COC/extensions/coc-nodeops/src/cli/init-wizard.ts` (NEW)
- `COC/extensions/coc-nodeops/src/runtime/node-manager.ts` (NEW)
- `COC/extensions/coc-nodeops/src/cli/commands.ts` (UPDATED - all new subcommands)
- `COC/extensions/coc-nodeops/src/config-schema.ts` (UPDATED - nodes registry)
- `COC/extensions/coc-nodeops/index.ts` (UPDATED - NodeManager init)
- `COC/extensions/coc-nodeops/package.json` (UPDATED - @clack/prompts dep)

Tests (24 new tests across 3 files):
- `COC/extensions/coc-nodeops/src/node-types.test.ts` (7 tests)
- `COC/extensions/coc-nodeops/src/network-presets.test.ts` (7 tests)
- `COC/extensions/coc-nodeops/src/runtime/node-manager.test.ts` (10 tests)

## 29) Phase 36: Testnet Operational Hardening
**Status: Implemented**

Implemented:
- **SIGTERM graceful shutdown**: shared shutdown handler for both SIGINT and SIGTERM, properly stops consensus, wire, DHT, pubsub, and closes persistent storage
- **Configurable bind addresses**: COC_RPC_BIND, COC_P2P_BIND, COC_WS_BIND, COC_IPFS_BIND, COC_WIRE_BIND env vars; defaults to 0.0.0.0 (production) or 127.0.0.1 (dev mode via COC_DEV_MODE=1)
- **LevelDB corruption recovery**: auto-detects corruption on open, calls classic-level repair, re-opens database; `LevelDatabase.repair()` static method
- **RPC authentication**: optional Bearer token via COC_RPC_AUTH_TOKEN env var or config; rejects unauthorized requests with 401
- **Admin RPC namespace**: admin_nodeInfo, admin_addPeer, admin_removePeer, admin_peers; gated by enableAdminRpc config flag
- **PeerDiscovery.removePeer**: new method for admin peer management

Files:
- `node/src/index.ts` (UPDATED - SIGTERM handler, auth options pass-through)
- `node/src/config.ts` (UPDATED - bind env vars, rpcAuthToken, enableAdminRpc)
- `node/src/storage/db.ts` (UPDATED - corruption recovery, repair static method)
- `node/src/rpc.ts` (UPDATED - auth middleware, admin namespace)
- `node/src/peer-discovery.ts` (UPDATED - removePeer method)
- `node/src/phase36.test.ts` (NEW - 6 tests)

## 27) Whitepaper Gap Summary
- Consensus: validator governance with stake-weighted proposer selection (Phase 22 + 26), BFT-lite round state machine with coordinator (Phase 28), GHOST fork choice (Phase 28), BFT integrated into ConsensusEngine main loop (Phase 29, opt-in), equivocation detection for double-vote slashing (Phase 30), consensus metrics tracking (Phase 30), BFT message signature verification (Phase 33).
- P2P: peer scoring (Phase 16), peer persistence and DNS seed discovery (Phase 26), binary wire protocol and Kademlia DHT (Phase 28), TCP server/client transport and DHT network layer (Phase 29, opt-in), wire FIND_NODE message for DHT queries (Phase 30), dual HTTP+TCP block and tx propagation (Phase 30), DHT node announcement (Phase 30), wire connection manager (Phase 30), wire Block/Tx dedup via BoundedSet (Phase 32), cross-protocol relay Wire→HTTP (Phase 32), BFT dual transport HTTP+TCP (Phase 32), DHT wireClientByPeerId O(1) lookup (Phase 32), per-peer wire port from config (Phase 32), node identity authentication in wire handshake (Phase 33), per-IP connection limit (Phase 33), DHT peer verification (Phase 33), exponential peer ban (Phase 33), signed HTTP gossip auth envelope with phased enforcement (Phase 33). HTTP gossip remains primary.
- EVM: state persistence connected (Phase 26), real stateRoot in block headers (Phase 27), state snapshot export/import (Phase 28), snap sync provider in consensus (Phase 29), state snapshot stateRoot verification (Phase 33).
- RPC: 57+ methods with parameter validation and structured error codes (Phase 27), BFT status endpoint (Phase 28), coc_getNetworkStats endpoint (Phase 30), dev accounts gated (Phase 33).
- PoSe: dispute automation partially addressed (Phase 19), HTTP input validation (Phase 27), rate limiting (Phase 33), PoSeManager v-value check (Phase 33).
- IPFS: MFS and Pubsub (Phase 26), tar archive for `get` (Phase 28), Merkle path bounds validation (Phase 27), upload size limit (Phase 33), path traversal protection (Phase 33), rate limiting (Phase 33).
- Security: node identity via crypto signing (Phase 33), BFT signature verification (Phase 33), DHT anti-poisoning (Phase 33), exponential peer banning (Phase 33), WebSocket idle timeout (Phase 33), default localhost binding (Phase 33), P2P signed request verification with monitor/enforce rollout (Phase 33), GET auth wiring for snap sync and peer discovery (manual audit), trySync/tryPropose reentrant lock (manual audit), PeerDiscovery IP diversity anti-Sybil (manual audit), BFT↔governance runtime sync (manual audit), chain-snapshot auth + rate limit (manual audit).
- Explorer: contract registry, call history, tx type classification, internal traces, governance display (Phase 27).
- Devnet: multi-node devnet enables all advanced features by default (BFT, Wire, DHT, SnapSync) with per-node wire port and DHT bootstrap peers (Phase 32).
- BFT Slashing: equivocation detection → stake slash → treasury deposit → auto-remove below threshold (Phase 34).
- Relay Witness: strict verification with forged witness rejection, timestamp validation, replay protection (Phase 34).
- Operations: Prometheus alerts (12 rules), on-call runbook, rollback runbook, testnet security configs (Phase 34).
- Node Ops: OpenClaw coc-nodeops extension with 5 node type presets, network presets, interactive init wizard, multi-node instance management, full CLI (Phase 35).
- Ops Hardening: SIGTERM/SIGINT dual shutdown, configurable bind addresses, LevelDB corruption recovery, RPC Bearer auth, admin RPC namespace (Phase 36).
- Testing: 909 tests across 91 files covering all major modules including security hardening (Phase 33), Go/No-Go readiness (Phase 34), node ops extension (Phase 35), ops hardening (Phase 36), and algorithm safety audit rounds 1-27.
- Algorithm Safety Audit (Rounds 1-17): BFT commit blockHash binding, snap sync target validation, full state snapshot trie traversal (iterateAccounts/iterateStorage), EIP-1559 baseFee per-block integration, persistent engine timestamp validation, DHT iterative lookup distance sorting, K-bucket ping-evict replacement, configurable signature enforcement (off/monitor/enforce), handshake canonical format alignment, fetchSnapshots discovery dedup, gas histogram O(n), finality O(1) lookup.
- Algorithm Safety Audit (Rounds 18-27): block normalization field preservation (gasUsed/stateRoot/signature/bftFinalized), state trie evictLru infinite loop guard (dirty entry skip + maxAttempts), P2P aborted chunk guard, MFS mv/cp circular recursion prevention, FrameDecoder exponential buffer growth O(n) amortized, peer-store defensive JSON validation, wire handshake nonce NaN fail-closed, BFT pending buffer height gap cap (≤10), snapshot validateSnapshot account/storage/code size limits (DoS prevention), FindNode response peer object validation, SnapSync fail-closed single-peer trust, validators hash cross-peer consensus, fetchStateSnapshot 30s timeout + 16MiB limit + cache, state-snapshot independent rate limiter, state snapshot export TTL cache.
- Manual Security Audit: GET auth wiring (fetchStateSnapshot + fetchPeerList attach x-p2p-auth signed header), trySync/tryPropose reentrant lock (syncInFlight/proposeInFlight guards), PeerDiscovery IP diversity quota (MAX_PEERS_PER_IP=3 anti-Sybil), BFT coordinator↔governance runtime sync (updateValidators on finalize + restoreGovernance), chain-snapshot endpoint auth + rate limit.
