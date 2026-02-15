# COC 系统架构（中文）

## 概述
COC 是一个 EVM 兼容的区块链原型，结合轻量执行层与 PoSe（Proof-of-Service）结算流程。系统由链上合约、链下服务和节点运行时组成。

## 分层架构
1. **执行层（EVM）**
   - 执行交易，通过 `PersistentStateManager` 持久化 EVM 状态。
   - 通过 JSON-RPC 提供钱包与工具访问。

2. **共识与链层**
   - 通过权益加权的出块者选择产生区块（支持轮转降级）。
   - BFT-lite 三阶段提交（propose/prepare/commit）+ 权益加权法定人数。
   - GHOST 式分叉选择规则实现确定性链选择。
   - BFT 协调器桥接共识引擎与 P2P 层。
   - 跟踪最终性深度并做基础链校验。
   - 通过快照持久化实现重启恢复。
   - ValidatorGovernance 实现提案制验证者集合管理。

3. **P2P 网络层**
   - 采用 HTTP gossip 传播交易、区块、BFT 消息与 pubsub 消息。
   - 二进制线协议帧编解码，含 TCP 传输层（Wire 服务端/客户端）。
   - Kademlia DHT 路由表和网络层（引导、迭代查找、定期刷新）。
   - 通过链快照同步进行对等节点对齐，含 EVM 状态快照端点 `/p2p/state-snapshot`。
   - 节点持久化存储与 DNS 种子发现。
   - 基于声誉的节点评分与自动封禁/解封。

4. **存储层（兼容 IPFS）**
   - Blockstore + UnixFS 文件布局。
   - HTTP API 子集与 `/ipfs/<cid>` 网关 + tar 归档支持。
   - MFS（可变文件系统）提供 POSIX 风格文件操作。
   - Pubsub 基于主题的消息发布/订阅与 P2P 转发。
   - EVM 状态快照导出/导入，支持快速同步。

5. **PoSe 服务层**
   - 链下挑战/验证/聚合流水线。
   - 链上 PoSeManager 合约用于注册、批次提交、争议与惩罚。

6. **NodeOps 运行时**
   - `coc-node`: 提供 PoSe challenge/receipt HTTP 端点。
   - `coc-agent`: 生成挑战、聚合批次、计算奖励。
   - `coc-relayer`: Epoch 结算与可选争议/惩罚自动化。

7. **节点运维层**
   - 基于 YAML 的策略引擎（policy-engine）。
   - 策略加载器与验证（policy-loader）。
   - Agent 生命周期钩子（onChallengeIssued、onReceiptVerified、onBatchSubmitted）。

8. **区块链浏览器**
   - Next.js 15 + React 19 Web 应用。
   - 区块、交易、地址查询与详情展示。
   - 通过 JSON-RPC 获取实时链数据。
   - Tailwind CSS 响应式 UI。

9. **安全层（Phase 33）**
   - 节点身份认证：通过 `NodeSigner`/`SignatureVerifier` 对 Wire 握手签名。
   - BFT 消息强制签名与验证（拒绝无签名/伪造投票）。
   - DHT 防投毒：节点加入路由表前先进行 TCP 连接探测验证。
   - Wire 服务端每 IP 连接限制（最多 5 个）。
   - IPFS 上传大小限制（10MB）和 MFS 路径遍历防护。
   - 区块时间戳验证（父块排序 + 未来偏移限制）。
   - 节点指数 ban（ban 期间不衰减，最长 24h）。
   - WebSocket 空闲超时（1h）和开发账户门控。
   - RPC/IPFS/PoSe 共享速率限制器。
   - P2P HTTP 写请求签名认证信封（`_auth`），含时间窗与 nonce 防重放。
   - 入站认证灰度模式：`off` / `monitor` / `enforce`，支持平滑迁移。
   - 状态快照 stateRoot 导入后校验。
   - PoSeManager ecrecover v 值校验。

