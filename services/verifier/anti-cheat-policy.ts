import type { ChallengeMessage, ReceiptMessage, Hex32 } from "../common/pose-types.ts"
import { hashSlashEvidencePayload } from "../common/slash-evidence.ts"

export const EvidenceReason = {
  ReplayNonce: 1,
  InvalidSignature: 2,
  Timeout: 3,
  StorageProofInvalid: 4,
  MissingReceipt: 5,
  BftEquivocation: 6,
} as const

export type EvidenceReasonCode = (typeof EvidenceReason)[keyof typeof EvidenceReason]

export interface SlashEvidence {
  nodeId: Hex32
  reasonCode: EvidenceReasonCode
  evidenceHash: Hex32
  rawEvidence: Record<string, unknown>
}

export class AntiCheatPolicy {
  buildEvidence(
    reasonCode: EvidenceReasonCode,
    challenge: ChallengeMessage,
    receipt?: ReceiptMessage,
    extra: Record<string, unknown> = {},
  ): SlashEvidence {
    const raw: Record<string, unknown> = {
      reasonCode,
      challengeId: challenge.challengeId,
      nodeId: challenge.nodeId,
      nonce: challenge.nonce,
      epochId: challenge.epochId.toString(),
      ...(receipt ? { receiptNodeId: receipt.nodeId, responseAtMs: receipt.responseAtMs.toString() } : {}),
      ...extra,
    }

    const evidenceHash = this.hashRawEvidence(raw)
    return {
      nodeId: challenge.nodeId,
      reasonCode,
      evidenceHash,
      rawEvidence: raw,
    }
  }

  private hashRawEvidence(raw: Record<string, unknown>): Hex32 {
    return hashSlashEvidencePayload(raw.nodeId as Hex32, raw)
  }
}
