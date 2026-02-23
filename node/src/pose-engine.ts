import { randomBytes } from "node:crypto"
import { ChallengeFactory, buildChallengeVerifyPayload } from "../../services/challenger/challenge-factory.ts"
import { ChallengeQuota } from "../../services/challenger/challenge-quota.ts"
import { ReceiptVerifier } from "../../services/verifier/receipt-verifier.ts"
import { NonceRegistry } from "../../services/verifier/nonce-registry.ts"
import type { NonceRegistryLike } from "../../services/verifier/nonce-registry.ts"
import { BatchAggregator } from "../../services/aggregator/batch-aggregator.ts"
import { computeEpochRewards } from "../../services/verifier/scoring.ts"
import type { EpochNodeStats } from "../../services/verifier/scoring.ts"
import type { ChallengeMessage, Hex32, ReceiptMessage, VerifiedReceipt } from "../../services/common/pose-types.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { buildReceiptSignMessage } from "./crypto/signer.ts"

type ChallengeBucket = "U" | "S" | "R"
type ChallengeTier = "default" | "trusted" | "restricted"

interface ChallengeBudgetProfile {
  maxPerEpoch: Record<ChallengeBucket, number>
  minIntervalMs: Record<ChallengeBucket, number>
}

interface PartialChallengeBudgetProfile {
  maxPerEpoch?: Partial<Record<ChallengeBucket, number>>
  minIntervalMs?: Partial<Record<ChallengeBucket, number>>
}

const DEFAULT_CHALLENGE_BUDGET_PROFILES: Record<ChallengeTier, ChallengeBudgetProfile> = {
  default: {
    maxPerEpoch: { U: 6, S: 2, R: 2 },
    minIntervalMs: { U: 1000, S: 2000, R: 2000 },
  },
  trusted: {
    maxPerEpoch: { U: 8, S: 3, R: 3 },
    minIntervalMs: { U: 500, S: 1000, R: 1000 },
  },
  restricted: {
    maxPerEpoch: { U: 3, S: 1, R: 1 },
    minIntervalMs: { U: 2000, S: 3000, R: 3000 },
  },
}

export interface PoSeEngineDeps {
  signer: NodeSigner & SignatureVerifier
  nonceRegistry?: NonceRegistryLike
  maxChallengesPerEpoch?: number
  challengeTierResolver?: (nodeId: string) => ChallengeTier
  challengeBudgetProfiles?: Partial<Record<ChallengeTier, PartialChallengeBudgetProfile>>
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
  private readonly tierQuotas: Record<ChallengeTier, ChallengeQuota>
  private readonly factory: ChallengeFactory
  private readonly verifier: ReceiptVerifier
  private readonly aggregator: BatchAggregator
  private readonly receipts: VerifiedReceipt[] = []
  private readonly issuedChallenges = new Map<Hex32, ChallengeMessage>()
  private readonly signer: NodeSigner & SignatureVerifier
  private readonly maxChallengesPerEpoch: number
  private readonly challengeTierResolver?: (nodeId: string) => ChallengeTier
  private issuedChallengeCount = 0
  private epochId: bigint

