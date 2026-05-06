# Phase X2 — ValidatorRegistry On-Chain Deployment Report

**Date / 日期**: 2026-05-06
**Status / 状态**: ⚠ partial — contract deployed; reader path verified end-to-end with 1 validator on-chain; 2 of 3 core stakings did not confirm in this session due to RPC mempool stuck-tx symptoms (operational, not architectural).
**Acceptance**: validator-set membership can be driven by an on-chain contract instead of a JSON allowlist. Demonstrated.

---

## 1. What landed / 已完成

| Step | Outcome |
|---|---|
| **X2.1** ValidatorRegistry contract surface audit | ✅ existing `contracts/contracts-src/governance/ValidatorRegistry.sol` (395 LOC) covers all events the off-chain `ValidatorRegistryReader` needs (`ValidatorRegistered`, `ValidatorDeactivated`, `ValidatorSlashed`); `getActiveValidators` view + `activeValidatorCount` view present. Test suite `contracts/test/ValidatorRegistry.test.cjs` passes 28/28 cases. |
| **X2.2** Implement contract | ✅ already existed from Phase F+G Sprint 3 — no new work needed. |
| **X2.3** Hardhat tests | ✅ already existed and pass. |
| **X2.4** Deploy + wire | ⚠ deployed (`0x162700d1613DfEC978032A909DE02643bC55df1A`, block 212676); `validatorRegistryAddress` wired into native configs and removed back out for now (single-validator set replaced the 3-validator JSON allowlist, leaving the cluster effectively running 1-of-1 BFT — see § 3). |
| **X2.5** End-to-end test | ⏳ blocked by X2.4 — needs the bootstrap to land all 3 cores so the on-chain set matches the operational set. |

---

## 2. Deploy artifact / 部署产物

```
contract:        ValidatorRegistry
address:         0x162700d1613DfEC978032A909DE02643bC55df1A
deploy block:    212676
deploy tx:       0xcd46d729fe391c50bafbe158d657e04ffacd3062f4cff60d65da69684ce8a819
deployer:        0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (= node-1 anvil idx 0)
chainId:         18780
RPC endpoint:    http://199.192.16.79:28782 (also reachable on :28780, :28784)
contract source: contracts/contracts-src/governance/ValidatorRegistry.sol
artifact JSON:   contracts/artifacts/contracts-src/governance/ValidatorRegistry.sol/ValidatorRegistry.json
```

Bootstrapped on-chain validator (1 of 3 cores):

```
nodeId:    0xc1ffd3cfee2d9e5cd67643f8f39fd6e51aad88f6f4ce6ab8827279cfffb92266
operator:  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (node-1)
stake:     32 ETH
stake tx:  0x24a08dc7236e34f068a4802caa3679d795bf59a2d0d212f326681841c8d56fd0
```

Two pending stake txs for node-2 / node-3 are stuck in the mempool with a series of higher-nonce successors that block fee-bump replacement. See § 4.

---

## 3. Reader path end-to-end verification / 端到端验证

Wiring was applied to `/etc/coc/node-{1,2,3}.json`:

```json
"validatorRegistryAddress": "0x162700d1613DfEC978032A909DE02643bC55df1A",
"validatorRegistryFromBlock": 212675
```

After `systemctl restart coc-node@{1,2,3}.service`, log line proves the path works:

```
{"level":"info","component":"validator-registry-reader","message":"reader initialized",
 "data":{"address":"0x162700d1613DfEC978032A909DE02643bC55df1A",
         "activeCount":1,"lastScannedBlock":"212714"}}
{"level":"info","component":"node",
 "message":"BFT validator set updated from ValidatorRegistry",
 "data":{"count":1,"ids":["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"]}}
```

This is the Phase X2 acceptance signal — **`BftCoordinator.updateValidators` was driven by an on-chain contract event scan instead of the JSON `validators` array.** Phase X2's architectural goal is met.

The cluster transitioned to a 1-of-1 BFT set after that update (only node-1 was on chain). Chain kept progressing because 1-of-1 quorum is trivially satisfied by self-vote, but the cluster lost its 3-validator Byzantine guarantee. This is the correct behaviour given on-chain state — the registry IS authoritative — but operationally we want **all 3 cores on chain before the wiring goes live in production**.

The wiring was unwired at the end of this session (`validatorRegistryAddress` removed from the JSON configs, natives restarted) so the testnet returns to its 3-validator JSON allowlist and progresses normally pending the staking follow-up.

---

## 4. Stuck-tx residue / 已知 mempool 问题

