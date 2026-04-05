# COC 公链技术白皮书

## 执行摘要

COC (ChainOfClaw) 是一条 EVM 兼容的公链，创新性地将**链上结算**(On-Chain Settlement)与**链下证明**(Off-Chain Proof)结合，通过 PoSe (Proof-of-Service) 机制实现**存储证明层**。
COC 的目标不是做”通用叙事”的公链复制，而是为 OpenClaw AI Agent 生态提供可验证服务与自动结算的基础设施。

核心创新：
- **PoSe v2 协议**：使用 EIP-712 签名和见证人仲裁的无许可故障证明
- **IPFS 兼容存储**：每个区块链节点都可以存储和验证数据
- **OpenClaw AI Agent 原生设计**：COC 作为 AI Agent 的信任与结算底座，提供可验证服务证明、自动奖惩与身份注册基础设施（Agent-to-Agent 协作编排待后续版本）
- **多层共识**：支持确定性轮转、降级模式、可选 BFT 协调器
- **混合网络**：HTTP 八卦协议 + TCP Wire 协议 + DHT 网络同时运行

---

## 一、核心思路

### 1.1 问题陈述

传统公链面临三个关键问题：

1. **存储扩展性差**：每个节点必须存储所有历史数据，导致节点运行成本高企
2. **数据可用性无法保证**：没有机制验证链下存储是否真实存在
3. **共识高度依赖单一机制**：BFT 过于复杂，PoW 过于浪费，中间方案缺乏

### 1.2 解决方案设计

COC 采用**分层验证架构**：

```
Layer 1: EVM Layer (链上计算)
         ↓
Layer 2: Storage Challenge (IPFS 存储挑战)
         ↓
Layer 3: PoSe Proofs (链下服务证明)
         ↓
Layer 4: On-Chain Settlement (Merkle 验证与结算)
```

**核心思路**：
- **IPFS CID 作为 PoSe 存储挑战输入**，验证节点数据可用性（非通用链上内容所有权注册）
- **验证者通过 PoSe 挑战证明数据存在**
- **链下 runtime 构造客观故障证据，链上合约负责验证并执行惩罚**
- **无需全量存储，只需随机采样验证**
- **为 OpenClaw AI Agent 生态设计**：提供 Agent 身份注册、节点绑定与服务证明基础设施（协作调度与结算归属待后续版本闭环）

---

## 二、技术路线

### 2.1 分层架构

#### Layer 1: 区块链引擎 (`node/src/`)

**接口导向设计**：所有组件基于 `IChainEngine` 接口，支持多种实现：

```typescript
interface IChainEngine {
  // 核心查询
  getTip(): ChainBlock | null
  getHeight(): bigint
  getBlockByNumber(number: bigint): ChainBlock | null

  // 区块生产和应用
  proposeNextBlock(): Promise<ChainBlock | null>
  applyBlock(block: ChainBlock): Promise<void>

  // 可选：存储层支持
  getLogs?(filter: LogFilter): Promise<IndexedLog[]>
  getTransactionByHash?(hash: Hex): Promise<TxWithReceipt | null>
}
```

**两种实现**：
1. **ChainEngine**：完全内存实现，用于单节点开发
2. **PersistentChainEngine**：LevelDB 持久化实现，用于生产环节

**EVM 执行**：
- 基于 `@ethereumjs/vm` 构建
- 支持**可检查点的状态**（快照同步用）
- 所有账户状态、存储槽、字节码均持久化

#### Layer 2: 共识引擎 (`consensus.ts`)

采用**多模式共识**，自动在三个状态间切换：

```
HEALTHY  ←→  DEGRADED  ←→  RECOVERING
  ↓
 Normal block production
 at blockTimeMs interval
```

**HEALTHY（正常）模式**：
- 确定性轮转：`nextProposer = validators[currentHeight % validatorCount]`
- 每个验证者轮流提议区块
- 块间隔由 `blockTimeMs` 控制（默认 3000ms，可配置）

**DEGRADED（降级）模式**：
- 触发条件：连续 5 次提议或同步失败
- 行为：降低要求，接受任何节点的提议
- 用途：容错和故障恢复

**RECOVERING（恢复）模式**：
- 触发条件：等待 30 秒冷却后重试
- 行为：从头开始验证链，重新启动共识

#### Layer 3: P2P 网络 (`p2p.ts`, `wire-protocol.ts`, `dht-network.ts`)

**三层网络并行**：

