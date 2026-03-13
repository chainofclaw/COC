# COC EVM and Smart Contract Compatibility

This document describes the current state of COC's EVM execution stack, smart contract compatibility boundaries, runtime limitations, and contract deployment and usage methods. The content is based on the actual repository implementation, not whitepaper-level goals.

Design principle: COC separates on-chain execution, off-chain PoSe services, and runtime automation. The EVM handles transaction execution and state persistence, PoSe contracts handle settlement, and runtime programs handle challenge, reward, slash, and other off-chain orchestration.

Module scope: This document covers the contract compatibility capabilities exposed by `node/src/evm.ts`, `node/src/rpc.ts`, `node/src/storage/persistent-state-manager.ts`, `contracts/contracts-src/*`, `contracts/deploy/*`, `runtime/*`, and `explorer/src/lib/solc-verify.ts`.

## 1. Current Assessment

As of the current codebase, COC can be considered an "EVM-compatible prototype chain supporting standard Solidity contract deployment and invocation", but it is not equivalent to a "complete Ethereum node implementation".

Key takeaways:

- Execution engine is functional: based on `@ethereumjs/vm`, defaulting to Shanghai semantics, supporting a single configured `hardfork`, and also supporting a static `hardforkSchedule` for block-height-based transitions.
- Contracts can be deployed, called, and persisted: supports contract creation, state storage, logs, receipts, `eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_getLogs`, and other core paths.
- RPC compatibility is "sufficient but not fully equivalent": core EVM/RPC paths work, but full Ethereum parity is still missing.
- Contract deployment should use standard `ethers` / Hardhat workflows, submitting signed transactions via `eth_sendRawTransaction`; `eth_sendTransaction` is only available with explicitly enabled dev accounts.
- PoSe settlement and governance contracts have test coverage, but the deployment toolchain is not entirely "out of the box" — some script entries must be used according to current repository reality, not legacy documentation.

## 2. EVM Execution Details

### 2.1 Execution Stack

COC's EVM execution core is in [`node/src/evm.ts`](/home/bob/projects/ClawdBot/COC/node/src/evm.ts).

- Execution engine: `@ethereumjs/vm`
- Common configuration: `createCustomCommon(...)`
- Hardfork: defaults to `Shanghai`, with support for a single `hardfork` override and a static `hardforkSchedule`
- Transaction execution: `runTx(...)`
- Read-only contract calls: `vm.evm.runCall(...)`

This means COC does not implement its own bytecode interpreter, but reuses a mature EVM library with chain storage, RPC, log indexing, and PoSe runtime connected around it.

### 2.2 State Persistence

COC is no longer a "pure in-memory EVM".

The current state persistence path is:

1. `PersistentStateTrie` uses LevelDB to persist accounts, storage slots, and code.
2. `PersistentStateManager` adapts the trie into a state manager compatible with `ethereumjs/vm`.
3. `EvmChain.create(chainId, stateManager, { hardfork?, hardforkSchedule? })` injects this persistent state manager, default hardfork, and optional static upgrade schedule into the VM.
4. After node restart, state can be restored directly from the existing state root without full replay.

Related implementation:

- [`node/src/storage/state-trie.ts`](/home/bob/projects/ClawdBot/COC/node/src/storage/state-trie.ts)
- [`node/src/storage/persistent-state-manager.ts`](/home/bob/projects/ClawdBot/COC/node/src/storage/persistent-state-manager.ts)
- [`node/src/index.ts`](/home/bob/projects/ClawdBot/COC/node/src/index.ts)

### 2.3 Block Execution and State Isolation

When applying remote blocks, COC now uses native EVM `checkpoint/commit/revert` for speculative execution isolation, rather than doing "fake forks" only at the trie level.

The execution flow is roughly:

1. Non-locally proposed block enters `applyBlock()`
2. Calls `evm.checkpointState()`
3. Replays transactions in the block
4. Validates `gasUsed`
5. Validates `stateRoot`
6. On success: `commitState()`; on failure: `revertState()`

This ensures invalid remote blocks do not pollute the parent state.

Related implementation:

- [`node/src/chain-engine.ts`](/home/bob/projects/ClawdBot/COC/node/src/chain-engine.ts)
- [`node/src/evm.ts`](/home/bob/projects/ClawdBot/COC/node/src/evm.ts)

### 2.4 Block Header and Receipt Views

COC currently exposes real computed values for RPC:

