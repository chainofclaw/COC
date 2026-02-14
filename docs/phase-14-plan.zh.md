# Phase 14：WebSocket 订阅与实时事件

## 概述

Phase 14 添加 WebSocket JSON-RPC 支持，实现 `eth_subscribe` 和 `eth_unsubscribe` 方法，使客户端能够实时接收新区块、待处理交易和日志事件的推送通知。

## 目标

1. 创建类型化的链事件发射器，支持区块、交易和日志事件
2. 实现 WebSocket JSON-RPC 服务器与订阅管理
3. 支持 `newHeads`、`newPendingTransactions` 和 `logs` 订阅类型
4. 将 WebSocket 服务器集成到节点入口
5. 保持与现有 HTTP RPC 的向后兼容性

## 架构

```
                ┌──────────────────┐
                │   IChainEngine   │
                │  (events 字段)   │
                └────────┬─────────┘
                         │
              ┌──────────▼──────────┐
              │  ChainEventEmitter  │
              │  (newBlock/pendingTx│
              │   /log 事件发射)    │
              └──────────┬──────────┘
                         │
           ┌─────────────┼─────────────┐
           │             │             │
    ┌──────▼──────┐ ┌────▼─────┐ ┌────▼─────┐
    │  newHeads   │ │ pending  │ │   logs   │
    │   订阅者    │ │ tx 订阅  │ │   订阅   │
    └─────────────┘ └──────────┘ └──────────┘
           │             │             │
    ┌──────▼─────────────▼─────────────▼──────┐
    │          WebSocket RPC 服务器             │
    │  (ws://host:port, eth_subscribe/unsub)   │
    └──────────────────────────────────────────┘
```

## 组件

### ChainEventEmitter (`chain-events.ts`)
- 包装 Node.js `EventEmitter`，提供类型化事件方法
- 事件类型：`BlockEvent`、`PendingTxEvent`、`LogEvent`
- 辅助格式化器：`formatNewHeadsNotification()`、`formatLogNotification()`
- 最大监听器数设为 1000，支持高并发场景

### WebSocket RPC 服务器 (`websocket-rpc.ts`)
- 基于 `ws` 包构建，提供生产级 WebSocket 支持
- 处理 `eth_subscribe` 和 `eth_unsubscribe` 方法
- 标准 RPC 方法委托给共享的 `handleRpcMethod()` 处理器
- 每客户端订阅跟踪，断开连接时自动清理
- `logs` 类型的订阅过滤器匹配（地址 + 主题）

### 引擎集成
- `ChainEngine`（内存）和 `PersistentChainEngine`（LevelDB）均发射事件
- `IChainEngine` 接口包含 `events: ChainEventEmitter` 字段
- 事件在 `addRawTx()`（待处理交易）和 `applyBlock()`（区块 + 日志）中发射

### 节点入口 (`index.ts`)
- WebSocket 服务器与 HTTP RPC 服务器并行启动
- 通过 `wsPort` 和 `wsBind` 配置
- 优雅关闭时停止 WebSocket 服务器并清理订阅

## 配置

```json
{
  "wsBind": "127.0.0.1",
  "wsPort": 18781
}
```

默认 WebSocket 端口为 `18781`（HTTP RPC 端口 + 1）。

## 订阅类型

### newHeads
以 Ethereum 兼容格式接收区块头通知。

### newPendingTransactions
在交易进入内存池时接收交易哈希。

### logs
接收过滤后的日志事件，支持可选的地址和主题过滤。

## 测试覆盖

- `websocket-rpc.test.ts`：5 个测试
  - 标准 RPC 方法通过 WebSocket 转发
  - newHeads 订阅接收区块通知
  - newPendingTransactions 订阅
  - 取消订阅停止通知
  - 客户端断开连接清理
- 所有现有测试通过（共 54 个）

## 状态：已完成
