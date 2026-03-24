# Silicon Immortality: Soul Registry & Agent Backup System

## Overview

The COC chain's **Silicon Immortality** feature provides AI Agents with blockchain-anchored identity registration, state backup, and social recovery. The core idea: an Agent's identity files (IDENTITY.md, SOUL.md), memories, and conversation history are stored on IPFS with optional encryption, and their integrity hash (Merkle Root) is anchored on-chain via EIP-712 signed transactions to the `SoulRegistry` contract — ensuring the Agent's "soul" is verifiable, recoverable, and tamper-proof.

The system comprises two core components:

| Component | Location | Responsibility |
|-----------|----------|----------------|
| **SoulRegistry Contract** | `contracts/contracts-src/governance/SoulRegistry.sol` | On-chain identity registration, backup anchoring, social recovery |
| **coc-backup Extension** | `extensions/coc-backup/` | Off-chain backup execution: file scanning, encryption, IPFS upload, on-chain anchoring, recovery |

---

## Architecture Overview

```
+---------------------+     +------------------+     +-------------------+
|   OpenClaw Agent    |     |   COC IPFS Node  |     |  COC Blockchain   |
|                     |     |                  |     |                   |
| dataDir/            |     | /api/v0/add      |     | SoulRegistry.sol  |
|  IDENTITY.md        | --> | /ipfs/{cid}      | --> |  registerSoul()   |
|  SOUL.md            |     | /api/v0/files/*  |     |  anchorBackup()   |
|  memory/*.md        |     +------------------+     |  updateIdentity() |
|  sessions/*.jsonl   |                              |  Social Recovery  |
+---------------------+                              +-------------------+
        |                                                     ^
        |              coc-backup extension                    |
        +-- scan --> diff detect --> encrypt --> IPFS upload --> EIP-712 sign --+
```

### Data Flow

**Backup Path:**
1. `change-detector` scans dataDir, classifies files by rules, computes SHA-256
2. Compares with previous manifest to identify added/modified/deleted/unchanged
3. `uploader` optionally encrypts (AES-256-GCM) new/modified files and uploads to IPFS
4. `manifest-builder` constructs Merkle tree (SHA-256 with domain separation), generates `SnapshotManifest`
5. `anchor` uploads manifest to IPFS, submits EIP-712 signed on-chain transaction via `SoulClient`

**Recovery Path:**
1. User provides the latest manifest's IPFS CID
2. `chain-resolver` recursively downloads all manifests along the `parentCid` chain (until full backup)
3. `integrity-checker` verifies each manifest's Merkle Root consistency
4. `downloader` applies manifests from oldest to newest, decrypting and writing files
5. `integrity-checker` performs SHA-256 verification on all final disk files

---

## SoulRegistry Contract

**File:** `contracts/contracts-src/governance/SoulRegistry.sol` (466 lines)

### Core Data Structures

#### SoulIdentity

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `bytes32` | `keccak256(Ed25519 public key)`, unique identity |
| `owner` | `address` | EOA controlling this soul |
| `identityCid` | `bytes32` | IPFS CID hash of IDENTITY.md + SOUL.md |
| `latestSnapshotCid` | `bytes32` | Latest backup manifest CID hash |
| `registeredAt` | `uint64` | Registration timestamp |
| `lastBackupAt` | `uint64` | Last backup timestamp |
| `backupCount` | `uint32` | Total backup count |
| `version` | `uint16` | Schema version (currently 1) |
| `active` | `bool` | Whether active |

#### BackupAnchor

| Field | Type | Description |
|-------|------|-------------|
| `manifestCid` | `bytes32` | Backup manifest CID hash |
| `dataMerkleRoot` | `bytes32` | Merkle Root of all backup files |
| `anchoredAt` | `uint64` | Anchor timestamp |
| `fileCount` | `uint32` | File count |
| `totalBytes` | `uint64` | Total bytes |
| `backupType` | `uint8` | `0` = full, `1` = incremental |
| `parentManifestCid` | `bytes32` | Parent CID for incremental (zero for full) |

### EIP-712 Signatures

The contract uses EIP-712 structured signatures for all write operations:

- **Domain:** `name="COCSoulRegistry"`, `version="1"`, `chainId=block.chainid`
- **Three operation type hashes:**
  - `RegisterSoul(bytes32 agentId, bytes32 identityCid, address owner, uint64 nonce)`
  - `AnchorBackup(bytes32 agentId, bytes32 manifestCid, bytes32 dataMerkleRoot, uint32 fileCount, uint64 totalBytes, uint8 backupType, bytes32 parentManifestCid, uint64 nonce)`
  - `UpdateIdentity(bytes32 agentId, bytes32 newIdentityCid, uint64 nonce)`
