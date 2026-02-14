# Phase 13.2：节点集成与事件索引

## 概述

Phase 13.2 将 Phase 13.1 的持久化存储层集成到运行节点中，使 LevelDB 成为默认的生产后端。同时添加持久化事件/日志索引，支持高效的 `eth_getLogs` 查询。

## 目标

1. 通过 `IChainEngine` 接口抽象链引擎
2. 将 `PersistentChainEngine` 集成到节点启动流程
3. 为 `BlockIndex` 添加持久化事件/日志索引
4. 启动时自动迁移旧版 `chain.json`
5. 更新 RPC 服务器以利用持久化存储

## 架构

```
                ┌──────────────┐
                │  IChainEngine │  (接口)
                └──────┬───────┘
           ┌───────────┴───────────┐
           │                       │
    ┌──────▼──────┐    ┌──────────▼──────────┐
    │ ChainEngine │    │ PersistentChainEngine │
    │   (内存)     │    │   (LevelDB)           │
    └─────────────┘    └────────┬──────────────┘
                                │
                    ┌───────────┼──────────┐
                    │           │          │
              ┌─────▼─┐  ┌─────▼────┐ ┌──▼────────┐
              │ 区块   │  │  Nonce   │ │  日志     │
              │ 索引   │  │   存储   │ │  索引     │
              └────────┘  └──────────┘ └───────────┘
```

## 组件

### IChainEngine 接口 (`chain-engine-types.ts`)
- 两种引擎后端的通用接口
- `ISnapshotSyncEngine` 支持旧版快照同步
- `IBlockSyncEngine` 支持基于区块的同步
- 可选的 `getLogs()` 和 `getTransactionByHash()` 方法

### 事件/日志索引 (`block-index.ts`)
- `IndexedLog` 类型包含完整事件元数据
- `LogFilter` 支持按地址/主题过滤
- `putLogs()` 按区块号存储日志
- `getLogs()` 跨区块范围查询并过滤

### 节点入口 (`index.ts`)
- 通过 `storage.backend` 配置驱动后端选择
- 启动时自动迁移旧版 `chain.json`
- 优雅关闭，清理 LevelDB 资源

### RPC 服务器 (`rpc.ts`)
- 所有方法现在使用 `IChainEngine` 接口
- `eth_getLogs` 优先使用持久化索引
- `eth_getTransactionByHash` 从持久化存储回退到 EVM 内存
- 正确处理异步/同步返回值

## 配置

```json
{
  "storage": {
    "backend": "leveldb",
    "leveldbDir": "~/.clawdbot/coc/leveldb",
    "cacheSize": 1000,
    "enablePruning": false,
    "nonceRetentionDays": 7
  }
}
```

设置 `"backend": "memory"` 使用旧版内存存储。

## 测试覆盖

- `rpc-persistent.test.ts`：5 个测试（区块查询、交易收据、日志索引、重启持久化）
- `block-index.test.ts`：9 个测试（+2 个新日志索引测试）
- 所有现有测试通过（25 核心 + 5 持久化引擎 + 7 集成）

## 迁移路径

1. 使用 `chain.json` 的现有节点 → 首次启动时自动迁移到 LevelDB
2. 成功迁移后 `chain.json` 重命名为 `chain.json.bak`
3. 无数据丢失；迁移具有幂等性

## 状态：已完成
