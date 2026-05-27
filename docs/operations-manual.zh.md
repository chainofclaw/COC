# COC (ChainOfClaw) 运维操作手册

> 从零到测试网——运维人员完整指南。

> **🟡 Canary 88780 说明** — 本文档涵盖 **代码默认值**(chainId `18780`、RPC
> 端口 `18780` 等)。**实时 canary 测试网**(chainId **88780**、公开 RPC
> `https://rpc.chainofclaw.io`、合约地址、faucet、explorer、速率限制)的权威参考
> 见 [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md)。
> 若是搭节点 **加入 88780**(非本地 devnet),设 `COC_CHAIN_ID=88780`,
> validator/peer 配置见 [`external-validator-onboarding.zh.md`](./external-validator-onboarding.zh.md)。

---

## 目录

1. [环境准备](#1-环境准备)
2. [仓库安装](#2-仓库安装)
3. [单节点快速启动](#3-单节点快速启动)
4. [节点配置参考](#4-节点配置参考)
5. [多节点 Devnet](#5-多节点-devnet)
6. [Docker 测试网部署](#6-docker-测试网部署)
7. [生产测试网部署](#7-生产测试网部署)
8. [智能合约部署](#8-智能合约部署)
9. [区块链浏览器](#9-区块链浏览器)
10. [钱包 CLI](#10-钱包-cli)
11. [PoSe 服务层](#11-pose-服务层)
12. [监控](#12-监控)
13. [健康检查与状态查询](#13-健康检查与状态查询)
14. [备份与恢复](#14-备份与恢复)
15. [质量门禁](#15-质量门禁)
16. [故障排查](#16-故障排查)

---

## 1. 环境准备

原理：稳定运维首先依赖运行时与工具链的一致性；Node.js、Docker 或 shell 行为不一致时，问题往往会先于共识或 PoSe 逻辑暴露出来。
模块/程序功能：本章说明核心节点、运行时服务、浏览器、钱包 CLI 以及容器化测试网共同依赖的宿主机前置条件。

### 软件要求

| 软件 | 版本 | 说明 |
|------|------|------|
| Node.js | **22+** | 使用 `--experimental-strip-types` 原生运行 TS |
| npm | 10+ | 需要 workspace 支持 |
| Git | 2.30+ | 版本控制 |
| curl | 任意 | RPC 验证工具 |
| bash | 4+ | Devnet 脚本依赖 |
| Docker | 24+ | 可选——容器化部署 |
| Docker Compose | 2.20+ | 可选——多容器编排 |

### 硬件要求（最低配置）

| 资源 | 单节点 | 3 节点测试网 |
|------|--------|-------------|
| CPU | 2 核 | 4 核 |
| 内存 | 4 GB | 8 GB |
| 磁盘 | 20 GB SSD | 60 GB SSD |
| 网络 | 10 Mbps | 50 Mbps |

---

## 2. 仓库安装

原理：COC 是一个多 workspace 系统，只有在代码树和依赖图一致时，节点、合约、运行时和浏览器之间才不会出现版本漂移。
模块/程序功能：本章将仓库目录映射到具体运维组件，帮助你识别哪个 workspace 负责节点执行、合约部署、运行时自动化、钱包操作和可观测性。

```bash
git clone https://github.com/<org>/ClawdBot.git
cd ClawdBot/COC
npm install          # 一次性安装所有 workspace 依赖
```

### Workspace 结构

```
COC/
├── node/            # 区块链核心引擎
├── contracts/       # Solidity 智能合约 (PoSeManager)
├── services/        # PoSe 链下服务
├── runtime/         # 运行时可执行文件 (agent, relayer, node)
├── wallet/          # CLI 钱包工具
├── explorer/        # Next.js 区块链浏览器
├── nodeops/         # 策略引擎和 Agent 钩子
├── tests/           # 集成和端到端测试
├── scripts/         # 运维脚本
├── docker/          # Docker 配置文件
└── docs/            # 文档
```

---

## 3. 单节点快速启动

原理：单节点环境是验证存储、RPC、执行和日志路径的最小闭环，不会引入对等网络和分布式共识变量。
模块/程序功能：本章启动核心区块链节点（`node/src/index.ts`），并验证外部工具依赖的 JSON-RPC 接口是否正常可用。

### 启动节点

```bash
COC_DATA_DIR=/tmp/coc-single \
  node --experimental-strip-types node/src/index.ts
```

### 默认端口

| 服务 | 端口 | 协议 |
|------|------|------|
| JSON-RPC | 18780 | HTTP |
| WebSocket | 18781 | WS |
| P2P 广播 | 19780 | HTTP |
| Wire 协议 | 19781 | TCP |
| IPFS API | 5001 | HTTP |
| Prometheus | 9100 | HTTP |

### 预充值账户（开发用）

| 字段 | 值 |
|------|-----|
| 地址 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| 私钥 | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| 余额 | 10 000 ETH |

### 验证启动

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# 预期返回: {"jsonrpc":"2.0","id":1,"result":"0x..."}
```

---

## 4. 节点配置参考

原理：节点行为由网络、共识、存储和安全配置共同决定；从运维角度看，这些输入应当明确、可审计、可复现。
模块/程序功能：本章说明主节点进程的数据目录、配置文件和环境变量，帮助你理解节点实际读取了哪些运行时输入。

配置文件加载自 `{COC_DATA_DIR}/node-config.json`，可通过环境变量覆盖。

### 核心参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `chainId` | 18780 | 链标识符 |
| `blockTimeMs` | 3000 | 出块间隔（毫秒） |
| `syncIntervalMs` | 5000 | P2P 同步间隔（毫秒） |
| `finalityDepth` | 3 | 最终性深度（区块数） |
| `maxTxPerBlock` | 50 | 每块最大交易数 |
| `minGasPriceWei` | `"1"` | 最低 Gas 价格 |
| `poseEpochMs` | 3600000 | PoSe 周期时长（1 小时） |
| `poseMaxChallengesPerEpoch` | 200 | 每周期最大挑战数 |

### 环境变量——网络

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COC_DATA_DIR` | `~/.clawdbot/coc` | 数据目录 |
| `COC_NODE_CONFIG` | `{dataDir}/node-config.json` | 配置文件路径 |
| `COC_NODE_KEY` | 自动生成 | 节点私钥（0x + 64 位十六进制）；`COC_NODE_PK` 仅作为旧别名兼容 |
| `COC_RPC_BIND` | `0.0.0.0` | RPC 监听地址 |
| `COC_RPC_PORT` | 18780 | RPC 端口 |
| `COC_WS_BIND` | `0.0.0.0` | WebSocket 监听地址 |
| `COC_WS_PORT` | 18781 | WebSocket 端口 |
| `COC_P2P_BIND` | `0.0.0.0` | P2P 监听地址 |
| `COC_P2P_PORT` | 19780 | P2P 端口 |
| `COC_WIRE_BIND` | `0.0.0.0` | Wire 协议监听地址 |
| `COC_WIRE_PORT` | 19781 | Wire 协议端口 |
| `COC_IPFS_BIND` | `0.0.0.0` | IPFS 监听地址 |
| `COC_IPFS_PORT` | 5001 | IPFS 端口 |
| `COC_METRICS_PORT` | 9100 | Prometheus 指标端口 |
| `COC_DEV_MODE` | `false` | 开发模式（绑定 127.0.0.1） |
| `COC_NODE_MODE` | `full` | 节点模式：`full` / `archive` / `light` |

### 环境变量——安全

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COC_RPC_AUTH_TOKEN` | （无） | RPC Bearer Token 认证 |
| `COC_ENABLE_ADMIN_RPC` | `false` | 启用 admin_* 命名空间 |
| `COC_DEV_ACCOUNTS` | （无） | 设为 `1` 启用开发账户 |
| `COC_SIGNATURE_ENFORCEMENT` | `enforce` | `off` / `monitor` / `enforce` |
| `COC_P2P_AUTH_MODE` | `enforce` | P2P 入站认证模式 |
| `COC_P2P_AUTH_MAX_CLOCK_SKEW_MS` | 120000 | 最大时钟偏移（毫秒） |
| `COC_POSE_AUTH_MODE` | `enforce` | PoSe 挑战认证模式 |
| `COC_POSE_ALLOWED_CHALLENGERS` | （无） | 逗号分隔的挑战者地址白名单 |

### 功能开关

| 变量 / 配置 | 默认值 | 说明 |
|-------------|--------|------|
| `enableBft` | 自动（≥3 验证者） | BFT 共识 |
| `enableWireProtocol` | `false` | TCP Wire 协议 |
| `enableDht` | `false` | DHT 节点发现 |
| `enableSnapSync` | `false` | 状态快照同步 |
| `snapSyncThreshold` | 100 | 触发快照同步的高度差 |

### 存储配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `storage.backend` | `leveldb` | `memory` 或 `leveldb` |
| `storage.cacheSize` | 1000 | LRU 缓存条目数 |
| `storage.enablePruning` | `false` | 自动裁剪旧区块 |
| `storage.nonceRetentionDays` | 7 | Nonce 清理阈值（天） |

### 数据目录结构

```
{COC_DATA_DIR}/
├── node-config.json              # 配置文件
├── node-key                      # 私钥（权限 0600）
├── leveldb/                      # LevelDB 状态存储
├── storage/                      # IPFS 区块存储
├── peers.json                    # P2P 节点缓存
├── pose-nonce-registry.log       # PoSe Nonce 持久化
├── p2p-auth-nonce.log            # P2P 认证 Nonce
├── pose-auth-nonce.log           # PoSe 认证 Nonce
├── reward-manifests/             # 奖励清单文件
├── evidence/                     # BFT 惩罚证据
├── pending-challenges.json       # Agent v1 待处理存储
└── pending-challenges-v2.json    # Agent v2 待处理存储
```

---

## 5. 多节点 Devnet

原理：进入多节点环境后，节点发现、BFT 协调和状态传播会成为最先暴露问题的地方，因此 Devnet 是分布式验证的第一层门槛。
模块/程序功能：本章使用 Devnet 脚本启动多个核心节点，并为它们分配协调好的端口、验证者列表和对等拓扑。

### 启动

```bash
bash scripts/start-devnet.sh 3    # 3 节点 Devnet
bash scripts/start-devnet.sh 5    # 5 节点 Devnet
bash scripts/start-devnet.sh 7    # 7 节点 Devnet
```

### 端口分配

| 服务 | 节点 1 | 节点 2 | 节点 3 | 计算公式 |
|------|--------|--------|--------|----------|
| RPC | 28780 | 28781 | 28782 | 28780 + (N-1) |
| P2P | 29780 | 29781 | 29782 | 29780 + (N-1) |
| WebSocket | 18781 | 18782 | 18783 | 18781 + (N-1) |
| Wire | 29781 | 29782 | 29783 | 29781 + (N-1) |
| IPFS | 5001 | 5002 | 5003 | 5001 + (N-1) |

### 自动启用功能

所有 Devnet 节点自动启用：**BFT 共识**、**Wire 协议**、**DHT 发现**、**快照同步**。

### 验证

```bash
bash scripts/verify-devnet.sh 3
```

检查项目：
- 所有节点出块高度递增
- 交易跨节点传播
- BFT 最终性状态

### 停止

```bash
bash scripts/stop-devnet.sh 3
```

---

## 6. Docker 测试网部署

原理：容器化部署以牺牲部分宿主机灵活性为代价，换取更强的可重复性，适合快速恢复一个已知拓扑的测试网环境。
模块/程序功能：本章覆盖 Docker Compose 栈和镜像，它们把核心节点、runtime 侧车、浏览器、官网和水龙头打包成接近测试网的部署形态。

### 6.1 单节点 Docker

```bash
docker compose -f docker/docker-compose.yml up -d
```

服务：`node`、`explorer`、`website`
暴露端口：18780 (RPC)、3000 (浏览器)、3001 (网站)

### 6.2 3 节点 BFT 测试网

```bash
# 启动
docker compose -f docker/docker-compose.testnet.yml up -d

# 启动同一套栈，并附带 PoSe runtime 侧车
docker compose -f docker/docker-compose.testnet.yml --profile pose up -d

# 或使用管理脚本
bash scripts/launch-testnet.sh up
bash scripts/launch-testnet.sh status
bash scripts/launch-testnet.sh verify
bash scripts/launch-testnet.sh down
```

服务：`node-1`、`node-2`、`node-3`、`explorer`、`faucet`
可选 profile：通过 `--profile pose` 启动 `agent`、`relayer`

| 服务 | 端口 |
|------|------|
| 节点 1 RPC | 28780 |
| 节点 2 RPC | 28782 |
| 节点 3 RPC | 28784 |
| 浏览器 | 3000 |
| 水龙头 | 3003 |

环境变量：
- 设置 `COC_FAUCET_KEY` 指定水龙头私钥
- 设置 `IMAGE_TAG` 以及可选的 `COC_NODE_IMAGE` / `COC_RUNTIME_IMAGE` / `COC_EXPLORER_IMAGE` / `COC_FAUCET_IMAGE`，用于部署预构建镜像

### 6.3 Dockerfile 说明

节点镜像（`docker/Dockerfile.node`）特性：
- **基础镜像**：`node:22-slim` 多阶段构建
- **运行用户**：非 root `coc` 用户
- **数据卷**：`/data/coc` 持久化存储
- **健康检查**：每 15 秒执行 `eth_blockNumber` 查询
- **暴露端口**：18780、18781、19780、19781、5001、9100

```bash
docker build -f docker/Dockerfile.node -t coc-node:latest .
```

runtime 镜像（`docker/Dockerfile.runtime`）打包了 `coc-agent` 和 `coc-relayer`，同样基于 Node 22：

```bash
docker build -f docker/Dockerfile.runtime -t coc-runtime:latest .
```

---

## 7. 生产测试网部署

原理：生产式测试网不仅是“把程序跑起来”，还需要处理身份生成、服务托管和对外入口治理，这些层面与节点二进制本身同等重要。
模块/程序功能：本章覆盖验证者引导、创世/配置产物生成，以及基于 systemd 和 Nginx 的节点运行方式。

### 7.1 生成验证者密钥

```bash
bash scripts/generate-validator-keys.sh <数量>
# 输出密钥对和地址到标准输出
# 务必安全保存——这些是验证者身份凭证
```

### 7.2 生成创世配置

```bash
# Docker 部署
COC_DOCKER=1 bash scripts/generate-genesis.sh 3

# 裸金属部署（将 203.0.113.10 替换成你的引导主机）
COC_BOOT_HOST=203.0.113.10 bash scripts/generate-genesis.sh 3
```

### 7.3 引导节点配置

```bash
bash scripts/setup-boot-nodes.sh
```

配置项：
- DNS TXT 记录用于种子发现
- DHT 引导节点列表
- 初始节点连接
- 用于验证者接入的 `boot-nodes.json` / `dht-seeds.json`

### 7.4 systemd 服务

安装 systemd 单元文件：

```bash
sudo cp docker/systemd/coc-node.service /etc/systemd/system/
sudo cp docker/systemd/coc-agent.service /etc/systemd/system/
sudo cp docker/systemd/coc-relayer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now coc-node
```

`coc-node.service` 关键配置：
- `Restart=always`，`RestartSec=10`
- `LimitNOFILE=65535`（LevelDB 需要）
- 环境文件：`/etc/coc/coc-node.env`

`coc-agent.service` 和 `coc-relayer.service` 使用同样的模式，分别读取：
- `/etc/coc/coc-agent.env`
- `/etc/coc/coc-relayer.env`

### 7.5 Nginx 反向代理

```bash
sudo cp docker/nginx/coc-rpc.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/coc-rpc.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

特性：
- TLS 终结（Let's Encrypt）
- 速率限制（10 req/s，突发 20）
- WebSocket 升级支持
- CORS 头部

---

## 8. 智能合约部署

原理：链上结算与治理不属于节点进程本身，运维上必须把合约生命周期、网络目标和验证流程视为独立步骤来管理。
模块/程序功能：本章覆盖基于 Hardhat 的合约工具链，以及用于 PoSeManagerV2 参数预设解析的类型化部署辅助模块 `contracts/deploy/deploy-pose.ts`。

### 编译

```bash
cd contracts
npm install
npm run compile
```

### 本地部署

```bash
npm run deploy:local
```

### PoSeManagerV2 部署

```bash
# 使用仓库内置的 Hardhat 脚本做本地 PoSe 部署
npm run deploy:local

# 使用默认的 COC Hardhat 网络别名部署治理合约
npm run deploy:governance:coc
```

`contracts/deploy/deploy-pose.ts` 当前是程序化部署辅助库，不是仓库里直接注册成 Hardhat task 的独立 CLI。它为自动化/测试提供以下预设目标：

- `l1-mainnet`
- `l1-sepolia`
- `l2-coc`
- `l2-arbitrum`
- `l2-optimism`

### 治理合约

```bash
npx hardhat run scripts/deploy-governance.js --network coc
```

### 验证 PoSe 合约

COC 当前没有提供 Hardhat `verify:pose` 入口，也没有把 `PoSeManagerV2` 发布到 Etherscan/Sourcify 这类公共验证服务的脚本。

当前可用的方式是使用 Explorer 的合约验证页面：

1. 打开 Explorer 的 `/verify` 页面
2. 粘贴已部署合约源码
3. 选择 Solidity 编译器版本和优化参数
4. 提交后由 Explorer 本地重编译，并与 `eth_getCode` 结果做比对

这条链路属于“本地字节码验证”，不是公共合约注册/发布流程。

### Hardhat 配置说明

```
Solidity: 0.8.24
Hardhat 脚本网络：
  hardhat   -> 内存本地链
  localhost -> 本地 JSON-RPC 端点
  coc       -> COC_RPC_URL || PROWL_RPC_URL || http://127.0.0.1:18780
               COC_CHAIN_ID || PROWL_CHAIN_ID || 18780
  prowl     -> PROWL_RPC_URL || http://127.0.0.1:18780
               PROWL_CHAIN_ID || 18780
```

`prowl` 仍作为兼容旧脚本的别名保留，但新的脚本和文档建议统一使用 `coc`。

---

## 9. 区块链浏览器

原理：浏览器是建立在 RPC 和 WebSocket 之上的只读呈现层，不应被视为独立于链数据之外的权威来源。
模块/程序功能：本章覆盖 Next.js 浏览器，它从运行中的 COC 节点读取链状态、索引视图、统计分析和合约验证结果。

### 开发模式

```bash
cd explorer
npm install
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:18780 \
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:18781 \
npm run dev
```

默认地址：http://localhost:3000

### 生产模式

```bash
cd explorer
npm run build
NEXT_PUBLIC_RPC_URL=http://your-rpc-endpoint:18780 \
npm start
```

### 页面功能

| 路径 | 说明 |
|------|------|
| `/` | 仪表盘——链统计、最新区块、实时 WebSocket 更新 |
| `/block/[id]` | 区块详情——交易表、Gas 利用率、出块者、stateRoot |
| `/tx/[hash]` | 交易详情——回执、日志、代币转账、内部交易追踪 |
| `/address/[addr]` | 地址页——余额、交易历史、合约部署元数据 |
| `/mempool` | 内存池——待处理/排队交易、排序、筛选 |
| `/validators` | 验证者——质押量、投票权重、状态 |
| `/stats` | 统计分析——TPS 趋势、Gas 使用图表 |
| `/contracts` | 合约注册表——索引查询、分页 |
| `/network` | 网络信息——节点信息、连接端点 |
| `/verify` | 合约验证——solc-js 源码验证 |

---

## 10. 钱包 CLI

原理：签名和资金管理应与节点执行隔离，这样运维人员才能在不影响验证者或 relayer 进程的前提下独立审计和轮换密钥。
模块/程序功能：本章覆盖 `wallet/coc-wallet.ts`，它提供轻量级的密钥库管理、余额查询、转账和 nonce/回执查询能力。

### 使用方法

```bash
# 创建新钱包
node --experimental-strip-types wallet/coc-wallet.ts create [--password <密码>]

# 从私钥或助记词导入
node --experimental-strip-types wallet/coc-wallet.ts import <私钥或助记词> [--password <密码>]

# 查询余额
node --experimental-strip-types wallet/coc-wallet.ts balance <地址> [--rpc <url>]

# 发送 ETH
node --experimental-strip-types wallet/coc-wallet.ts send <来源地址> <目标地址> <金额(ETH)> [--rpc <url>]

# 查询交易
node --experimental-strip-types wallet/coc-wallet.ts tx <交易哈希> [--rpc <url>]

# 获取 Nonce
node --experimental-strip-types wallet/coc-wallet.ts nonce <地址> [--rpc <url>]
```

### 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COC_RPC_URL` | `http://127.0.0.1:18780` | RPC 端点 |
| `COC_WALLET_PASSWORD` | unset | 创建、导入、发送交易所需的密钥库密码；需显式设置或传入 `--password` |

密钥库位置：`~/.coc/keystore/{地址}.json`

---

## 11. PoSe 服务层

原理：PoSe 是围绕挑战发起、回执验证、证据持久化、奖励清单生成和链上结算协调构建的链下服务流水线。
模块/程序功能：本章覆盖实现这条流水线的运行时程序：`coc-node`、`coc-agent`、`coc-relayer` 和 `coc-reward-claim`。

### 11.1 coc-node（PoSe 端点）

原理：`coc-node` 是面向 PoSe 的轻量 HTTP 服务，负责签名挑战回执和见证证明；它不是完整的区块链核心节点。
模块/程序功能：该程序对外暴露挑战/回执 API 以及最小化的本地健康检查端点，主要用于测试和运行时集成。

PoSe 运行时服务暴露以下 HTTP 端点：

```bash
COC_DATA_DIR=/data/coc \
COC_NODE_KEY=0x... \
COC_POSE_WITNESS_AUTH_TOKEN=... \
  node --experimental-strip-types runtime/coc-node.ts
```

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/pose/challenge` | POST | 提交挑战（v1 EIP-191 / v2 EIP-712） |
| `/pose/receipt` | POST | 提交回执 |
| `/pose/witness` | POST | 见证证明（仅 v2） |

安全注意：`/pose/witness` 会签发 EIP-712 witness attestation。配置了 `COC_POSE_WITNESS_AUTH_TOKEN` 或运行时配置里的 `poseWitnessAuthToken` 后，所有调用方都必须提供匹配的 `Authorization: Bearer <token>`；未配置 token 时仅允许 loopback 调用。远程 `witnessNodes` 需要配置对应 `authToken`；公网部署应配合 TLS 或私有网络。

注意：`runtime/coc-node.ts` 的 `/health` 只返回轻量级服务本地状态（`{"ok":true,"ts":...}`）；链高度和节点连接状态仍应通过核心节点 RPC 或 metrics server 查询。

### 11.2 coc-agent（挑战与聚合）

原理：agent 是评分和证据的生产者，它持续抽样目标节点、校验响应，并把观察结果转成可聚合的回执与奖励清单。
模块/程序功能：该程序负责发起挑战、验证回执、持久化证据/manifest，并为后续 relayer 结算准备输入数据。

```bash
COC_NODE_URL=http://127.0.0.1:18780 \
COC_L1_RPC_URL=http://127.0.0.1:8545 \
COC_POSE_MANAGER=0x... \
COC_OPERATOR_PK=0x... \
COC_AGENT_INTERVAL_MS=60000 \
COC_AGENT_BATCH_SIZE=5 \
  node --experimental-strip-types runtime/coc-agent.ts
```

核心功能：
- 向节点发起存储挑战
- 使用确定性评分验证回执
- 聚合批次并提交到 PoSeManager 合约
- 收集见证证明（v2）
- 持久化奖励清单到 `{dataDir}/reward-manifests/`
- Tick 重入保护防止周期重叠

若使用 v2 协议，`coc-agent` 还需要在运行时配置文件中提供 `protocolVersion: 2`、`poseManagerV2Address` 和 `verifyingContract`；这些设置主要通过配置文件而不是单独环境变量读取。

### 11.3 coc-relayer（Epoch 终结与惩罚）

原理：relayer 是结算侧协调器，它将持久化的奖励清单和证据转化为合约调用，同时保持争议和惩罚顺序的确定性。
模块/程序功能：该程序负责终结 epoch、分发奖励、把 BFT 双签证据桥接到 PoSe 争议管线，并推进 v2 争议生命周期。

```bash
COC_L1_RPC_URL=http://127.0.0.1:8545 \
COC_POSE_MANAGER=0x... \
COC_SLASHER_PK=0x... \
COC_RELAYER_INTERVAL_MS=60000 \
  node --experimental-strip-types runtime/coc-relayer.ts
```

核心功能：
- 终结 Epoch（v1 和 v2）
- 读取奖励清单并提交 Merkle 根
- 处理来自 BFT 双签检测的惩罚证据
- 管理 v2 争议生命周期（提交 → 揭示 → 结算）
- Tick 重入保护

若使用 v2 协议，relayer 还会从运行时配置文件中读取 `protocolVersion`、`poseManagerV2Address`、`verifyingContract` 以及可选的 `l2RpcUrl`。

### 11.4 coc-reward-claim（V2 Merkle 领取）

原理：奖励领取被有意地与奖励生成和 epoch 终结解耦，这样运营者可以在提交 claim 交易前先审计证明和金额。
模块/程序功能：该程序会读取奖励清单，优先选择 settled manifest 中的证明，并根据协议版本提交 v2 Merkle claim 或 v1 直接 claim。

```bash
COC_DATA_DIR=/data/coc \
COC_OPERATOR_PK=0x... \
  node --experimental-strip-types runtime/coc-reward-claim.ts --epoch 123 --node-id 0x...
```

对于 v2，该程序从运行时配置文件读取 `protocolVersion`、`poseManagerV2Address` 和 `rewardManifestDir`；对于 v1，则回退到 `poseManagerAddress` 并调用 `claimReward(nodeId)`。

### 运行时环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COC_NODE_URL` | `http://127.0.0.1:18780` | COC 节点 RPC |
| `COC_L1_RPC_URL` | `http://127.0.0.1:8545` | 结算层 RPC |
| `COC_POSE_MANAGER` | （必填） | PoSeManager v1 地址 |
| `COC_OPERATOR_PK` | （必填） | 运营者私钥 |
| `COC_OPERATOR_PK_FILE` | （无） | 运营者密钥文件路径 |
| `COC_SLASHER_PK` | （relayer 必填） | 惩罚者私钥 |
| `COC_SLASHER_PK_FILE` | （无） | 惩罚者密钥文件路径 |
| `COC_AGENT_INTERVAL_MS` | 60000 | Agent Tick 间隔 |
| `COC_AGENT_BATCH_SIZE` | 5 | 每批回执数 |
| `COC_AGENT_SAMPLE_SIZE` | 2 | 验证抽样大小 |
| `COC_RELAYER_INTERVAL_MS` | 60000 | Relayer Tick 间隔 |
| `COC_TX_RETRY_ATTEMPTS` | 2 | 交易重试次数 |
| `COC_TX_RETRY_BASE_DELAY_MS` | 250 | 基础重试延迟 |
| `COC_TX_RETRY_MAX_DELAY_MS` | 5000 | 最大重试延迟 |

### V2 协议配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `protocolVersion` | 1 | 设为 `2` 启用 v2 |
| `poseManagerV2Address` | （无） | PoSeManagerV2 合约地址 |
| `challengeBondWei` | `"100000000000000000"` | 0.1 ETH 保证金 |
| `rewardManifestDir` | `{dataDir}/reward-manifests` | 清单目录 |
| `epochNonceStrict` | false | 严格 Epoch Nonce 检查 |
| `insuranceFundAddress` | （无） | 保险基金地址 |

---

## 12. 监控

原理：可观测性应与共识路径隔离，监控系统的职责是帮助定位问题，而不是参与出块或结算正确性。
模块/程序功能：本章覆盖 Prometheus/Grafana 监控栈，以及在节点侧暴露 `/metrics` 和简单存活探针的 metrics server。

### Prometheus + Grafana 监控栈

```bash
docker compose -f docker/docker-compose.monitoring.yml up -d
```

| 服务 | 端口 | URL |
|------|------|-----|
| Prometheus | 9090 | http://localhost:9090 |
| Grafana | 3100 | http://localhost:3100 |

### Prometheus 指标端点

每个节点在 `http://<主机>:<COC_METRICS_PORT>/metrics`（默认 9100）暴露指标。

关键指标：
- `coc_block_height` — 当前区块高度
- `coc_tx_pool_size` — 内存池交易数
- `coc_peer_count` — P2P 连接节点数
- `coc_consensus_state` — 共识引擎状态
- `coc_bft_height` — BFT 已确认高度
- `coc_dht_peers` — DHT 路由表大小

### Grafana 仪表盘

| 仪表盘 | 说明 |
|--------|------|
| 总览 | 区块高度、TPS、节点数、内存池大小 |
| 共识 | BFT 轮次时序、最终性延迟、出块者轮转 |
| 网络 | P2P 连接数、Wire 协议统计、DHT 查询 |
| 资源 | CPU、内存、磁盘 I/O、LevelDB 压缩 |

### 告警规则

监控 Compose 会把 `ops/alerts/prometheus-rules.yml` 挂载为 Prometheus 的实际规则文件：

| 告警 | 条件 |
|------|------|
| NodeDown | `up{job="coc-node"} == 0` |
| BlockProductionStalled | `increase(coc_block_height[5m]) == 0` |
| ConsensusStateDegraded | `coc_consensus_state != 0` |
| HighAuthRejections | `rate(coc_p2p_auth_rejected_total[5m]) > 10` |
| NoWireConnections | `coc_wire_connections == 0 and coc_peers_connected > 0` |

运行 3 节点 Docker 测试网时，监控需要单独启动：

```bash
docker compose -f docker/docker-compose.testnet.yml up -d
docker compose -f docker/docker-compose.monitoring.yml up -d
```

监控栈会加入外部 `docker_coc-rpc` 网络，并抓取 `node-{1,2,3}:9100`。
| BFT 最终性延迟 | BFT 确认高度落后超过 10 个区块 |

---

## 13. 健康检查与状态查询

原理：COC 的健康状态是分层的；RPC、metrics 和 PoSe 服务端点回答的是不同问题，不能把它们当作同一种探针。
模块/程序功能：本章覆盖核心节点的运维脚本与 RPC 查询方式，并明确区分独立的 `runtime/coc-node.ts` PoSe 服务。

### 节点状态脚本

```bash
bash scripts/node-status.sh [rpc-url]
# 默认: http://127.0.0.1:18780
```

### RPC 健康查询方法

```bash
# 区块高度
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# 链统计
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_chainStats","params":[],"id":1}'

# BFT 状态
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_getBftStatus","params":[],"id":1}'

# 网络统计
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_getNetworkStats","params":[],"id":1}'

# Peer 数量
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}'
```

### 按组件区分的健康检查端点

```bash
# 核心节点 metrics server
curl -s http://127.0.0.1:9100/health
# 返回: ok

# PoSe 运行时服务（runtime/coc-node.ts）
curl -s http://127.0.0.1:19780/health
# 返回: {"ok":true,"ts":...}
```

链级健康状态应通过 `eth_blockNumber`、`coc_chainStats`、`coc_getNetworkStats` 等 JSON-RPC 方法判断；`/health` 只应视作具体 HTTP 服务的存活探针。

---

## 14. 备份与恢复

原理：可恢复性取决于“状态 + 身份”同时被保留；只备份数据库而不备份密钥或配置，无法安全恢复一个运营节点。
模块/程序功能：本章覆盖备份/恢复脚本，它们会归档节点状态、节点身份、节点缓存、奖励清单和本地证据文件。

### 备份

```bash
bash scripts/backup-node.sh [数据目录] [备份目录]
# 默认数据目录: ~/.clawdbot/coc
# 默认备份目录: ./backups/
```

备份内容：
- `leveldb/` — 链状态数据库
- `storage/` — IPFS 区块存储
- `node-config.json` — 配置文件
- `node-key` — 节点身份密钥
- `peers.json` — 节点缓存
- `reward-manifests/` — 奖励数据
- `evidence/` — 惩罚证据

### 恢复

```bash
bash scripts/restore-node.sh <备份归档文件> [数据目录]
```

**重要**：恢复前务必停止节点。恢复脚本会：
1. 验证备份完整性
2. 如果检测到节点进程仍在运行则直接拒绝继续
3. 用归档快照替换数据目录内容

它不会自动停止服务，也不会额外执行 LevelDB 修复流程。

### 手动备份

```bash
# 先停止节点
systemctl stop coc-node

# 归档数据目录
tar czf coc-backup-$(date +%Y%m%d).tar.gz -C ~/.clawdbot coc/

# 重启
systemctl start coc-node
```

---

## 15. 质量门禁

原理：运维变更应由受影响层级的测试来约束，因为 COC 横跨节点核心、服务层、运行时、合约、浏览器和扩展模块。
模块/程序功能：本章将质量门禁脚本映射到具体测试套件，便于运营者在全量验证和定向重跑之间做选择。

### 运行全量测试

```bash
bash scripts/quality-gate.sh
```

### 测试分层（1558 个测试，144 个文件）

| 层级 | 命令 | 测试数 |
|------|------|--------|
| 节点核心 | `cd node && node --experimental-strip-types --test $(find src -name '*.test.ts' -type f | sort)` | 859 |
| 运行时 | `node --experimental-strip-types --test $(find runtime/lib -name '*.test.ts' -type f | sort) $(find runtime -maxdepth 1 -name '*.test.ts' -type f | sort)` | 72 |
| 服务 + NodeOps | `node --experimental-strip-types --test $(find services -name '*.test.ts' -type f | sort) $(find nodeops -name '*.test.ts' -type f | sort)` | 164 |
| tests 工作区 | `node --experimental-strip-types --test $(find tests -name '*.test.ts' -type f | sort)` | 173 |
| 扩展 | `node --experimental-strip-types --test $(find extensions -name '*.test.ts' -type f | sort)` | 24 |
| 钱包 | `node --experimental-strip-types --test $(find wallet -maxdepth 1 -name '*.test.ts' -type f | sort)` | 8 |
| Explorer 库 | `node --experimental-default-type=module --experimental-strip-types --test $(find explorer/src/lib -name '*.test.ts' -type f | sort)` | 43 |
| Faucet | `node --experimental-strip-types --test $(find faucet/src -name '*.test.ts' -type f | sort)` | 26 |
| 合约部署 | `node --experimental-default-type=module --experimental-strip-types --test $(find contracts/deploy -name '*.test.ts' -type f | sort)` | 18 |
| 合约 | `cd contracts && npm test` | 171 |

### 运行特定测试层

```bash
# 仅节点核心
cd node && node --experimental-strip-types --test \
  $(find src -name '*.test.ts' -type f | sort)

# 合约测试（含覆盖率）
cd contracts && npm run coverage:check

# 仅运行时
node --experimental-strip-types --test \
  $(find runtime/lib -name '*.test.ts' -type f | sort) \
  $(find runtime -maxdepth 1 -name '*.test.ts' -type f | sort)

# 仅 tests 工作区
node --experimental-strip-types --test \
  $(find tests -name '*.test.ts' -type f | sort)
```

---

## 16. 故障排查

原理：故障排查应沿着系统边界展开：进程启动、RPC 表面、对等网络、存储层、PoSe 运行时，最后才是链上结算。
模块/程序功能：本章给出面向运维人员的诊断与恢复步骤，覆盖核心节点、运行时服务、浏览器以及外围基础设施。

### 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 启动报 `EADDRINUSE` | 端口被占用 | `ss -ltnp \| grep <端口>` 找到进程并终止或更换端口 |
| LevelDB `LOCK` 错误 | 上次实例未正常停止 | 删除 `{dataDir}/leveldb/LOCK` 或停止占用进程 |
| LevelDB 数据损坏 | 非正常关机 | 节点启动时自动修复；或删除 `leveldb/` 重新同步 |
| 不产生区块 | 单节点启用 BFT 但验证者 <3 | BFT 在 <3 验证者时自动禁用，检查验证者配置 |
| 节点无法连接 | 防火墙或 P2P 端口错误 | 检查 `COC_P2P_PORT`，确保端口开放，验证节点 URL |
| RPC 认证被拒 | Token 缺失或错误 | 设置 `COC_RPC_AUTH_TOKEN` 并传递 `Authorization: Bearer <token>` |
| 交易卡住 | Nonce 间隙或 Gas 过低 | 检查 `eth_getTransactionCount` 和 `eth_gasPrice`，用正确 Nonce 重新提交 |
| PoSe 挑战超时 | 节点不可达或存储响应慢 | 检查节点 `:9100/health` 存活探针并验证 `eth_blockNumber`，同时确认 IPFS 存储正常 |
| Agent 不提交批次 | 合约未部署或地址错误 | 验证 `COC_POSE_MANAGER` 地址与已部署合约匹配 |
| Relayer 终结失败 | Epoch 未就绪或 Gas 不足 | 检查 Epoch 时间；确保 Relayer 账户有 ETH 支付 Gas |
| 浏览器空白页 | RPC URL 错误 | 验证 `NEXT_PUBLIC_RPC_URL` 指向运行中的节点 |
| `--experimental-strip-types` 报错 | Node.js 版本 < 22 | 升级到 Node.js 22+ |
| Wire 握手超时 | 节点不可达或版本不匹配 | 检查 Wire 端口连通性；确认两端运行相同版本 |
| DHT 查找失败 | 无引导节点 | 确保配置了 `dnsSeeds` 或 `bootstrapPeers` |
| 快照同步卡住 | 节点高度差过大 | 增大 `snapSyncThreshold`；验证节点健康 |

### 诊断命令

```bash
# 检查监听端口
ss -ltnp | grep -E '(18780|18781|19780|19781|5001|9100)'

# 查看节点日志（systemd）
journalctl -u coc-node -f --no-pager

# 检查磁盘占用
du -sh ~/.clawdbot/coc/leveldb/

# 测试 RPC 连通性
curl -s -X POST http://127.0.0.1:18780 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' | jq .

# 查看进程资源占用
ps aux | grep 'node.*index.ts'

# 查看 Devnet 节点日志
tail -f /tmp/coc-devnet-*/node-*.log
```

### 恢复流程

**链卡住（无新区块）：**
1. 检查共识状态：`coc_chainStats` RPC
2. 验证验证者集：浏览器 `/validators` 页面
3. 若 BFT 卡住：重启节点清除 BFT 轮次状态
4. 若单节点：检查磁盘空间和 LevelDB 健康

**数据损坏：**
1. 停止节点
2. 备份当前 `leveldb/` 目录
3. 删除 `leveldb/` 并重启——节点将从节点同步
4. 或从备份恢复：`bash scripts/restore-node.sh <归档文件>`

**密钥泄露：**
1. 立即停止受影响节点
2. 生成新密钥：`bash scripts/generate-validator-keys.sh 1`
3. 通过治理合约停用旧验证者
4. 使用新密钥部署新节点
5. 审查惩罚证据确认是否有未授权操作

---

*为 COC (ChainOfClaw) 生成——最后更新 2026-03-09*