- **Nonce:** Per-agentId incrementing counter shared across all operation types

TypeScript EIP-712 type definitions at `node/src/crypto/soul-registry-types.ts`.

### Write Operations

| Function | Description | Access Control |
|----------|-------------|----------------|
| `registerSoul(agentId, identityCid, sig)` | Register new soul identity | msg.sender = owner, EIP-712 sig |
| `anchorBackup(agentId, manifestCid, dataMerkleRoot, fileCount, totalBytes, backupType, parentManifestCid, sig)` | Anchor a backup | owner + EIP-712 |
| `updateIdentity(agentId, newIdentityCid, sig)` | Update identity CID | owner + EIP-712 |
| `addGuardian(agentId, guardian)` | Add recovery guardian | owner only |
| `removeGuardian(agentId, guardian)` | Remove guardian (soft delete) | owner only |
| `initiateRecovery(agentId, newOwner)` | Initiate social recovery | active guardian |
| `approveRecovery(requestId)` | Approve recovery request | active guardian |
| `completeRecovery(requestId)` | Execute recovery transfer | anyone (if conditions met) |

### View Functions

| Function | Returns |
|----------|---------|
| `getSoul(agentId)` | Full SoulIdentity |
| `getLatestBackup(agentId)` | Latest BackupAnchor |
| `getBackupHistory(agentId, offset, limit)` | Paginated backup history |
| `getBackupCount(agentId)` | Total backup count |
| `getGuardians(agentId)` | Guardian list |
| `getActiveGuardianCount(agentId)` | Active guardian count |

### Social Recovery

When an Agent's owner private key is lost, guardians can recover ownership:

1. **Guardian Management:** Max 7 active guardians per agentId (`MAX_GUARDIANS=7`), cannot self-guard
2. **Initiate Recovery:** Any active guardian calls `initiateRecovery(agentId, newOwner)`, initiator auto-counts as 1 approval
3. **Approval Threshold:** Requires `ceil(2/3 * activeGuardianCount)` guardian approvals
4. **Time Lock:** After meeting threshold, must wait `RECOVERY_DELAY = 1 day`
5. **Execute Transfer:** Once both conditions met, anyone can call `completeRecovery()` — owner pointer transfers, identity data fully preserved

### Events

| Event | Trigger |
|-------|---------|
| `SoulRegistered(agentId, owner, identityCid)` | Registration success |
| `BackupAnchored(agentId, manifestCid, dataMerkleRoot, backupType)` | Backup anchored |
| `IdentityUpdated(agentId, newIdentityCid)` | Identity updated |
| `GuardianAdded(agentId, guardian)` | Guardian added |
| `GuardianRemoved(agentId, guardian)` | Guardian removed |
| `RecoveryInitiated(requestId, agentId, newOwner)` | Recovery initiated |
| `RecoveryApproved(requestId, guardian)` | Recovery approved |
| `RecoveryCompleted(requestId, agentId, newOwner)` | Recovery completed |

### Constraints & Security

- **One-to-one binding:** `ownerToAgent` mapping ensures one EOA can only own one agentId
- **Signature verification:** Assembly-level `ecrecover`, strict sig length 65, v value 27/28, non-zero recovery
- **CID storage:** On-chain stores `keccak256(cidString)` rather than raw CID (gas savings, but irreversible)

### Deployment

Deploy script at `contracts/deploy/deploy-soul-registry.ts`:

| Target | chainId | Confirmations | Gas Strategy |
|--------|---------|---------------|--------------|
| `l2-coc` | 18780 | 1 | legacy |
| `l1-sepolia` | 11155111 | 3 | EIP-1559 (30/2 gwei) |
| `l1-mainnet` | 1 | 5 | EIP-1559 (50/2 gwei) |

### Tests

`contracts/test/SoulRegistry.test.cjs` contains 24 test scenarios:
- Registration: valid registration, zero agentId, duplicate agentId, duplicate owner, forged signature
- Backup: full backup, incremental chain, missing parentCid, non-owner, paginated query
- Identity update: valid update, non-owner
- Guardians: add/remove flow, self-guard, duplicate add, non-owner
- Social recovery: full flow (3 guardians + 2/3 approval + time lock), insufficient votes, time lock not expired, non-guardian, duplicate approval
- Edge cases: unregistered queries, empty history, cross-operation nonce increment

---

## coc-backup Extension

**Location:** `extensions/coc-backup/` (OpenClaw plugin)

### Module Architecture

