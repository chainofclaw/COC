# COC Core Algorithms (English)

## 1) Proposer Rotation
**Goal**: deterministic leader selection per block height.

Algorithm:
- Maintain a static validator list `V`.
- For height `h`, proposer index = `(h - 1) mod |V|`.
- Only the proposer for `h` can build and broadcast block `h`.

Code:
- `COC/node/src/chain-engine.ts` (`expectedProposer`)

## 2) Block Hashing
**Goal**: deterministic block identity.

Algorithm:
- Hash payload fields: `height | parentHash | proposer | timestamp | txHashes`.
- `hash = keccak256(payload)`.

Code:
- `COC/node/src/hash.ts`

## 3) Mempool Selection
**Goal**: choose txs for a block deterministically.

Algorithm:
- Filter txs below `minGasPrice`.
- Sort by `gasPrice desc`, then `nonce asc`.
- Enforce per‑sender nonce continuity using on‑chain nonce.

Code:
- `COC/node/src/mempool.ts`

## 4) Chain Finality Depth
**Goal**: mark blocks finalized after depth `D`.

Algorithm:
- For tip height `H`, a block `b` is finalized if `H >= b.number + D`.

Code:
- `COC/node/src/chain-engine.ts` (`updateFinalityFlags`)

## 5) P2P Snapshot Sync
**Goal**: converge to the longest chain snapshot.

Algorithm:
- Periodically fetch snapshots from peers.
- If a peer snapshot tip height is higher than local, rebuild from it.

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
- Compute `seed = blockHeight mod totalStake`.
- Walk sorted validators accumulating stake: first validator where `cumulative > seed` is proposer.
- Deterministic: same height always produces same proposer.
- Falls back to round-robin if governance is disabled or no active validators.

Code:
- `COC/node/src/chain-engine-persistent.ts` (`stakeWeightedProposer`)

## 12) EIP-1559 Dynamic Base Fee
**Goal**: adjust base fee per block based on gas utilization.

Algorithm:
- Maintain target gas utilization at 50% of block gas limit.
- If actual gas > target: increase base fee by up to 12.5%.
- If actual gas < target: decrease base fee by up to 12.5%.
- Floor at 1 gwei minimum (never drops to zero).
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
- After successful sync in degraded mode → enter `recovering` (allow one propose attempt).
- If recovering propose succeeds → back to `healthy`.
- If recovering propose fails → back to `degraded`.
- Recovery cooldown: 30 seconds between recovery attempts.

Code:
- `COC/node/src/consensus.ts`
