import type { Hex32 } from "../common/pose-types.ts"

export interface EpochNodeStats {
  nodeId: Hex32
  uptimeBps: number
  storageBps: number
  relayBps: number
  storageGb: bigint
  uptimeSamples?: number
  storageSamples?: number
  relaySamples?: number
}

export interface ScoringConfig {
  uptimeBucketBps: number
  storageBucketBps: number
  relayBucketBps: number
  uptimeThresholdBps: number
  storageThresholdBps: number
  relayThresholdBps: number
  storageCapGb: bigint
  softCapMultiplier: bigint
  minSamples: number
}

export interface EpochRewardResult {
  rewards: Record<Hex32, bigint>
  bucketRewards: {
    uptime: bigint
    storage: bigint
    relay: bigint
  }
  cappedNodes: Hex32[]
  treasuryOverflow: bigint
}

const BASIS_POINTS = 10_000n

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  uptimeBucketBps: 6000,
  storageBucketBps: 3000,
  relayBucketBps: 1000,
  uptimeThresholdBps: 8000,
  storageThresholdBps: 7000,
  relayThresholdBps: 5000,
  storageCapGb: 500n,
  softCapMultiplier: 5n,
  minSamples: 5,
}

export function computeEpochRewards(
  rewardPool: bigint,
  stats: EpochNodeStats[],
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): EpochRewardResult {
  if (rewardPool < 0n) {
    throw new Error("rewardPool must be non-negative")
  }

  const bucketRewards = splitBuckets(rewardPool, cfg)
  const rewardMap = new Map<Hex32, bigint>()

  for (const s of stats) {
    rewardMap.set(s.nodeId, 0n)
  }

  allocateBucket(rewardMap, stats, bucketRewards.uptime, (s) => uptimeWeight(s, cfg))
  allocateBucket(rewardMap, stats, bucketRewards.storage, (s) => storageWeight(s, cfg))
  allocateBucket(rewardMap, stats, bucketRewards.relay, (s) => relayWeight(s, cfg))

  const capped = applySoftCap(rewardMap, cfg.softCapMultiplier)

  const rewards: Record<Hex32, bigint> = Object.create(null) as Record<Hex32, bigint>
  for (const [nodeId, value] of rewardMap.entries()) {
    rewards[nodeId] = value
  }

  return {
    rewards,
    bucketRewards,
    cappedNodes: [...capped.cappedNodes],
    treasuryOverflow: capped.treasuryOverflow,
  }
}

function splitBuckets(pool: bigint, cfg: ScoringConfig): { uptime: bigint; storage: bigint; relay: bigint } {
  const uptime = (pool * BigInt(cfg.uptimeBucketBps)) / BASIS_POINTS
  const storage = (pool * BigInt(cfg.storageBucketBps)) / BASIS_POINTS
  const relay = pool - uptime - storage
  return { uptime, storage, relay }
}

function allocateBucket(
  rewards: Map<Hex32, bigint>,
  stats: EpochNodeStats[],
  bucketAmount: bigint,
  weightOf: (stat: EpochNodeStats) => bigint,
): void {
  if (bucketAmount <= 0n || stats.length === 0) {
    return
  }

  const weights = stats.map(weightOf)
  const totalWeight = weights.reduce((acc, n) => acc + n, 0n)
  if (totalWeight === 0n) {
    return
  }

  let distributed = 0n
  for (let i = 0; i < stats.length; i++) {
    const w = weights[i]
    if (w === 0n) continue
    const share = (bucketAmount * w) / totalWeight
    if (share === 0n) continue
    const current = rewards.get(stats[i].nodeId) ?? 0n
    rewards.set(stats[i].nodeId, current + share)
    distributed += share
  }

  const remainder = bucketAmount - distributed
  if (remainder > 0n) {
    // Deterministic remainder sink: highest weight node in this bucket.
    let bestIdx = -1
    let bestWeight = 0n
    for (let i = 0; i < stats.length; i++) {
      if (weights[i] > bestWeight) {
        bestWeight = weights[i]
        bestIdx = i
      }
    }
    if (bestIdx >= 0 && bestWeight > 0n) {
      const nodeId = stats[bestIdx].nodeId
      rewards.set(nodeId, (rewards.get(nodeId) ?? 0n) + remainder)
    }
  }
}

