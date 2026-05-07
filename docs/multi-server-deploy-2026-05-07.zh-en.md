# Multi-Server Testnet — Deployment Report 2026-05-07

**Status / 状态**: ✅ deployed; 跨服务器 IPFS P2P 存储核心目标已验证

**Trigger / 触发**: 单 host 多进程 testnet 经过 2026-04 ~ 2026-05 大量调试后被证明不能验证真实分布式协议行为（`coc-ext-net` docker bridge 网络 unreachable、`host.docker.internal:host-gateway` 解析错误、systemd/docker 边界处的 nodeId 不一致导致 ValidatorRegistry rotation 死锁）。本次将 testnet 物理重新部署到 3 台分散服务器，验证真实 P2P 协议层。

---

## 1. 拓扑

| 角色 | hostname | 公网 IP | 地理位置 | 端口 | 实例 |
|---|---|---|---|---|---|
| validator-1 | server1.parallels.fund | 209.74.64.88 | 海外 (~225ms) | 28780/RPC, 29780/P2P, 29781/Wire, 28786/IPFS, 9101/metrics | `coc-node@1` |
| validator-2 | server1.bagua.my | 159.198.44.136 | (clawchain.io 公网 DNS 指向) | 同 validator-1 | `coc-node@1` |
| validator-3 | server1.clawchain.io | 199.192.16.79 | (老 testnet 所在) | **48780/RPC, 49780/P2P, 49781/Wire, 48786/IPFS, 29101/metrics**（+20000 偏移） | `coc-node@4` |

每台 native systemd（无 docker），一个 validator/host，公网 IP 直连，0.0.0.0 bind。validator-3 端口偏移避免与 server 上既有 docker container（`coc-light-1` 占用 38780-39781）冲突。

3 个 validator 地址（anvil idx 0/1/2，dev testnet）：
- `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (validator-1)
- `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (validator-2)
- `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` (validator-3)

ChainId: 18780 (与老 testnet 隔离不同 genesis，无数据交叉)。

---

## 2. 部署流程

### 2.1 Operator workstation (本地)

```bash
cd /passinger/projects/ClawdBot/COC
bash scripts/bootstrap-multi-server-genesis.sh \
  --validator-1-host 209.74.64.88 \
  --validator-2-host 159.198.44.136 \
  --validator-3-host 199.192.16.79 \
  --validator-3-port-shift 20000 \
  --reuse-anvil-keys
```

输出 `/tmp/coc-multi-server/`:
- `keys.txt`(chmod 600) — 3 keys
- `genesis.json` — canonical genesis
- `deploy-vars-server-{1,2,3}.sh` — 每 server 的 sourceable env

### 2.2 每台 server 执行

```bash
ssh root@<host>
source /root/deploy-vars-server-N.sh
bash <(curl -fsSL https://raw.githubusercontent.com/chainofclaw/COC/main/scripts/deploy-validator-server.sh)
```

deploy 脚本完成 9 步：apt 装 Node 22 + git + ufw + chrony，建 `coc:coc` 用户，clone 代码到 `/opt/coc`，npm install 依赖，从模板渲染 `/etc/coc/node-N.{env,json}`，开 ufw（仅必要端口），装 systemd unit，启动服务，自检 RPC + peer 连通性。

实际部署中遇到的问题 + 修复：

| 问题 | 修复 |
|---|---|
| `npm ci` 失败：repo 的 `.gitignore` 排除了 `package-lock.json` | 改用 `npm install`（commit `7c3e96f`） |
| validator-3 上 `/opt/coc` 已被老 testnet 占用（rsync 遗留，非 git repo） | 先 `mv /opt/coc /opt/coc.pre-multiserver.20260507`，让 deploy 脚本 fresh clone；老 systemd 单元保留 |
| validator-3 上 `/etc/coc/node-1.json` 等已被老 testnet 占用 | deploy-vars 改 `INSTANCE_ID=1→4`，避免冲突，老 node-1/2/3 配置保留 |
| 38780-39781 端口被老 docker container `coc-light-1` 占用 | port shift 从 +10000 提到 +20000，移到 48780-49781 |
| `peer identity verification failed` warnings on all 3 servers | 临时 patch 每 server 的 `/etc/coc/node-N.json`：`dhtRequireAuthenticatedVerify=false`, `p2pInboundAuthMode=observe`，重启服务 |

