# COC (ChainOfClaw)

COC is an EVM-compatible blockchain prototype with PoSe (Proof-of-Service) settlement and an IPFS-compatible storage interface.

## Structure

- `docs/`: whitepaper and technical documentation
- `specs/`: protocol/economics/roadmap specifications
- `contracts/`: PoSe settlement contracts
- `services/`: off-chain challenger/verifier/aggregator/relayer
- `runtime/`: coc-node / coc-agent / coc-relayer
- `node/`: chain engine + RPC + P2P + storage
- `wallet/`: minimal CLI wallet
- `tests/`: integration and e2e tests
- `scripts/`: devnet and verification scripts
- `explorer/`: blockchain explorer frontend
- `website/`: project website
- `nodeops/`: node operations and policy engine

## Current Progress

- Chain engine: block production, mempool, snapshots, basic finality
- P2P: HTTP gossip + snapshot sync
- EVM: in-memory execution with minimal JSON-RPC
- PoSe: challenge/receipt pipeline, batch aggregation, on-chain PoSeManager
- Storage: IPFS-compatible add/cat/get/block/pin/ls/stat/id/version + gateway
- Runtime: coc-node endpoints + coc-agent/relayer automation
- Tooling: wallet CLI and 3/5/7 node devnet scripts
- Explorer: Next.js blockchain explorer with block/tx/address views

## Quick Start

### Run a local node

```bash
cd node
npm install
npm start
```

### Deploy PoSe contracts

```bash
cd contracts
npm install
npm run compile
npm run deploy:local
```

### Run devnet

```bash
bash scripts/devnet-3.sh  # 3-node network
bash scripts/devnet-5.sh  # 5-node network
bash scripts/devnet-7.sh  # 7-node network
```

### Start explorer

```bash
cd explorer
npm install
npm run dev
# Open http://localhost:3000
```

## Quality Gate

```bash
bash scripts/quality-gate.sh
```

## Docs

- Implementation status: `docs/implementation-status.md`
- Feature matrix: `docs/feature-matrix.md`
- System architecture: `docs/system-architecture.en.md`
- Core algorithms: `docs/core-algorithms.en.md`

## License

MIT License - See LICENSE file for details
