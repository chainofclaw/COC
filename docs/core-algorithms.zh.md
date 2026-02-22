# COC 核心算法（中文）

## 1) 出块者轮转
**目标**：按区块高度确定出块者。

算法：
- 维护静态验证者列表 `V`。
- 对高度 `h`，出块者索引 = `(h - 1) mod |V|`。
- 仅该出块者可构造并广播区块 `h`。

代码：
- `COC/node/src/chain-engine.ts`（`expectedProposer`）

## 2) 区块哈希
**目标**：确定性区块标识。

算法：
- 对 `height | parentHash | proposer | timestamp | txHashes` 做拼接。
- `hash = keccak256(payload)`。

代码：
- `COC/node/src/hash.ts`

## 3) Mempool 选择策略
**目标**：确定性选取区块交易。

算法：
- 过滤低于 `minGasPrice` 的交易。
- 按 `gasPrice desc`，再 `nonce asc` 排序。
- 按地址 nonce 连续性约束。

代码：
- `COC/node/src/mempool.ts`

## 4) 最终性深度
**目标**：在深度 `D` 后标记区块 finalized。

算法：
- 对 tip 高度 `H`，若 `H >= b.number + D`，则 `b.finalized = true`。

代码：
- `COC/node/src/chain-engine.ts`（`updateFinalityFlags`）

## 5) P2P 快照同步
**目标**：多节点链状态收敛。

算法：
- 周期性拉取 peer 的链快照。
- 若对方高度更高，则采用其快照重建本地链。

代码：
- `COC/node/src/p2p.ts`，`COC/node/src/consensus.ts`

## 6) PoSe 挑战生成
**目标**：按 epoch 生成可验证挑战。

算法：
- 每节点每 epoch 按类型限额。
- 构造含 nonce 与 epoch seed 的挑战。
- 对挑战摘要签名。

代码：
- `COC/services/challenger/*`

## 7) 回执验证
**目标**：验证挑战响应。

算法：
- nonce 防重放。
- 校验挑战者/节点签名。
- 检查超时与响应体哈希。
- 按类型执行 U/S/R 校验。

代码：
- `COC/services/verifier/receipt-verifier.ts`

## 8) 批次聚合
**目标**：聚合回执并提交链上。

算法：
- 对回执哈希生成叶子。
- 生成 Merkle root。
- 采样叶子与 proof。
- 生成 summaryHash（epoch + root + sample commitment）。

代码：
- `COC/services/aggregator/batch-aggregator.ts`

## 9) 奖励评分
**目标**：按服务指标分配 epoch 奖励。

算法：
- 按 U/S/R 桶拆分奖励。
- 应用阈值与存储递减。
- 软上限与溢出再分配。

代码：
- `COC/services/verifier/scoring.ts`

## 10) 存储证明（兼容 IPFS）
**目标**：用 Merkle 路径证明文件分片可用性。

算法：
- 文件按固定大小切分（默认 256 KiB）。
- 对每个分片计算 `leafHash = keccak256(chunkBytes)`。
- 基于 `leafHash[]` 构建 Merkle 树。
- 对挑战 `(cid, chunkIndex)` 返回 `leafHash`、`merklePath`、`merkleRoot`。
- 验证方基于 `(leafHash, merklePath, chunkIndex)` 复算 root 并比对。

代码：
- `COC/node/src/ipfs-unixfs.ts`
- `COC/node/src/ipfs-merkle.ts`
- `COC/runtime/coc-node.ts`

## 11) 权益加权出块者选择
**目标**：按验证者权益确定性选择出块者。

算法：
- 从 `ValidatorGovernance` 获取活跃验证者，按 ID 字典序排序。
- 计算 `totalStake = sum(v.stake for v in validators)`。
- 计算 `seed = blockHeight mod totalStake`。
- 遍历排序后的验证者累加权益：第一个使 `cumulative > seed` 的验证者为出块者。
- 确定性：相同高度总是产生相同出块者。
- 治理未启用或无活跃验证者时降级为轮转制。

