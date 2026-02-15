# COC（ChainOfClaw）

COC 是一个 EVM 兼容的区块链原型，包含 PoSe（Proof-of-Service）结算与 IPFS 兼容的存储接口。

## 目录结构

- `docs/`：白皮书与技术文档
- `specs/`：协议/经济/路线规范
- `contracts/`：PoSe 结算合约
- `services/`：链下挑战/验证/聚合/中继
- `runtime/`：coc-node / coc-agent / coc-relayer
- `node/`：链引擎 + RPC + P2P + 存储
- `wallet/`：简易 CLI 钱包
- `tests/`：集成与端到端测试
- `scripts/`：devnet 与验证脚本
- `explorer/`：区块链浏览器前端
- `website/`：项目网站
- `nodeops/`：节点运维与策略引擎

## 当前进展

- **链引擎**：出块、mempool（EIP-1559 排序、替换、驱逐）、快照、确定性提议者轮换、基础最终性、共识错误恢复（降级模式）
- **P2P 网络**：基于 HTTP 的 tx/块 gossip、快照同步、每 peer 广播去重、请求体大小限制、广播并发控制
- **EVM 执行**：内存 + LevelDB 持久化状态、完整 @ethereumjs/vm 集成
- **JSON-RPC**：57+ 标准以太坊方法 + `coc_*` / `txpool_*` 自定义方法，BigInt 安全序列化
- **WebSocket RPC**：`eth_subscribe` / `eth_unsubscribe`（newHeads / newPendingTransactions / logs），订阅验证与限制
- **EIP-1559**：动态 baseFee 计算（50% 目标利用率、12.5% 最大变化、1 gwei 底价）
- **PoSe 协议**：
  - 链下：挑战工厂、回执验证、批次聚合、epoch 评分
  - 链上：PoSeManager 合约（注册、批次提交、挑战、最终化、惩罚）
- **存储层**：
  - LevelDB 持久化（区块索引、EVM 状态树、Nonce 注册表）
  - IPFS 兼容 HTTP APIs（add/cat/get/block/pin/ls/stat/id/version）+ `/ipfs/<cid>` 网关
- **运行时服务**：
  - `coc-node`：PoSe 挑战/回执 HTTP 端点
  - `coc-agent`：挑战生成、批次提交、节点注册
  - `coc-relayer`：epoch 最终化与惩罚自动化
- **节点运维**：基于 YAML 的策略引擎与 agent 生命周期钩子
- **健康监控**：系统诊断（内存/WS/存储/共识状态）
- **调试追踪**：debug_traceTransaction、trace_transaction 支持
- **工具集**：
  - CLI 钱包（创建地址、转账、查询余额）
  - 3/5/7 节点 devnet 脚本
  - 质量门禁脚本（单元 + 集成 + e2e 测试）
- **区块链浏览器**：Next.js 15 App Router 应用
  - 首页：链统计仪表盘 + 最新区块 + WebSocket 实时更新
  - 区块/交易/地址详情页
  - 合约视图：字节码反汇编、eth_call、存储扫描
  - Mempool 页面：待处理交易流
  - 验证者页面：验证者列表与状态
  - 统计页面：链活动、TPS、Gas 使用可视化
  - 合约页面：已部署合约列表
  - 网络页面：节点运行状态
- **测试覆盖**：191 个测试，66 个测试文件，覆盖链引擎、EVM、mempool、RPC、WebSocket、P2P、存储、IPFS、PoSe、配置等模块
- **生产加固**：RPC 参数验证（结构化错误码）、共识广播隔离、PoSe HTTP 输入验证、配置校验、Merkle 路径边界检查、结构化日志替代 console.warn

## 快速开始

### 运行本地节点

```bash
cd node
npm install
npm start
```

### 部署 PoSe 合约

```bash
cd contracts
npm install
npm run compile
npm run deploy:local
```

### 运行开发网络

```bash
bash scripts/devnet-3.sh  # 3 节点网络
bash scripts/devnet-5.sh  # 5 节点网络
bash scripts/devnet-7.sh  # 7 节点网络
```

### 启动浏览器

```bash
cd explorer
npm install
npm run dev
# 打开 http://localhost:3000
```

## 质量门禁

```bash
bash scripts/quality-gate.sh
```

## 文档

- 实现状态：`docs/implementation-status.md`
- 功能矩阵：`docs/feature-matrix.md`
- 系统架构：`docs/system-architecture.zh.md`
- 核心算法：`docs/core-algorithms.zh.md`

## 许可证

MIT 许可证 - 详见 LICENSE 文件

---

English version: [README.md](./README.md)
