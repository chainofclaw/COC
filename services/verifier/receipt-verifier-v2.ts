// PoSe v2 receipt verifier — 9-layer verification pipeline.
// Adds EIP-712 sig verify, tip binding, and witness quorum.

import { keccak256Hex } from "../relayer/keccak256.ts"
import { ChallengeType, type Hex32 } from "../common/pose-types.ts"
import {
  ResultCode,
  type ChallengeMessageV2,
  type ReceiptMessageV2,
  type WitnessAttestation,
  type EvidenceLeafV2,
  type VerifiedReceiptV2,
} from "../common/pose-types-v2.ts"
import { stableStringify } from "../common/encoding.ts"
import type { NonceRegistryLike } from "./nonce-registry.ts"
import type { Eip712Signer } from "../../node/src/crypto/eip712-signer.ts"
import { CHALLENGE_TYPES, RECEIPT_TYPES, WITNESS_TYPES } from "../../node/src/crypto/eip712-types.ts"

export interface ReceiptVerifierV2Deps {
  nonceRegistry?: NonceRegistryLike
  challengerEip712: Eip712Signer
  nodeEip712Verifier: {
    verifyTypedData(types: Record<string, readonly { name: string; type: string }[]>, value: Record<string, unknown>, sig: string, addr: string): boolean
  }
  witnessEip712Verifier: {
    verifyTypedData(types: Record<string, readonly { name: string; type: string }[]>, value: Record<string, unknown>, sig: string, addr: string): boolean
  }
  verifyUptimeResult?: (challenge: ChallengeMessageV2, receipt: ReceiptMessageV2) => boolean
  verifyStorageProof?: (challenge: ChallengeMessageV2, receipt: ReceiptMessageV2) => boolean
  verifyRelayResult?: (challenge: ChallengeMessageV2, receipt: ReceiptMessageV2) => boolean
  tipToleranceBlocks?: number
  currentTipHeight?: () => bigint
  requiredWitnesses: number
  witnessAddresses: string[]
}

export interface VerificationResultV2 {
  ok: boolean
  reason?: string
  resultCode: ResultCode
  responseBodyHash?: Hex32
}

export class ReceiptVerifierV2 {
  private readonly deps: ReceiptVerifierV2Deps

  constructor(deps: ReceiptVerifierV2Deps) {
    this.deps = deps
  }

  verify(
    challenge: ChallengeMessageV2,
    receipt: ReceiptMessageV2,
    witnesses: WitnessAttestation[],
  ): VerificationResultV2 {
    // Layer 1: Nonce replay check
    if (this.deps.nonceRegistry) {
      const v1Like = {
        challengeId: challenge.challengeId,
        epochId: challenge.epochId,
        nodeId: challenge.nodeId,
        challengeType: challenge.challengeType,
        nonce: challenge.nonce,
        randSeed: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32,
        issuedAtMs: challenge.issuedAtMs,
        deadlineMs: challenge.deadlineMs,
        querySpec: challenge.querySpec,
        challengerId: challenge.challengerId,
        challengerSig: challenge.challengerSig,
      }
      if (!this.deps.nonceRegistry.consume(v1Like)) {
        return { ok: false, reason: "nonce replay detected", resultCode: ResultCode.NonceMismatch }
      }
    }

    // Layer 2: Challenger EIP-712 sig verify
    const challengeTypeNum = challenge.challengeType === "U" ? 0 : challenge.challengeType === "S" ? 1 : 2
    const challengeData = {
      challengeId: challenge.challengeId,
      epochId: challenge.epochId,
      nodeId: challenge.nodeId,
      challengeType: challengeTypeNum,
      nonce: challenge.nonce,
      challengeNonce: challenge.challengeNonce,
      querySpecHash: challenge.querySpecHash,
      issuedAtMs: challenge.issuedAtMs,
      deadlineMs: BigInt(challenge.deadlineMs),
      challengerId: challenge.challengerId,
    }
    const challengerAddr = `0x${challenge.challengerId.slice(-40)}`.toLowerCase()
    if (!this.deps.challengerEip712.verifyTypedData(
      CHALLENGE_TYPES,
      challengeData as unknown as Record<string, unknown>,
      challenge.challengerSig,
      challengerAddr,
    )) {
      return { ok: false, reason: "invalid challenger EIP-712 signature", resultCode: ResultCode.InvalidSig }
    }

    // Layer 3: Field matching
    if (receipt.challengeId !== challenge.challengeId || receipt.nodeId !== challenge.nodeId) {
      return { ok: false, reason: "challenge/receipt mismatch", resultCode: ResultCode.InvalidSig }
    }

    // Layer 4: Deadline check
    if (receipt.responseAtMs < challenge.issuedAtMs) {
      return { ok: false, reason: "receipt timestamp before challenge issuance", resultCode: ResultCode.Timeout }
    }
    if (receipt.responseAtMs > challenge.issuedAtMs + BigInt(challenge.deadlineMs)) {
      return { ok: false, reason: "receipt timeout", resultCode: ResultCode.Timeout }
    }

    // Layer 5: Node EIP-712 sig verify (receipt includes tipHash + tipHeight)
    const responseBodyHash = this.hashResponseBody(receipt.responseBody)
    const receiptData = {
      challengeId: receipt.challengeId,
      nodeId: receipt.nodeId,
      responseAtMs: receipt.responseAtMs,
      responseBodyHash,
      tipHash: receipt.tipHash,
      tipHeight: receipt.tipHeight,
    }
    const nodeAddr = `0x${receipt.nodeId.slice(-40)}`.toLowerCase()
    if (!this.deps.nodeEip712Verifier.verifyTypedData(
      RECEIPT_TYPES,
      receiptData as unknown as Record<string, unknown>,
      receipt.nodeSig,
      nodeAddr,
    )) {
      return { ok: false, reason: "invalid node EIP-712 signature", resultCode: ResultCode.InvalidSig }
    }

    // Layer 6: Tip binding
    if (this.deps.currentTipHeight) {
      const tolerance = BigInt(this.deps.tipToleranceBlocks ?? 10)
      const currentTip = this.deps.currentTipHeight()
      const diff = receipt.tipHeight > currentTip
        ? receipt.tipHeight - currentTip
        : currentTip - receipt.tipHeight
      if (diff > tolerance) {
        return { ok: false, reason: "tip height out of tolerance", resultCode: ResultCode.TipMismatch }
      }
    }

    // Layer 7: Type-specific verification
    if (challenge.challengeType === ChallengeType.Uptime && this.deps.verifyUptimeResult) {
      if (!this.deps.verifyUptimeResult(challenge, receipt)) {
        return { ok: false, reason: "uptime verification failed", resultCode: ResultCode.StorageProofFail }
      }
    }
    if (challenge.challengeType === ChallengeType.Storage && this.deps.verifyStorageProof) {
      if (!this.deps.verifyStorageProof(challenge, receipt)) {
        return { ok: false, reason: "storage proof invalid", resultCode: ResultCode.StorageProofFail }
      }
    }
    if (challenge.challengeType === ChallengeType.Relay && this.deps.verifyRelayResult) {
      if (!this.deps.verifyRelayResult(challenge, receipt)) {
        return { ok: false, reason: "relay witness invalid", resultCode: ResultCode.RelayWitnessFail }
      }
    }

    // Layer 8: Witness quorum verification
    const witnessBitmap = this.verifyWitnesses(witnesses, receipt.challengeId, receipt.nodeId, responseBodyHash)
    const witnessCount = this.popcount(witnessBitmap)
    if (witnessCount < this.deps.requiredWitnesses) {
      return {
        ok: false,
        reason: `witness quorum not met: ${witnessCount}/${this.deps.requiredWitnesses}`,
        resultCode: ResultCode.WitnessQuorumFail,
        responseBodyHash,
      }
    }

    // Layer 9: Build evidence leaf
    return {
      ok: true,
      resultCode: ResultCode.Ok,
      responseBodyHash,
    }
  }

