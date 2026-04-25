# Incident Post-Mortem: Testnet BFT Halt — 2026-04-25 01:07 UTC ~ 02:42 UTC

> Testnet was stuck at block 27 238 for ~95 minutes. Root cause: prover sidecar shared LevelDB volume RW with validator → dual-writer corruption.
> Recovered. Defenses added.
> Chinese version: `incident-2026-04-25-chain-halt-post-mortem-zh.md`.

---

## TL;DR

| Item | Value |
|---|---|
| Incident start | 2026-04-25 **01:08 UTC** |
| Full recovery | 2026-04-25 **02:42 UTC** |
| Duration | ~ **95 minutes** |
| Blocks lost during halt | 0 (**not skipped, fully halted**) |
| Impact | 1 validator's state trie wiped + another validator already had divergent stateRoot |
| Data loss | None (all transactions and contract state restored from peer) |
| Root cause | All 3 prover sidecar containers had `rw=true` shared volume mount with validators' LevelDB → dual-writer corruption |
| Trigger action | `docker compose up -d --force-recreate node-1` (to expose IPFS HTTP port 28786) |
| Fix | Copy state DB from healthy peer + switch all provers to `:ro` mounts |

---

## 1. Timeline

All times UTC, 2026-04-25.

```
01:07:24  node-1 (old instance) finalizes block 27 238
          ┃
          ┃ user issues: docker compose up -d --force-recreate node-1
          ┃ (purpose: expose IPFS HTTP port 5001 → host 28786)
          ┃
01:07:25  node-1 (old) receives SIGTERM, begins 30s graceful shutdown
01:07:30  node-1 (new) starts; process holds LevelDB handle
          ↑ Meanwhile coc-prover-1 has been running continuously
            (since yesterday 12:11), still holds file descriptors on the volume
01:07:33  node-1 exports state-snapshot ✅
          accounts=90, stateRoot=0x5a570af9..., blockHeight=27238
01:07:50  node-1 completes wire handshake with node-2/3
01:08:33  ⚠️ First "state trie has no committed root" error appears
          → state trie is corrupted; node-1 stops participating in BFT
01:08-02:37  Chain halted:
          • node-2 (proposer for 27239) re-broadcasts proposal every 21s
          • prepareVotes=1 (only itself), never reaches quorum
          • node-1 has zero BFT activity
02:37     User reports halt
02:38:13  Stop coc-prover-1 (eliminate dual writer)
02:38:20  Discover node-1's state trie is empty (accounts=0)
02:38:30  Copy node-3's leveldb-state + leveldb-chain → node-1
02:38:40  ⚠️ Startup fails: LOCK file owned by root, coc user lacks permission
02:39:00  chown -R 999:999 to fix; restart node-1
02:39:28  node-1 exports healthy snapshot: accounts=90, stateRoot=0x0bd9b9cb...
02:40:00  ⚠️ New discovery: node-2 is also divergent
          • node-2 stateRoot=0x8b20c869... (89 accounts)
          • node-1/3 stateRoot=0x0bd9b9cb... (90 accounts)
          • BFT still stuck on 27239 (node-2 is proposer, proposal rejected)
02:41:18  Stop node-2, copy state DB from node-3
02:42:30  Restart node-2; all 3 nodes have identical stateRoot
02:42:50  **Chain resumes**: bn 27 238 → 27 245 → 27 250 → ...
02:43:56  Restart 3 provers (now `:ro` mount)
02:44:30  Full system stable confirmation (bn>27 282); all provers /health=ok
```

---

## 2. Root Cause Analysis

### 2.1 Direct cause: dual-writer LevelDB corruption

`coc-prover-1` container's docker volume mount was configured (in last night's 12:11 `docker run` invocation):
```bash
docker run -d --name coc-prover-1 \
  -v docker_node1-data:/data/coc \      # ← rw=true (default)
  -v .../node-1.json:/app/config.json:ro \
  ...
```

