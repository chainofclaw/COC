# Phase 17：Debug/Trace API

## 概述

Phase 17 添加了交易级别的调试和追踪 API，兼容以太坊的 `debug_traceTransaction`、`debug_traceBlockByNumber` 和 OpenEthereum 的 `trace_transaction` 格式。

## 组件

### Debug Trace 模块 (`debug-trace.ts`)

- `traceTransaction()`：基于收据数据的简化执行追踪
  - 优先使用持久化存储，回退到 EVM 内存
  - 返回包含 gas、失败状态和 structLogs 的 `TransactionTrace`
- `traceBlockByNumber()`：追踪区块中所有交易
  - 解析原始交易数据以提取哈希
  - 收集每笔交易的追踪信息
- `traceTransactionCalls()`：OpenEthereum 兼容的调用追踪
  - 返回包含 from/to/value/gas/input/output 的 `CallTrace[]`
  - 失败交易包含 error 字段

### RPC 集成 (`rpc.ts`)

- `debug_traceTransaction(txHash, options?)` → `TransactionTrace`
- `debug_traceBlockByNumber(blockNumber)` → `Array<{txHash, result}>`
- `trace_transaction(txHash)` → `CallTrace[]`

### Bug 修复：getReceiptsByBlock

修复了 `PersistentChainEngine.getReceiptsByBlock()` 方法，正确解析原始交易数据提取 txHash，而非错误地将原始交易 hex 当作哈希使用。

## 测试覆盖

- `debug-trace.test.ts`：5 个测试（全部通过）
- 覆盖：已确认交易追踪、不存在交易错误、区块追踪、不存在区块错误、调用追踪格式

## 状态：已完成
