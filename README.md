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

- **Chain Engine**: block production, mempool (EIP-1559, replacement, eviction), snapshots, deterministic proposer rotation, basic finality
- **P2P Networking**: HTTP-based gossip for tx/blocks, snapshot sync between peers
- **EVM Execution**: in-memory + persistent state via `@ethereumjs/vm` and LevelDB-backed trie
- **JSON-RPC**: 40+ standard Ethereum methods + custom `coc_*` / `txpool_*` methods, BigInt-safe serialization
- **WebSocket RPC**: `eth_subscribe` / `eth_unsubscribe` for newHeads, newPendingTransactions, logs
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
- **Blockchain Explorer**: Full-featured Next.js app (see below)
- **Testing**: 190 tests across 9 suites, covering chain engine, EVM, mempool, RPC, WebSocket, P2P, and storage

### Blockchain Explorer Features

The explorer (`explorer/`) is a Next.js 15 App Router application providing:

- **Homepage**: chain stats dashboard (block height, avg block time, gas price, peer count, chain ID, sync status), latest blocks table, real-time block and pending tx streams via WebSocket
- **Block Detail** (`/block/[id]`): full transaction table with method decoding, from/to, value, status, gas used; token transfers aggregated from receipts; prev/next block navigation; gas utilization percentage
- **Transaction Detail** (`/tx/[hash]`): decoded method name, token transfers (ERC-20 Transfer/Approval), event logs, status badge
- **Address Detail** (`/address/[address]`): balance, nonce, transaction history with filter tabs (All/Sent/Received/Contract/Token), contract detection
- **Contract View**: bytecode display with EVM opcode disassembler (PUSH/DUP/SWAP + all standard opcodes), eth_call interface with quick-call presets (name/symbol/decimals/totalSupply/owner/paused), ABI string decoder, storage scanner with multi-slot range scan and value interpretation (uint256/address)
- **Mempool** (`/mempool`): pool stats, live pending tx stream, pending transactions table with method/from/to/value/gas
- **Network** (`/network`): node runtime info, uptime, mempool stats, connection endpoints
- **Search**: supports address, tx hash, block number, hex block number
- **404 Page**: user-friendly not-found page

### Recent Development (Cycles 1–10)

| Cycle | Commit | Summary |
|-------|--------|---------|
| 1 | `226018d` | Fix PersistentStateTrie RLP decode — `@ethereumjs/trie` v6 passes hex strings, not Uint8Array |
| 2 | `69bd222` | Add 13 missing standard Ethereum RPC methods (eth_getBlockTransactionCount*, eth_getTransactionByBlock*, eth_feeHistory, eth_maxPriorityFeePerGas, filter methods) |
| 3 | `7cc9543` | Token transfer decoding (ERC-20 Transfer/Approval events) and method signature display in explorer |
| 4 | `e8e71e4` | Chain statistics dashboard on explorer homepage with 8 stat cards |
| 5 | `df50eb3` | Contract call interface (eth_call UI with presets) and WebSocket BigInt serialization fix |
| 6 | `c613d08` | eth_getBlockReceipts RPC method + enhanced block detail page with full tx table |
| 7 | `114b650` | txpool_status/txpool_content RPC methods + mempool explorer page |
| 8 | `684dffa` | Network status page (coc_nodeInfo RPC) + global 404 page |
| 9 | `8fbbbc7` | EVM bytecode disassembler + storage scanner with range scan and value interpretation |
| 10 | `6339490` | Test coverage enhancement: 175 → 190 tests covering all new RPC methods and mempool APIs |

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

