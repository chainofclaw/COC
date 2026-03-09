import test from "node:test"
import assert from "node:assert/strict"
import { computeEpochRewards, DEFAULT_SCORING_CONFIG, type EpochNodeStats } from "./scoring.ts"

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const C = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

function sumRewards(rewards: Record<string, bigint>): bigint {
  return Object.values(rewards).reduce((acc, n) => acc + n, 0n)
}

test("bucket split and threshold gating", () => {
  const stats: EpochNodeStats[] = [
    { nodeId: A, uptimeBps: 9000, storageBps: 8000, relayBps: 6000, storageGb: 100n },
    { nodeId: B, uptimeBps: 8500, storageBps: 6000, relayBps: 4000, storageGb: 500n },
  ]

  const result = computeEpochRewards(1_000_000n, stats)
  assert.equal(result.bucketRewards.uptime, 600000n)
  assert.equal(result.bucketRewards.storage, 300000n)
  assert.equal(result.bucketRewards.relay, 100000n)
  assert.equal(sumRewards(result.rewards) + result.treasuryOverflow, 1_000_000n)
  assert.equal(result.rewards[B] < result.rewards[A], true)
})

test("storage diminishing prevents linear domination", () => {
  const stats: EpochNodeStats[] = [
    { nodeId: A, uptimeBps: 9000, storageBps: 9000, relayBps: 5000, storageGb: 100n },
    { nodeId: B, uptimeBps: 9000, storageBps: 9000, relayBps: 5000, storageGb: 400n },
  ]

  const result = computeEpochRewards(1_000_000n, stats)
  const a = result.rewards[A]
  const b = result.rewards[B]
  assert.equal(b > a, true)
  assert.equal(b < a * 2n, true)
})

test("minSamples gates weight to zero when insufficient", () => {
  const stats: EpochNodeStats[] = [
    { nodeId: A, uptimeBps: 9000, storageBps: 8000, relayBps: 6000, storageGb: 100n, uptimeSamples: 2, storageSamples: 2, relaySamples: 2 },
    { nodeId: B, uptimeBps: 8500, storageBps: 8000, relayBps: 6000, storageGb: 100n, uptimeSamples: 10, storageSamples: 10, relaySamples: 10 },
  ]

  const cfg = { ...DEFAULT_SCORING_CONFIG, minSamples: 5 }
  const result = computeEpochRewards(1_000_000n, stats, cfg)

  // A has insufficient samples, should get 0
  assert.equal(result.rewards[A], 0n)
  // B should get all rewards
  assert.equal(result.rewards[B], 1_000_000n)
})

test("minSamples allows scoring when samples are sufficient", () => {
  const stats: EpochNodeStats[] = [
    { nodeId: A, uptimeBps: 9000, storageBps: 8000, relayBps: 6000, storageGb: 100n, uptimeSamples: 10, storageSamples: 10, relaySamples: 10 },
    { nodeId: B, uptimeBps: 8500, storageBps: 8000, relayBps: 6000, storageGb: 100n, uptimeSamples: 10, storageSamples: 10, relaySamples: 10 },
  ]

  const cfg = { ...DEFAULT_SCORING_CONFIG, minSamples: 5 }
  const result = computeEpochRewards(1_000_000n, stats, cfg)

  // Both nodes should get rewards
  assert.equal(result.rewards[A] > 0n, true)
  assert.equal(result.rewards[B] > 0n, true)
  assert.equal(sumRewards(result.rewards) + result.treasuryOverflow, 1_000_000n)
})

test("minSamples backward compatible when samples not provided", () => {
  const stats: EpochNodeStats[] = [
    { nodeId: A, uptimeBps: 9000, storageBps: 8000, relayBps: 6000, storageGb: 100n },
    { nodeId: B, uptimeBps: 8500, storageBps: 8000, relayBps: 6000, storageGb: 100n },
  ]

  const cfg = { ...DEFAULT_SCORING_CONFIG, minSamples: 5 }
  const result = computeEpochRewards(1_000_000n, stats, cfg)

  // Without sample counts, should default to Infinity (pass check)
  assert.equal(result.rewards[A] > 0n, true)
  assert.equal(result.rewards[B] > 0n, true)
})

test("soft cap trims whale and redistributes", () => {
  const stats: EpochNodeStats[] = [
    { nodeId: A, uptimeBps: 10000, storageBps: 10000, relayBps: 10000, storageGb: 500n },
    { nodeId: B, uptimeBps: 8000, storageBps: 7000, relayBps: 5000, storageGb: 50n },
    { nodeId: C, uptimeBps: 8000, storageBps: 7000, relayBps: 5000, storageGb: 50n },
  ]

  const cfg = { ...DEFAULT_SCORING_CONFIG, softCapMultiplier: 1n }
  const result = computeEpochRewards(2_000_000n, stats, cfg)
  assert.equal(result.cappedNodes.includes(A), true)
  assert.equal(result.rewards[A] <= result.rewards[B] * 2n, true)
  assert.equal(sumRewards(result.rewards) + result.treasuryOverflow, 2_000_000n)
})
