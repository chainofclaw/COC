# COC 试验网 Bug 修复报告

**周期**: 2026-05-12 至 2026-05-14 (3 天)
**主网**: 88780 R3.2 Prowl Testnet
**Validators**: 5 (N=5, f=1 BFT)
**起点 main HEAD**: `36281ff` → **终点**: `2ba8f57`

---

## 1. 总览

| 项 | 数值 |
|----|------|
| 合并 PR 数 | **167** |
| 关闭/重复 PR 数 | 13 |
| 新发现 issue 数 | 160+ |
| Rolling deploy 次数 | 5 (含 1 次紧急回滚) |
| Validator 中断 | 0 (含 1 次 BFT 死锁手动恢复) |
| 链 fork / reorg | 0 |
| 平均块时间 | 3.000s (稳定) |

## 2. 按日分布

| 日期 | 合并 | 主要内容 |
|------|------|---------|
| 2026-05-12 | 1 | poison block 链停修复 + atomic 重启恢复 |
| 2026-05-13 | 113 | ralph-loop 大规模 hardening + 4 deploy 周期 |
| 2026-05-14 | 53 | RPC体验完善 + observability 升级 |

## 3. 按模块分类

| 模块 | 数量 | 占比 |
|------|------|------|
| **RPC handlers** | 89 | 53% |
| **IPFS HTTP gateway** | 23 | 14% |
| **IPFS misc** | 22 | 13% |
| **IPFS MFS** | 9 | 5% |
| **WebSocket** | 6 | 4% |
| **Chain engine** | 4 | 2% |
| coc-node runtime | 2 | 1% |
| PoSe service | 2 | 1% |
| Faucet | 2 | 1% |
| 其他 (Metrics/P2P/HTTP/Storage/Synthetic/Docs) | 8 | 5% |

---

## 4. 发现问题的方法

### 4.1 主要驱动: ralph-loop autonomous agent

外部并行运行的自主代理,iteration 280 → 340+ 共~60 轮。每轮执行:
- 随机组合的压力测试 (合约部署 + 执行 + IPFS 上传下载)
- 观察链状态、错误响应
- 发现 bug → 自动开 issue → 写修复 PR
- 单日峰值产出 ~50 PR

**约 130 个 bug 由此发现** (>78%)。

### 4.2 Synthetic check loop (每 30 分钟)

部署在 prod-2 上的 pm2 进程 `coc-health-loop`:
- 13-16 个被动 RPC/WS/website 探测
- 5 个 active probe (tx/deploy/call/estimate/balance)
- 每 4 ticks 跑 stress probe (32→16 tx 批量发送)

**约 10 个 bug 由此发现** (TLS 握手、CORS、Origin 检查、空响应、ws upgrade)。

### 4.3 紧急手工诊断

- **2026-05-12 链停**: 通过 RPC eth_blockNumber 重复查询 + nodeops 日志定位 poison block (gas limit 100 < intrinsic 53306)
- **2026-05-13 force-merge 引入 corruption**: 批量 merge 后链上 deploy 前的本地 TS-strip 校验拦截

### 4.4 Code review (security-focused)

针对 PR 中 OOM/DoS/SSRF/CSWSH/slow-loris 模式逐文件 grep。约 15 个 security 类 bug 通过此方式发现。

---

## 5. 问题类型分类

### A. **Input validation 缺陷** (≈70 PRs)
| 子类 | 例子 |
|------|------|
| 静默 coercion | `Number("5")→5`, `[3]→3`, `{}→NaN`, `true→1` 都被旧代码接受为 limit |
| Silent clamping | `limit=0 → 1`, `offset=-10 → 0` 无 -32602 错误 |
| 类型不严 | `params[0]==undefined` 漏检导致 V8 NPE 泄露 |
| 编码错位 | hex 大小写、address EIP-55 vs lowercase 不一致 |
| Backend-config short-circuit | DID/governance handlers 未配置时直接 -32601,跳过参数校验 |

### B. **DoS/Security 加固** (≈20 PRs)
| 子类 | 例子 |
|------|------|
| OOM | `/pose/*` body 无 1MB 上限,`eth_compileSolidity` 14KB 源就阻塞 5 分钟 event loop |
| Amplification | `eth_getLogs` 内层 topic OR-set 未限,O(blocks×logs×topics) |
| Slowloris | rpc/pose/coc-node 无 body-read timeout |
| CSWSH | WebSocket upgrade 不校验 Origin |
| SSRF | `admin_addPeer` 接受非 http(s) URL scheme |
| Auth bypass | admin_* / ipfs repo/gc / block/rm 无 Bearer 鉴权 |
| BigInt O(n²) | tx 字段 hex 无长度上限 |

