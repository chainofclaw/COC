# COC Core Algorithms (English)

## 1) Proposer Rotation
**Goal**: deterministic leader selection per block height.

Algorithm:
- In-memory engine: maintain a static validator list `V`; proposer index = `(h - 1) mod |V|`.
- Persistent engine with governance enabled: use stake-weighted proposer selection (§11) via `ValidatorGovernance.getActiveValidators()`; falls back to round-robin when governance is disabled or no active validators exist.
- Only the proposer for `h` can build and broadcast block `h`.

Code:
- `COC/node/src/chain-engine.ts` (`expectedProposer` — round-robin)
- `COC/node/src/chain-engine-persistent.ts` (`expectedProposer` — stake-weighted with fallback)

## 2) Block Hashing
**Goal**: deterministic block identity.

Algorithm:
- Concatenate payload fields with `|` separator: `height|parentHash|proposer|timestampMs|txs(comma-separated rawTx list)|baseFee|cumulativeWeight`.
- `hash = keccak256(payload)`.
- `baseFee` and `cumulativeWeight` default to `0` when absent.

Code:
- `COC/node/src/hash.ts`

## 3) Mempool Selection
**Goal**: choose txs for a block deterministically.

Algorithm:
- `pickForBlock()`: reject txs that cannot pay current `baseFee` (`maxFeePerGas < baseFee`), filter txs below `minGasPrice`, sort by EIP-1559 effective gas price desc (`min(maxFeePerGas, baseFee + maxPriorityFeePerGas)`; legacy: `gasPrice`), then nonce asc, then arrival time. Enforce per-sender nonce continuity using on-chain nonce.
- `getAll()`: returns all pending txs sorted by legacy `gasPrice` desc (no baseFee context available outside block production).
- `gasPriceHistogram()`: buckets by legacy `gasPrice` for display/analytics.

Code:
- `COC/node/src/mempool.ts`

## 4) Chain Finality Depth
**Goal**: mark blocks finalized after depth `D`.

Algorithm:
- For tip height `H`, a block `b` is finalized if `H >= b.number + D`.
- `finalized` is derived from local depth rules; inbound remote `finalized` metadata is not trusted.

Code:
- `COC/node/src/chain-engine.ts` (`updateFinalityFlags`)

## 5) P2P Snapshot Sync
**Goal**: converge to the best chain via fork-choice rule.

Algorithm:
- Block-level sync: periodically fetch chain snapshots from static and discovered peers (deduplicated by URL).
- Snap sync: uses discovered peers (`discovery.getActivePeers()`, which includes DHT-discovered nodes) for state snapshot fetching and cross-peer stateRoot validation.
- Snapshot request handlers may be sync or async; they return a standard `ChainSnapshot` (`blocks + updatedAtMs`).
- Attempt adoption only when the remote tip wins fork-choice comparison.
- Before adoption, verify block-chain integrity (parent-link continuity, height continuity, and recomputable block hashes).
- Peer requests enforce resource guards: 10s request timeout, 2 MiB max request body, and 4 MiB max response body. State snapshot requests enforce 30s timeout and 16 MiB response limit.

Code:
- `COC/node/src/p2p.ts`, `COC/node/src/consensus.ts`

## 6) PoSe Challenge Generation
**Goal**: issue verifiable challenges per epoch.

Algorithm:
- Enforce per‑epoch quotas per node and challenge type.
- Construct challenge payload with nonce + epoch seed.
- Sign challenge hash.

Code:
- `COC/services/challenger/*`

## 7) Receipt Verification
**Goal**: validate challenge responses.

Algorithm:
- Enforce nonce replay protection.
- Verify challenger and node signatures.
- Check deadline and response body hashes.
- Apply per‑type checks (U/S/R).

Code:
- `COC/services/verifier/receipt-verifier.ts`

## 8) Batch Aggregation
**Goal**: aggregate receipts into a batch for on‑chain submission.

Algorithm:
- Hash each verified receipt into a leaf.
- Build Merkle root over leaves.
- Select deterministic sample leaf indexes and proofs.
- Compute `summaryHash` from epoch + root + sample commitment.

