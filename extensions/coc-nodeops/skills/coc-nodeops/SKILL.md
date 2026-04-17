---
name: coc-nodeops
description: Manage COC blockchain nodes -- initialize, start, stop, query status, and retrieve chain data via RPC. Use when the user asks about COC node setup, node operations, blockchain status, block heights, peer counts, or chain statistics.
allowed-tools: ["coc-node-init", "coc-node-list", "coc-node-start", "coc-node-stop", "coc-node-restart", "coc-node-status", "coc-node-remove", "coc-node-config", "coc-node-logs", "coc-rpc-query"]
---

# COC Node Operations

## When to use

- Setting up a new COC blockchain node
- Starting, stopping, or restarting nodes
- Checking node status (block height, peers, BFT)
- Querying on-chain data (chain stats, blocks, transactions, balances)
- Viewing node logs for debugging
- Managing node configuration

## Available tools

| Tool | Purpose |
|------|---------|
| `coc-node-init` | Initialize a new node (type + network) |
| `coc-node-list` | List all managed nodes |
| `coc-node-start` | Start a node or all nodes |
| `coc-node-stop` | Stop a node or all nodes |
| `coc-node-restart` | Restart a node or all nodes |
| `coc-node-status` | Live status with RPC stats |
| `coc-node-remove` | Remove a node instance |
| `coc-node-config` | View or patch node config |
| `coc-node-logs` | Read recent service logs |
| `coc-rpc-query` | Query chain via JSON-RPC |

## Common workflows

### First-time single node setup

1. `coc-node-init` with type=`dev`, network=`local`
2. `coc-node-start` with the returned node name
3. Wait ~10 seconds for the node to begin producing blocks
4. `coc-node-status` to verify blockHeight is incrementing

### Check chain health

1. `coc-node-status` to see running state, block height, peer count
2. `coc-rpc-query` with method=`coc_chainStats` for detailed chain statistics
3. `coc-rpc-query` with method=`coc_getBftStatus` for BFT consensus info

### Query blockchain data

- Block number: `coc-rpc-query` method=`eth_blockNumber`
- Block details: `coc-rpc-query` method=`eth_getBlockByNumber` params=`["latest", true]`
- Account balance: `coc-rpc-query` method=`eth_getBalance` params=`["0xADDRESS", "latest"]`
- Transaction: `coc-rpc-query` method=`eth_getTransactionByHash` params=`["0xHASH"]`

### Troubleshoot a node

1. `coc-node-status` to check running/stopped state
2. `coc-node-logs` with service=`node` to review recent output
3. `coc-node-restart` if needed
4. `coc-node-config` to inspect or fix configuration

## Node types

- `dev` -- Single-node development mode, auto-generates keys
- `validator` -- Full validator with consensus participation
- `fullnode` -- Non-validating full node
- `archive` -- Archive node (retains all historical state)
- `gateway` -- RPC gateway node (no consensus)

## Networks

- `local` -- Standalone localhost node
- `testnet` -- Public COC test network
- `mainnet` -- Production network (not yet launched)
- `custom` -- Manually specified parameters

## RPC methods reference

| Method | Returns |
|--------|---------|
| `eth_blockNumber` | Current block height (hex) |
| `eth_getBlockByNumber` | Block details by number |
| `eth_getBlockByHash` | Block details by hash |
| `net_peerCount` | Connected peer count (hex) |
| `coc_chainStats` | Chain statistics (blocks, txs, validators) |
| `coc_getBftStatus` | BFT consensus status and round info |
| `eth_getBalance` | Account balance in wei (hex) |
| `eth_syncing` | Sync progress or false |
| `eth_getTransactionByHash` | Transaction details |
| `eth_getTransactionReceipt` | Transaction receipt with logs |
