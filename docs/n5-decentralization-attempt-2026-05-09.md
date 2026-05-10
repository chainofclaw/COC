# N=5 去中心化升级尝试 — 事故报告

**日期**：2026-05-09 → 2026-05-10
**状态**：⚠ Phase 2 失败回滚，链恢复 pre-Phase-2 状态
**链停滞窗口**：17:17 → 01:01 UTC（约 7h44m，主要在挂着等 H15 fallback）

## 目标

把 chainId 18780 试验网 BFT 集合从静态 hardcoded 切换到 ValidatorRegistry-driven 动态模式，N=5 容忍 1 节点掉链不停。

## 完成的子目标

| Phase | 状态 | 备注 |
|---|---|---|
| Phase 0: 生成 3 个独立 EVM keypair | ✅ | `~/.coc/keys/{anchor-1,anchor-2,burst-1}.key`, manifest in `identities-2026-05-09.json` |
| Phase 1: stake hardcoded 身份进 ValidatorRegistry | ✅ | active set = {anvil-0, anvil-2}，匹配 production hardcoded BFT 集 |
| Phase 2: 让生产 3 节点启用 reader | ❌ rollback | 引发链停滞 7h+，最终回到 hardcoded set 模式 |

## Phase 2 失败的 root causes

### 1. gcloud 5 节点身份冲突

5 个 gcloud observer 全部用 anvil dev keys，与生产身份完全重叠：
- anchor-1 = anvil-2 (= server-1)
- anchor-2 + burst-1 = anvil-1 (生产无对应 server)
- burst-2 + burst-3 = 未确认（推测也是 anvil-1）

它们 `enableBft=true` 时持续 sign 并广播 BFT messages，与生产产生 equivocation。
**plan 错误假设**：以为只有 3 个 gcloud 冲突，实际 5 个全冲突。

### 2. server-2 / server-3 共用 coinbase = anvil-0

但有不同的 nodeIdentityKey（pre-Phase-2 chain 能跑就因为 nodeIdentityKey 不同——server-3 BFT signs 为 anvil-1 实际上）。
此事实直到 Phase 2 中途才搞清，原 plan「保留现状」的判断对动态切换不成立。

### 3. ValidatorRegistry Reader 行为是覆盖型

`node/src/index.ts:870-880` 显示当链上 active set 非空时，**完全替换** BFT 集（hardcoded 被忽略）。
因此 stake 必须先把所有现存身份都注册（done in Phase 1），但同步切换 reader 仍因下面问题失败。

### 4. BFT equivocation evidence 持久化、cap=100、不会随 round timeout 清

server-1/2 在 anchor-1（anvil-2 spammer）和 anchor-2/burst-1（anvil-1 spammer）运行期间累积了大量 evidence。即便停掉 spammer，cache 仍 drop 同 ID 的合法 vote。**只有 restart 才清** cache。

### 5. dynamic-set 切换下 BFT 内部 state 残留

server-2 restart 后 reader 推 active set，BFT round 67244 已 in-flight 的 cached `lastProposed` 与新 set 不一致，触发"re-broadcasting timed-out proposal"循环 + 拒绝新 proposer。

## 当前生产状态（Phase 2 回滚后）

```
chainId 18780 height 67269+ 推进中
  server-1 (209.74.64.88)   — hardcoded validators[3], BFT signs as anvil-2
  server-2 (159.198.44.136) — hardcoded validators[3], BFT signs as anvil-0?
  server-3 (199.192.16.79)  — hardcoded validators[3], BFT signs as anvil-1?
  gcloud 5 nodes — coc-node@1 全部停止（observers offline）
  ValidatorRegistry on-chain — 2 staked entries 保留（无害，reader 未启用）
```

stateRoot 三节点同步 ✓。peers=2/2/1 注：server-1/2 peer count=1 因 gcloud 全停 + 互连。

## 不变的已部署资产

- ValidatorRegistry 合约 0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e (block 30067)
- staked entries: anvil-0 + anvil-2（可后续 unstake 14d lockup）
- 独立 keypair `~/.coc/keys/anchor-{1,2}.key`、`burst-1.key` 已生成（待用）

## 未做工作（推迟至 R3.2 chainId 88780）

要做真正的 N=5 BFT，需要先解决：

1. **修 BFT 代码**：reader 切换时 invalidate cached lastProposed；evidence cache 跟 round number 关联（round timeout 时清，而非全局累积）；自我 propose 流程的 self-vote 设置确认正确进入 prepareVotes Map
2. **fork-off devnet 验证**：用 `tests/multinode-integration/scenarios/04-h15-fallback.test.ts` 体系做 reader 切换的 e2e
3. **R3.2 prod-candidate testnet (chainId 88780)**：按 `docs/r3-2-prod-candidate-testnet-88780.md`，7 个独立 BIP-39 seed，全新部署，避免 dev key 冲突
4. **gcloud 节点**：每个 VM 独立 EVM keypair 而不复用 anvil

## 重要文件 / 资产

| 路径 | 用途 |
|---|---|
| `contracts/keygen-anchors.mjs` | 生成独立 keypair |
| `contracts/stake-validator.mjs` | 用正确 ABI 调 ValidatorRegistry.stake |
| `contracts/unstake-validator.mjs` | 调 requestUnstake |
| `contracts/check-validator-set.mjs` | 查链上 active set |
| `~/.coc/keys/identities-2026-05-09.json` | 备用 keypair manifest |

## Lessons learned

1. **不要假设 plan「Out of scope」的事**：plan 标记 server-2/3 共用 coinbase 为 OOS，实际它在动态 set 切换时立刻成为阻塞。
2. **dynamic validator set 的代码路径在 prod chain 上没有 e2e 覆盖**：这次是事实上的首次实战，多个边界情况暴露。
3. **rollback 不是免费**：H15 fallback 600s timeout 意味着每次链状态卡死至少要等 10 min。
4. **reader 行为「empty fallback」是对的，但它不能保护"reader 被启用后 active set 残缺"的情况**。
5. **BFT evidence cache 的 cap=100 能防 OOM 但不能 self-heal**——一旦 cap 满了，对应 validator 的所有合法 vote 都被丢，必须 restart。

## 下一步建议

1. **保留现状**：当前 hardcoded N=3 BFT 已经满足"任 1 节点离线"的基本去中心化（H15 自救 ~10 min/cycle）
2. **不在 18780 prod 上再尝试 reader 切换**——风险太高
3. 把 N=5+ 目标推到新链（chainId 88780 R3.2）
4. 在 fork-off devnet 上跑通 reader 切换 + 添加新 validator 的全流程，再考虑迁移
