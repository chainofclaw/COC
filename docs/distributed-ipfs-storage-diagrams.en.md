# COC Distributed IPFS Storage - Architecture Diagrams

## 1. Block Replication Propagation Timeline

### 1.1 Block Diffusion in Three-Layer Node Network

```
Timeline: Node A uploads 1 MB file (4 blocks)

Initial State (t=0ms):
┌──────────────────────────────────────────────────────┐
│ Node A (Origin Node)                                 │
│ ├─ Block 0: Metadata (51B)     ✓                     │
│ ├─ Block 1: Data (262KB)       ✓                     │
│ ├─ Block 2: Data (262KB)       ✓                     │
│ └─ Block 3: Data (262KB)       ✓                     │
│                                                      │
│ Node B, C, D, E (Peer Nodes)                         │
│ └─ (No blocks)                 ✗                     │
└──────────────────────────────────────────────────────┘

Concurrent Broadcast (BROADCAST_CONCURRENCY=5):
        [Round 1] t=100-200ms
        │
        ├─ POST /p2p/gossip-block Block0 → Node B
        ├─ POST /p2p/gossip-block Block0 → Node C
        ├─ POST /p2p/gossip-block Block1 → Node D
        ├─ POST /p2p/gossip-block Block1 → Node E
        └─ POST /p2p/gossip-block Block2 → Node B

        [Round 2] t=200-300ms
        │
        ├─ POST /p2p/gossip-block Block2 → Node C
        ├─ POST /p2p/gossip-block Block3 → Node D
        └─ POST /p2p/gossip-block Block3 → Node E

Result (t=300ms):
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│ Node A       │ Node B       │ Node C       │ Node D       │ Node E       │
├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
│ Block 0: ✓   │ Block 0: ✓   │ Block 0: ✓   │ Block 1: ✓   │ Block 1: ✓   │
│ Block 1: ✓   │ Block 1: ✓   │ Block 2: ✓   │ Block 2: ✓   │ Block 3: ✓   │
│ Block 2: ✓   │ Block 3: lazy │ Block 3: lazy │ Block 0: lazy │ Block 0: lazy │
│ Block 3: ✓   │              │              │ Block 3: ✓   │ Block 2: lazy │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

Subsequent Lazy Pull (async):
When Node B needs Block3:
  Node B: GET {NodeA,C,D,E}/api/v0/cat?arg=bafybeicj...
  → Priority pull from nearest peer
  → Verify CID
  → Store locally

Final State (t=500ms+):
  ┌─────────────────────────────────┐
  │ All 5 nodes have complete copy  │
  │ Total redundancy: 20/4 = 5x     │
  └─────────────────────────────────┘
```

---

## 2. Block Retrieval Path Decision Tree

### 2.1 `cat(cid)` Call Flow

```
User calls:
  GET /api/v0/cat?arg=bafybeih5...
           │
           ↓
[Check 1: Local Block Storage]
  ├─ await store.has(cid)
  │   ├─ YES → [Read Local Block] → Return Data (5ms) ✓ FAST
  │   └─ NO → Continue
  │
[Check 2: Peer Nodes]
  ├─ const peers = await p2p.getPeers()  // Get all connected peers
  │
  ├─ FOR each peer node:
  │   ├─ TRY: GET {peer.url}/api/v0/cat?arg={cid}
  │   │   ├─ SUCCESS → Cache locally → Return (100-500ms) ✓ GOOD
  │   │   └─ FAIL (404) → Try next peer
  │   │
  │   ├─ Retry logic:
  │   │   ├─ Connection timeout (10s) → Mark peer unavailable
  │   │   └─ Max retry: 3 peers
  │   │
  │   └─ If all peers fail → Continue to DHT lookup
  │
[Check 3: DHT Node Discovery] (only when enableDht=true)
  ├─ const providers = await dht.findProviders(cid)
  │
  ├─ FOR each provider:
  │   ├─ TRY: GET {provider.url}/api/v0/cat?arg={cid}
  │   │   ├─ SUCCESS → Cache locally → Return (500-2000ms) ✓ SLOW
  │   │   └─ FAIL → Try next provider
  │   │
  │   └─ Max attempts: 10 DHT providers
  │
[Check 4: Error Handling]
  └─ If all above fail:
     └─ Return 404: Block not found
```

### 2.2 Retrieval Latency Comparison

