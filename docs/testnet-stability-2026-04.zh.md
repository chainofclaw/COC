# 测试网稳定性实验纪录 — 2026-04-19

版本: 1.0
日期: 2026-04-19
状态: 缓解措施已部署；遗留一项待跟进（applyBlock queue 化串行）。
范围: 公共测试网 `199.192.16.79`（3 个 BFT 验证节点）+ 持续 cron-stress 压力负载。

---

## 1. 背景

单次运维 session 对 COC 公共测试网做多小时稳定性验证。网络是 3 节点 BFT 集群（`node-1..3`）加一个 gateway 节点；同主机上的 `cron-stress.sh` 每分钟调用一次 Node.js tx 生成器，访问 `http://127.0.0.1:28780`。worker 在 5 种压测轮次间轮换（批量转账、EVM 密集调用、新合约部署+increment、mempool 生命周期、多钱包并行转账）。

本次 session 原意是确认生产就绪度；实际上暴露了 5 个独立缺陷，症状互相纠缠（出块停顿、RPC 超时、Explorer "No contracts found"、可复现的重启循环）。本文档记录出过什么问题、已交付什么修复、根因调查排除了什么、还剩什么待做。

---

## 2. 观察到的症状

### 2.1 BFT 共识死锁（applyBlock hang）

链高度会在随机块号卡住 10+ 分钟。日志显示 BFT 轮次达到 `commit` quorum（`prepareVotes=3 commitVotes=2`）并输出 `BFT round finalized`，但不再出现 `BFT finalized block`。`onFinalized` 内部的 `applyBlock` 调用 hang 住，无 error、无 stack、无背压信号 —— 典型的 "Promise 丢失 resolution"。

在单账户压测下的复发率：约每 8 分钟一次。

### 2.2 出块速度 1 秒/块（设计值 3 秒/块）

共识稳定后，Explorer 显示 `Blocks/min 66.7` —— 是设计 `blockTimeMs=3000` 的 3 倍。检查相邻块 timestamp 发现三元组模式（`t, t, t, t+3, t+3, t+3, …`）：每个 proposer 独立的 3 秒 `setInterval` 近似同时触发，产生连续紧挨的 block。

### 2.3 部署合约后 Explorer `Contracts` 页为空

部署 SoulRegistry / DIDRegistry / CidRegistry 之后，`https://explorer.clawchain.io/contracts` 显示 "No contracts found"。`curl` 访问同一 RPC 返回 9 个合约。nginx 返回 `Access-Control-Allow-Origin: http://localhost:3000` —— 单一硬编码开发 origin —— 导致浏览器丢弃跨域响应。Explorer 的 catch 降级到扫描最近 100 个 block，漏过更早的部署。

### 2.4 重启后 BFT/链状态脱节

首次 `process.exit(1)` 恢复后，BFT 重启成功但链不再前进。`coc_getBftStatus` 报告 `lastFinalizedHeight=H`；`eth_blockNumber` 返回 `H-1`。后续对高度 `H` 的 propose 被对端（同样处于脱节态）拒绝或 buffer，形成软死锁：`prepareVotes=1` 永不达成 quorum。

### 2.5 压测 worker 的 nonce 连带中毒

有毒 tx 隔离（见 3.1）上线后，任何让 `applyBlock` hang 的 tx 都被永久黑名单。压测 worker 只有单一 deployer 私钥；一旦 nonce=N 的 tx 被 poison，后续 nonce=N+1、N+2 … 全部无法入块（EVM 要求按序），因为前置 nonce 永远无法确认。worker 日志稳定出现 `multi:funded=0/3`、`batch_eth:0/5`、`deploy_fail`。

---

## 3. 已交付缓解措施

每个措施独立生效，不依赖后面的措施。

### 3.1 五层死锁恢复

多层防御：单层失败都不会让链无限死锁。

| 层 | 作用 | Commit |
|---|---|---|
| **内层 30 秒 `applyBlock` 超时**（onFinalized 内） | 把沉默 hang 转为可见的 `applyBlock timeout 30000ms` 错误 | `994f956` |
| **外层 75 秒 `work()` 超时**（onFinalized 外包一层） | 即使内层超时的 retry 路径也 hang，确保 onFinalizedQueue 一定前进 | `1289a0e` |
| **有毒 tx 隔离**（落盘持久化） | 标记失败 block 里尝试过的所有 tx；mempool 添加和 gossip 进入时拒绝 | `f20474a` + `3ac933a` |
| **`resetApplyingFlag()`** | 外层超时后强制清除 re-entrant applyBlock guard，下个 block 才能 apply | `9ace6f1` |
| **`process.exit(1)` + docker restart policy** | applyBlock/chain 状态脱节时从头重建 BFT 内存状态；退出前先把 poison set 落盘（`<dataDir>/poisoned-txs.txt`） | `2a26466` |