  constructor(epochId: bigint, deps: PoSeEngineDeps) {
    this.signer = deps.signer
    const nonceRegistry = deps.nonceRegistry ?? new NonceRegistry()
    this.maxChallengesPerEpoch = deps.maxChallengesPerEpoch ?? 200
    this.challengeTierResolver = deps.challengeTierResolver
    const challengerHex32 = addressToHex32(this.signer.nodeId)
    const budgetProfiles = resolveChallengeBudgetProfiles(deps.challengeBudgetProfiles)
    this.tierQuotas = {
      default: new ChallengeQuota(budgetProfiles.default),
      trusted: new ChallengeQuota(budgetProfiles.trusted),
      restricted: new ChallengeQuota(budgetProfiles.restricted),
    }
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

  issueChallenge(nodeId: string, opts: { challengeBucket?: ChallengeBucket } = {}): ChallengeMessage | null {
    if (this.issuedChallengeCount >= this.maxChallengesPerEpoch) {
      return null
    }
    const challengeBucket = normalizeChallengeBucket(opts.challengeBucket)
    const challengeTier = this.resolveChallengeTier(nodeId)
    const quota = this.tierQuotas[challengeTier]
    const nowMs = BigInt(Date.now())
    const can = quota.canIssue(nodeId as Hex32, this.epochId, challengeBucket, nowMs)
    if (!can.ok) return null
    const challenge = this.factory.issue({
      epochId: this.epochId,
      nodeId: nodeId as Hex32,
      challengeType: challengeBucketToFactoryType(challengeBucket),
      randSeed: `0x${randomBytes(32).toString("hex")}` as Hex32,
      issuedAtMs: nowMs,
      querySpec: { method: "eth_blockNumber" }
    })
    quota.commitIssue(nodeId as Hex32, this.epochId, challengeBucket, nowMs)
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
    const nodeStats = aggregateReceiptStats(this.receipts, this.issuedChallenges)
    const rewards = computeEpochRewards(1_000_000n, nodeStats)
    this.receipts.length = 0
    this.issuedChallenges.clear()
    this.issuedChallengeCount = 0
    this.epochId += 1n
    return { summaryHash: batch.summaryHash, merkleRoot: batch.merkleRoot, rewards: rewards.rewards }
  }

  private resolveChallengeTier(nodeId: string): ChallengeTier {
    const tier = this.challengeTierResolver?.(nodeId)
    if (tier === "trusted" || tier === "restricted") {
      return tier
    }
    return "default"
  }
}

function normalizeChallengeBucket(bucket: ChallengeBucket | undefined): ChallengeBucket {
  if (bucket === "S" || bucket === "R") return bucket
  return "U"
}

function challengeBucketToFactoryType(bucket: ChallengeBucket): "Uptime" | "Storage" | "Relay" {
  if (bucket === "S") return "Storage"
  if (bucket === "R") return "Relay"
  return "Uptime"
}

function resolveChallengeBudgetProfiles(
  overrides: Partial<Record<ChallengeTier, PartialChallengeBudgetProfile>> | undefined,
): Record<ChallengeTier, ChallengeBudgetProfile> {
  const merged = { ...DEFAULT_CHALLENGE_BUDGET_PROFILES }
  if (!overrides) return merged

  const tiers: ChallengeTier[] = ["default", "trusted", "restricted"]
  for (const tier of tiers) {
    const next = overrides[tier]
    if (!next) continue
    merged[tier] = {
      maxPerEpoch: {
        ...merged[tier].maxPerEpoch,
        ...next.maxPerEpoch,
      },
      minIntervalMs: {
        ...merged[tier].minIntervalMs,
        ...next.minIntervalMs,
      },
    }
  }
  return merged
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

/**
 * Aggregate verified receipts + unresponded challenges into per-node stats for reward computation.
 * Pass rate = verified / (verified + unresponded) per challenge type per node.
 */
function aggregateReceiptStats(
  receipts: VerifiedReceipt[],
  unresponded: Map<Hex32, ChallengeMessage>,
): EpochNodeStats[] {
  const nodes = new Map<string, { vU: number; vS: number; vR: number; tU: number; tS: number; tR: number }>()

  const getOrInit = (nodeId: string) => {
    let s = nodes.get(nodeId)
    if (!s) { s = { vU: 0, vS: 0, vR: 0, tU: 0, tS: 0, tR: 0 }; nodes.set(nodeId, s) }
    return s
  }

  // Count verified receipts per node per type
  for (const r of receipts) {
    const s = getOrInit(r.receipt.nodeId)
    switch (r.challenge.challengeType) {
      case "U": s.vU++; s.tU++; break
      case "S": s.vS++; s.tS++; break
      case "R": s.vR++; s.tR++; break
    }
  }

  // Count unresponded challenges (failures) per node per type
  for (const c of unresponded.values()) {
    const s = getOrInit(c.nodeId)
    switch (c.challengeType) {
      case "U": s.tU++; break
      case "S": s.tS++; break
      case "R": s.tR++; break
    }
  }

  return [...nodes.entries()].map(([nodeId, s]) => ({
    nodeId: nodeId as Hex32,
    uptimeBps: s.tU > 0 ? Math.round((s.vU / s.tU) * 10000) : 0,
    storageBps: s.tS > 0 ? Math.round((s.vS / s.tS) * 10000) : 0,
    relayBps: s.tR > 0 ? Math.round((s.vR / s.tR) * 10000) : 0,
    storageGb: 0n,
  }))
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
