# 88780 Canary Testnet — Public Endpoints & Network Parameters

> **Canonical reference.** Every other doc that mentions a 88780 endpoint,
> contract address, or network parameter should link here rather than
> duplicate the value. Contract addresses are mirrored from
> [`configs/deployed-contracts-88780.json`](../configs/deployed-contracts-88780.json) — if
> those diverge, the manifest is authoritative.

[中文版](./public-endpoints-88780.zh.md)

## Network identity

| Parameter | Value |
|-----------|-------|
| **Name** | ChainOfClaw Canary Testnet |
| **chainId (decimal)** | 88780 |
| **chainId (hex)** | `0x15acc` |
| **Status** | Canary — open to external operators, prod-candidate stability soak |
| **Genesis date** | 2026-05-20 (gen-5 UUPS deployment) |
| **EVM compatibility** | Paris hardfork (`solc 0.8.24`) |
| **Block time** | ~2.1 s (BFT early-commits optimization) |
| **Block gas limit** | ~30,000,000 |
| **Validator count** | On-chain dynamic via `ValidatorRegistry.getActiveValidators()` — **5 active** as of 2026-06-10 (currently single-operator; external operators welcome — see below). Max 21 (`MAX_VALIDATORS`) |
| **Quorum** | ⌈2/3 × N⌉ (currently 4 of 5) |
| **Native token symbol** | COC |
| **Native token decimals** | 18 |

## Public RPC + WebSocket + Faucet + Explorer

> These endpoints front the validator cluster. They have rate limits + DDoS
> protection. Direct validator RPC ports are not for public use.

| Endpoint | URL |
|----------|-----|
| **JSON-RPC** | `https://rpc.chainofclaw.io` |
| **WebSocket** | `wss://rpc.chainofclaw.io/ws` |
| **Faucet** | `https://faucet.chainofclaw.io` (10 COC per address per 24h) |
| **Block Explorer** | `https://explorer.chainofclaw.io` |
| **Status page** | `https://chainofclaw.io/network` |

### Rate limits (per-IP, per-sender)

These limits protect validator stability under spam. They are enforced
independently at three layers; the canary plan ([`coc-88780-2026-05-26-chaos-engineering-T1-T8.md`](../coc-88780-2026-05-26-chaos-engineering-T1-T8.md))
verified all three under burst load.

| Layer | Limit | Reject code |
|-------|-------|-------------|
| RPC per-IP rate | 240 req/min/IP | HTTP 429 / JSON-RPC `RPC rate limit exceeded` |
| Mempool per-sender quota | 64 pending tx/sender | JSON-RPC `exceeds max pending tx limit (64)` |
| Block gas limit | ~30M gas/block | tx remains pending until included |

Heavy users should batch RPC calls (`eth_call` accepts arrays in some
clients), or run a local archive node and gossip-receive blocks rather
than polling.

## Contract addresses (gen-5 UUPS proxies)

> All proxies are owned by the 3-of-5 multisig
> `0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E`. The multisig is the sole
> upgrade authority. Implementation addresses are tracked in
> [`contracts/.openzeppelin/unknown-88780.json`](../contracts/.openzeppelin/unknown-88780.json) and may change
> via authorized `upgradeToAndCall` calls signed by the multisig.

| Contract | Proxy address | Purpose |
|----------|---------------|---------|
| **MultiSigWallet** | `0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E` | Upgrade authority (immutable, not a proxy) |
| **COCToken** (TBD) | — | Native gas token; current allocation lives in genesis allocation, not a separate token contract |
| **PoSeManagerV2** | `0x256eb949C50d5F2af8699191b1Bc043203263549` | PoSe v2 settlement: challenges, receipts, witness quorum, slashing |
| **PoSeManager** (v1) | `0x91e1D4aBcb68476368E8Ec02d61456a08Ae43BD8` | Legacy PoSe v1, sunset window controlled by `v1SunsetEpoch` |
| **ValidatorRegistry** | `0x4441299c118373fDC96bE1983d42C79e19CDb4F0` | Stake-based BFT validator registry (permissionless `stake()`, 32 ETH min, 21 max active) |
| **EquivocationDetector** | `0xa5dcE830e917176c1091fd6112F41E47692C510e` | On-chain proof-based slashing; permissionless `submitEvidence` |
| **InsuranceFund** | `0x0546E0D98A18e110D3dFCFA150Bcd1C0a589d688` | 20% of slash proceeds; governance-controlled disbursement |
| **GovernanceDAO** | `0x4b9485670eA389Aeab7aC04d48bb2b42D0e8bdc7` | Bicameral DAO over `FactionRegistry`; requires verified faction membership |
| **FactionRegistry** | `0xc37d28297dB885d2B8d9966Cbb5df2e142671287` | Human/Claw faction identity; `verify()` gated for Sybil resistance |
| **Treasury** | `0x512B012683c88103b1BEE3ad470108B47fBD7C7E` | 3-of-5 signer wallet; 5% per-tx cap below `governanceApprove` |
| **SoulRegistry** | `0x3B6b5Fd45F8a6A2756e6D436d90b67faD0509244` | Soul identity + backup CID anchoring + social recovery |
| **DIDRegistry** | `0xe2D8165Cb9416bf92E4304446A5Dccd20Db45fbF` | `did:coc` agent identity, delegation, verifiable credentials |
| **CidRegistry** | `0x780603254D19A60ae35a1aEEBbB4dCd0c514371b` | Permissionless `keccak256(CID) → CID` lookup |
| **DelayedInbox** | `0xac820809399D6740eB274D99827a5ee595881A00` | L1→L2 message inbox with configurable inclusion delay |
| **RollupStateManager** | `0xA2Bf9FA3382A0A8aFf406BE8A8e9a64E1d69dC4e` | L2 state-root submission; proposer allowlist gated |

