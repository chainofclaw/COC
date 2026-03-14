# Prowl Testnet Plan

**Testnet Name**: Prowl (潜行)
**Chain ID**: 18780
**Launch Strategy**: Invited beta (10-20 nodes) → Public testnet

## Overview

COC Prowl Testnet is the first public test network for the ChainOfClaw blockchain. It provides a production-like environment for testing EVM compatibility, BFT consensus, PoSe storage challenges, and peer discovery.

## Infrastructure

### Containers (docker/)
| Service | Dockerfile | Port |
|---------|-----------|------|
| Node | `Dockerfile.node` | 18780 (RPC), 18781 (WS), 19780 (P2P), 19781 (Wire), 9100 (Metrics) |
| Runtime | `Dockerfile.runtime` | 9200 (agent metrics, optional) |
| Explorer | `Dockerfile.explorer` | 3000 |
| Website | `Dockerfile.website` | 3001 |
| Faucet | `Dockerfile.faucet` | 3003 |

### Compose Files
- `docker-compose.yml` — Single-node full stack
- `docker-compose.testnet.yml` — 3-node BFT testnet, with optional `pose` profile for `agent` and `relayer`
- `docker-compose.monitoring.yml` — Prometheus + Grafana, attached to the shared `docker_coc-rpc` network

### Monitoring
- Prometheus scrapes `/metrics` on port 9100
- Prometheus uses `ops/alerts/prometheus-rules.yml` as the active alert ruleset
- Grafana dashboard: block height, consensus, mempool, network, memory
- 15 Prometheus metrics covering chain, consensus, network, and process stats

### Genesis & Keys
- `scripts/generate-genesis.sh` — Generate genesis configuration
- `scripts/setup-boot-nodes.sh` — Generate `boot-nodes.json` + `dht-seeds.json` for validator onboarding
- `scripts/generate-validator-keys.sh` — Generate N validator key pairs
- Canonical output: `configs/prowl-testnet/` (genesis.json, validator-N.env, validators.json, boot-nodes.json, dht-seeds.json)

### Operations
- `scripts/backup-node.sh` — LevelDB snapshot backup (tar.gz)
- `scripts/restore-node.sh` — Restore from backup
- `scripts/node-status.sh` — Query node status via RPC
- `docker/systemd/` — systemd service templates for `coc-node`, `coc-agent`, `coc-relayer`, `coc-explorer`
- `docker/nginx/coc-rpc.conf` — Reverse proxy with rate limiting

### CI/CD
- `.github/workflows/test.yml` — PR test gate (repo quality gate + workspace suites)
- `.github/workflows/build-images.yml` — Docker image build on tag push
- `.github/workflows/testnet-deploy.yml` — Manual testnet deployment using `IMAGE_TAG`

## Deployment Timeline

### Phase 1: Invited Beta (2 weeks)
- Week 1: Docker + Monitoring + Genesis generation
- Week 2: Faucet + Operations tools + Documentation
- Milestone: 10-20 node internal testnet

### Phase 2: Public Testnet (2 weeks)
- Week 3: CI/CD + Stress testing + Security audit
- Week 4: Public registration + Community docs
- Milestone: Public testnet with 50-100 nodes

## Quick Start

```bash
# Generate genesis for 10 validators
bash scripts/generate-genesis.sh 10

# Start single-node stack
docker compose -f docker/docker-compose.yml up -d

# Start 3-node testnet
docker compose -f docker/docker-compose.testnet.yml up -d

# Add monitoring
docker compose -f docker/docker-compose.monitoring.yml up -d

# Add PoSe runtime sidecars
docker compose -f docker/docker-compose.testnet.yml --profile pose up -d

# Check metrics
curl http://localhost:9101/health
```

## Network Parameters

| Parameter | Value |
|-----------|-------|
| Chain ID | 18780 |
| Block Time | 3 seconds |
| Consensus | BFT (2/3 stake quorum) |
| Finality Depth | 3 blocks |
| Max TX/Block | 100 |
| PoSe Epoch | 1 hour |
| Transport | HTTP gossip + TCP wire protocol |
| Discovery | Kademlia DHT |

## Wallet and Toolchain Quick Connect

### MetaMask

Use the following network parameters:

| Field | Value |
|-------|-------|
| Network Name | `COC Prowl` |
| RPC URL | `http://127.0.0.1:18780` or the public Prowl RPC endpoint |
| Chain ID | `18780` |
| Currency Symbol | `ETH` |
| Block Explorer URL | `http://127.0.0.1:3000` or the public Explorer URL |