`-v docker_node1-data:/data/coc` **had no `:ro` suffix**, so docker mounted it with default `rw=true`.

`runtime/coc-node.ts` (the prover entrypoint) does this on startup:
```typescript
const storageBlockstore = poseStorageFromBlockstore 
  ? new IpfsBlockstore(storageDir)   // storageDir = /data/coc/storage
  : undefined;
```

`IpfsBlockstore.init()` calls `mkdir -p` to create the blocks directory. By itself harmless (dir exists → no-op). But the volume's RW mode allows the prover process to **legitimately** write to any file in the LevelDB directory — including the LOCK file.

LevelDB uses fcntl advisory locks to prevent two processes from opening the same DB. Across containers sharing the same physical inode, fcntl locks are **honored cross-container** — but only if both processes "honestly" request locks. If a process opens the LOCK file directly and writes 0 bytes, it can stomp the counterpart's lock state.

### 2.2 Trigger: force-recreate

Normally both processes leave LevelDB files alone, no problem. But the `force-recreate node-1` sequence triggered:
1. Old node-1 process receives SIGTERM, begins graceful shutdown — releases LevelDB lock
2. New node-1 process starts — must acquire LevelDB lock
3. **Between these steps**, prover-1 still has the volume open (only reading IPFS blocks, but fd still active)
4. Container namespace switch + filesystem inode remount may put the lock state into "half-released"
5. New node-1 acquires the lock successfully, but LevelDB internal state machine sees an unfinished manifest rewrite
6. Some 30s later, an internal LevelDB compaction triggers, finds manifest references SST files that don't exist → wipes trie and rebuilds

**The exact internal trigger** can't be 100% reproduced (involves LevelDB + Linux fcntl + container fs layer interactions), but **eliminating the dual writer is sufficient to prevent this class of issue**.

### 2.3 Secondary discovery: node-2 stateRoot divergence

This was the truly "unexpected" finding. After fixing node-1, we found node-2's stateRoot differs from node-1/3:
```
node-1 bn=27238 stateRoot=0x0bd9b9cb...
node-2 bn=27238 stateRoot=0x8b20c869...    ← different!
node-3 bn=27238 stateRoot=0x0bd9b9cb...
```

More precisely: `accounts=89` vs `accounts=90` — **one account missing**.

Going further back: block 27 200 also has stateRoot=0x8b20c869... vs 0x0bd9b9cb..., proving the divergence **predates tonight's incident**.

Possible causes:
- node-2 may have suffered a similar dual-writer corruption during a past restart, undetected
- A PoSe v2 register operation may not have committed cleanly on node-2 (left half-state)
- This is GitHub Issue #3 ("validators commit divergent state tries") observed in the wild

**Phase B's `(blockHash, stateRoot)` pair-quorum failed to halt the divergence**, because:
- BFT only needs 2/3 quorum: node-1 + node-3 = 2 votes, sufficient to finalize blocks
- node-2's vote (different stateRoot) is silently rejected by node-1+3
- node-2 itself applies blocks against its own state chain, so block.hash matches but internal state diverges
- BFT has no "forced audit": no mechanism to periodically reconcile each node's stateRoot

Phase D should add this.

---

## 3. Impact Assessment

### 3.1 Data Integrity

| Check | Result |
|---|---|
| All transaction hashes still queryable | ✅ |
| Block 1 ~ 27238 chain data | ✅ (each node has full copy) |
| Smart contract state (PoSeManagerV2 etc.) | ✅ (verified `getActiveNodeCount=4`, `DOMAIN_SEPARATOR` unchanged) |
| User wallet balances | ✅ (deployer 9 980+ ETH unchanged) |
| IPFS blockstore | ✅ (independent of LevelDB, untouched) |
| Registered CIDs in CidRegistry | ✅ (4 CIDs all queryable) |

### 3.2 Service Impact