Code:
- `COC/services/aggregator/batch-aggregator.ts`

## 9) Reward Scoring
**Goal**: allocate epoch rewards by service metrics.

Algorithm:
- Split reward pool into U/S/R buckets.
- Apply threshold checks and storage cap (sqrt diminishing).
- Enforce soft cap and redistribute overflow.

Code:
- `COC/services/verifier/scoring.ts`

## 10) Storage Proofs (IPFS-Compatible)
**Goal**: prove file availability with a Merkle path over stored chunks.

Algorithm:
- Split file into fixed-size chunks (default 256 KiB).
- For each chunk, compute `leafHash = keccak256(chunkBytes)`.
- Build a Merkle tree over `leafHash[]` with pairwise hashing.
- For a challenge `(cid, chunkIndex)`, return `leafHash`, `merklePath`, and `merkleRoot`.
- Verifier recomputes the root from `(leafHash, merklePath, chunkIndex)` and compares.

Code:
- `COC/node/src/ipfs-unixfs.ts`
- `COC/node/src/ipfs-merkle.ts`
- `COC/runtime/coc-node.ts`

## 11) Stake-Weighted Proposer Selection
**Goal**: deterministic proposer selection weighted by validator stake.

Algorithm:
- Get active validators from `ValidatorGovernance`, sort by ID lexicographically.
- Compute `totalStake = sum(v.stake for v in validators)`.
- If `totalStake === 0`: equal-weight fallback via `(blockHeight - 1) mod |validators|`.
- Otherwise compute `seed = keccak256(blockHeight as utf8) mod totalStake` (improves proposer distribution when `totalStake` is much larger than block height).
- Walk sorted validators accumulating stake: first validator where `seed < cumulative` is proposer.
- Deterministic: same height always produces same proposer.
- Falls back to round-robin if governance is disabled or no active validators.

Code:
- `COC/node/src/chain-engine-persistent.ts` (`stakeWeightedProposer`)

## 12) EIP-1559 Dynamic Base Fee
**Goal**: adjust base fee per block based on gas utilization.

Algorithm:
- Maintain target gas utilization at 50% of block gas limit.
- If actual gas > target: increase base fee by up to 12.5%. When integer division rounds the increase to zero, a minimum increment of 1 wei is applied to prevent stalling at low base fees.
- If actual gas < target: decrease base fee by up to 12.5%.
- Absolute floor: 1 gwei (base fee never drops below `MIN_BASE_FEE = 1_000_000_000`).
- `changeRatio = (gasUsed - targetGas) / targetGas`.
- `newBaseFee = parentBaseFee * (1 + changeRatio * 0.125)`.

Code:
- `COC/node/src/base-fee.ts`

## 13) Consensus Recovery State Machine
**Goal**: graceful degradation and recovery when block production or sync fails.

Algorithm:
- States: `healthy` → `degraded` → `recovering` → `healthy`.
- Track `proposeFailures` and `syncFailures` (consecutive counts).
- After 5 consecutive propose failures → enter `degraded` mode (stop proposing).
- After 5 consecutive sync failures (while healthy) → also enter `degraded` mode.
- After successful sync in degraded mode → enter `recovering` (allow one propose attempt).
- If recovering propose succeeds → back to `healthy`.
- If recovering propose fails → back to `degraded`.
- Recovery cooldown: 30 seconds between recovery attempts.
- Forced recovery: if stuck in `degraded` for 5 minutes (`MAX_DEGRADED_MS`), cooldown is cleared and recovery is forced.

Code:
- `COC/node/src/consensus.ts`

## 14) BFT-lite Consensus Round
**Goal**: three-phase commit with stake-weighted quorum for block finalization.

Algorithm:
- Phases: `propose` → `prepare` → `commit` → `finalized`.
- Quorum threshold: `floor(2/3 * totalStake) + 1`.
- Proposer broadcasts block, validators send prepare votes.
- On prepare quorum, transition to commit phase.
- Early commit buffering: `handleCommit()` accepts and records commit votes during `prepare` phase; on transition to `commit`, buffered votes are checked for immediate quorum.
- On commit quorum, block is BFT-finalized.
- `bftFinalized` is treated as local consensus metadata: untrusted inbound values are ignored, and trusted local finalization can promote existing block metadata.
- Timeout handling: rounds fail after configurable prepare + commit timeout.

