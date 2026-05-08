# 事件复盘：测试网 BFT 停产 — 2026-04-25 01:07 UTC ~ 02:42 UTC

> 测试网链高度卡在 block 27 238 约 95 分钟。根因为 prover sidecar 与 validator 共享 LevelDB 卷的双写者破坏。
> 已恢复，已添加防御措施。
> 英文版：`incident-2026-04-25-chain-halt-post-mortem-en.md`。

---

## TL;DR

| 项目 | 值 |
|---|---|
| 故障开始 | 2026-04-25 **01:08 UTC** |
| 完全恢复 | 2026-04-25 **02:42 UTC** |
| 持续时长 | ~ **95 分钟** |
| 期间停产块数 | 0（**不是漏块，是完全卡死**） |
| 影响 | 1 个 validator state trie 清空 + 另 1 个 validator 已分叉 stateRoot |
| 数据丢失 | 0（所有交易、合约状态均通过 peer 重建恢复） |
| 根因 | 3 个 prover sidecar 容器对 validator 的 LevelDB 卷有 `rw=true` 共享挂载 → dual-writer 破坏 |
| 触发动作 | `docker compose up -d --force-recreate node-1`（开放 IPFS HTTP 端口 28786） |
| 修复方式 | 从 healthy peer 拷 state DB + 把 prover 改 `:ro` 挂载 |

---

## 1. 时间线

所有时间为 UTC，2026-04-25。

```
01:07:24  node-1 (旧实例) 完成 block 27 238 finalize
          ┃
          ┃ user issues: docker compose up -d --force-recreate node-1
          ┃ (目的: 暴露 IPFS HTTP port 5001 → host 28786)
          ┃
01:07:25  node-1 (旧) 收到 SIGTERM, 开始 30s graceful shutdown
01:07:30  node-1 (新) 启动；进程持有 LevelDB 句柄
          ↑ 此时 coc-prover-1 仍在持续运行（自昨日 12:11 启动以来），
            它的 IpfsBlockstore 也持有同一卷的文件描述符
01:07:33  node-1 export state-snapshot ✅
          accounts=90, stateRoot=0x5a570af9..., blockHeight=27238
01:07:50  node-1 与 node-2/3 完成 wire 握手
01:08:33  ⚠️ 第一次出现 "state trie has no committed root" 错误
          → state trie 被破坏；之后 BFT 不再参与
01:08-02:37  链停产：
          • node-2（27239 的 proposer）每 21s 重发 prepare 提案
          • prepareVotes=1 (只有自己), 永远凑不齐 quorum
          • node-1 没有任何 BFT 活动
02:37     用户报告链停产
02:38:13  停 coc-prover-1（消除 dual writer）
02:38:20  发现 node-1 state trie 被清空（accounts=0）
02:38:30  从 node-3 拷 leveldb-state + leveldb-chain → node-1
02:38:40  ⚠️ 启动失败：LOCK 文件 root-owned, coc 用户没权限
02:39:00  chown -R 999:999 修复，重启 node-1
02:39:28  node-1 export 健康 snapshot：accounts=90, stateRoot=0x0bd9b9cb...
02:40:00  ⚠️ 新发现：node-2 也已分叉
          • node-2 stateRoot=0x8b20c869... (89 accounts)
          • node-1/3 stateRoot=0x0bd9b9cb... (90 accounts)
          • BFT 仍卡在 27239（node-2 是 proposer，提案被拒）
02:41:18  停 node-2，从 node-3 拷 state DB
02:42:30  重启 node-2，3 个节点 stateRoot 完全一致
02:42:50  **chain 恢复**：bn 27 238 → 27 245 → 27 250 → ...
02:43:56  重启 3 个 prover (now `:ro` mount)
02:44:30  完整系统稳定确认 (bn>27 282)，所有 prover /health=ok
```

---

## 2. 根因分析

### 2.1 直接原因：双写者 LevelDB 破坏

`coc-prover-1` 容器的 docker volume 挂载是这样配置的（在我昨晚 12:11 的 `docker run` 里）：
```bash
docker run -d --name coc-prover-1 \
  -v docker_node1-data:/data/coc \      # ← rw=true (默认)
  -v .../node-1.json:/app/config.json:ro \
  ...
```