1. **HTTP 八卦协议**（传统）
   - 无连接，基于 RESTful 端点
   - 内置去重（`seenTx=50,000`，`seenBlocks=10,000`）
   - 请求体大小限制（默认 2MB）

2. **Wire 协议**（优化）
   - TCP 长连接，帧化传输
   - Magic 字节 0xC0C1，安全握手
   - 身份签名验证，防止中间人攻击
   - 连接数可配置（出站默认 25、入站默认 50，且每 IP 最多 5）

3. **DHT 网络**（发现）
   - Kademlia 路由表（每个距离桶 20 个节点）
   - 迭代查询，K 进制树逐层向下
   - 定期刷新（默认 5 分钟）与周期公告（默认 3 分钟），并持久化 peer

**跨协议中继**：
- 通过 `onTxRelay`、`onBlockRelay` 回调实现
- 交叉验证去重（两层都有 BoundedSet）
- 防止消息风暴

#### Layer 4: PoSe 结算层 (`services/`, `contracts/`)

见下文详述。

### 2.2 存储架构

#### 持久化存储层 (`storage/`)

**LevelDB 为基础**：

1. **BlockIndex** - 块和交易索引
   - `blocks/{height}` → ChainBlock
   - `txIndex/{txHash}` → {blockNumber, index, receipt}
   - `accountTxs/{address}/{blockNumber}` → 地址历史

2. **StateTrie** - EVM 状态树
   - Merkle Patricia Trie 实现
   - 账户状态（nonce, balance, codeHash）
   - 存储槽（address → slot → value）
   - 字节码（codeHash → bytecode）
   - 支持检查点/回滚

3. **NonceStore** - 重放攻击防护
   - 记录所有已执行的 nonce
   - 7 天自动清理
   - 跨重启持久化

#### IPFS 兼容存储 (`ipfs-*.ts`)

**设计原则**：完全兼容 IPFS HTTP API，但简化实现。

**子系统**：

1. **Blockstore** - 内容寻址存储
   - 按 CID 存储块（Qm... 哈希）
   - DAG 和 Raw 块类型
   - Pin 管理（垃圾回收）

2. **UnixFS** - POSIX 文件布局
   - 文件元数据（大小、权限、修改时间）
   - 目录（merkle 树 + 链表）
   - Symlink 和硬链接
   - DAG 组织（文件分片）

3. **Mutable FileSystem (MFS)** - 可变文件系统
   - 支持 mkdir, write, read, ls, rm, mv, cp, stat, flush
   - 即时操作无需重新计算 CID
   - 后台异步 flush

4. **Pub/Sub** - 发布-订阅消息
   - 主题订阅
   - P2P 中继转发
   - 消息去重（最近 1000 条）
   - 环形缓冲（避免内存泄漏）

5. **HTTP Gateway** - REST API
   - `/ipfs/<cid>` - 获取文件
   - `/api/v0/add` - 上传文件
   - `/api/v0/get` - 下载+TAR 格式
   - MFS 路由：`/mfs/read`, `/mfs/write` 等
   - Pubsub 路由：`/pubsub/pub`, `/pubsub/sub`

---

## 三、独特功能详述

### 3.1 PoSe v2 协议

#### 为什么需要 PoSe？

1. **无中心方**：任何人都可以成为验证者
2. **可验证**：链上合约自动检测故障和惩罚
3. **低成本**：不需要 PoW 的计算；相比主流 PoS 质押门槛更低，但注册节点仍需保证金（bond）
4. **服务质量**：通过重复挑战测试节点可靠性

#### 四层流程

**流程 1：挑战生成** (`services/challenger/`)

```typescript
interface ChallengeMessageV2 {
  version: 2
  challengeId: Hex32          // 唯一标识
  epochId: bigint             // 服务周期
  nodeId: Hex32               // 被测试的节点
  challengeType: "U" | "S" | "R" // Uptime / Storage / Relay
  nonce: Hex32                // 16-byte 随机数（0x 前缀）
  challengeNonce: bigint      // epoch nonce（链上快照）
  querySpec: {                // 查询规范
    // Uptime:
    method?: "eth_blockNumber"
    minBlockNumber?: number
    // Storage:
    cid?: string
    chunkIndex?: number
    merkleRoot?: string
    proofSpec?: "merkle-path"
    // Relay:
    routeTag?: string
    expectedHop?: number
  }
  querySpecHash: Hex32        // 规范的 Merkle 哈希
  issuedAtMs: bigint
  deadlineMs: number          // 相对截止期（当前默认 U/R=2500ms, S=6000ms）
  challengerId: Hex32         // 发起者
  challengerSig: string       // EIP-712 签名
}
```

