# Prowl Testnet — Phase 2 Deployment Plan

**Issued**: 2026-05-06
**Owner**: COC operations
**Status**: planned (Phase N+D+S code merged in `c6c22cd`; production
migration pending the in-flight 24h soak `phase-j-local-w8c`)

## 1. Background

Phase 1 (the current testnet) runs three BFT validators + a sync-node + a
relayer + an agent + a faucet + an explorer, all in Docker, on a single
host. After Phase H/J/M consensus and observability work landed, the
operator (Peter) directed a deployment-architecture refresh:

1. Core validators leave Docker and run as native systemd services.
2. Auxiliary nodes (sync, light observers) stay in Docker.
3. Storage tiers: 50GB for core (archive mode), 200MB minimum for
   light peers.
4. Operate a "true P2P storage" path on top of the existing Phase C
   IPFS surface — closing the four enforcement gaps that Phase C left
   open: unbounded blockstore, warning-only replication factor,
   missing repair loop, and non-iterative DHT lookup.

This document is the contract for the next testnet rollout.

## 2. Hard guarantees

These are non-negotiable properties of the migration. Any deploy run
that violates them must abort and roll back.

| # | Guarantee | Verification |
|---|---|---|
| G1 | **No existing chain data is destroyed.** All `leveldb-{chain,state}` directories, evidence logs, and `.broken.*` historical backups are copied (not moved) from the docker volume to the new host filesystem location with `cp -a`. The docker volume remains intact as the rollback target. | `docker volume inspect docker_node1-data` after migration shows the volume still present and populated. |
| G2 | **External (host-side) ports are unchanged.** Every port reachable from outside the host today stays on the same number tomorrow. | `ss -tlnp \| grep -E ':(28780\|28781\|28782\|28783\|28784\|28785\|28786\|29780\|29781\|29782\|29783\|29784\|29785\|9101\|9102\|9103\|9104\|18780\|18781\|19880\|19881\|3003\|3000)\s'` post-migration shows the same set as pre-migration. |
| G3 | **No quorum loss.** At least 2 of 3 validators are healthy and finalizing blocks at every point during the migration. | Sample heights every 10 s during the migration; require monotonic increase across the active set. |
| G4 | **Phase J/M code paths preserved.** The deployed binary is the same `node/src/index.ts` running today, plus the Phase N/S code-only additions (LRU blockstore, `ipfsMaxStorageBytes`); BFT/EVM/wire protocols unchanged. | `git rev-parse HEAD` on `/opt/coc` matches the fork's main branch SHA. |
| G5 | **Soak baseline preserved.** Phase 2 starts only after the in-flight 24h soak `phase-j-local-w8c` has completed and `docs/soak-reports/phase-j-local-w8c.md` is archived. | File presence check; verdict line shows PASS or a documented FAIL with remediation. |

## 3. Canonical port table

External ports stay identical. The migration just removes the docker NAT
between host and container.

| Service | Today (Docker) | Tomorrow (Phase 2) | Change? |
|---|---|---|---|
| node-1 RPC | 28780 → container 18780 | systemd binds 0.0.0.0:28780 | No |
| node-1 WS | 28781 → 18781 | 0.0.0.0:28781 | No |
| node-1 P2P | 29780 → 19780 | 0.0.0.0:29780 | No |
| node-1 Wire | 29781 → 19781 | 0.0.0.0:29781 | No |
| node-1 IPFS HTTP | 28786 → 5001 | 0.0.0.0:28786 | No |
| node-1 /metrics | 9101 → 9100 | 0.0.0.0:9101 | No |
| node-2 RPC / WS / P2P / Wire / metrics | 28782 / 28783 / 29782 / 29783 / 9102 | same on host | No |
| node-3 RPC / WS / P2P / Wire / metrics | 28784 / 28785 / 29784 / 29785 / 9103 | same on host | No |
| sync-node RPC / WS / P2P / Wire / metrics | 18780 / 18781 / 19880 / 19881 / 9104 | unchanged (still docker) | No |
| faucet | 3003 | unchanged (still docker) | No |
| explorer | 3000 | unchanged (still docker) | No |
| **light-1 (NEW)** | — | 38780 / 38781 / 39780 / 39781 / 9111 | New host ports, no collision with existing |
| **light-2 (NEW)** | — | 38782 / 38783 / 39782 / 39783 / 9112 | New |

## 4. Architecture deltas vs Phase 1

| Layer | Phase 1 | Phase 2 |
|---|---|---|
| Validator runtime | 3× docker containers behind compose `coc-p2p` bridge | 3× systemd services on host network |
| Validator state | Named docker volumes (`docker_node{1,2,3}-data`) | `/var/lib/coc/node-{1,2,3}/` (host fs) |
| Validator config | `docker/testnet-configs/node-{1,2,3}.json` (peers via docker DNS `node-N`) | `/etc/coc/node-{1,2,3}.json` (peers via `127.0.0.1:<port>`) |
| Validator key | `COC_NODE_KEY` env in compose | `EnvironmentFile=/etc/coc/node-N.env` |
| Auxiliary nodes | sync-node, relayer, agent, faucet, explorer in `docker-compose.testnet.yml` | unchanged set; reach validators via `host.docker.internal:<port>` |
| Light observers | None | `coc-light-1`, `coc-light-2` (Phase D1, optional) |
| IPFS blockstore | unbounded growth | optional `maxBytes` cap (Phase S1); 200MB hard limit on light peers via tmpfs |
| Storage policy | implicit `nodeMode=full` | explicit `nodeMode=archive` for core; `nodeMode=light` for auxiliary observers |
| P2P storage enforcement | warning-only `minReplicas`; no repair; no iterative DHT | Phase P (separate session): hard `enforceMinReplicas`, repair scheduler, iterative `findProviders` |

