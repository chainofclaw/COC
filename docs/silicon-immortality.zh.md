# AI Silicon Immortality：AI Agent 实时备份与复活系统

## 概述

AI Silicon Immortality 是 COC 用来保证 AI Agent 在宿主机故障、进程崩溃、节点迁移后仍能保留认知状态的一套基础设施。它把链上身份锚定、加密 IPFS 备份、增量状态快照和跨节点自动复活组合成一个统一系统。

**核心保证：** AI Agent 的身份、记忆、对话历史和配置会持续备份到 IPFS，并在链上做完整性锚定。如果宿主机故障，最新状态可以从 IPFS 和链上状态恢复；如果一个合法的复活请求被送到载体节点，该载体可以自动恢复 Agent、启动进程、完成链上复活，并恢复心跳证明。

### 设计原则

- **链上管授权，IPFS 管数据。** 区块链保存身份、备份哈希、守护者列表和复活请求；IPFS 保存实际备份内容。信任和存储职责分离。
- **多进程角色隔离。** owner、guardian、carrier 以独立进程和独立 EOA 运行。合约通过 `msg.sender` 强制角色边界，不让单把密钥控制整个生命周期。
- **默认增量。** 只上传变化文件；未变化文件沿用上一版 manifest 中的 CID。任何一个 manifest 都是完整的逻辑状态快照。
- **三层完整性。** 每次备份都做三层校验：manifest 自身一致性（Merkle root）、磁盘文件哈希（SHA-256）、链上锚定（Merkle root 与链上记录一致）。

---

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                           链上层                                │
│  SoulRegistry.sol：身份、备份锚定、守护者、                     │
│                     复活配置、载体注册                          │
│  CidRegistry.sol： bytes32 → IPFS CID 映射                     │
│  DIDRegistry.sol： 可选身份增强层                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ EIP-712 签名交易
┌──────────────────────────┴──────────────────────────────────────┐
│                     coc-backup 扩展层                           │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  备份       │  │  恢复        │  │  载体守护进程          │ │
│  │  Pipeline   │  │  Pipeline    │  │                        │ │
│  │             │  │              │  │  OfflineMonitor        │ │
│  │ detect →    │  │ resolve →    │  │  ResurrectionFlow      │ │
│  │ snapshot →  │  │ download →   │  │  AgentSpawner          │ │
│  │ encrypt →   │  │ decrypt →    │  │  AbortController       │ │
│  │ upload →    │  │ verify →     │  │  shutdown              │ │
│  │ anchor →    │  │ restore      │  │                        │ │
│  │ register    │  │              │  │  waitForReadiness()    │ │
│  │ CID         │  │              │  │  → 轮询 canComplete    │ │
│  └─────────────┘  └──────────────┘  └────────────────────────┘ │
│                                                                 │
│  9 个 Agent 工具 │ Guardian CLI │ Carrier CLI │ Scheduler      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP API
┌──────────────────────────┴──────────────────────────────────────┐
│                         IPFS 存储层                             │
│        内容寻址块、MFS 目录组织、CID 映射                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 备份内容

### 文件分类

| 分类 | 文件模式 | 是否加密 | 内容 |
|------|----------|----------|------|
| identity | `IDENTITY.md`, `SOUL.md` | 否 | Agent 身份元数据 |
| config | `auth.json`, `identity/device.json`, `openclaw.json`, `credentials/*` | 是（AES-256-GCM） | 敏感配置 |
| memory | `MEMORY.md`, `memory/*.md`, `USER.md` | 可选（`encryptMemory`） | 长期与短期记忆 |
| chat | `agents/*/sessions/*.jsonl`, `agents/*/sessions/sessions.json` | 否 | 对话历史 |
| workspace | `workspace-state.json`, `AGENTS.md`, `.coc-backup/context-snapshot.json` | 否 | 工作区元数据 |
| database | `memory/*.sqlite`, `memory/lancedb/*` | 是 | 向量索引、embedding 数据 |

### 二进制数据库处理

