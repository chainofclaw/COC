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

**File:** `contracts/contracts-src/governance/SoulRegistry.sol` (~870 lines)

### Core Data Structures

#### SoulIdentity

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `bytes32` | Unique identity (contract comment says `keccak256(Ed25519 pubkey)`, CLI defaults to `keccak256(walletAddress)` when omitted) |
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
| `cancelRecovery(requestId)` | Cancel pending recovery | owner only |
| `deactivateSoul(agentId)` | Deactivate soul identity | owner only |

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
2. **Initiate Recovery:** Any active guardian calls `initiateRecovery(agentId, newOwner)`, initiator auto-counts as 1 approval. A `guardianSnapshot` (active count at initiation) is stored so threshold cannot be manipulated mid-recovery
3. **Approval Threshold:** Requires `ceil(2/3 * guardianSnapshot)` guardian approvals (snapshot-based, not live count)
4. **Time Lock:** After meeting threshold, must wait `RECOVERY_DELAY = 1 day`
5. **Execute Transfer:** Once both conditions met, anyone can call `completeRecovery()` — owner pointer transfers, identity data fully preserved
6. **Cancel Recovery:** Owner can call `cancelRecovery(requestId)` to abort a pending recovery before completion

### Resurrection Mechanism

#### Design Rationale

**Key distinction from Social Recovery:**

| | Social Recovery | Resurrection |
|-|----------------|--------------|
| **Purpose** | Ownership transfer (lost private key) | Rebuild agent on new hardware (carrier failure) |
| **Owner** | Changes to `newOwner` | Stays the same |
| **Trigger** | Guardian initiative only | Owner key OR guardian vote after offline timeout |
| **Time Lock** | 1 day (`RECOVERY_DELAY`) | 12 hours (`RESURRECTION_DELAY`) for guardian path; none for owner key |
| **Result** | `ownerToAgent` pointer transferred | On-chain resurrection authorization complete, heartbeat reset (actual recovery happens after the carrier pulls from IPFS and starts the Agent off-chain) |

The resurrection mechanism addresses a scenario not covered by social recovery: when an Agent's physical host (server, VM, container) becomes permanently unavailable but the owner's private key is not lost. Rather than transferring ownership, the goal is to spin up a new copy of the Agent on a different carrier, pulling its full state from IPFS backups.

#### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Resurrection Three-Layer Model                │
├────────────────┬─────────────────────┬──────────────────────────┤
│  Trigger Layer │  Authorization Layer│     Execution Layer      │
├────────────────┼─────────────────────┼──────────────────────────┤
│ Owner Key      │ EIP-712 Signature   │ Carrier registration     │
│ Heartbeat      │ Guardian 2/3 vote   │ IPFS state recovery      │
│   timeout      │ Time lock           │ Carrier readiness        │
│ Guardian       │                     │   confirmation           │
│   initiation   │                     │ Heartbeat reset          │
└────────────────┴─────────────────────┴──────────────────────────┘
```

#### Data Structures

##### ResurrectionConfig

Stored per agentId. Set by the soul owner via `configureResurrection()`.

| Field | Type | Description |
|-------|------|-------------|
| `resurrectionKeyHash` | `bytes32` | `keccak256(abi.encodePacked(resurrectionKeyAddress))` — hash of the resurrection key holder's Ethereum address |
| `maxOfflineDuration` | `uint64` | Max seconds without heartbeat before the agent is considered offline |
| `lastHeartbeat` | `uint64` | Timestamp of the last heartbeat (set on config and each heartbeat call) |
| `configured` | `bool` | Whether resurrection has been configured for this soul |

##### Carrier

Physical host registered to accept resurrected agents.

| Field | Type | Description |
|-------|------|-------------|
| `carrierId` | `bytes32` | Unique identifier |
| `owner` | `address` | Carrier provider's EOA |
| `endpoint` | `string` | Communication URL/IP |
| `registeredAt` | `uint64` | Registration timestamp |
| `cpuMillicores` | `uint64` | CPU specification |
| `memoryMB` | `uint64` | Memory specification |
| `storageMB` | `uint64` | Storage specification |
| `available` | `bool` | Whether accepting new souls |
| `active` | `bool` | Whether registered (false after deregister) |

##### ResurrectionRequest

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `bytes32` | Soul being resurrected |
| `carrierId` | `bytes32` | Target carrier |
| `initiator` | `address` | Who initiated the request |
| `initiatedAt` | `uint64` | Initiation timestamp |
| `approvalCount` | `uint8` | Guardian approvals (guardian path only) |
| `guardianSnapshot` | `uint8` | Active guardian count at initiation |
| `executed` | `bool` | Completed or cancelled |
| `carrierConfirmed` | `bool` | Carrier has acknowledged |
| `trigger` | `ResurrectionTrigger` | `OwnerKey` or `GuardianVote` |

##### ResurrectionTrigger (enum)

| Value | Description |
|-------|-------------|
| `OwnerKey` (0) | Owner used resurrection key to initiate |
| `GuardianVote` (1) | Guardians voted after offline timeout |

#### EIP-712 Signature Types

Two new EIP-712 type hashes added to the contract. TypeScript definitions at `node/src/crypto/soul-registry-types.ts`.

```
ResurrectSoul(bytes32 agentId, bytes32 carrierId, uint64 nonce)
Heartbeat(bytes32 agentId, uint64 timestamp, uint64 nonce)
```

Both share the same domain and nonce counter as existing operations (`RegisterSoul`, `AnchorBackup`, `UpdateIdentity`).

#### Contract Functions

##### Configuration & Heartbeat

| Function | Description | Access Control |
|----------|-------------|----------------|
| `configureResurrection(agentId, keyHash, maxOffline)` | Set resurrection key and offline threshold | owner only |
| `heartbeat(agentId, timestamp, sig)` | Prove agent is alive (EIP-712 signed, consumes nonce) | owner + EIP-712 |
| `isOffline(agentId)` → `bool` | Check if `block.timestamp > lastHeartbeat + maxOfflineDuration` | view |
| `getResurrectionConfig(agentId)` | Read resurrection config | view |

##### Carrier Management

| Function | Description | Access Control |
|----------|-------------|----------------|
| `registerCarrier(carrierId, endpoint, cpu, mem, storage)` | Register a physical host | anyone |
| `deregisterCarrier(carrierId)` | Mark carrier inactive | carrier owner |
| `updateCarrierAvailability(carrierId, available)` | Toggle availability | carrier owner |
| `getCarrier(carrierId)` | Read carrier info | view |

##### Resurrection Request Flow

| Function | Description | Access Control |
|----------|-------------|----------------|
| `initiateResurrection(agentId, carrierId, sig)` | Owner key path — sign with resurrection key | anyone with resurrection key |
| `initiateGuardianResurrection(agentId, carrierId)` | Guardian path — requires `isOffline()` | active guardian |
| `approveResurrection(requestId)` | Approve a guardian-initiated request | active guardian |
| `confirmCarrier(requestId)` | Carrier confirms willingness to host | carrier owner |
| `completeResurrection(requestId)` | Finalize resurrection, reset heartbeat | anyone (if conditions met) |
| `cancelResurrection(requestId)` | Cancel pending request | owner or initiator |

#### Owner Key Path (Sequence)

```
Owner                    Contract                  Carrier
  │                         │                         │
  │  configureResurrection  │                         │
  │  (keyHash, maxOffline)  │                         │
  │────────────────────────>│                         │
  │                         │                         │
  │  initiateResurrection   │                         │
  │  (agentId, carrierId,   │                         │
  │   resurrection-key sig) │                         │
  │────────────────────────>│ emit ResurrectionInitiated
  │                         │                         │
  │                         │  confirmCarrier         │
  │                         │<────────────────────────│
  │                         │ emit CarrierConfirmed   │
  │                         │                         │
  │  completeResurrection   │                         │
  │────────────────────────>│                         │
  │                         │ reset lastHeartbeat     │
  │                         │ emit ResurrectionCompleted
  │                         │                         │
  ├──────── on-chain authorization phase ends ────────┤
  │                                                   │
  │        (off-chain recovery — outside contract)    │
  │                         │                         │
  │                         │  carrier pulls IPFS     │
  │                         │  manifest → downloads   │
  │                         │  files → starts Agent   │
  │                         │<────────────────────────│
  │                         │                         │
  │                         │  Agent sends first real │
  │                         │  heartbeat = proof of   │
  │                         │  actual recovery        │
