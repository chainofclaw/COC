# COC 测试网当前状态文档（2026-04-24）

> 本文档记录 COC 测试网在 **2026-04-24** Phase C Step 2 完整上线后的配置状态。
> 英文版：`testnet-status-2026-04-24.en.md`。

## 1. 版本状态摘要

| 项目 | 状态 |
|---|---|
| 测试网是否运行最新版本 | **✅ 是**。所有 validator / agent / relayer / prover 均在 `coc-runtime:phase-c-step2` 或 `coc-node:phase-c-step1` 镜像上运行 |
| Phase 进度 | Phase C **Step 2 完整上线**，PoSe v2 全链路端到端验证通过 |
| 当前 git commit | `e9207ab` (feat(coc-node): v2 EIP-712 signing for Storage + Relay receipts) |
| 分支 | `fix/phase-c-p2p-storage` |
| 里程碑 tag | `phase-c-step2-batchv2-success-2026-04-24` |
| 链高度 (2026-04-24 验证时) | 12 247，三个 validator 同步 |
| BFT quorum 状态 | ✅ 健康，全部 3 个 validator 同高度 |
| PoSe v2 on-chain batchV2 | ✅ 已成功提交（tx `0xebe72a05...d15`，status=1，gasUsed=319 344） |

## 2. 基础设施

### 2.1 服务器

| 项目 | 值 |
|---|---|
| Hostname | `server1.clawchain.io` |
| Public IP | `199.192.16.79` |
| OS | Debian 12 (cloud) |
| 磁盘 | 237 G 总，约 199 G 可用 |
| SSH 配置 alias | `coc-testnet` |
| 源码路径 | `/root/clawd/COC` |

### 2.2 运行中的容器

12 个容器，按角色分组：

```
┌─ 共识层 (BFT validators) ──────────────────────────────────────────┐
│  coc-node-1    coc-node:phase-c-step1    (healthy, ~1h uptime)   │
│  coc-node-2    coc-node:phase-c-step1    (healthy)                │
│  coc-node-3    coc-node:phase-c-step1    (healthy)                │
└────────────────────────────────────────────────────────────────────┘

┌─ 只读观察 (sync-node) ─────────────────────────────────────────────┐
│  coc-sync-node    coc-node:fix-speculative-disable (旧版)         │
│    ⚠ 仍在 Phase B 镜像上运行。作为只读观察节点不影响 BFT，        │
│      建议下次维护时同步到 phase-c-step1                            │
└────────────────────────────────────────────────────────────────────┘

┌─ PoSe v2 证明层 ───────────────────────────────────────────────────┐
│  coc-prover-1    coc-runtime:phase-c-step2 (serving :19901)      │
│  coc-prover-2    coc-runtime:phase-c-step2 (serving :19902)      │
│  coc-prover-3    coc-runtime:phase-c-step2 (serving :19903)      │
│    每个 prover 共享对应 validator 的 blockstore                   │
│    （docker volume node{N}-data read-write）                      │
└────────────────────────────────────────────────────────────────────┘

┌─ PoSe v2 协调层 ───────────────────────────────────────────────────┐
│  coc-agent       coc-runtime:phase-c-step2                        │
│    challenger + aggregator；30s tick；执行完整 challenge→receipt→  │
│    verify→batch→submitBatchV2 流水线                             │
│  coc-relayer     coc-runtime:phase-c-step2                        │
│    epoch 边界触发、reward 分发、slash 触发                         │
└────────────────────────────────────────────────────────────────────┘

┌─ 周边服务 ─────────────────────────────────────────────────────────┐
│  coc-explorer    ghcr.io/chainofclaw/coc-explorer:latest          │
│    Next.js 区块浏览器 (127.0.0.1:3000)                           │
│  coc-faucet      ghcr.io/chainofclaw/coc-faucet:latest            │
│    水龙头 (0.0.0.0:3003)                                         │
│  openclaw-1      ghcr.io/openclaw/openclaw:latest                 │
│    OpenClaw agent runtime (独立于 COC)                            │
└────────────────────────────────────────────────────────────────────┘
```

