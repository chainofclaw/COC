# COC (ChainOfClaw)

COC is an EVM-compatible blockchain prototype with PoSe (Proof-of-Service) settlement and an IPFS-compatible storage interface.

## Structure

- `docs/`: whitepaper and technical documentation
- `specs/`: protocol/economics/roadmap specifications
- `contracts/`: PoSe settlement contracts
- `services/`: off-chain challenger/verifier/aggregator/relayer
- `runtime/`: coc-node / coc-agent / coc-relayer
- `node/`: chain engine + RPC + P2P + storage
- `wallet/`: minimal CLI wallet
- `tests/`: integration and e2e tests
- `scripts/`: devnet and verification scripts
- `explorer/`: blockchain explorer frontend (Next.js, port 3000)
- `website/`: project website (Next.js, port 3001)
- `nodeops/`: node operations and policy engine

## Current Progress

- **Chain Engine**: block production, mempool (EIP-1559, replacement, eviction), snapshots, deterministic proposer rotation, basic finality
- **P2P Networking**: HTTP-based gossip for tx/blocks, snapshot sync between peers
- **EVM Execution**: in-memory + persistent state via `@ethereumjs/vm` and LevelDB-backed trie
- **JSON-RPC**: 57+ standard Ethereum methods + custom `coc_*` / `txpool_*` methods, BigInt-safe serialization, parameter validation with structured error codes
- **WebSocket RPC**: `eth_subscribe` / `eth_unsubscribe` for newHeads, newPendingTransactions, logs
- **PoSe Protocol**:
  - Off-chain: challenge factory, receipt verification, batch aggregation, epoch scoring
  - On-chain: PoSeManager contract with registration, batch submission, challenge, finalize, slash
- **Storage Layer**: IPFS-compatible HTTP APIs (add/cat/get/block/pin/ls/stat/id/version) + `/ipfs/<cid>` gateway + tar archive for `get`
- **Runtime Services**:
  - `coc-node`: PoSe challenge/receipt HTTP endpoints
  - `coc-agent`: challenge generation, batch submission, node registration
  - `coc-relayer`: epoch finalization and slash automation
- **Node Operations**: YAML-based policy engine with agent lifecycle hooks
- **Tooling**:
  - CLI wallet (create address, transfer, query balance)
  - Devnet scripts for 3/5/7 node networks
  - Quality gate script (unit + integration + e2e tests)
- **Blockchain Explorer**: Full-featured Next.js app (see below)
- **BFT Consensus**: BFT-lite three-phase commit (propose/prepare/commit) with stake-weighted quorum, coordinator lifecycle management
- **Fork Choice**: GHOST-inspired deterministic fork selection (BFT finality > chain length > cumulative weight > hash tiebreaker)
- **DHT Routing**: Kademlia DHT with XOR distance metric, 256 K-buckets (K=20), findClosest lookup
- **Wire Protocol**: Binary framed protocol (Magic 0xC0C1, type byte, 4B length, payload) with streaming FrameDecoder
- **State Snapshot**: EVM state export/import for fast sync (accounts, storage, code)
- **TCP Transport**: Wire server (inbound TCP, handshake, frame dispatch) and wire client (outbound TCP, exponential backoff reconnect 1s-30s)
- **DHT Network**: DHT network layer with bootstrap, iterative FIND_NODE lookup (alpha=3 parallelism), periodic refresh (5 min)
- **Protocol Integration**: BFT coordinator + fork choice integrated into ConsensusEngine, snap sync provider, all features opt-in via config flags
- **Equivocation Detection**: Double-vote tracking with slashing evidence generation
- **Consensus Metrics**: Block production and sync performance tracking (propose/sync times, success rates, uptime)
- **Dual Transport**: Parallel HTTP gossip + TCP wire protocol for block and transaction propagation
- **Wire FIND_NODE**: DHT peer discovery via wire protocol request/response messages
- **Network Stats RPC**: `coc_getNetworkStats` endpoint aggregating P2P, wire, DHT, BFT stats
- **Testing**: 695 tests across 78 test files, covering chain engine, EVM, mempool, RPC, WebSocket, P2P, storage, IPFS, PoSe, BFT, DHT, wire protocol, fork choice, snap sync, equivocation detection, consensus metrics, and wire connection management

### Blockchain Explorer Features

The explorer (`explorer/`) is a Next.js 15 App Router application providing:

- **Homepage**: chain stats dashboard (block height, avg block time, gas price, peer count, chain ID, sync status), latest blocks table, real-time block and pending tx streams via WebSocket
- **Block Detail** (`/block/[id]`): full transaction table with method decoding, from/to, value, status, gas used; token transfers aggregated from receipts; prev/next block navigation; gas utilization percentage
- **Transaction Detail** (`/tx/[hash]`): decoded method name, token transfers (ERC-20 Transfer/Approval), event logs, status badge
- **Address Detail** (`/address/[address]`): balance, nonce, transaction history with filter tabs (All/Sent/Received/Contract/Token), contract detection
- **Contract View**: bytecode display with EVM opcode disassembler (PUSH/DUP/SWAP + all standard opcodes), eth_call interface with quick-call presets (name/symbol/decimals/totalSupply/owner/paused), ABI string decoder, storage scanner with multi-slot range scan and value interpretation (uint256/address)
- **Mempool** (`/mempool`): pool stats, live pending tx stream, pending transactions table with method/from/to/value/gas
- **Network** (`/network`): node runtime info, uptime, mempool stats, connection endpoints
- **Search**: supports address, tx hash, block number, hex block number
- **404 Page**: user-friendly not-found page

### Recent Development (Cycles 1–10)

| Cycle | Commit | Summary |
|-------|--------|---------|
| 1 | `226018d` | Fix PersistentStateTrie RLP decode — `@ethereumjs/trie` v6 passes hex strings, not Uint8Array |
| 2 | `69bd222` | Add 13 missing standard Ethereum RPC methods (eth_getBlockTransactionCount*, eth_getTransactionByBlock*, eth_feeHistory, eth_maxPriorityFeePerGas, filter methods) |
| 3 | `7cc9543` | Token transfer decoding (ERC-20 Transfer/Approval events) and method signature display in explorer |
| 4 | `e8e71e4` | Chain statistics dashboard on explorer homepage with 8 stat cards |
| 5 | `df50eb3` | Contract call interface (eth_call UI with presets) and WebSocket BigInt serialization fix |
| 6 | `c613d08` | eth_getBlockReceipts RPC method + enhanced block detail page with full tx table |
| 7 | `114b650` | txpool_status/txpool_content RPC methods + mempool explorer page |
| 8 | `684dffa` | Network status page (coc_nodeInfo RPC) + global 404 page |
| 9 | `8fbbbc7` | EVM bytecode disassembler + storage scanner with range scan and value interpretation |
| 10 | `6339490` | Test coverage enhancement: 175 → 190 tests covering all new RPC methods and mempool APIs |

### Hardening & Explorer Expansion (Cycles 11–20)

| Cycle | Commit | Summary |
|-------|--------|---------|
| 11 | `82a33a4` | Fix TxHistory table structure and add gas column |
| 12 | `2166fd2` | Fix formatBlock O(n*m) complexity, use actual gasUsed from receipts |
| 13 | `ab40184` | Add request body limits (2MB P2P, 1MB RPC) and P2P broadcast concurrency control |
| 14 | `cc66d03` | EIP-1559 effective gas price sorting in mempool |
| 15 | `a73c4cf` | Add eth_mining/eth_hashrate/eth_coinbase RPC methods, improve WebSocket resilience |
| 16 | `15eba37` | WebSocket subscription validation (address/topic format, per-client limits) |
| 17 | `52f5f41` | Consensus error recovery with degraded mode and auto-recovery |
| 18 | `9573e07` | Repair health checker (getHeight() fix), add memory/WS/storage diagnostics |
| 19 | `1c42906` | P2P per-peer broadcast deduplication with BoundedSet and stats |
| 20 | `278b7d9` | Validators explorer page + coc_validators RPC method |

### Features & EIP-1559 (Cycles 21–25)

| Cycle | Commit | Summary |
|-------|--------|---------|
| 21 | `3e636c8` | Chain statistics explorer page (block activity, TPS, gas usage visualization) |
| 22 | `98cd0ae` | Pagination support for address transaction queries (offset parameter) |
| 23 | `222ac8c` | EIP-1559 dynamic base fee calculation (50% target, 12.5% max change, 1 gwei floor) |
| 24 | `92eb984` | Debug trace improvement with log-derived events and tx input data |
| 25 | `cce7281` | Contracts listing page scanning recent blocks for deployments |

### Production Hardening & Test Coverage (Cycles 26–35)

