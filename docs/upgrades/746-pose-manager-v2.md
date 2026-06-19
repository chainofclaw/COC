# PoSeManagerV2 #746 Upgrade Runbook

Upgrade target: live 88780 `PoSeManagerV2` proxy →
implementation containing the protocol fix for issue #746 (V3 typehash
binds `resultCode`, `v2SunsetEpoch` soft sunset, legacy `submitBatchV2`
no-metadata path hard-cut), [PR #766](https://github.com/chainofclaw/COC/pull/766) + [PR #767](https://github.com/chainofclaw/COC/pull/767).

This runbook is the structural sibling of [`667-pose-manager-v2.md`](./667-pose-manager-v2.md);
read that first for general context on UUPS multisig upgrades. This file
captures only the #746-specific details.

## What's structurally different from the #667 r3 upgrade

1. **Witness ABI change is observable** — clients constructing
   `ReceiptBatchMetadata` in TypeScript MUST add the new `resultCodes[]`
   field (aligned with `leafHashes`); the contract reverts
   `MetadataLengthMismatch` otherwise. ABI consumers that only decode
   events / read state are unaffected.
2. **Legacy `submitBatchV2` hard-reverts** post-upgrade with
   `LegacyBatchPathSunset()`. The witness-on-batch-root rubber-stamp
   surface is gone. Anything still calling that path needs migration
   to `submitBatchV2WithMetadata` **before** the multisig executes.
3. **Off-chain rollout knob** `COC_POSE_WITNESS_LAYER7_VERIFY=1` enables
   the witness's independent Layer-7 verifier on each host. Default
   off — the soft sunset on `v2SunsetEpoch` carries the migration
   gracefully without forcing fleet-wide simultaneous restarts.

## Pre-flight

| Check | Command |
|---|---|
| Storage layout compatible | `npx hardhat run scripts/upgrade-pose-manager-v2-746.js --network coc` (step 1 internally — validates without writing) |
| Local dry-run upgrade simulation | `npx hardhat run scripts/test-upgrade-dry-run-746.js` |
| Proxy owner is the expected Safe | `cast call <PROXY> "owner()"`; compare to `POSE_MULTISIG_ADDRESS` |
| New ABI in `@chainofclaw/soul@2.2.0` matches | PR #51 on claw-mem, merged |
| Aggregator/agent fleet running PR #767 (off-chain v3 path) | `coc-agent --version` on each operator host; check that `services/aggregator/batch-aggregator-v2.ts` includes `metadata.resultCodes` |
| No live consumers of `submitBatchV2` (no-metadata) | grep prod ops scripts; any still on that path must migrate first |

## Order of operations

### 1. Prepare new implementation

```bash
cd contracts
COC_RPC_URL=https://prod-1.coc:28780 \
npx hardhat run scripts/upgrade-pose-manager-v2-746.js --network coc
```

Writes `contracts/tmp/upgrade-746-prepared.json` with the new impl
address. Commit `.openzeppelin/unknown-88780.json` so the upgrade
history stays reproducible.

### 2. Propose the Safe tx

```bash
COC_RPC_URL=https://prod-1.coc:28780 \
SAFE_TX_SERVICE_URL=https://<safe-tx-service-for-88780> \
POSE_MULTISIG_ADDRESS=0x<safe-address> \
PROPOSER_PRIVATE_KEY=0x<one-of-the-safe-signers> \
npx ts-node scripts/safe-propose-pose-upgrade-746.ts
```

Encodes `proxy.upgradeToAndCall(newImpl, "")` — empty calldata, no
re-initialize (existing storage is preserved verbatim; `v2SunsetEpoch`
starts at 0 = unlimited from the new `__gap` slot).

### 3. Coordinate the cut-over window

1. **Pause aggregator submissions** on the per-host `coc-agent`
   instances. Existing receipts queue without loss.
2. **Wait for dispute window** to clear (~2 epochs ≈ 2 h on 88780).
3. **Multisig executes** `upgradeToAndCall(newImpl, "")` via Safe UI.
   Gas budget ~80 k.
4. **Verify the upgrade**:
   ```bash
   cast storage <PROXY> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
   # Expect: the address from tmp/upgrade-746-prepared.json:newImpl
   cast call <PROXY> "v2SunsetEpoch()(uint64)"
   # Expect: 0 (unlimited)
   ```
5. **Resume aggregators** + per-host **set `COC_POSE_WITNESS_LAYER7_VERIFY=1`**
   and restart witness daemons. Witnesses begin signing v3 (in addition
   to v1 + v2) immediately.
6. **Smoke test the new path** — submit one v3-signed batch via an
   aggregator and confirm `ReceiptBatchMetadataSubmitted` event emits
   along with v3 sigs that recover correctly on-chain.

### 4. Roll forward and monitor (48 h)

- `BatchSubmittedV2` event volume — should remain steady (witnesses
  produce v1+v2+v3 during rollout; aggregator prefers v3).
- `LegacyBatchPathSunset` reverts in tx receipts — should be zero
  in steady state; non-zero means some aggregator host hasn't migrated.
- `V2SunsetEpochUpdated` event — emitted only when the multisig
  tightens the v2 sunset cap, which happens in PR-5 after the
  observation window.

## PR-5 — sunset tighten (deferred)

After 30 days of clean operation with v3 sigs flowing:

1. Per-host telemetry confirms 100% of witness sigs are v3 (no v2
   fallback path being hit).
2. Multisig signs `setV2SunsetEpoch(<current epoch>)`. Future v2 sigs
   beyond that epoch revert.
3. Schedule PR-6 (eventually) to drop the v2 path from the contract
   logic entirely — same pattern as #748 → #752 sunset → eventual
   v1 removal in PR-E (which #752 effectively replaced via soft cut).

## Rollback

`.openzeppelin/unknown-88780.json` git history pins each impl address.
To roll back, multisig signs
`proxy.upgradeToAndCall(oldImpl, "0x")` pointing back at the pre-#746
impl (same script template, change the target). The v3 path will
unconditionally fail on the rolled-back impl, so consumers on
PR #767+ must downgrade in lockstep.

## Open coordination items (deferred to live upgrade day)

- [ ] Confirm Safe Tx Service endpoint for chainId 88780 (same as #667
      runbook — verify it's still healthy).
- [ ] Identify Safe owner set + threshold for the proposal SLA.
- [ ] Confirm every aggregator host runs PR #767 binaries before the
      multisig executes — else `metadata.resultCodes` won't be sent
      and the contract rejects with `MetadataLengthMismatch`.
- [ ] Decide which fraction of witness hosts gets
      `COC_POSE_WITNESS_LAYER7_VERIFY=1` first (canary subset
      recommended for 24 h before fleet-wide enable).