## 3. 网络端口映射

### 3.1 外部可访问（绑 `0.0.0.0`）

| 服务 | 端口 (host) | 端口 (container) | 用途 |
|---|---|---|---|
| node-1 RPC | `28780` | 18780 | JSON-RPC (主要入口) |
| node-1 WS | `28781` | 18781 | WebSocket RPC / eth_subscribe |
| node-1 P2P | `29780` | 19780 | HTTP gossip (peer discovery) |
| node-1 Wire | `29781` | 19781 | 二进制 wire 协议 (FindNode / BlockRequest) |
| node-2 RPC | `28782` | — | 同 node-1 |
| node-2 WS | `28783` | — | |
| node-2 P2P | `29782` | — | |
| node-2 Wire | `29783` | — | |
| node-3 RPC | `28784` | — | |
| node-3 WS | `28785` | — | |
| node-3 P2P | `29784` | — | |
| node-3 Wire | `29785` | — | |
| **node-1 IPFS HTTP** | **`28786`** | **5001** | **2026-04-25 新增**：UnixFS `/api/v0/add`、`/api/v0/cat`、`/ipfs/<cid>` gateway，便于外部测试。⚠️ **无 auth、无 rate limit**，仅测试网用 |
| sync-node RPC | `18780` | — | 只读聚合查询入口（官方 RPC） |
| sync-node WS | `18781` | — | |
| Explorer | `3000` | 3000 | Next.js dev server（仅 127.0.0.1） |
| Faucet | `3003` | 3003 | 水龙头 UI + API |
| Prometheus metrics | `9101-9104` | 9100 | 各 node 的 Prometheus endpoint |

### 3.2 仅容器间可访问（docker network `coc-rpc`）

| 服务 | 容器内地址 | 用途 |
|---|---|---|
| prover-1/2/3 | `prover-N:18800` | PoSe challenge/receipt 处理 |
| agent metrics | `agent:9200` | 运行时内部指标 |
| node-2/3 IPFS | `node-N:5001` | IPFS HTTP API；只在容器内可见。node-1 已通过 host port 28786 对外开放 |

✅ **2026-04-25 起 node-1 IPFS HTTP 已公开**于 `http://199.192.16.79:28786`。可以直接外部 PUT/GET 测试：
```bash
# 上传
curl -X POST http://199.192.16.79:28786/api/v0/add -F file=@somefile.bin

# 取回
curl http://199.192.16.79:28786/api/v0/cat?arg=<CID>
```
⚠️ **node-2/3 仍只在容器内 5001**，外部不能直连。Node-1 是当前唯一公开的 IPFS 入口；上传后会自动通过 push-to-K + DHT gossip 复制到其他两个节点。

## 4. 链参数

| 参数 | 值 |
|---|---|
| chainId | **18780** |
| block time | 3 000 ms |
| finality depth | 3 blocks |
| max TX per block | 100 |
| BFT prepare/commit timeout | 5 000 ms / 5 000 ms |
| PoSe epoch | 3 600 s (1 hour) |
| Validator 数量 | 3 |
| Consensus | BFT-lite (≥2/3 stake quorum) |

### 4.1 Validator 列表

| Node | Validator 地址 | 私钥来源 | PoSe NodeID (= keccak256(pubkey)) | 余额 |
|---|---|---|---|---|
| node-1 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | Hardhat acct #0 | `0x7b8c787b0e5055300f13733856377c0b855c204ae32ed48dffddc1e059076f04` | 9 980.89 ETH |
| node-2 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | Hardhat acct #1 | `0xb8fdf03c6b15dfd781c47a20474745a4ee69d8e1ef92aa886cb57e7ed0906d88` | 1.98 ETH |
| node-3 | `0x3c44CdDdB6a900fa2b585dd299e03d12FA4293BC` | Hardhat acct #2 | `0x86fc22d816900e3d25ac919122d6e59e1289bb0e199d8742b662266364a94c3d` | 1.98 ETH |

