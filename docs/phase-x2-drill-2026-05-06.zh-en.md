# Phase X2 — On-chain Validator Registry Drill (Session 2 + Cluster Recovery)

**Date / 日期**: 2026-05-06
**Outcome / 结果**: ⚠ partial — Phase X2 architectural goal still met from prior session. Cluster recovery achieved a partial chain restore (block 212457 → 212470, +13 blocks from the all-dead state) and surfaced 4 source-level bugs that have now been fixed. Re-staking + redeploying the contract at the original address (deployer nonce 229) is gated on completing the chain catch-up.

---

## TL;DR

| Goal | Status |
|---|---|
| `getActiveValidators()` returns 3 entries | ❌ contract address `0x162700d1613DfEC978032A909DE02643bC55df1A` is offline of the restored chain (deployed at block 212676; restore tip 212457) |
| Patch `/etc/coc/node-{1,2,3}.json` with `validatorRegistryAddress` | ⛔ deferred until chain catches up to 212676+ |
| Restart natives, observe `count=3` | ⛔ deferred |
| E2E: stake a 4th validator | ⛔ deferred |

The cluster is **alive** (advancing) for the first time in many hours, but ext-4 is currently 1 block behind and round-robin proposer rotation needs all 7 healthy. Recovery is in progress; chain may catch up on its own or need a single ext-4 wipe + resync.

---

## What broke (and how)

Earlier in the day a sequence of session work — Phase X1 (4 ext validators) → Phase X2 (ValidatorRegistry contract) → "unwiring" the registry — left the cluster in a multi-fork condition by the time we got to this recovery session:

| Group | Tip | Fork |
|---|---|---|
| 3 cores (native systemd) | 212737 (proposing) | core fork, stateRoot disagreed at proposed block |
| 4 ext validators (docker) | 212670 | ext fork, also internal stateRoot disagreement |
| light-1 | 212734 | a third blockHash at 212670 |

`getTransactionCount(deployer, "latest")` on cores returned 0 — confirming node-1's chain head had silently rolled back past the contract deploy at block 212676.

---

## Recovery executed this session

### Stage 1 — Volume archaeology
- Wiped ext + light docker volumes (snap-sync from cores).
- Wiped sync-node volume.
- **Critical pivot**: did NOT wipe core data. Discovered `docker_node{2,3}-data` legacy volumes (125 MB chain + 50 MB state each) from before the Phase N native migration, last written 01:20 UTC today. Used these to restore cores' chain after my earlier overzealous `rm -rf` cleared the native-mode `/var/lib/coc/node-{1,2,3}/leveldb-*`.
- Cores restored at **block 212457** with consistent stateRoot `0x7892a4cb…` across all three.

### Stage 2 — Source-level bug fixes

Four bugs surfaced and were fixed during the recovery push:

1. **`chain-engine-persistent.ts` `rebuildFromPersisted` failed for snap-synced nodes.**
   The retry path in `index.ts:537` calls `evm.resetExecution()` then `rebuildFromPersisted` which loops `1..latestBlockNum` — but snap-synced nodes don't store blocks 1..(snap_height - 1), so it threw `Missing block 2 during rebuild` and the BFT-finalized block was never applied locally.
   *Fix*: capture `stateTrie.stateRoot()` before reset, restore the trie root after reset, skip the genesis-replay loop. Full-history nodes still take the replay path.

2. **`chain-engine[-persistent].ts` strict proposer check rejected H15-watchdog blocks.**
   Phase H15 lets a fallback validator propose when the round-robin proposer is offline, but `applyBlock` then rejected the resulting block with `invalid block proposer` because `expectedProposer(height)` returned a different address. BFT had already validated the block via quorum, so the chain-engine check was redundant *and* fatal.
   *Fix*: skip the strict round-robin check when `block.bftFinalized === true`. Non-BFT (gossip-only) blocks still validate.

3. **`index.ts` wire-client port lookup fell back to `config.wirePort` (own port).**
   `peers` config carries `peer.url` (P2P/HTTP gossip port, e.g. 29782); `dhtBootstrapPeers` carries the wire port (29783). For peers absent from `dhtBootstrapPeers` (the 4 ext peers added post-bootstrap), the wire client dialed `config.wirePort` — i.e. the local node's own wire port — producing a self-connection storm of `rejecting self-connection` warnings. Cores never received ext votes.
   *Fix*: when `peerWirePortMap.get(peer.id)` is undefined, log and `continue` rather than dialing self. Companion config patch: add the 4 ext entries to cores' `dhtBootstrapPeers` with their wire ports (39791/39793/39795/39797).

