# Phase 35: OpenClaw Node Installation, Configuration & Type Selection

## 1. Goal

Extend the `coc-nodeops` OpenClaw plugin to support:
- Node type presets (validator / fullnode / archive / gateway / dev)
- Interactive configuration wizard
- Multi-node instance management
- Network presets (testnet / mainnet / local / custom)

Users can run `openclaw coc init` to configure different COC node types with a single command.

---

## 2. Node Type Definitions

| Type | Consensus | Storage | Wire/DHT | SnapSync | Block Production | Services | Use Case |
|------|-----------|---------|----------|----------|------------------|----------|----------|
| **validator** | BFT | leveldb | yes | yes | yes | node + agent | Validator, participates in BFT |
| **fullnode** | - | leveldb | yes | yes | no | node | Syncs all blocks, provides RPC |
| **archive** | - | leveldb | yes | yes | no | node | Full history, pruning disabled |
| **gateway** | - | memory | no | no | no | node | Lightweight RPC proxy |
| **dev** | - | leveldb | no | no | yes (single) | node | Local development, test accounts |

---

## 3. CLI Commands

```bash
# Initialize (interactive / parametric)
openclaw coc init
openclaw coc init --type validator --network testnet --name val-1

# Node lifecycle
openclaw coc start [<name>]
openclaw coc stop [<name>]
openclaw coc restart [<name>]
openclaw coc status [<name>]

# Multi-node management
openclaw coc list
openclaw coc remove <name>

# Configuration & logs
openclaw coc config show [<name>]
openclaw coc config edit <name>
openclaw coc logs <name> [--follow]
```

---

## 4. Data Directory Structure

```
~/.clawdbot/coc/
├── nodes.json                     # Node registry
├── nodes/
│   ├── val-1/
│   │   ├── node-config.json       # Full COC node config
│   │   ├── node-key               # Node private key
│   │   ├── data/                  # LevelDB data
│   │   └── logs/
│   │       ├── node.log
│   │       └── agent.log
│   └── my-fullnode/
│       ├── node-config.json
│       └── ...
└── networks/
    ├── testnet.json               # Network preset
    └── local.json
```

---

## 5. Implementation

### 5.1 Node Type Presets (`src/node-types.ts`)
- `NodeType`: "validator" | "fullnode" | "archive" | "gateway" | "dev"
- `NodeTypePreset`: description, configOverrides, services list
- `NODE_TYPE_PRESETS`: maps each type to its preset
- Config overrides per type (enableBft, enableWireProtocol, storage backend, etc.)

### 5.2 Network Presets (`src/network-presets.ts`)
- `NetworkId`: "testnet" | "mainnet" | "local" | "custom"
- `NetworkPreset`: chainId, bootstrapPeers, dhtBootstrapPeers, port defaults
- Testnet: chainId=18780, public bootstrap peers
- Local: chainId=18780, localhost, auto ports

### 5.3 Interactive Wizard (`src/cli/init-wizard.ts`)
- Uses `@clack/prompts` for interactive prompts
- Steps: select type -> select network -> enter name -> enter RPC port -> (custom params)
- Generates `node-config.json`, `node-key`, registers to `nodes.json`
- Supports non-interactive mode via CLI flags

### 5.4 Node Manager (`src/runtime/node-manager.ts`)
- `NodeManager` class with persistent registry
- Registry operations: list, get, register, remove
- Lifecycle: start/stop/restart per node (delegates to `CocProcessManager`)
- Status: PID + live RPC queries (block height, peer count)
- Config: read/update node-config.json per instance

### 5.5 CLI Commands (`src/cli/commands.ts`)
- `coc init` -> interactive wizard or parse flags
- `coc list` -> table output of all nodes
- `coc start/stop/restart [name]` -> per-node or all
- `coc status [name]` -> with RPC stats
- `coc remove <name>` -> confirmation + delete
- `coc config show/edit` -> display or open $EDITOR
- `coc logs <name>` -> tail logs with --follow

### 5.6 Config Schema (`src/config-schema.ts`)
- Added `NodeEntrySchema` for registry entries
- Added `nodes` array field to `CocConfigSchema`

### 5.7 Plugin Entry (`index.ts`)
- Initializes `NodeManager` on CLI registration
- Passes NodeManager to command registration

---

## 6. Files

| Action | Path | Description |
|--------|------|-------------|
| **NEW** | `extensions/coc-nodeops/src/node-types.ts` | 5 node type presets |
| **NEW** | `extensions/coc-nodeops/src/network-presets.ts` | Network configuration presets |
| **NEW** | `extensions/coc-nodeops/src/cli/init-wizard.ts` | Interactive init wizard |
| **NEW** | `extensions/coc-nodeops/src/runtime/node-manager.ts` | Multi-node manager |
| **MOD** | `extensions/coc-nodeops/src/cli/commands.ts` | Extended CLI commands |
| **MOD** | `extensions/coc-nodeops/src/config-schema.ts` | Added nodes registry |
| **MOD** | `extensions/coc-nodeops/index.ts` | NodeManager initialization |
| **MOD** | `extensions/coc-nodeops/package.json` | Added @clack/prompts |

---

## 7. Tests (24 tests, 3 files)

| File | Tests | Coverage |
|------|-------|----------|
| `src/node-types.test.ts` | 7 | All 5 presets, config overrides, validation |
| `src/network-presets.test.ts` | 7 | All networks, labels, validation |
| `src/runtime/node-manager.test.ts` | 10 | Registry CRUD, persistence, lifecycle errors |

---

## 8. Verification

```bash
# 1. Interactive init
openclaw coc init
# -> Select dev -> local -> default name -> verify config generated

# 2. Parametric init
openclaw coc init --type fullnode --network testnet --name fn-1
# -> Verify enableWireProtocol:true, enableDht:true, validators:[]

# 3. Multi-node management
openclaw coc list                # Shows dev-1 + fn-1
openclaw coc start dev-1         # Start single node
openclaw coc status dev-1        # Shows running + block height
openclaw coc stop dev-1

# 4. Node type verification
openclaw coc init --type validator --network local --name val-1
# -> enableBft:true, validators non-empty, services includes agent

openclaw coc init --type gateway --network testnet --name gw-1
# -> storage.backend:"memory", enableBft:false

# 5. Remove
openclaw coc remove dev-1
openclaw coc list                # dev-1 gone

# 6. Run tests
cd extensions/coc-nodeops
node --experimental-strip-types --test src/node-types.test.ts src/network-presets.test.ts src/runtime/node-manager.test.ts
```