Code:
- `COC/node/src/bft.ts` (round state machine, quorum calculation)
- `COC/node/src/bft-coordinator.ts` (lifecycle management)

## 15) Tip-level Fork Choice Comparator (Current Implementation)
**Goal**: deterministic chain selection across competing forks.

Algorithm:
- Priority 1: BFT-finalized chain always wins.
- Priority 2: Longer chain preferred.
- Priority 3: Higher cumulative stake-weight.
- Priority 4: Lower block hash (deterministic tiebreaker).
- Current implementation is a tip-level comparator (`compareForks`), not the full subtree-weighted classical GHOST rule.
- `shouldSwitchFork()` determines if sync should adopt a remote chain.
- During sync, remote `bftFinalized` flags are never trusted — remote candidates are hardcoded to `bftFinalized: false` as a security-conservative measure.

Code:
- `COC/node/src/fork-choice.ts`

## 16) Kademlia DHT Routing
**Goal**: decentralized peer discovery via XOR distance routing.

Algorithm:
- Node IDs are 256-bit values; distance = XOR(nodeA, nodeB).
- Routing table: 256 K-buckets (K=20 peers each).
- Bucket index = highest bit position of XOR distance.
- `findClosest(target, K)`: returns K nearest peers by XOR distance.
- LRU eviction: most recently seen peers kept at bucket tail.
- Sybil protection: max 2 peers per IP per bucket (`MAX_PEERS_PER_IP_PER_BUCKET`), with host canonicalization (lowercase/trim + IPv4-mapped IPv6 normalization) before per-IP counting.

Code:
- `COC/node/src/dht.ts`

## 17) Binary Wire Protocol
**Goal**: efficient binary framing for P2P communication.

Algorithm:
- Frame: `[Magic 2B: 0xC0C1] [Type 1B] [Length 4B BE] [Payload NB]`.
- Max payload: 16 MiB.
- `FrameDecoder`: streaming accumulator for TCP partial reads with exponential buffer growth (2x, amortized O(n)); IPv4-mapped IPv6 addresses normalized before per-IP rate limiting.
- Message types: Handshake, Block, Transaction, BFT, Ping/Pong, FindNode/FindNodeResponse (DHT).

Code:
- `COC/node/src/wire-protocol.ts`

## 18) DHT Network Iterative Lookup
**Goal**: discover peers via iterative querying across the DHT network.

Algorithm:
- Start with K closest peers from local routing table.
- Select ALPHA (3) unqueried peers closest to target.
- Query each in parallel for their closest peers.
- Validate discovered peer IDs (`0x` + hex format), verify reachability/identity, then add only verified peers to routing table and candidate set.
- Repeat until no new peers are found (convergence).
- Return final K closest peers from routing table.

Code:
- `COC/node/src/dht-network.ts` (`iterativeLookup`)

## 19) Wire Server/Client TCP Handshake
**Goal**: establish authenticated TCP connections between nodes.

Algorithm:
- Server listens on configured port and accepts connections.
- On connect, server sends Handshake frame (nodeId, chainId, height).
- Client sends Handshake frame on connect.
- Receiver validates chainId — disconnect on mismatch.
- On successful validation, mark connection as handshake-complete.
- Post-handshake: dispatch Block, Transaction, BFT frames to handlers.
- Client uses exponential backoff on disconnect (1s initial, 30s max, doubles each attempt).
- Resource guards: per-IP connection limit (5), per-connection message rate limit (500 msg / 10s), idle timeout (5 min).
- Handshake nonce timestamp must be within 5-minute window; stale nonces are rejected.
- Replay-protection boundary: nonce deduplication uses BoundedSet(10,000), node-local in-memory window semantics (cleared on restart, not globally shared across nodes).

Code:
- `COC/node/src/wire-server.ts`
- `COC/node/src/wire-client.ts`

