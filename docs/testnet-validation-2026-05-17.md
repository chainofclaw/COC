# COC 88780 试验网验证报告（WS7 — live 验证）

- **日期**：2026-05-17
- **目标链**：chainId 88780（0x15acc），R3.2 试验网，N=5 validator + 2 observer
- **RPC 端点**：`http://159.198.36.3:28780`（节点 A）、`http://159.198.36.25:28780`（节点 B）
- **执行视角**：外部客户端，仅经公开 HTTP JSON-RPC（端口 28780）
- **背景**：本报告是 2026-05-17 测试覆盖深度扩展计划 WS7 的产出，承接 `docs/stress-test-2026-05-17.md`。WS5 把当时的临时探针固化为 `tests/stress/` 下可复用套件，本次将其指向 live 88780 执行。

---

## 1. 链状态

| 项 | 值 |
|---|---|
| chainId | 88780（`0x15acc`），`net_version` 一致 |
| 链头 | ~148,500（验证执行期间）|
| 双节点 | 节点 A / 节点 B 链头一致，均可达 |
| 部署账户 | Hardhat #0（`0xf39Fd6…92266`），余额充足、nonce ~2063 |

---

## 2. 验证结果

执行命令：

```bash
COC_STRESS_RPC=http://159.198.36.3:28780 \
  node --experimental-strip-types --test tests/stress/evm-coverage.test.ts
COC_STRESS_RPC=http://159.198.36.3:28780 \
  node --experimental-strip-types --test tests/stress/rpc-validation.test.ts
```

### 2.1 EVM 执行层 — `evm-coverage.test.ts`：6/6 通过

| 用例 | 结果 |
|---|---|
| runtime-pool 合约部署 + 执行（ret2a/sstore/counter/log0/timestamp） | ✅ 字节码部署正确 |
| CREATE 地址确定性（合约工厂模式，子合约 `keccak(rlp(factory,1))`） | ✅ |
| SELFDESTRUCT 删码 + 转移余额（Shanghai 语义） | ✅ |
| 交易类型矩阵 type-0 / type-1 / type-2，receipt.type 正确 | ✅ |
| 不可执行合约调用以 revert 拒绝 | ✅ |
| chainId 以 hex quantity 一致暴露 | ✅ |

### 2.2 RPC 输入校验层 — `rpc-validation.test.ts`：9/9 通过

| 用例 | 结果 |
|---|---|
| `coc_chainStats` 无参 sanity | ✅ |
| `coc_getContractInfo` 对全部畸形地址（null/object/array/畸形/路径穿越/超长串/数字/布尔/空串）返 -32602 | ✅ |
| `coc_getTransactionsByAddress` 畸形地址返 -32602 | ✅ |
| `coc_getTransactionsByAddress` 畸形 limit/offset 返 -32602 | ✅ |
| `coc_getContractInfo` 合法地址不误拒 | ✅ |
| `eth_getLogs` 有界范围（最近 5000 块）返数组 | ✅ |
| `eth_getLogs` 超限范围返干净 -32602（非 -32603） | ✅ |
| `eth_getLogs` 反转范围干净处理 | ✅ |
| 畸形输入轰炸后节点仍健康（`eth_blockNumber` 正常） | ✅ |

---

## 3. 过程中的修正

`rpc-validation.test.ts` 原 `eth_getLogs` 用例查询全链（`fromBlock: 0x0`）。在 148k 块的真链上，节点正确以
`-32602 "block range too large: max 10000 blocks, got 148535"` 拒绝 —— **这是节点的正确行为**（合理的范围上限），
缺陷在测试假设。已修正：用例改用有界窗口（最近 5000 块），并新增一条用例把"超限范围 → 干净 -32602、绝不 -32603"
固化为正式覆盖。本地短链走兼容分支同样通过。

---

## 4. 未覆盖项（受访问权限限制）

下列需 operator/SSH 节点侧访问或对 live testnet 的写授权，外部客户端无法执行：

| 领域 | 原因 |
|---|---|
| 88780 上治理提案 lifecycle | 对 live testnet 的写操作，有链上副作用，未授权不做 |
| IPFS 上传/下载 | IPFS HTTP API（5001）公网未暴露 |
| PoSe challenge/receipt 端到端 | pose-http 端点公网未暴露 |
| 共识混沌（停 validator / 分区） | 需节点 shell 注入故障 |
| `burst-throughput.test.ts` | 刻意未对 88780 跑 —— 并发 burst 会触发未修复的 #642（stateRoot 分歧死锁 BFT），不冲击 live N=5 testnet |

---

## 5. 结论

- **88780 的公网可达面（EVM 执行 + RPC 输入校验）：本次以固化套件复验，15/15 全通过，行为正确。**
- 相比 2026-05-17 首轮压测的临时探针，本次验证用的是 `tests/stress/` 下可复用、CI 可接入的套件 —— 同一覆盖面已工程化。
- `eth_getLogs` 的 10000 块范围上限经确认为有意设计，且已转为测试覆盖。
- COC 系统的 IPFS / PoSe / 治理写 / 共识混沌仍需节点侧访问才能在 live 链验证，与首轮报告的覆盖缺口判断一致。

复跑：`tests/stress/` 套件无链时优雅 skip，指定 `COC_STRESS_RPC` 即对目标链执行；CI 中由 `.github/workflows/stress.yml` 的 `stress-probes` lane 对临时 devnet 自动执行。