- `transactionsRoot`
- `receiptsRoot`
- `logsBloom`
- `stateRoot`

These are not fixed placeholder values, but are computed at runtime from blocks and receipts.

Related implementation:

- [`node/src/block-header.ts`](/home/bob/projects/ClawdBot/COC/node/src/block-header.ts)
- [`node/src/rpc.ts`](/home/bob/projects/ClawdBot/COC/node/src/rpc.ts)
- [`node/src/chain-events.ts`](/home/bob/projects/ClawdBot/COC/node/src/chain-events.ts)

## 3. Current Smart Contract Compatibility

### 3.1 Capabilities Considered Compatible

COC's current compatibility with "standard Solidity contracts" is demonstrated in the following scenarios:

| Capability | Status | Notes |
|---|---|---|
| Contract creation | Available | Contracts can be deployed via signed transactions |
| Contract invocation | Available | `eth_call` supports read-only calls |
| State read/write | Available | Persisted to account / storage trie |
| Log events | Available | Receipts and log indexing available |
| Code query | Available | `eth_getCode` |
| Storage slot query | Available | `eth_getStorageAt` |
| Historical receipt query | Available | Depends on persistent block index / receipts |
| WebSocket subscriptions | Available | `newHeads` / `newPendingTransactions` / `logs` |

From test coverage, the following contract families have been compiled, deployed, and tested:

- PoSe settlement contracts
  - `PoSeManager`
  - `PoSeManagerV2`
- Governance contracts
  - `FactionRegistry`
  - `GovernanceDAO`
  - `Treasury`
- Test/compatibility contracts
  - `ERC20Mock`
  - `ERC721Mock`
  - `ReentrancyAttacker`
  - `Eip712Harness` (located under `contracts-src/test/`)

Related directories:

- [`contracts/contracts-src/settlement`](/home/bob/projects/ClawdBot/COC/contracts/contracts-src/settlement)
- [`contracts/contracts-src/governance`](/home/bob/projects/ClawdBot/COC/contracts/contracts-src/governance)
- [`contracts/contracts-src/test-contracts`](/home/bob/projects/ClawdBot/COC/contracts/contracts-src/test-contracts)
- [`contracts/contracts-src/test`](/home/bob/projects/ClawdBot/COC/contracts/contracts-src/test) (Eip712Harness)
- [`contracts/test`](/home/bob/projects/ClawdBot/COC/contracts/test)

### 3.2 Verified EVM Semantics

Current implementation and tests confirm:

- Shanghai semantics by default, plus static `hardforkSchedule` switching by block height
- EIP-1559 base fee calculation support
- Standard transaction receipts and logs
- At least precompile boundary paths from 0x01 to 0x09
- `PUSH0` and other Shanghai features
- Historical execution context propagation into `eth_call`, `eth_estimateGas`, `eth_createAccessList`, `debug_traceCall`, `trace_call`, and `trace_callMany`
- `eth_estimateGas` now includes calldata and contract-creation intrinsic gas in the estimate

Related implementation and tests:

- [`node/src/base-fee.ts`](/home/bob/projects/ClawdBot/COC/node/src/base-fee.ts)
- [`node/src/precompiles.test.ts`](/home/bob/projects/ClawdBot/COC/node/src/precompiles.test.ts)
- [`node/src/hardfork.test.ts`](/home/bob/projects/ClawdBot/COC/node/src/hardfork.test.ts)

### 3.3 Compatibility Is Not "Full Ethereum Node Equivalence"

This must be stated clearly.

The repository's own implementation status document marks the execution layer as `Partial`, and the feature matrix explicitly notes `RPC: full EVM parity — Missing`:

- [`docs/implementation-status.md`](/home/bob/projects/ClawdBot/COC/docs/implementation-status.md)
- [`docs/feature-matrix.md`](/home/bob/projects/ClawdBot/COC/docs/feature-matrix.md)

A more accurate characterization:

- "Supports standard Solidity contracts and common Ethereum toolchains" — true
- "Fully behavior-equivalent to Geth / Nethermind / Erigon" — not currently true

## 4. RPC and Toolchain Compatibility

### 4.1 Available JSON-RPC Methods

`node/src/rpc.ts` currently implements 95 JSON-RPC methods inside `handleRpcMethod()`, grouped by namespace:

**eth_ — Standard Ethereum Methods**

