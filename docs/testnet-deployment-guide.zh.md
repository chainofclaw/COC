# COC 测试网部署文档

## 1. 测试网概览

| 项目 | 值 |
|------|-----|
| Chain ID | 18780 (0x495c) |
| 服务器 | 199.192.16.79 (server1.clawchain.io) |
| 节点数 | 3 (BFT 验证者) |
| 共识 | BFT-lite (2/3 权重签名) |
| 出块时间 | ~3 秒 / 块 (~40 块/分钟) |
| 最终性深度 | 3 个区块 |
| 每块交易上限 | 100 |
| 存储后端 | LevelDB |

### 验证者列表

| 节点 | 地址 | 私钥 (Hardhat #0-2) |
|------|------|------|
| node-1 | `0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| node-2 | `0x70997970c51812dc3a010c7d01b50e0d17dc79c8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| node-3 | `0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |

> **注意**: 这些是 Hardhat 默认测试密钥，仅用于测试网。

### 预充值账户

| 地址 | 余额 |
|------|------|
| `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 10,000 ETH |
| `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | 10,000 ETH |

---

## 2. 端口映射

### RPC 端点 (对外)

| 节点 | JSON-RPC | WebSocket | P2P Gossip | Wire Protocol | Prometheus |
|------|----------|-----------|------------|---------------|------------|
| node-1 | :28780 | :28781 | :29780 | :29781 | :9101 |
| node-2 | :28782 | :28783 | :29782 | :29783 | :9102 |
| node-3 | :28784 | :28785 | :29784 | :29785 | :9103 |

### 快速访问

```bash
# 查询区块高度
curl -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
  http://199.192.16.79:28780/

# 查询链统计
curl -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_chainStats","id":1}' \
  http://199.192.16.79:28780/

# 查询 BFT 状态
curl -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_getBftStatus","id":1}' \
  http://199.192.16.79:28780/
```

---

## 3. 启用的功能

| 功能 | 状态 | 说明 |
|------|------|------|
| BFT 共识 | 启用 | 2/3 权重签名投票 |
| Wire Protocol | 启用 | TCP 二进制帧协议 (Magic 0xC0C1) |
| DHT 对等发现 | 启用 | Kademlia DHT 路由表 |
| SnapSync | 启用 | 快速状态同步 |
| Admin RPC | 启用 | 管理接口 |
| P2P 认证 | enforce | 入站连接需签名 |
| PoSe 认证 | enforce | 挑战/回执需签名 |

---

## 4. Docker 部署架构

### 容器组成

```
docker-compose.testnet.yml
├── coc-node-1   (验证者 #0)
├── coc-node-2   (验证者 #1)
├── coc-node-3   (验证者 #2)
├── coc-explorer  (区块链浏览器, :3000)
├── coc-faucet    (水龙头, :3003, 可选)
├── coc-agent     (PoSe Agent, 可选, profile=pose)
└── coc-relayer   (PoSe Relayer, 可选, profile=pose)
```

### 网络拓扑

```
coc-p2p (internal bridge)
  └── node-1 ↔ node-2 ↔ node-3

coc-rpc (external bridge)
  ├── node-1, node-2, node-3 (RPC 对外)
  ├── explorer → node-1
  ├── faucet → node-1
  └── agent/relayer → node-1, node-2, node-3
```

### 启动/停止

```bash
cd COC

# 启动测试网 (3 节点 + explorer)
docker compose -f docker/docker-compose.testnet.yml up -d

# 停止
docker compose -f docker/docker-compose.testnet.yml down

# 查看日志
docker logs coc-node-1 --tail 50
docker logs coc-node-2 --tail 50
docker logs coc-node-3 --tail 50

# 清除数据重建 (危险: 链数据会丢失)
docker compose -f docker/docker-compose.testnet.yml down
docker volume rm docker_node1-data docker_node2-data docker_node3-data
docker compose -f docker/docker-compose.testnet.yml build node-1
docker compose -f docker/docker-compose.testnet.yml up -d
```

---

## 5. RPC 接口参考

### 标准 Ethereum 方法

| 方法 | 说明 |
|------|------|
| `eth_blockNumber` | 当前区块高度 (hex) |
| `eth_getBlockByNumber` | 按高度查询区块 |
| `eth_getBlockByHash` | 按哈希查询区块 |
| `eth_getBalance` | 查询账户余额 |
| `eth_getTransactionByHash` | 查询交易 |
| `eth_getTransactionReceipt` | 查询交易回执 |
| `eth_syncing` | 同步状态 |
| `net_peerCount` | 已连接对等节点数 |

### COC 扩展方法

| 方法 | 说明 |
|------|------|
| `coc_chainStats` | 链统计 (区块数、TPS、验证者数) |
| `coc_getBftStatus` | BFT 共识轮次状态 |
| `coc_getEquivocations` | BFT 违规证据 |

---

## 6. OpenClaw 插件 — coc-nodeops

### 安装

coc-nodeops 作为 OpenClaw 扩展插件运行，提供 CLI 命令和 AI Agent 工具。

**安装方式 1: 本地路径安装**

编辑 `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "coc-nodeops": {
        "enabled": true,
        "config": {
          "runtimeDir": "/path/to/COC/runtime"
        }
      }
    },
    "installs": {
      "coc-nodeops": {
        "source": "path",
        "sourcePath": "/path/to/COC/extensions/coc-nodeops",
        "installPath": "~/.openclaw/extensions/coc-nodeops"
      }
    }
  }
}
```

然后同步文件:

```bash
rsync -av --exclude='node_modules' \
  /path/to/COC/extensions/coc-nodeops/ \
  ~/.openclaw/extensions/coc-nodeops/

cd ~/.openclaw/extensions/coc-nodeops && npm install
```

**安装方式 2: 手动拷贝**

```bash
cp -r COC/extensions/coc-nodeops ~/.openclaw/extensions/
cd ~/.openclaw/extensions/coc-nodeops && npm install
```

### 验证安装

```bash
# 在 OpenClaw 项目目录中
pnpm openclaw plugins list 2>&1 | grep coc
# 应显示: COC node ops extension loading...
#         COC extension loaded (10 agent tools registered)
```

### 10 个 Agent 工具

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `coc-node-init` | 初始化新节点 | `type` (dev/validator/fullnode/archive/gateway), `network` (local/testnet/custom) |
| `coc-node-list` | 列出所有节点 | 无 |
| `coc-node-start` | 启动节点 | `name` (可选, 不填则启动全部) |
| `coc-node-stop` | 停止节点 | `name` (可选) |
| `coc-node-restart` | 重启节点 | `name` (可选) |
| `coc-node-status` | 查询状态 | `name` (可选) — 返回 blockHeight/peerCount/bftActive |
| `coc-node-remove` | 删除节点 | `name`, `keepData` (boolean) |
| `coc-node-config` | 查看/修改配置 | `name`, `patch` (object, 可选) |
| `coc-node-logs` | 查看日志 | `name`, `service` (node/agent/relayer), `lines` |
| `coc-rpc-query` | RPC 链上查询 | `method`, `params`, `name` (可选) |

### RPC 查询白名单

`coc-rpc-query` 工具仅允许以下只读方法:

```
eth_blockNumber, eth_getBlockByNumber, eth_getBlockByHash,
net_peerCount, coc_chainStats, coc_getBftStatus,
eth_getBalance, eth_syncing, eth_getTransactionByHash,
eth_getTransactionReceipt
```

### Skill 使用

当 OpenClaw AI Agent 需要管理 COC 节点时，会自动激活 `coc-nodeops` skill。

典型对话示例:

```
用户: 帮我部署一个 COC 测试节点
Agent: [调用 coc-node-init, type=dev, network=local]
       [调用 coc-node-start]
       [调用 coc-node-status]
       节点已启动，区块高度 5，RPC 端口 18780

用户: 查看链的运行状态
Agent: [调用 coc-rpc-query, method=coc_chainStats]
       当前区块高度 120，每分钟 40 块，1 个验证者

用户: 连接到远程测试网
Agent: [调用 coc-node-init, type=fullnode, network=custom]
       [调用 coc-node-config, patch={peers, validators, ...}]
       [调用 coc-node-start]
       [调用 coc-node-status]
       已同步到测试网高度 7092，连接 3 个节点
```

---

## 7. 独立部署新节点

### 方式 A: Docker 单节点 (最简单)

```bash
git clone https://github.com/NGPlateform/COC.git
cd COC

# 构建并启动单节点 + 浏览器
docker compose -f docker/docker-compose.yml up -d

# 验证
curl -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
  http://localhost:18780/
```

端口: RPC :18780, WS :18781, P2P :19780, Wire :19781, IPFS :5001, Metrics :9100, Explorer :3000

### 方式 B: 原生运行 (开发模式)

**前提**: Node.js 22+

```bash
git clone https://github.com/NGPlateform/COC.git
cd COC && npm install

# 直接运行 (自动生成密钥和创世区块)
node --experimental-strip-types node/src/index.ts
```

默认绑定 127.0.0.1:18780，单验证者模式。

### 方式 C: 通过 OpenClaw 部署 (推荐)

确保 coc-nodeops 插件已安装 (见第 6 节)。

```bash
# 初始化本地开发节点
openclaw coc init --type dev --network local --name my-node

# 启动
openclaw coc start my-node

# 查看状态
openclaw coc status my-node

# 查看日志
openclaw coc logs my-node
```

### 方式 D: 加入现有测试网 (观察者节点)

以下步骤部署一个 fullnode 观察者，通过 SnapSync 自动同步区块:

**步骤 1**: 初始化

```bash
openclaw coc init --type fullnode --network custom --name testnet-obs --rpc-port 18790
```

**步骤 2**: 配置连接测试网

编辑 `~/.clawdbot/coc/nodes/testnet-obs/node-config.json`:

```json
{
  "chainId": 18780,
  "validators": [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"
  ],
  "peers": [
    { "id": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "url": "http://199.192.16.79:29780" },
    { "id": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "url": "http://199.192.16.79:29782" },
    { "id": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "url": "http://199.192.16.79:29784" }
  ],
  "dhtBootstrapPeers": [
    { "id": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "address": "199.192.16.79", "port": 29781 },
    { "id": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "address": "199.192.16.79", "port": 29783 },
    { "id": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "address": "199.192.16.79", "port": 29785 }
  ],
  "enableWireProtocol": true,
  "enableDht": true,
  "enableSnapSync": true,
  "enableBft": false,
  "rpcPort": 18790,
  "rpcBind": "127.0.0.1",
  "wsPort": 18791,
  "p2pPort": 19790,
  "p2pBind": "0.0.0.0",
  "wirePort": 19791,
  "wireBind": "0.0.0.0",
  "blockTimeMs": 3000,
  "p2pInboundAuthMode": "off"
}
```

**步骤 3**: 启动并验证

```bash
openclaw coc start testnet-obs

# 等待 ~15 秒完成 SnapSync
openclaw coc status testnet-obs
# 应显示: blockHeight=XXXX, peerCount=3
```

或通过 RPC 直接验证:

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"coc_chainStats","id":1}' \
  http://127.0.0.1:18790/
```

### 方式 E: Docker 加入测试网

```bash
cd COC

# 创建观察者配置
mkdir -p /tmp/coc-observer
cat > /tmp/coc-observer/node-config.json << 'EOF'
{
  "chainId": 18780,
  "validators": [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"
  ],
  "peers": [
    { "id": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "url": "http://199.192.16.79:29780" },
    { "id": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "url": "http://199.192.16.79:29782" },
    { "id": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "url": "http://199.192.16.79:29784" }
  ],
  "dhtBootstrapPeers": [
    { "id": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "address": "199.192.16.79", "port": 29781 },
    { "id": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", "address": "199.192.16.79", "port": 29783 },
    { "id": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", "address": "199.192.16.79", "port": 29785 }
  ],
  "enableWireProtocol": true,
  "enableDht": true,
  "enableSnapSync": true,
  "enableBft": false,
  "p2pBind": "0.0.0.0",
  "p2pPort": 19780,
  "wireBind": "0.0.0.0",
  "wirePort": 19781,
  "rpcBind": "0.0.0.0",
  "rpcPort": 18780,
  "blockTimeMs": 3000,
  "p2pInboundAuthMode": "off"
}
EOF

# 运行 Docker 观察者
docker run -d --name coc-observer \
  -p 18790:18780 -p 18791:18781 \
  -v /tmp/coc-observer:/data/coc \
  -e COC_DATA_DIR=/data/coc \
  -e COC_NODE_CONFIG=/data/coc/node-config.json \
  ghcr.io/chainofclaw/coc-node:latest

# 验证同步
sleep 15
curl -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
  http://localhost:18790/
```

---

## 8. 故障排查

### 常见问题

| 症状 | 原因 | 解决方案 |
|------|------|----------|
| `invalid cumulativeWeight: expected 2, got 1` | 创世区块缺少 cumulativeWeight | 升级到最新代码，清除数据重启 |
| `verifyBlockChain failed: invalid snapshot cumulative weight` | SnapSync 类型不一致 (string vs BigInt) | 升级到最新代码 (hasValidSnapshotWeight fix) |
| `hexToBytes: invalid hex characters` | nodeId 不是有效的 hex 地址 | 确保 nodeId 为从私钥派生的 Ethereum 地址 |
| 节点卡在高度 1 不出块 | 创世区块 hash 不一致 | 确保所有节点使用相同的 validators 列表和 chainId |
| SnapSync 反复失败 | peer 连接不稳定 | 检查防火墙, 确认 Wire 端口可达 |
| `ENOENT: coc-node.ts` | 进程管理器脚本路径错误 | 升级 coc-nodeops 到 v0.2.0+ |

### 诊断命令

```bash
# 查看节点健康状态
curl -sf http://localhost:18780/ -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'

# 检查 peer 连通性
curl -sf http://localhost:18780/ -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"net_peerCount","id":1}'

# 查看容器日志
docker logs coc-node-1 --tail 50 2>&1 | grep -E '"level":"(error|warn)"'

# 通过 OpenClaw
openclaw coc status
openclaw coc logs <node-name> --service node
```
