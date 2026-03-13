# Prowl Testnet - Operations Manual

## Daily Checklist

| Item | Command | Expected |
|------|---------|----------|
| Block height | `bash scripts/node-status.sh` | Increasing |
| Consensus | `curl -s localhost:9100/metrics \| grep coc_consensus_state` | 0 (healthy) |
| Peer count | `curl -s localhost:9100/metrics \| grep coc_peers_connected` | >= 3 |
| Memory | `curl -s localhost:9100/metrics \| grep coc_process_memory` | < 2GB |
| Disk | `df -h /var/lib/coc` | < 80% used |

## Backup Strategy

### Manual Backup

```bash
bash scripts/backup-node.sh /var/lib/coc /backups
```

Output: `/backups/coc-backup-{date}-h{height}.tar.gz`

### Automated Backup (cron)

```bash
# Every 6 hours
0 */6 * * * /opt/coc/scripts/backup-node.sh /var/lib/coc /backups >> /var/log/coc/backup.log 2>&1

# Keep only last 7 days
0 1 * * * find /backups -name "coc-backup-*.tar.gz" -mtime +7 -delete
```

### Restore from Backup

```bash
# Stop the node first
sudo systemctl stop coc-node

# Restore
bash scripts/restore-node.sh /backups/coc-backup-XXXXX.tar.gz /var/lib/coc

# Restart
sudo systemctl start coc-node
```

## Runtime Services

Coordinator-operated testnet services can run alongside validator nodes:

```bash
sudo cp docker/systemd/coc-agent.service /etc/systemd/system/
sudo cp docker/systemd/coc-relayer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now coc-agent coc-relayer
```

Environment files:

- `/etc/coc/coc-agent.env` — `COC_OPERATOR_PK`, optional `COC_CONFIG`
- `/etc/coc/coc-relayer.env` — `COC_SLASHER_PK`, optional `COC_CONFIG`

## Upgrade Procedure

### Rolling Update (zero downtime for the network)

1. Update one node at a time
2. Wait for sync confirmation before updating the next

```bash
# On each node:
cd /opt/coc
git pull origin main
cd node && npm install && cd ..

# Restart
sudo systemctl restart coc-node

# Verify
bash scripts/node-status.sh
```

### Docker Upgrade

```bash
docker compose -f docker/docker-compose.testnet.yml pull
docker compose -f docker/docker-compose.testnet.yml up -d --no-deps node-1
# Wait for sync, then:
docker compose -f docker/docker-compose.testnet.yml up -d --no-deps node-2
docker compose -f docker/docker-compose.testnet.yml up -d --no-deps node-3
```

If the `pose` profile is enabled, roll the sidecars separately after the node tier:

```bash
docker compose -f docker/docker-compose.testnet.yml --profile pose pull
docker compose -f docker/docker-compose.testnet.yml --profile pose up -d --no-deps agent relayer
```

## Failure Recovery

### Consensus Stall

Symptoms: `coc_consensus_state` stays at 1 (degraded)

1. Check if >1/3 of validators are down
2. Restart affected nodes
3. Consensus auto-recovers once quorum is restored

```bash
# Check all nodes
for metrics_port in 9101 9102 9103; do
  echo "Metrics $metrics_port:"
  curl -sf http://localhost:$metrics_port/health
  echo
done

for rpc_port in 28780 28782 28784; do
  echo "RPC $rpc_port:"
  curl -s -X POST http://localhost:$rpc_port \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
  echo
done
```

### Storage Corruption

Symptoms: node crashes on startup with LevelDB errors

1. Stop the node
2. Restore from latest backup
3. Node will sync missing blocks from peers

```bash
sudo systemctl stop coc-node
bash scripts/restore-node.sh /backups/latest-backup.tar.gz /var/lib/coc
sudo systemctl start coc-node
```

### Network Partition

Symptoms: nodes split into groups with different block heights

1. Identify the partition (compare block heights across nodes)
2. Ensure network connectivity between all nodes
3. The fork choice rule will resolve: BFT finality > chain length > weight

### Out of Memory

1. Restart the node
2. Reduce LevelDB cache: set `storage.cacheSize: 500` in config
3. Consider adding swap or upgrading RAM

## Performance Tuning

### LevelDB Cache
```json
{
  "storage": {
    "cacheSize": 2000,
    "backend": "leveldb"
  }
}
```

### P2P Connections
```json
{
  "p2pMaxPeers": 100,
  "p2pRateLimitMaxRequests": 500
}
```

### File Descriptors
```bash
# In systemd service or /etc/security/limits.conf
LimitNOFILE=65535
```

## Monitoring Alerts

### Grafana Alert Rules (suggested)

| Alert | Condition | Severity |
|-------|-----------|----------|
| Node Down | `up == 0` for 2m | Critical |
| Consensus Degraded | `coc_consensus_state > 0` for 5m | Warning |
| High Memory | `coc_process_memory_bytes > 2e9` for 10m | Warning |
| No New Blocks | `delta(coc_block_height[5m]) == 0` | Critical |
| Low Peers | `coc_peers_connected < 2` for 5m | Warning |

The Docker monitoring stack mounts `ops/alerts/prometheus-rules.yml`; keep this file aligned with any separate operational dashboards or hosted Prometheus setup.
