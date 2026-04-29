# COC P2P Storage Mechanism — Full Reference

> Complete specification of how distributed IPFS storage works in COC under the current Phase C Step 2 testnet config.
> Illustrated by tracing a real **100 MiB file** end-to-end: chunking strategy, cross-node replication protocol, final replica count.
> Chinese version: `p2p-storage-mechanism-zh.md`.

## 0. TL;DR — What happens when you store a 100 MiB file

Uploading a 100 MiB file through `node-1`'s IPFS HTTP on the 3-validator testnet produces:

| Metric | Value |
|---|---|
| UnixFS leaf chunks | **400** (256 KiB each) |
| DAG root nodes | **1** (~16 KB, holds 400 IPLD Links) |
| Total content-addressed blocks | **401** |
| Wire pushes per block | 2 (to `node-2` and `node-3`) |
| Total `pushBlock` wire RPCs | 401 × 2 = **802** |
| Nodes actually storing the file | **3** (node-1 as source, node-2/3 receive full copies via push) |
| DHT providers per block | **3** (after cross-node gossip converges) |
| PoSe Merkle leafHash | keccak256(chunk) × 400 = 12 800 bytes metadata |
| Merkle tree depth | ceil(log₂ 400) = **9 levels** |
| PoSe proof size per chunk | 9 × 32 = **288 bytes** |
| Outbound bandwidth (node-1 → others) | 100 MiB × 2 = **200 MiB** |

---

## 1. Design Principles

COC's P2P storage layer extends IPFS content-addressing with **4 extra guarantees**:

1. **UnixFS chunking** — large files split into 256 KiB blocks (IPFS de-facto standard)
2. **Content addressing** — CIDv1 (dag-pb codec + sha256) gives a bijection between bytes and CID
3. **Push-to-K active replication** — every local PUT immediately pushes to K nearest peers; no "who's going to pull?" dependency
4. **DHT provider records + gossip** — nodes share "who holds what CID" so losing one node does not lose data

These came in Phase C (completed 2026-04-24). Pre-Phase-B was just a local blockstore behind an HTTP endpoint.

---

## 2. Module Map

```
User PUT entry point       IPFS HTTP      POST /api/v0/add → ipfs-http.ts:handleAdd
 │                              │
 │                              ▼
 │                        UnixFS chunker   ipfs-unixfs.ts:addFile
 │                              │
 │                              ▼
 │                      IpfsBlockstore     ipfs-blockstore.ts:doPut("local")
 │                              │  onPut hook
 │                              ▼
 │                    coc-ipfs-wiring.ts   onPut / pushToK / broadcastProviderAdvertise
 │                     ┌────────┼────────────────────────┐
 │                     ▼        ▼                        ▼
 │              DhtNetwork    WireClient              WireClient
 │              putProvider   pushBlock×K             ProviderAdvertise
 │              (local record)(wire-protocol 0x12)   (wire-protocol 0x14)
 │                            │                        │
 │                            ▼                        ▼
 │                     remote wire-server     remote wire-server
 │                     ─ verify CID=sha256(bytes)       ─ onProviderAdvertise
 │                     ─ putFromPeer("remote-cache")      hook → dht.putProvider
 │                        │
 │                        ▼
 │                 onPut(source="remote-cache")
 │                 ─ self-announce only
 │                 ─ gossip back
 │                 ─ DO NOT cascade push
 ▼
PUT response  ← X-COC-Replicas-Warning header if below minReplicas
```

---

## 3. Upload flow, step by step

### 3.1 Entry: HTTP PUT

User sends `POST /api/v0/add` to any validator's IPFS HTTP port (on testnet: container-internal 5001 — not exposed to host, see §3.2 of the testnet status doc). `ipfs-http.ts:handleAdd` parses multipart body, gets raw bytes.

### 3.2 UnixFS chunking

`ipfs-unixfs.ts:addFile` runs three steps:

**Step 1: chunk**
```typescript
const chunks = chunkBytes(bytes, DEFAULT_BLOCK_SIZE)  // DEFAULT = 262 144 (256 KiB)
```
100 MiB = 104 857 600 bytes → **400 chunks**, each exactly 256 KiB.

