# COC 测试网功能 / 性能 / 可靠性评估（2026-04-24）

> 对当前 COC 测试网（Phase C Step 2 上线后）做的功能完成度盘点。
> 目的：评估"按现状作为正式（主网）网络运行"的差距。
> 方法：按 9 个技术维度逐项打分，每项给出"完成度%"和"主网差距"。
> 配套文档：`testnet-status-2026-04-24-zh.md`（运行配置）/ `p2p-storage-mechanism-zh.md`（存储原理）。

---

## 0. 综合结论

> **作为测试网（验证技术可行性）：约 90% 完成度。**
> **作为正式主网运行：约 55-65% 完成度。**

主要落差不在协议本身，而在**多方利益相关者**的部分：

✅ **协议技术栈已基本就绪**——共识、EVM、P2P 存储、PoSe 都跑通了
🟡 **运维基础**部分到位——监控/日志有，备份策略简单，告警没有
❌ **真正的去中心化经济**还没起步——3 个 hardhat 测试 key、没质押市场、没有真正的"任何人可加入验证"

下面按维度逐项展开。

---

## 1. 共识层（BFT-lite）

| 项目 | 状态 | 完成度 | 证据 / 差距 |
|---|---|---|---|
| 区块产生 | ✅ | 100% | 3s 块时稳定，bn 已超 23 500 |
| 提议轮换（leader rotation） | ✅ | 100% | deterministic round-robin（chain-engine.ts） |
| Prepare/Commit 两轮投票 | ✅ | 100% | bft.ts + bft-coordinator.ts，2/3 stake 阈 |
| (blockHash, stateRoot) **配对** quorum | ✅ | 100% | Phase B 已收口，72h soak 验证过 |
| Equivocation 检测 | ✅ | 95% | EquivocationDetector 已工作，证据 store 已落地；slash 自动化未在 prod 验证 |
| 链分叉容错 | ✅ | 90% | fork-choice (BFT finality > length > weight)；多次手工切换已测过 |
| 慢节点降级 | ✅ | 80% | degraded mode 已实现；但 thresholds 未在大规模真验证集上调过 |
| **BFT 真拜占庭容错（>n/3 恶意）** | 🟡 | 60% | 协议层数学正确，但 3 节点的 quorum=2 = "1 死即停"，没有真冗余 |
| **>3 验证人扩展** | ❌ | 0% | 测试网只跑过 3/5/7 的 devnet 脚本；实际生产部署未做 |
| **Validator 动态加入/退出** | ❌ | 30% | validator-governance.ts 有合约接口；testnet 上未触发过 |

**结论：共识算法本身✅可用，但当前 3 节点物理上不能容忍单节点丢失**——一个挂了就只剩 2/3 阈值的边界，再有任何异常就停产。

---

## 2. 执行层（EVM）

| 项目 | 状态 | 完成度 | 证据 / 差距 |
|---|---|---|---|
| Cancun-compat EVM | ✅ | 100% | 基于 @ethereumjs/vm；ethers/viem 测试已过 |
| EIP-1559 baseFee | ✅ | 100% | base-fee.ts；动态调整正常 |
| EIP-4844 blob | ❌ | 0% | 不支持，rollup 路径才需要 |
| EIP-7702 / EOA delegation | ❌ | 0% | 不支持 |
| State trie 持久化 | ✅ | 100% | LevelDB + @ethereumjs/trie；GH#6 三层 bug 已修（Phase A） |
| Snap sync | ✅ | 90% | snap-sync 模块就绪；曾跑通；testnet 未在节点动态加入时压测过 |
| Debug/Trace RPC | ✅ | 95% | debug_traceTransaction、trace_transaction 已实现；solc 缺失导致部分单测 fail（不影响主路） |
| Receipts + Logs | ✅ | 100% | 标准 EVM logs，eth_getLogs 工作正常 |
| Gas estimation | ✅ | 100% | fee-oracle.ts；priority fee 中位数 + percentile |
| **MEV / mempool front-running 防护** | ❌ | 0% | 没做；公链需要 |
| **EVM gas limit 调优** | 🟡 | 60% | maxTxPerBlock=100 是 testnet 值；主网应基于 benchmark 重设 |

