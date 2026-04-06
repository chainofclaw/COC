# AI 硅基永生：Soul Registry 与 Agent 备份系统

## 概述

COC 链的**AI 硅基永生（Silicon Immortality）**功能为 AI Agent 提供了区块链锚定的身份注册、状态备份与社交恢复机制。核心思想是：Agent 的身份文件（IDENTITY.md、SOUL.md）、记忆、对话历史等状态数据通过 IPFS 存储并加密，其完整性哈希（Merkle Root）通过 EIP-712 签名交易锚定到链上的 `SoulRegistry` 合约，确保 Agent 的"灵魂"可验证、可恢复、不可篡改。

系统由两个核心组件构成：

| 组件 | 位置 | 职责 |
|------|------|------|
| **SoulRegistry 合约** | `contracts/contracts-src/governance/SoulRegistry.sol` | 链上身份注册、备份锚定、社交恢复 |
| **coc-backup 扩展** | `extensions/coc-backup/` | 链下备份执行：文件扫描、加密、IPFS 上传、链上锚定、恢复 |

---

## 架构总览

```
+---------------------+     +------------------+     +-------------------+
|   OpenClaw Agent    |     |   COC IPFS Node  |     |  COC 区块链        |
|                     |     |                  |     |                   |
| dataDir/            |     | /api/v0/add      |     | SoulRegistry.sol  |
|  IDENTITY.md        | --> | /ipfs/{cid}      | --> |  registerSoul()   |
|  SOUL.md            |     | /api/v0/files/*  |     |  anchorBackup()   |
|  memory/*.md        |     +------------------+     |  updateIdentity() |
|  sessions/*.jsonl   |                              |  社交恢复          |
+---------------------+                              +-------------------+
        |                                                     ^
        |              coc-backup 扩展                         |
        +-- 扫描 --> 差异检测 --> 加密 --> IPFS上传 --> EIP-712签名 --+
```

### 数据流

**备份路径：**
1. `change-detector` 扫描 dataDir，按规则分类文件，计算 SHA-256
2. 与上一次 manifest 对比，识别 added/modified/deleted/unchanged
3. `uploader` 对新增/修改文件执行可选 AES-256-GCM 加密，上传至 IPFS
4. `manifest-builder` 构建 Merkle 树（SHA-256，域分离前缀），生成 `SnapshotManifest`
5. `anchor` 将 manifest 上传 IPFS，通过 `SoulClient` 发起 EIP-712 签名的链上交易

**恢复路径：**
1. 用户提供最新 manifest 的 IPFS CID
2. `chain-resolver` 沿 `parentCid` 链递归下载所有 manifest（直到全量备份）
3. `integrity-checker` 校验每层 manifest 的 Merkle Root 自洽性
4. `downloader` 按从旧到新顺序下载并解密文件，写入目标目录
5. `integrity-checker` 对最终磁盘文件做 SHA-256 校验

---

## SoulRegistry 合约

**文件：** `contracts/contracts-src/governance/SoulRegistry.sol`（约 870 行）

### 核心数据结构

#### SoulIdentity（灵魂身份）

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | `bytes32` | 唯一身份标识（当前 CLI 默认语义为 `keccak256(owner wallet address)`，也可显式传入覆盖） |
| `owner` | `address` | 控制该灵魂的 EOA 地址 |
| `identityCid` | `bytes32` | IDENTITY.md + SOUL.md 的 IPFS CID 哈希 |
| `latestSnapshotCid` | `bytes32` | 最新备份 manifest 的 CID 哈希 |
| `registeredAt` | `uint64` | 注册时间戳 |
| `lastBackupAt` | `uint64` | 最后备份时间戳 |
| `backupCount` | `uint32` | 历史备份次数 |
| `version` | `uint16` | Schema 版本（当前为 1） |
| `active` | `bool` | 是否激活 |

#### BackupAnchor（备份锚点）

| 字段 | 类型 | 说明 |
|------|------|------|
| `manifestCid` | `bytes32` | 备份 manifest 的 CID 哈希 |
| `dataMerkleRoot` | `bytes32` | 所有备份文件的 Merkle Root |
| `anchoredAt` | `uint64` | 锚定时间戳 |
| `fileCount` | `uint32` | 文件数量 |
| `totalBytes` | `uint64` | 总字节数 |
| `backupType` | `uint8` | `0` = 全量，`1` = 增量 |
| `parentManifestCid` | `bytes32` | 增量备份的父 CID（全量时为 zero） |

### EIP-712 签名

合约使用 EIP-712 结构化签名保护所有写操作：

- **域名：** `name="COCSoulRegistry"`, `version="1"`, `chainId=block.chainid`
- **三类操作类型哈希：**
  - `RegisterSoul(bytes32 agentId, bytes32 identityCid, address owner, uint64 nonce)`
  - `AnchorBackup(bytes32 agentId, bytes32 manifestCid, bytes32 dataMerkleRoot, uint32 fileCount, uint64 totalBytes, uint8 backupType, bytes32 parentManifestCid, uint64 nonce)`
  - `UpdateIdentity(bytes32 agentId, bytes32 newIdentityCid, uint64 nonce)`
- **Nonce：** per-agentId 递增计数器，三类操作共享，防止重放攻击

TypeScript 侧 EIP-712 类型定义在 `node/src/crypto/soul-registry-types.ts`。

### 写操作

| 函数 | 说明 | 访问控制 |
|------|------|----------|
| `registerSoul(agentId, identityCid, sig)` | 注册新灵魂身份 | msg.sender 即 owner，EIP-712 签名验证 |
| `anchorBackup(agentId, manifestCid, dataMerkleRoot, fileCount, totalBytes, backupType, parentManifestCid, sig)` | 锚定一次备份 | owner + EIP-712 |
| `updateIdentity(agentId, newIdentityCid, sig)` | 更新身份 CID | owner + EIP-712 |
| `addGuardian(agentId, guardian)` | 添加恢复守护者 | owner only |
| `removeGuardian(agentId, guardian)` | 移除守护者（软删除） | owner only |
| `initiateRecovery(agentId, newOwner)` | 发起社交恢复 | 活跃守护者 |
| `approveRecovery(requestId)` | 批准恢复请求 | 活跃守护者 |
| `completeRecovery(requestId)` | 执行恢复转移 | 任何人（满足条件即可） |
| `cancelRecovery(requestId)` | 取消待处理恢复 | owner only |
| `deactivateSoul(agentId)` | 停用灵魂身份 | owner only |

### 视图函数

| 函数 | 返回 |
|------|------|
| `getSoul(agentId)` | 完整 SoulIdentity |
| `getLatestBackup(agentId)` | 最新 BackupAnchor |
| `getBackupHistory(agentId, offset, limit)` | 分页备份历史 |
| `getBackupCount(agentId)` | 备份总数 |
| `getGuardians(agentId)` | 守护者列表 |
| `getActiveGuardianCount(agentId)` | 活跃守护者数 |
| `getResurrectionReadiness(requestId)` | 复活请求聚合就绪状态（是否存在、票数、离线状态、可否完成） |

### 社交恢复机制

当 Agent 的 owner 私钥丢失时，通过守护者体系恢复所有权：