- Chain and blocks
  - `eth_chainId`, `eth_blockNumber`, `eth_syncing`, `eth_protocolVersion`
  - `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getBlockReceipts`
  - `eth_getBlockTransactionCountByHash`, `eth_getBlockTransactionCountByNumber`
  - `eth_getTransactionByBlockHashAndIndex`, `eth_getTransactionByBlockNumberAndIndex`
- Accounts and transactions
  - `eth_getBalance`, `eth_getTransactionCount`, `eth_accounts`
  - `eth_getTransactionByHash`, `eth_getTransactionReceipt`
  - `eth_sendRawTransaction`, `eth_sendTransaction` (only available when `COC_DEV_ACCOUNTS=1`)
- Contracts
  - `eth_call`, `eth_estimateGas`, `eth_getCode`, `eth_getStorageAt`, `eth_getProof`
  - `eth_createAccessList` (collects access list data from real execution)
- Logs and filters
  - `eth_getLogs`, `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`
  - `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_uninstallFilter`
- Fees
  - `eth_gasPrice`, `eth_feeHistory`, `eth_maxPriorityFeePerGas`
- Signing
  - `eth_sign`, `eth_signTypedData_v4`
- Uncle (stubs, COC has no uncle concept)
  - `eth_getUncleCountByBlockHash`, `eth_getUncleCountByBlockNumber`
  - `eth_getUncleByBlockHashAndIndex`, `eth_getUncleByBlockNumberAndIndex`
- Mining (stubs, COC does not do PoW)
  - `eth_mining`, `eth_hashrate`, `eth_coinbase`
  - `eth_getWork`, `eth_submitWork`, `eth_submitHashrate`
- Compilation (partial)
  - `eth_getCompilers`
  - `eth_compileSolidity` (compiled via lazily loaded workspace `solc`)
  - `eth_compileLLL` and `eth_compileSerpent` remain unsupported

**web3_ — Client Information**

- `web3_clientVersion` (returns `"COC/0.2"`)
- `web3_sha3`

**net_ — Network Information**

- `net_version`, `net_listening`, `net_peerCount`

**debug_ / trace_ — Debugging (requires `COC_DEBUG_RPC=1`)**

- `debug_traceTransaction`, `debug_traceBlockByNumber`, `debug_traceCall`
- `trace_transaction`, `trace_call`, `trace_replayTransaction`, `trace_replayBlockTransactions`
- `trace_rawTransaction`, `trace_block`, `trace_filter`, `trace_get`, `trace_callMany`

**txpool_ — Transaction Pool**

- `txpool_status`, `txpool_content`

**admin_ — Node Management (requires `enableAdminRpc=true`)**

- `admin_nodeInfo`, `admin_addPeer`, `admin_removePeer`, `admin_peers`

**coc_ — COC Custom Methods**

- Chain information
  - `coc_nodeInfo`, `coc_chainStats`, `coc_getNetworkStats`
- Validators and governance
  - `coc_validators`, `coc_getValidators`
  - `coc_submitProposal`, `coc_voteProposal`
  - `coc_getGovernanceStats`, `coc_getProposals`
  - `coc_getDaoProposal`, `coc_getDaoProposals`, `coc_getDaoStats`
  - `coc_getTreasuryBalance`, `coc_getFaction`
- BFT consensus
  - `coc_getBftStatus`, `coc_getEquivocations`
- Contract indexing
  - `coc_getContracts`, `coc_getContractInfo`
- Transaction indexing
  - `coc_getTransactionsByAddress`
- PoSe rewards
  - `coc_getRewardManifest`, `coc_getRewardClaim`
- Storage
  - `coc_prunerStats`

Implementation file:

- [`node/src/rpc.ts`](/home/bob/projects/ClawdBot/COC/node/src/rpc.ts)

### 4.2 WebSocket Compatibility

WebSocket RPC supports subscriptions:

- `eth_subscribe("newHeads")`
- `eth_subscribe("newPendingTransactions")`
- `eth_subscribe("logs")`

However, it is not a complete mirror of HTTP RPC. Some methods are explicitly blocked via WebSocket, including:

- Filter management methods
- `admin_*`
- `coc_submitProposal`
- `coc_voteProposal`

Related implementation:

- [`node/src/websocket-rpc.ts`](/home/bob/projects/ClawdBot/COC/node/src/websocket-rpc.ts)

### 4.3 Explorer Contract Verification

