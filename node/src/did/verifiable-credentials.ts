// Verifiable Credential issuance, verification, and selective disclosure for did:coc.

import { keccak256, AbiCoder, toUtf8Bytes } from "ethers"
import type { VerifiableCredential, SelectiveDisclosure, Hex32 } from "./did-types.ts"
import type { Eip712Signer } from "../crypto/eip712-signer.ts"
import { ANCHOR_CREDENTIAL_TYPES } from "../crypto/did-registry-types.ts"

// --- Credential hashing ---

export function computeCredentialHash(credential: Omit<VerifiableCredential, "proof" | "onChainAnchor">): Hex32 {
  const encoder = new AbiCoder()
  const encoded = encoder.encode(
    ["string[]", "string[]", "bytes32", "string", "string", "bytes32"],
    [
      credential["@context"],
      credential.type,
      credential.issuer,
      credential.issuanceDate,
      credential.expirationDate ?? "",
      credential.credentialSubject.id,
    ],
  )
  // Include subject fields
  const subjectKeys = Object.keys(credential.credentialSubject)
    .filter(k => k !== "id")
    .sort()
  const subjectValues = subjectKeys.map(k =>
    JSON.stringify(credential.credentialSubject[k], (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  )
  const subjectEncoded = encoder.encode(
    ["string[]", "string[]"],
    [subjectKeys, subjectValues],
  )

  return keccak256(encoder.encode(["bytes", "bytes"], [encoded, subjectEncoded])) as Hex32
}

// --- Selective disclosure: Merkle tree of credential fields ---

const LEAF_PREFIX = new Uint8Array([0x00])
const INTERNAL_PREFIX = new Uint8Array([0x01])

function hashLeaf(fieldName: string, fieldValue: unknown): Hex32 {
  const valueStr = JSON.stringify(fieldValue, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  )
  const encoder = new AbiCoder()
  const encoded = encoder.encode(["bytes1", "string", "string"], ["0x00", fieldName, valueStr])
  return keccak256(encoded) as Hex32
}

function hashInternal(left: Hex32, right: Hex32): Hex32 {
  const encoder = new AbiCoder()
  return keccak256(
    encoder.encode(["bytes1", "bytes32", "bytes32"], ["0x01", left, right]),
  ) as Hex32
}

export interface MerkleTreeResult {
  root: Hex32
  leaves: Array<{ fieldName: string; hash: Hex32; index: number }>
  proofs: Map<string, Hex32[]>
}

export function buildFieldMerkleTree(
  subject: Record<string, unknown>,
): MerkleTreeResult {
  const fieldNames = Object.keys(subject).filter(k => k !== "id").sort()

  if (fieldNames.length === 0) {
    return {
      root: keccak256(new Uint8Array(0)) as Hex32,
      leaves: [],
      proofs: new Map(),
    }
  }

  const leaves = fieldNames.map((name, index) => ({
    fieldName: name,
    hash: hashLeaf(name, subject[name]),
    index,
  }))

  // Build tree bottom-up
  let layer = leaves.map(l => l.hash)
  const proofCollector = new Map<string, Hex32[]>()
  for (const name of fieldNames) {
    proofCollector.set(name, [])
  }

  // Track which original leaf is at which position
  let leafPositions = fieldNames.map((_, i) => i)

  while (layer.length > 1) {
    const nextLayer: Hex32[] = []
    const nextPositions: number[][] = []

    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        const parent = hashInternal(layer[i], layer[i + 1])
        nextLayer.push(parent)

        // Add sibling to proof for all leaves in left subtree
        for (let j = 0; j < leafPositions.length; j++) {
          if (leafPositions[j] === i) {
            proofCollector.get(fieldNames[j])!.push(layer[i + 1])
            leafPositions[j] = nextLayer.length - 1
          } else if (leafPositions[j] === i + 1) {
            proofCollector.get(fieldNames[j])!.push(layer[i])
            leafPositions[j] = nextLayer.length - 1
          }
        }
      } else {
        // Odd leaf: pair with itself
        const parent = hashInternal(layer[i], layer[i])
        nextLayer.push(parent)
        for (let j = 0; j < leafPositions.length; j++) {
          if (leafPositions[j] === i) {
            proofCollector.get(fieldNames[j])!.push(layer[i])
            leafPositions[j] = nextLayer.length - 1
          }
        }
      }
    }

    layer = nextLayer
  }

  return {
    root: layer[0],
    leaves,
    proofs: proofCollector,
  }
}

