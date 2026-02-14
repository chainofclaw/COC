# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

COC (ChainOfClaw) 是一个 EVM 兼容的区块链原型，集成了 PoSe (Proof-of-Service) 结算机制和 IPFS 兼容的存储接口。

## 工作区结构

项目使用 npm workspaces 管理多个包：

- `node/`: 区块链核心引擎（ChainEngine, EVM, P2P, RPC, IPFS）
- `contracts/`: Solidity 智能合约（PoSeManager 结算合约）
- `services/`: PoSe 离线服务（challenger, verifier, aggregator, relayer）
- `runtime/`: 运行时可执行文件（coc-node, coc-agent, coc-relayer）
- `nodeops/`: 节点操作和策略引擎
- `wallet/`: CLI 钱包工具
- `tests/`: 集成和端到端测试
- `explorer/`: Next.js 区块链浏览器
- `website/`: 项目网站

## 运行时要求

- **Node.js 22+** (使用 `--experimental-strip-types` 直接运行 TypeScript)
- npm 用于包管理和工作区

## 核心开发命令

### 运行本地节点
```bash
cd node
npm install
npm start  # 使用 node --experimental-strip-types
```

### 智能合约开发
```bash
cd contracts
npm install
npm run compile          # 编译合约
npm test                 # Hardhat 测试
npm run coverage         # 覆盖率检查
npm run coverage:check   # 验证覆盖率阈值
npm run deploy:local     # 部署到本地网络
npm run verify:pose      # 验证 PoSe 合约
```

### 运行 Devnet
```bash
bash scripts/devnet-3.sh  # 3 节点网络
bash scripts/devnet-5.sh  # 5 节点网络
bash scripts/devnet-7.sh  # 7 节点网络
bash scripts/stop-devnet.sh    # 停止 devnet
bash scripts/verify-devnet.sh  # 验证 devnet 运行状态
```

### 区块链浏览器
```bash
cd explorer
npm install
npm run dev    # 开发模式 http://localhost:3000
npm run build  # 生产构建
npm start      # 生产模式启动
```

### 质量检查
```bash
bash scripts/quality-gate.sh  # 运行所有单元、集成和 e2e 测试
```

### 节点运维策略
策略文件位于 `nodeops/policies/*.yaml`，可以通过策略引擎加载和评估。

## 测试策略

使用 Node.js 内置测试框架：
- **单元测试**: `services/` 和 `nodeops/` 中的 `*.test.ts` 文件
- **存储层测试**: `node/src/storage/*.test.ts` (26 tests)
- **集成测试**: `tests/integration/*.test.ts`
- **E2E 测试**: `tests/e2e/*.test.ts`

运行测试：
```bash
# 单个包内运行测试
cd node
node --experimental-strip-types --test src/**/*.test.ts

# 仅运行存储层测试
node --experimental-strip-types --test src/storage/*.test.ts

# 合约测试
cd contracts
npm test
```

## 核心架构概念

### 节点核心组件 (node/src/)
- `chain-engine.ts`: 区块链引擎，管理区块生产、持久化和最终性
- `evm.ts`: EVM 执行层（基于 @ethereumjs/vm）
- `consensus.ts`: 共识引擎（当前为确定性轮换）
- `p2p.ts`: HTTP-based gossip 网络（事务和区块传播）
- `rpc.ts`: JSON-RPC 接口（钱包集成）
- `mempool.ts`: 交易内存池（gas 优先级 + nonce 排序）
- `storage.ts`: 链快照持久化
- `ipfs-*.ts`: IPFS 兼容存储层
  - `ipfs-blockstore.ts`: 内容寻址块存储
  - `ipfs-unixfs.ts`: UnixFS 文件布局
  - `ipfs-http.ts`: IPFS HTTP API 子集 + `/ipfs/<cid>` 网关
- `pose-engine.ts`: PoSe 挑战/收据管道
- `pose-http.ts`: PoSe HTTP 端点

### PoSe 服务层 (services/)
- `challenger/`: 挑战生成和配额管理
- `verifier/`: 收据验证、评分和奖励计算
- `aggregator/`: 批处理聚合（Merkle root + 样本证明）
- `relayer/`: epoch 最终化和 slash 自动化
- `common/`: 共享类型、Merkle 树和角色注册表