注意 `-v docker_node1-data:/data/coc` **没有 `:ro` 后缀**，导致 docker 以默认 `rw=true` 挂载。

`runtime/coc-node.ts`（prover 主入口）启动时：
```typescript
const storageBlockstore = poseStorageFromBlockstore 
  ? new IpfsBlockstore(storageDir)   // storageDir = /data/coc/storage
  : undefined;
```

`IpfsBlockstore.init()` 会做 `mkdir -p` 创建 blocks 目录。这本身是无害的（目录已存在 → no-op）。但卷的 RW 模式让 prover 进程**有资格**写入 LevelDB 目录里的任何文件——包括 LOCK 文件。

LevelDB 用 fcntl advisory lock 来防止两个进程同时打开同一 DB。容器之间 mount 同一物理 inode 时，fcntl 锁是**跨容器有效**的——但前提是两个进程都"诚实"地申请锁。如果一个进程直接打开 LOCK 文件 + 写 0 字节，会 stomp 掉对方的锁状态。

### 2.2 触发条件：force-recreate

正常情况下两个进程都不动 LevelDB 文件，平时没事。但当我做 `force-recreate node-1` 时：
1. 旧 node-1 进程收到 SIGTERM，开始 graceful shutdown — 这期间它会 release LevelDB lock
2. 新 node-1 进程启动 — 它要 acquire LevelDB lock
3. **两步之间**，prover-1 还在持续访问卷（虽然只读 IPFS blocks，但 fd 仍在）
4. 容器 namespace 切换 + 文件系统 inode 重新挂载，可能让锁状态进入"半释放"模式
5. 新 node-1 acquire 锁成功，但 LevelDB 内部状态机认为有未完成的 manifest 重写
6. 30s 后某个 LevelDB 内部 compaction 操作触发，发现 manifest 引用的 SST 文件不存在 → 清空 trie 重建

**精确的内部触发**没法 100% 复现（涉及 LevelDB + Linux fcntl + container fs layer 的交互），但 **避免双写者足以杜绝这一类问题**。

### 2.3 二次故障：node-2 stateRoot 分叉

这才是 incident 中真正"出乎意料"的发现。把 node-1 修好后，发现 node-2 的 stateRoot 跟 node-1/3 不一致：
```
node-1 bn=27238 stateRoot=0x0bd9b9cb...
node-2 bn=27238 stateRoot=0x8b20c869...    ← 不同！
node-3 bn=27238 stateRoot=0x0bd9b9cb...
```

更精确：`accounts=89` vs `accounts=90` —— **少了一个账户**。

时间上往前推：block 27 200 也是 stateRoot=0x8b20c869... vs 0x0bd9b9cb...，说明这个分叉**早就存在**，不是今晚发生的。

可能原因：
- node-2 在过去某次重启时（之前的部署调试期间），可能也经历过类似的双写者破坏，但没被察觉
- 也可能是某个 PoSe v2 注册操作在 node-2 上没有 commit 干净（留下半状态）
- 这是 GitHub Issue #3 ("validators commit divergent state tries") 的真实样本

**Phase B 的 `(blockHash, stateRoot)` pair-quorum 没能阻止分叉持续运行**，因为：
- BFT 只需 2/3 quorum：node-1 + node-3 = 2 票，足以 finalize 块
- node-2 的 vote 因 stateRoot 不同被 reject，但 node-1+3 不知情
- node-2 自己 apply 块时用自己的 stateRoot 链，所以 block.hash 一致但内部 state 分叉
- BFT 没有"强制 audit": 没有机制定期对账每个节点的 stateRoot

这是 Phase D 应该补的一项设计。

---

## 3. 影响评估

### 3.1 数据完整性

| 检查 | 结果 |
|---|---|
| 所有交易 hash 仍可查询 | ✅ |
| Block 1 ~ 27238 chain 数据 | ✅（每个节点都有完整副本） |
| 智能合约 state（PoSeManagerV2 等） | ✅（验证 `getActiveNodeCount=4`、`DOMAIN_SEPARATOR` 等不变） |
| 用户钱包余额 | ✅（deployer 账户 9 980+ ETH 不变） |
| IPFS blockstore | ✅（独立于 LevelDB，未受影响） |
| CidRegistry 已注册的 CID | ✅（4 个 CID 均仍可查） |