// --- Verify selective disclosure ---

export function verifySelectiveDisclosure(
  disclosure: SelectiveDisclosure,
): boolean {
  for (const field of disclosure.disclosedFields) {
    const leafHash = hashLeaf(field.fieldName, field.fieldValue)

    // Walk proof up to root
    let current = leafHash
    for (const sibling of field.merkleProof) {
      // Deterministic ordering: smaller hash first
      if (current < sibling) {
        current = hashInternal(current, sibling)
      } else {
        current = hashInternal(sibling, current)
      }
    }

    if (current !== disclosure.fieldMerkleRoot) {
      return false
    }
  }

  return true
}

// --- Credential issuance ---

export async function issueCredential(
  params: {
    context: string[]
    type: string[]
    issuerAgentId: Hex32
    subjectAgentId: Hex32
    claims: Record<string, unknown>
    expirationDate?: string
    verificationMethodId: string
    eip712Domain: { name: string; version: string; chainId: number; verifyingContract: string }
  },
  signer: Eip712Signer,
): Promise<VerifiableCredential> {
  const now = new Date().toISOString()

  const credential: VerifiableCredential = {
    "@context": params.context,
    type: params.type,
    issuer: params.issuerAgentId,
    issuanceDate: now,
    expirationDate: params.expirationDate,
    credentialSubject: {
      id: params.subjectAgentId,
      ...params.claims,
    },
    proof: {
      type: "EIP712Signature2024",
      created: now,
      verificationMethod: params.verificationMethodId,
      proofValue: "0x" as `0x${string}`,
      eip712Domain: params.eip712Domain,
    },
  }

  const credentialHash = computeCredentialHash(credential)

  // Sign the credential hash using EIP-712
  const sig = await signer.signTypedData(ANCHOR_CREDENTIAL_TYPES, {
    credentialHash,
    issuerAgentId: params.issuerAgentId,
    subjectAgentId: params.subjectAgentId,
    credentialCid: credentialHash, // placeholder, real CID set after IPFS pin
    expiresAt: params.expirationDate
      ? BigInt(Math.floor(new Date(params.expirationDate).getTime() / 1000))
      : 0n,
    nonce: 0n,
  })

  return {
    ...credential,
    proof: {
      ...credential.proof,
      proofValue: sig as `0x${string}`,
    },
  }
}

// --- Credential verification ---

export interface CredentialVerificationContext {
  resolveIssuerOwner(issuerAgentId: Hex32): Promise<string | null>
  isCredentialRevoked?(credentialId: Hex32): Promise<boolean>
}

export interface CredentialVerificationResult {
  valid: boolean
  error?: string
}

export async function verifyCredential(
  credential: VerifiableCredential,
  context: CredentialVerificationContext,
  eip712Verifier?: Eip712Signer,
): Promise<CredentialVerificationResult> {
  // Check expiry
  if (credential.expirationDate) {
    const expiryMs = new Date(credential.expirationDate).getTime()
    if (Date.now() > expiryMs) {
      return { valid: false, error: "credential expired" }
    }
  }

  // Check on-chain revocation
  if (credential.onChainAnchor && context.isCredentialRevoked) {
    const revoked = await context.isCredentialRevoked(credential.onChainAnchor.credentialHash)
    if (revoked) {
      return { valid: false, error: "credential revoked on-chain" }
    }
  }

  // Verify signature
  if (eip712Verifier) {
    const issuerOwner = await context.resolveIssuerOwner(credential.issuer)
    if (!issuerOwner) {
      return { valid: false, error: "cannot resolve issuer" }
    }

    const credentialHash = computeCredentialHash(credential)
    const valid = eip712Verifier.verifyTypedData(
      ANCHOR_CREDENTIAL_TYPES,
      {
        credentialHash,
        issuerAgentId: credential.issuer,
        subjectAgentId: credential.credentialSubject.id,
        credentialCid: credentialHash,
        expiresAt: credential.expirationDate
          ? BigInt(Math.floor(new Date(credential.expirationDate).getTime() / 1000))
          : 0n,
        nonce: 0n,
      },
      credential.proof.proofValue,
      issuerOwner,
    )
    if (!valid) {
      return { valid: false, error: "invalid signature" }
    }
  }

  return { valid: true }
}
