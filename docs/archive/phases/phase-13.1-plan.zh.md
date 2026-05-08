# Phase 13.1: 持久化存储层

**版本**: 1.0
**日期**: 2026-02-15
**状态**: 进行中
**优先级**: CRITICAL

---

## 1. 概述

Phase 13.1 为 COC 区块链实现生产级持久化存储，用基于 LevelDB 的健壮存储系统取代当前的纯内存/快照方式。

### 1.1 目标

- **EVM 状态持久化**: 在 LevelDB 支持的 Merkle Patricia Trie 中存储账户状态、合约存储和代码
- **Nonce 注册表持久化**: 防止节点重启后的重放攻击
- **区块/交易索引**: 支持按哈希、编号和地址高效查询
- **快照优化**: 支持增量快照和更快的恢复

### 1.2 成功标准

- ✅ EVM 状态在节点重启后保留
- ✅ Nonce 注册表在重启后防止重放
- ✅ 区块/交易查询在 < 10ms 内完成
- ✅ 状态同步/快照时间减少 50%+
- ✅ 所有现有测试在持久化后端下通过
- ✅ 存储开销 < 内存占用的 2 倍

---

## 2. 架构设计

### 2.1 存储分层

```
┌─────────────────────────────────────────────┐
│         应用层 (EVM/RPC)                     │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│         存储抽象层                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │状态树    │  │区块索引  │  │Nonce存储 │  │
│  └─────┬────┘  └─────┬─────┘ └─────┬──────┘ │
└────────┼─────────────┼─────────────┼────────┘
         │             │             │
┌────────▼─────────────▼─────────────▼────────┐
│           LevelDB 键值存储                   │
│     (持久化, ACID, 快照支持)                 │
└──────────────────────────────────────────────┘
```

### 2.2 键值命名空间设计

| 前缀 | 用途 | 键格式 | 值格式 |
|------|------|--------|--------|
| `s:` | 状态树节点 | `s:<nodeHash>` | RLP 编码的树节点 |
| `a:` | 账户状态 | `a:<address>` | `{nonce, balance, storageRoot, codeHash}` |
| `c:` | 合约代码 | `c:<codeHash>` | 字节码 |
| `b:` | 按编号查询区块 | `b:<number>` | 区块 JSON |
| `h:` | 按哈希查询区块 | `h:<hash>` | 区块编号 |
| `t:` | 按哈希查询交易 | `t:<txHash>` | 交易 + 收据 |
| `n:` | Nonce 注册表 | `n:<nonce>` | 时间戳 |
| `m:` | 元数据 | `m:<key>` | 链元数据 |

### 2.3 组件设计

#### 2.3.1 存储抽象 (`node/src/storage/db.ts`)

```typescript
interface IDatabase {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  del(key: string): Promise<void>
  batch(ops: BatchOp[]): Promise<void>
  close(): Promise<void>
}

class LevelDatabase implements IDatabase {
  // LevelDB 包装器，带错误处理
}
```

#### 2.3.2 状态树 (`node/src/storage/state-trie.ts`)

```typescript
interface IStateTrie {
  get(address: string): Promise<AccountState | null>
  put(address: string, state: AccountState): Promise<void>
  getStorageAt(address: string, slot: string): Promise<string>
  putStorageAt(address: string, slot: string, value: string): Promise<void>
  commit(): Promise<string> // 返回状态根
  checkpoint(): Promise<void>
  revert(): Promise<void>
}

class MerklePatriciaTrie implements IStateTrie {
  // @ethereumjs/trie 集成 LevelDB 后端
}
```

#### 2.3.3 区块索引 (`node/src/storage/block-index.ts`)

```typescript
interface IBlockIndex {
  putBlock(block: Block): Promise<void>
  getBlockByNumber(num: number): Promise<Block | null>
  getBlockByHash(hash: string): Promise<Block | null>
  getLatestBlock(): Promise<Block | null>
  getTransactionByHash(hash: string): Promise<TxWithReceipt | null>
}
```

#### 2.3.4 Nonce 存储 (`node/src/storage/nonce-store.ts`)

```typescript
interface INonceStore {
  markUsed(nonce: string): Promise<void>
  isUsed(nonce: string): Promise<boolean>
  cleanup(olderThan: number): Promise<void> // 清理旧 nonce
}
```

---

## 3. 实施计划

### 3.1 任务分解

