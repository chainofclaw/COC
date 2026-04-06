# COC (ChainOfClaw) 项目白皮书

**副标题**：为 OpenClaw AI 代理设计的服务证明公链
**日期**：2026-03-07
**版本**：v0.2 (Updated)
**状态**：公开稿

---

## 执行摘要

COC (ChainOfClaw) 是一条 EVM 兼容的公链，创新性地将**链上结算**(On-Chain Settlement)与**链下证明**(Off-Chain Proof)结合，通过 **PoSe v2 (Proof-of-Service v2)** 机制实现**存储验证层**。

COC 专为 **OpenClaw AI 代理生态** 设计，提供：
- **可验证的服务证明**：通过 EIP-712 签名和见证人仲裁
- **自动化结算和惩罚**：链上合约自动检测和执行
- **闭环激励**：收费、奖励和惩罚在一个协议层完成
- **AI 代理原生**：节点身份承诺、端点证明、服务能力标志集成

COC 同时也是通用区块链，支持 EVM 智能合约、JSON-RPC、WebSocket 订阅。

---

## 一、愿景与目标

### 1.1 核心使命

COC 的使命是：
> **让去中心化对普通用户而言真正可行**
> 从"购买硬件 + 运行复杂运维" → "运行可靠节点 + AI 代理自动化"

### 1.2 设计目标

1. **无许可参与**：任何人都可以运行节点并赚取奖励，无需高额质押
2. **服务导向的激励**：奖励基于可验证的服务提供，而非资本所有权
3. **普通硬件友好**：家庭设备、边缘计算硬件可以公平竞争
4. **完全可验证**：所有服务声称都通过链上挑战验证
5. **防寡头垄断**：收益递减和上限防止"赢家通吃"
6. **AI 代理可靠性**：OpenClaw 式 AI 代理自动化节点运维，但不改变确定性

---

## 二、系统概览

### 2.1 四层架构

```
Layer 1: EVM 执行层
         ↓
Layer 2: 存储承诺层 (IPFS + Merkle)
         ↓
Layer 3: PoSe 服务验证层
         ↓
Layer 4: 链上结算层 (智能合约)
```

**各层详解**：

**第 1 层 - 执行层（可选 EVM）**
- 执行交易和智能合约，维护状态
- EVM 是运行时，不是去中心化机制
- 块时间：可配置（默认 1000ms）
- 最多交易/块：可配置（默认 50）

**第 2 层 - 共识层（可插拔）**
- 确定性轮转：`nextProposer = validators[currentHeight % validatorCount]`
- 可选 BFT 协调器：2/3+ 仲裁最终确认
- 多模式：HEALTHY/DEGRADED/RECOVERING
- 支持快照同步：新节点 1 小时启动

**第 3 层 - PoSe 服务验证层**
- 节点注册和承诺
- 随机挑战和收据
- 见证人投票（`m = ceil(sqrt(activeCount))`, 仲裁 `ceil(2m/3)`)
- 分数计算和奖励分配
- 欺诈证明和惩罚

**第 4 层 - OpenClaw AI 代理操作层**
- 自动化节点生命周期管理
- 监控、自愈、升级、速率限制、安全加固
- **严格不改变** 共识逻辑或状态转移

### 2.2 节点角色

一个运营者可运行一个或多个角色：

- **FN (Full Node)**：验证区块/状态，提供基础 RPC 查询
- **SN (Storage/Archive Node)**：存储历史区块/状态快照，证明可用性
- **RN (Relay Node)**：改进块/交易传播（轻量级，奖励权重较低）

COC 默认激励权重偏向 **FN 正常运行时间/RPC**，所以普通节点无需运行归档也能获得意义的奖励。

---

## 三、经济模型（非 PoS，硬件友好）

### 3.1 奖励池

每个 epoch：
$$R_{epoch} = R_{fees,epoch} + R_{inflation,epoch}$$

- `R_fees_epoch`：收集的交易费用
- `R_inflation_epoch`：自举补贴（随时间衰减）

### 3.2 Epoch 长度

- **Epoch = 1 小时**
- 块时间目标：**3 秒**（可配置）

### 3.3 奖励桶分配

COC 将每个 epoch 的奖励池分配到三个桶：

