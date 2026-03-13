# COC Feature Matrix (English)

This matrix lists features by domain, with current status and primary code references.

Status legend:
- `Production-ready`: runtime-wired and hardened for sustained production use
- `Runtime-wired`: present in code and connected to the runtime main path
- `Implemented`: present in code and exercised in tests/devnet scripts
- `Partial`: present but simplified, stubbed, or not yet hardened
- `Missing`: not implemented

## Execution & RPC
- **EVM execution engine** — Partial — `COC/node/src/evm.ts`
- **RPC: basic chain info** — Implemented — `COC/node/src/rpc.ts`
- **RPC: block/tx queries** — Implemented — `COC/node/src/rpc.ts`
- **RPC: logs + filters** — Implemented (minimal) — `COC/node/src/rpc.ts`
- **RPC: web3_sha3** — Implemented — `COC/node/src/rpc.ts`
- **RPC: historical block-tag state reads** — Implemented (P0) — `COC/node/src/rpc.ts`, `COC/node/src/evm.ts`, `COC/node/src/storage/persistent-state-manager.ts`
- **RPC: historical execution context for call/estimate/trace** — Implemented (post-P6 parity hardening) — `COC/node/src/rpc.ts`, `COC/node/src/evm.ts`
- **RPC: tx/receipt schema parity** — Implemented (P1) — `COC/node/src/rpc.ts`, `COC/node/src/chain-engine-persistent.ts`
- **RPC: eth_createAccessList** — Implemented (P2) — `COC/node/src/rpc.ts`, `COC/node/src/evm.ts`
- **RPC: eth_getProof** — Implemented (P4) — `COC/node/src/rpc.ts`, `COC/node/src/storage/state-trie.ts`
- **RPC: eth_estimateGas intrinsic gas parity** — Implemented (post-P6 parity hardening) — `COC/node/src/evm.ts`, `COC/node/src/rpc.ts`
- **RPC: eth_getCompilers** — Implemented (post-P6, Solidity only) — `COC/node/src/rpc.ts`
- **RPC: eth_compileSolidity** — Implemented (post-P6, lazy `solc`) — `COC/node/src/rpc.ts`
- **RPC: real block header fields** — Implemented (M3) — `COC/node/src/block-header.ts`, `COC/node/src/rpc.ts`, `COC/node/src/chain-events.ts`
- **RPC: full EVM parity** — Missing
- **EVM hardfork configurability** — Implemented (P3 + post-P6 parity hardening, single hardfork + static schedule) — `COC/node/src/config.ts`, `COC/node/src/evm.ts`

## Consensus & Chain
- **Proposer rotation** — Implemented — `COC/node/src/chain-engine.ts`
- **Finality depth** — Implemented (simple) — `COC/node/src/chain-engine.ts`
- **Fork choice (GHOST-inspired)** — Implemented (Phase 28) — `COC/node/src/fork-choice.ts`
- **BFT-lite consensus rounds** — Implemented (Phase 28) — `COC/node/src/bft.ts`
- **BFT coordinator** — Implemented (Phase 28) — `COC/node/src/bft-coordinator.ts`
- **BFT status RPC** — Implemented (Phase 28) — `COC/node/src/rpc.ts`
- **BFT commit blockHash binding** — Implemented (Audit) — `COC/node/src/bft.ts`
- **BFT equivocation detection** — Implemented (Phase 30) — `COC/node/src/bft.ts`
- **Validator governance** — Implemented (Phase 22 + 26) — `COC/node/src/validator-governance.ts`, `COC/node/src/chain-engine-persistent.ts`
- **Stake-weighted proposer** — Implemented (Phase 26) — `COC/node/src/chain-engine-persistent.ts`
- **Block signature/stateRoot** — Implemented (Phase 26) — `COC/node/src/blockchain-types.ts`
- **StateRoot verification (post-EVM)** — Implemented (M7) — `COC/node/src/chain-engine.ts`
- **RPC PoW stubs** — Implemented (M7) — `COC/node/src/rpc.ts`
- **Governance RPC** — Implemented (Phase 26) — `COC/node/src/rpc.ts`