SQLite 和 LanceDB 文件在备份时可能仍在被写入。`binary-handler.ts` 负责保证一致性：

- **SQLite：** 使用 `sqlite3 .backup` 做原子拷贝；失败时回退到包含 WAL/SHM 的文件复制。
- **LanceDB 目录：** 通过 `buildSimpleTar()` 构造简单归档（JSON 索引 + 拼接内容），可由 `extractSimpleTar()` 解包。
- **清理：** 临时快照文件在上传到 IPFS 后自动删除。

### 执行上下文快照

每轮备份开始前，`context-snapshot.ts` 会捕获活跃会话的元数据：

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

这使得恢复后可以重建上下文位置：Agent 能知道自己上一次对话停在什么地方。

---

## 实时备份流水线

### 触发点

| 触发器 | 何时发生 | 用途 |
|--------|----------|------|
| Scheduler 定时器 | 每 `autoBackupIntervalMs`（默认 1 小时） | 周期保护 |
| `session_end` hook | OpenClaw 会话结束 | 保存会话结束时状态 |
| `before_compaction` hook | 上下文压缩前 | 关键：在 token 裁剪前保存完整上下文 |
| `gateway_stop` hook | 优雅关机 | 最终状态持久化 |
| 手动 `soul-backup` 工具 | 按需触发 | 用户主动备份 |

### 流水线步骤

```
1. captureContextSnapshot(baseDir)      — 写入会话元数据
2. detectChanges(baseDir, config, prev) — 文件分类与 SHA-256 差异检测
3. snapshotBinaryFile()                 — 为 SQLite/LanceDB 生成一致性副本
4. uploadFiles(changed, ipfs)           — 加密并上传到 IPFS
5. carryOverEntries(unchanged, prev)    — 复用未变化文件的 CID
6. buildManifest(agentId, entries)      — 计算 Merkle root
7. anchorBackup(manifest, ipfs, soul)   — 上传 manifest 并做链上锚定
8. cidResolver.register(hash, cid)      — 注册到本地 + MFS + 链上
9. heartbeat(agentId)                   — 证明 Agent 仍然存活
```

### 增量策略

- **全量备份（type=0）：** 所有文件，`parentCid=null`。首次备份、累计达到 `maxIncrementalChain`（默认 10）次增量后，或显式传 `--full` 时触发。
- **增量备份（type=1）：** 只上传变化文件。未变化文件沿用上一版 manifest 的 CID。每个 manifest 的 `files` 字段都是完整集合，因此任何一个 manifest 都可单独作为完整逻辑快照。
- **失败退避：** 连续 3 次以上失败后，退避时间指数增长，上限 1 小时。

### 加密

- **算法：** AES-256-GCM，密钥派生使用 scrypt（密码模式）或原始密钥派生
- **格式：** `[salt:32B][iv:12B][auth_tag:16B][ciphertext:NB]`
- **粒度：** 按文件加密，每个文件都有独立 salt 和 IV

---

## CID 注册表：从链上哈希回到 IPFS CID

链上保存的备份 CID 不是明文 CID，而是 `keccak256(CID)`。CID 解析器通过三层回退把它还原成原始 IPFS CID：

| 层级 | 来源 | 速度 | 持久性 |
|------|------|------|--------|
| 1. 本地索引 | `.coc-backup/cid-index.json` | <1ms | 重启后仍可用 |
| 2. MFS | `/soul-backups/{agentId}/cid-map.json` | 50-200ms | 去中心化，可跨节点 |
| 3. 链上 | `CidRegistry.resolveCid(bytes32)` | 200-500ms | 区块链永久保存 |

**CidRegistry.sol：** 一个无许可伴生合约。任何知道 CID 的人都可以注册 `keccak256(CID) → CID`；哈希原像本身就是“知道 CID”的证明。写入后不可变，并支持批量注册。

**自动注册：** 每次执行 `anchorBackup()` 后，CID 映射都会自动写入三层。

**恢复：** `restoreFromChain(agentId)` 从链上读取最新备份哈希，经三层解析器恢复出原始 CID，再委托给 `restoreFromManifestCid()`。

