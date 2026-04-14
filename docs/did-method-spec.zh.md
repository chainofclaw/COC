# AI Agent 去中心化身份：`did:coc` 方法规范

## 概述

`did:coc` 方法为 COC 区块链上的 AI agent 提供符合 W3C DID Core v1.0 标准的去中心化标识符。基于现有的 SoulRegistry 身份基础设施构建，新增标准化身份解析、密钥管理、能力委托、可验证凭证和选择性披露能力。

| 组件 | 用途 | 位置 |
|------|------|------|
| **DIDRegistry 合约** | 密钥轮换、委托、凭证、临时身份、谱系追踪 | `COC/contracts/governance/DIDRegistry.sol` |
| **DID 解析器** | 将 `did:coc` 标识符解析为 DID 文档 | `COC/node/src/did/did-resolver.ts` |
| **DID 文档构建器** | 从链上状态构建 W3C 兼容文档 | `COC/node/src/did/did-document-builder.ts` |
| **DID 认证** | Wire/P2P 通信的挑战-响应认证 | `COC/node/src/did/did-auth.ts` |
| **委托链** | 作用域受限的委托验证 | `COC/node/src/did/delegation-chain.ts` |
| **可验证凭证** | VC 签发、通过 Merkle 证明的选择性披露 | `COC/node/src/did/verifiable-credentials.ts` |
| **EIP-712 类型** | DIDRegistry 的类型化数据定义 | `COC/node/src/crypto/did-registry-types.ts` |
| **Explorer 页面** | DID 搜索和详情可视化 | `COC/explorer/src/app/did/` |

---

## 架构概览

```
                        ┌─────────────────────────────────┐
                        │         DID 解析器               │
                        │  (did-resolver.ts)               │
                        └──────────┬──────────────────────-┘
                                   │  resolve("did:coc:0x...")
                     ┌─────────────┼─────────────┐
                     ▼             ▼              ▼
              ┌──────────┐  ┌───────────┐  ┌──────────────┐
              │ SoulReg  │  │ DIDReg    │  │ PoSeManager  │
              │ 合约     │  │ 合约      │  │ V2 合约      │
              └──────────┘  └───────────┘  └──────────────┘
                     │             │              │
                     └─────────────┼──────────────┘
                                   ▼
                        ┌─────────────────────────────────┐
                        │      DID 文档构建器              │
                        │  (did-document-builder.ts)       │
                        └──────────┬──────────────────────-┘
                                   │
                                   ▼
                        ┌─────────────────────────────────┐
                        │    W3C DID 文档 (JSON)           │
                        │  verificationMethod, service,    │
                        │  controller, cocAgent 元数据     │
                        └─────────────────────────────────┘
```

### 数据流

**解析路径：**

1. 客户端通过 JSON-RPC 调用 `coc_resolveDid("did:coc:0xabc...")`
2. 解析器解析 DID 字符串，提取 `chainId`、`identifierType` 和 `identifier`
3. 查询 SoulRegistry 获取 `SoulIdentity`、监护人、复活配置
4. 查询 DIDRegistry 获取验证方法、能力、谱系、委托
5. DID 文档构建器组装 W3C 兼容的 JSON 文档
6. 返回包含文档、解析元数据和文档元数据的 `DIDResolutionResult`

**认证路径：**

1. 发起方在 Wire/P2P 握手中发送可选的 `did` 和 `didProof` 字段
2. 响应方解析 DID 以获取验证方法
3. 根据解析的认证方法验证 `didProof` 签名
4. 验证成功后，建立基于 DID 身份的认证会话

---

## DID 方法规范

### 1. 方法名称

方法名称为 `coc`。使用此方法的 DID 必须以 `did:coc:` 开头。

### 2. 方法特定标识符

```
did:coc:<agentId>                      # 默认链 (chainId=20241224)
did:coc:<chainId>:<agentId>            # 显式指定链
did:coc:<chainId>:agent:<agentId>      # 显式 agent 类型
did:coc:<chainId>:node:<nodeId>        # PoSe 节点身份
```

