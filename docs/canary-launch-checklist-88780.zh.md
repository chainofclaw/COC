# 88780 Canary 上线 — Go-Live Checklist

> 团队公开宣布 88780 为开放外部 validator onboarding 的 canary 网络前,必须全绿的
> 11 个关卡。本文档是"准备好了吗?"的单一真相源——每行链接到证明该 gate 的 SOP / PR / dashboard。

[English](./canary-launch-checklist-88780.md)

## 如何读

- **☑ 已关** — 完成 + 有证据
- **☐ 待办** — 未完成;负责人已标
- **🟡 进行中** — 已开始,有部分证据

上线宣布依赖**全部 11 项** ☑。每个 gate 显式链接证据 — 无"相信我,做完了"条目。

## 11 个 Gate

### 架构与代码

1. **☑ canary 准备 plan 中所有 HIGH 优先级项已关闭**
   *证据*:ValidatorRegistryReader 运营启用**已完成**(2026-06-10)—— 见
   [`88780-dynamic-validator-enablement-2026-06-10.zh.md`](./88780-dynamic-validator-enablement-2026-06-10.zh.md)
   与 [`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md)。
   *负责*:核心团队
   *当前*:**2026-06-10 已关闭。** 当前 validator(v1–v5)各自链上
   `stake(nodeId, pubkeyNode)` 32 COC(B4),全节点设 `validatorRegistryAddress`
   拉起(B5)。链上 `getActiveValidators()` 返回 **5 active**;节点日志
   `BFT validator set updated from ValidatorRegistry count=5`。validator 集合现
   由链上驱动并零重启热更新 —— 外部 operator 通过质押加入,无需改配置或协调重启。
   (reader 代码 + 11 单元测试早在 PR #756 交付;devnet stake→reader→BFT 路径在
   B3 已验证。)剩余的 HIGH 项灾难恢复 Runbook dry-run 单列为 Gate 7。

2. **☐ 最近 30 天连续出块无人工干预**
   *证据*:Grafana dashboard `coc-overview` 面板 "Block height per node, 30d 回溯"
   — 必须显示无 > 60s 的水平线,除了计划内 rolling upgrade 窗口(也必须有日志)。
   *负责*:ops
   *当前*:88780 自 gen-5 redeploy 2026-05-20 (commit `e5e6022`) 以来连续出块。
   宣布前一天前推 30 天的移动窗口。

3. **☐ 最近 30 天无 equivocation slash 事件(清白记录)**
   *证据*:`eth_getLogs` 对 `EquivocationDetector` proxy
   `0xa5dcE830e917176c1091fd6112F41E47692C510e` 在宣布窗口区块返回 0 事件。
   *负责*:ops
   *当前*:截至 2026-05-26 chaos 测试清理为 0 事件。slash 发生则重启 30d 时钟;
   调查根因;重做 gate。

### 安全

4. **☑ Bug bounty 计划上线(SECURITY.md)**
   *证据*:repo root 的 `SECURITY.md`(PR #757 Stage 1)。公开披露政策 + 严重度
   分级($100–$50k canary)+ 90d 披露窗口 + safe-harbor 语言全部到位。
   *负责*:安全团队
   *当前*:已交付。后续:Immunefi 集成可选,非阻塞。

5. **☐ 至少 1 份有效外部安全报告已接收 + 分类**
   *证据*:已关闭 GitHub Security advisory 链接 或 公开 credit 页面致谢报告者。
   *负责*:安全团队
   *当前*:待办。证明披露渠道端到端可用。在 1 份报告到来前,无法证明邮件 + advisory 渠道
   是 live + 受监控的。

### Validator 去中心化

6. **☐ 至少 1 个外部 operator 成功 stake + BFT 纳入**
   *证据*:非核心团队地址在 `ValidatorRegistry` 上的 `ValidatorRegistered` 事件,随后
   同一小时内 `senderId` 匹配该 operator nodeId 的 `BftMessage`。
   *负责*:生态
   *当前*:待办。SOP 在
   [`external-validator-onboarding.zh.md`](./external-validator-onboarding.zh.md)。
   完整 dry-run 循环端到端验证父 plan A.1.1。

### 运营准备

7. **☐ 灾难恢复 Runbook 评审过 + dry-run 测试过**
   *证据*:[`disaster-recovery-88780.zh.md`](./disaster-recovery-88780.zh.md) 中 6 个
   场景每个在镜像 88780 config 的 devnet 上执行过一次;每个场景的恢复程序生成预期 post-state。
   *负责*:ops
   *当前*:文档已交付(Stage 2)。dry-run 待办。6 个场景覆盖:
   链停、multisig 密钥丢失(1/2/3+ of 5)、大规模节点丢失、validator 密钥泄漏、
   equivocation slash 响应、OZ-manifest 损坏。

8. **☐ 公开 RPC 端点加固**
   *证据*:`https://rpc.chainofclaw.io` 在 10K req/min DDoS 测试(k6 / Artillery)下存活,
   不降级 validator-internal RPC。Cloudflare 或等同 CDN/WAF 前置。
   *负责*:ops
   *当前*:待办。按父 plan A.2.4;独立于本文档 sprint。
   Validator-internal RPC(`209.74.64.88:38780` 等)保持私有;仅 LB 前端暴露流量。

9. **☐ Faucet 可持续模型**
   *证据*:faucet 24h 连续 100 drip 请求/小时下存活,余额维持 ≥ 1000 COC(自动 refill 在位)。
   *负责*:ops
   *当前*:待办。当前 `faucet/` 代码是测试网调优(10 COC drip,24h 冷却)。
   canary 阶段的 refill cron job 缺失;需 SOP + 余额降至 500 COC 以下时告警。

10. **🟡 Grafana dashboards committed + Prometheus alerts wired**
    *证据*:4 个 dashboard(`docker/grafana/dashboards/coc-{overview,consensus,network,resources}.json`)
    + `ops/alerts/prometheus-rules.yml` 中 11 条 alert(4 组:availability、security、
    performance、network),每条映射到
    [`observability-runbook-88780.zh.md`](./observability-runbook-88780.zh.md) 一节(Stage 6)。
    SLO 编码:`SlowBlockProduction`(出块 p99 代理)、`EquivocationDetected`
    (清白记录 gate)、`LowPeerCount` / `coc_validators_active` panel(BFT quorum)、
    `HighMempoolBacklog`(mempool ack 代理)。
    *负责*:ops
    *当前*:资产 + 每条 alert SOP 已交付。剩余子任务(已跟踪,不阻塞 Gate 10):
    - 验证 dashboards 在新 Grafana 干净导入(上线前手动 dry-run);
    - 接 Alertmanager `runbook_url` annotation 指向公开 runbook URL(docs 站点上线后);
    - 可选:加 `ValidatorQuorumAtRisk` alert(`coc_validators_active < 5`)
      预防 chaos T2 风格的 2-down 重启竞速;
    - 对齐 dev-stack `docker/prometheus/alerts.yml` 与权威 `ops/alerts/prometheus-rules.yml`
      (或废弃 dev 文件)。

### 可发现性

11. **☐ 公开 docs 站点已发布**
    *证据*:`https://chainofclaw.io/en/docs` 可达,渲染新的 88780-canary 文档树
    (whitepaper, architecture, operations, canary launch, security 类别),
    locale 切换(zh / en)正常。
    *负责*:web/frontend
    *当前*:待办。按父 plan A.2.3 + 本 sprint Stage 5。底层文档是本 repo 的 `docs/` 目录;
    官网 docs 页面接入静态链接树。

## Burn-down

上线需 11 个全 ☑。当前:**2 ☑ / 1 🟡 / 8 ☐**(Gate 1 于 2026-06-10 关闭;Gate 4 此前已关)。

建议顺序(最快上线路径):
1. ~~Gate 1 需要运营启用(配置 + env on 每节点)~~ —— **✅ 2026-06-10 已关闭**
   (动态 validator 上线,v1–v5 已质押,reader 已启用)
2. Gates 7 + 11 可在本 sprint 文档级搞定(Gate 4 已 ☑)
3. Gates 8 + 9 + 10 是 ops infra sprint(Cloudflare 前置 public RPC,faucet refill cron,
   Grafana JSON + alert SOP)
4. Gate 6(外部 operator)是 validation 里程碑 — 依赖 gates 7, 11 全绿(Gate 1 的 reader
   已使质押自动加入)
5. Gates 2, 3 是时间门(30 天清白记录)— ops-infra gates(8, 10)关后第二天起时钟
6. Gate 5 需要真实 report — 在 bounty live + 索引后通常在 30 天窗口内自然关闭

### 校准时间表(从 2026-06-10 起)

关键路径是 **30 天清白记录窗口**,而它必须等 ops-infra gate 起来后才能开始。原
audit-sprint 的 2026-06-14 目标已顺延,因为 ops infra(Gate 8/9)+ 30 天窗口当时
尚未启动。

| 阶段 | 内容 | 现实 ETA |
|---|---|---|
| 已完成(本会话) | Gate 1 —— 链上动态 validator 上线(v1–v5 已质押,reader 已启用) | ✅ 2026-06-10 |
| 第 1–2 周 | ops infra:Gate 8(Cloudflare 前置 RPC)、Gate 9(faucet refill cron)、Gate 10(Grafana 导入 dry-run + Alertmanager URL)、Gate 7(DR 6 场景 devnet dry-run)、Gate 11(docs 站点上线) | ~2026-06-24 |
| 30 天窗口 | Gates 2 + 3 —— 30 天连续出块 + 零 equivocation,时钟从 ops infra 关闭日起算 | ~2026-07-24 |
| 窗口内 | Gate 5(首份外部安全报告)、Gate 6(邀请外部 operator 质押 + BFT 纳入) | 窗口内 |
| 公开发布 | 全 11 gate ☑ → 公告(Blog / Twitter / Discord) | **~2026 年 7 月下旬**(从原 6-8 周估计校准) |

预计日历最低:**~6 周**(从 2026-06-10 起),以 30 天清白记录 gate 为主(它现在要等
ops-infra 建设在 ~2026-06-24 完成后才能开始)。

## 不发布的红线条件

即使 11 gate 全 ☑,若上线前夜出现下列任一条件,推迟发布:

- [chainofclaw/COC issues](https://github.com/chainofclaw/COC/issues) 任何 `priority:critical` 未关
- 链最近 7 天有过出块停滞
- 任一 multisig signer 不可达(3-of-5 仍安全但缓冲已侵蚀)
- 活跃 validator 数(`ValidatorRegistry.getActiveValidators().length`,当前 5)
  跌破 BFT quorum 下限,或上线时任一活跃 validator 离线 > 1 小时

## 上线后监控(头 30 天)

上线宣布后 30 天窗口需高密度:

| 天 | 关注 |
|----|------|
| D+0 | 出块率、validator 参与率、RPC error rate |
| D+1 | 首波外部流量 — faucet drip 率、mempool 深度、gas 使用 |
| D+3 | 首次外部 operator stake 尝试(无则主动邀请) |
| D+7 | 首次周社区更新、bounty 提交计数 |
| D+14 | 若自然发生,首次 operator 退出(`requestUnstake`)测试 |
| D+30 | Stage-2 主网准备启动(按父 plan Phase B);canary 持续运行 |

## 另见

- 父 plan: `/home/bob/.claude/plans/applyblock-delightful-hennessy.md`(11 gates 的 gap 分析根据)
- [`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md) — 网络参数权威
- [`SECURITY.md`](../SECURITY.md) — gate 4 证据
- [`disaster-recovery-88780.zh.md`](./disaster-recovery-88780.zh.md) — gate 7 证据
- [`external-validator-onboarding.zh.md`](./external-validator-onboarding.zh.md) — gate 6 程序
