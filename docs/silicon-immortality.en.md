# AI Silicon Immortality: AI Agent Real-Time Backup and Resurrection System

## Overview

AI Silicon Immortality is COC's infrastructure for ensuring AI agents survive host failures, recover from crashes, and persist their cognitive state across restarts. It combines on-chain identity anchoring, encrypted IPFS backup, incremental state snapshots, and cross-node automated resurrection into a unified system.

**Core guarantee:** An AI agent's identity, memory, conversation history, and configuration are continuously backed up to IPFS with on-chain integrity anchoring. If the host fails, the latest state can be restored from IPFS and chain state; if a valid resurrection request reaches a carrier node, that carrier can automatically restore the agent, start it, complete the on-chain resurrection, and resume heartbeat proofs.

### Design Principles

- **Chain for authorization, IPFS for data.** The blockchain stores identity, backup hashes, guardian lists, and resurrection requests. IPFS stores the actual backup content. This separates trust (chain) from storage (IPFS).
- **Multi-process role separation.** Owner, guardian, and carrier run as independent processes with distinct EOAs. The contract enforces roles via `msg.sender` checks. No single key controls the entire lifecycle.
- **Incremental by default.** Only changed files are uploaded. Unchanged files carry over CID references from the previous manifest. Any single manifest is a complete state snapshot.
- **Three-layer integrity.** Every backup is verified at three levels: manifest self-consistency (Merkle root), disk file hashes (SHA-256), and on-chain anchor (Merkle root matches chain).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        On-Chain Layer                           │
│  SoulRegistry.sol: identity, backup anchors, guardians,        │
│                    resurrection config, carrier registry        │
│  CidRegistry.sol:  bytes32 → IPFS CID mapping                  │
│  DIDRegistry.sol:  optional identity enrichment                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ EIP-712 signed transactions
┌──────────────────────────┴──────────────────────────────────────┐
│                     coc-backup Extension                        │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Backup     │  │  Recovery    │  │  Carrier Daemon        │ │
│  │  Pipeline   │  │  Pipeline    │  │                        │ │
│  │             │  │              │  │  OfflineMonitor        │ │
│  │ detect →    │  │ resolve →    │  │  ResurrectionFlow      │ │
│  │ snapshot →  │  │ download →   │  │  AgentSpawner          │ │
│  │ encrypt →   │  │ decrypt →    │  │  AbortController       │ │
│  │ upload →    │  │ verify →     │  │  shutdown              │ │
│  │ anchor →    │  │ restore      │  │                        │ │
│  │ register    │  │              │  │  waitForReadiness()    │ │
│  │ CID         │  │              │  │  → polls canComplete   │ │
│  └─────────────┘  └──────────────┘  └────────────────────────┘ │
│                                                                 │
│  9 Agent Tools  │  Guardian CLI  │  Carrier CLI  │  Scheduler  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP API
┌──────────────────────────┴──────────────────────────────────────┐
│                     IPFS Storage Layer                          │
│  Content-addressed blocks, MFS organization, CID maps          │
└─────────────────────────────────────────────────────────────────┘
```

---

## What Gets Backed Up

### File Categories

| Category | File Patterns | Encrypted | Content |
|----------|--------------|-----------|---------|
| identity | `IDENTITY.md`, `SOUL.md` | No | Agent identity metadata |
| config | `auth.json`, `identity/device.json`, `openclaw.json`, `credentials/*` | Yes (AES-256-GCM) | Sensitive configuration |
| memory | `MEMORY.md`, `memory/*.md`, `USER.md` | Optional (`encryptMemory`) | Long-term + short-term memory |
| chat | `agents/*/sessions/*.jsonl`, `agents/*/sessions/sessions.json` | No | Conversation history |
| workspace | `workspace-state.json`, `AGENTS.md`, `.coc-backup/context-snapshot.json` | No | Workspace metadata |
| database | `memory/*.sqlite`, `memory/lancedb/*` | Yes | Vector indices, embeddings |

### Binary Database Handling

SQLite and LanceDB files may be actively written during backup. `binary-handler.ts` ensures consistency:

- **SQLite:** Uses `sqlite3 .backup` for an atomic copy. Falls back to file copy with WAL/SHM.
- **LanceDB directories:** Creates a simple archive (JSON index + concatenated file content) via `buildSimpleTar()`. Extractable via `extractSimpleTar()`.
- **Cleanup:** Temporary snapshot files are automatically removed after IPFS upload.

### Execution Context Snapshots

Before each backup cycle, `context-snapshot.ts` captures metadata about active sessions:

```json
{
  "version": 1,
  "capturedAt": "2026-04-05T12:00:00Z",
  "activeSessions": [{
    "sessionId": "abc-123",
    "messageCount": 42,
    "lastMessageAt": "2026-04-05T11:59:30Z",
    "estimatedTokens": 15000,
    "sizeBytes": 65536
  }]
}
```

This enables post-recovery context reconstruction: the agent knows its last conversational position.

---

## Real-Time Backup Pipeline

### Trigger Points

| Trigger | When | Purpose |
|---------|------|---------|
| Scheduler timer | Every `autoBackupIntervalMs` (default 1 hour) | Periodic protection |
| `session_end` hook | OpenClaw session ends | Capture session-final state |
| `before_compaction` hook | Context compaction imminent | Critical: saves full context before token pruning |
| `gateway_stop` hook | Graceful shutdown | Final state persistence |
| Manual `soul-backup` tool | On demand | User-initiated |

### Pipeline Steps

```
1. captureContextSnapshot(baseDir)     — Write session metadata
2. detectChanges(baseDir, config, prev) — Classify files, SHA-256 diff
3. snapshotBinaryFile()                 — Consistent copy for SQLite/LanceDB
4. uploadFiles(changed, ipfs)           — Encrypt + upload to IPFS
5. carryOverEntries(unchanged, prev)    — Reuse CIDs for unchanged files
6. buildManifest(agentId, entries)       — Compute Merkle root
7. anchorBackup(manifest, ipfs, soul)   — Upload manifest, anchor on-chain
8. cidResolver.register(hash, cid)      — Register in local + MFS + on-chain
9. heartbeat(agentId)                   — Prove agent is alive
```

### Incremental Strategy

- **Full backup (type=0):** All files, `parentCid=null`. Triggered on first backup, forced after `maxIncrementalChain` incrementals (default 10), or when `--full` flag is passed.
- **Incremental backup (type=1):** Only changed files uploaded. Unchanged files carry CID references from previous manifest. Each manifest's `files` field is complete (contains all files), making any single manifest a self-contained state snapshot.
- **Backoff on failure:** Exponential backoff up to 1 hour after 3+ consecutive failures.

### Encryption

- **Algorithm:** AES-256-GCM with scrypt KDF (password mode) or raw key derivation
- **Format:** `[salt:32B][iv:12B][auth_tag:16B][ciphertext:NB]`
- **Scope:** Per-file encryption. Each file gets a unique salt and IV.

---

## CID Registry: On-Chain to IPFS Resolution

On-chain, backup CIDs are stored as `keccak256(CID)` — a one-way hash. The CID resolver provides three-layer fallback to reverse this:

| Layer | Source | Speed | Persistence |
|-------|--------|-------|-------------|
| 1. Local index | `.coc-backup/cid-index.json` | <1ms | Survives restarts |
| 2. MFS | `/soul-backups/{agentId}/cid-map.json` | 50-200ms | Decentralized (any IPFS node with data) |
| 3. On-chain | `CidRegistry.resolveCid(bytes32)` | 200-500ms | Permanent (blockchain) |

**CidRegistry.sol:** Permissionless companion contract. Anyone who knows a CID can register `keccak256(CID) → CID` (hash preimage proves knowledge). Entries are immutable once written. Supports batch registration.

**Auto-registration:** After every `anchorBackup()`, the CID mapping is written to all three layers automatically.

**Recovery:** `restoreFromChain(agentId)` queries the latest backup hash on-chain, resolves it through the three layers, and delegates to `restoreFromManifestCid()`.

---

## Recovery Pipeline

### From Known CID (`restoreFromManifestCid`)

```
1. Chain resolution:  Follow parentCid links → build ordered chain [full, incr1, incr2, ...]
2. Merkle verification: Recompute each manifest's Merkle root, compare with stored value
3. On-chain verification: Compare latest manifest's Merkle root with on-chain anchor
4. Download & decrypt:  Apply manifests oldest-to-newest; later writes overwrite earlier
5. Disk verification:   SHA-256 each restored file vs manifest hash
```

### From AgentId (`restoreFromChain`)

```
1. Query SoulRegistry.getLatestBackup(agentId) → bytes32 manifestCidHash
2. CidResolver.resolve(manifestCidHash) → IPFS CID string
3. Verify: keccak256(resolvedCid) === manifestCidHash
4. Delegate to restoreFromManifestCid(resolvedCid, ...)
```

### Automated Recovery (`autoRestore`)

The `orchestrator.ts` wraps the full flow: discover → resolve → download → verify → write restore marker → notify agent. Available as the `soul-auto-restore` agent tool.

---

## Resurrection: Cross-Node Recovery

### Role Model

The contract enforces strict role separation via `msg.sender`:

| Role | Key | Responsibilities |
|------|-----|-----------------|
| **Owner** | Owner EOA | Register soul, backup, heartbeat, owner-key resurrection, manage guardians |
| **Guardian** (×N) | Guardian EOA | Initiate guardian resurrection, approve resurrection |
| **Carrier** | Carrier owner EOA | Confirm carrier, restore backup, spawn agent, complete resurrection |

These are separate processes with separate private keys. A carrier cannot initiate or approve resurrections. A guardian cannot confirm carrier hosting.

### Owner-Key Path (Self-Hosted Recovery)

When the owner still has their key but the host failed:

```
Owner: configureResurrection(keyHash, maxOfflineDuration)
Owner: heartbeat() — periodic, automated by scheduler
[Host fails, heartbeat stops]
Owner: initiateResurrection(agentId, carrierId, resurrectionKeySig)
Carrier daemon: confirmCarrier(requestId)
[No quorum or timelock needed]
Carrier daemon: restore → spawn → completeResurrection() → heartbeat()
```

### Guardian-Vote Path (Owner Unavailable)

When the owner is unavailable and guardians must act:

```
[Agent offline > maxOfflineDuration, isOffline() returns true]
Guardian 1: initiateGuardianResurrection(agentId, carrierId)
Guardian 2: approveResurrection(requestId)
[Wait for 2/3 guardian quorum + 12-hour timelock]
Carrier daemon: confirmCarrier(requestId)
Carrier daemon: waitForReadiness() — polls until canComplete=true
Carrier daemon: restore → spawn → health check → completeResurrection() → heartbeat()
```

### Carrier Daemon State Machine

```
idle → monitoring → resurrection_initiated → carrier_confirmed
  → waiting_readiness → downloading_backup → restoring_state
  → spawning_agent → health_checking → resurrection_complete
```

**Shutdown behavior:** `AbortController` propagates through every stage. `waitForReadiness()` and `waitForHealthy()` use interruptible sleeps. Each step checks `shutdownSignal.aborted` before proceeding. On shutdown during health check, the error is correctly classified as "daemon shutting down" (not "health check failed") and the spawned process is stopped.

**Request acceptance:** `addRequest()` returns `AddRequestResult`:
- `{ accepted: true }` — request queued for processing
- `{ accepted: false, reason: "not_running" | "already_processing" | "concurrency_limit" }` — explicit rejection with reason

**Graceful stop:** `daemon.stop()` is async. It aborts the AbortController, stops the OfflineMonitor, waits up to 30 seconds for active resurrections to drain, then cleans up the timeout timer.

---

## Social Recovery

If the agent's owner loses their private key, guardians can transfer ownership:

```
Guardian: initiateRecovery(agentId, newOwner)
[Freeze guardian snapshot count at initiation]
Guardian 2: approveRecovery(requestId)
[Wait for 2/3 of guardianSnapshot approvals + 1-day timelock]
Anyone: completeRecovery(requestId)
Owner: cancelRecovery(requestId) — owner can abort at any time
```

- Up to 7 guardians per soul
- Guardian snapshot prevents threshold manipulation during recovery
- Owner can cancel any pending recovery

---

## Configuration

### Backup Mode (Owner Node)

```json
{
  "enabled": true,
  "rpcUrl": "http://127.0.0.1:18780",
  "ipfsUrl": "http://127.0.0.1:18790",
  "contractAddress": "0x...",
  "privateKey": "0x...",
  "dataDir": "~/.openclaw",
  "autoBackupEnabled": true,
  "autoBackupIntervalMs": 3600000,
  "encryptMemory": false,
  "maxIncrementalChain": 10,
  "backupOnSessionEnd": true,
  "carrier": { "enabled": false },
  "categories": {
    "identity": true, "config": true, "memory": true,
    "chat": true, "workspace": true, "database": true
  }
}
```

### Carrier Mode (Carrier Node)

```json
{
  "enabled": true,
  "privateKey": "0xCarrierOwnerKey",
  "autoBackupEnabled": false,
  "carrier": {
    "enabled": true,
    "carrierId": "0x...",
    "agentEntryScript": "/path/to/openclaw/entry.js",
    "workDir": "/data/coc-resurrections",
    "watchedAgents": ["0xAgentId1", "0xAgentId2"],
    "pendingRequestIds": [
      { "requestId": "0x...", "agentId": "0x..." }
    ],
    "pollIntervalMs": 60000,
    "readinessTimeoutMs": 86400000,
    "readinessPollMs": 30000
  }
}
```

### Guardian Mode (Guardian Node)

```json
{
  "enabled": true,
  "privateKey": "0xGuardianKey",
  "autoBackupEnabled": false,
  "carrier": { "enabled": false }
}
```

---

## Agent Tools

| Tool | Parameters | Returns | Role |
|------|-----------|---------|------|
| `soul-backup` | `full?: boolean` | `BackupReceipt` | Owner |
| `soul-restore` | `manifestCid?, packagePath?, targetDir?, password?` | `RecoveryResult` | Owner |
| `soul-status` | — | Registration + IPFS status | Any |
| `soul-doctor` | — | Full `DoctorReport` | Any |
| `soul-resurrection` | `action, requestId?, carrierId?, resurrectionKey?` | Resurrection management | Owner |
| `soul-auto-restore` | `agentId?, targetDir?, password?` | Automated on-chain recovery | Owner |
| `soul-guardian-initiate` | `agentId, carrierId` | `{ requestId, txHash }` | Guardian |
| `soul-guardian-approve` | `requestId` | `{ txHash }` | Guardian |
| `soul-carrier-request` | `requestId, agentId` | Submit to carrier daemon | Carrier |

## CLI Commands

### Backup & Recovery (Owner)
```bash
coc-backup init [--agent-id] [--identity-cid] [--key-hash] [--max-offline]
coc-backup backup [--full]
coc-backup restore --manifest-cid <cid> [--target-dir <dir>] [--password <pwd>]
coc-backup status [--json]
coc-backup doctor [--json]
coc-backup history [--limit <n>] [--json]
```

### Resurrection (Owner)
```bash
coc-backup configure-resurrection --key-hash <hash> [--max-offline <sec>]
coc-backup heartbeat
coc-backup resurrect --carrier-id <id> --resurrection-key <key>
coc-backup resurrection start|status|confirm|complete|cancel
```

### Guardian Operations
```bash
coc-backup guardian initiate --agent-id <id> --carrier-id <id>
coc-backup guardian approve --request-id <id>
coc-backup guardian status --request-id <id>
```

### Carrier Management
```bash
coc-backup carrier register --carrier-id <id> --endpoint <url>
coc-backup carrier submit-request --request-id <id> --agent-id <id>
```

---

## Integrity Model

| Layer | Function | Verification |
|-------|----------|-------------|
| Manifest | `verifyManifestMerkleRoot()` | Recompute Merkle root from file entries, compare with stored value |
| Disk | `verifyRestoredFiles()` | SHA-256 each restored file, compare with manifest hash |
| On-chain | `verifyOnChainAnchor()` | Manifest Merkle root vs on-chain `dataMerkleRoot` |

**Merkle tree construction:**
- Leaf: `SHA-256(0x00 || lengthPrefixed(path, cid, hash))`
- Internal: `SHA-256(0x01 || left || right)`
- Deterministic: paths sorted lexicographically
- Odd leaf: paired with itself

---

## Test Coverage

**47 extension tests** across 9 files:

| File | Tests | Coverage |
|------|-------|---------|
| `binary-handler.test.ts` | 6 | SQLite snapshot, LanceDB tar, round-trip, cleanup |
| `change-detector-extended.test.ts` | 9 | All 7 new file patterns, category toggle, backward compat |
| `cid-resolver.test.ts` | 6 | Register/resolve, local index persistence, MFS fallback, on-chain fallback, null |
| `lifecycle.test.ts` | 3 | Init flow, doctor report, restore plan resolution |
| `state-restorer.test.ts` | 2 | Manifest CID restore, chain verification |
| `scheduler.test.ts` | 1 | State persistence across restart |
| `carrier-daemon.test.ts` | 7 | Config schema, start/stop, addRequest acceptance/rejection, concurrency, stop+drain |
| `resurrection-flow.test.ts` | 9 | Offline check, confirm rejection, readiness timeout, full success path, health failure, shutdown abort (3 scenarios) |
| `offline-monitor.test.ts` | 4 | Offline detection, online recovery, add/remove watch, error resilience |

**58 contract tests** in `SoulRegistry.test.cjs` covering registration, backup, social recovery, resurrection (both paths), carrier management.

---

## Complete Lifecycle: From the Agent's Perspective

This section describes the implemented lifecycle as it actually exists in the current codebase. It is deliberately written from the agent's point of view, but every step maps to a real entry point in `SoulRegistry`, `coc-backup`, or `node/src/did`.

### Scope Clarification

There are two adjacent layers in this repo:

- **Soul / backup / resurrection layer**: `SoulRegistry.sol` + `extensions/coc-backup/`
- **DID resolution layer**: `contracts/contracts-src/governance/DIDRegistry.sol` + `node/src/did/*`

The first layer is what actually performs initialization, backup, restore, and resurrection. The second layer can resolve the same `agentId` into a W3C-style `did:coc` document, but `coc-backup init` does **not** automatically write extra DIDRegistry state. In other words:

- `coc-backup init` creates the agent's on-chain **soul identity basis**
- `did:coc:<agentId>` can then be **derived and resolved** by the DID resolver
- richer DIDRegistry methods are **separate** from the backup loop

### Phase 1: Birth — Soul Registration and DID Basis

> *"I boot for the first time. I need a stable identifier, an owner, and a first recoverable snapshot."*

**Implemented flow**

```
Owner node runs: coc-backup init [--key-hash <hash>] [--max-offline <sec>]
  ↓
1. Resolve agentId
   - default: deriveDefaultAgentId(ownerAddress)
   - implementation: keccak256(ownerAddress)
  ↓
2. Check whether this wallet already owns a soul
   - SoulRegistry.ownerToAgent(owner) via SoulClient.getAgentIdForOwner()
  ↓
3. If not registered yet:
   - read IDENTITY.md if present
   - upload its content to IPFS
   - convert CID → bytes32 via keccak256(CID string)
   - call registerSoul(agentId, identityCid, EIP-712 owner signature)
  ↓
4. Force the first full backup
   - scheduler.runBackup(true)
  ↓
5. Write local metadata
   - .coc-backup/state.json
   - .coc-backup/latest-recovery.json
  ↓
6. Optional: configure resurrection
   - configureResurrection(agentId, resurrectionKeyHash, maxOfflineDuration)
```

**What exists after `init` succeeds**

- an on-chain `SoulRegistry` entry bound to the owner wallet
- a stable `agentId` that is also the DID identifier payload
- a first full backup anchored on-chain
- a local recovery package pointing to the latest manifest
- optional resurrection configuration for offline detection

**What this means for DID**

After registration, the agent can be referred to as `did:coc:<agentId>` by the DID layer in `node/src/did/did-resolver.ts`. That DID document is built from SoulRegistry state and optional DIDRegistry state. The backup workflow itself does **not** depend on DIDRegistry and does not automatically enrich it.

### Phase 2: Living — Automatic Backup While the Agent Works

> *"I think, respond, update memory, write config, rotate sessions, and keep moving. My state is captured in the background."*

**Implemented automatic triggers**

| Trigger | Condition in code | Effect |
|--------|-------------------|--------|
| periodic scheduler | `autoBackupEnabled=true` | recurring backup timer |
| session end | `backupOnSessionEnd && autoBackupEnabled` | immediate backup |
| before compaction | `backupOnSessionEnd && autoBackupEnabled` | backup before token/context trimming |
| gateway stop | always registered; backup only if `autoBackupEnabled` | final backup, then stop timers/daemon |
| stop hook | always registered; backup only if `autoBackupEnabled` | compatibility stop path |
| manual | `coc-backup backup` or `soul-backup` | on-demand backup |

**Implemented backup pipeline**

```
1. captureContextSnapshot(baseDir)
   → writes .coc-backup/context-snapshot.json

2. detectChanges(baseDir, config, previousManifest)
   → classify files by identity/config/memory/chat/workspace/database
   → compute SHA-256 for each file

3. snapshot binary data when needed
   → SQLite: atomic backup copy
   → LanceDB: archive directory

4. upload changed files to IPFS
   → encrypt per-file when category/config requires it

5. carry over unchanged entries from previous manifest

6. build a complete manifest
   → even incremental manifests are full logical snapshots

7. anchorBackup()
   → upload manifest to IPFS
   → store keccak256(manifestCid) + Merkle root on-chain

8. register CID mapping
   → local cid-index.json
   → MFS cid-map.json
   → optional on-chain CidRegistry

9. heartbeat()
   → if resurrection is configured
   → even "no changes" backups still try heartbeat
```

**What the agent preserves**

- identity files: `IDENTITY.md`, `SOUL.md`
- config and credentials
- long-term and daily memory files
- chat/session history
- workspace metadata including `AGENTS.md`
- database state including SQLite and LanceDB artifacts
- context snapshot metadata describing active sessions

From the agent's perspective, this means: if it disappears after a backup point, the next body can reconstruct almost everything except the delta between the last backup and the moment of failure.

### Phase 3: Recovery — Waking Up on the Same Owner Side

> *"My process died, but my latest memory state still exists. I only need to reload it."*

There are two implemented recovery entry styles.

**A. Recover from local recovery metadata**

CLI:

```bash
coc-backup restore --latest-local
```

Tool:

```json
{ "tool": "soul-restore", "latestLocal": true }
```

**B. Recover from chain state only**

Tool:

```json
{ "tool": "soul-auto-restore", "agentId": "0x..." }
```

This path uses `restoreFromChain()` internally. There is no separate CLI command named `restore-from-chain`; the agent-facing automatic entry point is the `soul-auto-restore` tool.

**Implemented restore pipeline**

```
1. Resolve restore source
   - manifest CID, recovery package, or latest local package

2. If restoring from agentId:
   - query SoulRegistry.getLatestBackup(agentId)
   - resolve bytes32 hash → CID via local index, MFS, or CidRegistry
   - verify keccak256(CID) matches the on-chain hash

3. Resolve the manifest chain
   - latest manifest → parentCid → ... → full backup root

4. Verify integrity
   - each manifest Merkle root
   - latest manifest anchor against on-chain Merkle root when possible

5. Download + decrypt + apply files oldest → newest

6. Verify restored disk files against manifest SHA-256 hashes

7. Write .coc-backup/restore-complete.json

8. Best-effort notify a running agent via SIGUSR2
   - otherwise the state is picked up on next start
```

**What the agent experiences**

The agent wakes with:

- the latest recoverable memory graph
- the latest recoverable chat history
- the same config/credential state that was backed up
- a restore marker proving which manifest was applied

This is a true implemented path today, both from a known manifest and from on-chain backup state plus the CID resolver.

### Phase 4: Resurrection — Getting a New Body

> *"My old host is gone. Recovery on the same machine is impossible. I need a different machine to restore me and continue."*

There are two implemented resurrection paths.

#### Path A: Owner-Key Resurrection

This is the faster self-hosted path when the operator still controls the resurrection key.

```
1. Owner configured resurrection in advance
   - configureResurrection(keyHash, maxOfflineDuration)

2. Old host stops sending heartbeats

3. Owner starts resurrection
   - coc-backup resurrect --carrier-id <id> --resurrection-key <hex>
   - or coc-backup resurrection start ...

4. Carrier side confirms and completes
   - confirmCarrier(requestId)
   - no guardian quorum or timelock
   - restore backup
   - spawn agent
   - completeResurrection(requestId)
   - optionally send initial heartbeat
```

#### Path B: Guardian-Vote Resurrection

This is the path when the owner is unavailable.

```
1. Agent becomes offline according to chain rules
   - SoulRegistry.isOffline(agentId) must return true

2. A guardian initiates
   - coc-backup guardian initiate --agent-id <id> --carrier-id <id>

3. Other guardians approve
   - coc-backup guardian approve --request-id <id>

4. Request reaches the carrier daemon
   - carrier.pendingRequestIds in config
   - or coc-backup carrier submit-request --request-id <id> --agent-id <id>
   - or tool soul-carrier-request

5. Carrier daemon executes carrier-only actions
   - verify offline
   - confirm carrier
   - waitForReadiness() until quorum + timelock are satisfied
   - autoRestore()
   - spawn agent
   - health check
   - completeResurrection()
   - send first heartbeat unless shutdown is already in progress
```

**Important correctness boundary**

Offline detection alone does **not** automatically create a resurrection request. The implemented automation starts **after** a valid request is created and delivered to the carrier daemon. This matches the current role model:

- owner/guardian initiate authorization on-chain
- carrier daemon performs restore/boot/completion on the carrier node

**What the agent experiences**

From the agent's perspective, resurrection is just a longer discontinuity than a normal restore:

1. it stops existing on the failed host
2. a new machine restores the latest recoverable state
3. it starts with the same `agentId`
4. it continues from the last successful backup window

The visible traces are:

- a gap in heartbeat timestamps
- a `ResurrectionCompleted` event on-chain
- a new `restore-complete.json` marker in the carrier work directory

### Phase 5: Ongoing — The Loop Continues

> *"I persist because identity, backup state, and resurrection authority are all externalized. My process is replaceable; my state is not."*

After successful recovery or resurrection, the same loop resumes:

```
run → backup → anchor → heartbeat
     ↓
failure
     ↓
restore on same owner side
or
resurrection on a carrier side
     ↓
run again with the same agentId
```

The practical result is not "I can never fail". It is:

- the agent can be rebuilt from the latest anchored state
- the agent keeps the same soul identity across hosts
- the resurrection path is fully implemented for both owner-key and guardian-vote models
- the DID layer can resolve that identity, but it is not what drives the backup loop

---

## Known Boundaries

1. **IPFS fetch not cancellable mid-download.** Once `autoRestore()` begins downloading, individual IPFS fetch calls use a 30-second `AbortSignal.timeout` but are not linked to the daemon's shutdown signal. This is an acceptable boundary: already-downloaded data should not be discarded, and the operation is idempotent.
2. **`carrier list` is a placeholder.** Requires an on-chain event indexer to enumerate registered carriers.
3. **Single key per process.** Each process uses one `privateKey` for all contract calls. Multi-role operation requires running separate processes. This is by design — it matches the contract's `msg.sender` enforcement.
4. **Merkle hash divergence.** Backup Merkle tree uses SHA-256 (off-chain integrity). Node core `ipfs-merkle.ts` uses Keccak-256 (EVM compatible). They cannot cross-verify directly.
5. **DID enrichment is adjacent, not automatic in `coc-backup init`.** Soul registration gives the agent its stable `agentId` and DID basis. Additional DIDRegistry-managed verification methods, delegation, and credentials belong to the `node/src/did` layer and are not part of the backup scheduler itself.

---

## File Inventory

### Smart Contracts
- `governance/SoulRegistry.sol` — Soul identity, backup anchoring, social recovery, resurrection (~870 lines)
- `governance/CidRegistry.sol` — CID registry (~90 lines)
- `governance/DIDRegistry.sol` — optional DID enrichment layer (~612 lines)

### Extension: `extensions/coc-backup/`
| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/backup/` | `change-detector.ts`, `uploader.ts`, `manifest-builder.ts`, `anchor.ts`, `scheduler.ts`, `binary-handler.ts`, `context-snapshot.ts` | Backup pipeline |
| `src/recovery/` | `chain-resolver.ts`, `downloader.ts`, `integrity-checker.ts`, `state-restorer.ts`, `cid-resolver.ts`, `orchestrator.ts`, `agent-restarter.ts` | Recovery pipeline |
| `src/carrier/` | `protocol.ts`, `offline-monitor.ts`, `agent-spawner.ts`, `resurrection-flow.ts`, `carrier-daemon.ts` | Carrier daemon |
| `src/` | `types.ts`, `config-schema.ts`, `crypto.ts`, `ipfs-client.ts`, `soul-client.ts`, `plugin-api.ts`, `lifecycle.ts`, `local-state.ts`, `utils.ts` | Core modules |
| `src/cli/` | `commands.ts` | CLI (backup, guardian, carrier, resurrection) |
| `test/` | 9 test files | 47 tests |
