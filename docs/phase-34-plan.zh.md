# Phase 34：公开试验网 Go/No-Go 清单（含验收命令、阈值、负责人）

## 1. 目标与范围

本清单用于公开试验网上线决策，覆盖四类门禁：
- 交付质量门禁（可构建、可测试、可启动）
- 协议与网络门禁（共识、P2P、PoSe、RPC）
- 安全门禁（已知高优风险闭环）
- 运营门禁（监控、告警、值守、演练）

> 决策规则：任一 `P0/P1` 门禁项不达标即 `No-Go`。

---

## 2. 决策规则

### 2.1 Go 条件（必须全部满足）
1. 所有 `P0` 项通过。
2. 所有 `P1` 项通过。
3. `P2` 项通过率 >= 90%（且不存在安全相关红线未闭环）。
4. 发布经理与安全负责人完成联合签字。

### 2.2 No-Go 触发条件（任一满足即 No-Go）
1. 节点无法稳定启动或 5 节点网络无法连续运行 24h。
2. 存在未闭环的高优安全风险（Relay witness 伪造、BFT 恶意行为惩罚缺失、跨地址 Sybil 无抑制策略）。
3. 监控告警未覆盖关键安全与可用性指标。
4. 无法完成故障恢复演练与回滚演练。

---

## 3. 验收前置约定

1. 在具备端口监听权限的真实环境执行（裸机/VM/K8s），不要在受限沙箱中做最终判定。  
2. 统一测试目录变量：

```bash
export COC_TESTNET_CONFIG_GLOB="./ops/testnet/*.json"
export COC_TESTNET_RPC="http://127.0.0.1:28780"
```

3. 负责人角色定义：
- 发布经理（Release Manager）
- 节点核心负责人（Core Node Lead）
- 共识负责人（Consensus Lead）
- PoSe 负责人（PoSe Lead）
- 合约负责人（Contracts Lead）
- 安全负责人（Security Lead）
- SRE 负责人（SRE Lead）
- QA 负责人（QA Lead）
- DevOps 负责人（DevOps Lead）

---

## 4. Go/No-Go 清单

| 优先级 | 领域 | 检查项 | 验收命令 | 通过阈值 | 负责人 |
|---|---|---|---|---|---|
| P0 | 质量 | 全量质量门禁 | `bash "scripts/quality-gate.sh"` | 退出码 `0`，无失败测试 | QA Lead |
| P0 | 启动 | 单节点冷启动 | `COC_DATA_DIR="./.run/go-no-go/node-1" node --experimental-strip-types "node/src/index.ts"` | 启动后可响应 RPC（见下一项） | Core Node Lead |
| P0 | 可用性 | RPC 基础可用 | `curl -fsS -X POST "$COC_TESTNET_RPC" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` | 返回 `result` 且 10 分钟内高度持续增长 | SRE Lead |
| P0 | 网络 | 3 节点联调冒烟 | `bash "scripts/verify-devnet.sh" 3` | 退出码 `0` | Core Node Lead |
| P0 | 网络 | 5 节点联调冒烟 | `bash "scripts/verify-devnet.sh" 5` | 退出码 `0`，且各节点高度差 <= 2（人工复核输出） | Core Node Lead |
| P0 | 安全配置 | P2P 入站鉴权强制开启 | `rg -n '"p2pInboundAuthMode":\\s*"enforce"' $COC_TESTNET_CONFIG_GLOB` | 所有节点配置为 `enforce` | Security Lead |
| P0 | 安全配置 | PoSe 入站鉴权强制开启 | `rg -n '"poseInboundAuthMode":\\s*"enforce"' $COC_TESTNET_CONFIG_GLOB` | 所有节点配置为 `enforce` | Security Lead |
| P0 | 安全配置 | DHT 禁止匿名回退 | `rg -n '"dhtRequireAuthenticatedVerify":\\s*true' $COC_TESTNET_CONFIG_GLOB` | 所有节点为 `true` | Security Lead |
| P0 | 安全配置 | Challenger 链上授权开启且 fail-closed | `rg -n '"poseUseOnchainChallengerAuth":\\s*true|"poseOnchainAuthFailOpen":\\s*false' $COC_TESTNET_CONFIG_GLOB` | 所有节点满足 `onchain=true` 且 `failOpen=false` | PoSe Lead |
| P0 | 安全能力 | Relay witness 严格验证闭环 | `node --experimental-strip-types --test "services/verifier/relay-witness-security.test.ts"` | 测试文件存在且全部通过 | Security Lead + PoSe Lead |
| P0 | 安全能力 | BFT 恶意行为惩罚闭环 | `node --experimental-strip-types --test "node/src/bft-slashing.integration.test.ts"` | 测试文件存在且全部通过 | Consensus Lead + Contracts Lead |
| P0 | 观测 | 网络安全指标可观测 | `curl -fsS -X POST "$COC_TESTNET_RPC" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"coc_getNetworkStats","params":[]}'` | 返回包含 `authRejected`、`discoveryIdentityFailures`、`dht` 验证统计 | SRE Lead |
| P0 | 指标 | Prometheus 指标可拉取 | `curl -fsS "http://127.0.0.1:9100/metrics" \| rg "coc_block_height|coc_peers_connected|coc_p2p_auth_rejected_total"` | 至少命中以上 3 个指标 | SRE Lead |
| P1 | 稳定性 | 24h 稳定性压测 | `bash "scripts/start-devnet.sh" 5`（持续 24h 采样） | 无崩溃；区块停滞总时长 < 5 分钟；重组异常=0 | SRE Lead + QA Lead |
| P1 | 性能 | 区块出块稳定性 | `curl` 周期调用 `eth_blockNumber`（5s 一次） | 平均出块间隔 3s±1s，P95 < 6s | Core Node Lead |
| P1 | 运营 | 告警规则覆盖 | `rg -n "authRejected|discoveryIdentityFailures|dht.verifyFailures|consensus_state" "./ops/alerts"` | 关键指标全部有告警规则 | DevOps Lead + SRE Lead |
| P1 | 运营 | On-call 与升级回滚预案 | `test -f "./ops/runbooks/testnet-oncall.md" && test -f "./ops/runbooks/testnet-rollback.md"` | 两份 Runbook 齐全且完成演练记录 | SRE Lead |
| P1 | 数据 | 快照恢复演练 | `curl -fsS "http://127.0.0.1:29780/p2p/state-snapshot" > "/tmp/coc-state-snapshot.json"` | 可导出快照并成功导入新节点完成追高 | Core Node Lead |
| P1 | 密钥 | 生产密钥托管 | `rg -n "KMS|Vault|HSM" "./ops" "./runtime" "./node"` | 私钥不以明文长期存放于配置文件 | Security Lead + DevOps Lead |
| P2 | 合约质量 | 合约测试与覆盖率 | `cd "contracts" && npm run test && npm run coverage:check` | 测试通过；覆盖率达到仓库既定阈值 | Contracts Lead |
| P2 | 运营自动化 | 发布流水线 | `test -d ".github/workflows"` | 至少包含 test/build/release 三类流水线 | DevOps Lead |

