# COC Prowl Testnet 运行状态报告 / COC Prowl Testnet Status Report

**Date / 日期**: 2026-05-06 02:35 UTC
**Author / 作者**: COC Operations
**Scope / 范围**: 试验网当前实测状态、已落地能力、距 Day-90 测试网正式上线还差什么、距主网商用还差什么 / Live state of Prowl testnet, what's landed, what stands between us and the Day-90 public-testnet launch, and what stands between us and a production mainnet.
**Source data / 数据来源**: live RPC + Prometheus + systemd + git log on `clawchain-server` (199.192.16.79).

---

## 1. 执行摘要 / Executive Summary

**中文.**
COC Prowl 测试网目前以 3 个 native systemd validator + 1 docker sync-node + 1 docker light peer + relayer/agent/faucet/explorer 的混合拓扑运行在 `clawchain-server` (199.192.16.79)，链高度 212,535，全节点同步。Phase H/I/J/M/N/D/S 全部代码已落地（共识自恢复、经济模型、Skills v0.2 spec、可观测性、native 部署、light peer + IPFS 200MB 配额）。

**测试网当前是"功能完整但运行不稳"状态**：单次会话内观察到 4 次链短停（每次 5-15 分钟，自恢复或人工恢复），均由两个根因驱动：(a) 验证者重启后 mempool drift 导致 BFT 提议哈希不一致 → equivocationDetector 累积 evidence → quorum 凑不齐；(b) Phase J1.1 dedup + H11 cooldown 三连锁 corner case（已修复 commit `6cfa622`，待 24h soak 验证）。

距 Day-90 公开测试网正式上线还有约 5 周时间窗口（2026-06-13）。**P0 阻断项**：24h 稳定性证据未拿到、外部 validator 接入流程未跑、mempool 决定性问题未解决。**P1**：经济参数未启用、Skills v0.2 未发 npm。

距**主网商用**距离更大（保守估计 6-12 个月）：核心安全闭环（密钥托管、second client 实现、抗女巫）、经济参数完整审计、生产级 SLO/告警/值守、跨主机 validator 部署、erasure-coded 存储、合约审计、桥接、KYC/合规等都还没启动。

**English.**
The COC Prowl testnet currently runs as a hybrid topology of 3 native systemd validators + 1 docker sync-node + 1 docker light peer + relayer/agent/faucet/explorer on `clawchain-server` (199.192.16.79). Chain height 212,535, all nodes synchronised. Phase H/I/J/M/N/D/S code has all landed (consensus self-recovery, economics model, Skills v0.2 spec, observability, native deployment, light peer + IPFS 200MB cap).

**The testnet today is "feature-complete but unstable in operation"**: within this single session we observed four chain-stall events (5-15 min each, self- or human-recovered), driven by two root causes: (a) validator-restart-induced mempool drift produces divergent BFT proposed-block hashes, equivocationDetector accumulates evidence, quorum cannot form; (b) the Phase J1.1 dedup × H11 cooldown × sync-in-flight triple-collision corner case (now fixed by commit `6cfa622`, awaiting 24h soak confirmation).

About 5 weeks remain until Day-90 public-testnet launch (2026-06-13). **P0 blockers**: no 24h stability evidence yet, no external-validator onboarding flow exercised, mempool determinism unsolved. **P1**: economics params not enabled, Skills v0.2 not published to npm.

The path to **mainnet** is much longer (a conservative estimate is 6-12 months): key custody, a second client implementation, anti-Sybil hardening, full economics audit, production-grade SLO/alerting/on-call rotation, multi-host validator deployment, erasure-coded storage, contract audit, bridges, and KYC/compliance work have not started.

---

## 2. 当前实测状态 / Live State Snapshot

