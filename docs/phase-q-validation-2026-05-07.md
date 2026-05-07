# Phase Q.7 — multi-server testnet validation results (2026-05-07)

| | |
|---|---|
| Tracking issue | [chainofclaw/COC#68](https://github.com/chainofclaw/COC/issues/68) |
| Design doc | [phase-q-erasure-coding.md](./phase-q-erasure-coding.md) |
| Deployed commit | `1a21ca9` (Q.6 + findByNodeId case-insensitivity fix) |
| Cluster | 3 validators: `209.74.64.88` (s1) / `159.198.44.136` (s2) / `199.192.16.79` (s3) |

## Summary

Q.4 + Q.5 + Q.6 work end-to-end against the live multi-server testnet. The
design doc's matrix was written for a 6-validator cluster; the 3-validator
testnet is a strict subset where every shard ends up on every node (peer
count < N+M means push spread degrades to "everyone holds everything", which
is itself the strongest replication possible). Test outcomes adapted
accordingly.

A pre-existing case-mismatch bug in `WireConnectionManager.findByNodeId`
surfaced during the matrix and was fixed in commit `1a21ca9` (lowercased
both sides of the lookup; regression test added).

## Test matrix

| ID | Test | Result |
|---|---|---|
| T1 | `POST /api/v0/add?erasure=4+2` 1 MB → manifest CID + `X-COC-Erasure-Stripe-Spread: distinct=2,worstOverlap=9` | ✅ |
| T2 | Cross-server cat (manifest + UnixFS fallback) — byte-identical from all 3 | ✅ 3/3 |
| T3 | Stop server-2 (peers=2 alive); cat from s1 + s3 | ✅ both alive servers serve |
| T4 | Stop server-3 too (only s1 alive); cat from s1 | ✅ sole survivor serves |
| T5 | Restore peers; delete > M (=3) data shards on s1; cat | ✅ HTTP 503 `insufficient_shards` with stripe + count detail |
| Spread metric (Q.6) | `X-COC-Erasure-Stripe-Spread: distinct=2,worstOverlap=9` reflects push to 2 non-origin peers, evenly split (9 + 9 = 18 attempts for 6 shards × K=3) | ✅ matches spread theory for peer count ≤ N+M |

`X-COC-Erasure-Stripe-Spread` reads `distinct=2` not `3` because `pushStripe`
excludes the origin from the candidate pool — that's correct, and the origin
already has all 6 shards locally. Effective replication is 3 distinct peers
each holding the full stripe.

## Performance benchmark on validator hardware

Run on server-1 (4-core QEMU virtual CPU). Library: `@ronomon/reed-solomon@6.0.0`,
shard size 256 KB, median of 3 runs, byte-identical verification after decode.

| Scheme | Size | Stripes | Encode median | Encode MB/s | Decode median | Decode MB/s |
|---|---|---|---|---|---|---|
| RS(4+2) | 1 MB | 1 | 0.5 ms | 1844 | 0.3 ms | 3675 |
| **RS(4+2)** | **10 MB** | **10** | **1.4 ms** | **7393** | 0.6 ms | 17799 |
| RS(4+2) | 100 MB | 100 | 20.6 ms | 4854 | 5.6 ms | 17833 |
| RS(6+3) | 11 MB | 7 | 2.9 ms | 3675 | 0.8 ms | 13418 |
| RS(6+3) | 101 MB | 67 | 18.8 ms | 5357 | 8.0 ms | 12509 |
| RS(8+4) | 10 MB | 5 | 1.4 ms | 7279 | 1.5 ms | 6860 |
| RS(8+4) | 100 MB | 50 | 16.9 ms | 5923 | 10.8 ms | 9272 |
| RS(10+4) | 100 MB | 40 | 16.8 ms | 5937 | 11.4 ms | 8749 |

Q.1 design target: **< 300 ms encode for 10 MB**. Achieved on validator
hardware: **1.4 ms** (RS(4+2)) — under target by **214×**. All tested schemes
encode 100 MB in < 25 ms.

## Bug surfaced + fixed (commit `1a21ca9`)

`WireConnectionManager.findByNodeId` did strict `===` against the peer-id
input. Wire handshake stores `getRemoteNodeId()` in EIP-55 mixed-case
(taken from peer's `config.nodeId`). DhtNetwork.routingTable normalises
to lowercase on insert, so `findProviders` returns lowercase. Strict `===`
silently missed every cross-node fetchRemote — surfaced when server-1
tried to pull restored shards from peers post-kill.

Fix: lowercase both sides of the comparison. Same keying convention DHT
already uses internally.

Regression test: register peer with mixed-case ID, look up with lower /
mixed / upper case — all return the client.

## Q.5 limitation observed

When server-1 had 3 of 6 shards locally and peers held the rest, the
existing `coc-ipfs-repair` tick logged
`erasure stripe unrecoverable {present:3, n:4, missingData:3}` and skipped
reconstruction. This is by design in Q.5: `store.has` is local-only, so
the tick only attempts parity reconstruction from locally-present shards.

For server-1 to recover its missing shards, the existing on-demand
fetchRemote path inside `store.get` does the work — pulling missing
shards from peers transparently as `cat`/`get` reads. With the case fix,
this works (verified for fresh CIDs).

A proactive "pull missing shards from peers during repair tick" extension
would be a useful Q+1 follow-up — let me note it as out-of-scope here.

## Caveats unique to a 3-validator cluster

The design doc assumes a 6-node cluster where push-to-K spread can land
each shard on a distinct peer. With 3 validators:

- `pushStripe` spread biases away from peers already used, but with only
  2 non-origin peers the result is `distinct=2, worstOverlap=9`. Both
  peers receive every shard at least once.
- Killing 1 validator: 2 of 3 nodes still hold the full stripe → cat
  succeeds, BFT advances (relaxed quorum threshold = 2 of 3).
- Killing 2 validators: 1 node holds the full stripe (the origin) → cat
  succeeds for that node. BFT halts (1 < quorum). Chain advance pauses
  until peers return.
- Killing 3 validators is not testable distinct from "kill all".

The "kill 3 of 6 with RS(4+2) → 503" test from the design is reproduced
by deleting shards on the surviving node instead of killing nodes — same
end state from the decoder's point of view.

## Acceptance

All matrix tests PASS. Performance under target by orders of magnitude.

## Out-of-scope follow-ups (Q+1)

- Proactive pull during repair tick (currently local-only)
- 6+ validator cluster to exercise true peer-distinct spread
- Streaming decode for files > 100 MB
- Encrypted shards (Phase R)
- BLS proof-of-erasure (Phase P+1)