**Step 2: leaf CIDs**
Each chunk wrapped in UnixFS + DAG-PB:
```typescript
for (const chunk of chunks) {
  const unixfs = new UnixFS({ type: "file", data: chunk })
  const node = dagPB.prepare({ Data: unixfs.marshal(), Links: [] })
  const encoded = dagPB.encode(node)
  const digest = await sha256.digest(encoded)
  const cid = CID.createV1(dagPB.code, digest)   // ← CIDv1, bafybe... base32
  await this.store.put({ cid: cid.toString(), bytes: encoded })
  leafCids.push(cid.toString())
}
```
Each `blockstore.put` fires the onPut hook chain described in §3.4.

**Step 3: DAG root**
```typescript
const rootNode = buildUnixFsRoot(leafCids, chunkSizes, bytes.length)
const rootBytes = dagPB.encode(rootNode)   // ~16 KB (400 IPLD Links)
const rootCid = CID.createV1(dagPB.code, sha256Digest(rootBytes))
await this.store.put({ cid: rootCid.toString(), bytes: rootBytes })
```
`rootCid` (`bafybeigxw35d6dw5...`) is what's returned to the user.

**Side product** (used by Phase C PoSe):
```typescript
const merkleLeaves = chunks.map(c => hashLeaf(c))  // keccak256(chunk) × 400
const merkleRoot   = buildMerkleRoot(merkleLeaves)  // single bytes32
```
This Merkle tree is **separate from the UnixFS DAG**. DAG uses sha256 (IPFS standard), Merkle uses keccak256 (EVM standard). PoSe challenge verification uses the latter.

### 3.3 Local persistence

`IpfsBlockstore.put()` calls `doPut(block, "local")`, writes bytes to `${dataDir}/storage/blocks/${cid}`, then fires `onPut(cid, bytes, { source: "local" })`.

**Critical**: `source = "local"` vs `"remote-cache"` determines whether pushToK cascades (avoiding exponential blow-up).

### 3.4 onPut hook chain: three actions

Phase C's onPut (in `coc-ipfs-wiring.ts`) does three things per block:

**(a) Self-announce locally**
```typescript
cfg.dht.putProvider(cid, cfg.localNodeId, DEFAULT_PROVIDER_TTL_MS)  // 24h TTL
```

**(b) Cross-node gossip**
```typescript
broadcastProviderAdvertise(cid)
// = iterate all connected WireClients, send ProviderAdvertise frame (wire 0x14)
```
Every directly-connected peer adds `cid → [senderId]` to its DhtNetwork. **Single-hop** — the receiver does not re-broadcast. Each node broadcasts its own CIDs, so the whole mesh converges.

**(c) Active push (only if source="local")**
```typescript
if (source === "local") pushToK(cid, bytes)  // fire-and-forget, doesn't block put
```

### 3.5 pushToK internals

```typescript
pushToK(cid, bytes):
  targets = dht.routingTable.findClosest(cidToRoutingKey(cid), K+1)
            .filter(peerId !== localNodeId)
            .slice(0, K)
  K = min(replicationFactor=3, peerCount - 1)
  for each target in parallel:
    client = connMgr.findByNodeId(target)
    client.pushBlock(cid, bytes, pushTimeoutMs=10s)
```

**K clamp**: configured `replicationFactor = 3`, but with only 2 other peers available (3-node testnet), K clamps to 2.

**Routing key projection**: `cidToRoutingKey(cid) = keccak256(utf8Bytes(cid))` — maps arbitrary CID formats (bafybe... / 0x... / Qm...) into the peer-ID XOR distance space so Kademlia's `findClosest` works.

**pushBlock wire frame** (`wire-protocol.ts:BlockRequestPayload`):
```typescript
{ 
  requestId: uuid, 
  cid: "bafybe...", 
  push: true, 
  bytes: base64(chunk)   // 1 MiB max per frame; 256 KiB chunks fit easily
}
```