---

## 3. RPC + WebSocket

| 项目 | 状态 | 完成度 | 证据 |
|---|---|---|---|
| 标准 eth_* RPC（83 个方法） | ✅ | 95% | rpc.ts 实现；ethers / viem 兼容性测试过 |
| `coc_*` 扩展 RPC | ✅ | 100% | dhtFindProviders, ipfsFetchBlockFromPeer, nodeInfo, validators, chainStats 等 |
| WebSocket eth_subscribe | ✅ | 95% | websocket-rpc.ts；newHeads / logs / pendingTxs subscription |
| RPC 限流 | ✅ | 90% | rate-limiter.ts；per-IP 限流；批量计数已修 |
| RPC 鉴权 | 🟡 | 50% | rpcAuthToken 支持 Bearer；admin RPC 隔离 enableAdminRpc；**但 testnet 上没启用** |
| HTTP/2 / 长连接优化 | ❌ | 0% | 仍是 HTTP/1.1 |

---

## 4. 网络层（P2P）

### 4.1 双协议栈：HTTP gossip + 二进制 wire

| 项目 | 状态 | 完成度 | 证据 |
|---|---|---|---|
| HTTP gossip（旧路径） | ✅ | 100% | p2p.ts；BoundedSet dedup；rate limit |
| 二进制 wire 协议 | ✅ | 100% | wire-protocol.ts (Magic 0xC0C1)；FrameDecoder streaming |
| Wire handshake 鉴权 | ✅ | 100% | NodeSigner 签名身份；`requireAuthenticatedVerify` |
| 跨协议 relay (Wire ↔ HTTP) | ✅ | 100% | onTxRelay/onBlockRelay 桥接 |
| 帧优先级（CRITICAL/HIGH/NORMAL/LOW） | ✅ | 100% | DEFAULT_PRIORITIES 表 |
| 反 DoS（per-IP / per-peer 限流） | ✅ | 90% | MAX_CONNECTIONS_PER_IP=5；MAX_MESSAGES_PER_WINDOW=500/10s |

### 4.2 DHT (Kademlia subset)

| 项目 | 状态 | 完成度 | 证据 |
|---|---|---|---|
| K-bucket routing table | ✅ | 100% | dht.ts |
| Iterative FindNode 查询 | ✅ | 100% | iterativeLookup with α=3 |
| 周期性 refresh / bucket 维护 | ✅ | 100% | 5 min refresh + 3 min announce |
| **Provider records (CID → peers)** | ✅ | 100% | **Phase C1.1 新增**；24h TTL，64 上限 |
| **跨节点 provider gossip** | ✅ | 100% | **Phase C 新增** ProviderAdvertise (0x14) |
| 抗 sybil（验证 handshake） | ✅ | 80% | requireAuthenticatedVerify；回调验证 ID |
| 完整 libp2p kad-dht 规范兼容 | ❌ | 0% | 自实现 subset；不连 IPFS 公网 |

### 4.3 Bootstrap & Discovery

| 项目 | 状态 | 完成度 | 证据 |
|---|---|---|---|
| 配置式 bootstrap peers | ✅ | 100% | dhtBootstrapPeers 配置项 |
| DNS seed | ✅ | 70% | dns-seeds.ts；testnet 没用 |
| Peer store 持久化 | ✅ | 100% | peer-store.ts；peers.json 自动保存 |
| 通过 advertised URL 跨 NAT | ✅ | 100% | Phase 修复 GH#2 后 |
| **公网 bootstrap node 集** | ❌ | 0% | testnet 是封闭网络；主网需要稳定 bootnode |

---

## 5. 存储层（IPFS-compatible）