## Connect a wallet

### MetaMask / EVM wallets

Custom-network entry:

```
Network name:       ChainOfClaw Canary
RPC URL:            https://rpc.chainofclaw.io
chainId:            88780  (0x15acc)
Currency symbol:    COC
Block explorer URL: https://explorer.chainofclaw.io
```

### ethers.js / viem

```ts
import { JsonRpcProvider } from "ethers"
const provider = new JsonRpcProvider("https://rpc.chainofclaw.io")
// chainId is auto-detected on first call.

// WebSocket subscriptions:
import { WebSocketProvider } from "ethers"
const ws = new WebSocketProvider("wss://rpc.chainofclaw.io/ws")
ws.on("block", (n) => console.log("new block:", n))
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

### Getting test COC

The faucet drips **10 COC per address per 24h** (sufficient for typical
dev exploration; not sufficient to stake as a validator — see
[external-validator-onboarding.md](./external-validator-onboarding.md)
for the 32-COC stake bootstrap path).

```bash
curl -X POST https://faucet.chainofclaw.io/faucet/request \
  -H 'content-type: application/json' \
  -d '{"address":"0xYourAddressHere"}'
```

## Becoming a validator

The canary network welcomes external operators. Brief overview:

1. Stand up a node (see [operations-manual.en.md](./operations-manual.en.md))
2. Stake 32 COC via `ValidatorRegistry.stake(nodeId, pubkeyNode)` from
   your validator's signing-key EOA
3. Your node is BFT-included within one poll cycle (~60s) of the on-chain
   stake event — **no manual coordination required** with existing
   operators (see [`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md)
   for the underlying mechanism)
4. To exit: `requestUnstake()` → wait `UNSTAKE_LOCKUP` (14 days) → `withdrawStake()`

Maximum active validator count is **21** (`MAX_VALIDATORS`). Slot
saturation reverts the `stake()` call.

Full step-by-step guide:
[`external-validator-onboarding.md`](./external-validator-onboarding.md).

## Operational SOPs

| Concern | Doc |
|---------|-----|
| Become a validator | [`external-validator-onboarding.md`](./external-validator-onboarding.md) |
| Node-side validator-registry reader (operator details) | [`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md) |
| Recover from chain halt / multisig key loss / mass node loss | [`disaster-recovery-88780.md`](./disaster-recovery-88780.md) |
| Pre-launch checklist (operator perspective) | [`canary-launch-checklist-88780.md`](./canary-launch-checklist-88780.md) |
| Report a vulnerability | [`SECURITY.md`](../SECURITY.md) |
| Whitepaper | [`COC_whitepaper.en.md`](./COC_whitepaper.en.md) ([中文](./COC_whitepaper.zh.md)) |
| Architecture deep-dive | [`architecture-whitepaper.en.md`](./architecture-whitepaper.en.md) ([中文](./architecture-whitepaper.zh.md)) |

## Decommissioned: Prowl testnet (chainId 18780)

The Prowl testnet (`chainId 18780`) was retired on 2026-05-12 in favor of
88780. Documents describing Prowl are preserved under
[`docs/archive/prowl-18780/`](./archive/prowl-18780/) for historical
reference but should not be used for current development.

## Reporting issues with these endpoints

- **RPC / WSS / Faucet / Explorer down or degraded**: see network status
  at <https://chainofclaw.io/network>. If status is green and your
  client is still failing, file a public issue at
  <https://github.com/chainofclaw/COC/issues/new>
- **Suspected security issue with an endpoint**: see [SECURITY.md](../SECURITY.md)
- **Rate-limited unexpectedly**: confirm your client respects 240 req/min/IP
  and consider running a local archive node for high-throughput access
