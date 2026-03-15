# COC 90 天发布路线图 / COC 90-Day Release Roadmap

**Date / 日期**: 2026-03-15  
**Planning Window / 规划窗口**: 2026-03-15 to 2026-06-13  
**Planning Baseline / 规划基线**: Repository assessment, local gate execution, and current market reality as of 2026-03-15

## 1. 发布建议 / Release Recommendation

| 中文 | English |
|---|---|
| 未来 90 天的目标不应是“COC 主网发布”，而应是“完成定位收敛、修复发布阻断项，并把 COC Prowl 推进到有条件公开测试网”。 | The 90-day goal should not be a COC mainnet launch. It should be positioning convergence, release-blocker closure, and advancing COC Prowl to a gated public testnet. |
| 对外叙事必须从“通用新公链”收敛为“面向 OpenClaw AI-agent 的服务证明与结算网络”。 | External positioning must converge from “another general-purpose chain” to “a service-proof and settlement network for OpenClaw AI agents.” |
| Day 90 的最佳结果是公开测试网上线；保底结果是邀请制 beta 稳定运行并通过下一轮 Go/No-Go。 | The best Day-90 outcome is a public testnet launch; the fallback outcome is a stable invited beta with a passed next-round Go/No-Go review. |
| 在 Day 90 之前，不建议承诺主网、通用公链扩张、或 TGE/大规模开放验证者加入。 | Before Day 90, do not commit to mainnet, broad “general chain” expansion, or a TGE / large open-validator onboarding. |

## 2. 当前基线 / Current Baseline

### 2.1 工程基线 / Engineering Baseline

| 领域 | 中文判断 | English Assessment |
|---|---|---|
| 核心实现 | COC 已具备节点、EVM、PoSe、浏览器、钱包、运行时、测试网配置等完整骨架。 | COC already has a substantial skeleton: node, EVM, PoSe, explorer, wallet, runtime services, and testnet configs. |
| 核心安全 | `relay-witness-security` 与 `bft-slashing.integration` 本地通过，说明关键安全闭环基本存在。 | `relay-witness-security` and `bft-slashing.integration` pass locally, indicating key security loops are materially in place. |
| 质量门禁 | `scripts/quality-gate.sh` 本地未通过，当前观察到 2 个性能基准失败。 | `scripts/quality-gate.sh` does not pass locally; 2 performance benchmark tests currently fail. |
| 联网冒烟 | `scripts/verify-devnet.sh 3` 本地失败，暴露出 devnet 端口规划和启动可靠性问题。 | `scripts/verify-devnet.sh 3` fails locally, exposing devnet port-planning and startup reliability issues. |
| 架构定位 | 文档同时描述为独立 PoSe 区块链与 L1 结算 + L2 Rollup 架构，定位冲突。 | The docs simultaneously describe COC as an independent PoSe chain and as an L1 settlement + L2 rollup architecture. |
| L1/L2 集成 | 运行时文档仍明确写着“缺少生产级 L1/L2 网络完整集成”。 | Runtime status still explicitly says “full integration with a production L1/L2 network” is remaining work. |

### 2.2 市场基线 / Market Baseline

| 中文 | English |
|---|---|
| 2026-03-15 的市场环境不是“缺链”，而是“链供给过剩、注意力稀缺、流动性极度头部化”。 | The market on 2026-03-15 is not “missing another chain”; it is oversupplied with chains, short on attention, and highly concentrated in liquidity. |
| COC 若走“通用 EVM 公链”路线，需要同时与头部 L1、L2、appchain 和行业垂直链竞争，成功概率低。 | If COC chooses the “general-purpose EVM chain” route, it competes against top L1s, L2s, appchains, and vertical chains at once; success probability is low. |
| COC 若走“AI-agent 原生服务证明与结算网络”路线，差异化更强，也更符合现有白皮书与 PoSe 设计。 | If COC chooses the “AI-agent-native service-proof and settlement network” route, the differentiation is stronger and better aligned with the current whitepaper and PoSe design. |

## 3. Day 90 目标 / Day-90 Target

| 中文 | English |
|---|---|
| **首选结果**：在 2026-06-13 前发布 `COC Prowl Public Testnet v1`，公开但受控开放，重点承载 OpenClaw 相关工作负载。 | **Preferred outcome**: launch `COC Prowl Public Testnet v1` by 2026-06-13, publicly accessible but operationally gated, focused on OpenClaw-related workloads. |
| **保底结果**：在 2026-06-13 前完成邀请制 beta（10-20 节点）稳定运行，并把公开测试网延期到下一窗口。 | **Fallback outcome**: achieve a stable invited beta (10-20 nodes) by 2026-06-13 and defer the public testnet to the next window. |
| **明确不做**：主网、开放式 validator 市场、泛生态扩张、代币营销。 | **Explicit non-goals**: mainnet, open validator market, broad ecosystem expansion, token marketing. |

