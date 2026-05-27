# 88780 Canary Observability Runbook

> Per-alert SOPs for the canary testnet. Every alert in
> [`ops/alerts/prometheus-rules.yml`](../ops/alerts/prometheus-rules.yml)
> maps to a section in this document. When a pager fires, search for the
> alert name and follow the **First response** sub-section.

[中文版](./observability-runbook-88780.zh.md)

## Operator quick reference

| Layer | Endpoint | Default port |
|---|---|---|
| Prometheus scrape (per node) | `http://<host>:9100/metrics` | 9100 |
| Grafana | configured per deployment | 3000 |
| Alertmanager | configured per deployment | 9093 |

Canonical network parameters: see
[`public-endpoints-88780.md`](./public-endpoints-88780.md). 6 active
validators (v1, v2, v3, v4, v5, obs-1) — BFT quorum requires ≥ 4 active.

## SLO targets

These are the canary SLOs each alert serves (per parent canary-readiness
plan A.1.3):

| SLO | Target | Alert that polices it |
|---|---|---|
| Block production p99 latency | < 10 s | `SlowBlockProduction` (warn @ 5 % > 6 s for 10 m) |
| Validator uptime (rolling 30 d) | ≥ 99.5 % | derived from `NodeDown` + Grafana 30-d panel |
| Mempool acceptance p99 | < 200 ms | indirect — `HighMempoolBacklog` flags backpressure |
| BFT equivocations (rolling 30 d) | 0 | `EquivocationDetected` (fires immediately, severity critical) |
| Active validator count | ≥ 4 | derived from `LowPeerCount` + `coc_validators_active` panel |

## Dashboards

Located in [`docker/grafana/dashboards/`](../docker/grafana/dashboards/).
Import into a fresh Grafana via "Dashboards → Import → JSON". The four
dashboards complement each other:

| Dashboard | Use when |
|---|---|
| `coc-overview.json` | Top-level health: block height, consensus state, peer count, mempool depth. **Start here.** |
| `coc-consensus.json` | BFT round detail: prepare/commit votes, equivocations, validator participation. |
| `coc-network.json` | Topology: HTTP peers, wire connections, DHT nodes, P2P auth rejections. |
| `coc-resources.json` | Process resources: RSS memory, CPU, file descriptors, disk. |

---

# Alert catalogue

Alerts grouped by `prometheus-rules.yml` group. Severity in the heading
matches the alert label.

## Availability group (`coc_availability`)

### `NodeDown` — critical

**Expr**: `up{job="coc-node"} == 0` for 2 m

**Symptom**: Prometheus has been unable to scrape this node's `/metrics`
endpoint for two minutes. Could be process crash, network partition,
firewall change, or the Prometheus scrape config drift.

**Dashboards**: `coc-overview` → "Node up" panel; `coc-resources` →
process panels (will be empty for the down node).

**Diagnosis**:
1. `ssh` to the host and `systemctl status coc-node@<unit>` (validator
   units use `@88` or `@1` depending on host — see
   [`public-endpoints-88780.md`](./public-endpoints-88780.md) for the
   per-host table).
2. If the service is running but Prometheus cannot scrape, check
   `iptables -L`, the host's firewall, or any reverse-proxy. The
   metrics endpoint binds to `127.0.0.1:9100` by default — Prometheus
   must reach it directly or via SSH tunnel.
3. `journalctl -u coc-node@<unit> -n 200` for recent crashes.

**First response**:
- If `systemctl status` shows the unit is `failed` or stopped:
  `systemctl restart coc-node@<unit>` and watch the logs for ~60 s.
- If the host is unreachable entirely, escalate (the host itself is
  down) — but **do not auto-replace** the validator key unless the
  outage exceeds 1 h (otherwise it self-heals when the host is back
  and BFT continues with 5/6 quorum).
- BFT continues with 5/6 quorum (T1 chaos result). With 4/6 the chain
  still produces blocks; with ≤ 3/6 it stalls (T3 result). Check
  `LowPeerCount` / `BlockProductionStalled` in parallel.

**Escalation**: if 2+ validators down simultaneously, **DO NOT restart
both at once** — page the on-call lead. Per chaos T2: parallel restart
of 2 validators triggers a 2.5 min stall via dead-proposer slot. Stagger
restarts ≥ 60 s apart.

---

### `BlockProductionStalled` — critical

**Expr**: `increase(coc_block_height[5m]) == 0` for 3 m

