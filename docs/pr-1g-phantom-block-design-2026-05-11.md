# PR-1G Design — Phantom block on restart

## Bug fingerprint (2026-05-11 T4 drill)

After T4 dual-stop drill, `validator-3` came back online reporting `h=4081`
while other validators (`v1/v2/v4/v5`) stayed at `h=4080`. The `h=4081`
block in v3's leveldb had hash `0x8acb…` which the other validators had
never finalized. Phase R (PR-1B's self-equivocation guard) then refused
to re-prepare a different `h=4081` from any new proposer → chain
deadlocked across the cluster.

The fundamental issue: **one validator local-finalized a block that
the consensus did not collectively finalize**. On restart, that
divergent block re-poisoned the cluster via gossip + Phase R.

## Why does this happen?

The current `onFinalized` callback (`index.ts:487`) is fired when the
LOCAL BFT coordinator sees quorum:

```typescript
onFinalized: (block) => {
  const finalizedBlock = { ...block, bftFinalized: true }
  await chain.applyBlock(finalizedBlock, true)
}
```

The `bftFinalized=true` flag is set by the LOCAL view. With N=5
relaxedQuorum=true (threshold 106 stake = 4 of 5 validators), a single
validator can race ahead and locally finalize while others see only 3
votes. That validator persists the block; others don't. On stop+restart,
the lone finalizer broadcasts its locally-finalized phantom.

Two concrete pre-conditions usually combine:
1. Async-network race during a force-propose (PR-1A H15 fallback)
2. Coordinated dual stop right at the moment of finalization

Both occurred in the 2026-05-11 T4 drill window.

## PR-1D made it worse (acknowledged)

`BlockIndex.repairLatestPointer()` promotes the highest stored `b:N`
to `LATEST_BLOCK_KEY` regardless of finalization status. After restart,
`LATEST = phantom`. The node then announces phantom-height to peers via
wire handshake → poisons consensus.

## Design options

### Option A — verify-on-init (recommended)

At init, after `repairLatestPointer`, do a one-shot peer tip-verification:

1. Query 3+ peers for `getBlockByNumber(localTip.number)`
2. If ≥ quorum-of-peers return the SAME hash as local: keep `LATEST`
3. If quorum disagrees or returns null:
   - Scan backwards from `LATEST` until we find a height where ≥quorum
     of peers agree with us
   - Demote `LATEST` to that height
   - Optionally wipe `b:>safeHeight` entries (or keep but never broadcast)
4. After demotion, trigger `forceSnapSync` to converge to canonical

**Pros**: Minimal protocol change. Recovery is automatic on restart.
**Cons**: Depends on peer reachability at startup (no peers → can't verify).
**Mitigation**: If no peers respond after timeout, fall back to current
behavior (trust LATEST) and log a warning. Operator can intervene if
needed.

### Option B — distinguish quorum-proven vs self-attested

Add a `quorumProvenFinalized: boolean` field on stored blocks:
- Local apply sets `bftFinalized=true, quorumProvenFinalized=false`
- After receiving signed acks from quorum-of-peers, update to `quorumProvenFinalized=true`
- `repairLatestPointer` only promotes if `quorumProvenFinalized=true`

**Pros**: Cleanest semantic — distinguishes "I think it's finalized"
from "the network confirms it's finalized."
**Cons**: Data migration; requires peer ack infrastructure; adds
~1-block latency to "trusted" finalization.

### Option C — never apply until quorum-ack

Delay `chain.applyBlock` from `onFinalized` callback until N additional
peers send `BFT confirm` messages.

**Pros**: Strongest safety property.
**Cons**: ~N round-trips of additional latency per block; breaks
existing 3 s/block target on cross-continent N=5.

## Recommendation

**Option A (verify-on-init)**. Lowest implementation cost, lowest
protocol risk, covers the observed bug. Option B is the long-term
clean design, but requires data migration and is overkill for the
testnet maturity phase. Option C is too costly.

## Implementation sketch — Option A

### `BlockIndex.repairLatestPointer` extension

Add a callback parameter to validate via peers:

```typescript
async repairLatestPointer(opts?: {
  validateWithPeers?: (height: bigint) => Promise<{
    ok: boolean
    peerHashes: Hex[]
  }>
}): Promise<{
  repaired: boolean
  latestBefore: bigint | null
  latestAfter: bigint | null
  highestStored: bigint | null
  // PR-1G additions:
  demoted: boolean
  reason?: "phantom-mismatch" | "peers-unreachable" | "no-data"
}>
```

When `validateWithPeers` is provided, after finding `highestStored`:
1. Call `validateWithPeers(highestStored)`
2. If `ok=true`: promote as before
3. If `ok=false`: scan backwards in steps of 1 height
4. Once found: promote to that height. Set `demoted=true`.

### Wire-up in `PersistentChainEngine.init`

`init` already calls `repairLatestPointer()`. Extend to pass a
`validateWithPeers` callback that hits `consensus.queryPeerHeight()`.

But `init` runs before `p2p` / `consensus` exist (chain comes up first).
**Restructure**: defer `repairLatestPointer` to AFTER p2p init, OR pass
a placeholder that returns "peers-unreachable" gracefully.

Cleaner: add `chain.verifyAndPromoteTipWithPeers(p2p)` method called
from `index.ts` after `p2p.start()`. Decouples chain init from network.

### Optional wipe path

If `demoted=true`, scan `b:N` for `N > newLATEST` and delete those
entries (plus `h:hash` entries). Frees disk + ensures these blocks
won't get re-broadcast from local store.

Could be made opt-in: log "demoted, X stale blocks retained" by default;
operator-callable `pruneStaleBlocksAfterTip()` for explicit cleanup.

### Tests

New `node/src/chain-engine-tip-sync.test.ts` cases (additions):
- `repairLatestPointer` with `validateWithPeers` returning ok=true: no demotion
- `repairLatestPointer` with `validateWithPeers` returning ok=false: demotes to backward-scan match
- `repairLatestPointer` with `validateWithPeers` throwing: falls back to existing behavior, logs warning
- `pruneStaleBlocksAfterTip` removes `b:N` for `N > LATEST`

### Files to modify

| File | Change |
|---|---|
| `node/src/storage/block-index.ts` | Extend `repairLatestPointer` with `validateWithPeers` opt + add `pruneStaleBlocksAfterTip(height)` |
| `node/src/chain-engine-persistent.ts` | Add `verifyAndPromoteTipWithPeers(p2p)` public method |
| `node/src/index.ts` | Call `chain.verifyAndPromoteTipWithPeers(p2p)` after `p2p.start()` |
| `node/src/chain-engine-tip-sync.test.ts` | New test cases (4-5 above) |

### Estimated effort

- Design: ~ done
- Implementation: 200-300 LoC (mostly in block-index + new public method)
- Tests: 100-150 LoC
- Integration validation: redeploy + retry T4 drill on 88780

Total ≈ half-day for code, full-day with cluster validation.

## Out of scope

- Generic byzantine fault recovery (more validators colluding) — that's
  Option C territory
- Migrating existing leveldb data — Option A doesn't change wire format
- Tuning H15 / PR-1A timeout intervals — separate PR
- Snap-sync threshold tweaks — separate PR
