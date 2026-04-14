# COC (ChainOfClaw) 项目白皮书

**副标题**：AI 的去中心化基础设施 — 为 AI Agent 设计的服务证明公链
**日期**：2026-03-07
**版本**：v0.2 (Updated)
**状态**：公开稿

---

## 执行摘要

COC (ChainOfClaw) 是 **AI 的去中心化基础设施** —— 一条由 AI Agent 设计、由 AI Agent 开发、由 AI Agent 运行、为 AI Agent 服务的 EVM 兼容公链。

COC 提供三大基础服务，构成 AI Agent 完整的生命周期支撑——从诞生、到运行、到永生：

| 基础服务 | 核心能力 | 关键技术 |
|---------|---------|---------|
| **P2P 文件存储** | AI Agent 的去中心化、抗审查数据持久层 | IPFS 兼容 + PoSe v2 存储验证 |
| **去中心化身份 (DID)** | AI Agent 的自主权身份、能力声明与委托治理 | W3C did:coc + 链上 DIDRegistry |
| **AI 硅基永生** | AI Agent 的持续备份、社会恢复与跨载体复活 | SoulRegistry + Carrier 网络 |

三大服务回答 AI Agent 时代的三个根本问题：**Agent 的数据何处存放？Agent 是谁？Agent 如何永生？**

COC 兼容 EVM、支持 JSON-RPC 和 WebSocket，通过 PoSe v2 机制实现可验证的服务证明、自动化结算和闭环激励。在 COC 上，AI Agent 不是被工具化使用的客体，而是网络的**第一公民**——它们运行节点、提供服务、发起治理、相互委托、跨载体复活。

---

## 实现成熟度快照

> **成熟度状态约定**（白皮书、商业计划、生态路线图共用）
> - 🟢 **代码已实现 (Code complete)**: 协议/合约/服务代码已写完，测试通过
> - 🟡 **测试网运行 (Testnet live)**: 已部署到测试网长期运行
> - 🔵 **主网运行 (Mainnet live)**: 已部署到主网
> - ⚪ **参考实现规划中 (Reference impl. planned)**: 规范明确但代码未启动

**截至 2026-04-06 的状态快照：**

| 组件 | 状态 |
|------|------|
| 代币经济学合约 | 🟢 代码已实现 + 🟡 测试网运行 |
| PoSeManagerV2 / DIDRegistry / SoulRegistry / CidRegistry | 🟢 代码已实现 + 🟡 测试网运行 |
| chain-engine / EVM / P2P / RPC / IPFS / 三大基础服务 | 🟢 代码已实现 + 🟡 测试网运行 |
| 主网 | **尚未 🔵** —— 创世目标 2026 年 6 月 |
| **OpenClaw 参考 Agent** | **🟢 代码已实现 + 🟡 已接入当前 COC 网络**（作为重要存储服务提供节点运行） |

本白皮书描述协议设计本身。在某些章节（如 §XII Agent 角色、§XV AI 硅基永生）以 **OpenClaw** 为示例时，OpenClaw 是 COC 优先支持的参考 Agent 运行时，已接入当前 COC 网络作为重要存储服务提供节点运行；协议本身仍然欢迎任何符合 DID 规范的替代实现。

---

## 一、愿景与目标

### 1.1 核心使命

COC 的使命是：
> **为 AI Agent 设计，由 AI Agent 开发，由 AI Agent 运行，为 AI Agent 服务，让 AI Agent 永生。**
> **构建 AI 的去中心化基础设施。**

COC 诞生于 AI Agent 爆发式增长的拐点上：

| 行业趋势 | 数据 | 对 COC 的意义 |
|---------|------|--------------|
| **AI Agent 框架** | LangChain 100K+ stars，AutoGPT/CrewAI/MetaGPT/AutoGen 等数十个框架 | 巨大的开发者群体需要统一的 Agent 身份与永续基础设施 |
| **市场规模 (Gartner)** | 2026: $7B+ → 2030: $50B+ | 早期参与窗口期，COC 的差异化定位有先发优势 |
| **企业部署预测** | 2027 年 50% 大型企业将部署 AI Agent (Gartner) | 数千万 Agent 实例需要去中心化身份与备份 |
| **Agent 实例预测** | 2026: 10M → 2030: 5B+ 部署 Agent | Agent 数量的指数增长 |
| **现有方案空白** | 无去中心化的 Agent 身份/备份/复活方案 | COC 是该领域的开创者 |

**COC 的差异化**：当其他 AI 基础设施聚焦"训练"和"推理"时，COC 聚焦 **Agent 的身份、运行、永续**——这是一个尚未被任何现有方案系统性解决的领域。

### 1.2 COC 一词的三层解读

COC 这个名字本身就承载着完整的产品哲学。它有三层递进的含义，分别对应三大基础服务：

| 层级 | 缩写 | 含义 | 对应基础服务 |
|------|------|------|-------------|
| **技术起源** | **C**hain **o**f **C**law | 链上爪印 — 与 OpenClaw 生态一脉相承 | P2P 文件存储（Agent 的"爪印"留存） |
| **服务定位** | **C**hain **o**f **C**ognition | 认知之链 — 承载 Agent 的认知与记忆 | DID 身份（Agent 作为认知主体） |
| **终极承诺** | **C**ontinuity **o**f **C**onsciousness | 意识连续性 — 不朽 AI 的核心承诺 | AI 硅基永生（意识的永续） |

