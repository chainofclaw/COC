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