| Cycle | Commit | Summary |
|-------|--------|---------|
| 26 | `a8f70eb` | Contract registry index with `coc_getContractsByPage` RPC + contract call history component |
| 27 | `dc3796f` | Address tx history with operation type classification (transfer/contract_call/token_transfer) |
| 28 | `d09409d` | Populate real stateRoot in block headers + internal transactions trace display |
| 29 | `c64c2d6` | Enhanced validators page with governance stake/voting + coc_chainStats RPC |
| 30 | `f429d4c` | Error boundaries, loading state, mempool sorting/filtering, WebSocket reconnecting indicator |
| 31 | `edff796` | Homepage optimization + exponential backoff + as-any elimination + 6 new test suites |
| 32 | `5ef183f` | Config validation + consensus recovery fix + PoSe engine tests + peer discovery tests |
| 33 | `b73cd00` | RPC parameter validation + structured error responses + hash/storage/blockstore tests |
| 34 | `3f15127` | Consensus broadcast isolation + silent catch logging + PoSe HTTP validation |
| 35 | `aab48a9` | Merkle path bounds check + snapshot-manager logging + IPFS HTTP/UnixFS/Merkle tests |

### Core Protocol & BFT (Cycles 36–45)

| Cycle | Commit | Summary |
|-------|--------|---------|
| 36 | `ad2ba99` | IPFS tar archive for `/api/v0/get` endpoint (POSIX USTAR format) |
| 37 | `d1b2cd7` | BFT-lite consensus round state machine (three-phase commit, stake-weighted quorum) |
| 38 | `ed0fd73` | Binary wire protocol with frame encoding/decoding and streaming FrameDecoder |
| 39 | `8c2024f` | Kademlia DHT routing table with XOR distance, 256 K-buckets (K=20) |
| 40 | `53eecd6` | GHOST-inspired fork choice rule (BFT finality > length > weight > hash) |
| 41 | `770e857` | BFT coordinator bridging consensus engine and P2P layer |
| 42 | `879d584` | EVM state snapshot export/import for fast sync |
| 43 | `4775b4b` | P2P BFT message routing (`/p2p/bft-message` endpoint + `broadcastBft`) |
| 44 | `333e2c2` | `coc_getBftStatus` RPC endpoint + debug-trace OpenEthereum format fix |
| 45 | `583b541` | Full test suite verification (640 tests) + core algorithms documentation |
| 46 | `6aa68ef` | Update all documentation for Phase 14-25 development progress |

### Protocol Integration (Cycles 47–56)

| Cycle | Commit | Summary |
|-------|--------|---------|
| 47 | `59c5cee` | Wire server/client TCP transport, DHT network layer, BFT/fork-choice/snap-sync consensus integration, 4 new test files |
| 48 | `3374448` | FIND_NODE wire protocol message (0x40/0x41) for DHT peer discovery via TCP |
| 49 | `d0a645a` | BFT equivocation detection — double-vote tracking with slashing evidence |
| 50 | `f0610f1` | Wire connection manager for outbound peer lifecycle (max connections, broadcast) |
| 51 | `ddfae69` | `coc_getNetworkStats` RPC endpoint + fix bftCoordinator parameter threading |
| 52 | `d7c8aab` | Dual HTTP+TCP block propagation in consensus engine |
| 53 | `b24ecc4` | DHT periodic node announcement to connected peers (3-min interval) |
| 54 | `c847e8b` | Consensus engine performance metrics tracking (propose/sync times, uptime) |
| 55 | `9bc400a` | Wire protocol transaction relay + FindNode server handler wiring |
| 56 | `be1c2ed` | Full test verification (695 tests) + documentation update |

## Quick Start

### Run a local node

```bash
cd node
npm install
npm start
```

### Deploy PoSe contracts

```bash
cd contracts
npm install
npm run compile
npm run deploy:local
```

### Run devnet

```bash
bash scripts/devnet-3.sh  # 3-node network
bash scripts/devnet-5.sh  # 5-node network
bash scripts/devnet-7.sh  # 7-node network
```

### Start explorer

```bash
cd explorer
npm install
npm run dev
# Open http://localhost:3000
```

### Start website

```bash
cd website
npm install
npm run dev
# Open http://localhost:3001
```

## Quality Gate

```bash
bash scripts/quality-gate.sh
```

## Docs

- Implementation status: `docs/implementation-status.md`
- Feature matrix: `docs/feature-matrix.md`
- System architecture: `docs/system-architecture.en.md`
- Core algorithms: `docs/core-algorithms.en.md`

## License

MIT License - See LICENSE file for details

