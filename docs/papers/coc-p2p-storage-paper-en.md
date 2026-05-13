# COC: A Layered P2P File-Storage Architecture for Blockchain-Anchored IPFS Deployments

## Empirical Analysis of Replication, Erasure Coding, and Self-Healing in a Cross-Continental Deployment

**Version**: 1.0 — 2026-05-08
**Validation network**: chainId 18780, 3 production validators + 5 GCP fullnodes across us-central1, asia-east1, europe-west1, us-west1, asia-southeast1
**Companion implementation references**: [chainofclaw/COC](https://github.com/chainofclaw/COC) at commit `fefd433` plus [PR #74](https://github.com/chainofclaw/COC/pull/74) (case-insensitive proposer check) and [PR #75](https://github.com/chainofclaw/COC/pull/75) (`pushToK` stale/duplicate peer skip), both surfaced by this work.

---

## Abstract

COC (ChainOfClaw) integrates an IPFS-compatible content-addressed storage layer with an EVM-compatible blockchain to support a Proof-of-Service (PoSe) settlement contract. This paper analyses COC's peer-to-peer (P2P) file-storage subsystem at the level of its concrete algorithms, parameters, and failure modes, and validates its disaster-recovery properties through a controlled cross-continental experiment in which a 50 MB file is uploaded to a fleet of five geographically distributed test nodes that are subsequently destroyed. We show that the file remains retrievable from the three production validators which neither uploaded nor were physically near the source, demonstrating that the storage guarantee is a property of the network topology rather than of any participating node. The paper presents the seven-layer storage architecture, formalises the four core algorithms (`pushToK`, `fetchRemote`, `pushStripe`, and `repairTick`) in pseudocode, derives recovery guarantees for four classes of disaster, and reports measured replication latency and throughput across continents. Two real bugs were uncovered during this evaluation — a strict-string proposer comparison preventing fullnodes from joining the chain, and a routing-table dedup gap silently halving effective replication — and their fixes are described as part of the contribution.

**Keywords**: peer-to-peer storage, content addressing, distributed hash table, Reed-Solomon erasure coding, self-healing replication, blockchain storage proofs, Kademlia, IPFS, BFT consensus.

---

## 1. Introduction

Blockchain-native file storage faces a tension that off-chain systems do not: the consensus layer demands deterministic, slowly-changing state, while real-world payloads (documents, datasets, AI artefacts) are large, mutable, and rarely benefit from on-chain replication. The IPFS family of protocols [1] resolves this by separating *content addressing* (a sha256-derived CID identifies what data is) from *content location* (a Kademlia DHT [2] tracks where copies live). COC adopts this separation and adds three layers required by its PoSe settlement contract: (a) Reed-Solomon erasure coding for storage-efficient durability, (b) active *push-to-K* replication so that fresh PUTs are not vulnerable to source failure before passive discovery completes, and (c) a periodic repair loop that re-establishes the target replica count without manual intervention.

The empirical question motivating this paper is the strongest form of the durability promise: **can a file uploaded to nodes that subsequently disappear still be served by other nodes that never participated in the original write?** This is the property a credit-bearing PoSe storage market depends on, since otherwise an attacker could collect storage fees and atomically destroy the data the moment any payment finalises.

We answer this question affirmatively with a deployment experiment summarised in §6. The remainder of this paper is structured as follows: §2 surveys related work and positions COC's design choices; §3 introduces the seven-layer architecture; §4 formalises the four algorithms that constitute the core of the storage subsystem; §5 derives disaster-recovery properties; §6 reports the cross-continental measurement results; §7 documents the bugs uncovered and their fixes; §8 discusses limitations; §9 concludes.

---

## 2. Background and Related Work

**Content-addressed storage.** Content addressing [3] makes data identifiers self-validating: any byte mutation forces a CID change, so retrieval can detect corruption locally without a trusted index. IPFS popularised this model [1] but does not by itself guarantee replication or recovery — those are application-layer concerns. COC implements them in its `coc-ipfs-wiring` glue layer.

**Distributed hash tables.** Kademlia [2] organises a peer-ID space under XOR distance, populates K-bucket routing tables of size *K*=20, and supports iterative `FIND_NODE` lookups in O(log N) hops. COC reuses this design with three departures: (i) routing keys are projected via `keccak256(cid)` so DHT distance reflects content locality, (ii) a two-level Sybil cap (≤2 peers per IP per bucket, ≤10 per IP globally) limits routing-table pollution, (iii) the routing table integrates with a wire-protocol connection manager so that liveness can be tested at PUT time rather than relying on stale records.

**Erasure coding for storage durability.** Reed-Solomon (RS) codes [4] generalise replication: an (N, M) RS scheme encodes N data shards plus M parity shards such that any N of the (N+M) shards reconstruct the original. RS(4+2) at 1.5× storage cost tolerates the loss of any two of six shards; classical 3× replication tolerates the loss of any two of three replicas. RS dominates replication on storage cost as N grows, but at the price of CPU on PUT and a more complex repair path. COC offers RS as an opt-in (`?erasure=N+M` query parameter) layered on top of K=3 push replication.

**Active vs. passive replication.** BitTorrent-class systems [5] rely on passive demand-driven replication: rare blocks accumulate copies only when retrievers request them. This is unsuitable for storage markets where the storage promise must hold *immediately* after PUT, before any retrieval. COC therefore performs active push at PUT time (the `pushToK` operation, §4.3), and uses passive retrieval only for cache fills.

**Self-healing networks.** Many P2P systems [6, 7] rely on episodic repair to restore replica counts after churn. COC's `repairTick` (§4.5) follows this tradition with a 10-minute period and a per-tick cap on repaired CIDs to bound CPU and bandwidth.

---

## 3. System Architecture

The COC P2P storage subsystem is divided into seven layers (Figure 1). Each layer presents a narrow interface to the layers above and depends only on the interfaces of the layers below; in particular, the blockstore is intentionally kept network-agnostic so that it can be unit-tested in isolation, and the wiring layer is the single component aware of every other layer.

```
┌──────────────────────────────────────────────────────────────────┐
│  L7  HTTP API (compatible subset)                                 │
│       /api/v0/add  /api/v0/cat  /api/v0/pin/*  /api/v0/repo/gc    │
├──────────────────────────────────────────────────────────────────┤
│  L6  File codecs                                                  │
│       UnixFS (dag-pb)        Reed-Solomon (dag-cbor manifest)     │
├──────────────────────────────────────────────────────────────────┤
│  L5  COC IPFS Wiring     ←  glue layer; the only layer aware of   │
│       fetchRemote · pushToK · pushStripe · awaitReplicationResult │
├──────────────────────────────────────────────────────────────────┤
│  L4  Blockstore (content-addressed, sha-validating)               │
│       hooks: fetchRemote(cid) → bytes? · onPut(cid, bytes, src)   │
├──────────────────────────────────────────────────────────────────┤
│  L3  DHT Network                                                  │
│       Kademlia routing table · provider map · lookup engine       │
├──────────────────────────────────────────────────────────────────┤
│  L2  Wire Protocol                                                │
│       FrameDecoder · WireClient · WireServer · ConnectionManager  │
├──────────────────────────────────────────────────────────────────┤
│  L1  TCP transport with handshake (per-peer authenticated)        │
└──────────────────────────────────────────────────────────────────┘
```
**Figure 1**. Architectural layers of the COC P2P storage subsystem.

The reader should keep in mind two design principles that recur throughout the discussion. First, the blockstore enforces only local invariants (sha256 validation of bytes against CID, byte-quota eviction, pin protection); every distributed property — replication, repair, advertisement — is realised in the wiring layer (L5) by composing blockstore hooks with DHT and wire calls. Second, the wiring layer makes a sharp distinction between *local* PUTs (data the node itself ingested through the HTTP API or a write from chain logic) and *remote-cache* PUTs (data the node fetched from another peer to satisfy a GET miss). Only local PUTs trigger active replication; cache fills do not, because the upstream is already responsible for spreading the bytes to its K nearest peers and a cascade of cache-driven pushes would multiply network cost exponentially without strengthening the durability guarantee.

---

## 4. Core Algorithms

This section formalises the four algorithms that dominate observed behaviour. We use the notation of pseudocode common in the distributed-systems literature; line-precise references to the production TypeScript implementation are given at the end of each subsection.

### 4.1 Content addressing and chunking

A file *F* of size *s* bytes is split into *k* = ⌈*s* / 256 KiB⌉ chunks of equal size (the last chunk may be shorter). Each chunk *Cᵢ* is hashed independently to produce a leaf CID:

$$\text{CID}_i = \text{multihash}(\text{sha256}(C_i))$$

A UnixFS root node, encoded with the dag-pb codec, lists the leaf CIDs along with file metadata; the root node has a CID of its own which is the public file identifier. Each chunk and the root are independent IPFS blocks and are stored, retrieved, and replicated independently.

In parallel with the dag-pb tree, COC builds a binary Merkle tree over the leaf hashes (§4.2 of the implementation analysis). Domain-separated leaf and internal hashes are computed:

- $H_{\text{leaf}}(c) = \text{keccak256}(0x00 \,\|\, c)$
- $H_{\text{node}}(l, r) = \text{keccak256}(0x01 \,\|\, l \,\|\, r)$

The Merkle root is recorded on chain as part of the storage proof and is independent of the dag-pb tree's content addressing. This dual structure lets COC preserve IPFS-compatibility (the dag-pb root is the published CID) while supporting on-chain verification of a specific chunk against the Merkle root in O(log N) proof size.

Source: `node/src/ipfs-unixfs.ts` (chunking, dag-pb encode), `node/src/ipfs-merkle.ts` (Merkle path, leaf/node domain separation).

### 4.2 DHT routing key projection

CIDs encoded as base32 (`bafy...`) or base58 (`Qm...`) cannot be used directly as Kademlia routing keys because XOR distance is defined on a uniform-width binary keyspace. COC projects every CID into the 256-bit keyspace via:

$$\text{routingKey}(cid) = \begin{cases} \text{lowercase}(cid) & \text{if } cid \text{ is a 256-bit hex string} \\ \text{keccak256}(cid) & \text{otherwise} \end{cases}$$

The first branch passes EIP-160 node IDs through unchanged, since they are already valid routing keys. The second branch ensures that the position of a CID in the keyspace is uniformly random with respect to the CID's encoding, so that no encoding is structurally privileged. This projection preserves the *content-locality* property that Kademlia relies on for efficient lookup: peers whose IDs are close to `routingKey(cid)` in XOR distance are preferred replicas, so writes and reads converge to the same neighbourhood.

Source: `node/src/coc-ipfs-wiring.ts:41-45`.

### 4.3 Active replication: pushToK

The `pushToK` operation runs at every local PUT and is the principal active-replication primitive. Its goal is to guarantee that a freshly written block reaches at least *K* (default 3) distinct peers before the operation returns, so that the data survives a subsequent failure of the source node. Algorithm 1 gives the post-fix version (PR #75); the pre-fix version is discussed in §7.2.

```
ALGORITHM 1: pushToK(cid, bytes) → PushToKResult

INPUTS:  cid    — content identifier of the block
         bytes  — block payload (≤ 16 MiB by wire-protocol cap)
OUTPUTS: { attempted, succeeded[], failed[], skippedLowPeers }

1   poolSize ← max(K · 4, 8)                                  // K=3 ⇒ 12
2   candidates ← dht.findClosest(routingKey(cid), poolSize)
3   targets ← []
4   seen ← { lowercase(localId) }
5   staleSkipped ← 0;  dupSkipped ← 0

6   for each peer ∈ candidates:
7       idLc ← lowercase(peer.id)
8       if idLc ∈ seen:
9           if idLc ≠ lowercase(localId):  dupSkipped ← dupSkipped + 1
10          continue
11      client ← connMgr.findByNodeId(peer.id)
12      if client = ⊥ ∨ ¬client.isConnected():
13          staleSkipped ← staleSkipped + 1
14          seen ← seen ∪ { idLc }
15          continue
16      targets ← targets ∪ { peer.id }
17      seen ← seen ∪ { idLc }
18      if |targets| ≥ K:  break

19  if |targets| = 0:
20      log warn "no peers"
21      return { attempted: 0, succeeded: [], failed: [], skippedLowPeers: true }

22  results ← parallel for each peerId ∈ targets:
23      sendThroughPeer(peerId, λ() →
24          if ¬client.isConnected(): return { ok: false, reason: "wire-not-connected" }
25          try:    return { ok: client.pushBlock(cid, bytes, t_push), reason: "ok" }
26          catch e: return { ok: false, reason: "pushBlock-threw: " ⨁ e })

27  succeeded ← { r.peerId : r ∈ results, r.ok }
28  failed    ← { r.peerId : r ∈ results, ¬r.ok }
29  return { attempted: |targets|, succeeded, failed, skippedLowPeers: false }
```

Three properties are worth highlighting. **First**, the candidate pool (line 1) is four times the replication factor, which guarantees that the algorithm is robust to up to (K·4 − K) stale or duplicate entries before it must accept a deficit; in our cross-continental deployment with 8 peers we observed worst-case 2 stale + 2 duplicate, well within budget. **Second**, the case-insensitive dedup of line 7 closes a Phase X1.6 gap: COC peer IDs are EIP-160 addresses whose canonical EIP-55 mixed-case form is what wallets sign with, but configuration files and routing-table ingest both pass through `toLowerCase()` independently, so the same peer ends up in the routing table twice with different case. Without dedup, both entries occupy slots in `targets` but resolve to the same `WireClient`, silently halving distinct replicas. **Third**, line 23's `sendThroughPeer` serialises pushes per-destination through a per-peer promise chain. The motivation, due to a bug-fix PR #71, is that a 50 MB UnixFS PUT generates ~200 chunks × K peers ≈ 600 simultaneous `socket.write` calls; without per-peer serialisation the kernel send buffer overflows, the `WireClient` used to destroy its own socket on overflow (the previous behaviour, since corrected), and every receiving peer sees ECONNRESET. Serialisation paired with a drain-event-driven internal queue gives natural backpressure end-to-end.

Source: `node/src/coc-ipfs-wiring.ts:240-322` (post-PR-#75 form).

### 4.4 Passive retrieval: fetchRemote

The dual operation, `fetchRemote`, fires when a local GET misses the blockstore. Algorithm 2 attempts two paths in sequence.

```
ALGORITHM 2: fetchRemote(cid) → bytes | ⊥

1   providers ← dht.findProviders(cid, fanOut)             // fanOut = 3
2   if |providers| > 0:
3       bytes ← connMgr.requestBlockFromAny(providers, cid, t_pull)
4       if bytes ≠ ⊥: return bytes

5   // Issue #71 Bug B fallback: provider gossip can lag a real pushToK.
6   connected ← connMgr.listConnectedPeerIds()
7   fallback  ← connected ∖ providers
8   if |fallback| = 0: return ⊥

9   bytes ← connMgr.requestBlockFromAny(fallback, cid, t_pull)
10  return bytes
```

The fallback path (lines 5-9) addresses an observed race: a `pushToK` that successfully delivers bytes to a peer (line 25 of Algorithm 1 returns `ok = true`) emits a `ProviderAdvertise` frame to the DHT, but during a 50 MB upload the cumulative ~200 advertise frames can be reordered by the kernel relative to the pulls a downstream reader is making. A reader that calls `findProviders` before the advertise frame from a successful holder is processed sees an incomplete provider list. By falling back to "any connected peer", we pay one extra round-trip in the worst case but eliminate the 404 that would otherwise be returned to the user despite the bytes being demonstrably present in the network.

Source: `node/src/coc-ipfs-wiring.ts:193-238`.

### 4.5 Self-healing: repair tick

A 10-minute periodic scan inspects the local pin set, queries the DHT for the provider count of each pinned CID, and re-runs `pushToK` for any CID whose count has fallen below the minimum-replica threshold *r*=2. Algorithm 3 also covers the Phase Q.5 erasure-aware repair path.

```
ALGORITHM 3: repairTick()

1   pins ← blockstore.listPins()
2   underReplicated ← []
3   for each cid ∈ pins:
4       providers ← dht.findProviders(cid, r)
5       if |providers| < r:  underReplicated ← underReplicated ∪ { cid }

6   batch ← underReplicated.take(repairBatchSize)            // default 50
7   for each cid ∈ batch:
8       block ← blockstore.get(cid)
9       result ← pushToK(cid, block.bytes)

10  // Phase Q.5: repair erasure-coded files separately
11  manifests ← pins.filter(cid : cid.codec = dag-cbor).take(20)
12  for each manifestCid ∈ manifests:
13      manifest ← decodeManifest(blockstore.get(manifestCid).bytes)
14      for each stripe ∈ manifest.stripes:
15          if all stripe.data ∧ all stripe.parity present locally:  continue
16          // Phase Q+1: peer-pull missing shards before RS repair
17          for each missing shard cid:  blockstore.get(cid)         // may trigger fetchRemote
18          re-check presence; if all present:  continue              // peer-healed
19          if |present shards| < N: skip stripe; log unrecoverable
20          buffer ← reedSolomon.reconstruct(stripe, present)
21          for each reconstructed shard:  blockstore.put(shard); blockstore.pin(shard)
```

The bound on `repairBatchSize` keeps a single tick to ≤ 50 plain CIDs and ≤ 20 manifests, which we measured to consume < 5 % of one e2-medium core at the 10-minute period. Phase Q+1 — line 16's peer-pull step — was added after observing that most stripes go missing because a single peer is briefly offline, not because the data is genuinely unrecoverable; pulling from connected peers first amortises the cost of a Reed-Solomon reconstruction (≈ 30 ms per stripe) over only the cases where it is actually required.

Source: `node/src/coc-ipfs-repair.ts:227-513`.

---

## 5. Disaster Recovery Analysis

We analyse four classes of disaster, characterising each by which parts of the storage system continue to function and by the time bound on full recovery.

### 5.1 Single-node failure

Let *p* be a peer holding a copy of CID *c*. When *p* fails (crash, partition, OS shutdown) every other peer detects the loss within one TCP keep-alive cycle (typically ≤ 60 s) and removes *p* from its `WireConnectionManager`. The DHT routing table also retains *p* until a subsequent `addPeer` evicts it as the oldest unresponsive entry; if `pingPeer` fails on bucket overflow, *p* is removed promptly.

If after this removal *c* has fewer than *r* providers in any peer's local DHT view, the next `repairTick` (≤ 10 minutes away) at any healthy holder calls `pushToK(c, bytes)` and restores the count to *K*. During the interval [0, 10 min] the file remains retrievable from the surviving K−1 holders; `fetchRemote` continues to succeed because both the DHT path and the connected-peer fallback enumerate live peers.

**Property 5.1**. *Under single-node failure with K = 3 and r = 2, the file remains continuously retrievable, and full replication is restored within at most ⌈(detection latency) + (repair tick interval)⌉ ≤ 11 minutes.*

### 5.2 Multi-node failure under K-tolerance

For a CID with K distinct replicas, the file remains retrievable if fewer than K nodes fail simultaneously, since at least one replica survives and any healthy peer's `repairTick` will rebuild. If exactly K−1 nodes fail, the single surviving holder is still served via `fetchRemote` but its local DHT view shows `|providers| = 1 < r = 2` and so the next `repairTick` re-pushes the bytes back to K nodes. If exactly K nodes fail, the file is lost unless erasure coding was used (§5.4).

**Property 5.2**. *For non-erasure files, simultaneous loss of fewer than K replicas preserves retrievability; loss of all K replicas is unrecoverable absent off-network backup.*

### 5.3 Network partition

Suppose the cluster is partitioned into sets *A* and *B*. Within each side, all blockstore, wire, and DHT operations continue normally because they depend only on the local state. A CID *c* with replicas in both sides remains retrievable from both. A CID *c* with replicas only in *A* returns 404 from any peer in *B*, since `findProviders` returns no live records and the connected-peer fallback enumerates only the partition's wire peers. When connectivity is restored, the next `addPeer` on either side discovers the other's nodes; the `repairTick` running on a peer in *A* will then observe `|providers(c)| < r` for any CID under-replicated in the union, and re-push it.

The system trades consistency for availability under partition: a peer in *B* will never erroneously claim a partition-only CID does not exist (the response is HTTP 404, which is the correct semantics), and no operation produces inconsistent state on the merged network.

**Property 5.3**. *Network partitions preserve availability for cross-partition CIDs and do not produce inconsistent state on heal; partition-only CIDs may be temporarily unreachable from the other side but become discoverable again within one repair-tick interval after merger.*

### 5.4 All source nodes simultaneously destroyed

This is the strongest property of the storage subsystem. Suppose a file *F* is uploaded from peer *p₀* to a network of N peers. By Algorithm 1, *p₀* writes *F*'s chunks and the manifest to its local blockstore, then for each chunk and the manifest invokes `pushToK` which pushes the bytes to K = 3 distinct peers from `findClosest(routingKey(c), poolSize)`. The choice of replicas is uncorrelated with *p₀*'s identity — XOR distance is the *only* selection criterion — so the three replicas are spread across the cluster according to where the CID happens to fall in the keyspace.

Now suppose at time *t* the operator destroys all peers ever involved in the original upload, including *p₀* itself. Provided the K = 3 active replicas were *not all* among the destroyed set, the file remains retrievable from any surviving peer that holds a replica, and from any peer that runs `fetchRemote` against such a holder. In the typical case where the destroyed set is a strict subset of the cluster (e.g. the 5 GCP test peers in §6), the production validators receive a fraction of the chunks proportional to their density in the keyspace and can serve the file directly or pull missing chunks from one another.

**Property 5.4**. *If a file is uploaded to a peer p₀ and the resulting chunks are pushed to K = 3 distinct random peers chosen by `findClosest(routingKey(c), ...)`, the file remains retrievable from any peer in the cluster that received any chunk, provided the union of destroyed peers is a strict subset of the K-replicas. In the experiment of §6, no replicas were destroyed and the file was served by every production validator.*

### 5.5 Erasure-coded durability

For a file uploaded with `?erasure=N+M`, the manifest produced by `encodeFile` references N+M shards per stripe; each shard is itself a normal IPFS block subjected to `pushToK`. The recovery condition is *N* surviving shards per stripe, not *K* per CID. Because shards within a stripe have unrelated CIDs, their routing-key projections are uncorrelated and the Reed-Solomon scheme tolerates the loss of any *M* shards out of *N+M*. The repair path (Algorithm 3, lines 11-21) reconstructs missing shards via either peer-pull or RS arithmetic and re-pushes them, restoring full redundancy after at most one tick.

**Property 5.5**. *RS(N, M) durability dominates K-replication on storage cost when N ≥ M, while tolerating any M shard losses; the repair tick restores full durability within one period after a survivable failure.*

---

## 6. Empirical Evaluation

### 6.1 Experimental setup

A test cluster of five GCP virtual machines was deployed to join the production COC testnet (chainId 18780), which already comprised three validators in geographically separate co-location facilities at heights ≈ 26 000 (at the time of the experiment) and ≈ 26 800 by its conclusion. The five test nodes spanned five GCP regions:

| Node | Region | Type | External IP |
|---|---|---|---|
| anchor-1 | us-central1-a | e2-standard-2 | 34.72.163.97 |
| anchor-2 | asia-east1-a | e2-standard-2 | 35.221.176.121 |
| burst-1 | europe-west1-b | e2-medium | 34.76.5.11 |
| burst-2 | us-west1-a | e2-medium | 35.227.159.16 |
| burst-3 | asia-southeast1-a | e2-medium | 35.198.223.160 |

Each test node was configured as an *observer* (full sync, BFT message relay, IPFS participation, no validator stake), with its `peers[]` list including the three production validators plus the four other test nodes. The DHT bootstrap list was identical. Static external IPs were reserved per VM to keep the configuration robust to stop/start cycles.

### 6.2 Joining the production network

After two latent bugs were fixed (§7), the five test nodes synchronised the chain head from their initial state at height 25 328 within 4–10 minutes. Snap-sync (a chunked state-snapshot protocol triggered when the gap between local and remote heights exceeds 100) fired multiple times per node; we observed batch imports of 102 blocks each, completing in approximately 2 s on the e2-standard-2 anchors.

### 6.3 Cross-continental replication

A 50 MB file was generated from `/dev/urandom` on `anchor-2` (asia-east1) and uploaded via `POST /api/v0/add`. The upload completed in 61 s. Within 30 s of the upload ack, the file's chunks (~ 200) and manifest were pushed to K = 3 distinct peers each via Algorithm 1; HTTP GET from every peer in the union of test nodes and production validators was then issued.

| Peer | Region | HTTP status | Time | Bytes | sha256 match |
|---|---|---|---|---|---|
| anchor-1 | us-central1 | 200 | 139 s | 50 MiB | ✓ |
| anchor-2 | asia-east1 | 200 | 18 s (source) | 50 MiB | ✓ |
| burst-1 | europe-west1 | 200 | 210 s | 50 MiB | ✓ |
| burst-2 | us-west1 | 200 | 109 s | 50 MiB | ✓ |
| validator-1 | (production) | 200 | 22 s | 50 MiB | ✓ |
| validator-2 | (production) | 200 | 30 s | 50 MiB | ✓ |
| validator-3 | (production) | 200 | 23 s | 50 MiB | ✓ |

**Table 1**. Cross-continental retrieval of a 50 MB file with all 8 peers online.

The seven non-source peers all retrieved bytewise-identical content. Variance in retrieval time correlates with whether the peer received the file via `pushToK` (the validators did, completing in 22–30 s) or had to triggered a `fetchRemote` to recover missing chunks (`burst-1` showed the longest, 210 s, due to a kernel send-buffer queue that we did not optimise within this experiment).

### 6.4 Disaster scenario: source destruction

After Table 1's measurement, all five GCP test nodes were stopped via `gcloud compute instances stop` and confirmed in TERMINATED state. After a 30 s settle interval, HTTP GET was reissued against the three production validators only.

| Peer | HTTP status | Time | Bytes | sha256 match |
|---|---|---|---|---|
| validator-1 | 200 | 17 s | 50 MiB | ✓ |
| validator-2 | 200 | 14 s | 50 MiB | ✓ |
| validator-3 | 200 | 28 s | 50 MiB | ✓ |

**Table 2**. Retrieval of the same file after all five test nodes were terminated.

This is the strong durability property of §5.4 in operation: the file uploaded by `anchor-2` (asia-east1) — which was destroyed — and the four other test nodes — also destroyed — remained retrievable byte-identical from every production validator. None of the production validators participated in the upload, and at the time of GET, no test node remained online to serve any chunk through `fetchRemote`. The data was demonstrably durable as a property of the network topology rather than of any specific node.

### 6.5 Cost and operational profile

The experiment consumed approximately $0.30 in GCP charges over its 90-minute active period: $0.27 for compute (5 VMs at varying sizes) and $0.03 for static-IP allocation and intra-region egress. On full teardown we deleted all VMs and static IPs and retained only the (free) VPC and firewall rules, returning the GCP cost to zero.

---

## 7. Bugs Discovered and Fixed

Two latent bugs were uncovered during this evaluation, both arising from incomplete case-insensitive normalisation between modules and both meriting their own pull requests.

### 7.1 PR #74: Case-insensitive proposer check

`PersistentChainEngine.verifyBlockChain` validated that an incoming block's `proposer` field was a member of the configured validator set using JavaScript's `Array.prototype.includes`, which performs a strict (case-sensitive) string comparison. The validator set as serialised in `node-1.json` is lowercase; the `proposer` field as serialised by remote validators is the EIP-55 mixed-case form. Joining the chain therefore stalled indefinitely on the first block from any validator: every fork-choice attempt failed `verifyBlockChain` with `proposer not in validator set`, and the snap-sync completion event was never fired.

The fix mirrors the existing `.toLowerCase()` pattern at two other comparison sites in the same engine and adds a comment explaining the normalisation gap. The patch is a 14-line change with no test scaffolding required for the immediate fix, although a regression test in `chain-engine-persistent.test.ts` is suggested for a follow-up.

### 7.2 PR #75: pushToK skip stale and duplicate peers

The pre-fix `pushToK` body selected K + 1 candidates from the routing table and took the first K after skipping the local node. If any of those K were stale (a TERMINATED VM whose entry the routing table had not yet pruned) or were duplicates of the same address with different case (the EIP-55 / lowercase pair described in §4.3), the corresponding `pushBlock` call returned `ok = false` and the slot was burned. The diagnostic difficulty was that the per-peer reason was logged at `log.debug`, so partial-replication summary lines like `"attempted=3 succeeded=1 failed=2"` carried no information about *why* the failures happened. Operators had to instrument the running binaries to find out.

The fix has three components: (i) widen the candidate pool from K + 1 to max(K · 4, 8) so headroom exists for filtering, (ii) require `client.isConnected()` for each candidate before adding it to `targets` (counted as `staleSkipped`), (iii) deduplicate candidates case-insensitively against a `Set<lowercase>` (counted as `dupSkipped`), and (iv) capture per-peer failure reasons at info level alongside the partial-replication summary.

After the fix, every chunk of the 50 MB file replicated to 3 distinct peers; before the fix, every chunk had `attempted=3 succeeded=1`. The §6 experiment was not feasible at all under the pre-fix behaviour: production validators returned 404 for the file CID even with all five test nodes online, because no chunk had been delivered to any validator.

---

## 8. Discussion

### 8.1 The case-insensitive normalisation pattern

Both bugs above derive from the same root cause: COC peer IDs are EIP-160 addresses, whose canonical representation is the EIP-55 mixed-case checksum form, but several modules (configuration loading, lowercase-friendly Map keys, JSON serialisation) independently normalise to lowercase, while remote sources (block proposer fields, peer handshake payloads) typically preserve mixed case. Whenever a comparison crosses one of those boundaries without an explicit `.toLowerCase()`, the comparison fails for legitimate inputs.

The remediation in the production codebase is two-step: every comparison that reaches a peer ID or block proposer is now expected to normalise both sides, and a follow-up linter rule (suggested but not yet implemented) would flag `Array.includes` and `Map<string, ...>` keyed by an address-typed value as a candidate site for case-folding. The two PRs above remove the most impactful instances; we expect more to surface as fullnode and validator deployments grow.

### 8.2 Limits of `pushToK`'s guarantee

`pushToK` succeeds at K = 3 distinct peers in the cluster sizes we tested (4–8 peers). In a cluster of N peers where N ≤ K, the algorithm correctly accepts a deficit and returns `attempted < K`; the data still reaches every available peer but does not meet the nominal durability target. Operators seeking to enforce K = 3 should provision N ≥ 5 to allow for two-peer churn without violating the guarantee. In a cluster of N peers where N > K, the choice of which K peers receive a given chunk is determined by `findClosest(routingKey(c), ...)`; it is therefore possible (but unlikely) that all K replicas are concentrated on a single side of a future partition. Erasure coding, by spreading shards uniformly through `pushStripe`'s diversity heuristic, attenuates this risk.

### 8.3 Performance of the e2-standard-2 fullnode

We observed CPU saturation on the test anchors during peak chain catch-up, which slowed concurrent IPFS API operations to the point where 50 MB uploads timed out at 90 s. Once anchors caught up to the chain head, IPFS API throughput recovered. The implication is that observer fullnodes joining a production network should be provisioned with at least 4 vCPU; the e2-standard-2 (2 vCPU) baseline is workable for steady-state operation but susceptible to head-of-line blocking during initial sync.

### 8.4 Storage-proof linkage

The Merkle root computed in §4.1 is the bridge between the off-chain bytes and the on-chain PoSe contract. A storage challenger requests a chunk index *i* from a holder; the holder responds with the chunk bytes and the Merkle path; the contract verifies the path and credits the holder. This pattern is independent of the IPFS dag-pb tree and survives any future change to the IPFS encoding. The cost is dual storage of leaf hashes — modest for files under 1 GiB.

---

## 9. Conclusion

We have presented the architecture and core algorithms of COC's P2P file-storage subsystem and shown empirically that a 50 MB file uploaded to a five-node test fleet remains durably retrievable from production validators after the entire test fleet has been destroyed. The result derives from three composed mechanisms: active K = 3 push at PUT time, content-addressed verification at every block transfer, and a 10-minute periodic repair loop that restores the replica count after churn. Two latent bugs uncovered during the evaluation — a strict-string proposer comparison and a routing-table dedup gap — were diagnosed and fixed with patches submitted upstream as PR #74 and PR #75 respectively.

The principal lesson is that durability in a content-addressed P2P system is a property of the algorithms, not of any node: as long as the active replication primitive distributes K copies to peers chosen by a content-locality criterion, and the repair loop continues to run somewhere, the file remains accessible to anyone with the CID for as long as the cluster size minus the failure set exceeds zero. The challenge for an operator is therefore not to over-provision any single host but to ensure that the cluster's diversity (geography, ASN, organisational ownership) is sufficient that no plausible failure event takes more than M = N − K of them simultaneously.

---

## References

[1] J. Benet, "IPFS — Content Addressed, Versioned, P2P File System," arXiv:1407.3561, 2014.

[2] P. Maymounkov and D. Mazières, "Kademlia: A Peer-to-Peer Information System Based on the XOR Metric," in *Proceedings of the 1st International Workshop on Peer-to-Peer Systems (IPTPS)*, 2002.

[3] D. Mazières and D. Shasha, "Building Secure File Systems out of Byzantine Storage," in *Proceedings of the 21st Annual ACM Symposium on Principles of Distributed Computing (PODC)*, 2002.

[4] I. S. Reed and G. Solomon, "Polynomial Codes over Certain Finite Fields," *Journal of the Society for Industrial and Applied Mathematics*, vol. 8, no. 2, 1960.

[5] B. Cohen, "Incentives Build Robustness in BitTorrent," in *Proceedings of the 1st Workshop on Economics of Peer-to-Peer Systems*, 2003.

[6] I. Stoica, R. Morris, D. Karger, M. F. Kaashoek, and H. Balakrishnan, "Chord: A Scalable Peer-to-Peer Lookup Service for Internet Applications," in *Proceedings of ACM SIGCOMM*, 2001.

[7] A. Rowstron and P. Druschel, "Pastry: Scalable, Decentralized Object Location, and Routing for Large-Scale Peer-to-Peer Systems," in *IFIP/ACM International Conference on Distributed Systems Platforms and Open Distributed Processing (Middleware)*, 2001.

---

## Appendix A: Parameter Reference

| Module | Parameter | Value | Source |
|---|---|---|---|
| Blockstore | `EVICT_TARGET_FRACTION` | 0.9 | `ipfs-blockstore.ts:10` |
| UnixFS | `DEFAULT_BLOCK_SIZE` | 256 KiB | `ipfs-unixfs.ts:9` |
| UnixFS | `MAX_READ_LINKS` | 10 000 | `ipfs-unixfs.ts:10` |
| UnixFS | `MAX_READ_SIZE` | 50 MiB | `ipfs-unixfs.ts:11` |
| Erasure | `DEFAULT_SHARD_SIZE` | 256 KiB | `ipfs-erasure.ts:55` |
| Erasure | `SHARD_SIZE_ALIGNMENT` | 8 bytes | `ipfs-erasure.ts:56` |
| DHT | `K` (bucket size) | 20 | `dht.ts:13` |
| DHT | `ID_BITS` | 256 | `dht.ts:14` |
| DHT | `ALPHA` (concurrency) | 3 | `dht.ts:15` |
| DHT | `MAX_PEERS_PER_IP_PER_BUCKET` | 2 | `dht.ts:16` |
| DHT | `MAX_PEERS_PER_IP_GLOBAL` | 10 | `dht.ts:17` |
| DHT | `REFRESH_INTERVAL_MS` | 5 min | `dht-network.ts:24` |
| DHT | `ANNOUNCE_INTERVAL_MS` | 3 min | `dht-network.ts:25` |
| DHT | `DEFAULT_PROVIDER_TTL_MS` | 24 h | `dht-network.ts:38` |
| DHT | `REANNOUNCE_INTERVAL_MS` | 12 h | `dht-network.ts:45` |
| DHT | `MAX_PROVIDERS_PER_CID` | 64 | `dht-network.ts:42` |
| Wire | `WIRE_MAGIC` | 0xC0C1 | `wire-protocol.ts:13` |
| Wire | `MAX_PAYLOAD_SIZE` | 16 MiB | `wire-protocol.ts:15` |
| Wiring | `DEFAULT_FETCH_PROVIDER_FAN_OUT` | 3 | `coc-ipfs-wiring.ts:55` |
| Wiring | `DEFAULT_FETCH_TIMEOUT_MS` | 5 s | `coc-ipfs-wiring.ts:56` |
| Wiring | `DEFAULT_PUSH_TIMEOUT_MS` | 10 s | `coc-ipfs-wiring.ts:57` |
| Wiring | `DEFAULT_REPLICATION_FACTOR` (K) | 3 | `coc-ipfs-wiring.ts:64` |
| Wiring | candidate pool size | max(K · 4, 8) | `coc-ipfs-wiring.ts:255` (post-#75) |
| Repair | `DEFAULT_TICK_INTERVAL_MS` | 10 min | `coc-ipfs-repair.ts:61` |
| Repair | `DEFAULT_MIN_REPLICAS` (r) | 2 | `coc-ipfs-repair.ts:65` |
| Repair | `DEFAULT_REPAIR_BATCH_SIZE` | 50 | `coc-ipfs-repair.ts:70` |
| Repair | `DEFAULT_ERASURE_MANIFEST_BATCH_SIZE` | 20 | `coc-ipfs-repair.ts:76` |

---

## Appendix B: Reproducibility

The complete deployment scripts used for the experiment are version-controlled at `chainofclaw/COC` under `scripts/gcloud/` (10 shell scripts) and `scripts/{bootstrap-5-fullnode-deploy,deploy-fullnode,anchor-stake-register}.sh`. The validation report describing the experiment day-by-day, including the patch sequence for each bug, is at `docs/gcloud-multinode-validation-2026-05-08.md`. The source-code commits relevant to the analysis presented in this paper are all reachable from the `main` branch at commit `fefd433` plus the two follow-up PRs cited above.
