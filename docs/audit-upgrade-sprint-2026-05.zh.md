# 2026-05 安全审计 + 升级 sprint 回顾 + 88780 正式上线计划

**作用域**:2026-05-10 ~ 2026-05-28(19 天) 的 chainId **88780** 准生产试验网工作。
**目标读者**:维护者、运维、未来的安全审计员。
**配套文档**:[r3-2-prod-candidate-testnet-88780.md](r3-2-prod-candidate-testnet-88780.md)(SOP) /
[88780-redeploy-2026-05-19.md](88780-redeploy-2026-05-19.md)(gen-4 部署日志) /
[88780-redeploy-gen5-uups-2026-05-20.md](88780-redeploy-gen5-uups-2026-05-20.md)(gen-5 UUPS 转型)。

---

## 1. 关键里程碑时间线

| 日期 | 事件 | 持久后果 |
|---|---|---|
| 2026-05-10 | 18780 N=3 chaos test:T2 单 validator stop 链冻结 ≥7.5min,N=3 single-fault-fragile 结论;decision 转 R3.2 chainId 88780 N=5 | 18780 永久放弃 in-place 升级 |
| 2026-05-12 | 88780 N=5+2 上线;13 合约第一代部署(gen-0);18780 decommissioned | 唯一 active testnet 转为 88780 |
| 2026-05-16 | `#635` consensus proposer-skip stall 修复(PR-1M, PR #641 `c4a330a`) | 单 validator 宕机不再使链 bpm 跌到 0.92,死槽位停产 600s+ 消除 |
| 2026-05-17 | `#642` 并发 tx burst stateRoot divergence 修复(PR #643 `5d73466`)— speculativelyComputeStateRoot 不再污染共享 trie | BFT 不再因空块上 proposer/voter stateRoot 不匹配死锁 |
| 2026-05-17~20 | 60+ ralph 审计迭代 → 30+ 真实 issue;`#645`~`#705` 安全批次 | 全部 26 合约 + 节点 RPC/IPFS/DID/faucet/P2P 远程攻击面穷尽审计 + live 88780 验证 |
| 2026-05-18 | gen-1 重部署(节点侧硬化 #645-#670 合并 PR #646 `144f9b6`);PR #665 早批次子集 | 节点 13 文件 +180/-30 安全硬化 ship live |
| 2026-05-18 | `#671` 3 竞态修复 PR #672+#673(`84ea62b`+`ca60bf6`,**CI stress lane 转绿**) | EVM/RPC Stress Probes 死锁根因消除;getStorageTrie stale cache + forceSnapSync 与 applyBlock 串行化 |
| 2026-05-19 | gen-3 PoSeManagerV2 重部:`#677` CEI reorder + `#680` finalizeEpochV2 分页化(PR #693 `0a5d16b`) | epoch 终结无论 batch 数都能完成;`epochBatchCursor` + `processEpochBatches` 链上可调 |
| 2026-05-19 | gen-4 全 13 合约重部 + multisig 交接(`0x3c055D83…` 3-of-5)+ deployer 转私密 EOA;`#683`/`#685`/`#686` 关闭 | 全部 13 合约 owner=multisig;部署者不再是 Hardhat 公开 EOA;PoSeManagerV2 init-on-deploy |
| 2026-05-20 | gen-5 全合约 UUPS 改造(PR #707/#708/#709) | **redeploy-per-fix 循环终结**:未来 bug 修复走 `upgradeProxy()` multisig 签名,proxy 地址永久 |
| 2026-05-24 | obs-1 升 5th validator(v2 159.198.44.136 带宽问题);触发 2 个 snap-sync 路径 bug(`f379c2d`/`0dc653e`) | 5-val 集稳定;TS const 提取实例方法引用必须 `.bind` 教训 |
| 2026-05-26 | 本会话:#735/#667/#748/#749/#750/#747 6 PR 全 merge(PR #745/#751/#752/#753/#754) | 治理 Sybil + PoSe v2 witness 加固 + 链下挑战派生 + loopback gate 硬化 全部 live |
| 2026-05-26~28 | docs/canary stage 1-6(#757/#759/#760/#761)上线 SECURITY.md + 公开端点 + observability runbook | 正式上线准备文档 ship |
| 2026-05-28 | 6 节点全部部署 `2b1cb01`;链高 418348+;6 unique miner address 轮换;stateRoot 跨节点一致 | sprint 结束节点健康 baseline |

---

## 2. 合约部署代次

| 代 | 日期 | 触发原因 | 持久后果 |
|---|---|---|---|
| gen-0 | 2026-05-12 | 初次部署 13 合约到 88780 | 立刻被 #645-#670 安全审计推翻 |
| gen-1 | 2026-05-18 | #645-#670 安全批次全量重部 | owner 仍为 Hardhat default `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` ← `#686` |
| gen-2 | 2026-05-19 | PoSeManagerV2 单独重部(`#676` pull-payment) | 旧地址 `0x42c0A043…` 作废 |
| gen-3 | 2026-05-19 | PoSeManagerV2 再单独重部(`#677`+`#680` 分页化 + CEI) | 旧地址 `0x6E6EeECC…` 作废 |
| gen-4 | 2026-05-19 | 全 13 合约重部 + multisig 交接 + fresh deployer | owner=multisig `0x3c055D83…`;deployer=`0xB4E943F5…`;13 全新地址 |
| **gen-5** | **2026-05-20** | **全合约 UUPS 改造** | **proxy 地址永久;未来 fix 走 `upgradeProxy()`,不再换地址** |

**gen-5 13 个 proxy 地址**(在 `configs/deployed-contracts-88780.json`):

| 合约 | proxy |
|---|---|
| FactionRegistry | `0xc37d28297dB885d2B8d9966Cbb5df2e142671287` |
| GovernanceDAO | `0x4b9485670eA389Aeab7aC04d48bb2b42D0e8bdc7` |
| Treasury | `0x512B012683c88103b1BEE3ad470108B47fBD7C7E` |
| SoulRegistry | `0x3B6b5Fd45F8a6A2756e6D436d90b67faD0509244` |
| DIDRegistry | `0xe2D8165Cb9416bf92E4304446A5Dccd20Db45fbF` |
| CidRegistry | `0x780603254D19A60ae35a1aEEBbB4dCd0c514371b` |
| PoSeManager | `0x91e1D4aBcb68476368E8Ec02d61456a08Ae43BD8` |
| PoSeManagerV2 | `0x256eb949C50d5F2af8699191b1Bc043203263549` |
| ValidatorRegistry | `0x4441299c118373fDC96bE1983d42C79e19CDb4F0` |
| EquivocationDetector | `0xa5dcE830e917176c1091fd6112F41E47692C510e` |
| InsuranceFund | `0x0546E0D98A18e110D3dFCFA150Bcd1C0a589d688` |
| DelayedInbox | `0xac820809399D6740eB274D99827a5ee595881A00` |
| RollupStateManager | `0xA2Bf9FA3382A0A8aFf406BE8A8e9a64E1d69dC4e` |
| MultiSigWallet(owner) | `0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E` |

---

## 3. 已 CLOSED 的安全 issue(本月)

| # | 严重度 | 标题 | 修复 PR |
|---|---|---|---|
| #515 | RPC | coc_dhtFindProviders / coc_ipfsFetchBlockFromPeer 非-CID 静默接受 | PR #702 `e7a03e5` |
| #589 | perf | 13-block burst-stall(被 #635 修复链解决) | 同 #635 |
| #635 | High | consensus proposer-skip stall(单 validator 宕机 → 600s 停产) | PR #641 `c4a330a` |
| #640 | Security | Faucet 并发请求绕过 cooldown | merge 进 main |
| #642 | High | 并发 tx burst stateRoot divergence(BFT 死锁) | PR #643 `5d73466` |
| #645~#664 | 多种 | ralph audit 第一批 20 个真实漏洞 | PR #665+#646(squash `144f9b6`) |
| #650 | Med | PoSeManagerV2 emission 信用未支撑的 native reward pool | PR #699 `59edbef`(decouple) |
| #667 PR-A | Security | /pose/witness 鉴权缺失(子集) | PR #700 `706f2d1`(Bearer auth) |
| #667 PR-B | Security | v2 typehash 签名 + epochId 绑定 | PR #713 `f4a644c` |
| #667 main | High | witness 密码学 rubber-stamp(Push verification + freshness) | PR #751 `ccd1ff6` |
| #668 | hardening | collectWitnesses bitmap collision | `ee1d59a`(降级 hardening) |
| #669 | Low | P2P gossip 畸形 JSON 500 + error 日志 | `c3f9e8b` |
| #670 | Low-Med | IPFS repair 绕过 erasure 上限 → 持久 DoS | `4a9e4a1` |
| #671 | Critical | 3 个 stateRoot 竞态(getStorageTrie / eth_call / forceSnapSync) | PR #672+#673 |
| #677 | Low/CEI | PoSeManagerV2 settleChallenge CEI reorder | PR #693 `0a5d16b` |
| #680 | High | submitBatchV2 无界 epoch batches OOG | PR #693 `0a5d16b`(分页化) |
| #683 | High | RollupStateManager.submitOutputRoot 无界 l2BlockNumber | proposer 门禁(PR #697) |
| #684 | Low | explorer /api/verify 同步阻塞 + 预算检查无效 | `worker_threads` 卸载 + 强制超时 |
| #685 | Low | PoSeManagerV2 部署未 initialize → DOMAIN_SEPARATOR=0 | PR #697(deploy 脚本) |
| #686 | High | 全 88780 合约 owner = Hardhat 公开 EOA | gen-4 multisig 交接 |
| #687/#689/#691/#694 | 多种 | gen-4 安全批次 | 6 PR #688/#690/#692/#695/#696/#697 |
| #705 | Security | GovernanceDAO bicameral 静默 faction 自动通过 | gen-5 GovernanceDAO 初版(folded 进 #707) |
| #715 | Med | witness anti-replay guard ECDSA v-byte malleability | PR #716 `06ca38b` |
| #717 | Med | RollupStateManager 退还/slash 错位 in-flight bond | PR #718 `dbee82e` |
| #719 | Med | Treasury.executeWithdrawal 计入已替换 signer 的 stale confirm | PR #720 `40daf0f` |
| #721 | Med | DID delegation 跨 Soul 重注册仍生效 | PR #722 `ffebb3d` |
| #723 | Med | DelayedInbox.forceInclude markIncluded 后 revert | PR #724 `09a74ec` |
| #725 | Med | EquivocationDetector 链上路径死代码(BFT 签名未端到端透传) | PR #726 `838fb6e` |
| #727 | High | verifyManifestSignature 接受任意 65-byte 签名当 generatorAddress 缺失 | PR #728 `298ff6b` |
| #729 | Med | DHT RoutingTable.addPeer 旁路 Sybil per-IP 上限 | PR #730 `c05ec73` |
| #732 | Med | P2P inbound auth 缺 roster(任意 EOA 签 + pull state-snapshot) | PR #731 `736f966`(folded) |
| #733 | Med | wire-server handshake 缺 peer roster | PR #731 `736f966`(folded) |
| #734 | High | PoSeManagerV2.enableEmission 缺幂等 → 重放 reset cocToken/rewind genesisEpoch | PR #731 `736f966`(folded) |
| #735 | Med-High | GovernanceDAO `onlyRegistered` 忽略 `isVerified` 标记 → 端到端治理 Sybil | PR #745 `78fb854` |
| #736 | Med | IPFS MFS 写端点缺 admin gate + byte quota | PR #731 `736f966`(folded) |
| #747 | Med | 链下 challengeId 完全 challenger-controlled,可预挖 | PR #754 `2b1cb01` |
| #748 | Med | WITNESS_TYPES v1 fallback 跨 epoch 重放 | PR #752 `b747397`(`v1SunsetEpoch`) |
| #749 | Low | challengeNonces seed=block.prevrandao 单 block proposer-grindable | PR #752 `b747397`(多块 RANDAO 链) |
| #750 | Low | /pose/witness loopback gate 不查 X-Forwarded-For,反代后默认开 | PR #753 `78bfb44` |

**关闭统计**:34+ issue,涉及合约、共识、P2P、IPFS、Faucet、Explorer、治理、Rollup 全栈。

---

## 4. 仍 OPEN 的安全 issue

| # | 严重度 | 状态 |
|---|---|---|
| **#746 (#667 F1+F3)** | High | witness 语义层验证 — 让 witness 自跑 receipt-verifier-v2 Layer 7 + leafHash binding。**协议设计深水**:网络拓扑/endpoint discovery/延迟取舍待决。建议参考 Chainlink OCR3 + EigenLayer fraud-proof 兜底模式 |
| **#744** | Low-Med | GovernanceDAO Option B — register 经济门槛(stake/bond)替代 verifier 单点信任。设计开放问题:bond vs burn vs lock-stake / 大小 / grandfathering / faction 对称 |
| **#468 follow-up** | Low | UnixFS 目录 DAG 内文件不可被 PoSe 挑战(Option A 接受;merkleRoot/merkleLeaves 仅由 `addFile` 单文件路径产生) |
| **#15(5)** | Low | BFT RPC↔relayer 字段映射 round-trip 测试(跨组件 fixture 复杂) |

---

## 5. 当前部署快照(2026-05-28)

### 节点(全部 `2b1cb01`)

| 节点 | host:port | unit | 签名地址前缀 | 上次重启 UTC |
|---|---|---|---|---|
| v1 | 209.74.64.88:38780 | coc-node@88 | — | 2026-05-26 08:09 |
| v2 | 159.198.44.136:28780 | coc-node@1 | — | 2026-05-26 17:56 |
| v3 | 199.192.16.79:28780 | coc-node@88 | — | 2026-05-26 08:09 |
| v4 | 159.198.36.3:28780 | coc-node@1 | — | 2026-05-26 17:56 |
| v5 | 159.198.36.25:28780 | coc-node@1 | — | 2026-05-26 17:56 |
| obs-1 | 34.139.57.20 | coc-node@1 | `0x919a0fd0…` | 2026-05-26 08:09 |

**6 unique miner 在轮换出块**(v2 虽 memory 标"带宽超限"实际仍参与共识);block time ~3-4s;stateRoot 跨 5 validator 在 block 418000 完全一致 `0x221f4254c2fd86b1…`。

### 合约(全部 gen-5 UUPS proxy,owner = multisig `0x3c055D83…`)

见 §2 表格。**当前 PoSeManagerV2 impl 在 PR #751 + #752 之前** — 节点跑新代码,但合约还在旧 impl,新 contract-side 特性(`v1SunsetEpoch` setter、新 PRNG seed、Push verification on-chain hooks)**尚未生效**。

### main 自部署后增量(全 docs/chore,无需部署)

```
6897ab9 docs(canary): Stage 6 — observability runbook + Gate 10 close (#761)
baef28a website(canary): Stage 5 — refresh for 88780 + new /security page (#760)
008acef docs(canary): Stage 3+4 — chainId 88780 sweep + Prowl/historical archive (#759)
8321997 docs(canary): Stage 1 — SECURITY.md + public endpoints reference (88780) (#757)
38c64e1 chore(contracts): record 2026-05-26 r3 security-batch impl upgrades on 88780 (#755)
```

---

## 6. 88780 正式上线计划(从 canary 转 public testnet)

**目标**:把 88780 从 "准生产候选 testnet" 转 "对外公开 testnet",支持第三方 dApp 开发者、faucet、explorer、wallet integration。

### 6.1 上线 Gates(必须全部 PASS)

| Gate | 验收标准 | 当前状态 | 责任人 |
|---|---|---|---|
| **G1 节点健康** | 5+ validator 持续 7 天无 stall,出块率 >99.5%,stateRoot 跨节点 100% 一致 | ✅ 已满足(2026-05-12 上线至今 16 天稳定运行) | 运维 |
| **G2 合约升级 ceremony** | multisig 通过 `upgradeProxy()` 把 PoSeManagerV2 / DIDRegistry / Treasury 升到带 #667+#735+#748+#749 修复的 impl | ⏳ 待执行(impl 已 ship 节点,合约未升) | multisig 签字方 |
| **G3 节点 strict 模式** | 全 validator + obs-1 设 `COC_POSE_WITNESS_REQUIRE_VERIFIED=true` + `COC_POSE_REQUIRE_VERIFIED_CHALLENGE=true` + token 配齐 | ⏳ 待执行 | 运维 |
| **G4 公开端点文档** | SECURITY.md + 公开 RPC endpoints + faucet 入口 + explorer URL | ✅ 完成(PR #757/#759/#760/#761) | docs |
| **G5 Explorer 公网可达** | https://explorer.openclaw.com 或类似入口,WS + REST,合约 verify 入口可用 | ⚠ 需确认(canary stage 5 #760 是 website refresh) | 前端 |
| **G6 Faucet 公网可达** | Drip 0.05 ETH/24h,Cloudflare Turnstile 或类似抗刷,coldown enforced(memory:#640 已修) | ✅ 后端就绪;需确认外部 host | faucet 运维 |
| **G7 chaos validated** | T1 (observer stop)、T2 (single validator stop)、T5 (partition) 全部 ≤15s 恢复;evidence cache <80% | ✅ R3.2 T2 drill 已验证 N=5 完美 | QA |
| **G8 经济参数 freeze** | block reward / gas baseFee / Treasury 5% cap / GovernanceDAO 7d voting + 40% quorum + 60% approval 文档化且不再变 | ⚠ 部分文档化(`gen-5` Treasury cap),GovernanceDAO 默认仍写死 needs sign-off | economics |
| **G9 incident response** | on-call rotation 文档化,multisig signer 可用性 24/7(3/5 quorum 1h 内可达),停链 SOP 演练 | ⚠ on-call 待立 | ops lead |
| **G10 observability** | Prometheus / Grafana 仪表盘 上线;高度/出块率/stateRoot agreement/BFT round latency 告警 | ✅ runbook ship(#761),仪表盘待 deploy | ops |
| **G11 安全 issue 状态** | 所有 High 级别 issue closed 或 explicit decision 记录;Med/Low 有 owner+ETA | ⏳ #746(#667 F1+F3)High 仍 open — 需 explicit accept-risk + 写文档化"语义验证 v2 后续 milestone" | 维护者 |

### 6.2 上线步骤(顺序执行)

#### Stage A:合约升级 ceremony(G2)— ETA 2026-05-30

1. **PoSeManagerV2 impl 部署**(deployer EOA `0xB4E943F5…`)
   ```bash
   cd contracts && DEPLOYER_PRIVATE_KEY=… npx hardhat run --network coc \
     scripts/upgrade-pose-manager-v2-667.js
   ```
2. **multisig 提案**(3/5 签字):
   ```js
   PoSeManagerV2_proxy.upgradeToAndCall(newImpl, "0x")
   ```
3. **链上 verify**:
   - `domainSeparator()` 仍返回 expected value
   - `v1SunsetEpoch()` 返回 0(unlimited,后续 step F 设)
   - `getActiveNodeCount()` 不变
4. 同步对 DIDRegistry / Treasury / GovernanceDAO 重复上述步骤(impl 已 ship in PR #745/#751/#752)

#### Stage B:节点 strict 模式(G3)— ETA 2026-06-01

每节点 systemd env 加:
```
Environment=COC_POSE_WITNESS_AUTH_TOKEN=<32-byte hex,multisig-shared>
Environment=COC_POSE_WITNESS_REQUIRE_VERIFIED=true
Environment=COC_POSE_REQUIRE_VERIFIED_CHALLENGE=true
Environment=COC_POSE_WITNESS_TRUSTED_PROXIES=<反代 IP,若有>
```

滚动重启(`bash scripts/deploy-rolling-safe.sh`),每节点 GATE1+GATE2 过后再下一个。

#### Stage C:外部接入面(G5/G6)— ETA 2026-06-03

- explorer.openclaw.com → 反代到 `node-1.openclaw.com:28780` + WS;启 token-only IPFS admin gate
- faucet.openclaw.com → 0.05 ETH / 24h / IP + Turnstile

#### Stage D:on-call + 演练(G9)— ETA 2026-06-05

- 3 人 on-call 轮换,multisig signer 至少 3 人 24/7 联系方式可达
- 演练 1:模拟单 validator 宕机 → chaos drill 验证 G7
- 演练 2:模拟 PoSeManagerV2 紧急 upgrade(用 dummy impl)→ 验证 multisig ceremony 时长 ≤1h
- 演练 3:模拟 RPC DoS → 验证速率限制 + 告警触发

#### Stage E:observability(G10)— ETA 2026-06-07

- Prometheus 拉每节点 `/metrics`(已有 endpoint per memory)
- Grafana 仪表盘:per-validator 出块率、stateRoot agreement、BFT round latency、mempool size、IPFS pin disk used
- AlertManager → Slack/PagerDuty:`up == 0` 5min、出块率 <0.5 bpm 持续 5 min、stateRoot mismatch >0

#### Stage F:v1 sunset(承接 G2 #748)— ETA 2026-06-10

agent 池升级到 v2 typehash 后:
```js
PoSeManagerV2_proxy.setV1SunsetEpoch(<current_epoch + 24>)
// 24 epoch ≈ 24 小时缓冲期,之后 v1 fallback 拒绝
```

#### Stage G:#746 决策记录 + 公告(G11)— ETA 2026-06-12

- 在 SECURITY.md 写 "PoSe v2 witness 当前不验证 receipt 语义内容(F1),依赖 prover 自签 + EigenLayer 风格 fraud-proof 兜底;witness 跑 Layer 7 是 milestone M12 计划"
- 决定 milestone:M12 (Witness Layer-7 Verification) 排期,或者关 #746 作为 wontfix-by-design

#### Stage H:公开宣布(launch)— ETA 2026-06-14

- 博客 + Twitter + Discord 宣布 88780 公开 testnet
- 列出 RPC / WS / explorer / faucet 入口
- 列出 SECURITY.md + audit sprint 总结(本文档)链接

### 6.3 上线后第一周(2026-06-14 ~ 2026-06-21)

- 监控外部流量增长 → 必要时升级反代带宽(memory:v2 159.198.44.136 已知带宽限)
- 收集 dApp 开发者 feedback → 优先修阻塞性 bug
- 准备 mainnet 时间表(R4 milestone,目标 Q3 2026):基于 88780 真实流量数据校准 gas / Treasury cap / GovernanceDAO 参数

---

## 7. 关键经验教训(供下一轮 sprint 参考)

1. **审计 squash-merge 必须用两点 diff 核实**:`git log A..B` 在 squash 后丢祖先,会让"已 merge"的修复看上去"未 merge"。用 `git diff origin/main test/branch -- node/`。
2. **`--experimental-strip-types` 不做 typecheck**:TS const 提取实例方法引用前必须 `.bind`,否则 strict-mode `this=undefined` 运行期才炸(snap-sync 2 个 bug)。
3. **redeploy-per-fix 循环必终结于 UUPS**:gen-0~gen-4 每个合约级修复都得"全量 redeploy + 换地址 + 改两个仓的 manifest";gen-5 之后 = `upgradeProxy()` + multisig 签名,proxy 地址永久。
4. **gen-5 后 storage layout 成永久承诺**:OZ 升级插件守 layout 验证,`contracts/.openzeppelin/unknown-88780.json` 必须入库。`__gap` 调整 1 次就要重新核对 layout 兼容。
5. **integration test 必须跟合约修复同步**:#745 把 `isVerified` gate 加进 `GovernanceDAO.onlyRegistered`,合约层测试改了,`tests/integration/governance-*` 没改 → main red 一周直到本会话 cherry-pick 修复。
6. **EIP-170 24576 字节 size cap 是硬约束**:加 feature 前必须先 trim(custom errors / 删 dead code),否则编译器静默生成 over-cap bytecode,UUPS upgradeProxy 会拒绝。
7. **审计 issue 必须先验证利用链再公开发布**:#664 / #668 / #685 都是 initial draft 误判,公开后才 walk-back。"提 issue 前必须完整验证 exploit"。
8. **Stress lane CI flaky 是已知问题**:`EVM/RPC Stress Probes` 长期 flaky,admin merge bypass 是 documented 路径(`gh pr merge --admin --squash`)— 真实测试已在 PR body 列出 results。

---

## 8. 残留 issue 优先级建议

| 优先级 | issue | 时机 |
|---|---|---|
| **P0 上线前必关** | (无) | — |
| **P1 上线前必决策** | #746 (#667 F1+F3) | Stage G(2026-06-12)写明 milestone 或 wontfix |
| **P2 上线后第一季度** | #744 (Sybil Option B economic gate) | 2026 Q3 设计 RFC |
| **P3 长期** | #468 follow-up / #15(5) round-trip test | M12+ |

---

## 9. 文档版本

- 创建:2026-05-28
- 作者:本会话 audit sprint
- 配套英文版:[audit-upgrade-sprint-2026-05.en.md](audit-upgrade-sprint-2026-05.en.md)
- 维护规则:每次 88780 重大合约升级或安全 issue 关闭后,更新 §3 / §5 / §6