```
┌────────────────────────────────────────────────────────┐
│ Block Retrieval Latency (by source)                    │
├────────────────────────────────────────────────────────┤
│                                                        │
│ Local block       ████ 5ms       (CPU cache hit)       │
│                  █████████ 50ms  (Disk read)           │
│                                                        │
│ HTTP peer        ████████████████ 100ms (HTTP)         │
│                  ███████████████████████████ 500ms     │
│                                                        │
│ TCP Wire         ███████ 50ms   (Persistent conn)      │
│                  ████ 25ms      (Best case)            │
│                                                        │
│ DHT query        ██████████████████ 1000ms (Lookup)    │
│                  ████████████████████████████ 2500ms   │
│                                                        │
│ Worst case       ███████████████████████████████ 5000ms │
│                  (Full network search)                 │
│                                                        │
└────────────────────────────────────────────────────────┘

Performance Optimization Tips:
  1. Enable TCP Wire protocol (50ms vs 100-500ms)
  2. Increase replica count (faster DHT failure)
  3. Local caching (cache after first remote fetch)
```

---

## 3. Multi-Protocol Dual-Layer Broadcasting Architecture

### 3.1 Block Broadcasting Protocol Selection

```
Block generation:
  ┌──────────────────────────────────────────┐
  │ Node A generates block                   │
  │ block = { cid: "bafybeih5...", ... }    │
  └──────────────────────┬───────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ↓                ↓                ↓
    [Decision]      [Priority]      [Selection]
    │               │                 │
    ├─HTTP          ├─All blocks      ├─ Prefer: HTTP
    │ Gossip        │ must go via      │ Fallback: Wire
    │               │ HTTP            │
    └─TCP Wire      │ (Reliability)   │
      (Optional)    │                 └─ If wire enabled:
    │               │                   ├─ Dual broadcast
    │               ├─Critical blocks   └─ Race transmit
    │               │ fast propagate
    │               │ (wire)
    │
    └─-> broadcastBlock()
           ├─ HTTP: await p2p.receiveBlock(block)
           │
           └─ Wire: if (wireBroadcast) {
                     wireBroadcast(block)
                   }
```

### 3.2 Protocol Advantages Comparison

```
┌─────────────────────────────────────────────────────┐
│ HTTP Gossip vs TCP Wire                             │
├───────────────────┬─────────────────┬───────────────┤
│ Feature           │ HTTP Gossip     │ TCP Wire      │
├───────────────────┼─────────────────┼───────────────┤
│ Latency           │ 100-500ms       │ 25-50ms       │
│ Throughput        │ Medium          │ High          │
│ Reliability       │ High (retry)    │ Medium        │
│ Firewall Piercing │ Good (HTTP)     │ Poor (custom) │
│ Priority Queue    │ FIFO            │ Priority      │
│ Connection State  │ Stateless       │ Persistent    │
│ Content Verify    │ Manual required │ Frame-level   │
├───────────────────┼─────────────────┼───────────────┤
│ Best Use Case     │ Generic block   │ Critical block│
│                   │ forwarding      │ acceleration  │
│                   │ BFT messages    │ Local network │
└───────────────────┴─────────────────┴───────────────┘

Recommended Configuration:
  Small network (3-5): HTTP Gossip only
  Medium (5-20): HTTP + Wire hybrid
  Large (20+): Wire primary, HTTP backup
```

---

## 4. DHT Node Discovery and Block Query

### 4.1 DHT Iterative Lookup Flow

```
Query Target: Providers of block bafybeih5...

[Start] Node A initiates query:
  │
  ├─ hash = CID.hash()                    // Convert to 256-bit hash
  │
  ├─ candidates = routingTable.findClosest(hash, K=20)
  │                                       // K-bucket query
  │
  └─ parallel_queries = 3                 // ALPHA = 3 concurrent
     │
     [Round 1] (t=0ms):
       Node A concurrently queries 3 closest candidates:
       │
       ├─ Node B: FIND_NODE(hash) → [C, D, E, F]
       ├─ Node C: FIND_NODE(hash) → [D, E, G, H]
       └─ Node E: FIND_NODE(hash) → [G, H, I, J]
       │
       ├─ Collect responses: [C, D, E, F, G, H, I, J]
       │
       └─ Update candidate set (sorted by XOR distance)
     │
     [Round 2] (t=100ms):
       Query next 3 closest:
       │
       ├─ Node D: FIND_NODE(hash) → [I, J, K, L]
       ├─ Node G: FIND_NODE(hash) → [K, L, M, N]
       └─ Node I: FIND_NODE(hash) → [Provider X, Y]
       │
       └─ Found providers! → [X, Y]
     │
     [Round 3] (t=200ms):
       Query additional candidates (if more providers needed)
       │
       └─ Goal: Minimum 3 providers
     │
     [Convergence Condition]:
       ├─ Found sufficient providers (3+)
       ├─ No new close neighbors discovered
       └─ Timeout (30s)

Final Result:
  ┌────────────────────────────────────┐
  │ Providers of bafybeih5...:         │
  │ ├─ Node X (distance: 0x1234...)    │
  │ ├─ Node Y (distance: 0x5678...)    │
  │ └─ Node Z (distance: 0xABCD...)    │
  └────────────────────────────────────┘

Select closest provider:
  GET {NodeX.url}/api/v0/cat?arg=bafybeih5...
```

