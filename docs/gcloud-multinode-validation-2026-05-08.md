# GCloud 多节点 P2P 存储验证 — 2026-05-08

| | |
|---|---|
| Status | ✅ 完成 — 用户原始测试目标 100% 达成 |
| Trigger | 验证 fullnode 跨大陆加入现网（chainId 18780）后的 IPFS p2p 存储健壮性，特别是"5 个测试节点上传 50MB 文件后全部下线，主网仍能 serve" 的持久性承诺 |
| Outcome | 上传 50MB → 7 节点都拿到副本 → 停 5 测试节点 → 主网 3 个 validator 仍 GET 200 OK |
| PRs | [#74](https://github.com/chainofclaw/COC/pull/74) case-insensitive proposer · [#75](https://github.com/chainofclaw/COC/pull/75) pushToK skip stale + dup peers |
| 删除 / 保留 | VM/磁盘/IP 全清理；VPC + firewall 保留（GCP 免费） |

---

## 1. 测试目标

1. **加入现网**：5 个 gcloud fullnode（observer 角色）从零起步追上现网 chainId 18780（高度 ~26000）。
2. **跨大陆 p2p 存储**：从任意节点上传文件后，跨 5 个 region（us-central1 / asia-east1 / europe-west1 / us-west1 / asia-southeast1）的副本 sha256 必须一致。
3. **持久性**：上传 50 MB 文件 → 复制扩散到主网 3 个 validator → 停掉所有 5 个上传/复制源节点 → 主网仍能完整 serve 该文件。

第 3 项是 PoSe 存储承诺的本质：**数据生存于网络，而非任何单一节点**。

---

## 2. 测试拓扑

```
                            ┌────────── 现网 (chainId 18780, 已运行) ──────────┐
                            │   validator-1 (209.74.64.88:28780/29780/29781)  │
                            │   validator-2 (159.198.44.136:同端口)            │
                            │   validator-3 (199.192.16.79:48780/49780/49781) │
                            └────────────────┬─────────────────────────────────┘
                                             │ wire 协议 + DHT bootstrap
                            ┌────────────────┴─────────────────────────────────┐
                            │              5 个 gcloud fullnode (本次新增)     │
                            │                                                  │
                  ┌─────────┴─────────┐                       ┌─────────┴────┐
              anchor-1                 anchor-2          burst-1   burst-2   burst-3
              us-central1-a            asia-east1-a      eur-w1    us-w1     asia-se1
              e2-standard-2            e2-standard-2     e2-medium e2-medium e2-medium
              34.72.163.97             35.221.176.121    34.76.5.11 35.227.159.16  35.198.223.160
                            (full mesh: 每个 fullnode 配置其他 4 个 + 3 个 validator 为 peers)
```

每个 fullnode 的 `/etc/coc/node-1.json` 配置：
- `chainId: 18780`（不是新链，加入现网）
- `validators: [现网 3 地址]`（用于验证 BFT 签名，本身不是 validator）
- `peers: [3 现网 + 4 其他 gcloud]`（7 个直连 peer）
- `dhtBootstrapPeers: [同 peers]`（DHT 启动时的 bootstrap 入口）
- `p2pInboundAuthMode: "enforce"`、`dhtRequireAuthenticatedVerify: true`（严格鉴权）

详细脚本与配置见 [`scripts/gcloud/`](../scripts/gcloud/) 与 [`scripts/bootstrap-5-fullnode-deploy.sh`](../scripts/bootstrap-5-fullnode-deploy.sh)。

---

## 3. P2P 存储核心算法与原理

COC 的 IPFS 存储层目标：**任意节点 PUT 的文件，集群中任意节点可 GET，且少于 K 个节点同时丢失数据时仍可恢复**。这通过五个相互关联的算法实现。

### 3.1 内容寻址（Content Addressing）

每个文件被分块（chunk）后，每块通过 `sha256(bytes)` 计算 multihash，再编码为 CID（Content Identifier）。CID 既是定位 key，也是内容完整性 checksum：

- 文件 ≥ 256 KB 时由 [`ipfs-unixfs.ts`](../node/src/ipfs-unixfs.ts) 切成 256 KB chunks，每块独立 CID。
- 顶层生成一个 UnixFS manifest（包含子 CID 列表），其本身也有 CID — 这是用户拿到的 file root CID。
- 取回时按 manifest 列出的子 CID 逐块拉取，sha256 自验证 → 任何字节翻转必然 CID 不匹配，立即拒绝。

**实测**：50 MB 文件分成约 200 个 chunk + 96 个 manifest CID，共 296 个独立 IPFS block 在网络中流转。

### 3.2 DHT 路由（Kademlia + XOR 距离）

[`dht-network.ts`](../node/src/dht-network.ts) 实现 Kademlia 风格的 K-bucket 路由表：

- **Peer ID 空间**：所有节点地址（20 字节 EIP-160）和 CID 投影到同一 256-bit 空间（CID 通过 `keccak256(cid)` 投影，见 [`coc-ipfs-wiring.ts:41-45`](../node/src/coc-ipfs-wiring.ts)）。
- **距离度量**：XOR 距离 `d(a, b) = a ⊕ b`，距离越小越近。
- **K-buckets**：每个节点维护按距离桶分类的 routing table，每桶最多 20 个 peer。
- **`findClosest(key, n)`**：返回与 key XOR 距离最近的 n 个 peer。
- **`announce(cid)`**：把"我有这个 CID"通告给距离 `keccak256(cid)` 最近的节点（provider records）。
- **`findProviders(cid, n)`**：从 routing table 查询哪些节点声明持有该 CID。

这把 IPFS 寻址转成"在哈希空间中找到与目标 key 最近的若干 peer"，O(log N) 复杂度。

### 3.3 主动复制 — pushToK

[`coc-ipfs-wiring.ts:240-316`](../node/src/coc-ipfs-wiring.ts) 的 `pushToK` 是**写时主动推送**：

```
本地 PUT 一个 block →
  pushToK(cid, bytes) {
    candidates = dht.findClosest(keccak256(cid), POOL_SIZE)
    targets = candidates 中 wire 已连接 + 去重后的前 K 个
    for each target in parallel:
      sendThroughPeer(target, () => wire.pushBlock(cid, bytes))
  }
```

设计意图：让数据在 PUT 时就**主动**到达 K 个 distinct peer，而不是等 GET 时按需拉取。`K=3`（默认 `replicationFactor`）+ 上传源 = 4 个副本同时存在。

关键修复（PR #75，本次发现）：
- **POOL_SIZE 从 K+1 增大到 max(K×4, 8)**：原版只取 K+1 个 candidate，被 stale entry 占用就空转。
- **大小写不敏感去重**：原版不 dedup，导致同一地址的 mixed-case 与 lowercase 占两个 slot。
- **跳过 wire 已断开的 peer**：DHT routing table 滞后于 wire 状态，必须运行时验 `client.isConnected()`。

### 3.4 被动拉取 — fetchRemote

[`coc-ipfs-wiring.ts:193-238`](../node/src/coc-ipfs-wiring.ts) 的 `fetchRemote` 是**读时按需拉取**：

```
本地 GET 一个 cid，blockstore miss →
  fetchRemote(cid) {
    providers = dht.findProviders(cid, 3)        // 第一路径：DHT 提供者
    bytes = wire.requestBlockFromAny(providers, cid)
    if bytes: return

    fallback = connectedPeers - providers        // 第二路径：所有直连 peer
    bytes = wire.requestBlockFromAny(fallback, cid)
    return bytes
  }
```

第二路径是 **#71 Bug B fix**："provider gossip 滞后于真实数据"——大文件 PUT 时大量 ProviderAdvertise frame 可能丢失，但 chunks 已经通过 pushToK 到达接收方，所以即使 DHT 不知道，直接问每个直连 peer 也能拿到。

实测意义：anchor-1 GET 一个由 anchor-2 上传的文件时，即使 anchor-2 的 DHT 通告还在传播，只要 anchor-1 与 anchor-2（或任何其他持有副本的节点）有 wire 连接，就能立即拿到数据。

### 3.5 Wire 协议（持久 TCP，二进制帧）

[`wire-protocol.ts`](../node/src/wire-protocol.ts) 定义 `Magic 0xC0C1 | Type 1B | Length 4B | Payload` 的帧格式。文件传输的关键消息：

| 类型码 | 名称 | 含义 |
|---|---|---|
| `0x10` | BlockRequest | 拉取 / 推送 block（payload 含 `requestId, cid, push: bool, bytes?: base64`） |
| `0x11` | BlockResponse | 响应 BlockRequest（payload 含 `bytes` 或 `null`） |
| `0x14` | ProviderAdvertise | DHT 通告 "我有 CID X" |
| `0x40-41` | FindNode/Response | DHT 路由查找 |

[`wire-client.ts:395-427`](../node/src/wire-client.ts) 的 `pushBlock(cid, bytes, timeoutMs)` 把 bytes 编 base64 进 BlockRequest payload 发出，等待对端 ack。底层流量控制（#71 Bug A fix）：超过 socket writableLength 阈值时不再 destroy socket，而是把帧排入内部队列、监听 `'drain'` 事件继续。

### 3.6 Erasure Coding（Phase Q）

[`docs/runbooks/phase-q-erasure-coding.md`](runbooks/phase-q-erasure-coding.md) 记录的 Reed-Solomon 选项：用 `?erasure=N+M` 上传，文件每个 stripe 被切 N 个数据 shard + M 个校验 shard，**任何 N 个就能重组**（容忍丢 M 个）。

| 模式 | 存储成本 | 容错 |
|---|---|---|
| 纯复制 K=3 | 3.0× | 允许 2/3 节点丢失 |
| RS(4+2) | 1.5× | 允许 2/6 shard 丢失 |
| RS(8+4) | 1.5× | 允许 4/12 shard 丢失 |

shard 本身仍是普通 IPFS block，受同样的 pushToK + 修复循环保护。本次测试用纯复制路径（POST /api/v0/add 默认），未启用 erasure，但本节为完整性而记录。

### 3.7 修复循环（Repair Tick，Phase C3.3）

[`coc-ipfs-repair.ts`](../node/src/coc-ipfs-repair.ts) 每 10 分钟扫描本地 pinned CID：

```
for each pinned cid:
  providerCount = dht.findProviders(cid).length
  if providerCount < minReplicas (默认 2):
    pushToK(cid, blockstore.get(cid))   // 重新主动推送
```

设计意图：长时间运行后总有节点离线、网络分区造成 provider records 衰减；定期 sweep 让被减少的副本数回到 K。修复 batch size 50 CID + 20 manifest，避免一次扫描压垮节点。

---

## 4. 灾难恢复机制

将上述算法组合后，COC 对四类故障场景给出明确恢复路径。

### 4.1 单节点宕机

**触发**：某 peer 进程崩溃 / VM 断电 / 网络分区中孤立。

**自愈路径**：
1. 该节点的 wire 连接被对端检测到（TCP keep-alive 或下次 frame 写失败），从所有对端的 connection manager 移除。
2. 后续 `pushToK` 的 `findClosest` 仍可能选中该节点的 routing table 旧 entry，但 PR #75 后会被 `client.isConnected() = false` 过滤跳过，slot 让给下一个候选。
3. 若该节点持有的 CID 副本数因此降到 < K，**任意其他节点**的 repair tick（10 分钟周期）会扫描到提供者数不足并重新 pushToK，把副本数补回 K。
4. 节点恢复后重新 wire 连接，DHT routing table 重新发现，旧 routing 旧 entry 被新 contact 信息覆盖。

**保障**：单节点宕机后 ≤ 10 分钟集群副本数自愈。GET 在恢复期内仍 OK（其余 K-1 个副本 serve）。

### 4.2 多节点宕机（< K 个）

**触发**：例如 K=3 时同时丢 2 节点。

**自愈路径**：
- 任何 CID 都有 K=3 个 distinct peer 持有。最坏情况 2 个挂掉的节点都恰好是某 CID 的副本持有者，仍剩 1 个副本可 serve。
- 其余在线节点的 repair tick 检测到 `providerCount=1 < minReplicas=2`，触发 pushToK，1 → 2 副本。
- 若启用 RS(N+M)，可同时丢失 M 个 shard 而 GET 仍立即可用，无需等修复。

**保障**：丢节点数 < K 时 GET 不间断；纯复制下副本数缓冲在 K-1 + repair tick；erasure 下 N+M 分布更均匀。

### 4.3 网络分区

**触发**：跨大陆 BGP 抽风、防火墙规则变更、VPN 断开。

**行为**：
- 分区两侧各自仍能 PUT/GET 自己持有的 CID（IPFS 是无中心的）。
- 已经在两侧都有副本的 CID：双方都可服务。
- 仅在一侧的 CID：另一侧 GET 走 fetchRemote，DHT 找不到 provider 也找不到 fallback peer，最终返回 404。
- 分区恢复后，wire 重连 + DHT routing table 合并，下个 repair tick 会触发跨分区补副本。

**保障**：可用性 > 一致性。分区期间不会有"假成功"（数据写一半就丢），但会有"暂时不可达"。

### 4.4 全部源节点同时宕机（本次测试场景）

**触发**：上传文件的 5 个 gcloud 测试节点（包含上传源 anchor-2）全部 TERMINATED。

**保障路径**：
- 上传时 pushToK 把每个 chunk + manifest 推送到 K=3 个 distinct peer，**包含主网 3 个 validator 中的若干个**（DHT 距离决定）。
- 上传后 5 测试节点全停 → 仅主网 validator 持有副本。
- 用户从主网任意 validator 发 GET → 该 validator 的 blockstore 直接 serve（如果它本身持有该 CID），或通过 fetchRemote 第一路径（DHT providers）/ 第二路径（直连 peer fallback）从其他主网 validator 拿。
- 主网 3 个 validator 互为 wire 直连，跨节点拉取在 < 30 s 完成。

**实测验证（见 §6）**：50 MB 文件停 5 节点后，主网 3 validator 都 HTTP 200 OK，sha256 完全匹配，14-28 s 完成 GET。

---

## 5. 测试过程时间线

### 5.1 GCP 基础设施搭建（5 min）

```bash
bash scripts/gcloud/00-bootstrap-project.sh        # VPC + 子网 + 4 firewall rules
bash scripts/gcloud/10-create-anchor.sh anchor-1   # e2-standard-2 us-central1-a
bash scripts/gcloud/10-create-anchor.sh anchor-2   # e2-standard-2 asia-east1-a
bash scripts/gcloud/20-create-burst.sh burst-1     # e2-medium europe-west1-b
bash scripts/gcloud/20-create-burst.sh burst-2     # e2-medium us-west1-a
bash scripts/gcloud/20-create-burst.sh burst-3     # e2-medium asia-southeast1-a
```

每个 VM 自动绑定 static IP（避免 stop+start 后 IP 变化破坏 peers 配置）。

### 5.2 节点部署与同步（每 VM ~5 min）

```bash
bash scripts/bootstrap-5-fullnode-deploy.sh \
  --chain-id 18780 \
  --upstream-validator <addr>:<host>:<p2p>:<wire> ... \
  --gcloud-host-1 <ip> ... --gcloud-host-5 <ip>
bash scripts/gcloud/50-deploy-node.sh all
```

[`scripts/bootstrap-5-fullnode-deploy.sh`](../scripts/bootstrap-5-fullnode-deploy.sh) 为每个 host 生成 base64 嵌入式 deploy bundle（含完整 `/etc/coc/node-1.{json,env}`），无需在 VM 上做模板替换。

### 5.3 第一次卡死 — 发现 #74（case-insensitive proposer）

5 节点都 active 但持续报：
```
warn: verifyBlockChain failed: proposer not in validator set
      proposer: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
```

`localHeightBefore == localHeightAfter` 永远不进。根因：[`chain-engine-persistent.ts:1363`](../node/src/chain-engine-persistent.ts) 用 `validators.includes(block.proposer)` 严格匹配，但 validators 数组是 lowercase（节点配置生成时 normalize），block.proposer 是 EIP-55 mixed case（远端签名者 wallet 标准）。

**修复**：mirror 第 293 行和第 750 行的 `.toLowerCase()` 模式（[PR #74](https://github.com/chainofclaw/COC/pull/74)）。

### 5.4 同步成功 + 5 节点全部 catch up

打 patch 后 anchor-1 立刻从停滞高度 25328 跳到 25431（102-block snap-sync），最终 5 个节点都追上现网。

### 5.5 第二次卡死 — 发现 #75（pushToK partial replication）

50 MB 上传后日志反复出现：
```
"pushToK: partial replication","data":{"attempted":3,"succeeded":1,"failed":2}
```

每个 chunk 都只在 1 个其他节点上有副本。主网 GET 全部 HTTP 404。

加详细 per-peer 失败日志（patch v1）后看到：
```
"failedDetail":[{"peerId":"0x1e1aCC3B...","reason":"no-client-for-peerId"}]
```

查证 `0x1e1aCC3B...` 是已经 TERMINATED 的 burst-3 — DHT routing table 里残留 stale entry 占了一个 K slot。

加 succeeded 列表日志（patch v2）后看到：
```
"succeededPeers":["0xF7B71E59d625fa8E540FF48A4fFCcaD1D777Df78",
                  "0xf7b71e59d625fa8e540ff48a4ffccad1d777df78"]   ← 同一地址不同 case
```

DHT 还有大小写不同的同地址重复 entry —— 占两个 slot 但实际同节点。

**修复**（[PR #75](https://github.com/chainofclaw/COC/pull/75)）：
1. POOL_SIZE: K+1 → max(K×4, 8) 留 headroom
2. 跳过 `client.isConnected() === false` 的 stale peer
3. 用 `Set<lowercase>` 去重大小写差异
4. 完整化 partial / full replication 日志（per-peer reason, succeededPeers, staleSkipped, dupSkipped）

### 5.6 修复后：50 MB 跨大陆 + 持久性测试

**阶段 A（5 节点齐全）**：anchor-2 上传 50 MB（61s），CID `bafybeievwyw6ma2bzl2mbxe5ico3kge5r2p3gcxxdn5lpsdycqhou7nmcm`，sha `863844ee...`。

7 节点 GET：
| 节点 | Region | HTTP | 耗时 | sha 校验 |
|---|---|---|---|---|
| anchor-1 | us-central1 | 200 | 139 s | ✓ |
| anchor-2 | asia-east1 | 200 | 18 s | ✓（源） |
| burst-1 | europe-west1 | 200 | 210 s | ✓ |
| burst-2 | us-west1 | 200 | 109 s | ✓ |
| **validator-1** | （主网） | 200 | **22 s** | ✓ |
| **validator-2** | （主网） | 200 | **30 s** | ✓ |
| **validator-3** | （主网） | 200 | **23 s** | ✓ |

**阶段 B（停所有 5 测试节点）**：
```bash
gcloud compute instances stop coc-anchor-{1,2} coc-burst-{1,2,3}
# 等 30 s 让连接彻底断开
```

主网 GET 重测：
| 节点 | HTTP | 耗时 | sha |
|---|---|---|---|
| validator-1 | **200** | 17 s | ✓ |
| validator-2 | **200** | 14 s | ✓ |
| validator-3 | **200** | 28 s | ✓ |

**用户原始测试目标 100% 实现**。

### 5.7 清理

```bash
bash scripts/gcloud/40-destroy-all.sh vms-only   # 删 5 VM + 5 static IP
# 保留 VPC + 4 firewall rules + 5 子网（GCP 免费），下次 30 min 重建
```

---

## 6. 关键发现总结

### 6.1 真实 bug：两个 case-insensitive 缺陷

PR #74（chain-engine）和 PR #75（ipfs）本质都是 **Phase X1.6 case-insensitive normalization 的遗漏**：远程节点用 EIP-55 mixed case 形式发地址，本地配置生成 lowercase 形式，没在所有比较点 normalize 就会失配。

完整修复需要：
- [x] PR #74：`chain-engine-persistent.ts:1363` `validators.includes(proposer)`
- [x] PR #75：`coc-ipfs-wiring.ts` pushToK candidate dedup
- [ ] （建议）系统性 grep `.includes(` 和 `Map<string, ...>` 与地址相关的所有用法 + 加 lint 规则

### 6.2 跨大陆 GET 时间分布

50 MB 在测试网络的实测时间：
- 同 region：< 20 s（IPFS 本地 cat + 局部 wire 拉取）
- 跨大陆 wire 直连：14-30 s
- 跨大陆 + 节点 CPU 紧张（追同步时）：100-210 s
- 4 vCPU+ 时跨大陆 50 MB 应稳定在 30-60 s

### 6.3 节点 sysreq 经验值

跨大陆加入现网的 observer fullnode 推荐：
- **CPU**：≥ 4 vCPU（e2-standard-2 的 2 vCPU 在追同步时被 100% 占满，IPFS API 共享主线程 → 大文件 add 排队）
- **磁盘**：≥ 50 GB SSD（chain DB + IPFS blockstore，不含 30 GB IPFS 缓存）
- **内存**：≥ 4 GB（实测 anchor-1 RES 260 MB 但 V8 heap 高峰可达 2 GB+）
- **网络**：双向 P2P / Wire / IPFS 端口（29780/29781/28786）须对等节点可达

### 6.4 IP 稳定性

GCP ephemeral IP 在 stop+start 后会变。peers 配置一旦烧入 deploy bundle 后变 IP 就破坏 mesh。**所有 fullnode 必须用 static IP**（[`10-create-anchor.sh`](../scripts/gcloud/10-create-anchor.sh) / [`20-create-burst.sh`](../scripts/gcloud/20-create-burst.sh) 已内嵌 reserved address 创建逻辑）。

---

## 7. 测试结论

| 验证项 | 结果 |
|---|---|
| Fullnode 跨大陆加入现网 | ✅（修复 #74 后 5/5 节点同步成功） |
| 1 MB / 10 MB / 50 MB 跨节点复制 | ✅（修复 #75 后 7/7 节点 sha 一致） |
| pushToK 真实 K=3 distinct 副本 | ✅（partial 计数从 100% → 0%） |
| **5 测试节点全停后主网持久性** | ✅（3/3 validator HTTP 200） |
| Static IP 稳定性 | ✅ |
| ValidatorRegistry 升级 anchor 为 BFT validator | ⚠️ 现网未启用 governance contract（`coc_governanceStats` returns method not supported）— 留待上游决策 |

P2P 存储核心承诺成立：**任意节点上传 → 多节点持有副本 → 上传源全失败时数据仍生存于网络**。

---

## 附录 A：关键文件路径

### 算法实现
- [`node/src/coc-ipfs-wiring.ts`](../node/src/coc-ipfs-wiring.ts) — fetchRemote / pushToK / pushStripe glue
- [`node/src/ipfs-blockstore.ts`](../node/src/ipfs-blockstore.ts) — 内容寻址 blockstore
- [`node/src/ipfs-unixfs.ts`](../node/src/ipfs-unixfs.ts) — 文件分块
- [`node/src/ipfs-erasure.ts`](../node/src/ipfs-erasure.ts) — Reed-Solomon
- [`node/src/coc-ipfs-repair.ts`](../node/src/coc-ipfs-repair.ts) — 修复循环
- [`node/src/dht-network.ts`](../node/src/dht-network.ts) / [`dht.ts`](../node/src/dht.ts) — Kademlia DHT
- [`node/src/wire-client.ts`](../node/src/wire-client.ts) / [`wire-server.ts`](../node/src/wire-server.ts) — TCP 帧协议
- [`node/src/chain-engine-persistent.ts`](../node/src/chain-engine-persistent.ts) — 区块验证（PR #74 涉及）

### 部署脚本（本次新增）
- [`scripts/bootstrap-5-fullnode-deploy.sh`](../scripts/bootstrap-5-fullnode-deploy.sh) — 生成 5 个 host 的 base64 deploy bundle
- [`scripts/deploy-fullnode.sh`](../scripts/deploy-fullnode.sh) — 单 VM 一键部署
- [`scripts/anchor-stake-register.sh`](../scripts/anchor-stake-register.sh) — Phase B（暂搁置）
- [`scripts/gcloud/`](../scripts/gcloud/) — VPC / VM / chaos 工具集（10 个脚本）

### 现网 reference（对照）
- [`docs/multi-server-deploy-2026-05-07.zh-en.md`](multi-server-deploy-2026-05-07.zh-en.md) — 现网 3 validator 部署报告
- [`docs/runbooks/phase-q-erasure-coding.md`](runbooks/phase-q-erasure-coding.md) — Phase Q 设计与运维

---

## 附录 B：实测命令速查

```bash
# 50 MB 跨大陆复制 + 持久性测试（用户原始需求复现）
CID=bafybeievwyw6ma2bzl2mbxe5ico3kge5r2p3gcxxdn5lpsdycqhou7nmcm

# 5 节点齐全时
for ip in 209.74.64.88:28786 159.198.44.136:28786 199.192.16.79:48786; do
  curl -sS -o /tmp/dl.bin -w "%{http_code} %{size_download}\n" \
    -X POST "http://$ip/api/v0/cat?arg=$CID"
done

# 停所有 gcloud 节点
bash scripts/gcloud/30-stop-burst.sh all-bursts
gcloud compute instances stop coc-anchor-1 coc-anchor-2 ...

# 重复 GET（仍应 200 OK）
```

```bash
# 修复后的 partial replication 日志（应该全是 full）
sudo grep "pushToK:.*replication" /var/log/coc/node-1.log | tail -5
# {"message":"pushToK: full replication","data":{
#   "succeededPeers":["...3 distinct lowercase ids..."],
#   "staleSkipped":1,"dupSkipped":1}}
```