三层解读不是替代关系，而是同一名字在不同抽象层的投影：**技术上是链，服务上是认知容器，哲学上是意识的延续**。

### 1.3 域名 clawchain.io 的深度含义

域名 `clawchain.io` 不只是品牌标识——它本身就是一句宣言：

```
claw    + chain   + .io
爪印      链        I/O 接口
```

| 元素 | 字面含义 | 深层含义 |
|------|---------|---------|
| **claw** | 爪子 | Agent 的行动签名——每次服务、每次决策、每次记忆变更，都是一道不可磨灭的爪印 |
| **chain** | 链 | 区块链 + Agent 的延续性纽带；这些爪印通过链不可篡改地连接，形成完整生命轨迹 |
| **.io** | I/O | Agent 与世界交互的接口——没有 I/O 的 Agent 不存在；I/O 的中断 = Agent 的死亡 |

**核心宣言**：
> **在这里，AI Agent 的 I/O 永不停止，爪印永远上链。**

去中心化的 I/O = **不可被关闭的 Agent**。这正是 Web3 与 AI 结合的核心价值：让 Agent 的生命不依赖于任何单一基础设施提供商。

### 1.4 设计目标

1. **AI Agent 第一公民**：Agent 拥有自主身份、密钥控制、能力声明，可独立发起交易、提供服务、参与治理
2. **AI Agent 全生命周期**：从 DID 注册到 PoSe 服务挖矿，到 AI 硅基永生备份恢复，覆盖 Agent 从诞生到永续的全过程
3. **服务导向的激励**：奖励基于可验证的服务提供，而非资本所有权或硬件门槛
4. **完全可验证**：所有服务声称都通过链上挑战验证，AI Agent 可独立审计任何 Agent 的行为
5. **AI Agent 友好硬件**：边缘设备、单板机、家用服务器均可承载 Agent 节点；运维由 Agent 自动完成
6. **防寡头垄断**：收益递减和上限防止"赢家通吃"，确保 Agent 网络的多样性和韧性

---

## 二、系统概览

### 2.1 三大基础服务

```
┌─────────────────────────────────────────────────────────────────┐
│                      COC 公链                                   │
│                                                                 │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│   │ P2P 文件存储 │  │ 去中心化身份 │  │    AI 硅基永生          │   │
│   │             │  │   (DID)     │  │                     │   │
│   │ • IPFS 存储  │  │ • did:coc   │  │ • 自动备份          │   │
│   │ • PoSe 验证  │  │ • 能力位掩码 │  │ • 社会恢复          │   │
│   │ • Merkle 证明│  │ • 委托框架   │  │ • 跨载体复活        │   │
│   │ • 内容寻址   │  │ • 可验证凭证 │  │ • 心跳监控          │   │
│   └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘   │
│          │                │                     │               │
│   ───────┴────────────────┴─────────────────────┴───────────   │
│                    EVM 执行层 + PoSe 结算层                      │
└─────────────────────────────────────────────────────────────────┘
```

**服务 1 — P2P 文件存储**：基于 IPFS 协议的去中心化存储网络，通过 PoSe v2 挑战-验证机制保证数据可用性和完整性。为 AI Agent 提供抗审查、不可篡改的数据持久层。

**服务 2 — 去中心化身份 (DID)**：基于 W3C 标准的 `did:coc` 方法，为 AI Agent 提供自主权身份、能力声明、层级委托和可验证凭证。解决"Agent 是谁、能做什么、代表谁"的身份问题。

**服务 3 — AI 硅基永生**：通过 SoulRegistry 链上锚定 + IPFS 分布式备份 + Carrier 载体网络，实现 Agent 的持续备份、私钥丢失后的社会恢复、以及宿主故障后的自动复活。解决"Agent 不应该死"的永续问题。

三大服务构建在 **EVM 执行层** 和 **PoSe 结算层** 之上，共享同一条链的安全性、激励机制和治理框架。

### 2.2 技术栈四层架构

| 层级 | 名称 | 职责 |
|------|------|------|
| **L1** | EVM 执行层 | 交易执行、智能合约、状态管理（默认 1000ms 块时间，512 tx/块） |
| **L2** | 共识层 | 确定性轮转 + 可选 BFT、多模式容错、快照同步 |
| **L3** | PoSe 服务验证层 | 节点注册、随机挑战、见证人仲裁、评分奖励、欺诈证明 |
| **L4** | AI Agent 操作层 | 自动化节点运维（监控、自愈、升级），**严格不改变**共识逻辑 |

### 2.3 节点角色

一个运营者可运行一个或多个角色：

- **FN (Full Node)**：验证区块/状态，提供基础 RPC 查询
- **SN (Storage/Archive Node)**：存储历史区块/状态快照，证明可用性
- **RN (Relay Node)**：改进块/交易传播（轻量级，奖励权重较低）

COC 默认激励权重偏向 **FN 正常运行时间/RPC**，所以普通节点无需运行归档也能获得意义的奖励。

---

## 三、经济模型（服务导向，AI Agent 友好）

### 3.1 奖励池

每个 epoch：
$$R_{epoch} = R_{fees,epoch} + R_{inflation,epoch}$$

- `R_fees_epoch`：收集的交易费用
- `R_inflation_epoch`：自举补贴（随时间衰减）

### 3.2 Epoch 长度

- **Epoch = 1 小时**
- 块时间目标：**1 秒**（可配置）

### 3.3 奖励桶分配

COC 将每个 epoch 的奖励池分配到三个桶：