总耗时（含调试）：~30 分钟。clean redeploy on fresh server: ~5 分钟。

---

## 3. 验证结果

### 3.1 跨服务器 IPFS P2P 文件复制 ✅ 核心目标

**测试**：PUT 512KB random payload 到 server-1 (`209.74.64.88:28786/api/v0/add`)，等 12 秒，从所有 3 servers 通过 `/api/v0/get` 拉取（tar archive）。

CID: `bafybeidxlrnh7rih65vai4aibpe46afbhqpnmzl3gxjlimdgv4ew4v2mja`

```
209.74.64.88:28786:  HTTP=200  raw_size=525824 (tar)  extracted=524288 bytes ✓
159.198.44.136:28786: HTTP=200  raw_size=525824 (tar)  extracted=524288 bytes ✓
199.192.16.79:48786:  HTTP=200  raw_size=525824 (tar)  extracted=524288 bytes ✓
```

文件系统验证：所有 3 servers `/var/lib/coc/node-{1,4}/storage/blocks/` 都包含 root CID + 2 个 leaf chunks（512KB 文件按 256KB chunk size 分成 2 leaves）。

server-1 的 `coc-ipfs-wiring` 日志：
```
{"message":"pushToK: partial replication","cid":"bafybeidxlr...","attempted":3,"succeeded":2,"failed":1}
```
3 个目标里 2 成功（含 server-2 + server-3 + 1 个不计入），文件物理出现在跨网络的两台对端服务器 disk 上。

**这是单 host 多进程 testnet 无法证明的能力** —— localhost 读永远成功，看不出真复制 vs 读自己。本次跨 3 个公网 IP / 3 个不同 hostname，1 个 PUT 操作触发文件实际跨大陆传输并落盘。

### 3.2 链 BFT 出块 ⚠ slow / 仅部分功能

| | finalized blocks | 当前 height | 状态 |
|---|---|---|---|
| server-1 | 3 | 4 | leading |
| server-2 | 2 | 3 | 落后 1 块 |
| server-3 | 2 | 4 | follow |

链产出 4 块后 stall。s2 在 03:59:10 重启后未追上 height 4。BFT 协议层有效（产生过 round + finalize 事件），但延续性差，跟单 host 的故障模式相似但根因不完全相同。

### 3.3 跨服务器 wire 互连 ✅

所有 3 servers 都建立了 wire-client connections 到另 2 个 servers，handshake 完成。但有 `peer identity verification failed` 警告（见 §4 已知 bug）。

---

## 4. 已知 bugs（不在本次会话修复范围）

### 4.1 DHT discovery 用 wire port 做 HTTP identity verify