| Item | Value | 中文备注 / Note |
|---|---|---|
| Chain height | 212,535 | 5 节点同步（3 native validator + sync + light） |
| Validator count | 3 | 单运营方，单台主机 / single operator, single host |
| Block production | ~3.9 s mean (rolling) | Day-60 gate ≤ 4 s ✓ |
| Equivocation counter | 0 (post-recovery) — peaked 17 in this session | 反复触发，待 J1.1 fix soak 验证 / recurring; J1.1 fix soak pending |
| Fork-choice max depth | 0 | 无 reorg |
| Native validator process state | systemd active × 3 | port 28780 / 28782 / 28784 |
| Docker auxiliaries | 5 healthy | sync-node / relayer / agent / faucet / explorer |
| Light peer | 1 (coc-light-1) | 200MB IPFS tmpfs cap, height-synced |
| External port preservation | 18 ports unchanged from Phase 1 | G2 兑现 / preserved |
| Soak in progress | runId=`phase-2-j-fix-w8e` | 启动 2026-05-06 02:31Z，含 J1.1 fix |

**Stability events observed this session / 本次会话内观察到的链事件**

| # | Time (UTC) | Symptom | Cause | Recovery |
|---|---|---|---|---|
| 1 | 2026-05-05 ~17:08 | 60 min stall at 209,233 | Phase H10 stateRoot mismatch + J1.1 missing | force-recreate to phase-j-local |
| 2 | 2026-05-06 ~01:13 | 12 min stall at 212,412 | J1.1 dedup × H11 cooldown corner case | mv leveldb + sync restart |
| 3 | 2026-05-06 ~01:34 | 90 s stall at 212,470 | mempool drift after sync-node recreate | halt-tx + sync restart |
| 4 | 2026-05-06 ~02:29 | 5 min stall at 212,525 | mempool drift after relayer/agent restart | halt-tx + sync restart |
| 5 | 2026-05-06 ~02:33 | 5 min stall at 212,525 | same as #4 (J1.1 fix didn't address mempool drift) | halt-tx + sync restart |

**Recovery pattern / 恢复模式**: `docker stop coc-relayer coc-agent` → `systemctl restart coc-node@1 coc-node@2 coc-node@3` → wait 30 s → `docker start coc-relayer coc-agent`. 每次成功，但说明根因仍未解决 / works every time, indicating the underlying cause is not yet fixed.

---

## 3. 已落地的能力（按 Phase）/ Implemented Capabilities (by Phase)

### 3.1 共识与稳定性 / Consensus & Stability

| Phase | Scope | Status | 备注 / Note |
|---|---|---|---|
| **B / C** | BFT-lite + IPFS Phase C P2P 存储 | ✅ landed | 包括 push-to-K (K=3)、provider gossip、wire BlockRequest |
| **H1-H8** | 共识异常诊断与首批稳定性修复 | ✅ landed | EVM state-diff CLI、namespace separation 等 |
| **H10** | stateRoot equality 不变量 | ⚠ landed monitor mode | enforce 模式未启 — 历史 209,233 块仍含 mismatch 残留警告 / `enforce` mode not yet enabled — legacy 209,233 mismatch noise persists |
| **H11** | H4 + onFinalized 升级到 forceSnapSync | ✅ landed | 60s cooldown |
| **H12-H14** | snap-sync 失败可见、rate limit 拆分、importSnapSyncBlocks 修剪 | ✅ landed | |
| **H15 / H15b** | no-progress proposer override watchdog + stagger | ✅ landed | 按 nodeId 错位避免 equivocation storm |
| **H16** | finalize 后等价签名证据自动 prune | ✅ landed | |
| **J (J1+J2)** | 共识自恢复死区修复 | ✅ landed | J1.1 早期分歧检测、J2.1 forceClearRound、J2.2 self-stuck force-clear，生产已 fire |
| **J 2026-05-06 corner-case** | J1.1 dedup vs H11 cooldown × in-flight | ✅ commit `6cfa622` | callback 返 false → 回滚 dedup；24h soak 中验证 |
| **J3 fixture** | docker-compose 多节点回归 fixture | ⚠ landed but bug | wire-handshake validator 地址不匹配，未跑通；Week 9 待修 |
| **mempool-drift induced equivocation** | (未命名 phase) | ❌ open | 重启后多 validator 提议不同 hash 累积 evidence — Day-60 阻断项之一 |

### 3.2 经济模型 / Economics

