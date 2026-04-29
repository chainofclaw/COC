# COC P2P 存储机制完整文档

> 详细说明 COC 在测试网当前配置下（Phase C Step 2）的分布式 IPFS 存储工作原理。
> 结合真实代码路径追踪一个 **100 MiB 文件** 的完整存储过程：分块策略、跨节点复制协议、最终落盘节点数。
> 英文版：`p2p-storage-mechanism-en.md`。

## 0. TL;DR — 100 MiB 文件的存储结果

在 3-validator 测试网 PUT 一个 100 MiB 文件（以 `node-1` 为上传入口）最终会产生：

| 指标 | 数值 |
|---|---|
| UnixFS 叶子 chunk 数 | **400 块**（每块 256 KiB） |
| DAG root 节点数 | **1 块**（~16 KB，内含 400 个 IPLD Link） |
| 总 content-addressed block 数 | **401 块** |
| 每块传输次数（经 wire push） | 2 次（发到 `node-2` 和 `node-3`） |
| 总 `pushBlock` wire RPC 次数 | 401 × 2 = **802 次** |
| 实际落盘节点数 | **3 个**（node-1 是源，node-2/3 通过 push 拿到完整副本） |
| 每块 DHT provider 记录数 | **3 个**（所有 validator 相互 gossip 后） |
| 每块 keccak256 leafHash（用于 PoSe） | 32 字节 × 400 = 12 800 字节 |
| Merkle tree 深度 | ceil(log₂ 400) = **9 层** |
| 单块 PoSe proof 大小 | 9 × 32 = **288 字节** |
| 累计出向带宽（node-1 → 其他） | 100 MiB × 2 = **200 MiB** |

---

## 1. 核心设计原则

COC 的 P2P 存储层在 IPFS 的 content-addressing 基础上加了 **4 重保障**：

1. **UnixFS 分块** — 大文件按 256 KiB 切块（IPFS 事实标准）
2. **内容寻址** — CIDv1 (dag-pb codec + sha256) 保证每块 bytes ↔ CID 双向单射
3. **Push-to-K 主动复制** — 每次本地 PUT 立即推送到 K 个最近 peer，不依赖"谁来拉"
4. **DHT provider records + gossip** — 跨节点告知"谁持有哪些 CID"，保证死一个节点不丢数据

这些是 Phase C（2026-04-24 完成）新增的能力。Phase B 之前只有"本地 blockstore + 外部可读 HTTP"。

---

## 2. 涉及的代码模块

```
用户 PUT 入口              IPFS HTTP      POST /api/v0/add → ipfs-http.ts:handleAdd
 │                              │
 │                              ▼
 │                        UnixFS 分块      ipfs-unixfs.ts:addFile
 │                              │
 │                              ▼
 │                      IpfsBlockstore     ipfs-blockstore.ts:doPut("local")
 │                              │ onPut 钩子
 │                              ▼
 │                    coc-ipfs-wiring.ts   onPut / pushToK / broadcastProviderAdvertise
 │                     ┌────────┼────────────────────────┐
 │                     ▼        ▼                        ▼
 │              DhtNetwork    WireClient              WireClient
 │              putProvider   pushBlock×K             ProviderAdvertise
 │              (本地记录)    (wire-protocol 0x12)    (wire-protocol 0x14)
 │                            │                        │
 │                            ▼                        ▼
 │                     远端 wire-server      远端 wire-server
 │                     ─ 校验 CID=sha256(bytes)         ─ onProviderAdvertise
 │                     ─ putFromPeer("remote-cache")      钩子 → dht.putProvider
 │                        │
 │                        ▼
 │                 onPut(source="remote-cache")
 │                 ─ 自宣告（不 cascade push）
 │                 ─ 回 gossip
 ▼
响应 PUT 完成  ← X-COC-Replicas-Warning 响应头（若低于 minReplicas）
```

---

## 3. 上传流程逐步详解

### 3.1 入口：HTTP PUT

用户发 `POST /api/v0/add` 到任意 validator 的 IPFS HTTP 端口（测试网是容器内 5001，不对外暴露 — 见测试网配置文档 §3.2）。`ipfs-http.ts:handleAdd` 解析 multipart body，拿到原始 bytes。

### 3.2 UnixFS 分块

