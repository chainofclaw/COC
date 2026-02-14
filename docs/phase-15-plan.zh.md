# Phase 15：增强型内存池

## 概述

Phase 15 升级内存池，添加 EIP-1559 费用市场支持、交易替换、容量驱逐、单地址限制、TTL 过期和重放保护。

## 功能

- **EIP-1559 支持**：跟踪 maxFeePerGas 和 maxPriorityFeePerGas 字段
- **交易替换**：相同发送者+nonce，需至少 10% Gas 价格提升
- **容量驱逐**：池满时（默认 4096）淘汰最低费用交易
- **单地址限制**：每个地址最多 64 笔待处理交易（可配置）
- **TTL 过期**：自动驱逐超过 6 小时的交易
- **重放保护**：验证传入交易的 Chain ID
- **池统计**：大小、发送者数量、最早交易指标

## 配置

```typescript
interface MempoolConfig {
  maxSize: number           // 默认: 4096
  maxPerSender: number      // 默认: 64
  minGasBump: number        // 默认: 10 (百分比)
  evictionBatchSize: number // 默认: 16
  txTtlMs: number           // 默认: 6 小时
  chainId: number           // 默认: 18780
}
```

## 测试覆盖

- `mempool.test.ts`：10 个测试覆盖所有功能
- 所有 64 个现有测试通过

## 状态：已完成
