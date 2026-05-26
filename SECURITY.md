# Security Policy

[English](#english) · [中文](#中文)

---

## English

ChainOfClaw (COC) takes security seriously. This document describes how to
report a vulnerability and what to expect in return.

### Reporting a vulnerability

**Do not file public GitHub issues for security vulnerabilities.** Use one of
these private channels:

1. **Email**: `security@chainofclaw.io` (preferred for time-sensitive reports)
2. **GitHub private vulnerability report**: open one at
   <https://github.com/chainofclaw/COC/security/advisories/new>

If your finding is critical (active exploitation, validator-key compromise,
funds at risk, chain liveness threat), email is fastest — we monitor that
inbox during waking hours and aim to acknowledge within 24 hours.

For lower-severity reports, the GitHub private-advisory channel keeps
metadata + history alongside the codebase and is recommended.

If you require PGP-encrypted submission, request a key in your first email
(no body) and we'll respond with our current public key fingerprint. We
rotate the key annually.

### What's in scope

Vulnerabilities that affect the production canary testnet (**chainId 88780**)
or could affect a future mainnet launch:

- **Chain & consensus**: BFT correctness (safety + liveness), fork-choice,
  snap-sync, P2P message handling, equivocation detection
- **Smart contracts**: any of the 13 gen-5 UUPS-proxied contracts on 88780
  (PoSeManagerV2, GovernanceDAO, Treasury, SoulRegistry, DIDRegistry,
  ValidatorRegistry, EquivocationDetector, InsuranceFund, DelayedInbox,
  RollupStateManager, CidRegistry, FactionRegistry, PoSeManager). The
  upgrade-authority MultiSigWallet is also in scope despite being immutable
- **Off-chain services**: `runtime/`, `services/`, `node/`, `explorer/`,
  `faucet/`, `wallet/` packages
- **Public-facing infrastructure**: any host the project operates that
  serves RPC, WSS, faucet, explorer, or the website

### What's out of scope

- Documentation typos / wording issues (these are
  [normal contributions](./CONTRIBUTING.md) — use a PR)
- Self-inflicted issues (lost private keys held only by the reporter, etc.)
- Theoretical attacks without a working PoC against the current network
- Spam / phishing in third-party channels we don't operate
- Known issues already documented as `OPEN` in
  [chainofclaw/COC issues](https://github.com/chainofclaw/COC/issues) (e.g.
  #746 PoSe witness semantic verification — listed publicly because the
  affected code is dormant in production)

### Severity & reward tiers (canary testnet)

We reward verified, novel reports. The reward range reflects the
**canary-testnet phase** — mainnet launch will introduce a separate,
higher-tier bounty program.

| Severity | Examples | Reward (USD-equivalent) |
|----------|----------|------------------------|
| **Critical** | Active fund-loss vector, root-key compromise, chain-halt vector that we cannot mitigate operationally, contract storage corruption | $10,000 – $50,000 |
| **High** | Validator-set manipulation, slashing bypass, RPC-rate-limit bypass exposing DoS amplification, signature malleability / EIP-2 violations | $2,500 – $10,000 |
| **Medium** | Front-end XSS with auth implications, mempool eviction patterns, governance proposal griefing not blocked by economics | $500 – $2,500 |
| **Low** | Information leaks of public-but-undocumented data, missing input validation without exploit path | $100 – $500 |

Rewards are paid in COC (post-canary launch) or in stablecoin equivalent
(if requested before payout). Payment requires a non-anonymous channel for
tax / regulatory compliance — pseudonyms are fine for credit, real identity
is required for payout.

### Triage & response timeline

| Stage | Target |
|-------|--------|
| Initial acknowledgment | 24h (Critical), 72h (High), 7d (Medium/Low) |
| Triage decision + severity classification | 5 business days |
| Fix landed on `main` | within 30d of triage for Critical / High |
| Coordinated public disclosure | 90 days from report, or sooner with reporter's agreement once the fix is deployed |

If we cannot reach a fix within 90 days for a Critical/High issue, we'll
contact you to discuss extension — but extensions are rare and require
explicit agreement.

### Safe harbor

Researchers acting in good faith — meaning they only test against their own
funds, do not exfiltrate user data beyond what's needed to demonstrate the
bug, do not perform attacks on third parties using the discovery, and
follow the disclosure timeline — will not face legal action from the
project.

If you compromise mainnet user funds, retain stolen funds, or publicly
disclose before the agreed timeline, safe harbor does not apply.

### Audit & disclosure history

Prior audit work is recorded in the [`docs/`](./docs/) directory and in
sprint summaries within commit history. Recent in-house audit cycles
(2026-04 to 2026-05) closed 15+ findings tracked publicly under
[issue numbers #645–#754](https://github.com/chainofclaw/COC/issues?q=is%3Aissue+is%3Aclosed).
The only remaining open item from those cycles is
[#746](https://github.com/chainofclaw/COC/issues/746) (PoSe witness
semantic verification — affected code is dormant in production).

External third-party audits are planned before mainnet launch and will be
linked here when complete.

---

## 中文

ChainOfClaw (COC) 对安全持严肃态度。本文档说明如何提交漏洞报告以及您可以期待的处理流程。

### 提交漏洞

**请不要为安全漏洞开公开的 GitHub issue。** 使用以下私密渠道之一:

1. **邮件**:`security@chainofclaw.io`(紧急报告首选)
2. **GitHub 私密漏洞报告**:在
   <https://github.com/chainofclaw/COC/security/advisories/new> 提交

如果是严重问题(正在被利用、validator 密钥泄漏、资金风险、链活性威胁),邮件最快——我们在工作时间监控该信箱,目标 24 小时内回复。

中低严重度报告建议走 GitHub 私密报告通道,元数据 + 历史与代码库同地保存。

如需 PGP 加密提交,请在首封邮件中(无正文)请求密钥,我们将回复当前公钥指纹。密钥每年轮换一次。

### 收录范围

影响生产 canary 测试网(**chainId 88780**)或未来主网启动的漏洞:

- **链与共识**:BFT 正确性(safety + liveness)、fork-choice、snap-sync、
  P2P 消息处理、equivocation 检测
- **智能合约**:88780 上 13 个 gen-5 UUPS proxy 合约
  (PoSeManagerV2、GovernanceDAO、Treasury、SoulRegistry、DIDRegistry、
  ValidatorRegistry、EquivocationDetector、InsuranceFund、DelayedInbox、
  RollupStateManager、CidRegistry、FactionRegistry、PoSeManager)。
  升级权威 MultiSigWallet 虽不可升级但也在范围内
- **链下服务**:`runtime/`、`services/`、`node/`、`explorer/`、`faucet/`、`wallet/` 包
- **对外基础设施**:项目运营的 RPC、WSS、faucet、explorer 或官网主机

### 不在范围

- 文档错别字 / 文字表达(这些是正常贡献,见 [CONTRIBUTING.md](./CONTRIBUTING.md),用 PR 提交)
- 自致问题(报告者自己丢失的私钥等)
- 无可工作 PoC 的理论攻击
- 我们不运营的第三方渠道中的钓鱼 / 垃圾邮件
- 已在 [chainofclaw/COC issues](https://github.com/chainofclaw/COC/issues) 中以 `OPEN` 状态记录的已知问题
  (例如 #746 PoSe witness 语义校验——公开列出因受影响代码在生产中休眠)

### 严重度与奖励级别(canary 测试网)

我们对经核实的新颖报告予以奖励。奖金范围反映**canary 测试网阶段**——主网启动将引入单独的、更高级别的赏金计划。

| 严重度 | 示例 | 奖励(USD 等值) |
|--------|------|------------------|
| **Critical** | 主动资金损失向量、根密钥泄漏、运营无法缓解的链停 vector、合约存储破坏 | $10,000 – $50,000 |
| **High** | Validator 集合操纵、slash 绕过、暴露 DoS 放大的 RPC 限流绕过、签名可塑性 / EIP-2 违规 | $2,500 – $10,000 |
| **Medium** | 带 auth 影响的前端 XSS、mempool 驱逐模式、经济模型未阻挡的治理提案 griefing | $500 – $2,500 |
| **Low** | 公开但未记录数据的信息泄漏、无利用路径的输入校验缺失 | $100 – $500 |

奖励以 COC(canary 启动后)或稳定币等值支付(在支付前提出要求)。支付需要非匿名渠道用于税务 / 合规——化名用于致谢可以,但实际支付需要真实身份。

### 分类与响应时间表

| 阶段 | 目标 |
|------|------|
| 初次确认 | 24 小时(Critical)、72 小时(High)、7 天(Medium/Low)|
| 分类决策 + 严重度划分 | 5 个工作日 |
| 修复合并到 `main` | Critical / High 在分类后 30 天内 |
| 协调公开披露 | 报告后 90 天,或在修复部署后经报告者同意提前 |

如果 Critical/High 问题 90 天内无法修复,我们会联系您讨论延期——但延期罕见,需明确同意。

### 安全港(Safe Harbor)

善意研究 — 仅测试自己的资金、除证明 bug 所需外不导出用户数据、不利用发现攻击第三方、遵守披露时间表 — 不会受到项目方法律追究。

如果您侵害主网用户资金、保留盗窃资金、或在约定时间表前公开披露,则不适用安全港。

### 审计与披露历史

历史审计工作记录在 [`docs/`](./docs/) 目录及 commit history 的 sprint 总结中。
近期内部审计周期(2026-04 至 2026-05)关闭了 15+ 项发现,公开追踪于
[#645–#754](https://github.com/chainofclaw/COC/issues?q=is%3Aissue+is%3Aclosed)。
这些周期的唯一遗留开放项是
[#746](https://github.com/chainofclaw/COC/issues/746)
(PoSe witness 语义校验——受影响代码在生产中休眠)。

主网启动前计划进行外部第三方审计,完成后将链接于此。
