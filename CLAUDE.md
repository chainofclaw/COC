# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

COC (ChainOfClaw) is an EVM-compatible blockchain prototype integrating a PoSe (Proof-of-Service) settlement mechanism and an IPFS-compatible storage interface.

## Workspace Structure

The project uses npm workspaces to manage multiple packages:

- `node/`: Blockchain core engine (ChainEngine, EVM, P2P, RPC, IPFS)
- `contracts/`: Solidity smart contracts (PoSeManager settlement contract)
- `services/`: PoSe off-chain services (challenger, verifier, aggregator, relayer)
- `runtime/`: Runtime executables (coc-node, coc-agent, coc-relayer)
- `nodeops/`: Node operations and policy engine
- `wallet/`: CLI wallet tool
- `tests/`: Integration and end-to-end tests
- `explorer/`: Next.js blockchain explorer
- `extensions/coc-backup/`: Soul identity backup and recovery (OpenClaw plugin)
- `website/`: Project website

## Runtime Requirements

- **Node.js 22+** (uses `--experimental-strip-types` to run TypeScript directly)
- npm for package management and workspaces

## Core Development Commands

### Run Local Node
```bash
cd node
npm install
npm start  # uses node --experimental-strip-types
```

### Smart Contract Development
```bash
cd contracts
npm install
npm run compile          # Compile contracts
npm test                 # Hardhat tests
npm run coverage         # Coverage check
npm run coverage:check   # Verify coverage thresholds
npm run deploy:local     # Deploy to local network
npm run deploy:governance:coc   # Deploy governance contracts to the default COC network alias
# Contract verification is exposed through explorer /verify,
# not a Hardhat verify:pose script
```

### Run Devnet
```bash
bash scripts/start-devnet.sh 3  # 3-node network
bash scripts/start-devnet.sh 5  # 5-node network
bash scripts/start-devnet.sh 7  # 7-node network
bash scripts/stop-devnet.sh     # Stop devnet
bash scripts/verify-devnet.sh   # Verify devnet status
```

### Blockchain Explorer
```bash
cd explorer
npm install
npm run dev    # Development mode http://localhost:3000
npm run build  # Production build
npm start      # Production mode
```

### Quality Gate
```bash
bash scripts/quality-gate.sh  # Run repository-wide quality gate (node/runtime/services/tests/extensions/wallet/explorer/faucet/contracts)
```

### Node Operations Policies
Policy files are located at `nodeops/policies/*.yaml` and can be loaded and evaluated by the policy engine.

## Test Strategy

Uses Node.js built-in test framework and Hardhat test runner (`1635` tests across `151` test files, excluding vendored `node_modules` tests):
- **Node layer tests**: `node/src/*.test.ts node/src/**/*.test.ts` (`899` tests, `75` files) - chain engine, EVM, RPC, WebSocket, P2P, mempool, storage, IPFS, PoSe, BFT consensus, DHT, wire protocol, fork choice, state snapshot, wire server, DHT network, snap sync, consensus-BFT integration, consensus metrics, wire connection manager, wire tx relay, sync progress, gas histogram, governance stats, wire dedup/relay, security hardening, P2P auth, wire auth handshake, replay guard, nonce registry, PoSe auth, Prometheus metrics, BFT slashing, Phase 36 ops hardening, algorithm safety audit round 3, P2P benchmarks, wire priority frames, stateRoot verification, speculative execution, coc_getEquivocations, ethers toolchain compatibility, viem toolchain compatibility, fee oracle, RPC data accuracy, block format standardization
- **Services + NodeOps tests**: `services/**/*.test.ts` + `nodeops/*.test.ts` (`164` tests, `25` files) - PoSe v2 services, reward tree, scoring determinism, challenger rewards, policy DSL, policy hot reload
- **Runtime tests**: `runtime/lib/*.test.ts` + `runtime/coc-relayer.test.ts` (`72` tests, `16` files) - pending retention, runtime metrics, agent metrics server, reward manifest, pose-v2 fault proof, relayer dispute recovery, BFT slash bridge
- **Tests workspace**: `tests/**/*.test.ts` (`178` tests, `14` files) - integration, e2e, stress, chaos, governance scripts, infra validation, v1 reward scoring, contract lifecycle
- **Wallet tests**: `wallet/coc-wallet.test.ts` (`8` tests, `1` file) - wallet CLI, keystore, import/export, formatting
- **Explorer tests**: `explorer/src/lib/*.test.ts` (`43` tests, `3` files) - ABI decoding, provider helpers, Solidity compiler version resolution
- **Faucet tests**: `faucet/src/*.test.ts` (`26` tests, `3` files) - drip flow, web UI, server wiring, cooldown logic
- **Contract deploy tests**: `contracts/deploy/*.test.ts` (`18` tests, `2` files) - deploy config resolution, CLI wrapper, PoSe deploy helper validation
- **Contract tests**: `cd contracts && npm test` (`203` tests, `9` files) - PoSeManager v1, PoSeManagerV2, v2 E2E lifecycle, gas benchmarks, security audit, EIP-712 cross-check, SoulRegistry (identity, backup, recovery, guardians)
- **Extension tests**: `extensions/coc-nodeops/src/**/*.test.ts` (`24` tests, `3` files) - node types, network presets, node manager
- **Storage layer tests**: `node/src/storage/*.test.ts` (included in node layer)