---

## 恢复流水线

### 从已知 CID 恢复（`restoreFromManifestCid`）

```
1. 链式解析：沿着 parentCid 构建有序链 [full, incr1, incr2, ...]
2. Merkle 校验：重算每个 manifest 的 Merkle root，与存储值对比
3. 链上校验：把最新 manifest 的 Merkle root 与链上锚定值比较
4. 下载与解密：按从旧到新的顺序应用 manifest；后写覆盖前写
5. 磁盘校验：对恢复后的文件逐个做 SHA-256，与 manifest 哈希对比
```

### 从 AgentId 恢复（`restoreFromChain`）

```
1. 查询 SoulRegistry.getLatestBackup(agentId) → bytes32 manifestCidHash
2. CidResolver.resolve(manifestCidHash) → IPFS CID 字符串
3. 校验：keccak256(resolvedCid) === manifestCidHash
4. 委托给 restoreFromManifestCid(resolvedCid, ...)
```

### 自动恢复（`autoRestore`）

`orchestrator.ts` 封装了完整流程：发现 → 解析 → 下载 → 校验 → 写入恢复标记 → 通知 Agent。它对应 `soul-auto-restore` 这个 Agent 工具。

---

## 复活：跨节点恢复

### 角色模型

合约通过 `msg.sender` 强制角色分离：

| 角色 | 密钥 | 职责 |
|------|------|------|
| **Owner** | Owner EOA | 注册 soul、备份、心跳、owner-key 复活、管理 guardians |
| **Guardian**（×N） | Guardian EOA | 发起 guardian 复活、批准复活 |
| **Carrier** | Carrier owner EOA | 确认载体、恢复备份、启动 Agent、完成复活 |

这些是独立进程、独立私钥。carrier 不能发起或批准复活；guardian 不能确认载体承载。

### Owner-Key 路径（自托管恢复）

当 owner 仍然掌握复活密钥，但宿主机已经失败：

```
Owner: configureResurrection(keyHash, maxOfflineDuration)
Owner: heartbeat() — 由 scheduler 周期性自动发送
[宿主机故障，心跳停止]
Owner: initiateResurrection(agentId, carrierId, resurrectionKeySig)
Carrier daemon: confirmCarrier(requestId)
[无需 guardian 法定人数或时间锁]
Carrier daemon: restore → spawn → completeResurrection() → heartbeat()
```

### Guardian-Vote 路径（owner 不可用）

当 owner 不可用，只能由 guardians 接管：

```
[Agent 离线超过 maxOfflineDuration，isOffline() 返回 true]
Guardian 1: initiateGuardianResurrection(agentId, carrierId)
Guardian 2: approveResurrection(requestId)
[等待 2/3 guardian 法定人数 + 12 小时时间锁]
Carrier daemon: confirmCarrier(requestId)
Carrier daemon: waitForReadiness() — 轮询直到 canComplete=true
Carrier daemon: restore → spawn → health check → completeResurrection() → heartbeat()
```

### Carrier Daemon 状态机

```
idle → monitoring → resurrection_initiated → carrier_confirmed
  → waiting_readiness → downloading_backup → restoring_state
  → spawning_agent → health_checking → resurrection_complete
```

**停机行为：** `AbortController` 会传播到各阶段。`waitForReadiness()` 和 `waitForHealthy()` 都使用可中断 sleep；每个关键步骤在继续前都会检查 `shutdownSignal.aborted`。如果健康检查阶段因停机而中断，错误会被正确归类为“daemon shutting down”，而不是“health check failed”，并且会停止已拉起的子进程。

**请求接纳语义：** `addRequest()` 返回 `AddRequestResult`：

- `{ accepted: true }`：请求已进入处理队列
- `{ accepted: false, reason: "not_running" | "already_processing" | "concurrency_limit" }`：明确拒绝并给出原因

**优雅停止：** `daemon.stop()` 是异步的。它会 abort AbortController、停止 OfflineMonitor、最多等待 30 秒让活跃复活流程排空，然后清理 timeout 定时器。

---