## Networking
- **Tx gossip** — Implemented — `COC/node/src/p2p.ts`
- **Block gossip** — Implemented — `COC/node/src/p2p.ts`
- **Snapshot sync** — Implemented — `COC/node/src/p2p.ts`
- **Peer discovery / scoring** — Implemented (Phase 16 + 26) — `COC/node/src/peer-discovery.ts`
- **Peer persistence** — Implemented (Phase 26) — `COC/node/src/peer-store.ts`
- **DNS seed discovery** — Implemented (Phase 26) — `COC/node/src/dns-seeds.ts`
- **BFT message routing** — Implemented (Phase 28) — `COC/node/src/p2p.ts`
- **Kademlia DHT routing** — Implemented (Phase 28) — `COC/node/src/dht.ts`
- **DHT network layer** — Implemented (Phase 29) — `COC/node/src/dht-network.ts`
- **Binary wire protocol** — Implemented (Phase 28) — `COC/node/src/wire-protocol.ts`
- **Wire server (TCP inbound)** — Implemented (Phase 29) — `COC/node/src/wire-server.ts`
- **Wire client (TCP outbound)** — Implemented (Phase 29) — `COC/node/src/wire-client.ts`
- **State snapshot P2P** — Implemented (Phase 29) — `COC/node/src/p2p.ts`
- **Wire FIND_NODE message** — Implemented (Phase 30) — `COC/node/src/wire-protocol.ts`
- **Wire connection manager** — Implemented (Phase 30) — `COC/node/src/wire-connection-manager.ts`
- **DHT node announcement** — Implemented (Phase 30) — `COC/node/src/dht-network.ts`
- **Dual HTTP+TCP block propagation** — Implemented (Phase 30) — `COC/node/src/consensus.ts`
- **Wire transaction relay** — Implemented (Phase 30) — `COC/node/src/index.ts`
- **Wire Block/Tx dedup** — Implemented (Phase 32) — `COC/node/src/wire-server.ts`
- **Cross-protocol relay (Wire→HTTP)** — Implemented (Phase 32) — `COC/node/src/wire-server.ts`
- **BFT dual transport (HTTP+TCP)** — Implemented (Phase 32) — `COC/node/src/index.ts`
- **DHT wireClientByPeerId lookup** — Implemented (Phase 32) — `COC/node/src/dht-network.ts`
- **Per-peer wire port config** — Implemented (Phase 32) — `COC/node/src/index.ts`
- **broadcastFrame sender exclusion** — Implemented (Phase 32) — `COC/node/src/wire-server.ts`
- **Wire frame priority queue** — Implemented (M7) — `COC/node/src/wire-protocol.ts`

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
- **IPFS tar archive** — Implemented (Phase 28) — `COC/node/src/ipfs-tar.ts`
- **EVM state snapshot** — Implemented (Phase 28 + Audit: full trie traversal) — `COC/node/src/state-snapshot.ts`
- **Snap sync provider** — Implemented (Phase 29) — `COC/node/src/consensus.ts`
- **Log indexing** — Implemented (Phase 13.2) — `COC/node/src/storage/block-index.ts`
- **Block/log pruning** — Implemented (Phase 21) — `COC/node/src/storage/pruner.ts`
- **Tx-level pruning by age** — Implemented (M7) — `COC/node/src/storage/pruner.ts`
- **State trie COW (fork/merge)** — Implemented (M7) — `COC/node/src/storage/state-trie.ts`
- **Node mode (full/archive/light)** — Implemented (M7) — `COC/node/src/config.ts`

## Mempool
- **Gas‑price ordering** — Implemented — `COC/node/src/mempool.ts`
- **Nonce continuity** — Implemented — `COC/node/src/mempool.ts`
- **EIP-1559 effective gas price sorting** — Implemented — `COC/node/src/mempool.ts`
- **Dynamic base fee calculation** — Implemented — `COC/node/src/base-fee.ts`
- **Per-block baseFee integration** — Implemented (Audit) — `COC/node/src/chain-engine.ts`, `COC/node/src/chain-engine-persistent.ts`

