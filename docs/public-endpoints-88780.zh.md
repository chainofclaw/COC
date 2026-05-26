# 88780 Canary 测试网 — 公开端点与网络参数

> **权威参考。** 其他文档凡提及 88780 端点、合约地址或网络参数时,应链接至此而非重复值。
> 合约地址镜像自
> [`configs/deployed-contracts-88780.json`](../configs/deployed-contracts-88780.json)——
> 如有差异以该 manifest 为准。

[English](./public-endpoints-88780.md)

## 网络标识

| 参数 | 值 |
|------|-----|
| **名称** | ChainOfClaw Canary 测试网 |
| **chainId(十进制)** | 88780 |
| **chainId(十六进制)** | `0x15acc` |
| **状态** | Canary — 对外部 operator 开放,prod-candidate 稳定性长跑 |
| **创世日期** | 2026-05-20(gen-5 UUPS 部署) |
| **EVM 兼容** | Paris hardfork (`solc 0.8.24`) |
| **出块时间** | ~2.1 秒(BFT early-commits 优化) |
| **区块 gas 上限** | ~30,000,000 |
| **Validator 数** | 6(当前单运营方;欢迎外部 operator,见下) |
| **Quorum** | ⌈2/3 × N⌉ = 6 中 4 |
| **原生代币符号** | COC |
| **原生代币 decimals** | 18 |

## 公开 RPC + WebSocket + Faucet + Explorer

> 这些端点前置于 validator 集群,带速率限制 + DDoS 防护。validator 直连 RPC 端口不对公开使用。

| 端点 | URL |
|------|-----|
| **JSON-RPC** | `https://rpc.chainofclaw.io` |
| **WebSocket** | `wss://rpc.chainofclaw.io/ws` |
| **Faucet** | `https://faucet.chainofclaw.io`(每地址 24 小时 10 COC) |
| **区块浏览器** | `https://explorer.chainofclaw.io` |
| **状态页** | `https://chainofclaw.io/network` |

### 速率限制(per-IP、per-sender)

下列限制保护 validator 在 spam 下的稳定性,三层独立强制执行。canary 计划的
[chaos 测试](../coc-88780-2026-05-26-chaos-engineering-T1-T8.md)在 burst 负载下验证了三层。

| 层 | 上限 | 拒绝代码 |
|----|------|---------|
| RPC per-IP | 240 req/min/IP | HTTP 429 / JSON-RPC `RPC rate limit exceeded` |
| Mempool per-sender 配额 | 64 pending tx/sender | JSON-RPC `exceeds max pending tx limit (64)` |
| 区块 gas 上限 | ~30M gas/block | tx 保持 pending 至打包 |

重度用户应批量 RPC 调用(部分客户端的 `eth_call` 接受数组),或运行本地 archive 节点 + 通过 gossip 接块代替轮询。

## 合约地址(gen-5 UUPS proxies)

> 所有 proxy 由 3-of-5 multisig `0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E` 拥有。
> multisig 是**唯一**升级权威。Implementation 地址追踪于
> [`contracts/.openzeppelin/unknown-88780.json`](../contracts/.openzeppelin/unknown-88780.json)
> ,可经 multisig 签名的 `upgradeToAndCall` 调用变更。

| 合约 | Proxy 地址 | 用途 |
|------|------------|------|
| **MultiSigWallet** | `0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E` | 升级权威(immutable,非 proxy) |
| **PoSeManagerV2** | `0x256eb949C50d5F2af8699191b1Bc043203263549` | PoSe v2 结算:challenge、receipt、witness quorum、slash |
| **PoSeManager**(v1) | `0x91e1D4aBcb68476368E8Ec02d61456a08Ae43BD8` | Legacy PoSe v1,sunset 窗口由 `v1SunsetEpoch` 控制 |
| **ValidatorRegistry** | `0x4441299c118373fDC96bE1983d42C79e19CDb4F0` | 基于 stake 的 BFT validator 注册(permissionless `stake()`,32 COC min,21 active 上限) |
| **EquivocationDetector** | `0xa5dcE830e917176c1091fd6112F41E47692C510e` | 链上证明驱动 slash;permissionless `submitEvidence` |
| **InsuranceFund** | `0x0546E0D98A18e110D3dFCFA150Bcd1C0a589d688` | slash 收入 20%;治理控制支出 |
| **GovernanceDAO** | `0x4b9485670eA389Aeab7aC04d48bb2b42D0e8bdc7` | `FactionRegistry` 之上的双院 DAO;需 verified faction 资格 |
| **FactionRegistry** | `0xc37d28297dB885d2B8d9966Cbb5df2e142671287` | Human/Claw 阵营身份;`verify()` 门禁防 Sybil |
| **Treasury** | `0x512B012683c88103b1BEE3ad470108B47fBD7C7E` | 3-of-5 signer 钱包;5% 单笔上限,`governanceApprove` 提升 |
| **SoulRegistry** | `0x3B6b5Fd45F8a6A2756e6D436d90b67faD0509244` | Soul 身份 + backup CID 锚定 + 社交恢复 |
| **DIDRegistry** | `0xe2D8165Cb9416bf92E4304446A5Dccd20Db45fbF` | `did:coc` agent 身份、delegation、可验证凭证 |
| **CidRegistry** | `0x780603254D19A60ae35a1aEEBbB4dCd0c514371b` | permissionless `keccak256(CID) → CID` 查询 |
| **DelayedInbox** | `0xac820809399D6740eB274D99827a5ee595881A00` | L1→L2 消息 inbox 带可配置 inclusion delay |
| **RollupStateManager** | `0xA2Bf9FA3382A0A8aFf406BE8A8e9a64E1d69dC4e` | L2 state-root 提交;proposer allowlist 门禁 |

