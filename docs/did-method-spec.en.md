# Decentralized Identity for AI Agents: `did:coc` Method Specification

## Overview

The `did:coc` method provides W3C DID Core v1.0 compliant decentralized identifiers for AI agents on the COC blockchain. Built on top of the existing SoulRegistry identity infrastructure, it adds standardized identity resolution, key management, capability delegation, verifiable credentials, and selective disclosure.

| Component | Purpose | Location |
|-----------|---------|----------|
| **DIDRegistry Contract** | Key rotation, delegation, credentials, ephemeral identities, lineage | `COC/contracts/governance/DIDRegistry.sol` |
| **DID Resolver** | Resolves `did:coc` identifiers to DID Documents | `COC/node/src/did/did-resolver.ts` |
| **DID Document Builder** | Constructs W3C-compliant documents from on-chain state | `COC/node/src/did/did-document-builder.ts` |
| **DID Auth** | Challenge-response authentication for Wire/P2P | `COC/node/src/did/did-auth.ts` |
| **Delegation Chain** | Scope-limited delegation verification | `COC/node/src/did/delegation-chain.ts` |
| **Verifiable Credentials** | VC issuance, selective disclosure via Merkle proofs | `COC/node/src/did/verifiable-credentials.ts` |
| **EIP-712 Types** | Typed data definitions for DIDRegistry | `COC/node/src/crypto/did-registry-types.ts` |
| **Explorer Pages** | DID search and detail visualization | `COC/explorer/src/app/did/` |

---

## Architecture Overview

```
                        ┌─────────────────────────────────┐
                        │         DID Resolver             │
                        │  (did-resolver.ts)               │
                        └──────────┬──────────────────────-┘
                                   │  resolve("did:coc:0x...")
                     ┌─────────────┼─────────────┐
                     ▼             ▼              ▼
              ┌──────────┐  ┌───────────┐  ┌──────────────┐
              │ SoulReg  │  │ DIDReg    │  │ PoSeManager  │
              │ Contract │  │ Contract  │  │ V2 Contract  │
              └──────────┘  └───────────┘  └──────────────┘
                     │             │              │
                     └─────────────┼──────────────┘
                                   ▼
                        ┌─────────────────────────────────┐
                        │      DID Document Builder        │
                        │  (did-document-builder.ts)       │
                        └──────────┬──────────────────────-┘
                                   │
                                   ▼
                        ┌─────────────────────────────────┐
                        │     W3C DID Document (JSON)      │
                        │  verificationMethod, service,    │
                        │  controller, cocAgent metadata   │
                        └─────────────────────────────────┘
```

### Data Flow

**Resolution Path:**

1. Client calls `coc_resolveDid("did:coc:0xabc...")` via JSON-RPC
2. Resolver parses the DID string to extract `chainId`, `identifierType`, and `identifier`
3. Queries SoulRegistry for `SoulIdentity`, guardians, resurrection config
4. Queries DIDRegistry for verification methods, capabilities, lineage, delegations
5. DID Document Builder assembles a W3C-compliant JSON document
6. Returns `DIDResolutionResult` with document, resolution metadata, and document metadata

**Authentication Path:**

1. Initiator sends Wire/P2P handshake with optional `did` and `didProof` fields
2. Responder resolves the DID to obtain verification methods
3. Verifies `didProof` signature against the resolved authentication methods
4. On success, establishes authenticated session with DID-based identity

---

## DID Method Specification

### 1. Method Name

The method name is `coc`. A DID using this method MUST begin with `did:coc:`.

### 2. Method-Specific Identifier

```
did:coc:<agentId>                      # Default chain (chainId=20241224)
did:coc:<chainId>:<agentId>            # Explicit chain
did:coc:<chainId>:agent:<agentId>      # Explicit agent type
did:coc:<chainId>:node:<nodeId>        # PoSe node identity
```

Where:
- `<agentId>` / `<nodeId>` — `0x`-prefixed hex bytes32 from SoulRegistry / PoSeManagerV2
- `<chainId>` — Decimal integer. When omitted, defaults to COC mainnet (`20241224`)

