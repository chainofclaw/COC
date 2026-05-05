# COC Economics v1 (testnet) — Phase I Parameters

> **Audience**: validator operators, governance reviewers.
> **Scope**: testnet (Prowl) economy parameters for the public-testnet
> launch milestone. Mainnet values will be re-frozen in a separate document
> after the public testnet exits.
> **Status**: Phase I code is merged & env-gated default-off (commits
> `8c53885` / `ce1b341` / `90146fc` / `d4bf449` / `368fa62` / `7b5a326`).
> This document freezes the values; rollout sequencing lives in
> `operators/economics-rollout.zh-en.md`.
> **Last reviewed**: 2026-05-05.

## 1. Block Reward Schedule (Sprint I1)

Geometric-halving curve. Each block credits the proposer with
`getBlockReward(height, INITIAL, INTERVAL)` wei after tx execution and
before state commit. Reference: `node/src/base-fee.ts:114-128`.

| Parameter | Value | Notes |
|---|---|---|
| `INITIAL` (`COC_BLOCK_REWARD_WEI`) | `2_000_000_000_000_000_000` (2 COC) | testnet only |
| `INTERVAL` (`COC_BLOCK_REWARD_HALVING_INTERVAL_BLOCKS`) | `42_048_000` (~4 years @ 3 s/block) | matches mainnet curve |
| Genesis (`height=0`) reward | `0` | always |
| Reward floor | `0` after 64 halvings | dust prevention |

**Why geometric halving**: testnet operators are the same group as future
mainnet validators; running the same curve catches off-by-one and
post-halving boundary bugs before mainnet activation. Initial value is
small (2 COC) because testnet tokens have no real value — the curve
shape, not the magnitude, is what's being validated.

**Consensus invariant**: every node MUST run the same curve. Mismatch
across the validator set = stateRoot divergence = chain stall (the
2026-04-30 testnet pattern that Phase H1 hardened against). Operators
MUST flip `COC_BLOCK_REWARD_ENABLED` simultaneously.

## 2. EIP-1559 Fee Distribution (Sprint I2)

When `COC_FEE_DISTRIBUTION_ENABLED=1`, the executionBlock's `coinbase`
is set to the block proposer's resolved address (via
`validatorAddressMap`), so ethereumjs runTx credits priority fee to the
proposer. Base fee continues to be effectively burned (sent to `0x0`).

| Component | Destination | Rate |
|---|---|---|
| `baseFeePerGas × gasUsed` | `0x0000…0000` (burn) | 100% of base fee |
| `(maxPriorityFeePerGas × gasUsed)` | proposer address | 100% of priority fee |
| `maxFeePerGas` cap | refunded to sender | EVM standard |

**No tip-split with treasury** in Phase I. Treasury revenue comes from
slashing (§4) and PoSe v2 epoch settlement (`epochTreasuryDelta`,
already shipping pre-I).

**Coinbase plumbing**: see `node/src/evm.ts` `ExecutionContext.coinbase`
+ `node/src/chain-engine-persistent.ts:436` proposerCoinbase resolution.

## 3. Validator Bond / Stake (existing — referenced for context)

| Parameter | Value | Source |
|---|---|---|
| Genesis validator stakes | per-validator `stake: bigint` in `validatorStakes[]` config | `node/src/config.ts` |
| Default stake (when `validatorStakes` omitted) | `1_000_000_000_000_000_000` (1 COC) | `chain-engine-persistent.ts:117` |
| Quorum threshold | strict 2/3 + 1 wei | `bft.ts` `hasQuorum()` |
| Relaxed quorum (testnet only) | exactly 2/3 | `COC_DEV_RELAXED_QUORUM=1`; **must be 0 in production** |

## 4. Equivocation Slashing (Sprints I3a / I4a)

Equivocation = a validator emits two BFT messages of the same `(type,
height)` for different `blockHash`. Detected by
`node/src/bft.ts` `EquivocationDetector`; evidence flushed to chain via
`runtime/coc-relayer.ts` (Sprint I3c). On-chain enforcement:
`contracts/contracts-src/governance/EquivocationDetector.sol`.

