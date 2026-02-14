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

- **Chain Engine**: block production, mempool, snapshots, deterministic proposer rotation, basic finality
- **P2P Networking**: HTTP-based gossip for tx/blocks, snapshot sync between peers
- **EVM Execution**: in-memory execution with `@ethereumjs/vm`, minimal JSON-RPC support
- **PoSe Protocol**:
  - Off-chain: challenge factory, receipt verification, batch aggregation, epoch scoring
  - On-chain: PoSeManager contract with registration, batch submission, challenge, finalize, slash
- **Storage Layer**: IPFS-compatible HTTP APIs (add/cat/get/block/pin/ls/stat/id/version) + `/ipfs/<cid>` gateway
- **Runtime Services**:
  - `coc-node`: PoSe challenge/receipt HTTP endpoints
  - `coc-agent`: challenge generation, batch submission, node registration
  - `coc-relayer`: epoch finalization and slash automation
- **Node Operations**: YAML-based policy engine with agent lifecycle hooks
- **Tooling**:
  - CLI wallet (create address, transfer, query balance)
  - Devnet scripts for 3/5/7 node networks
  - Quality gate script (unit + integration + e2e tests)
- **Blockchain Explorer**: Next.js app with block/tx/address views and real-time data
- **Testing**: 32 test files covering contracts, services, runtime, and node operations

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