The Explorer provides a contract verification workflow, but its semantics are "recompile locally and compare against on-chain deployed bytecode", not an Etherscan/Sourcify-style public verification service.

How it works:

1. Explorer receives source code, compiler version, and optimization parameters
2. Recompiles with `solc`
3. Calls `eth_getCode`
4. Strips the metadata suffix from the deployment bytecode and compares

Related implementation:

- [`explorer/src/app/api/verify/route.ts`](/home/bob/projects/ClawdBot/COC/explorer/src/app/api/verify/route.ts)
- [`explorer/src/lib/solc-verify.ts`](/home/bob/projects/ClawdBot/COC/explorer/src/lib/solc-verify.ts)

## 5. Current Runtime Limitations

This is the most important section of this document.

### 5.1 EVM / Hardfork Limitations

- The default hardfork is `Shanghai`
- A single configured `hardfork` can switch the whole node to another `@ethereumjs/common` hardfork
- A static `hardforkSchedule` can switch execution semantics by block height
- COC still does not derive a full upgrade schedule automatically from chain metadata like mainstream Ethereum clients
- If your toolchain or bytecode strictly depends on other fork-era differences, you must still verify independently

Impact:

- Shanghai features like `PUSH0` are available
- Scenarios requiring "exact behavioral equivalence under London / Berlin / Cancun" should not be assumed

### 5.2 Not a Complete Ethereum Node

The following methods are currently missing, simplified, or stubbed:

| Method/Capability | Status | Notes |
|---|---|---|
| `RPC: full EVM parity` | Missing | Repository explicitly marks as Missing |
| `eth_createAccessList` | Available but still limited | Returns access-list entries and `gasUsed` from real execution, but edge-case parity with Geth is not guaranteed |
| `debug_trace*` / `trace_*` | Partial | Supports `debug_traceCall`, `trace_call`, `trace_callMany`, `trace_replayTransaction`, `trace_replayBlockTransactions`, `trace_rawTransaction`, `trace_block`, `trace_filter`, and `trace_get`, producing replay-backed traces from real execution; `trace_transaction`, `trace_block`, `trace_filter`, and `trace_get` now consistently return localized OpenEthereum-style traces; `debug_traceCall`, `debug_traceTransaction`, and `debug_traceBlockByNumber` now also support the built-in `callTracer` and `prestateTracer`, with `callTracer.onlyTopCall`, `callTracer.withLog`, and best-effort ABI `revertReason` decoding for `Error(string)` / `Panic(uint256)`; unknown custom errors fall back to `CustomError(0x<selector>)`; plus `prestateTracer.diffMode`, `disableCode`, and `disableStorage`; `trace_filter` now supports `fromBlock/toBlock`, `fromAddress/toAddress`, and `after/count`, `trace_get` can resolve a single localized trace by `traceAddress`, and `trace_callMany` applies each simulated call on top of the previous call's resulting state; `vmTrace` now exports best-effort `code` and a depth-collapsed `sub` tree, while `stateDiff` combines access-list targets with storage observed in `structLogs`, and now covers created-contract `code/storage` changes as well, but it still falls short of full OpenEthereum semantics |
| `eth_compile*` / `eth_getCompilers` | Partial | `eth_getCompilers` and `eth_compileSolidity` are now supported; `eth_compileSolidity` compiles source via lazily loaded `solc`, while `eth_compileLLL` / `eth_compileSerpent` still return unsupported |
| `eth_mining` / `eth_hashrate` / `eth_coinbase` | Stubs | Returns fixed values (`false` / `"0x0"` / zero address) |
| `eth_getWork` / `eth_submitWork` / `eth_submitHashrate` | Stubs | COC does not do PoW mining |
| Uncle-related methods | Stubs | Returns `0x0` or `null` |

### 5.3 Transaction and RPC Rate Limiting

Current runtime limits include:

- Block gas limit: `30,000,000`
- `eth_call` gas cap: maximum `30,000,000`
- `eth_estimateGas` defaults to `30,000,000` as upper bound and now includes calldata / contract-creation intrinsic gas in the estimate
- Raw transaction size limit: ~`128 KiB`
- RPC request body size limit: `1 MiB`
- Filter limit: `1000`
- `eth_getLogs` / filter log scan range limit: `10,000` blocks
- Debug RPC disabled by default, must explicitly set `COC_DEBUG_RPC=1`

Related implementation:

