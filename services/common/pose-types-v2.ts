// PoSe v2 protocol message types.
// Adds EIP-712 signatures, witness attestations, tip binding, and result codes.

import type { Hex32, ChallengeType } from "./pose-types.ts"

export const PROTOCOL_VERSION_V2 = 2

// Result codes for evidence leaves (mirrors Solidity uint8).
// Stays within the uint8 space the on-chain EvidenceLeafV2 already
// accepts (PoSeTypesV2.sol EvidenceLeafV2.resultCode is uint8), so
// Phase C2.4's new code slots in without a typehash bump or contract
// redeploy.
export const ResultCode = {
  Ok: 0,
  Timeout: 1,
  InvalidSig: 2,
  StorageProofFail: 3,
  RelayWitnessFail: 4,
  TipMismatch: 5,
  NonceMismatch: 6,
  WitnessQuorumFail: 7,
  /**
   * Phase C2.4: 5% audit sampling caught a mismatch between the
   * Merkle leaf the prover returned and the chunk bytes an
   * independent peer reproduced. Prover and DHT provider colluded
   * (or the prover fabricated a Merkle proof for bytes it doesn't
   * hold). Treated like StorageProofFail for scoring purposes, but
   * distinguished in evidence so forensic replay can tell "Merkle
   * math mismatch" apart from "bytes don't reproduce hash".
   */
  InvalidStorageAudit: 8,
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
  /**
   * Optional v2 typehash signature (#667). Includes `epochId` so the
   * signature is permanently bound to the epoch in which it was collected.
   * Witnesses produce both v1 (`witnessSig`) and v2 (`witnessSigV2`) during
   * the versioned-typehash rollout window; the contract accepts either.
   */
  witnessSigV2?: `0x${string}`
  /**
   * Optional v3 typehash signature (#746). Adds `resultCode` on top of v2
   * so the witness signature cryptographically pins the Layer-7 verifier
   * result the witness independently computed. Witnesses on coc-node
   * v0.4+ produce all three versions during rollout; aggregator prefers
   * v3 when present.
   */
  witnessSigV3?: `0x${string}`
  /**
   * Optional Layer-7 verifier result (#746). When the witness ran the
   * verifier callbacks itself (verifyUptimeResult / verifyStorageProof /
   * verifyRelayResult), this is its independently-computed ResultCode.
   * Aggregator uses this for `ReceiptBatchMetadata.resultCodes[]`.
   */
  resultCode?: ResultCode
}

/**
 * Per-receipt metadata sent alongside a v2 batch (#667). Lets the contract
 * verify each witness signature against the ORIGINAL (challengeId, responseBodyHash)
 * the witness actually attested to — not the batch merkleRoot. The contract
 * independently rebuilds the Merkle root from `leafHashes` to assert it
 * matches the submitted root.
 *
 * `witnessReceiptIndex[i]` is the index in {challengeIds, nodeIds,
 * responseBodyHashes, leafHashes} that the witness at bit `i` (0..31) of
 * the batch-level bitmap attested to. Unused bit positions hold the sentinel
 * value `0xffff` (which the contract rejects when accessed via `BadReceiptIndex`).
 */
export interface ReceiptBatchMetadata {
  challengeIds: Hex32[]
  nodeIds: Hex32[]
  responseBodyHashes: Hex32[]
  leafHashes: Hex32[]
  /**
   * #746 — per-receipt Layer-7 verifier result code, fed into the v3
   * witness EIP-712 digest so the witness signature pins the result the
   * witness independently computed. Must be `length == leafHashes.length`;
   * validated on-chain by `submitBatchV2WithMetadata`.
   */
  resultCodes: number[]
  /** Fixed length 32 — matches Solidity `uint16[32]`. */
  witnessReceiptIndex: number[]
}

/** Sentinel for `witnessReceiptIndex` slots that don't have an assigned receipt. */
export const WITNESS_INDEX_UNUSED = 0xffff

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