## 核心组件
- **节点运行时**：`COC/node/src/*`
- **PoSe 合约**：`COC/contracts/settlement/*`
- **PoSe 服务**：`COC/services/*`
- **运行时服务**：`COC/runtime/*`
- **节点运维**：`COC/nodeops/*`
- **钱包 CLI**：`COC/wallet/bin/coc-wallet.js`
- **区块链浏览器**：`COC/explorer/src/*`

## 数据流（高层）
1. 钱包向 JSON-RPC 发送签名交易。
2. 节点 mempool 按 nonce/gas 排序并广播交易。
3. 出块者打包交易并通过 EVM 执行。
4. 区块 gossip 给其他节点并被验证接受。
5. 存储接口写入文件并生成 CID，用于 PoSe 存储挑战。
6. PoSe agent 发起挑战、验证回执、聚合批次。
7. 聚合批次提交到 PoSeManager，relayer 触发最终结算。

## 当前边界
- 共识采用 ValidatorGovernance 权益加权出块 + 轮转降级。BFT 协调器已集成到 ConsensusEngine（通过 `enableBft` 可选启用）：在 `tryPropose()` 中启动 BFT 轮次，失败时降级为直接广播。BFT 消息通过双传输层（HTTP gossip + Wire 协议 TCP）广播。分叉选择规则已集成到 `trySync()` 实现确定性链选择。等价检测追踪双重投票以生成惩罚证据。性能指标（出块时间、同步统计、运行时间）通过 `getMetrics()` 导出。
- P2P 以 HTTP gossip 为主要传输 + 节点持久化 + DNS 种子发现。Wire 服务端/客户端提供可选 TCP 传输（`enableWireProtocol`），支持 FIND_NODE 请求/响应用于 DHT 查询。Wire 协议含 Block/Tx 去重（BoundedSet: seenTx 50K, seenBlocks 10K）及跨协议中继（Wire→HTTP 通过 onTxRelay/onBlockRelay 回调）。HTTP gossip 写路径支持签名认证信封（`_auth`）校验，具备可配置灰度模式（`off`/`monitor`/`enforce`）、时间偏移限制与 nonce 防重放。DHT 网络层提供可选迭代节点发现（`enableDht`），含定期节点公告；FIND_NODE 使用 wireClientByPeerId 映射（O(1) 查找），回退到 wireClients 扫描和本地路由表。区块和交易通过双通道（HTTP+TCP）并行传播，支持发送方排除（excludeNodeId）。每个 peer 使用独立 wire port（来自 dhtBootstrapPeers 配置）。Wire 连接管理器处理出站节点生命周期。状态快照端点可用于快速同步。
- EVM 状态通过 PersistentStateManager + LevelDB 跨重启持久化。快照同步提供者已集成到 ConsensusEngine（通过 `enableSnapSync` 可选启用）。
- IPFS 支持核心 HTTP API、网关、MFS、Pubsub 和 tar 归档 `get`。
- RPC 提供 `coc_getNetworkStats`（P2P/Wire/DHT/BFT 统计）和 `coc_getBftStatus`（BFT 轮次状态含等价检测计数）。
- 安全加固（Phase 33）：Wire 握手节点身份认证（NodeSigner/SignatureVerifier）、BFT 强制消息签名、DHT 节点验证（加入路由表前 TCP 探测）、每 IP Wire 连接限制（最多 5）、IPFS 上传大小限制（10MB）、MFS 路径遍历防护、区块时间戳验证、节点指数 ban（最长 24h）、WebSocket 空闲超时（1h）、开发账户需 `COC_DEV_ACCOUNTS=1`、默认绑定 `127.0.0.1`、共享速率限制器（RPC 200/min, IPFS 100/min, PoSe 60/min）、HTTP gossip 签名认证信封（`off`/`monitor`/`enforce` 灰度模式 + 防重放）、治理自投票移除、PoSeManager ecrecover v 值校验、状态快照 stateRoot 校验。
- 所有高级功能（BFT、Wire、DHT、SnapSync）在多节点 devnet 中通过 `start-devnet.sh` 默认启用。单节点 devnet 自动禁用 BFT（需要 >= 3 验证者）。DHT 迭代查找使用 Wire 协议 FIND_NODE（可用时），回退到本地路由表。