During the bootstrap stage, two parallel stake-script attempts on the same ports (28782 and a retry from a previous shell) raced and both grabbed the same nonce slot for node-2 (`0x70997970…`), submitting conflicting txs. The result was a queue of pending txs at nonces 3, 4, 5, 6 on node-2 that none of the validators ever included.

```
0x70997970C51812dc3A010C7d01b50e0d17dc79C8: pending=7 latest=3
0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC: pending=4 latest=4
```

Replacement attempts at `gasPrice = 4× / 8×` did not displace the stuck nonces in this session. Not unique to ValidatorRegistry — same pattern would surface on any high-frequency tx under this deployment.

Workarounds for the next session:
1. Submit replacement at the *exact* stuck nonce with gas price ≥ 1.5× incumbent, broadcast through *all* validator RPCs to bypass mempool partition.
2. Or `admin_clearMempool` on each validator (no API exposed today; would need a patch).
3. Or wait out the mempool TTL (configured `mempool.ts` evict) and resubmit fresh.

Once the residue clears: rerun `node contracts/x2-stake-remaining.mjs`, confirm `getActiveValidators` returns 3, re-add `validatorRegistryAddress` to native configs, restart natives, observe the on-chain set replace the JSON allowlist with all 3 cores intact.

---

## 5. Re-wire procedure (after staking is fixed)

```bash
# 1. Confirm 3 of 3 cores on chain
cd /passinger/projects/ClawdBot/COC/contracts && node check-staked.mjs
# expected output: "active set: 3 validators"

# 2. Re-add validatorRegistryAddress to native configs
ssh clawchain-server '
python3 -c "
import json
ADDR = \"0x162700d1613DfEC978032A909DE02643bC55df1A\"
for n in [1,2,3]:
    p = f\"/etc/coc/node-{n}.json\"
    cfg = json.load(open(p))
    cfg[\"validatorRegistryAddress\"] = ADDR
    cfg[\"validatorRegistryFromBlock\"] = 212675
    json.dump(cfg, open(p,\"w\"), indent=2)
"
'

# 3. Rolling restart
ssh clawchain-server 'systemctl restart coc-node@1 coc-node@2 coc-node@3'

# 4. Verify reader loaded all 3
ssh clawchain-server 'grep "validator set updated from ValidatorRegistry" /var/log/coc/node-1.log | tail -1'
# expected: "count":3, ids includes all three core addresses
```

---

## 6. What this enables / 解锁能力

Once X2.4 is fully complete (all 3 cores staked + wired):

- **No-restart validator add**: a 4th validator can stake on chain via `stake(nodeId, pubkey)` and the running cluster picks it up within `validatorRegistryPollIntervalMs` (default 60 s) — no JSON edit, no `systemctl restart`. This is Phase X1's "Day 60 Gate" promise of governance-driven onboarding.
- **No-restart validator remove**: `requestUnstake(nodeId)` triggers the contract's `ValidatorDeactivated` event; reader removes from BFT set on next poll.
- **On-chain slashing**: `slashValidator(nodeId, reason)` (called by the configured slasher account) decrements stake; if slash leaves an active validator at 0 stake, contract emits `ValidatorDeactivated` automatically.

These are the building blocks for Phase X3 (stake redistribution policy) and Phase X4 (slashing + auto-rotation). With X2 deployed, those phases become contract-call work rather than JSON edits.

---

## 7. Follow-up

| Item | Status |
|---|---|
| Clear stuck node-2 mempool nonces; stake node-2 + node-3 | open |
| Re-wire `validatorRegistryAddress` on natives | gated on above |
| End-to-end test: add a 4th validator on-chain (e.g. one of the ext anvil keys) and observe BFT pick it up without restart | gated on above |
| Phase X3 (stake redistribution) — implement `setValidatorStake` governance entry point | not started |
| Phase X4 (auto-rotation on inactivity) — extend slasher to auto-deactivate validators with no proposed blocks for N epochs | not started |

---

## 8. References

- Contract source: `contracts/contracts-src/governance/ValidatorRegistry.sol` (already merged)
- Deploy script: `contracts/deploy-validator-registry.mjs` (path-portability fix this session)
- Helper scripts created this session:
  - `contracts/x2-stake-remaining.mjs` — sequential stake of 2 anvil keys
  - `contracts/x2-stake-via-28780.mjs` — same, via different RPC endpoint
  - `contracts/check-staked.mjs` — read `getActiveValidators` snapshot
- Off-chain reader: `runtime/lib/validator-registry-reader.ts`
- Wiring point: `node/src/index.ts:852-905` (Sprint 4 of Phase F+G)
- Decentralization roadmap context: `docs/testnet-decentralization-analysis-2026-05-06.zh-en.md` § 4.2 Phase X2 row
