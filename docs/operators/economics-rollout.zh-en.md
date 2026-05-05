# Economics v1 Rollout Playbook (中英) — Phase I Activation

> **Purpose / 目的**: step-by-step procedure for flipping
> `COC_BLOCK_REWARD_ENABLED` and `COC_FEE_DISTRIBUTION_ENABLED` on the
> public testnet without inducing stateRoot divergence.
> 在公开测试网启用 `COC_BLOCK_REWARD_ENABLED` 与
> `COC_FEE_DISTRIBUTION_ENABLED` 的逐步流程，避免诱发 stateRoot 分叉。
>
> **Owner / 责任方**: ops + governance jointly. Procedure must be
> rehearsed once on a private 3-node devnet before testnet execution.
> ops 与 governance 共同负责。流程必须先在私有 3 节点 devnet 演练一次再在测试网执行。
>
> **Last updated / 最后更新**: 2026-05-05.

## 1. Pre-flight checklist / 上线前检查

- [ ] `docs/economics-v1.en.md` § 8 open questions resolved by governance
      / `docs/economics-v1.zh.md` § 8 治理已 close 全部待定问题。
- [ ] All 3 testnet validators on the same node image tag (run
      `docker ps --format '{{.Names}}\t{{.Image}}'` on `clawchain-server`).
      所有 3 个验证者使用同一节点镜像 tag。
- [ ] Sync-node observer is healthy and ≤10 blocks behind validators.
      sync-node observer 健康且与验证者高度差 ≤10 块。
- [ ] `COC_BFT_AUTO_RECOVERY=1` already set (was the 2026-05-04 fix).
      `COC_BFT_AUTO_RECOVERY=1` 已生效。
- [ ] `COC_DEV_RELAXED_QUORUM=0` confirmed on every validator.
      所有验证者已确认 `COC_DEV_RELAXED_QUORUM=0`。
- [ ] Last 1h chain shows 0 BFT timeouts (`docker logs --since 1h
      coc-node-1 | grep -c 'BFT round timed out'`).
      过去 1 小时链上 BFT timeout 计数为 0。
- [ ] Snapshot of pre-rollout state stored: heights, stateRoots, validator
      balances, and `coc_nodeInfo` from each validator captured to
      `phase-j-rollout-snapshot.json`.
      已存留 rollout 前快照: 各验证者高度、stateRoot、余额、`coc_nodeInfo`。

## 2. Activation order / 激活顺序

The flip is **consensus-affecting** — every validator must enable the
feature in the SAME block window, otherwise nodes that haven't flipped
yet will compute different post-state stateRoots and stall (the 2026-04-30
testnet pattern). Two strategies are acceptable:

**Strategy A — coordinated atomic flip**: chosen for I1 (block reward)
since its consensus impact is large and well-understood.

激活流程对**共识有影响**——所有验证者必须在同一区块窗口内启用，否则尚未翻转的节点会计算出不同的 post-state stateRoot 并停滞（2026-04-30 测试网即为此模式）。两种可接受策略：

策略 A——协调原子翻转: I1（区块奖励）使用此方案，因其共识影响大且边界清晰。

1. **Choose activation height H** at least 100 blocks ahead of "now"
   (gives all operators ~5 min lead time at 3 s blocks).
   确定一个比"当前"靠后 ≥100 块的高度 H（按 3 秒/块给运营方约 5 分钟提前量）。
2. **Communicate H** in the operator chat with the exact env-var values
   to apply. Include this hash of the values to detect copy-paste errors:
   `keccak256("INITIAL=2e18|INTERVAL=42048000")`.
   在运营频道告知 H 与精确的环境变量值。包含 `keccak256(...)` 哈希以便检测复制粘贴错误。
3. **Each operator updates `/root/clawd/COC/docker/.env`** with the new
   vars but does NOT restart their container yet.
   每个运营方更新 `/root/clawd/COC/docker/.env` 但**先不重启容器**。
4. **At height H − 5**, all operators simultaneously run
   `docker compose up -d --force-recreate <node>`. The 5-block buffer
   absorbs clock skew between operators (no NTP coordination required).
   在高度 H−5 时所有运营方同时执行重建命令；5 块缓冲消化时钟偏差。
5. **Validate at height H + 1**: every node's `eth_getBlockByNumber` for
   block H+1 returns identical stateRoot. Use:
   ```bash
   for P in 28780 28782 28784; do
     curl -s http://localhost:$P -X POST ... eth_getBlockByNumber [(H+1), false]
   done | jq -r '.result.stateRoot' | sort -u | wc -l
   # MUST output 1
   ```
   高度 H+1 验证: 三节点 stateRoot 必须完全一致。

**Strategy B — gradual ramp (NOT applicable to Phase I, listed for
completeness)**: only applicable to non-consensus-affecting features. For
I1/I2 this strategy WILL cause stateRoot divergence and is forbidden.

策略 B——渐进式（不适用于 Phase I，仅列于完整性）: 仅适用于非共识影响功能。I1/I2 使用此策略**会**导致 stateRoot 分叉，禁止。

## 3. Per-feature activation / 各功能启用顺序

Recommended order to minimize blast radius if a regression surfaces:
建议顺序，以便在出现回归时缩小影响面：

### 3.1 Sprint I1: block reward / 区块奖励