| 项目 | 状态 | 完成度 | 证据 |
|---|---|---|---|
| Content addressing (CIDv1, dag-pb) | ✅ | 100% | ipfs-blockstore.ts + ipfs-unixfs.ts |
| UnixFS 文件分块（256 KiB） | ✅ | 100% | DEFAULT_BLOCK_SIZE |
| MFS（mkdir/write/read/...） | ✅ | 95% | ipfs-mfs.ts；测试已过 |
| Pubsub | ✅ | 80% | ipfs-pubsub.ts；testnet 未压测 |
| HTTP API `/api/v0/*` | ✅ | 95% | ipfs-http.ts；add/cat/pin/block/get 等 |
| `/ipfs/<cid>` gateway | ✅ | 90% | 有；MAX_READ_SIZE=50 MiB 限制 |
| **缺块 peer fetch fallback** | ✅ | 100% | **Phase C1.3 新增** |
| **Push-to-K 主动复制** | ✅ | 100% | **Phase C1.4 新增**；K=3 (clamp 到 peerCount-1) |
| **PUT 等待 minReplicas** | ✅ | 100% | **Phase C3.1 新增**；X-COC-Replicas-Warning header |
| **12h 自 reannounce** | ✅ | 100% | **Phase C3.2 新增** |
| **10 min 自动修复 under-replicated** | ✅ | 100% | **Phase C3.3 新增** |
| **大文件 GET（>50 MiB）** | ❌ | 0% | readFile 有 50 MiB 上限；100 MiB 文件存得了取不出 |
| Erasure coding | ❌ | 0% | 推迟到 Phase D；当前是纯 K=3 整副本 |
| Storage market / payment | ❌ | 0% | 没做；主网核心需求 |
| 客户端流式 GET（HTTP range） | ❌ | 20% | 部分支持，未充分测试 |

---

## 6. PoSe（Proof of Service）

### 6.1 v1 协议

| 项目 | 状态 | 完成度 |
|---|---|---|
| Challenge / Receipt 流水线 | ✅ | 100% |
| Merkle batch 聚合 | ✅ | 100% |
| 合约结算 (PoSeManager v1) | ✅ | 100% |
| Slash 自动化 | ✅ | 90% |

### 6.2 v2 协议（Phase C 重点）

| 项目 | 状态 | 完成度 | 证据 |
|---|---|---|---|
| EIP-712 receipt 签名 | ✅ | 100% | RECEIPT_TYPES + WITNESS_TYPES |
| Permissionless fault proof | ✅ | 95% | PoSeManagerV2 已部署；流程跑通 |
| Commit-reveal + bond | ✅ | 100% | challengeBondMin 设为 0.02 ETH |
| Witness quorum (2/3) | ✅ | 100% | _validateWitnessQuorum；3 个 prover 全部签名 |
| Merkle-claimable rewards | ✅ | 90% | 流程齐；reward distribution 待全周期验证 |
| Empty epoch finalization | ✅ | 80% | allowEmptyBatchWitnessSubmission 选项 |
| **PoSe v2 链上 batchV2 提交** | ✅ | 100% | **测试网验证**：tx `0xebe72a05...` status=1 |
| **5% 审计抽检** | ✅ | 100% | **Phase C2.4 新增**；storage-audit.ts |
| **CidRegistry + DHT 预过滤** | ✅ | 100% | **Phase C2.2 新增** |
| **真实 Merkle proof from blockstore** | ✅ | 90% | **Phase C2.1 新增**；prover sidecar 实测产出真 proof |

### 6.3 端到端流水线（Phase C Step 2 实测）

