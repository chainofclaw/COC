# Phase 18：Explorer WebSocket 集成

## 概述

Phase 18 为区块浏览器添加实时 WebSocket 订阅功能，无需刷新页面即可获取新区块和待处理交易的实时更新。

## 组件

### WebSocket Hook (`use-websocket.ts`)
- 管理 WebSocket 连接生命周期，支持自动重连
- 通过 WebSocket 处理 JSON-RPC 请求/响应
- `eth_subscribe`/`eth_unsubscribe` 封装
- 订阅跟踪与回调分发
- RPC 超时处理（10 秒）
- 断开后 3 秒重连

### LiveBlocks 组件 (`LiveBlocks.tsx`)
- 订阅 `newHeads` 获取实时区块通知
- 显示最新 10 个区块（区块号、哈希、Gas、时间戳）
- 绿色脉冲指示器表示实时连接
- 连接中显示黄色指示器

### LiveTransactions 组件 (`LiveTransactions.tsx`)
- 订阅 `newPendingTransactions` 查看内存池
- 显示最新 20 条待处理交易哈希
- 交易哈希去重
- Pending 状态标记

### ConnectionStatus 组件 (`ConnectionStatus.tsx`)
- 头部指示器显示 WebSocket 连接状态
- 绿色/红色圆点配 Live/Offline 文字

### 更新页面
- 首页：历史区块列表上方显示实时区块和待处理交易网格
- 布局：导航链接和连接状态指示器
- 连接信息：同时显示 HTTP RPC 和 WebSocket 端点

## 配置

- `NEXT_PUBLIC_WS_URL`：WebSocket 端点（默认 `ws://127.0.0.1:18781`）
- `NEXT_PUBLIC_RPC_URL`：HTTP RPC 端点（默认 `http://127.0.0.1:28780`）

## 状态：已完成
