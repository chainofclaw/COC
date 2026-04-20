# Testnet Stability Session — 2026-04-19

Version: 1.0
Date: 2026-04-19
Status: Mitigations deployed; one defect scheduled for follow-up (applyBlock queue serialization).
Scope: Public testnet at `199.192.16.79` (3 BFT validators) under sustained cron-stress load.

---

## 1. Background

A single operator session ran multi-hour stability validation against the public COC testnet. The network is a 3-node BFT cluster (`node-1..3`) plus a gateway node; a `cron-stress.sh` worker on the same host invokes a Node.js tx generator once per minute against `http://127.0.0.1:28780`. The worker rotates through 5 stress rounds (batch transfers, EVM-heavy calls, fresh contract deploy+increment, mempool lifecycle, multi-wallet parallel transfers).

The session set out to confirm production readiness; instead it surfaced five independent defects with overlapping symptoms (block production halts, RPC timeouts, Explorer "No contracts found", reproducible restart loops). This document records what went wrong, what was shipped, what was eliminated during root-cause investigation, and what remains to be done.

---

## 2. Symptoms Observed

### 2.1 BFT consensus deadlock (applyBlock hang)

Chain height would freeze for 10+ minutes at random block numbers. Logs showed BFT rounds reaching `commit` quorum (`prepareVotes=3 commitVotes=2`) and emitting `BFT round finalized`, but never the subsequent `BFT finalized block`. The `applyBlock` call inside `onFinalized` hung with no error, no stack, no backpressure signal — a classic lost-Promise-resolution.

Recurrence rate under single-account stress: approximately every 8 minutes.

### 2.2 Block production rate 1 s/block (design: 3 s/block)

Once consensus was stabilized, the Explorer reported `Blocks/min 66.7` — three times the designed `blockTimeMs=3000`. Inspection of consecutive block timestamps revealed triplet patterns (`t, t, t, t+3, t+3, t+3, …`): each proposer's independent 3 s `setInterval` fired near-simultaneously, producing back-to-back blocks.

### 2.3 Explorer `Contracts` page empty despite RPC returning data

After deploying SoulRegistry / DIDRegistry / CidRegistry, `https://explorer.clawchain.io/contracts` showed "No contracts found". `curl` against the same RPC returned 9 contracts. nginx responded with `Access-Control-Allow-Origin: http://localhost:3000` — a single hard-coded dev origin — so the browser dropped the cross-origin response. The Explorer's catch fell through to a 100-block scan that missed older deployments.

### 2.4 BFT/chain state desync after restart

After the first `process.exit(1)` recovery, BFT re-started but chain never advanced. `coc_getBftStatus` reported `lastFinalizedHeight=H`; `eth_blockNumber` returned `H-1`. New proposals at height `H` were rejected/buffered by peers (also desynced), producing a soft livelock with `prepareVotes=1` indefinitely.

### 2.5 Stress worker nonce-chain poisoning

Once the poison-tx quarantine (section 3.1) was in place, any tx that hung `applyBlock` was permanently blacklisted. The stress worker used a single deployer key; a poisoned nonce=N tx wedged every subsequent nonce=N+1, N+2 … because EVM requires sequential nonce inclusion. Worker runs consistently showed `multi:funded=0/3`, `batch_eth:0/5`, `deploy_fail`.

---

## 3. Mitigations Shipped

Each mitigation is standalone and does not depend on a later one.

### 3.1 Five-layer deadlock recovery

Nested defenses so no single layer's failure can wedge the chain indefinitely:

| Layer | Purpose | Commit |
|---|---|---|
| **Inner 30 s `applyBlock` timeout** (onFinalized) | Convert silent hang into a surfaced `applyBlock timeout 30000ms` error | `994f956` |
| **Outer 75 s `work()` timeout** (onFinalized wrapper) | Guarantee the onFinalizedQueue advances even if the inner timeout's retry path also hangs | `1289a0e` |
| **Poison-tx quarantine** (persistent) | Mark every tx a failed block tried to execute; reject from mempool and gossip on re-entry | `f20474a` + `3ac933a` |
| **`resetApplyingFlag()`** | Force-clear the re-entrant applyBlock guard after outer timeout so the next block can be applied | `9ace6f1` |
| **`process.exit(1)` + docker restart policy** | Rebuild BFT in-memory state from scratch when applyBlock/chain state desyncs; poison set is persisted to disk first (`<dataDir>/poisoned-txs.txt`) | `2a26466` |

