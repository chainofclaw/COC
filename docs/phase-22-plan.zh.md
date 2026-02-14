# Phase 22：验证者治理

## 概述

Phase 22 添加基于提案的验证者治理系统，支持质押加权投票和基于 epoch 的转换。

## 组件

### ValidatorGovernance (`validator-governance.ts`)

**验证者管理：**
- 创世验证者初始化（含质押金额）
- 质押加权投票权计算（与质押成比例）
- 活跃/非活跃验证者跟踪

**提案系统：**
- `add_validator`：添加新验证者（需要地址 + 最低质押）
- `remove_validator`：移除验证者（不能移除最后一个）
- `update_stake`：修改验证者质押金额
- 提案者必须是活跃验证者
- 提案者自动投赞成票

**投票：**
- 每个活跃验证者可投赞成/反对票
- 质押加权投票权决定结果
- 可配置批准阈值（默认 67%）
- 最低参与要求（默认 50%）
- 达到阈值时提案自动决议

**生命周期：**
- 提案在可配置的 epoch 时长后过期（默认 24 个 epoch）
- `advanceEpoch()` 处理过期提案
- 状态：pending → approved/rejected/expired

### 配置
- `minStake`：验证者最低质押（默认 1 ETH）
- `maxValidators`：最大验证者集合大小（默认 100）
- `proposalDurationEpochs`：提案过期时间（默认 24）
- `approvalThresholdPercent`：需要的批准投票权（默认 67%）
- `minVoterPercent`：最低参与率（默认 50%）

## 测试覆盖

- `validator-governance.test.ts`：15 个测试（全部通过）

## 状态：已完成