代码：
- `COC/node/src/chain-engine-persistent.ts`（`stakeWeightedProposer`）

## 12) EIP-1559 动态 Base Fee
**目标**：根据 Gas 利用率按区块调整 base fee。

算法：
- 维持 50% 区块 Gas 上限的目标利用率。
- 实际 Gas > 目标：base fee 最多上调 12.5%。
- 实际 Gas < 目标：base fee 最多下调 12.5%。
- 最低 1 gwei（永不降至零）。
- `changeRatio = (gasUsed - targetGas) / targetGas`。
- `newBaseFee = parentBaseFee * (1 + changeRatio * 0.125)`。

代码：
- `COC/node/src/base-fee.ts`

## 13) 共识恢复状态机
**目标**：区块生产或同步失败时优雅降级并恢复。

算法：
- 状态：`healthy` → `degraded` → `recovering` → `healthy`。
- 跟踪 `proposeFailures` 和 `syncFailures`（连续计数）。
- 连续 5 次出块失败 → 进入 `degraded` 模式（停止出块）。
- 降级模式下同步成功 → 进入 `recovering`（允许一次出块尝试）。
- 恢复出块成功 → 回到 `healthy`。
- 恢复出块失败 → 回到 `degraded`。
- 恢复冷却：两次恢复尝试间隔 30 秒。

代码：
- `COC/node/src/consensus.ts`

## 14) BFT-lite 共识轮次
**目标**：三阶段提交 + 权益加权法定人数实现区块最终性。

算法：
- 阶段：`propose` → `prepare` → `commit` → `finalized`。
- 法定人数阈值：`floor(2/3 * totalStake) + 1`。
- 出块者广播区块，验证者发送 prepare 投票。
- prepare 达到法定人数后进入 commit 阶段。
- commit 达到法定人数后区块 BFT 最终化。
- 超时处理：轮次在 prepare + commit 超时后失败。

代码：
- `COC/node/src/bft.ts`（轮次状态机、法定人数计算）
- `COC/node/src/bft-coordinator.ts`（生命周期管理）

## 15) GHOST 式分叉选择
**目标**：在竞争分叉中确定性选择链。

算法：
- 优先级 1：BFT 最终化链总是获胜。
- 优先级 2：较长链优先。
- 优先级 3：更高累积权益权重。
- 优先级 4：较低区块哈希（确定性决胜）。
- `shouldSwitchFork()` 判断同步是否应采用远端链。

代码：
- `COC/node/src/fork-choice.ts`

## 16) Kademlia DHT 路由
**目标**：基于 XOR 距离路由的去中心化节点发现。

算法：
- 节点 ID 为 256 位值；距离 = XOR(nodeA, nodeB)。
- 路由表：256 个 K-Bucket（每个最多 K=20 个节点）。
- Bucket 索引 = XOR 距离最高位位置。
- `findClosest(target, K)`：返回按 XOR 距离最近的 K 个节点。
- LRU 淘汰：最近活跃节点保留在 bucket 尾部。

代码：
- `COC/node/src/dht.ts`

## 17) 二进制线协议
**目标**：高效二进制帧格式用于 P2P 通信。

算法：
- 帧：`[Magic 2B: 0xC0C1] [Type 1B] [Length 4B 大端] [Payload NB]`。
- 最大载荷：16 MiB。
- `FrameDecoder`：TCP 流式累积解码器。
- 消息类型：Handshake, Block, Transaction, BFT, Ping/Pong。

代码：
- `COC/node/src/wire-protocol.ts`

## 18) DHT 网络迭代查找
**目标**：通过 DHT 网络迭代查询发现节点。

算法：
- 从本地路由表获取 K 个最近节点作为初始集合。
- 选择 ALPHA (3) 个未查询过的最近候选节点。
- 并行查询每个候选节点获取其最近节点列表。
- 将新发现的节点加入路由表和候选集合。
- 重复直到无新节点发现（收敛）。
- 返回路由表中最终 K 个最近节点。

代码：
- `COC/node/src/dht-network.ts`（`iterativeLookup`）