function uptimeWeight(stat: EpochNodeStats, cfg: ScoringConfig): bigint {
  if ((stat.uptimeSamples ?? Infinity) < cfg.minSamples) return 0n
  if (stat.uptimeBps < cfg.uptimeThresholdBps) {
    return 0n
  }
  return BigInt(stat.uptimeBps)
}

function storageWeight(stat: EpochNodeStats, cfg: ScoringConfig): bigint {
  if ((stat.storageSamples ?? Infinity) < cfg.minSamples) return 0n
  if (stat.storageBps < cfg.storageThresholdBps) {
    return 0n
  }
  const cappedGb = stat.storageGb > cfg.storageCapGb ? cfg.storageCapGb : stat.storageGb
  const capFactor = isqrt(cfg.storageCapGb * 1_000_000n)
  const nodeFactor = isqrt(cappedGb * 1_000_000n)
  if (capFactor === 0n) {
    return 0n
  }
  return (BigInt(stat.storageBps) * nodeFactor) / capFactor
}

function relayWeight(stat: EpochNodeStats, cfg: ScoringConfig): bigint {
  if ((stat.relaySamples ?? Infinity) < cfg.minSamples) return 0n
  if (stat.relayBps < cfg.relayThresholdBps) {
    return 0n
  }
  return BigInt(stat.relayBps)
}

function applySoftCap(
  rewards: Map<Hex32, bigint>,
  softCapMultiplier: bigint,
): { cappedNodes: Set<Hex32>; treasuryOverflow: bigint } {
  if (softCapMultiplier <= 0n || rewards.size === 0) {
    return { cappedNodes: new Set<Hex32>(), treasuryOverflow: 0n }
  }

  const nonZero = [...rewards.entries()].filter(([, v]) => v > 0n)
  if (nonZero.length === 0) {
    return { cappedNodes: new Set<Hex32>(), treasuryOverflow: 0n }
  }

  const values = nonZero.map(([, v]) => v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const median = values[Math.floor(values.length / 2)]
  if (median === 0n) {
    return { cappedNodes: new Set<Hex32>(), treasuryOverflow: 0n }
  }

  const cap = median * softCapMultiplier
  const cappedNodes = new Set<Hex32>()
  let overflow = 0n

  for (const [nodeId, value] of rewards.entries()) {
    if (value > cap) {
      overflow += value - cap
      rewards.set(nodeId, cap)
      cappedNodes.add(nodeId)
    }
  }

  if (overflow === 0n) {
    return { cappedNodes, treasuryOverflow: 0n }
  }

  const receivers = [...rewards.entries()].filter(([, value]) => value > 0n && value < cap)
  if (receivers.length === 0) {
    return { cappedNodes, treasuryOverflow: overflow }
  }

  const totalReceiverWeight = receivers.reduce((acc, [, value]) => acc + value, 0n)
  if (totalReceiverWeight === 0n) {
    return { cappedNodes, treasuryOverflow: overflow }
  }

  let redistributed = 0n
  for (const [nodeId, value] of receivers) {
    const room = cap - value
    if (room <= 0n) continue
    const share = (overflow * value) / totalReceiverWeight
    const grant = share > room ? room : share
    if (grant > 0n) {
      rewards.set(nodeId, value + grant)
      redistributed += grant
    }
  }

  return {
    cappedNodes,
    treasuryOverflow: overflow - redistributed,
  }
}

function isqrt(n: bigint): bigint {
  if (n < 0n) {
    throw new Error("isqrt on negative")
  }
  if (n < 2n) {
    return n
  }

  let x0 = n
  let x1 = (x0 + n / x0) >> 1n
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + n / x0) >> 1n
  }
  return x0
}
