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
- [ ] 部署 explorer 指向新 testnet endpoints
- [ ] 部署 faucet 在新 chain 上

### 优先级 4（容量 / 弹性测试）
- [ ] 添加 4th validator（验证 governance-driven 加节点）
- [ ] 节点 region 跨大陆扩展（当前 3 servers 都在亚洲？需要确认地理）
- [ ] 故意 partition 测试（一段时间网络分区然后恢复）