Diagnostic instrumentation shipped alongside:

- Phase markers inside `applyBlock` for hang localization: `2f9f7eb`, `76c0148`
- Full `process.report.writeReport()` dump before exit: `c214b3d`
- Raw tx bytes + block context dump for offline replay: `ee43505`
- Offline replay harness: `90b0eb3` (`scripts/replay-hang-tx.ts`)
- State-manager concurrency stress test suite: `b887a63` (`node/src/storage/state-race.test.ts`)

### 3.2 Wall-clock slot alignment (consensus scheduling)

`consensus.ts:tryPropose` now gates on the chain tip's wall-clock slot:

```
currentSlot = floor(Date.now() / blockTimeMs)
tipSlot     = floor(tip.timestampMs / blockTimeMs)
if (tipSlot >= currentSlot) return   // already produced this slot
```

Bounds the whole network to at most one block per `blockTimeMs` window regardless of per-node timer phase. Measured block interval after patch: `[4, 2, 6, 4, 2, 3, 4, 2, 3]` seconds, mean 3.3 s, no zero-interval bursts. Commit `9946a12`.

### 3.3 CORS origin is now configurable

Node reads `COC_CORS_ORIGIN` (env), defaulting to `http://localhost:3000`. Deployment on `199.192.16.79` sets `COC_CORS_ORIGIN=*` in `docker-compose.testnet.yml` so browsers at `explorer.clawchain.io` get accepted responses. (Deployment change only; no source commit.)

### 3.4 Prefund-on-restart guard + genesis stateRoot

Two bugs in `chain-engine-persistent.ts` surfaced when validators were restarted with existing LevelDB state:

1. `init()` unconditionally called `evm.prefund()`, re-writing genesis balances into a populated state trie. This triggered `@ethereumjs/trie: Stack underflow` and crash-looped every validator.
2. The multi-validator genesis path created block 1 without committing the state trie or recording a `stateRoot`, so `eth_getBalance("latest")` returned 0 and no account could fund any transaction until the first regular block.

Fix: load `latestBlock` first; prefund only when the chain is empty; commit the state trie and embed its root as block 1's `stateRoot`. Commit `ac9c43e`.

### 3.5 Stress worker uses multiple prefunded accounts