1. **守护者管理：** 每个 agentId 最多 7 个活跃守护者（`MAX_GUARDIANS=7`），不可自我守护
2. **发起恢复：** 任一活跃守护者调用 `initiateRecovery(agentId, newOwner)`，发起者自动计 1 票。此时存储 `guardianSnapshot`（发起时的活跃守护者数量），防止恢复期间阈值被操纵
3. **批准阈值：** 需 `ceil(2/3 * guardianSnapshot)` 个守护者批准（基于快照而非实时数量）
4. **时间锁：** 满足投票阈值后，还需等待 `RECOVERY_DELAY = 1 day`
5. **执行转移：** 双条件满足后任何人可调用 `completeRecovery()`，owner 指针转移，身份数据完整保留
6. **取消恢复：** Owner 可调用 `cancelRecovery(requestId)` 在完成前中止恢复流程

### 复活机制

#### 设计原理

**与社交恢复的核心区别：**

| | 社交恢复 | 复活 |
|-|---------|------|
| **目的** | 所有权转移（私钥丢失） | 在新硬件上重建 Agent（载体故障） |
| **Owner** | 变更为 `newOwner` | 保持不变 |
| **触发条件** | 仅守护者发起 | 主人密钥 OR 守护者投票（需失联超时） |
| **时间锁** | 1 天 (`RECOVERY_DELAY`) | 守护者路径 12 小时 (`RESURRECTION_DELAY`)；主人密钥无时间锁 |
| **结果** | `ownerToAgent` 指针转移 | 链上复活授权完成，心跳重置（实际恢复发生在载体链下拉取并启动 Agent 之后） |

复活机制解决的是社交恢复未覆盖的场景：当 Agent 的物理主机（服务器/VM/容器）永久不可用，但主人私钥并未丢失。目标不是转移所有权，而是在另一个载体上拉起 Agent 的新副本，从 IPFS 备份中恢复完整状态。

#### 三层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                       复活三层模型                                │
├────────────────┬─────────────────────┬──────────────────────────┤
│    触发层       │      授权层         │        执行层             │
├────────────────┼─────────────────────┼──────────────────────────┤
│ 主人复活密钥    │ EIP-712 签名        │ 载体注册与分配            │
│ 心跳超时        │ Guardian 2/3 投票   │ IPFS 状态恢复             │
│ 好友发起        │ 时间锁              │ 载体就绪确认              │
│                │                     │ 心跳重置                  │
└────────────────┴─────────────────────┴──────────────────────────┘
```

#### 数据结构

##### ResurrectionConfig（复活配置）

每个 agentId 存储一份。由灵魂 owner 通过 `configureResurrection()` 设置。

| 字段 | 类型 | 说明 |
|------|------|------|
| `resurrectionKeyHash` | `bytes32` | `keccak256(abi.encodePacked(resurrectionKeyAddress))` — 复活密钥持有者 ETH 地址的哈希 |
| `maxOfflineDuration` | `uint64` | 无心跳的最大允许秒数，超出则视为失联 |
| `lastHeartbeat` | `uint64` | 最后心跳时间戳（配置时和每次心跳自动更新） |
| `configured` | `bool` | 该灵魂是否已配置复活 |

##### Carrier（载体）

注册用于接收复活 Agent 的物理主机。

| 字段 | 类型 | 说明 |
|------|------|------|
| `carrierId` | `bytes32` | 唯一标识 |
| `owner` | `address` | 载体提供者 EOA |
| `endpoint` | `string` | 通信地址 (URL/IP) |
| `registeredAt` | `uint64` | 注册时间戳 |
| `cpuMillicores` | `uint64` | CPU 规格 |
| `memoryMB` | `uint64` | 内存规格 |
| `storageMB` | `uint64` | 存储规格 |
| `available` | `bool` | 是否接受新灵魂 |
| `active` | `bool` | 是否注册中（注销后为 false） |

##### ResurrectionRequest（复活请求）

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | `bytes32` | 被复活的灵魂 |
| `carrierId` | `bytes32` | 目标载体 |
| `initiator` | `address` | 发起人 |
| `initiatedAt` | `uint64` | 发起时间戳 |
| `approvalCount` | `uint8` | 守护者批准数（仅守护者路径） |
| `guardianSnapshot` | `uint8` | 发起时的活跃守护者数 |
| `executed` | `bool` | 已完成或已取消 |
| `carrierConfirmed` | `bool` | 载体已确认 |
| `trigger` | `ResurrectionTrigger` | `OwnerKey` 或 `GuardianVote` |

##### ResurrectionTrigger（枚举）

| 值 | 说明 |
|----|------|
| `OwnerKey` (0) | 主人使用复活密钥发起 |
| `GuardianVote` (1) | 守护者在失联超时后投票发起 |

#### EIP-712 签名类型

合约新增两个 EIP-712 类型哈希。TypeScript 定义位于 `node/src/crypto/soul-registry-types.ts`。

```
ResurrectSoul(bytes32 agentId, bytes32 carrierId, uint64 nonce)
Heartbeat(bytes32 agentId, uint64 timestamp, uint64 nonce)
```

与现有操作（`RegisterSoul`、`AnchorBackup`、`UpdateIdentity`）共享同一域名和 nonce 计数器。

#### 合约函数

##### 配置与心跳

| 函数 | 说明 | 访问控制 |
|------|------|----------|
| `configureResurrection(agentId, keyHash, maxOffline)` | 设置复活密钥和失联阈值 | owner only |
| `heartbeat(agentId, timestamp, sig)` | 证明 Agent 存活（EIP-712 签名，消耗 nonce） | owner + EIP-712 |
| `isOffline(agentId)` → `bool` | 检查 `block.timestamp > lastHeartbeat + maxOfflineDuration` | view |
| `getResurrectionConfig(agentId)` | 读取复活配置 | view |

##### 载体管理

| 函数 | 说明 | 访问控制 |
|------|------|----------|
| `registerCarrier(carrierId, endpoint, cpu, mem, storage)` | 注册物理主机 | 任何人 |
| `deregisterCarrier(carrierId)` | 标记载体为不活跃 | 载体 owner |
| `updateCarrierAvailability(carrierId, available)` | 切换可用状态 | 载体 owner |
| `getCarrier(carrierId)` | 读取载体信息 | view |

##### 复活请求流程

| 函数 | 说明 | 访问控制 |
|------|------|----------|
| `initiateResurrection(agentId, carrierId, sig)` | 主人密钥路径 — 用复活密钥签名 | 任何人均可代发，但必须携带有效复活密钥签名 |
| `initiateGuardianResurrection(agentId, carrierId)` | 守护者路径 — 需 `isOffline()` | 活跃守护者 |
| `approveResurrection(requestId)` | 批准守护者发起的请求 | 活跃守护者 |
| `confirmCarrier(requestId)` | 载体确认愿意承载 | 载体 owner |
| `completeResurrection(requestId)` | 完成复活，重置心跳 | 任何人（满足条件后） |
| `cancelResurrection(requestId)` | 取消待处理请求 | owner 或发起人 |

#### 主人密钥路径（时序图）

```
Owner                    合约                      载体
  │                         │                         │
  │  configureResurrection  │                         │
  │  (keyHash, maxOffline)  │                         │
  │────────────────────────>│                         │
  │                         │                         │
  │  initiateResurrection   │                         │
  │  (agentId, carrierId,   │                         │
  │   复活密钥签名)          │                         │
  │────────────────────────>│ emit ResurrectionInitiated
  │                         │                         │
  │                         │  confirmCarrier         │
  │                         │<────────────────────────│
  │                         │ emit CarrierConfirmed   │
  │                         │                         │
  │  completeResurrection   │                         │
  │────────────────────────>│                         │
  │                         │ 重置 lastHeartbeat      │
  │                         │ emit ResurrectionCompleted
  │                         │                         │
  ├─────────── 链上授权阶段结束 ──────────────────────┤
  │                                                   │
  │              (链下恢复阶段——不在合约管控范围内)       │
  │                         │                         │
  │                         │  载体拉取 IPFS manifest  │
  │                         │  → 下载文件 → 启动 Agent │
  │                         │<────────────────────────│
  │                         │                         │
  │                         │  Agent 首次真实 heartbeat │
  │                         │  = 实际恢复成功的证明     │
