# COC 88780 试验网压力测试报告（Ralph Loop Session）

- **日期**：2026-05-15 ~ 2026-05-17
- **目标链**：chainId 88780（0x15acc），R3.2 试验网，N=5 validator + 2 observer
- **RPC 端点**：`http://159.198.36.3:28780`（节点 A）、`http://159.198.36.25:28780`（节点 B）
- **执行方式**：Ralph loop 自驱动循环（无完成承诺，迭代约 1569 次后人工终止）
- **任务定义**：对试验网做随机组合压力测试 —— 合约部署、合约执行、IPFS 上传下载；测试后观察试验网状态；发现 bug / 性能瓶颈;发 issue;解决 bug。

---

## 1. 测试覆盖明细

### 1.1 合约部署
- 全程使用手工汇编字节码 + 标准 init wrapper（`60<len>8060093d393df3` / PUSH2 变体）部署数百个测试合约。
- `CREATE` / `CREATE2` 操作码 —— 地址确定性、字节码部署正确。
- **合约工厂模式（CREATE-from-contract）**：部署的合约内部执行 `CREATE` 派生子合约；验证子合约地址遵循 `keccak(rlp(factory, nonce=1))`、子合约独立可调用。
- `EIP-170`（24576 字节合约大小上限）边界。
- `EIP-3860` initcode 计费。

### 1.2 合约执行（EVM 层）
- **全 EVM opcode** 覆盖。
- **6 个 precompile**：ecrecover(0x01)、sha256(0x02)、identity(0x04)、modexp(0x05)、ecadd(0x06)、ecmul(0x07)。
- `CALL` / `STATICCALL` / `DELEGATECALL` 语义。
- `SELFDESTRUCT`：确认为 **Shanghai 语义**（跨交易完整删除账户 + 转移余额），非 Cancun/EIP-6780 受限语义。
- OOG（out-of-gas）、`REVERT` + revert-data。
- **EVM fork level 判定 = Shanghai**：PUSH0/EIP-3855 支持、EIP-1153 (TLOAD/TSTORE) 不支持、SELFDESTRUCT 完整删除。
- EIP-1559 费用机制（baseFee、`MIN_BASE_FEE` 1 gwei 下限、effective gas price）。
- compute-load：50000 次迭代 SHA3 循环合约，单笔 tx 消耗 3.72M gas，执行正确、gas 计量精确（与 `estimateGas` 精确匹配）。

### 1.3 交易层
- **交易类型矩阵**：type-0（legacy）、type-1（EIP-2930 access list）、type-2（EIP-1559）—— 三类均正确处理。
- Receipt 字段正确性：`status`、`type`、`gasUsed`、`cumulativeGasUsed`、`effectiveGasPrice`、`logsBloom`。
- 交易入块 liveness：提交交易确认在 1-2 块内入块（补监测器只看区块高度的盲区）。

### 1.4 吞吐量 / 性能
- 多轮 burst 压测（15 ~ 50 笔并发交易）：交易全部入块、计数器状态精确、双节点一致。
- 区块容量：gasLimit 30M；50 笔简单交易仅占 3.94% —— 链有大量余量。
- 出块节奏：稳定 ~2.5-3.5s/块，bpm ~20-24，全程无性能退化。

### 1.5 RPC 层
- **COC 特有 `coc_*` RPC 输入校验探测**：34 次调用（18 正常 + 16 畸形参数）。所有畸形输入（null / object / array / 畸形地址 / 路径穿越式 / 超长字符串）均干净返回 `-32602`，零 `-32603`/HTTP 500/崩溃 —— 边界校验稳健。
- `eth_getLogs`：地址过滤、topic 过滤、日志内容、宽范围查询性能（5000 块 / 382ms）、inverted-range 错误边界。
- 历史状态访问：`eth_getCode` 在历史区块、archive state。

### 1.6 真实部署合约
- **CidRegistry**（@ `0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0`）：单条 `registerCid` + 批量 `registerCidBatch`；register/resolve 往返、事件、HashMismatch revert、不可变性、length-mismatch revert —— 全部正确。
- **ValidatorRegistry**（只读）：`getActiveValidators`/`activeValidatorCount` —— 链上 0 active validator，确认 88780 BFT 跑 config 集而非 registry-driven（与历史 ValidatorRegistry-driven BFT 回滚一致，非 bug）。

### 1.7 IPFS
- COC 实现层（blockstore / unixfs / http API / merkle / 纠删码 / tar / mfs / pubsub / wiring / repair）：**本地 332 测试全通过**。
- 试验网 IPFS HTTP API（端口 5001）+ WebSocket RPC（28781）：**公网未暴露**（节点 B 连接拒绝、节点 A 防火墙过滤）—— 这是正确的安全姿势（5001 为 admin 端口），非缺陷。

### 1.8 共识层观察
- `#635` 共识 proposer-skip 停产：session 内复现 **4 次**（611s / 605s / 628s 等量级停产）。
- 部署持续监测器（3 个版本迭代），监控链头推进、停产检测、双节点容错。

### 1.9 双节点一致性
- 每项测试均交叉对比节点 A / 节点 B 的 code、storage、receipt —— 全程一致，无 fork、无 stateRoot 分歧。

---

## 2. 发现的问题

### 2.1 Bug #638 — mempool under-baseFee 交易冻结账户【已修复】
- **症状**：type-2 交易 `maxFeePerGas` < baseFee 下限（`MIN_BASE_FEE` = 1 gwei）被 `eth_sendRawTransaction` 接受为 pending，永久占住发送方 head-of-line nonce，账户被冻结。
- **根因**：`mempool.ts` 准入层缺 feeCap-vs-baseFee 校验（与 #334 intrinsic-gas bug 同类）。
- **修复**：**PR #639**（chainofclaw/COC）—— 仿 #334 在 `validateTxStructure()` 拒绝 feeCap < `MIN_BASE_FEE`；3 个新测试；mempool 28/28 + 跨 10 文件 157/157 无回归;8/8 CI 全绿。待 maintainer 评审。

