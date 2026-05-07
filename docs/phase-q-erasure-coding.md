# Phase Q — Reed-Solomon Erasure Coding for IPFS Storage

| | |
|---|---|
| Status | Drafted (proposal) |
| Owner | Pending assignment |
| Created | 2026-05-07 |
| Depends on | Phase C (push-to-K replication, repair loop) — already shipped |
| Tracking issue | TBD (chainofclaw/COC) |

## 1. Problem statement

The current IPFS layer ships with **K=3 push-to-K replication** (`coc-ipfs-wiring.ts:138`). Every locally-stored block is proactively pushed to its 3 closest peers in DHT space. This gives:

| Property | Value |
|---|---|
| Storage overhead | **3×** raw size |
| Tolerance | survives **2 of 3** replicas going down |
| Repair cost (one node lost) | re-replicate all of the lost node's data |

For a multi-server testnet with three validators each holding 50 GB, push-to-K gives ≤ 50 GB unique addressable storage at 150 GB physical cost. As we onboard user-nodes (5–50 ext-validators) the storage cost dominates and 3× overhead becomes wasteful.

Reed-Solomon (RS) erasure coding lets us trade CPU for storage:

| Configuration | Storage overhead | Tolerance |
|---|---|---|
| Replication K=3 | 3.0× | 2 of 3 |
| RS(4, 2) | 1.5× | 2 of 6 |
| RS(6, 3) | 1.5× | 3 of 9 |
| RS(10, 4) | 1.4× | 4 of 14 |

A 4+2 scheme on a 9-validator network costs the same as 1.5× replication but tolerates any 2 simultaneous failures — strict improvement.

## 2. Goals

1. Support `POST /api/v0/add?erasure=N+M` to encode a file into N data shards + M parity shards. Returns a single **manifest CID**; original file CID is still produced as a side-effect for back-compat.
2. Support `POST /api/v0/get?arg=<manifest_cid>` to transparently reconstruct from any N-of-(N+M) shards.
3. Repair loop integration: detect missing data shards, reconstruct from parity, re-pin.
4. Co-exist with K=3 — do not remove or alter push-to-K. Erasure coding layers *above* it: each shard is itself a normal IPFS block subject to push-to-K.
5. Shard placement policy that maximises spread across distinct peers (avoid co-locating > N/M shards on one peer).
6. Multi-server testnet validation: kill any M nodes, GET still succeeds; kill M+1, GET fails predictably.

## 3. Non-goals

- Streaming encode/decode (load whole file into memory; revisit at file > 100 MB).
- Cross-region geo-distribution.
- Automatic conversion of pure-replicated CIDs to erasure-coded form.
- Replacing K=3 — RS is opt-in per file via `?erasure=N+M`.
- Erasure-aware DHT routing (just use existing push-to-K + provider records).
- Fountain codes / LDPC / Raptor — RS is the entry point; other codes are a future phase.

## 4. Architecture

### 4.1 Data flow — encode

```
Original file (e.g. 1 MB)
        │
        ▼
UnixFS chunker  (existing — DEFAULT_BLOCK_SIZE = 256 KB → 4 chunks)
        │
        ▼
Buffer chunks into shard-sized groups (e.g. 256 KB each)
        │
        ▼
Reed-Solomon encoder (N data + M parity)
        │  ┌── data shard 0 ──┐
        ├──┤ data shard 1     │  N IPFS blocks
        │  │ ...              │  (each a regular CIDv1 raw block)
        │  └── data shard N-1 ┘
        │
        ▼  parity shard 0     ┐
        ├──┤ parity shard 1   │  M IPFS blocks
        │  │ ...              │  (also raw, but tagged)
        │  └── parity shard M-1┘
        │
        ▼
Manifest CID (dag-cbor):
  { version: 1, scheme: "rs", n: N, m: M, shardSize: <bytes>,
    fileSize: <bytes>, originalCid: <unixfs cid>,
    dataCids: [...], parityCids: [...] }
```

### 4.2 Data flow — decode

```
GET /api/v0/get?arg=<manifest_cid>
        │
        ▼
Fetch manifest block, parse fields
        │
        ▼
Try fetching data shards in parallel
        │
        ├── all N data shards present → concat → return (fast path)
        │
        └── data shard k missing
                  │
                  ▼
            Fetch parity shards until N total shards retrieved
                  │
                  ▼
            RS decoder reconstructs missing data shard(s)
                  │
                  ▼
            Concat data shards → return
```

### 4.3 Shard size

Shard size = max chunk size (256 KB). For files > 256 KB the encoder must operate over a "stripe" of N chunks at a time:

- File size F, chunk size C, data shards N
- Stripe size = N · C bytes
- Number of stripes = ⌈F / (N·C)⌉
- Each stripe produces N data + M parity shards = N+M IPFS blocks
- Total IPFS blocks per encoded file = stripes · (N+M)

Files smaller than one stripe pad with zeros; padding length recorded in manifest.