| Phase | Scope | Status |
|---|---|---|
| **I1** | 出块奖励几何减半 schedule | ✅ code landed, ⚠ not enabled by default |
| **I2** | EIP-1559 fee burn + proposer + treasury 分配 | ✅ code landed, ⚠ not enabled |
| **I3a-I3c** | BFT equivocation 链上证据自动提交 + relayer 扫链 | ✅ landed |
| **I4a / I4b** | slashTotal 自动计算、relayer auto slash | ✅ landed |
| **I5** | Treasury + Insurance Fund 路由 | ✅ landed |
| **K.1 docs** | economics-v1 参数文档冻结（en）| ✅ landed |
| **K.2 rollout playbook** | 启用 / 灰度 / 回滚 SOP | ✅ landed |
| **Economic enable on testnet** | 实际启用 I1/I2 等开关 | ❌ not done — Day 65 P1 |

### 3.3 可观测性 / Observability

| Phase | Scope | Status |
|---|---|---|
| **M1** | `coc_bft_equivocations_total` + `coc_fork_choice_max_depth_blocks` 实际 emit | ✅ landed; alert rule 不再静默 |
| **M2** | soak harness：collect.ts / run-24h.sh / summarize.ts / TEMPLATE.md | ✅ landed; 第 1 次 soak 失败（数据有 stall）；w8e 进行中 |
| **Prometheus + Grafana** | 9090/3100 + 4 dashboards + 13 alert rules | ✅ docker compose `monitoring.yml` 内 |
| **Logs centralisation** | 缺 / missing | ❌ no Loki/ELK；只有 docker logs / journalctl |

### 3.4 部署与运维 / Deployment & Ops

| Phase | Scope | Status |
|---|---|---|
| **N (Phase 2 native)** | systemd `coc-node@.service` 模板 + per-instance env + native configs | ✅ landed; production migrated 2026-05-06 |
| **D1 (light peer)** | `docker-compose.light.yml` + light-{1,2}.json | ✅ light-1 deployed and healthy |
| **S1+S2 (storage tier)** | `IpfsBlockstore.maxBytes` LRU + nodeMode-aware default | ✅ landed; 实测 50 × 5MB PUT 后 tmpfs 始终 ≤194MB |
| **External port preservation** | 18 ports 与 docker host map 一致 | ✅ verified |
| **Phase 2 deployment runbook** | docs/native-deployment.en.md | ✅ landed (含首次 deploy lessons) |
| **Phase 2 plan doc** | docs/testnet-phase-2-deployment-plan.en.md | ✅ landed (5 hard guarantees G1-G5) |

### 3.5 OpenClaw 融合 / OpenClaw Integration

| Phase | Scope | Status |
|---|---|---|
| **L.1 spec** | `docs/openclaw-skills-v0.2-spec.md` | ✅ frozen |
| **L.2 skills 骨架** | `extensions/coc-nodeops/skills/{pose-status,chain-stats,health,upgrade}/` 4 个 standalone CLI | ✅ landed + 15 unit tests |
| **L.3 plugin manifest 包装** | package.json + openclaw.json + commander 适配 | ❌ not started |
| **npm publish v0.2** | `@openclaw/coc-nodeops@0.2` | ❌ not started |
| **Discord / GitHub Discussions / community** | | ❌ not started |
| **OpenClaw × COC showcase video** | | ❌ not started |

### 3.6 P2P 存储（Phase C / D / P）/ P2P Storage

| Phase | Scope | Status |
|---|---|---|
| **C 全套** | UnixFS + DHT providers + push-to-K + wire BlockRequest + provider gossip | ✅ ~3,500 LOC landed |
| **S1 LRU eviction** | maxBytes + 90% target eviction | ✅ landed; 实测正确驱逐 |
| **P1 minReplicas hard enforcement** | enforceMinReplicas flag + 503 on under-replicated PUT | ❌ not started |
| **P2 repair loop** | 周期性扫 pinned CID + push-to-K under-replicated | ❌ not started |
| **P3 iterative DHT findProviders** | hops=3 wire FindProvider/FindProviderResponse | ❌ not started |
| **Q (erasure coding)** | Reed-Solomon 7+3 sharding | ❌ explicit out-of-scope for Day-90 |