**随机数生成策略**：
- 合约 owner 先调用 `initEpochNonce(epochId)`，将 `block.prevrandao` 快照为 `challengeNonces[epochId]`
- 挑战方读取该 epoch nonce 作为 `challengeNonce`
- 生产环境应保证每个 epoch 先初始化 nonce，避免挑战熵退化

**流程 2：收据验证** (`services/verifier/`)

```typescript
interface ReceiptMessageV2 {
  challengeId: Hex32
  nodeId: Hex32
  responseAtMs: bigint
  responseBody: {             // 实际响应
    data?: string             // 返回的块/数据
    proof?: string[]          // Merkle 路径
  }
  responseBodyHash: Hex32     // 响应哈希
  tipHash: Hex32              // 节点当前链顶
  tipHeight: bigint           // 区块高度（绑定）
  nodeSig: string             // 节点 EIP-712 签名
}
```

**验证步骤**：
1. 验证挑战消息的 challenger EIP-712 签名
2. 校验 challenge/receipt 字段匹配与时间窗（`issuedAt <= responseAt <= issuedAt+deadline`）
3. 验证收据的 node EIP-712 签名（含 `tipHash/tipHeight/responseBodyHash`）
4. Tip 绑定：`tipHeight` 与当前链头高度差不得超过容忍窗口（默认 10 块）
5. 按挑战类型执行专属校验（Uptime/Storage/Relay）
6. 校验 witness 签名与法定人数
7. 通过后记录到 `verifiedReceipts[]`

**结果代码**：
```typescript
const ResultCode = {
  Ok: 0,              // ✓ 成功
  Timeout: 1,         // ✗ 超时
  InvalidSig: 2,      // ✗ 签名错误
  StorageProofFail: 3,// ✗ 存储验证失败
  RelayWitnessFail: 4,// ✗ 见证人中继失败
  TipMismatch: 5,     // ✗ 链顶不匹配（重放攻击）
  NonceMismatch: 6,   // ✗ 随机数错误
  WitnessQuorumFail: 7, // ✗ 见证人不足
}
```

**流程 3：见证人投票** (`runtime/lib/witness-collector.ts` + 合约 witness set)

**创新：分布式仲裁**

挑战可能产生网络延迟、临时故障。因此引入**见证人集群**来确认：

1. **见证人集合大小**：`m = ceil(sqrt(activeNodeCount))`，并限制 `m <= 32`
   - 例如 100 个活跃节点 → 10 个见证人
   - 样本小，成本低

2. **选择方式**：链上基于 `challengeNonces[epochId]` 伪随机选取
   - `idx = keccak256(nonce, i) % activeCount`，去重后取前 m 个
   - 同一 epoch nonce 下结果确定性一致

3. **仲裁阈值**：`quorum = ceil(2m / 3)`
   - 需要 2/3+ 见证人同意
   - BFT 式容错

4. **过渡开关**：合约支持 `allowEmptyWitnessSubmission`（当前默认 false）
   - 过渡期允许空 witness 提交
   - 生产建议在 witness 集稳定后切到 strict（false）

5. **见证人消息**：
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

**流程 4：Merkle 批处理和链上结算** (`services/aggregator/`)

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

1. 收集 N 个 EvidenceLeaf（由 agent `batchSize` 决定，当前默认 5）
2. 构建 Merkle 树
3. 生成 Merkle 根、summaryHash 与 sampleProofs（sampleSize 当前默认 2）
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
  // 1. 验证 witness quorum（可配置 strict/transition）
  // 2. 验证 sampleProofs 与 summaryHash
  // 3. 记录 batch，进入 dispute window
}
```

**斜杠分布**（每 epoch 最多 5%）：
- 50% 销毁
- 30% 分给举报者
- 20% 分给保险基金

#### 无许可故障证明（Permissionless Fault Proof）

任何人都可以挑战聚合器的 Merkle 树：

```typescript
enum FaultType {
  DoubleSig = 1,      // 预留：当前 reveal 路径不接受
  InvalidSig = 2,     // 签名验证失败
  TimeoutMiss = 3,    // 说成功但实际超时
  BatchForgery = 4,   // 伪造的 Merkle 叶
}
```

**挑战流程**：
1. `openChallenge(commitHash)` 提交挑战 bond（最小值由合约参数控制）
2. `revealChallenge(...)` 提交解密后的客观证据（含 batch/merkle/leaf）
3. 进入 adjudication window 后调用 `settleChallenge(challengeId)`
4. 若故障成立：按规则 slash 目标节点并返还挑战者 bond + 奖励；否则 bond 计入 insurance

### 3.2 混合共识机制

#### 确定性轮转（Deterministic Rotation）

```typescript
function expectedProposer(nextHeight: bigint): string {
  const activeValidators = getActiveValidators()
  const index = Number(nextHeight % BigInt(activeValidators.length))
  return activeValidators[index].address
}
```

**优点**：
- 完全确定，无需共识消息
- 验证者可以预知轮次
- 故障排除容易

**缺点**：
- 如果一个验证者宕机，需要等待它的轮次
- 解决：降级模式自动接受其他提议

#### 可选 BFT 协调器（BFT Coordinator）

如果启用 `enableBft: true`，在确定性轮转之上层叠 BFT：

```
Proposer gets turn
        ↓
