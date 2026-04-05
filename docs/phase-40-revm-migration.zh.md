# Phase 40: EVM 引擎抽象层与 revm 迁移

**状态**: 阶段 1-2 已完成 (2026-04-05)，阶段 3-5 进行中

## 概述

Phase 40 引入引擎无关的 EVM 抽象层，使 COC 可以在不影响其余代码的情况下替换底层 EVM 实现。近期目标是从 EthereumJS VM (~133 TPS) 迁移到 revm (Rust EVM via WASM，目标 **500-1000+ TPS**)。

## 动机

经过 Phase 37-39 消除所有非 EVM 开销后（mega-batch 写入、VM 初始化去重、ECDSA 去重、State Trie 批量提交、Rollup 排序器模式），瓶颈已转移到 **EVM 执行引擎本身**：

| 组件 | 每笔交易耗时 | 占比 |
|------|------------|------|
| EthereumJS `runTx()` | ~5-7ms | 70-80% |
| State Trie 读写 | ~1-2ms | 15-20% |
| 其他开销 | ~0.5ms | 5-10% |

revm (Rust) 执行 EVM 字节码比 EthereumJS (JavaScript) 快 10-50 倍。即使通过 WASM（比 native 慢约 2 倍），仍预期获得 5-10 倍加速。

## 架构变化

### 变更前 (EthereumJS 耦合)

```
ChainEngine → EvmChain → EthereumJS VM → @ethereumjs/common
                  ↓           ↓               ↓
              getBlockCommon()  runTx()    Hardfork 枚举
              (泄漏 Common 类型)          (泄漏到配置)
```

### 变更后 (引擎无关)

```
ChainEngine → IEvmEngine ← EvmChain (EthereumJS)
                  ↑
                  ← RevmEngine (revm WASM)  [阶段 3]
                  ↑
              prepareBlock() → EvmBlockEnv { _internal }
              (引擎内部细节已封装)
```

## 阶段 1-2: 抽象层 (已完成)

### 新建文件

**`node/src/evm-types.ts`** — 引擎无关类型:
- `EvmHardfork` — `"shanghai" | "cancun" | "prague"` (替代 EthereumJS `Hardfork` 枚举)
- `EvmHardforkScheduleEntry` — 配置级硬分叉调度
- `EvmBlockEnv` — 每块预计算一次的不透明块环境
- `CallParams` / `CallResult` — eth_call 参数类型

**`node/src/evm-engine.ts`** — `IEvmEngine` 接口:
```typescript
interface IEvmEngine {
  applyBlockContext(context): Promise<void>
  prepareBlock(blockNumber, context?): EvmBlockEnv
  executeRawTx(rawTx, ...): Promise<ExecutionResult>
  getBalance(address, stateRoot?): Promise<bigint>
  getNonce(address, stateRoot?): Promise<bigint>
  getCode(address, stateRoot?): Promise<string>
  getStorageAt(address, slot, stateRoot?): Promise<string>
  prefund(accounts): Promise<void>
  checkpointState(): Promise<void>
  commitState(): Promise<void>
  revertState(): Promise<void>
  getReceipt(txHash): TxReceipt | null
  getTransaction(txHash): TxInfo | null
  evictCaches(): void
  getBlockNumber(): bigint
  getChainId(): number
}
```

### 修改文件

**`node/src/evm.ts`** — 新增 `prepareBlock()`:
- 将 `getBlockCommon()` + `getExecutionBlock()` 封装为单一 `EvmBlockEnv`
- 引擎内部数据存储在 `_internal` 中（对消费者不透明）

**`node/src/chain-engine-persistent.ts`** + **`node/src/chain-engine.ts`**:
- 从 `getBlockCommon()` + `getExecutionBlock()` 迁移到 `prepareBlock()`

### 验证

- **1017/1017** node 测试通过（零回归）
- 纯重构 — 无行为变更

## 阶段 3: revm WASM 绑定 (进行中)

### 方案