```bash
# /root/clawd/COC/docker/.env (each validator host)
COC_BLOCK_REWARD_ENABLED=1
COC_BLOCK_REWARD_WEI=2000000000000000000
COC_BLOCK_REWARD_HALVING_INTERVAL_BLOCKS=42048000
```

Acceptance window: 30 min after H. Look for:
观察窗口: H 之后 30 分钟。检查项:

- 每个验证者地址余额每块增加 2 COC（`eth_getBalance` 在 H+10 vs H 应差 20 COC × 该验证者出块次数）。
- Each validator's address balance increases by 2 COC per block proposed.
- 三节点高度持续推进（≥10 块/30s）。
- All 3 nodes advance height continuously.
- 0 stateRoot divergence in `coc_chainStats` for the window.

### 3.2 Sprint I2: fee distribution / 手续费分配

After §3.1 has been stable for ≥24h, repeat the strategy A flip with:
§3.1 稳定 ≥24 小时后，按策略 A 再次执行：

```bash
COC_FEE_DISTRIBUTION_ENABLED=1
```

Acceptance: a self-sent tx with `maxPriorityFeePerGas=1 gwei` from
operator wallet credits the proposer's address with the priority fee
(verifiable by `eth_getBalance(proposer)` delta).
验收: 用 `maxPriorityFeePerGas=1 gwei` 自发交易，提议者地址应增加对应 priority fee。

### 3.3 Sprint I3 / I4 / I5: equivocation slashing path / 等价签名 slashing

These are NOT env-gated on the node side — they're contract-level
features that activate as soon as the relayer (`coc-relayer`) is wired
to the deployed `EquivocationDetector` + `ValidatorRegistry` +
`Treasury` + `InsuranceFund` contracts. Activation = deploy contracts +
configure `coc-relayer` env (`COC_EQUIVOCATION_DETECTOR_ADDR`,
`COC_VALIDATOR_REGISTRY_ADDR`, `COC_TREASURY_ADDR`,
`COC_INSURANCE_FUND_ADDR`).

这部分**不在节点侧 env-gated**——它们是合约级特性，部署 `EquivocationDetector` + `ValidatorRegistry` + `Treasury` + `InsuranceFund` 并把 relayer 接到合约即生效。激活 = 部署 + 配置 relayer 环境变量。

Acceptance: simulate equivocation on a private devnet by signing two
conflicting BFT messages from one validator key, observe the relayer
auto-submit + confirm `validatorRegistry.slashedStake[v]` increased.
验收: 在私有 devnet 用一个验证者私钥签发两条冲突 BFT 消息，观察 relayer 自动上报，并确认 `slashedStake[v]` 增加。

## 4. Rollback / 回滚

A regression discovered post-activation needs to roll back the entire
validator set in lockstep, otherwise rolling back one validator
re-introduces the divergence the activation was supposed to avoid.

激活后发现回归需要整个验证者集合**同步**回滚，否则单点回滚反而引入分叉。

| Step | Command | Notes |
|---|---|---|
| 1 | Operator chat: declare rollback height H'. | 确定回滚高度 H' |
| 2 | All operators set the env back to default-off. | 所有运营方将变量回默认值 |
| 3 | All operators `docker compose up -d --force-recreate <node>` at H'-5. | 在 H'−5 同步重建 |
| 4 | Verify all 3 stateRoots match at H' + 1. | H'+1 校验 stateRoot |
| 5 | If a node's leveldb has been corrupted by the divergence (case 2026-05-05): apply the J3 manual recovery — `mv leveldb-{chain,state} ...broken.<ts>`, restart, snap-sync. | 若 leveldb 已腐败，按 J3 手动恢复 |

## 5. Failure modes & escalation / 故障模式与升级

| Symptom | Likely cause | Recovery |
|---|---|---|
| BFT round timeouts cluster ≥2/min | one validator on different INITIAL/INTERVAL than others | check `.env` parity; coordinated re-flip |
| Single validator's stateRoot diverges (J1.1 fires onPeerQuorumDiverged) | leveldb corruption from prior partial activation | J3 procedure: backup + clear + snap-sync |
| All 3 nodes stall, prepareVotes={self only} | self-stuck proposer (J2.2 path) | wait ≤4 min for J2.2 forceClearRound; if not, restart proposer container |
| `eth_getBalance(proposer)` doesn't increase | I1 not actually enabled OR coinbase unset | check `coc_nodeInfo` reflects new env vars; if absent, container didn't pick up new env (re-recreate) |

升级路径: ops → governance multi-sig holder → external auditor (only if
suspected consensus-level vulnerability).

## 6. Audit trail / 审计追踪

Every activation MUST capture (commit to a private ops repo):
每次激活必须记录（提交到私有 ops 仓库）：

- Activation block height H + UTC timestamp
- Pre/post `.env` diffs (sanitize secrets)
- Pre/post `coc_nodeInfo` from all validators
- Block H+0..H+10 stateRoots from all validators (proof-of-consensus)
- Operator signatures of each step (chat thread export OK)

This file IS the proof when a future incident asks "who flipped what,
when". It is not a courtesy.

本文件是未来发生事件追溯"谁、何时、翻转了什么"的证据，不是礼节性记录。

---

**Cross-references**

- Parameters: `docs/economics-v1.{en,zh}.md`
- Phase J recovery procedures: `tests/multinode-integration/README.md`
- Roadmap: `docs/90-day-release-roadmap.zh-en.md` Week 9