`ipfs-unixfs.ts:addFile` 分三步：

**步 1：切块**
```typescript
const chunks = chunkBytes(bytes, DEFAULT_BLOCK_SIZE)  // DEFAULT = 262 144 (256 KiB)
```
100 MiB = 104 857 600 字节 → 切成 **400 个 chunk**，每块整整 256 KiB。

**步 2：叶子 CID**
每个 chunk 包装成一个 UnixFS 叶子 + DAG-PB 节点：
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
每次 `blockstore.put` 立即触发 **3.4 节描述的 onPut 钩子链**。

**步 3：DAG 根节点**
```typescript
const rootNode = buildUnixFsRoot(leafCids, chunkSizes, bytes.length)
const rootBytes = dagPB.encode(rootNode)   // ~16 KB（400 个 IPLD Link）
const rootCid = CID.createV1(dagPB.code, sha256Digest(rootBytes))
await this.store.put({ cid: rootCid.toString(), bytes: rootBytes })
```
返回给用户的就是 `rootCid`（如 `bafybeigxw35d6dw5...`）。

**同时生成的副产物**（Phase C PoSe 用）：
```typescript
const merkleLeaves = chunks.map(c => hashLeaf(c))  // keccak256(chunk) × 400
const merkleRoot   = buildMerkleRoot(merkleLeaves)  // 单 bytes32
```
这个 Merkle 树**与 UnixFS DAG 独立**。DAG 用 sha256（IPFS 生态标准），Merkle 用 keccak256（EVM 生态标准）。PoSe 挑战验证用后者。

### 3.3 本地落盘

`IpfsBlockstore.put()` 在 `doPut(block, "local")` 内把 bytes 写到磁盘 `${dataDir}/storage/blocks/${cid}`，然后触发 `onPut(cid, bytes, { source: "local" })`。

**关键**：源 = "local" 还是 "remote-cache" 决定后续是否 cascade push（避免指数级放大）。

### 3.4 onPut 钩子：三连发

Phase C 注入的 `onPut`（位于 `coc-ipfs-wiring.ts`）对每个写入的 block 做三件事：

**(a) 本地自宣告**
```typescript
cfg.dht.putProvider(cid, cfg.localNodeId, DEFAULT_PROVIDER_TTL_MS)  // 24h TTL
```
在自己的 DhtNetwork.providerRecords 里写一条 `cid → [localId]`。

**(b) 跨节点 Gossip**
```typescript
broadcastProviderAdvertise(cid)
// = 遍历所有已连的 WireClient，发 ProviderAdvertise 帧（wire 协议 0x14）
```
每个直接连接的 peer 收到后在**自己的** DhtNetwork 里加一条 `cid → [senderId]`。**单跳**——接收方不再转发，因为每个节点自己都会发，终局收敛。

**(c) 主动推送（仅 source="local" 时）**
```typescript
if (source === "local") pushToK(cid, bytes)  // 异步，不阻塞 put 返回
```

### 3.5 pushToK 的细节

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

**K 的 clamp**：配置的 `replicationFactor = 3`，但若只有 2 个其他 peer 可用（3-node 测试网），K clamp 到 2。

**routing key 转换**：`cidToRoutingKey(cid) = keccak256(utf8Bytes(cid))` — 把任意格式 CID（bafybe... 或 0x... 或 Qm...）投影到 peer-ID 的 XOR 距离空间，让 Kademlia routing table 能 `findClosest`。

**pushBlock wire 帧**（`wire-protocol.ts:BlockRequestPayload`）：
```typescript
{ 
  requestId: uuid, 
  cid: "bafybe...", 
  push: true, 
  bytes: base64(chunk)   // 最大 1 MiB per frame，256 KiB chunk 舒服塞下
}
```

接收方 `wire-server.ts` 校验流程：
1. 解 base64 → Uint8Array bytes
2. 大小 ≤ 1 MiB？否则 reject "oversize"
3. 验证 hash：
   - 若 CID 以 `0x` 开头 → 验 `keccak256(bytes) === cid`（legacy）
   - 否则 → parse CIDv1，`sha256(bytes) === multihash.digest`（Phase C 新增）
4. 通过则调用 `blockstore.putFromPeer({cid, bytes})`
5. 回 BlockResponse 帧 `{found: true}`