### 4.2 DHT Performance Characteristics

```
Network Scale vs Query Time:

Nodes = 10:
  Average hops: 2.3
  Query time: 200-300ms
  │
  ├─ Round 1: 100ms (3 queries)
  ├─ Round 2: 100ms (3 queries)
  └─ Converge

Nodes = 100:
  Average hops: 6.6
  Query time: 500-800ms
  │
  ├─ Round 1: 100ms
  ├─ Round 2: 100ms
  ├─ Round 3: 100ms
  ├─ Round 4: 100ms
  ├─ Round 5: 100ms
  └─ Round 6: 100ms

Nodes = 1000:
  Average hops: 10
  Query time: 800-1200ms
  │
  └─ 10 rounds × 100ms

Conclusion:
  DHT query latency ∝ log(N)
  N = 10: Fast (use as primary query)
  N > 100: Slow (use as fallback)
```

---

## 5. Node Downtime and Recovery Scenarios

### 5.1 Block Availability Evolution

```
Scenario: 5-node network, Node A is origin

Initial State:
  ┌─────┬─────┬─────┬─────┬─────┐
  │  A  │  B  │  C  │  D  │  E  │
  ├─────┼─────┼─────┼─────┼─────┤
  │ ✓✓✓ │ ✓✓✓ │ ✓✓✓ │ ✓✓✓ │ ✓✓✓ │ 3 replicas/block
  │ 100%│ 100%│ 100%│ 100%│ 100%│
  └─────┴─────┴─────┴─────┴─────┘
         Redundancy: 15 blocks / 5 original = 3x

Node A Fails:
  ┌─────┬─────┬─────┬─────┬─────┐
  │  A  │  B  │  C  │  D  │  E  │
  ├─────┼─────┼─────┼─────┼─────┤
  │  ✗  │ ✓✓✓ │ ✓✓✓ │ ✓✓✓ │ ✓✓✓ │ 3 replicas/block
  │DOWN │ 100%│ 100%│ 100%│ 100%│
  └─────┴─────┴─────┴─────┴─────┘
         Redundancy: 12 blocks / 5 original = 2.4x
         Availability: 100% (B, C, D, E cover all blocks)

Node A + B Fail:
  ┌─────┬─────┬─────┬─────┬─────┐
  │  A  │  B  │  C  │  D  │  E  │
  ├─────┼─────┼─────┼─────┼─────┤
  │  ✗  │  ✗  │ ✓✓✓ │ ✓✓✓ │ ✓✓✓ │ 3 replicas/block
  │DOWN │DOWN │ 100%│ 100%│ 100%│
  └─────┴─────┴─────┴─────┴─────┘
         Redundancy: 9 blocks / 5 original = 1.8x
         Availability: 100% (C, D, E still have complete)

Node A + B + C Fail:
  ┌─────┬─────┬─────┬─────┬─────┐
  │  A  │  B  │  C  │  D  │  E  │
  ├─────┼─────┼─────┼─────┼─────┤
  │  ✗  │  ✗  │  ✗  │ ✓✓✓ │ ✓✓✓ │ ? replicas/block
  │DOWN │DOWN │DOWN │ 100%│ 100%│
  └─────┴─────┴─────┴─────┴─────┘
         Risk: Some blocks may be missing
         Availability: Uncertain

Worst Case Threshold:
  3 replicas + 2 failures = 1 replica (critical)
  3 replicas + 3 failures = data loss risk

  5 replicas + 2 failures = 3 replicas (safe)
  5 replicas + 3 failures = 2 replicas (acceptable)
  5 replicas + 4 failures = 1 replica (critical)
```

### 5.2 Node A Recovery Process

