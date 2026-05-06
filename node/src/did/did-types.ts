// W3C DID Core v1.0 compliant types for did:coc method.
// Reference: https://www.w3.org/TR/did-core/

export type Hex32 = `0x${string}`

// --- DID Document types ---

export interface VerificationMethodEntry {
  id: string
  type: string
  controller: string
  blockchainAccountId?: string
  publicKeyHex?: string
  publicKeyMultibase?: string
}

export interface ServiceEndpoint {
  id: string
  type: string
  serviceEndpoint: string | Record<string, string>
}

export interface AgentLineage {
  parent: Hex32 | null
  forkHeight: bigint | null
  generation: number
}

export interface AgentReputation {
  poseScore: number
  epochsActive: number
  slashCount: number
  rewardsClaimed: string
}

export interface CocAgentMetadata {
  soulRegistryAddress?: string
  registeredAt?: string
  version?: number
  identityCid?: string
  latestSnapshotCid?: string
  capabilities?: string[]
  runtimeEnvironment?: { nodeVersion?: string; protocolVersion?: number }
  lineage?: AgentLineage
  reputation?: AgentReputation
}

export interface DIDDocument {
  "@context": string[]
  id: string
  alsoKnownAs?: string[]
  controller?: string | string[]
  verificationMethod?: VerificationMethodEntry[]
  authentication?: (string | VerificationMethodEntry)[]
  assertionMethod?: (string | VerificationMethodEntry)[]
  capabilityInvocation?: (string | VerificationMethodEntry)[]
  capabilityDelegation?: (string | VerificationMethodEntry)[]
  keyAgreement?: (string | VerificationMethodEntry)[]
  service?: ServiceEndpoint[]
  cocAgent?: CocAgentMetadata
}

export interface DIDResolutionMetadata {
  contentType: "application/did+json"
  error?: "notFound" | "deactivated" | "invalidDid" | "methodNotSupported"
}

export interface DIDDocumentMetadata {
  created?: string
  updated?: string
  deactivated?: boolean
  versionId?: string
}

export interface DIDResolutionResult {
  didDocument: DIDDocument | null
  didResolutionMetadata: DIDResolutionMetadata
  didDocumentMetadata: DIDDocumentMetadata
}

// --- DID Method parsing ---

export interface ParsedDID {
  method: "coc"
  chainId: number
  identifierType: "agent" | "node"
  identifier: Hex32
}

export const COC_DID_CONTEXT = "https://coc.network/ns/did/v1"
export const W3C_DID_CONTEXT = "https://www.w3.org/ns/did/v1"
export const DEFAULT_CHAIN_ID = 20241224

// Capability bitmask flags
export const CAPABILITY_FLAGS = {
  STORAGE:     0x0001,
  COMPUTE:     0x0002,
  VALIDATION:  0x0004,
  CHALLENGE:   0x0008,
  AGGREGATION: 0x0010,
  WITNESS:     0x0020,
  RELAY:       0x0040,
  BACKUP:      0x0080,
  GOVERNANCE:  0x0100,
  IPFS_PIN:    0x0200,
  DNS_SEED:    0x0400,
  FAUCET:      0x0800,
} as const

export type CapabilityFlag = typeof CAPABILITY_FLAGS[keyof typeof CAPABILITY_FLAGS]

export function capabilityBitmaskToNames(bitmask: number): string[] {
  const names: string[] = []
  for (const [name, flag] of Object.entries(CAPABILITY_FLAGS)) {
    if (bitmask & flag) names.push(name.toLowerCase())
  }
  return names
}

export function capabilityNamesToBitmask(names: readonly string[]): number {
  let bitmask = 0
  const lookup = new Map(
    Object.entries(CAPABILITY_FLAGS).map(([k, v]) => [k.toLowerCase(), v]),
  )
  for (const name of names) {
    const flag = lookup.get(name.toLowerCase())
    if (flag !== undefined) bitmask |= flag
  }
  return bitmask
}

// --- Delegation types ---

export interface DelegationScope {
  resource: string
  action: string
  constraints?: {
    epochMin?: bigint
    epochMax?: bigint
    maxValue?: bigint
    nodeIds?: Hex32[]
  }
}

export interface DelegationCredential {
  delegationId: Hex32
  delegator: Hex32
  delegatee: Hex32
  parentDelegation: Hex32
  scopeHash: Hex32
  scopes: DelegationScope[]
  issuedAt: bigint
  expiresAt: bigint
  nonce: bigint
  depth: number
  delegatorSig: `0x${string}`
}

export interface DelegationProof {
  chain: DelegationCredential[]
  leafAction: {
    resource: string
    action: string
    payload: unknown
  }
  proofTimestamp: bigint
  proofSignature: `0x${string}`
}

// --- Verifiable Credential types ---

export interface VerifiableCredential {
  "@context": string[]
  type: string[]
  issuer: Hex32
  issuanceDate: string
  expirationDate?: string
  credentialSubject: {
    id: Hex32
    [key: string]: unknown
  }
  proof: {
    type: "EIP712Signature2024"
    created: string
    verificationMethod: string
    proofValue: `0x${string}`
    eip712Domain: {
      name: string
      version: string
      chainId: number
      verifyingContract: string
    }
  }
  onChainAnchor?: {
    txHash: `0x${string}`
    credentialHash: Hex32
    blockNumber: bigint
  }
}

export interface SelectiveDisclosure {
  credentialHash: Hex32
  disclosedFields: Array<{
    fieldName: string
    fieldValue: unknown
    merkleProof: Hex32[]
  }>
  fieldMerkleRoot: Hex32
}