**为什么 `putFromPeer` 而不是 `put`**：区分 local vs remote-cache 来源。remote-cache 的 onPut **不触发 pushToK**（否则每块接收都往 K 个新 peer 再推，指数级放大）。

### 3.6 等待复制结果

Phase C3.1 在 `ipfs-http.ts:handleAdd` 的返回前做了一步：
```typescript
const replicaStatus = await awaitReplicationResult(meta.cid, 8000)
if (replicaStatus.worstReplicaCount < minReplicas /*=2*/) {
  headers["X-COC-Replicas-Warning"] = `got ${worst}/${minReplicas} (cid=${worstCid})`
}
res.writeHead(200, headers)
```
响应 header 可能带 `X-COC-Replicas-Warning: got 0/2` — 上传仍返回 200，但警告没达到最低复制要求。3-node 测试网正常情况下都能达到 2/2 所以无警告。

---

## 4. Wire 协议帧类型

Phase C 加了两个消息类型（`wire-protocol.ts:MessageType`）：

| opcode | 名字 | 用途 | 载荷 |
|---|---|---|---|
| `0x12` | BlockRequest | 拉（push=false）/ 推（push=true）block | `{requestId, cid, push?, bytes?}` |
| `0x13` | BlockResponse | 响应上述请求 | `{requestId, cid, found, bytes?, error?}` |
| `0x14` | ProviderAdvertise | 单跳 gossip "我有这个 CID" | `{cid, ttlMs?}` |

其他帧类型（Handshake, BFT, Block, Transaction, FindNode, Ping）都是 Phase B 就有的基础设施。

**优先级**（`wire-protocol.ts:DEFAULT_PRIORITIES`）：
- BFT messages: CRITICAL
- Block 传播 + BlockRequest/Response: HIGH
- ProviderAdvertise: LOW（gossip 可以慢点，不影响活性）

---

## 5. DHT Provider Records

### 5.1 数据结构（内存中）

`dht-network.ts:DhtNetwork.providerRecords`
```typescript
Map<cidHex_lowercased, Map<peerId_lowercased, expiresAtMs>>
```

外层 key = 小写 CID 字符串
内层 = `{peerId → 过期时间戳}`

### 5.2 基本操作

| API | 行为 |
|---|---|
| `putProvider(cid, peerId, ttlMs=24h)` | 插入或续期 |
| `findProviders(cid, maxK=3)` | 返回 ≤K 个未过期 peer；查询时**懒清理**过期项 |
| `removeExpiredProviders()` | 主动扫描清理（由 refresh() 计时器每 5 min 触发） |
| `reannounceSelfProviders()` | Phase C3.2：对 `blockstore.listPins()` 的每个 CID 都 `putProvider(cid, localId)` |

### 5.3 容量上限

- 每 CID ≤ 64 个 provider（`MAX_PROVIDERS_PER_CID`）
- 超过 cap 时淘汰"最快过期"的那条
- 防止 sybil 节点塞爆 map

### 5.4 Cross-node 收敛

对于同一个 CID，经过一次 PUT + gossip 后：
- **origin 节点**：`providerRecords[cid]` 含 `{localId, peer2, peer3}`（因为 peer2/3 也 gossip 过来了）
- **peer2/3 节点**：`providerRecords[cid]` 含 `{localId, peer2, peer3}`（从 origin gossip + 自己 putFromPeer 后的自宣告 + peer2↔peer3 互相 gossip）

**所有 3 个节点对同一个 CID 的 provider 视图完全一致**。

### 5.5 生命周期

```
t=0        origin 写入 + gossip + pushToK → 3 providers 收敛
t=12h      origin 执行 reannounceSelfProviders：把自己的 pins 再 putProvider + gossip
           全网 provider 记录 TTL 被刷新到 t+12h
t=24h      若 t=12h 的 reannounce 没执行（节点离线），record 此时会过期
t=10min × N  repair loop 扫描 pins，对 findProviders(cid) < minReplicas 的
             调 pushToK 补足
```

---

## 6. 检索（GET）流程

### 6.1 路径

用户通过 IPFS HTTP `GET /api/v0/cat?arg=<cid>` 或 `GET /ipfs/<cid>`：