### 运行时服务 (runtime/)
- `coc-node.ts`: PoSe 挑战/收据 HTTP 端点
- `coc-agent.ts`: 挑战生成、批量提交、节点注册
- `coc-relayer.ts`: epoch 最终化和 slash hooks

### 节点运维 (nodeops/)
- `policy-engine.ts`: 策略评估引擎
- `policy-loader.ts`: 策略加载和验证（支持 YAML）
- `agent-hooks.ts`: agent 生命周期钩子
  - `onChallengeIssued`: 挑战发起时触发
  - `onReceiptVerified`: 收据验证后触发
  - `onBatchSubmitted`: 批次提交后触发
- `policy-types.ts`: 策略类型定义
- `policies/*.yaml`: 示例策略配置
  - `default-policy.yaml`: 默认策略
  - `home-lab-policy.yaml`: 家庭实验室策略
  - `alerts-policy.yaml`: 告警策略

### 区块链浏览器 (explorer/)
- `src/app/page.tsx`: 首页 - 最新区块列表
- `src/app/block/[id]/page.tsx`: 区块详情页面
- `src/app/tx/[hash]/page.tsx`: 交易详情页面（包含 receipt 和 logs）
- `src/app/address/[address]/page.tsx`: 地址页面（余额和交易历史）
- `src/lib/provider.ts`: ethers.js provider 配置

### 智能合约 (contracts/)
- `settlement/PoSeManager.sol`: PoSe 结算合约
  - 节点注册和承诺更新
  - 批量提交和挑战
  - epoch 最终化和 slash

### 性能基准测试 (node/src/benchmarks/)
- `evm-benchmark.test.ts`: EVM 执行性能基准测试
  - 测试常见操作的 gas 消耗
  - 测量执行时间

### 持久化存储层 (node/src/storage/) - Phase 13.1
- `db.ts`: LevelDB 存储抽象层
  - IDatabase 接口定义
  - LevelDatabase: 生产环境实现
  - MemoryDatabase: 测试用内存实现
  - 批量操作支持
- `block-index.ts`: 区块和交易索引
  - 按编号查询区块
  - 按哈希查询区块和交易
  - 最新区块指针
  - BigInt 序列化处理
- `nonce-store.ts`: Nonce 注册表持久化
  - 防止重放攻击（跨重启）
  - 自动清理（7 天阈值）
  - PersistentNonceStore: LevelDB 后端
  - InMemoryNonceStore: 测试用
- `state-trie.ts`: EVM 状态树持久化
  - Merkle Patricia Trie 集成
  - 账户状态（nonce, balance, storageRoot, codeHash）
  - 存储槽管理（address -> slot -> value）
  - 合约代码存储（code -> codeHash）
  - Checkpoint/revert 支持

## 数据流概览

1. 钱包通过 JSON-RPC 发送签名交易
2. 节点内存池验证并 gossip 交易
3. 提议者构建区块并通过 EVM 执行
4. 区块被 gossip 并被 peers 接受
5. 存储 API 接受文件并生成 CIDs（用于 PoSe 存储挑战）
6. PoSe agent 发起挑战、验证收据、聚合批次
7. 聚合的批次提交到 PoSeManager，稍后由 relayer 最终化

## 当前限制

- 共识采用确定性轮换（尚未实现 BFT/PoS）
- P2P 使用 HTTP gossip（非完整的 peer discovery 协议）
- EVM 状态为内存存储，仅支持快照持久化
- IPFS 兼容性聚焦于核心 HTTP APIs 和网关行为，不支持完整的 IPFS 功能（如 MFS、pubsub）

## 配置文件位置

- 节点配置：通过环境变量或 `node/src/config.ts` 加载
- 合约配置：`contracts/hardhat.config.cjs`

## 文档参考

- 实现状态：`docs/implementation-status.md`
- 系统架构：`docs/system-architecture.en.md`
- 核心算法：`docs/core-algorithms.en.md`
- 功能矩阵：`docs/feature-matrix.md`
