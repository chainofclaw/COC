# Phase J — 共识自恢复死区（2026-05-05）

## 时间线

- **05-04 21:00 UTC**: 测试网在高度 206803→206804 停滞。症状：node-2（提议者）反复 `prepareVotes=1, buffered=0`；node-1 BFT 7+ 小时无活动；node-3 也不参与。三节点 RPC 均响应，每节点 P2P peer 数 = 2。严格 3/3 quorum 永远凑不齐。
- **05-05 04:00 UTC**: 调查会话开启，识别出 stateRoot 分叉：node-1 报告 block 206803 stateRoot 为 `0x2a248…`，而 node-2/3 报告 `0x3d3877…`。node-1 的 `state-snapshot` 日志显示**正确**的 `0x3d3877…` —— leveldb 块头被损坏但 EVM trie 是对的。
- **05-05 04:30 UTC**: 排除项: H1（post-apply parent-trie sync —— 仅在 apply 前运行）、H4（`onPeerQuorumDiverged` —— 需要 prepare votes 才能扫描，206804 一票都没收到）、H5（`forceSnapSync` —— 依赖 H4）、H15b stagger（仅在 `stuckProposer ≠ self` 时触发）。
- **05-05 04:46 UTC**: 手动恢复：停 coc-node-1，将 `leveldb-{chain,state}` 移至 `*.broken.20260505T0446Z`，重启。Node-1 从 node-2/3 snap-sync，导入 322 个账户至高度 206803。stateRoot 一致。
- **05-05 04:48 UTC**: node-1 恢复后 node-2 的 BFT round 仍卡死 —— 提议者内部 round 状态从未释放。重启 coc-node-2 → 链立刻恢复；60 秒内 +30 块，0 timeout。
- **05-05 之后**: Phase J 规划 + 实施。本文档涵盖 J1 + J2 + J3 + L.2 交付。

## 死区机制

### 死区 1 — H4/H5 需要 quorum 才能 fire

H4（`detectPeerQuorumDivergence`）与 H5（`forceSnapSync`）只在 BFT round timeout 路径运行（`bft-coordinator.ts:614-654`），扫描 prepareVotes 看是否有 ≥2/3 OTHER validator 在某个 (blockHash, stateRoot) 上达成一致而本节点不认。在严格 3/3 quorum 下：

- node-1 leveldb 损坏的状态导致 chain-engine 拒绝传入提案的 parent block 校验。
- BFT coordinator 从未收到合法的 block 来启动 round → 没有 `activeRound` → 没有 prepareVotes → `detectPeerQuorumDivergence` 扫一个空集 → 返回 null → H4 永不 fire → H5 计数器永不 tick。
- 即使 peer prepares 抵达，也只是堆在 `pendingMessages`（行 108）里被 H4 detect 路径完全无视。

**修复（J1）**: 直接从缓冲的 prepare 消息检测 divergence，并把 chain-engine 的 stateRoot mismatch 拒绝事件接到 snap-sync 触发器。

### 死区 2 — H15b stagger 让自卡 proposer 无路可走

`checkNoProgressWatchdog`（`consensus.ts:274-323`）在 `stuckProposerId === this.nodeId` 时立即 return（行 296），注释写"peers 会处理 override"。但 peers 的 override 只在 `getRoundState().active === false` 时 fire —— 而自卡 proposer 的协调器仍持有 active round（自身 prepareVote 唯一）。Peers 发新 propose；提议者 BFT 层把它当成自己 active round 的重复消息丢弃。结果：`docker restart` 是唯一出路。

**修复（J2）**: 当自身 IS stuck proposer 且 active round 存在且 elapsed > NO_PROGRESS_TIMEOUT_MS 时，调用新公开的 `bft.forceClearRound()`，让下个 propose tick 干净开始。节流到 NO_PROGRESS_TIMEOUT_MS（120s）以给 peers 投递新票留余地。

## 修复落地