## PoSe (Off‑chain)
- **Challenge factory (v1)** — Implemented — `COC/services/challenger/challenge-factory.ts`
- **Challenge factory (v2 EIP-712)** — Implemented — `COC/services/challenger/challenge-factory-v2.ts`
- **Receipt verification (v1)** — Implemented — `COC/services/verifier/receipt-verifier.ts`
- **Receipt verification (v2, 9-layer)** — Implemented — `COC/services/verifier/receipt-verifier-v2.ts`
- **Batch aggregation (v1 + v2)** — Implemented — `COC/services/aggregator/*`
- **Reward scoring** — Implemented — `COC/services/verifier/scoring.ts`
- **Unified SlashEvidence bus** — Implemented (M0-M2) — `COC/services/common/slash-evidence.ts`
- **Unified reward manifest (v1/v2)** — Implemented (M4) — `COC/runtime/lib/reward-manifest.ts`, `COC/runtime/coc-agent.ts`
- **Reward tree (Merkle-claimable)** — Implemented — `COC/services/common/reward-tree.ts`
- **Storage proofs** — Implemented (Merkle path) — `COC/runtime/coc-node.ts`
- **Witness collector** — Implemented — `COC/runtime/lib/witness-collector.ts`

## PoSe (On‑chain)
- **PoSeManager (v1)** — Implemented — `COC/contracts/settlement/PoSeManager.sol`
- **PoSeManagerV2 (v2)** — Implemented — `COC/contracts/settlement/PoSeManagerV2.sol`
- **v2 Fault proofs (commit-reveal-settle)** — Implemented — `COC/contracts/settlement/PoSeManagerV2.sol`
- **v2 Witness quorum validation** — Implemented (default strict) — `COC/contracts/settlement/PoSeManagerV2.sol`
- **v2 Merkle-claimable rewards** — Implemented — `COC/contracts/settlement/PoSeManagerV2.sol`
- **v2 EIP-712 signatures** — Implemented — `COC/contracts/settlement/PoSeTypesV2.sol`
- **EIP-712 cross-check (TS ↔ Solidity)** — Implemented — `COC/contracts/test/eip712-crosscheck.test.cjs`
- **L1/L2 deployment configs** — Implemented (M7) — `COC/contracts/deploy/l1-config.ts`, `COC/contracts/deploy/l2-config.ts`
- **PoSe deploy script** — Implemented (M7) — `COC/contracts/deploy/deploy-pose.ts`
- **PoSe deploy CLI** — Implemented (P5) — `COC/contracts/deploy/cli-deploy-pose.ts`

## Runtime Services
- **coc-node HTTP endpoints** — Runtime-wired — `COC/runtime/coc-node.ts` (dual-version signing, `/pose/witness`)
- **coc-agent automation** — Runtime-wired — `COC/runtime/coc-agent.ts` (v2 challenges, witness collection, reward manifest, persistent pending, metrics, NodeOps tick)
- **coc-relayer automation** — Runtime-wired — `COC/runtime/coc-relayer.ts` (v2 finalize with reward manifest, epoch nonce init, fault proof lifecycle, persistent pending recovery, scoring-based reward distribution)
- **Runtime Docker image** — Implemented — `COC/docker/Dockerfile.runtime`
- **Runtime systemd templates** — Implemented — `COC/docker/systemd/coc-agent.service`, `COC/docker/systemd/coc-relayer.service`
- **Testnet `pose` compose profile** — Implemented — `COC/docker/docker-compose.testnet.yml`, `COC/docker/testnet-runtime-configs/{agent,relayer}.json`
- **Runtime metrics** — Implemented — `COC/runtime/lib/runtime-metrics.ts`, `COC/runtime/lib/agent-metrics-server.ts`
- **Pending retention** — Implemented — `COC/runtime/lib/pending-retention.ts`
- **Unified retry (exponential backoff)** — Implemented (M6) — `COC/runtime/lib/retry.ts`
- **Secure key resolution** — Implemented (M6) — `COC/runtime/lib/key-material.ts`
- **BFT → PoSe slash bridge** — Implemented (M7) — `COC/runtime/coc-relayer.ts`
- **V1 challenger rewards** — Implemented (M7) — `COC/services/relayer/epoch-finalizer.ts`

## Tooling
- **Wallet CLI** — Implemented (M7) — `COC/wallet/coc-wallet.ts`
- **Devnet scripts (3/5/7)** — Implemented — `COC/scripts/*.sh`
- **Genesis + boot-node artifact generation** — Implemented — `COC/scripts/generate-genesis.sh`, `COC/scripts/setup-boot-nodes.sh`
- **Testnet image-tag deployment workflow** — Implemented — `COC/.github/workflows/testnet-deploy.yml`, `COC/docker/docker-compose.testnet.yml`
- **Docker monitoring stack on shared testnet RPC network** — Implemented — `COC/docker/docker-compose.monitoring.yml`, `COC/docker/prometheus/prometheus.yml`, `COC/ops/alerts/prometheus-rules.yml`
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
- **Contract verification** — Implemented (M7) — `COC/explorer/src/app/verify/page.tsx`, `COC/explorer/src/lib/solc-verify.ts`
- **ABI method decoding** — Implemented (M7) — `COC/explorer/src/lib/abi-decoder.ts`
- **TPS/Gas charts** — Implemented (M7) — `COC/explorer/src/components/ChainCharts.tsx`