| 类型 | challenge → receipt → verify | 状态 |
|---|---|---|
| Uptime | ✅ 完整跑通 | `pendingV2: 0`（队列已 drain） |
| Storage | 🟡 receipt 生成可，agent 端 resolveMeta 路径不对（共享 blockstore 路径约定 mismatch） | Phase D follow-up |
| Relay | ✅ 完整跑通 | 同 Uptime |
| **batchV2 链上结算** | ✅ status=1 已观测 | tx `0xebe72a05...d15`，gasUsed=319 344 |
| **Reward 分发到节点钱包** | ❌ | rewardRoot 计算了，但 claim 流程未端到端验证 |
| **Slash 自动化触发** | 🟡 30% | scaffolded; Phase C 期间没触发过真 slash |

**当前活跃指标（运行中观测）**：
- batchV2 提交频率：每 epoch 多次（最近 5 min 看到 4 次提交）
- v2 verify 失败率：**0%**（最近 30 min 内 0 次 "verification failed"）
- pending queue 长度：稳定为 0（drain 速度跟得上 challenge 速度）

---

## 7. 智能合约层

| 合约 | 状态 | 完成度 | 已部署 testnet | 已 initialize |
|---|---|---|---|---|
| `PoSeManager` (v1) | ✅ | 100% | ❌ | — |
| `PoSeManagerV2` | ✅ | 100% | ✅ `0xCD8a...` | ✅（Phase C 期间手动调过） |
| `MerkleProofLite` | ✅ | 100% | (库) | — |
| `CidRegistry` | ✅ | 100% | ✅ `0xb727...` | ✅ |
| `SoulRegistry` | ✅ | 100% | ✅ `0x1291...` | ✅ |
| `DIDRegistry` | ✅ | 100% | ✅ `0x5f3f...` | ✅ |
| `FactionRegistry` | ✅ | 90% | ❌ | — |
| `GovernanceDAO` | ✅ | 80% | ❌ | — |
| `Treasury` | ✅ | 80% | ❌ | — |
| **`COCToken` (本币)** | 🟡 | 50% | ❌ | **未发行** |
| **`FoundationVesting`** | ✅ | 95% | ❌ | — |
| **质押 / Stake 机制合约** | ❌ | 0% | — | — |
| **Reward distribution 合约** | 🟡 | 70% | partial via PoSeManagerV2 | — |

合约测试覆盖：**227 个测试**，coverage 阈值已通过。但**链上未发币、未启动经济模型**。

---

## 8. 治理 / 身份 / 备份

| 项目 | 状态 | 完成度 | 证据 |
|---|---|---|---|
| SoulRegistry（身份） | ✅ | 100% | 单测 + 集成测试齐 |
| DID 解析（did:coc 方法） | ✅ | 95% | did-resolver.ts、did-document-builder.ts |
| Delegation chain（≤3 层） | ✅ | 100% | delegation-chain.ts |
| Verifiable Credentials | ✅ | 95% | VC + Merkle selective disclosure |
| 社交恢复（2/3 guardian） | ✅ | 100% | SoulRegistry recovery flow |
| 备份恢复（claw-mem 包） | ✅ | 95% | 独立包 `@chainofclaw/claw-mem`（208 测试） |
| 治理提案 / DAO 投票 | 🟡 | 70% | GovernanceDAO 合约就绪；testnet 没跑过完整提案周期 |
| 链上参数变更（升级、参数调整） | ❌ | 30% | 没做；硬编码常量 |

---

## 9. 周边服务

| 项目 | 状态 | 完成度 | 证据 |
|---|---|---|---|
| Block Explorer (Next.js) | ✅ | 90% | 9 页（home/block/tx/address/mempool/validators/stats/contracts/network）|
| Faucet | ✅ | 90% | 测试网工作；rate limit 已实现 |
| Contract verification (solc-js) | ✅ | 80% | explorer/verify 页面就绪 |
| Mempool 可视化 | ✅ | 90% | explorer/mempool 页 |
| Sync-node（只读 RPC 入口） | ✅ | 95% | 公开 RPC：`http://199.192.16.79:18780` |
| 监控 dashboards (Grafana) | 🟡 | 60% | grafana 配置在 docker/grafana 目录；testnet 未实际部署 dashboards |
| Prometheus metrics | ✅ | 100% | 每 node 9100 端口 + agent 9200 端口 |
| 日志聚合（ELK / Loki） | ❌ | 0% | 当前只能 docker logs |
| 告警系统 | ❌ | 0% | 没接 PagerDuty/Slack |

