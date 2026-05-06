# Native Deployment — Phase N

**Status**: Phase N runbook for migrating the 3 Prowl testnet validators
from Docker containers to native systemd services on the same Linux host.
The sync-node, relayer, agent, faucet, and explorer remain in Docker,
plus 1-2 light docker peers (Phase D1) join the cluster as 200MB-capped
observers.

**When to run this**: only after the in-flight 24h soak completes and the
maintainer has reviewed `docs/soak-reports/<runId>.md` for the current
docker baseline. Migration without that baseline destroys the comparison
data.

## Architecture target

```
Host: 199.192.16.79 (clawchain-server)
├── systemd (Phase N1) — native validators on host network
│   ├── coc-node@1.service  → /var/lib/coc/node-1
│   │   RPC 28780 · WS 28781 · P2P 29780 · Wire 29781 · IPFS 28786 · /metrics 9101
│   ├── coc-node@2.service  → /var/lib/coc/node-2
│   │   RPC 28782 · WS 28783 · P2P 29782 · Wire 29783 · /metrics 9102
│   └── coc-node@3.service  → /var/lib/coc/node-3
│       RPC 28784 · WS 28785 · P2P 29784 · Wire 29785 · /metrics 9103
└── docker
    ├── coc-sync-node       host RPC 18780 · WS 18781 · P2P 19880 · Wire 19881 · /metrics 9104
    ├── coc-relayer / coc-agent  → host.docker.internal:28780 (validator-1 RPC)
    ├── coc-faucet / coc-explorer
    ├── coc-light-1 (D1)    tmpfs /data/coc/blocks=200m, NODE_MODE=light
    └── coc-light-2 (D1, optional)
```

**External port preservation guarantee**: every external (host-side) port
listed above is identical to the current `docker-compose.testnet.yml`
mapping. Operators, monitoring scrape config (`docker/prometheus/
prometheus.yml`), explorer URLs, faucet endpoints, and DNS records can
stay untouched. The native validators simply bind these ports directly
on `0.0.0.0` instead of going through the docker NAT.

The native validators bind `0.0.0.0` so docker peers reach them via
`host.docker.internal:<port>`. Each docker container that needs
host-network reach has an `extra_hosts: ["host.docker.internal:host-gateway"]`
entry (added at deploy time).

## Pre-flight checklist

- [ ] 24h soak complete; `docs/soak-reports/<runId>.md` archived.
- [ ] Phase J/M images deployed (`coc-node:phase-j-local-m1`).
- [ ] Server has `node` 22+ at `/usr/bin/node`. Verify:
      `node --version` from the `coc` user.
- [ ] `coc:coc` system user/group exists; create if missing:
      `useradd --system --home /var/lib/coc --shell /usr/sbin/nologin coc`
- [ ] Disk space: `df -h /var/lib/coc` shows ≥60GB free per validator
      (50GB archive cap + 10GB headroom).
- [ ] Repo at `/opt/coc` (clone or rsync from this checkout); `git status`
      clean; `coc:coc` owns it.

## Migration steps (per validator, gradual)

The migration moves one validator at a time. Quorum needs 2/3, so we can
afford one offline at a time. Total expected disruption: ~30s per
validator while the docker container stops and the systemd service
starts. Multiply ×3 = 90s of total reduced-quorum time, never below
quorum.

### 1. Stage artifacts on server

From a workstation with this checkout:

```bash
# Systemd template + envs
scp docker/systemd/coc-node@.service                root@host:/etc/systemd/system/
scp docker/systemd/native-env/node-{1,2,3}.env      root@host:/etc/coc/
scp docker/systemd/native-configs/node-{1,2,3}.json root@host:/etc/coc/

# Repo at /opt/coc (one-time)
rsync -avz --delete --exclude .git --exclude node_modules ./ root@host:/opt/coc/
```

On the server:

```bash
sudo chown -R coc:coc /etc/coc /opt/coc /var/log/coc
sudo mkdir -p /var/lib/coc/{node-1,node-2,node-3}
sudo chown -R coc:coc /var/lib/coc
sudo systemctl daemon-reload
```

### 2. Per-validator: drain → migrate → start native

Run for **each N in 1, 2, 3**, waiting 30s + chain-progress check between
iterations.

