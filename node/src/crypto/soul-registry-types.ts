// EIP-712 typed data definitions for COC SoulRegistry contract.
// Each type mirrors a Solidity struct for hashStruct consistency.

import type { Eip712Domain } from "./eip712-types.ts"

export const SOUL_DOMAIN_NAME = "COCSoulRegistry"
export const SOUL_DOMAIN_VERSION = "1"

export function buildSoulDomain(chainId: bigint | number, verifyingContract: string): Eip712Domain {
  return {
    name: SOUL_DOMAIN_NAME,
    version: SOUL_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  }
}

export const REGISTER_SOUL_TYPES = {
  RegisterSoul: [
    { name: "agentId", type: "bytes32" },
    { name: "identityCid", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const ANCHOR_BACKUP_TYPES = {
  AnchorBackup: [
    { name: "agentId", type: "bytes32" },
    { name: "manifestCid", type: "bytes32" },
    { name: "dataMerkleRoot", type: "bytes32" },
    { name: "fileCount", type: "uint32" },
    { name: "totalBytes", type: "uint64" },
    { name: "backupType", type: "uint8" },
    { name: "parentManifestCid", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const UPDATE_IDENTITY_TYPES = {
  UpdateIdentity: [
    { name: "agentId", type: "bytes32" },
    { name: "newIdentityCid", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const RESURRECT_SOUL_TYPES = {
  ResurrectSoul: [
    { name: "agentId", type: "bytes32" },
    { name: "carrierId", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const HEARTBEAT_TYPES = {
  Heartbeat: [
    { name: "agentId", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const