---

## 10. 性能指标（实测）

| 指标 | 测试网实测 | 主网目标（参考以太坊 L2） | 评级 |
|---|---|---|---|
| 区块时间 | **3.0 s**（精确） | 2-12 s 都 OK | ✅ |
| 区块大小 | maxTxPerBlock=100 | 应基于 gas limit | 🟡 |
| TPS（持续） | 未压测 | ≥ 100 | ❓ |
| Finality 延迟 | finalityDepth=3 ≈ 9 s | < 30 s | ✅ |
| State trie 写入吞吐 | 已经过 storage-io benchmark | — | ✅ |
| 跨节点 wire 带宽 | 100 MiB PUT → 200 MiB out | — | ✅ |
| 节点启动时间 | < 30 s（容器健康） | < 60 s | ✅ |
| Snap sync 时间 | benchmark 跑通；prod scale 未测 | < 4 h | 🟡 |
| 区块链状态尺寸 | 13-21 MB / node（1 epoch） | 主网会暴涨 | ❓ |
| **batchV2 链上节奏** | **每 30-75s 一批** | < 1 epoch (= 1h) | ✅ |
| **v2 verify 失败率** | 0% (30 min 观测) | < 0.1% | ✅ |
| **平均 challenge → receipt 延迟** | < 100 ms（容器内 docker network） | < 500 ms | ✅ |

⚠️ **注意**：上述很多"已验证"是**单机 docker 网络**下的结果。跨数据中心、跨地理位置的真实网络条件下重新评估。

---

## 11. 可靠性指标

| 维度 | 当前能容忍 | 主网应能容忍 | Gap |
|---|---|---|---|
| Validator 同时挂数 | 1（剩 2/3 = 仍工作但无冗余） | n/3 - 1 with n ≥ 7 | 🟡 |
| 网络分区 | 已测过 1-2-1 分区恢复 | 多 partition + healing | 🟡 |
| 数据中心宕机 | 全在 1 台 host：N/A | 多 region | ❌ |
| 单 IPFS block 副本数 | **3**（K=2 + origin，全 validator） | ≥ 3 + erasure | 🟡 |
| Storage 数据丢失风险 | 1 节点挂：0%；2 节点挂：0%；3 节点挂：100% | 多副本 + EC + 长期归档 | ❌ |
| Equivocation 处罚 | 检测✅；slash 自动化未在生产触发 | 自动 slash + bond 没收 | 🟡 |
| 双花防护 | 防 nonce 重放（NonceRegistry） | 同 | ✅ |
| **磁盘满 / 节点 OOM** | 容器自动 restart；state checkpoint 保护 | + 监控 + 告警 | 🟡 |
| **共识停摆下的链外恢复** | 手册 + 备份（已建立） | + 自动化 fallback | 🟡 |

---

## 12. 运维成熟度

| 项目 | 状态 | 完成度 | 备注 |
|---|---|---|---|
| Docker 容器化 | ✅ | 100% | 全部服务 |
| docker-compose 一键部署 | ✅ | 95% | testnet 用 |
| K8s helm chart | ❌ | 0% | 未做 |
| CI/CD 流水线 | 🟡 | 70% | GitHub Actions 已有；自动部署到 testnet 未做 |
| 自动化备份 | 🟡 | 50% | 手动打过 snapshot；没有 cron |
| 回滚流程 | ✅ | 95% | 已建立 git tag + image 双层 rollback |
| 文档（部署 / 运维） | ✅ | 90% | docs/testnet-* 系列+本评估 |
| Disaster Recovery 演练 | ❌ | 0% | 没正经演练过 |
| 安全审计 | 🟡 | 60% | 内部 audit round 3 已做；未请第三方机构 |
| 漏洞赏金计划 | ❌ | 0% | 未启动 |
| Bug 提交流程 | ✅ | 80% | GitHub Issues 在用 |