## Node Operations
- **Policy engine** — Implemented — `COC/nodeops/policy-engine.ts`
- **Policy loader (YAML)** — Implemented — `COC/nodeops/policy-loader.ts`
- **Agent hooks** — Implemented — `COC/nodeops/agent-hooks.ts`
- **Policy hot-reload** — Implemented (M5) — `COC/runtime/lib/nodeops-runtime.ts`
- **Policy conflict detection** — Implemented (M5) — `COC/nodeops/policy-loader.ts`
- **NodeOps agent runtime** — Implemented (M5) — `COC/runtime/lib/nodeops-runtime.ts`
- **Advanced policy DSL** — Implemented (M7) — `COC/nodeops/expression-eval.ts`, `COC/nodeops/policy-types.ts`

## Networking (Advanced)
- **Request body limits** — Implemented (2MB P2P, 1MB RPC) — `COC/node/src/p2p.ts`, `COC/node/src/rpc.ts`
- **P2P broadcast concurrency** — Implemented (5 peers/batch) — `COC/node/src/p2p.ts`
- **Per-peer broadcast dedup** — Implemented — `COC/node/src/p2p.ts`
- **P2P stats/counters** — Implemented — `COC/node/src/p2p.ts`
- **P2P signed auth envelope (`_auth`)** — Implemented (tx/block/pubsub/bft write paths) — `COC/node/src/p2p.ts`
- **P2P inbound auth mode** — Implemented (`off`/`monitor`/`enforce`) — `COC/node/src/config.ts`, `COC/node/src/p2p.ts`
- **P2P auth observability counters** — Implemented (`authAccepted/authMissing/authInvalid/authRejected`) — `COC/node/src/p2p.ts`

## WebSocket RPC
- **eth_subscribe (newHeads)** — Implemented — `COC/node/src/websocket-rpc.ts`
- **eth_subscribe (newPendingTransactions)** — Implemented — `COC/node/src/websocket-rpc.ts`
- **eth_subscribe (logs)** — Implemented — `COC/node/src/websocket-rpc.ts`
- **Subscription validation** — Implemented (address/topic format, max 10/client) — `COC/node/src/websocket-rpc.ts`

## Consensus & Reliability
- **Consensus error recovery** — Implemented (degraded mode, auto-recovery) — `COC/node/src/consensus.ts`
- **BFT consensus integration** — Implemented (Phase 29, opt-in; Phase 32, dual transport) — `COC/node/src/consensus.ts`
- **Fork choice integration** — Implemented (Phase 29) — `COC/node/src/consensus.ts`
- **Snap sync integration** — Implemented (Phase 29 + Audit: target chain head validation) — `COC/node/src/consensus.ts`
- **Consensus metrics** — Implemented (Phase 30) — `COC/node/src/consensus.ts`
- **Network stats RPC** — Implemented (Phase 30) — `COC/node/src/rpc.ts`
- **Health checker** — Implemented (memory/WS/storage diagnostics) — `COC/node/src/health.ts`

## Debug & Trace
- **debug_traceTransaction** — Implemented (P2: replay-backed opcode-level) — `COC/node/src/debug-trace.ts`
- **debug_traceBlockByNumber** — Implemented (P2: replay-backed opcode-level) — `COC/node/src/debug-trace.ts`
- **debug_traceCall** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/evm.ts`
- **trace_transaction** — Implemented (P2: replay-backed, OpenEthereum format) — `COC/node/src/debug-trace.ts`
- **trace_call** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`
- **trace_replayTransaction** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/debug-trace.ts`
- **trace_replayBlockTransactions** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/debug-trace.ts`
- **trace_rawTransaction** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/evm.ts`
- **trace_block** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/debug-trace.ts`
- **trace_filter** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/debug-trace.ts`
- **trace_get** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`
- **trace_callMany** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/evm.ts`
- **Built-in callTracer / prestateTracer** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/evm.ts`
- **Best-effort vmTrace / stateDiff** — Implemented (post-P6 trace parity) — `COC/node/src/rpc.ts`, `COC/node/src/evm.ts`