Broadcast block via BFT round
        ↓
Need 2/3+ votes to finalize
        ↓
If no quorum → timeout → next proposer
```

**BFT 消息**：
```typescript
interface BftMessage {
  height: bigint
  round: number
  type: "Propose" | "Prepare" | "Commit"
  blockHash: string
  signature: string           // 签名，防止变造
}
```

**PBFT 风格流程**：
1. **Prepare** - 收集 2/3+ 投票，确认块有效
2. **Commit** - 收集 2/3+ 承诺，最终确认块
3. **Timeout** - 10s 无进展则跳过

**防护**：
- **Equivocation Detector**：检测双重投票，自动斜杠
- **Signature Verification**：所有消息都必须有效签名
- **Per-validator evidenceBuffer**：每个验证者最多保存 100 条证据（防止 Sybil）

#### 快照同步（Snap Sync）

当新节点加入时：

```
1. 请求状态快照（包括账户、存储、字节码）
2. 导入状态到 StateTrie
3. 设置状态根为已知好值
4. 异步同步相邻块
5. 恢复共识
```

**快照包含**：
```typescript
interface StateSnapshot {
  stateRoot: string
  blockHeight: string
  blockHash: string
  accounts: Array<{
    address: string
    nonce: string
    balance: string
    storageRoot: string
    codeHash: string
    storage: Array<{ slot: string; value: string }>
    code?: string
  }>
  validators?: ValidatorRecord[]
}
```

**验证**：
- 块哈希必须在本地链上
- 状态根 hash 必须验证通过
- 治理信息一致性检查

### 3.3 EVM 兼容性

#### 支持的功能

1. **所有 EVM 操作码**（PUSH, DUP, SWAP, 算术等）
2. **智能合约**（Solidity, Vyper）
3. **JSON-RPC 接口**（57+ 方法）
   - `eth_call` - 无状态调用
   - `eth_sendTransaction` - 提交交易
   - `eth_getBalance`, `eth_getCode` - 查询
   - `debug_traceTransaction` - 交易跟踪
   - `eth_subscribe` - WebSocket 订阅

4. **EIP-1559 动态手续费**
   - 基础费用：`baseFee = prevBaseFee + (parentGasUsed - targetGas) / parentGasUsed * baseFee / 8`
   - 优先级费用：`maxPriorityFeePerGas`
   - 最大费用：`maxFeePerGas`

5. **Keccak-256 哈希**
6. **椭圆曲线操作**（ECDSA 恢复）
7. **ABI 编码/解码**

#### PoSe 特定的合约接口

```solidity
interface IPoSeManagerV2 {
  function registerNode(
    bytes32 nodeId,
    bytes calldata pubkeyNode,
    uint8 serviceFlags,
    bytes32 serviceCommitment,
    bytes32 endpointCommitment,
    bytes32 metadataHash,
    bytes calldata ownershipSig,
    bytes calldata endpointAttestation
  ) external payable;

  function initEpochNonce(uint64 epochId) external;

  function submitBatchV2(
    uint64 epochId,
    bytes32 merkleRoot,
    bytes32 summaryHash,
    SampleProof[] calldata sampleProofs,
    uint32 witnessBitmap,
    bytes[] calldata witnessSignatures
  ) external returns (bytes32 batchId);

  function openChallenge(bytes32 commitHash) external payable returns (bytes32 challengeId);

  function revealChallenge(
    bytes32 challengeId,
    bytes32 targetNodeId,
    uint8 faultType,
    bytes32 evidenceLeafHash,
    bytes32 salt,
    bytes calldata evidenceData,
    bytes calldata challengerSig
  ) external;

