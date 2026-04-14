// Builds W3C DID Documents from on-chain SoulRegistry + DIDRegistry state.

import type {
  DIDDocument,
  VerificationMethodEntry,
  ServiceEndpoint,
  CocAgentMetadata,
  Hex32,
  AgentLineage,
} from "./did-types.ts"
import {
  W3C_DID_CONTEXT,
  COC_DID_CONTEXT,
  capabilityBitmaskToNames,
} from "./did-types.ts"
import { KEY_PURPOSE } from "../crypto/did-registry-types.ts"

// On-chain data shapes (mirroring contract structs via ethers return)

export interface SoulIdentityData {
  agentId: string
  owner: string
  identityCid: string
  latestSnapshotCid: string
  registeredAt: bigint
  lastBackupAt: bigint
  backupCount: number
  version: number
  active: boolean
}

export interface GuardianData {
  guardian: string
  addedAt: bigint
  active: boolean
}

export interface ResurrectionConfigData {
  resurrectionKeyHash: string
  maxOfflineDuration: bigint
  lastHeartbeat: bigint
  configured: boolean
}

export interface VerificationMethodData {
  keyId: string
  keyAddress: string
  keyPurpose: number
  addedAt: bigint
  revokedAt: bigint
  active: boolean
}

export interface LineageData {
  parentAgentId: string
  forkHeight: bigint
  generation: number
}

export interface BuilderInput {
  chainId: number
  soul: SoulIdentityData
  guardians?: GuardianData[]
  resurrectionConfig?: ResurrectionConfigData
  verificationMethods?: VerificationMethodData[]
  capabilities?: number
  lineage?: LineageData
  services?: ServiceEndpoint[]
  didDocumentCid?: string
}

const ZERO_BYTES32 = "0x" + "00".repeat(32)

function agentIdToDid(agentId: string, chainId?: number): string {
  const id = agentId.toLowerCase()
  return chainId ? `did:coc:${chainId}:${id}` : `did:coc:${id}`
}

function addressToBlockchainAccountId(address: string, chainId: number): string {
  return `eip155:${chainId}:${address}`
}

