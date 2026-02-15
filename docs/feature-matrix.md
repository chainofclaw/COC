# COC Feature Matrix (English)

This matrix lists features by domain, with current status and primary code references.

## Execution & RPC
- **EVM execution engine** — Partial — `COC/node/src/evm.ts`
- **RPC: basic chain info** — Implemented — `COC/node/src/rpc.ts`
- **RPC: block/tx queries** — Implemented — `COC/node/src/rpc.ts`
- **RPC: logs + filters** — Implemented (minimal) — `COC/node/src/rpc.ts`
- **RPC: web3_sha3** — Implemented — `COC/node/src/rpc.ts`
- **RPC: full EVM parity** — Missing

## Consensus & Chain
- **Proposer rotation** — Implemented — `COC/node/src/chain-engine.ts`
- **Finality depth** — Implemented (simple) — `COC/node/src/chain-engine.ts`
- **Fork choice / reorg** — Partial — `COC/node/src/chain-engine.ts`
- **Validator governance** — Implemented (Phase 22 + 26) — `COC/node/src/validator-governance.ts`, `COC/node/src/chain-engine-persistent.ts`
- **Stake-weighted proposer** — Implemented (Phase 26) — `COC/node/src/chain-engine-persistent.ts`
- **Block signature/stateRoot** — Implemented (Phase 26) — `COC/node/src/blockchain-types.ts`
- **Governance RPC** — Implemented (Phase 26) — `COC/node/src/rpc.ts`

## Networking
- **Tx gossip** — Implemented — `COC/node/src/p2p.ts`
- **Block gossip** — Implemented — `COC/node/src/p2p.ts`
- **Snapshot sync** — Implemented — `COC/node/src/p2p.ts`
- **Peer discovery / scoring** — Implemented (Phase 16 + 26) — `COC/node/src/peer-discovery.ts`
- **Peer persistence** — Implemented (Phase 26) — `COC/node/src/peer-store.ts`
- **DNS seed discovery** — Implemented (Phase 26) — `COC/node/src/dns-seeds.ts`

## Storage
- **Chain snapshot persistence** — Implemented — `COC/node/src/storage.ts`
- **LevelDB persistent storage** — Implemented (Phase 13.1) — `COC/node/src/storage/db.ts`
- **Block/transaction indexing** — Implemented (Phase 13.1) — `COC/node/src/storage/block-index.ts`
- **Address tx pagination** — Implemented — `COC/node/src/storage/block-index.ts`
- **EVM state trie** — Implemented (Phase 13.1) — `COC/node/src/storage/state-trie.ts`
- **EVM state persistence** — Implemented (Phase 26) — `COC/node/src/storage/persistent-state-manager.ts`
- **Nonce registry persistence** — Implemented (Phase 13.1) — `COC/node/src/storage/nonce-store.ts`
- **User file storage (IPFS-compatible)** — Implemented (core APIs) — `COC/node/src/ipfs-http.ts`
- **IPFS gateway** — Implemented (basic) — `COC/node/src/ipfs-http.ts`
- **IPFS MFS** — Implemented (Phase 26) — `COC/node/src/ipfs-mfs.ts`
- **IPFS Pubsub** — Implemented (Phase 26) — `COC/node/src/ipfs-pubsub.ts`
- **Log indexing** — Implemented (Phase 13.2) — `COC/node/src/storage/block-index.ts`
- **Block/log pruning** — Implemented (Phase 21) — `COC/node/src/storage/pruner.ts`

## Mempool
- **Gas‑price ordering** — Implemented — `COC/node/src/mempool.ts`
- **Nonce continuity** — Implemented — `COC/node/src/mempool.ts`
- **EIP-1559 effective gas price sorting** — Implemented — `COC/node/src/mempool.ts`
- **Dynamic base fee calculation** — Implemented — `COC/node/src/base-fee.ts`

## PoSe (Off‑chain)
- **Challenge factory** — Implemented — `COC/services/challenger/*`
- **Receipt verification** — Implemented — `COC/services/verifier/*`
- **Batch aggregation** — Implemented — `COC/services/aggregator/*`
- **Reward scoring** — Implemented — `COC/services/verifier/scoring.ts`
- **Storage proofs** — Implemented (Merkle path) — `COC/runtime/coc-node.ts`

## PoSe (On‑chain)
- **PoSeManager contract** — Implemented — `COC/contracts/settlement/PoSeManager.sol`
- **Batch challenge + finalize** — Implemented — `COC/contracts/settlement/PoSeManager.sol`
- **Slashing** — Implemented — `COC/contracts/settlement/PoSeManager.sol`

## Runtime Services
- **coc-node HTTP endpoints** — Implemented — `COC/runtime/coc-node.ts`
- **coc-agent automation** — Implemented — `COC/runtime/coc-agent.ts`
- **coc-relayer automation** — Implemented — `COC/runtime/coc-relayer.ts`