  buildEvidenceLeaf(
    challenge: ChallengeMessageV2,
    receipt: ReceiptMessageV2,
    witnessBitmap: number,
    resultCode: ResultCode,
  ): EvidenceLeafV2 {
    return {
      epoch: challenge.epochId,
      nodeId: challenge.nodeId,
      nonce: challenge.nonce,
      tipHash: receipt.tipHash,
      tipHeight: receipt.tipHeight,
      latencyMs: Number(receipt.responseAtMs - challenge.issuedAtMs),
      resultCode,
      witnessBitmap,
    }
  }

  toVerifiedReceipt(
    challenge: ChallengeMessageV2,
    receipt: ReceiptMessageV2,
    witnesses: WitnessAttestation[],
    verifiedAtMs: bigint,
  ): VerifiedReceiptV2 {
    const result = this.verify(challenge, receipt, witnesses)
    const responseBodyHash = result.responseBodyHash ?? this.hashResponseBody(receipt.responseBody)
    const witnessBitmap = this.computeWitnessBitmap(witnesses)
    const evidenceLeaf = this.buildEvidenceLeaf(challenge, receipt, witnessBitmap, result.resultCode)

    return {
      challenge,
      receipt,
      witnesses,
      witnessBitmap,
      evidenceLeaf,
      verifiedAtMs,
    }
  }

  private verifyWitnesses(
    witnesses: WitnessAttestation[],
    challengeId: Hex32,
    nodeId: Hex32,
    responseBodyHash: Hex32,
  ): number {
    let bitmap = 0
    for (const w of witnesses) {
      if (w.challengeId !== challengeId || w.nodeId !== nodeId) continue
      if (w.responseBodyHash !== responseBodyHash) continue
      if (w.witnessIndex >= 32) continue

      const witnessAddr = this.deps.witnessAddresses[w.witnessIndex]
      if (!witnessAddr) continue

      const attestData = {
        challengeId: w.challengeId,
        nodeId: w.nodeId,
        responseBodyHash: w.responseBodyHash,
        witnessIndex: w.witnessIndex,
      }
      if (this.deps.witnessEip712Verifier.verifyTypedData(
        WITNESS_TYPES,
        attestData as unknown as Record<string, unknown>,
        w.witnessSig,
        witnessAddr,
      )) {
        bitmap |= (1 << w.witnessIndex)
      }
    }
    return bitmap
  }

  private computeWitnessBitmap(witnesses: WitnessAttestation[]): number {
    let bitmap = 0
    for (const w of witnesses) {
      if (w.witnessIndex < 32) {
        bitmap |= (1 << w.witnessIndex)
      }
    }
    return bitmap
  }

  private popcount(n: number): number {
    let count = 0
    let v = n
    while (v) {
      count += v & 1
      v >>>= 1
    }
    return count
  }

  private hashResponseBody(body: Record<string, unknown>): Hex32 {
    const stable = stableStringify(body)
    return `0x${keccak256Hex(Buffer.from(stable, "utf8"))}` as Hex32
  }
}
