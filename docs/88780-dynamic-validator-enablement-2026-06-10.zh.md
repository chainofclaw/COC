# 88780 试验网 — 链上动态 validator 上线(2026-06-10)

## 概述

88780 的 BFT validator 集合现在由**链上 `ValidatorRegistry`**
(`0x4441299c118373fDC96bE1983d42C79e19CDb4F0`)驱动,不再依赖各节点静态的
`validators` 配置数组。每个节点运行 `ValidatorRegistryReader`,把 registry 的
active set 镜像进 BFT coordinator 并**零重启热更新**
(`consensus.onValidatorSetChange()` → `bft.updateValidators()`)。运营方通过
`ValidatorRegistry.stake(nodeId, pubkeyNode)` 质押 32 COC 后,在一个轮询周期内
(~30–60s)即进入 prepare/commit quorum;解质押后在 deactivation 事件上被移除
—— 无需改配置、无需协调重启、无需手工维护 peer 列表。

这关闭了[金丝雀上线清单](./canary-launch-checklist-88780.zh.md)的 **Gate 1**
("当前 validators 须各自链上 `stake(nodeId, pubkeyNode)` 32 COC,使 reader 在
翻转 registry env 前看到非空 active set")。它把
[`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md) 与
[`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md)
中描述的"外部 validator 加入"能力,从**规划态**提升为**生产已上线**。

此前增删 validator 需编辑每个节点的 JSON 配置并做全网原子重启 —— 慢、易错、
也违背 permissionless 承诺。从此 validator 集合变更就是一笔普通的链上交易。

## 88780 上的变更

### B4 — 当前 validators 链上质押 32 COC

五个 live validator(v1–v5)各自用其签名密钥 EOA 执行
`ValidatorRegistry.stake(nodeId, pubkeyNode)`,`msg.value = 32 COC`。质押工具
**先 dry-run**,对每把密钥校验派生出的 `nodeId` 末 20 字节等于该 validator 期望
的 EVM 签名地址,才允许不可逆的 `--apply`:

```
nodeId = keccak256(uncompressedPubkey[1:65])   // 65 字节 0x04 前缀公钥
signerAddr = "0x" + nodeId[-40:]               // 末 20 字节 == BFT 签名 id
```

Validator 签名密钥经 SSH **只读入内存**(`COC_VAL_KEYS` 环境变量,逗号分隔),
**绝不落盘**。质押前由 deployer EOA 给每个签名 EOA 预充 32.1 COC(多出部分付
gas)。

质押后链上状态(已核实):

| 字段 | 值 |
|---|---|
| `activeValidatorCount()` | **5** |
| `getActiveValidators()` | 5 个 id:`0xde4e7889…`(v1) `0xb939e5a6…`(v2) `0xdefc8430…`(v3) `0xcc640966…`(v4) `0x5e773c93…`(v5) |
| `MIN_STAKE()` | 32 COC |
| `MAX_VALIDATORS()` | 21 |
| 质押锁定 | `withdrawStake()` 前有 14 天 `UNSTAKE_LOCKUP` |

每个 `nodeId[-20:]` 已确认等于节点配置中对应 validator 的签名地址 —— 即 registry
的 active set 与节点已在使用的 BFT 签名 id 逐字节一致。

⚠ 160 COC(5 × 32)现已链上锁定,带 14 天解质押锁定期。这是一次刻意的、不可逆的
承诺,把 validator 集合锚定到真实质押。

### B5 — 全节点启用 ValidatorRegistryReader

每个节点配置新增 `validatorRegistryAddress`
(`0x4441299c118373fDC96bE1983d42C79e19CDb4F0`)及 reader 调参
(`pollIntervalMs = 30000`,`fromBlock` 取 registry 部署高度)。全节点以**原子
重启**拉起(同时 `&` + `wait`,非滚动 —— 依 `bft.ts` round-state 未 fsync 的教训,
滚动重启会引发 equivocation)。

重启后每个节点日志:

```
[INFO][validator-registry-reader] reader initialized
  address: 0x4441299c118373fDC96bE1983d42C79e19CDb4F0
  activeCount: 5
[INFO][node] BFT validator set updated from ValidatorRegistry
  count: 5
```

出块持续 ~18 BPM,无中断。静态 `validators` 数组保留在配置中作为**安全网**:若
registry 返回空 active set,reader 回退到静态集合(`if (active.length === 0)` →
保持 fallback),空/错配的 registry 永远无法使链停摆。

**Devnet 预验证(B3):** 动生产前,在本地 devnet 端到端验证了
stake → reader → BFT 路径 —— 新 validator 质押 32 COC,reader 在一个 5s 轮询周期
内感知,热更新前后节点 PID 未变(证明零重启)。79 个 reader/治理测试全绿。

回滚锚点:各节点变更前配置存为 `node-*.json.bak.preB5-<ts>`。回滚 = 恢复该备份
(其中无 `validatorRegistryAddress`)并原子重启 —— 节点回退到静态 `validators`
数组。

## 拓扑背景(并行的运维变更)

以下与动态 validator 工作一同完成,定义了文档现在反映的运行状态:

- **缩容到 5 个 active validator。** `obs-1`(gcloud 节点)优雅缩出省成本 ——
  其 VM **已 TERMINATED 但可恢复**(保留静态 IP `34.139.57.20`,链上 validator +
  PoSe 注册的 0.1 ETH 不动)。当前 live 集合:**v1–v5(全 VPS)**。quorum =
  ⌈2/3 × 5⌉ = **4**,容错 1。
  - 上线后,恢复 obs-1 本身也是零重启:启 VM → 用其签名密钥 stake 32 COC → 起
    服务 → v1–v5 的 reader 热加入。无需重启 v1–v5。(对比此前的
    `obs1-rejoin.sh` 全网原子重启 SOP,现在仅在 reader 被禁用时才需要。)
- **gcloud 成本清理(月省 ~$80)。** 删除久废的 `obs-2` 与 `validator-2` VM,
  释放 11 个闲置预留静态 IP。仅保留 `obs-1`(`coc-r3-2-observer-1`,TERMINATED)
  及其静态 IP 用于恢复。
- **PoSe v2 流水线运行中。** v1–v5 在 18780 端口跑 `coc-pose-witness` +
  `coc-agent`,`witnessNodes` / `nodeEndpoints` 按 PoSe nodeId 排序。这是此前
  文档标为"已部署但休眠"的链下结算流水线 —— 现在正在产出挑战与见证回执。

## 运维影响

| 之前 | 现在 |
|---|---|
| Validator 集合硬编码在各节点 `validators` 配置 | 由链上 `ValidatorRegistry.getActiveValidators()` 驱动 |
| 增删 validator = 改全部配置 + 全网原子重启 | 加 = `stake()` 交易;减 = `requestUnstake()` 交易;reader 热更新 |
| 新 validator 需手工协调 peer 列表 | reader 在 ~30–60s 内感知质押;无需协调 |
| obs-1 加回 = `obs1-rejoin.sh`(wipe + 6-val 配置 + 原子重启) | obs-1 加回 = 启 VM + `stake()`(零重启) |

恢复运维手册里记录的静态配置 + 原子重启 SOP 仍然有效,作为**回退**(reader 禁用
时)以及真正的冷启动 / 灾难恢复路径,但不再是日常 validator 变更的常规路径。

## 参考

- ValidatorRegistry proxy:`0x4441299c118373fDC96bE1983d42C79e19CDb4F0`
  (出自 `configs/deployed-contracts-88780.json`)
- Reader 实现:`runtime/lib/validator-registry-reader.ts`(+ 11 个单元测试)
- 接线 + 空集回退:`node/src/index.ts`(`if (active.length === 0)`)
- BFT 热更新路径:`node/src/consensus.ts`(`onValidatorSetChange`)→
  `node/src/bft.ts`(`updateValidators`)
- 启用 SOP(现已执行):[`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md)
- 网络参数:[`public-endpoints-88780.zh.md`](./public-endpoints-88780.zh.md)
- 外部加入:[`external-validator-onboarding.md`](./external-validator-onboarding.md)
- 上线状态:[`canary-launch-checklist-88780.zh.md`](./canary-launch-checklist-88780.zh.md)(Gate 1 ☑)