```
Node A Comes Back Online:
  │
  [Phase 1] Startup (t=0s)
  ├─ Read pins.json
  │  └─ "I should have blocks: [bafybeih5, bafybeidf, ...]"
  │
  [Phase 2] Block Sync (t=0-10s)
  ├─ FOR each pin:
  │   IF local block missing:
  │     ├─ GET {NodeB.url}/api/v0/cat?arg={cid}
  │     ├─ Verify CID hash
  │     └─ Store to storage/blocks/{cid}
  │
  [Phase 3] DHT Announcement (t=10-20s)
  ├─ FOR each pin:
  │   └─ dht.announce(cid, self.address)  // Tell network "I have this block"
  │
  [Phase 4] Complete (t=20s)
  └─ Node A restored to full replica state

Worst Case: 1000 blocks, 50ms/block
  Total recovery time = 1000 × 50ms = 50s
  Optimization: Batch queries (max 5 concurrent) = 50s / 5 = 10s
```

---

## 6. PoSe Storage Proof Workflow

### 6.1 Proof Generation and Verification

```
PoSe Cycle:
  │
[1] Challenger randomly selects block
  │   SELECT RANDOM cid FROM stored_blocks
  │   cid = bafybeih5cyyzd4gpjbxhinpdsd75qkudq5zvma4vsmrrgclyocdzs2vp3y
  │
[2] Submit challenge to blockchain
  │   tx = PoSeManager.challenge(
  │         cid,
  │         merkleRoot,
  │         requesterAddress
  │       )
  │
[3] Prover responds
  │   blockData = await node.getBlock(cid)
  │   proof = merkle.buildMerklePath(blockData)
  │
  │   tx = PoSeManager.submitReceipt(
  │         cid,
  │         merkleRoot,
  │         proof,
  │         timestamp
  │       )
  │
[4] On-chain verification
  │   merkle.verify(blockData, proof, merkleRoot)
  │   if merkleRoot is correct:
  │     ├─ ✓ Proof valid
  │     └─ Allocate reward
  │
[5] Reward allocation
    └─ prover += reward

Block Query Optimization:
┌─────────────────────────────────────┐
│ Merkle Proof Tree                   │
├─────────────────────────────────────┤
│                                     │
│           Root                      │
│          /    \                     │
│        H1      H2                   │
│       /  \    /  \                  │
│      H3  H4  H5  H6                 │
│     / \ / \ / \ / \                 │
│    L0 L1 L2 L3 L4 L5                │
│                                     │
│ Query Block L2:                     │
│   Proof = [L3, H4, H2]              │
│   Verify: H1 = hash(L2, L3)         │
│           H4' = hash(L2, L3)        │
│           ... → Root                │
│                                     │
│ Proof Size: O(log N)                │
│ N = 262KB blocks: ~18 hashes        │
│ = 18 × 32B = 576B                   │
│                                     │
└─────────────────────────────────────┘
```

---

## 7. Network Scale Effects

### 7.1 Replica Count Growth with Node Count

```
Replica Count = f(Node Count, Block Receipt Probability)

Assumption: Each node has 95% probability of receiving block

┌──────────────────────────────────────┐
│ Nodes │ Expected Replicas │ Redundancy │
├──────────────────────────────────────┤
│   1   │     1             │    1x      │
│   2   │    1.95           │    2x      │
│   3   │    2.86           │    3x      │
│   5   │    4.77           │    5x      │
│  10   │    9.41           │    9x      │
│  20   │   18.34           │   18x      │
│  50   │   46.13           │   46x      │
│ 100   │   91.42           │   91x      │
└──────────────────────────────────────┘

Calculation Formula:
  E[Replicas] = N × (1 - (1-P)^N)

  P = Block receipt probability = 0.95
  N = Node count

Growth Curve:
  Replicas
    │
 90 ├         ╱╱
    │      ╱╱
 70 ├    ╱╱
    │  ╱╱
 50 ├╱╱
    │
 30 ├
    │
 10 ├
    │
  0 ├─────────────────
    0    20    40    60    80   100
              Node Count

Conclusion:
  - Replica count ∝ N (approximately linear)
  - More nodes = higher redundancy
  - 10+ nodes: Reliability already 99.99%
```

### 7.2 Block Propagation Time vs Node Count

