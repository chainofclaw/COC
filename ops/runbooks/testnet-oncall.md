# Prowl Testnet On-Call Runbook

## Quick Reference

| Service | Port | Health Check |
|---------|------|-------------|
| RPC | 18780 | `curl -s http://HOST:18780 -X POST -H 'content-type:application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` |
| P2P | 19780 | `curl -s http://HOST:19780/p2p/node-info` |
| WebSocket | 18781 | `wscat -c ws://HOST:18781` |
| Wire | 19781 | TCP connection check: `nc -zv HOST 19781` |
| Metrics | 9100 | `curl -s http://HOST:9100/metrics` |

## Triage Flowchart

```
Alert received
  ├── NodeDown → Section 1
  ├── BlockProductionStalled → Section 2
  ├── ConsensusStateDegraded → Section 3
  ├── HighAuthRejections → Section 4
  ├── EquivocationDetected → Section 5
  └── Other → Section 6
```

## 1. Node Down

**Symptoms**: Prometheus `up == 0`, RPC unreachable.

**Steps**:
1. SSH to the affected node host.
2. Check process status: `docker ps | grep coc-node` or `pgrep -f "node/src/index.ts"`.
3. Check system resources: `free -h`, `df -h`, `dmesg | tail`.
4. Review logs: `docker logs coc-node-N --tail 200` or `journalctl -u coc-node -n 200`.
5. Restart if OOM or crash: `docker restart coc-node-N`.
6. Verify recovery: `bash scripts/node-status.sh http://HOST:18780`.

**Escalation**: If node fails to restart after 2 attempts, escalate to Core Node Lead.

## 2. Block Production Stalled

**Symptoms**: `coc_block_height` not increasing for 5+ minutes.

**Steps**:
1. Check consensus state: `curl ... coc_getNetworkStats`.
2. Check peer connectivity: `curl ... net_peerCount`.
3. If all nodes stalled: check BFT round status via `coc_getBftStatus`.
4. If single node: check if it's the proposer in current rotation.
5. Check mempool: `curl ... coc_mempoolStats` (empty mempool = normal if no transactions).
6. Force restart consensus: restart the affected node.

## 3. Consensus Degraded

**Symptoms**: `coc_consensus_state != 0` for 5+ minutes.

**Steps**:
1. Check which state: `0=healthy, 1=degraded, 2=recovering`.
2. If `degraded`: node is producing blocks locally but sync is failing.
3. Check peer heights: compare `eth_blockNumber` across all nodes.
4. If height gap > 5: trigger snap sync by restarting the lagging node.
5. Monitor recovery: consensus should auto-recover to `healthy` once synced.

## 4. High Auth Rejections

**Symptoms**: `coc_p2p_auth_rejected_total` rising rapidly.

**Steps**:
1. Check network stats: `curl ... coc_getNetworkStats` → review `authRejected` counts.
2. Identify source IPs: check node logs for rejected auth attempts.
3. If from known validator: check clock sync (`ntpq -p`); clock skew > 30s causes auth failures.
4. If from unknown IPs: potential attack. Monitor but rely on rate limiting.
5. Temporary mitigation: if overwhelming, add source IPs to firewall blocklist.

## 5. Equivocation Detected

**Symptoms**: Alert fires immediately on any equivocation.

**Steps**:
1. This is critical: a validator double-voted.
2. Check BFT status: `curl ... coc_getBftStatus` → `equivocations` field.
3. Identify the validator from logs.
4. Slashing should be automatic via BftSlashingHandler.
5. Verify slash applied: check validator stake via `coc_getValidators`.
6. If validator removed: verify network still has 2/3+ quorum for BFT.
7. Document the incident for post-mortem.

## 6. General Troubleshooting

**Check node status**:
```bash
bash scripts/node-status.sh http://HOST:18780
```

**Check all nodes**:
```bash
for port in 18780 18781 18782; do
  echo "=== Node on port $port ==="
  bash scripts/node-status.sh http://HOST:$port
done
```

**Check Docker containers**:
```bash
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --tail 50
```

## Escalation Matrix

| Severity | Response Time | Escalation |
|----------|-------------|------------|
| Critical (NodeDown, Equivocation) | 15 min | Core Node Lead + Security Lead |
| Warning (Degraded, HighAuth) | 1 hour | SRE Lead |
| Info (Low peers, slow blocks) | Next business day | DevOps |