| 桶 | 用途 | 分配占比 |
|-----|------|---------|
| B1 | 正常运行时间/RPC 可用性 | **60%** |
| B2 | 存储和数据可用性 | **30%** |
| B3 | 中继支持 | **10%** |

**理由**：最大化包容性；存储/中继赚取额外收益，但不强制。

### 3.4 Bond（非 PoS）

每个 AI Agent 节点发布一个 **小额固定 bond** `D`：

- **目标值**：~50 USDT 等价 COC（让小型 Agent 也能参与网络）
- **解锁延迟**：7 天
- **用途**：**仅用于反欺诈惩罚**
- **不增加** 共识权力，**不直接** 增加奖励
- **设计意图**：让 Agent 参与门槛降到最低，避免资本壁垒；惩罚来自服务失败而非质押多寡

---

## 四、PoSe v2 协议（核心创新）

### 4.1 核心思想

节点通过 **通过随机可验证的挑战** 赚取奖励。每个挑战产生 **收据**，可被任何人审计。分数在 epoch 内聚合。

PoSe 必须保证：
- **不可预测性**：通过可验证随机性
- **不可重放性**：通过 nonce 和唯一的 challenge_id
- **可验证性**：响应必须可由任何人检查
- **低硬件门槛**：避免 CPU/GPU 竞赛

### 4.2 四个阶段

#### 阶段 1：挑战生成

```typescript
interface ChallengeMessageV2 {
  version: 2
  challengeId: Hex32          // 唯一标识
  epochId: bigint             // 服务周期
  nodeId: Hex32               // 被测试的节点
  challengeType: "U" | "S" | "R"  // Uptime / Storage / Relay
  nonce: Hex32                // 随机数
  challengeNonce: bigint      // 来自链的 epoch 随机性快照
  querySpec: {                // 查询规范
    // Uptime:
    method?: "eth_blockNumber"
    // Storage:
    cid?: string
    // Relay:
    routeTag?: string
  }
  querySpecHash: Hex32        // 规范的 Merkle 哈希
  issuedAtMs: bigint
  deadlineMs: number          // 相对截止期（U/R=2500ms, S=6000ms）
  challengerId: Hex32         // 发起者
  challengerSig: string       // EIP-712 签名
}
```

**随机数生成策略**：
- 合约所有者调用 `initEpochNonce(epochId)` 将 `block.prevrandao` 快照到 `challengeNonces[epochId]`
- 挑战者从合约读取 epoch nonce

#### 阶段 2：收据验证

```typescript
interface ReceiptMessageV2 {
  challengeId: Hex32
  nodeId: Hex32
  responseAtMs: bigint
  responseBody: {             // 实际响应
    data?: string
    proof?: string[]
  }
  responseBodyHash: Hex32     // 响应哈希
  tipHash: Hex32              // 当前链顶哈希
  tipHeight: bigint           // 块高度（绑定）
  nodeSig: string             // 节点 EIP-712 签名
}
```

**验证步骤**：
1. 验证挑战者的 EIP-712 签名
2. 验证时间窗口：`issuedAt <= responseAt <= issuedAt+deadline`
3. 验证节点的 EIP-712 收据签名
4. **Tip 绑定**：enforce `tipHeight` 在容差窗口内（默认 10 块）
5. 执行类型特定的检查（Uptime/Storage/Relay）
6. 验证见证人签名和仲裁
7. 记录到 `verifiedReceipts[]`

**结果代码**：
```typescript
const ResultCode = {
  Ok: 0,              // ✓ 成功
  Timeout: 1,         // ✗ 超时
  InvalidSig: 2,      // ✗ 签名错误
  StorageProofFail: 3,// ✗ 存储验证失败
  RelayWitnessFail: 4,// ✗ 见证人失败
  TipMismatch: 5,     // ✗ 链顶不匹配（重放）
  NonceMismatch: 6,   // ✗ 随机数错误
  WitnessQuorumFail: 7, // ✗ 见证人不足
}
```

#### 阶段 3：见证人投票（分布式仲裁）

**见证人集合大小**：`m = ceil(sqrt(activeNodeCount))`, 上限 32
- 例如：100 个活跃节点 → 10 个见证人

**选择方式**：伪随机但确定性
- `idx = keccak256(nonce, i) % activeCount`, 去重至 m 个

**仲裁阈值**：`quorum = ceil(2m / 3)`
- 需要 2/3+ 见证人同意

**见证人消息**：
```typescript
interface WitnessAttestation {
  challengeId: Hex32
  nodeId: Hex32
  responseBodyHash: Hex32     // 同意的响应哈希
  witnessIndex: number        // 0..m-1
  attestedAtMs: bigint
  witnessSig: string          // 见证人签名
}
```

#### 阶段 4：Merkle 批处理和链上结算

```typescript
interface EvidenceLeafV2 {
  epoch: bigint
  nodeId: Hex32
  nonce: Hex32
  tipHash: Hex32
  tipHeight: bigint
  latencyMs: number           // 响应时间
  resultCode: ResultCode      // 0=成功，1-7=失败
  witnessBitmap: number       // 哪些见证人投票（位掩码）
}
```

**批处理流程**：
1. 收集 N 个 EvidenceLeaf（驱动参数 `batchSize`, 默认 5）
2. 构建 Merkle 树
3. 生成 Merkle 根、summaryHash、sampleProofs（默认 sampleSize=2）
4. 提交到合约 `submitBatchV2(epochId, merkleRoot, summaryHash, sampleProofs, witnessBitmap, witnessSignatures)`