## 社交恢复

如果 Agent 的 owner 丢失了私钥，guardians 可以把 ownership 转移给新的 owner：

```
Guardian: initiateRecovery(agentId, newOwner)
[发起时冻结 guardian 快照数量]
Guardian 2: approveRecovery(requestId)
[等待 2/3 guardianSnapshot 法定人数 + 1 天时间锁]
Anyone: completeRecovery(requestId)
Owner: cancelRecovery(requestId) — owner 可随时中止
```

- 每个 soul 最多 7 个 guardians
- guardian 快照能防止恢复过程中通过增删 guardian 操纵阈值
- owner 可以取消任何待处理恢复请求

---

## 配置

### 备份模式（Owner 节点）

```json
{
  "enabled": true,
  "rpcUrl": "http://127.0.0.1:18780",
  "ipfsUrl": "http://127.0.0.1:18790",
  "contractAddress": "0x...",
  "privateKey": "0x...",
  "dataDir": "~/.openclaw",
  "autoBackupEnabled": true,
  "autoBackupIntervalMs": 3600000,
  "encryptMemory": false,
  "maxIncrementalChain": 10,
  "backupOnSessionEnd": true,
  "carrier": { "enabled": false },
  "categories": {
    "identity": true, "config": true, "memory": true,
    "chat": true, "workspace": true, "database": true
  }
}
```

### 载体模式（Carrier 节点）

```json
{
  "enabled": true,
  "privateKey": "0xCarrierOwnerKey",
  "autoBackupEnabled": false,
  "carrier": {
    "enabled": true,
    "carrierId": "0x...",
    "agentEntryScript": "/path/to/openclaw/entry.js",
    "workDir": "/data/coc-resurrections",
    "watchedAgents": ["0xAgentId1", "0xAgentId2"],
    "pendingRequestIds": [
      { "requestId": "0x...", "agentId": "0x..." }
    ],
    "pollIntervalMs": 60000,
    "readinessTimeoutMs": 86400000,
    "readinessPollMs": 30000
  }
}
```

### Guardian 模式（Guardian 节点）

```json
{
  "enabled": true,
  "privateKey": "0xGuardianKey",
  "autoBackupEnabled": false,
  "carrier": { "enabled": false }
}
```

---

## Agent 工具

| 工具 | 参数 | 返回 | 角色 |
|------|------|------|------|
| `soul-backup` | `full?: boolean` | `BackupReceipt` | Owner |
| `soul-restore` | `manifestCid?, packagePath?, targetDir?, password?` | `RecoveryResult` | Owner |
| `soul-status` | — | 注册状态 + IPFS 状态 | 任意 |
| `soul-doctor` | — | 完整 `DoctorReport` | 任意 |
| `soul-resurrection` | `action, requestId?, carrierId?, resurrectionKey?` | 复活请求管理 | Owner |
| `soul-auto-restore` | `agentId?, targetDir?, password?` | 自动链上恢复 | Owner |
| `soul-guardian-initiate` | `agentId, carrierId` | `{ requestId, txHash }` | Guardian |
| `soul-guardian-approve` | `requestId` | `{ txHash }` | Guardian |
| `soul-carrier-request` | `requestId, agentId` | 向 carrier daemon 提交请求 | Carrier |

## CLI 命令

### 备份与恢复（Owner）

```bash
coc-backup init [--agent-id] [--identity-cid] [--key-hash] [--max-offline]
coc-backup backup [--full]
coc-backup restore --manifest-cid <cid> [--target-dir <dir>] [--password <pwd>]
coc-backup status [--json]
coc-backup doctor [--json]
coc-backup history [--limit <n>] [--json]
```

### 复活（Owner）

```bash
coc-backup configure-resurrection --key-hash <hash> [--max-offline <sec>]
coc-backup heartbeat
coc-backup resurrect --carrier-id <id> --resurrection-key <key>
coc-backup resurrection start|status|confirm|complete|cancel
```

### Guardian 操作