## 连接钱包

### MetaMask / EVM 钱包

自定义网络条目:

```
网络名称:           ChainOfClaw Canary
RPC URL:           https://rpc.chainofclaw.io
chainId:           88780  (0x15acc)
代币符号:           COC
区块浏览器 URL:     https://explorer.chainofclaw.io
```

### ethers.js / viem

```ts
import { JsonRpcProvider } from "ethers"
const provider = new JsonRpcProvider("https://rpc.chainofclaw.io")
// chainId 首次调用时自动检测。

// WebSocket 订阅:
import { WebSocketProvider } from "ethers"
const ws = new WebSocketProvider("wss://rpc.chainofclaw.io/ws")
ws.on("block", (n) => console.log("新块:", n))
```

```ts
// viem
import { createPublicClient, http } from "viem"
import { defineChain } from "viem"

export const coc88780 = defineChain({
  id: 88780,
  name: "ChainOfClaw Canary",
  nativeCurrency: { name: "COC", symbol: "COC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.chainofclaw.io"] } },
  blockExplorers: { default: { name: "COC Explorer", url: "https://explorer.chainofclaw.io" } },
})

const client = createPublicClient({ chain: coc88780, transport: http() })
```

### 获取测试 COC

Faucet 每地址 24 小时滴 **10 COC**(够典型开发探索;不足以质押作 validator——见
[external-validator-onboarding.md](./external-validator-onboarding.md) 的 32-COC stake bootstrap 路径)。

```bash
curl -X POST https://faucet.chainofclaw.io/faucet/request \
  -H 'content-type: application/json' \
  -d '{"address":"0xYourAddressHere"}'
```

## 成为 Validator

Canary 网络欢迎外部 operator。简要概览:

1. 搭建节点(见 [operations-manual.zh.md](./operations-manual.zh.md))
2. 从你的 validator 签名密钥 EOA 经 `ValidatorRegistry.stake(nodeId, pubkeyNode)` 质押 32 COC
3. 链上 stake 事件后一个 poll 周期(~60s)内你的节点被 BFT 纳入——**与现有 operator 无需手动协调**
   (底层机制见 [`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md))
4. 退出:`requestUnstake()` → 等 `UNSTAKE_LOCKUP`(14 天)→ `withdrawStake()`

最大活跃 validator 数 **21**(`MAX_VALIDATORS`)。槽位饱和会 revert `stake()` 调用。

完整步骤指南:[`external-validator-onboarding.md`](./external-validator-onboarding.md)。

## 运营 SOP

| 关切 | 文档 |
|------|------|
| 成为 validator | [`external-validator-onboarding.md`](./external-validator-onboarding.md) |
| 节点端 validator-registry reader(运营细节) | [`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md) |
| 链停 / 多签密钥丢失 / 大规模节点丢失恢复 | [`disaster-recovery-88780.md`](./disaster-recovery-88780.md) |
| 上线前 checklist(运营视角) | [`canary-launch-checklist-88780.md`](./canary-launch-checklist-88780.md) |
| 报告漏洞 | [`SECURITY.md`](../SECURITY.md) |
| 白皮书 | [`COC_whitepaper.zh.md`](./COC_whitepaper.zh.md) ([English](./COC_whitepaper.en.md)) |
| 架构深入 | [`architecture-whitepaper.zh.md`](./architecture-whitepaper.zh.md) ([English](./architecture-whitepaper.en.md)) |

## 已退役:Prowl 测试网(chainId 18780)

Prowl 测试网(`chainId 18780`)于 2026-05-12 退役,由 88780 接替。描述 Prowl 的文档保留在
[`docs/archive/prowl-18780/`](./archive/prowl-18780/) 作历史参考,**不应**用于当前开发。

## 报告端点问题

- **RPC / WSS / Faucet / Explorer 不可用或降级**:查看
  <https://chainofclaw.io/network> 的状态。若状态绿但客户端仍失败,在
  <https://github.com/chainofclaw/COC/issues/new> 提公开 issue
- **疑似端点安全问题**:见 [SECURITY.md](../SECURITY.md)
- **意外被限流**:确认客户端遵守 240 req/min/IP,考虑运行本地 archive 节点用于高吞吐访问
