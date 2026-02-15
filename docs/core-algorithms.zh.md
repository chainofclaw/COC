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