### 4.4 Manifest format (dag-cbor)

```cbor
{
  "v": 1,                     // manifest version
  "scheme": "rs",             // future: "ldpc", "fountain", etc.
  "n": 4,                     // data shards per stripe
  "m": 2,                     // parity shards per stripe
  "shardSize": 262144,        // bytes per shard (== chunk size)
  "fileSize": 1048576,        // original file size (bytes, pre-padding)
  "originalCid": "bafy...",   // UnixFS root for direct retrieval (back-compat)
  "stripes": [
    {
      "data":   ["bafy0...", "bafy1...", "bafy2...", "bafy3..."],
      "parity": ["bafyP0...", "bafyP1..."]
    },
    ...
  ]
}
```

CIDv1 + dag-cbor codec; manifest itself is a normal IPFS block under push-to-K.

### 4.5 Library choice

Evaluate (in order of preference):

| Library | License | Pure JS? | Notes |
|---|---|---|---|
| `@ronomon/reed-solomon` | MIT | yes | Production-ready, CRC tables, well-benchmarked |
| `reed-solomon-erasure` (Rust binding via napi) | MIT | no — needs prebuilds | Fastest; complicates deploy |
| `tetracarbonate/reedsolomon` | MIT | yes | Smaller, fewer features |

**Decision criterion**: pure JS preferred for portability across native + container deploys. Switch to native binding only if benchmarks show pure-JS encoding > 200 ms/MB on validator hardware.

## 5. Integration points

### 5.1 New module: `node/src/ipfs-erasure.ts`

```typescript
export interface ErasureEncoder {
  encode(file: Uint8Array, params: { n: number; m: number; shardSize: number }):
    Promise<{ manifestCid: CidString; manifest: ErasureManifest; shards: IpfsBlock[] }>
  decode(manifest: ErasureManifest, fetchShard: (cid: CidString) => Promise<Uint8Array | null>):
    Promise<Uint8Array>
}
```

Pure helper module — no I/O, no network. Fully unit-testable with synthetic blocks.

### 5.2 IPFS HTTP API extension (`node/src/ipfs-http.ts`)

- `POST /api/v0/add?erasure=N+M` — new query param. When present, encode after chunking, store all N+M shards via existing `store.put`, store manifest, pin manifest. Return manifest CID as `Hash`.
- `POST /api/v0/get?arg=<cid>` — auto-detect manifest by reading first block; if `scheme: "rs"`, take decode path; else fall through to existing UnixFS reader.
- New `POST /api/v0/erasure/status?arg=<manifest_cid>` — return per-stripe shard availability for ops dashboards.

Validation:
- N + M ≤ 14 (Galois field size limit for Reed-Solomon over GF(256) with reasonable performance)
- N ≥ 1, M ≥ 1, both integers
- shardSize fixed at 256 KB in v1; tunable later

### 5.3 Repair loop (`node/src/coc-ipfs-repair.ts`)

Add a new tick branch:
1. Iterate pinned manifest CIDs (manifests are recursive-pinned just like UnixFS roots).
2. For each manifest, parse + check availability of every shard via `findProviders`.
3. If a stripe has < N data shards available locally and at peers, attempt parity-based reconstruction:
   - Fetch any N shards (data + parity)
   - Decode missing data shard(s)
   - Re-pin reconstructed shards locally + push-to-K
4. Emit metric `coc_ipfs_erasure_repair_total{result="success|fail|skip"}`.

### 5.4 RPC

- `coc_erasureStatus(manifestCid: string): { stripes: Array<{ dataAvailable: number; parityAvailable: number; needsRepair: boolean }> }`
- `coc_erasureBenchmark(): { encodeMbPerSec: number; decodeMbPerSec: number }` (admin-only)

### 5.5 Pinning + LRU eviction

- Manifest CID → recursive pin (recurse into all shards).
- Existing `IpfsBlockstore.pin` already handles recursive sets via the file-meta map; extend to read manifest format and walk the shard list.
- LRU eviction: pinned shards are immune (existing rule); manifest pin propagates immunity to all shards.

### 5.6 Push-to-K spread policy

Current push-to-K picks K-closest peers per CID via DHT. For shards of the same stripe this could happen to overlap (two shards land on the same peer), reducing fault tolerance.

**Phase Q.4 enhancement**: when storing a stripe's shards in sequence, track which peers each shard was pushed to and bias subsequent pushes toward unused peers. Failsafe: if no unused peer exists (e.g. stripe size > peer count), fall back to random. This is best-effort — DHT-distance ordering still drives the primary choice.

## 6. Milestones