### 4.2 PoSe Operator（challenger + agent key）

| 项目 | 值 |
|---|---|
| 地址 | `0x0fC876c0b47575cFa81de526C1ac0E7b5b6b427a` |
| 余额 | 9.99 ETH（足够 operator bond + 若干天 gas） |
| 作用 | agent / relayer 发交易的签名账户；注册为一个独立的 PoSe challenger node |

## 5. 链上合约（PoSe v2 + 治理）

**部署者**：`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`（node-1 的 key）
**部署时间**：2026-04-24 08:04 UTC

| 合约 | 地址 | 字节数 | 初始化状态 |
|---|---|---|---|
| `PoSeManagerV2` | `0xCD8a1C3ba11CF5ECfa6267617243239504a98d90` | 36 514 | **✅ 已初始化** (chainId=18780, verifyingContract=self, challengeBondMin=0.02 ETH) |
| `CidRegistry` | `0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575` | 4 186 | 不需初始化；当前 3 个 CID 已注册 |
| `SoulRegistry` | `0x1291Be112d480055DaFd8a610b7d1e203891C274` | 30 228 | 部署就绪 |
| `DIDRegistry` | `0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154` | 21 164 | 部署就绪 |

### 5.1 PoSeManagerV2 域参数

```
DOMAIN_SEPARATOR = 0x210c4104e22518643cd21d46997d1921ad8ecd0475c5df0fda8e3a975a6af1e1
domain.name      = "COCPoSe"
domain.version   = "2"
chainId          = 18780
verifyingContract = 0xCD8a1C3ba11CF5ECfa6267617243239504a98d90
challengeBondMin  = 0.02 ETH
```

⚠️ **部署踩坑提示（2026-04-24 踩过）**：
合约构造函数不取参数，但 `DOMAIN_SEPARATOR` 在 `initialize(chainId, verifyingContract, challengeBondMin)` 中才设置。Hardhat 部署脚本若不调 `initialize`，合约会处于半初始化状态（`DOMAIN_SEPARATOR=0x0000...`），所有 witness-quorum 签名都会因为 EIP-712 域不匹配而 revert，表现为 `submitBatchV2` 全部失败。**部署后必须调一次** `initialize`。

### 5.2 已注册 PoSe v2 节点

| NodeID | Operator (registerNode 发起者) |
|---|---|
| `0xd306e71dc0a8554f...225f1d52` | `0x0fC876c0...6b427a`（agent 自注册） |
| `0x7b8c787b0e505530...059076f04` | `0xf39Fd6e5...92266`（node-1） |
| `0xb8fdf03c6b15dfd7...0906d88` | `0x70997970...79C8`（node-2） |
| `0x86fc22d816900e3d...64a94c3d` | `0x3c44CdDd...4293BC`（node-3） |

### 5.3 已注册 CID（CidRegistry）

CID 数量：**3**。包括 Phase C 验证中上传的测试文件（bafybe... 开头的 IPFS CIDv1）。

## 6. Docker 镜像版本

| 镜像 | Tag | ImageID | 用途 |
|---|---|---|---|
| `coc-node` | `phase-c-step1` | `73edf1d790cb` | chain 引擎 (validator + sync-node) |
| `coc-runtime` | `phase-c-step2` | `fb7901d588a1` | agent / relayer / prover sidecar |
| `coc-node` | `ghcr.io/chainofclaw/coc-node:latest` | 同上 | 为兼容 compose 默认值别名 |
| `coc-runtime` | `ghcr.io/chainofclaw/coc-runtime:latest` | 同上 | 同上 |

Rollback 回退镜像（Phase B 最后稳定版）：
- `coc-node:fix-speculative-disable` (`4b432901742c`) — 当前 sync-node 仍在用