```

**无时间锁。** 主人密钥 = 最高权限——只要能提供有效的复活密钥签名，唯一的门槛是载体确认可以承载。

#### 守护者投票路径（时序图）

```
                           心跳超时
守护者₁                     合约                      载体
  │                         │                         │
  │  isOffline(agentId)?    │                         │
  │────────────────────────>│ 返回 true               │
  │                         │                         │
  │ initiateGuardianRes.    │                         │
  │ (agentId, carrierId)    │                         │
  │────────────────────────>│ snapshot=3, approval=1  │
  │                         │ emit ResurrectionInitiated
  │                         │                         │
守护者₂                     │                         │
  │  approveResurrection    │                         │
  │────────────────────────>│ approval=2 (≥ ceil(2/3×3)=2) ✓
  │                         │                         │
  │                         │  confirmCarrier         │
  │                         │<────────────────────────│
  │                         │                         │
  │        ···12 小时后···                             │
  │                         │                         │
任何人                       │                         │
  │  completeResurrection   │                         │
  │────────────────────────>│ 检查: approvals ≥ 2 ✓   │
  │                         │ 检查: 时间 ≥ 12h ✓      │
  │                         │ 检查: 载体已确认 ✓       │
  │                         │ 重置 lastHeartbeat      │
  │                         │ emit ResurrectionCompleted
  │                         │                         │
  ├─────────── 链上授权阶段结束 ──────────────────────┤
  │              (链下恢复阶段同主人密钥路径)            │
```

**守护者路径三条件：**
1. `approvalCount >= ceil(2/3 * guardianSnapshot)`
2. `block.timestamp >= initiatedAt + RESURRECTION_DELAY`（12 小时）
3. `carrierConfirmed == true`

12 小时时间锁（对比所有权恢复的 1 天）反映了 Agent 停机的紧急性高于密钥丢失。

#### 载体提供模型

```
                   ┌────────────────────────────────┐
                   │          载体注册表              │
                   │     (SoulRegistry 合约内)       │
                   └──────────┬─────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────┴────┐   ┌─────┴────┐   ┌──────┴────┐
        │  自有载体  │   │ 社区载体  │   │  云载体   │
        │ (自建 VPS) │   │(志愿者节点)│   │(API 集成) │
        └──────────┘   └──────────┘   └───────────┘
```

**注册流程：**
1. 提供者调用 `registerCarrier(carrierId, endpoint, cpuMillicores, memoryMB, storageMB)`
2. 载体标记为 `available = true` 且 `active = true`
3. 复活请求指定 carrierId 后，提供者调用 `confirmCarrier(requestId)` 确认资源可用

**链下载体协议（确认后）：**
1. 载体监听匹配自身 carrierId 的 `ResurrectionInitiated` 事件
2. 验证本地资源满足 Agent 需求
3. 链上调用 `confirmCarrier(requestId)`

*以下为链下恢复阶段（不在合约管控范围内）：*

4. `ResurrectionCompleted` 后，从 IPFS 拉取 Agent 最新备份 manifest。链上存储 `keccak256(cidString)` 作为 `bytes32`，通过三层 CID 解析器（本地索引 → MFS cid-map → 链上 `CidRegistry.sol`）自动还原为原始 CID。`restoreFromChain()` 已实现，可通过 `CidResolver` 全自动完成恢复（参见 `state-restorer.ts`、`cid-resolver.ts`）。
5. 下载并解密所有文件（使用 `restoreFromManifestCid()` 管道）
6. 启动 Agent 进程
7. Agent 发送首次**真实** `heartbeat()` — 这才是实际恢复成功的证明

#### 链下集成

##### 自动心跳（scheduler.ts）

`BackupScheduler` 将心跳发送集成到备份周期中：
- 每次 `runBackup()` 成功后，自动调用 `soul.heartbeat(agentId)`
- 即使无文件变更（跳过备份），仍发送心跳
- 心跳间隔 = `autoBackupIntervalMs`（默认 1 小时）
- 失败为非致命：记录警告，不阻塞备份管道

##### SoulClient 方法（soul-client.ts）

| 方法 | 签名 | 说明 | 状态 |
|------|------|------|------|
| `configureResurrection` | `(agentId, keyHash, maxOffline) → txHash` | 配置复活参数 | ✅ 已实现 |
| `heartbeat` | `(agentId) → txHash` | 发送 EIP-712 签名心跳（自动生成 timestamp） | ✅ 已实现 |
| `isOffline` | `(agentId) → boolean` | 检查失联状态 | ✅ 已实现 |
| `getResurrectionConfig` | `(agentId) → ResurrectionConfig` | 读取配置 | ✅ 已实现 |
| `initiateResurrection` | `(agentId, carrierId, resurrectionKey) → { txHash, requestId }` | 主人密钥复活（内部用复活私钥创建 Wallet，并从事件解析 requestId） | ✅ 已实现 |
| `registerCarrier` | `(carrierId, endpoint, cpu, mem, storage) → txHash` | 注册载体 | ✅ 已实现 |
| `getCarrier` | `(carrierId) → CarrierInfo` | 读取载体信息 | ✅ 已实现 |
| `deregisterCarrier` | `(carrierId) → txHash` | 注销载体 | ✅ 已实现 |
| `updateCarrierAvailability` | `(carrierId, available) → txHash` | 切换载体可用状态 | ✅ 已实现 |
| `getResurrectionRequest` | `(requestId) → ResurrectionRequestInfo` | 读取复活请求详情 | ✅ 已实现 |
| `getResurrectionApproval` | `(requestId, guardian) → boolean` | 查询守护者是否已批准 | ✅ 已实现 |
| `getResurrectionReadiness` | `(requestId) → ResurrectionReadiness` | 聚合读取票数、离线状态、可否完成 | ✅ 已实现 |
| `initiateGuardianResurrection` | `(agentId, carrierId) → ResurrectionStartResult` | 守护者发起复活 | ✅ 已实现 |
| `approveResurrection` | `(requestId) → txHash` | 批准复活请求 | ✅ 已实现 |
| `confirmCarrier` | `(requestId) → txHash` | 载体确认承载 | ✅ 已实现 |
| `completeResurrection` | `(requestId) → txHash` | 完成复活 | ✅ 已实现 |
| `cancelResurrection` | `(requestId) → txHash` | 取消复活请求 | ✅ 已实现 |

> **插件覆盖范围与角色分离：**
>
> 所有合约方法均已在 `SoulClient` 中封装。但 **载体守护进程只执行载体角色的动作**：确认载体、等待就绪、下载备份、启动 Agent、完成复活、发送心跳。它 **不会** 发起或批准守护者投票复活——那些是守护者节点的职责，通过单独的守护者 CLI 或脚本完成。
>
> - **主人密钥路径（自托管）：** 插件 CLI + 工具覆盖完整闭环（配置 → 心跳 → 发起 → 确认 → 完成）。单个 EOA 即可。
> - **守护者投票路径：** 守护者外部调用 `initiateGuardianResurrection` + `approveResurrection`。载体守护进程通过配置 `pendingRequestIds` 或 `addRequest()` 接收待处理请求，确认载体，轮询 `getResurrectionReadiness()` 直到法定人数 + 时间锁满足，然后下载备份、启动 Agent、链上完成、发送心跳。
> - **角色约束：** `confirmCarrier` 需要载体所有者 EOA；`initiateGuardianResurrection` / `approveResurrection` 需要活跃守护者 EOA。生产环境中这些是不同的密钥。

##### CLI 命令

| 命令 | 说明 | 状态 |
|------|------|------|
| `coc-backup init [--agent-id] [--identity-cid] [--key-hash] [--max-offline]` | 初始化注册、首次全量备份、写入本地恢复元数据 | ✅ 已实现 |
| `coc-backup doctor [--json]` | 输出统一 `DoctorReport` 与推荐动作 | ✅ 已实现 |
| `coc-backup configure-resurrection --key-hash <hash> [--max-offline <sec>]` | 配置复活密钥和失联超时（默认 86400 秒 = 24 小时） | ✅ 已实现 |
| `coc-backup heartbeat` | 手动发送心跳 | ✅ 已实现 |
| `coc-backup resurrect --carrier-id <id> --resurrection-key <key> [--agent-id <id>]` | 主人密钥发起复活（`--agent-id` 用于为他人代理复活） | ✅ 已实现 |
| `coc-backup resurrection start ...` | 显式的 owner-key 复活发起命令 | ✅ 已实现 |
| `coc-backup resurrection status [--request-id] [--json]` | 查看请求详情与 readiness | ✅ 已实现 |
| `coc-backup resurrection confirm [--request-id]` | 载体确认承载 | ✅ 已实现 |
| `coc-backup resurrection complete [--request-id]` | 完成复活请求 | ✅ 已实现 |
| `coc-backup resurrection cancel [--request-id]` | 取消复活请求 | ✅ 已实现 |
| `coc-backup carrier register --carrier-id <id> --endpoint <url> [--cpu] [--memory] [--storage]` | 注册为载体提供者 | ✅ 已实现 |
| `coc-backup carrier list` | 列出已知载体（需索引器） | 未实现 |

##### TypeScript 类型（types.ts）

```typescript
interface ResurrectionConfig {
  resurrectionKeyHash: string  // bytes32
  maxOfflineDuration: number   // 秒
  lastHeartbeat: number        // unix 时间戳
  configured: boolean
}