- [`node/src/base-fee.ts`](/home/bob/projects/ClawdBot/COC/node/src/base-fee.ts)
- [`node/src/rpc.ts`](/home/bob/projects/ClawdBot/COC/node/src/rpc.ts)

### 5.4 `eth_sendTransaction` Is Not a Production Deployment Interface

`eth_sendTransaction` only has dev accounts available when `COC_DEV_ACCOUNTS=1` is explicitly enabled.

This means:

- Local development and debugging can use `eth_sendTransaction`
- Production contract deployment and transactions should use an external signer via `eth_sendRawTransaction`
- Standard external wallet workflows with Hardhat / ethers / Foundry are more appropriate for COC's actual usage

### 5.5 Historical Queries and `nodeMode` Boundaries

COC supports node operating modes:

- `archive`
- `full`
- `light`

These define the node's desired history retention strategy:

Current target strategies in code:

- `archive`: no pruning
- `full`: retain the most recent `10,000` blocks
- `light`: aggressive pruning, retain only the most recent `128` blocks

Important note: the current main node startup path only computes and logs the pruner configuration based on `nodeMode`. The `StoragePruner` itself is implemented and has test coverage, but there is no obvious startup wiring yet. More accurately:

- `nodeMode` defines the retention strategy target
- Actual automatic pruning depends on whether the pruner is wired into the main path in the future
- Even when fully wired, it still requires `storage.enablePruning = true`

Operational implications:

- Explorer, indexer, audit, and contract history analysis nodes should use `archive`
- If pruning is enabled or the pruner is manually wired in, do not use `light`/pruned `full` nodes for long-history contract queries

Related implementation:

- [`node/src/config.ts`](/home/bob/projects/ClawdBot/COC/node/src/config.ts)
- [`node/src/index.ts`](/home/bob/projects/ClawdBot/COC/node/src/index.ts)
- [`node/src/storage/pruner.ts`](/home/bob/projects/ClawdBot/COC/node/src/storage/pruner.ts)

### 5.6 Configuration Boundaries in Current Repository

The repository now converges the default COC `chainId` to `18780` across the core node, `config.example.json`, and `contracts/hardhat.config.cjs`.

This still does not mean deployments can skip verification. If you connect to an external devnet, historical testnet, or custom-configured network, you must use the value returned by the target node.

Therefore, before deploying any contract, you must first query the target node:

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

Then unify your deployment toolchain, wallet signer, EIP-712 `chainId`, and runtime config to this actual value.

## 6. Contract Deployment Methods

### 6.1 General Application Contract Deployment: Recommended via Hardhat / ethers

For standard Solidity contracts, the recommended approach is:

1. Compile contracts locally
2. Sign with an external private key
3. Submit raw transactions via COC RPC

Hardhat network configuration example:

```js
// hardhat.config.cjs
require("@nomicfoundation/hardhat-ethers")

module.exports = {
  solidity: "0.8.24",
  networks: {
    coc: {
      url: process.env.COC_RPC_URL || "http://127.0.0.1:18780",
      chainId: Number(process.env.COC_CHAIN_ID || "18780"),
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
}
```

Deployment script example:

```js
// scripts/deploy-my-contract.js
const { ethers } = require("hardhat")

async function main() {
  const Factory = await ethers.getContractFactory("MyContract")
  const contract = await Factory.deploy()
  await contract.waitForDeployment()
  console.log("address =", await contract.getAddress())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

Run:

```bash
export COC_RPC_URL="http://127.0.0.1:18780"
export COC_CHAIN_ID="18780"
export DEPLOYER_PRIVATE_KEY="0xyour_private_key"

npx hardhat run scripts/deploy-my-contract.js --network coc
```

### 6.2 Governance Contract Deployment: Existing Hardhat Script

Governance contracts have an existing deployment script:

- [`contracts/scripts/deploy-governance.js`](/home/bob/projects/ClawdBot/COC/contracts/scripts/deploy-governance.js)

Usage:

```bash
cd contracts
npm install
npx hardhat compile

export PROWL_RPC_URL="http://127.0.0.1:18780"
export PROWL_CHAIN_ID="18780"
export DEPLOYER_PRIVATE_KEY="0xyour_private_key"