## 20) Snap Sync State Transfer
**Goal**: fast-sync node state from a peer's EVM snapshot.

Algorithm:
- Syncing node requests state snapshot from peer via `/p2p/state-snapshot`.
- Peer exports full EVM state: accounts, storage slots, contract code.
- Receiver validates snapshot structure (`validateSnapshot()`).
- Receiver checks snapshot `(blockHeight, blockHash)` matches the target chain tip before import.
- Import accounts, storage, and code into local state trie.
- After import, verify expectedStateRoot via cross-peer consensus (at least 2 votes AND strict majority of responding peers; single-peer networks accept with 1 vote; fail-closed when multiple peers disagree without quorum or when known peers > 1 but only 1 responds) and set local state root.
- Validator set is subject to cross-peer hash consensus before governance restore; snapshots without validator consensus are imported without governance state.
- Import snapshot blocks via `importSnapSyncBlocks()` (writes to block index without re-execution); proposer-set validation is skipped for historical blocks since the validator set may have changed since those blocks were produced. This path is append-only (overlapping ranges are rejected). Finality depth is recomputed locally and imported `bftFinalized` flags are cleared.
- For large-gap sync attempts, if snap sync fails but block continuity exists, consensus falls back to block-level replay instead of aborting the sync round.
- Resume consensus from the snapshot's block height.
- Security assumption: block-hash payload currently does not include `stateRoot`, so SnapSync still depends on snapshot-provider trust; production deployments should add trusted state-root anchoring and/or multi-peer cross-checks.

Code:
- `COC/node/src/state-snapshot.ts` (`exportStateSnapshot`, `importStateSnapshot`)
- `COC/node/src/consensus.ts` (`SnapSyncProvider` interface)
- `COC/node/src/p2p.ts` (`/p2p/state-snapshot` endpoint)

## 21) BFT Equivocation Detection
**Goal**: detect double-voting by validators for slashing evidence.

Algorithm:
- Maintain a 3-level map: `height → phase → validatorId → blockHash`.
- On each vote (prepare/commit), check if the validator already voted for a different block hash at the same height+phase.
- If conflict found, emit `EquivocationEvidence` with both conflicting block hashes.
- Prune old heights to limit memory (configurable `maxTrackedHeights`, default 100; `maxEvidence` caps total evidence records at 1000).
- Pruning occurs after recording the vote (not before) to avoid race conditions.

Code:
- `COC/node/src/bft.ts` (`EquivocationDetector`)
- `COC/node/src/bft-coordinator.ts` (integration)

## 22) Dual Transport Block/Tx Propagation
**Goal**: maximize block and transaction delivery via parallel transport paths.

Algorithm:
- On block production: broadcast via HTTP gossip (primary) AND wire protocol TCP (secondary).
- On transaction receipt via HTTP: relay to all wire-connected peers via `broadcastFrame`.
- On transaction/block receipt via wire: relay to HTTP gossip peers via `onTxRelay`/`onBlockRelay` callbacks.
- Each transport path operates independently — failure in one does not block the other.
- Wire broadcast uses late binding pattern: function reference set after wire server initialization.
- Shared dedup via `BoundedSet` (seenTx 50K, seenBlocks 10K) — wire and HTTP layers share the same sets to prevent cross-protocol amplification.
- Cross-protocol relay is safe: shared dedup ensures each message is processed at most once across both transports.
- `broadcastFrame` supports `excludeNodeId` parameter to skip the original sender.
- BFT messages also broadcast via dual transport (HTTP gossip + wire protocol TCP).

Code:
- `COC/node/src/consensus.ts` (`broadcastBlock` with wireBroadcast callback)
- `COC/node/src/index.ts` (`wireBroadcastFn`, `wireTxRelayFn`, `wireBftBroadcastFn`)
- `COC/node/src/wire-server.ts` (dedup, relay callbacks, excludeNodeId)

## 23) Consensus Metrics Collection
**Goal**: track block production and sync performance for observability.

