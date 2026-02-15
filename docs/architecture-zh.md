# COC (ChainOfClaw) 技术架构文档

> **版本**: v1.2.0
> **更新日期**: 2026-02-15
> **状态**: 生产就绪（190 测试通过）

---

## 1. 系统概述

COC 是基于 EVM 兼容的 PoSe (Proof of Service) 区块链，通过挑战-响应机制验证节点提供的存储、中继和在线服务，实现去中心化服务网络的激励与惩罚。

### 1.1 核心特性

- **EVM 兼容**: 完整支持以太坊智能合约和工具链
- **PoSe 共识**: 服务证明替代传统 PoW/PoS
- **经济安全**: 质押、惩罚、通胀三位一体
- **抗女巫**: 渐进式质押 + 机器指纹 + 随机挑战

### 1.2 代码规模

| 组件 | 代码量 | 文件数 |
|------|--------|--------|
| TypeScript Runtime | ~9,000 行 | 95 |
| Solidity 合约 | ~510 行 | 5 |
| Solidity 测试合约 | ~280 行 | 4 |
| 测试用例 | 190 个 | 35 |

---

## 2. 架构设计

### 2.1 系统分层

```
┌─────────────────────────────────────────────┐
│           应用层 (Applications)              │
│  DApp, 区块浏览器, 钱包, 监控仪表盘          │
└─────────────────────────────────────────────┘
                    ↓ JSON-RPC
┌─────────────────────────────────────────────┐
│          L2 节点层 (COC Nodes)               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ RPC 服务 │  │ EVM 引擎 │  │出块+最终性│  │
│  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────┘
                    ↓ PoSe 协议
┌─────────────────────────────────────────────┐
│         PoSe 运行时 (Runtime)                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │挑战者Agent│  │节点服务器│  │中继器    │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────┘
                    ↓ 结算
┌─────────────────────────────────────────────┐
│      L1 结算层 (Ethereum/Base)               │
│           PoSeManager 合约                   │
└─────────────────────────────────────────────┘
```

### 2.2 核心模块

#### 2.2.1 节点层 (`node/src/`)