```
http handler 
 → unixfs.readFile(rootCid)
    → blockstore.get(rootCid) 取 DAG root
    → 解析 400 个 leaf Link
    → for each leaf: blockstore.get(leafCid)
       → 若本地有 → 返回
       → 若本地无 → ENOENT → fetchRemote hook
          → dht.findProviders(cid, 3)
          → connMgr.requestBlockFromAny(providers, cid)
             → 并行向每个 provider 发 BlockRequest push=false
             → 首个返回 {found:true, bytes} 的胜出
          → blockstore.doPut(cid, bytes, "remote-cache") 
            → cache 本地 + 自宣告 DHT（不 push）
    → concat 400 块 bytes 返回
```

### 6.2 ⚠️ 100 MiB 文件的检索限制

`ipfs-unixfs.ts:readFile` 有一个 **`MAX_READ_SIZE = 50 MiB`** 的安全上限：
```typescript
for (const link of rootNode.Links) {
  ...
  totalSize += chunk.length
  if (totalSize > MAX_READ_SIZE) {
    throw new Error(`readFile exceeds max size: ${totalSize} > ${MAX_READ_SIZE}`)
  }
}
```

**所以 100 MiB 文件可以 PUT 成功并完整存在所有 3 个节点，但用 `/api/v0/cat` 或 `/ipfs/<cid>` GET 回来会在第 200 块后抛异常**。

如果要取回大文件，需要：
- 绕过 `readFile`：直接 `blockstore.get(rootCid)` 拿 DAG root，然后逐块 `blockstore.get(leafCid)` 流式写出（需要改 ipfs-http 支持范围请求）
- 或调整 `MAX_READ_SIZE` 常量
- 或使用 `/api/v0/block/get?arg=<leafCid>` 逐 block 拉

这是 Phase D 或后续的工作，当前 Phase C 代码按原样保持。

### 6.3 fetchRemote 并发

```typescript
requestBlockFromAny(peerIds, cid, opts):
  concurrency = min(opts.concurrency ?? 3, peerIds.length)
  timeoutMs = opts.timeoutMs ?? 5000
  // Promise-race：并发向 concurrency 个 peer 发 BlockRequest
  // 首个 {found: true, bytes} 胜出，其他作废
```

`DEFAULT_FETCH_PROVIDER_FAN_OUT = 3`。测试网 3 节点时实际并发最多 2 个（除自己外）。

---

## 7. 容错：Self-Healing

### 7.1 Re-announce 循环（C3.2）

`DhtNetwork.reannounceSelfProviders()`
- 触发周期：`REANNOUNCE_INTERVAL_MS = DEFAULT_PROVIDER_TTL_MS / 2 = 12h`
- 行为：遍历 `blockstore.listPins()`，对每个 pin 调 `putProvider(cid, localId)`（刷自己 TTL）+ `broadcastProviderAdvertise(cid)`（刷对方 TTL）
- 批量上限：每 tick ≤ 100 CID，剩余等下一 tick — 防止重启后雪崩
- 作用：长寿节点不会因为 24h TTL 让自己的 provider 记录过期，peer 始终知道"我还有"

### 7.2 Repair 循环（C3.3）

`IpfsRepairLoop.runOnce()`（由 `coc-ipfs-repair.ts` 实现）
- 触发周期：`DEFAULT_TICK_INTERVAL_MS = 10 min`
- 行为：
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
- 防雪崩：单 tick 最多修 50 个 CID；reentrance guard 避免 tick 重叠
- 容错：丢失 bytes 的 CID（理论不该发生）logs WARN 跳过，不崩 tick

### 7.3 综合效果

针对 100 MiB 文件的 401 个 block：
- 任意单个 validator 挂了：另两个仍持全副本；DHT 记录自愈
- 两个挂了（剩 node-1 一个）：
  - BFT 共识停（需要 2/3），但数据没丢
  - 新加入节点 `blockstore.get` ENOENT → fetchRemote → DHT 找到 node-1 → 拉回
- 节点回归：repair loop 在 10 min 内检测到副本数 < 2，自动补推

---

## 8. PoSe 存储证明（Merkle 路径）

存储层本身只管"文件真的在节点上"。**PoSe 存储证明**（Phase C2）负责每 epoch 抽查节点是否守住了声称持有的 CID：

