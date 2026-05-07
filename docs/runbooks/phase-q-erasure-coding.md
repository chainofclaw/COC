# Phase Q Runbook — Reed-Solomon erasure coding

| | |
|---|---|
| Status | Shipped (2026-05-07) |
| Design | [`docs/phase-q-erasure-coding.md`](../phase-q-erasure-coding.md) |
| Validation | [`docs/phase-q-validation-2026-05-07.md`](../phase-q-validation-2026-05-07.md) |
| Tracking | [chainofclaw/COC#68](https://github.com/chainofclaw/COC/issues/68) |

## What it does

Adds opt-in Reed-Solomon erasure coding to the IPFS HTTP API. Files
encoded with `?erasure=N+M` are split into N data shards + M parity
shards per stripe. Any N of (N+M) shards reconstruct the original.
RS layers above the existing K=3 push-to-K replication; each shard is
itself a normal IPFS block subject to push-to-K + DHT advertisement.

| Scheme | Storage cost | Tolerance |
|---|---|---|
| Plain replication (K=3) | 3.0× | any 2 of 3 replicas |
| RS(4+2) | 1.5× | any 2 of 6 shards |
| RS(6+3) | 1.5× | any 3 of 9 shards |
| RS(8+4) | 1.5× | any 4 of 12 shards |
| RS(10+4) | 1.4× | any 4 of 14 shards |

## When to enable RS

Use `?erasure=N+M` when:
- The file is ≥ 1 MB (per-stripe overhead dominates for tiny files).
- The cluster has ≥ N+M validators that you trust to hold shards
  long-term, **or** you accept that with fewer peers the spread
  policy degrades to "everyone holds everything" (still functionally
  correct but no storage savings vs replication).
- File durability matters more than the small extra CPU on PUT/GET.

Skip RS (use plain `POST /api/v0/add`) when:
- File is small (< 256 KB — single shard is the whole file plus padding).
- The cluster has 3 or fewer validators (RS(4+2) at 3-validator cluster
  forces every peer to hold every shard, no different from K=3
  replication).
- You want the simplest possible recovery path (`/api/v0/cat?arg=<unixfs_cid>`
  works on plain CIDs without manifest decode).

## How to PUT

```bash
curl -X POST -F "file=@bigfile.bin" \
  "http://<node>:28786/api/v0/add?erasure=4+2"
```

Response (note: `+` must be URL-encoded as `%2B` on some clients):

```
HTTP/1.1 200 OK
X-COC-Erasure-Scheme: rs(4+2)
X-COC-Erasure-Original-Cid: bafybeif...   ← UnixFS root for back-compat retrieval
X-COC-Erasure-Stripe-Spread: distinct=4,worstOverlap=3   ← peer placement metric

{"Name":"bigfile.bin","Hash":"bafyreif...","Size":"<bytes>"}
```

The `Hash` is the **manifest CID** (CIDv1 / dag-cbor / sha256). It is
the entry-point for retrieval — clients store this and use it later.
The original UnixFS CID is also produced and stored as a side-effect
for back-compat retrieval.

### Headers explained

- `X-COC-Erasure-Scheme: rs(N+M)` — confirms the scheme that was applied.
- `X-COC-Erasure-Original-Cid` — UnixFS root. `cat` on this CID still
  works (no erasure decode needed). Useful when peers are healthy and
  you want the cheaper read path.
- `X-COC-Erasure-Stripe-Spread: distinct=K,worstOverlap=L` — diversity
  metric. `K` is the number of distinct peers that received a shard;
  `L` is the largest count of shards landed on a single peer. Lower
  `L` is better. `L > 1` indicates the cluster has fewer reachable
  peers than there are shards in a stripe.

### Validation rules

- `N ≥ 1`, `M ≥ 1`, both integers
- `N ≤ 24` (`@ronomon/reed-solomon` `MAX_K`)
- `M ≤ 6` (`@ronomon/reed-solomon` `MAX_M`)
- Shard size fixed at 256 KB in v1; tunable later
- File-size cap inherits from the IPFS HTTP body limit (50 MB + 64 KB
  headroom; see Phase Q.1 Q.2 notes).

Malformed `?erasure=` returns HTTP 400 `invalid erasure spec`.

## How to GET

```bash
# manifest CID — does erasure decode (auto-detects via dag-cbor codec)
curl -X POST "http://<node>:28786/api/v0/cat?arg=<manifest_cid>" -o file.bin

# back-compat: UnixFS CID still works
curl -X POST "http://<node>:28786/api/v0/cat?arg=<original_cid>" -o file.bin

# tar archive form
curl -X POST "http://<node>:28786/api/v0/get?arg=<manifest_cid>" -o file.tar
```

The HTTP server inspects the CID's multicodec to dispatch:

| CID codec | Path |
|---|---|
| `dag-cbor` (0x71) | parse manifest → erasure decode |
| `dag-pb` (0x70) | UnixFS reader |
| `raw` (0x55) | return bytes verbatim |

## Monitoring

### Per-file shard inventory

```bash
curl -X POST "http://<node>:28786/api/v0/erasure/status?arg=<manifest_cid>" | jq
```

Returns:

```json
{
  "fileSize": 1048576,
  "scheme": "rs",
  "n": 4,
  "m": 2,
  "stripes": [
    { "dataAvailable": 4, "parityAvailable": 2, "needsRepair": false }
  ]
}
```

`needsRepair: true` means this node holds < N+M shards locally for that
stripe. The repair tick (next 10 min) will try to reconstruct missing
slots from parity. Non-manifest CID input → HTTP 415 `not_a_manifest`.

### Repair-loop metrics (Phase Q.5 counters)

`coc-ipfs-repair` exposes the new counters in the loop's `getMetrics()`
return value (Prometheus exposure deferred to Q+1):

| Metric | Meaning |
|---|---|
| `erasureManifestsScanned` | manifests successfully parsed this tick |
| `erasureStripesRepaired` | stripes where ≥ 1 shard was reconstructed |
| `erasureShardsReconstructed` | individual shards regenerated |
| `erasureStripesSkippedInsufficient` | stripes with > M missing → unrecoverable from local store alone |
| `erasureManifestParseFailed` | manifest fetch/parse errors |

Tick cadence: 10 min. Per-tick manifest budget: 20 (configurable via
`erasureManifestBatchSize`).

### Log lines worth watching

```
[coc-ipfs-repair] erasure stripe repaired
  {stripe:N, reconstructed:K, missingData:X, missingParity:Y}
```
Successful reconstruction.

```
[coc-ipfs-repair] erasure stripe unrecoverable
  {manifestStripe:N, present:K, n:Required, missingData:X, missingParity:Y}
```
> M shards missing locally. The repair loop in Q.5 only uses local
shards; if peers hold the missing pieces the on-demand `fetchRemote`
path inside `cat`/`get` recovers them transparently. A persistent
`unrecoverable` log line means the data is gone from the swarm.

```
[ipfs] erasure stripe push: peer overlap detected
  {rootCid:..., distinctPeersUsed:K, worstPeerOverlap:L}
```
Stripe push had to fall back because peer count < N+M. Not an error;
informational — recipients will still hold every shard, just with
overlap > 1.

## Troubleshooting

### `503 insufficient_shards`

```json
{"error":"insufficient_shards","message":"stripe N: only K shards available, need J"}
```

The decoder couldn't find ≥ N shards even after asking peers via
`fetchRemote`. Causes:

1. **Multi-node failure**: more than M validators holding shards crashed
   simultaneously. Restart them; once peers come back the on-demand
   pull during `cat` recovers.
2. **Shard inventory loss**: shards got evicted by LRU, the manifest's
   pin tracking didn't propagate, or disk corruption took out > M
   slots. Inspect via `erasure/status` per node — if every node reports
   `dataAvailable < n`, the data is irrecoverable.
3. **Wire/DHT not connected**: `coc_dhtFindProviders <cid>` from the
   reading node should return ≥ 1 provider per missing shard. If it
   returns `[]`, peers can't be reached or the DHT routing table is
   empty. Restart the node to re-bootstrap.

Recovery procedure for case 1:

1. Make sure all validators are up: `systemctl is-active coc-node@N` on each.
2. Confirm wire connections: peers should appear in `coc_getPeers` output.
3. Retry the `cat` — `fetchRemote` will pull missing shards on demand
   and cache them locally.
4. (Optional) Force the repair loop to converge faster by restarting
   the reader node — the loop runs at boot + every 10 min.

### `400 invalid erasure spec`

The `?erasure=` value didn't match `^\d+\+\d+$`. Examples that fail:
`?erasure=4-2`, `?erasure=four-plus-two`, `?erasure=`. Use `4+2`,
`6+3`, etc. (URL-encode as `4%2B2` if your client mangles `+`).

### `415 not_a_manifest` on `erasure/status`

The CID you queried is not a Phase-Q erasure manifest (e.g. a UnixFS
root or a raw block). Use the manifest CID you got back from the PUT
response (`Hash` field), not the `X-COC-Erasure-Original-Cid` header.

### Cross-node `cat` slow / hangs

Wire client to the peer holding shards may need to reconnect. Check:

```bash
# Confirm DHT knows about the manifest's shards on peers
curl -X POST -d '{"jsonrpc":"2.0","method":"coc_dhtFindProviders","params":["<shard_cid>"],"id":1}' \
  http://<reader>:28780
```

A non-empty `providers` list with > 1 entry is a healthy sign. If only
`self` is returned, peers haven't propagated their advertise records
yet — wait one DHT advertise cycle (~3 min).

## Deploy notes

`@ronomon/reed-solomon` is a **native addon**. Build dependencies on
each validator host:

```
apt-get install -y build-essential python3
```

Already added to `scripts/deploy-validator-server.sh` step [1/9]. ~200 MB
extra disk + ~2 min cold install per server. After first install the
build artifact (`binding.node`) is cached in `node_modules` — no rebuild
on `git pull` unless Node ABI changes.

## Performance

Validator hardware (4-core QEMU, server-1) measured 2026-05-07:

| Scheme | 10 MB encode | Throughput | 100 MB encode |
|---|---|---|---|
| RS(4+2) | 1.4 ms | 7.4 GB/s | 20.6 ms |
| RS(6+3) | 2.9 ms | 3.7 GB/s | 18.8 ms |
| RS(8+4) | 1.4 ms | 7.3 GB/s | 16.9 ms |
| RS(10+4) | 1.8 ms | 5.5 GB/s | 16.8 ms |

End-to-end PUT latency (encode + N+M shard CID computations + dag-cbor
manifest + push to peers + pin) is dominated by CID hashing + network
push, not RS encoding.

Decode is symmetric: ≤ 12 ms for 100 MB across all tested schemes.

## Known limitations & follow-ups

- **Repair loop is local-only**: `coc-ipfs-repair` uses `store.has` to
  check shard availability. Missing shards are reconstructed only from
  *locally-held* shards. If a node has < N shards locally, the tick
  logs `unrecoverable` even when peers could supply the missing pieces.
  On-demand fallback (`store.get` → `fetchRemote`) still recovers
  transparently during a `cat`. Proactive pull-from-peers during repair
  is a Q+1 follow-up.
- **No `erasure/repair` admin RPC**: operators wait for the 10-min tick.
  Adding a manual trigger is small-scope follow-up work.
- **Pin model is per-shard**: every shard CID is pinned individually
  alongside the manifest CID. `pin/ls` returns one entry per shard, not
  one entry per file. A "pin manifest recursively → walks stripe arrays"
  refactor is documented in the design but deferred.
- **Streaming decode for files > 100 MB**: not implemented; whole-file
  in-memory decode works up to ~50 MB (HTTP body cap). Larger files
  need a streaming path — Q+1.
- **3-validator testnet caveat**: with peers < N+M, push spread degrades
  to "everyone holds everything." Not a bug, just doesn't deliver
  storage savings until cluster grows.

## Quick reference

```
PUT     POST /api/v0/add?erasure=N+M  (multipart)
GET     POST /api/v0/cat?arg=<manifest_cid_or_unixfs>
GET tar POST /api/v0/get?arg=<manifest_cid_or_unixfs>
status  POST /api/v0/erasure/status?arg=<manifest_cid>
DHT     POST /api/v0/.../coc_dhtFindProviders?cid=<...>  (RPC port)
```

## Contacts

For Phase Q questions or follow-up work, reference:
- Tracking issue: [chainofclaw/COC#68](https://github.com/chainofclaw/COC/issues/68)
- Design: `docs/phase-q-erasure-coding.md`
- Q.7 validation: `docs/phase-q-validation-2026-05-07.md`
- Benchmark replay: `scripts/phase-q-benchmark/`