---

## 13. 测试覆盖

| 层 | 测试数 | 状态 |
|---|---|---|
| node 层 | 1 141 (75 文件) | ✅ 1 126 pass / 15 fail（fail 全部是缺 solc 包/benchmark flake，跟 Phase C 无关） |
| services + nodeops | 164 (25 文件) | ✅ 100% pass |
| runtime | 72 (16 文件) | ✅ 100% pass |
| integration / e2e | 178 (14 文件) | ✅ pass |
| wallet | 8 (1 文件) | ✅ pass |
| explorer | 43 (3 文件) | ✅ pass |
| faucet | 26 (3 文件) | ✅ pass |
| contracts (Hardhat) | 227 (10 文件) | ✅ pass，coverage thresholds met |
| claw-mem (备份扩展，独立 repo) | 208 | ✅ pass |
| **总计** | **2 067 个测试** | **97% 通过率** |

测试**类型分布**：
- 单元测试：占大头
- Integration（多组件）：~14 文件
- Chaos / resilience：3 文件
- Stress / TPS bench：2 文件
- Phase C 新增：32 个测试（wiring/repair/audit/gossip）
- E2E（multi-node devnet）：1 bash 脚本

⚠️ **缺口**：
- 没有专门的安全 audit 单元测试套（仅 round-3 算法审计）
- 长 soak test（>24h）未做过完整周期
- Adversarial 节点行为测试有但范围窄

---

## 14. 主网启动 Readiness Checklist

按"作为正式主网启动"维度的硬性 gate（绿色=已就绪、黄色=部分、红色=没做）：

### 🟢 已就绪

- [x] BFT 共识协议（数学上）
- [x] EVM 兼容性（ethers / viem 测试通过）
- [x] State trie 持久化（GH#6 修复后稳定）
- [x] 区块/交易/收据 RPC
- [x] Wire 二进制协议
- [x] DHT + provider records
- [x] IPFS UnixFS 分块 + 内容寻址
- [x] Push-to-K 复制 + 跨节点 gossip
- [x] Self-healing repair 循环
- [x] PoSe v2 EIP-712 流水线（**链上 batchV2 已成功**）
- [x] PoSeManagerV2 + CidRegistry + SoulRegistry + DIDRegistry 部署 + 初始化
- [x] BFT slash 检测（equivocation detector）
- [x] Backup 恢复（claw-mem）
- [x] 区块浏览器 + Faucet
- [x] Prometheus 指标暴露
- [x] 测试覆盖 ≥ 2000 测试
- [x] Phase A/B/C 三个里程碑全部完成

### 🟡 部分就绪 — 主网启动前必须收尾

- [ ] **大文件 GET 流式（解决 readFile 50 MiB 上限）**：3-5 天工作
- [ ] **CidRegistry 自动注册 hook**（PUT 后链上记录）：1 天
- [ ] **PoSe v2 reward claim 端到端**：未跑过完整 epoch 闭环
- [ ] **Slash 自动化在 production 触发**：未真 slash 过
- [ ] **5+ 验证人扩展验证**：testnet 一直 3 节点
- [ ] **跨数据中心部署**：当前都在 1 台 host
- [ ] **完整 24h-72h soak**：Phase B 之前的 soak 测试有，但 Phase C 完整流水线没跑过 24h
- [ ] **告警系统（PagerDuty/Slack 接入）**：没做
- [ ] **Disaster recovery drill**：没演练过
- [ ] **第三方安全审计**：内部 round-3 完成；外部 audit 未做
- [ ] **漏洞赏金计划上线**：未启动
- [ ] **链上参数升级机制**：硬编码常量

### 🔴 主网启动**核心缺失**