## 7. 配置文件

### 7.1 Validator 配置（`docker/testnet-configs/node-{1,2,3}.json`）

关键字段（三个节点仅 `nodeId` 和 `peers` 不同）：
```json
{
  "nodeId": "<validator 地址>",
  "chainId": 18780,
  "rpcBind": "0.0.0.0",
  "rpcPort": 18780,
  "p2pBind": "0.0.0.0",
  "p2pPort": 19780,
  "wsBind": "0.0.0.0",
  "wsPort": 18781,
  "ipfsBind": "0.0.0.0",
  "wireBind": "0.0.0.0",
  "wirePort": 19781,
  "validators": [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"
  ],
  "peers": [ /* 其它两个 validator 的 P2P URL */ ],
  "dhtBootstrapPeers": [ /* 其它两个 validator 的 wire 端口 */ ],
  "enableBft": true,
  "enableWireProtocol": true,
  "enableDht": true,
  "enableSnapSync": true,
  "blockTimeMs": 3000,
  "finalityDepth": 3,
  "maxTxPerBlock": 100
}
```

### 7.2 Agent 配置（`docker/testnet-runtime-configs/agent.json`）

```json
{
  "dataDir": "/data/coc/runtime",
  "storageDir": "/shared-blockstore/storage",
  "nodeUrl": "http://node-1:18780",
  "l1RpcUrl": "http://node-1:18780",
  "l2RpcUrl": "http://node-1:18780",
  "chainId": 18780,
  "protocolVersion": 2,
  "poseManagerAddress": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "poseManagerV2Address": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "verifyingContract": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "cidRegistryAddress": "0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575",
  "poseStorageFromBlockstore": true,
  "nodeEndpoints": {
    "0x7b8c787b...076f04": "http://prover-1:18800",
    "0xb8fdf03c...906d88": "http://prover-2:18800",
    "0x86fc22d8...a94c3d": "http://prover-3:18800"
  },
  "agentIntervalMs": 30000,
  "agentBatchSize": 5,
  "agentSampleSize": 2,
  "agentMetricsPort": 9200
}
```

**环境变量**：
- `COC_OPERATOR_PK = 0x8b3a350cf5c34c9194ca3a545d6546d9f8b66d0f6937f33ce3cbb7a7e3c7eca0` (operator 私钥)

### 7.3 Prover 配置（`docker/testnet-runtime-configs/provers/node-{1,2,3}.json`）

三个 prover 仅私钥不同：
```json
{
  "dataDir": "/data/coc",
  "storageDir": "/data/coc/storage",
  "nodeBind": "0.0.0.0",
  "nodePort": 18800,
  "chainId": 18780,
  "protocolVersion": 2,
  "poseManagerV2Address": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "verifyingContract": "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90",
  "poseStorageFromBlockstore": true
}
```

**环境变量 per prover**：
- `COC_CONFIG = /app/config.json`
- `COC_NODE_PK = <validator 私钥>`（每个 prover 持对应 validator 的 key）
- `COC_RPC_URL = http://node-N:18780`（关键：prover 需要通过 validator RPC 查 block tip）

**Volume mount**：
- `docker_node{N}-data:/data/coc`（read-write，共享验证人的 blockstore）

### 7.4 Relayer 配置

同 agent 的 chainId / poseManagerV2Address / verifyingContract。
- `COC_SLASHER_PK = 0xdbda1821b80551c171720b42e0ca60ef6d611f8c6e3853e54af5d3f8ef500c4c`

## 8. Docker Volume

| Volume | 大小 | 用途 |
|---|---|---|
| `docker_node1-data` | 21 MB | node-1 chain state + IPFS blockstore |
| `docker_node2-data` | 13 MB | node-2 |
| `docker_node3-data` | 13 MB | node-3 |
| `docker_sync-data` | 4 MB | sync-node snapshot |
| `docker_runtime-data` | 8 KB | agent / relayer 状态 (pending receipts, nonce log) |