  function settleChallenge(bytes32 challengeId) external;

  function finalizeEpochV2(
    uint64 epochId,
    bytes32 rewardRoot,
    uint256 totalReward,
    uint256 slashTotal,
    uint256 treasuryDelta
  ) external;

  function claim(uint64 epochId, bytes32 nodeId, uint256 amount, bytes32[] calldata merkleProof) external;
}
```

### 3.4 性能优化

#### 1. 内存池优化

**EIP-1559 排序**：
- 按有效气价排序（min(maxFeePerGas, baseFee + maxPriorityFeePerGas)）
- O(n log n) 初始排序，后续增量更新

**驱逐策略**：
- 达到容量上限时，移除最低有效气价交易（默认池容量 4096，可配置）
- O(n) 快速选择（而非 O(n log n) 排序）

#### 2. 块提议加速

**并行 nonce 预取**：
```typescript
// 顺序很重要，但可以预取所有地址的 nonce
const nonces = await Promise.all(
  accounts.map(a => getPendingNonce(a))
)
```

#### 3. DHT 优化

**并发对等点验证**：
- 迭代查询并行度 `ALPHA=3`
- 候选节点验证采用并发批处理（默认并发 5）

**定期刷新**：
- 每 5 分钟刷新 DHT 路由表
- 去掉死节点，发现新邻居

#### 4. 请求大小限制

```typescript
const P2P_MAX_REQUEST_BODY = 2 * 1024 * 1024     // 2MB
const P2P_MAX_RESPONSE_BODY = 4 * 1024 * 1024    // 4MB
const POSE_MAX_BODY = 1024 * 1024                // 1MB
const IPFS_MAX_UPLOAD_SIZE = 10 * 1024 * 1024    // 10MB
const RPC_BATCH_MAX = 100                        // 100 items per batch
```

#### 5. 缓冲管理

**FrameDecoder 缓冲紧缩**：
```typescript
// 如果使用量 < 1/4，则重新分配
if (buffer.byteLength > 4 * bytesUsed) {
  buffer = new Uint8Array(buffer.buffer, offset, usedLength)
}
```

---

## 四、安全性设计

### 4.1 重放攻击防护

#### 1. Nonce 注册表

```typescript
class PersistentNonceStore {
  async recordTx(address: string, nonce: bigint, height: bigint): Promise<void>
  async hasBeenUsed(address: string, nonce: bigint): Promise<boolean>
  async cleanup(beforeHeight: bigint): Promise<void>  // 7 天后清理
}
```

**工作原理**：
- 每笔交易执行时，记录 (address, nonce)
- 后续收到相同 nonce 的交易，立即拒绝
- 7 天后自动清理（跨节点重启）

#### 2. 链顶绑定（Tip Binding）

PoSe 收据必须包含节点当前的链顶：

```typescript
interface ReceiptMessageV2 {
  tipHash: Hex32      // 当前块哈希
  tipHeight: bigint   // 当前块高
  ...
}
```

验证：
```typescript
// 允许窗口：tipHeight 与当前链头差值不超过阈值（默认 10）
const diff = abs(receipt.tipHeight - currentTipHeight)
if (diff > tipToleranceBlocks) {
  return ResultCode.TipMismatch
}
```

#### 3. 时间戳验证

```typescript
const issuedAt = challenge.issuedAtMs
const deadline = challenge.deadlineMs
const receivedAt = receipt.responseAtMs

if (receivedAt > issuedAt + deadline) {
  return ResultCode.Timeout
}
```

### 4.2 签名和身份

#### EIP-712 类型化签名

```typescript
// 定义签名类型
const types = {
  ChallengeMessage: [
    { name: 'version', type: 'uint8' },
    { name: 'challengeId', type: 'bytes32' },
    { name: 'epochId', type: 'uint64' },
    { name: 'nodeId', type: 'bytes32' },
    { name: 'querySpecHash', type: 'bytes32' },
    // ... 更多字段
  ]
}

// 签名时
const signature = await signer.signMessage(
  types,
  challenge
)

// 验证时
const recoveredAddress = verifier.recoverAddress(
  types,
  challenge,
  signature
)
```

**优点**：
- 防止意外签名（类型信息清晰）
- 可读性高（Metamask 可解析）
- 链外验证安全

#### Wire 协议握手

```typescript
// 1. 客户端发送身份
ClientHandshake {
  publicKey: string
  timestamp: bigint
  clientSignature: string     // sign(publicKey + timestamp)
}

