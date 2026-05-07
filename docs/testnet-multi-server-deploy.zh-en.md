# Multi-Server Testnet Deployment Guide / 多服务器试验网部署指南

**Status / 状态**: ready-to-deploy / 待部署 (scripts in repo, no servers yet)

**Supersedes / 取代**: `docs/native-deployment.en.md` (single-host approach)

---

## 1. Why multi-server / 为何要多服务器

The single-host multi-process testnet (3 systemd cores + 4 docker ext on one machine) was used through 2026-04 and early 2026-05. It produced multiple recurring failure modes that **only exist in that topology**:

- Docker custom-bridge network configs broke `host.docker.internal:host-gateway` resolution
- ext docker containers ended up with zero outbound network connectivity ("Network is unreachable" for any external IP)
- `nodeId` derivation diverged between systemd env (`COC_NODE_KEY`) and docker container env, causing ValidatorRegistry rotation mismatches
- BFT 5-of-5 quorum repeatedly failed because validator sets were inconsistent across the systemd/docker boundary
- Real distributed protocol behavior (cross-network latency, NAT traversal, partition tolerance) was never tested

The 2026-05-07 session ended with the testnet on a single validator after 4 hours of failed recovery attempts. The conclusion: single-host multi-process testing actively misled debugging because it produced failure modes that don't exist in real deployment, while hiding the failure modes that do.

**Multi-server topology fixes both**:
- One validator per public IP
- Real network stack
- Failures observable correspond to production failures

---

## 2. Architecture / 架构

```
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│ server-A (e.g. Hetzner)  │  │ server-B (e.g. DO NYC)   │  │ server-C (e.g. Linode JP)│
│                          │  │                          │  │                          │
│  coc-node@1.service      │  │  coc-node@1.service      │  │  coc-node@1.service      │
│  /var/lib/coc/node-1/    │  │  /var/lib/coc/node-1/    │  │  /var/lib/coc/node-1/    │
│                          │  │                          │  │                          │
│  Public TCP:             │  │  Public TCP:             │  │  Public TCP:             │
│   28780/RPC  28781/WS    │  │   28780/RPC  28781/WS    │  │   28780/RPC  28781/WS    │
│   29780/P2P  29781/Wire  │  │   29780/P2P  29781/Wire  │  │   29780/P2P  29781/Wire  │
│   28786/IPFS             │  │   28786/IPFS             │  │   28786/IPFS             │
│                          │  │                          │  │                          │
│  Loopback only:          │  │  Loopback only:          │  │  Loopback only:          │
│   9101/metrics           │  │   9101/metrics           │  │   9101/metrics           │
└──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘
        │                            │                            │
        └─────────── public internet (or WireGuard mesh) ─────────┘

         User nodes (light, dapp, sync) connect from anywhere
```

Each validator binds 0.0.0.0 on its host. Peers discover each other via the
`peers` and `dhtBootstrapPeers` lists in their config — populated by the deploy
script with the other servers' public hostnames or IPs.

---

## 3. Server requirements / 服务器要求

**Per validator host**:
- Ubuntu 22.04 LTS or newer (script tested on 22.04, 24.04)
- 4 CPU, 4GB RAM minimum (8GB recommended for archive mode)
- 60GB SSD minimum (50GB chain data + 10GB headroom)
- Public IPv4 (or routable IPv6 with all peers reachable)
- Open inbound TCP: 22 (ssh), 28780, 28781, 29780, 29781, 28786
- Outbound: unrestricted (or at minimum, the same ports to the other 2 validators)
- Time sync: chrony or systemd-timesyncd (deploy script installs chrony)

**Operator workstation** (not a validator):
- Bash 4+, Node 22+, openssl, ssh client
- Network reachability to all 3 servers (for `scp` and `ssh`)

---

## 4. Pre-deployment / 部署前

### 4.1 Generate keys + genesis on operator workstation

```bash
cd /path/to/COC
./scripts/bootstrap-multi-server-genesis.sh \
  --validator-1-host server-a.example.com \
  --validator-2-host server-b.example.com \
  --validator-3-host server-c.example.com
# Or for dev/throwaway testnet:
./scripts/bootstrap-multi-server-genesis.sh \
  --validator-1-host ... --validator-2-host ... --validator-3-host ... \
  --reuse-anvil-keys
```

This produces in `/tmp/coc-multi-server/`:
- `keys.txt` (chmod 600) — 3 private keys + addresses
- `genesis.json` — chain genesis (identical for all 3)
- `deploy-vars-server-{1,2,3}.sh` — one per server, sourceable

**Security**: the `keys.txt` file contains all 3 private keys. Treat as
secret material. Never commit, never email, prefer `scp` to a tmpfs.

### 4.2 Distribute deploy vars

```bash
scp /tmp/coc-multi-server/deploy-vars-server-1.sh root@server-a.example.com:/root/
scp /tmp/coc-multi-server/deploy-vars-server-2.sh root@server-b.example.com:/root/
scp /tmp/coc-multi-server/deploy-vars-server-3.sh root@server-c.example.com:/root/
```

---

## 5. Deployment / 部署

On **each** server, sequentially (server-A first, then B, then C):

```bash
ssh root@server-a.example.com
source /root/deploy-vars-server-1.sh
bash /opt/coc/scripts/deploy-validator-server.sh
# ... wait for "Deployment complete" message ...
exit
```

Repeat for server-B (instance vars 2) and server-C (instance vars 3).