## 4. 90 天阶段路线 / 90-Day Phased Roadmap

### 4.1 阶段总览 / Phase Overview

| 阶段 | 日期 | 中文目标 | English Goal | 退出条件 / Exit Criteria |
|---|---|---|---|---|
| Phase 1 | 2026-03-15 to 2026-04-13 | 修复发布阻断项，冻结定位与发布范围 | Fix release blockers and freeze positioning and release scope | `quality-gate` 绿、3/5 节点冒烟绿、单一产品叙事冻结 |
| Phase 2 | 2026-04-14 to 2026-05-13 | 跑通邀请制 beta，完成真实运行栈与运维闭环 | Run invited beta and complete the real runtime + ops loop | 10-20 节点 beta、24h 稳定、L1/L2 staging 集成 |
| Phase 3 | 2026-05-14 to 2026-06-13 | 完成公开测试网准备与 Go/No-Go 决策 | Complete public testnet readiness and Go/No-Go decision | 7 天 soak、P0 全过、P1 大部分通过、上线或延期决定明确 |

### 4.2 周节奏 / Weekly Cadence

| 周次 | 日期 | 中文重点 | English Focus |
|---|---|---|---|
| Week 1 | 2026-03-16 to 2026-03-22 | 冻结定位，统一“AI-agent 服务证明与结算网络”叙事；明确 Day 90 只做测试网，不做主网承诺。 | Freeze positioning around an “AI-agent service-proof and settlement network”; state clearly that Day 90 is testnet-only, not mainnet. |
| Week 2 | 2026-03-23 to 2026-03-29 | 修复 devnet 端口规划、metrics 端口隔离、wire/p2p 冲突，确保 3 节点启动稳定。 | Fix devnet port planning, metrics port isolation, and wire/p2p conflicts; make 3-node startup stable. |
| Week 3 | 2026-03-30 to 2026-04-05 | 修复 `quality-gate` 红灯，处理性能基准与共识异常；建立稳定的性能回归基线。 | Turn `quality-gate` green, address benchmark and consensus issues, and establish a stable performance regression baseline. |
| Week 4 | 2026-04-06 to 2026-04-13 | 清理架构文档冲突，统一 README、白皮书、架构文档、测试网文档的口径。 | Remove architecture-document conflicts and align README, whitepaper, architecture docs, and testnet docs. |
| Week 5 | 2026-04-14 to 2026-04-20 | 完成 staging 环境的 L1/L2 结算、relayer、agent、faucet、explorer 联调。 | Complete staging integration for L1/L2 settlement, relayer, agent, faucet, and explorer. |
| Week 6 | 2026-04-21 to 2026-04-27 | 接入最小生产级密钥托管方案，跑通升级、回滚、备份、恢复演练。 | Integrate a minimum production-grade key custody model and run upgrade, rollback, backup, and restore drills. |
| Week 7 | 2026-04-28 to 2026-05-04 | 启动邀请制 beta，目标 10-20 节点，优先引入 3 个以上独立运营方。 | Launch the invited beta with 10-20 nodes and at least 3 independent operators. |
| Week 8 | 2026-05-05 to 2026-05-11 | 完成 24h 稳定性验证，修复 beta 暴露出的共识、同步、PoSe、运维缺陷。 | Complete 24-hour stability validation and fix consensus, sync, PoSe, and ops defects surfaced by beta. |
| Week 9 | 2026-05-12 to 2026-05-18 | 冻结公开测试网经济参数 v1，明确奖励、国库、惩罚和测试网激励规则。 | Freeze public-testnet economics v1, including rewards, treasury, slashing, and incentive rules. |
| Week 10 | 2026-05-19 to 2026-05-25 | 完成钱包/SDK/tooling/桥接最小集，确保外部开发者能实际接入和试用。 | Finish the minimum wallet/SDK/tooling/bridge surface so external developers can actually integrate and test. |
| Week 11 | 2026-05-26 to 2026-06-01 | 跑 7 天 soak、完成告警覆盖、值守机制、支持文档和公开注册页面。 | Run a 7-day soak, finish alert coverage, on-call readiness, support docs, and public registration pages. |
| Week 12 | 2026-06-02 to 2026-06-13 | 做最终 Go/No-Go，满足条件则发布公开测试网；否则继续 beta 并顺延 30 天。 | Execute the final Go/No-Go; launch public testnet if gates pass, otherwise continue beta and slip by 30 days. |