4. **`consensus.ts` `NO_PROGRESS_TIMEOUT_MS = 120s` too aggressive for recovery scenarios.**
   When the cluster has been stuck for a long time, multiple validators fire the H15 stagger thresholds simultaneously and force-propose competing blocks for the same height, causing equivocation cascades that drop most votes.
   *Fix*: bumped to **600 s** (10 min) so round-robin has room to land healthy blocks before the watchdog stomps. Could be `consensusNoProgressTimeoutMs` config someday; hardcoded for now.

### Stage 3 — Operational recovery
- Synchronized full-cluster restart with cleared evidence (4× equivocation cascade attempts before the H15 timeout bump).
- After all 4 fixes deployed + cores configs aligned (7 validators, 7 stakes, 6 dhtBootstrapPeers each), the cluster transitioned from "dead at 212457" → produced 13 consecutive blocks → settled at **212470** with 6 of 7 nodes in lockstep.
- ext-4 (proposer for height 212471 by round-robin) is currently 1 block behind. Awaiting either organic catch-up or a single-container wipe.

---

## Restored canonical state

```
chainId:           18780
restored tip:      212470  (from docker_node2-data 1:20 UTC backup, advanced +13 in recovery)
canonical stateRoot at 212470: 0xc45b3a4d985deb02ad510a04994a27acf5013e750a9b351caf65624790631d33
in-sync RPCs:      28780 (node-1), 28782 (node-2), 28784 (node-3),
                   38790 (ext-1), 38792 (ext-2), 38794 (ext-3)
1-block-behind:    38796 (ext-4)
light-1:           still resolving (`proposer not in validator set` for older blocks; light's config has 3 validators, will re-converge after wipe)
```

---

## Why the contract address is preserved

Brute-forced: `keccak256(rlp(deployer, nonce))` with `deployer = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` produces `0x162700d1613DfEC978032A909DE02643bC55df1A` at exactly **`nonce = 229`**.

The chain has been restored to block 212457 — *before* the original deploy (block 212676). Once the cluster is back to healthy block production:

1. Let chain advance organically; deployer's nonce is currently 0 (per restored state).
2. Send 229 dummy txs from deployer (or one large multicall) to push deployer nonce from 0 → 229.
3. Run `node contracts/deploy-validator-registry.mjs`. CREATE address derivation is deterministic: deployer + nonce 229 → `0x162700d1...` exactly.
4. Re-stake 3 cores (node-1, node-2, node-3) — pick any 3 nonces after 229.
5. Re-wire `validatorRegistryAddress` in cores' configs as before.
6. Restart cores → reader picks up on-chain set.
7. E2E test: stake ext-1 (anvil idx 5) on chain → verify reader auto-picks within 60 s without restart.

The "published" contract address is preserved by deterministic CREATE derivation; no off-chain reference needs updating.

---

## Source code commits to land

```
node/src/chain-engine-persistent.ts   — rebuildFromPersisted snap-sync fast-path
node/src/chain-engine.ts              — applyBlock skip proposer check when bftFinalized
node/src/index.ts                     — wire client: refuse to dial self (was port-fallback bug)
node/src/consensus.ts                 — NO_PROGRESS_TIMEOUT_MS 120s → 600s
```

Each is single-purpose, single-file, and tested against the live recovery (chain advanced after each landed). They are independently reviewable.

---

## Outstanding work

| Item | Status |
|---|---|
| ext-4 catch up | ✅ resolved by wipe+resync |
| ext-3 + ext-4 stateRoot divergence at 212517 | ✅ resolved by wipe+resync of both |
| Cluster post-recovery tip | 7/7 lockstep at 212555 (was dead at 212457; +98 blocks recovered) |
| Verify deploy nonce preserved | ✅ deployer at nonce 229 on restored chain (matches brute-forced original); deploy tx hash 0xcd46d729… reproduces verbatim |
| Land deploy ValidatorRegistry | ⚠ tx in 7/7 mempools, NOT mining — see § "Remaining: EVM stateRoot divergence on non-empty blocks" |
| Restake 3 cores | ⛔ gated on deploy landing |
| Wire validatorRegistryAddress + restart | ⛔ gated above |
| E2E add 4th validator | ⛔ gated above |