export function buildDIDDocument(input: BuilderInput): DIDDocument {
  const { chainId, soul, guardians, resurrectionConfig, verificationMethods, capabilities, lineage, services, didDocumentCid } = input

  const did = agentIdToDid(soul.agentId, chainId)

  // Verification methods
  const vmEntries: VerificationMethodEntry[] = []
  const authRefs: string[] = []
  const assertionRefs: string[] = []
  const capInvokeRefs: string[] = []
  const capDelegateRefs: string[] = []

  // Master key: soul.owner
  const masterVm: VerificationMethodEntry = {
    id: `${did}#master`,
    type: "EcdsaSecp256k1RecoveryMethod2020",
    controller: did,
    blockchainAccountId: addressToBlockchainAccountId(soul.owner, chainId),
  }
  vmEntries.push(masterVm)
  authRefs.push("#master")
  assertionRefs.push("#master")
  capInvokeRefs.push("#master")
  capDelegateRefs.push("#master")

  // Resurrection key (if configured)
  if (resurrectionConfig?.configured && resurrectionConfig.resurrectionKeyHash !== ZERO_BYTES32) {
    const resVm: VerificationMethodEntry = {
      id: `${did}#resurrection`,
      type: "EcdsaSecp256k1RecoveryMethod2020",
      controller: did,
      publicKeyHex: resurrectionConfig.resurrectionKeyHash,
    }
    vmEntries.push(resVm)
  }

  // Additional verification methods from DIDRegistry
  if (verificationMethods) {
    for (const vm of verificationMethods) {
      if (!vm.active) continue
      const keyLabel = decodeKeyId(vm.keyId)
      const entry: VerificationMethodEntry = {
        id: `${did}#${keyLabel}`,
        type: "EcdsaSecp256k1RecoveryMethod2020",
        controller: did,
        blockchainAccountId: addressToBlockchainAccountId(vm.keyAddress, chainId),
      }
      vmEntries.push(entry)

      if (vm.keyPurpose & KEY_PURPOSE.AUTHENTICATION) authRefs.push(`#${keyLabel}`)
      if (vm.keyPurpose & KEY_PURPOSE.ASSERTION) assertionRefs.push(`#${keyLabel}`)
      if (vm.keyPurpose & KEY_PURPOSE.CAPABILITY_INVOCATION) capInvokeRefs.push(`#${keyLabel}`)
      if (vm.keyPurpose & KEY_PURPOSE.CAPABILITY_DELEGATION) capDelegateRefs.push(`#${keyLabel}`)
    }
  }

  // Controllers: self + active guardians
  const controllers: string[] = [did]
  if (guardians) {
    for (const g of guardians) {
      if (!g.active) continue
      controllers.push(g.guardian.toLowerCase())
    }
  }

  // Service endpoints
  const svcEndpoints: ServiceEndpoint[] = services ? [...services] : []

  // Agent metadata
  const agentMeta: CocAgentMetadata = {
    registeredAt: new Date(Number(soul.registeredAt) * 1000).toISOString(),
    version: soul.version,
  }

  if (soul.identityCid !== ZERO_BYTES32) {
    agentMeta.identityCid = soul.identityCid
  }
  if (soul.latestSnapshotCid !== ZERO_BYTES32) {
    agentMeta.latestSnapshotCid = soul.latestSnapshotCid
  }

  if (capabilities !== undefined && capabilities > 0) {
    agentMeta.capabilities = capabilityBitmaskToNames(capabilities)
  }

  if (lineage && lineage.parentAgentId !== ZERO_BYTES32) {
    agentMeta.lineage = {
      parent: lineage.parentAgentId as Hex32,
      forkHeight: lineage.forkHeight,
      generation: lineage.generation,
    }
  }

  // alsoKnownAs: link to off-chain DID Document if anchored on-chain
  // The contract stores a bytes32 hash — this is an opaque content identifier
  // that must be resolved via CidRegistry or similar to get the actual CID
  const alsoKnownAs = didDocumentCid && didDocumentCid !== ZERO_BYTES32
    ? [`urn:coc:did-doc:${didDocumentCid}`]
    : undefined

  const doc: DIDDocument = {
    "@context": [W3C_DID_CONTEXT, COC_DID_CONTEXT],
    id: did,
    ...(alsoKnownAs ? { alsoKnownAs } : {}),
    controller: controllers.length === 1 ? controllers[0] : controllers,
    verificationMethod: vmEntries,
    authentication: authRefs,
    assertionMethod: assertionRefs,
    capabilityInvocation: capInvokeRefs,
    capabilityDelegation: capDelegateRefs,
    service: svcEndpoints.length > 0 ? svcEndpoints : undefined,
    cocAgent: agentMeta,
  }

  return doc
}

export function buildDeactivatedDocument(agentId: string, chainId: number): DIDDocument {
  const did = agentIdToDid(agentId, chainId)
  return {
    "@context": [W3C_DID_CONTEXT, COC_DID_CONTEXT],
    id: did,
    verificationMethod: [],
    authentication: [],
    assertionMethod: [],
  }
}

// Decode a bytes32 keyId back to a human-readable label.
// Convention: keyId = keccak256(label). We store common labels for reverse lookup.
const KNOWN_KEY_LABELS = new Map<string, string>()

export function registerKeyLabel(keyId: string, label: string): void {
  KNOWN_KEY_LABELS.set(keyId.toLowerCase(), label)
}

function decodeKeyId(keyId: string): string {
  const known = KNOWN_KEY_LABELS.get(keyId.toLowerCase())
  if (known) return known
  // Fallback: use truncated hex
  return `key-${keyId.slice(2, 10)}`
}
