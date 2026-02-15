# COC System Architecture (English)

## Overview
COC is an EVM-compatible blockchain prototype that combines a lightweight execution layer with a PoSe (Proof-of-Service) settlement workflow. The system is split into on-chain contracts, off-chain services, and node runtime components.

## Layered Architecture
1. **Execution Layer (EVM)**
   - Executes transactions with persistent state via `PersistentStateManager`.
   - Exposes JSON-RPC for wallet and tooling integration.

2. **Consensus & Chain Layer**
   - Produces blocks via stake-weighted proposer selection (with round-robin fallback).
   - BFT-lite three-phase commit (propose/prepare/commit) with stake-weighted quorum.
   - GHOST-inspired fork choice rule for deterministic chain selection.
   - BFT coordinator bridging consensus engine and P2P layer.
   - Tracks finality depth and performs basic chain validation.
   - Persists chain snapshots for restart recovery.
   - ValidatorGovernance for proposal-based validator set management.

3. **P2P Networking Layer**
   - HTTP-based gossip for transactions, blocks, BFT messages, and pubsub messages.
   - Binary wire protocol with frame encoding/decoding and TCP transport (wire server/client).
   - Kademlia DHT routing table and network layer (bootstrap, iterative lookup, periodic refresh).
   - Snapshot-based sync to reconcile peers, including EVM state snapshot via `/p2p/state-snapshot`.
   - Peer persistence to disk with DNS seed discovery.
   - Reputation-based peer scoring with auto-ban/unban.

4. **Storage Layer (IPFS-Compatible)**
   - Blockstore + UnixFS layout for user files.
   - HTTP API subset and `/ipfs/<cid>` gateway with tar archive support.
   - MFS (Mutable File System) for POSIX-like file operations.
   - Pubsub for topic-based messaging with P2P forwarding.
   - EVM state snapshot export/import for fast sync.

5. **PoSe Service Layer**
   - Off-chain challenger/verifier/aggregator pipeline.
   - On-chain PoSeManager contract for registration, batch submission, dispute, and slashing.

6. **NodeOps Runtime**
   - `coc-node`: PoSe challenge/receipt HTTP endpoints.
   - `coc-agent`: challenge issuance, batch submission, rewards calculation.
   - `coc-relayer`: epoch finalization and optional dispute/slash automation.

7. **Node Operations Layer**
   - YAML-based policy engine for evaluating node behavior rules.
   - Policy loader with validation and error handling.
   - Agent lifecycle hooks (onChallengeIssued, onReceiptVerified, onBatchSubmitted).

8. **Blockchain Explorer**
   - Next.js 15 + React 19 web application.
   - Block, transaction, and address query with detail views.
   - Real-time chain data via JSON-RPC.
   - Responsive UI with Tailwind CSS.

## Core Components
- **Node Runtime**: `COC/node/src/*`
- **PoSe Contracts**: `COC/contracts/settlement/*`
- **PoSe Services**: `COC/services/*`
- **Runtime Services**: `COC/runtime/*`
- **Node Operations**: `COC/nodeops/*`
- **Wallet CLI**: `COC/wallet/bin/coc-wallet.js`
- **Blockchain Explorer**: `COC/explorer/src/*`

## Data Flow (High-Level)
1. Wallet sends signed transaction to JSON-RPC.
2. Node mempool validates nonce/gas ordering and gossips the tx.
3. Proposer builds a block and executes txs via EVM.
4. Block is gossiped and accepted by peers.
5. Storage API accepts files and produces CIDs for PoSe storage challenges.
6. PoSe agent issues challenges, verifies receipts, aggregates batches.
7. Aggregated batch is submitted to PoSeManager and finalized later by relayer.

## Current Boundaries
- Consensus uses ValidatorGovernance stake-weighted block production + rotation fallback. BFT coordinator integrated into ConsensusEngine (opt-in via `enableBft`): starts BFT round in `tryPropose()`, falls back to direct broadcast on failure. Fork choice rule integrated into `trySync()` for deterministic chain adoption. Equivocation detection tracks double-voting for slashing evidence. Performance metrics (block times, sync stats, uptime) via `getMetrics()`.
- P2P uses HTTP gossip as primary transport + peer persistence + DNS seed discovery. Wire server/client provide opt-in TCP transport (`enableWireProtocol`) with FIND_NODE request/response for DHT queries. DHT network layer provides opt-in iterative peer discovery (`enableDht`) with periodic node announcement. Dual HTTP+TCP propagation for blocks and transactions. Wire connection manager handles outbound peer lifecycle. State snapshot endpoint available for fast sync.
- EVM state persists across restarts via PersistentStateManager + LevelDB. Snap sync provider integrated into ConsensusEngine (opt-in via `enableSnapSync`).
- IPFS supports core HTTP APIs, gateway, MFS, Pubsub, and tar archive for `get`.
- RPC exposes `coc_getNetworkStats` for P2P/wire/DHT/BFT stats and `coc_getBftStatus` for BFT round inspection with equivocation count.
- All advanced features (BFT, wire protocol, DHT, snap sync) are disabled by default and enabled via config flags.