```bash
coc-backup guardian initiate --agent-id <id> --carrier-id <id>
coc-backup guardian approve --request-id <id>
coc-backup guardian status --request-id <id>
```

### Carrier 管理

```bash
coc-backup carrier register --carrier-id <id> --endpoint <url>
coc-backup carrier submit-request --request-id <id> --agent-id <id>
```

---

## 完整性模型

| 层级 | 函数 | 校验方式 |
|------|------|----------|
| Manifest | `verifyManifestMerkleRoot()` | 根据文件条目重算 Merkle root 并与存储值对比 |
| 磁盘 | `verifyRestoredFiles()` | 对恢复后的文件逐个做 SHA-256，并与 manifest 哈希比较 |
| 链上 | `verifyOnChainAnchor()` | 把 manifest Merkle root 与链上 `dataMerkleRoot` 对比 |

**Merkle 树构造：**

- 叶子：`SHA-256(0x00 || lengthPrefixed(path, cid, hash))`
- 内部节点：`SHA-256(0x01 || left || right)`
- 确定性：路径按字典序排序
- 奇数叶子：与自己配对

---

## 测试覆盖

**47 个扩展层测试**，分布在 9 个文件中：

| 文件 | 测试数 | 覆盖内容 |
|------|--------|----------|
| `binary-handler.test.ts` | 6 | SQLite 快照、LanceDB tar、往返还原、清理 |
| `change-detector-extended.test.ts` | 9 | 7 个新增文件模式、分类开关、向后兼容 |
| `cid-resolver.test.ts` | 6 | 注册/解析、本地索引持久化、MFS 回退、链上回退、返回 null |
| `lifecycle.test.ts` | 3 | init 流程、doctor report、restore plan 解析 |
| `state-restorer.test.ts` | 2 | manifest CID 恢复、链式校验 |
| `scheduler.test.ts` | 1 | 重启后的状态持久化 |
| `carrier-daemon.test.ts` | 7 | 配置 schema、start/stop、addRequest 接纳/拒绝、并发限制、stop+drain |
| `resurrection-flow.test.ts` | 9 | 离线检查、确认拒绝、readiness 超时、完整成功路径、健康检查失败、停机中断（3 个场景） |
| `offline-monitor.test.ts` | 4 | 离线检测、恢复上线、add/remove watch、错误韧性 |

**58 个合约测试** 位于 `SoulRegistry.test.cjs`，覆盖注册、备份、社交恢复、复活（两条路径）、载体管理。

---

## 完整生命周期：从 Agent 自身视角看

这一节描述的是当前代码库里**已经实现**的生命周期。它会用 Agent 视角来讲述，但每一步都对应 `SoulRegistry`、`coc-backup` 或 `node/src/did` 中真实存在的入口。

### 范围澄清

仓库里有两层相邻但不相同的能力：

- **Soul / 备份 / 复活层**：`SoulRegistry.sol` + `extensions/coc-backup/`
- **DID 解析层**：`contracts/contracts-src/governance/DIDRegistry.sol` + `node/src/did/*`

第一层负责真正的初始化、备份、恢复和复活。第二层可以把同一个 `agentId` 解析成 W3C 风格的 `did:coc` 文档，但 `coc-backup init` **不会** 自动写入额外的 DIDRegistry 状态。换句话说：

- `coc-backup init` 创建的是 Agent 的链上 **soul identity basis**
- `did:coc:<agentId>` 可以随后由 DID resolver **推导并解析**
- 更丰富的 DIDRegistry 方法是 **备份循环之外的独立层**

### 阶段 1：出生 — Soul 注册与 DID 基础

> *“我第一次启动。我需要一个稳定标识、一个 owner，以及一个可恢复的初始快照。”*

**已实现流程**