## 9. 备份 & 回滚

### 9.1 已建立的备份

`/root/phase-c-rollback.20260424-094001/`
```
-rw-r--r-- 3.3M node1-data.tar.gz
-rw-r--r-- 3.3M node2-data.tar.gz
-rw-r--r-- 3.3M node3-data.tar.gz
```
节点 state snapshot，Phase C 上线前打的快照。

`/root/clawd/COC.phase-b-stable.20260424-094001/`
完整的 Phase B 源码树备份。

`/root/clawd/COC/docker/docker-compose.testnet.yml.pre-phase-c.20260424-094001`
`/root/clawd/COC/docker/testnet-configs.pre-phase-c.20260424-094001/`
Phase C 上线前的 compose + config 副本。

### 9.2 回滚操作

如果 Phase C 在后续 soak 期间发现严重问题，回退到 Phase B：

```bash
# 1. 停服务
cd /root/clawd/COC/docker && docker compose -f docker-compose.testnet.yml down agent relayer

# 2. 恢复 Phase B 镜像（仍在 local registry）
sed -i "s|coc-node:phase-c-step1|coc-node:fix-speculative-disable|" docker-compose.testnet.yml

# 3. 可选：恢复 volume 数据
for n in 1 2 3; do
  docker run --rm -v docker_node${n}-data:/data -v /root/phase-c-rollback.20260424-094001:/b alpine sh -c "rm -rf /data/* && tar xzf /b/node${n}-data.tar.gz -C /data"
done

# 4. 重启
docker compose -f docker-compose.testnet.yml up -d node-1 node-2 node-3
```

Git 端回滚：
```bash
cd /root/clawd/COC
git checkout phase-b-stable-2026-04-24
# 然后重建镜像
docker build -f docker/Dockerfile.node -t coc-node:rollback .
```

### 9.3 关键 Git Tags（all pushed to `origin/NGPlateform/COC`）

| Tag | 意义 |
|---|---|
| `phase-b-stable-2026-04-24` | **回滚基准** - Phase C 前最后稳定版 |
| `phase-c-candidate-2026-04-24` | Phase C PR 首版 |
| `phase-c-testnet-verified-2026-04-24` | 存储分发跑通 |
| `phase-c-gossip-verified-2026-04-24` | 跨节点 DHT gossip 跑通 |
| `phase-c-step2-bootstrapped-2026-04-24` | PoSe v2 基础设施就位 |
| `phase-c-step2-provers-2026-04-24` | 3 个 prover sidecar 部署 |
| `phase-c-step2-verified-2026-04-24` | 完整 challenge→verify 链路通 |
| **`phase-c-step2-batchv2-success-2026-04-24`** | **当前** - batchV2 链上 status=1 |

## 10. 如何访问 / 常用运维命令

### 10.1 从本地 SSH 到测试网

```bash
ssh coc-testnet   # alias 走 ~/.ssh/config
```

### 10.2 查链高度

```bash
for n in 1 2 3; do
  port=$((28780 + (n-1)*2))
  bn=$(curl -s -X POST "http://199.192.16.79:$port" -H content-type:application/json \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
    | python3 -c "import sys,json; print(int(json.load(sys.stdin)['result'],16))")
  echo "node-$n: $bn"
done
```

### 10.3 查 PoSe v2 状态

```bash
ssh coc-testnet 'cd /root/clawd/COC/contracts && node --experimental-strip-types --input-type=module <<JS
import { JsonRpcProvider, Contract } from "ethers"
const p = new JsonRpcProvider("http://127.0.0.1:28780")
const c = new Contract("0xCD8a1C3ba11CF5ECfa6267617243239504a98d90", [
  "function getActiveNodeCount() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
], p)
console.log("active nodes:", (await c.getActiveNodeCount()).toString())
console.log("domain_separator:", await c.DOMAIN_SEPARATOR())
JS'
```