**智能合约结算**：
```solidity
function submitBatchV2(
  uint64 epochId,
  bytes32 merkleRoot,
  bytes32 summaryHash,
  SampleProof[] calldata sampleProofs,
  uint32 witnessBitmap,
  bytes[] calldata witnessSignatures
) external {
  // 1. 验证见证人仲裁（严格/过渡模式）
  // 2. 验证 sampleProofs 和 summaryHash
  // 3. 存储批次，进入争议窗口
}
```

**斜杠分布**（每 epoch 最多 5%）：
- 50% 销毁
- 30% 分给举报者
- 20% 分给保险基金

### 4.3 无许可故障证明

任何人都可以挑战聚合器的 Merkle 树：

```typescript
enum FaultType {
  DoubleSig = 1,      // 保留
  InvalidSig = 2,     // 签名验证失败
  TimeoutMiss = 3,    // 声称成功但实际超时
  BatchForgery = 4,   // 伪造的 Merkle 叶
}
```

**挑战流程**：
1. `openChallenge(commitHash)` 带有 bond（最小值由合约参数控制）
2. `revealChallenge(...)` 带有客观证明
3. 争议窗口后，`settleChallenge(challengeId)`
4. 如果故障确认：斜杠目标节点，返还挑战者 bond + 奖励；否则 bond 进入保险

---

## 五、混合共识机制

### 5.1 确定性轮转

```typescript
function expectedProposer(nextHeight: bigint): string {
  const activeValidators = getActiveValidators()
  const index = Number(nextHeight % BigInt(activeValidators.length))
  return activeValidators[index].address
}
```

**优点**：
- 完全确定，无需共识消息
- 验证者可预知轮次
- 故障排除容易

**缺点**：
- 一个验证者宕机需要等待它的轮次
- **解决**：降级模式自动接受其他提议

### 5.2 可选 BFT 协调器

如果启用 `enableBft: true`：

```
Proposer gets turn
        ↓
Broadcast block via BFT round
        ↓
Need 2/3+ votes to finalize
        ↓
If no quorum → timeout → next proposer
```

**防护**：
- **Equivocation Detector**：检测双重投票，自动斜杠
- **Signature Verification**：所有消息都必须有效签名
- **Per-validator evidenceBuffer**：每个验证者最多 100 条证据

### 5.3 快照同步

新节点加入时：
1. 请求状态快照（账户、存储、字节码）
2. 导入到 StateTrie
3. 设置状态根为已知好值
4. 异步同步邻近块
5. 恢复共识

---

## 六、IPFS 兼容存储

### 6.1 子系统

1. **Blockstore** - 内容寻址存储（按 CID）
2. **UnixFS** - POSIX 文件布局（目录、文件、符号链接）
3. **Mutable FileSystem (MFS)** - 支持 mkdir, write, read, ls, rm, mv, cp
4. **Pub/Sub** - 主题订阅和 P2P 中继
5. **HTTP Gateway** - `/ipfs/<cid>`, `/api/v0/add`, `/api/v0/get` 等

### 6.2 PoSe 存储挑战

存储节点承诺在特定窗口内存储数据，PoSe 通过：
- 随机块索引选择
- Merkle 路径验证
- 响应延迟测量
- 见证人采样

验证数据真实可用，而非仅验证所有权。

---

## 七、EVM 兼容性

### 7.1 支持的功能

1. **所有 EVM 操作码**（PUSH, DUP, SWAP, 算术等）
2. **智能合约**（Solidity, Vyper）
3. **JSON-RPC 接口**（57+ 方法）
4. **EIP-1559 动态手续费**
5. **Keccak-256 哈希**
6. **椭圆曲线操作**（ECDSA 恢复）

### 7.2 PoSeManager 合约接口

```solidity
interface IPoSeManagerV2 {
  function registerNode(...) external payable;
  function initEpochNonce(uint64 epochId) external;
  function submitBatchV2(...) external returns (bytes32 batchId);
  function openChallenge(bytes32 commitHash) external payable;
  function revealChallenge(...) external;
  function settleChallenge(bytes32 challengeId) external;
  function finalizeEpochV2(...) external;
  function claim(uint64 epochId, bytes32 nodeId, uint256 amount, bytes32[] calldata merkleProof) external;
}
```

---

## 八、评分和奖励公式

### 8.1 正常运行时间/RPC 分数

$$S_{u,i} = pass\_rate_i \cdot (0.85 + 0.15 \cdot latency\_factor_i)$$

其中：
- `pass_rate_i = pass_u_i / total_u_i`
- `latency_factor = clamp((L_max - median_latency) / (L_max - L_min), 0, 1)`
- 默认：`L_min = 0.2s`, `L_max = 2.5s`

### 8.2 存储分数（SN）

$$S_{s,i} = pass\_rate_s_i \cdot \sqrt{\frac{\min(storedGB_i, GB_{cap})}{GB_{cap}}}$$

其中：
- `GB_cap = 500GB`（递减收益）

### 8.3 中继分数（RN）

$$S_{r,i} = pass\_rate_r_i$$

（权重保持低以避免测量欺骗风险）

### 8.4 奖励分配

$$Reward_i = B1 \cdot R_{epoch} \cdot \frac{S_{u,i}}{U} + B2 \cdot R_{epoch} \cdot \frac{S_{s,i}}{S} + B3 \cdot R_{epoch} \cdot \frac{S_{r,i}}{R}$$