## 5. 工作流拆解 / Workstream Breakdown

### 5.1 产品定位与叙事 / Product Positioning and Narrative

| 中文动作 | English Action | 目标完成时间 |
|---|---|---|
| 删除或改写“通用新公链”“生产就绪主网”等容易误导的表述。 | Remove or rewrite statements that imply “another general-purpose chain” or “production-ready mainnet.” | Day 14 |
| 把官网、白皮书、README、架构文档统一为一个定位：OpenClaw AI-agent 服务证明与结算网络。 | Align website, whitepaper, README, and architecture docs to one positioning: an OpenClaw AI-agent service-proof and settlement network. | Day 30 |
| 对外只承诺邀请制 beta 与公开测试网，不承诺主网日期。 | Publicly commit only to invited beta and public testnet, not a mainnet date. | Day 14 |

### 5.2 发布工程与协议稳定性 / Release Engineering and Protocol Stability

| 中文动作 | English Action | 目标完成时间 |
|---|---|---|
| 修复 `start-devnet.sh` 的端口冲突和多节点 metrics 端口复用问题。 | Fix port conflicts and shared metrics-port reuse in `start-devnet.sh`. | Day 10 |
| 跑通 `verify-devnet.sh 3` 与 `verify-devnet.sh 5`，并把结果纳入预发布门禁。 | Make `verify-devnet.sh 3` and `verify-devnet.sh 5` pass and promote them into the pre-release gate. | Day 21 |
| 修复当前观测到的 `invalid wire magic`、`invalid cumulativeWeight`、冷启动脆弱性等问题。 | Fix the currently observed `invalid wire magic`, `invalid cumulativeWeight`, and cold-start fragility issues. | Day 21 |
| 让 `scripts/quality-gate.sh` 稳定退出 0；若性能基准噪声过大，则拆出独立 perf gate。 | Make `scripts/quality-gate.sh` reliably return 0; if perf thresholds are too noisy, split them into a dedicated performance gate. | Day 21 |

### 5.3 运行时、结算与运维 / Runtime, Settlement, and Operations

| 中文动作 | English Action | 目标完成时间 |
|---|---|---|
| 完成 staging L1/L2 真实链路，至少覆盖 relayer、epoch finalize、reward manifest、fault proof。 | Complete a real staging L1/L2 path covering relayer, epoch finalization, reward manifests, and fault proofs. | Day 45 |
| 接入最小可用密钥托管：KMS、Vault、HSM 或独立签名服务四选一。 | Introduce minimum viable key custody: KMS, Vault, HSM, or an isolated signer service. | Day 45 |
| 完成 24h 稳定性压测、回滚、快照恢复、备份恢复演练。 | Complete 24-hour stability, rollback, snapshot restore, and backup/restore drills. | Day 60 |
| 完成 7 天 soak test 与公开测试网值守轮班。 | Complete a 7-day soak test and on-call rotation for the public testnet. | Day 84 |

### 5.4 经济模型与生态入口 / Economics and Ecosystem Entry Points

| 中文动作 | English Action | 目标完成时间 |
|---|---|---|
| 把当前 `economics.md` 从 draft 推进到 v1 测试网参数冻结版。 | Move the current `economics.md` from draft to a frozen v1 testnet parameter set. | Day 65 |
| 明确测试网激励与不可承诺项，避免把测试网奖励叙事提前等同于主网经济。 | Define testnet incentives and non-promises clearly; do not present testnet rewards as if they were mainnet economics. | Day 65 |
| 确保钱包、浏览器、faucet、最小 SDK、开发者接入文档可用。 | Ensure wallet, explorer, faucet, a minimum SDK, and developer onboarding docs are usable. | Day 75 |
| 至少引入 1 个真实 OpenClaw 工作负载和 2 个示范集成。 | Bring in at least 1 real OpenClaw workload and 2 demo integrations. | Day 90 |

## 6. P0 / P1 / P2 优先级清单 / Priority Checklist

### 6.1 P0: Day 90 前必须完成 / Must Be Done Before Day 90