Receiver-side (`wire-server.ts`) verifies:
1. Decode base64 → Uint8Array bytes
2. Size ≤ 1 MiB? Otherwise reject "oversize"
3. Hash check:
   - If CID starts with `0x` → verify `keccak256(bytes) === cid` (legacy)
   - Otherwise → parse CIDv1, `sha256(bytes) === multihash.digest` (Phase C)
4. Call `blockstore.putFromPeer({cid, bytes})`
5. Reply BlockResponse `{found: true}`

**Why `putFromPeer` instead of `put`**: distinguishes local vs remote-cache provenance. remote-cache's onPut **does not trigger pushToK** (otherwise every received push would push to K new peers → exponential).

### 3.6 Waiting for replication results

Phase C3.1 added a step in `ipfs-http.ts:handleAdd` before returning:
```typescript
const replicaStatus = await awaitReplicationResult(meta.cid, 8000)
if (replicaStatus.worstReplicaCount < minReplicas /*=2*/) {
  headers["X-COC-Replicas-Warning"] = `got ${worst}/${minReplicas} (cid=${worstCid})`
}
res.writeHead(200, headers)
```
Response may carry `X-COC-Replicas-Warning: got 0/2` — upload still returns 200, but flags failure to reach minReplicas. 3-node testnet normally gets 2/2 so no warning.

---

## 4. Wire Protocol Frames

Phase C added two message types (`wire-protocol.ts:MessageType`):

| opcode | name | purpose | payload |
|---|---|---|---|
| `0x12` | BlockRequest | pull (push=false) / push (push=true) | `{requestId, cid, push?, bytes?}` |
| `0x13` | BlockResponse | reply to above | `{requestId, cid, found, bytes?, error?}` |
| `0x14` | ProviderAdvertise | single-hop "I hold this CID" gossip | `{cid, ttlMs?}` |

Other frame types (Handshake, BFT, Block, Transaction, FindNode, Ping) existed in Phase B.

**Priorities** (`wire-protocol.ts:DEFAULT_PRIORITIES`):
- BFT messages: CRITICAL
- Block propagation + BlockRequest/Response: HIGH
- ProviderAdvertise: LOW (gossip can lag without affecting liveness)

---

## 5. DHT Provider Records

### 5.1 In-memory structure

`dht-network.ts:DhtNetwork.providerRecords`
```typescript
Map<cidHex_lowercased, Map<peerId_lowercased, expiresAtMs>>
```

Outer key: lowercased CID string.
Inner: `{peerId → expiry timestamp}`.

### 5.2 Operations

| API | behavior |
|---|---|
| `putProvider(cid, peerId, ttlMs=24h)` | insert or renew |
| `findProviders(cid, maxK=3)` | return ≤K non-expired peers; lazy-clean expired on query |
| `removeExpiredProviders()` | active scan (called by `refresh()` timer every 5 min) |
| `reannounceSelfProviders()` | Phase C3.2: for each `blockstore.listPins()` CID, `putProvider(cid, localId)` |

### 5.3 Caps

- ≤ 64 providers per CID (`MAX_PROVIDERS_PER_CID`)
- Over cap → evict soonest-to-expire
- Bounds memory under sybil flood

### 5.4 Cross-node convergence

For the same CID, after one PUT + gossip:
- **Origin node**: `providerRecords[cid]` = `{localId, peer2, peer3}` (peer2/3 gossip back)
- **peer2/3 nodes**: `providerRecords[cid]` = `{localId, peer2, peer3}` (origin gossip + self-announce from putFromPeer + peer2↔peer3 cross-gossip)

**All 3 nodes have identical provider views for any given CID.**

### 5.5 Lifecycle

```
t=0        Origin puts + gossips + pushToK → 3 providers converge
t=12h      Origin runs reannounceSelfProviders: re-putProvider + re-gossip all pins
           Provider TTLs across the network refresh to t+12h
t=24h      If t=12h reannounce didn't run (node offline), records start expiring
t=10min ×N Repair loop scans pins; for any `findProviders(cid) < minReplicas`
           calls pushToK to top up replicas
```

---