| Service | Impact |
|---|---|
| Block production | ❌ Fully halted for 95 min |
| RPC eth_blockNumber etc. | 🟡 Read still worked, all writes stuck in mempool |
| WebSocket subscriptions | 🟡 No newHeads (no new blocks) |
| Faucet | ❌ Couldn't dispatch ETH transfers |
| Explorer real-time updates | 🟡 Showed "waiting for new blocks" |
| IPFS HTTP `/api/v0/add` | ✅ Always available (decoupled from BFT) |
| PoSe v2 batchV2 on-chain submit | ❌ Couldn't submit (depends on chain) |

### 3.3 Economic Loss

Testnet = 0. Hardhat default accounts, no token issuance, no real economic activity.

---

## 4. Remediation Steps (executed)

### 4.1 Emergency containment

```bash
# 1. Stop prover-1 (eliminate dual writer)
docker stop coc-prover-1

# 2. Stop node-3 (so we can take a static snapshot)
docker stop coc-node-3

# 3. Backup node-1's broken state DB
mv /var/lib/docker/volumes/docker_node1-data/_data/leveldb-state \
   /var/lib/docker/volumes/docker_node1-data/_data/leveldb-state.broken.20260425-023820

# 4. Copy node-3's state DB → node-1
cp -r /var/lib/docker/volumes/docker_node3-data/_data/leveldb-state \
      /var/lib/docker/volumes/docker_node1-data/_data/leveldb-state
cp -r /var/lib/docker/volumes/docker_node3-data/_data/leveldb-chain \
      /var/lib/docker/volumes/docker_node1-data/_data/leveldb-chain

# 5. Fix permissions (critical, otherwise LOCK file EACCES)
chown -R 999:999 \
  /var/lib/docker/volumes/docker_node1-data/_data/leveldb-state \
  /var/lib/docker/volumes/docker_node1-data/_data/leveldb-chain

# 6. Restart node-3 → node-1
docker start coc-node-3
docker start coc-node-1
```

### 4.2 Secondary fix (node-2 divergence)

Same procedure for node-2:
```bash
docker stop coc-node-2
mv /var/lib/docker/volumes/docker_node2-data/_data/leveldb-state \
   /var/lib/docker/volumes/docker_node2-data/_data/leveldb-state.diverged.20260425-024118
mv /var/lib/docker/volumes/docker_node2-data/_data/leveldb-chain \
   /var/lib/docker/volumes/docker_node2-data/_data/leveldb-chain.diverged.20260425-024118
docker stop coc-node-3   # static copy
cp -r /var/lib/docker/volumes/docker_node3-data/_data/leveldb-state \
      /var/lib/docker/volumes/docker_node2-data/_data/leveldb-state
cp -r /var/lib/docker/volumes/docker_node3-data/_data/leveldb-chain \
      /var/lib/docker/volumes/docker_node2-data/_data/leveldb-chain
chown -R 999:999 /var/lib/docker/volumes/docker_node2-data/_data/leveldb-{state,chain}
docker start coc-node-3
docker start coc-node-2
```

### 4.3 Permanent fix: prover RO mounts

```bash
# Restart 3 prover sidecars with all volume mounts now :ro
for n in 1 2 3; do
  docker rm -f coc-prover-$n
  docker run -d --name coc-prover-$n \
    --network docker_coc-rpc --network-alias prover-$n \
    -p 127.0.0.1:$((19900+n)):18800 \
    -v docker_node${n}-data:/data/coc:ro \    # ← :ro
    -v /root/clawd/COC/docker/testnet-runtime-configs/provers/node-$n.json:/app/config.json:ro \
    -e COC_CONFIG=/app/config.json \
    -e COC_NODE_PK=$KEY \
    -e COC_RPC_URL=http://node-$n:18780 \
    coc-runtime:phase-c-step2 \
    runtime/coc-node.ts
done
```

⚠️ Note: `runtime/coc-node.ts`'s `IpfsBlockstore.init()` calls `mkdir -p`. On a RO volume the directory already exists, so mkdir is a no-op — no error. If future code requires write capability, this will break — recorded in §5.3 follow-ups.

