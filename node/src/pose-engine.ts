import { randomBytes } from "node:crypto"
import { ChallengeFactory, buildChallengeVerifyPayload } from "../../services/challenger/challenge-factory.ts"
import { ChallengeQuota } from "../../services/challenger/challenge-quota.ts"
import { ReceiptVerifier } from "../../services/verifier/receipt-verifier.ts"
import { NonceRegistry } from "../../services/verifier/nonce-registry.ts"
import type { NonceRegistryLike } from "../../services/verifier/nonce-registry.ts"
import { BatchAggregator } from "../../services/aggregator/batch-aggregator.ts"
import { computeEpochRewards } from "../../services/verifier/scoring.ts"
import type { ChallengeMessage, Hex32, ReceiptMessage, VerifiedReceipt } from "../../services/common/pose-types.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { buildReceiptSignMessage } from "./crypto/signer.ts"

export interface PoSeEngineDeps {
  signer: NodeSigner & SignatureVerifier
  nonceRegistry?: NonceRegistryLike
  maxChallengesPerEpoch?: number
}

function addressToHex32(address: string): Hex32 {
  const clean = address.startsWith("0x") ? address.slice(2) : address
  return `0x${clean.padStart(64, "0")}` as Hex32
}

function hex32ToAddress(hex32: string): string {
  const clean = hex32.startsWith("0x") ? hex32.slice(2) : hex32
  // Take the last 40 hex chars (20 bytes) as Ethereum address
  return `0x${clean.slice(-40)}`.toLowerCase()
}

export class PoSeEngine {
  private readonly quota: ChallengeQuota
  private readonly factory: ChallengeFactory
  private readonly verifier: ReceiptVerifier
  private readonly aggregator: BatchAggregator
  private readonly receipts: VerifiedReceipt[] = []
  private readonly issuedChallenges = new Map<Hex32, ChallengeMessage>()
  private readonly signer: NodeSigner & SignatureVerifier
  private readonly maxChallengesPerEpoch: number
  private issuedChallengeCount = 0
  private epochId: bigint

  constructor(epochId: bigint, deps: PoSeEngineDeps) {
    this.signer = deps.signer
    const nonceRegistry = deps.nonceRegistry ?? new NonceRegistry()
    this.maxChallengesPerEpoch = deps.maxChallengesPerEpoch ?? 200
    const challengerHex32 = addressToHex32(this.signer.nodeId)
    this.quota = new ChallengeQuota({
      maxPerEpoch: { U: 6, S: 2, R: 2 },
      minIntervalMs: { U: 1000, S: 2000, R: 2000 }
    })
    this.factory = new ChallengeFactory({
      challengerId: challengerHex32,
      sign: (digestHex) => {
        return this.signer.sign(digestHex) as `0x${string}`
      }
    })
    this.verifier = new ReceiptVerifier({
      nonceRegistry,
      verifyChallengerSig: (challenge) => {
        const payload = buildChallengeVerifyPayload(challenge)
        const challengerAddr = hex32ToAddress(challenge.challengerId)
        return this.signer.verifyNodeSig(payload, challenge.challengerSig, challengerAddr)
      },
      verifyNodeSig: (challenge, receipt, responseBodyHash) => {
        const msg = buildReceiptSignMessage(
          challenge.challengeId,
          receipt.nodeId,
          responseBodyHash,
        )
        const nodeAddr = hex32ToAddress(receipt.nodeId)
        return this.signer.verifyNodeSig(msg, receipt.nodeSig, nodeAddr)
      },
      verifyUptimeResult: (challenge, receipt) => {
        if (!receipt.responseBody?.ok) return false
        const bn = Number(receipt.responseBody?.blockNumber)
        if (!Number.isFinite(bn) || bn <= 0) return false
        const minBn = Number((challenge.querySpec as Record<string, unknown>)?.minBlockNumber ?? 0)
        if (minBn > 0 && bn < minBn) return false
        return true
      },
    })
    this.aggregator = new BatchAggregator({
      sampleSize: 2,
      signSummary: (s) => this.signer.sign(s)
    })
    this.epochId = epochId
  }

  getEpochId(): bigint {
    return this.epochId
  }

  issueChallenge(nodeId: string): ChallengeMessage | null {
    if (this.issuedChallengeCount >= this.maxChallengesPerEpoch) {
      return null
    }
    const can = this.quota.canIssue(nodeId as Hex32, this.epochId, "U", BigInt(Date.now()))
    if (!can.ok) return null
    const challenge = this.factory.issue({
      epochId: this.epochId,
      nodeId: nodeId as Hex32,
      challengeType: "Uptime",
      randSeed: `0x${randomBytes(32).toString("hex")}` as Hex32,
      issuedAtMs: BigInt(Date.now()),
      querySpec: { method: "eth_blockNumber" }
    })
    this.quota.commitIssue(nodeId as Hex32, this.epochId, "U", BigInt(Date.now()))
    this.issuedChallengeCount += 1
    this.issuedChallenges.set(challenge.challengeId, challenge)
    return challenge
  }

  submitReceipt(challenge: ChallengeMessage, receipt: ReceiptMessage): void {
    const issued = this.issuedChallenges.get(challenge.challengeId)
    if (!issued) {
      throw new Error("unknown challenge")
    }
    if (!isSameChallenge(issued, challenge)) {
      throw new Error("challenge payload mismatch")
    }
    const verified = this.verifier.toVerifiedReceipt(issued, receipt, BigInt(Date.now()))
    this.issuedChallenges.delete(issued.challengeId)
    this.receipts.push(verified)
  }

  submitReceiptByChallengeId(challengeId: Hex32, receipt: ReceiptMessage): void {
    const issued = this.issuedChallenges.get(challengeId)
    if (!issued) {
      throw new Error("unknown challenge")
    }
    const verified = this.verifier.toVerifiedReceipt(issued, receipt, BigInt(Date.now()))
    this.issuedChallenges.delete(issued.challengeId)
    this.receipts.push(verified)
  }

  finalizeEpoch(): { summaryHash: string; merkleRoot: string; rewards: Record<string, bigint> } | null {
    if (this.receipts.length === 0) return null
    const batch = this.aggregator.buildBatch(this.epochId, this.receipts)
    const rewards = computeEpochRewards(1_000_000n, [
      { nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex32, uptimeBps: 9000, storageBps: 0, relayBps: 0, storageGb: 0n }
    ])
    this.receipts.length = 0
    this.issuedChallenges.clear()
    this.issuedChallengeCount = 0
    this.epochId += 1n
    return { summaryHash: batch.summaryHash, merkleRoot: batch.merkleRoot, rewards: rewards.rewards }
  }
}

function isSameChallenge(a: ChallengeMessage, b: ChallengeMessage): boolean {
  if (a.challengeId !== b.challengeId) return false
  if (a.epochId !== b.epochId) return false
  if (a.nodeId !== b.nodeId) return false
  if (a.challengeType !== b.challengeType) return false
  if (a.nonce !== b.nonce) return false
  if (a.randSeed !== b.randSeed) return false
  if (a.issuedAtMs !== b.issuedAtMs) return false
  if (a.deadlineMs !== b.deadlineMs) return false
  if (a.challengerId !== b.challengerId) return false
  if (a.challengerSig !== b.challengerSig) return false
  return stableStringify(a.querySpec) === stableStringify(b.querySpec)
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