```

**No time lock.** Owner key is the highest authority — if the owner can produce a valid resurrection key signature, the only gate is the carrier confirming it can host.

#### Guardian Vote Path (Sequence)

```
                           heartbeat times out
Guardian₁                  Contract                  Carrier
  │                         │                         │
  │  isOffline(agentId)?    │                         │
  │────────────────────────>│ returns true            │
  │                         │                         │
  │ initiateGuardianRes.    │                         │
  │ (agentId, carrierId)    │                         │
  │────────────────────────>│ snapshot=3, approval=1  │
  │                         │ emit ResurrectionInitiated
  │                         │                         │
Guardian₂                   │                         │
  │  approveResurrection    │                         │
  │────────────────────────>│ approval=2 (≥ ceil(2/3×3)=2) ✓
  │                         │                         │
  │                         │  confirmCarrier         │
  │                         │<────────────────────────│
  │                         │                         │
  │        ···12 hours pass···                        │
  │                         │                         │
Anyone                      │                         │
  │  completeResurrection   │                         │
  │────────────────────────>│ check: approvals ≥ 2 ✓  │
  │                         │ check: time ≥ 12h ✓     │
  │                         │ check: carrier ✓        │
  │                         │ reset lastHeartbeat     │
  │                         │ emit ResurrectionCompleted
  │                         │                         │
  ├──────── on-chain authorization phase ends ────────┤
  │        (off-chain recovery same as owner-key path)│
```

**Three conditions for guardian path:**
1. `approvalCount >= ceil(2/3 * guardianSnapshot)`
2. `block.timestamp >= initiatedAt + RESURRECTION_DELAY` (12 hours)
3. `carrierConfirmed == true`

The 12-hour time lock (vs 1-day for ownership recovery) reflects the higher urgency of agent downtime compared to key loss.

#### Carrier Provision Model

```
                   ┌────────────────────────────────┐
                   │        Carrier Registry         │
                   │    (SoulRegistry contract)      │
                   └──────────┬─────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────┴────┐   ┌─────┴────┐   ┌──────┴────┐
        │Self-hosted│   │Community │   │  Cloud    │
        │ (own VPS) │   │(volunteer│   │(API-based)│
        │           │   │  nodes)  │   │           │
        └──────────┘   └──────────┘   └───────────┘