### C. **EIP/RFC 规范合规** (≈30 PRs)
| 规范 | 修复 |
|------|------|
| EIP-1559 (type 2 tx) | effectiveGasPrice 应 `min(maxFee, base+priority)`,旧代码返 maxFee |
| EIP-1898 | bare hash + `{blockNumber}` + `{blockHash}` 三形态全支持,互斥校验 |
| EIP-2930 | accessList 必须输出 + 强类型校验 |
| EIP-4844 | blobVersionedHashes 校验 |
| RFC 2046 (multipart) | boundary 必须 CRLF-anchored |
| RFC 7233 (Range) | IPFS gateway 必须支持 |
| Geth parity | -32602 (params) vs -32000 (chain) vs -32603 (internal) |

### D. **错误码映射** (≈25 PRs)
- 大量 -32603 "internal error" 实际是客户端输入错 → 改为 -32602 / -32000
- "fetch failed" / 500 → 改为 400/-32602 + 清晰 message
- V8 内部错误 / ethers TypeError 泄露 → 改为 generic message + ops 日志保留

### E. **Address/Hash 大小写** (≈10 PRs)
- ethers v6 解析返 EIP-55 mixed case
- COC 其他 API (receipts, miner, logs) 已用 lowercase
- dApp 跨 API 字符串比较 `tx.from === receipt.from` 假阴性
- 修: 在 RPC formatter 内强制 toLowerCase()

### F. **Chain stability/consensus** (4 PRs)
- **#335 poison block**: mempool 接受 gasLimit=100 < intrinsic 53306,块卡死
- **#439 stale-nonce**: persistent engine 不拒绝 已用 nonce 的 tx,污染 mempool
- **#445 insufficient-funds**: 提交时不拒绝,直到打包才失败
- **#530 chain checks order**: 所有结构性 check 必须在 nonce check 之前

### G. **HTTP 体验/parity** (≈15 PRs)
- HEAD method 没实现导致 uptime monitor 返回 404
- 405 response 缺 Content-Length + Allow header
- CORS preflight / Origin echo / Vary header
- 客户端调试体验改善 (清晰 error message,无 V8 内部泄露)

---

## 6. 典型问题深度案例

### Case 1: 链停事故 (2026-05-12, #335)
- **症状**: 88780 区块停在 70073,5 validators 全部 BFT round timeout
- **发现**: 手工 RPC 查询发现 head age > 5 min
- **根因**: mempool 接受了一笔 `gasLimit=100, gasPrice=2gwei` 的 tx,intrinsic gas 53306,执行立即 revert 但 block 已签名。后续每轮重提同样 poison block,共识无法前进。
- **修复**: mempool 入口加 `computeIntrinsicGas()` 校验,gasLimit < intrinsic 直接拒绝。
- **恢复**: 5 validators atomic restart (清 mempool)。

### Case 2: WebSocket CSWSH 漏洞 (#375)
- **症状**: Browser 任意 origin (`http://evil.com`) 可订阅 pending tx / log notifications
- **发现**: code review 时注意到 wss upgrade 无 Origin 校验
- **根因**: 旧代码只校验 token,Same-Origin Policy 在 WS 不自动 enforce
- **修复**: `verifyClient` 校验 Origin 是否在 `COC_WS_ORIGIN` 白名单
- **副作用**: 默认 allowlist 只含 localhost,部署到 prod 后 explorer/faucet WS 全 403
- **追加修**: prod-2 env 加 `COC_WS_ORIGIN=https://clawchain.io,...`