同时上线的诊断工具：

- `applyBlock` 内部 phase marker（hang 定位）: `2f9f7eb`, `76c0148`
- 退出前完整 `process.report.writeReport()` dump: `c214b3d`
- 原始 tx 字节 + block context dump（离线复现用）: `ee43505`
- 离线复现脚本: `90b0eb3`（`scripts/replay-hang-tx.ts`）
- 状态管理器并发压力测试套件: `b887a63`（`node/src/storage/state-race.test.ts`）

### 3.2 基于 wall-clock 的 slot 调度

`consensus.ts:tryPropose` 现在按链 tip 的 wall-clock slot 判定：

```
currentSlot = floor(Date.now() / blockTimeMs)
tipSlot     = floor(tip.timestampMs / blockTimeMs)
if (tipSlot >= currentSlot) return   // 当前 slot 已出过块
```

无论各节点 timer 相位如何错开，全网每 `blockTimeMs` 最多出 1 个 block。补丁后实测出块间隔：`[4, 2, 6, 4, 2, 3, 4, 2, 3]` 秒，均值 3.3 秒，无零间隔连发。Commit `9946a12`。

### 3.3 CORS origin 可配置

节点读取 `COC_CORS_ORIGIN` 环境变量，默认值 `http://localhost:3000`。`199.192.16.79` 上 `docker-compose.testnet.yml` 设置 `COC_CORS_ORIGIN=*`，让 `explorer.clawchain.io` 浏览器能拿到响应。（仅部署变更；无单独 commit。）

### 3.4 重启时 prefund guard + genesis stateRoot

`chain-engine-persistent.ts` 有两个 bug 在节点带已有 LevelDB 数据重启时暴露：

1. `init()` 无条件调用 `evm.prefund()`，往已填充的 state trie 上重写 genesis 余额，触发 `@ethereumjs/trie: Stack underflow`，让所有验证节点 crash 循环。
2. 多验证节点 genesis 路径创建 block 1 时没有 commit state trie 也没记录 `stateRoot`，导致 `eth_getBalance("latest")` 返回 0，任何账户都无法 fund 第一笔交易。

修复：先 load `latestBlock`；只在链空时 prefund；提交 state trie 并把 root 嵌入 block 1 的 `stateRoot` 字段。Commit `ac9c43e`。

### 3.5 压测 worker 使用多个 prefund 账户

在每个验证节点 config 的 `prefund` 列表里新增 3 个 Hardhat 账户（#3/#5/#6 → `0x90F7…`、`0x9965…`、`0x976E…`），各 1 000 ETH。cron worker 重构为按 round 索引轮换 5 个私钥（`KEYS[round % 5]`）。被 poison 的 tx 现在只卡住其归属账户的 nonce 链，不会拖垮整个压测工作负载。

验证：多账户压测 30 分钟监控窗口内产生 **0** 次 hang，对比单账户 48 分钟内 6 次 hang 的基线。

---

## 4. 根因调查

### 4.1 已排除的假设（附证据）

| 假设 | 反证 |
|---|---|
| `@ethereumjs/vm` `runTx` 有 bug | 10/10 捕获到的 hang-tx 在原版 VM 上跑 4–28 ms 全部成功（`scripts/replay-hang-tx.ts`）。 |
| libuv 线程池耗尽（classic-level I/O） | `UV_THREADPOOL_SIZE=32` vs 默认 4：hang 间隔没有显著变化（7.5 min vs 8 min）。 |
| PersistentStateManager 同地址写竞争 | `state-race.test.ts`：50 并发 `putAccount` 同一地址 47 ms 完成。5 种并发模式全部 pass（`b887a63`）。 |
| 单进程 chain engine 内部 race | `chain-concurrency.race.test.ts` A+B+C（tx + proposer + RPC 读）：30 秒 500 tx、5 751 blocks、61 k reads，无 hang。 |

### 4.2 调查过程中发现的潜在缺陷

`chain-concurrency.race.test.ts` 的 A+B+C+D 变体（额外并发模拟 gossip 重发已见 block）**不是 hang**，而是在 `chain-engine-persistent.ts:357` **抛出** `applyBlock re-entrant call detected`。现有所有 caller 都依赖外层 try/catch 吞下这个抛错：