### 10.4 常用日志查看

```bash
ssh coc-testnet 'docker logs --tail 50 coc-agent 2>&1 | grep -iE "batchV2|tick ok|verify"'
ssh coc-testnet 'docker logs --tail 50 coc-relayer'
ssh coc-testnet 'docker logs --tail 50 coc-prover-1'
```

### 10.5 PUT/GET 测试文件到 IPFS

**外部直连（推荐，2026-04-25 后可用）**：
```bash
# 上传
head -c 4096 /dev/urandom > /tmp/t.bin
curl -sf -X POST http://199.192.16.79:28786/api/v0/add -F file=@/tmp/t.bin
# → {"Name":"t.bin","Hash":"bafybe...","Size":"4096"}

# 取回（注意 50 MiB readFile 上限）
curl -sf "http://199.192.16.79:28786/api/v0/cat?arg=<CID>" -o out.bin
```

**容器内（沿用旧路径，node-2/3 也用此）**：
```bash
ssh coc-testnet 'docker exec coc-node-1 sh -c "head -c 4096 /dev/urandom > /tmp/t.bin && curl -sf -X POST http://localhost:5001/api/v0/add -F file=@/tmp/t.bin"'
```

### 10.6 Explorer / Faucet URL

- Explorer（本机 HTTP）: `http://199.192.16.79:3000`（如果反向代理开放）或者 `ssh -L 3000:127.0.0.1:3000 coc-testnet` 本地转发
- Faucet: `http://199.192.16.79:3003`

## 11. 已知遗留问题 & 下一步

### 11.1 Phase C 遗留（均属于下一阶段工作）

| 问题 | 影响 | 优先级 |
|---|---|---|
| `coc-sync-node` 仍在 Phase B 镜像上 | 无功能影响；只读节点不产块 | 低 |
| Storage challenge 在 `pickRandomChallengeTarget` 阶段 skip | agent 无法从共享 blockstore 解析 Merkle meta（路径约定不匹配），Uptime/Relay 已跑通 | 中 |
| HTTP `/api/v0/add` 不自动调 `CidRegistry.register()` | 必须手动注册 CID 到合约后 challenger 才能挑战它 | 中 |
| `reward manifest write failed (EACCES)` | agent 容器内 `/data/coc/runtime/reward-manifests` 目录 permission | 低，仅影响本地备份 |
| Relayer reward claim 未 end-to-end 验证 | batchV2 已成功上链；但 `claimRewards` 流水线还未跑过完整周期 | 中 |

### 11.2 下阶段建议

1. **把 Storage challenge 打通**：agent 的 resolveMeta 需要改成通过 prover 的 `/pose/storage-meta` RPC 查（不再靠共享 blockstore）
2. **CidRegistry 自动注册 hook**：在 `ipfs-http.ts` 的 `handleAdd` 里加一步 chain tx（可配置开关）
3. **Soak 监控**：24h 观察 `batchV2` 节拍、`pendingV2` 队列长度、`storageGb` 累加
4. **重新部署脚本 fix**：`contracts/deploy/deploy-pose.ts` 加 `initialize()` 调用作为 post-deploy step

## 12. 文档变更记录

| 时间 | 版本 | 变更 |
|---|---|---|
| 2026-04-24 | 1.0 | 初版：Phase C Step 2 完整上线后的测试网配置快照 |
| 2026-04-25 | 1.1 | node-1 IPFS HTTP 端口对外开放（host port `28786` → 容器 `5001`），便于外部测试 PUT/GET。compose 备份 `docker-compose.testnet.yml.bak.20260425-010705`。Node-2/3 仍只在容器内 5001。 |

---

**备注**：本文档对应的运行状态快照是 **2026-04-24 12:30 UTC 左右**。如果之后有新部署或配置变更，请更新 §12 的版本记录并更新相关 sections。当前文档的单一事实源 = 测试网本身的 live config + chain state。