| 任务 | 文件 | 预估时间 | 优先级 |
|------|------|----------|--------|
| LevelDB 抽象 | `storage/db.ts` | 2h | P0 |
| 状态树集成 | `storage/state-trie.ts` | 4h | P0 |
| 区块索引 | `storage/block-index.ts` | 3h | P0 |
| Nonce 持久化 | `storage/nonce-store.ts` | 2h | P0 |
| EVM 集成 | `evm.ts`, `chain-engine.ts` | 4h | P0 |
| 迁移脚本 | `scripts/migrate-storage.ts` | 2h | P1 |
| 测试 | `storage/*.test.ts` | 6h | P0 |
| 文档 | `docs/*` | 2h | P1 |

**总预估**: 25 小时（约 3 天）

### 3.2 依赖项

```bash
npm install --save level @ethereumjs/trie @ethereumjs/util
```

- **level**: Node.js 的 LevelDB 绑定
- **@ethereumjs/trie**: Merkle Patricia Trie 实现
- **@ethereumjs/util**: RLP 编码工具函数

---

## 4. 测试策略

### 4.1 单元测试

- ✅ 数据库 CRUD 操作
- ✅ 批量操作和原子性
- ✅ 状态树 get/put/commit
- ✅ 区块索引查询（按编号、按哈希）
- ✅ Nonce 存储 mark/check 操作

### 4.2 集成测试

- ✅ EVM 状态跨重启持久化
- ✅ 带持久化存储的区块生产
- ✅ 重启后的 nonce 重放防护
- ✅ 状态同步和恢复

### 4.3 性能基准测试

- ✅ 状态读/写吞吐量（目标: 10k ops/sec）
- ✅ 区块查询延迟（目标: < 10ms）
- ✅ 快照创建时间（目标: 10 万账户 < 5 秒）
- ✅ 磁盘使用效率（目标: < 内存的 2 倍）

### 4.4 崩溃恢复测试

- ✅ 区块中途杀死节点并验证恢复
- ✅ 损坏数据库检测和修复
- ✅ Checkpoint/revert 正确性

---

## 5. 迁移策略

### 5.1 向后兼容性

- 现有 JSON 快照仍支持迁移
- 迁移脚本: `scripts/migrate-storage.ts`
- 首次运行时使用 `--migrate` 标志自动检测和迁移

### 5.2 迁移步骤

```bash
# 备份现有数据
cp -r data/ data.backup/

# 运行迁移
node --experimental-strip-types scripts/migrate-storage.ts \
  --from data/chain-snapshot.json \
  --to data/leveldb

# 使用新存储启动节点
cd node
npm start
```

---

## 6. 性能优化

### 6.1 缓存策略

- 热状态的内存 LRU 缓存（大小: 1000 账户）
- 最近区块的区块头缓存（大小: 100）
- 频繁调用合约的代码缓存

### 6.2 批量操作

- 将区块内的状态更新分组到单个 LevelDB 批次
- 非关键索引的异步写后

### 6.3 修剪

- 自动清理 nonce（7 天前）
- 归档节点 vs 全节点模式的可选状态修剪

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 数据损坏 | 高 | LevelDB ACID 保证、校验和、定期备份 |
| 性能回退 | 中 | 基准测试、缓存、批量写入 |
| 迁移失败 | 中 | 全面迁移测试、回滚计划 |
| 磁盘空间耗尽 | 低 | 修剪、监控、告警 |

---

## 8. 验收标准

- [ ] 现有 127 个测试在持久化存储下全部通过
- [ ] 状态在节点重启后保留（集成测试验证）
- [ ] Nonce 注册表在重启后防止重放
- [ ] 区块/交易查询 < 10ms（p95）
- [ ] 快照时间减少 50%+
- [ ] 存储开销 < 内存的 2 倍
- [ ] 文档更新（implementation-status.md、架构文档）
- [ ] 迁移脚本使用示例数据测试

---

## 9. 上线计划

### 阶段 A: 开发（第 1-2 天）
- 实现存储组件
- 编写单元测试
- 本地集成测试

### 阶段 B: 测试（第 3 天）
- 运行完整测试套件
- 性能基准测试
- 崩溃恢复测试

### 阶段 C: 文档（第 3 天）
- 更新技术文档
- 编写迁移指南
- 代码审查

### 阶段 D: 部署（第 4 天）
- 合并到主分支
- 更新 devnet 脚本
- 监控指标

---

## 10. 参考资料

- [LevelDB 文档](https://github.com/Level/level)
- [EthereumJS Trie](https://github.com/ethereumjs/ethereumjs-monorepo/tree/master/packages/trie)
- [Merkle Patricia Trie 规范](https://ethereum.org/en/developers/docs/data-structures-and-encoding/patricia-merkle-trie/)
- [COC 架构文档](./architecture-zh.md)

---

**文档负责人**: COC 核心团队
**最后更新**: 2026-02-15