Algorithm:
- On each `tryPropose()`: record start time, increment `blocksProposed` or `proposeFailed`, accumulate `totalProposeMs`.
- On each `trySync()`: record start time, increment `syncAttempts`, track `syncAdoptions` and `blocksAdopted`.
- On snap sync success: increment `snapSyncs`.
- `getMetrics()` returns computed averages (total time / count), last operation times, and uptime.
- `startedAtMs` set in `start()` for uptime calculation.

Code:
- `COC/node/src/consensus.ts` (`ConsensusMetrics` interface, `getMetrics()`)

## 24) Wire Protocol Dedup
**Goal**: prevent duplicate Block/Tx processing at the wire protocol layer.

Algorithm:
- Maintain `seenTx = BoundedSet<Hex>(50_000)` and `seenBlocks = BoundedSet<Hex>(10_000)`.
- On incoming Block frame: check `seenBlocks.has(block.hash)` — if seen, discard silently; otherwise add and process.
- On incoming Transaction frame: check `seenTx.has(rawTx)` — if seen, discard silently; otherwise add and process.
- BoundedSet evicts oldest entries when capacity reached (FIFO).
- Stats exposed via `getStats()`: `seenTxSize`, `seenBlocksSize`.

Code:
- `COC/node/src/wire-server.ts` (`seenTx`, `seenBlocks`, `handleFrame`)

## 25) Cross-Protocol Relay
**Goal**: bridge Wire protocol and HTTP gossip for full network coverage.

Algorithm:
- Wire→HTTP: after wire-level dedup + handler, call `onTxRelay(rawTx)` / `onBlockRelay(block)` to inject into HTTP gossip layer.
- HTTP→Wire: existing `wireTxRelayFn` / `wireBroadcastFn` relay from HTTP to wire-connected peers.
- Relay errors are non-fatal (try-catch, ignore failures).
- No circular relay: wire and HTTP share the same BoundedSet dedup instances (injected via `sharedSeenTx`/`sharedSeenBlocks`).

Code:
- `COC/node/src/wire-server.ts` (`onTxRelay`, `onBlockRelay` config callbacks)
- `COC/node/src/index.ts` (wiring relay callbacks to P2P `receiveTx`/`receiveBlock`)

## 26) DHT Wire Client Priority Lookup
**Goal**: efficient wire client discovery for DHT FIND_NODE queries.

Algorithm:
- Priority 1: `wireClientByPeerId` Map — O(1) direct lookup by peer ID.
- Priority 2: scan `wireClients` array by `getRemoteNodeId()` match (backward compatibility).
- Priority 3: fall back to local routing table `findClosest(targetId, ALPHA)`.
- `wireClientByPeerId` is built during connection creation as `peer.id → client` (only successful client creations are recorded; no index alignment dependency).
- Per-peer wire port resolved from `dhtBootstrapPeers` config instead of using local `wirePort`.

Code:
- `COC/node/src/dht-network.ts` (`findNode` with 3-tier priority)
- `COC/node/src/index.ts` (`wireClientByPeerId` construction, `peerWirePortMap`)

## 27) DHT Peer Verification
**Goal**: prevent DHT routing table poisoning by verifying peers before insertion.

Algorithm:
- When a new peer is discovered via iterative lookup, verify reachability before adding to routing table.
- Iterative lookup validates discovered `peer.id` format (`0x` + hex) before insertion/verification to reject malformed FIND_NODE responses.
- Priority 1: check if peer has an active wire client connection (`wireClientByPeerId` or `wireClients` scan) — already verified via wire handshake.
- Priority 2: authenticated wire handshake (`verifyPeerByHandshake`) — open a temporary WireClient, exchange signed handshake messages, verify identity, then disconnect.
- If `requireAuthenticatedVerify=true` (default): reject unverifiable peers (no TCP probe fallback).
- If `requireAuthenticatedVerify=false`: fallback to lightweight TCP connect probe with 3-second timeout.
- Successful verification = peer is reachable and identity confirmed → add to routing table and notify discovery callback.
- Timeout, connection refused, or identity mismatch → discard peer (do not add to routing table).
- Stale peer filtering on load: peers with `lastSeenMs` older than 24 hours are excluded.