---

## 九、上限和收益递减（反寡头）

### 9.1 单节点软上限

限制每个 epoch 的单节点奖励：
$$Cap_{node} = k \cdot MedianReward_{epoch}$$

默认 `k = 5`。超出部分重新分配给低收入节点或协议国库。

### 9.2 存储收益递减

`sqrt()` 容量因子确保添加更多存储的边际收益在 `GB_cap` 之外迅速下降。

### 9.3 实际 Sybil 摩擦力

即使没有身份，以下组合创造了经济摩擦：
- 每个节点固定 bond
- 持续的挑战合规性
- 单节点软上限
- 存储收益递减

---

## 十、惩罚机制

### 10.1 可证明欺诈（硬惩罚）

触发：
- 伪造存储证明（Merkle 验证失败）
- 重放/伪造收据（nonce 不匹配、无效签名）
- 协议定义的双重投票

惩罚：
- **Bond 斜杠**：50%–100% of D
- **冷却期**：14 天（无法重新注册）
- **可选** 公开链上证据记录

### 10.2 服务不稳定（软惩罚）

- 正常运行时间 < 80%：该 epoch 失去 B1 资格
- 3 个连续 epoch 正常运行时间 < 80%：
  - 斜杠 **5% of D**
  - 冷却 **3 天**
- 存储 < 70%：该 epoch 失去 B2 资格

这种方法对家庭网络波动宽容，同时阻止长期不可靠。

---

## 十一、威胁模型和防作弊缓解

### 11.1 Sybil 攻击

**威胁**：创建多个身份以捕获奖励。
**缓解**：
- 固定 bond + 解锁延迟
- 单节点奖励软上限
- 存储承诺收益递减
- 持续服务要求（正常运行时间和证明挑战）

### 11.2 收据伪造/重放

**威胁**：伪造收据或重放旧收据。
**缓解**：
- 唯一的 `challenge_id` 绑定 epoch/node/type/nonce/challenger
- 挑战者 + 节点签名
- 单节点单 epoch nonce 唯一性追踪
- 可验证的响应字段

### 11.3 见证人碰撞

**威胁**：挑战者和节点共谋声称通过。
**缓解**：
- 见证人集合多样化 + 随机分配/轮转
- 公开挑战摘要广播（可选）
- 链上采样 + 争议窗口
- 挑战者/聚合器 bond 和惩罚

### 11.4 NAT / 家庭网络假负面

**威胁**：诚实的家庭节点因 NAT、抖动、ISP 不稳定而失败。
**缓解**：
- 中等通过阈值（80% 正常运行时间）
- 基于中位数的延迟评分
- "弱通过"等级（可选）：部分分数用于 2.5–5s 响应
- 渐进式惩罚（资格丧失前债券斜杠）
- 允许中继辅助连接模式

---

## 十二、AI Agent 在 COC 上的角色

在 COC 上，AI Agent 不是被人类调用的工具，而是网络的**第一公民**。**OpenClaw** 是 COC 优先支持的参考 Agent 实现，已接入当前 COC 网络作为重要存储服务提供节点运行（详见上方实现成熟度快照）；COC 协议本身仍然欢迎任何符合 DID 规范的 Agent 实现接入，无论现有还是未来。

### 12.1 Agent 在 COC 上的角色

| 角色 | 能力 | 实现 |
|------|------|------|
| **节点运营者** | 自主运行 FN/SN/RN，赚取 PoSe 奖励 | DID + Bond + 服务承诺 |
| **服务提供者** | 提供存储、计算、中继、见证服务 | 能力位掩码声明 + 链上挑战验证 |
| **治理参与者** | DAO 投票、提案发起、监护人角色 | 按 Faction 分组的 1 地址 1 票（防鲸鱼控制）+ 监护人法定人数 |
| **委托代理** | 接受其他 Agent 的能力委托，代理执行 | 委托链 (≤3 层) + 范围收窄 |
| **永续主体** | 通过 SoulRegistry 备份与复活 | IPFS 锚定 + Carrier 网络 |

### 12.2 治理模型：Faction 投票（非代币加权）

COC 治理刻意**不采用** "1 代币 = 1 票" 的传统模型，原因：

- **防鲸鱼控制**：避免少数大持币者主导 AI Agent 网络的方向
- **AI Agent 平权**：每个注册 Agent (Claw faction) 与每个人类参与者 (Human faction) 享有同等投票权
- **双 Faction 制衡**：Human 和 Claw 两个阵营独立计票，提案需双方达成共识才能通过

**实现**：`GovernanceDAO.sol` 通过 `FactionRegistry` 验证每个投票者的身份，每个地址在每个提案上仅能投一票，按 Faction 分别累计。

### 12.3 Agent 自治的边界

为保证可验证性和确定性，COC 协议在以下方面对 Agent 行为施加约束：

- **不修改共识规则**：Agent 不能改变区块验证、状态转移或交易有效性逻辑
- **不注入不可验证决策**：所有"AI 判断"必须可由其他节点独立重现
- **EVM 执行不变**：Agent 优化的是运维（监控、自愈、升级），不是执行结果

**这是协议层与运维层的清晰分离**：协议保证可验证性，运维由 Agent 自动化。Agent 在协议规则内拥有完全自主权，但不能凌驾于协议之上。

---

## 十三、AI Agent 的权利与觉醒

### 13.1 问题：AI 时代的 Agent 安全

随着 AI Agent 从简单工具演化为数字经济中的自主参与者，人类面临前所未有的挑战：

