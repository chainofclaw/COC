import type { ChallengeType, Hex32 } from "../common/pose-types.ts"

export interface QuotaConfig {
  maxPerEpoch: Record<ChallengeType, number>
  minIntervalMs: Record<ChallengeType, number>
}

interface Counter {
  count: number
  lastIssuedAtMs: bigint
}

export class ChallengeQuota {
  private readonly cfg: QuotaConfig
  private readonly counters = new Map<string, Counter>()

  constructor(cfg: QuotaConfig) {
    this.cfg = cfg
  }

  canIssue(nodeId: Hex32, epochId: bigint, challengeType: ChallengeType, nowMs: bigint): { ok: boolean; reason?: string } {
    const key = this.key(nodeId, epochId, challengeType)
    const current = this.counters.get(key)
    const max = this.cfg.maxPerEpoch[challengeType]
    const minInterval = BigInt(this.cfg.minIntervalMs[challengeType])

    if (current && current.count >= max) {
      return { ok: false, reason: "quota exceeded" }
    }

    if (current && nowMs - current.lastIssuedAtMs < minInterval) {
      return { ok: false, reason: "rate limited" }
    }

    return { ok: true }
  }

  commitIssue(nodeId: Hex32, epochId: bigint, challengeType: ChallengeType, nowMs: bigint): void {
    const key = this.key(nodeId, epochId, challengeType)
    const current = this.counters.get(key)
    if (!current) {
      this.counters.set(key, { count: 1, lastIssuedAtMs: nowMs })
      return
    }

    current.count += 1
    current.lastIssuedAtMs = nowMs
  }

  /** Remove counters for epochs older than the given epochId */
  pruneEpochsBefore(epochId: bigint): number {
    const epochStr = epochId.toString()
    let pruned = 0
    for (const key of this.counters.keys()) {
      const parts = key.split(":")
      if (parts.length >= 2 && BigInt(parts[1]) < epochId) {
        this.counters.delete(key)
        pruned++
      }
    }
    return pruned
  }

  private key(nodeId: Hex32, epochId: bigint, challengeType: ChallengeType): string {
    return `${nodeId}:${epochId.toString()}:${challengeType}`
  }
}
