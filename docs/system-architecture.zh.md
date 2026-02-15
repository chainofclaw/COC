# COC 系统架构（中文）

## 概述
COC 是一个 EVM 兼容的区块链原型，结合轻量执行层与 PoSe（Proof-of-Service）结算流程。系统由链上合约、链下服务和节点运行时组成。

## 分层架构
1. **执行层（EVM）**
   - 执行交易，通过 `PersistentStateManager` 持久化 EVM 状态。
   - 通过 JSON-RPC 提供钱包与工具访问。

2. **共识与链层**
   - 通过权益加权的出块者选择产生区块（支持轮转降级）。
   - 跟踪最终性深度并做基础链校验。
   - 通过快照持久化实现重启恢复。
   - ValidatorGovernance 实现提案制验证者集合管理。

3. **P2P 网络层**
   - 采用 HTTP gossip 传播交易、区块与 pubsub 消息。
   - 通过链快照同步进行对等节点对齐。
   - 节点持久化存储与 DNS 种子发现。
   - 基于声誉的节点评分与自动封禁/解封。

4. **存储层（兼容 IPFS）**
   - Blockstore + UnixFS 文件布局。
   - HTTP API 子集与 `/ipfs/<cid>` 网关。
   - MFS（可变文件系统）提供 POSIX 风格文件操作。
   - Pubsub 基于主题的消息发布/订阅与 P2P 转发。

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
- 共识采用 ValidatorGovernance 权益加权出块（尚未实现 BFT 最终性）。
- P2P 采用 HTTP gossip + 节点持久化 + DNS 种子发现（尚未实现 DHT 或二进制线协议）。
- EVM 状态通过 PersistentStateManager + LevelDB 跨重启持久化。
- IPFS 支持核心 HTTP API、网关、MFS 和 Pubsub（尚未支持 tar archive `get`）。
