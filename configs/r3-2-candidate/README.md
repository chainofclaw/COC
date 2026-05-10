# COC R3.2 Prod-Candidate Testnet (chainId 88780)

This directory holds the public configuration for the R3.2 prod-candidate
chain. It is the rehearsal environment for mainnet bring-up.

## Files

- `genesis.json` — chain spec: chainId 88780, 5 BFT validators, prefund map.
- `validators.json` — public addresses of the 5 validators (also kept at
  `~/.coc/keys/88780-prod-candidate/validators.json` next to private keys).
- `README.md` — this file.

## Validator key custody

Per-validator private keys live at `~/.coc/keys/88780-prod-candidate/`
(chmod 600 each, never committed). Generated via:

```bash
bash scripts/generate-validator-keys.sh 5 ~/.coc/keys/88780-prod-candidate/
```

Each validator-N.env contains `COC_NODE_KEY` + `COC_NODE_ID`.
`validators-private.json` (mode 0600) holds the index-mapped
`{address, privateKey}` pairs for genesis editing — also never committed.

## Stake allocation

Each of the 5 validators is granted exactly 32 ETH stake at genesis.
With `relaxedQuorum=true` the BFT threshold is `(160 × 2) / 3 = 106` —
4 active validators (128 stake) reach quorum; 3 active (96) does not.
This is the f=1 fault-tolerant configuration.

The `validatorStakes` block in genesis is the seed value; the on-chain
`ValidatorRegistry` contract becomes the authoritative source after
deployment + reader subscription is wired (per `node/src/index.ts`
ValidatorRegistry reader path).

## Prefund

- `0xf39F...92266` (anvil-0) — 10M ETH; convenience deployer for the
  pre-deployment phase. Replace with a managed deployer before any
  production-equivalent traffic.
- 5 validator addresses — 100 ETH each, so each validator has gas to
  call `ValidatorRegistry.stake(32 ether)` and ongoing operational tx.

## Next steps

This config is **inert** until the chain is bootstrapped:

1. Spin up validator-1's coc-node with `COC_NODE_CONFIG` pointing at
   `genesis.json` and `COC_NODE_KEY` from `validator-1.env`.
2. Bring up validator-2..5 once validator-1 is producing.
3. Deploy 10 governance contracts via
   `contracts/deploy-all-registries-newchain.mjs` with
   `RPC=http://<validator-1>:28780`.
4. Each validator stakes 32 ETH into ValidatorRegistry.
5. Wire up ValidatorRegistry reader in node configs.

See `docs/r3-2-prod-candidate-testnet-88780.md` for the full SOP.