```
Time for block to propagate from Node A to all nodes:

Assumption: HTTP gossip, 100ms/hop, concurrency=5

┌──────────────────────────┐
│ Nodes │ Expected Time │   │
├──────────────────────────┤
│   3   │   200ms       │ Very Fast   │
│   5   │   300ms       │ Fast        │
│  10   │   500ms       │ Medium      │
│  20   │   800ms       │ Medium      │
│  50   │  1.5s         │ Slow        │
│ 100   │  2.5s         │ Very Slow   │
│ 500   │  8s           │ Extremely   │
└──────────────────────────┘

Formula:
  T(N) ≈ log(N) × (blockSize / bandwidth)

  Assume: blockSize = 262KB, bandwidth = 10 Mbps
  T(N) ≈ log(N) × 0.2s

Optimization Strategies:
  1. Use TCP Wire: reduce by 0.5x
  2. Increase concurrency: 5 → 10 reduces by 0.5x
  3. Data center internal: 1Gbps → 1ms/hop
  4. Use CDN nodes: multi-region redundancy
```

---

## 8. Block Size and Performance Tradeoffs

### 8.1 Block Size Impact Analysis

```
Current Configuration: DEFAULT_BLOCK_SIZE = 262KB

┌─────────────────────────────────────────┐
│ Block Size │ Advantages   │ Disadvantages
├─────────────────────────────────────────┤
│ 64KB       │ Fast transfer│ Large index   │
│            │ High concur  │ Many queries  │
│            │              │ Deep Merkle   │
│            │              │              │
│ 262KB      │ Balanced     │ (No major     │
│ ✓          │ Small index  │ disadvantages)│
│            │ Good speed   │              │
│            │ Shallow tree │              │
│            │              │              │
│ 1MB        │ Save space   │ Slow transfer │
│            │ Shallow tree │ Unreliable    │
│            │              │ High retry    │
│            │              │ Memory use    │
│            │              │              │
│ 10MB       │ Optimal      │ LAN only      │
│            │ storage      │ Timeout risk  │
└─────────────────────────────────────────┘

Performance Metrics Comparison:

Transfer Time (1MB file):
  64KB blocks (16 blocks):   16 × 50ms = 800ms
  262KB blocks (4 blocks):    4 × 150ms = 600ms ✓ Optimal
  1MB blocks (1 block):      600ms

Merkle Tree Depth:
  64KB blocks:   log2(16) = 4 layers
  262KB blocks:  log2(4) = 2 layers ✓ Proof small
  1MB blocks:    log2(1) = 0 layers

Index Size (1GB file):
  64KB blocks:   16,384 items × 32B = 524KB
  262KB blocks:  4,096 items × 32B = 131KB ✓ Minimal
  1MB blocks:    1,024 items × 32B = 33KB

Recommendation:
  ✓ 262KB block size is optimal balance point
```

---

## 9. Failure Mode Analysis

### 9.1 Failure Tree

```
Data Unavailability
  │
  ├─ All replicas lost (P ≈ 10^-6)
  │   ├─ Node A: fails
  │   ├─ Node B: fails
  │   └─ Node C: fails (simultaneous)
  │
  ├─ Network partition (P ≈ 10^-3)
  │   ├─ Nodes A-B disconnect
  │   ├─ Nodes B-C disconnect
  │   └─ Block unretrievable from reachable nodes
  │
  ├─ Block corruption (P ≈ 10^-15/block)
  │   ├─ Disk error
  │   ├─ Memory error
  │   └─ Undetected by CID hash (extremely unlikely)
  │
  ├─ DHT pollution (P ≈ 10^-2)
  │   ├─ Attacker claims to have block
  │   ├─ Heavy queries to attacker
  │   └─ Returns invalid block (caught by CID validation)
  │
  └─ Application error (P ≈ 10^-3)
      ├─ Block wrongly deleted
      ├─ Pin list overwritten
      └─ Garbage collection error
```

### 9.2 Reliability Calculation

```
System Reliability (99% assumption):

Single node storage reliability:
  R_node = 0.99999 (0.001% annual failure)

At least K out of N nodes working:
  P(at least K alive) = Σ C(N,i) × p^i × (1-p)^(N-i)
                        i=K to N

3-node network (at least 2 working):
  = C(3,2) × 0.99999^2 × 0.00001^1
    + C(3,3) × 0.99999^3 × 0.00001^0
  ≈ 0.99999999 (99.99999% available)

5-node network (at least 3 working):
  ≈ 0.999999999 (99.9999999% available)

Conclusion:
  3 nodes → 9 nines reliability
  5 nodes → 11 nines reliability
  (Actual depends on sync frequency)
```

---

**Diagrams complete, use with main document.**
