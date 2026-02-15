import { keccak256Hex } from "../relayer/keccak256.ts"
import {
  ChallengeType,
  type ChallengeMessage,
  type Hex32,
  type ReceiptMessage,
  type VerificationResult,
  type VerifiedReceipt,
} from "../common/pose-types.ts"
import type { NonceRegistryLike } from "./nonce-registry.ts"

export interface ReceiptVerifierDeps {
  nonceRegistry?: NonceRegistryLike
  verifyChallengerSig: (challenge: ChallengeMessage) => boolean
  verifyNodeSig: (challenge: ChallengeMessage, receipt: ReceiptMessage, responseBodyHash: Hex32) => boolean
  verifyUptimeResult?: (challenge: ChallengeMessage, receipt: ReceiptMessage) => boolean
  verifyStorageProof?: (challenge: ChallengeMessage, receipt: ReceiptMessage) => boolean
  verifyRelayResult?: (challenge: ChallengeMessage, receipt: ReceiptMessage) => boolean
}

export class ReceiptVerifier {
  private readonly deps: ReceiptVerifierDeps

  constructor(deps: ReceiptVerifierDeps) {
    this.deps = deps
  }

  verify(challenge: ChallengeMessage, receipt: ReceiptMessage): VerificationResult {
    if (this.deps.nonceRegistry && !this.deps.nonceRegistry.consume(challenge)) {
      return { ok: false, reason: "nonce replay detected" }
    }
    if (!this.deps.verifyChallengerSig(challenge)) {
      return { ok: false, reason: "invalid challenger signature" }
    }
    if (receipt.challengeId !== challenge.challengeId || receipt.nodeId !== challenge.nodeId) {
      return { ok: false, reason: "challenge/receipt mismatch" }
    }
    if (receipt.responseAtMs < challenge.issuedAtMs) {
      return { ok: false, reason: "receipt timestamp before challenge issuance" }
    }
    if (receipt.responseAtMs > challenge.issuedAtMs + BigInt(challenge.deadlineMs)) {
      return { ok: false, reason: "receipt timeout" }
    }

    const responseBodyHash = this.hashResponseBody(receipt.responseBody)
    if (!this.deps.verifyNodeSig(challenge, receipt, responseBodyHash)) {
      return { ok: false, reason: "invalid node signature" }
    }

    if (challenge.challengeType === ChallengeType.Uptime && this.deps.verifyUptimeResult) {
      if (!this.deps.verifyUptimeResult(challenge, receipt)) {
        return { ok: false, reason: "uptime replay failed" }
      }
    }

    if (challenge.challengeType === ChallengeType.Storage && this.deps.verifyStorageProof) {
      if (!this.deps.verifyStorageProof(challenge, receipt)) {
        return { ok: false, reason: "storage proof invalid" }
      }
    }

    if (challenge.challengeType === ChallengeType.Relay && this.deps.verifyRelayResult) {
      if (!this.deps.verifyRelayResult(challenge, receipt)) {
        return { ok: false, reason: "relay witness invalid" }
      }
    }

    return { ok: true, responseBodyHash }
  }

  toVerifiedReceipt(challenge: ChallengeMessage, receipt: ReceiptMessage, verifiedAtMs: bigint): VerifiedReceipt {
    const result = this.verify(challenge, receipt)
    if (!result.ok || !result.responseBodyHash) {
      throw new Error(result.reason ?? "verification failed")
    }
    return {
      challenge,
      receipt,
      verifiedAtMs,
      responseBodyHash: result.responseBodyHash,
    }
  }

  private hashResponseBody(body: Record<string, unknown>): Hex32 {
    const stable = stableStringify(body)
    return `0x${keccak256Hex(Buffer.from(stable, "utf8"))}` as Hex32
  }
}

function stableStringify(value: unknown): string {
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