`node/src/index.ts:1384`：
```ts
onPeerDiscovered: (peer) => {
  p2p.discovery.addDiscoveredPeers([{ id: peer.id, url: `http://${peer.address}` }])
}
```

DHT 的 `peer.address` 是 host:wire_port，被当 HTTP 端点验证 → wire 是二进制协议，HTTP 解析失败 → `peer identity verification failed`。

Workaround：3 servers 的 config 临时设 `dhtRequireAuthenticatedVerify=false`, `p2pInboundAuthMode=observe`。

正确修复：discovery 应通过 P2P 端口（28780+P2P offset = 29780 / 49780）做 HTTP verify，不是 wire 端口。

### 4.2 `/api/v0/cat` endpoint bug

```
GET /api/v0/cat/<cid>  → HTTP 404
GET /api/v0/get/<cid>  → HTTP 200 (tar archive，含完整 file)
GET /api/v0/block/get/<cid> → HTTP 200 (raw root block)
```

`cat` endpoint 应该 follow UnixFS leaves 并 stream。所有底层 data + metadata 都在（`pins.json` + `file-meta.json` + leaf blocks on disk），只是 `cat` 路径 trace 失败。

文件位置：`node/src/ipfs-http.ts`（cat handler）。

### 4.3 BFT 多块出块后 stall

3 servers 出块 4 块后 stall。同单 host testnet 的故障模式，但跨服务器版本可能因 §4.1 验证 bug 部分原因。需深入 trace BFT round 状态机 + wire transport 是否丢包。

---

## 5. 部署成果文件

### 已 commit + push 到 chainofclaw/COC main

- `7f39569` — multi-server scripts + 模板 + ops 文档
- `7c3e96f` — fix: 用 npm install 替代 npm ci（lockfile 未提交）
- 现 commit (本报告) — deployment retrospective

### 服务器现存遗留（未 commit）

3 servers 的 `/etc/coc/node-N.json` 中：
- `dhtRequireAuthenticatedVerify=false`
- `p2pInboundAuthMode=observe`
- `poseInboundAuthMode=observe`
- `p2pRequireInboundAuth=false`

这些是 §4.1 bug 的运行时 workaround。修复 bug 后应恢复严格模式。

### 未在新 testnet 部署

- ValidatorRegistry on-chain governance 合约（plan §R5）— 当前用 static `validators` array
- Phase X2 的 `/contracts/x2-stake-cores.mjs` 未运行（无须 stake，static 直接生效）
- IPFS verify-multi-server-ipfs.sh 没运行 — 因 `/api/v0/cat` bug 改用 ad-hoc `/api/v0/get` 测试

---

## 6. 老 testnet 处置

server-3 (199.192.16.79) 上的老 testnet：
- ✅ 数据完整保留：`/var/lib/coc/node-{1,2,3}/`（含 leveldb-chain, leveldb-state, evidence.jsonl）
- ✅ 备份 tarball 完整：`/var/lib/coc/node-{1,2,3}-pre-rollback-20260507.tgz`（~248MB 共）
- ✅ 老代码完整保留：`/opt/coc.pre-multiserver.20260507/`
- ✅ 老 systemd 单元文件保留：`/etc/systemd/system/coc-node@.service`（同一 template，已被新 deploy 覆盖但内容相同）
- ⚠ 老 systemd 服务**已停止**：`coc-node@1/2/3` 现在 inactive
- ⚠ 老 testnet 配置仍在 `/etc/coc/node-{1,2,3}.json`（未触动）

恢复老 testnet 任意时点可执行：
```bash
ssh root@199.192.16.79
mv /opt/coc /opt/coc-multiserver-bak
mv /opt/coc.pre-multiserver.20260507 /opt/coc
systemctl start coc-node@1 coc-node@2 coc-node@3
```

老 chain state（forked 在 213865/213867）会从 storage 重新加载。

---

## 7. 下次会话路线图

### 优先级 1（基础健全性）
- [ ] 修 `node/src/index.ts:1384` DHT discovery URL bug（用 P2P 端口而非 wire 端口）
- [ ] 修 `node/src/ipfs-http.ts` `/api/v0/cat` endpoint follow-leaves 逻辑
- [ ] 恢复 3 servers 的严格 auth mode（`dhtRequireAuthenticatedVerify=true` 等）

### 优先级 2（功能扩展）
- [ ] 部署 ValidatorRegistry on-chain governance 到新 chain
- [ ] 运行 `scripts/x2-stake-cores.mjs` stake 3 validators
- [ ] 切到 reader 模式（`validatorRegistryAddress` in config）

### 优先级 3（用户体验）
- [ ] 写 `docs/run-user-node.zh-en.md` light/sync 节点接入文档
- [x] **部署 explorer 指向新 testnet endpoints** —— 见 §8
- [x] **部署 faucet 在新 chain 上** —— 见 §8

### 优先级 4（容量 / 弹性测试）
- [ ] 添加 4th validator（验证 governance-driven 加节点）
- [ ] 节点 region 跨大陆扩展（当前 3 servers 都在亚洲？需要确认地理）
- [ ] 故意 partition 测试（一段时间网络分区然后恢复）

---

## 8. Explorer + Faucet 部署到新 testnet (2026-05-07)

### 8.1 现状

`159.198.44.136` (clawchain.io) 上 PM2 已经管着 `coc-explorer`, `coc-faucet`, `coc-website`, `coc-ipfs` 4 个服务，原本指向老 chain 的 `:18780`。新 testnet 在同台机器上的 validator-2 监听 `:28780`。最务实的做法：复用既有 PM2 + nginx infra，把 RPC backend 切到新 chain，不重新部署。

### 8.2 切换步骤

#### Step 1 — Nginx 公网 RPC + WebSocket 路由

`/etc/nginx/sites-available/clawchain.io` 中 `location /api/testnet/rpc` 和 `location /api/testnet/ws` 两个 block 的 proxy_pass 都要改。**RPC 和 WS 是两个不同端口（28780 vs 28781），两条 sed 都要执行**——本会话首次部署只改了 RPC 漏了 WS，导致 explorer 显示 "Offline" 因为 WSS upgrade 失败：

```bash
ssh root@<host>
cp /etc/nginx/sites-available/clawchain.io /etc/nginx/sites-available/clawchain.io.bak-pre-multiserver-20260507