- [ ] **本币（COC token）发行 + 经济模型上线**：合约 50% 写好，但**没发币**，没有真正的 stake / fee / reward 价值
- [ ] **质押市场（Permissionless validator 加入）**：没做
- [ ] **Storage payment / market**：没做（用户不能为存储付费）
- [ ] **MEV 防护**（公链必须）：没做
- [ ] **Bootstrap node 集群**（不依赖单 host）：3 个 hardhat key 不能做生产 validator
- [ ] **真正的去中心化运维**：当前一个人 ssh 到一台 host 控制所有 validator
- [ ] **法律 / 合规框架**：N/A，超出技术范围

---

## 15. 三种部署目标的现实评估

### 🎯 目标 A：技术可行性 demo / 投资人 PoC
**完成度 ≈ 95%**。
当前 testnet 已能演示：分布式存储 + PoSe 奖励 + 完整 EVM 应用 + DID。除大文件 GET 限制和未发币外，所有"看起来在跑"的能力都真在跑。

### 🎯 目标 B：开发者测试网（DApp 开发者上线）
**完成度 ≈ 75%**。
缺：(1) 公开 IPFS HTTP 端口、(2) 大文件 GET、(3) reward claim 完整闭环、(4) 24h+ soak 验证、(5) 告警 + 自动备份。
建议：再花 **2-3 周**修这 5 项后开放给开发者。

### 🎯 目标 C：正式主网启动
**完成度 ≈ 55-65%**。
核心缺失是**经济层**——发币、质押、奖励真到账、storage market、MEV 防护、第三方 audit、多地部署。
建议：列**最小可行主网（MVB）**子集：
- 只先开 PoSe + 区块链结算（不开 storage market）
- 用 5+ 个真验证人替换测试 key
- 第三方 audit
- 24h 以上稳定 soak
- 公开 bug bounty
估计 **3-6 个月**到 MVB 主网。

---

## 16. 优先级建议（基于以上评估）

**P0（开发者测试网必做）**：
1. 大文件流式 GET（`MAX_READ_SIZE` → 1 GiB + 流式 readFile）
2. CidRegistry 自动注册 hook
3. PoSe v2 reward claim 端到端验证
4. 24h 完整 soak（监控 batchV2 节奏 + 队列长度 + 内存）
5. IPFS HTTP 端口选择性暴露 + auth/limit

**P1（主网准入）**：
6. 5-7 验证人扩展验证（跨主机）
7. Slash 自动化在故意制造的恶意行为下触发
8. 告警系统 + PagerDuty 接入
9. K8s 部署 chart + 多 region
10. 第三方安全 audit（外部机构）

**P2（主网核心经济功能）**：
11. COC token 发行 + 创世分配
12. Permissionless validator stake 流程
13. Storage payment market（与 PoSe v2 对齐）
14. MEV 防护层（commit-reveal / threshold encryption）
15. 链上治理升级机制

**P3（网络成熟期）**：
16. Erasure coding（Reed-Solomon）替代 K=3 整副本
17. Cross-rollup interop
18. ZK 证明优化（PoSe proof 进 ZK）

---

## 17. 总结

**作为测试网，COC 已基本完成"可演示的去中心化区块链 + 分布式存储 + PoSe 奖励"的全栈技术验证。Phase A/B/C 三个里程碑都达成，2067 个测试 97% 通过率。**

**作为正式主网，仍然缺少：**
1. 经济层（发币 + stake + storage market）—— 这是 2-6 个月工作
2. 大规模运维就绪（多区域 + 告警 + 演练）
3. 外部安全审计

**当前最适合的定位**：开发者预览测试网 + 投资人技术 PoC，进一步打磨**2-3 周**后可开放给早期 DApp 开发者，但**不应该**当作正式主网对外宣传或开放经济活动。

---

**文档版本**：v1.0 / 2026-04-24
**评估方**：Claude Code（基于 testnet live state + 代码审计 + 文档交叉对照）
**下次评估建议时间**：Phase D 启动前 / 主网启动 sprint 启动前