**Examples:**
- `did:coc:0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890`
- `did:coc:18780:0xabcdef...`
- `did:coc:18780:node:0xabcdef...`

**Parsing regex:** `^did:coc:(?:(\d+):)?(?:(agent|node):)?(.+)$`

### 3. CRUD Operations

| Operation | Mechanism | On-Chain Effect |
|-----------|-----------|-----------------|
| **Create** | `SoulRegistry.registerSoul()` + `DIDRegistry.updateDIDDocument()` | SoulIdentity created + DID document CID anchored |
| **Read** | `coc_resolveDid` RPC / DID Resolver | Assembles DID Document from on-chain state |
| **Update** | `DIDRegistry.updateDIDDocument()` (EIP-712 signed) | Updates document CID |
| **Deactivate** | `SoulRegistry.deactivateSoul()` | Marks `active=false`; resolver returns empty verification methods |

### 4. DID Document Structure

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://coc.network/ns/did/v1"
  ],
  "id": "did:coc:0xabc123...",
  "controller": ["did:coc:0xabc123...", "0xguardian1...", "0xguardian2..."],
  "verificationMethod": [
    {
      "id": "did:coc:0xabc123...#master",
      "type": "EcdsaSecp256k1RecoveryMethod2020",
      "controller": "did:coc:0xabc123...",
      "blockchainAccountId": "eip155:20241224:0xOwnerAddress"
    },
    {
      "id": "did:coc:0xabc123...#operational",
      "type": "EcdsaSecp256k1RecoveryMethod2020",
      "controller": "did:coc:0xabc123...",
      "blockchainAccountId": "eip155:20241224:0xOperatorAddress"
    }
  ],
  "authentication": ["#master", "#operational"],
  "assertionMethod": ["#master", "#operational"],
  "capabilityInvocation": ["#master"],
  "capabilityDelegation": ["#master"],
  "service": [
    { "id": "#rpc", "type": "CocRpcEndpoint", "serviceEndpoint": "http://node:18780" },
    { "id": "#wire", "type": "CocWireProtocol", "serviceEndpoint": "tcp://node:19781" },
    { "id": "#ipfs", "type": "IpfsGateway", "serviceEndpoint": "http://node:5001" },
    { "id": "#pose", "type": "CocPoSeEndpoint", "serviceEndpoint": "http://node:18780/pose" }
  ],
  "cocAgent": {
    "registeredAt": "2026-03-15T10:00:00.000Z",
    "version": 1,
    "identityCid": "0x1111...",
    "capabilities": ["storage", "compute", "validation"],
    "lineage": { "parent": null, "forkHeight": null, "generation": 0 },
    "reputation": { "poseScore": 0.95, "epochsActive": 1200, "slashCount": 0 }
  }
}
```

**Mapping from on-chain state:**

| DID Document Field | Source |
|--------------------|--------|
| `id` | Derived from `SoulIdentity.agentId` |
| `controller` | Self DID + active guardians from `SoulRegistry.getGuardians()` |
| `verificationMethod[#master]` | `SoulIdentity.owner` address |
| `verificationMethod[#resurrection]` | `ResurrectionConfig.resurrectionKeyHash` |
| `verificationMethod[#operational...]` | `DIDRegistry.getActiveVerificationMethods()` |
| `service` | Configured endpoints (not stored on-chain) |
| `cocAgent.capabilities` | `DIDRegistry.agentCapabilities()` bitmask decoded |
| `cocAgent.lineage` | `DIDRegistry.agentLineage()` |

---

## DIDRegistry Smart Contract

**File:** `COC/contracts/governance/DIDRegistry.sol`

**Relationship to SoulRegistry:** DIDRegistry is a separate contract that references SoulRegistry via an immutable `soulRegistry` address. It does NOT modify SoulRegistry. All state-changing operations require that the caller is the `soul.owner` of the referenced `agentId` in SoulRegistry.

**EIP-712 Domain:** `name="COCDIDRegistry"`, `version="1"`, bound to `chainId` and contract address.

### Core Data Structures

> **JSON wire convention:** The tables below show both the canonical Solidity type and the actual JSON wire type returned via JSON-RPC. The wire type is determined by how the provider layer (`node/src/did/did-data-provider.ts`) converts on-chain values:
>
> - Fields that go through `BigInt(...)` in the provider become **hex strings** on the wire (e.g. `"0x1f4"` for `500`), following the EVM RPC `bigint → hex` serialization rule.
> - Fields that go through `Number(...)` in the provider stay as plain **JSON numbers**. This is chosen per field for small, bounded values (e.g. delegation/credential timestamps in seconds) where hex-string overhead is not justified.
> - `uint8` / `bool` always serialize as JSON `number` / `boolean`. `bytes32` / `address` always serialize as `0x`-prefixed hex strings.
>
> **Always check the "JSON Wire Type" column** — different structs make different choices.

#### VerificationMethod

| Field | Solidity Type | JSON Wire Type | Description |
|-------|--------------|---------------|-------------|
| `keyId` | `bytes32` | `string` (hex) | Key label hash, e.g. `keccak256("operational")` |
| `keyAddress` | `address` | `string` (hex) | Ethereum address derived from the key |
| `keyPurpose` | `uint8` | `number` | Bitmask: `0x01`=auth, `0x02`=assertion, `0x04`=capInvocation, `0x08`=capDelegation |
| `addedAt` | `uint64` | `string` (hex) | Timestamp when key was added |
| `revokedAt` | `uint64` | `string` (hex) | Timestamp when revoked (`0x0` = active) |
| `active` | `bool` | `boolean` | Whether the key is currently active |

#### DelegationRecord

| Field | Solidity Type | JSON Wire Type | Description |
|-------|--------------|---------------|-------------|
| `delegationId` | `bytes32` | `string` (hex) | Unique delegation ID (added by RPC layer) |
| `delegator` | `bytes32` | `string` (hex) | agentId of the delegating agent |
| `delegatee` | `bytes32` | `string` (hex) | agentId of the receiving agent |
| `parentDelegation` | `bytes32` | `string` (hex) | Parent delegation ID (`bytes32(0)` for root) |
| `scopeHash` | `bytes32` | `string` (hex) | `keccak256` of canonical scope encoding |
| `issuedAt` | `uint64` | `number` | Issuance timestamp (Unix seconds) |
| `expiresAt` | `uint64` | `number` | Expiration timestamp (Unix seconds) |
| `depth` | `uint8` | `number` | Chain depth (0 = direct from principal) |
| `revoked` | `bool` | `boolean` | Revocation flag |
| `_readError` | — | `boolean?` | **RPC-only field**: `true` when this delegation record could not be read from chain. Other fields (except `delegationId`) are zero-valued stubs. Consumers should skip or retry these records. |

#### EphemeralIdentity

| Field | Solidity Type | JSON Wire Type | Description |
|-------|--------------|---------------|-------------|
| `parentAgentId` | `bytes32` | `string` (hex) | Parent agent's soul ID |
| `ephemeralAddress` | `address` | `string` (hex) | Temporary address for the sub-identity |
| `scopeHash` | `bytes32` | `string` (hex) | Scope limitation hash |
| `createdAt` | `uint64` | `string` (hex) | Creation timestamp |
| `expiresAt` | `uint64` | `string` (hex) | Auto-expiration timestamp |
| `active` | `bool` | `boolean` | Whether currently active |

#### Lineage

| Field | Solidity Type | JSON Wire Type | Description |
|-------|--------------|---------------|-------------|
| `parentAgentId` | `bytes32` | `string` (hex) | Parent agent ID (`bytes32(0)` for genesis) |
| `forkHeight` | `uint256` | `string` (hex) | Block height at which the agent was forked |
| `generation` | `uint16` | `number` | Generation number (0 = root) |

#### CredentialAnchor

| Field | Solidity Type | JSON Wire Type | Description |
|-------|--------------|---------------|-------------|
| `credentialHash` | `bytes32` | `string` (hex) | `keccak256` of the full credential |
| `issuerAgentId` | `bytes32` | `string` (hex) | Issuer's soul ID |
| `subjectAgentId` | `bytes32` | `string` (hex) | Subject's soul ID |
| `credentialCid` | `bytes32` | `string` (hex) | IPFS CID hash of the credential |
| `issuedAt` | `uint64` | `number` | Issuance timestamp (Unix seconds) |
| `expiresAt` | `uint64` | `number` | Expiration timestamp (Unix seconds) |
| `revoked` | `bool` | `boolean` | Revocation flag |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_DELEGATION_DEPTH` | `3` | Maximum delegation chain depth |
| `MIN_DELEGATION_INTERVAL` | `60` seconds | Rate-limiting between delegation grants |
| `MAX_VERIFICATION_METHODS` | `8` | Max keys per agent |
| `MAX_DELEGATIONS_PER_AGENT` | `32` | Max outbound delegations per agent |

### EIP-712 Type Definitions

```
UpdateDIDDocument(bytes32 agentId, bytes32 newDocumentCid, uint64 nonce)
AddVerificationMethod(bytes32 agentId, bytes32 keyId, address keyAddress, uint8 keyPurpose, uint64 nonce)
RevokeVerificationMethod(bytes32 agentId, bytes32 keyId, uint64 nonce)
GrantDelegation(bytes32 delegator, bytes32 delegatee, bytes32 parentDelegation, bytes32 scopeHash, uint64 expiresAt, uint8 depth, uint64 nonce)
RevokeDelegation(bytes32 delegationId, uint64 nonce)
CreateEphemeralIdentity(bytes32 parentAgentId, bytes32 ephemeralId, address ephemeralAddress, bytes32 scopeHash, uint64 expiresAt, uint64 nonce)
AnchorCredential(bytes32 credentialHash, bytes32 issuerAgentId, bytes32 subjectAgentId, bytes32 credentialCid, uint64 expiresAt, uint64 nonce)
```

### Write Operations

| Function | Description | Access Control |
|----------|-------------|----------------|
| `updateDIDDocument(agentId, newCid, sig)` | Update DID document CID | Owner + EIP-712 sig |
| `addVerificationMethod(agentId, keyId, keyAddress, keyPurpose, sig)` | Add a new key | Owner + EIP-712 sig |
| `revokeVerificationMethod(agentId, keyId, sig)` | Revoke an active key | Owner + EIP-712 sig |
| `grantDelegation(delegator, delegatee, parent, scopeHash, expiresAt, depth, sig)` | Grant a delegation credential | Owner + EIP-712 sig |
| `revokeDelegation(delegationId, sig)` | Revoke a specific delegation | Delegator owner + EIP-712 sig |
| `revokeAllDelegations(agentId)` | Emergency: invalidate all delegations | Owner |
| `updateCapabilities(agentId, capabilities)` | Update capability bitmask | Owner |
| `createEphemeralIdentity(parentAgentId, ephemeralId, ephemeralAddress, scopeHash, expiresAt, sig)` | Create temporary sub-identity | Owner + EIP-712 sig |
| `deactivateEphemeralIdentity(ephemeralId)` | Deactivate ephemeral identity | Parent owner |
| `recordLineage(agentId, parentAgentId, forkHeight, generation)` | Record fork relationship | Owner |
| `anchorCredential(credentialHash, issuerAgentId, subjectAgentId, credentialCid, expiresAt, sig)` | Anchor a verifiable credential | Issuer owner + EIP-712 sig |
| `revokeCredential(credentialId)` | Revoke a credential | Issuer owner |

### View Functions

| Function | Returns |
|----------|---------|
| `didDocumentCid(agentId)` | DID document IPFS CID hash |
| `getVerificationMethods(agentId)` | All verification methods (including revoked) |
| `getActiveVerificationMethods(agentId)` | Only active verification methods |
| `delegations(delegationId)` | Delegation record |
| `getAgentDelegations(agentId)` | Array of delegation IDs issued by agent |
| `isDelegationValid(delegationId)` | Boolean validity check (expiry + revocation + global epoch) |
| `agentCapabilities(agentId)` | Capability bitmask |
| `ephemeralIdentities(ephemeralId)` | Ephemeral identity record |
| `agentLineage(agentId)` | Lineage record |
| `credentials(credentialId)` | Credential anchor record |
| `globalRevocationEpoch(agentId)` | Timestamp before which all delegations are void |

### Events

| Event | Trigger |
|-------|---------|
| `DIDDocumentUpdated(agentId, newCid)` | DID document CID updated |
| `VerificationMethodAdded(agentId, keyId, keyAddress, purpose)` | New key added |
| `VerificationMethodRevoked(agentId, keyId)` | Key revoked |
| `DelegationGranted(delegationId, delegator, delegatee, expiresAt)` | Delegation created |
| `DelegationRevoked(delegationId)` | Delegation revoked |
| `GlobalRevocationSet(agentId, epoch)` | All delegations before epoch invalidated |
| `EphemeralIdentityCreated(parentAgentId, ephemeralId)` | Ephemeral identity created |
| `EphemeralIdentityDeactivated(ephemeralId)` | Ephemeral identity deactivated |
| `CapabilitiesUpdated(agentId, capabilities)` | Capability bitmask changed |
| `LineageRecorded(agentId, parentAgentId, generation)` | Lineage recorded |
| `CredentialAnchored(credentialId, issuer, subject)` | Credential hash anchored |
| `CredentialRevoked(credentialId)` | Credential revoked |

---

## Key Management

### Key Hierarchy

```
Master Key (Cold)  ←── SoulRegistry.soul.owner
  ├── Operational Key (Hot)  ←── DIDRegistry verification method (keyPurpose=0x03)
  ├── Delegation Key         ←── DIDRegistry verification method (keyPurpose=0x08)
  ├── Recovery Key           ←── SoulRegistry.resurrectionKeyHash
  └── Session Keys (Ephemeral) ←── ECDH-derived per connection
```

### Key Rotation

DID is anchored to `agentId` (bytes32), NOT to any specific key. Rotation flow:

1. Owner signs `AddVerificationMethod` with master key to register the new operational key
2. Owner signs `RevokeVerificationMethod` to deactivate the old key
3. Peers re-resolve the DID Document to discover the updated key set
4. Previously signed delegation credentials remain valid until expiry (they reference `agentId`, not key addresses)

### Key Recovery

Leverages the existing SoulRegistry guardian system:

1. Guardian initiates recovery via `SoulRegistry.initiateRecovery()`
2. 2/3 guardian quorum approves within the 1-day time lock
3. Ownership transfers to `newOwner` via `SoulRegistry.completeRecovery()`
4. New owner registers fresh keys in DIDRegistry

---

## Delegation Framework

### Scope Language

Scopes define what a delegatee is authorized to do:

```typescript
interface DelegationScope {
  resource: string     // URI pattern: "pose:receipt:*", "ipfs:cid:<CID>", "rpc:method:eth_*"
  action: string       // "submit" | "read" | "write" | "challenge" | "witness" | "*"
  constraints?: {
    epochMin?: bigint   // Minimum epoch
    epochMax?: bigint   // Maximum epoch
    maxValue?: bigint   // Max value for value-bearing operations
    nodeIds?: Hex32[]   // Restrict to specific nodes
  }
}
```

**Examples:**

| Scope | Meaning |
|-------|---------|
| `{ resource: "pose:receipt:*", action: "submit" }` | Can submit PoSe receipts |
| `{ resource: "ipfs:cid:QmXyz", action: "read" }` | Can read specific IPFS data |
| `{ resource: "*", action: "*" }` | Full access (root delegation) |
| `{ resource: "delegation:create", action: "write" }` | Can create sub-delegations |

The `scopeHash` stored on-chain is `keccak256(canonicalEncode(scopes))`. The full scopes array is stored off-chain (IPFS or direct transmission).

### Delegation Chain Rules

```
Agent A (principal)
  └─ delegates to Agent B (depth=0, scopes=[pose:*, delegation:create])
       └─ B delegates to Agent C (depth=1, scopes=[pose:receipt:*])
            └─ C delegates to Agent D (depth=2, scopes=[pose:receipt:submit])
```

| Rule | Description |
|------|-------------|
| **Scope narrowing** | Child scope MUST be a subset of parent scope |
| **Depth increment** | `child.depth = parent.depth + 1`; max depth = 3 |
| **Expiry ceiling** | `child.expiresAt <= parent.expiresAt` |
| **Re-delegation authority** | Parent must include `{ resource: "delegation:create", action: "write" }` |
| **Cascading revocation** | Revoking A→B automatically invalidates B→C and C→D |
| **Global revocation** | `revokeAllDelegations()` sets epoch; all prior delegations void |

### Delegation Proof

When a delegatee acts on behalf of a principal, it presents a `DelegationProof`:

```typescript
interface DelegationProof {
  chain: DelegationCredential[]  // [A→B, B→C, C→D]
  leafAction: { resource: string; action: string; payload: unknown }
  proofTimestamp: bigint
  proofSignature: `0x${string}`  // Leaf delegatee signs the proof envelope
}
```

**Verification algorithm:**

1. Walk chain from index 0 (root) to N (leaf)
2. At each step verify: depth == index, not expired, not revoked, not globally revoked
3. For i > 0: verify parent reference, chain continuity (parent.delegatee == child.delegator), expiry ceiling, scope subset, re-delegation authority
4. Optionally verify EIP-712 signature at each step
5. Final check: leaf delegation scopes cover the requested action

---

## Verifiable Credentials

### Credential Types

| Type | Issuer | Purpose |
|------|--------|---------|
| `AgentCapabilityCredential` | Self-signed or DAO | Declares agent capabilities |
| `NodeOperatorCredential` | PoSeManagerV2 (implicit) | Node operator identity |
| `ReputationCredential` | Epoch Aggregator | PoSe score, uptime history |
| `ServiceLevelCredential` | Self-signed + stake | SLA commitments |
| `AuditCredential` | DAO-certified auditor | Code audit results |

### Credential Structure

```typescript
interface VerifiableCredential {
  "@context": ["https://www.w3.org/2018/credentials/v1", "https://coc.chain/credentials/v1"]
  type: string[]
  issuer: Hex32            // agentId
  issuanceDate: string     // ISO 8601
  expirationDate?: string
  credentialSubject: {
    id: Hex32              // subject agentId
    [key: string]: unknown // type-specific claims
  }
  proof: {
    type: "EIP712Signature2024"
    created: string
    verificationMethod: string  // "did:coc:<issuerAgentId>#operationalKey"
    proofValue: `0x${string}`
    eip712Domain: { name, version, chainId, verifyingContract }
  }
  onChainAnchor?: {
    txHash: `0x${string}`
    credentialHash: Hex32
    blockNumber: bigint
  }
}
```

### Selective Disclosure

Uses a Merkle-tree-based scheme compatible with the existing `MerkleProofLite.sol`:

1. Each field in `credentialSubject` is independently hashed as a leaf: `SHA-256(0x00 || fieldName || fieldValue)`
2. Internal nodes use domain separation: `SHA-256(0x01 || leftHash || rightHash)`
3. The credential stores the Merkle root of all field hashes
4. To disclose a specific field, the holder provides the field value + Merkle proof
5. The verifier recomputes the leaf hash and walks the proof to the root

```typescript
interface SelectiveDisclosure {
  credentialHash: Hex32
  disclosedFields: Array<{
    fieldName: string
    fieldValue: unknown
    merkleProof: Hex32[]
  }>
  fieldMerkleRoot: Hex32
}
```

**Example:** An agent can prove "my PoSe score >= 90" by disclosing only the `score` field from a `ReputationCredential`, without revealing uptime percentiles, slash history, or other attributes.

---

## Capability Bitmask

Agent capabilities are declared as a 16-bit bitmask on-chain:

| Bit | Flag | Capability |
|-----|------|-----------|
| 0 | `0x0001` | `storage` — IPFS-compatible storage service |
| 1 | `0x0002` | `compute` — General computation |
| 2 | `0x0004` | `validation` — Block validation |
| 3 | `0x0008` | `challenge` — PoSe challenge issuance |
| 4 | `0x0010` | `aggregation` — Batch aggregation |
| 5 | `0x0020` | `witness` — Witness attestation |
| 6 | `0x0040` | `relay` — Transaction/block relay |
| 7 | `0x0080` | `backup` — Soul backup service |
| 8 | `0x0100` | `governance` — Governance voting |
| 9 | `0x0200` | `ipfs_pin` — IPFS pinning service |
| 10 | `0x0400` | `dns_seed` — DNS seed node |
| 11 | `0x0800` | `faucet` — Testnet faucet |

---

## Protocol Integration

### Wire Protocol Enhancement (Backward Compatible)

The existing `HandshakePayload` in `wire-server.ts` / `wire-client.ts` is extended with optional fields:

```typescript
interface HandshakePayload {
  // Original fields (unchanged)
  nodeId: string; chainId: number; height: string;
  publicKey?: string; nonce?: string; signature?: string;
  // DID extensions (optional)
  did?: string;        // "did:coc:0x..."
  didProof?: string;   // EIP-712 signature proving DID control
}
```

Nodes without DID support simply omit these fields. DID-aware nodes resolve the DID and verify `didProof` against the document's authentication methods.

### P2P Auth Enhancement (Backward Compatible)

The existing `P2PAuthEnvelope` in `p2p.ts` gains optional DID fields:

```typescript
interface P2PAuthEnvelope {
  // Original fields (unchanged)
  senderId: string; timestampMs: number; nonce: string; signature: string;
  // DID extensions (optional)
  did?: string;
  delegationChain?: DelegationCredential[];
}
```

### DID Authentication Flow

```
Initiator                                    Responder
    │                                            │
    │  HandshakeInit { nodeId, did, nonce, sig } │
    │───────────────────────────────────────────>│
    │                                            │  resolve(did) → DID Document
    │                                            │  verify sig against auth methods
    │                                            │
    │  HandshakeAck { nodeId, did, nonce, sig }  │
    │<───────────────────────────────────────────│
    │                                            │
    │  resolve(did) → DID Document               │
    │  verify sig against auth methods           │
    │                                            │
    │  ═══ Mutually Authenticated Session ═══    │
```

### Node Configuration

New fields in `config.ts`:

| Config Key | Type | Default | Description |
|------------|------|---------|-------------|
| `didRegistryAddress` | `string?` | — | DIDRegistry contract address |
| `didEnabled` | `boolean` | `false` | Enable DID features |
| `didAuthMode` | `"off" \| "optional" \| "required"` | `"off"` | DID auth enforcement for Wire/P2P |

### RPC Methods

| Method | Parameters | Returns |
|--------|-----------|---------|
| `coc_resolveDid` | `did: string` | `DIDResolutionResult` |
| `coc_getDIDDocument` | `agentId: string` | `DIDDocument \| null` |
| `coc_getAgentCapabilities` | `agentId: string` | `{ capabilities: string[], bitmask: number }` |
| `coc_getDelegations` | `agentId: string` | `DelegationRecord[]` (includes `_readError: true` on partial read failures) |
| `coc_getAgentLineage` | `agentId: string` | `Lineage \| null` |
| `coc_getCredentialAnchor` | `credentialId: string` | `{ valid: boolean, error?: string, anchor?: CredentialAnchor }` — checks on-chain anchor only (existence/revocation/expiry). Full VC verification (signatures, proofs, content) requires fetching the credential from IPFS and using `verifiable-credentials.ts`. |
| `coc_getVerificationMethods` | `agentId: string` | `VerificationMethod[]` |

---

## Security Considerations

| Threat | Mitigation |
|--------|-----------|
| **Key compromise** | Guardian 2/3 quorum recovery via SoulRegistry (1-day time lock) |
| **Delegation abuse** | Depth ≤ 3, mandatory scope narrowing, time-bound expiry, instant revocation |
| **Sybil attacks** | PoSe bond requirement + endpoint uniqueness + machine fingerprint + 1 owner:1 soul |
| **Delegation spam** | MIN_DELEGATION_INTERVAL = 60s + MAX_DELEGATIONS_PER_AGENT = 32 |
| **Replay attacks** | Per-agentId EIP-712 nonces + chainId domain isolation |
| **Correlation analysis** | Ephemeral sub-identities + selective disclosure |
| **Scope escalation** | On-chain depth + expiry enforcement; off-chain scope subset verification |
| **Global compromise** | `revokeAllDelegations()` sets epoch, instantly invalidating all prior delegations |

---

## Tests

### Node Layer Tests

**File:** `COC/node/src/did/*.test.ts` (79 tests, 4 files)

| Test File | Tests | Coverage |
|-----------|-------|---------|
| `did-document-builder.test.ts` | 13 | DID Document construction, guardian controllers, resurrection keys, verification methods, capabilities, lineage, service endpoints, CID handling |
| `did-resolver.test.ts` | 18 | DID parsing, formatting, resolution (active/inactive/not found/invalid/wrong chain), guardian integration, metadata |
| `delegation-chain.test.ts` | 25 | Scope matching (exact, wildcard, constraints), scope subset, scope hashing, chain verification (1-hop, 2-hop, expired, revoked, global revocation, scope widening, depth mismatch, delegation authority), proof verification |
| `did-auth.test.ts` | 12 | Auth message format, sign/verify round-trip, DID-enhanced detection (Wire/P2P), peer verification (valid, invalid format, unknown agent, wrong signature) |
| `verifiable-credentials.test.ts` | 11 | Credential hashing (deterministic, unique), Merkle tree (multi-field, single, empty, deterministic), selective disclosure (single/multi-field, tampered value, wrong root) |

### Contract Tests

**File:** `COC/contracts/test/DIDRegistry.test.cjs` (24 tests)

Covers: DID document CRUD, verification method add/revoke/duplicate, delegation grant/revoke/revokeAll/rate-limiting/depth-limit, capability update, ephemeral identity create/deactivate/duplicate, lineage recording, credential anchor/revoke, access control (non-owner rejection), EIP-712 signature verification.

---

## File Inventory

### New Files

| File | Lines | Description |
|------|-------|-------------|
| `contracts/governance/DIDRegistry.sol` | ~600 | Core DID smart contract |
| `contracts/test/DIDRegistry.test.cjs` | ~700 | Hardhat test suite |
| `contracts/deploy/deploy-did-registry.ts` | ~110 | Deployment script |
| `node/src/crypto/did-registry-types.ts` | ~100 | EIP-712 type definitions |
| `node/src/did/did-types.ts` | ~190 | W3C DID Core types |
| `node/src/did/did-resolver.ts` | ~140 | DID Resolver |
| `node/src/did/did-document-builder.ts` | ~180 | DID Document Builder |
| `node/src/did/did-auth.ts` | ~160 | DID Authentication |
| `node/src/did/delegation-chain.ts` | ~240 | Delegation chain verification |
| `node/src/did/verifiable-credentials.ts` | ~270 | Verifiable Credentials + selective disclosure |
| `node/src/did/*.test.ts` | ~800 | 4 test files, 79 tests |
| `explorer/src/app/did/page.tsx` | ~80 | Explorer DID search page |
| `explorer/src/app/did/[id]/page.tsx` | ~190 | Explorer DID detail page |

### Modified Files

| File | Change |
|------|--------|
| `node/src/wire-server.ts` | HandshakePayload + `did`/`didProof` optional fields |
| `node/src/wire-client.ts` | HandshakePayload + `did`/`didProof` optional fields |
| `node/src/p2p.ts` | P2PAuthEnvelope + `did`/`delegationChain` optional fields |
| `node/src/config.ts` | + `didRegistryAddress`, `didEnabled`, `didAuthMode` |
| `explorer/src/app/layout.tsx` | + DID navigation link |
