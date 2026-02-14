# Phase 19：PoSe 争议自动化

## 概述

Phase 19 为 PoSe（服务证明）系统添加自动争议检测、累积惩罚跟踪和争议事件日志。

## 组件

### DisputeMonitor (`services/dispute/dispute-monitor.ts`)
- 自动验证提交的批次与本地观测到的收据
- 检测：已提交批次缺少本地收据、摘要哈希不匹配
- 跳过已终结/已争议的批次，避免重复处理
- 可配置：检查间隔、每次最大批次数、自动挑战开关
- `validateBatch()` / `validateBatches()` 批次检验
- `drainDisputes()` 消费待处理的争议结果

### PenaltyTracker (`services/dispute/penalty-tracker.ts`)
- 每个节点的累积惩罚积分跟踪
- 基于证据的积分分配：重放随机数(20)、无效签名(15)、超时(5)、存储证明无效(30)、缺失收据(10)
- 两级惩罚机制：
  - 暂停阈值（默认 50 分）：可配置时长的临时暂停
  - 驱逐阈值（默认 100 分）：永久驱逐
- 基于时间的衰减：积分按可配置的每小时速率递减
- `isPenalized()` / `isEjected()` / `getPenalizedNodes()` 查询

### DisputeLogger (`services/dispute/dispute-logger.ts`)
- 记录所有争议相关事件（挑战、验证、惩罚、争议、终结）
- 支持过滤的查询 API：类型、节点 ID、Epoch ID、时间范围、限制
- 按类型分组的事件汇总
- 节点历史查询
- 可配置最大事件容量，FIFO 淘汰

## 测试覆盖

- `services/dispute/dispute.test.ts`：22 个测试（7 监控 + 7 惩罚 + 8 日志）
- 全部通过

## 状态：已完成