## 19) Wire Server/Client TCP 握手
**目标**：在节点间建立经验证的 TCP 连接。

算法：
- 服务端监听配置端口并接受连接。
- 连接建立时服务端发送 Handshake 帧（nodeId, chainId, height）。
- 客户端在连接时发送 Handshake 帧。
- 接收方验证 chainId — 不匹配则断开连接。
- 验证成功后标记连接为握手完成。
- 握手后：将 Block、Transaction、BFT 帧分发到对应处理器。
- 客户端断线后使用指数退避重连（初始 1s，上限 30s，每次翻倍）。

代码：
- `COC/node/src/wire-server.ts`
- `COC/node/src/wire-client.ts`

## 20) 快照同步状态传输
**目标**：从 peer 的 EVM 快照快速同步节点状态。

算法：
- 同步节点通过 `/p2p/state-snapshot` 向 peer 请求状态快照。
- Peer 导出完整 EVM 状态：账户、存储槽、合约代码。
- 接收方验证快照结构（`validateSnapshot()`）。
- 将账户、存储和代码导入本地状态树。
- 设置本地 state root 以匹配快照。
- 从快照的区块高度恢复共识。

代码：
- `COC/node/src/state-snapshot.ts`（`exportStateSnapshot`、`importStateSnapshot`）
- `COC/node/src/consensus.ts`（`SnapSyncProvider` 接口）
- `COC/node/src/p2p.ts`（`/p2p/state-snapshot` 端点）

## 21) BFT 等价检测
**目标**：检测验证者双重投票以生成惩罚证据。

算法：
- 维护三层映射：`高度 → 阶段 → 验证者ID → 区块哈希`。
- 每次投票（prepare/commit）时，检查该验证者在相同高度+阶段是否已为不同区块哈希投票。
- 发现冲突则生成 `EquivocationEvidence`，包含两个冲突的区块哈希。
- 裁剪旧高度以限制内存（可配置 `maxTrackedHeights`，默认 100）。
- 裁剪在记录投票之后执行（而非之前），避免竞态条件。

代码：
- `COC/node/src/bft.ts`（`EquivocationDetector`）
- `COC/node/src/bft-coordinator.ts`（集成）

## 22) 双传输层区块/交易传播
**目标**：通过并行传输路径最大化区块和交易传递可靠性。

算法：
- 出块时：同时通过 HTTP gossip（主）和 Wire 协议 TCP（辅）广播。
- 通过 HTTP 接收交易时：中继至所有 wire 连接的节点（`broadcastFrame`）。
- 通过 Wire 接收交易/区块时：通过 `onTxRelay`/`onBlockRelay` 回调中继至 HTTP gossip 层。
- 两条传输路径独立运行 — 一条失败不影响另一条。
- Wire 广播使用延迟绑定模式：函数引用在 wire 服务器初始化后设置。
- Wire 层通过 `BoundedSet`（seenTx 50K, seenBlocks 10K）去重，防止重复处理。
- 跨协议中继安全：P2P `receiveTx`/`receiveBlock` 内部有去重，Wire 层也独立去重。
- `broadcastFrame` 支持 `excludeNodeId` 参数，跳过原始发送方。
- BFT 消息也通过双传输层（HTTP gossip + Wire 协议 TCP）广播。

代码：
- `COC/node/src/consensus.ts`（`broadcastBlock` 含 wireBroadcast 回调）
- `COC/node/src/index.ts`（`wireBroadcastFn`、`wireTxRelayFn`、`wireBftBroadcastFn`）
- `COC/node/src/wire-server.ts`（去重、中继回调、excludeNodeId）

## 23) 共识指标收集
**目标**：追踪出块和同步性能以支持可观测性。

算法：
- 每次 `tryPropose()`：记录开始时间，递增 `blocksProposed` 或 `proposeFailed`，累积 `totalProposeMs`。
- 每次 `trySync()`：记录开始时间，递增 `syncAttempts`，追踪 `syncAdoptions` 和 `blocksAdopted`。
- 快照同步成功时：递增 `snapSyncs`。
- `getMetrics()` 返回计算的平均值（总时间/次数）、最近操作时间和运行时间。
- `startedAtMs` 在 `start()` 中设置用于计算运行时间。