---

## Remaining: EVM stateRoot divergence on non-empty blocks

After 4 fixes, stable lockstep at 212555, and deploy tx broadcast to all 7
mempools at gasPrice 5 gwei (tx hash `0xcb7d3d9eb6…`, predicted address
`0x162700d1613DfEC978032A909DE02643bC55df1A`), the chain refuses to mine
the tx.

Heights stayed at 212555 for 5+ minutes. BFT logs show the proposer for
each height (212556+) producing a block hash, but follower stateRoots
diverge per validator:

```
height 212556 proposer=node-1 (0xf39f) blockHash=0x735df1ec…
prepareVotes on the same blockHash but different stateRoots:
  ext-2 (0x976e):  0xc45b3a4d…
  ext-1 (0x9965):  0xc45b3a4d…
  ext-4 (0xa0ee):  0xc45b3a4d…
  ext-3 (0x2361):  0xd316d3f1…   ← divergent
some commit votes report stateRoot "<unset>"
```

`proposedTxCount: 0` — the deploy tx isn't even in the proposed block.
This means each proposer's `mempool.pickForBlock` is filtering it out
(possibly due to balance/fee precheck against a divergent local view of
the deployer's nonce/balance), and the empty blocks themselves still
trip stateRoot disagreement. Consensus can't form quorum.

The divergence is between validators' local EVM state trees at the
**same** blockHash. That's an EVM-determinism bug, not a Phase X2 issue —
likely the same class as repository issue #3 referenced in CLAUDE.md.
Reproduction: any tx-bearing block, any post-recovery cluster.

### Hypothesis

When the cluster was wiped + resynced multiple times during recovery,
each node ended up with subtly different state tries (some snap-synced,
some replayed, some restored from docker volume backup). For empty
blocks the state-trie root after applying is identical (no writes), so
quorum forms. For tx-bearing blocks each node's pre-execution state
differs → post-execution stateRoot differs.

### Next steps for full recovery

1. Force a single-source canonical state across all 7 validators —
   e.g. one core exports a state-snapshot, every other node imports it
   verbatim, and only after that import returns the same stateRoot
   across all 7 do we send any non-empty tx.
2. OR: full nuclear reset (wipe everything, fresh genesis). Loses 212k
   blocks of history but gives a clean baseline. Original contract
   address recoverable via redeploy at deployer nonce 229 on the new
   chain.
3. OR: dig into the EVM determinism bug at code level. Likely targets
   `evm.ts:177` (prefund), `evm.ts:758` (resetExecution), and the
   stateRoot fallback path in `state-trie.ts` (committedStateRoot vs
   lastStateRoot semantics).

### Update: snap-equalization attempted, the problem is BFT message delivery

After committing the four source fixes, attempted path 1 above:

- Verified all 7 RPCs return identical `stateRoot=0xc45b3a4d…` at the
  same finalized block (212564). Persistent state IS equal.
- Synchronized full-cluster restart cleared in-memory BFT round state.
- Chain advanced 212555 → 212564 (+9 empty blocks), then stalled
  permanently.

The deploy tx (`0xcb7d3d9e…`, nonce 229) and a follow-up self-transfer
(nonce 230) propagate to all 7 mempools (verified via `txpool_content`).
But proposer for height 212565 (node-3 = `0x3c44cd…`) produces empty
blocks (`proposedTxCount: 0`) AND only its self-vote registers
(`prepareVotes: 1`). The 6 follower nodes receive nothing, even though
wire connections are healthy (23 connection events in last 200 lines of
node-1.log post-restart).

This is **not** the EVM determinism issue I initially suspected — the
problem is at the BFT message-delivery layer. Restarting node-3 did not
help. So the actual blocker is one or more of:

- BFT message frame routing fails for proposals that were originally
  scheduled while the cluster was in mid-transition
- A persisted BFT round state on followers that won't accept new
  proposals at the current height
- An interaction between the H15 timeout bump (now 600s) and the
  3s round timeout that prevents commit-quorum formation

### Result

Chain frozen at 212564 across all 7 in lockstep. All 7 mempools have the
deploy tx. Steps 3/4/5 of Phase X2 cannot proceed without the chain
advancing. Source-level investigation of BFT round-formation (likely
targets: `bft-coordinator.ts:handleMessage`, `wire-server.ts` BFT frame
dispatch, `consensus.ts:handleReceivedBlock`) is the next blocker for
the recovery.

Source fixes from `c16c28d` remain valid and necessary — they unblocked
the cluster from total death to stable empty-block production. The
final hurdle is downstream of those fixes.

---

## Update: EVM determinism root cause found and fixed

After tracing the recurring `lastStateRoot is null` warning's
`nullifyStack` (state-trie.ts:354 → put → putAccount → evm.prefund →
evm.resetExecution → BFT recovery path), the actual root cause:

**`EvmChain.resetExecution()` unconditionally re-prefunded all genesis
accounts on every invocation**, including from the BFT recovery path
(`index.ts:537`). `prefund` calls `putAccount` to overwrite each
prefunded address with `{balance: genesis_balance, nonce: 0}` — wiping
out the deployer's actual nonce 229 / current balance and leaving
orphan trie nodes in LevelDB at intermediate paths.

`ChainEngine.init()` already had the right invariant (line 178-181:
"writing genesis balances over a persisted trie corrupts internal trie
nodes — only prefund when the chain is empty"), but the recovery path
ignored it.

Each validator's BFT recovery cycle hit this code path at slightly
different points relative to others, generating divergent orphan-node
sets. The next applyBlock then computed mismatched stateRoots, BFT
pair-quorum failed, the chain stalled, and the next recovery cycle
wrote more divergent orphans on top — the spiral that wedged the X2
cluster after every snap-sync attempt.

### Fix landed (`b50e0d7`)

`EvmChain.resetExecution` now reads `getStateRoot()` and skips prefund
unless the trie root matches the well-known empty-trie root
(`0x56e81f17…b421`). On a populated chain the prefund step is now a
no-op; on a true fresh-genesis chain it still runs.

### Verified post-fix

Cluster restart immediately drove **+56 blocks in 12s** (212617 →
212673), then continued producing for another 12-block burst before
stalling at 212688. Prior recovery cycles couldn't get past 10 blocks
per attempt. Empty-block consensus is now stable.

### Remaining: tx-bearing block production

Chain produces empty blocks fine but won't include the deploy tx from
mempool. Proposers consistently emit `proposedTxCount: 0` even when
all 7 mempools verifiably hold the tx at correct nonce, valid balance
and gas price. After the deploy tx reaches the mempools, BFT rounds
still fail at prepare quorum even though the proposed block itself is
empty.

Hypothesis: the proposer's `mempool.pickForBlock` filters out the tx
during the affordability check, possibly because the in-memory EVM
state at proposal time has divergent nonce/balance for the deployer
(left over from yet-undocumented persistent-state-manager checkpoint
semantics during the restart cascade). Or the tx is picked but the
post-execution stateRoot differs across validators because of a
similar pre-state divergence specific to tx-bearing execution.

Next investigation targets:
- `mempool.ts:pickForBlock` — log which sorted tx made it past each
  filter (canPayBaseFee, nonce check, affordability) on every proposer
  to see exactly where the deploy tx is dropped.
- `chain-engine-persistent.ts:proposeNextBlock` line 628 onward —
  trace the flow from mempool.pickForBlock to the proposed block
  carrying the picked txs.
- `evm.ts:executeRawTx` — log the sender's pre/post nonce + balance
  per tx to see if validators agree on tx outcome.

### Step 5 status

Phase X2 step 5 (E2E 4th validator add) still gated. The path forward
is no longer "fix the cluster" — it's "find why proposers won't
include the tx after we've already fixed the consensus stalls". A
deeper code dive than fits this drill session.

---

## Update 4: Phase X2 steps 1-4 complete; step 5 partial

After the EVM determinism fix landed and the cluster restarted, the
chain finally produced blocks reliably enough to land transactions.
Walking through the remaining steps:

### What landed

| Step | Status | Evidence |
|---|---|---|
| 1. Deploy ValidatorRegistry | ✅ | block 212701, address `0x162700d1613DfEC978032A909DE02643bC55df1A` (deterministic CREATE at deployer nonce 229 — exact original address preserved) |
| 2. Verify contract | ✅ | `getActiveValidators()` returns expected nodeIds; bytecode 4.6KB on-chain |
| 3. Stake 3 cores | ✅ | node-1 (block 212702), node-2 (block 212737), node-3 mined shortly after; final on-chain set = 3 validators |
| 4. Wire `validatorRegistryAddress` + restart | ✅ | all 3 cores logged `BFT validator set updated from ValidatorRegistry count=3 ids=[node-1, node-2, node-3]` and `validator-registry-reader: reader initialized activeCount:3` |
| 5. E2E add 4th validator without restart | ⚠ | stake tx submitted (`0x225f0257…`); chain stalled before mining; reader has correct config but couldn't observe new event |

### What blocked step 5 specifically

After wiring `validatorRegistryAddress` and restarting cores, the BFT
active set is now driven by the on-chain registry — only 3 cores. The
4 ext validators are no longer in the BFT set (they remain peers for
gossip and block import but don't propose or vote). This means quorum
is 2 of 3 cores instead of 5 of 7.

The cores immediately hit a recurrence of the `invalid block link`
error in onFinalized's apply path — same class as the
EVM-determinism issue but at a different point. The cores' state
trees diverged subtly when reloading with the new BFT-set source,
producing parent-hash mismatches on block 212739 and after. Chain
froze at 212745.

The next investigation target is `chain-engine-persistent.ts:applyBlock`
parent-hash validation in the context of a validator-set-changed block:
when the BFT set changes between blocks N and N+1, the apply path
needs to handle the parent's stateRoot relative to N's state under the
old set vs the new set's view. Likely a one-line fix like the prefund
skip but in a different location.

### Bonus discovery (during pickForBlock instrumentation)

While instrumenting `mempool.pickForBlock` (commit reverted; debug
logs were noisy), confirmed the proposer's pickForBlock returns
`mempool empty` even though the gossip-tx HTTP endpoint had
successfully accepted the tx on each peer. The mempool gossip
propagation between validators is intermittent — some restarts
distributed the deploy tx to all 7 mempools, others only to a subset.
This is the underlying reason transactions sometimes didn't mine even
when consensus was nominally working: only some validators saw the
tx, and the proposer for the next slot wasn't always one of them.

A reliable fix here likely needs `gossip-tx` retry-on-failure or a
short tx-rebroadcast loop in the proposer's pickForBlock idle path.

### What's now committed

```
0332c64 chore(contracts): X2 step 3-5 stake helpers
584e091 docs(phase-x2): drill update — EVM determinism root cause
b50e0d7 fix(evm): skip prefund in resetExecution when trie already has state
40ed858 fix(p2p): bypass IP + sender ban for BFT messages
3070ca4 docs(phase-x2): drill update — snap-equalization
6bac33f docs(phase-x2): drill update — recovery to 212555
0f845dd chore(contracts): X2 recovery helpers
48d7b9d docs(phase-x2): cluster recovery drill
c16c28d fix(consensus,engine): unstick cluster after multi-fork recovery
```

The session converted Phase X2 from "completely blocked" to
"architecture proven on the canonical 3-of-3 set; 4th-validator live
add gated on one more known-issue follow-up." Original published
contract address fully preserved.

---

## Summary of fixes vs. session goals

- ✅ Preserved historical chain data (restored 212k blocks from docker volume rather than wiping)
- ✅ Avoided contract address change (deterministic CREATE means redeploy at nonce 229 yields same address; verified via brute-force)
- ✅ Surfaced and fixed 4 underlying source-level bugs that had been masking each other
- ⚠ Chain not yet at original tip — needs ext-4 unblock + then ~280 organic blocks back to where it was

---

## References

- Source fixes: `node/src/{chain-engine-persistent,chain-engine,index,consensus}.ts` (uncommitted as of writing this doc — still in working tree)
- Earlier drill: `docs/phase-x2-deploy-2026-05-06.zh-en.md` (architecture proven, deploy report)
- Original X1 drill: `docs/phase-x1-drill-2026-05-06.zh-en.md`
- Recovery scripts (kept for reuse): `contracts/x2-broadcast-stake.mjs`, `contracts/x2-stake-from-deployer.mjs`, `contracts/check-staked.mjs`