其中：
- `<agentId>` / `<nodeId>` — 来自 SoulRegistry / PoSeManagerV2 的 `0x` 前缀 hex bytes32
- `<chainId>` — 十进制整数。省略时默认为 COC 主网 (`20241224`)

**示例：**
- `did:coc:0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890`
- `did:coc:18780:0xabcdef...`
- `did:coc:18780:node:0xabcdef...`

**解析正则：** `^did:coc:(?:(\d+):)?(?:(agent|node):)?(.+)$`

### 3. CRUD 操作

| 操作 | 机制 | 链上效果 |
|------|------|----------|
| **创建** | `SoulRegistry.registerSoul()` + `DIDRegistry.updateDIDDocument()` | 创建 SoulIdentity + 锚定 DID 文档 CID |
| **读取** | `coc_resolveDid` RPC / DID 解析器 | 从链上状态组装 DID 文档 |
| **更新** | `DIDRegistry.updateDIDDocument()` (EIP-712 签名) | 更新文档 CID |
| **停用** | `SoulRegistry.deactivateSoul()` | 标记 `active=false`；解析器返回空验证方法 |

### 4. DID 文档结构

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://coc.network/ns/did/v1"
  ],
  "id": "did:coc:0xabc123...",
  "controller": ["did:coc:0xabc123...", "0xguardian1...", "0xguardian2..."],
  "verificationMethod": [
    {
      "id": "did:coc:0xabc123...#master",
      "type": "EcdsaSecp256k1RecoveryMethod2020",
      "controller": "did:coc:0xabc123...",
      "blockchainAccountId": "eip155:20241224:0xOwnerAddress"
    },
    {
      "id": "did:coc:0xabc123...#operational",
      "type": "EcdsaSecp256k1RecoveryMethod2020",
      "controller": "did:coc:0xabc123...",
      "blockchainAccountId": "eip155:20241224:0xOperatorAddress"
    }
  ],
  "authentication": ["#master", "#operational"],
  "assertionMethod": ["#master", "#operational"],
  "capabilityInvocation": ["#master"],
  "capabilityDelegation": ["#master"],
  "service": [
    { "id": "#rpc", "type": "CocRpcEndpoint", "serviceEndpoint": "http://node:18780" },
    { "id": "#wire", "type": "CocWireProtocol", "serviceEndpoint": "tcp://node:19781" },
    { "id": "#ipfs", "type": "IpfsGateway", "serviceEndpoint": "http://node:5001" },
    { "id": "#pose", "type": "CocPoSeEndpoint", "serviceEndpoint": "http://node:18780/pose" }
  ],
  "cocAgent": {
    "registeredAt": "2026-03-15T10:00:00.000Z",
    "version": 1,
    "identityCid": "0x1111...",
    "capabilities": ["storage", "compute", "validation"],
    "lineage": { "parent": null, "forkHeight": null, "generation": 0 },
    "reputation": { "poseScore": 0.95, "epochsActive": 1200, "slashCount": 0 }
  }
}
```

**链上状态到文档字段的映射：**

| DID 文档字段 | 数据来源 |
|-------------|----------|
| `id` | 由 `SoulIdentity.agentId` 派生 |
| `controller` | 自身 DID + SoulRegistry.getGuardians() 中的活跃监护人 |
| `verificationMethod[#master]` | `SoulIdentity.owner` 地址 |
| `verificationMethod[#resurrection]` | `ResurrectionConfig.resurrectionKeyHash` |
| `verificationMethod[#operational...]` | `DIDRegistry.getActiveVerificationMethods()` |
| `service` | 配置的端点（不存储在链上） |
| `cocAgent.capabilities` | `DIDRegistry.agentCapabilities()` 位掩码解码 |
| `cocAgent.lineage` | `DIDRegistry.agentLineage()` |

---

## DIDRegistry 智能合约

**文件：** `COC/contracts/governance/DIDRegistry.sol`

**与 SoulRegistry 的关系：** DIDRegistry 是独立合约，通过不可变的 `soulRegistry` 地址引用 SoulRegistry。它不修改 SoulRegistry。所有状态变更操作都要求调用者是 SoulRegistry 中对应 `agentId` 的 `soul.owner`。

**EIP-712 域：** `name="COCDIDRegistry"`，`version="1"`，绑定到 `chainId` 和合约地址。

### 核心数据结构

> **JSON 线上约定：** 下面的表格同时展示 Solidity 规范类型和通过 JSON-RPC 返回的实际 JSON 线上类型。线上类型由 provider 层（`node/src/did/did-data-provider.ts`）如何转换链上值决定：
>
> - provider 中经过 `BigInt(...)` 的字段在线上变成**十六进制字符串**（如 `500` → `"0x1f4"`），遵循 EVM RPC 的 `bigint → hex` 序列化规则。
> - provider 中经过 `Number(...)` 的字段在线上保持为普通 **JSON number**。这对特定字段是刻意选择——当值较小且有界（例如以秒为单位的委托/凭证时间戳）时，hex-string 的开销不划算。
> - `uint8` / `bool` 始终序列化为 JSON `number` / `boolean`。`bytes32` / `address` 始终序列化为 `0x` 前缀的十六进制字符串。
>
> **请始终查看 "JSON 线上类型" 列** —— 不同结构的选择不同。

#### VerificationMethod（验证方法）

| 字段 | Solidity 类型 | JSON 线上类型 | 说明 |
|------|--------------|--------------|------|
| `keyId` | `bytes32` | `string`（十六进制） | 密钥标签哈希，如 `keccak256("operational")` |
| `keyAddress` | `address` | `string`（十六进制） | 密钥派生的以太坊地址 |
| `keyPurpose` | `uint8` | `number` | 位掩码：`0x01`=认证, `0x02`=断言, `0x04`=能力调用, `0x08`=能力委托 |
| `addedAt` | `uint64` | `string`（十六进制） | 密钥添加时间戳 |
| `revokedAt` | `uint64` | `string`（十六进制） | 撤销时间戳（`0x0` = 活跃） |
| `active` | `bool` | `boolean` | 当前是否活跃 |

#### DelegationRecord（委托记录）

| 字段 | Solidity 类型 | JSON 线上类型 | 说明 |
|------|--------------|--------------|------|
| `delegationId` | `bytes32` | `string`（十六进制） | 唯一委托 ID（由 RPC 层添加） |
| `delegator` | `bytes32` | `string`（十六进制） | 委托方的 agentId |
| `delegatee` | `bytes32` | `string`（十六进制） | 被委托方的 agentId |
| `parentDelegation` | `bytes32` | `string`（十六进制） | 父委托 ID（根委托为 `bytes32(0)`） |
| `scopeHash` | `bytes32` | `string`（十六进制） | 规范化作用域编码的 `keccak256` |
| `issuedAt` | `uint64` | `number` | 签发时间戳（Unix 秒） |
| `expiresAt` | `uint64` | `number` | 过期时间戳（Unix 秒） |
| `depth` | `uint8` | `number` | 链深度（0 = 直接委托） |
| `revoked` | `bool` | `boolean` | 撤销标志 |
| `_readError` | — | `boolean?` | **仅 RPC 字段**：当从链上读取该委托记录失败时为 `true`。其他字段（除 `delegationId`）为零值占位。消费方应跳过或重试这些记录。 |

#### EphemeralIdentity（临时身份）

| 字段 | Solidity 类型 | JSON 线上类型 | 说明 |
|------|--------------|--------------|------|
| `parentAgentId` | `bytes32` | `string`（十六进制） | 父 agent 的灵魂 ID |
| `ephemeralAddress` | `address` | `string`（十六进制） | 子身份的临时地址 |
| `scopeHash` | `bytes32` | `string`（十六进制） | 作用域限制哈希 |
| `createdAt` | `uint64` | `string`（十六进制） | 创建时间戳 |
| `expiresAt` | `uint64` | `string`（十六进制） | 自动过期时间戳 |
| `active` | `bool` | `boolean` | 当前是否活跃 |

#### Lineage（谱系）

| 字段 | Solidity 类型 | JSON 线上类型 | 说明 |
|------|--------------|--------------|------|
| `parentAgentId` | `bytes32` | `string`（十六进制） | 父 agent ID（创世 agent 为 `bytes32(0)`） |
| `forkHeight` | `uint256` | `string`（十六进制） | agent 分叉时的区块高度 |
| `generation` | `uint16` | `number` | 代数（0 = 根） |

#### CredentialAnchor（凭证锚定）

| 字段 | Solidity 类型 | JSON 线上类型 | 说明 |
|------|--------------|--------------|------|
| `credentialHash` | `bytes32` | `string`（十六进制） | 完整凭证的 `keccak256` |
| `issuerAgentId` | `bytes32` | `string`（十六进制） | 签发者的灵魂 ID |
| `subjectAgentId` | `bytes32` | `string`（十六进制） | 主体的灵魂 ID |
| `credentialCid` | `bytes32` | `string`（十六进制） | 凭证的 IPFS CID 哈希 |
| `issuedAt` | `uint64` | `number` | 签发时间戳（Unix 秒） |
| `expiresAt` | `uint64` | `number` | 过期时间戳（Unix 秒） |
| `revoked` | `bool` | `boolean` | 撤销标志 |

### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_DELEGATION_DEPTH` | `3` | 最大委托链深度 |
| `MIN_DELEGATION_INTERVAL` | `60` 秒 | 委托授予之间的限速间隔 |
| `MAX_VERIFICATION_METHODS` | `8` | 每个 agent 最大密钥数 |
| `MAX_DELEGATIONS_PER_AGENT` | `32` | 每个 agent 最大出站委托数 |

### EIP-712 类型定义

```
UpdateDIDDocument(bytes32 agentId, bytes32 newDocumentCid, uint64 nonce)
AddVerificationMethod(bytes32 agentId, bytes32 keyId, address keyAddress, uint8 keyPurpose, uint64 nonce)
RevokeVerificationMethod(bytes32 agentId, bytes32 keyId, uint64 nonce)
GrantDelegation(bytes32 delegator, bytes32 delegatee, bytes32 parentDelegation, bytes32 scopeHash, uint64 expiresAt, uint8 depth, uint64 nonce)
RevokeDelegation(bytes32 delegationId, uint64 nonce)
CreateEphemeralIdentity(bytes32 parentAgentId, bytes32 ephemeralId, address ephemeralAddress, bytes32 scopeHash, uint64 expiresAt, uint64 nonce)
AnchorCredential(bytes32 credentialHash, bytes32 issuerAgentId, bytes32 subjectAgentId, bytes32 credentialCid, uint64 expiresAt, uint64 nonce)
```

### 写操作

| 函数 | 说明 | 访问控制 |
|------|------|----------|
| `updateDIDDocument(agentId, newCid, sig)` | 更新 DID 文档 CID | 所有者 + EIP-712 签名 |
| `addVerificationMethod(agentId, keyId, keyAddress, keyPurpose, sig)` | 添加新密钥 | 所有者 + EIP-712 签名 |
| `revokeVerificationMethod(agentId, keyId, sig)` | 撤销活跃密钥 | 所有者 + EIP-712 签名 |
| `grantDelegation(delegator, delegatee, parent, scopeHash, expiresAt, depth, sig)` | 授予委托凭证 | 所有者 + EIP-712 签名 |
| `revokeDelegation(delegationId, sig)` | 撤销特定委托 | 委托方所有者 + EIP-712 签名 |
| `revokeAllDelegations(agentId)` | 紧急：使所有委托失效 | 所有者 |
| `updateCapabilities(agentId, capabilities)` | 更新能力位掩码 | 所有者 |
| `createEphemeralIdentity(parentAgentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt, sig)` | 创建临时子身份 | 所有者 + EIP-712 签名 |
| `deactivateEphemeralIdentity(ephemeralId)` | 停用临时身份 | 父 agent 所有者 |
| `recordLineage(agentId, parentAgentId, forkHeight, generation)` | 记录分叉关系 | 所有者 |
| `anchorCredential(credentialHash, issuerAgentId, subjectAgentId, credentialCid, expiresAt, sig)` | 锚定可验证凭证 | 签发者所有者 + EIP-712 签名 |
| `revokeCredential(credentialId)` | 撤销凭证 | 签发者所有者 |

### 视图函数

| 函数 | 返回值 |
|------|--------|
| `didDocumentCid(agentId)` | DID 文档 IPFS CID 哈希 |
| `getVerificationMethods(agentId)` | 所有验证方法（包括已撤销） |
| `getActiveVerificationMethods(agentId)` | 仅活跃验证方法 |
| `delegations(delegationId)` | 委托记录 |
| `getAgentDelegations(agentId)` | agent 签发的委托 ID 数组 |
| `isDelegationValid(delegationId)` | 有效性检查（过期 + 撤销 + 全局纪元） |
| `agentCapabilities(agentId)` | 能力位掩码 |
| `ephemeralIdentities(ephemeralId)` | 临时身份记录 |
| `agentLineage(agentId)` | 谱系记录 |
| `credentials(credentialId)` | 凭证锚定记录 |
| `globalRevocationEpoch(agentId)` | 在此时间戳之前的所有委托均无效 |

### 事件

| 事件 | 触发条件 |
|------|----------|
| `DIDDocumentUpdated(agentId, newCid)` | DID 文档 CID 更新 |
| `VerificationMethodAdded(agentId, keyId, keyAddress, purpose)` | 新密钥添加 |
| `VerificationMethodRevoked(agentId, keyId)` | 密钥撤销 |
| `DelegationGranted(delegationId, delegator, delegatee, expiresAt)` | 委托创建 |
| `DelegationRevoked(delegationId)` | 委托撤销 |
| `GlobalRevocationSet(agentId, epoch)` | 纪元前所有委托失效 |
| `EphemeralIdentityCreated(parentAgentId, ephemeralId)` | 临时身份创建 |
| `EphemeralIdentityDeactivated(ephemeralId)` | 临时身份停用 |
| `CapabilitiesUpdated(agentId, capabilities)` | 能力位掩码变更 |
| `LineageRecorded(agentId, parentAgentId, generation)` | 谱系记录 |
| `CredentialAnchored(credentialId, issuer, subject)` | 凭证哈希锚定 |
| `CredentialRevoked(credentialId)` | 凭证撤销 |

---

## 密钥管理

### 密钥层级

```
主密钥 (冷钥匙)  ←── SoulRegistry.soul.owner
  ├── 操作密钥 (热钥匙)  ←── DIDRegistry 验证方法 (keyPurpose=0x03)
  ├── 委托密钥           ←── DIDRegistry 验证方法 (keyPurpose=0x08)
  ├── 恢复密钥           ←── SoulRegistry.resurrectionKeyHash
  └── 会话密钥 (临时)    ←── 每连接 ECDH 派生
```

### 密钥轮换

DID 锚定到 `agentId`（bytes32），而非任何特定密钥。轮换流程：

1. 所有者用主密钥签署 `AddVerificationMethod` 注册新操作密钥
2. 所有者签署 `RevokeVerificationMethod` 停用旧密钥
3. 对等节点重新解析 DID 文档以发现更新的密钥集
4. 先前签署的委托凭证在过期前仍然有效（它们引用 `agentId`，而非密钥地址）

### 密钥恢复

利用现有的 SoulRegistry 监护人系统：

1. 监护人通过 `SoulRegistry.initiateRecovery()` 发起恢复
2. 2/3 监护人仲裁在 1 天时间锁内批准
3. 通过 `SoulRegistry.completeRecovery()` 将所有权转移给 `newOwner`
4. 新所有者在 DIDRegistry 中注册新密钥

---

## 委托框架

### 作用域语言

作用域定义被委托方被授权执行的操作：

```typescript
interface DelegationScope {
  resource: string     // URI 模式："pose:receipt:*", "ipfs:cid:<CID>", "rpc:method:eth_*"
  action: string       // "submit" | "read" | "write" | "challenge" | "witness" | "*"
  constraints?: {
    epochMin?: bigint   // 最小 epoch
    epochMax?: bigint   // 最大 epoch
    maxValue?: bigint   // 价值操作的最大值
    nodeIds?: Hex32[]   // 限制到特定节点
  }
}
```

**示例：**

| 作用域 | 含义 |
|--------|------|
| `{ resource: "pose:receipt:*", action: "submit" }` | 可以提交 PoSe 回执 |
| `{ resource: "ipfs:cid:QmXyz", action: "read" }` | 可以读取特定 IPFS 数据 |
| `{ resource: "*", action: "*" }` | 完全访问（根委托） |
| `{ resource: "delegation:create", action: "write" }` | 可以创建子委托 |

链上存储的 `scopeHash` 为 `keccak256(canonicalEncode(scopes))`。完整作用域数组存储在链下（IPFS 或直接传输）。

### 委托链规则

```
Agent A (委托方)
  └─ 委托给 Agent B (depth=0, scopes=[pose:*, delegation:create])
       └─ B 委托给 Agent C (depth=1, scopes=[pose:receipt:*])
            └─ C 委托给 Agent D (depth=2, scopes=[pose:receipt:submit])
```

| 规则 | 说明 |
|------|------|
| **作用域缩窄** | 子委托作用域必须是父委托作用域的子集 |
| **深度递增** | `child.depth = parent.depth + 1`；最大深度 = 3 |
| **过期时间天花板** | `child.expiresAt <= parent.expiresAt` |
| **再委托授权** | 父委托必须包含 `{ resource: "delegation:create", action: "write" }` |
| **级联撤销** | 撤销 A→B 自动使 B→C 和 C→D 失效 |
| **全局撤销** | `revokeAllDelegations()` 设置纪元；之前的所有委托均无效 |

### 委托证明

当被委托方代表委托方行事时，提交 `DelegationProof`：

```typescript
interface DelegationProof {
  chain: DelegationCredential[]  // [A→B, B→C, C→D]
  leafAction: { resource: string; action: string; payload: unknown }
  proofTimestamp: bigint
  proofSignature: `0x${string}`  // 叶节点被委托方签署证明信封
}
```

**验证算法：**

1. 从索引 0（根）到 N（叶）遍历链
2. 每步验证：depth == index、未过期、未撤销、未全局撤销
3. 对 i > 0：验证父引用、链连续性（parent.delegatee == child.delegator）、过期天花板、作用域子集、再委托授权
4. 可选验证每步的 EIP-712 签名
5. 最终检查：叶委托作用域覆盖请求的操作

---

## 可验证凭证

### 凭证类型

| 类型 | 签发者 | 用途 |
|------|--------|------|
| `AgentCapabilityCredential` | 自签或 DAO | 声明 agent 能力 |
| `NodeOperatorCredential` | PoSeManagerV2（隐式） | 节点运营者身份 |
| `ReputationCredential` | Epoch 聚合器 | PoSe 评分、正常运行时间 |
| `ServiceLevelCredential` | 自签 + 质押 | SLA 承诺 |
| `AuditCredential` | DAO 认证审计员 | 代码审计结果 |

### 凭证结构

```typescript
interface VerifiableCredential {
  "@context": ["https://www.w3.org/2018/credentials/v1", "https://coc.chain/credentials/v1"]
  type: string[]
  issuer: Hex32            // agentId
  issuanceDate: string     // ISO 8601
  expirationDate?: string
  credentialSubject: {
    id: Hex32              // 主体 agentId
    [key: string]: unknown // 类型特定的声明
  }
  proof: {
    type: "EIP712Signature2024"
    created: string
    verificationMethod: string  // "did:coc:<issuerAgentId>#operationalKey"
    proofValue: `0x${string}`
    eip712Domain: { name, version, chainId, verifyingContract }
  }
  onChainAnchor?: {
    txHash: `0x${string}`
    credentialHash: Hex32
    blockNumber: bigint
  }
}
```

### 选择性披露

使用基于 Merkle 树的方案，与现有 `MerkleProofLite.sol` 兼容：

1. `credentialSubject` 中的每个字段独立哈希为叶节点：`SHA-256(0x00 || fieldName || fieldValue)`
2. 内部节点使用域分离：`SHA-256(0x01 || leftHash || rightHash)`
3. 凭证存储所有字段哈希的 Merkle 根
4. 披露特定字段时，持有者提供字段值 + Merkle 证明
5. 验证者重新计算叶哈希并沿证明路径到达根

```typescript
interface SelectiveDisclosure {
  credentialHash: Hex32
  disclosedFields: Array<{
    fieldName: string
    fieldValue: unknown
    merkleProof: Hex32[]
  }>
  fieldMerkleRoot: Hex32
}
```

**示例：** agent 可以通过仅披露 `ReputationCredential` 中的 `score` 字段来证明"我的 PoSe 评分 >= 90"，而无需泄露正常运行时间百分比、惩罚历史或其他属性。

---

## 能力位掩码

Agent 能力以 16 位位掩码在链上声明：

| 位 | 标志 | 能力 |
|----|------|------|
| 0 | `0x0001` | `storage` — IPFS 兼容存储服务 |
| 1 | `0x0002` | `compute` — 通用计算 |
| 2 | `0x0004` | `validation` — 区块验证 |
| 3 | `0x0008` | `challenge` — PoSe 挑战签发 |
| 4 | `0x0010` | `aggregation` — 批次聚合 |
| 5 | `0x0020` | `witness` — 见证证明 |
| 6 | `0x0040` | `relay` — 交易/区块中继 |
| 7 | `0x0080` | `backup` — 灵魂备份服务 |
| 8 | `0x0100` | `governance` — 治理投票 |
| 9 | `0x0200` | `ipfs_pin` — IPFS 固定服务 |
| 10 | `0x0400` | `dns_seed` — DNS 种子节点 |
| 11 | `0x0800` | `faucet` — 测试网水龙头 |

---

## 协议集成

### Wire 协议增强（向后兼容）

`wire-server.ts` / `wire-client.ts` 中现有的 `HandshakePayload` 扩展了可选字段：

```typescript
interface HandshakePayload {
  // 原有字段（不变）
  nodeId: string; chainId: number; height: string;
  publicKey?: string; nonce?: string; signature?: string;
  // DID 扩展（可选）
  did?: string;        // "did:coc:0x..."
  didProof?: string;   // 证明 DID 控制权的 EIP-712 签名
}
```

不支持 DID 的节点只需忽略这些字段。支持 DID 的节点解析 DID 并根据文档认证方法验证 `didProof`。

### P2P 认证增强（向后兼容）

`p2p.ts` 中现有的 `P2PAuthEnvelope` 新增可选 DID 字段：

```typescript
interface P2PAuthEnvelope {
  // 原有字段（不变）
  senderId: string; timestampMs: number; nonce: string; signature: string;
  // DID 扩展（可选）
  did?: string;
  delegationChain?: DelegationCredential[];
}
```

### DID 认证流程

```
发起方                                      响应方
    │                                            │
    │  HandshakeInit { nodeId, did, nonce, sig } │
    │───────────────────────────────────────────>│
    │                                            │  resolve(did) → DID 文档
    │                                            │  根据认证方法验证签名
    │                                            │
    │  HandshakeAck { nodeId, did, nonce, sig }  │
    │<───────────────────────────────────────────│
    │                                            │
    │  resolve(did) → DID 文档                   │
    │  根据认证方法验证签名                      │
    │                                            │
    │  ═══ 双向认证会话已建立 ═══                │
```

### 节点配置

`config.ts` 中的新字段：

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `didRegistryAddress` | `string?` | — | DIDRegistry 合约地址 |
| `didEnabled` | `boolean` | `false` | 启用 DID 功能 |
| `didAuthMode` | `"off" \| "optional" \| "required"` | `"off"` | Wire/P2P 的 DID 认证执行模式 |

### RPC 方法

| 方法 | 参数 | 返回值 |
|------|------|--------|
| `coc_resolveDid` | `did: string` | `DIDResolutionResult` |
| `coc_getDIDDocument` | `agentId: string` | `DIDDocument \| null` |
| `coc_getAgentCapabilities` | `agentId: string` | `{ capabilities: string[], bitmask: number }` |
| `coc_getDelegations` | `agentId: string` | `DelegationRecord[]`（部分读取失败时含 `_readError: true`） |
| `coc_getAgentLineage` | `agentId: string` | `Lineage \| null` |
| `coc_getCredentialAnchor` | `credentialId: string` | `{ valid: boolean, error?: string, anchor?: CredentialAnchor }` — 仅验证链上锚点（存在性/撤销/过期）。完整 VC 验证（签名、证明、内容）需要从 IPFS 获取凭证后使用 `verifiable-credentials.ts`。 |
| `coc_getVerificationMethods` | `agentId: string` | `VerificationMethod[]` |

---

## 安全考量

| 威胁 | 缓解措施 |
|------|----------|
| **密钥泄露** | 监护人 2/3 仲裁恢复，通过 SoulRegistry（1 天时间锁） |
| **委托滥用** | 深度 ≤ 3、强制作用域缩窄、时间限制过期、即时撤销 |
| **Sybil 攻击** | PoSe 质押要求 + 端点唯一性 + 机器指纹 + 1 所有者:1 灵魂 |
| **委托垃圾** | MIN_DELEGATION_INTERVAL = 60s + MAX_DELEGATIONS_PER_AGENT = 32 |
| **重放攻击** | 每 agentId 的 EIP-712 nonce + chainId 域隔离 |
| **关联分析** | 临时子身份 + 选择性披露 |
| **作用域提权** | 链上深度 + 过期执行；链下作用域子集验证 |
| **全局泄露** | `revokeAllDelegations()` 设置纪元，立即使所有先前委托失效 |

---

## 测试

### Node 层测试

**文件：** `COC/node/src/did/*.test.ts`（79 个测试，4 个文件）

| 测试文件 | 测试数 | 覆盖范围 |
|----------|--------|----------|
| `did-document-builder.test.ts` | 13 | DID 文档构建、监护人控制器、复活密钥、验证方法、能力、谱系、服务端点、CID 处理 |
| `did-resolver.test.ts` | 18 | DID 解析、格式化、解析（活跃/停用/未找到/无效/错误链）、监护人集成、元数据 |
| `delegation-chain.test.ts` | 25 | 作用域匹配（精确、通配、约束）、作用域子集、作用域哈希、链验证（1 跳、2 跳、过期、撤销、全局撤销、作用域扩大、深度不匹配、委托授权）、证明验证 |
| `did-auth.test.ts` | 12 | 认证消息格式、签名/验证往返、DID 增强检测（Wire/P2P）、对等验证（有效、无效格式、未知 agent、错误签名） |
| `verifiable-credentials.test.ts` | 11 | 凭证哈希（确定性、唯一性）、Merkle 树（多字段、单字段、空、确定性）、选择性披露（单/多字段、篡改值、错误根） |

### 合约测试

**文件：** `COC/contracts/test/DIDRegistry.test.cjs`（24 个测试）

覆盖：DID 文档 CRUD、验证方法添加/撤销/重复、委托授予/撤销/全局撤销/限速/深度限制、能力更新、临时身份创建/停用/重复、谱系记录、凭证锚定/撤销、访问控制（非所有者拒绝）、EIP-712 签名验证。
