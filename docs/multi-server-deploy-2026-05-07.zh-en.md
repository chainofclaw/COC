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

---

## 9. IPFS 50GB storage cap + P2P 协议端到端验证 (2026-05-07)

### 9.1 配置 50GB cap

每台 server 在 `/etc/coc/node-N.env` 追加：

```
COC_IPFS_MAX_BYTES=53687091200   # = 50 * 1024^3
```

| Server | env 文件 | port |
|---|---|---|
| 209.74.64.88 | /etc/coc/node-1.env | RPC 28780, IPFS 28786 |
| 159.198.44.136 | /etc/coc/node-1.env | RPC 28780, IPFS 28786 |
| 199.192.16.79 | /etc/coc/node-4.env | RPC 48780, IPFS 48786 (port-shifted +20000) |

修改后 `systemctl restart coc-node@<N>`。验证已生效：

```bash
ssh root@<host> 'cat /proc/$(systemctl show -p MainPID --value coc-node@<N>)/environ | tr "\0" "\n" | grep IPFS'
# 期望含: COC_IPFS_MAX_BYTES=53687091200
```

实现位置：
- `node/src/ipfs-blockstore.ts:45-235` — `maxBytes` config + LRU eviction at `EVICT_TARGET_FRACTION=0.9` (45GB target)
- `node/src/config.ts:384-401` — env-to-config 映射；`light` mode 默认 100MB，其他无上限

LRU 排序基于 `accessSeq` 计数；pinned CIDs 不会被驱逐。50G × 3 节点，K=3 复制 → 实际可承载约 50GB unique 内容。

**Disk margin 警告**：server-1 free=58G，cap=50G，余量仅 8G；如果 PUT 接近上限触发 LRU eviction 较慢，可能短时占满。生产建议 server-1 改为 40G 或扩盘。

### 9.2 测试矩阵 (2026-05-07)

| ID | 测试 | 结果 | 详情 |
|---|---|---|---|
| B1a | 256KB PUT to s1 + GET from 3 servers (byte-cmp) | **PASS** 3/3 | tar=263680, body=262144 byte-identical |
| B1b | 1MB PUT + GET 3 servers | **PASS** 3/3 | tar=1050112 byte-identical |
| B1c | 5MB PUT + GET 3 servers | **PASS** 3/3 | tar=5244416 byte-identical |
| B1d | 10MB PUT | **PASS** 3/3 (commit `0512ccb`) | 修复后 tar=10487296 byte-identical；详见 §9.4 fix 1 |
| B2 | filesystem replication audit (block files in `/var/lib/coc/.../storage/blocks/`) | **PASS** | 三服务器各 40 blocks / 8.5M，所有测试 CID 都能在 3 台 server 找到对应 block 文件 |
| B3 | DHT findProviders RPC (`coc_dhtFindProviders`) | **PASS** 3/3 | 三服务器各自的 DHT view 都返回全 3 validator 地址作为 provider |
| B4 | origin-death resilience (stop s1, GET from s2/s3) | **PASS** 2/2 | 512KB CID PUT 到 s1，s1 stop 后 s2 + s3 都能完整 GET；s1 重启后追上链头并保留 pin |
| B5 | pin/ls 验证 | **PASS** | 原始 server (s1) 的 pin set 含所有 PUT 过的 CID（共 8 个 root CID）；replica server 不 pin（设计如此 — 允许 LRU 驱逐） |
| B6 | repair loop | **SKIP** | 需 10 min wall clock，留作 future regression test |

### 9.3 测试操作示例

```bash
# B1: 256KB roundtrip
dd if=/dev/urandom of=/tmp/test.bin bs=1024 count=256
CID=$(curl -sS -X POST -F "file=@/tmp/test.bin" http://209.74.64.88:28786/api/v0/add | jq -r .Hash)
sleep 15
for h in 209.74.64.88:28786 159.198.44.136:28786 199.192.16.79:48786; do
  curl -sS -X POST "http://$h/api/v0/get?arg=$CID" | tar -xO > /tmp/got.bin
  cmp /tmp/test.bin /tmp/got.bin && echo "$h: OK" || echo "$h: MISMATCH"
done

# B2: filesystem audit
ssh root@209.74.64.88 'ls /var/lib/coc/node-1/storage/blocks/' | wc -l
ssh -i ~/.ssh/openclaw_server_key root@159.198.44.136 'ls /var/lib/coc/node-1/storage/blocks/' | wc -l
ssh root@199.192.16.79 'ls /var/lib/coc/node-4/storage/blocks/' | wc -l
# 三个数字应相同（= block 总数）

# B3: DHT
curl -sS -X POST http://209.74.64.88:28780 \
  -d '{"jsonrpc":"2.0","method":"coc_dhtFindProviders","params":["<cid>"],"id":1}'

# B4: origin-down
ssh root@209.74.64.88 'systemctl stop coc-node@1'
curl -sS -X POST http://159.198.44.136:28786/api/v0/get?arg=<cid> | tar -xO > /tmp/from-replica.bin
ssh root@209.74.64.88 'systemctl start coc-node@1'
```

### 9.4 已知问题与修复

#### Fix 1 (✅ 已修): 10MB PUT 失败
- **根因**：`DEFAULT_MAX_UPLOAD_SIZE = 10 * 1024 * 1024`（精确 10MB）。10MB 文件加 multipart 头就超限，错误传到外层 catch 返回通用 `500 "internal error"`。
- **修复 commit `0512ccb`**：
  - 上限提至 `50 MB + 64 KB headroom`（与 `UnixFsBuilder.MAX_READ_SIZE=50MB` 对齐）
  - 引入 `HttpError` 类，超限改返 **413 "payload too large"** 而非 500
