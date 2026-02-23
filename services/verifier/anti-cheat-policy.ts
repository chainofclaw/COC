import { keccak256Hex } from "../relayer/keccak256.ts"
import type { ChallengeMessage, ReceiptMessage, Hex32 } from "../common/pose-types.ts"

export const EvidenceReason = {
  ReplayNonce: 1,
  InvalidSignature: 2,
  Timeout: 3,
  StorageProofInvalid: 4,
  MissingReceipt: 5,
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
    const stable = stableStringify(raw)
    return `0x${keccak256Hex(Buffer.from(stable, "utf8"))}` as Hex32
  }
}

function stableStringify(value: unknown): string {
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((x) => stableStringify(x)).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const props = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${props.join(",")}}`
}