npx hardhat run scripts/deploy-governance.js --network coc
```

`contracts/hardhat.config.cjs` keeps `prowl` as a legacy alias, but `coc` is the preferred network name for new usage.

This will deploy and wire up:

- `FactionRegistry`
- `GovernanceDAO`
- `Treasury`

### 6.3 PoSeManagerV2 Deployment: Formal CLI and Library Entrypoints

The current formal deployment entrypoints for PoSeManagerV2 are:

- [`contracts/deploy/cli-deploy-pose.ts`](/home/bob/projects/ClawdBot/COC/contracts/deploy/cli-deploy-pose.ts)
- [`contracts/deploy/deploy-pose.ts`](/home/bob/projects/ClawdBot/COC/contracts/deploy/deploy-pose.ts)

The library module provides:

- `resolveDeployParams(target)`
- `validateDeployParams(params)`
- `deployPoSeManagerV2(target, abi, bytecode, privateKey?)`

Supported target presets:

- `l1-mainnet`
- `l1-sepolia`
- `l2-coc`
- `l2-arbitrum`
- `l2-optimism`

Formal CLI usage:

```bash
cd contracts
npm install
npm run compile

export DEPLOYER_PRIVATE_KEY="0xyour_private_key"
export L2_RPC_URL="http://127.0.0.1:18780"

npm run deploy:pose:coc
```

You can also invoke the CLI directly:

```bash
node --experimental-strip-types deploy/cli-deploy-pose.ts \
  --target l2-coc \
  --artifact artifacts/contracts-src/settlement/PoSeManagerV2.sol/PoSeManagerV2.json \
  --json
```

Minimal library example:

```ts
import { readFile } from "node:fs/promises"
import { deployPoSeManagerV2 } from "../contracts/deploy/deploy-pose.ts"

const artifact = JSON.parse(
  await readFile(
    new URL(
      "../contracts/artifacts/contracts-src/settlement/PoSeManagerV2.sol/PoSeManagerV2.json",
      import.meta.url,
    ),
    "utf-8",
  ),
)

const result = await deployPoSeManagerV2(
  "l2-coc",
  artifact.abi,
  artifact.bytecode,
  process.env.DEPLOYER_PRIVATE_KEY,
)

console.log(result)
```

Run:

```bash
node --experimental-strip-types path/to/your-script.ts
```

### 6.4 PoSeManagerV2 Requires Post-Deployment Initialization

`PoSeManagerV2` is not immediately usable after deployment.

After deployment, you must call:

```solidity
initialize(uint256 chainId, address verifyingContract, uint256 challengeBondMin)
```

Initialization sets:

- EIP-712 `DOMAIN_SEPARATOR`
- `challengeBondMin`
- `verifyingContract`

If deploying to the COC chain itself, `verifyingContract` is typically the contract's own address.

Typical flow from tests:

1. `deploy()`
2. `initialize(chainId, contractAddress, challengeBondMin)`
3. `depositRewardPool(...)`
4. `registerNode(...)`
5. `initEpochNonce(epochId)`
6. `submitBatchV2(...)`
7. `openChallenge(...) / revealChallenge(...) / settleChallenge(...)`
8. `finalizeEpochV2(...)`
9. `claim(...)`

Related references:

- [`contracts/contracts-src/settlement/PoSeManagerV2.sol`](/home/bob/projects/ClawdBot/COC/contracts/contracts-src/settlement/PoSeManagerV2.sol)
- [`contracts/test/pose-v2-e2e.test.cjs`](/home/bob/projects/ClawdBot/COC/contracts/test/pose-v2-e2e.test.cjs)

### 6.5 Current Deployment Toolchain Boundaries

The repository's [`contracts/package.json`](/home/bob/projects/ClawdBot/COC/contracts/package.json) now converges PoSe deployment onto:

- `npm run deploy:pose`
- `npm run deploy:pose:coc`
- `npm run deploy:local` (compatibility alias that forwards to `deploy:pose:coc`)

Therefore the recommended approach is:

- General contracts: use standard Hardhat/ethers deployment scripts
- Governance contracts: use `scripts/deploy-governance.js`
- PoSeManagerV2: prefer `deploy/cli-deploy-pose.ts`; use the library functions from `contracts/deploy/deploy-pose.ts` only when embedding deployment into custom automation

`deploy:local` is still available, but it is now only a compatibility alias rather than a standalone script file.

## 7. Day-to-Day Usage

### 7.1 Query Chain Information

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

### 7.2 Query Contract Code

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0xYourContract","latest"]}'
```