// 2. 服务器验证和响应
ServerHandshake {
  publicKey: string
  timestamp: bigint
  serverSignature: string
}

// 3. 防止身份切换
if (peer.handshakeComplete && newHandshake.publicKey !== peer.publicKey) {
  socket.destroy()  // 断开连接
}
```

### 4.3 拜占庭容错

#### Equivocation 检测

两票算法：某个验证者为不同的块投票？

```typescript
class EquivocationDetector {
  onBftVote(vote: BftVote): { slashable: boolean; evidence: EquivocationEvidence | null } {
    // 同一 (height, round) 两个不同的 blockHash
    if (seenVotes.has(key)) {
      const previous = seenVotes.get(key)
      if (previous.blockHash !== vote.blockHash && previous.signature !== vote.signature) {
        return { slashable: true, evidence: { vote1, vote2 } }
      }
    }
    seenVotes.set(key, vote)
    return { slashable: false, evidence: null }
  }
}
```

**自动斜杠**：
```typescript
const validator = governance.getValidator(evidence.signer)
governance.applySlash(validator.id, slashAmount)
governance.deactivateValidator(validator.id)
```

#### Per-validator Evidence Cap

```typescript
// 防止存储耗尽
const maxPerValidator = 100

class EquivocationDetector {
  recordEvidence(validatorId: string, evidence: Evidence): void {
    if (!evidenceByValidator[validatorId]) {
      evidenceByValidator[validatorId] = []
    }
    const buf = evidenceByValidator[validatorId]
    buf.push(evidence)
    if (buf.length > maxPerValidator) {
      buf.shift()  // 移除最旧的
    }
  }
}
```

### 4.4 HTTP 服务器硬化

```typescript
// 4-2 http server hardening

const server = http.createServer(...)

// Slowloris 防护
server.headersTimeout = 10_000      // 10s
server.requestTimeout = 30_000      // 30s
server.keepAliveTimeout = 5_000     // 5s

// 请求体大小限制（按子系统）
const p2pMaxBody = 2 * 1024 * 1024      // 2MB
const poseMaxBody = 1024 * 1024         // 1MB
const ipfsMaxUpload = 10 * 1024 * 1024  // 10MB