### Case 3: IPFS gateway 多 PR 合并后无法 load (#428→#429)
- **症状**: main 上 ipfs-http.ts syntax 错,整个 node 无法启动
- **发现**: 部署前本地 `node --check` 测出语法错
- **根因**: 4 个 PR (#324 Range, #326 HEAD, #328 CORS, #340 content-type) 都改 `/ipfs/<cid>` handler,Python 冲突 resolver 把多版本 `})` 堆叠,产生重复 handler + orphan
- **修复**: 重写 handler 合并 4 个 PR 的 intent,补完 dangling test blocks
- **教训**: 安装 `import()` 真实 TS-strip 校验 guard (替代 `node --check`)

### Case 4: Effective gas price 计算错误 (#447)
- **症状**: EIP-1559 (type 2) tx receipt 返 maxFeePerGas 而非真实 effective
- **发现**: ralph-loop 压测发现 indexer 33× 多算 gas cost
- **根因**: `formatPersistentReceipt` 用 `parsed.gasPrice`,ethers v6 type 2 tx 该字段 = maxFeePerGas
- **修复**: 公式 `min(maxFeePerGas, baseFee + maxPriorityFeePerGas)`

### Case 5: Synthetic stress probe 误报 (5-13/5-14)
- **症状**: 每 2 小时 stress probe 报 `tps=0.86 < 5` STRESS-FAIL,但链实际健康
- **发现**: Daily review 注意 stress 日志一致 FAIL
- **根因**: 单账户 mempool 串行 nonce + 3s 块时 → 理论 TPS 上限 0.33,5 不可达
- **修复**: N=32→16, tpsMin=5→0.3, RPC=public→localhost (避免 TLS hairpin)

---

## 7. 解决方法模式

| 模式 | 实例数 |
|------|--------|
| 增加 input shape check (类型/范围/regex) | ~70 |
| 抢在调用 ethers/V8 前 sanitize error message | ~25 |
| 切换错误码 (-32603 → -32602/-32000) | ~25 |
| Lowercase normalization | ~10 |
| 文件 hardcoded cap (Body size, array length, hex magnitude) | ~15 |
| Header/CORS/Method 补齐 | ~10 |
| Spec 字段补齐 (accessList, blobVersionedHashes 等) | ~10 |
| 顺序重排 (validation before short-circuit) | ~5 |

---

## 8. 部署节奏

| Deploy | HEAD | 累积 commits | 触发原因 |
|--------|------|--------------|---------|
| 2026-05-12 | `8dc8a6f` (起点) | - | 上次 PR-1P 部署 |
| 2026-05-13 早 | `f2bdf3a` | 17 fixes | 17 PR 集中 + #429 corruption 修复 |
| 2026-05-13 中 | `3ff9596` | +26 | batch26 23 PR + synthetic warmup fix |
| 2026-05-13 晚 (回滚) | `4f2e291` ← `2110bcd` | -39 toxic | 多 PR safe-merge corruption,force-push 回滚 |
| 2026-05-14 中 | `8130eea` | +55 | ralph-loop 重发 + 另一 Claude 25 PR |
| 2026-05-14 晚 | `2ba8f57` | +1 | synthetic 5 改进 (跨 validator/p95/reorg/daily) |

5 rolling deploys 全成功,平均 1 validator 用时 ~30s + 缓冲,**整批 ≤8 min**,**0 outage**。

---

## 9. Observability 升级 (Synthetic monitoring)

部署后新加 5 类检查:

| Check | 触发频率 | 阈值 |
|-------|---------|------|
| `consensus.stateRootAgreement` | 30 min/tick | 5/5 validators stateRoot 必须一致 |
| `chain.blockTimeP95` | 30 min/tick | p95 ≤ 6s (=2× 标定 3s) |
| `chain.reorgWatch` | 30 min/tick | tip-20 hash 必须不变 |
| stress probe (localhost) | 2 hr | TPS ≥ 0.3, 16 tx 全确认 |
| daily-summary cron | 00:05 UTC | 24h 汇总报告 |

实测改进前后:
- 改前: 13 checks, 单公网 RPC 视角,无 fork/reorg 检测
- 改后: **16 checks**, **5 validator 直连 stateRoot 比对**,可捕 BFT 分歧

---

## 10. 关键经验/教训

1. **批量 PR merge 必须有 import()-based syntax guard** —— `node --check` 只解析 JS,不跑 TS strip,无法拦截 TypeScript-specific syntax error。我们经历了一次 39 PR force-merge 后 6 个文件 (含 2 个生产) 失效的事故,回滚 main 才恢复。

2. **Python heredoc 冲突解决器只能处理 sibling test 添加场景** —— mid-statement 切割的冲突会被破坏。后期改为对生产文件不允许自动 resolve,test 文件加 syntax 验证。

3. **单 RPC 视角不够** —— 必须直连每个 validator 校验 stateRoot 一致性,否则 fork 仅靠公网 RPC 不可见。

4. **ralph-loop 自动 agent 在压测中发现的 bug 比 code review 多 5-10x** —— 持续压测 ROI 远高于"人工 review"。

5. **TLS hairpin-NAT 是 prod-2 自我探测的隐藏成本** —— 同机 nginx 反代回 localhost 首次连接 ~5-10s 冷启动。所有同机 synthetic 都应优先 localhost RPC。

6. **Reopen issue 不能让 ralph-loop 回头处理** —— 它只跟新发现的 bug。"已 closed" 但代码不在 main 的 issue 需要人工处理或等下一轮 stress 重发现。

---

## 11. 当前 prod 状态 (2026-05-14 16:55 UTC)

- Main HEAD: `2ba8f57`
- Prod 5 validators 全在 `8130eea` (synthetic 改进 commits 仅在监控,无需重 deploy)
- Chain tip ~80500,块时间 3.000s,无 fork,5/5 stateRoot 一致
- OPEN PRs: 0
- OPEN issues: 38 历史 reopen + 12 重发候选 (ralph-loop 后续会自然处理)
- Synthetic loop: **16/16 PASS HEALTHY**
- Faucet 余额: 99989 COC (24h drain 0.05 COC)

---

*生成于 2026-05-14, /passinger/projects/ClawdBot/COC*