### 7.3 Read Storage Slots

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getStorageAt","params":["0xYourContract","0x0","latest"]}'
```

### 7.4 Read-Only Contract Calls

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"eth_call",
    "params":[
      {
        "to":"0xYourContract",
        "data":"0x70a08231000000000000000000000000YourAddressWithout0x"
      },
      "latest"
    ]
  }'
```

### 7.5 Query Indexed Contracts

If the node has persistent block indexing enabled, you can use:

- `coc_getContracts`
- `coc_getContractInfo`

Example:

```bash
curl -s -X POST http://127.0.0.1:18780 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"coc_getContracts","params":[{"limit":20,"offset":0}]}'
```

### 7.6 Using the Wallet CLI to Fund Deployment Accounts

The wallet CLI is at [`wallet/coc-wallet.ts`](/home/bob/projects/ClawdBot/COC/wallet/coc-wallet.ts).

Common commands:

```bash
node --experimental-strip-types wallet/coc-wallet.ts create --password my-pass
```

```bash
node --experimental-strip-types wallet/coc-wallet.ts balance 0xYourAddress --rpc http://127.0.0.1:18780
```

```bash
node --experimental-strip-types wallet/coc-wallet.ts send 0xFrom 0xTo 1.0 --rpc http://127.0.0.1:18780 --password my-pass
```

## 8. Use Cases and Non-Use Cases

### 8.1 Suitable For

- Deploying standard Solidity business contracts on COC
- Using `ethers` / Hardhat for contract interaction; the repository now includes an `ethers`-level regression covering deployment, reads/writes, `eth_createAccessList`, and `debug_traceTransaction`
- Providing the on-chain execution layer for PoSe / governance / Explorer
- Local devnet / testnet / prototype validation
- Events, receipts, state persistence, and basic block header compatibility

### 8.2 Should Not Be Assumed

- Method-for-method equivalence with mainstream Ethereum clients
- Workflows relying on complete access list tracking
- Debuggers requiring Geth-level opcode trace precision
- Legacy toolchains relying on PoW, uncle, or compilation RPCs
- Long-history auditing/indexing on pruned `light` or pruned `full` nodes

## 9. Operational Recommendations

If your goal is "stable deployment and operation of application contracts", the recommended approach is:

1. Use an `archive` node as the deployment and query endpoint.
2. Verify the actual chain ID with `eth_chainId` before deployment — do not trust sample files.
3. Use external private key signing via `eth_sendRawTransaction`.
4. When you need debug traces, explicitly enable `COC_DEBUG_RPC=1`, and accept that traces are simplified.
5. When you need historical logs or Explorer capabilities, do not use `light` nodes.
6. When deploying PoSeManagerV2, treat "deploy" and "initialize" as two separate steps.

## 10. Source Code Entry Points

- EVM execution: [`node/src/evm.ts`](/home/bob/projects/ClawdBot/COC/node/src/evm.ts)
- RPC: [`node/src/rpc.ts`](/home/bob/projects/ClawdBot/COC/node/src/rpc.ts)
- WebSocket RPC: [`node/src/websocket-rpc.ts`](/home/bob/projects/ClawdBot/COC/node/src/websocket-rpc.ts)
- Persistent state: [`node/src/storage/persistent-state-manager.ts`](/home/bob/projects/ClawdBot/COC/node/src/storage/persistent-state-manager.ts)
- State trie: [`node/src/storage/state-trie.ts`](/home/bob/projects/ClawdBot/COC/node/src/storage/state-trie.ts)
- Block header views: [`node/src/block-header.ts`](/home/bob/projects/ClawdBot/COC/node/src/block-header.ts)
- PoSe v1/v2 contracts: [`contracts/contracts-src/settlement`](/home/bob/projects/ClawdBot/COC/contracts/contracts-src/settlement)
- Governance contracts: [`contracts/contracts-src/governance`](/home/bob/projects/ClawdBot/COC/contracts/contracts-src/governance)
- PoSe deployment helper: [`contracts/deploy/deploy-pose.ts`](/home/bob/projects/ClawdBot/COC/contracts/deploy/deploy-pose.ts)
- Governance deployment script: [`contracts/scripts/deploy-governance.js`](/home/bob/projects/ClawdBot/COC/contracts/scripts/deploy-governance.js)
- Runtime configuration: [`config.example.json`](/home/bob/projects/ClawdBot/COC/config.example.json)
- Explorer contract verification: [`explorer/src/lib/solc-verify.ts`](/home/bob/projects/ClawdBot/COC/explorer/src/lib/solc-verify.ts)
