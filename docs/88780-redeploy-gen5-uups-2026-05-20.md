# 88780 testnet — gen-5 UUPS upgradeable redeploy (2026-05-20)

## Summary

All 13 COC production contracts on 88780 are now **UUPS upgradeable proxies**,
with the existing 3-of-5 `MultiSigWallet` as the sole upgrade authority. This
is the fifth 88780 contract deployment generation; **every contract address
changed**.

Before gen-5, each security fix triggered a full immutable redeploy (gen-1
through gen-4 = 4 generations in 9 days). Future bug fixes for these
contracts can ship as an in-place `upgradeProxy()` signed by the multisig —
no address churn for off-chain consumers.

## Change set on `main`

PR #707 (`14d5ccc`) — convert 13 contracts to OpenZeppelin UUPS upgradeable:

- `Initializable` + `UUPSUpgradeable` inheritance; locked-implementation
  constructor (`_disableInitializers()`); proxy `initialize(...)` runs once.
- Every contract's `_authorizeUpgrade(address)` is gated on `onlyOwner` — the
  multisig becomes the sole upgrade authority after the gen-5 handoff.
- All upgrade-blocking `immutable` state vars (`DOMAIN_SEPARATOR` on
  Soul/DIDRegistry, `soulRegistry` on DIDRegistry, `validatorRegistry` on
  EquivocationDetector, `INCLUSION_DELAY` on DelayedInbox, the three Rollup
  bond/window vars) converted to mutable storage and initialised in
  `initialize`.
- `uint256[50] private __gap;` at every contract's storage end — see "Storage
  discipline" below.
- `PoSeManagerStorage` refactored to an abstract upgradeable base with a
  chained `__PoSeManagerStorage_init(initialOwner)` internal initialiser.
- `PoSeManagerV2.initialize` signature simplified to
  `(challengeBondMin, initialOwner)` — `chainId` and `verifyingContract` are
  now `block.chainid` and `address(this)` (the proxy) inside the initialiser.
- `MultiSigWallet.sol` left untouched — the upgrade authority must stay
  immutable, or the authority is recursively upgradeable.
- PR #706 (GovernanceDAO bicameral silent-faction fix, #705) folded into the
  gen-5 GovernanceDAO initial implementation.
- New `@openzeppelin/contracts-upgradeable@^5.1.0` +
  `@openzeppelin/hardhat-upgrades@^3.6.0` dependencies; plugin required in
  `hardhat.config.cjs`.
- 22 existing test suites adapted to `upgrades.deployProxy`; new
  `contracts/test/uups-upgrade-safety.test.cjs` regression suite (15
  contracts × 2 tests = 30 cases) locks in storage layout + upgrade auth.
- 4 integration test suites in `tests/integration/` adapted via a new
  vendored `TestERC1967Proxy.sol` helper so they can deploy proxies without
  the hardhat-upgrades plugin (they spawn a real Hardhat node).