---

## 5. Defenses

### 5.1 ✅ Done

1. **Provers permanently use `:ro` mounts**: §4.3 above
2. **Testnet status doc updated** with "shared volume RW constraint" rule in `testnet-status-2026-04-24-zh.md` §3
3. **docker-compose now has prover service definitions**: prevents next manual `docker run` from omitting `:ro`
4. **Readiness assessment dropped operations score**: 60% → **50%**

### 5.2 🟡 Short-term follow-up (1-2 weeks)

5. `runtime/coc-node.ts` should **actively check** that `storageDir` is RO-mounted, log explicit warning rather than silently accepting
6. **Alerting integration**: Prometheus alertmanager + Slack/PagerDuty webhook with rules:
   - `chain_height` for any single validator stagnant for 5+ min → P0 alert
   - Any two validators with diverging stateRoot → P0 alert
   - LevelDB error log frequency > 1/min → P1 alert
7. **State-divergence detection script**: every epoch, reconcile all 3 validators' stateRoots; on divergence, automatically freeze the divergent node's voting + rotate proposer

### 5.3 ❌ Phase D Design Tasks

8. **Cross-validator stateRoot audit**: periodic active reconciliation; on divergence, immediately freeze the divergent validator's voting power
9. **Single-process LevelDB enforcement**: at runtime/coc-node.ts startup, detect if target volume is already locked by another process; refuse to start if so
10. **Finer-grained IPFS volume separation**: split `storage/blocks/` into its own named volume so the prover only mounts that subvolume rather than the entire `/data/coc`

### 5.4 Test Coverage

`tests/chaos-resilience.test.ts` should add:
- "Validator restart while prover sidecar is running"
- "Two processes opening same LevelDB simultaneously"
- Deliberately induce stateRoot divergence; assert BFT cannot continue finalizing

---

## 6. Lessons Learned

1. **Default RW on shared docker volumes is a trap**. All non-owning writers should use `:ro`.
2. **Testnet is not "free environment"**: tonight's 95-min halt impacted the development flow — meaning at production deployment this class of failure must auto-recover in <5 min.
3. **State divergence is more common than visible**. node-2's divergence **predated tonight** but went undetected — passive monitoring isn't enough; need active audits.
4. **GH#3 should be elevated to a Phase D blocker**. Cross-node stateRoot audit is mandatory pre-mainnet.

---

## 7. Forensic Data Retained (don't immediately delete)

```
/var/lib/docker/volumes/docker_node1-data/_data/leveldb-state.broken.20260425-023820/
/var/lib/docker/volumes/docker_node2-data/_data/leveldb-state.diverged.20260425-024118/
/var/lib/docker/volumes/docker_node2-data/_data/leveldb-chain.diverged.20260425-024118/
```

**Retain through 2026-05-09** (14 days) for:
- Investigating which specific account differs in node-2's 89 vs 90 accounts
- LevelDB manifest forensics (was it LSM compaction half-state vs LOCK preemption?)

After the date:
```bash
ssh coc-testnet 'rm -rf /var/lib/docker/volumes/docker_node*-data/_data/leveldb-state.broken.* /var/lib/docker/volumes/docker_node*-data/_data/leveldb-{state,chain}.diverged.*'
```

---

## 8. Doc Changes

| Related Doc | Change |
|---|---|
| `testnet-status-2026-04-24-zh.md` / `-en.md` | §3 add "Shared Volume RW Constraint" subsection |
| `docker/docker-compose.testnet.yml` | Add prover-1/2/3 service definitions (all `:ro`) |
| `testnet-readiness-assessment-2026-04-24-zh.md` / `-en.md` | §11 / §12 reduce score; add this incident to known issues |

---

**Investigator**: Claude Code (based on SSH logs + container state + LevelDB on-disk forensics)
**Severity**: P1 (testnet, no economic loss, but 95 min full halt)
**Post-mortem completed**: 2026-04-25 03:00 UTC