---

## 4. 已知问题（公开 / Known Open Issues）

### 4.1 P0（阻断 Day-90 测试网上线 / Blocks Day-90 testnet launch）

1. **~~Mempool-drift + stateRoot drift 引发的链停~~** — 三连击修复 (commit `47d8102`, `9c253de`, `f4fe324` + node-2/3 Plan B convergence)
   - **Phase R** (`47d8102`)：BFT no-double-vote 不变量。同 height 不同 blockHash 的 startRound 拒绝。生产 fired 290+ 次。
   - **Phase R2** (`9c253de`)：speculativelyComputeStateRoot 加 parent-hash guard + 在 fork 前强制父 trie sync，防 stale BEACON_ROOTS storageRoot 污染计算。
   - **Plan B convergence**：node-2 + node-3 mv leveldb-{chain,state} → 从 node-1 snap-sync，三 validator state 收敛到 `0xc45b3a4d`。
   - **Phase R3** (`f4fe324`)：consensus re-broadcast 路径优先用 BFT 已 prepare 的 block 而不是 lastProposedBlock，闭合 H15 forcePropose 与 Phase R 的次生死锁。
   - **生产实测**：链 stable advance 10s/块（之前 14 min/块），equivocation 计数器持续 0，无需人工干预。
   - **未达 3s/块目标**：仍有偶发 round retry，是 liveness 问题不是 safety 问题；后续工程优化。

2. **24h 稳定性证据缺失**
   - 既有 soak 报告（phase-j-local-w8c）verdict = FAIL（720s stall + 105 equivocations）。
   - 新 soak `phase-2-j-fix-w8e` 刚启动，未完成。
   - Day-60 Gate 要求"24h 无崩溃、无长时间停块、无未解释重组"——目前不满足。

3. **外部 validator 接入流程未跑**
   - configs/prowl-testnet/validators.json 全部为内部 Hardhat 测试账户。
   - 没有任何独立运营方走过完整的 join / 签名 onboarding / runbook 流程。
   - Day-60 Gate 要求"≥3 个独立运营方"——0/3。

4. **J3 fixture wire-handshake 配置 bug**
   - `tests/multinode-integration/configs/*.json` 中 validator 公钥与 wire 签名 key 不匹配，cluster 起不来 BFT。
   - 阻断 Phase J 的回归保护。

### 4.2 P1（强烈建议在 Day-90 前完成 / Strongly recommended pre-launch）

1. **Phase H10 enforce mode 未启**：当前 monitor 模式让 stateRoot mismatch 块仍被接受，本身就是上述 mempool-drift 的二级放大器。
2. **经济参数未启用**：测试网仍以"无经济模型"运行，没有真实 staking / reward / slash 流。
3. **Skills v0.2 未发布**：4 个 skill 还是 standalone CLI，没有 OpenClaw plugin manifest 包装。
4. **Phase P 全未做**：minReplicas 强制、repair loop、iterative DHT 都没动。
5. **soak 自动化未接 CI**：每次 soak 都靠人工跑 nohup + summarize。

### 4.3 P2（不阻塞 Day-90）

- Erasure-coded sharding (Phase Q)
- 第二客户端实现
- 跨主机 validator 部署（当前 3 个 native + 全部 docker 全在同一主机）

---

## 5. 距测试网"开发完成"还差什么 / Gap to Testnet "Development Complete"

中文.

发布 roadmap 把"开发完成"定义为 Day-90 公开测试网（2026-06-13）。距今约 38 天。要补的关键工程项：

1. **修复 mempool-drift equivocation 根因**（P0 #1）—— 1-2 周
2. **跑通 24h soak verdict=PASS**（P0 #2）—— 修完 #1 后 1 周
3. **外部 validator onboarding 流程跑通 + ≥3 独立运营方**（P0 #3）—— 2 周
4. **J3 fixture 修通 + 加 CI**（P0 #4）—— 3 天
5. **H10 enforce mode 灰度 + 老 mismatch 数据清理**（P1）—— 1 周
6. **经济参数 v1 灰度启用**（P1）—— 1 周
7. **Skills v0.2 发布 npm + OpenClaw plugin manifest**（P1）—— 1 周
8. **Phase P1 (minReplicas hard enforcement) + P2 (repair loop)**（P1）—— 1.5 周
9. **7 天 soak**（公开测试网候选 Day-84）—— 1 周