| Parameter | Value | Notes |
|---|---|---|
| Slash rate per equivocation event | 100% of validator's bonded stake | testnet rule; mainnet may scale by severity |
| Slash cooldown | `1000` blocks (`DEFAULT_SLASH_COOLDOWN_BLOCKS`) | prevents griefing-via-replay |
| Evidence accepted from | any caller (permissionless) | Sprint I3a |
| Encoded by | `runtime/lib/bft-slash-bridge.ts` | Sprint I3b |
| Auto-submitted by | `coc-relayer` on next finalize tick | Sprint I3c |

**`slashTotal` estimator** (Sprint I4a, `runtime/lib/pose-slash-estimator.ts`):
the relayer scans recent finality + evidence to compute the cumulative
`slashTotal` parameter for `PoSeManagerV2.finalizeEpoch()`. Prevents the
relayer from submitting an under-counted finalization that would lock
slashed funds in escrow forever.

## 5. Treasury & Insurance Fund Routing (Sprint I5)

When a validator is slashed, the bonded stake is routed by
`ValidatorRegistry.sol` according to:

| Bucket | Share | Destination |
|---|---|---|
| Insurance reserve | configurable (default 100% of slashed stake on testnet) | `InsuranceFund.sol` |
| Treasury overflow | balance of the slashed amount | `Treasury.sol` |

**Why 100% to insurance on testnet**: simulates worst-case payout pool.
Mainnet split (likely 50/50 or 70/30) is finalized in Week 9 governance
review; this document reflects testnet defaults only.

**Withdraw authority**: both contracts gate `withdraw()` on
`onlyGovernance` (multi-sig). No automatic distribution; pull-based.

Reference: `contracts/contracts-src/governance/Treasury.sol`,
`contracts/contracts-src/governance/InsuranceFund.sol`,
`contracts/contracts-src/governance/ValidatorRegistry.sol`.

## 6. Testnet Incentive Rules

The testnet emits **testnet-only tokens with no main-net value**.
Validators participating in the public testnet (Phase 2 / Phase 3 of
the 90-day roadmap) earn:

- Block rewards per §1
- Priority fees per §2
- Optional: PoSe v2 epoch claims (off-chain reward manifest, see
  `docs/reward-mechanism.en.md`)

There is **no airdrop, no token swap, no mainnet allocation** tied to
testnet participation. This is stated explicitly in the operator
onboarding email and reflected in the public testnet announcement
(Week 9 docs).

## 7. Environment Variable Reference

All Phase I features are env-gated default-off. Activation requires the
ENTIRE validator set to flip simultaneously (consensus-affecting).

| Env | Default | Required when | Owner |
|---|---|---|---|
| `COC_BLOCK_REWARD_ENABLED` | `0` | Sprint I1 active | every validator |
| `COC_BLOCK_REWARD_WEI` | unset → `0` | I1 active | every validator (must match) |
| `COC_BLOCK_REWARD_HALVING_INTERVAL_BLOCKS` | `42_048_000` | I1 active | every validator (must match) |
| `COC_FEE_DISTRIBUTION_ENABLED` | `0` | Sprint I2 active | every validator |
| `COC_BFT_AUTO_RECOVERY` | `0` | recommended on testnet | each validator independent |
| `COC_DEV_RELAXED_QUORUM` | `0` | NEVER `1` in production | each validator |

**Validation tooling** (planned for Week 9): `bash scripts/check-economy-flags.sh`
to verify all 3 testnet validators report identical reward/halving values
via `coc_nodeInfo`.

## 8. Open questions (for Week 9 governance freeze)

| Topic | Owner | Deadline |
|---|---|---|
| Mainnet `INITIAL` reward (production token decimals + curve start) | governance | 2026-05-18 |
| Insurance/Treasury split for slashed stake (testnet 100/0 vs mainnet) | governance | 2026-05-18 |
| Whether to enable I1+I2 simultaneously or staged | ops | 2026-05-12 |
| Halving interval recalibration if block time changes | governance | post-mainnet |

---

**Cross-references**

- Implementation: `node/src/base-fee.ts`, `node/src/chain-engine-persistent.ts`,
  `node/src/evm.ts`
- Contracts: `contracts/contracts-src/governance/{Treasury,InsuranceFund,EquivocationDetector,ValidatorRegistry}.sol`
- Roadmap: `docs/90-day-release-roadmap.zh-en.md` Week 9
- Rollout procedure: `docs/operators/economics-rollout.zh-en.md`
- Companion: `docs/economics-v1.zh.md` (Chinese mirror)