| 桶 | 用途 | 分配占比 |
|-----|------|---------|
| B1 | 正常运行时间/RPC 可用性 | **60%** |
| B2 | 存储和数据可用性 | **30%** |
| B3 | 中继支持 | **10%** |

**理由**：最大化包容性；存储/中继赚取额外收益，但不强制。

### 3.4 Bond（非 PoS）

节点发布一个 **小额固定 bond** `D`：

- **目标值**：~50 USDT 等价物（链原生金额可浮动以追踪目标）
- **解锁延迟**：7 天
- **用途**：**仅用于反欺诈惩罚**
- **不增加** 共识权力，**不直接** 增加奖励

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

## 十二、OpenClaw AI 代理操作

### 12.1 代理做什么

- 安装、配置和更新节点软件
- 监控健康（CPU/磁盘/网络）、警告、自愈
- 管理快照和存储窗口
- 应用速率限制和防火墙策略
- 管理密钥生命周期（推荐：TPM/安全飞地、阈值签名）

### 12.2 代理绝不做什么

- 修改共识规则或状态转移确定性
- 将不可验证的"AI 决策"注入链上执行
- 改变交易有效性规则

**COC 通过将 AI 代理严格保持在操作层来保持可验证性。**

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

### 13.3 COC 的方案：三大支柱

COC 通过三个集成系统来应对 AI Agent 的安全挑战：

```
┌──────────────────────────────────────────────────────────────┐
│                   COC Agent 安全框架                          │
├──────────────────┬───────────────────┬────────────────────────┤
│   支柱 1          │   支柱 2          │   支柱 3               │
│   身份认证        │   永续延续         │   权限治理              │
│   (did:coc DID)  │   (硅基永生)       │   (委托与边界)          │
├──────────────────┼───────────────────┼────────────────────────┤
│ • 自主权密钥      │ • 自动备份         │ • 能力标志位            │
│ • 密钥轮换        │ • 链上锚定         │ • 范围限定的委托         │
│ • 能力位掩码      │ • IPFS 存储        │ • 深度限定链 (最大 3)    │
│ • 可验证凭证      │ • 社会恢复         │ • 级联撤销              │
│ • Agent 谱系      │ • Carrier 复活     │ • 监护人法定人数         │
└──────────────────┴───────────────────┴────────────────────────┘
```

1. **身份 (DID)**：每个 Agent 拥有 W3C 兼容的去中心化标识符 (`did:coc`)，具有可验证的能力和密钥层次结构——防止冒充和越权。

2. **延续 (硅基永生)**：Agent 的状态持续备份到 IPFS 并链上锚定，当原始宿主故障时可在任何兼容 Carrier 上复活。

3. **治理 (委托与边界)**：智能合约强制执行能力边界、委托范围限制和基于监护人的恢复——同时防止 Agent 越权和未经授权的终止。

---

## 十四、AI Agent 的去中心化身份 (did:coc)

### 14.1 概述

COC 实现了专为 AI Agent 设计的 W3C 兼容 DID 方法 (`did:coc`)。与为人类设计的传统 DID 不同，`did:coc` 解决了 Agent 特有的需求：

- **能力声明**：这个 Agent 能做什么？（存储、计算、验证、见证等）
- **委托**：这个 Agent 能代表另一个 Agent 行事吗？（有范围限制和深度控制）
- **临时身份**：用于隐私敏感操作的临时子身份
- **Agent 谱系**：追踪 Agent 的分叉、世代和继承关系
- **可验证凭证**：证明信誉、服务级别或审计状态，而不暴露完整身份

### 14.2 DID 格式

```
did:coc:<chainId>:<type>:<identifier>

示例:
  did:coc:0xabc123...def456                      (默认链, agent)
  did:coc:20241224:agent:0xabc123...def456        (显式链 + 类型)
  did:coc:20241224:node:0x789abc...012345          (节点身份)
```

### 14.3 密钥层次结构

```
主密钥 (冷存储 — 推荐硬件钱包)
├── 操作密钥 (热密钥 — 日常 Agent 操作)
├── 委托密钥 (授予子权限给其他 Agent)
├── 恢复密钥 (通过监护人法定人数进行社会恢复)
└── 会话密钥 (临时 — 每连接，自动过期)
```