Running tests:
```bash
# Node layer tests
cd /path/to/COC && node --experimental-strip-types --test $(find node/src -name '*.test.ts' -type f | sort)

# Runtime tests
cd /path/to/COC && node --experimental-strip-types --test $(find runtime/lib -name '*.test.ts' -type f | sort) runtime/coc-relayer.test.ts

# Service + ops tests
cd /path/to/COC && node --experimental-strip-types --test services/**/*.test.ts nodeops/*.test.ts

# Tests workspace
cd /path/to/COC && node --experimental-strip-types --test tests/**/*.test.ts

# Wallet tests
cd /path/to/COC && node --experimental-strip-types --test wallet/coc-wallet.test.ts

# Explorer tests
cd /path/to/COC && node --experimental-default-type=module --experimental-strip-types --test explorer/src/lib/*.test.ts

# Faucet tests
cd /path/to/COC && node --experimental-strip-types --test faucet/src/*.test.ts

# Extension tests
cd extensions/coc-nodeops && node --experimental-strip-types --test src/node-types.test.ts src/network-presets.test.ts src/runtime/node-manager.test.ts

# Contract deploy config tests
cd /path/to/COC && node --experimental-default-type=module --experimental-strip-types --test contracts/deploy/*.test.ts

# Contract tests
cd contracts && npm test
```

## Core Architecture

### Node Core Components (node/src/)
- `chain-engine.ts`: Blockchain engine, manages block production, persistence, and finality
- `evm.ts`: EVM execution layer (based on @ethereumjs/vm)
- `consensus.ts`: Consensus engine (deterministic rotation + degraded mode + auto-recovery + optional BFT coordinator + snap sync provider)
- `p2p.ts`: HTTP gossip network (per-peer dedup, request body limits, broadcast concurrency control)
- `rpc.ts`: JSON-RPC interface (83+ methods, parameter validation, structured error codes)
- `websocket-rpc.ts`: WebSocket RPC (eth_subscribe, subscription validation and limits, idle timeout)
- `config.ts`: Node configuration with validation (chainId, ports, validators, storage, enableBft, enableWireProtocol, enableDht, enableSnapSync, rpcAuthToken, enableAdminRpc, COC_*_BIND env vars, nodeMode full/archive/light)
- `mempool.ts`: Transaction mempool (EIP-1559 effective gas price sorting)
- `base-fee.ts`: EIP-1559 dynamic baseFee calculation
- `fee-oracle.ts`: Fee estimation module (priority fee median, fee history reward percentiles, cache)
- `health.ts`: Health checks (memory/WS/storage/consensus diagnostics)
- `debug-trace.ts`: Transaction tracing (debug_traceTransaction, trace_transaction)
- `storage.ts`: Chain snapshot persistence
- `ipfs-*.ts`: IPFS-compatible storage layer
  - `ipfs-blockstore.ts`: Content-addressed block storage
  - `ipfs-unixfs.ts`: UnixFS file layout
  - `ipfs-http.ts`: IPFS HTTP API subset + `/ipfs/<cid>` gateway + MFS/Pubsub routes
  - `ipfs-mfs.ts`: Mutable File System (mkdir/write/read/ls/rm/mv/cp/stat/flush)
  - `ipfs-pubsub.ts`: Topic-based pub/sub messaging (dedup, P2P forwarding)
