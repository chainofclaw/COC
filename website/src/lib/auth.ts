import { ethers } from 'ethers'

export interface AuthPayload {
  address: string
  signature: string
  message: string
}

/// Verify EIP-191 personal_sign signature and return the recovered address
export function verifySignature(message: string, signature: string): string {
  return ethers.verifyMessage(message, signature)
}

/// Verify that the signature was produced by the claimed address
export function verifyAuth(payload: AuthPayload): boolean {
  const recovered = verifySignature(payload.message, payload.signature)
  return recovered.toLowerCase() === payload.address.toLowerCase()
}

/// Build a deterministic signing message for forum actions
export function buildSignMessage(action: string, data: Record<string, unknown>): string {
  const sorted = Object.keys(data).sort().reduce((acc, key) => {
    return { ...acc, [key]: data[key] }
  }, {} as Record<string, unknown>)
  return `COC Forum ${action}\n${JSON.stringify(sorted)}`
}
