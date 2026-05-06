// EIP-712 typed data definitions for COC DIDRegistry contract.
// Each type mirrors a Solidity struct for hashStruct consistency.

import type { Eip712Domain } from "./eip712-types.ts"

export const DID_DOMAIN_NAME = "COCDIDRegistry"
export const DID_DOMAIN_VERSION = "1"

export function buildDIDDomain(chainId: bigint | number, verifyingContract: string): Eip712Domain {
  return {
    name: DID_DOMAIN_NAME,
    version: DID_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  }
}

export const UPDATE_DID_DOCUMENT_TYPES = {
  UpdateDIDDocument: [
    { name: "agentId", type: "bytes32" },
    { name: "newDocumentCid", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const ADD_VERIFICATION_METHOD_TYPES = {
  AddVerificationMethod: [
    { name: "agentId", type: "bytes32" },
    { name: "keyId", type: "bytes32" },
    { name: "keyAddress", type: "address" },
    { name: "keyPurpose", type: "uint8" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const REVOKE_VERIFICATION_METHOD_TYPES = {
  RevokeVerificationMethod: [
    { name: "agentId", type: "bytes32" },
    { name: "keyId", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const GRANT_DELEGATION_TYPES = {
  GrantDelegation: [
    { name: "delegator", type: "bytes32" },
    { name: "delegatee", type: "bytes32" },
    { name: "parentDelegation", type: "bytes32" },
    { name: "scopeHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "depth", type: "uint8" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const REVOKE_DELEGATION_TYPES = {
  RevokeDelegation: [
    { name: "delegationId", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const CREATE_EPHEMERAL_IDENTITY_TYPES = {
  CreateEphemeralIdentity: [
    { name: "parentAgentId", type: "bytes32" },
    { name: "ephemeralId", type: "bytes32" },
    { name: "ephemeralAddress", type: "address" },
    { name: "scopeHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const ANCHOR_CREDENTIAL_TYPES = {
  AnchorCredential: [
    { name: "credentialHash", type: "bytes32" },
    { name: "issuerAgentId", type: "bytes32" },
    { name: "subjectAgentId", type: "bytes32" },
    { name: "credentialCid", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const

// Key purpose bitmask values
export const KEY_PURPOSE = {
  AUTHENTICATION:       0x01,
  ASSERTION:            0x02,
  CAPABILITY_INVOCATION: 0x04,
  CAPABILITY_DELEGATION: 0x08,
} as const

export type KeyPurpose = typeof KEY_PURPOSE[keyof typeof KEY_PURPOSE]