代码：
- `COC/node/src/consensus.ts`（`ConsensusMetrics` 接口、`getMetrics()`）

## 24) Wire 协议去重
**目标**：在 Wire 协议层防止重复 Block/Tx 处理。

算法：
- 维护 `seenTx = BoundedSet<Hex>(50_000)` 和 `seenBlocks = BoundedSet<Hex>(10_000)`。
- 收到 Block 帧时：检查 `seenBlocks.has(block.hash)` — 已见则静默丢弃，否则添加并处理。
- 收到 Transaction 帧时：检查 `seenTx.has(rawTx)` — 已见则静默丢弃，否则添加并处理。
- BoundedSet 容量满时淘汰最旧条目（FIFO）。
- 统计通过 `getStats()` 暴露：`seenTxSize`、`seenBlocksSize`。

代码：
- `COC/node/src/wire-server.ts`（`seenTx`、`seenBlocks`、`handleFrame`）

## 25) 跨协议中继
**目标**：桥接 Wire 协议与 HTTP gossip 实现全网覆盖。

算法：
- Wire→HTTP：Wire 层去重 + 处理后，调用 `onTxRelay(rawTx)` / `onBlockRelay(block)` 注入 HTTP gossip 层。
- HTTP→Wire：现有 `wireTxRelayFn` / `wireBroadcastFn` 从 HTTP 中继至 wire 连接的节点。
- 中继错误为非致命（try-catch，忽略失败）。
- 无循环中继：两层各自独立去重（Wire BoundedSet + P2P `seenTx.has()`）。

代码：
- `COC/node/src/wire-server.ts`（`onTxRelay`、`onBlockRelay` 配置回调）
- `COC/node/src/index.ts`（将中继回调接入 P2P `receiveTx`/`receiveBlock`）

## 26) DHT Wire 客户端优先查找
**目标**：高效的 wire 客户端发现用于 DHT FIND_NODE 查询。

算法：
- 优先级 1：`wireClientByPeerId` Map — O(1) 直接按 peer ID 查找。
- 优先级 2：扫描 `wireClients` 数组按 `getRemoteNodeId()` 匹配（向后兼容）。
- 优先级 3：回退到本地路由表 `findClosest(targetId, ALPHA)`。
- `wireClientByPeerId` 在启动时构建：映射 `config.peers[i].id → wireClients[i]`。
- 每个 peer 的 wire port 从 `dhtBootstrapPeers` 配置解析，而非使用本地 `wirePort`。

代码：
- `COC/node/src/dht-network.ts`（`findNode` 三级优先查找）
- `COC/node/src/index.ts`（`wireClientByPeerId` 构建、`peerWirePortMap`）

## 27) DHT 节点验证
**目标**：通过验证节点可达性防止 DHT 路由表投毒。

算法：
- 通过迭代查找发现新节点时，先验证可达性再加入路由表。
- 优先级 1：检查该节点是否有活跃的 wire 客户端连接（`wireClientByPeerId` 或 `wireClients` 扫描）— 已通过 wire 握手验证。
- 优先级 2：认证式 wire 握手（`verifyPeerByHandshake`）— 临时创建 WireClient，交换签名握手消息，验证身份后断开。
- 当 `requireAuthenticatedVerify=true`（默认）时：拒绝无法验证的节点（无 TCP 探测回退）。
- 当 `requireAuthenticatedVerify=false` 时：回退到轻量级 TCP 连接探测，3 秒超时。
- 验证成功 = 节点可达且身份确认 → 加入路由表并通知发现回调。
- 超时、连接拒绝或身份不匹配 → 丢弃节点（不加入路由表）。
- 加载时过滤过期节点：`lastSeenMs` 超过 24 小时的节点被排除。

代码：
- `COC/node/src/dht-network.ts`（`verifyPeer`、`iterativeLookup`）

