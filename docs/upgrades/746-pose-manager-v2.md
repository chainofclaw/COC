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

### 2. Execute via the 88780 MultiSigWallet

> **CORRECTION (2026-06-30, post-r4):** earlier drafts of this runbook
> referenced "Gnosis Safe" + Safe Tx Service. **88780 actually uses a
> standard `MultiSigWallet` contract** at `0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E`
> (the proxy's `owner()`), with the submit / confirm / execute pattern —
> NOT a Gnosis Safe. There is no Safe Tx Service for chainId 88780 (the
> public `safe-global` index doesn't host it and no self-hosted instance
> is deployed). The tooling that actually works is the offline executor
> already in `contracts/scripts/multisig-execute-security-upgrades.js`,
> which is what r3 batch (2026-05-26) used to execute multisig txIds 8/9
> and what r4 (this batch) used for txId 10. The `safe-propose-pose-upgrade-746.ts`
> file is kept for ABI/structural reference but is **not the path that runs**.

The 5 owner EOAs live in `~/.coc/keys/88780-multisig/owner-{1..5}.json`;
threshold is 3-of-5. The executor reads them automatically. You need
the deployer EOA (gas funding source) configured via
`DEPLOYER_PRIVATE_KEY`.

First, wrap the `prepareUpgrade` output (which is per-contract) into the
batch shape the executor expects (a single batch can contain multiple
upgrades — for #746 we have just one):

```bash
cat > contracts/tmp/upgrade-746-multisig.json <<'JSON'
{
  "chainId": 88780,
  "multisig": "0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E",
  "upgrades": [
    {
      "name": "PoSeManagerV2",
      "proxy": "0x256eb949C50d5F2af8699191b1Bc043203263549",
      "newImpl": "<address from tmp/upgrade-746-prepared.json:newImpl>",
      "issue": "#746",
      "pr": "PR #766"
    }
  ]
}
JSON
```

Then run the executor — it tops up owner-1/-2/-3 EOAs with gas, submits
the tx from owner-1, confirms with owner-1/-2/-3 (reaching the 3-of-5
threshold), then executes from owner-1 in one fully offline session:

```bash
cd contracts
COC_RPC_URL=https://clawchain.io/api/testnet/rpc \
COC_CHAIN_ID=88780 \
DEPLOYER_PRIVATE_KEY=0x<deployer-funding-key> \
PHASE_B_INPUT=tmp/upgrade-746-multisig.json \
npx hardhat run scripts/multisig-execute-security-upgrades.js --network coc
```

The script encodes `proxy.upgradeToAndCall(newImpl, "")` itself (empty
calldata, no re-initialize) — existing storage is preserved verbatim;
`v2SunsetEpoch` starts at 0 = unlimited from the new packed slot.

Output: writes `tmp/upgrade-security-executed.json` with the submit /
execute tx hashes for the runbook log.

### 3. Coordinate the cut-over window

1. **Pause aggregator submissions** on the per-host `coc-agent`
   instances. Existing receipts queue without loss.
2. **Wait for dispute window** to clear (~2 epochs ≈ 2 h on 88780).
3. **Run the multisig executor** (step 2 above). It will:
   - Submit `proxy.upgradeToAndCall(newImpl, "0x")` from owner-1,
     returning a `txId`.
   - Collect 3 confirmations (owner-1 / -2 / -3).
   - Execute. Gas budget ~80–100 k per upgrade.
4. **Verify the upgrade**:
   ```bash
   curl -fsS -X POST -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["<PROXY>","0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc","latest"]}' \
     https://clawchain.io/api/testnet/rpc | jq -r '.result'
   # Expect: 0x...<address from tmp/upgrade-746-prepared.json:newImpl>

   curl -fsS -X POST -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<PROXY>","data":"0x417db998"},"latest"]}' \
     https://clawchain.io/api/testnet/rpc | jq -r '.result'
   # Expect: 0x...0 (v2SunsetEpoch = 0 = unlimited)
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
2. Multisig executes `setV2SunsetEpoch(<current epoch>)` via the same
   `multisig-execute-security-upgrades.js` pattern (or a thin
   `multisig-execute-pose-call.js` wrapper for non-upgrade calls).
   Future v2 sigs beyond that epoch revert.
3. Schedule PR-6 (eventually) to drop the v2 path from the contract
   logic entirely — same pattern as #748 → #752 sunset → eventual
   v1 removal in PR-E (which #752 effectively replaced via soft cut).

## Rollback

`.openzeppelin/unknown-88780.json` git history pins each impl address.
To roll back, point a new `tmp/upgrade-746-rollback-multisig.json` at
the pre-#746 impl `0x0e8B945060AC6Ebe37DA2BE06406Dd7F49C8d356` (the r3
batch entry in the OZ manifest) and run
`multisig-execute-security-upgrades.js` again. The v3 path will
unconditionally fail on the rolled-back impl, so consumers on
PR #767+ must downgrade in lockstep.

## Coordination items — closed during r4 execution (2026-06-30)

- [x] ~~Confirm Safe Tx Service endpoint for chainId 88780~~ → **no
      Safe Tx Service exists for 88780**; safe-global rejects with 403,
      no self-hosted instance. The actual path is the offline
      `multisig-execute-security-upgrades.js` executor (this runbook §2).
- [x] ~~Identify Safe owner set + threshold for the proposal SLA~~ →
      MultiSigWallet at `0x3c055D83…` is 3-of-5 with owners stored at
      `~/.coc/keys/88780-multisig/owner-{1..5}.json`.
- [ ] Confirm every aggregator host runs PR #767 binaries before the
      multisig executes — else `metadata.resultCodes` won't be sent
      and the contract rejects with `MetadataLengthMismatch`.
- [ ] Decide which fraction of witness hosts gets
      `COC_POSE_WITNESS_LAYER7_VERIFY=1` first (canary subset
      recommended for 24 h before fleet-wide enable).

## r4 execution record (2026-06-30)

| Item | Value |
|---|---|
| Multisig txId | **10** |
| Submit tx | `0x09734192ed9ea5897b164b5c5e368c09738dd888b36c7e64de567dd9ae7a23a1` |
| Execute tx | `0xeb1724940a76e5ee755f04855f44cb5dedeb3a5fde83e9b4ecc0aa77155ffe85` |
| New impl | `0xc9AB3664697ac71AB8d9B00943eB128535fd696b` (23 149 bytes) |
| Confirmers | owner-1 (`0x9Fe2502c…`), owner-2 (`0x47679770…`), owner-3 (`0x25480D6E…`) |
| Post-upgrade `v2SunsetEpoch()` | `0` (unlimited — soft sunset window open) |
| Post-upgrade `v1SunsetEpoch()` | `0` (unchanged — #748 still ungated) |
| Chain | 6-val 88780 continued producing throughout; no stall |

This row should be mirrored into `coc-746-pr-series-closed.md` (the
sister to `coc-667-pr-series-closed.md`) once that file is written for
the post-mortem of this batch.
