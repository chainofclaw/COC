# 测试网去中心化能力分析：核心节点停机后的可用性 / Testnet Decentralization Analysis: Survivability After Core-Node Shutdown

**Date / 日期**: 2026-05-06
**Audience / 对象**: 测试网运营、外部接入运营方、roadmap 规划 / Testnet ops, external operators, roadmap planning
**Question / 问题**: 按照当前部署模式，当网络自建节点逐渐增多时（10-20 个），停掉核心节点，整个测试网能够继续不间断运行？/ In the current deployment model, as self-built nodes grow to 10-20, can the testnet keep running uninterrupted if the core nodes are stopped?

---

## 1. 直接结论 / Direct Conclusion

**中文.**
**今天的答案是否定的。** 即使外部运营方运行了 10、20、甚至 100 个 self-built 节点，停掉当前 3 个核心 native validator 之后，链会立即停止出块。原因是 BFT 共识的 validator 集合是一个**固定的 3 地址白名单**（写在 `/etc/coc/node-N.json` 的 `validators` 字段里），而 self-built 节点默认是 **observer（不参与投票）**。链 = quorum 投票 = validators 集合，与"运行的节点数量"完全解耦。

**English.**
**The answer today is no.** Even if external operators run 10, 20, or 100 self-built nodes, stopping the three current core native validators will halt block production within one round. BFT consensus is anchored on a **fixed 3-address validator allowlist** (the `validators` field in `/etc/coc/node-N.json`); self-built nodes default to **observer (non-voting)**. Liveness is a property of the validator set, not of the peer count.

---

## 2. 架构事实 / Architectural Facts

### 2.1 谁能投票，谁不能 / Who Can Vote, Who Cannot

- **BFT 投票成员** = `validators` 数组里出现的地址。当前 3 个：`0xf39fd6e5...`、`0x70997970...`、`0x3c44cdddb6...`，每个 stake=100，total stake=300。
- **外部 self-built 节点**（包括 sync-node、light peer、未来的 10-20 个 social-built 节点）= **observers**：可以同步块、查询 RPC、参与 P2P / IPFS 转发，但 **不签名 prepare / commit 消息**，BFT round 看不到它们的投票。
- **代码位置**：`node/src/bft-coordinator.ts` 在每个 round 用 `cfg.validators.map(...)` 快照 quorum 计算用的成员；`hasQuorum()` 比较的是已投票成员的 stake 之和与 `quorumThreshold(validators, relaxedQuorum)`。

### 2.2 当前 quorum 阈值 / Current Quorum Threshold