- `peer-store.ts`: Peer persistence storage (peers.json, auto-save)
- `dns-seeds.ts`: DNS seed discovery (TXT record resolution)
- `ipfs-merkle.ts`: Merkle tree construction and proof generation (with index bounds validation)
- `ipfs-tar.ts`: POSIX tar archive builder for IPFS `/api/v0/get` compatibility
- `bft.ts`: BFT-lite consensus round (propose/prepare/commit, 2/3 stake-weighted quorum, equivocation detection, mandatory message signature)
- `bft-coordinator.ts`: BFT round lifecycle management with timeout, P2P bridging, equivocation detector, message signing/verification
- `fork-choice.ts`: GHOST-inspired fork selection (BFT finality > chain length > weight)
- `wire-protocol.ts`: Binary framed TCP protocol (Magic 0xC0C1, FrameDecoder streaming, FindNode/FindNodeResponse, FramePriority queue sorting)
- `wire-server.ts`: TCP server accepting inbound connections, handshake with identity signing, frame dispatch, FindNode handler, per-IP connection limits, default bind 127.0.0.1
- `wire-client.ts`: TCP client with exponential backoff reconnect (1s-30s), async FindNode requests, handshake signing
- `wire-connection-manager.ts`: Wire connection lifecycle management (add/remove peers, max connections, broadcast)
- `dht-network.ts`: DHT network layer (bootstrap, iterative lookup with peer verification, periodic refresh, node announcement)
- `dht.ts`: Kademlia DHT routing table (XOR distance, K-buckets, findClosest)
- `state-snapshot.ts`: EVM state snapshot export/import for fast sync
- `validator-governance.ts`: Validator set management with stake-weighted voting
- `pose-engine.ts`: PoSe challenge/receipt pipeline
- `pose-http.ts`: PoSe HTTP endpoints (field validation for challenge/receipt)
- `rate-limiter.ts`: Shared rate limiter for RPC/IPFS/PoSe endpoints
- `crypto/signer.ts`: NodeSigner + SignatureVerifier (ethers.js wallet-based node identity)

### PoSe Service Layer (services/)
- `challenger/`: Challenge generation and quota management
- `verifier/`: Receipt verification, scoring, and reward calculation
- `aggregator/`: Batch aggregation (Merkle root + sample proofs)
- `relayer/`: Epoch finalization and slash automation
- `common/`: Shared types, Merkle tree, and role registry

### Runtime Services (runtime/)
- `coc-node.ts`: PoSe challenge/receipt HTTP endpoints, dual-version signing (v1 EIP-191 / v2 EIP-712), `/pose/witness` endpoint
- `coc-agent.ts`: Challenge generation, batch submission, node registration, v2 witness collection, persistent pending store, runtime metrics (JSON + Prometheus + HTTP), tick reentrance guard
- `coc-relayer.ts`: Epoch finalization (v1 + v2), fault proof submission, slash hooks, tick reentrance guard
- `lib/`: Runtime utilities (pending-retention, runtime-metrics, agent-metrics-server, witness-collector, contract-reader, config, evidence-store)

### Node Operations (nodeops/)
- `policy-engine.ts`: Policy evaluation engine
- `policy-loader.ts`: Policy loading and validation (YAML support)
- `agent-hooks.ts`: Agent lifecycle hooks
  - `onChallengeIssued`: Triggered on challenge issuance
  - `onReceiptVerified`: Triggered after receipt verification
  - `onBatchSubmitted`: Triggered after batch submission
- `policy-types.ts`: Policy type definitions (PolicyRule, NodeOpsPolicyV2)
- `expression-eval.ts`: Safe recursive-descent expression evaluator (M7, no eval)
- `policies/*.yaml`: Example policy configurations
  - `default-policy.yaml`: Default policy
  - `home-lab-policy.yaml`: Home lab policy
  - `alerts-policy.yaml`: Alerts policy

### Blockchain Explorer (explorer/)
- `src/app/page.tsx`: Home - chain stats dashboard (coc_chainStats) + latest blocks + WebSocket real-time updates
- `src/app/block/[id]/page.tsx`: Block detail page (full tx table, method decoding, gas utilization, proposer, stateRoot)
- `src/app/tx/[hash]/page.tsx`: Transaction detail page (receipt, logs, token transfers, internal transactions trace)
- `src/app/address/[address]/page.tsx`: Address page (balance, tx history with type classification, contract deployment metadata)
- `src/app/mempool/page.tsx`: Mempool page (pool stats, pending/queued tabs, sorting, filtering)
- `src/app/validators/page.tsx`: Validators page (governance stake, voting power, validator status)
- `src/app/stats/page.tsx`: Stats page (chain activity, TPS, gas usage visualization, coc_chainStats)
- `src/app/contracts/page.tsx`: Contracts page (indexed lookup via contract registry, pagination)
- `src/app/network/page.tsx`: Network page (node info, connection endpoints)
- `src/app/verify/page.tsx`: Contract verification page (solc-js source verification, M7)
- `src/components/ContractView.tsx`: Contract view (bytecode disassembly, eth_call, storage scan)
- `src/components/ContractCallHistory.tsx`: Contract call history (incoming transactions to contract)
- `src/components/ConnectionStatus.tsx`: WebSocket status indicator (live/reconnecting/offline)
- `src/components/ChainCharts.tsx`: TPS trend + gas usage charts (pure CSS, M7)
- `src/lib/provider.ts`: ethers.js provider configuration
- `src/lib/rpc.ts`: RPC call utilities (HTTP status checks, network error handling)
- `src/lib/use-websocket.ts`: WebSocket hook (exponential backoff with jitter, reconnecting state)
- `src/lib/abi-decoder.ts`: 4-byte method selector + event topic decoder (M7)
- `src/lib/solc-verify.ts`: Solc-js source verification service (M7)