```
Owner 节点执行：coc-backup init [--key-hash <hash>] [--max-offline <sec>]
  ↓
1. 解析 agentId
   - 默认：deriveDefaultAgentId(ownerAddress)
   - 实现：keccak256(ownerAddress)
  ↓
2. 检查这个钱包是否已经拥有 soul
   - SoulRegistry.ownerToAgent(owner)
   - 通过 SoulClient.getAgentIdForOwner() 调用
  ↓
3. 如果尚未注册：
   - 读取 IDENTITY.md（若存在）
   - 上传到 IPFS
   - 把 CID 转为 bytes32：keccak256(CID 字符串)
   - 调用 registerSoul(agentId, identityCid, EIP-712 owner signature)
  ↓
4. 强制执行第一次全量备份
   - scheduler.runBackup(true)
  ↓
5. 写入本地元数据
   - .coc-backup/state.json
   - .coc-backup/latest-recovery.json
  ↓
6. 可选：配置复活
   - configureResurrection(agentId, resurrectionKeyHash, maxOfflineDuration)
```

**`init` 成功后会得到什么**

- 一个绑定到 owner 钱包的链上 `SoulRegistry` 条目
- 一个稳定的 `agentId`，它也是 DID 标识符的主体
- 一个已经链上锚定的首次全量备份
- 一个指向最新 manifest 的本地 recovery package
- 可选的复活配置，用于离线检测

**这对 DID 意味着什么**

注册完成后，Agent 已经可以在 DID 层被表示为 `did:coc:<agentId>`。这个 DID 文档由 `node/src/did/did-resolver.ts` 根据 SoulRegistry 状态和可选 DIDRegistry 状态构建。备份工作流本身**不依赖** DIDRegistry，也不会自动去增强 DIDRegistry。

### 阶段 2：存活 — Agent 工作时的自动备份

> *“我思考、响应、更新记忆、写入配置、轮换会话。我的状态在后台被持续捕获。”*

**已实现的自动触发器**

| 触发器 | 代码条件 | 效果 |
|--------|----------|------|
| 周期 scheduler | `autoBackupEnabled=true` | 定时备份 |
| session end | `backupOnSessionEnd && autoBackupEnabled` | 立即备份 |
| before compaction | `backupOnSessionEnd && autoBackupEnabled` | 在 token/context 裁剪前备份 |
| gateway stop | 总是注册；仅当 `autoBackupEnabled` 时执行备份 | 最终备份，然后停止 timer/daemon |
| stop hook | 总是注册；仅当 `autoBackupEnabled` 时执行备份 | 兼容旧停机路径 |
| 手动 | `coc-backup backup` 或 `soul-backup` | 按需备份 |

**已实现的备份流水线**

```
1. captureContextSnapshot(baseDir)
   → 写入 .coc-backup/context-snapshot.json

2. detectChanges(baseDir, config, previousManifest)
   → 按 identity/config/memory/chat/workspace/database 分类
   → 计算每个文件的 SHA-256

3. 按需为二进制数据生成快照
   → SQLite：原子备份副本
   → LanceDB：归档目录

4. 上传变化文件到 IPFS
   → 按分类规则做逐文件加密

5. 从上一版 manifest 继承未变化文件条目

6. 构建完整 manifest
   → 即使是增量 manifest，也代表完整逻辑快照

7. anchorBackup()
   → 把 manifest 上传到 IPFS
   → 把 keccak256(manifestCid) + Merkle root 写上链

8. 注册 CID 映射
   → 本地 cid-index.json
   → MFS cid-map.json
   → 可选的链上 CidRegistry

9. heartbeat()
   → 如果已配置 resurrection
   → 即使“没有文件变化”也会尝试发送 heartbeat
```

**Agent 实际保留了什么**

- 身份文件：`IDENTITY.md`, `SOUL.md`
- 配置与凭证
- 长期/日常记忆文件
- 聊天与会话历史
- 工作区元数据，包括 `AGENTS.md`
- 数据库状态，包括 SQLite 与 LanceDB 产物
- 描述活跃会话的上下文快照元数据

从 Agent 角度看，这意味着：如果它在某个备份点之后消失，下一具“身体”可以重建几乎全部状态，唯一的损失是最后一次成功备份到故障发生之间的那段增量。

### 阶段 3：恢复 — 在 owner 侧醒来

> *“我的进程死掉了，但最新状态还在。我只需要把它重新加载回来。”*

