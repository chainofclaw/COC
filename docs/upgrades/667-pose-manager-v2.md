# PoSeManagerV2 #667 Upgrade Runbook

Upgrade target: live 88780 `PoSeManagerV2` proxy →
implementation containing the protocol fix for issue #667 (independent
on-chain witness quorum verification, [PR #710](https://github.com/chainofclaw/COC/pull/710)).

## Pre-flight

| Check | Command |
|---|---|
| OZ storage layout compatibility | `npx hardhat run scripts/upgrade-pose-manager-v2-667.js --network coc` (step 1 internally — validates without writing) |
| Local dry-run upgrade simulation | `npx hardhat run scripts/test-upgrade-dry-run-667.js` |
| Proxy owner is the expected Safe | `cast call <PROXY> "owner()"` (or via `eth_call`); compare to `POSE_MULTISIG_ADDRESS` |
| ABI in `@chainofclaw/soul@2.1.0` matches new impl | Already done (claw-mem PR #50, merged) |
| Aggregator/agent fleet running PR #713 (off-chain v2 path) | Check `coc-agent --version` on each operator host |

## Order of operations

### 1. Prepare new implementation

The Safe multisig owns the proxy; this step deploys the new impl bytecode but does NOT wire the proxy to it.

```bash
cd contracts
COC_RPC_URL=https://prod-1.coc:28780 \
npx hardhat run scripts/upgrade-pose-manager-v2-667.js --network coc
```

Outputs `tmp/upgrade-667-prepared.json` with the new impl address. Commit `.openzeppelin/unknown-88780.json` (the OZ plugin's manifest) so the upgrade history stays reproducible.

### 2. Propose the Safe tx

```bash
COC_RPC_URL=https://prod-1.coc:28780 \
SAFE_TX_SERVICE_URL=https://<safe-tx-service-for-88780> \
POSE_MULTISIG_ADDRESS=0x<safe-address> \
PROPOSER_PRIVATE_KEY=0x<one-of-the-safe-signers> \
npx ts-node scripts/safe-propose-pose-upgrade.ts
```

The script:
- Asserts `proxy.owner() == POSE_MULTISIG_ADDRESS` before submitting.
- Encodes `upgradeToAndCall(newImpl, "")` — empty calldata, no re-initialize.
- Pushes the proposal to Safe Tx Service. Returns the `safeTxHash`.

Open the proposal in the Safe UI (Safe Wallet). The other owners review and sign.

### 3. Coordinate the cut-over window

Per the plan (`docs/plans/skills-https-github-com-ngplateform-cla-whimsical-stearns.md`):

1. **Pause aggregator submissions** — configure `coc-agent` to skip `flushBatchV2` rounds (operational flag); existing receipts queue in mempool / agent state.
2. **Wait for dispute window** — current epoch's batches must clear the 2-epoch dispute window (~2 hours on 88780). The new `_validateWitnessQuorumV2` does not touch existing storage; in-flight batches are unaffected, but easier to verify when there's no in-flight churn.
3. **Multisig executes** the proposal via Safe UI. The tx is `proxy.upgradeToAndCall(newImpl, "0x")`; gas budget ~80k.
4. **Verify on-chain**:
   ```bash
   # ERC-1967 implementation slot = keccak256("eip1967.proxy.implementation") - 1
   cast storage <PROXY> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
   ```
   Should now decode to the address in `tmp/upgrade-667-prepared.json:newImpl`.
5. **Resume aggregators** — un-pause `coc-agent`.
6. **Smoke test the new path** — submit one v2-metadata batch from an aggregator and confirm `ReceiptBatchMetadataSubmitted` event emits.

### 4. Roll forward and monitor

For the next 48 hours, watch:
- `BatchSubmittedV2` event volume — should remain steady (witnesses keep producing v1+v2 signatures during the rollout window, so neither path is "starved").
- `WitnessSigReplay` reverts in tx receipts — should be zero in steady state; non-zero indicates an aggregator misconfiguration trying to reuse signatures across batches.
- `_witnessSigUsed` storage growth — bounded by `(active validator count) × (batches per epoch) × (epochs)`. At current 88780 scale (~5 active validators, ~10 batches/epoch) this is ~50 slots/epoch ≈ ~1MB/year of growth, well within budget.

## Rollback

The old impl address is preserved by the OZ plugin and pinned in
`.openzeppelin/unknown-88780.json` history (git log). To roll back:

```bash
# Find the previous impl entry in the OZ manifest history.
git log -p contracts/.openzeppelin/unknown-88780.json | grep '"address"' | head -20

# Propose a Safe tx pointing the proxy back at the old impl:
SAFE_TX_SERVICE_URL=... POSE_MULTISIG_ADDRESS=... PROPOSER_PRIVATE_KEY=... \
SAFE_TARGET_IMPL=0x<old-impl> \
npx ts-node scripts/safe-propose-pose-upgrade-revert.ts  # (not in PR-D — add if needed)
```

Until PR-E (v1 typehash sunset, 30 days after this upgrade), the old impl
is structurally compatible: every `submitBatchV2` call that worked before
the upgrade also works after. Rollback is therefore equivalent in
behaviour, just slower to settle (no metadata path available).

## Open coordination items (deferred to live upgrade day)

- [ ] **Confirm Safe Tx Service endpoint for chainId 88780** — if not in the
      `safe-global` hosted index, stand up a self-hosted Safe Tx Service
      first.
- [ ] **Identify the Safe owner set + threshold** — required to estimate
      signing-round duration; coordinate signer availability.
- [ ] **Aggregator pause mechanism** — confirm `coc-agent` has a runtime
      flag (or graceful stop) that holds new batches without losing
      in-mempool receipts.