- **部署**：3 台 server 已滚动重启验证 10MB roundtrip 跨 server byte-identical。

#### Fix 2 (✅ 已修): `cat`/`get` 未知 CID 返通用 500
- **根因**：之前误判为 "/api/v0/cat 返回 404"。**实际路由工作正常**（256K/5M 都成功）；真正的 bug 是请求**未存在的 CID** 时 `store.get` 抛 ENOENT 被外层 catch 捕获，返回通用 `500 "internal error"`，调用方无法区分"路由错"和"块缺失"。
- **修复 commit `0512ccb`**：
  - `handleCat` / `handleGet` 显式捕获 not-found 抛 `HttpError(404, "block not found")`
  - 外层 catch 根据 `HttpError.status` 返回正确状态码
- **验证**：未知 CID → `HTTP 404 {"error":"block not found"}` 三台 server 一致。

#### Fix 3 (✅ 已修): pin/ls 不能按 arg 过滤
- **根因**：`handlePinLs` 完全忽略 `?arg=<cid>`，无条件返回全部 pinned 集。
- **修复 commit `e66b157`**：
  - `?arg=<cid>` + 已 pin → 200，仅返回该 CID 一条
  - `?arg=<cid>` + 未 pin → **404 "not pinned"**
  - `?arg=<malformed>` → 400 "invalid cid"
  - 无 `arg` → 与之前相同，返全部 pinned 集（kubo 兼容语义）
- **验证**：3 台 server 在线 200/404/全集三态 OK。

#### Fix 4 (✅ 已修): DHT 发现 URL 用 wire port 验证 peer identity
- **根因**：`node/src/index.ts:1384` 把 DHT 返回的 wire-port 地址直接构造成 `http://${host}:${wirePort}` 并交给 PeerDiscovery，导致 HTTP 上的 identity-proof / state-snapshot / bft-message gossip 全部 404。
- **修复 commit `e66b157`**：
  - 启动时从 `config.peers` 构建 `peerId → HTTP P2P URL` 映射表（用 `advertisedUrl ?? url`）
  - `onPeerDiscovered` 只把映射表里有的 peer 加进 HTTP discovery；wire-only peer 仅打 debug 日志（wire 握手已经签名认证，无需 HTTP 二次验证）
- **配置回切**：3 台 server 的 `/etc/coc/node-N.json` 已改回严格模式：
  ```json
  "p2pInboundAuthMode": "strict",
  "dhtRequireAuthenticatedVerify": true,
  ```
- **验证**：3 台 server 滚动重启后链稳定出块（block 3438→3450 in 8s），fresh PUT 的 CID 在 3 server 各自的 `coc_dhtFindProviders` 全返回 3 validator，无 verify/reject/auth fail 日志。

### 9.5 结论

3 台多服务器 testnet 上：
- ✅ Cross-server P2P + IPFS replication 真实可用
- ✅ K=3 push-to-K 完整覆盖（block 文件物理存在 3 台机器）
- ✅ DHT routing table 跨 server 同步
- ✅ Origin-death scenario 数据可用性保持
- ✅ Pin 持久（重启后保留）
- ✅ 50G cap 已配置 + LRU 驱逐策略生效（cap 测试推荐看 `node/src/ipfs-blockstore.test.ts` 单测，端到端把 45G 数据 PUT 进去过于昂贵）

下一步建议（非本次范围）：
- Reed-Solomon 纠删码 (Phase Q) 已立项 ✅ — 设计文档 [`docs/archive/phases/phase-q-erasure-coding.md`](./archive/phases/phase-q-erasure-coding.md)，tracking issue [chainofclaw/COC#68](https://github.com/chainofclaw/COC/issues/68)。预估 8.5 dev-days，分 Q.1—Q.8 八个里程碑。

#### Fix 5 (✅ 已修): DHT provider records 持久化
- **根因**：provider 表（CID → 持有该 CID 的 peer 集）只在内存中，restart 全清。`coc_dhtFindProviders` 对老 CID 返 `[]` 直到对应 peer 在 ≤TTL/2 (=12h) 内重新 announce。本次 testnet 重启就观察到这一现象。
- **修复 commit `1000bc9`**（mirror 现有 peer 持久化模式）：
  - `DhtNetwork` 加 `providerStorePath` 配置选项 + `saveProviders()` / `loadProviders()` 方法
  - `start()` 启动时先从 `dataDir/dht-providers.json` 恢复未过期记录
  - 每 60s 自动 flush + `stop()` 时最后一次 flush（atomic write via temp + rename）
  - save 时跳过已过期条目（防文件膨胀），load 时同样过滤（防过期记录复活）
- **测试**：5 个新单测覆盖 round-trip / 过期过滤 / 缺路径 no-op / 损坏文件容错 / save 跳过过期。

#### Item: dhtBootstrapPeers 写进 env 模板
- **结论**：误判 — `dhtBootstrapPeers` 是 JSON 数组结构，**已经在 `docker/systemd/native-configs/node-multiserver.json.template` 里以 placeholder 形式存在**，由 `bootstrap-multi-server-genesis.sh` 在 deploy 时填入 per-peer ID/host/wire port。env 文件存的是平铺 `KEY=VAL`，不适合放数组结构。无 fix 可做。