### 3.2 服务影响

| 服务 | 影响 |
|---|---|
| 链共识（block production） | ❌ 完全停产 95 min |
| RPC eth_blockNumber 等 | 🟡 仍可读，但所有 *写* 交易卡在 mempool |
| WebSocket subscriptions | 🟡 不接收 newHeads（因为没有新块） |
| Faucet | ❌ 不能 dispatch ETH transfer |
| Explorer 实时更新 | 🟡 显示"等待新块" |
| IPFS HTTP `/api/v0/add` | ✅ 始终可用（与 BFT 解耦） |
| PoSe v2 batchV2 链上提交 | ❌ 不能提交（依赖链）|

### 3.3 经济损失

测试网 = 0。Hardhat 默认账户、未发币、无真实经济活动。

---

## 4. 修复步骤（已执行）

### 4.1 紧急止血

```bash
# 1. 停 prover-1 (消除 dual writer)
docker stop coc-prover-1

# 2. 停 node-3 (作为 donor 拿一个一致快照)
docker stop coc-node-3

# 3. 备份 node-1 损坏的 state DB
mv /var/lib/docker/volumes/docker_node1-data/_data/leveldb-state \
   /var/lib/docker/volumes/docker_node1-data/_data/leveldb-state.broken.20260425-023820

# 4. 拷 node-3 的 state DB → node-1
cp -r /var/lib/docker/volumes/docker_node3-data/_data/leveldb-state \
      /var/lib/docker/volumes/docker_node1-data/_data/leveldb-state
cp -r /var/lib/docker/volumes/docker_node3-data/_data/leveldb-chain \
      /var/lib/docker/volumes/docker_node1-data/_data/leveldb-chain

# 5. 修权限（关键，否则 LOCK 文件 EACCES）
chown -R 999:999 \
  /var/lib/docker/volumes/docker_node1-data/_data/leveldb-state \
  /var/lib/docker/volumes/docker_node1-data/_data/leveldb-chain

# 6. 重启 node-3 → node-1
docker start coc-node-3
docker start coc-node-1
```

### 4.2 二次修复（node-2 分叉）

```bash
# 同样的过程对 node-2
docker stop coc-node-2
mv /var/lib/docker/volumes/docker_node2-data/_data/leveldb-state \
   /var/lib/docker/volumes/docker_node2-data/_data/leveldb-state.diverged.20260425-024118
mv /var/lib/docker/volumes/docker_node2-data/_data/leveldb-chain \
   /var/lib/docker/volumes/docker_node2-data/_data/leveldb-chain.diverged.20260425-024118
docker stop coc-node-3   # 静态拷
cp -r /var/lib/docker/volumes/docker_node3-data/_data/leveldb-state \
      /var/lib/docker/volumes/docker_node2-data/_data/leveldb-state
cp -r /var/lib/docker/volumes/docker_node3-data/_data/leveldb-chain \
      /var/lib/docker/volumes/docker_node2-data/_data/leveldb-chain
chown -R 999:999 /var/lib/docker/volumes/docker_node2-data/_data/leveldb-{state,chain}
docker start coc-node-3
docker start coc-node-2
```

### 4.3 持久化修复：prover RO 挂载

```bash
# 重启 3 个 prover sidecar，所有卷挂载改成 :ro
for n in 1 2 3; do
  docker rm -f coc-prover-$n
  docker run -d --name coc-prover-$n \
    --network docker_coc-rpc --network-alias prover-$n \
    -p 127.0.0.1:$((19900+n)):18800 \
    -v docker_node${n}-data:/data/coc:ro \    # ← :ro
    -v /root/clawd/COC/docker/testnet-runtime-configs/provers/node-$n.json:/app/config.json:ro \
    -e COC_CONFIG=/app/config.json \
    -e COC_NODE_PK=$KEY \
    -e COC_RPC_URL=http://node-$n:18780 \
    coc-runtime:phase-c-step2 \
    runtime/coc-node.ts
done
```

⚠️ 注意：`runtime/coc-node.ts` 中 `IpfsBlockstore.init()` 会调 `mkdir -p`。在 RO 卷上目录已存在，所以 mkdir 是 no-op，不报错。如果未来代码改成"必须能写"，这里会出问题——已记入下面的 §5.3 后续工作清单。