## Tooling
- **Wallet CLI** — Implemented — `COC/wallet/bin/coc-wallet.js`
- **Devnet scripts (3/5/7)** — Implemented — `COC/scripts/*.sh`
- **Quality gate script** — Implemented — `COC/scripts/quality-gate.sh`

## Blockchain Explorer
- **Block explorer** — Implemented — `COC/explorer/src/app/block/[id]/page.tsx`
- **Transaction viewer** — Implemented — `COC/explorer/src/app/tx/[hash]/page.tsx`
- **Address explorer** — Implemented — `COC/explorer/src/app/address/[address]/page.tsx`
- **Latest blocks feed** — Implemented — `COC/explorer/src/app/page.tsx`
- **Contract view** — Implemented — `COC/explorer/src/components/ContractView.tsx`
- **Mempool page** — Implemented — `COC/explorer/src/app/mempool/page.tsx`
- **Validators page** — Implemented — `COC/explorer/src/app/validators/page.tsx`
- **Stats page** — Implemented — `COC/explorer/src/app/stats/page.tsx`
- **Contracts listing** — Implemented — `COC/explorer/src/app/contracts/page.tsx`
- **Network page** — Implemented — `COC/explorer/src/app/network/page.tsx`
- **Real-time updates** — Implemented (WebSocket) — `COC/explorer/src/app/page.tsx`
- **Contract call history** — Implemented (Phase 27) — `COC/explorer/src/components/ContractCallHistory.tsx`
- **Address tx type classification** — Implemented (Phase 27) — `COC/explorer/src/app/address/[address]/page.tsx`
- **Internal transactions trace** — Implemented (Phase 27) — `COC/explorer/src/app/tx/[hash]/page.tsx`
- **WebSocket reconnection** — Implemented (exponential backoff) — `COC/explorer/src/lib/use-websocket.ts`
- **Error boundaries** — Implemented (Phase 27) — `COC/explorer/src/app/`
- **Contract verification** — Missing

## Node Operations
- **Policy engine** — Implemented — `COC/nodeops/policy-engine.ts`
- **Policy loader (YAML)** — Implemented — `COC/nodeops/policy-loader.ts`
- **Agent hooks** — Implemented — `COC/nodeops/agent-hooks.ts`
- **Policy hot-reload** — Missing

## Networking (Advanced)
- **Request body limits** — Implemented (2MB P2P, 1MB RPC) — `COC/node/src/p2p.ts`, `COC/node/src/rpc.ts`
- **P2P broadcast concurrency** — Implemented (5 peers/batch) — `COC/node/src/p2p.ts`
- **Per-peer broadcast dedup** — Implemented — `COC/node/src/p2p.ts`
- **P2P stats/counters** — Implemented — `COC/node/src/p2p.ts`

## WebSocket RPC
- **eth_subscribe (newHeads)** — Implemented — `COC/node/src/websocket-rpc.ts`
- **eth_subscribe (newPendingTransactions)** — Implemented — `COC/node/src/websocket-rpc.ts`
- **eth_subscribe (logs)** — Implemented — `COC/node/src/websocket-rpc.ts`
- **Subscription validation** — Implemented (address/topic format, max 10/client) — `COC/node/src/websocket-rpc.ts`

## Consensus & Reliability
- **Consensus error recovery** — Implemented (degraded mode, auto-recovery) — `COC/node/src/consensus.ts`
- **Health checker** — Implemented (memory/WS/storage diagnostics) — `COC/node/src/health.ts`

## Debug & Trace
- **debug_traceTransaction** — Implemented — `COC/node/src/debug-trace.ts`
- **debug_traceBlockByNumber** — Implemented — `COC/node/src/debug-trace.ts`
- **trace_transaction** — Implemented (OpenEthereum format) — `COC/node/src/debug-trace.ts`

## Input Validation & Error Handling
- **RPC parameter validation** — Implemented (Phase 27) — `COC/node/src/rpc.ts`
- **Structured RPC error codes** — Implemented (-32602/-32603) — `COC/node/src/rpc.ts`
- **PoSe HTTP field validation** — Implemented (Phase 27) — `COC/node/src/pose-http.ts`
- **Config validation** — Implemented (Phase 27) — `COC/node/src/config.ts`
- **Merkle path bounds check** — Implemented (Phase 27) — `COC/node/src/ipfs-merkle.ts`
- **Snapshot JSON validation** — Implemented (Phase 27) — `COC/node/src/storage/snapshot-manager.ts`

## Performance & Benchmarking
- **EVM benchmarks** — Implemented — `COC/node/src/benchmarks/evm-benchmark.test.ts`
- **Load testing** — Implemented (Phase 23) — `COC/node/src/benchmarks/load-test.test.ts`
- **formatBlock optimization** — Implemented (O(n) via Transaction.from) — `COC/node/src/rpc.ts`