Code:
- `COC/node/src/dht-network.ts` (`verifyPeer`, `iterativeLookup`)

## 28) Exponential Peer Ban
**Goal**: progressively penalize misbehaving peers with escalating ban durations.

Algorithm:
- Each `PeerScore` tracks a `banCount` field (number of times banned).
- On ban trigger (invalid data, repeated failures): increment `banCount`.
- Ban duration: `baseBanMs * 2^min(banCount - 1, 10)`, capped at 24 hours.
- During ban period: `applyDecay()` skips the peer (no score recovery while banned).
- After ban expires: peer can be re-evaluated, but next offense doubles ban duration.

Code:
- `COC/node/src/peer-scoring.ts` (`exponentialBanMs`, `recordInvalidData`, `applyDecay`)

## 29) Node Identity Handshake
**Goal**: cryptographically verify node identity during wire protocol TCP handshake.

Algorithm:
- Each node has a persistent private key (`nodePrivateKey` from `COC_NODE_KEY` env / `dataDir/node-key`).
- On wire handshake, sender signs `wire:handshake:<chainId>:<nodeId>:<nonce>` using `NodeSigner.sign()`.
- Receiver verifies signature via `SignatureVerifier.recoverAddress()`.
- Recovered address must match the claimed `nodeId` — mismatch → disconnect + `recordInvalidData()`.
- Nonce provides per-session replay protection (node-local in-memory window; cleared on restart, not shared across nodes).
- Signature verification is enforced when `verifier` is configured (production deployments should always configure it); unsigned handshake requests are rejected and disconnected.

Code:
- `COC/node/src/wire-server.ts` (handshake verification)
- `COC/node/src/wire-client.ts` (handshake signing)
- `COC/node/src/config.ts` (`resolveNodeKey`)
- `COC/node/src/crypto/signer.ts` (`NodeSigner`, `SignatureVerifier`)

## 30) BFT Message Signing
**Goal**: prevent BFT vote forgery by requiring cryptographic signatures on all consensus messages.

Algorithm:
- `BftMessage.signature` is mandatory (type `Hex`, no longer optional).
- Canonical message format: `bft:<type>:<height>:<blockHash>` (deterministic string).
- Sender signs canonical message via `NodeSigner.sign()`.
- Receiver verifies via `SignatureVerifier.verifyNodeSig(canonical, signature, validatorAddress)`.
- Messages with missing or invalid signatures are dropped when `verifier` is configured; production deployments must configure verifier for signature enforcement.
- Only messages from known active validators are accepted.

Code:
- `COC/node/src/bft.ts` (`BftMessage.signature` required)
- `COC/node/src/bft-coordinator.ts` (`signMessage`, `bftCanonicalMessage`, verification in `handlePrepare`/`handleCommit`)

## 31) P2P HTTP Auth Envelope
**Goal**: authenticate HTTP gossip write traffic and support phased rollout without instant network split.

Algorithm:
- Sender signs canonical message `p2p:<path>:<senderId>:<timestampMs>:<nonce>:<payloadHash>` and attaches `_auth`.
- `payloadHash` uses deterministic JSON serialization + keccak256.
- Receiver verifies:
  - envelope fields (`senderId/timestampMs/nonce/signature`) presence and format.
  - timestamp within `p2pAuthMaxClockSkewMs` (default 120s).
  - nonce replay key (`senderId:nonce`) not seen before.
  - signature recovers the claimed sender address.
- Rollout modes:
  - `off`: no verification.
  - `monitor`: verify and count failures, but do not reject request.
  - `enforce`: reject missing/invalid signatures with HTTP 401.
- Node exposes counters for observability:
  - `authAcceptedRequests`, `authMissingRequests`, `authInvalidRequests`, `authRejectedRequests`, `rateLimitedRequests`.

Code:
- `COC/node/src/p2p.ts` (`buildSignedP2PPayload`, `verifySignedP2PPayload`, rollout mode handling)
- `COC/node/src/config.ts` (`p2pInboundAuthMode`, `p2pAuthMaxClockSkewMs`)