- `consensus.ts` proposer 路径：降级到空 block
- `index.ts` P2P/wire `onBlock`：silent catch
- `index.ts` BFT `onFinalized`：log + `resetApplyingFlag()` 重试

这是 fail-fast 反应而非真正的互斥控制 —— 合法的并发调用者（proposer 还没结束 apply，gossip 因 BFT 重发又投递同一 block）无法排队等待。这个缺陷是配套工作项（5.1）的目标。

### 4.3 未解释的剩余部分：线上 hang 变体

测试网上表现是 *hang*，不是 throw。本地 fixture 还原不出这种 hang。目前最接近的假设是多个子系统同时参与：

- BFT 协调器广播投票
- Wire 协议 TCP 发送队列
- mempool 在 tx 执行期间被修改（gossip 到达 `runTx` 中途）
- WebSocket RPC 订阅扇出

尚无证据指向具体哪一对交互。退出前抓到的 `process.report` dump 显示 libuv 空闲（无 pending fs/db I/O）、hung Promise 无 JS stack —— 与"microtask chain 内部 resolution 丢失"一致，但不足以精确定位。

---

## 5. 未来调试计划

### 5.1 applyBlock queue 化串行（本次 session 进行中）

把 `applyingBlock` 的 re-entrant 抛错替换为 `PersistentChainEngine`（以及 `ChainEngine`）内部的 Promise-chain queue。每个 caller 的 `applyBlock()` 返回一个 promise，在前面已排队的 apply 完成后 resolve。这消除 4.2 的 API 设计缺陷，同时缩小 4.3 的 live-node hang 所利用的 race window —— 即使不能彻底消除 hang。

详细设计见配套 plan 文件。

### 5.2 活节点集成 fixture

本地 race test 只启一个 `PersistentChainEngine`。生产症状要求 3 个真实节点通过 wire TCP 交换 BFT 投票才能复现。下次迭代选项：

- 用 `scripts/start-devnet.sh 3` 进程内拉起 3 节点 devnet，单账户压测驱动，hang 检测触发 `process.on('uncaughtException')` + `setInterval` 堆快照
- 或直接跑测试网的 docker-compose devnet，`--publish-all` 暴露端口，attach Node inspector

### 5.3 把 `runTx` 隔离到 worker 线程

如果 5.2 后 hang 仍无法定位，把 `@ethereumjs/vm runTx` 每笔 tx 放到一个 `worker_threads` worker 里。主线程 `Worker.terminate()` 无论 microtask 状态如何都能可靠杀掉 hung worker。代价是每笔 tx 约 1 ms 的 worker 创建开销；测试网可接受，上生产前需实测评估。

### 5.4 向 `@ethereumjs/vm` 上游申报

如果 5.2/5.3 把问题定位到 runTx 内部 promise chain，对 `@ethereumjs/vm` 10.1.1 提交最小复现 bug 报告。今天无行动 —— 缺最小复现。

---

## 附录 A: Commit 索引

| Commit | 摘要 |
|---|---|
| `ac9c43e` | fix(node): prefund-on-restart crash + genesis stateRoot missing |
| `994f956` | fix(bft): timeout + per-call promise to prevent onFinalized deadlock |
| `1289a0e` | fix(bft): wrap entire onFinalized work() in 75s wall-clock timeout |
| `2f9f7eb` | diag(chain): add phase markers inside applyBlock for hang localization |
| `2a41831` | fix(evm): 15s timeout around @ethereumjs/vm runTx to prevent hangs |
| `76c0148` | diag(chain): extend phase markers to applyBlock entry DB reads |
| `f20474a` | fix(mempool): poison-tx quarantine for applyBlock-hanging transactions |
| `731633f` | fix(node): use imported keccak256 in onFinalized hot path |
| `9ace6f1` | fix(chain): force-clear applyingBlock guard after work slot timeout |
| `2a26466` | fix(bft): process.exit(1) + persistent poison on work slot timeout |
| `3ac933a` | fix(mempool): add missing loadPoisonedHashes method |
| `c214b3d` | diag(bft): dump full process report before exit on work slot timeout |
| `ee43505` | diag(bft): dump raw tx bytes + block context on work slot timeout |
| `9946a12` | fix(consensus): wall-clock slot alignment to cap block rate |
| `90b0eb3` | scripts(diag): offline replay harness for captured hang txs |
| `b887a63` | test(storage): concurrency stress tests for PersistentStateManager |
| `d2c81b3` | fix(explorer): contracts page slow/empty on public RPC — parallel + index-aware |