**Symptom**: All scraped nodes report no new blocks for the last 5
minutes. Either the chain has lost quorum or every node is wedged
locally.

**Dashboards**: `coc-overview` → "Block Height" panel (look for the
plateau); `coc-consensus` → "BFT Phase" panel (stuck on `propose` or
`prepare` is the giveaway).

**Diagnosis**:
1. Cross-check `coc_block_height` across all scraped nodes. If only one
   is stuck and others are advancing, it's a single-node sync issue —
   demote the alert to the affected node.
2. If all are stuck at the same height, query
   `coc_validators_active` — if < 4, BFT cannot reach quorum.
3. Curl `/coc_getBftStatus` on a validator: phase + round timer.
   `phase=propose` + round age > 60 s = dead proposer slot.

**First response**:
- **All nodes stuck, ≥ 4 active**: likely a dead-proposer slot. Wait up
  to 60 s for the H15 fallback (it ships at ~600 s in production —
  this is the proposer-skip fast path landed in PR #641 `c4a330a`).
  The chain will self-heal.
- **All nodes stuck, < 4 active**: BFT below quorum. Restore at least
  one validator (per `NodeDown` flow). Do not attempt a hard fork.
- **One node stuck while others advance**: that node is locally
  wedged. Restart it with `systemctl restart coc-node@<unit>` and let
  snap-sync catch up.

**Escalation**: if quorum cannot be restored within 30 m, follow
[`disaster-recovery-88780.md` § Chain halt](./disaster-recovery-88780.md).

---

### `ValidatorQuorumAtRisk` — warning

**Expr**: `coc_validators_active < 5` for 2 m

**Symptom**: Active validator count fell below 5. BFT quorum is 4 of 6
on the canary network — one more dropping triggers a stall (chaos T3
result: 3 down = clean stall, chain frozen until restored).

**Dashboards**: `coc-consensus` → "Active Validator Count" stat.

**Diagnosis**:
1. Identify which validator is missing via `coc_validators_active`
   per-instance label or by cross-checking `coc_block_height` (the
   missing one's metric is stale).
2. Check `journalctl -u coc-node@<unit>` on the missing validator's
   host. Could be planned restart, crashed process, or network
   partition.

**First response** (THIS IS THE CHAOS T2 SOP — read carefully):
- **Do NOT restart any other validator** until the missing one is
  back. Two simultaneous down = 2.5 min stall (chaos T2 result).
- If the missing validator is a planned restart, wait for it to come
  back (typically < 30 s with snap-sync) and the alert clears.
- If unplanned (crash), restart **only that single validator** per
  the `NodeDown` SOP. Stagger any other planned ops ≥ 60 s after
  recovery confirmed.

**Escalation**: validator count drops to 4 → preemptively warn
the on-call lead. Drops to 3 → `BlockProductionStalled` will fire
(chain has stalled); escalate to disaster-recovery flow.

---

### `ConsensusStateDegraded` — warning

**Expr**: `coc_consensus_state != 0` for 5 m

**Symptom**: A node has been reporting a non-healthy consensus state
(1 = degraded, 2 = recovering) for 5+ minutes. Often a side effect of a
partial network partition or transient peer churn.

**Dashboards**: `coc-consensus` → "Consensus State Per Node" timeline.

**Diagnosis**:
1. Compare across nodes — single-node degraded vs network-wide.
2. Check `coc_peers_connected` on the affected node. State `1` with low
   peer count = isolation.

**First response**:
- Single-node degraded with low peers: check the node's outbound
  connectivity (DNS, firewall, ISP). Often a peer-list reset
  (`rm /var/lib/coc/node-*/peers.json; systemctl restart …`) clears
  it. State `2` (recovering) is informational — node is back-filling
  via snap-sync, leave it alone unless it stays in state 2 > 30 m.

**Escalation**: pattern across multiple nodes → likely upstream
incident (RPC gateway, public faucet — see
[`disaster-recovery-88780.md`](./disaster-recovery-88780.md)).

---

## Security group (`coc_security`)

### `HighAuthRejections` — warning

**Expr**: `rate(coc_p2p_auth_rejected_total[5m]) > 10` for 3 m

**Symptom**: > 10 P2P auth rejections per second on a single node for
3+ minutes. Possible Sybil flood, brute-force scan, or a misconfigured
peer attempting reconnection storm.

**Dashboards**: `coc-network` → "P2P Auth Rejections" panel.

**Diagnosis**:
1. Look at `coc_p2p_auth_rejected_reason_total{reason=…}` to break down
   reason: `bad_signature`, `unknown_signer`, `expired_nonce`,
   `roster_mismatch`. The last two during a deploy window mean a stale
   peer cache — benign.
2. Identify the source IPs via the node's gossip log
   (`journalctl -u coc-node@<unit> | grep auth.*rejected`).

**First response**:
- Most common cause: bootstrap peer dropped out of the validator
  roster (e.g. retired observer) and stale `peers.json` keeps
  retrying. Solution: edit `peers.json` to remove the dead peer or
  let the connection backoff exhaust (~10 min).
- True attack: temporary block at `iptables` for the burst window;
  open a security advisory if pattern repeats.

**Escalation**: rejection rate stays > 100/s for 10 m → page
security-on-call.

---

### `DiscoveryIdentityFailures` — warning

**Expr**: `increase(coc_discovery_identity_failures_total[10m]) > 50` for 5 m

**Symptom**: 50+ peer-discovery identity verification failures in 10 m.
Same root-cause family as `HighAuthRejections` but at the DNS-seed /
DHT bootstrap layer.

**Dashboards**: `coc-network` → "Discovery Identity Failures" panel.

**Diagnosis**: same as `HighAuthRejections`. Verify the seed list is
current (DNS TXT records) and the affected peers are still in the
expected roster.

**First response**: if a seed peer was retired without DNS update,
update the DNS TXT records. Otherwise treat as `HighAuthRejections`.

---

### `DhtVerifyFailures` — warning

**Expr**: `increase(coc_dht_verify_failures_total[10m]) > 20` for 5 m

**Symptom**: DHT iterative lookup is failing to verify peer signatures
on FIND_NODE responses. Often a wire-protocol incompatibility after
upgrade.

**Dashboards**: `coc-network` → "DHT Stats" panel.

**Diagnosis**: confirm all nodes are on the same release HEAD (per
[`public-endpoints-88780.md`](./public-endpoints-88780.md) operations
log). Cross-version `verifyNodeSig` mismatch is the most common
trigger.

**First response**: roll the affected nodes to the canonical HEAD via
`scripts/deploy-rolling-safe.sh <HEAD>`. Do not roll all nodes
simultaneously (per chaos T2/T8 ops SOP — staggered restart).

---

### `EquivocationDetected` — critical

**Expr**: `increase(coc_bft_equivocations_total[5m]) > 0` for 0 m

**Symptom**: A validator has been observed signing two conflicting
messages for the same BFT height. Chain slashing should fire
automatically via `EquivocationDetector` at
`0xa5dcE830e917176c1091fd6112F41E47692C510e` (gen-5 proxy).

**Dashboards**: `coc-consensus` → "Equivocations Total" stat.

**Diagnosis** (operator side — DO NOT debug the slashed validator
key, treat it as compromised):
1. Identify the offender via `coc_getEquivocations` RPC on any healthy
   node.
2. Confirm the on-chain `EquivocationProven` event fired (Explorer
   `/address/0xa5dcE830…` events tab).
3. Check `coc_validators_active` post-slash — if it dropped below 4
   (BFT quorum), follow `BlockProductionStalled` SOP in parallel.

**First response**: if the equivocating validator is one of yours:
- **Stop the node immediately** (`systemctl stop coc-node@<unit>`).
- Follow [`operator-runbook.md` § 3 Slash response](./operator-runbook.md#3-slash-response).
- Do NOT re-stake the slashed key; generate a fresh keypair.
- File a post-mortem within 24 h.

**Escalation**: any equivocation is an immediate page to the
on-call lead. This is the canary 30-day-clean-record gate (Gate 3 in
[`canary-launch-checklist-88780.md`](./canary-launch-checklist-88780.md))
— a single event resets the clock.

---

## Performance group (`coc_performance`)

### `SlowBlockProduction` — warning

**Expr**: `coc_block_time_seconds_bucket{le="6"} / coc_block_time_seconds_count < 0.95` for 10 m

**Symptom**: More than 5 % of blocks are taking > 6 s. Canary target is
p99 < 10 s — this is the early-warning signal.

**Dashboards**: `coc-overview` → "Block Time Histogram"; `coc-resources`
→ CPU / disk-IO panels.

**Diagnosis**:
1. Check `coc_resources` dashboard for CPU saturation or disk-IO
   pressure on validators.
2. Check `coc-overview` mempool depth — large pending pool (> 200) can
   throttle block formation.
3. Check `coc_validators_active` — if a validator is slow to respond,
   dead-proposer slots inflate p99.

**First response**:
- CPU/disk saturation: scale the host or move to faster storage.
- Mempool backlog → `HighMempoolBacklog` SOP.
- Persistent dead-proposer slots: identify the slow validator (lowest
  `coc_blocks_produced_total` rate) and restart it.

---

### `HighMempoolBacklog` — warning

**Expr**: `coc_tx_pool_pending > 500` for 5 m

**Symptom**: A validator is holding > 500 pending transactions for 5+
minutes. Mempool per-sender quota is 64 (per `coc-88780-2026-05-26-chaos-engineering-T1-T8.md`
T6/T6b), so 500+ pending means active inbound demand.

**Dashboards**: `coc-overview` → "Mempool Depth"; `coc-consensus` →
"Tx Per Block".

**Diagnosis**:
1. Compare across nodes — if all are at > 500 it's organic load; if
   only one, that node is slow to relay (possible peer issue).
2. Check inbound RPC rate `coc_rpc_requests_total` — limit is 240
   req/min/IP. If a single IP is dominating, possible misbehaving
   client.

**First response**:
- Organic load: raise block gas limit or accept temporary backlog;
  burst will clear on its own (T6 result — chain remained at ~3s/block
  during 500-tx burst).
- Single-IP flooding: blacklist at the nginx/Cloudflare layer.

---

### `HighMemoryUsage` — warning

**Expr**: `coc_process_memory_bytes > 2e9` for 10 m

**Symptom**: A node's process RSS exceeded 2 GB for 10+ minutes. Either
slow leak (rare) or expected after long uptime + heavy snap-sync.

**Dashboards**: `coc-resources` → "Process Memory" panel.

**Diagnosis**: check uptime via `coc_node_uptime_seconds`. RSS > 2 GB
after 30+ days of uptime is normal; after 24 h is a leak indicator.

**First response**: rolling restart per
`scripts/deploy-rolling-safe.sh` — stagger nodes ≥ 60 s apart (chaos
T2 SOP). For genuine leaks, capture a heap snapshot
(`kill -USR2 <pid>`) before restart and open a bug.

---

## Network group (`coc_network`)

### `LowPeerCount` — warning

**Expr**: `coc_peers_connected < 2` for 5 m

**Symptom**: A node has < 2 HTTP gossip peers. With 6 active validators
+ 0 observers, healthy is 5 connections per node.

**Dashboards**: `coc-network` → "Peers Connected".

**Diagnosis**:
1. `cat /var/lib/coc/node-<unit>/peers.json` — verify peer list is
   intact.
2. Check `coc_p2p_auth_rejected_total` — if rejection rate is high,
   peers are present but rejected (see `HighAuthRejections`).

**First response**: reset peer cache + restart:
```bash
mv /var/lib/coc/node-<unit>/peers.json /tmp/peers.bak
systemctl restart coc-node@<unit>
```
Node will rediscover via DNS seeds + DHT. If still < 2 after 5 m,
check outbound firewall.

---

### `NoWireConnections` — warning

**Expr**: `coc_wire_connections == 0 and coc_peers_connected > 0` for 5 m

**Symptom**: Wire (TCP) protocol has zero connections but HTTP gossip
peers are available. Wire is the high-throughput transport for
BFT messages — without it BFT runs on HTTP fallback and is slower.

**Dashboards**: `coc-network` → "Wire Connections".

**Diagnosis**:
1. Check `COC_ENABLE_WIRE_PROTOCOL=true` in the node's env.
2. Confirm wire port (29790 / 29780 depending on host) is reachable
   from peers (`nc -zv <peer-ip> 29790`).
3. Inspect `journalctl -u coc-node@<unit> -e | grep wire` for
   handshake failures.

**First response**: if config is right and ports are open, restart the
node. If wire stays at 0 across all nodes after the restart, open an
issue — likely a wire-protocol regression.

---

## Faucet group (`coc_faucet`)

The faucet alerts depend on a textfile-collector probe — see
[`faucet-operations-88780.md`](./faucet-operations-88780.md) for the
install/cron procedure for `scripts/faucet-balance-check.sh`.

### `FaucetBalanceLow` — warning

**Expr**: `coc_faucet_balance_eth < 500` for 5 m

**Symptom**: Faucet wallet balance fell below 500 COC (~50 drips at
default 10 COC/drip, ~12 h headroom at canary onboarding pace).

**Dashboards**: `coc-overview` → "Faucet Balance" panel (if added — at
time of writing, the metric is in the textfile collector but not yet
wired into a dashboard panel; tracked as Gate 10 polish).

**Diagnosis**:
1. `curl -s https://faucet.chainofclaw.io/faucet/status | jq` — confirm
   the on-chain balance matches the alert (rules out probe drift).
2. Check `totalDrips` field — sudden ramp = onboarding spike, organic.
   Steady rate = expected drain; treat as a refill cycle.

**First response**: trigger a standard refill per
[`faucet-operations-88780.md` § Refill procedure](./faucet-operations-88780.md#refill-procedure).
For ≤ 10 000 COC, multisig signers can approve directly. Verify within
1 block after the multisig tx lands.

**Escalation**: if balance keeps dropping after refill at the same
rate, suspect abuse — escalate to faucet-operations § Abuse response.

---

### `FaucetBalanceCritical` — critical

**Expr**: `coc_faucet_balance_eth < 100` for 1 m

**Symptom**: Faucet has < 100 COC. Drips will start failing within
hours; if `daily_global_limit` interacts at the same time, immediately.

**Dashboards**: same as `FaucetBalanceLow`.

**First response**: refill **IMMEDIATELY**. If the multisig signers
aren't reachable in time, fall back to `pm2 stop coc-faucet` to fail
fast rather than partially serve — drip failures are worse for
onboarding UX than a `503` with a clear retry message. Then page on-call.

---

### `FaucetProbeStale` — warning

**Expr**: `time() - coc_faucet_balance_check_timestamp_seconds > 1800` for 5 m

**Symptom**: The faucet balance probe (`scripts/faucet-balance-check.sh`)
has not refreshed the textfile metric in 30+ minutes. The probe is
dead, not the faucet itself — but a dead probe hides a draining faucet.

**Diagnosis**:
1. SSH to the faucet host. `systemctl status cron` — confirm cron is
   running.
2. `cat /etc/cron.d/coc-faucet-balance-check` — confirm cron entry
   exists.
3. Run the script manually: `bash /usr/local/bin/faucet-balance-check.sh`
   and check exit code + stderr.
4. Confirm `/var/lib/node_exporter/textfile_collector/coc_faucet_balance.prom`
   gets updated with current timestamp.

**First response**: most common cause is `jq` / `curl` not installed
on a new host. Install via package manager + rerun. If `node_exporter`
isn't reading the textfile collector dir, confirm the
`--collector.textfile.directory` flag in its systemd unit.

---

# Alerts deliberately not implemented (yet)

| Signal | Why deferred | Tracking |
|---|---|---|
| `MultisigSignerUnreachable` | Out-of-band (3-of-5 still safe with 1 down) — manual check before canary launch | Gate 8 in checklist |
| Block production p99 absolute (vs ratio) | `SlowBlockProduction` covers it indirectly; native p99 query is more expensive | Backlog |
| Faucet drain | Currently informational; `MempoolBacklog` catches the symptom | Gate 9 in checklist |
| RPC public-endpoint 5xx rate | Belongs to Cloudflare layer (not yet stood up) | Gate 8 |

# Notes for future work

- The dev-stack file `docker/prometheus/alerts.yml` partially overlaps
  with `ops/alerts/prometheus-rules.yml` but uses different thresholds.
  The canonical prod file is `ops/alerts/prometheus-rules.yml` — keep
  the dev file in sync or deprecate it in a future cleanup.
- Add `runbook_url` annotation to every alert pointing at this doc
  (Alertmanager renders it as a link in pages). Out of scope for this
  PR; tracked alongside Gate 10 polish.
- Per chaos memory (T1–T8 results), the validator-restart SOP is
  enforced via observer judgement, not by an automated alert. A
  `ValidatorQuorumAtRisk` alert (`coc_validators_active < 5`) would
  preempt this — also tracked as a follow-up.

# See also

- [`disaster-recovery-88780.md`](./disaster-recovery-88780.md) — what to do when an alert
  escalates to a disaster scenario.
- [`canary-launch-checklist-88780.md`](./canary-launch-checklist-88780.md) — Gate 10 evidence pointer.
- [`operator-runbook.md`](./operator-runbook.md) — daily ops SOP.
- [`public-endpoints-88780.md`](./public-endpoints-88780.md) — host inventory + ports.
