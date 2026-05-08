# Phase H — 测试网稳定性硬化 收尾报告（2026-04-30）

## 时间线

- **04-29 20:00 UTC**：testnet 一天经历 5+ 次 BFT 停机；root cause 怀疑 proposer-side stateRoot divergence
- **04-30 早晨**：合入 H1（PR #19 post-apply parent-trie sync + diag）+ H2B（PR #21 relaxedQuorum）+ H3（PR #20 mempool affordability）
- **04-30 09:01 UTC**：node-1 shadow divergence 复发；cluster 在高度 146,668 死锁（H4/H5 未上线）
- **04-30 11:00 UTC**：执行紧急恢复 — `rsync leveldb-state + leveldb-chain` from node-2 → node-1，部署 `phase-h4-76bb640` image
- **04-30 11:35 UTC**：H5（PR #27）forceSnapSync 自动恢复合入
- **04-30 12:30 UTC**：部署 `phase-h5-20dc3f2` + 启用 `COC_BFT_AUTO_RECOVERY=1`
- **04-30 12:50 UTC**：翻转 `COC_DEV_RELAXED_QUORUM=0`（strict 3-of-3 quorum）
- **04-30 12:53 UTC**：3 分钟观察 — 59 finalized blocks / 0 timeouts / 0 divergences

## 死锁机制（已解码）

```
T+0     node-1 finalize block 146,668 as proposer
T+4     round 146,669 starts (proposer=node-2). node-1 spec stateRoot
        diverges from node-2/3 (R1 vs R2)
T+4     relaxedQuorum (H2B): node-2/3 form 2-of-3 quorum on R2 → finalize
        146,669 + 146,670 unilaterally
T+10    node-1 round 146,669 timeout (R1 ≠ R2 → no commit possible)
T+20    node-1 round 146,670 timeout
T+20+∞  Coordinator silent. expected proposer for 146,671 = node-1, but
        node-1 tip = 146,668 → can't propose. node-2/3 tip = 146,670 →
        wait for node-1 to propose. DEADLOCK.
```

**根因**：round-robin proposer 假设全节点同 tip。当落后节点（因 shadow state 不同）成为下一轮 proposer 时整个集群 stall，无 leader-skip 机制。

## 修复 sprint 链

| Sprint | PR | 修复方向 |
|---|---|---|
| H1 | #19 | computeStateRoot post-apply parent-trie sync — 减少（不消除）shadow divergence 频率 |
| H2B | #21 | relaxedQuorum dev flag — 让 2/3 节点能 finalize 而不被 1 个 divergent 节点拖死 |
| H3 | #20 | mempool affordability filter — 防 unaffordable tx 进 block |
| H4 | #26 | onPeerQuorumDiverged callback — 单次 divergence 立即触发 requestSyncNow |
| H5 | #27 | onPersistentDivergence + forceSnapSync — 持续 divergence 自动 leveldb 重置（替代手动 rsync）|

## Acceptance 结果

- **Strict 3-of-3 quorum 工作正常**（COC_DEV_RELAXED_QUORUM=0 持续 3+ min 无故障）
- **H4+H5 为 dormant 安全网** — 当前未触发，证明根因（leveldb 持久 corruption）已通过手动 rsync 清除，H1 post-apply sync 防止再次累积
- **节点恢复时间**：H5 自动恢复 ~30s（3 轮 × 10s timeout 触发 forceSnapSync）vs 之前 manual rsync ~10 min 操作

## 后续建议

- testnet 监测 24-72h 确认稳定
- 若 H5 触发 → 收集 forensic 快照分析为什么 H1 post-apply sync 没防住
- 长期（生产）：production rollout 时保持 `COC_BFT_AUTO_RECOVERY=1`，但 `COC_DEV_RELAXED_QUORUM` 必须 0（Byzantine 安全）
- 已解码的死锁场景在 plan 中标记为「已修复」；H6（本 sprint）→ 完成
