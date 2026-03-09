# COC (ChainOfClaw) Operations Manual

> From zero to testnet — a complete guide for operators.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Repository Setup](#2-repository-setup)
3. [Single-Node Quick Start](#3-single-node-quick-start)
4. [Node Configuration Reference](#4-node-configuration-reference)
5. [Multi-Node Devnet](#5-multi-node-devnet)
6. [Docker Testnet Deployment](#6-docker-testnet-deployment)
7. [Production Testnet Setup](#7-production-testnet-setup)
8. [Smart Contract Deployment](#8-smart-contract-deployment)
9. [Explorer Setup](#9-explorer-setup)
10. [Wallet CLI](#10-wallet-cli)
11. [PoSe Service Layer](#11-pose-service-layer)
12. [Monitoring](#12-monitoring)
13. [Health Checks & Status](#13-health-checks--status)
14. [Backup & Restore](#14-backup--restore)
15. [Quality Gate](#15-quality-gate)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Prerequisites

Principle: stable operations start with runtime and toolchain parity; mismatched Node.js, Docker, or shell behavior causes failures long before consensus or PoSe logic is reached.
Module / program focus: this chapter covers the host requirements shared by the core node, runtime services, explorer, wallet CLI, and containerized testnet workflows.

### Software

| Software | Version | Notes |
|----------|---------|-------|
| Node.js | **22+** | Uses `--experimental-strip-types` for native TS |
| npm | 10+ | Workspace support required |
| Git | 2.30+ | For cloning and version control |
| curl | any | For RPC verification |
| bash | 4+ | Devnet scripts |
| Docker | 24+ | Optional — for containerized deployment |
| Docker Compose | 2.20+ | Optional — multi-container orchestration |

### Hardware (Minimum)

| Resource | Single Node | 3-Node Testnet |
|----------|-------------|----------------|
| CPU | 2 cores | 4 cores |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB SSD | 60 GB SSD |
| Network | 10 Mbps | 50 Mbps |

---

## 2. Repository Setup

Principle: COC is a multi-workspace system, so operators need a consistent checkout and dependency graph before they can run or verify any individual component.
Module / program focus: this chapter maps repository directories to operational programs, so you can tell which workspace owns node execution, contracts, runtime automation, wallet operations, and observability.

```bash
git clone https://github.com/<org>/ClawdBot.git
cd ClawdBot/COC
npm install          # Installs all workspaces at once
```

### Workspace Structure

```
COC/
├── node/            # Blockchain core engine
├── contracts/       # Solidity smart contracts (PoSeManager)
├── services/        # PoSe off-chain services
├── runtime/         # Runtime executables (agent, relayer, node)
├── wallet/          # CLI wallet tool
├── explorer/        # Next.js block explorer
├── nodeops/         # Policy engine and agent hooks
├── tests/           # Integration and E2E tests
├── scripts/         # DevOps scripts
├── docker/          # Docker configurations
└── docs/            # Documentation
```

---

## 3. Single-Node Quick Start

Principle: a single-node environment is the smallest safe setup for validating storage, RPC, execution, and logging without introducing peer or consensus variables.
Module / program focus: this chapter starts the core blockchain node (`node/src/index.ts`) and verifies the JSON-RPC surface that external tools use.

### Start a node

```bash
COC_DATA_DIR=/tmp/coc-single \
  node --experimental-strip-types node/src/index.ts
```

### Default Ports

| Service | Port | Protocol |
|---------|------|----------|
| JSON-RPC | 18780 | HTTP |
| WebSocket | 18781 | WS |
| P2P Gossip | 19780 | HTTP |
| Wire Protocol | 19781 | TCP |
| IPFS API | 5001 | HTTP |
| Prometheus | 9100 | HTTP |

### Pre-funded Account (Dev)

| Field | Value |
|-------|-------|
| Address | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| Private Key | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| Balance | 10 000 ETH |

### Verify

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# Expected: {"jsonrpc":"2.0","id":1,"result":"0x..."}
```

---

## 4. Node Configuration Reference

Principle: node behavior is determined by explicit configuration for networking, consensus, storage, and security; operationally, these inputs should be reviewable and reproducible.
Module / program focus: this chapter documents the main node process, its data directory layout, and the config/env inputs that shape its runtime behavior.

Configuration is loaded from `{COC_DATA_DIR}/node-config.json` and can be overridden by environment variables.

### Core Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `chainId` | 18780 | Chain identifier |
| `blockTimeMs` | 3000 | Block production interval (ms) |
| `syncIntervalMs` | 5000 | P2P sync interval (ms) |
| `finalityDepth` | 3 | Blocks before finality |
| `maxTxPerBlock` | 50 | Maximum transactions per block |
| `minGasPriceWei` | `"1"` | Minimum gas price |
| `poseEpochMs` | 3600000 | PoSe epoch duration (1 hour) |
| `poseMaxChallengesPerEpoch` | 200 | Max challenges per epoch |

### Environment Variables — Network

| Variable | Default | Description |
|----------|---------|-------------|
| `COC_DATA_DIR` | `~/.clawdbot/coc` | Data directory |
| `COC_NODE_CONFIG` | `{dataDir}/node-config.json` | Config file path |
| `COC_NODE_KEY` | auto-generated | Node private key (0x + 64 hex) |
| `COC_RPC_BIND` | `0.0.0.0` | RPC listen address |
| `COC_RPC_PORT` | 18780 | RPC port |
| `COC_WS_BIND` | `0.0.0.0` | WebSocket listen address |
| `COC_WS_PORT` | 18781 | WebSocket port |
| `COC_P2P_BIND` | `0.0.0.0` | P2P listen address |
| `COC_P2P_PORT` | 19780 | P2P port |
| `COC_WIRE_BIND` | `0.0.0.0` | Wire protocol listen address |
| `COC_WIRE_PORT` | 19781 | Wire protocol port |
| `COC_IPFS_BIND` | `0.0.0.0` | IPFS listen address |
| `COC_IPFS_PORT` | 5001 | IPFS port |
| `COC_METRICS_PORT` | 9100 | Prometheus metrics port |
| `COC_DEV_MODE` | `false` | Dev mode (binds to 127.0.0.1) |
| `COC_NODE_MODE` | `full` | Node mode: `full` / `archive` / `light` |

### Environment Variables — Security

| Variable | Default | Description |
|----------|---------|-------------|
| `COC_RPC_AUTH_TOKEN` | (none) | Bearer token for RPC auth |
| `COC_ENABLE_ADMIN_RPC` | `false` | Enable admin_* namespace |
| `COC_DEV_ACCOUNTS` | (none) | Set `1` to enable dev accounts |
| `COC_SIGNATURE_ENFORCEMENT` | `enforce` | `off` / `monitor` / `enforce` |
| `COC_P2P_AUTH_MODE` | `enforce` | P2P inbound auth mode |
| `COC_P2P_AUTH_MAX_CLOCK_SKEW_MS` | 120000 | Max clock drift (ms) |
| `COC_POSE_AUTH_MODE` | `enforce` | PoSe challenge auth mode |
| `COC_POSE_ALLOWED_CHALLENGERS` | (none) | Comma-separated challenger addresses |

### Feature Flags

| Variable / Config | Default | Description |
|-------------------|---------|-------------|
| `enableBft` | auto (≥3 validators) | BFT consensus |
| `enableWireProtocol` | `false` | TCP wire protocol |
| `enableDht` | `false` | DHT peer discovery |
| `enableSnapSync` | `false` | State snapshot sync |
| `snapSyncThreshold` | 100 | Height gap to trigger snap sync |

### Storage

| Parameter | Default | Description |
|-----------|---------|-------------|
| `storage.backend` | `leveldb` | `memory` or `leveldb` |
| `storage.cacheSize` | 1000 | LRU cache entries |
| `storage.enablePruning` | `false` | Auto-prune old blocks |
| `storage.nonceRetentionDays` | 7 | Nonce cleanup threshold |

### Data Directory Layout

```
{COC_DATA_DIR}/
├── node-config.json              # Configuration
├── node-key                      # Private key (mode 0600)
├── leveldb/                      # LevelDB state storage
├── storage/                      # IPFS block store
├── peers.json                    # P2P peer cache
├── pose-nonce-registry.log       # PoSe nonce persistence
├── p2p-auth-nonce.log            # P2P auth nonces
├── pose-auth-nonce.log           # PoSe auth nonces
├── reward-manifests/             # Reward manifest files
├── evidence/                     # BFT slash evidence
├── pending-challenges.json       # Agent v1 pending store
└── pending-challenges-v2.json    # Agent v2 pending store
```

---

## 5. Multi-Node Devnet

Principle: a devnet introduces peer discovery, BFT coordination, and state propagation, which are the first places distributed bugs become visible.
Module / program focus: this chapter uses the devnet scripts to boot multiple core nodes with coordinated ports, validator lists, and peer topology for local multi-node testing.

### Start

```bash
bash scripts/start-devnet.sh 3    # 3-node devnet
bash scripts/start-devnet.sh 5    # 5-node devnet
bash scripts/start-devnet.sh 7    # 7-node devnet
```

### Port Allocation

| Service | Node 1 | Node 2 | Node 3 | Formula |
|---------|--------|--------|--------|---------|
| RPC | 28780 | 28781 | 28782 | 28780 + (N-1) |
| P2P | 29780 | 29781 | 29782 | 29780 + (N-1) |
| WebSocket | 18781 | 18782 | 18783 | 18781 + (N-1) |
| Wire | 29781 | 29782 | 29783 | 29781 + (N-1) |
| IPFS | 5001 | 5002 | 5003 | 5001 + (N-1) |

### Features Auto-Enabled

All devnet nodes enable: **BFT consensus**, **Wire protocol**, **DHT discovery**, **Snap sync**.

### Verify

```bash
bash scripts/verify-devnet.sh 3
```

Checks performed:
- Block height increasing on all nodes
- Transaction propagation across peers
- BFT finality status

### Stop

```bash
bash scripts/stop-devnet.sh 3
```

---

## 6. Docker Testnet Deployment

Principle: containerized deployments trade some host flexibility for reproducibility, making them useful when operators need a known-good topology that can be recreated quickly.
Module / program focus: this chapter covers the Docker Compose stacks and images that package the core node, explorer, website, and faucet into a testnet-style deployment.

### 6.1 Single-Node Docker

```bash
docker compose -f docker/docker-compose.yml up -d
```

Services: `node`, `explorer`, `website`
Exposed ports: 18780 (RPC), 3000 (Explorer), 3001 (Website)

### 6.2 3-Node BFT Testnet

```bash
# Start
docker compose -f docker/docker-compose.testnet.yml up -d

# Or use the launch script
bash scripts/launch-testnet.sh up
bash scripts/launch-testnet.sh status
bash scripts/launch-testnet.sh verify
bash scripts/launch-testnet.sh down
```

Services: `node-1`, `node-2`, `node-3`, `explorer`, `faucet`

| Service | Port |
|---------|------|
| Node 1 RPC | 28780 |
| Node 2 RPC | 28782 |
| Node 3 RPC | 28784 |
| Explorer | 3000 |
| Faucet | 3003 |

Environment: Set `COC_FAUCET_KEY` for faucet private key.

### 6.3 Dockerfile

The node image (`docker/Dockerfile.node`) uses:
- **Base**: `node:22-slim` multi-stage build
- **User**: Non-root `coc` user
- **Volume**: `/data/coc` for persistent storage
- **Health check**: `eth_blockNumber` query every 15 seconds
- **Exposed ports**: 18780, 18781, 19780, 19781, 5001, 9100

```bash
docker build -f docker/Dockerfile.node -t coc-node:latest .
```

---

## 7. Production Testnet Setup

Principle: production-style testnets add identity management, service supervision, and external ingress; these layers matter as much as the node binary itself.
Module / program focus: this chapter covers the scripts and host services used to bootstrap validators, generate genesis/config artifacts, and operate nodes under systemd and Nginx.

### 7.1 Generate Validator Keys

```bash
bash scripts/generate-validator-keys.sh <count>
# Outputs key pairs and addresses to stdout
# Save securely — these are the validator identities
```

### 7.2 Generate Genesis Configuration

```bash
# For Docker deployment
bash scripts/generate-genesis.sh --docker --validators=3

# For bare-metal deployment
bash scripts/generate-genesis.sh --bare-metal --validators=3
```

### 7.3 Bootstrap Nodes

```bash
bash scripts/setup-boot-nodes.sh
```

Configures:
- DNS TXT records for seed discovery
- DHT bootstrap peer list
- Initial peer connections

### 7.4 systemd Service

Install the systemd unit file:

```bash
sudo cp docker/systemd/coc-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now coc-node
```

Key settings in `coc-node.service`:
- `Restart=always` with `RestartSec=5`
- `LimitNOFILE=65536` for LevelDB
- Environment file: `/etc/coc/node.env`

### 7.5 Nginx Reverse Proxy

```bash
sudo cp docker/nginx/coc-rpc.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/coc-rpc.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Features:
- TLS termination (Let's Encrypt)
- Rate limiting (10 req/s burst 20)
- WebSocket upgrade support
- CORS headers

---

## 8. Smart Contract Deployment

Principle: on-chain settlement and governance are separate from the node process; operators must manage contract lifecycle, network targeting, and verification as distinct steps.
Module / program focus: this chapter covers the Hardhat-based contract toolchain plus the typed deployment helper (`contracts/deploy/deploy-pose.ts`) that resolves preset L1/L2 parameters for PoSeManagerV2 automation.

### Build

```bash
cd contracts
npm install
npm run compile
```

### Local Deployment

```bash
npm run deploy:local
```

### PoSeManagerV2 Deployment

```bash
# Local PoSe deployment via the packaged Hardhat script
npm run deploy:local

# Governance deployment against the "prowl" network configured in Hardhat
npm run deploy:governance
```

`contracts/deploy/deploy-pose.ts` is a programmatic deployment helper, not a standalone Hardhat task in this repository. It provides validated preset targets for automation/tests:

- `l1-mainnet`
- `l1-sepolia`
- `l2-coc`
- `l2-arbitrum`
- `l2-optimism`

### Governance Contract

```bash
npx hardhat run scripts/deploy-governance.js --network prowl
```

### Verify PoSe Contract

```bash
npm run verify:pose
```

### Hardhat Configuration

```
Solidity: 0.8.24
Hardhat script networks:
  hardhat   -> in-memory local chain
  localhost -> local JSON-RPC endpoint
  prowl     -> PROWL_RPC_URL || http://127.0.0.1:18780
               PROWL_CHAIN_ID || 20241224
```

---

## 9. Explorer Setup

Principle: the explorer is a read-oriented client over RPC and WebSocket endpoints; it should never be treated as an authoritative source independent of chain data.
Module / program focus: this chapter covers the Next.js explorer, which renders chain state, indexed views, analytics, and contract verification against a live COC node.

### Development

```bash
cd explorer
npm install
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:18780 \
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:18781 \
npm run dev
```

Default: http://localhost:3000

### Production

```bash
cd explorer
npm run build
NEXT_PUBLIC_RPC_URL=http://your-rpc-endpoint:18780 \
npm start
```

### Pages

| Path | Description |
|------|-------------|
| `/` | Dashboard — chain stats, latest blocks, real-time updates |
| `/block/[id]` | Block detail — transactions, gas, proposer, stateRoot |
| `/tx/[hash]` | Transaction detail — receipt, logs, token transfers, traces |
| `/address/[addr]` | Address — balance, transaction history, contract metadata |
| `/mempool` | Mempool — pending/queued transactions, sorting, filtering |
| `/validators` | Validators — stake, voting power, status |
| `/stats` | Analytics — TPS trend, gas usage charts |
| `/contracts` | Contract registry — indexed lookup, pagination |
| `/network` | Network info — node info, connection endpoints |
| `/verify` | Contract verification — solc-js source verification |

---

## 10. Wallet CLI

Principle: signing and custody should remain separate from node execution, so wallet operations can be audited and rotated independently of validator or relayer processes.
Module / program focus: this chapter covers `wallet/coc-wallet.ts`, a lightweight operator CLI for keystore management, balance inspection, transfers, and nonce/receipt queries.

### Usage

```bash
# Create a new wallet
node --experimental-strip-types wallet/coc-wallet.ts create [--password <pwd>]

# Import from private key or mnemonic
node --experimental-strip-types wallet/coc-wallet.ts import <key-or-mnemonic> [--password <pwd>]

# Check balance
node --experimental-strip-types wallet/coc-wallet.ts balance <address> [--rpc <url>]

# Send ETH
node --experimental-strip-types wallet/coc-wallet.ts send <from> <to> <amount-in-eth> [--rpc <url>]

# Query transaction
node --experimental-strip-types wallet/coc-wallet.ts tx <hash> [--rpc <url>]

# Get nonce
node --experimental-strip-types wallet/coc-wallet.ts nonce <address> [--rpc <url>]
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `COC_RPC_URL` | `http://127.0.0.1:18780` | RPC endpoint |
| `COC_WALLET_PASSWORD` | `coc-default-password` | Keystore password fallback (change this in real environments) |

Keystore location: `~/.coc/keystore/{address}.json`

---

## 11. PoSe Service Layer

Principle: PoSe is an off-chain service pipeline around challenge issuance, receipt verification, evidence persistence, reward manifest generation, and settlement coordination.
Module / program focus: this chapter covers the runtime programs that implement that pipeline: `coc-node`, `coc-agent`, `coc-relayer`, and `coc-reward-claim`.

### 11.1 coc-node (PoSe Endpoints)

Principle: `coc-node` is a lightweight PoSe-facing HTTP service that signs challenge receipts and witness attestations; it is not the full blockchain node.
Module / program focus: this program exposes challenge/receipt APIs for test and runtime integration, plus a minimal service-local health endpoint.

The PoSe runtime service exposes these HTTP endpoints:

```bash
COC_DATA_DIR=/data/coc \
COC_NODE_PK=0x... \
  node --experimental-strip-types runtime/coc-node.ts
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/pose/challenge` | POST | Submit challenge (v1 EIP-191 / v2 EIP-712) |
| `/pose/receipt` | POST | Submit receipt |
| `/pose/witness` | POST | Witness attestation (v2 only) |

Note: `runtime/coc-node.ts` returns a lightweight service-local health payload (`{"ok":true,"ts":...}`) on `/health`; chain height and peer status should still be checked through node RPC or the metrics server.

### 11.2 coc-agent (Challenge & Aggregation)

Principle: the agent is the scoring and evidence producer; it continuously samples target nodes, validates replies, and turns observations into batchable receipts and reward manifests.
Module / program focus: this program drives challenges, verifies receipts, persists evidence/manifests, and prepares data that later feeds relayer settlement.

```bash
COC_NODE_URL=http://127.0.0.1:18780 \
COC_L1_RPC_URL=http://127.0.0.1:8545 \
COC_POSE_MANAGER=0x... \
COC_OPERATOR_PK=0x... \
COC_AGENT_INTERVAL_MS=60000 \
COC_AGENT_BATCH_SIZE=5 \
  node --experimental-strip-types runtime/coc-agent.ts
```

Functions:
- Issues storage challenges to nodes
- Verifies receipts with deterministic scoring
- Aggregates batches and submits to PoSeManager
- Collects witness attestations (v2)
- Persists reward manifests to `{dataDir}/reward-manifests/`
- Tick reentrance guard prevents overlapping cycles

For protocol v2, `coc-agent` also requires `protocolVersion: 2`, `poseManagerV2Address`, and `verifyingContract` in the runtime config file; those settings are config-backed rather than standalone env-only flags.

### 11.3 coc-relayer (Epoch Finalization & Slashing)

Principle: the relayer is the settlement-side coordinator; it turns persisted manifests and evidence into contract calls, while keeping challenge and slash sequencing deterministic.
Module / program focus: this program finalizes epochs, distributes rewards, bridges BFT equivocation evidence into PoSe disputes, and advances the v2 dispute lifecycle.

```bash
COC_L1_RPC_URL=http://127.0.0.1:8545 \
COC_POSE_MANAGER=0x... \
COC_SLASHER_PK=0x... \
COC_RELAYER_INTERVAL_MS=60000 \
  node --experimental-strip-types runtime/coc-relayer.ts
```

Functions:
- Finalizes epochs (v1 and v2)
- Reads reward manifests and submits Merkle roots
- Processes slash evidence from BFT equivocation detection
- Manages v2 dispute lifecycle (commit → reveal → settle)
- Tick reentrance guard

For protocol v2, the relayer also reads `protocolVersion`, `poseManagerV2Address`, `verifyingContract`, and optional `l2RpcUrl` from the runtime config file.

### 11.4 coc-reward-claim (V2 Merkle Claim)

Principle: reward claiming is intentionally separated from reward generation and finalization, so operators can audit proofs before submitting claim transactions.
Module / program focus: this program reads reward manifests, resolves the best available proof (settled manifest first), and submits either v2 Merkle claims or v1 direct reward claims.

```bash
COC_DATA_DIR=/data/coc \
COC_OPERATOR_PK=0x... \
  node --experimental-strip-types runtime/coc-reward-claim.ts --epoch 123 --node-id 0x...
```

For v2, `protocolVersion`, `poseManagerV2Address`, and `rewardManifestDir` are read from the runtime config file. For v1, the same program falls back to `poseManagerAddress` and direct `claimReward(nodeId)`.

### Runtime Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COC_NODE_URL` | `http://127.0.0.1:18780` | COC node RPC |
| `COC_L1_RPC_URL` | `http://127.0.0.1:8545` | Settlement layer RPC |
| `COC_POSE_MANAGER` | (required) | PoSeManager v1 address |
| `COC_OPERATOR_PK` | (required) | Operator private key |
| `COC_OPERATOR_PK_FILE` | (none) | Operator key file path |
| `COC_SLASHER_PK` | (required for relayer) | Slasher private key |
| `COC_SLASHER_PK_FILE` | (none) | Slasher key file path |
| `COC_AGENT_INTERVAL_MS` | 60000 | Agent tick interval |
| `COC_AGENT_BATCH_SIZE` | 5 | Receipts per batch |
| `COC_AGENT_SAMPLE_SIZE` | 2 | Verification sample size |
| `COC_RELAYER_INTERVAL_MS` | 60000 | Relayer tick interval |
| `COC_TX_RETRY_ATTEMPTS` | 2 | Transaction retry count |
| `COC_TX_RETRY_BASE_DELAY_MS` | 250 | Base retry delay |
| `COC_TX_RETRY_MAX_DELAY_MS` | 5000 | Max retry delay |

### V2 Protocol Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `protocolVersion` | 1 | Set to `2` for v2 |
| `poseManagerV2Address` | (none) | PoSeManagerV2 address |
| `challengeBondWei` | `"100000000000000000"` | 0.1 ETH bond |
| `rewardManifestDir` | `{dataDir}/reward-manifests` | Manifest directory |
| `epochNonceStrict` | false | Strict epoch nonce check |
| `insuranceFundAddress` | (none) | Insurance fund address |

---

## 12. Monitoring

Principle: observability should be isolated from the consensus path; metrics collection must help diagnosis without becoming part of block production or settlement correctness.
Module / program focus: this chapter covers the Prometheus/Grafana stack plus the node-side metrics server that exposes `/metrics` and a simple liveness endpoint.

### Prometheus + Grafana Stack

```bash
docker compose -f docker/docker-compose.monitoring.yml up -d
```

| Service | Port | URL |
|---------|------|-----|
| Prometheus | 9090 | http://localhost:9090 |
| Grafana | 3100 | http://localhost:3100 |

### Prometheus Metrics Endpoint

Each node exposes metrics at `http://<host>:<COC_METRICS_PORT>/metrics` (default 9100).

Key metrics:
- `coc_block_height` — current block number
- `coc_tx_pool_size` — mempool transaction count
- `coc_peer_count` — connected P2P peers
- `coc_consensus_state` — consensus engine state
- `coc_bft_height` — BFT finalized height
- `coc_dht_peers` — DHT routing table size

### Grafana Dashboards

| Dashboard | Description |
|-----------|-------------|
| Overview | Block height, TPS, peer count, mempool size |
| Consensus | BFT round timing, finality lag, proposer rotation |
| Network | P2P connections, wire protocol stats, DHT queries |
| Resources | CPU, memory, disk I/O, LevelDB compaction |

### Alert Rules

Alerts are defined in `docker/prometheus/alerts.yml`:

| Alert | Condition |
|-------|-----------|
| BlockProductionStopped | No new blocks for > 30 seconds |
| HighMempoolSize | Mempool > 1000 pending transactions |
| PeerCountLow | Connected peers < 2 |
| DiskSpaceLow | Available disk < 10% |
| HighMemoryUsage | Memory > 90% |
| BftFinalityLag | BFT finalized height > 10 blocks behind |

---

## 13. Health Checks & Status

Principle: health in COC is layered; RPC, metrics, and PoSe service endpoints answer different questions and should not be treated as interchangeable probes.
Module / program focus: this chapter covers operator-facing scripts and RPC calls for the core node, while distinguishing them from the separate `runtime/coc-node.ts` PoSe service.

### Node Status Script

```bash
bash scripts/node-status.sh [rpc-url]
# Default: http://127.0.0.1:18780
```

### RPC Health Methods

```bash
# Block height
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# Chain stats
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_chainStats","params":[],"id":1}'

# BFT status
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_getBftStatus","params":[],"id":1}'

# Network stats
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_getNetworkStats","params":[],"id":1}'

# Peer count
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}'
```

### Health Endpoints by Component

```bash
# Core node metrics server
curl -s http://127.0.0.1:9100/health
# Returns: ok

# PoSe runtime service (runtime/coc-node.ts)
curl -s http://127.0.0.1:18780/health
# Returns: {"ok":true,"ts":...}
```

Use JSON-RPC methods such as `eth_blockNumber`, `coc_chainStats`, and `coc_getNetworkStats` for chain health. Use `/health` only as a liveness probe for the specific HTTP service that exposes it.

---

## 14. Backup & Restore

Principle: recoverability depends on preserving both state and identity; backing up data without keys or config is not enough to restore an operator safely.
Module / program focus: this chapter covers the backup/restore scripts that archive node state, peer metadata, reward manifests, and local evidence files.

### Backup

```bash
bash scripts/backup-node.sh [data-dir] [backup-dir]
# Default data-dir: ~/.clawdbot/coc
# Default backup-dir: ./backups/
```

Backs up:
- `leveldb/` — chain state database
- `storage/` — IPFS block store
- `node-config.json` — configuration
- `node-key` — node identity
- `peers.json` — peer cache
- `reward-manifests/` — reward data
- `evidence/` — slash evidence

### Restore

```bash
bash scripts/restore-node.sh <backup-archive> [data-dir]
```

**Important**: Stop the node before restoring. The restore script will:
1. Verify backup integrity
2. Refuse to continue if a node process still appears to be running
3. Replace data directory contents with the archived snapshot

It does not automatically stop the service or run a separate LevelDB repair pass.

### Manual Backup

```bash
# Stop node first
systemctl stop coc-node

# Archive data directory
tar czf coc-backup-$(date +%Y%m%d).tar.gz -C ~/.clawdbot coc/

# Restart
systemctl start coc-node
```

---

## 15. Quality Gate

Principle: operational changes should be gated by tests from the affected layer, because COC spans node, services, runtime, contracts, explorer, and extensions.
Module / program focus: this chapter maps the quality-gate script to the underlying test suites so operators can choose between full validation and targeted reruns.

### Run Full Test Suite

```bash
bash scripts/quality-gate.sh
```

### Test Breakdown (1409 tests, 140 files)

| Layer | Command | Tests |
|-------|---------|-------|
| Node core | `cd node && node --experimental-strip-types --test --test-force-exit src/*.test.ts src/**/*.test.ts` | 839 |
| Services + NodeOps | `node --experimental-strip-types --test --test-force-exit services/**/*.test.ts nodeops/*.test.ts tests/*.test.ts` | 296 |
| Runtime + Wallet | `node --experimental-strip-types --test --test-force-exit runtime/lib/*.test.ts runtime/*.test.ts wallet/coc-wallet.test.ts` | 79 |
| Contracts | `cd contracts && npm test` | 171 |
| Extensions | `cd extensions/coc-nodeops && node --experimental-strip-types --test src/*.test.ts src/**/*.test.ts` | 24 |

### Run Specific Test Layers

```bash
# Node core only
cd node && node --experimental-strip-types --test --test-force-exit \
  src/*.test.ts src/**/*.test.ts

# Contract tests with coverage
cd contracts && npm run coverage:check

# Integration tests
node --experimental-strip-types --test --test-force-exit \
  tests/integration/*.test.ts

# E2E tests
node --experimental-strip-types --test --test-force-exit \
  tests/e2e/*.test.ts
```

---

## 16. Troubleshooting

Principle: troubleshooting should follow system boundaries: process startup, RPC surface, peer network, storage, PoSe runtime, and finally contract settlement.
Module / program focus: this chapter provides operator-oriented diagnosis and recovery steps for the core node, runtime services, explorer, and surrounding infrastructure.

### Common Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| `EADDRINUSE` on startup | Port already in use | `ss -ltnp \| grep <port>` to find process, kill or change port |
| LevelDB `LOCK` error | Previous instance not stopped | Remove `{dataDir}/leveldb/LOCK` or stop the other process |
| LevelDB corruption | Unclean shutdown | Node auto-repairs on startup; or manually: delete `leveldb/` and resync |
| No blocks produced | Single node, BFT enabled with <3 validators | BFT auto-disables with <3 validators; check validator config |
| Peers not connecting | Firewall or wrong P2P port | Check `COC_P2P_PORT`, ensure port is open, verify peer URLs |
| RPC auth rejected | Missing or wrong token | Set `COC_RPC_AUTH_TOKEN` and pass `Authorization: Bearer <token>` header |
| Transaction stuck | Nonce gap or low gas price | Check `eth_getTransactionCount` and `eth_gasPrice`; resubmit with correct nonce |
| PoSe challenge timeout | Node unreachable or slow storage | Check node `/health` endpoint; verify IPFS storage is responsive |
| Agent not submitting batches | Contract not deployed or wrong address | Verify `COC_POSE_MANAGER` address matches deployed contract |
| Relayer finalization fails | Epoch not ready or insufficient gas | Check epoch timing; ensure relayer account has ETH for gas |
| Explorer blank page | Wrong RPC URL | Verify `NEXT_PUBLIC_RPC_URL` points to a running node |
| `--experimental-strip-types` error | Node.js < 22 | Upgrade to Node.js 22+ |
| Wire handshake timeout | Peer unreachable or version mismatch | Check wire port connectivity; verify both peers run same version |
| DHT lookup fails | No bootstrap peers | Ensure `dnsSeeds` or `bootstrapPeers` configured |
| Snap sync stuck | Peer height too far ahead | Increase `snapSyncThreshold`; verify peer health |

### Diagnostic Commands

```bash
# Check listening ports
ss -ltnp | grep -E '(18780|18781|19780|19781|5001|9100)'

# View node logs (systemd)
journalctl -u coc-node -f --no-pager

# Check disk usage
du -sh ~/.clawdbot/coc/leveldb/

# Test RPC connectivity
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq .

# Check process resource usage
ps aux | grep 'node.*index.ts'

# View devnet node logs
tail -f /tmp/coc-devnet-*/node-*.log
```

### Recovery Procedures

**Stuck chain (no new blocks):**
1. Check consensus state: `coc_chainStats` RPC
2. Verify validator set: `/validators` in explorer
3. If BFT stuck: restart nodes to clear BFT round state
4. If single node: check disk space and LevelDB health

**Data corruption:**
1. Stop node
2. Back up current `leveldb/` directory
3. Delete `leveldb/` and restart — node will resync from peers
4. Or restore from backup: `bash scripts/restore-node.sh <archive>`

**Key compromise:**
1. Immediately stop the compromised node
2. Generate new keys: `bash scripts/generate-validator-keys.sh 1`
3. Update governance to deactivate old validator
4. Deploy new node with fresh keys
5. Review slash evidence for unauthorized actions

---

*Generated for COC (ChainOfClaw) — last updated 2026-03-09*