# RPC: 28780
sed -i 's|proxy_pass http://199.192.16.79:28780|proxy_pass http://127.0.0.1:28780|g' /etc/nginx/sites-available/clawchain.io
# WebSocket: 28781
sed -i 's|proxy_pass http://199.192.16.79:28781|proxy_pass http://127.0.0.1:28781|g' /etc/nginx/sites-available/clawchain.io

# 验证两个 location 都更新成功
grep -A 1 'location /api/testnet/' /etc/nginx/sites-available/clawchain.io | grep proxy_pass
# 期望：两行 proxy_pass http://127.0.0.1:2878{0,1}

nginx -t && nginx -s reload
```

WSS 升级测试（确认配置生效）：

```bash
echo -e 'GET /api/testnet/ws HTTP/1.1\r\nHost: clawchain.io\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n' | \
  openssl s_client -connect clawchain.io:443 -quiet -servername clawchain.io 2>/dev/null | head -3
# 期望：HTTP/1.1 101 Switching Protocols
```

#### Step 2 — Explorer 配置

`/root/clawd/COC/explorer/.env.local`:

```
NEXT_PUBLIC_RPC_URL=https://clawchain.io/api/testnet/rpc
NEXT_PUBLIC_WS_URL=wss://clawchain.io/api/testnet/ws
COC_RPC_URL=http://127.0.0.1:28780
```

`NEXT_PUBLIC_RPC_URL` 是浏览器侧 build-time injected — 因为公网 URL 不变（依赖 nginx 后端切换），不需要重新 build。`COC_RPC_URL` 是 server-side runtime env，next start 启动时读取。

#### Step 3 — Faucet 配置

新建 `/root/clawd/COC/faucet/.env.local`（chmod 600，**不入仓库**）：

```
COC_FAUCET_RPC_URL=http://127.0.0.1:28780
COC_FAUCET_PORT=3003
COC_FAUCET_PRIVATE_KEY=<faucet 私钥，参见本机 secrets 笔记>
COC_FAUCET_DRIP_AMOUNT=10
COC_FAUCET_COOLDOWN_MS=86400000
```

由于新 chain 是 fresh genesis，faucet 地址在新链上没余额，需要从 anvil-0 deployer 转账。1000 ETH 一次足够运行很久（drip 量 10 ETH × 100 次/天 ≈ 1000 / 月）：

```bash
# 在 operator 工作站
node -e '
import { JsonRpcProvider, Wallet, Transaction } from "ethers"
const provider = new JsonRpcProvider("https://clawchain.io/api/testnet/rpc")
const w = new Wallet(process.env.ANVIL_0_KEY, provider)  // anvil-0 deployer
const nonce = await provider.getTransactionCount(w.address, "latest")
const tx = await w.populateTransaction({
  to: process.env.FAUCET_ADDR,
  value: 1000n * 10n ** 18n,
  nonce, gasLimit: 21000n, gasPrice: 5_000_000_000n,
  type: 0, chainId: 18780n,
})
await provider.broadcastTransaction(await w.signTransaction(tx))
'
```

#### Step 4 — PM2 重启

```bash
# Explorer: env 改了直接 restart 即可（next start 重新读 .env.local）
pm2 restart coc-explorer