## 6. Retrieval (GET)

### 6.1 Path

User `GET /api/v0/cat?arg=<cid>` or `GET /ipfs/<cid>`:

```
http handler
 → unixfs.readFile(rootCid)
    → blockstore.get(rootCid) fetch DAG root
    → parse 400 leaf Links
    → for each leaf: blockstore.get(leafCid)
       → local hit → return
       → local miss → ENOENT → fetchRemote hook
          → dht.findProviders(cid, 3)
          → connMgr.requestBlockFromAny(providers, cid)
             → parallel BlockRequest push=false to each provider
             → first {found:true, bytes} wins
          → blockstore.doPut(cid, bytes, "remote-cache")
            → local cache + self-announce in DHT (NO push)
    → concat 400 chunks return
```

### 6.2 ⚠️ 100 MiB retrieval limit

`ipfs-unixfs.ts:readFile` has a **`MAX_READ_SIZE = 50 MiB`** safety cap:
```typescript
for (const link of rootNode.Links) {
  ...
  totalSize += chunk.length
  if (totalSize > MAX_READ_SIZE) {
    throw new Error(`readFile exceeds max size: ${totalSize} > ${MAX_READ_SIZE}`)
  }
}
```

**So a 100 MiB file PUTs successfully and lives on all 3 nodes, but GET-ing it via `/api/v0/cat` or `/ipfs/<cid>` throws after chunk ~200.**

To retrieve large files, one must:
- Bypass `readFile`: get the DAG root directly, then stream leaf-by-leaf via `blockstore.get(leafCid)` (requires ipfs-http changes to support range/streaming)
- Adjust `MAX_READ_SIZE`
- Or pull block-by-block via `/api/v0/block/get?arg=<leafCid>`

This is a Phase D or later concern; the Phase C code keeps the limit as-is.

### 6.3 fetchRemote concurrency

```typescript
requestBlockFromAny(peerIds, cid, opts):
  concurrency = min(opts.concurrency ?? 3, peerIds.length)
  timeoutMs = opts.timeoutMs ?? 5000
  // Promise-race: parallel BlockRequest to `concurrency` peers
  // first {found: true, bytes} wins, others abort
```

`DEFAULT_FETCH_PROVIDER_FAN_OUT = 3`. On the 3-node testnet, the effective max concurrency is 2 (excluding self).

---

## 7. Fault Tolerance — Self-Healing

### 7.1 Re-announce loop (C3.2)

`DhtNetwork.reannounceSelfProviders()`
- Period: `REANNOUNCE_INTERVAL_MS = DEFAULT_PROVIDER_TTL_MS / 2 = 12h`
- Behavior: iterate `blockstore.listPins()`, for each pin call `putProvider(cid, localId)` (refresh own TTL) + `broadcastProviderAdvertise(cid)` (refresh peer TTLs)
- Batch cap: ≤ 100 CIDs per tick; rest picks up next tick — no startup thundering herd
- Effect: long-lived nodes never let their own provider records expire under the 24h TTL

### 7.2 Repair loop (C3.3)

`IpfsRepairLoop.runOnce()` (from `coc-ipfs-repair.ts`)
- Period: `DEFAULT_TICK_INTERVAL_MS = 10 min`
- Behavior:
  ```
  pins = blockstore.listPins()
  for cid in pins:
    providers = dht.findProviders(cid, minReplicas=2)
    if providers.length < minReplicas:
      underReplicated.push(cid)
  batch = underReplicated.slice(0, repairBatchSize=50)
  for cid in batch:
    block = blockstore.get(cid)
    pushToK(cid, block.bytes)
  ```
