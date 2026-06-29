# 88780 testnet — on-chain dynamic validator enablement (2026-06-10)

## Summary

The 88780 BFT validator set is now **driven by the on-chain
`ValidatorRegistry`** (`0x4441299c118373fDC96bE1983d42C79e19CDb4F0`) instead of
each node's static `validators` config array. Every node runs the
`ValidatorRegistryReader`, which mirrors the registry's active set into the BFT
coordinator and hot-updates it (`consensus.onValidatorSetChange()` →
`bft.updateValidators()`) **with zero restart**. An operator who stakes 32 COC
via `ValidatorRegistry.stake(nodeId, pubkeyNode)` is included in the
prepare/commit quorum within one poll cycle (~30–60s), and one who unstakes is
removed on the deactivation event — no config edits, no coordinated restart, no
manual peer-list churn.

This closes **Gate 1** of the
[canary launch checklist](./canary-launch-checklist-88780.md) ("the current
validators must each `stake(nodeId, pubkeyNode)` 32 COC on-chain so the reader
sees a non-empty active set before flipping the registry env"). It promotes the
"external validator onboarding" capability documented in
[`public-endpoints-88780.md`](./public-endpoints-88780.md) and
[`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md)
from **aspirational/planned** to **live in production**.

Before this change, adding or removing a validator meant editing every node's
JSON config and performing an atomic full-network restart — slow, error-prone,
and antithetical to the permissionless promise. From now on, validator set
changes are ordinary on-chain transactions.

## What changed on 88780

### B4 — current validators staked 32 COC on-chain

Each of the five live validators (v1–v5) executed
`ValidatorRegistry.stake(nodeId, pubkeyNode)` with `msg.value = 32 COC` from its
signing-key EOA. The staking tool ran a **dry-run first**, verifying for each
key that the derived `nodeId`'s trailing 20 bytes equal the validator's expected
EVM signer address before any irreversible `--apply`:

```
nodeId = keccak256(uncompressedPubkey[1:65])   // 65-byte 0x04-prefixed pubkey
signerAddr = "0x" + nodeId[-40:]               // trailing 20 bytes == BFT signer id
```

Validator signing keys were read over SSH into memory only (`COC_VAL_KEYS` env,
comma-separated) and **never persisted to disk**. Pre-funding (32.1 COC per
signing EOA, extra for gas) was done from the deployer EOA before staking.

Post-stake on-chain state (verified):

| Field | Value |
|---|---|
| `activeValidatorCount()` | **5** |
| `getActiveValidators()` | 5 ids: `0xde4e7889…`(v1) `0xb939e5a6…`(v2) `0xdefc8430…`(v3) `0xcc640966…`(v4) `0x5e773c93…`(v5) |
| `MIN_STAKE()` | 32 COC |
| `MAX_VALIDATORS()` | 21 |
| stake lockup | 14-day `UNSTAKE_LOCKUP` before `withdrawStake()` |

Each `nodeId[-20:]` was confirmed equal to the corresponding validator's signer
address in the node config — so the registry's active set is byte-identical to
the BFT signer ids the nodes already use.

⚠ The 160 COC (5 × 32) is now locked on-chain with a 14-day unstake lockup. This
is a deliberate, irreversible commitment that anchors the validator set to real
stake.

### B5 — ValidatorRegistryReader enabled on every node

Each node's config gained `validatorRegistryAddress`
(`0x4441299c118373fDC96bE1983d42C79e19CDb4F0`) plus reader tuning
(`pollIntervalMs = 30000`, `fromBlock` at the registry deploy height). All
nodes were brought up with an **atomic restart** (simultaneous `&` + `wait`,
not rolling — per the `bft.ts` round-state fsync lesson, rolling restarts risk
equivocation).

After restart, every node logged:

```
[INFO][validator-registry-reader] reader initialized
  address: 0x4441299c118373fDC96bE1983d42C79e19CDb4F0
  activeCount: 5
[INFO][node] BFT validator set updated from ValidatorRegistry
  count: 5
```

Block production continued at ~18 BPM with no disruption. The static
`validators` array remains in config as a **safety net**: if the registry ever
returns an empty active set, the reader falls back to the static set
(`if (active.length === 0)` → keep fallback), so an empty/misconfigured registry
can never stall the chain.

**Devnet pre-validation (B3):** before touching production, the
stake → reader → BFT path was verified end-to-end on a local devnet —
a fresh validator staked 32 COC, the reader picked it up within one 5s poll
cycle, and the node's PID was unchanged across the hot update (proving
zero-restart). 79 reader/governance tests green.

Rollback anchor: each node's pre-change config saved as
`node-*.json.bak.preB5-<ts>`. To revert, restore the backup (which lacks
`validatorRegistryAddress`) and atomic-restart — the nodes fall back to the
static `validators` array.

## Topology context (concurrent ops changes)

These were done alongside the dynamic-validator work and define the current
running state the docs now reflect:

- **Scaled down to 5 active validators.** `obs-1` (the gcloud node) was
  gracefully scaled out to save cost — its VM is **TERMINATED but recoverable**
  (static IP `34.139.57.20` retained, on-chain validator + PoSe registration
  left intact at 0.1 ETH). Current live set: **v1–v5 (all VPS)**. Quorum =
  ⌈2/3 × 5⌉ = **4**, fault tolerance 1.
  - Post-enablement, recovering obs-1 is itself zero-restart: start the VM,
    stake 32 COC from its signing key, start the service → the reader on v1–v5
    hot-adds it. No v1–v5 restart required. (Contrast with the previous
    `obs1-rejoin.sh` full-network atomic-restart SOP, now only needed if the
    reader is ever disabled.)
- **gcloud cost cleanup (~$80/mo saved).** Deleted the long-dead `obs-2` and
  `validator-2` VMs and released 11 idle reserved static IPs. Only `obs-1`
  (`coc-r3-2-observer-1`, TERMINATED) + its static IP are kept for recovery.
- **PoSe v2 pipeline running.** v1–v5 run `coc-pose-witness` + `coc-agent` on
  port 18780, with `witnessNodes` / `nodeEndpoints` ordered by PoSe nodeId.
  This is the off-chain settlement pipeline previously documented as deployed
  but dormant — it is now actively producing challenges and witness receipts.

## Operational impact

| Before | After |
|---|---|
| Validator set hardcoded in each node's `validators` config | Driven by on-chain `ValidatorRegistry.getActiveValidators()` |
| Add/remove validator = edit all configs + atomic full-network restart | Add = `stake()` tx; remove = `requestUnstake()` tx; reader hot-updates |
| New validator needs manual peer-list coordination | Reader picks up stake within ~30–60s; no coordination |
| obs-1 rejoin = `obs1-rejoin.sh` (wipe + 6-val config + atomic restart) | obs-1 rejoin = start VM + `stake()` (zero restart) |

The static-config + atomic-restart SOPs documented in the recovery runbooks
remain valid as a **fallback** (reader disabled) and for true cold-start /
disaster recovery, but are no longer the normal path for routine validator
changes.

## References

- ValidatorRegistry proxy: `0x4441299c118373fDC96bE1983d42C79e19CDb4F0`
  (from `configs/deployed-contracts-88780.json`)
- Reader implementation: `runtime/lib/validator-registry-reader.ts` (+ 11-case
  unit tests)
- Wiring + empty-set fallback: `node/src/index.ts` (`if (active.length === 0)`)
- BFT hot-update path: `node/src/consensus.ts` (`onValidatorSetChange`) →
  `node/src/bft.ts` (`updateValidators`)
- Enablement SOP (now executed): [`validator-registry-reader-enablement-88780.md`](./validator-registry-reader-enablement-88780.md)
- Network params: [`public-endpoints-88780.md`](./public-endpoints-88780.md)
- External onboarding: [`external-validator-onboarding.md`](./external-validator-onboarding.md)
- Go-live status: [`canary-launch-checklist-88780.md`](./canary-launch-checklist-88780.md) (Gate 1 ☑)