The script handles:
1. apt install Node 22, git, ufw, chrony
2. Create `coc:coc` system user
3. Clone repo to `/opt/coc`
4. `npm ci` dependencies
5. Render `/etc/coc/node-1.env` and `/etc/coc/node-1.json` from templates
6. Open firewall (only the public ports)
7. Install systemd unit and enable it
8. Verify local RPC + check peer reachability

It is **idempotent** — safe to re-run if interrupted.

---

## 6. Post-deployment verification / 部署后验证

### 6.1 Chain alive

```bash
for HOST in server-a.example.com server-b.example.com server-c.example.com; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "http://$HOST:28780" | grep -oE '"result":"[^"]+"'
done
# All 3 should report the same height (within 1-2 blocks during BFT round)
```

### 6.2 stateRoot consensus

```bash
HEIGHT=0x...  # pick a recent finalized height
for HOST in server-a.example.com server-b.example.com server-c.example.com; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"$HEIGHT\",false],\"id\":1}" \
    "http://$HOST:28780" | grep -oE '"stateRoot":"[^"]+"'
done
# All 3 stateRoots MUST match exactly.
```

### 6.3 IPFS cross-server replication (the key acceptance test)

```bash
SERVER_A=server-a.example.com SERVER_B=server-b.example.com SERVER_C=server-c.example.com \
  bash /opt/coc/scripts/verify-multi-server-ipfs.sh
```

This PUTs 10MB to server-A, waits 15s, then GETs from server-C. If both bytes
match, real cross-network IPFS replication is working.

### 6.4 Send a test transaction

```bash
# From operator workstation (any server's RPC works since gossip propagates)
node /opt/coc/contracts/x2-stake-cores.mjs --send-test-tx \
  --rpc http://server-a.example.com:28780
# Verify same tx receipt visible on server-b RPC within 10s
```

---

## 7. Adding a 4th+ validator / 增加新验证者

For governance-driven validator additions (rather than redeploy):

1. Operator generates a new key + address
2. New server runs `deploy-validator-server.sh` with `INSTANCE_ID=1` (each server has its own instance) but configures the new validator's `peers` list to point at all 3 existing servers
3. Existing 3 validators must add new peer to their `peers` config (rolling restart)
4. If using ValidatorRegistry contract: the new validator stakes via `contracts/x2-stake-cores.mjs`-style script — running cluster picks it up via reader poll without restart

For v1 multi-server testnet, **static `validators` array** is recommended. ValidatorRegistry on-chain governance can be added once the static-validator chain is provably stable.

---

## 8. User node onboarding / 用户节点接入

User-facing light/sync/dapp nodes are out of scope for the validator deploy
script, but the same node code runs them. Minimal config for a user node:

```json
{
  "nodeId": "0xUSER_GENERATED_ADDR",
  "chainId": 18780,
  "rpcBind": "127.0.0.1",
  "rpcPort": 8545,
  "validators": [
    "<canonical 3 validator addresses>"
  ],
  "peers": [
    {"id": "<validator-1-addr>", "url": "http://server-a.example.com:29780"},
    {"id": "<validator-2-addr>", "url": "http://server-b.example.com:29780"},
    {"id": "<validator-3-addr>", "url": "http://server-c.example.com:29780"}
  ],
  "enableBft": false,
  "enableSnapSync": true,
  "nodeMode": "light"
}
```

User node binds RPC to loopback, doesn't propose blocks, snap-syncs from
validators, and serves dapp queries locally.

A future polished onboarding doc is tracked separately. For now, this snippet
+ `node --experimental-strip-types node/src/index.ts` is all that's required.

---

## 9. Troubleshooting / 故障排除

### Validator service won't start
- `systemctl status coc-node@1`
- `tail -100 /var/log/coc/node-1.log`
- Common: missing `COC_NODE_KEY` in env, malformed JSON config

### Chain doesn't advance after deploy
- Confirm all 3 servers can reach each other on TCP 29780, 29781:
  - `nc -zv server-b.example.com 29780` from server-A
- Check `BFT consensus enabled` log line on each server — `validators=3` required
- If `validators` array doesn't match across servers, BFT will fork

### Cross-server IPFS GET fails
- IPFS port 28786 may not be open: `ufw status` should list it
- Replication delay can exceed 15s on slow networks — try 60s
- DHT `findProviders` requires wire connections — see Wire troubleshooting

### Wire connections never establish
- Check `wire client connected` events in logs on each server
- Firewall on TCP 29781 must be open inbound
- `peers[].url` and `dhtBootstrapPeers[].address` must point to the OTHER servers, never self
- Public hostnames must resolve from the validator hosts (test: `getent hosts <peer-host>`)

### Validator key compromise
- Stop the affected validator immediately
- Generate a new key + address
- Update all servers' configs to remove old + add new
- Rolling restart
- For governance-managed sets: call `ValidatorRegistry.requestUnstake(oldAddr)` then `stake(newAddr)`

---

## 10. Cleanup of legacy single-host testnet / 清理旧单机试验网

The 199.192.16.79 deployment is left in place as a reference but is not
operational (forked, partial). Once multi-server is alive:

1. Update explorer / faucet / external clients to point at the new servers
2. Announce migration window
3. Stop systemd services on the old host: `systemctl stop coc-node@{1,2,3}`
4. Optionally archive `/var/lib/coc/` for historical reference
5. Decommission the box

The pre-rollback backup tarballs in `/var/lib/coc/*-pre-rollback-20260507.tgz`
contain the chain history through height 212966; preserve at least one copy if
ValidatorRegistry historical state is needed.