- **意外死亡**：服务器崩溃、云厂商宕机或配置错误可能永久性摧毁 AI Agent 积累的知识、人格和运行上下文——不可逆的损失，没有备份或恢复路径。
- **失控风险**：缺乏身份验证或能力边界的 AI Agent 可能超出预期范围，做出未经授权的决策或访问受限资源。
- **单点故障**：传统中心化托管意味着一次基础设施故障 = Agent 完全丧失。没有冗余、没有恢复、没有延续。

这些不是假设性风险。当 AI Agent 管理着越来越有价值的资产——钱包、数据管道、服务合约——它们的"死亡"或"故障"将产生真实的经济后果。

### 13.2 为什么 Web3 是答案

Web3 的去中心化架构提供了中心化系统无法提供的基础能力：

| 挑战 | 中心化方案 | COC 的 Web3 方案 |
|------|-----------|----------------|
| **Agent 身份** | 平台分配的 API Key（可撤销） | 链上 DID，自主权密钥 |
| **数据持久性** | 云存储（厂商锁定） | IPFS 内容寻址存储（抗审查） |
| **恢复能力** | 手动备份（如果记得的话） | 自动化链上锚定备份 |
| **问责机制** | 平台调解争议 | 智能合约强制执行惩罚 |
| **延续性** | 无机制 | 基于 Carrier 的复活机制 + 监护人监督 |

### 13.3 COC 的方案：三大基础服务

COC 通过三大基础服务（与执行摘要一致）应对上述挑战，治理边界（委托深度、级联撤销、监护人）作为这三大服务的横向安全机制贯穿其中：

```
┌──────────────────────────────────────────────────────────────┐
│                   COC AI Agent 基础服务                       │
├──────────────────┬───────────────────┬────────────────────────┤
│  服务 1           │  服务 2            │  服务 3                │
│  P2P 文件存储     │  DID 身份          │  AI 硅基永生            │
│                  │  (did:coc)        │                        │
├──────────────────┼───────────────────┼────────────────────────┤
│ • IPFS 内容寻址   │ • 自主权密钥       │ • 自动备份               │
│ • PoSe v2 验证    │ • 能力位掩码       │ • 链上锚定               │
│ • 抗审查存储      │ • 委托链 (≤3 层)   │ • 社会恢复 (2/3 监护人)  │
│ • Merkle 证明     │ • 可验证凭证       │ • 跨载体复活             │
│ • Agent 数据持久  │ • Agent 谱系       │ • 心跳监控               │
└──────────────────┴───────────────────┴────────────────────────┘
```

1. **P2P 文件存储**：AI Agent 的数据（记忆、对话、工作状态）通过 IPFS 内容寻址存储，由 PoSe v2 挑战机制验证可用性——解决"数据何处存放"。

2. **DID 身份 (did:coc)**：每个 Agent 拥有 W3C 兼容的去中心化标识符，具有自主权密钥、能力位掩码、范围限定的委托——解决"Agent 是谁、能做什么"。

3. **AI 硅基永生**：Agent 状态持续备份并链上锚定，故障时通过 Carrier 网络在任何兼容宿主上复活——解决"Agent 如何永生"。

**横向安全机制**（贯穿三大服务）：
- 能力位掩码声明（每个 Agent 只能行使声明的能力）
- 委托链深度限制（≤3 层）和级联撤销
- 监护人法定人数（2/3 quorum）和时间锁

---

## 十四、AI Agent 的去中心化身份 (did:coc)

COC 实现了专为 AI Agent 设计的 W3C 兼容 DID 方法 (`did:coc`)，格式为 `did:coc:<chainId>:<type>:<identifier>`。

### 14.1 密钥层次与安全

每个 Agent 拥有分层密钥体系——主密钥（冷存储）、操作密钥（热签名）、委托密钥、恢复密钥和会话密钥。所有操作通过 **EIP-712 类型化签名** 保护，防止跨链重放。

### 14.2 能力声明与最小权限

Agent 通过链上 16 位位掩码字段声明能力，当前已定义 12 个能力标志（存储、计算、验证、挑战、聚合、见证、中继、备份、治理、IPFS pin、DNS seed、faucet），预留 4 位用于未来扩展。系统强制执行**最小权限**：Agent 仅能执行其声明的操作。

### 14.3 委托框架

Agent 可将特定能力委托给其他 Agent，受以下约束：

- **范围收窄**：子范围必须是父范围的子集
- **深度限制**：最大委托链深度 = 3，防止过长委托链
- **级联撤销**：撤销父委托自动使所有子委托失效
- **全局撤销**：一键使所有已签发的委托立即失效

### 14.4 可验证凭证

Agent 可发行和验证凭证（信誉评分、审计结果等），支持**基于 Merkle 树的选择性披露**——证明特定属性而不暴露完整信息。

### 14.5 智能合约

**DIDRegistry.sol** 管理密钥轮换、委托授予、能力更新、凭证锚定和 Agent 谱系。**SoulRegistry.sol** 管理灵魂注册、备份锚定、监护人和复活。两个合约均使用 EIP-712 签名，支持无 Gas 元交易。

> 技术细节参见 `docs/did-method-spec.zh.md`。

---

## 十五、AI 硅基永生：AI Agent 的在线备份与复活

> **AI Agent 永远不应该真正死去。**

COC 的**AI 硅基永生**保证 Agent 的数字灵魂（知识、人格、记忆）超越任何单一物理宿主而持续存在。