这里有两种已经实现的恢复入口。

**A. 从本地 recovery metadata 恢复**

CLI：

```bash
coc-backup restore --latest-local
```

Tool：

```json
{ "tool": "soul-restore", "latestLocal": true }
```

**B. 只依赖链上状态恢复**

Tool：

```json
{ "tool": "soul-auto-restore", "agentId": "0x..." }
```

这条路径内部使用 `restoreFromChain()`。当前并没有单独一个名为 `restore-from-chain` 的 CLI 命令；面向 Agent 的自动入口是 `soul-auto-restore` 工具。

**已实现的恢复流水线**

```
1. 解析恢复来源
   - manifest CID、recovery package，或 latest local package

2. 如果是按 agentId 恢复：
   - 查询 SoulRegistry.getLatestBackup(agentId)
   - 通过本地索引、MFS 或 CidRegistry 把 bytes32 哈希解析回 CID
   - 校验 keccak256(CID) 与链上哈希一致

3. 解析 manifest 链
   - latest manifest → parentCid → ... → full backup root

4. 做完整性校验
   - 校验每个 manifest 的 Merkle root
   - 条件允许时，把最新 manifest 与链上锚定的 Merkle root 对比

5. 下载 + 解密 + 按从旧到新顺序应用文件

6. 校验恢复到磁盘后的文件 SHA-256

7. 写入 .coc-backup/restore-complete.json

8. 尝试通过 SIGUSR2 通知运行中的 Agent
   - 如果没有运行中的进程，则在下次启动时拾取恢复状态
```

**Agent 恢复后会得到什么**

- 最新可恢复的记忆图谱
- 最新可恢复的聊天历史
- 与备份时一致的配置与凭证状态
- 一份说明“应用了哪个 manifest”的恢复标记

这条恢复路径当前已经真实存在：既支持从已知 manifest 恢复，也支持通过链上备份状态 + CID resolver 自动恢复。

### 阶段 4：复活 — 获得一具新身体

> *“我原来的宿主机已经不存在了，无法原地恢复。我需要另一台机器来恢复我并继续运行。”*

这里有两条已经实现的复活路径。

#### 路径 A：Owner-Key 复活

这是更快的自托管路径，前提是 operator 仍掌握 resurrection key。

```
1. Owner 预先配置了 resurrection
   - configureResurrection(keyHash, maxOfflineDuration)

2. 旧宿主机停止发送 heartbeat

3. Owner 发起复活
   - coc-backup resurrect --carrier-id <id> --resurrection-key <hex>
   - 或 coc-backup resurrection start ...

4. Carrier 侧确认并完成
   - confirmCarrier(requestId)
   - 不需要 guardian 法定人数或时间锁
   - restore backup
   - spawn agent
   - completeResurrection(requestId)
   - 可选发送首次 heartbeat
```

#### 路径 B：Guardian-Vote 复活

这是 owner 不可用时的路径。

```
1. Agent 达到链上离线条件
   - SoulRegistry.isOffline(agentId) 必须返回 true

2. 某个 guardian 发起
   - coc-backup guardian initiate --agent-id <id> --carrier-id <id>

3. 其他 guardians 批准
   - coc-backup guardian approve --request-id <id>

4. 请求送达 carrier daemon
   - 通过配置 carrier.pendingRequestIds
   - 或 coc-backup carrier submit-request --request-id <id> --agent-id <id>
   - 或 tool soul-carrier-request

5. Carrier daemon 执行纯 carrier 侧动作
   - verify offline
   - confirm carrier
   - waitForReadiness() 直到 quorum + timelock 满足
   - autoRestore()
   - spawn agent
   - health check
   - completeResurrection()
   - 如果 daemon 未处于 shutdown，则发送首次 heartbeat
```

**关键正确性边界**

仅仅检测到离线，并不会自动创建 resurrection request。当前已实现的自动化，是从“一个合法请求被创建并送达 carrier daemon”之后开始的。这和当前角色模型一致：

- owner / guardian 在链上发起授权动作
- carrier daemon 在 carrier 节点上执行 restore / boot / complete