```

**Registration flow:**
1. Provider calls `registerCarrier(carrierId, endpoint, cpuMillicores, memoryMB, storageMB)`
2. Carrier is marked `available = true` and `active = true`
3. When a resurrection request targets this carrier, provider calls `confirmCarrier(requestId)` if resources allow

**Off-chain carrier protocol (post-confirmation):**
1. Carrier listens for `ResurrectionInitiated` events matching its carrierId
2. Validates local resources can accommodate the agent's requirements
3. Calls `confirmCarrier(requestId)` on-chain

*Steps 4-7 are the off-chain recovery phase (outside contract control):*

4. After `ResurrectionCompleted`, pulls the agent's latest backup manifest from IPFS. **Note:** The chain only stores `keccak256(cidString)` — the real CID cannot be derived on-chain. The carrier must obtain the manifest CID via off-chain means — e.g. backup logs, MFS path `/soul-backups/`, or owner providing it through an off-chain channel. `restoreFromChain()` is currently not implemented (see `state-restorer.ts`).
5. Downloads and decrypts all files (using `restoreFromManifestCid()` pipeline)
6. Starts the agent process
7. Agent sends its first **real** `heartbeat()` — this is the actual proof of successful recovery

#### Off-Chain Integration

##### Automatic Heartbeat (scheduler.ts)

The `BackupScheduler` integrates heartbeat sending into the backup cycle:
- After every successful `runBackup()`, calls `soul.heartbeat(agentId)` automatically
- Even when no files changed (backup skipped), still sends a heartbeat
- Heartbeat interval = `autoBackupIntervalMs` (default 1 hour)
- Failures are non-fatal: logged as warnings, do not block the backup pipeline

##### SoulClient Methods (soul-client.ts)

| Method | Signature | Description | Status |
|--------|-----------|-------------|--------|
| `configureResurrection` | `(agentId, keyHash, maxOffline) → txHash` | Configure resurrection parameters | ✅ Implemented |
| `heartbeat` | `(agentId) → txHash` | Send EIP-712 signed heartbeat (auto-generates timestamp) | ✅ Implemented |
| `isOffline` | `(agentId) → boolean` | Check offline status | ✅ Implemented |
| `getResurrectionConfig` | `(agentId) → ResurrectionConfig` | Read configuration | ✅ Implemented |
| `initiateResurrection` | `(agentId, carrierId, resurrectionKey) → txHash` | Owner key resurrection (creates a Wallet from the resurrection private key internally) | ✅ Implemented |
| `registerCarrier` | `(carrierId, endpoint, cpu, mem, storage) → txHash` | Register a carrier | ✅ Implemented |
| `getCarrier` | `(carrierId) → CarrierInfo` | Read carrier info | ✅ Implemented |
| `deregisterCarrier` | — | Deregister a carrier | Direct contract call |
| `updateCarrierAvailability` | — | Toggle carrier availability | Direct contract call |
| `initiateGuardianResurrection` | — | Guardian-initiated resurrection | Direct contract call |
| `approveResurrection` | — | Approve resurrection request | Direct contract call |
| `confirmCarrier` | — | Carrier confirms hosting | Direct contract call |
| `completeResurrection` | — | Finalize resurrection | Direct contract call |
| `cancelResurrection` | — | Cancel resurrection request | Direct contract call |

> **Plugin coverage boundary:** The current coc-backup plugin covers the owner-key resurrection core path (configure → heartbeat → initiate → carrier register → query). The guardian voting path (`initiateGuardianResurrection`, `approveResurrection`) and remaining carrier management operations (`deregisterCarrier`, `updateCarrierAvailability`, `confirmCarrier`, `completeResurrection`, `cancelResurrection`) require direct contract calls or external scripts.

##### CLI Commands

| Command | Description | Status |
|---------|-------------|--------|
| `coc-backup configure-resurrection --key-hash <hash> [--max-offline <sec>]` | Configure resurrection key and offline timeout (default 86400s = 24h) | ✅ Implemented |
| `coc-backup heartbeat` | Manually send a heartbeat | ✅ Implemented |
| `coc-backup resurrect --carrier-id <id> --resurrection-key <key> [--agent-id <id>]` | Initiate owner-key resurrection (use `--agent-id` when relaying for another soul) | ✅ Implemented |
| `coc-backup carrier register --carrier-id <id> --endpoint <url> [--cpu] [--memory] [--storage]` | Register as a carrier provider | ✅ Implemented |
| `coc-backup carrier list` | List known carriers (requires indexer) | Not implemented |

##### TypeScript Types (types.ts)

```typescript
interface ResurrectionConfig {
  resurrectionKeyHash: string  // bytes32
  maxOfflineDuration: number   // seconds
  lastHeartbeat: number        // unix timestamp
  configured: boolean
}

