# Prowl Testnet - Validator Join Guide

## System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 cores | 4 cores |
| RAM | 4 GB | 8 GB |
| Disk | 50 GB SSD | 100 GB NVMe |
| Network | 10 Mbps | 50 Mbps |
| OS | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 |

## Prerequisites

- Node.js 22+ (`node --version` should show v22.x or later)
- Git
- curl

## Step 1: Clone Repository

```bash
git clone https://github.com/chainofclaw/coc.git
cd coc
```

## Step 2: Install Dependencies

```bash
cd node && npm install && cd ..
```

## Step 3: Generate Node Key

```bash
node --experimental-strip-types -e "
import { Wallet } from 'ethers';
const w = Wallet.createRandom();
console.log('Private Key: ' + w.privateKey);
console.log('Address:     ' + w.address);
"
```

Save the private key securely. Share only your **address** with the testnet coordinators.

## Step 4: Configure Node

Create `/etc/coc/node-config.json` (or use `COC_NODE_CONFIG` env var):

```json
{
  "nodeId": "YOUR_ADDRESS",
  "chainId": 18780,
  "rpcBind": "0.0.0.0",
  "rpcPort": 18780,
  "p2pBind": "0.0.0.0",
  "p2pPort": 19780,
  "wsPort": 18781,
  "wirePort": 19781,
  "validators": ["VALIDATOR_LIST_FROM_GENESIS"],
  "peers": [
    {"id": "SEED_NODE_ID", "url": "http://SEED_NODE_IP:19780"}
  ],
  "enableBft": true,
  "enableWireProtocol": true,
  "enableDht": true,
  "enableSnapSync": true,
  "blockTimeMs": 3000,
  "finalityDepth": 3,
  "maxTxPerBlock": 100,
  "prefund": [],
  "dhtBootstrapPeers": [
    {"id": "SEED_NODE_ID", "address": "SEED_NODE_IP", "port": 19781}
  ]
}
```

## Step 5: Start Node

### Option A: Direct

```bash
export COC_NODE_KEY="0xYOUR_PRIVATE_KEY"
export COC_DATA_DIR=/var/lib/coc
export COC_NODE_CONFIG=/etc/coc/node-config.json
node --experimental-strip-types node/src/index.ts
```

### Option B: Docker

```bash
docker run -d \
  --name coc-node \
  -p 18780:18780 -p 18781:18781 -p 19780:19780 -p 19781:19781 -p 9100:9100 \
  -v /var/lib/coc:/data/coc \
  -v /etc/coc/node-config.json:/data/coc/node-config.json:ro \
  -e COC_NODE_KEY="0xYOUR_PRIVATE_KEY" \
  ghcr.io/chainofclaw/coc-node:latest
```

### Option C: systemd

```bash
sudo cp docker/systemd/coc-node.service /etc/systemd/system/
# Edit the service file to set COC_NODE_KEY
sudo systemctl daemon-reload
sudo systemctl enable --now coc-node
```

## Step 6: Verify Sync

```bash
# Check block height
bash scripts/node-status.sh http://localhost:18780

# Check health
curl http://localhost:18780/health

# Check metrics
curl http://localhost:9100/metrics | grep coc_block_height
```

Your node is synced when its block height matches other nodes.

## Step 7: Register as Validator

Once synced, contact testnet coordinators to be added to the validator set through a governance proposal.

## Step 8: Set Up Monitoring (Optional)

```bash
docker compose -f docker/docker-compose.monitoring.yml up -d
# Grafana: http://localhost:3100 (admin/cocprowl)
```

## Firewall Rules

Open these ports for inbound traffic:

| Port | Protocol | Purpose |
|------|----------|---------|
| 19780 | TCP | P2P gossip |
| 19781 | TCP | Wire protocol |

Optional (for public access):

| Port | Protocol | Purpose |
|------|----------|---------|
| 18780 | TCP | JSON-RPC |
| 18781 | TCP | WebSocket RPC |

## Network Info

| Item | Value |
|------|-------|
| Chain ID | 18780 |
| RPC Endpoint | http://prowl-rpc.chainofclaw.com:18780 |
| WebSocket | ws://prowl-rpc.chainofclaw.com:18781 |
| Block Explorer | https://explorer.chainofclaw.com |
| Faucet | https://faucet.chainofclaw.com |

## FAQ

### 1. Node won't sync
- Verify peers are reachable: `curl http://PEER_IP:19780/p2p/info`
- Check firewall rules allow P2P ports
- Ensure `validators` list matches genesis

### 2. High memory usage
- LevelDB cache can be tuned: set `storage.cacheSize` in config
- Monitor with: `curl http://localhost:9100/metrics | grep coc_process_memory`

### 3. Consensus stuck
- Check `curl http://localhost:9100/metrics | grep coc_consensus_state`
- 0=healthy, 1=degraded, 2=recovering
- Restart node if stuck in degraded for >10 minutes

### 4. How do I get test tokens?
- Visit the faucet at https://faucet.chainofclaw.com
- Enter your wallet address to receive 10 COC per request
- One request per address per day

### 5. Docker container won't start
- Ensure Docker version >= 24.0
- Check if ports are in use: `ss -ltnp | grep 18780`
- Check logs: `docker logs coc-node`

### 6. Cannot connect to seed nodes
- Verify connectivity: `telnet SEED_IP 19780`
- Check DNS resolution
- Try using IP address instead of hostname

### 7. How to upgrade the node?
```bash
# Docker
docker pull ghcr.io/chainofclaw/coc-node:latest
docker stop coc-node && docker rm coc-node
# Re-run docker run command

# Direct
cd coc && git pull && cd node && npm install && cd ..
# Restart node
```

### 8. How to check if my node is validating?
```bash
curl -s http://localhost:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"coc_validators","params":[],"id":1}' | \
  python3 -m json.tool
```

### 9. How to participate in governance voting?
Use the voting script:
```bash
node --experimental-strip-types scripts/vote-proposal.ts \
  --proposal-id <ID> --voter <YOUR_VALIDATOR_ID> --approve
```

### 10. Where is data stored?
- Direct: `$COC_DATA_DIR` (default `/var/lib/coc`)
- Docker: `/data/coc` inside container, mapped to `/var/lib/coc` on host
- Data includes blocks, state, and peer information
