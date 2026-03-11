# COC Settlement Contracts

## Quick Start

```bash
cd COC/contracts
npm install
npm run compile
npm test
npm run deploy:pose:coc
```

## Included

- Settlement contracts:
  - `settlement/PoSeManager.sol`
  - `settlement/PoSeManagerStorage.sol`
  - `settlement/PoSeTypes.sol`
  - `settlement/MerkleProofLite.sol`
- Hardhat config:
  - `hardhat.config.cjs`
- Deploy entrypoints:
  - `deploy/cli-deploy-pose.ts`
  - `deploy/deploy-pose.ts`
- Contract tests:
  - `test/*.cjs`

## Notes

- `deploy:pose` is the formal PoSeManagerV2 deployment CLI.
- `deploy:pose:coc` targets the local/default COC network preset.
- `deploy:local` is now a compatibility alias to `deploy:pose:coc`, not the removed `scripts/deploy-posemanager.js`.
- Hardhat exposes both `coc` and legacy `prowl` network aliases for governance deployment; prefer `deploy:governance:coc` for new usage.
- Contract verification is provided by the Explorer `/verify` flow, which recompiles locally and compares deployed bytecode; this package does not ship a Hardhat `verify:pose` script.
- For persistent networks, set RPC/private-key environment variables before deployment.