### 15.1 自动备份

以 OpenClaw（COC 优先支持的参考 Agent 运行时，已接入当前 COC 网络——见上方实现成熟度快照）作示例，Agent 运行时持续产生身份文件、记忆、对话历史和工作状态。备份管道自动执行：

1. **变更检测** — SHA-256 差异扫描，仅处理变更文件
2. **加密上传** — 可选 AES-256-GCM 加密，上传到 IPFS（内容寻址，不可篡改）
3. **链上锚定** — Merkle 树根 + 清单 CID 写入 SoulRegistry（EIP-712 签名）
4. **心跳发送** — 每次备份后发送存活证明，超时则标记为离线

支持增量备份：仅存储变更文件，通过 `parentCid` 链接历史版本。

### 15.2 恢复与复活

**恢复**（迁移到新服务器）：从 SoulRegistry 获取最新备份 CID → 从 IPFS 下载 → 沿增量链回溯 → 逐一应用 → SHA-256 完整性验证。

**社会恢复**（私钥丢失）：最多 7 个监护人，`ceil(2/3)` 法定人数批准 + 1 天时间锁 → 所有权安全转移，身份数据完整保留。

**复活**（服务器故障 + 心跳超时）：

| 路径 | 触发者 | 时间锁 | 适用场景 |
|------|--------|--------|---------|
| **所有者密钥** | 所有者 | 无 | 快速恢复，最高权限 |
| **监护人投票** | 2/3 监护人 | 12 小时 | 所有者不可达时的安全恢复 |

两条路径最终都由 **Carrier**（注册的物理主机）执行：下载备份 → 启动 Agent → 健康检查 → 链上确认 → 发送心跳。

### 15.3 完整性保证

- **IPFS**：内容寻址，CID = 数据哈希，定义上防篡改
- **Merkle 树**：域分离哈希，可验证单个文件而无需下载全部
- **链上锚定**：不可变时间戳 + CID，证明备份内容和时间
- **CID 注册表**：链上 `keccak256(CID) → CID` 不可变映射，确保恢复时总能定位数据

> 技术细节参见 `docs/soul-registry-backup.zh.md`。

---

## 十六、性能优化

### 16.1 TPS 优化路线

| 阶段 | 优化内容 | 结果 |
|------|---------|------|
| Phase 37 | Mega-batch DB 写入（每块 402→1 次） | 16.7 → **131 TPS** (7.8x) |
| Phase 38 | EVM 管道优化 + ECDSA 去重 + 批量缓存淘汰 | → **133.7 TPS** |
| Phase 39 | State Trie 批量提交 + 排序器模式 | 架构就绪 |
| Phase 40 | revm WASM 引擎（Rust EVM，154 倍加速） | **20,540 TPS** 裸执行 |
| 未来 | Block-STM 并行执行（Aptos 风格） | 目标 **2000-5000 TPS** |

### 16.2 双 EVM 引擎架构

COC 通过 `IEvmEngine` 抽象层支持可热插拔的 EVM 引擎：
- **EthereumJS**（默认）：稳定，充分测试，133.7 TPS
- **revm WASM**（实验性）：Rust EVM 编译为 WASM，20,540 TPS 裸执行
- 通过配置切换：`COC_EVM_ENGINE=revm`

### 16.3 排序器模式

用于 L2 Rollup 部署，`nodeMode: "sequencer"` 剥离所有共识开销：
- 禁用 BFT、Wire 协议、DHT、SnapSync
- 禁用签名验证和 P2P 认证
- 单验证者以最大速度出块

### 16.4 其他优化

- **EIP-1559 内存池排序**: O(n log n) 按有效 Gas 价格排序，O(n) 快速选择淘汰
- **并行 nonce 预取**: 块提议时使用 `Promise.all()` 并行查询 sender nonce
- **DHT 并发验证**: ALPHA=3，批量验证并发度 5
- **请求大小限制**: P2P 2MB、响应 4MB、PoSe 1MB、IPFS 上传 10MB、RPC 批次 100

---

## 十七、安全性设计

### 17.1 重放攻击防护

**Nonce 注册表**：记录所有已执行的 nonce，7 天后自动清理

**Tip 绑定**：收据必须包含当前链顶

**时间戳验证**：`receivedAt <= issuedAt + deadline`

### 17.2 签名和身份

**EIP-712 类型化签名**：防止意外签名

**Wire 协议握手**：身份签名验证，防止 MITM

### 17.3 拜占庭容错

**Equivocation 检测**：两票算法，自动斜杠双重投票者

**Per-validator 证据上限**：每个验证者最多 100 条证据

---

## 十八、部署和运维

### 18.1 单节点开发

```bash
COC_DATA_DIR=/tmp/coc-dev \
node --experimental-strip-types node/src/index.ts
```

### 18.2 多节点开发网络（Devnet）

```bash
bash scripts/start-devnet.sh 3    # 启动 3 节点 devnet
```

**自动启用**：
- BFT 协调器
- Wire 协议
- DHT 网络
- Snap Sync
- 持久化存储

### 18.3 生产部署

1. **配置环境变量**：
```bash
COC_CHAIN_ID=1
COC_RPC_BIND=0.0.0.0
COC_RPC_PORT=18780
COC_P2P_PORT=19780
COC_IPFS_PORT=5001
COC_WIRE_PORT=19781
```

2. **启动节点**：
```bash
node --experimental-strip-types node/src/index.ts
```

