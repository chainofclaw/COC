# COC 系统架构（中文）

## 概述
COC 是一个 EVM 兼容的区块链原型，结合轻量执行层与 PoSe（Proof-of-Service）结算流程。系统由链上合约、链下服务和节点运行时组成。

## 分层架构
1. **执行层（EVM）**
   - 执行交易并维护内存状态。
   - 通过 JSON-RPC 提供钱包与工具访问。

2. **共识与链层**
   - 通过确定性的出块者轮转产生区块。
   - 跟踪最终性深度并做基础链校验。
   - 通过快照持久化实现重启恢复。

3. **P2P 网络层**
   - 采用 HTTP gossip 传播交易与区块。
   - 通过链快照同步进行对等节点对齐。

4. **存储层（兼容 IPFS）**
   - Blockstore + UnixFS 文件布局。
   - HTTP API 子集与 `/ipfs/<cid>` 网关。

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
- 共识为确定性轮转（尚未实现 BFT/PoS）。
- P2P 为 HTTP gossip（尚未完成节点发现与评分）。
- EVM 状态为内存存储，仅快照持久化。
- IPFS 兼容性目前集中在核心 HTTP API 与网关行为。