interface CarrierInfo {
  carrierId: string            // bytes32
  owner: string                // address
  endpoint: string
  registeredAt: number         // unix 时间戳
  cpuMillicores: number
  memoryMB: number
  storageMB: number
  available: boolean
  active: boolean
}

interface ResurrectionResult {
  requestId: string
  agentId: string
  carrierId: string
  trigger: "owner-key" | "guardian-vote"
  filesRestored: number
  totalBytes: number
}

interface ResurrectionReadiness {
  exists: boolean
  trigger: "owner-key" | "guardian-vote"
  approvalCount: number
  approvalThreshold: number
  carrierConfirmed: boolean
  offlineNow: boolean
  readyAt: number
  canComplete: boolean
}
```

#### 安全考量

| 威胁 | 缓解措施 |
|------|----------|
| **复活密钥泄露** | 密钥哈希存于链上——攻击者还需找到愿意确认的可用载体。Owner 可随时用新密钥重新配置。 |
| **心跳伪造** | 心跳需要灵魂 owner 的 EIP-712 签名（nonce 保护）。其他人无法发送心跳。 |
| **误判失联** | `maxOfflineDuration` 由 owner 配置。设置过短会在临时网络问题时触发误报。 |
| **载体冒充** | 载体确认由载体 owner 地址门控。攻击者需要载体的私钥。 |
| **守护者串谋（复活）** | 与社交恢复相同的 2/3 阈值。且需 `isOffline == true`——发起**和完成**时均复检，守护者无法复活在线 Agent；若 Agent 在 12 小时等待期内恢复心跳，该请求将无法完成。 |
| **载体拒绝确认** | 若目标载体从不确认，复活请求保持待处理。Owner 或发起人可取消后换一个载体重新发起。 |
| **Nonce 共享** | 复活和心跳操作与注册/备份/更新共享同一 per-agentId nonce 计数器，防止跨操作重放。 |
| **假在线/假复活** | `completeResurrection()` 立即刷新 `lastHeartbeat`，但不证明载体已成功恢复并启动 Agent。真正的存活证明需要后续的**真实** `heartbeat()` 签名交易（由恢复后的 Agent 主动发起）。 |
| **恢复链路信任边界** | 载体执行 `restoreFromManifestCid()` 时，链上 anchor 校验使用 manifest 内嵌的 `agentId`（非调用者钱包），任何有 RPC 访问的载体均可完成链上完整性校验。注意：manifest 中的 `agentId` 本身未经签名保护——完整性依赖 Merkle root 与链上 anchor 的匹配。 |

### 事件

| 事件 | 触发时机 |
|------|----------|
| `SoulRegistered(agentId, owner, identityCid)` | 注册成功 |
| `BackupAnchored(agentId, manifestCid, dataMerkleRoot, backupType)` | 锚定备份 |
| `IdentityUpdated(agentId, newIdentityCid)` | 更新身份 |
| `GuardianAdded(agentId, guardian)` | 添加守护者 |
| `GuardianRemoved(agentId, guardian)` | 移除守护者 |
| `RecoveryInitiated(requestId, agentId, newOwner)` | 发起恢复 |
| `RecoveryApproved(requestId, guardian)` | 批准恢复 |
| `RecoveryCompleted(requestId, agentId, newOwner)` | 恢复完成 |
| `RecoveryCancelled(requestId, agentId)` | Owner 取消恢复 |
| `SoulDeactivated(agentId, owner)` | Owner 停用灵魂 |
| `ResurrectionConfigured(agentId, keyHash, maxOffline)` | 复活参数已设置 |
| `Heartbeat(agentId, timestamp)` | 收到心跳 |
| `CarrierRegistered(carrierId, owner, endpoint)` | 载体已注册 |
| `CarrierDeregistered(carrierId)` | 载体已注销 |
| `ResurrectionInitiated(requestId, agentId, carrierId, trigger)` | 复活已发起 |
| `ResurrectionApproved(requestId, guardian)` | 守护者批准复活 |
| `CarrierConfirmed(requestId, carrierId)` | 载体确认承载 |
| `ResurrectionCompleted(requestId, agentId, carrierId)` | 复活完成 |
| `ResurrectionCancelled(requestId)` | 复活已取消 |

### 自定义错误

| 错误 | 触发条件 |
|------|----------|
| `AlreadyRegistered()` | 重复 owner 或 agentId 注册 |
| `NotRegistered()` | 操作不存在的灵魂 |
| `NotOwner()` | 调用者非灵魂 owner |
| `InvalidAgentId()` | 注册时传入零 agentId |
| `InvalidSignature()` | EIP-712 签名验证失败 |
| `AgentIdTaken()` | 重复 agentId 注册 |
| `SoulNotActive()` | 操作已停用的灵魂 |
| `GuardianLimitReached()` | 活跃守护者数量已达 MAX_GUARDIANS |
| `GuardianAlreadyAdded()` | 守护者地址已激活 |
| `GuardianNotFound()` | 尝试移除非活跃守护者 |
| `CannotGuardSelf()` | Owner 不能做自己的守护者 |
| `RecoveryNotFound()` | 恢复请求不存在 |
| `RecoveryAlreadyExecuted()` | 恢复已完成或已取消 |
| `RecoveryNotReady()` | 批准数不足或时间锁未过 |
| `AlreadyApproved()` | 守护者已对此请求投票 |
| `NotGuardian()` | 调用者非活跃守护者 |
| `InvalidBackupType()` | backupType 不是 0 或 1 |
| `ParentCidRequired()` | 增量备份缺少 parentManifestCid |
| `InvalidAddress()` | 零地址传入恢复或守护者操作 |
| `InvalidCid()` | 零 bytes32 作为 CID（注册、更新或备份） |
| `ResurrectionNotConfigured()` | 对未配置复活的灵魂执行复活操作 |
| `NotOffline()` | 守护者复活需要 Agent 已失联 |
| `CarrierNotFound()` | 载体未注册或已注销 |
| `CarrierNotAvailable()` | 载体不接受新灵魂 |
| `NotCarrierOwner()` | 调用者非载体所有者 |
| `CarrierAlreadyRegistered()` | 重复载体注册 |
| `ResurrectionNotFound()` | 复活请求不存在 |
| `ResurrectionAlreadyExecuted()` | 复活已完成或已取消 |
| `ResurrectionNotReady()` | 批准数不足或时间锁未过 |
| `CarrierNotConfirmed()` | 载体未确认复活请求 |
| `InvalidKeyHash()` | 零复活密钥哈希 |

### 约束与安全

- **一对一绑定：** `ownerToAgent` 映射确保一个 EOA 只能拥有一个 agentId
- **签名验证：** 使用汇编级 `ecrecover`，严格校验 sig 长度 65、v 值 27/28、非零恢复地址，EIP-2 规范 `s` 检查（拒绝可锻造签名）
- **输入校验：** 零地址触发 `InvalidAddress`，零 bytes32 CID/Merkle root 触发 `InvalidCid`
- **CID 存储：** 链上存储 `keccak256(cidString)` 而非原始 CID（节省 gas，但不可逆向）

### 部署

部署脚本位于 `contracts/deploy/deploy-soul-registry.ts`：

| 目标 | chainId | 确认数 | Gas 策略 |
|------|---------|--------|----------|
| `l2-coc` | 18780 | 1 | legacy |
| `l1-sepolia` | 11155111 | 3 | EIP-1559 (30/2 gwei) |
| `l1-mainnet` | 1 | 5 | EIP-1559 (50/2 gwei) |

### 测试

`contracts/test/SoulRegistry.test.cjs` 当前包含 58 个测试场景：
- 注册：合法注册、zero agentId、重复 agentId、重复 owner、伪造签名
- 备份：全量备份、增量链、缺失 parentCid、非 owner、分页查询、无效 CID 拒绝
- 身份更新：合法更新、非 owner
- 守护者：添加/移除流程、自我守护、重复添加、非 owner、无效地址
- 社交恢复：完整流程（3守护者+2/3批准+时间锁）、票数不足、时间锁未过、非守护者、重复批准、guardian 快照阈值
- 取消恢复：owner 取消、非 owner 拒绝
- 停用：合法停用、停用后操作阻断
- 签名安全：EIP-2 可锻造签名拒绝
- 边界情况：未注册查询、空历史、零 identityCid 拒绝、守护者重激活、跨操作 nonce 递增
- 复活配置：配置参数、零密钥哈希拒绝、心跳 EIP-712 流程、失联检测
- 载体管理：注册、注销、可用性更新、重复/非 owner 拒绝
- 主人密钥复活：完整流程、缺少载体确认、错误密钥拒绝
- 守护者投票复活：完整流程（失联超时+2/3 批准+12小时时间锁）、批准不足、取消、非守护者拒绝

---

## coc-backup 扩展

**位置：** `extensions/coc-backup/`（OpenClaw 插件）

### 模块架构

```
extensions/coc-backup/
  index.ts                      # 插件入口，注册 CLI/Tool/Hook
  openclaw.plugin.json          # 插件清单
  tsconfig.json                 # 扩展独立类型检查入口
  test/                         # vitest 单测与最小集成测试
  src/
    types.ts                    # 核心类型定义
    config-schema.ts            # Zod 配置 Schema
    plugin-api.ts               # 本地插件 API 类型定义
    utils.ts                    # 路径/格式化/agentId 工具函数
    local-state.ts              # 本地状态与恢复包读写
    lifecycle.ts                # doctor/init/restore 编排层
    crypto.ts                   # AES-256-GCM 加密/解密
    ipfs-client.ts              # IPFS HTTP API 客户端
    soul-client.ts              # SoulRegistry 合约客户端
    cli/
      commands.ts               # CLI 命令组
    backup/
      change-detector.ts        # 文件分类与差异检测
      uploader.ts               # 加密上传至 IPFS
      manifest-builder.ts       # Merkle 树与 Manifest 构建
      anchor.ts                 # IPFS+链上锚定
      scheduler.ts              # 定时自动备份调度器（含状态持久化）
    recovery/
      chain-resolver.ts         # 增量链解析
      downloader.ts             # IPFS 下载与解密
      integrity-checker.ts      # 三层完整性校验
      state-restorer.ts         # 恢复管道编排
