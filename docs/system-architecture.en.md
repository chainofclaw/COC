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

9. **Security Layer (Phase 33)**
   - Node identity authentication via `NodeSigner`/`SignatureVerifier` (wire handshake signing).
   - BFT message mandatory signatures with verification (reject unsigned/forged votes).
   - DHT anti-poisoning: peer verification (TCP probe) before routing table insertion.
   - Per-IP connection limits on wire server (max 5 per IP).
   - IPFS upload size limits (10MB) and MFS path traversal prevention.
   - Block timestamp validation (parent ordering + future drift limit).
   - Exponential peer ban with no decay during ban period.
   - WebSocket idle timeout (1h) and dev accounts gating.
   - Shared rate limiter across RPC/IPFS/PoSe endpoints.
   - P2P HTTP signed auth envelope (`_auth`) with timestamp window and nonce replay guard.
   - Inbound auth rollout modes: `off` / `monitor` / `enforce` for safe migration.
   - State snapshot stateRoot verification on import.
   - PoSeManager ecrecover v-value validation.

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
- Consensus uses ValidatorGovernance stake-weighted block production + rotation fallback. BFT coordinator integrated into ConsensusEngine (opt-in via `enableBft`): starts BFT round in `tryPropose()`, falls back to direct broadcast on failure. BFT messages broadcast via dual transport (HTTP gossip + wire protocol TCP). Fork choice rule integrated into `trySync()` for deterministic chain adoption. Equivocation detection tracks double-voting for slashing evidence. Performance metrics (block times, sync stats, uptime) via `getMetrics()`.
- P2P uses HTTP gossip as primary transport + peer persistence + DNS seed discovery. Wire server/client provide opt-in TCP transport (`enableWireProtocol`) with FIND_NODE request/response for DHT queries. Wire protocol includes Block/Tx dedup via BoundedSet (seenTx 50K, seenBlocks 10K) and cross-protocol relay (Wire→HTTP via onTxRelay/onBlockRelay callbacks). HTTP gossip write paths support signed auth envelope verification (`_auth`) with configurable rollout mode (`off`/`monitor`/`enforce`), timestamp skew bounds, and nonce replay guard. DHT network layer provides opt-in iterative peer discovery (`enableDht`) with periodic node announcement; FIND_NODE uses wireClientByPeerId map (O(1) lookup) with scan and local routing table fallback. Dual HTTP+TCP propagation for blocks and transactions with sender exclusion (excludeNodeId). Per-peer wire port from dhtBootstrapPeers config. Wire connection manager handles outbound peer lifecycle. State snapshot endpoint available for fast sync.
- EVM state persists across restarts via PersistentStateManager + LevelDB. Snap sync provider integrated into ConsensusEngine (opt-in via `enableSnapSync`).
- IPFS supports core HTTP APIs, gateway, MFS, Pubsub, and tar archive for `get`.
- RPC exposes `coc_getNetworkStats` for P2P/wire/DHT/BFT stats and `coc_getBftStatus` for BFT round inspection with equivocation count.
- Security hardening (Phase 33): node identity authentication in wire handshake (NodeSigner/SignatureVerifier), BFT mandatory message signatures, DHT peer verification (TCP probe before routing table insertion), per-IP wire connection limits (max 5), IPFS upload size limit (10MB), MFS path traversal prevention, block timestamp validation, exponential peer ban (max 24h), WebSocket idle timeout (1h), dev accounts gated behind `COC_DEV_ACCOUNTS=1`, default bind `127.0.0.1`, shared rate limiter (RPC 200/min, IPFS 100/min, PoSe 60/min), HTTP gossip signed auth envelope with phased rollout mode (`off`/`monitor`/`enforce`) and replay protection, governance self-vote removed, PoSeManager ecrecover v-value check, state snapshot stateRoot verification.
- All advanced features (BFT, Wire, DHT, SnapSync) enabled by default in multi-node devnet via `start-devnet.sh`. Single-node devnet auto-disables BFT (requires >= 3 validators). DHT iterative lookup uses wire protocol FIND_NODE when available, falls back to local routing table.
