# COC：面向区块链锚定 IPFS 部署的分层 P2P 文件存储架构

## 跨大陆部署中复制、纠删码与自愈机制的实证分析

**版本**：1.0 — 2026-05-08
**验证网络**：chainId 18780，3 个生产 validator + 5 个跨 us-central1 / asia-east1 / europe-west1 / us-west1 / asia-southeast1 的 GCP fullnode
**配套实现引用**：[chainofclaw/COC](https://github.com/chainofclaw/COC) commit `fefd433` 加上本工作直接发现的 [PR #74](https://github.com/chainofclaw/COC/pull/74)（大小写不敏感的 proposer 校验）与 [PR #75](https://github.com/chainofclaw/COC/pull/75)（`pushToK` 跳过 stale / duplicate peer）

---

## 摘要

COC（ChainOfClaw）将一个 IPFS 兼容的内容寻址存储层与一个 EVM 兼容的区块链整合，用以支持 Proof-of-Service（PoSe）结算合约。本文从具体算法、参数和故障模式三个维度分析 COC 的对等（P2P）文件存储子系统，并通过一个受控的跨大陆实验验证其灾后恢复属性：将一个 50 MB 文件上传至 5 台地理上分散的测试节点，随后销毁这 5 台节点，文件仍可从未参与上传、未与源邻近的 3 个生产 validator 完整取回——证明存储保证是网络拓扑的属性，而非任何单一节点的属性。文章呈现 7 层存储架构，将四个核心算法（`pushToK`、`fetchRemote`、`pushStripe`、`repairTick`）以伪代码形式形式化，推导四类灾难下的恢复保证，并报告跨大陆复制延迟与吞吐的实测数据。在评估过程中发现并修复了两个真实 bug——一个严格字符串 proposer 比较阻断 fullnode 加入链，一个路由表去重缺口悄然把有效复制因子腰斩——其修复也作为本文的贡献之一记录。

**关键词**：对等存储、内容寻址、分布式哈希表、Reed-Solomon 纠删码、自愈复制、区块链存储证明、Kademlia、IPFS、BFT 共识。

---

## 1. 引言

链上原生文件存储面临一个链下系统不存在的张力：共识层要求确定性的、缓慢变化的状态，而真实世界负载（文档、数据集、AI 制品）往往体积大、可变、且鲜少受益于链上复制。IPFS 协议族 [1] 通过分离 *内容寻址*（sha256 派生的 CID 标识"是什么"）与 *内容定位*（Kademlia DHT [2] 跟踪"在哪里"）来化解这一张力。COC 沿用此分离，并在其上叠加 PoSe 结算合约所需的三层：（a）面向存储效率的 Reed-Solomon 纠删码；（b）主动的 *push-to-K* 复制，使刚写入的数据在被动发现完成前不致受源节点失败影响；（c）周期修复循环，无需人工干预即可恢复目标副本数。

本文的实证关注是耐久承诺的最强形式：**上传到节点的文件，在这些节点全部消失后，是否仍能从从未参与原始写入的其他节点取回？**任何带有信用机制的 PoSe 存储市场都依赖此性质——否则，攻击者可在任意付款 finalize 的瞬间收取存储费用并原子地销毁数据。

本文 §6 通过一个部署实验对此问题给出肯定回答。其余章节安排如下：§2 综述相关工作并定位 COC 的设计选择；§3 给出 7 层架构；§4 形式化构成存储子系统核心的四个算法；§5 推导灾后恢复属性；§6 报告跨大陆测量结果；§7 记录所发现的 bug 及其修复；§8 讨论局限；§9 总结。

---

## 2. 背景与相关工作

**内容寻址存储**。内容寻址 [3] 使数据标识符自验证：任何字节翻转必然导致 CID 改变，因此本地即可检测损坏，无需可信索引。IPFS 普及了该模型 [1]，但其本身不保证复制或恢复——这些属于应用层的责任。COC 在其 `coc-ipfs-wiring` 胶合层中实现这些责任。

**分布式哈希表**。Kademlia [2] 在 XOR 距离下组织 peer-ID 空间，以 *K*=20 的 K-bucket 路由表存储邻居，并以迭代 `FIND_NODE` 查询达到 O(log N) 跳数。COC 复用该设计但有三处偏离：（i）路由 key 通过 `keccak256(cid)` 投影，使 DHT 距离反映内容局部性；（ii）双层 Sybil 上限（每 IP 每桶 ≤ 2 个 peer，每 IP 全表 ≤ 10 个）限制路由表污染；（iii）路由表与 wire 协议连接管理器集成，使节点活跃性可在 PUT 时验证，而非依赖陈旧记录。

**面向存储耐久的纠删码**。Reed-Solomon（RS）码 [4] 是复制的推广：（N, M）RS 方案将原始数据编码为 N 个数据 shard 加 M 个校验 shard，任意 N 个就可以重组原始内容。RS(4+2) 在 1.5× 存储成本下容忍 6 个 shard 中任意 2 个丢失；经典 3× 复制容忍 3 个副本中任意 2 个丢失。N 增大时 RS 在存储成本上压制纯复制，代价是 PUT 时的 CPU 与更复杂的修复路径。COC 提供 RS 作为可选选项（`?erasure=N+M` 查询参数），叠加在 K=3 的 push 复制之上。

**主动复制 vs 被动复制**。BitTorrent 类系统 [5] 依赖被动的需求驱动复制：稀有 block 仅在被请求时才积累副本。这对存储市场不适用——存储承诺必须在 PUT *后立即* 成立，先于任何取回。因此 COC 在 PUT 时执行主动 push（`pushToK` 操作，§4.3），仅在缓存填充时使用被动取回。

**自愈网络**。许多 P2P 系统 [6, 7] 依赖间歇性修复在节点流失后恢复副本数。COC 的 `repairTick`（§4.5）沿袭此传统，以 10 分钟周期与每 tick 修复 CID 数上限来约束 CPU 与带宽。

---

## 3. 系统架构

COC 的 P2P 存储子系统分为 7 层（图 1）。每层向上层呈现窄接口，仅依赖下层的接口；尤其，blockstore 有意保持网络无关，可独立单元测试，而 wiring 层是唯一感知所有其他层的组件。

```
┌──────────────────────────────────────────────────────────────────┐
│  L7  HTTP API（兼容子集）                                          │
│       /api/v0/add  /api/v0/cat  /api/v0/pin/*  /api/v0/repo/gc    │
├──────────────────────────────────────────────────────────────────┤
│  L6  文件编码                                                      │
│       UnixFS (dag-pb)        Reed-Solomon (dag-cbor manifest)     │
├──────────────────────────────────────────────────────────────────┤
│  L5  COC IPFS Wiring     ← 胶合层；唯一感知所有其他层的层           │
│       fetchRemote · pushToK · pushStripe · awaitReplicationResult │
├──────────────────────────────────────────────────────────────────┤
│  L4  Blockstore（内容寻址、sha 校验）                               │
│       钩子: fetchRemote(cid) → bytes? · onPut(cid, bytes, src)    │
├──────────────────────────────────────────────────────────────────┤
│  L3  DHT 网络                                                      │
│       Kademlia 路由表 · provider map · 查询引擎                    │
├──────────────────────────────────────────────────────────────────┤
│  L2  Wire 协议                                                     │
│       FrameDecoder · WireClient · WireServer · ConnectionManager  │
├──────────────────────────────────────────────────────────────────┤
│  L1  TCP 传输（按 peer 鉴权握手）                                   │
└──────────────────────────────────────────────────────────────────┘
```
**图 1**. COC P2P 存储子系统的层次架构。

读者应记住贯穿讨论的两条设计原则。**第一**，blockstore 仅强制本地不变量（字节对 CID 的 sha256 校验、字节配额驱逐、pin 保护）；每个分布式属性——复制、修复、通告——都在 wiring 层（L5）通过组合 blockstore 钩子与 DHT、wire 调用来实现。**第二**，wiring 层在 *本地* PUT（节点自身通过 HTTP API 摄入或链逻辑写入）与 *remote-cache* PUT（节点为满足 GET miss 而从其他 peer 取回的数据）之间作严格区分。**仅本地 PUT** 触发主动复制；缓存填充不触发，因为上游已经负责把字节扩散给其 K 个最近 peer，缓存驱动的级联推送会指数级放大网络成本而不增强耐久保证。

---

## 4. 核心算法

本节形式化主导观测行为的四个算法。我们使用分布式系统文献中常见的伪代码记法；对生产 TypeScript 实现的精确行号引用在每小节末尾给出。

### 4.1 内容寻址与分块

大小为 *s* 字节的文件 *F* 被切为 *k* = ⌈*s* / 256 KiB⌉ 个等大 chunk（最后一个可能更短）。每个 chunk *Cᵢ* 独立哈希得到叶子 CID：

$$\text{CID}_i = \text{multihash}(\text{sha256}(C_i))$$

UnixFS 根节点（dag-pb 编码）列出所有叶子 CID 与文件元数据；根节点本身有自己的 CID，即用户公开的文件标识符。每个 chunk 与根都是独立的 IPFS block，独立存储、取回、复制。

与 dag-pb 树并行，COC 在叶子哈希上构建二叉 Merkle 树（实现分析的 §4.2）。带域分隔的叶子与内部哈希分别为：

- $H_{\text{leaf}}(c) = \text{keccak256}(0x00 \,\|\, c)$
- $H_{\text{node}}(l, r) = \text{keccak256}(0x01 \,\|\, l \,\|\, r)$

Merkle 根作为存储证明的一部分记录在链上，与 dag-pb 树的内容寻址相互独立。这种双结构使 COC 在保留 IPFS 兼容性（dag-pb 根即为发布的 CID）的同时，支持以 O(log N) 大小的证明在链上验证特定 chunk 对 Merkle 根的归属。

来源：`node/src/ipfs-unixfs.ts`（分块、dag-pb 编码）、`node/src/ipfs-merkle.ts`（Merkle 路径、叶子/节点域分隔）。

### 4.2 DHT 路由 key 投影

base32（`bafy...`）或 base58（`Qm...`）编码的 CID 不能直接作为 Kademlia 路由 key——XOR 距离要求统一宽度的二进制 key 空间。COC 通过下式将每个 CID 投影至 256 位 key 空间：

$$\text{routingKey}(cid) = \begin{cases} \text{lowercase}(cid) & \text{若 } cid \text{ 为 256 位十六进制} \\ \text{keccak256}(cid) & \text{否则} \end{cases}$$

第一分支让 EIP-160 节点 ID 原样通过——它们已是合法路由 key。第二分支保证 CID 在 key 空间中的位置相对其编码格式均匀随机，无任何编码享有结构性特权。该投影保留 Kademlia 高效查询所依赖的 *内容局部性* 属性：与 `routingKey(cid)` XOR 距离接近的 peer 是首选副本，使读写收敛于同一邻域。

来源：`node/src/coc-ipfs-wiring.ts:41-45`。

### 4.3 主动复制：pushToK

`pushToK` 操作在每次本地 PUT 时运行，是首要的主动复制原语。其目标是确保新写入的 block 在操作返回前到达至少 *K*（默认 3）个不同 peer，使数据能在源节点后续失败时存活。算法 1 给出修复后版本（PR #75）；修复前版本在 §7.2 讨论。

```
算法 1：pushToK(cid, bytes) → PushToKResult

输入：  cid    — block 的内容标识符
        bytes  — block 内容（≤ 16 MiB，受 wire 协议上限约束）
输出：  { attempted, succeeded[], failed[], skippedLowPeers }

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

三个属性值得强调。**第一**，候选池（第 1 行）是复制因子的 4 倍，保证算法在必须接受亏损前可容忍至多（K·4 − K）个 stale 或重复条目；在我们的跨大陆 8 节点部署中，最坏观察到 2 个 stale + 2 个重复，远在预算之内。**第二**，第 7 行的大小写不敏感去重弥补了 Phase X1.6 的缺口：COC peer ID 是 EIP-160 地址，钱包签名时使用其规范的 EIP-55 mixed-case 形式，但配置文件与路由表导入分别独立调用 `toLowerCase()`，使同一 peer 以不同大小写两次进入路由表。若不去重，两条目都占用 `targets` 槽位但解析到同一 `WireClient`，悄然把不同副本数减半。**第三**，第 23 行的 `sendThroughPeer` 通过每 peer promise 链对推送做 per-destination 串行化。其动机源于 PR #71：50 MB UnixFS PUT 产生约 200 chunk × K peer ≈ 600 个并发 `socket.write` 调用；若不做 per-peer 串行化，内核发送缓冲区溢出，`WireClient` 之前会在溢出时 destroy 自身 socket（已修），每个接收 peer 看到 ECONNRESET。串行化配合 drain 事件驱动的内部队列，在端到端给出自然的 backpressure。

来源：`node/src/coc-ipfs-wiring.ts:240-322`（PR #75 后形式）。

### 4.4 被动取回：fetchRemote

对偶操作 `fetchRemote` 在本地 GET 未命中 blockstore 时触发。算法 2 顺序尝试两条路径。

```
算法 2：fetchRemote(cid) → bytes | ⊥

1   providers ← dht.findProviders(cid, fanOut)             // fanOut = 3
2   if |providers| > 0:
3       bytes ← connMgr.requestBlockFromAny(providers, cid, t_pull)
4       if bytes ≠ ⊥: return bytes

5   // Issue #71 Bug B 兜底：provider gossip 可能滞后于真实 pushToK
6   connected ← connMgr.listConnectedPeerIds()
7   fallback  ← connected ∖ providers
8   if |fallback| = 0: return ⊥

9   bytes ← connMgr.requestBlockFromAny(fallback, cid, t_pull)
10  return bytes
```

兜底路径（第 5–9 行）针对一个观察到的竞态：成功向某 peer 投递字节的 `pushToK`（算法 1 第 25 行返回 `ok = true`）会向 DHT 发出 `ProviderAdvertise` 帧，但在 50 MB 上传过程中累积约 200 个 advertise 帧可能被内核相对下游读者发起的 pull 重排。在某成功持有者的 advertise 帧被处理之前调用 `findProviders` 的读者会看到不完整 provider 列表。回退到"任意已连接 peer"在最坏情况下多付一个往返，但消除了字节明明在网络中可证存在却返回 404 的情况。

来源：`node/src/coc-ipfs-wiring.ts:193-238`。

### 4.5 自愈：修复 tick

10 分钟周期扫描检查本地 pin 集合，对每个 pinned CID 查询 DHT 中的 provider 数，对任何 provider 数低于最小副本阈值 *r*=2 的 CID 重新运行 `pushToK`。算法 3 也涵盖 Phase Q.5 的纠删码感知修复路径。

```
算法 3：repairTick()

1   pins ← blockstore.listPins()
2   underReplicated ← []
3   for each cid ∈ pins:
4       providers ← dht.findProviders(cid, r)
5       if |providers| < r:  underReplicated ← underReplicated ∪ { cid }

6   batch ← underReplicated.take(repairBatchSize)            // 默认 50
7   for each cid ∈ batch:
8       block ← blockstore.get(cid)
9       result ← pushToK(cid, block.bytes)

10  // Phase Q.5：另行修复纠删编码文件
11  manifests ← pins.filter(cid : cid.codec = dag-cbor).take(20)
12  for each manifestCid ∈ manifests:
13      manifest ← decodeManifest(blockstore.get(manifestCid).bytes)
14      for each stripe ∈ manifest.stripes:
15          if all stripe.data ∧ all stripe.parity present locally:  continue
16          // Phase Q+1：在 RS 修复前先做 peer 拉取
17          for each missing shard cid:  blockstore.get(cid)         // 可能触发 fetchRemote
18          重新检查持有；若全部到位：continue                          // 已通过 peer 修复
19          if |持有的 shard 数| < N: 跳过该 stripe; 记 unrecoverable
20          buffer ← reedSolomon.reconstruct(stripe, present)
21          for each 重建的 shard:  blockstore.put(shard); blockstore.pin(shard)
```

`repairBatchSize` 的上限将单 tick 限于 ≤ 50 个普通 CID 与 ≤ 20 个 manifest，实测在 10 分钟周期下消耗 e2-medium 单核 CPU < 5%。Phase Q+1（第 16 行的 peer-pull 步骤）是在观察到大多数 stripe 缺失是因为单 peer 短暂离线、而非数据真正不可恢复后加入的；先从已连接 peer 拉取，只在确实必要时才支付一次 RS 重建（约 30 ms / stripe）。

来源：`node/src/coc-ipfs-repair.ts:227-513`。

---

## 5. 灾后恢复分析

我们分析四类灾难，刻画每一类下存储系统中持续可用的部分以及全恢复的时间界。

### 5.1 单节点失败

设 *p* 为持有 CID *c* 副本的 peer。当 *p* 失败（崩溃、分区、操作系统下电）时，每个其他 peer 在一个 TCP keep-alive 周期（典型 ≤ 60 s）内检测到丢失，并将 *p* 从其 `WireConnectionManager` 移除。DHT 路由表也保留 *p* 直至下一次 `addPeer` 把它作为最旧的无响应条目驱逐；若桶满时 `pingPeer` 失败，*p* 被立即移除。

若移除后 *c* 在某 peer 的本地 DHT 视图中 provider 数小于 *r*，则任一健康持有者下一次（≤ 10 分钟）的 `repairTick` 会调用 `pushToK(c, bytes)` 把数量恢复到 *K*。区间 [0, 10 min] 内文件仍可从存活的 K−1 个持有者取回；`fetchRemote` 仍可成功，因为 DHT 路径与连接 peer 兜底路径都枚举活跃 peer。

**性质 5.1**。*在 K = 3 与 r = 2 下的单节点失败下，文件保持持续可取回，且全复制在至多 ⌈(检测延迟) + (修复 tick 间隔)⌉ ≤ 11 分钟内恢复。*

### 5.2 K 容忍下的多节点失败

对持有 K 个不同副本的 CID，若同时失败的节点少于 K 个，则文件保持可取回——至少有一个副本存活，任意健康 peer 的 `repairTick` 会重建。若恰好 K−1 个节点失败，单一存活持有者仍通过 `fetchRemote` 服务，但其本地 DHT 视图显示 `|providers| = 1 < r = 2`，因此下一次 `repairTick` 会把字节重新推回 K 个节点。若恰好 K 个节点失败，除非启用了纠删码（§5.4），文件丢失。

**性质 5.2**。*对非纠删文件，少于 K 个副本的同时丢失保持可取回；K 个副本全部丢失在缺乏离线网络备份时不可恢复。*

### 5.3 网络分区

设集群被分为 *A*、*B* 两侧。每一侧内 blockstore、wire、DHT 操作正常进行，因为它们仅依赖本地状态。两侧均有副本的 CID *c* 在两侧均可取回。仅 *A* 有副本的 CID *c* 在 *B* 的任何 peer 上返回 404——`findProviders` 找不到活跃记录，连接 peer 兜底也只枚举本分区的 wire peer。连通性恢复后，任一侧的下一次 `addPeer` 会发现另一侧的节点；*A* 中运行的 `repairTick` 此时观察到合并后任何欠复制 CID 的 `|providers(c)| < r`，并把它们重新推送出去。

系统在分区下用一致性换可用性：*B* 的 peer 不会错误声明分区独有 CID 不存在（HTTP 404 响应在该语义下正确），且任何操作在合并网络上都不产生不一致状态。

**性质 5.3**。*网络分区保留跨分区 CID 的可用性，且不在 heal 时产生不一致状态；分区独有 CID 可能从另一侧暂时不可达，但合并后一个修复 tick 间隔内可重新被发现。*

### 5.4 所有源节点同时被销毁

这是存储子系统最强的性质。设文件 *F* 从 peer *p₀* 上传至 N 个 peer 组成的网络。由算法 1，*p₀* 把 *F* 的 chunks 与 manifest 写入本地 blockstore，然后对每个 chunk 与 manifest 调用 `pushToK`，从 `findClosest(routingKey(c), poolSize)` 选 K = 3 个不同 peer 推送字节。副本选择与 *p₀* 的身份不相关——XOR 距离是 *唯一* 的选择标准——因此 3 个副本依据 CID 在 key 空间中的位置散布在集群。

设在时刻 *t*，操作员销毁所有曾参与原始上传的 peer，包括 *p₀* 自己。只要 K = 3 个活跃副本 *并非全部* 在被销毁集合内，文件就仍可从任何持有副本的存活 peer 取回，以及从对此持有者运行 `fetchRemote` 的任何 peer 取回。在被销毁集合是集群严格子集的典型情况下（如 §6 中的 5 个 GCP 测试 peer），生产 validator 按 CID 在 key 空间中的密度比例接收一部分 chunks，可直接服务或互相拉取缺失 chunk。

**性质 5.4**。*若文件上传到 peer p₀ 且产生的 chunks 被推送到由 `findClosest(routingKey(c), ...)` 选择的 K = 3 个不同随机 peer，那么只要被销毁 peer 集合是 K 个副本的严格子集，文件就仍可从集群中接收过任何 chunk 的任意 peer 取回。在 §6 实验中，无副本被销毁，文件由每个生产 validator 服务。*

### 5.5 纠删编码下的耐久

对以 `?erasure=N+M` 上传的文件，`encodeFile` 产生的 manifest 引用每 stripe N+M 个 shard；每个 shard 本身是普通 IPFS block，受 `pushToK` 约束。恢复条件是每 stripe 有 N 个存活 shard，而非每 CID 有 K 个。由于 stripe 内的 shard 有不相关 CID，它们的路由 key 投影互不相关，Reed-Solomon 方案容忍 N+M 中任意 M 个 shard 丢失。修复路径（算法 3 第 11–21 行）通过 peer-pull 或 RS 算术重建缺失 shard 并重新推送，在可恢复故障后的至多一个 tick 内恢复全冗余。

**性质 5.5**。*在 N ≥ M 时，RS(N, M) 耐久在存储成本上压制 K 复制，且容忍任意 M 个 shard 丢失；修复 tick 在可存活故障后的一个周期内恢复全耐久。*

---

## 6. 实证评估

### 6.1 实验设置

部署一个 5 节点 GCP 虚拟机测试集群加入生产 COC 测试网（chainId 18780）。该测试网已包含 3 个 validator，分布在地理上分隔的托管设施中，实验时高度约 26 000，结束时约 26 800。5 个测试节点跨 5 个 GCP region：

| 节点 | Region | 类型 | 外部 IP |
|---|---|---|---|
| anchor-1 | us-central1-a | e2-standard-2 | 34.72.163.97 |
| anchor-2 | asia-east1-a | e2-standard-2 | 35.221.176.121 |
| burst-1 | europe-west1-b | e2-medium | 34.76.5.11 |
| burst-2 | us-west1-a | e2-medium | 35.227.159.16 |
| burst-3 | asia-southeast1-a | e2-medium | 35.198.223.160 |

每个测试节点配置为 *observer*（全同步、BFT 消息中继、IPFS 参与，无 validator stake），其 `peers[]` 列表包括 3 个生产 validator 加上其他 4 个测试节点。DHT bootstrap 列表相同。每 VM 预留静态外部 IP，使配置对 stop/start 周期鲁棒。

### 6.2 加入生产网络

在两个潜伏 bug 修复后（§7），5 个测试节点从初始状态高度 25 328 在 4–10 分钟内同步到链头。Snap-sync（本地与远程高度差超过 100 时触发的分块状态快照协议）每节点多次触发；观察到 102 块的批量导入，在 e2-standard-2 anchor 上约 2 s 完成。

### 6.3 跨大陆复制

在 `anchor-2`（asia-east1）从 `/dev/urandom` 生成一个 50 MB 文件，通过 `POST /api/v0/add` 上传。上传 61 s 完成。上传 ack 后 30 s 内，文件的 chunk（约 200 个）与 manifest 通过算法 1 各自推送到 K = 3 个不同 peer；随后从测试节点与生产 validator 联合中的每个 peer 发出 HTTP GET。

| Peer | Region | HTTP 状态 | 时间 | 字节 | sha256 匹配 |
|---|---|---|---|---|---|
| anchor-1 | us-central1 | 200 | 139 s | 50 MiB | ✓ |
| anchor-2 | asia-east1 | 200 | 18 s（源） | 50 MiB | ✓ |
| burst-1 | europe-west1 | 200 | 210 s | 50 MiB | ✓ |
| burst-2 | us-west1 | 200 | 109 s | 50 MiB | ✓ |
| validator-1 | （生产） | 200 | 22 s | 50 MiB | ✓ |
| validator-2 | （生产） | 200 | 30 s | 50 MiB | ✓ |
| validator-3 | （生产） | 200 | 23 s | 50 MiB | ✓ |

**表 1**。8 个 peer 全在线时 50 MB 文件的跨大陆取回。

7 个非源 peer 全部取回字节相同的内容。取回时间的方差与该 peer 是通过 `pushToK` 收到文件（validator 即如此，22–30 s 完成）还是不得不触发 `fetchRemote` 取回缺失 chunk（`burst-1` 最长 210 s，因内核发送缓冲队列未在本实验中优化）相关。

### 6.4 灾难场景：源销毁

在表 1 测量后，5 个 GCP 测试节点全部通过 `gcloud compute instances stop` 停机并确认 TERMINATED 状态。30 s 静置间隔后，仅向 3 个生产 validator 重新发出 HTTP GET。

| Peer | HTTP 状态 | 时间 | 字节 | sha256 匹配 |
|---|---|---|---|---|
| validator-1 | 200 | 17 s | 50 MiB | ✓ |
| validator-2 | 200 | 14 s | 50 MiB | ✓ |
| validator-3 | 200 | 28 s | 50 MiB | ✓ |

**表 2**。5 个测试节点全部停机后同一文件的取回。

这正是 §5.4 强耐久性质在运作：由 `anchor-2`（asia-east1）上传——已被销毁——以及其他 4 个测试节点——也全被销毁——的文件，仍可从每个生产 validator 字节相同地取回。生产 validator 均未参与上传，GET 时刻无任何测试节点可在线为任何 chunk 服务 `fetchRemote`。数据可证明是网络拓扑的属性而非任何特定节点的属性。

### 6.5 成本与运维剖面

实验在 90 分钟活动期内消耗约 $0.30 GCP 费用：$0.27 计算（5 个不同规格 VM）加 $0.03 静态 IP 分配与同区出口流量。完全清理时删除全部 VM 与静态 IP，仅保留（免费的）VPC 与防火墙规则，使 GCP 成本归零。

---

## 7. 发现并修复的 Bug

评估期间揭露了两个潜伏 bug，均源自模块间不完整的大小写归一化，各自值得独立的 PR。

### 7.1 PR #74：大小写不敏感的 proposer 校验

`PersistentChainEngine.verifyBlockChain` 用 JavaScript 的 `Array.prototype.includes` 校验入站 block 的 `proposer` 字段是否在配置 validator 集合中，该方法做严格（大小写敏感）字符串比较。`node-1.json` 中序列化的 validator 集合是小写；远程 validator 序列化的 `proposer` 字段是 EIP-55 mixed-case 形式。因此加入链时在任何 validator 的第一个 block 处永久卡死：每个 fork-choice 尝试都因 `proposer not in validator set` 而 `verifyBlockChain` 失败，snap-sync 完成事件从不触发。

修复对照同一 engine 中两处其他比较点的 `.toLowerCase()` 模式，并加注释说明归一化缺口。补丁是 14 行变更，无需测试脚手架以应用即时修复，但建议在 `chain-engine-persistent.test.ts` 中加回归测试作为后续工作。

### 7.2 PR #75：pushToK 跳过 stale 与重复 peer

修复前的 `pushToK` 体从路由表选 K + 1 个候选，跳过本地节点后取前 K 个。若其中任一为 stale（一个 TERMINATED VM 的条目路由表尚未剔除）或为同一地址的不同大小写重复（§4.3 的 EIP-55 / lowercase 对），对应 `pushBlock` 调用返回 `ok = false`，槽位被烧掉。诊断难度在于 per-peer 原因记录在 `log.debug` 级别，因此 partial-replication 汇总行（如 `attempted=3 succeeded=1 failed=2`）不携带任何关于失败 *为何* 发生的信息。运维人员只能对运行二进制做 instrumentation 才能查出。

修复有四处：（i）将候选池从 K + 1 扩大为 max(K · 4, 8) 留出过滤余量；（ii）在加入 `targets` 前对每个候选要求 `client.isConnected()`（计为 `staleSkipped`）；（iii）针对 `Set<lowercase>` 做大小写不敏感去重（计为 `dupSkipped`）；（iv）在 partial-replication 汇总旁以 info 级别捕获 per-peer 失败原因。

修复后，50 MB 文件的每个 chunk 都复制到 3 个不同 peer；修复前每个 chunk 都是 `attempted=3 succeeded=1`。§6 实验在修复前根本不可行：即便 5 个测试节点全在线，生产 validator 对文件 CID 仍返回 404，因为没有任何 chunk 投递到任何 validator。

---

## 8. 讨论

### 8.1 大小写归一化模式

上述两个 bug 都源自同一根因：COC peer ID 是 EIP-160 地址，规范表示为 EIP-55 mixed-case checksum 形式，但若干模块（配置加载、对小写友好的 Map key、JSON 序列化）独立归一化为小写，而远程来源（block proposer 字段、peer 握手载荷）通常保留 mixed case。任何跨此边界的比较若没有显式 `.toLowerCase()` 都会对合法输入失配。

生产代码库中的纠正分两步：每一处接触 peer ID 或 block proposer 的比较现在都期望对两侧归一化；以及一个建议的、尚未实现的 lint 规则会把 `Array.includes` 与以地址类型值为 key 的 `Map<string, ...>` 标记为可能需要大小写折叠的位置。上述两个 PR 移除了影响最大的实例；随着 fullnode 与 validator 部署增长，预期会有更多浮现。

### 8.2 `pushToK` 保证的局限

`pushToK` 在我们测试的集群规模（4–8 个 peer）下成功达到 K = 3 个不同 peer。在 N ≤ K 的 N peer 集群中，算法正确接受亏损并返回 `attempted < K`；数据仍到达每个可用 peer，但不达标称耐久目标。希望执行 K = 3 的运维应配置 N ≥ 5 以容许 2 peer 流失而不破坏保证。在 N > K 的 N peer 集群中，给定 chunk 由 `findClosest(routingKey(c), ...)` 决定的 K 个 peer 接收；因此（虽不大可能）可能 K 个副本全集中在未来分区的同一侧。纠删码通过 `pushStripe` 的多样性启发将 shard 均匀散布，缓解此风险。

### 8.3 e2-standard-2 fullnode 的性能

我们观察到 anchor 在追同步高峰时 CPU 饱和，使得并发 IPFS API 操作变慢以致 50 MB 上传在 90 s 处超时。anchor 追上链头后 IPFS API 吞吐恢复。这意味着加入生产网络的 observer fullnode 应至少配置 4 vCPU；e2-standard-2（2 vCPU）基线对稳态运行可用，但在初始同步时易受 head-of-line 阻塞影响。

### 8.4 存储证明的链接

§4.1 中计算的 Merkle 根是链下字节与链上 PoSe 合约之间的桥梁。存储 challenger 向某持有者请求 chunk index *i*；持有者响应 chunk 字节与 Merkle 路径；合约校验路径并向持有者计提报酬。该模式独立于 IPFS dag-pb 树，能在 IPFS 编码任何未来变更后存活。代价是叶子哈希的双重存储——对 1 GiB 以下文件可承受。

---

## 9. 结论

我们呈现了 COC P2P 文件存储子系统的架构与核心算法，并实证表明上传至 5 节点测试舰队的 50 MB 文件在该舰队全部销毁后仍可从生产 validator 耐久地取回。该结果源自三个组合机制：PUT 时主动 K = 3 推送、每次 block 传输的内容寻址校验，以及在节点流失后恢复副本数的 10 分钟周期修复循环。评估期间揭示的两个潜伏 bug——一个严格字符串 proposer 比较与一个路由表去重缺口——已被诊断并以补丁形式上游提交为 PR #74 与 PR #75。

主要教训是：内容寻址 P2P 系统的耐久是算法的属性而非任何节点的属性——只要主动复制原语将 K 份副本分发给按内容局部性准则选择的 peer，且修复循环仍在某处运行，文件便对持有 CID 的任何人保持可访问，只要集群规模减去失败集合大于零。运维者面对的挑战因此不是过度配置任何单一主机，而是确保集群的多样性（地理、ASN、组织所有权）使得任何可能的故障事件不会同时拿走 M = N − K 个以上节点。

---

## 参考文献

[1] J. Benet, "IPFS — Content Addressed, Versioned, P2P File System," arXiv:1407.3561, 2014.

[2] P. Maymounkov and D. Mazières, "Kademlia: A Peer-to-Peer Information System Based on the XOR Metric," in *Proceedings of the 1st International Workshop on Peer-to-Peer Systems (IPTPS)*, 2002.

[3] D. Mazières and D. Shasha, "Building Secure File Systems out of Byzantine Storage," in *Proceedings of the 21st Annual ACM Symposium on Principles of Distributed Computing (PODC)*, 2002.

[4] I. S. Reed and G. Solomon, "Polynomial Codes over Certain Finite Fields," *Journal of the Society for Industrial and Applied Mathematics*, vol. 8, no. 2, 1960.

[5] B. Cohen, "Incentives Build Robustness in BitTorrent," in *Proceedings of the 1st Workshop on Economics of Peer-to-Peer Systems*, 2003.

[6] I. Stoica, R. Morris, D. Karger, M. F. Kaashoek, and H. Balakrishnan, "Chord: A Scalable Peer-to-Peer Lookup Service for Internet Applications," in *Proceedings of ACM SIGCOMM*, 2001.

[7] A. Rowstron and P. Druschel, "Pastry: Scalable, Decentralized Object Location, and Routing for Large-Scale Peer-to-Peer Systems," in *IFIP/ACM International Conference on Distributed Systems Platforms and Open Distributed Processing (Middleware)*, 2001.

---

## 附录 A：参数表

| 模块 | 参数 | 值 | 来源 |
|---|---|---|---|
| Blockstore | `EVICT_TARGET_FRACTION` | 0.9 | `ipfs-blockstore.ts:10` |
| UnixFS | `DEFAULT_BLOCK_SIZE` | 256 KiB | `ipfs-unixfs.ts:9` |
| UnixFS | `MAX_READ_LINKS` | 10 000 | `ipfs-unixfs.ts:10` |
| UnixFS | `MAX_READ_SIZE` | 50 MiB | `ipfs-unixfs.ts:11` |
| Erasure | `DEFAULT_SHARD_SIZE` | 256 KiB | `ipfs-erasure.ts:55` |
| Erasure | `SHARD_SIZE_ALIGNMENT` | 8 字节 | `ipfs-erasure.ts:56` |
| DHT | `K`（桶大小） | 20 | `dht.ts:13` |
| DHT | `ID_BITS` | 256 | `dht.ts:14` |
| DHT | `ALPHA`（并发度） | 3 | `dht.ts:15` |
| DHT | `MAX_PEERS_PER_IP_PER_BUCKET` | 2 | `dht.ts:16` |
| DHT | `MAX_PEERS_PER_IP_GLOBAL` | 10 | `dht.ts:17` |
| DHT | `REFRESH_INTERVAL_MS` | 5 分钟 | `dht-network.ts:24` |
| DHT | `ANNOUNCE_INTERVAL_MS` | 3 分钟 | `dht-network.ts:25` |
| DHT | `DEFAULT_PROVIDER_TTL_MS` | 24 小时 | `dht-network.ts:38` |
| DHT | `REANNOUNCE_INTERVAL_MS` | 12 小时 | `dht-network.ts:45` |
| DHT | `MAX_PROVIDERS_PER_CID` | 64 | `dht-network.ts:42` |
| Wire | `WIRE_MAGIC` | 0xC0C1 | `wire-protocol.ts:13` |
| Wire | `MAX_PAYLOAD_SIZE` | 16 MiB | `wire-protocol.ts:15` |
| Wiring | `DEFAULT_FETCH_PROVIDER_FAN_OUT` | 3 | `coc-ipfs-wiring.ts:55` |
| Wiring | `DEFAULT_FETCH_TIMEOUT_MS` | 5 秒 | `coc-ipfs-wiring.ts:56` |
| Wiring | `DEFAULT_PUSH_TIMEOUT_MS` | 10 秒 | `coc-ipfs-wiring.ts:57` |
| Wiring | `DEFAULT_REPLICATION_FACTOR`（K） | 3 | `coc-ipfs-wiring.ts:64` |
| Wiring | 候选池大小 | max(K · 4, 8) | `coc-ipfs-wiring.ts:255` (PR #75 后) |
| Repair | `DEFAULT_TICK_INTERVAL_MS` | 10 分钟 | `coc-ipfs-repair.ts:61` |
| Repair | `DEFAULT_MIN_REPLICAS`（r） | 2 | `coc-ipfs-repair.ts:65` |
| Repair | `DEFAULT_REPAIR_BATCH_SIZE` | 50 | `coc-ipfs-repair.ts:70` |
| Repair | `DEFAULT_ERASURE_MANIFEST_BATCH_SIZE` | 20 | `coc-ipfs-repair.ts:76` |

---

## 附录 B：可复现性

实验所用全部部署脚本在 `chainofclaw/COC` 仓库的 `scripts/gcloud/`（10 个 shell 脚本）与 `scripts/{bootstrap-5-fullnode-deploy,deploy-fullnode,anchor-stake-register}.sh` 下版本控制。逐日描述实验、含每个 bug 补丁序列的验证报告位于 `docs/gcloud-multinode-validation-2026-05-08.md`。本论文所做分析涉及的源代码 commit 全部可从 `main` 分支的 `fefd433` commit 加上前述两个后续 PR 触达。