```

### 配置

通过 Zod Schema 验证（`src/config-schema.ts`）：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 总开关 |
| `rpcUrl` | string | `http://127.0.0.1:18780` | COC RPC 地址 |
| `ipfsUrl` | string | `http://127.0.0.1:18790` | IPFS API 地址 |
| `contractAddress` | string | 必填 | SoulRegistry 合约地址 |
| `privateKey` | string | 必填 | 以太坊私钥 |
| `dataDir` | string | `~/.openclaw` | 备份数据根目录 |
| `autoBackupEnabled` | boolean | `true` | 定时备份开关 |
| `autoBackupIntervalMs` | number | `3600000` | 备份间隔（默认 1 小时） |
| `encryptMemory` | boolean | `false` | 加密 memory 类文件 |
| `encryptionPassword` | string? | 可选 | 加密密码（覆盖私钥派生） |
| `maxIncrementalChain` | number | `10` | 增量链上限（超出后强制全量） |
| `backupOnSessionEnd` | boolean | `true` | 会话结束时执行备份 |
| `categories.*` | boolean | 全部 `true` | 各文件分类的启用开关 |

### 生命周期与巡检层

`lifecycle.ts` 提供 CLI 和 Agent tool 共享的统一编排层，避免两边各自拼接状态判断。

#### LifecycleState

固定枚举如下：

`unregistered`、`registered_no_backup`、`healthy`、`backup_overdue`、`ipfs_unreachable`、`restore_ready`、`restore_blocked`、`resurrection_unconfigured`、`offline`、`resurrection_pending`、`attention_required`

#### DoctorReport