- **chain-engine**: 区块生产、最终性确认、状态快照
- **evm.ts**: EthereumJS VM，执行智能合约
- **rpc.ts**: JSON-RPC 服务（57+ 方法，含 eth_*、coc_*、txpool_*）
- **websocket-rpc.ts**: WebSocket RPC（eth_subscribe，含订阅验证与限制）
- **consensus.ts**: 共识引擎（降级模式、自动恢复）
- **mempool.ts**: 交易池（EIP-1559 有效 gas 价格排序）
- **p2p.ts**: HTTP gossip 网络（每 peer 去重、请求体限制）
- **base-fee.ts**: EIP-1559 动态 baseFee 计算
- **health.ts**: 健康检查（内存/WS/存储诊断）
- **debug-trace.ts**: 交易追踪（debug_traceTransaction、trace_transaction）
- **pose-engine**: PoSe 协议引擎，处理挑战验证逻辑
- **crypto/signer**: secp256k1 签名与验证
- **storage/**: LevelDB 持久化（区块索引、状态树、Nonce 存储）

#### 2.2.2 运行时 (`runtime/`)

- **coc-agent.ts**: 挑战者/聚合器，驱动 epoch 验证循环
- **coc-node.ts**: HTTP 服务器，响应 PoSe 挑战请求
- **coc-relayer.ts**: L1-L2 中继器，提交 epoch 最终化和 dispute

#### 2.2.3 服务层 (`services/`)

| 服务 | 职责 |
|------|------|
| verifier | Receipt 验证、节点评分、通胀计算、反作弊 |
| challenger | 挑战工厂、配额管理、随机种子生成 |
| aggregator | 批次聚合、Merkle 树构建 |
| relayer | L1-L2 状态同步、争议提交 |
| common | 通用类型、Merkle 工具、角色注册 |

#### 2.2.4 节点运维 (`nodeops/`)

- **policy-engine**: 运维策略评估（容量、负载、健康度）

#### 2.2.5 合约层 (`contracts/settlement/`)

- **PoSeManager.sol**: 主合约（节点注册、批次提交、惩罚、解绑）
- **PoSeManagerStorage.sol**: 存储布局与常量
- **PoSeTypes.sol**: 结构体定义
- **IPoSeManager.sol**: 接口与事件
- **MerkleProofLite.sol**: Merkle 证明验证

---

## 3. PoSe 协议详解

### 3.1 Epoch 生命周期

```
Epoch N (1 小时)
  ├─ 0-50 分钟: 挑战阶段
  │   ├─ 挑战者发起挑战
  │   ├─ 节点响应并签名 receipt
  │   └─ 聚合器收集 receipt
  ├─ 50-60 分钟: 聚合阶段
  │   ├─ 构建 Merkle 树
  │   ├─ 计算节点评分
  │   └─ 提交批次到 L1
  └─ 完成后进入 Epoch N+1

Dispute Window (2 epochs)
  ├─ Slasher 可提交争议
  └─ 超时后批次最终化
```

### 3.2 挑战类型

#### 3.2.1 Uptime 挑战

验证节点是否与 L1 链保持同步。

**请求**:
```json
{
  "type": "Uptime",
  "querySpec": {
    "method": "eth_blockNumber",
    "minBlockNumber": 12345000
  },
  "nonce": "0xabc123...",
  "randSeed": "0x1234...",
  "timestamp": 1707926400
}
```

**验证逻辑**:
```typescript
verifyUptimeResult: (challenge, receipt) => {
  if (!receipt.responseBody?.ok) return false;
  const bn = Number(receipt.responseBody?.blockNumber);
  if (!Number.isFinite(bn) || bn <= 0) return false;
  const minBn = Number(challenge.querySpec?.minBlockNumber ?? 0);
  if (minBn > 0 && bn < minBn) return false;
  return true;
}
```

#### 3.2.2 Storage 挑战

验证节点存储特定数据并能提供 Merkle 证明。

**请求**:
```json
{
  "type": "Storage",
  "querySpec": {
    "cid": "bafybeiabc123...",
    "offset": 1024,
    "length": 256
  },
  "nonce": "0xdef456...",
  "randSeed": "0x5678...",
  "timestamp": 1707926460
}
```

**验证逻辑**:
- 检查 receipt 中 merkleProof 是否有效
- 验证叶子节点哈希与 querySpec 匹配
- 累加 verifiedStorageBytes

#### 3.2.3 Relay 挑战

验证节点能够中继 L1 交易。

**验证逻辑**:
```typescript
verifyRelayResult: (challenge, receipt) => {
  const witness = receipt.responseBody?.witness;
  return !!witness; // P2 待增强: 验证 witness 签名
}
```

### 3.3 评分算法

#### 3.3.1 分桶权重

```typescript
const buckets = {
  uptime: { weight: 0.6, cap: 100 },   // 60% 奖励池
  storage: { weight: 0.3, cap: 1000 }, // 30% 奖励池
  relay: { weight: 0.1, cap: 50 }      // 10% 奖励池
}
```

#### 3.3.2 存储递减曲线

防止单节点垄断存储奖励。

```typescript
function applyDiminishingReturns(storageGb: bigint): bigint {
  const gb = Number(storageGb);
  return BigInt(Math.floor(Math.sqrt(gb) * 10)); // sqrt 递减
}
```

#### 3.3.3 软上限

超过中位数 5 倍的评分被截断。

```typescript
function applySoftCap(score: bigint, medianScore: bigint): bigint {
  const cap = medianScore * 5n;
  return score > cap ? cap : score;
}
```

### 3.4 通胀计算

```typescript
const INFLATION_RATE_PER_EPOCH = 0.0001; // 0.01% per epoch
const epochReward = totalSupply * INFLATION_RATE_PER_EPOCH;

// 按评分比例分配
nodeReward = (nodeScore / totalScore) * epochReward;
```

---

## 4. 防女巫攻击机制

### 4.1 经济门槛（CRITICAL）

#### 4.1.1 渐进式质押

每个运营商的第 N 个节点需质押 `MIN_BOND << N` ETH。

| 节点序号 | 质押要求 | 累计成本 |
|---------|---------|---------|
| 1 | 0.1 ETH | 0.1 ETH |
| 2 | 0.2 ETH | 0.3 ETH |
| 3 | 0.4 ETH | 0.7 ETH |
| 4 | 0.8 ETH | 1.5 ETH |
| 5 | 1.6 ETH | 3.1 ETH |
| **50** | **5.6 × 10¹³ ETH** | **禁止性成本** |

**合约实现**:
```solidity
function _requiredBond(uint8 existingNodeCount) internal pure returns (uint256) {
    return MIN_BOND << existingNodeCount;
}
```

#### 4.1.2 MAX_NODES_PER_OPERATOR

每个地址最多注册 5 个节点。

```solidity
if (operatorNodeCount[msg.sender] >= MAX_NODES_PER_OPERATOR)
    revert TooManyNodes();
```

### 4.2 机器指纹（HIGH）

#### 4.2.1 endpointCommitment 全局唯一

防止同物理机注册多个虚拟节点。

```typescript
function computeMachineFingerprint(pubkey: string): string {
  const host = hostname();
  const ifaces = networkInterfaces();

  // 取第一个非环回非零 MAC
  let mac = "00:00:00:00:00:00";
  for (const name of Object.keys(ifaces).sort()) {
    const entries = ifaces[name] ?? [];
    const found = entries.find(e =>
      !e.internal && e.mac !== "00:00:00:00:00:00"
    );
    if (found) { mac = found.mac; break; }
  }

  return `machine:${host}:${mac}:${pubkey}`;
}
```

**合约检查**:
```solidity
if (endpointCommitmentUsed[endpointCommitment])
    revert EndpointAlreadyRegistered();

endpointCommitmentUsed[endpointCommitment] = true;
```

#### 4.2.2 解绑时释放 endpoint

允许合法节点退出后重新注册。

```solidity
function requestUnbond(bytes32 nodeId) external {
    // ...
    endpointCommitmentUsed[node.endpointCommitment] = false;
}
```

### 4.3 挑战随机化（P1）

#### 4.3.1 随机种子

每次挑战使用 `crypto.randomBytes(32)`，防止预测。

```typescript
const challenge: ChallengeMessage = {
  // ...
  randSeed: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
};
```

#### 4.3.2 角色轮换

基于 L1 blockHash + epoch + pubkey 确定性轮换挑战者和聚合器。

```typescript
function isAssignedForRole(
  role: "challenger" | "aggregator",
  epochId: number,
  pubkey: string,
  blockHash: string
): boolean {
  const seed = keccak256(
    toUtf8Bytes(`${role}:${epochId}:${blockHash}`)
  );
  const nodeHash = keccak256(toUtf8Bytes(pubkey));
  return BigInt(nodeHash) % 10n === BigInt(seed) % 10n; // 10% 选中率
}
```

### 4.4 准入控制（P1）

#### 4.4.1 挑战者准入

空 challengerSet 时，要求 agent 必须是已注册活跃节点。

```typescript
function canRunForEpochRole(epochId: number): boolean {
  if (challengerSet.length === 0) {
    return selfNodeRegistered; // 每 tick 查询合约
  }
  // ...
}
```

#### 4.4.2 自注册状态刷新

```typescript
async function refreshSelfNodeStatus(): Promise<void> {
  const nodeId = computeNodeId(pubkey);
  const record = await poseContract.getNode(nodeId);
  selfNodeRegistered = record.active && record.bondAmount > 0n;
}
```

### 4.5 签名验证（CRITICAL）

#### 4.5.1 公钥所有权证明

注册时验证 msg.sender 控制对应公钥。

```solidity
function _verifyOwnership(
    bytes32 nodeId,
    bytes calldata pubkeyNode,
    bytes calldata sig
) internal view {
    if (sig.length != 65) revert InvalidOwnershipProof();

    bytes32 messageHash = keccak256(
        abi.encodePacked("coc-register:", nodeId, msg.sender)
    );
    bytes32 ethSignedHash = keccak256(
        abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
    );

    uint8 v = uint8(sig[64]);
    bytes32 r; bytes32 s;
    assembly {
        r := calldataload(sig.offset)
        s := calldataload(add(sig.offset, 32))
    }
    if (v < 27) v += 27;

    address recovered = ecrecover(ethSignedHash, v, r, s);
    if (recovered == address(0)) revert InvalidOwnershipProof();

    address nodeAddr = _pubkeyToAddress(pubkeyNode);
    if (recovered != nodeAddr) revert InvalidOwnershipProof();
}
```

#### 4.5.2 挑战签名验证

```typescript
function verifyChallengerSig(
  challenge: ChallengeMessage,
  sig: Signature
): boolean {
  const payload = buildChallengeVerifyPayload(challenge);
  const recovered = recoverMessageAddress({
    message: { raw: payload },
    signature: sig
  });
  return recovered.toLowerCase() === challenge.challenger.toLowerCase();
}
```

#### 4.5.3 Receipt 签名验证

```typescript
function verifyNodeSig(
  receipt: ReceiptMessage,
  sig: Signature
): boolean {
  const payload = buildReceiptSignMessage(receipt);
  const recovered = recoverMessageAddress({
    message: { raw: toHex(payload) },
    signature: sig
  });
  return recovered.toLowerCase() === receipt.nodeId.slice(0, 42).toLowerCase();
}
```

### 4.6 Nonce 防重放

```typescript
class NonceRegistry {
  private used = new Set<string>();

  markUsed(nonce: string): void {
    this.used.add(nonce);
  }

  isUsed(nonce: string): boolean {
    return this.used.has(nonce);
  }
}
```

**局限**: 纯内存态，重启丢失（P2 待持久化到 LevelDB）。

---

## 5. 惩罚机制

### 5.1 Slash 原因代码

| 代码 | 原因 | 扣除比例 |
|------|------|---------|
| 1 | Nonce 重放 / 明显欺诈 | 20% |
| 2 | 无效签名 | 15% |
| 3 | 超时 / 活性故障 | 5% |
| 4 | 无效存储证明 | 30% |
| 5+ | 通用可证明故障 | 10% |

### 5.2 Slash 流程

```solidity
function slash(
    bytes32 nodeId,
    PoSeTypes.SlashEvidence calldata evidence
) external onlyRole(SLASHER_ROLE) {
    // 1. 验证证据
    if (evidence.evidenceHash != keccak256(evidence.rawEvidence))
        revert InvalidSlashEvidence();

    // 2. 防重放
    bytes32 replayKey = keccak256(
        abi.encodePacked("slash-evidence", nodeId,
                         evidence.reasonCode, evidence.evidenceHash)
    );
    if (usedReplayKeys[replayKey]) revert EvidenceAlreadyUsed();
    usedReplayKeys[replayKey] = true;

    // 3. 扣除质押
    uint16 slashBps = _slashBps(evidence.reasonCode);
    uint256 slashAmount = (node.bondAmount * slashBps) / 10_000;
    node.bondAmount -= slashAmount;

    // 4. 质押归零则停用
    if (node.bondAmount == 0) {
        node.active = false;
    }

    emit NodeSlashed(nodeId, slashAmount, evidence.reasonCode);
}
```

---

## 6. 解绑与提取

### 6.1 解绑延迟

```solidity
uint64 public constant UNBOND_DELAY_EPOCHS = 7 * 24; // 7 天
```

### 6.2 流程

```solidity
// 1. 请求解绑
function requestUnbond(bytes32 nodeId) external {
    node.active = false;
    node.unlockEpoch = currentEpoch + UNBOND_DELAY_EPOCHS;
    unbondRequested[nodeId] = true;
    endpointCommitmentUsed[node.endpointCommitment] = false;
}

// 2. 到期提取
function withdraw(bytes32 nodeId) external {
    if (currentEpoch < node.unlockEpoch) revert UnlockNotReached();

    uint256 amount = node.bondAmount;
    node.bondAmount = 0;
    unbondRequested[nodeId] = false;

    payable(msg.sender).call{value: amount}("");
}
```

---

## 7. 数据流图

### 7.1 挑战-响应流

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│ Challenger│         │   Node   │         │Aggregator│
└─────┬────┘         └────┬─────┘         └────┬─────┘
      │                   │                    │
      │ 1. POST /challenge│                    │
      │─────────────────>│                    │
      │                   │                    │
      │ 2. Receipt + Sig  │                    │
      │<─────────────────│                    │
      │                   │                    │
      │ 3. 验证签名       │                    │
      │                   │                    │
      │ 4. 提交 Receipt   │                    │
      │──────────────────────────────────────>│
      │                   │                    │
      │                   │      5. 构建 Merkle 树
      │                   │                    │
      │                   │      6. submitBatch()
      │                   │                    │
```

### 7.2 争议流

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│ Slasher  │         │PoSeManager│        │ Relayer  │
└────┬─────┘         └────┬─────┘         └────┬─────┘
     │                    │                    │
     │ 1. 发现伪造 receipt│                    │
     │                    │                    │
     │ 2. challengeBatch()│                    │
     │───────────────────>│                    │
     │                    │                    │
     │                    │ 3. 标记 disputed   │
     │                    │                    │
     │                    │        4. 监听事件  │
     │                    │<───────────────────│
     │                    │                    │
     │                    │        5. slash()  │
     │                    │<───────────────────│
     │                    │                    │
```

---

## 8. 安全性分析

### 8.1 已修复漏洞（10 项）

| 级别 | 数量 | 漏洞 |
|------|------|------|
| CRITICAL | 4 | 质押收取、MIN_BOND、签名验证、公钥所有权 |
| HIGH | 2 | Sybil 注册防护、storageGb 硬编码 |
| P1 | 4 | Uptime 严格化、randSeed 随机、机器指纹、准入控制 |

### 8.2 残留风险（P2）

| 风险 | 影响 | 优先级 |
|------|------|--------|
| Relay witness 伪造 | 可获得虚假中继奖励 | P2 |
| NonceRegistry 重启丢失 | 重放攻击窗口 | P2 |
| blockHash 种子可预测 | 角色分配可操纵 | P2 |
| MAC 软件伪造 | 机器指纹绕过 | P3 |
| 跨地址 Sybil | 多钱包绕过渐进质押 | P2 |

### 8.3 攻击成本评估

| 攻击类型 | 成本 | 成功率 | 防护状态 |
|---------|------|--------|---------|
| 单地址多节点 | 3.1 ETH (5节点) | 0% | ✅ 已阻断 |
| 多地址 Sybil | N × 0.1 ETH | 中 | ⚠️ 部分防护 |
| 存储空壳 | 0.1 ETH | 低 | ✅ 已阻断 |
| Uptime 空壳 | 0.1 ETH | 低 | ✅ 已阻断 |
| Relay 伪造 | 0.1 ETH | 中 | ⚠️ 待加固 |

---

## 9. 性能指标

### 9.1 吞吐量

- **挑战频率**: ~100 次/epoch/挑战者
- **聚合批次**: ~1000 receipt/batch
- **L1 gas 消耗**: ~500K gas/batch submit

### 9.2 延迟

- **挑战响应**: < 2 秒
- **Receipt 验证**: < 100ms
- **Batch 最终化**: 2 epochs (~2 小时)

### 9.3 存储

- **节点状态**: ~200 bytes/node
- **Batch 元数据**: ~300 bytes/batch
- **Merkle 证明**: ~1KB/sample

---

## 10. 部署配置

### 10.1 网络参数

```yaml
network:
  chainId: 2077
  l1RpcUrl: "https://mainnet.base.org"
  l2RpcUrl: "http://localhost:8545"
  poseManagerAddress: "0x..." # L1 合约地址

epoch:
  durationSeconds: 3600
  disputeWindowEpochs: 2
  unbondDelayEpochs: 168 # 7 天
```

### 10.2 节点配置

```yaml
node:
  privateKey: "0x..." # 节点私钥
  httpPort: 3000
  bondAmount: "0.1" # ETH

challenge:
  uptimeQuota: 50
  storageQuota: 30
  relayQuota: 20
```

### 10.3 策略配置

```yaml
policy:
  maxConcurrentChallenges: 10
  challengeTimeoutMs: 5000
  retryAttempts: 3

scoring:
  uptimeWeight: 0.6
  storageWeight: 0.3
  relayWeight: 0.1
  storageDiminishingFactor: 0.5 # sqrt
```

---

## 11. 监控与告警

### 11.1 关键指标

| 指标 | 阈值 | 告警级别 |
|------|------|---------|
| 挑战成功率 | < 95% | WARNING |
| Receipt 验证失败率 | > 5% | CRITICAL |
| Batch 争议率 | > 10% | WARNING |
| 节点 Slash 率 | > 20% | CRITICAL |
| Epoch 延迟 | > 10 分钟 | WARNING |

### 11.2 日志格式

```json
{
  "level": "info",
  "timestamp": "2026-02-14T12:34:56Z",
  "module": "coc-agent",
  "event": "challenge_completed",
  "data": {
    "nodeId": "0xabc...",
    "challengeType": "Storage",
    "success": true,
    "latencyMs": 1234
  }
}
```

---

## 12. 未来路线图

### 12.1 P2 优先级

1. **Relay witness 严格验证** (Q2 2026)
2. **Nonce 持久化** (Q2 2026)
3. **VRF 角色分配** (Q3 2026)
4. **跨地址 Sybil 检测** (Q3 2026)

### 12.2 P3 长期目标

- 数据可用性采样 (DAS)
- TEE 硬件指纹
- 去中心化 challenger 市场
- ZK 证明优化

---

## 13. 测试覆盖率

### 13.1 测试分布

| 模块 | 测试数 | 文件数 |
|------|--------|--------|
| Contracts (Solidity) | 52 | 7 |
| Node (链引擎+EVM+RPC+WS+P2P+存储) | 83 | 9 |
| Services (PoSe 运行时) | 44 | 13 |
| Nodeops (运维策略) | 11 | 3 |
| **总计** | **190** | **35** |

### 13.2 合约覆盖率（Phase 4）

| 指标 | 覆盖率 | 目标 | 状态 |
|------|--------|------|------|
| Statements | 83.62% | 80% | ✅ 达标 |
| Lines | 84.46% | 80% | ✅ 达标 |
| Functions | 75.51% | 80% | ⚠️ 接近 |
| Branches | 51.02% | 80% | ⚠️ 待提升 |

**未覆盖路径**: 主要为错误处理边界和极端场景（如 slash 流程、争议解决）。

### 13.3 Phase 4 测试清单

#### 13.3.1 ERC-20 兼容性（17 测试）

- ✅ 部署与元数据验证
- ✅ 转账、授权、transferFrom
- ✅ 事件发射（Transfer, Approval）
- ✅ 边界检查（余额不足、零地址、溢出）
- ✅ Mint/Burn 功能
- ✅ Gas 使用量验证（< 100k）

#### 13.3.2 ERC-721 NFT（20 测试）

- ✅ NFT 铸造与所有权
- ✅ 转账与授权机制
- ✅ 批量授权（setApprovalForAll）
- ✅ Safe transfer 钩子
- ✅ Burn 功能
- ✅ ERC-165 接口支持
- ✅ Gas 使用量验证（< 100k）

#### 13.3.3 重入防护（6 测试）

- ✅ CEI 模式验证（Checks-Effects-Interactions）
- ✅ 多次 withdraw 防护
- ✅ 状态在外部调用前清零
- ✅ VulnerableBank 对比测试（演示重入漏洞）
- ✅ BankAttacker 重入攻击演示

**关键发现**: PoSeManager 正确实现 CEI 模式（line 242-244），bondAmount 在 `.call{value}` 之前清零，无需额外 ReentrancyGuard。

#### 13.3.4 Merkle 证明（10 测试）

- ✅ 二元树证明验证
- ✅ 多层树证明（4 叶子）
- ✅ 奇数叶子处理（3 叶子）
- ✅ 错误证明拒绝
- ✅ 哈希排序独立性验证
- ✅ 批次内多样本处理
- ✅ 重复叶子检测
- ✅ leafIndex 升序校验
- ✅ summaryHash 完整性验证
- ✅ Gas 使用量验证（< 300k）

**重要**: 所有测试已适配 PoSeManager.submitBatch 的验证逻辑（line 105-118），包括 summaryHash 计算和非空证明要求。

#### 13.3.5 EVM Precompile（16 测试）

覆盖 9 个预编译合约边界情况：
- ✅ ecrecover (0x01): 无效 v 值、零签名、恢复地址
- ✅ sha256 (0x02): 空输入、长输入
- ✅ ripemd160 (0x03): 边界测试
- ✅ identity (0x04): 透传验证
- ✅ modexp (0x05): 幂模运算
- ✅ bn256Add/Mul/Pairing (0x06-08): 椭圆曲线运算
- ✅ blake2f (0x09): Blake2 压缩函数

#### 13.3.6 Hardfork 兼容性（11 测试）

验证 Shanghai hardfork 特性：
- ✅ PUSH0 操作码（0x5f）可用性
- ✅ BASEFEE 操作码（block.basefee）
- ✅ SELFBALANCE 操作码
- ✅ CHAINID 操作码
- ✅ 温暖 COINBASE（EIP-3651）
- ✅ Pre-Shanghai 兼容性验证

### 13.4 测试工具链

```yaml
Solidity 测试:
  - Hardhat v2.22.18
  - ethers.js v6.13.5
  - chai matchers
  - solidity-coverage v0.8.13
  - hardhat-gas-reporter v2.2.1

TypeScript 测试:
  - Node.js native test runner
  - --experimental-strip-types
```

### 13.5 CI/CD 集成

```yaml
GitHub Actions:
  - 自动覆盖率检查（80% 阈值）
  - Gas 报告生成
  - Codecov 集成
  - 所有 PR 必须通过测试
```

---

## 14. 参考文献

- [EthereumJS VM 文档](https://github.com/ethereumjs/ethereumjs-monorepo)
- [Merkle 树最佳实践](https://en.wikipedia.org/wiki/Merkle_tree)
- [EIP-191: 签名数据标准](https://eips.ethereum.org/EIPS/eip-191)
- [渐进式质押论文](https://arxiv.org/abs/...)

---

**文档维护者**: COC 核心团队
**联系方式**: dev@chainofclaw.org
**许可证**: MIT
