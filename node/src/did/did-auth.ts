// DID-based authentication for Wire protocol and P2P communication.
// Provides challenge-response authentication using DID resolution.

import type { Hex32, DIDDocument, DelegationCredential } from "./did-types.ts"
import type { DIDDataProvider } from "./did-resolver.ts"
import { createDIDResolver, parseDID, formatDID } from "./did-resolver.ts"
import type { NodeSigner, SignatureVerifier } from "../crypto/signer.ts"
import { keccak256, toUtf8Bytes } from "ethers"

// --- DID Auth challenge-response ---

export interface DIDAuthChallenge {
  did: string
  challenge: string       // random nonce
  timestampMs: bigint
}

export interface DIDAuthResponse {
  did: string
  challenge: string
  signature: string       // sign("did-auth:{did}:{challenge}:{timestampMs}")
  delegationChain?: DelegationCredential[]
}

export function buildDIDAuthMessage(did: string, challenge: string, timestampMs: bigint): string {
  return `did-auth:${did}:${challenge}:${timestampMs.toString()}`
}

export function signDIDAuth(
  did: string,
  challenge: string,
  timestampMs: bigint,
  signer: NodeSigner,
): DIDAuthResponse {
  const message = buildDIDAuthMessage(did, challenge, timestampMs)
  const signature = signer.sign(message)
  return { did, challenge, signature }
}

export function verifyDIDAuth(
  response: DIDAuthResponse,
  timestampMs: bigint,
  verifier: SignatureVerifier,
  expectedAddress: string,
  maxClockSkewMs = 300_000, // 5 minutes
): boolean {
  // Verify timestamp freshness
  const diff = timestampMs > 0n
    ? (timestampMs > BigInt(Date.now()) ? timestampMs - BigInt(Date.now()) : BigInt(Date.now()) - timestampMs)
    : 0n
  if (diff > BigInt(maxClockSkewMs)) return false

  const message = buildDIDAuthMessage(response.did, response.challenge, timestampMs)
  return verifier.verifyNodeSig(message, response.signature, expectedAddress)
}

// --- Enhanced handshake payload ---

export interface DIDHandshakePayload {
  // Original wire handshake fields
  nodeId: string
  chainId: number
  height: string
  publicKey?: string
  nonce?: string
  signature?: string
  // DID extensions (all optional for backward compatibility)
  did?: string
  didProof?: string
  delegationChain?: DelegationCredential[]
}

export function isDIDEnhanced(payload: DIDHandshakePayload): boolean {
  return payload.did !== undefined && payload.did.startsWith("did:coc:")
}

// --- DID-enhanced P2P auth envelope ---

export interface DIDP2PAuthEnvelope {
  path: string
  senderId: string
  timestampMs: number
  nonce: string
  signature: string
  // DID extensions
  did?: string
  delegationChain?: DelegationCredential[]
  [key: string]: unknown
}

export function isDIDEnhancedP2P(envelope: DIDP2PAuthEnvelope): boolean {
  return envelope.did !== undefined && envelope.did.startsWith("did:coc:")
}

// --- DID-based peer verification ---

export interface DIDPeerVerificationResult {
  verified: boolean
  did?: string
  agentId?: Hex32
  ownerAddress?: string
  error?: string
}

export async function verifyDIDPeer(
  did: string,
  signature: string,
  challenge: string,
  timestampMs: bigint,
  provider: DIDDataProvider,
  verifier: SignatureVerifier,
  chainId: number,
): Promise<DIDPeerVerificationResult> {
  const parsed = parseDID(did)
  if (!parsed) {
    return { verified: false, error: "invalid DID format" }
  }

  const resolver = createDIDResolver({ defaultChainId: chainId, provider })
  const result = await resolver.resolve(did)

  if (!result.didDocument) {
    return { verified: false, error: result.didResolutionMetadata.error ?? "DID not found" }
  }

  // Find the owner address from verification methods
  const authMethods = result.didDocument.verificationMethod?.filter(vm => {
    const refs = result.didDocument!.authentication as string[] | undefined
    if (!refs) return false
    const vmId = vm.id.includes("#") ? "#" + vm.id.split("#")[1] : vm.id
    return refs.includes(vmId) || refs.includes(vm.id)
  })

  if (!authMethods || authMethods.length === 0) {
    return { verified: false, error: "no authentication methods found" }
  }

  // Try each auth method until one succeeds
  for (const vm of authMethods) {
    const address = extractAddressFromVM(vm)
    if (!address) continue

    const message = buildDIDAuthMessage(did, challenge, timestampMs)
    if (verifier.verifyNodeSig(message, signature, address)) {
      return {
        verified: true,
        did,
        agentId: parsed.identifier,
        ownerAddress: address,
      }
    }
  }

  return { verified: false, error: "signature verification failed for all auth methods" }
}

function extractAddressFromVM(vm: { blockchainAccountId?: string; publicKeyHex?: string }): string | null {
  if (vm.blockchainAccountId) {
    // Format: eip155:<chainId>:<address>
    const parts = vm.blockchainAccountId.split(":")
    if (parts.length >= 3) return parts[2].toLowerCase()
  }
  return null
}