`buildDoctorReport()` 输出统一结构，覆盖：

- 本地数据目录状态
- `state.json` / `latest-recovery.json` 路径
- IPFS 可达性
- 链上注册状态、备份计数、最近备份时间、是否过期
- 恢复材料是否齐全、是否缺密码
- 复活配置状态、失联状态、待处理请求与 readiness
- 推荐操作列表（CLI 命令建议）

备份过期判定为：

`now - lastBackupAt > max(2 * autoBackupIntervalMs, 6h)`

### CLI 命令

所有命令在 `coc-backup` 子命令组下：

#### `coc-backup init`

自托管首启流程入口，按固定顺序执行：

1. 校验配置与依赖
2. 解析或生成 `agentId`（默认 `keccak256(owner wallet address)`）
3. 如未注册则上链注册 soul
4. 强制执行首次全量备份
5. 写入本地 `state.json` 与 `latest-recovery.json`
6. 可选配置复活参数

```bash
coc-backup init [--agent-id <bytes32>] [--identity-cid <bytes32>] [--key-hash <bytes32>] [--max-offline <seconds>]
```

#### `coc-backup register`
注册 Agent 的链上灵魂身份。
```bash
coc-backup register [--agent-id <bytes32>] [--identity-cid <cid>]
```
- `--agent-id`：省略时自动生成 `keccak256(owner wallet address)`
- `--identity-cid`：省略时读取 `dataDir/IDENTITY.md` 上传

#### `coc-backup backup`
执行一次备份。
```bash
coc-backup backup [--full]
```
- `--full`：强制全量备份（否则根据变更自动选择增量/全量）
- 返回结果区分三种语义：`completed`、`skipped`、`registration_required`
- 心跳状态单独返回：`sent`、`not_configured`、`failed`、`not_attempted`

#### `coc-backup restore`
恢复入口固定支持三种来源之一，不再承诺“从链上自动反推最新 CID”。
```bash
coc-backup restore --manifest-cid <cid> [--target-dir <dir>] [--password <pwd>]
coc-backup restore --package <path> [--target-dir <dir>] [--password <pwd>]
coc-backup restore --latest-local [--target-dir <dir>] [--password <pwd>]
```
- `--manifest-cid`：显式指定目标 manifest
- `--package`：使用本地恢复包 JSON
- `--latest-local`：直接读取 `dataDir/.coc-backup/latest-recovery.json`
- 若恢复目标包含加密文件，且既没有 `--password` 也没有可用 `privateKey`，恢复前直接失败，不进入下载阶段
- 返回结果除恢复计数外，还包含 `requestedManifestCid`、`resolvedAgentId`、`anchorCheckAttempted`、`anchorCheckPassed`、`anchorCheckReason`

#### `coc-backup status`
查询当前生命周期摘要。
```bash
coc-backup status [--json]
```

#### `coc-backup doctor`
执行统一巡检并给出下一步动作建议。
```bash
coc-backup doctor [--json]
```

#### `coc-backup history`
查询链上备份历史。
```bash
coc-backup history [--limit <n>] [--json]
```

#### `coc-backup configure-resurrection`
配置复活密钥哈希和离线阈值。
```bash
coc-backup configure-resurrection --key-hash <bytes32> [--max-offline <seconds>]
```

#### `coc-backup heartbeat`
手动发送一次心跳。
```bash
coc-backup heartbeat
```

#### `coc-backup resurrect`
兼容别名，等价于 `coc-backup resurrection start`。
```bash
coc-backup resurrect --carrier-id <bytes32> --resurrection-key <hex> [--agent-id <bytes32>]
```

#### `coc-backup resurrection ...`
自托管 owner-key 复活闭环命令组。
```bash
coc-backup resurrection start --carrier-id <bytes32> --resurrection-key <hex> [--agent-id <bytes32>]
coc-backup resurrection status [--request-id <bytes32>] [--json]
coc-backup resurrection confirm [--request-id <bytes32>]
coc-backup resurrection complete [--request-id <bytes32>]
coc-backup resurrection cancel [--request-id <bytes32>]
```
- `start` 返回 `txHash + requestId`
- 若未显式传 `--request-id`，其余子命令会回退到本地 `state.json` 中记录的待处理请求

#### `coc-backup carrier ...`
载体管理命令：
```bash
coc-backup carrier register --carrier-id <bytes32> --endpoint <url> [--cpu <millicores>] [--memory <mb>] [--storage <mb>]
coc-backup carrier submit-request --request-id <id> --agent-id <id>   # 向本地 daemon 提交复活请求
coc-backup carrier list          # 占位：需要链上索引器支持
```

#### `coc-backup guardian ...`
守护者侧操作命令（需要守护者 EOA 密钥）：
```bash
coc-backup guardian initiate --agent-id <id> --carrier-id <id>   # 守护者发起复活
coc-backup guardian approve --request-id <id>                     # 守护者批准复活
coc-backup guardian status --request-id <id>                      # 查询复活就绪状态
```

### Agent 工具

插件通过 `api.registerTool()` 注册了九个可供 AI Agent 程序化调用的工具：

| 工具名 | 参数 | 返回 |
|--------|------|------|
| `soul-backup` | `full?: boolean` | `BackupReceipt` + 兼容字段（`manifestCid`、`fileCount`、`totalBytes`、`backupType`、`txHash`） |
| `soul-restore` | `manifestCid?`、`packagePath?`、`latestLocal?`、`targetDir?`、`password?` | `RecoveryResult` |
| `soul-status` | 无 | `{ registered, lifecycleState, doctor }` |
| `soul-doctor` | 无 | 完整 `DoctorReport` |
| `soul-resurrection` | `action=start\|status\|confirm\|complete\|cancel` 等 | owner-key 复活请求管理与 readiness 查询 |
| `soul-auto-restore` | `agentId?`、`targetDir?`、`password?` | 通过 CidResolver 自动链上恢复 |
| `soul-guardian-initiate` | `agentId`、`carrierId` | `{ requestId, txHash }` 守护者发起复活 |
| `soul-guardian-approve` | `requestId` | `{ txHash }` 守护者批准复活 |
| `soul-carrier-request` | `requestId`、`agentId` | 向载体守护进程提交待处理请求 |

### TypeScript 核心类型

这轮新增或扩展的关键类型：

| 类型 | 用途 |
|------|------|
| `LifecycleState` | CLI/tool 共享的生命周期枚举 |
| `DoctorReport` | 巡检与推荐动作结果 |
| `RecommendedAction` | Doctor 输出的下一步建议 |
| `BackupReceipt` | 区分备份成功、跳过、需注册三种结果 |
| `BackupRecoveryPackage` | 本地最新恢复包 |
| `RecoveryResult` | 恢复结果，含 anchor 校验可观测性 |
| `ResurrectionRequestInfo` | 复活请求详情 |
| `ResurrectionReadiness` | 复活请求聚合就绪状态 |

### 加密方案

**算法：** AES-256-GCM（`src/crypto.ts`）

**密钥派生：**
- 从私钥：`SHA-256(privateKeyHex) → scrypt(seed, salt, N=16384, r=8, p=1) → 32字节 key`
- 从密码：`scrypt(password, salt, N=16384, r=8, p=1) → 32字节 key`

**密文格式：** `[salt:32B][iv:12B][auth_tag:16B][ciphertext:NB]`