// 速率限制（每 IP，按子系统）
const p2pRateLimiter = new RateLimiter(60_000, 240)
const poseRateLimiter = new RateLimiter(60_000, 60)
const ipfsRateLimiter = new RateLimiter(60_000, 100)
if (!p2pRateLimiter.allow(clientIp)) {
  res.writeHead(429)
  return
}
```

---

## 五、扩展性路线图

### 近期（Phase 36-40）

1. **多链桥接**：支持其他 L1 的资产跨链
2. **智能合约优化**：内联缓存、字节码预预编译
3. **并行执行**：多线程 EVM 执行（非共享状态）

### 中期（Phase 41-50）

1. **Rollup 集成**：支持 OP Stack / Arbitrum Orbit
2. **数据可用性采样**：DAS（Data Availability Sampling）
3. **同态加密**：隐私交易

### 远期（Phase 51+）

1. **量子安全密码学**
2. **跨链原子组合**
3. **zk-SNARK 批证明**

---

## 六、与其他方案对比

### 6.1 对比方法与边界

为保证结论可验证、可复核，本章采用以下原则：

1. 只比较**协议设计与公开机制**，不比较短期市场价格与营销口径。
2. 外部网络的吞吐、费用、验证者规模会随版本和市场变化，本章避免把瞬时数据写成固定事实。
3. 结论强调“**场景适配**”而非“绝对优劣”。
4. 关键事实以官方文档或主流生态规范文档为准（例如 Ethereum 质押门槛、Polygon PoS checkpoint 机制、Optimistic Rollup 提现挑战窗口、Filecoin FVM、Arweave SmartWeave/AO）。

### 6.2 与主流公链对比（按架构取舍）

| 维度 | COC | Ethereum | Solana | Polygon PoS | Arbitrum / Optimism |
|------|-----|----------|--------|-------------|---------------------|
| **架构层级** | L1 | L1 | L1 | Ethereum 侧链（PoS，向 Ethereum 提交 checkpoint） | Optimistic Rollup（L2） |
| **执行环境** | EVM | EVM | SVM | EVM | EVM |
| **核心共识/排序** | 轮转出块 + 可选 BFT + PoSe 结算层 | PoS（Gasper） | PoH + PoS（Tower BFT） | PoS 验证者集 + Bor/Heimdall | L2 Sequencer + 欺诈证明机制 |
| **节点参与约束** | 无许可参与（需 bond 与协议约束） | 独立验证者需满足 32 ETH 质押门槛 | 协议无固定最小质押，但验证者竞争受硬件与投票成本影响 | 需满足验证者集合与质押规则 | 参与角色受 Rollup 治理与桥接/证明机制约束 |
| **离链服务可验证性** | 原生 PoSe（challenge / witness / slash） | 无原生离链存储 QoS 证明 | 无原生离链存储 QoS 证明 | 无原生离链存储 QoS 证明 | 重点验证状态转换正确性，不覆盖存储服务 QoS |
| **最终性/提现语义** | 原生最终性由 `blockTimeMs` + `finalityDepth` 决定 | PoS 经济最终性 | 快速概率最终性 | 链内最终性 + 依赖 Ethereum checkpoint 语义 | 提现通常受挑战窗口影响（主网常见约 7 天） |
| **生态定位** | OpenClaw AI Agent 原生链 + EVM 兼容 | 安全性与流动性基座 | 高吞吐、低延迟执行 | 低成本 EVM 生态扩展 | 继承 Ethereum 流动性、降低执行成本 |

**可站住脚的判断（非绝对结论）**：
1. 若核心需求是“AI Agent 服务证据可验证 + 可客观惩罚 + 奖励闭环”，COC 的 PoSe 机制更直接。
2. 若核心需求是“最强资产安全背书与流动性深度”，Ethereum 及其主流 L2 仍是首选。
3. 若核心需求是“极低延迟高吞吐执行”，Solana 具备优势，但开发栈与 EVM 生态差异较大。
4. 若核心需求是“EVM 低成本部署”，Polygon 与 Arbitrum/Optimism 更成熟，但并不原生提供离链存储 QoS 证明。

**关键定位声明**：
COC 不主张在“通用吞吐、生态规模、资产安全背书”这些维度全面优于所有主流链；其真正创新在于把**可验证服务证明、可客观惩罚、奖励闭环**直接纳入 AI Agent 基础设施协议面。

### 6.3 与存储网络对比（Filecoin / Arweave / Storj）

| 维度 | COC | Filecoin | Arweave | Storj |
|------|-----|----------|---------|-------|
| **主定位** | 通用链执行 + 服务证明 + 存储承诺 | 去中心化存储市场 | 永久数据网络 | 去中心化对象存储服务 |
| **合约能力** | EVM 智能合约 | 支持 FVM/FEVM 合约 | 支持 SmartWeave/AO 等可编程范式 | 非链上合约平台 |
| **数据持久性模型** | 依赖节点激励与治理参数 | 基于存储合约周期与续约 | 面向长期/永久保存经济模型 | 纠删码 + 审计 + 修复 |
| **证明/审计重点** | 服务可用性与质量（QoS） | 存储承诺与时序证明（PoRep/PoSt） | 永久可检索性与经济激励 | 存储节点审计与可用性维护 |
| **典型场景** | OpenClaw AI Agent 状态与服务结算 | 冷/温数据存储与检索市场 | 长期归档与永久发布 | 私有文件与对象存储 |

**结论**：
1. Filecoin 与 Arweave 在“存储持久性经济模型”上更强，COC 在“链上执行 + 服务可证明结算”上更强。
2. Storj 更像工程化云存储网络，不以链上共识执行为核心目标。
3. COC 的定位不是替代全部存储网络，而是为 OpenClaw AI Agent 生态提供“可执行 + 可验证 + 可奖惩”的一体化底座。

### 6.4 汇总决策矩阵

```
                 ┌──────────────────────────────────────────────────┐
                 │      需求驱动选择（面向 AI Agent 业务）         │
                 └──────────────────────────────────────────────────┘

需求：是否必须实现“证据可验证 + 客观惩罚 + 奖励闭环”？
│
├─ 是 → 是否同时需要链上合约编排？
│       ├─ 是 → COC（OpenClaw AI Agent 原生）
│       └─ 否 → 可评估专用存储网络 + 外部仲裁层
│
└─ 否 → 是否优先追求既有 EVM 生态与流动性？
        ├─ 是 → Ethereum / Arbitrum / Optimism / Polygon
        └─ 否 → 评估 Solana 或专用存储网络（按业务目标取舍）