Three additional Hardhat accounts (#3/#5/#6 → `0x90F7…`, `0x9965…`, `0x976E…`) were added to the `prefund` list in each validator config (1 000 ETH each). The cron worker was refactored to rotate through the 5 keys by round index (`KEYS[round % 5]`). A poisoned tx now only wedges its owning account's nonce chain, not the entire stress workload.

Verified: a 30-minute monitoring window under multi-account stress produced **zero** hangs, compared to 6 hangs in the 48-minute single-account baseline.

---

## 4. Root-Cause Investigation

### 4.1 Hypotheses eliminated (with evidence)

| Hypothesis | Evidence against |
|---|---|
| `@ethereumjs/vm` `runTx` has a bug | 10/10 captured hang-txs replayed against a pristine stock VM in 4–28 ms (`scripts/replay-hang-tx.ts`). |
| libuv thread-pool exhaustion (classic-level I/O) | `UV_THREADPOOL_SIZE=32` vs default 4: hang interval unchanged (7.5 min vs 8 min). |
| PersistentStateManager single-address write race | `state-race.test.ts`: 50 concurrent `putAccount` on same address completed in 47 ms. All 5 patterns pass (`b887a63`). |
| Single-process chain engine race | `chain-concurrency.race.test.ts` A+B+C (tx + proposer + RPC reads): 500 tx, 5 751 blocks, 61 k reads in 30 s, no hang. |

### 4.2 Latent defect discovered during investigation

The A+B+C+D variant of `chain-concurrency.race.test.ts` (add gossip-style concurrent `applyBlock` on an already-seen block) does **not** hang but **throws** `applyBlock re-entrant call detected` at `chain-engine-persistent.ts:357`. Every caller today depends on try/catch to swallow this throw:

- `consensus.ts` proposer path: falls back to an empty block
- `index.ts` P2P/wire `onBlock`: silent catch
- `index.ts` BFT `onFinalized`: logs + retries with `resetApplyingFlag()`

This is a fail-fast reaction, not genuine mutual exclusion — legitimate concurrent callers (proposer finishing while gossip re-delivers a block from BFT retry) cannot queue and wait. This defect is the target of the paired work item (section 5.1).

### 4.3 Unexplained remainder: live-node hang variant

The testnet symptom is a *hang*, not a throw. Local fixtures cannot reproduce a hang of this shape. The best current hypothesis is multi-component concurrency across at least the following subsystems simultaneously:

- BFT coordinator's outbound vote broadcast
- Wire protocol TCP send queue
- Mempool mutation during tx execution (gossip arriving during `runTx`)
- WebSocket RPC subscription fan-out

No evidence yet points to one specific interaction. The `process.report` dumps captured at exit show libuv idle (no pending fs/db I/O) and no JS stack for the hung Promise — consistent with lost resolution inside a microtask chain, but not specific enough to localize.

---

## 5. Future Debugging Plan

### 5.1 Queue-serialize `applyBlock` — in-flight this session

Replace the `applyingBlock` re-entrant throw with a Promise-chain queue inside `PersistentChainEngine` (and `ChainEngine` for parity). Each caller's `applyBlock()` returns a promise that resolves after prior queued applies complete. This removes the API design defect (section 4.2) and shrinks the race window that the live-node hang (section 4.3) exploits — even if it does not eliminate the hang itself.

See the paired plan file for detailed design.

### 5.2 Live-node integration fixture

The local race test spins up one `PersistentChainEngine`. The production symptom only reproduces with 3 real nodes exchanging BFT votes over wire TCP. Next iteration should either:

- Use `scripts/start-devnet.sh 3` to run a 3-node devnet in-process, drive it with single-account stress, hook `process.on('uncaughtException')` + `setInterval` heap snapshot on hang detection
- Or invoke the testnet's docker-compose devnet directly with a `--publish-all` port expose and attach Node inspector

### 5.3 Isolate `runTx` in a worker thread

If the hang remains unexplained after 5.2, move `@ethereumjs/vm runTx` into a `worker_threads` worker per tx. Main thread `Worker.terminate()` reliably kills a hung worker regardless of microtask state. The cost is one worker creation per tx (~1 ms); acceptable for a testnet, to be measured before production.

### 5.4 Upstream `@ethereumjs/vm` audit

File a minimal reproducer against `@ethereumjs/vm` 10.1.1 if 5.2/5.3 localize the issue to runTx's internal promise chain. No action today — we lack a minimal repro.

---

## Appendix A: Commit index

| Commit | Summary |
|---|---|
| `ac9c43e` | fix(node): prefund-on-restart crash + genesis stateRoot missing |
| `994f956` | fix(bft): timeout + per-call promise to prevent onFinalized deadlock |
| `1289a0e` | fix(bft): wrap entire onFinalized work() in 75s wall-clock timeout |
| `2f9f7eb` | diag(chain): add phase markers inside applyBlock for hang localization |
| `2a41831` | fix(evm): 15s timeout around @ethereumjs/vm runTx to prevent hangs |
| `76c0148` | diag(chain): extend phase markers to applyBlock entry DB reads |
| `f20474a` | fix(mempool): poison-tx quarantine for applyBlock-hanging transactions |
| `731633f` | fix(node): use imported keccak256 in onFinalized hot path |
| `9ace6f1` | fix(chain): force-clear applyingBlock guard after work slot timeout |
| `2a26466` | fix(bft): process.exit(1) + persistent poison on work slot timeout |
| `3ac933a` | fix(mempool): add missing loadPoisonedHashes method |
| `c214b3d` | diag(bft): dump full process report before exit on work slot timeout |
| `ee43505` | diag(bft): dump raw tx bytes + block context on work slot timeout |
| `9946a12` | fix(consensus): wall-clock slot alignment to cap block rate |
| `90b0eb3` | scripts(diag): offline replay harness for captured hang txs |
| `b887a63` | test(storage): concurrency stress tests for PersistentStateManager |
| `d2c81b3` | fix(explorer): contracts page slow/empty on public RPC — parallel + index-aware |