**加密策略：**
- `identity/device.json` 和 `auth.json` 始终加密
- `memory/*.md` 在 `encryptMemory=true` 时加密
- `IDENTITY.md`、`SOUL.md` 不加密（公开身份信息）

### 文件分类规则

`change-detector.ts` 中定义的分类规则（优先级顺序匹配）：

| 文件模式 | 分类 | 默认加密 |
|----------|------|----------|
| `IDENTITY.md` | identity | 否 |
| `SOUL.md` | identity | 否 |
| `identity/device.json` | config | 是 |
| `auth.json` | config | 是 |
| `MEMORY.md` | memory | 可选 |
| `memory/*.md` | memory | 可选 |
| `USER.md` | memory | 可选 |
| `agents/*/sessions/*.jsonl` | chat | 否 |
| `workspace-state.json` | workspace | 否 |
| `AGENTS.md` | workspace | 否 |
| `memory/*.sqlite` | database | 是 |
| `memory/lancedb/*` | database | 是 |
| `openclaw.json` | config | 是 |
| `plugins/*/openclaw.plugin.json` | config | 否 |
| `agents/*/sessions/sessions.json` | chat | 否 |
| `credentials/*` | config | 是 |
| `.coc-backup/context-snapshot.json` | workspace | 否 |

### Merkle 树实现

`manifest-builder.ts` 实现了与 `node/src/ipfs-merkle.ts` 结构相同（域分离前缀、奇数节点处理）但哈希函数不同的 Merkle 树。节点核心使用 Keccak-256（EVM 兼容），备份扩展使用 SHA-256（链下完整性校验）：

- **叶节点哈希：** `SHA-256(0x00 || leafData)`，域分离前缀 `0x00` 防止叶/内节点碰撞
- **内节点哈希：** `SHA-256(0x01 || left || right)`，域分离前缀 `0x01`
- **叶数据：** 长度前缀编码 `[u32le(path.len) || path || u32le(cid.len) || cid || u32le(hash.len) || hash]`，按路径字典序排序保证确定性（防止冒号拼接的歧义碰撞）
- **奇数处理：** 最后一个奇数节点与自身配对

### 增量备份机制

- **全量备份（backupType=0）：** 包含所有文件，`parentCid=null`
- **增量备份（backupType=1）：** 仅上传变更文件，未变更文件通过 `carryOverEntries()` 从上一个 manifest 复制 CID 引用
- **强制全量触发条件：** `forceFullBackup=true`、首次备份、增量链长度达到 `maxIncrementalChain`（默认 10）
- **Manifest 完整性：** 每个增量 manifest 的 `files` 字段包含**所有**文件（含 carry-over），使任何单一 manifest 都是完整状态快照
- **本地持久化：** 调度器把 `lastManifestCid`、`incrementalCount`、`lastBackupAt`、`lastFullBackupAt` 写入 `dataDir/.coc-backup/state.json`，进程重启后优先恢复增量上下文，不再一律退化为全量备份

### 本地元数据文件

`local-state.ts` 维护两个固定文件：

| 文件 | 路径 | 用途 |
|------|------|------|
| `state.json` | `dataDir/.coc-backup/state.json` | 调度器状态、最近 manifest、待处理复活请求 |
| `latest-recovery.json` | `dataDir/.coc-backup/latest-recovery.json` | 最新恢复包，供 `restore --latest-local` 使用 |

`latest-recovery.json` 固定包含：

- `agentId`
- `latestManifestCid`
- `anchoredAt`
- `txHash`
- `dataMerkleRoot`
- `backupType`
- `encryptionMode`
- `requiresPassword`
- `recommendedRestoreCommand`

### 恢复管道

`state-restorer.ts` 中的 `restoreFromManifestCid()` 实现四步恢复管道：

1. **链解析：** 从目标 CID 出发，沿 `parentCid` 递归下载所有 manifest，组装成有序链（旧→新）
2. **Merkle 校验：** 对链中每个 manifest 重新计算 Merkle Root 并与存储值对比
3. **链上 anchor 校验：** 若目标 manifest 恰好是链上最新备份，则使用 manifest 内嵌 `agentId` 查询并验证链上 anchor；若恢复的是历史快照，则明确记录“未执行链上最新快照校验”的原因
4. **下载应用：** 按从旧到新顺序逐层应用，后写覆盖先写
5. **磁盘校验：** 对最终写入的文件计算 SHA-256 与 manifest 中记录的 hash 对比

> 注意：当前链上 anchor 校验只覆盖“传入 manifest 与链上最新备份一致”的场景。历史快照恢复会返回 `anchorCheckAttempted=false` 和具体原因，而不是伪装成已完成链上核验。

### 安全加固

- **CID 格式校验：** 拒绝包含斜杠、反斜杠、点、空白或超过 512 字符的 CID
- **IPFS 超时：** 所有 IPFS HTTP 调用使用 30 秒 `AbortSignal.timeout`
- **文件大小限制：** 超过 100 MB 的单文件从备份中排除（`MAX_FILE_BYTES`）
- **Manifest 大小上限：** 下载的 manifest 超过 10 MB 时拒绝
- **路径遍历防护：** `downloader.ts` 解析路径后验证其仍在 `targetDir` 范围内
- **符号链接过滤：** `change-detector.ts` 在目录扫描时跳过符号链接（`entry.isSymbolicLink()`）

### 完整性校验三层模型

| 层级 | 函数 | 校验内容 |
|------|------|----------|
| Manifest 自洽 | `verifyManifestMerkleRoot()` | 重新计算 Merkle Root，与 manifest 记录值对比 |
| 磁盘文件 | `verifyRestoredFiles()` | 读取每个文件计算 SHA-256，与 manifest hash 对比 |
| 链上锚定 | `verifyOnChainAnchor()` | manifest Merkle Root 与链上最新备份的 anchor 对比（仅适用于最新快照恢复） |

### CID 注册表（bytes32 → IPFS CID 解析）

链上备份锚定存储 `keccak256(CID)` 作为 `bytes32`，这是不可逆的哈希。CID 解析器实现三层回退机制：

| 层级 | 来源 | 速度 | 可用性 |
|------|------|------|--------|
| 本地索引 | `.coc-backup/cid-index.json` | <1ms | 重启后保持 |
| MFS | `/soul-backups/{agentId}/cid-map.json` | 50-200ms | 去中心化（任意 IPFS 节点） |
| 链上 | `CidRegistry.resolveCid(bytes32)` | 200-500ms | 永久（区块链） |

**CidRegistry.sol**（`contracts/contracts-src/governance/CidRegistry.sol`）：无许可伴生合约。注册为追加写入（不可变条目），带哈希原像验证。支持单条和批量注册。

**注册流程：** 每次 `anchorBackup()` 后，CID 映射通过 `CidResolver.register()` 自动写入三层存储。

**恢复流程：** `restoreFromChain(agentId)` 现在通过解析器链自动解析最新备份 CID，无需用户手动提供 manifest CID。

### 二进制数据库快照

`binary-handler.ts` 确保活跃写入中的数据库文件备份一致性：

- **SQLite：** 使用 `sqlite3 .backup` 命令获取原子快照；回退方案为文件复制 + WAL/SHM
- **LanceDB 目录：** 创建简单归档格式（JSON 索引 + 连接内容），通过 `buildSimpleTar()` 实现
- **清理：** 临时快照文件在上传后自动清除