```bash
N=1   # then 2, then 3

# 1) Stop the docker container with grace period
docker stop coc-node-${N}

# 2) Copy LevelDB + IPFS blockstore from docker volume to host fs
sudo cp -a /var/lib/docker/volumes/docker_node${N}-data/_data/. /var/lib/coc/node-${N}/
sudo chown -R coc:coc /var/lib/coc/node-${N}/

# 3) Sanity-check the tip block was preserved
sudo -u coc ls /var/lib/coc/node-${N}/leveldb-chain/ | wc -l   # >0

# 4) Start the native service
sudo systemctl enable --now coc-node@${N}.service
sudo systemctl status coc-node@${N}.service                    # active (running)

# 5) Verify chain progression for ~30s on the canonical external port
#    (28780 for N=1, 28782 for N=2, 28784 for N=3)
PORT=$(( 28780 + (N - 1) * 2 ))
for i in 1 2 3; do
  curl -sS -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
       -H 'Content-Type: application/json' http://localhost:${PORT}/
  sleep 10
done

# 6) Verify Prometheus metrics endpoint (9101/9102/9103 unchanged)
curl -s http://localhost:910${N}/metrics | grep -E '^coc_block_height '
```

Stop here if step 5 doesn't show monotonic growth — see the rollback
section. Otherwise repeat for the next N.

### 3. Adapt sync-node + relayer + agent

After all 3 validators are native, the docker peers must reach them via
the host network instead of docker DNS. Add to each docker compose
service:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
environment:
  - COC_BOOTSTRAP_PEERS=http://host.docker.internal:29780,http://host.docker.internal:29782,http://host.docker.internal:29784
  - COC_RELAYER_RPC_URL=http://host.docker.internal:28780
```

The exact env var names depend on each service's config; the
`docker-compose.testnet.yml` patch is part of the same Phase N commit.

Restart the affected services:

```bash
docker compose -f docker/docker-compose.testnet.yml up -d --no-deps \
  sync-node relayer agent faucet explorer
```

### 4. Bring up Phase D1 light peer

```bash
docker compose -f docker/docker-compose.light.yml up -d light-1
sleep 60
docker exec coc-light-1 du -sh /data/coc/blocks   # ≤200M
```

### 5. Final verification

```bash
# Heights match across native + sync-node (docker) + light-1 (docker)
for p in 28780 28782 28784 18780 38780; do
  curl -sS -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
       -H 'Content-Type: application/json' http://localhost:$p/ | jq -r .result
done

# All three validators emit M1 metrics
for p in 9101 9102 9103; do
  curl -s http://localhost:$p/metrics | \
    grep -E '^coc_(bft_equivocations_total|fork_choice_max_depth_blocks) ' || echo "MISSING $p"
done

# Light peer respects 200MB cap
docker exec coc-light-1 du -sh /data/coc /data/coc/blocks
```

## Rollback

If a native validator fails to advance the chain or crashes-on-restart:

```bash
N=1   # the broken one

sudo systemctl stop coc-node@${N}.service
sudo systemctl disable coc-node@${N}.service

# Original docker volume is untouched. Restart the docker container.
docker start coc-node-${N}

# Wait 30s, verify chain advances, escalate to maintainer.
```

The migration is reversible per-validator; native artifacts in
`/var/lib/coc/node-N/` can be deleted (or kept for forensics) once the
docker container is healthy again.

## Long-term ops

- **Logs**: `journalctl -u coc-node@1.service -f` (also written to
  `/var/log/coc/node-1.log` per unit config).
- **Restart**: `sudo systemctl restart coc-node@1`.
- **Disk usage**: `du -sh /var/lib/coc/node-1` should plateau at the
  archive workload (~5-30GB depending on tx volume); add 50GB cap
  enforcement via filesystem quota if needed.
- **Light peer storage cap**: observed via
  `coc_ipfs_repo_size_bytes` (Phase S follow-up — until then, `du -sh`
  inside the container).
- **Image rebuild**: light peers run the docker image; rebuild on every
  Phase J/M/P deploy. Native validators run `node` against
  `/opt/coc/node/src/index.ts` directly — no rebuild step, just rsync
  + `systemctl restart`.