1. 安装预编译的 revm WASM 包（避免 Rust 工具链依赖）
2. 创建 `RevmAdapter` 将 `IStateTrie` 桥接到 revm 的状态回调接口
3. 创建 `RevmEngine implements IEvmEngine`
4. 将 EthereumJS 类型映射到 revm 等价类型

### 关键类型映射

| EthereumJS | revm | 转换方式 |
|------------|------|---------|
| `Hardfork.Shanghai` | `SpecId::SHANGHAI` | 枚举映射 |
| `runTx(vm, {tx, block})` | `revm.transact(env, tx)` | 适配器 |
| `result.totalGasSpent` | `result.gas_used` | 直接映射 |
| `result.execResult.logs` | `result.logs` | 格式转换 |
| `Address.fromString()` | `[u8; 20]` | hex 解析 |

### 计划新建文件

- `node/src/revm-adapter.ts` — IStateTrie → revm StateDb 桥接
- `node/src/revm-engine.ts` — RevmEngine implements IEvmEngine
- `node/src/evm-factory.ts` — 引擎工厂（按配置选择）

## 阶段 4: 双引擎验证 (计划中)

并行运行两个引擎处理相同交易，对比:
- 交易哈希
- Gas 消耗
- 成功/失败状态
- Receipt 日志
- State root（链兼容性关键指标）

所有结果必须 **100% 一致** 才能切换默认引擎。

## 阶段 5: 切换默认引擎 (计划中)

- 配置: `evmEngine: "revm"` (默认), `"ethereumjs"` (回退)
- 基于硬分叉高度切换: 高度 N 之前用 EthereumJS，之后用 revm
- 不影响已有链数据（执行引擎是内部实现细节）

## 预期 TPS 提升

| 引擎 | 简单转账 | 合约调用 | 理论天花板 |
|------|---------|---------|-----------|
| EthereumJS (当前) | 133 TPS | ~50-80 TPS | ~170 TPS |
| revm WASM | **500-800 TPS** | **200-400 TPS** | **~1000 TPS** |
| revm native (napi-rs, 未来) | **800-1500 TPS** | **400-800 TPS** | **~2000 TPS** |

## 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| State root 不一致 | 中 | 致命（链分叉） | 阶段 4 双引擎逐笔对比；EF 测试向量验证 |
| revm WASM 性能低于预期 | 低 | 收益减少 | WASM 仍比 JS 快 5-10x；可升级 napi-rs |
| Debug trace API 不兼容 | 高 | 部分功能缺失 | 保留 EthereumJS 回退用于 tracing |
| Cancun 特性 (beacon roots) | 中 | 功能缺失 | revm 已支持 Cancun；正确映射 SpecId |

## 文件清单

| 文件 | 操作 | 阶段 |
|------|------|------|
| `node/src/evm-types.ts` | **已创建** | 1 |
| `node/src/evm-engine.ts` | **已创建** | 2 |
| `node/src/evm.ts` | 已修改 (+`prepareBlock()`) | 1-2 |
| `node/src/chain-engine-persistent.ts` | 已修改 (使用 `prepareBlock()`) | 1 |
| `node/src/chain-engine.ts` | 已修改 (使用 `prepareBlock()`) | 1 |
| `node/src/revm-adapter.ts` | 计划中 | 3 |
| `node/src/revm-engine.ts` | 计划中 | 3 |
| `node/src/evm-factory.ts` | 计划中 | 4 |

## TPS 优化历程

| Phase | 优化内容 | TPS | 提升倍数 |
|-------|---------|-----|---------|
| 基线 | 无优化 | 16.7 | — |
| **Phase 37** | Mega-batch DB 写入 | **131** | 7.8x |
| **Phase 38** | EVM Pipeline + ECDSA 去重 | **133.7** | +2% |
| **Phase 39** | State Trie 批量提交 + Rollup 排序器模式 | **133.7** | 架构就绪 |
| **Phase 40** (进行中) | revm WASM 替换 EthereumJS | **500-1000** | 4-8x (预期) |
| **Phase 40** (未来) | revm native (napi-rs) | **800-2000** | 6-15x (预期) |