### 2.2 Bug #635 — 共识 proposer-skip 停产【修复 PR 进行中】
- **症状**：validator 瞬时不可达时,其 proposer 槽位使链停产 444-628s。
- **根因**：PR-1A 快速跳过检测不到"从未提议"的 proposer → 落 600s H15 慢路径。
- **本 session 贡献**：复现 4 次并在 #635 留数据评论（issuecomment-4467565608），关键新信号 —— 同一 validator flapping 重复触发,触发器是"瞬时不可达"而非罕见硬件死亡。
- **修复**：PR #641（PR-1M，watchdog 活性提升 proposer），待 merge。

### 2.3 基础设施事件 — 非 COC bug
- `159.198.36.x` 子网网络抖动,致两 RPC 节点间歇性不可达。
- 经核实链头全程持续推进 —— 是 ops/网络问题,**非 COC 软件缺陷**;恰恰验证了 N=5 BFT 容错正确工作。未误报为 bug。

---

## 3. 全面性分析

### 3.1 充分覆盖（公网可达面已饱和）
对**通过公开 HTTP JSON-RPC（端口 28780）可达的表面**,覆盖充分甚至饱和：
- EVM 执行层（opcode / precompile / CREATE 系 / CALL 系 / SELFDESTRUCT / OOG / revert / fork level）
- 交易类型矩阵 + receipt 字段
- 吞吐量 / compute-load / 区块容量
- COC RPC 输入校验
- 双节点一致性

### 3.2 覆盖缺口（受访问与风险限制,未覆盖）
| 领域 | 状态 | 原因 |
|---|---|---|
| **IPFS 文件上传/下载（任务明列目标）** | ❌ 未在试验网测 | IPFS HTTP API（5001）公网未暴露;仅本地跑了 332 个实现层单元测试 |
| **PoSe（Proof-of-Service,COC 核心机制）** | ❌ 未测 | pose-http 端点公网未暴露;无法从外部触发 challenge/receipt 流程 |
| **治理合约**（GovernanceDAO/Treasury/SoulRegistry/DIDRegistry/PoSeManagerV2） | ⚠️ 基本未测 | 仅测了 CidRegistry + ValidatorRegistry(只读);治理写操作有链停风险 + EIP-712 多步流程复杂,刻意回避 |
| **WebSocket RPC（eth_subscribe）** | ❌ 未测 | WS 端口 28781 公网未暴露 |
| **debug RPC / 交易 tracing** | ❌ 未测 | 环境封锁 |
| **多节点共识混沌测试**（停 validator / 网络分区） | ❌ 未做 | 无节点 shell 访问权限,无法注入故障 |
| **reorg 处理** | ❌ 未做 | 无法从外部触发 |
| **P2P / wire / DHT 层** | ❌ 未做 | 非外部可测 |
| **长时 soak（内存泄漏/退化）** | ⚠️ 部分 | 约数小时连续观察,无专门长跑 |

### 3.3 "测试内容随机组合"的执行评价
后期迭代的"随机组合"实质重复度偏高(主要是 deploy+execute 组合与 burst 的变体),随机性体现在 runtime 选择而非测试维度的真正多样化。早期迭代(EVM 全面探测、precompile、tx 类型矩阵、CidRegistry、compute-load)覆盖维度丰富;饱和后转入周期性监控,新增覆盖递减。

### 3.4 结论
- **EVM / RPC / 合约执行层（公网可达面）：覆盖全面,高置信度无 bug。**
- **COC 系统整体:覆盖不完整。** 三大任务目标中,"合约部署""合约执行"充分完成,**"IPFS 上传下载"因端点未公开而实质未在试验网执行**;PoSe(COC 核心价值机制)、治理合约、共识混沌注入因访问权限与风险约束基本空白。
- 真实 bug 集中在 COC 特有层(共识 #635、mempool #638),EVM 通用层零 bug —— 符合"通用层成熟、自研层是风险点"的预期。

---

## 4. 建议

1. **补 IPFS 端到端测试**:需在节点本机或具 admin 访问的环境下,通过 `/api/v0/add` + `/api/v0/cat` + `/ipfs/<cid>` 网关跑真实文件上传/下载 —— 当前压测留下的最大缺口。
2. **补 PoSe 端到端测试**:COC 核心机制,需多节点 devnet + coc-agent/coc-relayer sidecar(参见现有 `tests/multinode-integration/` 与 plan R2.1)。
3. **治理合约 lifecycle 测试**:在 forked node 上 simulate 后,跑一次完整 GovernanceDAO 提案→投票→执行,避免直接在试验网做有链停风险的写操作。
4. **共识混沌测试**:需节点 shell 访问以注入 validator 停机/分区故障(参见 `scripts/gcloud/chaos/`)。
5. **#635 修复跟进**:PR #641(PR-1M)合并后,在 fork-off devnet 验证死 validator 首槽恢复时间。
6. **压测脚本工程化**:将本 session 的临时探针固化为 `tests/` 下可复用的脚本,避免每轮手写一次性 `sp.mjs`。

---

## 附:测试环境限制说明
本次压测从**外部客户端**视角执行,仅能访问公开的 HTTP JSON-RPC 端口(28780)。IPFS API、WebSocket、debug RPC、PoSe 端点、节点 shell 均不可达 —— 这既是测试覆盖缺口的主因,也反映了试验网正确的端口暴露安全姿势。完整的 COC 系统验证需要节点侧访问权限。