```
challenger (agent)
  ─ 选 CID + chunkIndex（从 CidRegistry 池随机抽，DHT 预过滤垄断）
  ─ 发 challenge 到 prover(node-i)

prover (coc-node 边车)
  ─ blockstore.get(leafCid_i) 取 chunk bytes
  ─ leafHash = keccak256(bytes)
  ─ merklePath = buildMerklePath(all400LeafHashes, chunkIndex)
  ─ 返回 receipt { leafHash, merkleRoot, merklePath, chunkIndex } + EIP-712 sig

verifier (agent)
  ─ 用 leafHash + merklePath 重算一个 merkleRoot
  ─ 和 receipt 的 merkleRoot 对比 → Merkle 数学验证
  ─ 5% 概率额外"审计抽检"：再向另一个 DHT 独立 provider 请求同一个 chunk
     - 重算 keccak256(bytes) vs prover 声称的 leafHash
     - 不等 → InvalidStorageAudit → 节点降 storageBps
```

对 100 MiB 文件来说：
- Merkle tree 400 叶 → 深度 9
- 单 chunk 的 path = 9 个 siblings × 32 B = **288 B**
- 完整 proof 消息（含 leafHash + root + path）：9 × 32 + 32 × 2 = **352 字节**
- 这是存储证明的"单位大小"，与文件大小无关（只与 log₂ chunk 数有关）

---

## 9. 关键参数表

| 模块 | 常量 | 值 | 作用 |
|---|---|---|---|
| UnixFS | `DEFAULT_BLOCK_SIZE` | 256 KiB (262 144) | chunk 大小 |
| UnixFS | `MAX_READ_LINKS` | 10 000 | DAG root 最多链多少叶 |
| UnixFS | `MAX_READ_SIZE` | 50 MiB | `readFile` 上限 |
| wiring | `DEFAULT_REPLICATION_FACTOR` | 3 | K = push 目标 peer 数 |
| wiring | `DEFAULT_FETCH_PROVIDER_FAN_OUT` | 3 | GET 并行请求 peer 数 |
| wiring | `DEFAULT_FETCH_TIMEOUT_MS` | 5 000 | 单 peer block 拉取超时 |
| wiring | `DEFAULT_PUSH_TIMEOUT_MS` | 10 000 | 单 peer push 超时 |
| HTTP | `minReplicas` | 2 | PUT 警告阈值 |
| DHT | `DEFAULT_PROVIDER_TTL_MS` | 24 h | provider 记录有效期 |
| DHT | `REANNOUNCE_INTERVAL_MS` | 12 h | re-announce 周期 |
| DHT | `MAX_PROVIDERS_PER_CID` | 64 | 每 CID provider 上限 |
| repair | `DEFAULT_TICK_INTERVAL_MS` | 10 min | 修复循环周期 |
| repair | `DEFAULT_MIN_REPLICAS` | 2 | 低于此触发补推 |
| repair | `DEFAULT_REPAIR_BATCH_SIZE` | 50 | 单 tick 最多修几个 CID |
| wire | frame max size | 16 MiB | 单帧编码上限 |
| wire | push bytes max | 1 MiB | push 载荷大小上限 |

---

## 10. 100 MiB 上传全过程 — 步步可追踪

一个完整示例，跟着这个时序日志可以验证流程：