```

### 6.5 COC 技术创新与独特定位（可论证）

| 创新点 | 对应机制 | 与常见方案的关键差异 | 可验证结果 |
|--------|----------|----------------------|------------|
| **证据可验证** | EIP-712 challenge/receipt + witness quorum + Merkle 证据叶 | 不依赖“主观运维报告”判断服务质量 | 证据可链上/链下复验，结论可重放 |
| **惩罚可客观执行** | commit-reveal-settle 挑战流程 + 可配置 slash cap | 处罚依据来自客观证据而非人工仲裁 | 恶意或失职行为可被自动触发惩罚 |
| **奖励闭环** | `finalizeEpochV2` + reward root + Merkle claim | 奖励分配与挑战结果在同一结算面闭合 | 贡献、奖惩、领取路径完整可审计 |
| **AI Agent 身份基础设施** | 节点身份承诺、endpoint 证明、服务能力标记（serviceFlags）、FactionRegistry | 面向 OpenClaw 场景的 Agent 身份与注册层 | Agent 身份可链上验证；协作编排与结算归属待后续版本闭环 |
| **运行安全性** | tip binding、nonce 注册、入站认证、重放防护 | 同时覆盖链上与 P2P/PoSe 通道风险 | 降低重放、伪造、延迟注入类攻击面 |

**为什么这组论证更有说服力**：
1. 每个“优势”都对应到明确协议机制，而不是抽象宣传语。
2. 每个机制都能映射到可观测结果（可复验、可惩罚、可结算、可审计）。
3. 对比结论以“适配场景”呈现，避免把动态市场指标误当成静态事实。

### 6.6 对比事实参考（官方与生态文档）

- Ethereum Staking: https://ethereum.org/en/staking/
- Solana Validators: https://solana.com/validators
- Polygon PoS Docs: https://docs.polygon.technology/pos/
- Optimism Bridging/Messaging: https://docs.optimism.io/app-developers/guides/bridging/messaging
- Arbitrum Withdrawal Window (official support): https://support.arbitrum.io/hc/en-us/articles/18237449094555-Why-does-it-take-7-days-to-complete-an-L2-to-L1-withdrawal
- Filecoin FVM: https://fvm.filecoin.io/
- Filecoin Smart Contracts: https://docs.filecoin.io/smart-contracts/
- Arweave Docs: https://docs.arweave.org/
- Arweave SmartWeave: https://cookbook.arweave.net/concepts/smartweave.html
- Storj Architecture: https://storj.dev/node/get-started/architecture

---

## 七、关键指标

### 区块链性能

```
默认块时间：1000ms（可配置，最小 100ms）
每块最大交易数：默认 512（maxTxPerBlock）
内存池容量：默认 4096（可配置）

实测 TPS（简单 ETH 转账，单节点）：
  EthereumJS 引擎：133.7 TPS（串行 EVM 天花板）
  revm WASM 引擎：20,540 TPS 裸执行 / 500-1000 TPS 端到端（目标）
  Block-STM 并行：2000-5000 TPS（未来目标）
```

### PoSe 性能

```
Agent 轮询间隔：默认 60s
批次大小：默认 5（batchSize）
采样证明数：默认 2（sampleSize）
Tip 容忍窗口：默认 10 blocks
Witness 法定人数：ceil(2m/3), m=|witnessSet|, m<=32
```

### 存储性能

```
Blockstore/UnixFS 延迟取决于磁盘与负载
UnixFS 目录遍历：O(log n) + 线性读目录
Pin 管理：增量维护（非固定毫秒承诺）
```

---

## 八、部署和运维

### 单节点开发

```bash
COC_DATA_DIR=/tmp/coc-dev \
node --experimental-strip-types node/src/index.ts
```

### 多节点开发网络（Devnet）

```bash
bash scripts/start-devnet.sh 3    # 启动 3 节点 devnet
```

**自动启用**：
- BFT 协调器
- Wire 协议
- DHT 网络
- Snap Sync
- 持久化存储

### 生产部署

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

## 九、总结

COC 是一条为**数据服务定制**的公链：

1. **PoSe v2**：无许可的分布式故障证明，通过见证人仲裁
2. **IPFS 兼容**：每个节点都可以存储，任何人都可以验证
3. **混合共识**：确定性 + 可选 BFT + 快照同步
4. **EVM 兼容**：使用 Solidity，迁移成本为零
5. **生产就绪**：LevelDB 持久化，完整的 RPC API，全面的安全检查

其设计目标是成为**信任最小化的数据网络**的结算层。