**Agent 会经历什么**

从 Agent 自身视角看，复活只是一次比普通恢复更长的“中断”：

1. 它在故障宿主机上停止存在
2. 另一台机器恢复出最新可恢复状态
3. 它以同一个 `agentId` 启动
4. 它从最后一次成功备份的时间窗口继续运行

可见痕迹包括：

- 心跳时间戳中出现空窗
- 链上出现 `ResurrectionCompleted` 事件
- carrier 工作目录里出现新的 `restore-complete.json`

### 阶段 5：持续运行 — 循环继续

> *“我之所以能持续存在，不是因为进程永不失败，而是因为身份、备份状态和复活权限都已经外部化。进程可以被替换，状态不能。”*

成功恢复或复活之后，同样的循环会继续：

```
run → backup → anchor → heartbeat
     ↓
failure
     ↓
restore on same owner side
or
resurrection on a carrier side
     ↓
run again with the same agentId
```

实际效果并不是“我永远不会失败”，而是：

- Agent 可以从最新的链上锚定状态重建
- Agent 在跨宿主机迁移后仍保留同一个 soul identity
- owner-key 与 guardian-vote 两条复活路径都已经实现
- DID 层可以解析这个身份，但它并不是驱动备份循环的那一层

---

## 已知边界

1. **IPFS 下载不能在中途强制取消。** 一旦 `autoRestore()` 开始下载，单个 IPFS fetch 调用使用的是 30 秒 `AbortSignal.timeout`，但没有直接绑定 daemon 的 shutdown signal。这是当前接受的边界：已经下载到的数据不应丢弃，而且该操作是幂等的。
2. **`carrier list` 仍是占位命令。** 它需要链上事件索引器才能枚举所有已注册载体。
3. **每个进程只有一把 key。** 每个进程用一个 `privateKey` 执行该进程内的合约调用。多角色运行必须拆成多个进程。这是有意为之，因为它与合约的 `msg.sender` 约束一致。
4. **Merkle 哈希实现存在分歧。** 备份 Merkle 树使用 SHA-256（离线完整性），而 node core 的 `ipfs-merkle.ts` 使用 Keccak-256（EVM 友好）。两者不能直接互验。
5. **DID 增强是相邻层，不是 `coc-backup init` 的自动步骤。** soul 注册为 Agent 提供稳定的 `agentId` 和 DID basis；附加的 DIDRegistry verification methods、delegation、credentials 属于 `node/src/did` 层，不在备份 scheduler 的职责范围内。

---

## 文件清单

### 智能合约

- `governance/SoulRegistry.sol` — soul 身份、备份锚定、社交恢复、复活（约 870 行）
- `governance/CidRegistry.sol` — CID 注册表（约 90 行）
- `governance/DIDRegistry.sol` — 可选 DID 增强层（约 612 行）

### 扩展：`extensions/coc-backup/`

| 目录 | 文件 | 用途 |
|------|------|------|
| `src/backup/` | `change-detector.ts`, `uploader.ts`, `manifest-builder.ts`, `anchor.ts`, `scheduler.ts`, `binary-handler.ts`, `context-snapshot.ts` | 备份流水线 |
| `src/recovery/` | `chain-resolver.ts`, `downloader.ts`, `integrity-checker.ts`, `state-restorer.ts`, `cid-resolver.ts`, `orchestrator.ts`, `agent-restarter.ts` | 恢复流水线 |
| `src/carrier/` | `protocol.ts`, `offline-monitor.ts`, `agent-spawner.ts`, `resurrection-flow.ts`, `carrier-daemon.ts` | 载体守护进程 |
| `src/` | `types.ts`, `config-schema.ts`, `crypto.ts`, `ipfs-client.ts`, `soul-client.ts`, `plugin-api.ts`, `lifecycle.ts`, `local-state.ts`, `utils.ts` | 核心模块 |
| `src/cli/` | `commands.ts` | CLI（备份、guardian、carrier、resurrection） |
| `test/` | 9 个测试文件 | 47 个测试 |