## 5. Phase ordering

Phase 2 ships in three sub-phases, each shippable independently. None
takes the chain offline.

### Phase N+D+S — operations + storage cap (next session)

1. Wait for `phase-j-local-w8c` soak to complete + summary green (G5).
2. Stage `docker/systemd/coc-node@.service` + `native-env/*` +
   `native-configs/*` to server (`/etc/systemd/system/`, `/etc/coc/`).
3. `coc:coc` user + `/var/lib/coc`, `/var/log/coc` directories.
4. **Per validator (gradual)**: docker stop → `cp -a` data → `systemctl
   enable --now coc-node@N`. Watch chain progress 30 s, then next.
5. Patch `docker-compose.testnet.yml` for sync-node + relayer + agent +
   faucet + explorer: `extra_hosts: ["host.docker.internal:host-gateway"]`
   + RPC URLs to `host.docker.internal:28780`.
6. Recreate docker auxiliary services.
7. Bring up `docker compose -f docker/docker-compose.light.yml up -d
   light-1`.
8. Final verification: G1-G4 commands all green.
9. Start `phase-2-w9a` 24h soak.

### Phase P1 + P2 — replication enforcement + repair loop (session +1)

1. `enforceMinReplicas` flag in `node/src/coc-ipfs-wiring.ts`; PUT
   returns 503 + chunk-level body when worst replica < `minReplicas`.
2. `RepairScheduler` class: hourly scan of pinned CIDs, re-push
   under-replicated to K-closest peers, emit `coc_ipfs_repair_total`
   counter.
3. Unit tests; rsync to server; rolling `systemctl restart coc-node@N`.
4. Smoke: PUT a 256 KiB file, kill 2 of 3 validators, verify PUT
   returns 503 with the right body. Restore quorum, observe repair
   counter increment after the 1 h tick.

### Phase P3 + P4 — iterative DHT lookup (session +2)

1. `findProvidersIterative(cid, hops=3)` in `node/src/dht-network.ts`.
2. Wire-protocol `FindProvider` (0x14) / `FindProviderResponse` (0x15)
   in `wire-protocol.ts` + handler in `wire-server.ts`.
3. Synchronized `systemctl restart coc-node@1 coc-node@2 coc-node@3`
   (wire-protocol additive change but newer validators must speak the
   new opcodes for the iterative path to work; light peers tolerate
   older wire and fall back to the cached DHT view).
4. Smoke: light-1 requests a CID present only on node-2's blockstore
   without a direct provider record cached locally.

## 6. Rollback playbook

Every step is reversible. The scope of each rollback is the smallest
that restores correctness.

| Trigger | Rollback action |
|---|---|
| Native validator does not advance the chain within 30 s of `systemctl start` | `systemctl stop coc-node@N && systemctl disable coc-node@N && docker start coc-node-N`; the docker volume was never deleted, so the original container resumes from the same tip. |
| Native validator advances but auxiliary docker services lose connectivity (sync-node not finalizing, relayer/agent timing out) | Add `extra_hosts` and update RPC URL env to `host.docker.internal:28780`; `docker compose up -d --force-recreate` the affected service. |
| Light peer hits 200 MB tmpfs cap and falls behind | Reduce `COC_IPFS_MAX_BYTES` hysteresis, or grow tmpfs mount to 300 MB. Light peer is non-critical; can be down without affecting consensus. |
| Phase P1 enforcement returns 503 for legitimate clients | Set `enforceMinReplicas=false` (default); restart coc-node@N. Returns to Phase 1 warning-only behaviour. |
| Phase P2 repair loop floods wire | Increase `ipfsRepairIntervalMs` from 1 h to 6 h, or set to a sentinel that disables repair. |
| Phase P3 wire incompatibility breaks BFT | Revert the wire-protocol commit on a single validator and `systemctl restart`; once that validator is on the older wire, others tolerate (additive opcode); roll the rest back at leisure. |

## 7. Acceptance criteria

Phase 2 is "complete" when:

- 24h `phase-2-w9a` soak report (`docs/soak-reports/phase-2-w9a.md`)
  shows verdict PASS using the same gate criteria as the Phase 1
  baseline (height monotonic, 0 stalls ≥ 120 s, equivocations counter
  == 0, fork depth max ≤ 1, mean block time ≤ 4 s).
- `du -sh /var/lib/coc/node-1` shows core node disk usage trending
  toward (but well under) 50 GB; light peer's blockstore stable at
  ≤ 200 MB.
- All Phase N + D + S + P metric series visible in Prometheus,
  alerts unchanged from Phase 1 + new `coc_ipfs_repair_total`
  observable.
- Migration runbook (`docs/native-deployment.en.md`) executed exactly
  once with no rollbacks recorded; if any rollbacks occurred, attach
  the incident notes to the soak report.

## 8. Out of scope (Phase Q, future)

- Reed-Solomon erasure coding (sharding instead of full-copy
  replication).
- Filecoin-style sealing / verifiable storage proofs.
- Dedicated `nodeMode=storage` non-validator storage role.
- Inter-host validator deployment (this plan still co-locates 3
  validators on one host; multi-host is Phase 3).

## 9. Inputs / dependencies

- Approved plan: `/home/bob/.claude/plans/applyblock-delightful-hennessy.md`
- Migration runbook: `docs/native-deployment.en.md`
- Phase J postmortem: `docs/phase-j-postmortem.en.md`
- Phase J 2026-05-06 corner-case: `docs/phase-j-stall-2026-05-06-corner-case.md`
- 24h soak baseline (in-flight): `phase-j-local-w8c`
