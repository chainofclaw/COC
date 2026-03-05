import { Wallet, verifyMessage, hashMessage, SigningKey } from "ethers"
import type { Hex } from "../blockchain-types.ts"

export interface NodeSigner {
  readonly nodeId: Hex
  sign(message: string): string
  signBytes(data: Uint8Array): string
}

export interface SignatureVerifier {
  verifyNodeSig(message: string, signature: string, expectedAddress: string): boolean
  recoverAddress(message: string, signature: string): string
}

export function createNodeSigner(privateKey: string): NodeSigner & SignatureVerifier {
  const wallet = new Wallet(privateKey)
  const signingKey = wallet.signingKey
  const nodeId = wallet.address.toLowerCase() as Hex

  return {
    nodeId,

    sign(message: string): string {
      const digest = hashMessage(message)
      const sig = signingKey.sign(digest)
      return sig.serialized
    },

    signBytes(data: Uint8Array): string {
      const digest = hashMessage(data)
      const sig = signingKey.sign(digest)
      return sig.serialized
    },

    verifyNodeSig(message: string, signature: string, expectedAddress: string): boolean {
      try {
        const recovered = this.recoverAddress(message, signature)
        return recovered.toLowerCase() === expectedAddress.toLowerCase()
      } catch {
        return false
      }
    },

    recoverAddress(message: string, signature: string): string {
      return verifyMessage(message, signature).toLowerCase()
    },
  }
}

// Build the canonical message for PoSe challenge signing
export function buildChallengeSignMessage(challengeId: string, epochId: bigint, nodeId: string): string {
  return `pose:challenge:${challengeId}:${epochId.toString()}:${nodeId}`
}

// Build the canonical message for PoSe receipt signing
export function buildReceiptSignMessage(
  challengeId: string,
  nodeId: string,
  responseBodyHash: string,
  responseAtMs?: bigint | number,
): string {
  const base = `pose:receipt:${challengeId}:${nodeId}:${responseBodyHash}`
  return responseAtMs !== undefined ? `${base}:${responseAtMs.toString()}` : base
}

// --- v2 EIP-712 extensions ---

import type { Eip712Signer } from "./eip712-signer.ts"
import { createEip712Signer } from "./eip712-signer.ts"
import type { Eip712Domain } from "./eip712-types.ts"

export interface NodeSignerV2 extends NodeSigner {
  readonly eip712: Eip712Signer
}

export function createNodeSignerV2(privateKey: string, domain: Eip712Domain): NodeSignerV2 & SignatureVerifier {
  const base = createNodeSigner(privateKey)
  const wallet = new Wallet(privateKey)
  const eip712 = createEip712Signer(wallet, domain)

  return {
    ...base,
    eip712,
  }
}