## EVM Compatibility Regression (P6)
- **P0-P5 regression baseline** — Implemented (P6) — `COC/node/src/rpc-debug-compatibility.test.ts`, `COC/node/src/rpc-persistent.test.ts`
- **Ethers toolchain compatibility regression** — Implemented (post-P6 parity hardening) — `COC/node/src/ethers-toolchain-compat.test.ts`
- **Node workspace quality gate** — Implemented (`864` tests / `124` suites passing) — `COC/node/src/**/*.test.ts`
- **Root tests workspace quality gate** — Implemented (`173` tests / `34` suites passing) — `COC/tests/**/*.test.ts`
- **Repository-wide quality gate** — Implemented (`1563` tests / `145` files across repo workspaces, excluding vendored `node_modules` tests) — `COC/scripts/quality-gate.sh`

## Input Validation & Error Handling
- **RPC parameter validation** — Implemented (Phase 27) — `COC/node/src/rpc.ts`
- **Structured RPC error codes** — Implemented (-32602/-32603) — `COC/node/src/rpc.ts`
- **PoSe HTTP field validation** — Implemented (Phase 27) — `COC/node/src/pose-http.ts`
- **Config validation** — Implemented (Phase 27) — `COC/node/src/config.ts`
- **Merkle path bounds check** — Implemented (Phase 27) — `COC/node/src/ipfs-merkle.ts`
- **Snapshot JSON validation** — Implemented (Phase 27) — `COC/node/src/storage/snapshot-manager.ts`

## Security Hardening (Phase 33)
- **IPFS upload size limit** — Implemented (10MB default) — `COC/node/src/ipfs-http.ts`
- **MFS path traversal protection** — Implemented — `COC/node/src/ipfs-mfs.ts`
- **Wire per-IP connection limit** — Implemented (max 5/IP) — `COC/node/src/wire-server.ts`
- **Block timestamp validation** — Implemented (parent ordering + 60s drift, both engines) — `COC/node/src/chain-engine.ts`, `COC/node/src/chain-engine-persistent.ts`
- **Configurable signature enforcement** — Implemented (off/monitor/enforce) — `COC/node/src/config.ts`
- **Node identity authentication** — Implemented (wire handshake signing) — `COC/node/src/wire-server.ts`, `COC/node/src/wire-client.ts`
- **BFT message signing** — Implemented (mandatory signature) — `COC/node/src/bft-coordinator.ts`
- **DHT peer verification** — Implemented (TCP probe + ping-evict) — `COC/node/src/dht-network.ts`
- **DHT distance-sorted lookup** — Implemented (Audit) — `COC/node/src/dht-network.ts`
- **K-bucket ping-evict** — Implemented (Audit) — `COC/node/src/dht.ts`
- **State snapshot stateRoot check** — Implemented — `COC/node/src/state-snapshot.ts`
- **Exponential peer ban** — Implemented (base * 2^n, max 24h) — `COC/node/src/peer-scoring.ts`
- **WebSocket idle timeout** — Implemented (1h) — `COC/node/src/websocket-rpc.ts`
- **Dev accounts gating** — Implemented (COC_DEV_ACCOUNTS=1) — `COC/node/src/rpc.ts`
- **Default localhost binding** — Implemented (127.0.0.1) — `COC/node/src/wire-server.ts`
- **Shared rate limiter** — Implemented (RPC/IPFS/PoSe) — `COC/node/src/rate-limiter.ts`
- **P2P signed request verification** — Implemented (timestamp window + nonce replay guard) — `COC/node/src/p2p.ts`
- **Governance self-vote removal** — Implemented — `COC/node/src/validator-governance.ts`
- **PoSeManager v-value check** — Implemented — `COC/contracts/settlement/PoSeManager.sol`

## Performance & Benchmarking
- **EVM benchmarks** — Implemented — `COC/node/src/benchmarks/evm-benchmark.test.ts`
- **Load testing** — Implemented (Phase 23) — `COC/node/src/benchmarks/load-test.test.ts`
- **formatBlock optimization** — Implemented (O(n) via Transaction.from) — `COC/node/src/rpc.ts`
- **P2P benchmarks** — Implemented (M7) — `COC/node/src/benchmarks/p2p-benchmark.test.ts`