Notes:

- Prefer externally signed transactions via `eth_sendRawTransaction`.
- `eth_sendTransaction` is a dev-account convenience path, not the production submission path.
- `pending`, `safe`, and `finalized` tags are part of the supported testnet compatibility surface.

### Foundry

Minimal `foundry.toml` snippet:

```toml
[rpc_endpoints]
prowl = "http://127.0.0.1:18780"
```

Useful `cast` commands:

```bash
cast chain-id --rpc-url http://127.0.0.1:18780
cast block latest --rpc-url http://127.0.0.1:18780
cast balance 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:18780
cast send 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  --value 1wei \
  --private-key "$PRIVATE_KEY" \
  --rpc-url http://127.0.0.1:18780
```

Current testnet boundary:

- Type-3 blob transactions are explicitly unsupported.
- Cancun-era header and blob-gas fields are exposed, but Prowl should not yet be described as supporting full blob transaction flow.

### Hardhat

Minimal `hardhat.config.ts` network snippet:

```ts
networks: {
  prowl: {
    url: "http://127.0.0.1:18780",
    chainId: 18780,
    accounts: [process.env.PRIVATE_KEY ?? ""],
  },
}
```

Recommended usage:

- Prefer `ethers` signer flows that end in `eth_sendRawTransaction`.
- Do not rely on `eth_sendTransaction` unless `COC_DEV_ACCOUNTS=1` is deliberately enabled for a local dev node.

## EVM Compatibility Rollout Checklist

Use this checklist before promoting an image tag onto shared Prowl validators or public RPC nodes.

### 1. Local Regression Gate

Run the core compatibility suites:

```bash
node --experimental-strip-types --test \
  node/src/blob-gas.test.ts \
  node/src/cancun-compat.test.ts \
  node/src/rpc-semantic-compat.test.ts \
  node/src/rpc-debug-compatibility.test.ts \
  node/src/wallet-toolchain-compat.test.ts
```

Expected result:

- All tests pass.
- `parentBeaconBlockRoot` behavior stays wired through execution, replay, and empty-block paths.
- `pending`, `safe`, and `finalized` semantics stay stable.

### 2. RPC Smoke Gate

Confirm the node exposes the expected chain and fee surface:

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'

curl -s -X POST http://127.0.0.1:18780 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"eth_blobBaseFee","params":[]}'

curl -s -X POST http://127.0.0.1:18780 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":3,"method":"eth_getBlockByNumber","params":["latest",false]}'
```

Expected result:

- `eth_chainId = 0x495c`
- `eth_blobBaseFee` returns a non-zero spec-aligned minimum such as `0x1`
- Latest block response includes `blobGasUsed`, `excessBlobGas`, and `parentBeaconBlockRoot`

### 3. Finality and Pending Gate

Check block-tag semantics against a node that already has several blocks:

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":4,"method":"eth_getBlockByNumber","params":["latest",false]}'

curl -s -X POST http://127.0.0.1:18780 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":5,"method":"eth_getBlockByNumber","params":["finalized",false]}'

curl -s -X POST http://127.0.0.1:18780 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":6,"method":"eth_getTransactionCount","params":["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","pending"]}'
```

Expected result:

- `finalized.number < latest.number` once the chain is deeper than `finalityDepth`
- `pending` nonce reflects mempool-aware sequencing rather than only on-chain nonce

### 4. Trace and Historical Read Gate

Run against a debug-enabled archive-capable node:

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":7,"method":"debug_traceBlockByNumber","params":["finalized",{"tracer":"callTracer"}]}'

curl -s -X POST http://127.0.0.1:18780 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":8,"method":"trace_replayBlockTransactions","params":["finalized",["trace"]]}'
```

Expected result:

- Both methods accept `finalized`
- Returned traces point to the finalized block, not the latest head
- If `COC_DEBUG_RPC` is disabled, the node should reject with method-disabled errors rather than partial payloads

### 5. Wallet / SDK Gate

Validate at least one real client path before rollout:

- MetaMask: add the network, read balance, and send one externally signed transaction
- Foundry: `cast chain-id`, `cast block latest`, `cast send`
- Hardhat or ethers: deploy a trivial contract and verify `eth_getCode` is non-empty

## Rollout Decision

Promote a build only when all of the following hold:

- Regression suites are green
- RPC smoke checks match the expected values above
- Wallet / SDK smoke checks succeed without local patches
- Release notes clearly state that blob/type-3 transactions remain unsupported