| ID | Deliverable | Estimate |
|---|---|---|
| Q.1 | Library evaluation + this doc finalised + tracking issue opened | 0.5 day |
| Q.2 | `ipfs-erasure.ts` module: encode/decode helpers + 30+ unit tests (random data, corruption M, corruption M+1, padding edge cases, oversized file rejection) | 2 days |
| Q.3 | Manifest format + dag-cbor encode/decode + manifest-aware reader | 1 day |
| Q.4 | HTTP API: `?erasure=N+M`, manifest-detecting GET, status endpoint + integration tests | 1.5 days |
| Q.5 | Repair loop integration + parity-based reconstruction + metrics | 1.5 days |
| Q.6 | Push-to-K spread policy + multi-shard placement tests | 1 day |
| Q.7 | Multi-server testnet validation matrix (kill M nodes, kill M+1 nodes, kill manifest-holding node) + performance benchmarks | 1 day |
| Q.8 | Documentation + ops runbook + changelog entry | 0.5 day |

**Total**: ~8.5 dev-days. Wall-clock with reviews: ~2 weeks.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pure-JS RS too slow for 100 MB files | Benchmark Q.2 first; if > 500 ms/MB fall back to native binding |
| Manifest format collision with future codecs | `scheme` field keyed; v2/v3 add new schemes without breaking v1 readers |
| Decoder deadlock when M+1 shards missing | Hard fail with structured `HttpError(503, "insufficient shards")`; document in API contract |
| Storage cost regression if user enables RS naively (e.g. RS(1, 5)) | Reject N < 2 in API validator |
| Repair loop hot-loops on permanently-lost stripes | Per-CID retry budget (3 attempts) + dead-letter table; surface in `getStats()` |
| Padding bytes reveal file size for adversaries | Document that file size is in manifest plaintext; encryption is out of scope (separate phase) |
| Concurrent repair vs PUT race on same manifest | Manifest pin is recursive + atomic file-meta write (existing TOCTOU lock at `ipfs-http.ts:498`) |

## 8. Test plan

**Unit (Q.2)**:
- Roundtrip random 1 KB / 1 MB / 10 MB / 50 MB — all sizes byte-identical after decode.
- Corrupt M shards in arbitrary positions — decode succeeds.
- Corrupt M+1 shards — decode fails with documented error code.
- Padding edge cases: file size = 0, 1 byte, exactly 1 stripe, 1 stripe + 1 byte.
- Validate N+M ≤ 14, N ≥ 1, M ≥ 1.

**Integration (Q.3 — Q.6)**:
- `POST /api/v0/add?erasure=4+2` → returns manifest CID.
- `POST /api/v0/get?arg=<manifest>` → byte-identical to original.
- Pin manifest → all shards listed in `pin/ls`.
- Kill 2 of 6 shards on disk → repair tick reconstructs them.
- Manifest format roundtrip via dag-cbor library.

**Multi-server (Q.7)**:
| Test | Setup | Expected |
|---|---|---|
| M-1 fail | RS(4,2), 6 nodes, kill 1 | GET still works |
| M fail | RS(4,2), 6 nodes, kill 2 | GET still works (uses parity) |
| M+1 fail | RS(4,2), 6 nodes, kill 3 | GET returns 503 with insufficient-shards error |
| Manifest holder fail | RS(4,2), kill the only node holding manifest CID | manifest is push-to-K replicated → still recoverable |
| Repair convergence | Kill 2 nodes, wait 10 min repair tick | shards re-replicated to surviving nodes |

**Performance (Q.7)**:
- Encode + decode benchmarks at 1 MB / 10 MB / 100 MB on representative validator hardware.
- Target: ≤ 300 ms encode for 10 MB on a 4-core x86_64 VM.

## 9. Out-of-scope (deferred to later phases)

- Streaming encode/decode for files > 100 MB (Phase Q+1)
- Encrypted shards (Phase R — confidentiality)
- Adaptive RS scheme selection per file size / replication target (Phase Q+2)
- Cross-region geographic placement constraints (Phase S — geo-replication)
- BLS-based proof-of-erasure / proof-of-storage attestations (Phase P+1)

## 10. Decision points to resolve before Q.2 starts

1. Library: confirm `@ronomon/reed-solomon` is acceptable license-wise (MIT — should be fine).
2. Default N+M for testnet ops: proposed `4+2` (matches 6-node single-region testnet target).
3. Manifest codec: dag-cbor (proposed) vs JSON (simpler, larger). Vote: dag-cbor — already a dependency via dag-pb.
4. Should RS opt-in flag persist with the file (`/api/v0/get` always re-encodes when re-PUT) or be one-shot? Proposed: one-shot — re-PUT defaults to plain UnixFS unless flag is repeated.
5. Repair tick budget: proposed 5 manifests per tick (vs current 50 raw CIDs) — encoding cost is per-manifest, not per-CID.

## 11. Acceptance criteria

Phase Q is complete when:
- All 8.5 days of milestones land in `chainofclaw/COC main`.
- Multi-server validation matrix in §8 all PASS or explicitly SKIP.
- Encode/decode benchmarks documented in `docs/multi-server-deploy-*.md`.
- Tracking issue closed; changelog entry under "Phase Q — erasure coding".
- Operator-facing ops runbook explains: when to enable RS, expected storage savings, recovery procedure for M+1 failures.