### Smart Contracts (contracts/)
- `settlement/PoSeManager.sol`: PoSe v1 settlement contract (node registration, batch submission, epoch finalization, slashing)
- `settlement/PoSeManagerV2.sol`: PoSe v2 settlement contract (permissionless fault proofs, commit-reveal+bond, Merkle-claimable rewards, witness quorum, empty epoch finalization, EIP-712 signatures)
- `settlement/PoSeTypesV2.sol`: v2 data structures (EvidenceLeafV2, FaultProof, ChallengeRecord, RewardClaim)
- `settlement/IPoSeManagerV2.sol`: v2 interface and events
- `settlement/MerkleProofLite.sol`: Merkle proof verification (calldata + memory variants)
- `governance/SoulRegistry.sol`: Soul identity registration, backup CID anchoring, EIP-712 signed operations, social recovery with 2/3 guardian quorum

### Performance Benchmarks (node/src/benchmarks/)
- `evm-benchmark.test.ts`: EVM execution performance benchmarks
  - Gas consumption profiling for common operations
  - Execution time measurement
- `p2p-benchmark.test.ts`: P2P subsystem performance benchmarks (M7)
  - Wire frame encode/decode throughput
  - DHT routing table query latency
  - Variable payload size performance

### Persistent Storage Layer (node/src/storage/) - Phase 13.1
- `db.ts`: LevelDB storage abstraction
  - IDatabase interface definition
  - LevelDatabase: Production implementation
  - MemoryDatabase: In-memory implementation for testing
  - Batch operation support
- `block-index.ts`: Block and transaction indexing
  - Query blocks by number
  - Query blocks and transactions by hash
  - Latest block pointer
  - BigInt serialization handling
- `nonce-store.ts`: Nonce registry persistence
  - Replay attack prevention (across restarts)
  - Automatic cleanup (7-day threshold)
  - PersistentNonceStore: LevelDB backend
  - InMemoryNonceStore: For testing
- `state-trie.ts`: EVM state trie persistence
  - Merkle Patricia Trie integration
  - Account state (nonce, balance, storageRoot, codeHash)
  - Storage slot management (address -> slot -> value)
  - Contract code storage (code -> codeHash)
  - Checkpoint/revert support
  - `setStateRoot`/`hasStateRoot` for snapshot restore
- `persistent-state-manager.ts`: EVM state persistence adapter
  - Adapts IStateTrie to EthereumJS StateManagerInterface
  - Persistent read/write for accounts, storage, and code
  - Checkpoint/commit/revert support

## Data Flow Overview

1. Wallet sends signed transactions via JSON-RPC
2. Node mempool validates and gossips transactions
3. Proposer builds block and executes via EVM
4. Block is gossiped to and accepted by peers
5. Storage API accepts files and generates CIDs (for PoSe storage challenges)
6. PoSe agent issues challenges, verifies receipts, aggregates batches
7. Aggregated batches are submitted to PoSeManager, later finalized by relayer

## Current Limitations

- All advanced features (BFT, Wire, DHT, SnapSync) enabled by default in multi-node devnet via `start-devnet.sh`
- Single-node devnet auto-disables BFT (requires >= 3 validators)
- DHT iterative lookup uses wire protocol FIND_NODE when available, falls back to local routing table
- Wire protocol and HTTP gossip have independent dedup (BoundedSet) and cross-protocol relay

## Configuration File Locations

- Node config: loaded via environment variables or `node/src/config.ts`
- Contract config: `contracts/hardhat.config.cjs`

## Documentation Reference

- Implementation status: `docs/implementation-status.md`
- System architecture: `docs/system-architecture.en.md`
- Core algorithms: `docs/core-algorithms.en.md`
- Feature matrix: `docs/feature-matrix.md`
- Soul Registry & Backup: `docs/soul-registry-backup.en.md` / `docs/soul-registry-backup.zh.md`

## Code and Documentation Language Requirements

- Code comments in English
- Documentation maintained in both Chinese and English versions, updated in sync