| 项目 | 中文说明 | English Description | Owner | Target |
|---|---|---|---|---|
| 定位冻结 | 统一为 AI-agent 服务证明与结算网络，停止通用公链叙事漂移。 | Freeze positioning around an AI-agent service-proof and settlement network; stop generic-chain narrative drift. | Product + Founder | Day 14 |
| 质量门禁转绿 | `scripts/quality-gate.sh` 必须稳定通过。 | `scripts/quality-gate.sh` must pass reliably. | QA Lead + Core Node Lead | Day 21 |
| Devnet 冒烟转绿 | `verify-devnet.sh 3/5` 必须稳定通过。 | `verify-devnet.sh 3/5` must pass reliably. | Core Node Lead | Day 21 |
| 端口与启动缺陷修复 | 修复多节点端口冲突、metrics 冲突、冷启动失败。 | Fix multi-node port collisions, metrics collisions, and startup failures. | Core Node Lead | Day 10 |
| 共识与网络异常修复 | 修复当前观测到的 wire/magic、cumulativeWeight、同步异常。 | Fix currently observed wire/magic, cumulativeWeight, and sync issues. | Consensus Lead | Day 21 |
| staging L1/L2 集成 | 跑通真实 staging 结算链路，而非仅靠本地 mock。 | Complete a real staging settlement path rather than relying only on local mocks. | PoSe Lead + Contracts Lead | Day 45 |
| 最小生产级密钥托管 | 私钥不得长期明文放在配置或环境里。 | Private keys must not live long-term in plain config or env files. | Security Lead + DevOps Lead | Day 45 |
| 邀请制 beta 上线 | 10-20 节点，至少 3 个独立运营方。 | Launch invited beta with 10-20 nodes and at least 3 independent operators. | Release Manager + SRE Lead | Day 60 |
| 24h 稳定性验证 | 无崩溃、无长时间停块、无未解释重组。 | Pass 24-hour stability with no crashes, no prolonged stalls, and no unexplained reorgs. | SRE Lead + QA Lead | Day 60 |
| 公开测试网 Go/No-Go 包 | 包含 runbook、告警、支持文档、回滚方案、签字流程。 | Ship the public-testnet Go/No-Go package: runbooks, alerts, support docs, rollback plan, and sign-off process. | Release Manager | Day 84 |

### 6.2 P1: 强烈建议在 Day 90 前完成 / Strongly Recommended Before Day 90

| 项目 | 中文说明 | English Description | Owner | Target |
|---|---|---|---|---|
| 经济参数冻结 v1 | 冻结奖励、通胀、国库、惩罚和测试网激励规则。 | Freeze rewards, inflation, treasury, slashing, and testnet incentive rules. | Token/Economics Lead | Day 65 |
| 7 天 soak test | 面向公开测试网的长期稳定性验证。 | Run a 7-day soak for public-testnet readiness. | SRE Lead | Day 84 |
| 开发者接入闭环 | 钱包、faucet、explorer、SDK、Foundry/Hardhat 文档可用。 | Ensure wallet, faucet, explorer, SDK, and Foundry/Hardhat docs are usable. | DevRel + DX Lead | Day 75 |
| 最小桥接与资产入口 | 提供测试网资产入口和基本桥接方案。 | Provide testnet asset access and a minimum bridging path. | Ecosystem Lead | Day 75 |
| OpenClaw 真实工作负载 | 至少 1 个真实工作负载跑在 beta/testnet 上。 | Run at least 1 real OpenClaw workload on beta/testnet. | Product + OpenClaw Team | Day 90 |
| 公开社区支持面 | 上线 FAQ、join guide、issue template、反馈渠道。 | Launch FAQs, join guides, issue templates, and support channels. | Community Lead | Day 84 |

### 6.3 P2: 可并行推进，但不应阻塞 Day 90 / Important but Should Not Block Day 90

| 项目 | 中文说明 | English Description |
|---|---|---|
| 更强的抗女巫机制 | 处理跨地址、跨 VPS、集群识别、机器证明等更高阶问题。 | Strengthen anti-Sybil beyond the current baseline, including cross-address, cross-VPS, clustering, and machine-proof mechanisms. |
| 去中心化 challenger 市场 | 降低当前 challenger/协调方集中度。 | Decentralize the challenger/coordinator market. |
| 数据可用性与存储证明增强 | 引入 DAS、更多样本策略、更强可验证存储计量。 | Improve data availability and storage-proof depth, including DAS and stronger sampling. |
| 第二客户端或多实现策略 | 降低单客户端风险。 | Add a second client or multi-implementation strategy to reduce single-client risk. |
| 更大规模生态扩张 | 钱包、桥、DeFi、索引器、预言机等广泛对接。 | Pursue broader ecosystem integrations across wallets, bridges, DeFi, indexers, and oracles. |
| blob/type-3 完整支持 | 不是 Day 90 的关键目标。 | Full blob/type-3 support is not a Day-90 goal. |