- Anti-thundering-herd: ≤ 50 CIDs per tick; reentrance guard blocks overlapping ticks
- Tolerant: missing bytes (shouldn't happen) logs WARN and skips rather than crashing the tick

### 7.3 Composite resilience

For a 100 MiB file's 401 blocks:
- Any single validator dies: other two still hold full copies; DHT records self-heal
- Two die (only node-1 remains):
  - BFT consensus halts (needs 2/3), but data survives
  - New joiner does `blockstore.get` → ENOENT → fetchRemote → DHT finds node-1 → pulls
- Node returns: repair loop detects < 2 replicas within 10 min, auto-pushes to restore K

---

## 8. PoSe Storage Proof (Merkle path)

The storage layer handles "file is really on the node". **PoSe storage proof** (Phase C2) handles "was the node still holding claimed CIDs this epoch":

```
Challenger (agent)
  ─ Pick CID + chunkIndex (from CidRegistry pool, pre-filtered by DHT)
  ─ Send challenge to prover(node-i)

Prover (coc-node sidecar)
  ─ blockstore.get(leafCid_i) → chunk bytes
  ─ leafHash = keccak256(bytes)
  ─ merklePath = buildMerklePath(all400LeafHashes, chunkIndex)
  ─ Return receipt { leafHash, merkleRoot, merklePath, chunkIndex } + EIP-712 sig

Verifier (agent)
  ─ Recompute a merkleRoot from leafHash + merklePath
  ─ Compare to the receipt's merkleRoot — pure Merkle math
  ─ 5% probability extra "audit sample": fetch the same chunk from another
    DHT-independent provider
     - Recompute keccak256(bytes) vs prover's claimed leafHash
     - Mismatch → InvalidStorageAudit → node's storageBps drops
```

For a 100 MiB file:
- Merkle tree: 400 leaves → depth 9
- Single chunk path = 9 sibling hashes × 32 B = **288 B**
- Full proof message (leafHash + root + path): 9 × 32 + 32 × 2 = **352 bytes**
- This is the "unit size" of storage proof — independent of file size (scales with log₂ chunk count).

---

## 9. Parameter Reference

| Module | Constant | Value | Purpose |
|---|---|---|---|
| UnixFS | `DEFAULT_BLOCK_SIZE` | 256 KiB (262 144) | chunk size |
| UnixFS | `MAX_READ_LINKS` | 10 000 | max leaves per DAG root |
| UnixFS | `MAX_READ_SIZE` | 50 MiB | `readFile` cap |
| wiring | `DEFAULT_REPLICATION_FACTOR` | 3 | K = push target count |
| wiring | `DEFAULT_FETCH_PROVIDER_FAN_OUT` | 3 | GET parallel peers |
| wiring | `DEFAULT_FETCH_TIMEOUT_MS` | 5 000 | single-peer block fetch timeout |
| wiring | `DEFAULT_PUSH_TIMEOUT_MS` | 10 000 | single-peer push timeout |
| HTTP | `minReplicas` | 2 | PUT warning threshold |
| DHT | `DEFAULT_PROVIDER_TTL_MS` | 24 h | provider record lifetime |
| DHT | `REANNOUNCE_INTERVAL_MS` | 12 h | re-announce period |
| DHT | `MAX_PROVIDERS_PER_CID` | 64 | per-CID provider cap |
| repair | `DEFAULT_TICK_INTERVAL_MS` | 10 min | repair loop period |
| repair | `DEFAULT_MIN_REPLICAS` | 2 | below = trigger push |
| repair | `DEFAULT_REPAIR_BATCH_SIZE` | 50 | CIDs repaired per tick |
| wire | frame max size | 16 MiB | single frame encoding cap |
| wire | push bytes max | 1 MiB | push payload cap |

---

## 10. 100 MiB upload — traced timeline

A concrete worked example that should match real testnet behavior:

```
t=0 s       POST /api/v0/add to node-1, Content-Type: multipart/form-data
            node-1 ipfs-http handleAdd finishes reading body, gets 104857600 bytes

t=0.1 s     unixfs.addFile runs:
            step1 chunkBytes → 400 chunks
            step2 for i in 0..399:
              - dagPB encode chunk_i → ~256 KB block
              - sha256(block) → CID_i (bafybe...)
              - blockstore.put(CID_i, block) → local disk write
              - onPut fires:
                  * dht.putProvider(CID_i, node1)
                  * broadcast ProviderAdvertise(CID_i) → [node2, node3]
                  * async pushToK(CID_i, block_bytes) launched
                       → parallel node2.pushBlock + node3.pushBlock

t=0.1 s    (parallel) node-2 receives BlockRequest(push=true, CID=..., bytes=base64):
              - sha256 verify passes
              - blockstore.putFromPeer(CID_i, block)
              - onPut(source="remote-cache") fires:
                   * dht.putProvider(CID_i, node2)
                   * broadcast ProviderAdvertise(CID_i) → [node1, node3]
                   * NO cascade push (source != local)
              - reply BlockResponse {found: true}
            node-3 same pattern

t=0.5 s    All 400 chunks put + replicated
            unixfs builds rootNode, runs same blockstore.put + onPut + pushToK
            rootCid finalized

t=0.6 s    awaitReplicationResult(rootCid, 8000ms):
            inFlightPushes[rootCid] → PushToKResult
            worst replica count = 2 (node-2, node-3 both ack-ed push)
            minReplicas = 2 → no warning

t=0.6 s    HTTP 200 returned:
            {"Name":"file.bin", "Hash":"bafybeig...", "Size":"104857600"}

Final state (all 3 validators hold full copies):
  node-1.blockstore: root + 400 chunks ≈ 100 MiB on disk
  node-2.blockstore: root + 400 chunks ≈ 100 MiB on disk
  node-3.blockstore: root + 400 chunks ≈ 100 MiB on disk

DHT state (each node's view is equivalent):
  for each of 401 CIDs: providers = {node1, node2, node3}
```

**Failure scenarios:**
- node-1 OOM-restarts 5 minutes later:
  - node-1 disk data intact (LevelDB survives)
  - node-1 in-memory DHT empties
  - Reannounce tick re-putProviders all 400 pins + broadcasts within 12h
  - External user GETs from node-2: local hit → immediate
- node-1 offline 15 min, no restart:
  - node-2/3's DHT has `node-1` provider entries still unexpired (24h TTL)
  - External user GETs rootCid from node-2: local hit (was pushed via pushToK) → immediate
  - If user queries a CID node-2 happens not to have (shouldn't happen but corner case):
    - blockstore.get ENOENT → fetchRemote(CID) → dht.findProviders = [node-1, node-2, node-3]
    - requestBlockFromAny parallel 3 peers → node-2/3 wins → returns
    - node-1 timeout does not hurt (race-based)

---

## 11. Current Limitations & Phase D Work

| Issue | Impact |
|---|---|
| `MAX_READ_SIZE = 50 MiB` limits `/api/v0/cat` | 100 MiB files store fine but can't be cat-ed; needs streaming GET |
| `/api/v0/add` doesn't auto-call `CidRegistry.register()` | Operators must manually register on-chain to make a CID eligible for PoSe challenge |
| No erasure coding | K=3 full replicas is simple but uses 3× storage; Reed-Solomon could hit ~1.5× |
| Only 3 validators | K clamps to 2; true "geo-distributed" would need ≥5 nodes for Kademlia locality to matter |
| No storage market | Currently "uploader stores for free + K peers passively receive"; Phase D needs storage pricing/payment |

All listed in Phase C's "explicitly deferred" list, to be addressed in Phase D.

---

## 12. References

- Code entry points:
  - `node/src/ipfs-http.ts` — HTTP layer
  - `node/src/ipfs-unixfs.ts` — UnixFS encode/decode
  - `node/src/ipfs-blockstore.ts` — local block storage + onPut hook
  - `node/src/coc-ipfs-wiring.ts` — glues blockstore / DHT / wire
  - `node/src/coc-ipfs-repair.ts` — self-heal loop
  - `node/src/dht-network.ts` — Kademlia + provider records
  - `node/src/wire-protocol.ts` — binary frames
  - `node/src/wire-server.ts` / `wire-client.ts` — TCP transport
  - `node/src/ipfs-merkle.ts` — keccak256 Merkle tree (for PoSe)

- Related docs:
  - `testnet-status-2026-04-24-en.md` — current testnet config
  - `architecture-en.md` — overall architecture
  - `anti-sybil-en.md` — anti-sybil design
