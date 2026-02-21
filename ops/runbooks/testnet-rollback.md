# Prowl Testnet Rollback Runbook

## When to Rollback

- Consensus bug causing persistent fork or stall
- Critical security vulnerability requiring immediate node downgrade
- Data corruption affecting chain integrity
- Failed upgrade that breaks RPC or P2P

## Pre-Rollback Checklist

- [ ] Confirm all nodes are affected (not just one)
- [ ] Take state snapshots from each node before rollback
- [ ] Notify team via on-call channel
- [ ] Document the issue triggering rollback

## Rollback Procedures

### Procedure A: Docker Image Rollback

For Docker-deployed testnet nodes:

```bash
# 1. Stop all nodes
docker compose -f docker/docker-compose.yml down

# 2. Update image tag to previous version
# Edit docker/docker-compose.yml: image: coc-node:TAG → coc-node:PREVIOUS_TAG

# 3. Restart with previous version
docker compose -f docker/docker-compose.yml up -d

# 4. Verify
bash scripts/node-status.sh http://127.0.0.1:18780
```

### Procedure B: Binary Rollback (Bare Metal)

```bash
# 1. Stop node processes
bash scripts/stop-devnet.sh

# 2. Checkout previous known-good commit
git checkout PREVIOUS_COMMIT_SHA

# 3. Reinstall dependencies
npm install

# 4. Restart
bash scripts/start-devnet.sh 3
```

### Procedure C: State Snapshot Recovery

When chain data is corrupted:

```bash
# 1. Stop the affected node
docker stop coc-node-N

# 2. Export snapshot from a healthy node
curl -s http://HEALTHY_NODE:19780/p2p/state-snapshot > /tmp/coc-state-snapshot.json

# 3. Clear corrupted data
rm -rf /data/coc-node-N/leveldb

# 4. Start node (it will sync from peers or import snapshot)
docker start coc-node-N

# 5. Verify sync progress
watch -n 5 'bash scripts/node-status.sh http://NODE_N:18780'
```

### Procedure D: Genesis Reset (Last Resort)

Complete network reset. Only when chain state is unrecoverable:

```bash
# 1. Stop all nodes
docker compose -f docker/docker-compose.yml down

# 2. Clear all node data
for i in 1 2 3; do
  rm -rf /data/coc-node-$i/leveldb
  rm -rf /data/coc-node-$i/peers.json
done

# 3. Regenerate configs if needed
bash scripts/generate-genesis.sh 3 configs/prowl-testnet

# 4. Restart fresh
docker compose -f docker/docker-compose.yml up -d

# 5. Verify genesis block
curl -s http://127.0.0.1:18780 -X POST \
  -H 'content-type:application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x0",false]}'
```

## Post-Rollback Verification

```bash
# 1. All nodes responsive
for port in 18780 18781 18782; do
  bash scripts/node-status.sh http://127.0.0.1:$port
done

# 2. Block production resumed
sleep 30
curl -s http://127.0.0.1:18780 -X POST \
  -H 'content-type:application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

# 3. Peers connected
curl -s http://127.0.0.1:18780 -X POST \
  -H 'content-type:application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"net_peerCount","params":[]}'

# 4. Metrics endpoint healthy
curl -s http://127.0.0.1:9100/metrics | grep coc_block_height
```

## Rollback Decision Matrix

| Scenario | Procedure | Downtime |
|----------|-----------|----------|
| Bad code deploy | A or B | ~5 min |
| Single node corruption | C | ~10 min |
| Network-wide corruption | D | ~30 min |
| Security emergency | A + firewall | ~5 min |

## Drill Schedule

- Monthly: Procedure A drill (Docker rollback)
- Quarterly: Procedure C drill (Snapshot recovery)
- Pre-launch: Full Procedure D drill (Genesis reset)

## Drill Record

| Date | Procedure | Duration | Issues | Operator |
|------|-----------|----------|--------|----------|
| _TBD_ | _A_ | _min_ | _None_ | _Name_ |