## 7. 发布门禁 / Release Gates

### 7.1 Day 30 Gate

| 中文 | English |
|---|---|
| `quality-gate` 通过，3 节点 devnet 冒烟通过，架构口径统一。 | `quality-gate` passes, 3-node devnet smoke passes, and architecture messaging is unified. |
| 若失败，则停止任何公开宣发，把所有资源回收到稳定性和定位修正。 | If this gate fails, stop public promotion and redirect all effort into stability and positioning correction. |

### 7.2 Day 60 Gate

| 中文 | English |
|---|---|
| 邀请制 beta 已运行，10-20 节点在线，24h 稳定性通过，staging L1/L2 集成完成。 | Invited beta is live, 10-20 nodes are online, 24-hour stability passes, and staging L1/L2 integration is complete. |
| 若失败，则不进入公开测试网冲刺阶段，只继续 beta 修复。 | If this gate fails, do not enter the public-testnet sprint; continue beta stabilization only. |

### 7.3 Day 90 Gate

| 中文 | English |
|---|---|
| P0 必须全部通过；P1 至少通过 80%；没有未闭环的高优安全风险。 | All P0 items must pass; at least 80% of P1 must pass; no unresolved high-priority security issues may remain. |
| 满足条件则公开测试网上线；否则顺延 30 天，并公开说明原因与修复计划。 | If all conditions pass, launch the public testnet; otherwise slip by 30 days and publish the reasons and remediation plan. |

## 8. 成功指标 / Success Metrics

### 8.1 工程指标 / Engineering Metrics

| 指标 | 中文目标 | English Target |
|---|---|---|
| 质量门禁 | Day 21 起连续 14 天保持绿色 | Keep the quality gate green for 14 consecutive days starting no later than Day 21 |
| 出块稳定性 | 平均 3s ± 1s，P95 < 6s | Mean block time 3s ± 1s, P95 < 6s |
| 邀请制 beta 稳定性 | 24h 零崩溃，停块总时长 < 5 分钟 | 24-hour zero-crash run, cumulative stall time < 5 minutes |
| 公开测试网稳定性 | 7 天 soak 无 P0 事故 | 7-day soak with no P0 incidents |

### 8.2 产品指标 / Product Metrics

| 指标 | 中文目标 | English Target |
|---|---|---|
| 独立运营方 | 至少 3 家邀请制 beta 运营方 | At least 3 independent invited-beta operators |
| 节点规模 | 邀请制 beta 10-20 节点；公开测试网 20-50 节点为第一阶段目标 | 10-20 nodes in invited beta; 20-50 nodes as the phase-1 public-testnet target |
| 真实工作负载 | 至少 1 个 OpenClaw 真实工作负载，2 个示范集成 | At least 1 real OpenClaw workload and 2 demo integrations |
| 开发者可用性 | 外部开发者可在 30 分钟内完成接入、领水、发交易、查询结果 | An external developer can onboard, get faucet funds, send a transaction, and query results within 30 minutes |

## 9. 明确不做 / Explicit Non-Goals

| 中文 | English |
|---|---|
| 不在 90 天窗口内承诺主网发布日期。 | Do not commit to a mainnet date within this 90-day window. |
| 不把“公开测试网”包装成“成功公链已成”。 | Do not market a public testnet as proof that a successful public chain has already been achieved. |
| 不先做大规模生态 BD，再补核心稳定性。 | Do not prioritize large-scale ecosystem BD before core stability is fixed. |
| 不在抗女巫、密钥托管、真实运行栈未收口前开放式吸引验证者。 | Do not open validator participation broadly before anti-Sybil, key custody, and real runtime operations are sufficiently closed. |

## 10. 最终建议 / Final Recommendation

| 中文 | English |
|---|---|
| 未来 90 天，COC 的正确目标不是“证明自己是一条成功公链”，而是“证明自己是一条值得继续投入的垂直链/应用链候选”。 | For the next 90 days, COC should not try to prove it is already a successful public chain; it should prove it is a worthy vertical-chain / appchain candidate for further investment. |
| 一旦 Day 90 能稳定交付公开测试网，并且真实 OpenClaw 工作负载能跑通，COC 才具备继续讨论主网、代币、开放 validator 市场的基础。 | Only after Day 90 delivers a stable public testnet and real OpenClaw workloads run successfully should COC reopen the discussion around mainnet, token design, and an open validator market. |