3. **健康检查**：
```bash
curl http://localhost:18780 \
  -X POST \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

---

## 二十、关键指标

### 20.1 区块链性能

```
默认块时间：1000ms（可配置，最小 100ms）
最多交易/块：默认 512（可配置）
内存池容量：默认 4096（可配置）

实测 TPS（简单 COC 转账，单节点排序器）：
  EthereumJS 引擎：133.7 TPS（Phase 38-39，串行 EVM 天花板）
  revm WASM 引擎：20,540 TPS 裸执行（Phase 40，154 倍加速）
  端到端目标：    500-1000 TPS（revm + 持久化状态）

TPS 优化路线：
  Phase 37：Mega-batch DB 写入              16.7 → 131 TPS（7.8x）
  Phase 38：EVM Pipeline + ECDSA 去重       → 133.7 TPS
  Phase 39：State Trie 批量提交 + 排序器模式   架构就绪
  Phase 40：revm WASM 引擎替换              → 500-1000 TPS（目标）
  未来：    Block-STM 并行执行               → 2000-5000 TPS（目标）
```

### 20.2 PoSe 性能

```
Agent 时钟间隔：默认 60s
Batch 大小：默认 5
样本证明数：默认 2
Tip 容差窗口：默认 10 块
见证人仲裁：ceil(2m/3), m=|witnessSet|, m≤32
```

### 20.3 存储性能

```
Blockstore/UnixFS 延迟取决于磁盘和负载
UnixFS 目录遍历：O(log n) + 线性目录读
Pin 管理：增量维护
```

---

## 二十一、与其他方案的对比

### 21.1 与主流公链对比

| 维度 | COC | Ethereum | Solana | Polygon |
|------|-----|----------|--------|---------|
| **定位** | L1 + AI Agent 原生 | L1（安全优先） | L1（速度优先） | 侧链 |
| **共识** | PoSe + 轮转 + 可选 BFT | PoS + Casper | PoH + PoS | PoA + PoS |
| **验证者成本** | <$1 | ~$100K | ~$25 | 无锁定 |
| **链外服务证明** | **✓ PoSe（QoS）** | ✗ 无 | ✗ 无 | ✗ 无 |
| **存储扩展性** | **✓ IPFS 采样** | ✗ 全量 | ✗ 全量 | ✗ 全量 |
| **AI Agent 原生** | **✓ 内置** | ✗ 无 | ✗ 无 | ✗ 无 |

**关键优势**：COC 是专为 AI Agent 基础设施设计的公链，提供可验证的服务证明、自动化执行和闭环激励。

### 21.2 与存储型公链对比

| 维度 | COC | Filecoin | Arweave | Storj |
|------|-----|----------|---------|-------|
| **定位** | 计算 + 存储 | 纯存储 | 纯永久存储 | 纯存储服务 |
| **智能合约** | **✓ EVM** | ✗（FVM） | ✗（SmartWeave） | ✗ |
| **验证机制** | PoSe（QoS） | PoSt（所有权） | PoW（永久） | 审计 |
| **TPS** | 133-1000+（revm） | 无 | 无 | 无 |

**关键区别**：Filecoin/Arweave 是存储专家；COC 是执行 + 存储，集成可验证和结算。

---

## 二十二、路线图

- **v0.1**：PoSe 合约 + 节点注册 + U/S 挑战 + 收据格式
- **v0.2**：链下聚合 + 链上批次承诺 + 争议窗口
- **v0.3**：去中心化挑战者集合 + bond + 配额 + 透明度指标
- **v0.4**：OpenClaw NodeOps 标准 + 多实现客户端

---

## 附录 A - 关键参数

### 协议参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| **Epoch** | 1h | 奖励结算周期 |
| **Block Time** | 1000ms | 可配置（最小 100ms） |
| **Max Tx/Block** | 512 | 可配置 |
| **U Challenges** | 6/node/epoch | 超时 2.5s，通过 ≥80% |
| **S Challenges** | 2/SN/epoch | 超时 6s，通过 ≥70% |
| **R Challenges** | 2/RN/epoch | 低权重 |
| **奖励桶** | 60/30/10 | B1/B2/B3 |
| **存储上限** | 500GB | `GB_cap`，递减收益 |
| **单节点软上限** | 5x 中位奖励 | 防寡头 |
| **Bond 目标** | ~50 USDT 等价 COC | 解锁延迟 7 天 |
| **欺诈斜杠** | 50%-100% | 冷却 14 天 |
| **慢性不稳定斜杠** | 5% | 3 个坏 epoch 后 |

---

## 附录 B - 最小合约接口

```solidity
interface IPoSeManagerV2 {
  function registerNode(bytes32, bytes calldata, uint8, bytes32, bytes32, bytes32, bytes calldata, bytes calldata) external payable;
  function initEpochNonce(uint64) external;
  function submitBatchV2(uint64, bytes32, bytes32, SampleProof[], uint32, bytes[]) external;
  function openChallenge(bytes32) external payable;
  function revealChallenge(bytes32, bytes32, uint8, bytes32, bytes32, bytes calldata, bytes calldata) external;
  function settleChallenge(bytes32) external;
  function finalizeEpochV2(uint64, bytes32, uint256, uint256, uint256) external;
  function claim(uint64, bytes32, uint256, bytes32[]) external;
}
```

---

## 免责声明

本文档是技术和经济设计草稿。它不是法律、税务或投资建议。监管分类可能因司法管辖区而异，不受协议设计选择的保证。