```
t=0 s       POST /api/v0/add 到 node-1, Content-Type: multipart/form-data
            node-1 的 ipfs-http handleAdd 读完 body, 拿到 104857600 bytes

t=0.1 s     unixfs.addFile 调用：
            step1 chunkBytes → 400 chunks
            step2 for i in 0..399:
              - dagPB 编码 chunk_i → ~256 KB block
              - sha256(block) → CID_i（bafybe...）
              - blockstore.put(CID_i, block) → 本地落盘
              - onPut 触发：
                  * dht.putProvider(CID_i, node1)
                  * broadcast ProviderAdvertise(CID_i) → [node2, node3]
                  * 异步 pushToK(CID_i, block_bytes) 启动
                       → 并行调 node2.pushBlock + node3.pushBlock

t=0.1 s    (并行) node-2 收到 BlockRequest(push=true, CID=..., bytes=base64):
              - sha256 验证通过
              - blockstore.putFromPeer(CID_i, block)
              - onPut(source="remote-cache") 触发：
                   * dht.putProvider(CID_i, node2)
                   * broadcast ProviderAdvertise(CID_i) → [node1, node3]
                   * NOT cascade push (source != local)
              - 回 BlockResponse {found: true}
            node-3 类似

t=0.5 s    所有 400 个 chunk 都 put 完毕
            unixfs 构造 rootNode，再走一遍 blockstore.put + onPut + pushToK
            rootCid 确定

t=0.6 s    awaitReplicationResult(rootCid, 8000ms)：
            查 inFlightPushes[rootCid] 取 PushToKResult
            worst replica count = 2（node-2, node-3 都 ack 了 push）
            minReplicas = 2 → 无警告

t=0.6 s    HTTP 200 返回：
            {"Name":"file.bin", "Hash":"bafybeig...", "Size":"104857600"}

最终状态（3 个 validator 全部持有全副本）：
  node-1.blockstore: root + 400 chunks ≈ 100 MiB on disk
  node-2.blockstore: root + 400 chunks ≈ 100 MiB on disk
  node-3.blockstore: root + 400 chunks ≈ 100 MiB on disk
  
DHT state (每个 node 的视图都等价):
  for each of 401 CIDs: providers = {node1, node2, node3}
```

**节点死亡场景**：
- 上传后 5 分钟 node-1 OOM 重启：
  - node-1 数据全在磁盘（LevelDB 不丢）
  - node-1 重启后 blockstore 健在，但内存 DHT 清空
  - reannounce tick 在最多 12h 内把自己的 400 个 pin 重新 putProvider + broadcast
  - 外部用户从 node-2 GET：成功（本地有）
- 上传后 node-1 掉线 15 分钟、没重启：
  - node-2/3 的 DHT 里 `node1` provider 还没过期（24h TTL）
  - 外部用户从 node-2 GET rootCid：本地 blockstore 有（因为是 pushToK 推过来的）→ 立即返回
  - 如果用户查的是 node-2 本地没有的 CID（理论不该出现，但 corner case）：
    - blockstore.get ENOENT → fetchRemote(CID) → dht.findProviders = [node-1, node-2, node-3]
    - requestBlockFromAny 并发 3 peers → node-2/3 命中 → 返回
    - node-1 超时不影响（并发 race）

---

## 11. 当前不足 & Phase D 工作

| 问题 | 影响 |
|---|---|
| `MAX_READ_SIZE = 50 MiB` 限制 `/api/v0/cat` | 100 MiB 文件存得下但取不出；需要流式 GET 实现 |
| `/api/v0/add` 不自动调 `CidRegistry.register()` | 上传后必须手动上链注册 CID 才能被 PoSe challenger 挑战 |
| 没有 erasure coding | K=3 整副本是最简单可靠但最耗存储（3 倍冗余）；Reed-Solomon 能做到 ~1.5 倍 |
| 只有 3 validators | K clamp 到 2；真正的"跨数据中心"需要 ≥5 节点才能发挥 Kademlia locality 优势 |
| 无 incentive model | 目前"谁 PUT 谁免费存 + K peer 被动被推"；后续需要 storage market（付费存储） |

这些都列在 Phase C 计划的"不做"清单里，留给 Phase D。

---

## 12. 参考

- 代码入口：
  - `node/src/ipfs-http.ts` — HTTP 层
  - `node/src/ipfs-unixfs.ts` — UnixFS 编解码
  - `node/src/ipfs-blockstore.ts` — 本地 block 存储 + onPut 钩子
  - `node/src/coc-ipfs-wiring.ts` — 把 blockstore/DHT/wire 粘起来
  - `node/src/coc-ipfs-repair.ts` — self-heal
  - `node/src/dht-network.ts` — Kademlia + provider records
  - `node/src/wire-protocol.ts` — 二进制帧
  - `node/src/wire-server.ts` / `wire-client.ts` — TCP 通信
  - `node/src/ipfs-merkle.ts` — keccak256 Merkle tree（PoSe 用）

- 相关文档：
  - `testnet-status-2026-04-24-zh.md` — 当前测试网配置
  - `architecture-zh.md` — 总体架构
  - `anti-sybil-zh.md` — 抗女巫攻击设计