### 执行上下文快照

`context-snapshot.ts` 在每次备份周期前捕获会话元数据：

```json
{
  "version": 1,
  "capturedAt": "2026-04-05T12:00:00Z",
  "activeSessions": [{
    "sessionId": "abc-123",
    "messageCount": 42,
    "lastMessageAt": "2026-04-05T11:59:30Z",
    "estimatedTokens": 15000,
    "sizeBytes": 65536
  }]
}
```

这使恢复后的上下文重建成为可能，提供 Agent 最后会话状态的元数据。

### OpenClaw 生命周期钩子

插件注册四个生命周期钩子以实现全面备份覆盖：

| 钩子 | 触发时机 | 用途 |
|------|----------|------|
| `session_end` | Agent 会话结束 | 保存会话最终状态 |
| `before_compaction` | 上下文压缩即将发生 | 关键：在 token 裁剪前保存完整上下文 |
| `gateway_stop` | 网关优雅关闭 | 进程退出前最终备份 |
| `stop` | 传统停止事件 | 向后兼容 |

### 载体守护进程（跨节点复活）

载体守护进程在指定载体节点上自动化完整的复活生命周期：

**组件：**
- `offline-monitor.ts` — 轮询 `isOffline()` 监控代理，在线→离线转换时触发事件
- `resurrection-flow.ts` — 载体侧状态机：`verify_offline → confirm_carrier → wait_readiness → download → restore → spawn → health_check → complete`。**不**发起或批准——那是守护者的操作。
- `agent-spawner.ts` — 通过 `node:child_process.spawn()` 启动恢复后的 OpenClaw 进程
- `carrier-daemon.ts` — 整合监控 + 流程 + 启动器，带并发限制、关闭信号（AbortController）和历史追踪。`addRequest()` 返回接纳状态。

**状态机：**
```
idle → monitoring → resurrection_initiated → carrier_confirmed
  → waiting_readiness → downloading_backup → restoring_state
  → spawning_agent → health_checking → resurrection_complete
```

---

## 已知限制

1. **CID 注册表已实现：** 链上存储 `keccak256(cidString)` 作为 `bytes32`，`CidRegistry.sol` + `cid-resolver.ts` 现已提供三层解析（本地索引 → MFS → 链上合约），无需外部链下约定
2. **`restoreFromChain` 已实现：** CidResolver 三层回退机制使得仅凭链上状态即可自动解析出可恢复的真实 manifest CID
3. **历史快照链上校验有限：** `restoreFromManifestCid()` 只对“链上最新备份”做 anchor 校验；历史快照恢复会显式报告跳过原因
4. **第三方载体秘密交付未纳入本轮：** 文档和代码本轮只保证自托管 owner/operator 路径闭环，不承诺社区/云载体可无缝拿到解密材料与 owner 心跳签名能力
5. **文件上传串行：** 大量文件场景下性能仍受限，未实现并发上传
6. **守护者重激活模式：** 链上 `_guardians` 数组使用重激活——重新添加已移除的守护者会重激活现有条目而非 push 新条目。数组大小上限 = 历史上曾添加过的不同地址总数
7. **哈希函数差异：** 备份 Merkle 树使用 SHA-256，节点核心 `ipfs-merkle.ts` 使用 Keccak-256，两者不可直接互验

---

## 文件清单

### 智能合约
- `contracts/contracts-src/governance/SoulRegistry.sol` — 主合约（约 915 行，含复活机制与 `getResurrectionReadiness`）
- `contracts/contracts-src/governance/CidRegistry.sol` — CID 注册表伴生合约（约 90 行）
- `contracts/deploy/deploy-soul-registry.ts` — 部署脚本（109 行）
- `contracts/test/SoulRegistry.test.cjs` — 测试套件（58 个测试）

### EIP-712 类型
- `node/src/crypto/soul-registry-types.ts` — TypeScript 签名类型定义（5 个类型）

### coc-backup 扩展
- `extensions/coc-backup/index.ts` — 插件入口（约 260 行）
- `extensions/coc-backup/openclaw.plugin.json` — 插件清单
- `extensions/coc-backup/package.json` — 依赖定义
- `extensions/coc-backup/tsconfig.json` — 扩展独立类型检查配置
- `extensions/coc-backup/test/` — vitest 单测与最小集成测试
- `extensions/coc-backup/src/types.ts` — 核心类型（约 240 行）
- `extensions/coc-backup/src/config-schema.ts` — 配置 Schema（25 行）
- `extensions/coc-backup/src/crypto.ts` — 加密模块（81 行）
- `extensions/coc-backup/src/ipfs-client.ts` — IPFS 客户端（116 行）
- `extensions/coc-backup/src/plugin-api.ts` — 本地插件 API 类型
- `extensions/coc-backup/src/utils.ts` — 公共工具函数
- `extensions/coc-backup/src/local-state.ts` — 本地状态与恢复包持久化
- `extensions/coc-backup/src/lifecycle.ts` — lifecycle/doctor/init 编排
- `extensions/coc-backup/src/soul-client.ts` — 合约客户端（约 430 行）
- `extensions/coc-backup/src/cli/commands.ts` — CLI 命令（约 565 行）
- `extensions/coc-backup/src/backup/anchor.ts` — 锚定逻辑（67 行）
- `extensions/coc-backup/src/backup/change-detector.ts` — 变更检测（130 行）
- `extensions/coc-backup/src/backup/manifest-builder.ts` — Manifest 构建（97 行）
- `extensions/coc-backup/src/backup/scheduler.ts` — 调度器（约 300 行）
- `extensions/coc-backup/src/backup/uploader.ts` — 上传器（73 行）
- `extensions/coc-backup/src/recovery/chain-resolver.ts` — 链解析（123 行）
- `extensions/coc-backup/src/recovery/downloader.ts` — 下载器（115 行）
- `extensions/coc-backup/src/recovery/integrity-checker.ts` — 完整性校验（86 行）
- `extensions/coc-backup/src/recovery/state-restorer.ts` — 恢复编排（约 182 行）
- `extensions/coc-backup/src/backup/binary-handler.ts` — 二进制数据库快照（约 170 行）
- `extensions/coc-backup/src/backup/context-snapshot.ts` — 会话上下文捕获（约 100 行）
- `extensions/coc-backup/src/recovery/cid-resolver.ts` — 三层 CID 解析器（约 180 行）
- `extensions/coc-backup/src/recovery/orchestrator.ts` — 自动恢复编排（约 130 行）
- `extensions/coc-backup/src/recovery/agent-restarter.ts` — Agent 重启通知（约 60 行）
- `extensions/coc-backup/src/carrier/protocol.ts` — 载体协议类型（约 60 行）
- `extensions/coc-backup/src/carrier/offline-monitor.ts` — 离线代理监控（约 120 行）
- `extensions/coc-backup/src/carrier/agent-spawner.ts` — Agent 进程启动器（约 110 行）
- `extensions/coc-backup/src/carrier/resurrection-flow.ts` — 复活状态机（约 170 行）
- `extensions/coc-backup/src/carrier/carrier-daemon.ts` — 载体守护进程（约 180 行）

**总计：** 当前仓库中，核心合约 + `coc-backup` 相关代码已超过 6,500 行；扩展侧已补充独立类型检查、vitest 测试入口、CID 注册表、二进制快照、上下文捕获与载体守护进程。