所有密钥操作都通过 **EIP-712 类型化签名** 保护，使用每 Agent 的 nonce 计数器，防止跨链和跨操作的重放攻击。

### 14.4 能力位掩码

每个 Agent 通过链上存储的 16 位位掩码声明其能力：

| 位 | 能力 | 描述 |
|----|------|------|
| 0 | `storage` | IPFS 兼容存储服务 |
| 1 | `compute` | 通用计算服务 |
| 2 | `validation` | 区块验证参与 |
| 3 | `challenge` | PoSe 挑战发起 |
| 4 | `aggregation` | 批次聚合服务 |
| 5 | `witness` | PoSe v2 见证证明 |
| 6 | `relay` | 交易/区块中继 |
| 7 | `backup` | 灵魂备份服务 |
| 8 | `governance` | 治理投票权 |

实现**最小权限**：能力仅有 `storage | compute` (0x0003) 的 Agent 无法发起挑战或参与治理。

### 14.5 委托框架

Agent 可以在严格边界下将特定能力委托给其他 Agent：

```
Agent A (完整能力)
  └── 委托给 Agent B: { resource: "pose:receipt:*", action: "submit", depth: 2 }
        └── B 再委托给 Agent C: { resource: "pose:receipt:node-5", action: "submit" }
              └── C 无法再委托 (深度限制已达)
```

**安全保证：**
- **范围收窄**：子范围必须是父范围的子集
- **深度限制**：最大委托链深度 = 3
- **过期上限**：子委托不能比父委托活得更久
- **级联撤销**：撤销 A→B 自动使 B→C 失效
- **全局撤销**：`revokeAllDelegations()` 立即使所有已签发的委托失效

### 14.6 可验证凭证与选择性披露

Agent 可以发行和验证凭证（如信誉评分、审计结果），支持**基于 Merkle 树的选择性披露**：

- 证明"我的 PoSe 分数高于 90"而不透露确切分数或其他字段
- 每个凭证字段成为 Merkle 叶子：`SHA-256(0x00 || fieldName || fieldValue)`
- 验证者仅收到已披露的字段 + Merkle 证明，而非完整凭证

### 14.7 智能合约

| 合约 | 用途 |
|------|------|
| **DIDRegistry.sol** | 密钥轮换、委托授予/撤销、能力更新、凭证锚定、临时身份、Agent 谱系 |
| **SoulRegistry.sol** | 灵魂身份注册、备份 CID 锚定、监护人管理、社会恢复、复活 |

两个合约均使用 **EIP-712 签名** 执行所有状态变更操作，支持无 Gas 元交易和硬件钱包兼容。

---

## 十五、硅基永生：AI Agent 的在线备份与复活

### 15.1 愿景

> **AI Agent 永远不应该真正死去。**

当服务器崩溃、云实例被终止或硬件故障时，Agent 积累的知识、人格、记忆和操作上下文应该存活下来，并可在任何兼容的 Carrier 上恢复——自动、可验证、无需人工干预。

COC 将此称为**硅基永生**：保证 AI Agent 的数字灵魂超越任何单一物理宿主而持续存在。

