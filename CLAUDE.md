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
npm run verify:pose      # Verify PoSe contract
```

### Run Devnet
```bash
bash scripts/devnet-3.sh  # 3-node network
bash scripts/devnet-5.sh  # 5-node network
bash scripts/devnet-7.sh  # 7-node network
bash scripts/stop-devnet.sh    # Stop devnet
bash scripts/verify-devnet.sh  # Verify devnet status
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
bash scripts/quality-gate.sh  # Run all unit, integration, and e2e tests
```

### Node Operations Policies
Policy files are located at `nodeops/policies/*.yaml` and can be loaded and evaluated by the policy engine.

## Test Strategy

Uses Node.js built-in test framework (239 tests, 132+97+10 distribution):
- **Node layer tests**: `node/src/**/*.test.ts` (132 tests) - chain engine, EVM, RPC, WebSocket, P2P, mempool, storage, MFS, Pubsub
- **Service layer tests**: `services/**/*.test.ts` + `nodeops/*.test.ts` + `tests/**/*.test.ts` (97 tests)
- **Contract tests**: `contracts/` (52 tests via Hardhat)
- **Storage layer tests**: `node/src/storage/*.test.ts` (36 tests, included in node layer)

Running tests:
```bash
# Node layer tests
cd node && node --experimental-strip-types --test --test-force-exit src/**/*.test.ts

# Service layer tests
cd /path/to/COC && node --experimental-strip-types --test --test-force-exit services/**/*.test.ts nodeops/*.test.ts tests/**/*.test.ts

# Contract tests
cd contracts && npm test
```

## Core Architecture

### Node Core Components (node/src/)
- `chain-engine.ts`: Blockchain engine, manages block production, persistence, and finality
- `evm.ts`: EVM execution layer (based on @ethereumjs/vm)
- `consensus.ts`: Consensus engine (deterministic rotation + degraded mode + auto-recovery)
- `p2p.ts`: HTTP gossip network (per-peer dedup, request body limits, broadcast concurrency control)
- `rpc.ts`: JSON-RPC interface (57+ methods)
- `websocket-rpc.ts`: WebSocket RPC (eth_subscribe, subscription validation and limits)
- `mempool.ts`: Transaction mempool (EIP-1559 effective gas price sorting)
- `base-fee.ts`: EIP-1559 dynamic baseFee calculation
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
- `pose-engine.ts`: PoSe challenge/receipt pipeline
- `pose-http.ts`: PoSe HTTP endpoints

### PoSe Service Layer (services/)
- `challenger/`: Challenge generation and quota management
- `verifier/`: Receipt verification, scoring, and reward calculation
- `aggregator/`: Batch aggregation (Merkle root + sample proofs)
- `relayer/`: Epoch finalization and slash automation
- `common/`: Shared types, Merkle tree, and role registry

### Runtime Services (runtime/)
- `coc-node.ts`: PoSe challenge/receipt HTTP endpoints
- `coc-agent.ts`: Challenge generation, batch submission, node registration
- `coc-relayer.ts`: Epoch finalization and slash hooks

### Node Operations (nodeops/)
- `policy-engine.ts`: Policy evaluation engine
- `policy-loader.ts`: Policy loading and validation (YAML support)
- `agent-hooks.ts`: Agent lifecycle hooks
  - `onChallengeIssued`: Triggered on challenge issuance
  - `onReceiptVerified`: Triggered after receipt verification
  - `onBatchSubmitted`: Triggered after batch submission
- `policy-types.ts`: Policy type definitions
- `policies/*.yaml`: Example policy configurations
  - `default-policy.yaml`: Default policy
  - `home-lab-policy.yaml`: Home lab policy
  - `alerts-policy.yaml`: Alerts policy

### Blockchain Explorer (explorer/)
- `src/app/page.tsx`: Home - chain stats dashboard + latest blocks + WebSocket real-time updates
- `src/app/block/[id]/page.tsx`: Block detail page (full tx table, method decoding, gas utilization)
- `src/app/tx/[hash]/page.tsx`: Transaction detail page (receipt, logs, token transfers)
- `src/app/address/[address]/page.tsx`: Address page (balance, tx history, contract detection)
- `src/app/mempool/page.tsx`: Mempool page (pool stats, pending tx stream)
- `src/app/validators/page.tsx`: Validators page (validator list and status)
- `src/app/stats/page.tsx`: Stats page (chain activity, TPS, gas usage visualization)
- `src/app/contracts/page.tsx`: Contracts page (deployed contract listing scan)
- `src/app/network/page.tsx`: Network page (node info, connection endpoints)
- `src/components/ContractView.tsx`: Contract view (bytecode disassembly, eth_call, storage scan)
- `src/lib/provider.ts`: ethers.js provider configuration
- `src/lib/rpc.ts`: RPC call utilities

### Smart Contracts (contracts/)
- `settlement/PoSeManager.sol`: PoSe settlement contract
  - Node registration and commitment updates
  - Batch submission and challenges
  - Epoch finalization and slashing

### Performance Benchmarks (node/src/benchmarks/)
- `evm-benchmark.test.ts`: EVM execution performance benchmarks
  - Gas consumption profiling for common operations
  - Execution time measurement

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

- Consensus uses ValidatorGovernance stake-weighted block production + rotation fallback (BFT finality not yet implemented)
- P2P uses HTTP gossip + peer persistence + DNS seed discovery (DHT and binary wire protocol not yet implemented)
- EVM state persists across restarts via PersistentStateManager + LevelDB
- IPFS supports core HTTP APIs, gateway, MFS, and Pubsub (tar archive `get` not yet supported)

## Configuration File Locations

- Node config: loaded via environment variables or `node/src/config.ts`
- Contract config: `contracts/hardhat.config.cjs`

## Documentation Reference

- Implementation status: `docs/implementation-status.md`
- System architecture: `docs/system-architecture.en.md`
- Core algorithms: `docs/core-algorithms.en.md`
- Feature matrix: `docs/feature-matrix.md`

## Code and Documentation Language Requirements

- Code comments in English
- Documentation maintained in both Chinese and English versions, updated in sync