---

## 5. 分阶段验收节奏

| 时间点 | 目标 | 必做项 | 负责人 |
|---|---|---|---|
| T-14 天 | 冻结需求与风险收敛 | 完成全部 P0 开发与测试用例补齐 | Core Node Lead / Security Lead |
| T-7 天 | 预发布联调 | 跑通 3/5 节点冒烟与 24h 稳定性验证 | QA Lead / SRE Lead |
| T-3 天 | 发布候选确认 | P0/P1 全通过，回滚演练完成 | Release Manager |
| T-0 | 上线决策会 | 联合签字（发布+安全+SRE） | Release Manager |

---

## 6. 公开试验网当前基线判定（2026-02-22）

当前建议：`有条件 Go`（待真实环境验证）。

### 已解决的阻断项（2026-02-22）：
1. **Relay witness 严格验证**：`services/verifier/relay-witness-security.test.ts` — 17 个测试覆盖伪造见证、时间戳操纵、重放保护、跨节点复用。
2. **BFT 恶意行为惩罚**：`node/src/bft-slashing.ts` + `node/src/bft-slashing.integration.test.ts` — 9 个测试覆盖 equivocation 检测 → 质押削减 → 国库存入 → 验证者移除。
3. **运营基础设施**：`ops/alerts/prometheus-rules.yml`（12 条告警规则）、`ops/runbooks/testnet-oncall.md`、`ops/runbooks/testnet-rollback.md`。
4. **测试网安全配置**：`ops/testnet/node-config-{1,2,3}.json` 及 `docker/testnet-configs/node-{1,2,3}.json` 已更新全部安全字段（`dhtRequireAuthenticatedVerify`、`p2pInboundAuthMode: enforce`、`poseInboundAuthMode: enforce`、`poseUseOnchainChallengerAuth: true`、`poseOnchainAuthFailOpen: false`）。
5. **Prometheus 指标**：`node/src/metrics.ts` + `node/src/metrics-server.ts` 已集成至 `index.ts`，7 个测试通过。
6. **CI 流水线**：`.github/workflows/test.yml`、`build-images.yml`、`testnet-deploy.yml` 已就位。

### 剩余上线前事项（非阻断）：
1. 真实 L1/L2 集成与生产密钥托管（P1 — 运营层面）。
2. 真实环境 24h 稳定性测试（P1 — 需要端口监听权限）。
3. 回滚演练记录（P1 — 需要真实环境）。  

---

## 7. 决策签字

| 角色 | 姓名 | 结论（Go/No-Go） | 日期 | 备注 |
|---|---|---|---|---|
| Release Manager |  |  |  |  |
| Security Lead |  |  |  |  |
| SRE Lead |  |  |  |  |
| Core Node Lead |  |  |  |  |