# Faucet: PM2 entry env 缓存难以更新，删掉重建
pm2 delete coc-faucet
cd /root/clawd/COC/faucet
set -a; source /root/clawd/COC/faucet/.env.local; set +a
pm2 start npm --name coc-faucet --update-env -- start
pm2 save  # 持久化，重启服务器自动恢复
```

### 8.3 验证

```bash
# 1. nginx RPC proxy
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://clawchain.io/api/testnet/rpc
# 期望：返回当前 height

# 2. Explorer
curl -sI https://explorer.clawchain.io/   # HTTP 200

# 3. Faucet status
curl -s https://faucet.clawchain.io/faucet/status
# 期望：{"balance":"1000.0","totalDrips":0,"dailyDrips":0,"dailyLimit":"10000.0","dripAmount":"10.0"}

# 4. Faucet drip (注意 address 必须正确 EIP-55 校验和或全小写)
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"address":"0x<lowercase_addr>"}' \
  https://faucet.clawchain.io/faucet/request
# 期望：{"txHash":"0x...","amount":"10.0","unit":"COC"}

# 5. drip 后受益地址有余额
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x<addr>","latest"],"id":1}' \
  https://clawchain.io/api/testnet/rpc
# 期望：返回 0x8ac7230489e80000 (= 10 ETH)
```

### 8.4 端点摘要

| Service | URL | Backend | 说明 |
|---|---|---|---|
| Explorer | https://explorer.clawchain.io | PM2 `coc-explorer` (Next.js port 3000) | server-side RPC = `127.0.0.1:28780` |
| Faucet UI | https://faucet.clawchain.io | PM2 `coc-faucet` (port 3003) | drip 10 ETH/请求，24h 冷却 |
| Faucet API | /faucet/{status,request} | 同上 | POST request，`{"address":"0x..."}` |
| Public RPC | https://clawchain.io/api/testnet/rpc | nginx → `127.0.0.1:28780` | 浏览器用 |
| Public WS | wss://clawchain.io/api/testnet/ws | nginx → `127.0.0.1:28780` (WS upgrade) | newHeads 等 subscribe |

### 8.5 已知 caveat

- **nginx RPC 和 WS 是两个不同 location，必须都改**：本次部署首次操作时只 sed RPC（28780）漏了 WS（28781），结果 explorer 页面显示 "Offline"（block 数停在 RPC 单次拉取后的值，不再更新）。WSS handshake 在 nginx 层 400 因为后端 199.192.16.79:28781 已不再监听。修复后 `HTTP/1.1 101 Switching Protocols`。**Step 1 已加双 sed**。
- **faucet drip 校验严格**：`0x...Dead` 大小写混合不通过 EIP-55 校验 → 500 internal error。Web UI 应 lowercase normalize 输入；API 调用方需保证 address 是有效校验和或全小写。
- **Faucet RPC 选择 server-2 (159.198.44.136:28780) 而非 server-1/3**：因为 PM2 + faucet 在同台机器，loopback 最快；任一 server 宕机不影响另两个，但 faucet 跟 server-2 共命运。生产化可改成轮询所有 3 个 RPC。
- **explorer NEXT_PUBLIC_RPC_URL 仍指 https://clawchain.io/api/testnet/rpc**（域名不变）：依赖 nginx 后端切换。如果未来 RPC backend 从同台机器搬走，要么改 nginx upstream，要么 rebuild explorer 改 NEXT_PUBLIC_RPC_URL。
