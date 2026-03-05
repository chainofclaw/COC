// PoSe v2 protocol message types.
// Adds EIP-712 signatures, witness attestations, tip binding, and result codes.

import type { Hex32, ChallengeType } from "./pose-types.ts"

export const PROTOCOL_VERSION_V2 = 2

// Result codes for evidence leaves (mirrors Solidity uint8)
export const ResultCode = {
  Ok: 0,
  Timeout: 1,
  InvalidSig: 2,
  StorageProofFail: 3,
  RelayWitnessFail: 4,
  TipMismatch: 5,
  NonceMismatch: 6,
  WitnessQuorumFail: 7,
} as const

export type ResultCode = (typeof ResultCode)[keyof typeof ResultCode]

// Fault types for permissionless fault proofs
export const FaultType = {
  DoubleSig: 1,
  InvalidSig: 2,
  TimeoutMiss: 3,
  BatchForgery: 4,
} as const

export type FaultType = (typeof FaultType)[keyof typeof FaultType]

// v2 challenge message — adds version, challengeNonce, querySpecHash
export interface ChallengeMessageV2 {
  version: 2
  challengeId: Hex32
  epochId: bigint
  nodeId: Hex32
  challengeType: ChallengeType
  nonce: `0x${string}`
  challengeNonce: bigint
  querySpec: Record<string, unknown>
  querySpecHash: Hex32
  issuedAtMs: bigint
  deadlineMs: number
  challengerId: Hex32
  challengerSig: `0x${string}`
}

// v2 receipt — adds tipHash, tipHeight, responseBodyHash
export interface ReceiptMessageV2 {
  challengeId: Hex32
  nodeId: Hex32
  responseAtMs: bigint
  responseBody: Record<string, unknown>
  responseBodyHash: Hex32
  tipHash: Hex32
  tipHeight: bigint
  nodeSig: `0x${string}`
}

// Witness attestation — signed by witness node
export interface WitnessAttestation {
  challengeId: Hex32
  nodeId: Hex32
  responseBodyHash: Hex32
  witnessIndex: number
  attestedAtMs: bigint
  witnessSig: `0x${string}`
}

// Evidence leaf for Merkle batch (mirrors Solidity EvidenceLeafV2 struct)
export interface EvidenceLeafV2 {
  epoch: bigint
  nodeId: Hex32
  nonce: `0x${string}`
  tipHash: Hex32
  tipHeight: bigint
  latencyMs: number
  resultCode: ResultCode
  witnessBitmap: number
}

// Reward leaf for Merkle claim tree
export interface RewardLeaf {
  epochId: bigint
  nodeId: Hex32
  amount: bigint
}

// Verified receipt v2 — combines challenge, receipt, witnesses, and evidence
export interface VerifiedReceiptV2 {
  challenge: ChallengeMessageV2
  receipt: ReceiptMessageV2
  witnesses: WitnessAttestation[]
  witnessBitmap: number
  evidenceLeaf: EvidenceLeafV2
  verifiedAtMs: bigint
}

// Fault proof for permissionless slashing
export interface FaultProof {
  batchId: Hex32
  faultType: FaultType
  evidenceLeafHash: Hex32
  merkleProof: Hex32[]
  evidenceData: `0x${string}`
  challengerSig: `0x${string}`
}
