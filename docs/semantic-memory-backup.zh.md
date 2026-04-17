# 语义记忆备份与恢复

## 概述

coc-backup 扩展的文件级备份保证了 Agent 的所有数据文件可以在宿主机故障后恢复。但 AI Agent 不仅仅是文件——它有正在做的事、积累的决策经验和对项目的语义理解。传统文件恢复后，Agent 只能看到原始文件，却不知道：

- 上次在做什么，做到哪里了
- 做过哪些关键决策，以及为什么
- 从过去的工作中学到了什么

**语义记忆层**通过与 [claude-mem](https://github.com/thedotmack/claude-mem) 的 SQLite 数据库桥接，在备份前提取结构化的 observations（观察）和 session summaries（会话摘要），在恢复后将其格式化注入 Agent 的启动上下文。这使得复活后的 Agent 不只是"拿回文件"，而是"记住自己是谁、在做什么"。

### 与现有备份的关系

| 层级 | 负责模块 | 备份内容 | 恢复后效果 |
|------|----------|----------|-----------|
| 文件级 | change-detector + uploader | 原始文件 (MEMORY.md, sessions/*.jsonl, *.sqlite) | Agent 拿回所有文件 |
| 元数据级 | context-snapshot.ts | 会话数量、token 估算、最后消息时间 | Agent 知道上次对话停在哪 |
| **语义级** | **semantic-snapshot.ts + context-injector.ts** | **结构化决策、学习、发现、项目上下文** | **Agent 理解自己之前在做什么、学到了什么** |

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    claude-mem 插件 (独立运行)                │
│                                                             │
│  SessionStart → PostToolUse → Stop hooks                   │
│       ↓              ↓            ↓                         │
│  SDK Agent 提取结构化 observations + summaries              │
│       ↓                                                     │
│  ~/.claude-mem/claude-mem.db (SQLite)                       │
│  ┌──────────────────────────────────────────┐              │
│  │ observations: type, title, facts,        │              │
│  │               narrative, concepts        │              │
│  │ session_summaries: request, learned,     │              │
│  │                    completed, next_steps │              │
│  │ observations_fts: FTS5 全文搜索索引      │              │
│  └──────────────────────────────────────────┘              │
└────────────────────────┬────────────────────────────────────┘
                         │ 只读 (node:sqlite)
┌────────────────────────┴────────────────────────────────────┐
│                    coc-backup 语义记忆层                     │
│                                                             │
│  备份前:                                                    │
│  ┌─────────────────────┐    ┌──────────────────────┐       │
│  │ semantic-snapshot.ts │───→│ .coc-backup/          │      │
│  │ 读取 claude-mem DB   │    │ semantic-snapshot.json│      │
│  │ token 预算化打包     │    └──────────┬───────────┘       │
│  └─────────────────────┘               │                    │
│                                        ↓                    │
│  ┌─────────────────────┐    ┌──────────────────────┐       │
│  │ scheduler.ts        │───→│ manifest.json         │      │
│  │ _buildSemanticDigest│    │ + semanticDigest      │      │
│  └─────────────────────┘    └──────────────────────┘       │
│                                                             │
│  恢复后:                                                    │
│  ┌─────────────────────┐    ┌──────────────────────┐       │
│  │ context-injector.ts │───→│ RECOVERY_CONTEXT.md   │      │
│  │ 读取 snapshot JSON  │    │ (Markdown 格式)       │      │
│  │ 格式化恢复上下文    │    └──────────────────────┘       │
│  └─────────────────────┘                                    │
│                                                             │
│  搜索:                                                      │
│  ┌─────────────────────┐                                    │
│  │ memory-search.ts    │ ← soul-memory-search tool         │
│  │ Worker 代理 / FTS5  │                                   │
│  └─────────────────────┘                                    │
└─────────────────────────────────────────────────────────────┘
```

### 关键设计决策

1. **桥接而非嵌入**：coc-backup 只读取 claude-mem 的 SQLite 数据库，不嵌入其 SDK agent 管道。活跃的 observation 捕获仍是 claude-mem 的职责。
2. **自包含恢复上下文**：`RECOVERY_CONTEXT.md` 和 `semantic-snapshot.json` 无需 claude-mem worker 即可读取，确保在 carrier 节点上也能完成复活。
3. **备份时预算化**：token 预算在备份时计算（而非恢复时），恢复只做格式化。
4. **向后兼容**：`semanticDigest` 为 optional 字段，旧 manifest 不受影响。

---

## 语义快照

### 数据来源

`semantic-snapshot.ts` 从 claude-mem 的 SQLite 数据库读取两张核心表：

**observations 表**（每次工具使用后由 claude-mem SDK agent 生成）：

| 字段 | 用途 |
|------|------|
| `type` | 观察类型：decision / discovery / pattern / learning / issue / explanation |
| `title` | 一行标题摘要 |
| `facts` | 结构化事实数组 (JSON) |
| `narrative` | 完整叙事描述 |
| `concepts` | 关联概念标签 (JSON) |
| `created_at` | 创建时间 |

**session_summaries 表**（每次会话结束时由 claude-mem 生成）：

| 字段 | 用途 |
|------|------|
| `request` | 用户请求了什么 |
| `learned` | 学到了什么关键信息 |
| `completed` | 完成了什么工作 |
| `next_steps` | 下一步建议 |
| `created_at` | 创建时间 |

### Token 预算化打包

语义快照使用贪心算法在 token 预算内打包数据。token 估算公式：`tokens = ceil(chars / 4)`。

打包顺序：
1. **Summaries 优先**（信息密度更高）——每条摘要用约 50-200 tokens 概括整个会话
2. **Observations 其次**——每条观察约 20-100 tokens，提供细粒度的决策和发现记录

```
Budget: 8000 tokens (default)

Pack summaries:  [S1: 120t] [S2: 95t] [S3: 180t] ... → 累计: 1200t
Pack observations: [O1: 80t] [O2: 45t] [O3: 60t] ... → 累计: 6800t
                                                         停止 (剩余 < 下一条)
```

### 输出格式

```json
{
  "version": 1,
  "capturedAt": "2026-04-17T10:00:00.000Z",
  "tokenBudget": 8000,
  "tokensUsed": 6800,
  "observations": [
    {
      "id": 42,
      "type": "decision",
      "title": "Implemented Redis caching layer",
      "facts": ["Reduced DB queries by 60%", "Added 2GB memory usage"],
      "narrative": "Added Redis to reduce database load during peak hours...",
      "concepts": ["redis", "performance", "caching"],
      "createdAt": "2026-04-17T09:30:00.000Z"
    }
  ],
  "summaries": [
    {
      "request": "Optimize database performance",
      "learned": "Redis + connection pool reduced latency 40%",
      "completed": "Implemented caching in production",
      "next_steps": "Monitor metrics, consider distributed caching",
      "createdAt": "2026-04-17T09:45:00.000Z"
    }
  ],
  "activeProjects": ["api-server", "dashboard"]
}
```

### 数据库定位策略

语义快照按以下顺序查找 claude-mem 数据库：

1. 配置中显式指定的路径 (`semanticSnapshot.claudeMemDbPath`)
2. 默认位置 `~/.claude-mem/claude-mem.db`

数据库以只读模式打开，不写入任何数据。如果数据库不存在或 schema 不匹配，生成空快照（优雅降级）。

---

## 恢复上下文注入

### 触发时机

在 `orchestrator.ts` 的恢复流程中，文件恢复完成后、写入 restore marker 前：

```
autoRestore / restoreFromCid
  ├── 1. 链上查找 → CID 解析
  ├── 2. 下载文件 → 解密 → 写入磁盘
  ├── 3. Merkle 验证 + 链上锚定验证
  ├── 4. ★ injectRecoveryContext()  ← 语义上下文注入
  ├── 5. 写入 restore-complete.json marker
  └── 6. 通知 Agent 进程重启
```

### RECOVERY_CONTEXT.md 格式

```markdown
# Recovery Context

> Restored from backup at 2026-04-17T14:00:00Z. Agent `0xabcdef...` resurrected.

## Last Session Summaries

### Apr 17, 2026
- **Working on**: Optimize database performance
- **Learned**: Redis + connection pool reduced latency 40%
- **Completed**: Implemented caching in production
- **Next Steps**: Monitor metrics, consider distributed caching

## Recent Observations

| Time  | Type      | Title                           | Key Facts                        |
|-------|-----------|---------------------------------|----------------------------------|
| 09:30 | decision  | Implemented Redis caching layer | Reduced queries by 60%           |
| 08:00 | discovery | Found N+1 query in dashboard    | Dashboard fires 200 queries/page |

## Active Projects
- api-server
- dashboard

## Snapshot Metadata
- Captured at: 2026-04-17T10:00:00Z
- Observations: 42
- Summaries: 5
- Tokens used: 6800 / 8000

## Recovery Integrity
- Files restored: 156
- Total bytes: 12,580,000
- Backups applied: 3 manifests
- Merkle verified: yes
- On-chain anchor: verified
- Agent ID: 0xabcdef1234567890
```

### 无语义快照时的降级

如果 `.coc-backup/semantic-snapshot.json` 不存在（旧备份或 claude-mem 未运行时的备份），仍会生成最小的 `RECOVERY_CONTEXT.md`，仅包含 Recovery Integrity 部分。

---

## 链上语义摘要锚定

### SemanticDigest

备份 manifest 中的可选 `semanticDigest` 字段：

```json
{
  "version": 1,
  "agentId": "0x...",
  "timestamp": "2026-04-17T10:05:00Z",
  "files": { "...": "..." },
  "merkleRoot": "0x...",
  "semanticDigest": {
    "observationCount": 42,
    "summaryCount": 5,
    "contentHash": "a1b2c3d4e5f6...",
    "snapshotTokens": 6800
  }
}
```

| 字段 | 说明 |
|------|------|
| `observationCount` | 快照中包含的 observation 数量 |
| `summaryCount` | 快照中包含的 summary 数量 |
| `contentHash` | 语义内容的 SHA-256 哈希 |
| `snapshotTokens` | 实际使用的 token 数 |

### 验证路径

语义摘要不需要修改链上合约。验证通过现有 Merkle 锚定机制传递：

```
semantic-snapshot.json → SHA-256 → contentHash
                                        ↓
semantic-snapshot.json → IPFS CID → manifest.files[path].hash
                                        ↓
manifest.files → Merkle tree → merkleRoot
                                        ↓
merkleRoot → SoulRegistry.anchorBackup() → 链上存储
```

只要 manifest 的 Merkle root 与链上记录一致，语义数据的完整性就得到保证。

---

## 语义记忆搜索

### soul-memory-search 工具

恢复后的 Agent 可以使用 `soul-memory-search` 工具搜索过往记忆：

```
Tool: soul-memory-search
Parameters:
  query: "Redis caching"     (required) 搜索文本
  limit: 10                  (optional) 最大结果数
  type: "decision"           (optional) 按类型过滤
```

### 搜索策略（两层降级）

| 优先级 | 策略 | 条件 | 速度 | 质量 |
|--------|------|------|------|------|
| 1 | claude-mem worker 代理 | Worker 在 `127.0.0.1:37777` 可达 | ~100ms | 高（支持向量语义搜索） |
| 2 | SQLite FTS5 | 恢复的 SQLite 有 FTS5 索引 | ~10ms | 中（全文匹配） |
| 3 | SQLite LIKE | FTS 不可用时 | ~50ms | 低（关键词匹配） |

### 数据库查找顺序

搜索按以下顺序定位数据库：

1. `{dataDir}/memory/` 下的 `.sqlite` 或 `.db` 文件（恢复的数据库优先）
2. `~/.claude-mem/claude-mem.db`（全局 claude-mem 数据库）

优先使用恢复的数据库确保搜索的是 Agent 自己的记忆，而非宿主机的记忆。

---

## 配置

在 `coc-backup` 扩展配置中添加 `semanticSnapshot` 节：

```json
{
  "enabled": true,
  "rpcUrl": "http://127.0.0.1:18780",
  "ipfsUrl": "http://127.0.0.1:18790",
  "contractAddress": "0x...",
  "privateKey": "0x...",
  "semanticSnapshot": {
    "enabled": true,
    "tokenBudget": 8000,
    "maxObservations": 50,
    "maxSummaries": 10,
    "claudeMemDbPath": ""
  }
}
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否启用语义快照 |
| `tokenBudget` | `8000` | 语义快照的最大 token 预算 |
| `maxObservations` | `50` | 从数据库读取的最大 observation 数 |
| `maxSummaries` | `10` | 从数据库读取的最大 summary 数 |
| `claudeMemDbPath` | `""` | 显式指定 claude-mem 数据库路径（空 = 自动检测） |

### 文件分类规则

语义记忆相关的文件在备份中的分类：

| 文件路径 | 分类 | 加密 |
|----------|------|------|
| `.coc-backup/semantic-snapshot.json` | memory | 否 |
| `RECOVERY_CONTEXT.md` | memory | 否 |
| `.coc-backup/context-snapshot.json` | workspace | 否 |

---

## 完整备份-恢复数据流

### 备份路径（扩展后）

```
1. scheduler.runBackup()
2. captureContextSnapshot(baseDir)         ← 会话元数据
3. captureSemanticSnapshot(baseDir, config) ← ★ 语义快照
4. detectChanges(baseDir, config, prev)     ← 文件变更检测
   └── semantic-snapshot.json 作为 "memory" 类文件被包含
5. uploadFiles(changedFiles, ipfs, key)     ← IPFS 上传
6. _buildSemanticDigest(baseDir)            ← ★ 计算 SHA-256 digest
7. buildManifest(agentId, entries, parent, digest) ← 构建 manifest
   └── manifest.semanticDigest 被设置
8. anchorBackup(manifest, ipfs, soul)       ← 链上锚定
```

### 恢复路径（扩展后）

```
1. autoRestore() / restoreFromCid()
2. restoreFromChain(agentId, ...)
   ├── getSoul() → 验证活跃 + 有备份
   ├── getLatestBackup() → 获取 CID hash
   ├── cidResolver.resolve() → 反向映射 CID
   └── restoreFromManifestCid(cid, ...)
       ├── resolveChainFromCid() → 递归下载 manifest 链
       ├── verifyManifestMerkleRoot() → Merkle 自洽验证
       ├── verifyOnChainAnchor() → 链上锚定验证
       ├── applyManifestChain() → 下载解密写入文件
       └── verifyRestoredFiles() → 磁盘完整性验证
3. ★ injectRecoveryContext(targetDir, recovery, agentId)
   ├── 读取 .coc-backup/semantic-snapshot.json
   ├── 格式化为 Markdown
   └── 写入 RECOVERY_CONTEXT.md
4. writeRestoreMarker()
5. notifyAgentRestart()
```

---

## 前置依赖

| 依赖 | 版本 | 用途 | 必需？ |
|------|------|------|--------|
| Node.js | 22+ | `node:sqlite` 内置 SQLite 模块 | 是 |
| claude-mem | 任意 | 提供 observation/summary 数据源 | 否（无则生成空快照） |
| claude-mem worker | 任意 | 语义搜索代理（port 37777） | 否（无则降级到 SQLite FTS） |

---

## Agent 工具列表

coc-backup 扩展现在注册 **13 个** Agent 工具：

| 工具 | 分类 | 说明 |
|------|------|------|
| `soul-backup` | 备份 | 执行一次备份周期 |
| `soul-restore` | 恢复 | 从 manifest CID 恢复 |
| `soul-auto-restore` | 恢复 | 自动从链上查找并恢复 |
| `soul-status` | 状态 | 查看注册和备份状态 |
| `soul-doctor` | 诊断 | 运行完整健康检查 |
| `soul-resurrection` | 复活 | 管理 owner-key 复活请求 |
| `soul-guardian-initiate` | 守护者 | 发起 guardian 复活 |
| `soul-guardian-approve` | 守护者 | 批准复活请求 |
| `soul-guardian-manage` | 守护者 | 管理守护者列表 |
| `soul-recovery-initiate` | 社交恢复 | 发起所有权转移 |
| `soul-recovery-approve` | 社交恢复 | 批准所有权转移 |
| `soul-carrier-request` | 载体 | 提交复活请求到 carrier daemon |
| **`soul-memory-search`** | **语义记忆** | **搜索过往 observations 和 summaries** |

---

## 测试

语义记忆层新增 16 个测试（全部通过）：

| 测试文件 | 测试数 | 覆盖内容 |
|----------|--------|----------|
| `test/semantic-snapshot.test.ts` | 6 | 快照捕获、token 预算、读写、优雅降级、禁用状态 |
| `test/context-injector.test.ts` | 5 | 完整上下文生成、空快照降级、锚定状态格式化、管道字符转义 |
| `test/memory-search.test.ts` | 5 | FTS5 搜索、类型过滤、limit、空数据库、LIKE 降级 |

coc-backup 扩展总测试：**63 个**（原 47 + 新 16），零回归。