---

## 5. 防御措施

### 5.1 ✅ 已完成

1. **prover sidecar 永久 RO 挂载**：上述 §4.3
2. **测试网状态文档加运维规则**：`testnet-status-2026-04-24-zh.md` §3 末尾加"卷共享读写约束"小节
3. **docker-compose 加 prover service 定义**：避免下次手动 `docker run` 漏掉 `:ro`
4. **readiness assessment 反扣运维成熟度分**：60% → **50%**

### 5.2 🟡 短期 follow-up（1-2 周）

5. 在 `runtime/coc-node.ts` 启动时**主动校验**`storageDir` 是 RO 挂载，给出明确警告而不是隐式接受
6. **告警系统接入**：Prometheus alertmanager + Slack/PagerDuty webhook，规则：
   - `chain_height` 同一 validator 5 分钟内未增长 → P0 告警
   - 任意两 validator stateRoot 不一致 → P0 告警
   - LevelDB 错误日志频率 > 1/min → P1 告警
7. **state-divergence 检测脚本**：每 epoch 对账 3 节点 stateRoot 是否一致，不一致就停 prover 自动 rotate proposer

### 5.3 ❌ Phase D 设计任务

8. **跨 validator stateRoot audit**：周期性主动对账，发现不一致立即 freeze 分叉节点的投票权
9. **LevelDB 单进程强制保证**：runtime/coc-node.ts 启动时检测目标卷是否已被另一进程持锁，是则拒启动
10. **更细粒度的 IPFS 卷分离**：把 `storage/blocks/` 单独抽成独立 named volume，prover 只挂这个子卷而不是整个 `/data/coc`

### 5.4 测试覆盖

`tests/chaos-resilience.test.ts` 应当增加：
- "Validator restart while prover sidecar is running"
- "Two processes opening same LevelDB simultaneously"
- 有意制造 stateRoot 分叉，断言 BFT 不能继续 finalize

---

## 6. 经验教训

1. **共享 docker volume 默认 RW 是大坑**。所有非业主写入者都应当 `:ro`。
2. **测试网不是"无成本环境"**：今晚的 95 min 停产对开发流程造成实质阻碍——意味着真正部署时这种事必须有 < 5 min 自动恢复机制。
3. **state divergence 比表面看起来普遍**。node-2 的分叉**早于今晚**就存在但没被发现，说明被动监控不够，需要主动 audit。
4. **GH#3 应升级为 Phase D 阻断项**——主网启动前必须有跨节点 stateRoot audit。

---

## 7. 留存的取证数据（不要立即删）

```
/var/lib/docker/volumes/docker_node1-data/_data/leveldb-state.broken.20260425-023820/
/var/lib/docker/volumes/docker_node2-data/_data/leveldb-state.diverged.20260425-024118/
/var/lib/docker/volumes/docker_node2-data/_data/leveldb-chain.diverged.20260425-024118/
```

**保留至 2026-05-09**（14 天），用于：
- 反查 node-2 的 89 → 90 account 差异是哪个账户
- 分析 LevelDB 损坏后的 manifest 状态（看是 LSM compaction 半状态还是 LOCK 抢占问题）

到期可以执行：
```bash
ssh coc-testnet 'rm -rf /var/lib/docker/volumes/docker_node*-data/_data/leveldb-state.broken.* /var/lib/docker/volumes/docker_node*-data/_data/leveldb-{state,chain}.diverged.*'
```

---

## 8. 文档变更

| 关联文档 | 变更 |
|---|---|
| `testnet-status-2026-04-24-zh.md` | §3 加"卷共享读写约束"小节 |
| `docker/docker-compose.testnet.yml` | 加 prover-1/2/3 服务定义（all `:ro`） |
| `testnet-readiness-assessment-2026-04-24-zh.md` | §11 / §12 反扣分；新增 incident 列入 known issues |

---

**事件负责复盘**：Claude Code（基于 SSH 日志 + 容器状态 + LevelDB on-disk 取证）
**事件 P 级**：P1（测试网，无经济损失，但 95 min 完全停产）
**post-mortem 完成时间**：2026-04-25 03:00 UTC
