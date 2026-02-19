# Prowl 测试网 - 验证者加入指南

## 系统要求

| 资源 | 最低配置 | 推荐配置 |
|------|---------|---------|
| CPU | 2 核 | 4 核 |
| RAM | 4 GB | 8 GB |
| 磁盘 | 50 GB SSD | 100 GB NVMe |
| 网络 | 10 Mbps | 50 Mbps |
| 操作系统 | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 |

## 前置条件

- Node.js 22+（执行 `node --version` 应显示 v22.x 或更高）
- Git
- curl

## 第一步：克隆仓库

```bash
git clone https://github.com/chainofclaw/coc.git
cd coc
```

## 第二步：安装依赖

```bash
cd node && npm install && cd ..
```

## 第三步：生成节点密钥

```bash
node --experimental-strip-types -e "
import { Wallet } from 'ethers';
const w = Wallet.createRandom();
console.log('私钥: ' + w.privateKey);
console.log('地址: ' + w.address);
"
```

妥善保管私钥，仅将**地址**分享给测试网协调人。

## 第四步：配置节点

创建 `/etc/coc/node-config.json`（也可通过 `COC_NODE_CONFIG` 环境变量指定路径）：

```json
{
  "nodeId": "你的地址",
  "chainId": 18780,
  "rpcBind": "0.0.0.0",
  "rpcPort": 18780,
  "p2pBind": "0.0.0.0",
  "p2pPort": 19780,
  "wsPort": 18781,
  "wirePort": 19781,
  "validators": ["从创世配置获取的验证者列表"],
  "peers": [
    {"id": "种子节点ID", "url": "http://种子节点IP:19780"}
  ],
  "enableBft": true,
  "enableWireProtocol": true,
  "enableDht": true,
  "enableSnapSync": true,
  "blockTimeMs": 3000,
  "finalityDepth": 3,
  "maxTxPerBlock": 100,
  "prefund": [],
  "dhtBootstrapPeers": [
    {"id": "种子节点ID", "address": "种子节点IP", "port": 19781}
  ]
}
```

## 第五步：启动节点

### 方式 A：直接运行

```bash
export COC_NODE_KEY="0x你的私钥"
export COC_DATA_DIR=/var/lib/coc
export COC_NODE_CONFIG=/etc/coc/node-config.json
node --experimental-strip-types node/src/index.ts
```

### 方式 B：Docker（推荐新手使用）

```bash
docker run -d \
  --name coc-node \
  -p 18780:18780 -p 18781:18781 -p 19780:19780 -p 19781:19781 -p 9100:9100 \
  -v /var/lib/coc:/data/coc \
  -v /etc/coc/node-config.json:/data/coc/node-config.json:ro \
  -e COC_NODE_KEY="0x你的私钥" \
  ghcr.io/chainofclaw/coc-node:latest
```

### 方式 C：systemd 服务

```bash
sudo cp docker/systemd/coc-node.service /etc/systemd/system/
# 编辑服务文件，设置 COC_NODE_KEY
sudo systemctl daemon-reload
sudo systemctl enable --now coc-node
```

## 第六步：验证同步状态

```bash
# 检查区块高度
bash scripts/node-status.sh http://localhost:18780

# 检查健康状态
curl http://localhost:18780/health

# 检查 Prometheus 指标
curl http://localhost:9100/metrics | grep coc_block_height
```

当节点区块高度与其他节点一致时，表示同步完成。

## 第七步：注册为验证者

同步完成后，联系测试网协调人通过治理提案将你添加到验证者集合。

## 第八步：设置监控（可选）

```bash
docker compose -f docker/docker-compose.monitoring.yml up -d
# Grafana: http://localhost:3100 (admin/cocprowl)
```

## 防火墙规则

为入站流量开放以下端口：

| 端口 | 协议 | 用途 |
|------|------|------|
| 19780 | TCP | P2P 广播 |
| 19781 | TCP | Wire 协议 |

可选（如需公开访问）：

| 端口 | 协议 | 用途 |
|------|------|------|
| 18780 | TCP | JSON-RPC |
| 18781 | TCP | WebSocket RPC |

## 网络信息

| 项目 | 值 |
|------|------|
| Chain ID | 18780 |
| RPC 端点 | http://prowl-rpc.chainofclaw.com:18780 |
| WebSocket | ws://prowl-rpc.chainofclaw.com:18781 |
| 区块浏览器 | https://explorer.chainofclaw.com |
| 水龙头 | https://faucet.chainofclaw.com |

## 常见问题 (FAQ)

### 1. 节点无法同步
- 确认对等节点可达：`curl http://PEER_IP:19780/p2p/info`
- 检查防火墙是否允许 P2P 端口
- 确保 `validators` 列表与创世配置一致

### 2. 内存占用过高
- 可调整 LevelDB 缓存：在配置中设置 `storage.cacheSize`
- 监控：`curl http://localhost:9100/metrics | grep coc_process_memory`

### 3. 共识卡住
- 检查：`curl http://localhost:9100/metrics | grep coc_consensus_state`
- 0=健康, 1=降级, 2=恢复中
- 若降级超过 10 分钟，尝试重启节点

### 4. 如何获取测试币？
- 访问水龙头页面：https://faucet.chainofclaw.com
- 输入你的钱包地址，每次可获取 10 COC
- 每个地址每日限领一次

### 5. Docker 容器启动失败
- 确认 Docker 版本 ≥ 24.0
- 检查端口是否被占用：`ss -ltnp | grep 18780`
- 查看日志：`docker logs coc-node`

### 6. 连接不上种子节点
- 确认网络连通性：`telnet SEED_IP 19780`
- 检查 DNS 解析是否正常
- 尝试使用 IP 地址替代域名

### 7. 节点如何升级？
```bash
# Docker 方式
docker pull ghcr.io/chainofclaw/coc-node:latest
docker stop coc-node && docker rm coc-node
# 重新执行 docker run 命令

# 直接运行方式
cd coc && git pull && cd node && npm install && cd ..
# 重启节点
```

### 8. 如何检查节点是否作为验证者正常工作？
```bash
curl -s http://localhost:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"coc_validators","params":[],"id":1}' | \
  python3 -m json.tool
```

### 9. 如何参与治理投票？
使用投票脚本：
```bash
node --experimental-strip-types scripts/vote-proposal.ts \
  --proposal-id <提案ID> --voter <你的验证者ID> --approve
```

### 10. 数据存储在哪里？
- 直接运行：`$COC_DATA_DIR`（默认 `/var/lib/coc`）
- Docker：容器内 `/data/coc`，映射到宿主机 `/var/lib/coc`
- 数据包括区块、状态、对等节点信息