| 模式 | 公式 | 3-validator @ 100 stake 各 |
|---|---|---|
| 标准 BFT (`COC_DEV_RELAXED_QUORUM=0`) | `(2n)/3 + 1` | 201 stake → 必须 **3/3** |
| 放宽 (`COC_DEV_RELAXED_QUORUM=1`，当前测试网） | `(2n)/3` | 200 stake → 2/3 |

**结论 1**：放宽模式下，**容忍 1 个 core 离线**。停掉 2 个 core → quorum 凑不齐 → 停链。
**结论 2**：标准模式下，**任何 1 个 core 离线就停链**。

### 2.3 为什么观察者节点帮不上 / Why Observers Don't Help

- BFT 消息（prepare/commit）只在 `validators` 集合内部聚合 stake；observer 即使发了 prepare，`pickWinningVoteGroup` 不把它们计入 quorum。
- observer 没有 validator key（`COC_NODE_KEY` 不在 `validators` 列表中），它们的签名 BFT 协议根本不接受。

---

## 3. 已存在但未启用的机制 / Mechanism Available But Not Enabled

`node/src/config.ts:168` 已经定义了 `validatorRegistryAddress` 字段，配合 `runtime/lib/validator-registry-reader.ts` 可以在 BFT 运行时根据**链上合约状态**动态更新 validator 集合：

```typescript
validatorRegistryAddress?: string  // ValidatorRegistry contract address
```

合约设计意图（Sprint 4 of Phase F+G）：on-chain ValidatorRegistry 维护活跃 validator + stake；reader 监听 add/remove 事件；自动调用 `BftCoordinator.updateValidators` 切换集合。

**但是**：
- 该合约**今天没有部署**（`contracts/governance/` 目录里没有 `ValidatorRegistry.sol`，只有 SoulRegistry / DIDRegistry / CidRegistry）。
- 测试网 config 里没有 `validatorRegistryAddress`，`ValidatorRegistryReader` 没有启动 → 集合永远是 JSON 里的 3 个地址。

---

## 4. 让链能扛核心宕机的工程化路径 / Engineering Path to Survive Core Shutdown

### 4.1 必要条件 / Necessary Conditions

要做到"停掉 core 后链继续不间断运行"，需要同时满足：

1. **多运营方 validator 集合**：≥7 个验证者来自 ≥4 个独立运营方
2. **stake 分布**：单一运营方 stake < 1/3 total（否则 = 单一信任根）
3. **集合可动态更新**：onboard / offboard 不需要全网 hard fork
4. **验证者身份认证**：拒绝伪造身份的 byzantine 加入
5. **Slashing + auto-rotation**：长期离线的 validator 自动出局，被替换

### 4.2 阶段化实施（Phase X 系列）/ Phased Rollout (Phase X Series)

#### Phase X1 — 外部 validator 接入（manual onboard）

- 邀请 4 个独立运营方各跑 1 个 validator（共 7 验证者 = 3 core + 4 external）
- 每个新 validator 走线下流程：生成 key → 提交地址 → 修改 testnet 集中维护的 `validators` JSON → 滚动 systemctl restart 一遍验证集合
- relaxed quorum @ 7 = `(2×7)/3` = 4 stake → 容忍最多 3 个静默
- **达成"停掉 3 core 后剩 4 external 仍能 quorum"**
- 工作量：2-3 周（招募 + onboarding 文档 + 第一次实测）

> **2026-05-06 实测结果**：✅ Phase X1 完成。基础设施 + 代码修复 + 实战演练全部通过（详见 `docs/phase-x1-drill-2026-05-06.zh-en.md`）。Drill v4 在 04:42 UTC 演示了"停掉 3 cores 后链继续"——ext-1 在 H15 watchdog 超时（180 s）后接管 proposer 角色，于 04:42:26 finalize 了 height 212668，期间 3 个 native validator 全部 inactive。修复关键：commit `ad89a2f` 把 `expectedProposer` 的比较从 strict `!==` 改为 `.toLowerCase() !== .toLowerCase()`，因为外部 validator 的 nodeId 是 EIP-55 checksumed (mixed-case) 但 `validators` 数组是 lowercase。Phase X2 (ValidatorRegistry 合约) 可以无阻塞启动。

#### Phase X2 — 部署 ValidatorRegistry 合约

- 实现 `contracts/governance/ValidatorRegistry.sol`：
  - `addValidator(address, stake)` (governance-multisig 权限)
  - `removeValidator(address)` (governance + 自动 slash 触发)
  - `updateStake(address, newStake)`
  - 事件：`ValidatorAdded` / `ValidatorRemoved` / `StakeUpdated`
- 部署到测试网，把合约地址写入 `validatorRegistryAddress` 配置
- 启用 `ValidatorRegistryReader`（已实现）
- 后续 onboard 走链上 tx，不再修 JSON，**不需要全 cluster 重启**
- 工作量：1-2 周（合约 + 测试 + 文档）

> **2026-05-06 实测结果**：⚠ 部分完成。合约 + reader + tests 全部 Phase F+G Sprint 3-4 已 land；本会话部署到 testnet (`0x162700d1613DfEC978032A909DE02643bC55df1A`，block 212676)，详见 `docs/phase-x2-deploy-2026-05-06.zh-en.md`。1 个 core (node-1) 成功 staked；reader 端到端验证通过——日志 `BFT validator set updated from ValidatorRegistry count=1`。其余 2 个 core 的 stake tx 因 mempool stuck-nonce 残留未确认，是运维问题不是架构问题。下次 session 清完 stuck txs 后即可完成 X2.4-X2.5。

#### Phase X3 — Stake 分布与权重调整

- 减小 core validator 的相对 stake（例如 core 各 100 → 各 50；4 个 external 各 75）
- 总 stake 调整后单一运营方 < 1/3 ≈ 33%
- 工作量：1 周（设计 + 调整 + 验证 quorum 仍合理）

#### Phase X4 — Slashing + Auto-Rotation

- Phase I 已实现 slashing 半成品（equivocation evidence + auto slash relayer）
- 需要补：**长期 inactivity 也触发 slash + remove**（ValidatorRegistry 自动剔除连续 N 个 epoch 不响应的 validator）
- 工作量：1-2 周

#### Phase X5 — 真实"停核心"演练

- 三个 core 同时 systemctl stop（保留 leveldb 但进程下线）
- 观察 4 个 external validator 是否继续出块
- 观察链是否在 ≤30s 内 recover（external 形成 quorum 4/4）
- 出 incident report：包含 BFT round 数 / 链高度推进图
- 工作量：1 周（含报告）

**总工作量**：6-8 周。可与 Day-90 测试网公开窗口（2026-06-13）对齐。

### 4.3 中间状态：Phase X1 单独完成 vs 全 X 完成 / Intermediate States

| 部署状态 | 停 1 core | 停 2 core | 停 3 core | 备注 |
|---|---|---|---|---|
| **今天（3 core, relaxedQuorum）** | ✅ 链继续 | ❌ 链停 | ❌ 链停 | 自建节点数量无关 |
| **Phase X1 完成（3 core + 4 external）** | ✅ | ✅ | ✅ | 4 external > quorum 4 |
| **Phase X1+X2 完成** | ✅ | ✅ | ✅ + on-chain governance | 验证者 onboard 不再 hardcode |
| **Phase X1+X2+X3 完成** | ✅ + 拜占庭安全 | ✅ | ✅ | stake 分散，无单一信任根 |

---

## 5. 风险与降级 / Risks and Descope

| 风险 | 触发 | 降级 |
|---|---|---|
| 外部 validator 招募失败 | Day-60 前不到 4 家 | 推迟 X 系列；core 仍负责出块；外部仅做 observer |
| ValidatorRegistry 合约 bug | X2 部署后 add/remove 异常 | 回退 hardcode JSON 集合；走 X1 + 手动 onboard |
| Stake 重新分配后 core 不愿降权 | 单 org 治理博弈 | 先做 X1，X3 推迟到 Phase X' |
| 4 external 中 ≥2 同时离线 | 概率事件 | quorum 仍由 3 core 维持；触发监控告警 |
| Slashing 误伤 honest validator | bug | 关闭 auto-rotation，改为手动复核 |

**回滚预案**：每个 X 阶段独立可回滚（删除合约调用、改回 JSON、systemctl restart）。最差情况退到今天的 3-core 拓扑。

---

## 6. 与 90-day Roadmap 的对齐 / Alignment with 90-day Roadmap

- Day 60 Gate (`docs/90-day-release-roadmap.zh-en.md` §6.1) 已要求"邀请制 beta 上线，10-20 节点，至少 3 个独立运营方"。该文今天的解读偏重 **节点数量**，但本文澄清 quorum 真正决定可用性的不是节点数而是**独立 validator 数**。
- 建议把 Day 60 描述更新为 **"≥3 独立运营方各运行 ≥1 个 validator（不是 observer）"**。
- Phase X 系列与 90-day-roadmap §5.7.2 的降级序列兼容：如果 X1 滑移，Day-90 仍可发布"邀请制 testnet（带不可持续性警告）"，主网延期。

---

## 7. 对外说明（公开测试网通告时使用） / External Messaging Template

> 当前 Prowl 测试网 v1（Day 90 之前）的 validator 集合由 ChainOfClaw 团队运营的 3 个核心节点维护。外部运营方运行的 self-built 节点是**观察者节点**，不参与共识投票，因此核心节点宕机将暂停链推进。我们计划在 Day 60 之后逐步将 4-7 个独立运营方的 validator 加入集合（Phase X 系列），届时停掉核心节点后链将继续运行。**今天请将 Prowl 视为 invited beta，不要将其当作生产环境数据源**。

> The current Prowl testnet v1 (pre-Day-90) is maintained by three core validators run by the ChainOfClaw team. External self-built nodes participate as **observer nodes** — they do not vote on consensus, so a stop of the core nodes pauses block production. We are scheduling 4-7 independent-operator validators to join the consensus set after Day 60 (Phase X series), at which point core-node downtime will no longer halt the chain. **Today, treat Prowl as an invited beta; do not use it as a production data source.**

---

## 8. 总结 / Summary

- **现状**：链的可用性由 **3 个 core validator** 决定，与"自建节点数量"无关。停掉 cores → 链停。
- **代码已具备但未启用**：on-chain ValidatorRegistry 接口（`validatorRegistryAddress` + reader）。需要补合约 + 部署。
- **要让外部节点能维持链**：必须把它们升级为 **validator**（投票成员），不只是 observer。
- **可工程化路径**：Phase X1-X5，6-8 周，可与 Day-90 公开测试网窗口对齐。
- **一句话**：节点数量提供 **观察可用性**（RPC / IPFS），validator 数量与多运营方分布提供 **共识可用性**。两者完全独立。

---

## 9. 引用 / References

- `node/src/bft-coordinator.ts` — quorum + validator 集合应用点
- `node/src/bft.ts:95-109` — quorumThreshold 公式
- `node/src/config.ts:160-174` — validatorRegistryAddress 字段（未启用）
- `runtime/lib/validator-registry-reader.ts` — 链上 reader（已实现）
- `docs/90-day-release-roadmap.zh-en.md` — Day 60 / 90 退出条件
- `docs/testnet-status-report-2026-05-06.zh-en.md` — Day 90 P0 清单（外部 validator 接入是其中之一）