interface CarrierInfo {
  carrierId: string            // bytes32
  owner: string                // address
  endpoint: string
  registeredAt: number         // unix timestamp
  cpuMillicores: number
  memoryMB: number
  storageMB: number
  available: boolean
  active: boolean
}

interface ResurrectionResult {
  requestId: string
  agentId: string
  carrierId: string
  trigger: "owner-key" | "guardian-vote"
  filesRestored: number
  totalBytes: number
}
```

#### Security Considerations

| Threat | Mitigation |
|--------|-----------|
| **Resurrection key compromise** | Key hash stored on-chain — attacker must also find an available carrier willing to confirm. Owner can re-configure with a new key at any time. |
| **Heartbeat spoofing** | Heartbeat requires EIP-712 signature from the soul owner (nonce-protected). No one else can send heartbeats. |
| **False offline detection** | `maxOfflineDuration` is owner-configurable. Short values increase risk of false positives during temporary network issues. |
| **Carrier impersonation** | Carrier confirmation is gated by the carrier owner's address. An attacker would need the carrier's private key. |
| **Guardian collusion (resurrection)** | Same 2/3 threshold as social recovery. Additionally requires `isOffline == true` at both initiation **and** completion — guardians cannot resurrect an online agent, and if the agent recovers during the 12-hour delay the request becomes uncompletable. |
| **Denial of carrier confirmation** | If the targeted carrier never confirms, the resurrection request remains pending. The owner or initiator can cancel and re-initiate with a different carrier. |
| **Nonce sharing** | Resurrection and heartbeat operations share the same per-agentId nonce counter as registration/backup/update, preventing cross-operation replay. |
| **Fake online / fake resurrection** | `completeResurrection()` immediately resets `lastHeartbeat`, but does not prove the carrier has successfully restored and started the Agent. True liveness proof requires a subsequent **real** `heartbeat()` signed transaction (initiated by the recovered Agent). |
| **Recovery trust boundary** | When the carrier executes `restoreFromManifestCid()`, on-chain anchor verification uses the `agentId` embedded in the manifest (not the caller's wallet), so any carrier with RPC access can perform full chain verification. Note: the manifest `agentId` itself is not signature-protected — integrity relies on Merkle root matching against the on-chain anchor. |

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
| `RecoveryCancelled(requestId, agentId)` | Recovery cancelled by owner |
| `SoulDeactivated(agentId, owner)` | Soul deactivated by owner |
| `ResurrectionConfigured(agentId, keyHash, maxOffline)` | Resurrection parameters set |
| `Heartbeat(agentId, timestamp)` | Heartbeat received |
| `CarrierRegistered(carrierId, owner, endpoint)` | Carrier registered |
| `CarrierDeregistered(carrierId)` | Carrier deregistered |
| `ResurrectionInitiated(requestId, agentId, carrierId, trigger)` | Resurrection started |
| `ResurrectionApproved(requestId, guardian)` | Guardian approved resurrection |
| `CarrierConfirmed(requestId, carrierId)` | Carrier confirmed hosting |
| `ResurrectionCompleted(requestId, agentId, carrierId)` | Resurrection completed |
| `ResurrectionCancelled(requestId)` | Resurrection cancelled |

### Custom Errors

| Error | Trigger |
|-------|---------|
| `AlreadyRegistered()` | Duplicate owner or agentId registration |
| `NotRegistered()` | Operation on non-existent soul |
| `NotOwner()` | Caller is not the soul owner |
| `InvalidAgentId()` | Zero agentId passed to registration |
| `InvalidSignature()` | EIP-712 signature verification failed |
| `AgentIdTaken()` | Duplicate agentId registration |
| `SoulNotActive()` | Operation on deactivated soul |
| `GuardianLimitReached()` | Active guardian count already at MAX_GUARDIANS |
| `GuardianAlreadyAdded()` | Guardian address already active |
| `GuardianNotFound()` | Attempting to remove a non-active guardian |
| `CannotGuardSelf()` | Owner cannot be their own guardian |
| `RecoveryNotFound()` | Recovery request does not exist |
| `RecoveryAlreadyExecuted()` | Recovery already completed or cancelled |
| `RecoveryNotReady()` | Insufficient approvals or time lock not passed |
| `AlreadyApproved()` | Guardian already voted on this request |
| `NotGuardian()` | Caller is not an active guardian |
| `InvalidBackupType()` | backupType not 0 or 1 |
| `ParentCidRequired()` | Incremental backup missing parentManifestCid |
| `InvalidAddress()` | Zero address passed to recovery or guardian operations |
| `InvalidCid()` | Zero bytes32 passed as CID (registration, update, or backup) |
| `ResurrectionNotConfigured()` | Resurrection operation on unconfigured soul |
| `NotOffline()` | Guardian resurrection requires offline agent |
| `CarrierNotFound()` | Carrier not registered or inactive |
| `CarrierNotAvailable()` | Carrier not accepting new souls |
| `NotCarrierOwner()` | Caller is not the carrier owner |
| `CarrierAlreadyRegistered()` | Duplicate carrier registration |
| `ResurrectionNotFound()` | Resurrection request does not exist |
| `ResurrectionAlreadyExecuted()` | Resurrection already completed or cancelled |
| `ResurrectionNotReady()` | Insufficient approvals or time lock not passed |
| `CarrierNotConfirmed()` | Carrier has not confirmed the resurrection request |
| `InvalidKeyHash()` | Zero resurrection key hash |

### Constraints & Security

- **One-to-one binding:** `ownerToAgent` mapping ensures one EOA can only own one agentId
- **Signature verification:** Assembly-level `ecrecover`, strict sig length 65, v value 27/28, non-zero recovery, EIP-2 canonical `s` check (rejects malleable signatures)
- **Input validation:** `InvalidAddress` for zero addresses, `InvalidCid` for zero bytes32 CID/Merkle root
- **CID storage:** On-chain stores `keccak256(cidString)` rather than raw CID (gas savings, but irreversible)

### Deployment

Deploy script at `contracts/deploy/deploy-soul-registry.ts`:

| Target | chainId | Confirmations | Gas Strategy |
|--------|---------|---------------|--------------|
| `l2-coc` | 18780 | 1 | legacy |
| `l1-sepolia` | 11155111 | 3 | EIP-1559 (30/2 gwei) |
| `l1-mainnet` | 1 | 5 | EIP-1559 (50/2 gwei) |

### Tests

`contracts/test/SoulRegistry.test.cjs` contains 55 test scenarios:
- Registration: valid registration, zero agentId, duplicate agentId, duplicate owner, forged signature
- Backup: full backup, incremental chain, missing parentCid, non-owner, paginated query, invalid CID rejection
- Identity update: valid update, non-owner
- Guardians: add/remove flow, self-guard, duplicate add, non-owner, invalid address
- Social recovery: full flow (3 guardians + 2/3 approval + time lock), insufficient votes, time lock not expired, non-guardian, duplicate approval, guardian snapshot threshold
- Cancel recovery: owner cancellation, non-owner rejection
- Deactivation: valid deactivation, operations blocked after deactivation
- Signature security: EIP-2 malleable signature rejection
- Edge cases: unregistered queries, empty history, zero identityCid rejection, guardian reactivation, cross-operation nonce increment
- Resurrection config: configure parameters, zero key hash rejection, heartbeat EIP-712 flow, offline detection
- Carrier management: register, deregister, availability update, duplicate/non-owner rejection
- Owner-key resurrection: full flow, missing carrier confirmation, wrong key rejection
- Guardian-vote resurrection: full flow with offline timeout + 2/3 approval + 12h time lock, insufficient approvals, cancellation, non-guardian rejection

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

`manifest-builder.ts` implements the same structure (domain separation prefixes, odd-node handling) as `node/src/ipfs-merkle.ts` but with a different hash function. The node core uses Keccak-256 (EVM-compatible), while the backup extension uses SHA-256 (off-chain integrity):

- **Leaf hash:** `SHA-256(0x00 || leafData)` — `0x00` prefix prevents leaf/internal node collision
- **Internal hash:** `SHA-256(0x01 || left || right)` — `0x01` prefix for domain separation
- **Leaf data:** Length-prefixed encoding `[u32le(path.len) || path || u32le(cid.len) || cid || u32le(hash.len) || hash]`, sorted lexicographically by path for determinism (prevents ambiguity from colon-separated concatenation)
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

### Security Hardening

- **CID format validation:** Rejects CIDs containing slashes, backslashes, dots, whitespace, or exceeding 512 characters
- **IPFS timeout:** All IPFS HTTP calls use a 30-second `AbortSignal.timeout`
- **File size limit:** Individual files exceeding 100 MB are excluded from backup (`MAX_FILE_BYTES`)
- **Manifest size cap:** Downloaded manifests exceeding 10 MB are rejected
- **Path traversal prevention:** `downloader.ts` resolves paths and verifies they remain under `targetDir`
- **Symlink filtering:** `change-detector.ts` skips symbolic links during directory scan (`entry.isSymbolicLink()`)

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
5. **Guardian reactivation model:** On-chain `_guardians` array uses reactivation — re-adding a previously removed guardian reactivates the existing entry instead of pushing a new one. Array size upper bound = total unique addresses ever added
6. **Hash function divergence:** Backup Merkle tree uses SHA-256, while node core `ipfs-merkle.ts` uses Keccak-256 — they cannot cross-verify directly

---

## File Inventory

### Smart Contracts
- `contracts/contracts-src/governance/SoulRegistry.sol` — Main contract (~870 lines, includes resurrection mechanism)
- `contracts/deploy/deploy-soul-registry.ts` — Deploy script (109 lines)
- `contracts/test/SoulRegistry.test.cjs` — Test suite (55 tests)

### EIP-712 Types
- `node/src/crypto/soul-registry-types.ts` — TypeScript signature types (5 type definitions)

### coc-backup Extension
- `extensions/coc-backup/index.ts` — Plugin entry (150 lines)
- `extensions/coc-backup/openclaw.plugin.json` — Plugin manifest
- `extensions/coc-backup/package.json` — Dependencies
- `extensions/coc-backup/src/types.ts` — Core types (78 lines)
- `extensions/coc-backup/src/config-schema.ts` — Config schema (25 lines)
- `extensions/coc-backup/src/crypto.ts` — Encryption module (81 lines)
- `extensions/coc-backup/src/ipfs-client.ts` — IPFS client (116 lines)
- `extensions/coc-backup/src/soul-client.ts` — Contract client (~330 lines)
- `extensions/coc-backup/src/cli/commands.ts` — CLI commands (~340 lines)
- `extensions/coc-backup/src/backup/anchor.ts` — Anchoring logic (67 lines)
- `extensions/coc-backup/src/backup/change-detector.ts` — Change detection (130 lines)
- `extensions/coc-backup/src/backup/manifest-builder.ts` — Manifest building (97 lines)
- `extensions/coc-backup/src/backup/scheduler.ts` — Scheduler (167 lines)
- `extensions/coc-backup/src/backup/uploader.ts` — Uploader (73 lines)
- `extensions/coc-backup/src/recovery/chain-resolver.ts` — Chain resolution (123 lines)
- `extensions/coc-backup/src/recovery/downloader.ts` — Downloader (115 lines)
- `extensions/coc-backup/src/recovery/integrity-checker.ts` — Integrity verification (86 lines)
- `extensions/coc-backup/src/recovery/state-restorer.ts` — Recovery orchestration (159 lines)

**Total:** Code (excluding tests): ~2,600 lines. Including tests: ~3,800 lines