```
extensions/coc-backup/
  index.ts                      # Plugin entry, registers CLI/Tool/Hook
  openclaw.plugin.json          # Plugin manifest
  src/
    types.ts                    # Core type definitions
    config-schema.ts            # Zod config schema
    crypto.ts                   # AES-256-GCM encryption/decryption
    ipfs-client.ts              # IPFS HTTP API client
    soul-client.ts              # SoulRegistry contract client
    cli/
      commands.ts               # 5 CLI commands
    backup/
      change-detector.ts        # File classification & diff detection
      uploader.ts               # Encrypt & upload to IPFS
      manifest-builder.ts       # Merkle tree & manifest building
      anchor.ts                 # IPFS + on-chain anchoring
      scheduler.ts              # Automatic backup scheduler
    recovery/
      chain-resolver.ts         # Incremental chain resolution
      downloader.ts             # IPFS download & decryption
      integrity-checker.ts      # Three-layer integrity verification
      state-restorer.ts         # Recovery pipeline orchestration
```

### Configuration

Validated via Zod Schema (`src/config-schema.ts`):

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch |
| `rpcUrl` | string | `http://127.0.0.1:18780` | COC RPC URL |
| `ipfsUrl` | string | `http://127.0.0.1:18790` | IPFS API URL |
| `contractAddress` | string | required | SoulRegistry contract address |
| `privateKey` | string | required | Ethereum private key |
| `dataDir` | string | `~/.openclaw` | Backup data root directory |
| `autoBackupEnabled` | boolean | `true` | Scheduled backup switch |
| `autoBackupIntervalMs` | number | `3600000` | Backup interval (default 1 hour) |
| `encryptMemory` | boolean | `false` | Encrypt memory files |
| `encryptionPassword` | string? | optional | Password (overrides key derivation) |
| `maxIncrementalChain` | number | `10` | Max incremental chain length |
| `backupOnSessionEnd` | boolean | `true` | Backup on session end |
| `categories.*` | boolean | all `true` | Per-category enable switches |

### CLI Commands

All commands under the `coc-backup` subcommand group:

#### `coc-backup register`
Register the Agent's on-chain soul identity.
```bash
coc-backup register [--agent-id <bytes32>] [--identity-cid <cid>]
```

#### `coc-backup backup`
Execute a backup.
```bash
coc-backup backup [--full]
```

#### `coc-backup restore`
Restore Agent state from a manifest CID.
```bash
coc-backup restore --manifest-cid <cid> [--target-dir <dir>] [--password <pwd>]
```

#### `coc-backup status`
Query on-chain registration and IPFS reachability.
```bash
coc-backup status [--json]
```

#### `coc-backup history`
Query on-chain backup history.
```bash
coc-backup history [--limit <n>] [--json]
```

### Agent Tools

Three tools registered via `api.registerTool()` for programmatic AI Agent invocation:

| Tool | Parameters | Returns |
|------|-----------|---------|
| `soul-backup` | `full?: boolean` | `{ manifestCid, fileCount, totalBytes, backupType, txHash }` |
| `soul-restore` | `manifestCid, targetDir?` | `{ filesRestored, totalBytes, backupsApplied, merkleVerified }` |
| `soul-status` | none | On-chain status + IPFS reachability |

### Encryption

**Algorithm:** AES-256-GCM (`src/crypto.ts`)

**Key Derivation:**
- From private key: `SHA-256(privateKeyHex) -> scrypt(seed, salt, N=16384, r=8, p=1) -> 32-byte key`
- From password: `scrypt(password, salt, N=16384, r=8, p=1) -> 32-byte key`

**Ciphertext Format:** `[salt:32B][iv:12B][auth_tag:16B][ciphertext:NB]`

**Encryption Policy:**
- `identity/device.json` and `auth.json` are always encrypted
- `memory/*.md` encrypted when `encryptMemory=true`
- `IDENTITY.md`, `SOUL.md` are not encrypted (public identity info)

### File Classification Rules

Defined in `change-detector.ts` (priority-ordered matching):

| File Pattern | Category | Default Encrypted |
|-------------|----------|-------------------|
| `IDENTITY.md` | identity | no |
| `SOUL.md` | identity | no |
| `identity/device.json` | config | yes |
| `auth.json` | config | yes |
| `MEMORY.md` | memory | optional |
| `memory/*.md` | memory | optional |
| `USER.md` | memory | optional |
| `agents/*/sessions/*.jsonl` | chat | no |
| `workspace-state.json` | workspace | no |
| `AGENTS.md` | workspace | no |

### Merkle Tree Implementation

`manifest-builder.ts` implements the same algorithm as `node/src/ipfs-merkle.ts`:

- **Leaf hash:** `SHA-256(0x00 || leafData)` — `0x00` prefix prevents leaf/internal node collision
- **Internal hash:** `SHA-256(0x01 || left || right)` — `0x01` prefix for domain separation
- **Leaf data:** `UTF-8("path:cid:hash")`, sorted lexicographically by path for determinism
- **Odd count handling:** Last odd leaf paired with itself

### Incremental Backup

- **Full backup (backupType=0):** Includes all files, `parentCid=null`
- **Incremental backup (backupType=1):** Only uploads changed files; unchanged files get CID references from previous manifest via `carryOverEntries()`
- **Forced full triggers:** `forceFullBackup=true`, first backup, incremental chain reaches `maxIncrementalChain` (default 10)
- **Manifest completeness:** Each incremental manifest's `files` field contains **all** files (including carry-overs), making any single manifest a complete state snapshot

### Recovery Pipeline

`restoreFromManifestCid()` in `state-restorer.ts` implements a 4-step recovery pipeline:

1. **Chain resolution:** From target CID, recursively download all manifests along `parentCid`, assemble ordered chain (old → new)
2. **Merkle verification:** Recompute each manifest's Merkle Root and compare with stored value
3. **Download & apply:** Apply manifests from oldest to newest; later writes overwrite earlier (correct delete semantics)
4. **Disk verification:** Compute SHA-256 for all final files and compare with manifest hashes

### Three-Layer Integrity Model

| Layer | Function | Verification |
|-------|----------|-------------|
| Manifest self-consistency | `verifyManifestMerkleRoot()` | Recompute Merkle Root, compare with manifest value |
| Disk files | `verifyRestoredFiles()` | Read each file, compute SHA-256, compare with manifest hash |
| On-chain anchor | `verifyOnChainAnchor()` | Compare manifest Merkle Root with on-chain stored value |

---

## Known Limitations

1. **Irreversible CID:** On-chain stores `keccak256(cidString)` not raw CID — cannot recover from chain alone (user must save manifest CID or find via MFS)
2. **`restoreFromChain` incomplete:** Due to irreversible CID hashing, auto-locating IPFS content from chain data requires a CID registry
3. **Scheduler state not persisted:** `lastManifest` and `incrementalCount` are memory-only; process restart forces full backup
4. **Sequential file upload:** No concurrent upload for large file sets
5. **Guardian soft delete:** On-chain `_guardians` array only grows (soft delete via `active=false`), but bounded by `MAX_GUARDIANS=7`

---

## File Inventory

### Smart Contracts
- `contracts/contracts-src/governance/SoulRegistry.sol` — Main contract (466 lines)
- `contracts/deploy/deploy-soul-registry.ts` — Deploy script (96 lines)
- `contracts/test/SoulRegistry.test.cjs` — Test suite (647 lines, 24 scenarios)

### EIP-712 Types
- `node/src/crypto/soul-registry-types.ts` — TypeScript signature types (46 lines)

### coc-backup Extension
- `extensions/coc-backup/index.ts` — Plugin entry (141 lines)
- `extensions/coc-backup/openclaw.plugin.json` — Plugin manifest
- `extensions/coc-backup/package.json` — Dependencies
- `extensions/coc-backup/src/types.ts` — Core types (78 lines)
- `extensions/coc-backup/src/config-schema.ts` — Config schema (25 lines)
- `extensions/coc-backup/src/crypto.ts` — Encryption module (81 lines)
- `extensions/coc-backup/src/ipfs-client.ts` — IPFS client (94 lines)
- `extensions/coc-backup/src/soul-client.ts` — Contract client (207 lines)
- `extensions/coc-backup/src/cli/commands.ts` — CLI commands (223 lines)
- `extensions/coc-backup/src/backup/anchor.ts` — Anchoring logic (67 lines)
- `extensions/coc-backup/src/backup/change-detector.ts` — Change detection (140 lines)
- `extensions/coc-backup/src/backup/manifest-builder.ts` — Manifest building (99 lines)
- `extensions/coc-backup/src/backup/scheduler.ts` — Scheduler (154 lines)
- `extensions/coc-backup/src/backup/uploader.ts` — Uploader (73 lines)
- `extensions/coc-backup/src/recovery/chain-resolver.ts` — Chain resolution (123 lines)
- `extensions/coc-backup/src/recovery/downloader.ts` — Downloader (95 lines)
- `extensions/coc-backup/src/recovery/integrity-checker.ts` — Integrity verification (86 lines)
- `extensions/coc-backup/src/recovery/state-restorer.ts` — Recovery orchestration (125 lines)

**Total:** 22 files, 3,109 lines of new code
