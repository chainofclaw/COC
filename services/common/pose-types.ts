export type Hex32 = `0x${string}`

export const ChallengeType = {
  Uptime: "U",
  Storage: "S",
  Relay: "R",
} as const

export type ChallengeType = (typeof ChallengeType)[keyof typeof ChallengeType]

export interface ChallengeMessage {
  challengeId: Hex32
  epochId: bigint
  nodeId: Hex32
  challengeType: ChallengeType
  nonce: `0x${string}`
  randSeed: Hex32
  issuedAtMs: bigint
  deadlineMs: number
  querySpec: Record<string, unknown>
  challengerId: Hex32
  challengerSig: `0x${string}`
}

export interface ReceiptMessage {
  challengeId: Hex32
  nodeId: Hex32
  responseAtMs: bigint
  responseBody: Record<string, unknown>
  nodeSig: `0x${string}`
}

export interface VerificationResult {
  ok: boolean
  reason?: string
  responseBodyHash?: Hex32
}

export interface VerifiedReceipt {
  challenge: ChallengeMessage
  receipt: ReceiptMessage
  verifiedAtMs: bigint
  responseBodyHash: Hex32
}

export const PROTOCOL_VERSION_V1 = 1

// Re-export v2 types
export {
  PROTOCOL_VERSION_V2,
  ResultCode,
  FaultType,
  type ChallengeMessageV2,
  type ReceiptMessageV2,
  type WitnessAttestation,
  type EvidenceLeafV2,
  type RewardLeaf,
  type VerifiedReceiptV2,
  type FaultProof,
} from "./pose-types-v2.ts"