Contract test suite on the merged `main`: **525 passing** (vs 494 pre-UUPS;
+30 upgrade-safety + 1 #706 regression). No regressions.

## On-chain redeploy

Multisig and deployer reused from gen-4 — only the contracts are new.

| Role | Address | Notes |
|---|---|---|
| Deployer (reused gen-4) | `0xB4E943F5F34b763fC78598a9e528995B4CDe786a` | non-public BIP-39, funded from `0xf39Fd6…` during gen-4 |
| MultiSigWallet 3-of-5 (reused gen-4) | `0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E` | upgrade authority for every UUPS proxy |
| FactionRegistry | `0xc37d28297dB885d2B8d9966Cbb5df2e142671287` | |
| GovernanceDAO | `0x4b9485670eA389Aeab7aC04d48bb2b42D0e8bdc7` | includes #706/#705 bicameral fix |
| Treasury | `0x512B012683c88103b1BEE3ad470108B47fBD7C7E` | |
| SoulRegistry | `0x3B6b5Fd45F8a6A2756e6D436d90b67faD0509244` | DOMAIN_SEPARATOR computed in initialize from address(this) |
| DIDRegistry | `0xe2D8165Cb9416bf92E4304446A5Dccd20Db45fbF` | |
| CidRegistry | `0x780603254D19A60ae35a1aEEBbB4dCd0c514371b` | |
| PoSeManager (v1) | `0x91e1D4aBcb68476368E8Ec02d61456a08Ae43BD8` | |
| PoSeManagerV2 | `0x256eb949C50d5F2af8699191b1Bc043203263549` | DOMAIN_SEPARATOR=`0x8b80503c…` (live-verified), challengeBondMin=0.1 ETH, FINALIZE_BATCH_BUDGET=200 |
| ValidatorRegistry | `0x4441299c118373fDC96bE1983d42C79e19CDb4F0` | |
| EquivocationDetector | `0xa5dcE830e917176c1091fd6112F41E47692C510e` | |
| InsuranceFund | `0x0546E0D98A18e110D3dFCFA150Bcd1C0a589d688` | |
| DelayedInbox | `0xac820809399D6740eB274D99827a5ee595881A00` | |
| RollupStateManager | `0xA2Bf9FA3382A0A8aFf406BE8A8e9a64E1d69dC4e` | #683 proposer allowlist live (non-allowlisted `submitOutputRoot` reverts) |

Canonical source of truth: `configs/deployed-contracts-88780.json` (synced
to the `@chainofclaw/soul` 88780 manifest via claw-mem PR #49).

Storage-layout bookkeeping: `contracts/.openzeppelin/unknown-88780.json` is
**committed** as part of the manifest PR — the OpenZeppelin upgrades plugin
validates new implementations against this file on every `upgradeProxy()`.
Losing it loses the safety check.

## Procedure

```bash
# 0. Pre-conditions: existing gen-4 multisig + deployer in ~/.coc/keys/
# 1. Compile (already includes OZ upgradeable + the upgrades plugin)
cd contracts && npm install && npx hardhat compile

# 2. Set env. The deployer key is funded from gen-4; the multisig is
#    deployed and owns gen-4's contracts (its address is reused).
export DEPLOYER_PRIVATE_KEY=<gen-4 deployer key from ~/.coc/keys/88780-deployer.json>
export COC_RPC_URL=http://209.74.64.88:38780
export COC_CHAIN_ID=88780
export MULTISIG_ADDRESS=0x3c055D83a9aA12Bba4a2ed53F8970DF4081eBC7E
export TREASURY_SIGNERS=<5 owner addresses from ~/.coc/keys/88780-multisig/>

# 3. Governance trio (each via upgrades.deployProxy under the hood)
npx hardhat run scripts/deploy-governance.js --network coc

# 4. Remaining 10 contracts. Same flow; deploy-all-88780.js also runs the
#    transferOwnership loop and writes configs/deployed-contracts-88780.json
export FACTION_REGISTRY=...  GOVERNANCE_DAO=...  TREASURY=...
npx hardhat run scripts/deploy-all-88780.js --network coc

# 5. Commit configs/deployed-contracts-88780.json +
#    contracts/.openzeppelin/unknown-88780.json
```

## Validation

Live-verified on 88780 (RPC `http://209.74.64.88:38780`):

- Every 13 proxy `owner()` == multisig `0x3c055D83…`.
- PoSeManagerV2: `initialized()==true`, `DOMAIN_SEPARATOR != 0` (=`0x8b80503c…`,
  computed from proxy address inside initialize), `challengeBondMin==0.1 ETH`,
  `FINALIZE_BATCH_BUDGET==200`.
- RollupStateManager: `submitOutputRoot` from a random non-allowlisted EOA
  reverts (#683 proposer allowlist live).
- `upgradeToAndCall` from a random EOA on a CidRegistry proxy reverts (UUPS
  `_authorizeUpgrade` auth gate live).
- Network kept producing blocks throughout (deployer-only txs — no consensus
  impact).
- `cd contracts && npm test`: **525 passing** on `main`.

## Storage discipline (new, load-bearing from gen-5 on)

UUPS proxies share their storage slots across upgrades. From gen-5 forward,
every PR that touches a UUPS contract's storage must observe the OZ rules:

1. New storage fields go **before** `uint256[50] private __gap;` and the gap
   shrinks by the number of slots consumed.
2. Existing storage fields cannot be reordered, removed, or changed type.
3. Inheritance order cannot change for existing UUPS contracts.

The OZ hardhat-upgrades plugin enforces these rules on every
`upgrades.deployProxy` and `upgrades.upgradeProxy` call against
`contracts/.openzeppelin/unknown-88780.json`. **That file must be committed;
without it the plugin's safety check is bypassed.** Tests in
`contracts/test/uups-upgrade-safety.test.cjs` exercise this path per contract.

## Operational impact

- **No node restart.** Core validators / observers don't reference contract
  addresses.
- **All `onlyOwner` actions on 88780 — including `upgradeToAndCall` — now
  require a 3-of-5 multisig transaction.** The deployer key has zero residual
  privilege after the handoff.
- **Future bug fixes ship as upgrades**, not redeploys. Proxy addresses are
  permanent; manifest churn ends.
- Consumers (PoSe agent/relayer, `@chainofclaw/soul`, explorer) take the new
  proxy addresses from the manifest. Off-chain code is unchanged — the proxy
  presents the implementation's ABI transparently.
- PR #706 (GovernanceDAO bicameral silent-faction, #705) is folded into the
  gen-5 GovernanceDAO initial implementation; #706 will be closed.
- #686 (gen-4: multisig-as-owner) is preserved and extended at the proxy
  layer — the multisig is now the upgrade authority too.

## 88780 deployment history

| Date | Generation | Trigger | Scope | Notes |
|---|---|---|---|---|
| 2026-05-11 | gen-0 | initial bring-up | superseded | |
| 2026-05-18 | gen-1 | PR #675 — full #645–#670 security batch | full 13 | superseded |
| 2026-05-18 | gen-2 | PR #678 — #676 pull-payment | PoSeManagerV2 only | superseded |
| 2026-05-19 | gen-3 | PR #698 — #677 / #680 (settle CEI + finalize pagination) | PoSeManagerV2 only | superseded |
| 2026-05-19 | gen-4 | PRs #688/#690/#692/#695/#696/#697 + PR #701 manifest — full 13 with multisig owner (#686) | full 13 + MultiSigWallet | superseded by gen-5 |
| **2026-05-20** | **gen-5 (current)** | **PR #707 (UUPS conversion) + PR #708 manifest — every contract behind a UUPS proxy** | **full 13 proxies + reused multisig + #706 fold** | **upgrade-in-place from here on** |