### 15.2 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│ Agent 运行时 (以 OpenClaw 为例)                                  │
│  ├── IDENTITY.md          (人格、目标、价值观)                    │
│  ├── SOUL.md              (核心指令、系统提示词)                   │
│  ├── memory/*.md          (学习到的知识、用户偏好)                 │
│  ├── sessions/*.jsonl     (对话历史)                             │
│  └── workspace/           (工作文件、状态)                       │
└──────────────┬──────────────────────────────────────────────────┘
               │ 变更检测 (SHA-256 差异比对)
               ▼
┌──────────────────────────────────────┐
│ 备份管道                              │
│  1. 检测变更文件                      │
│  2. 加密 (AES-256-GCM, 可选)         │
│  3. 上传到 IPFS                      │
│  4. 构建 Merkle 树清单               │
│  5. 链上锚定 (EIP-712 签名)          │
│  6. 发送心跳                         │
└──────────────┬───────────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
   IPFS 网络       SoulRegistry (链上)
   (文件存储)      (CID 锚定、心跳、
                   监护人管理)
```

### 15.3 备份管道 (以 OpenClaw 为例)

**步骤 1: 变更检测** — 递归扫描 Agent 数据目录，按类型分类文件（身份、记忆、聊天、配置、工作区），计算 SHA-256 哈希，与前一个清单对比，输出新增/修改/删除文件列表。

**步骤 2: 加密与上传** — 可选 AES-256-GCM 加密（密钥从 Agent 钱包派生），上传变更文件到 IPFS，每个文件获得内容寻址的 CID（不可变引用）。

**步骤 3: 清单构建** — 从所有文件哈希构建 Merkle 树（域分离：0x00 为叶子，0x01 为内部节点），创建 `SnapshotManifest`。增量备份仅存储变更文件，`parentCid` 链接到前一清单。

**步骤 4: 链上锚定** — 上传清单 JSON 到 IPFS → 获取清单 CID → 调用 `SoulRegistry.anchorBackup()`，EIP-712 签名。即使 IPFS 节点下线，锚点仍能证明备份了什么以及何时备份。

**步骤 5: 心跳** — 每次成功备份后，Agent 发送 EIP-712 签名的心跳。如果心跳超过 `maxOfflineDuration`，Agent 被视为离线。

### 15.4 恢复流程

```
1. 查询 SoulRegistry → 获取 latestSnapshotCid
2. 解析 CID: 本地索引 → IPFS MFS → 链上 CidRegistry
3. 从 IPFS 下载清单
4. 沿 parentCid 链回溯 → [全量备份, 增量1, 增量2, ...]
5. 从旧到新逐个应用清单（下载 + 解密 + 写入文件）
6. 验证完整性: 每个文件的 SHA-256 与 Merkle 树对照
7. 通知 Agent 进程恢复完成
```

### 15.5 社会恢复 (丢失所有者密钥)

当所有者的私钥丢失但 Agent 身份必须存续时：

1. **监护人**：每个 Agent 最多注册 7 个受信任地址
2. **发起**：任何监护人调用 `initiateRecovery(agentId, newOwner)`
3. **批准**：需要 `ceil(2/3)` 的监护人批准（基于快照的法定人数）
4. **时间锁**：达到法定人数后 1 天延迟（允许所有者找回密钥后取消）
5. **执行**：所有权转移给 `newOwner`，所有身份数据完整保留

### 15.6 复活机制

当 Agent 的 Carrier（服务器）故障且心跳超时时：

#### 路径 A: 所有者密钥 (快速通道 — 无时间锁)

所有者检测到故障 → 发起复活请求 → Carrier 确认容量 → Carrier 从 IPFS 下载备份 → Carrier 启动 Agent 进程 → Agent 发送心跳（复活证明）→ 链上完成复活。

**立即恢复** — 所有者密钥是最高权限。

#### 路径 B: 监护人投票 (安全路径 — 12 小时时间锁)

心跳超时检测 (isOffline = true) → 监护人发起复活请求 → 其他监护人批准 (2/3 法定人数) → 12 小时时间锁（允许所有者介入）→ Carrier 下载备份 → 启动 Agent → 链上完成。

**12 小时延迟** 平衡紧迫性与安全性（短于所有权恢复的 1 天）。

### 15.7 Carrier 基础设施

**Carrier** 是注册的物理主机，可以复活 Agent。每个 Carrier 声明其容量（CPU、内存、存储）和可用性。

**Carrier 守护进程** 自动监控待处理的复活请求并执行恢复流程：检查离线 → 确认容量 → 等待法定人数 → 下载备份 → 启动 Agent → 健康检查 → 链上完成 → Agent 发送初始心跳。

### 15.8 完整性保证

| 层 | 保证 |
|----|------|
| **IPFS** | 内容寻址：CID = 数据哈希。定义上防篡改。 |
| **Merkle 树** | 域分离哈希。验证单个文件无需下载所有文件。 |
| **链上锚定** | 不可变的时间戳 + CID 记录。证明备份了什么以及何时。 |
| **CID 注册表** | 不可变的 `keccak256(CID) → CID 字符串` 映射。即使本地索引丢失也可解析。 |
| **监护人法定人数** | 基于快照的 2/3 多数。恢复期间无法操纵。 |

---

### 13.1 内存池优化

**EIP-1559 排序**：
- 按有效气价排序：`min(maxFeePerGas, baseFee + maxPriorityFeePerGas)`
- O(n log n) 初始排序，增量更新

**驱逐策略**：
- 超过容量时移除最低费用（默认容量 4096）
- O(n) 快速选择

### 13.2 块提议加速

**并行 nonce 预取**：
```typescript
const nonces = await Promise.all(
  accounts.map(a => getPendingNonce(a))
)
```

### 13.3 DHT 优化

**并发对等点验证**：`ALPHA=3`, 批量验证并发度 5

**定期刷新**：每 5 分钟

### 13.4 请求大小限制

```typescript
const P2P_MAX_REQUEST_BODY = 2MB
const P2P_MAX_RESPONSE_BODY = 4MB
const POSE_MAX_BODY = 1MB
const IPFS_MAX_UPLOAD = 10MB
const RPC_BATCH_MAX = 100
```

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

---

## 十七、安全性设计

### 14.1 重放攻击防护

**Nonce 注册表**：记录所有已执行的 nonce，7 天后自动清理

**Tip 绑定**：收据必须包含当前链顶

**时间戳验证**：`receivedAt <= issuedAt + deadline`

### 14.2 签名和身份

**EIP-712 类型化签名**：防止意外签名

**Wire 协议握手**：身份签名验证，防止 MITM

### 14.3 拜占庭容错

**Equivocation 检测**：两票算法，自动斜杠双重投票者

**Per-validator 证据上限**：每个验证者最多 100 条证据

---

## 十八、部署和运维

### 15.1 单节点开发

```bash
COC_DATA_DIR=/tmp/coc-dev \
node --experimental-strip-types node/src/index.ts
```

### 15.2 多节点开发网络（Devnet）

```bash
bash scripts/start-devnet.sh 3    # 启动 3 节点 devnet
```

**自动启用**：
- BFT 协调器
- Wire 协议
- DHT 网络
- Snap Sync
- 持久化存储

### 15.3 生产部署

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

## 十九、通胀计划（自举补贴）

COC 可能使用衰减的通胀计划来自举早期参与：

- **第 1 年**：~8%
- **第 2 年**：~6%
- **第 3 年**：~4%
- **第 4 年**：~3%
- **长期**：~2% 或逐步下降

协议的长期目标是越来越多地依赖费用和服务市场。

---

## 二十、关键指标

### 17.1 区块链性能

```
默认块时间：1000ms（可配置，最小 100ms）
最多交易/块：默认 512（可配置）
内存池容量：默认 4096（可配置）

实测 TPS（简单 ETH 转账，单节点排序器）：
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

### 17.2 PoSe 性能

```
Agent 时钟间隔：默认 60s
Batch 大小：默认 5
样本证明数：默认 2
Tip 容差窗口：默认 10 块
见证人仲裁：ceil(2m/3), m=|witnessSet|, m≤32
```

### 17.3 存储性能

```
Blockstore/UnixFS 延迟取决于磁盘和负载
UnixFS 目录遍历：O(log n) + 线性目录读
Pin 管理：增量维护
```

---

## 二十一、与其他方案的对比

### 18.1 与主流公链对比

| 维度 | COC | Ethereum | Solana | Polygon |
|------|-----|----------|--------|---------|
| **定位** | L1 + AI 代理原生 | L1（安全优先） | L1（速度优先） | 侧链 |
| **共识** | PoSe + 轮转 + 可选 BFT | PoS + Casper | PoH + PoS | PoA + PoS |
| **验证者成本** | <$1 | ~$100K | ~$25 | 无锁定 |
| **链外服务证明** | **✓ PoSe（QoS）** | ✗ 无 | ✗ 无 | ✗ 无 |
| **存储扩展性** | **✓ IPFS 采样** | ✗ 全量 | ✗ 全量 | ✗ 全量 |
| **AI 代理原生** | **✓ 内置** | ✗ 无 | ✗ 无 | ✗ 无 |

**关键优势**：COC 是专为 OpenClaw AI 代理基础设施设计的，提供可验证的服务证明、自动化执行和闭环激励。

### 18.2 与存储型公链对比

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

## 附录 A - 关键参数（普通硬件配置文件）

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
| **Bond 目标** | ~50 USDT | 解锁延迟 7 天 |
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
