// EIP-712 typed data definitions for COC PoSe v2 protocol.
// Each type mirrors a Solidity struct for hashStruct consistency.

export interface Eip712Domain {
  name: string
  version: string
  chainId: bigint | number
  verifyingContract: string
}

export const POSE_DOMAIN_NAME = "COCPoSe"
export const POSE_DOMAIN_VERSION = "2"

export function buildDomain(chainId: bigint | number, verifyingContract: string): Eip712Domain {
  return {
    name: POSE_DOMAIN_NAME,
    version: POSE_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  }
}

// ethers v6 TypedDataDomain format
export function toEthersDomain(d: Eip712Domain) {
  return {
    name: d.name,
    version: d.version,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  }
}

// EIP-712 type definitions — keys are type names, values are field arrays.
// These match the Solidity structs in PoSeTypesV2.sol.

export const CHALLENGE_TYPES = {
  Challenge: [
    { name: "challengeId", type: "bytes32" },
    { name: "epochId", type: "uint64" },
    { name: "nodeId", type: "bytes32" },
    { name: "challengeType", type: "uint8" },
    { name: "nonce", type: "bytes16" },
    { name: "challengeNonce", type: "uint64" },
    { name: "querySpecHash", type: "bytes32" },
    { name: "issuedAtMs", type: "uint64" },
    { name: "deadlineMs", type: "uint64" },
    { name: "challengerId", type: "bytes32" },
  ],
} as const

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "challengeId", type: "bytes32" },
    { name: "nodeId", type: "bytes32" },
    { name: "responseAtMs", type: "uint64" },
    { name: "responseBodyHash", type: "bytes32" },
    { name: "tipHash", type: "bytes32" },
    { name: "tipHeight", type: "uint64" },
  ],
} as const

export const WITNESS_TYPES = {
  WitnessAttestation: [
    { name: "challengeId", type: "bytes32" },
    { name: "nodeId", type: "bytes32" },
    { name: "responseBodyHash", type: "bytes32" },
    { name: "witnessIndex", type: "uint8" },
  ],
} as const

export const EVIDENCE_LEAF_TYPES = {
  EvidenceLeaf: [
    { name: "epoch", type: "uint64" },
    { name: "nodeId", type: "bytes32" },
    { name: "nonce", type: "bytes16" },
    { name: "tipHash", type: "bytes32" },
    { name: "tipHeight", type: "uint64" },
    { name: "latencyMs", type: "uint32" },
    { name: "resultCode", type: "uint8" },
    { name: "witnessBitmap", type: "uint32" },
  ],
} as const

export const REWARD_LEAF_TYPES = {
  RewardLeaf: [
    { name: "epochId", type: "uint64" },
    { name: "nodeId", type: "bytes32" },
    { name: "amount", type: "uint256" },
  ],
} as const

export const REWARD_MANIFEST_TYPES = {
  RewardManifest: [
    { name: "epochId", type: "uint64" },
    { name: "rewardRoot", type: "bytes32" },
    { name: "totalReward", type: "uint256" },
    { name: "scoringInputsHash", type: "bytes32" },
  ],
} as const