## 28) 指数节点封禁
**目标**：对异常节点实施递增的封禁时间。

算法：
- 每个 `PeerScore` 维护 `banCount` 字段（封禁次数）。
- 触发封禁（无效数据、反复失败）时：递增 `banCount`。
- 封禁时长：`baseBanMs * 2^min(banCount - 1, 10)`，上限 24 小时。
- 封禁期间：`applyDecay()` 跳过该节点（不恢复评分）。
- 封禁到期后：节点可重新评估，但下次违规封禁时长翻倍。

代码：
- `COC/node/src/peer-scoring.ts`（`exponentialBanMs`、`recordInvalidData`、`applyDecay`）

## 29) 节点身份握手
**目标**：在 Wire 协议 TCP 握手中通过密码学验证节点身份。

算法：
- 每个节点拥有持久化私钥（`nodePrivateKey`，来自 `COC_NODE_KEY` 环境变量 / `dataDir/node-key`）。
- Wire 握手时，发送方签名 `wire:handshake:<nodeId>:<nonce>`（使用 `NodeSigner.sign()`）。
- 接收方通过 `SignatureVerifier.recoverAddress()` 验证签名。
- 恢复的地址必须与声称的 `nodeId` 匹配 — 不匹配则断开连接并记录 `recordInvalidData()`。
- Nonce 防止重放攻击（每次握手唯一）。
- 运行时默认强制签名验证（`verifier` 始终启用）；无签名的握手请求将被拒绝并断开连接。

代码：
- `COC/node/src/wire-server.ts`（握手验证）
- `COC/node/src/wire-client.ts`（握手签名）
- `COC/node/src/config.ts`（`resolveNodeKey`）
- `COC/node/src/crypto/signer.ts`（`NodeSigner`、`SignatureVerifier`）

## 30) BFT 消息签名
**目标**：通过强制密码学签名防止 BFT 投票伪造。

算法：
- `BftMessage.signature` 为必填字段（类型 `Hex`，不再可选）。
- 规范消息格式：`bft:<type>:<height>:<blockHash>`（确定性字符串）。
- 发送方通过 `NodeSigner.sign()` 签名规范消息。
- 接收方通过 `SignatureVerifier.verifyNodeSig(canonical, signature, validatorAddress)` 验证。
- 签名缺失或无效的消息被静默丢弃。
- 仅接受来自已知活跃验证者的消息。

代码：
- `COC/node/src/bft.ts`（`BftMessage.signature` 必填）
- `COC/node/src/bft-coordinator.ts`（`signMessage`、`bftCanonicalMessage`、`handlePrepare`/`handleCommit` 中的验证）

## 31) P2P HTTP 认证信封
**目标**：为 HTTP gossip 写流量提供节点级认证，并支持平滑灰度上线，避免一次性网络分裂。

算法：
- 发送方签名规范消息：`p2p:<path>:<senderId>:<timestampMs>:<nonce>:<payloadHash>`，并附加 `_auth` 字段。
- `payloadHash` 使用确定性 JSON 序列化后做 keccak256。
- 接收方依次校验：
  - 信封字段完整性（`senderId/timestampMs/nonce/signature`）。
  - 时间戳是否在 `p2pAuthMaxClockSkewMs` 允许窗口内。
  - 重放键（`senderId:nonce`）是否已出现。
  - 签名是否能恢复并匹配声明的发送地址。
- 灰度模式：
  - `off`：不校验。
  - `monitor`：校验并记账，不拒绝请求。
  - `enforce`：无签名或签名无效时返回 HTTP 401。
- 节点暴露安全观测计数：
  - `authAcceptedRequests`、`authMissingRequests`、`authInvalidRequests`、`authRejectedRequests`、`rateLimitedRequests`。

代码：
- `COC/node/src/p2p.ts`（`buildSignedP2PPayload`、`verifySignedP2PPayload`、灰度处理）
- `COC/node/src/config.ts`（`p2pInboundAuthMode`、`p2pAuthMaxClockSkewMs`）