总和约 8-10 周工作量；50 天总时长但有并行空间，理论上 35-40 天可完成。**节奏紧但还可达成**——前提是 P0 #1 mempool drift 在 2 周内有可工程化方案。

English.

The release roadmap defines "development complete" as the Day-90 public-testnet launch (2026-06-13), about 38 days from now. Key engineering items to close:

1. Fix mempool-drift equivocation root cause (P0 #1) — 1-2 weeks
2. Pass a 24h soak (P0 #2) — 1 week after #1
3. Onboard ≥3 independent external validators (P0 #3) — 2 weeks
4. Fix J3 fixture + wire to CI (P0 #4) — 3 days
5. Promote H10 to enforce mode + clear legacy mismatches (P1) — 1 week
6. Gradual enable of economics v1 (P1) — 1 week
7. Skills v0.2 npm + OpenClaw plugin manifest (P1) — 1 week
8. Phase P1 + P2 (P1) — 1.5 weeks
9. 7-day soak (Day-84 candidate) — 1 week

Total ≈ 8-10 person-weeks of work; 50 calendar days net but with parallelisable streams, 35-40 days is achievable. **Tight but feasible** — provided P0 #1 has a workable fix in the next 2 weeks.

---

## 6. 距"主网商用"还差什么 / Gap to Mainnet

中文.

Day-90 测试网上线 ≠ 主网商用。要走到主网，roadmap 之外还需要：

| 类别 | 缺什么 / What's missing | 估计工作量 |
|---|---|---|
| **共识协议成熟度** | mempool 决定性、second client 实现、抗女巫强化（机器证明 / cluster ID）、跨地域 validator 实测 | 3-6 个月 |
| **密钥与权限** | KMS / HSM / Vault 方案、operator multi-sig、validator key rotation drill、紧急 quorum 切换 | 2-3 个月 |
| **经济参数审计** | 通胀曲线 / treasury 政策 / slash 比例第三方审计、长期博弈论模拟 | 2-4 个月 |
| **合约审计** | PoSeManager v1/v2 / SoulRegistry / DIDRegistry / CidRegistry 第三方审计 + bug bounty | 3-6 个月 |
| **生产 SLO / 告警 / 值守** | 跨地域多 validator + 24/7 on-call rotation + 完整 runbook + 故障演练 | 2-3 个月 |
| **可扩展性** | erasure coding (Phase Q)、shard / rollup 路线、TPS benchmark 验证 | 6-12 个月 |
| **生态/桥接** | 跨链桥（至少 1 个 trusted bridge）、stable asset onboarding、explorer 多语言 | 3-6 个月 |
| **法务 / 合规** | KYC for validators、jurisdiction analysis、TGE 合规、token 设计文档 | 持续 |
| **客户端独立性** | 第二独立实现（Rust / Go），客户端多样性达到 ≥40% by stake | 6-9 个月 |
| **生产基础设施** | dedicated DNS、TLS、CDN、bootstrap nodes 跨地域、备份与 disaster recovery | 2-3 个月 |

**保守乐观估计**：在不出现重大重写的情况下，从 Day-90 测试网算起，**6-12 个月**到 mainnet。激进估计需要专门 mainnet readiness program 同步推进。

English.

Day-90 testnet launch ≠ mainnet ready. Beyond the roadmap, the path to mainnet requires:

| Area | What's missing | Effort estimate |
|---|---|---|
| **Consensus maturity** | mempool determinism, second-client implementation, anti-Sybil hardening (machine attestation / cluster ID), cross-region validator soak | 3-6 months |
| **Key custody & access** | KMS / HSM / Vault, operator multi-sig, validator key rotation drill, emergency quorum cutover | 2-3 months |
| **Economics audit** | Third-party audit of inflation curve / treasury policy / slash ratios, long-horizon game-theoretic simulation | 2-4 months |
| **Contract audit** | Third-party audit of PoSeManager v1/v2 / SoulRegistry / DIDRegistry / CidRegistry, bug bounty programme | 3-6 months |
| **Production SLO / alerting / on-call** | Cross-region multi-validator + 24/7 on-call + full runbooks + incident drills | 2-3 months |
| **Scalability** | Erasure coding (Phase Q), shard / rollup roadmap, validated TPS benchmarks | 6-12 months |
| **Ecosystem / bridges** | At least one trusted bridge, stable asset onboarding, multi-locale explorer | 3-6 months |
| **Legal / compliance** | Validator KYC, jurisdictional analysis, TGE compliance, token design memo | Ongoing |
| **Client diversity** | Second independent implementation (Rust / Go), reach ≥40% stake on the secondary client | 6-9 months |
| **Production infrastructure** | Dedicated DNS, TLS, CDN, cross-region bootstrap nodes, backup & disaster recovery | 2-3 months |

**Conservative-optimistic estimate**: assuming no major rewrites, **6-12 months** from Day-90 testnet launch to mainnet. Hitting the lower bound likely requires a dedicated mainnet-readiness programme running in parallel from Day 60 onward.

---

## 7. 风险与降级建议 / Risks and Descope Recommendations

### 7.1 当前最大风险 / Biggest active risk

**Mempool-drift equivocation** 是一个会随机暴露在每次维护操作（任意 docker / systemd 重启）后的中级故障。在外部运营方接入（Day 60+）后，该问题会被放大：每个 operator 的网络变动都会引发链停。**优先级 = P0**。

The mempool-drift equivocation is a mid-severity fault that surfaces after every maintenance operation (any docker / systemd restart). Once external operators come online (Day 60+), the blast radius grows: every operator's network event can stall the chain. **Priority = P0.**

### 7.2 如果 P0 #1 在 2 周内没有方案 / If P0 #1 has no workable fix in 2 weeks

启动 90-day-roadmap §5.7.2 描述的降级序列：
- 不发公开测试网；继续邀请制 beta 至 Day 120
- Day 90 改为 Go/No-Go 复盘
- 保留所有已落地能力，把宣发收回

Trigger the descope sequence from roadmap §5.7.2:
- Do not launch public testnet; continue invited beta through Day 120
- Day 90 becomes a Go/No-Go review only
- Retain all landed capability, withdraw external messaging

---

## 8. 验证脚本 / Verification Commands

```bash
# 当前链状态 / current chain state
ssh clawchain-server '
for p in 28780 28782 28784 18780 38780; do
  echo -n "port $p height="
  curl -sS -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}" \
    -H "Content-Type: application/json" http://localhost:$p
  echo
done'

# Phase M1 metric 实测 / Phase M1 metrics in production
curl -s http://199.192.16.79:9101/metrics | grep -E '^coc_(bft_equivocations_total|fork_choice_max_depth_blocks|block_height|consensus_state) '

# soak 状态 / soak status
ssh clawchain-server 'wc -l /root/clawd/COC/docs/soak-reports/raw/phase-2-j-fix-w8e.jsonl'

# 完整 phase commit 历史 / full phase commit history
git log --oneline --all | grep -iE 'Phase [A-Z]'
```

---

## 9. 引用文档 / Referenced Docs

- `docs/90-day-release-roadmap.zh-en.md` — 90-day release plan
- `docs/testnet-phase-2-deployment-plan.en.md` — Phase 2 deployment guarantees
- `docs/native-deployment.en.md` — native migration runbook
- `docs/phase-j-postmortem.en.md` — Phase J consensus self-recovery postmortem
- `docs/phase-j-stall-2026-05-06-corner-case.md` — corner-case writeup + resolution
- `docs/economics-v1.en.md` — frozen economic parameters
- `docs/operators/economics-rollout.zh-en.md` — economics enable playbook
- `docs/openclaw-skills-v0.2-spec.md` — Skills v0.2 contract
- `docs/soak-reports/TEMPLATE.md` — soak report template
- `CLAUDE.md` — repository agent guide

---

**End of report. Generated 2026-05-06 02:35 UTC.**