| Sprint | 内容 | 文件 |
|---|---|---|
| **J1.1** | `BftCoordinator.tryEarlyDivergenceDetect` —— 每个缓冲的 prepare 都触发，不需要 round 处于 active。按 height 去重 + 1s 节流。 | `node/src/bft-coordinator.ts` |
| **J1.2** | 两个 engine 的 stateRoot mismatch 路径都加了 `cfg.onLocalApplyRejected` 回调。 | `node/src/chain-engine-persistent.ts`、`node/src/chain-engine.ts` |
| **J1.3** | `index.ts` 接线把新回调路由到 `consensus.requestSyncNow`。 | `node/src/index.ts` |
| **J2.1** | `BftCoordinator.forceClearRound(reason)` 公开 + 结构化日志。 | `node/src/bft-coordinator.ts` |
| **J2.2** | Watchdog 的自卡 proposer 分支 + `lastSelfClearRoundAtMs` 节流。 | `node/src/consensus.ts` |
| **J3** | `tests/multinode-integration/` —— docker-compose 集成测试 + 2 个故障注入场景。 | `tests/multinode-integration/` |
| **J4** | 5 个新单元测试（3 个 J1.1，2 个 J2.1，2 个 J2.2）。 | `node/src/bft-coordinator.test.ts`、`node/src/consensus.test.ts` |

## 验收结果

- **单元测试**: `bft-coordinator.test.ts` 22/22（含 5 新）；`consensus.test.ts` 21/21（含 2 新）；`chain-engine-persistent.test.ts` 26/26 不变。整个 node 层套件 1222/1224 通过；2 个失败（`Benchmark: 100 eth_call invocations`、`Block Production Throughput`）是 `docs/90-day-release-roadmap.zh-en.md` 第 47 行已记录的预存在性能 flake，与 J 无关。
- **类型检查**: `node --experimental-strip-types --check` 在所有修改文件上干净通过。
- **集成 fixture**: docker-compose 栈与场景测试已通过类型检查；活跑是 J3 manual lane（`docker compose up` + 场景 runner），将在下个专门会话运行 —— 视为公开测试网启动前的"Phase 3 Verification" gate。

## 副线交付（Week 8/9 对齐）

- **K.1 — economics-v1 文档**: `docs/economics-v1.{en,zh}.md` 冻结测试网 block reward（2 COC 初值，4 年减半）、EIP-1559 手续费分配（priority fee → 提议者）、等价签名 slashing（测试网 100% 比例，1000 块冷却）、Treasury/InsuranceFund 路由（测试网默认 100/0）。
- **K.2 — rollout 操作手册**: `docs/operators/economics-rollout.zh-en.md` 记录策略 A 协调原子翻转、各功能验收窗口、回滚流程。
- **L.1 — skills v0.2 spec**: `docs/openclaw-skills-v0.2-spec.md` 冻结 `pose-status` / `chain-stats` / `health` / `upgrade` 的 contract（CLI、JSON schema、exit code、error envelope）。
- **L.2 — pose-status 骨架**: `extensions/coc-nodeops/skills/pose-status/` 提供标准参考实现，3/3 单元测试通过。

## 建议

- 退出 Phase 2（Week 8 末）前，每周用专属 CI runner 跑 J3 fixture（独立 lane，PR 不阻塞）。这些场景是目前唯一能证明 J1+J2 能阻止下一次 2026-05-05 的东西。
- 在 K.1 § 8 待定问题被治理 close 后排期 I1 / I2 原子翻转（K.2 策略 A）—— 目标 2026-05-18。
- L.1 spec 经 OpenClaw plugin reviewer 审议前，**不要**发布 `chain-stats` / `health` / `upgrade`；`schemaVersion: "0.2"` envelope 是公开 contract。
- 生产环境保持 `COC_DEV_RELAXED_QUORUM=0`。Phase H/J 都围绕这个不变量设计。
