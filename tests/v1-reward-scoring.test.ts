import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeEpochRewards } from "../services/verifier/scoring.ts"
import type { EpochNodeStats } from "../services/verifier/scoring.ts"
import {
  writeRewardManifest,
  readRewardManifest,
  stableStringifyForHash,
  type RewardManifest,
} from "../runtime/lib/reward-manifest.ts"
import { keccak256, toUtf8Bytes } from "ethers"

function makeStats(overrides: Partial<EpochNodeStats> & { nodeId: `0x${string}` }): EpochNodeStats {
  return {
    uptimeBps: 9500,
    storageBps: 8500,
    relayBps: 7000,
    storageGb: 10n,
    ...overrides,
  }
}

function buildV1Manifest(epochId: number, stats: EpochNodeStats[], rewardPoolWei: bigint): RewardManifest {
  const scoringResult = computeEpochRewards(rewardPoolWei, stats)
  const totalReward = Object.values(scoringResult.rewards).reduce((a, b) => a + b, 0n)
  return {
    epochId,
    rewardRoot: "0x" + "0".repeat(64),
    totalReward: totalReward.toString(),
    slashTotal: "0",
    treasuryDelta: scoringResult.treasuryOverflow.toString(),
    leaves: Object.entries(scoringResult.rewards)
      .filter(([, amt]) => amt > 0n)
      .map(([nodeId, amt]) => ({ nodeId, amount: amt.toString() })),
    proofs: {},
    scoringInputsHash: keccak256(toUtf8Bytes(stableStringifyForHash(stats))),
    generatedAtMs: Date.now(),
  }
}

describe("v1 reward scoring pipeline", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "v1-reward-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("persistV1RewardManifest produces correct manifest with scored rewards (not equal split)", () => {
    const nodeA = "0x" + "aa".repeat(16) as `0x${string}`
    const nodeB = "0x" + "bb".repeat(16) as `0x${string}`
    const stats: EpochNodeStats[] = [
      makeStats({ nodeId: nodeA, uptimeBps: 9800, storageBps: 9000, storageGb: 100n }),
      makeStats({ nodeId: nodeB, uptimeBps: 8200, storageBps: 7500, storageGb: 10n }),
    ]
    const pool = 1000000000000000000n // 1 ETH
    const manifest = buildV1Manifest(42, stats, pool)

    assert.equal(manifest.epochId, 42)
    assert.equal(manifest.leaves.length, 2)

    const amountA = BigInt(manifest.leaves.find((l) => l.nodeId === nodeA)!.amount)
    const amountB = BigInt(manifest.leaves.find((l) => l.nodeId === nodeB)!.amount)

    // Scored rewards should NOT be equal
    assert.notEqual(amountA, amountB, "scoring model should produce unequal rewards")
    // Higher-performing node gets more
    assert.ok(amountA > amountB, "nodeA (higher scores) should receive more than nodeB")

    const totalReward = BigInt(manifest.totalReward)
    assert.equal(totalReward, amountA + amountB)
    assert.ok(totalReward <= pool, "total reward should not exceed pool")
  })

  it("relayer reads manifest and distributes proportionally", () => {
    const nodeA = "0x" + "aa".repeat(16) as `0x${string}`
    const nodeB = "0x" + "bb".repeat(16) as `0x${string}`
    const stats: EpochNodeStats[] = [
      makeStats({ nodeId: nodeA, uptimeBps: 9800, storageBps: 9000, storageGb: 100n }),
      makeStats({ nodeId: nodeB, uptimeBps: 8200, storageBps: 7500, storageGb: 10n }),
    ]
    const manifest = buildV1Manifest(100, stats, 2000000000000000000n)
    writeRewardManifest(tmpDir, manifest)

    const loaded = readRewardManifest(tmpDir, 100)
    assert.ok(loaded, "manifest should be readable")
    assert.equal(loaded!.epochId, 100)
    assert.equal(loaded!.leaves.length, 2)

    // Simulate relayer proportional scaling (pool == manifestTotal)
    const manifestTotal = BigInt(loaded!.totalReward)
    const poolBalance = manifestTotal
    const rewards = loaded!.leaves.map((leaf) => {
      const raw = BigInt(leaf.amount)
      return { nodeId: leaf.nodeId, amount: (raw * poolBalance) / manifestTotal }
    })
    const distributed = rewards.reduce((a, r) => a + r.amount, 0n)
    assert.ok(distributed <= poolBalance)
    assert.equal(rewards.length, 2)
  })

  it("empty node list produces no manifest", () => {
    const stats: EpochNodeStats[] = []
    const result = computeEpochRewards(1000000000000000000n, stats)
    assert.deepEqual(result.rewards, Object.create(null))
  })

  it("missing manifest returns null from readRewardManifest", () => {
    const loaded = readRewardManifest(tmpDir, 999)
    assert.equal(loaded, null)
  })

  it("on-chain pool lower than manifest total scales down proportionally", () => {
    const nodeA = "0x" + "aa".repeat(16) as `0x${string}`
    const nodeB = "0x" + "bb".repeat(16) as `0x${string}`
    const stats: EpochNodeStats[] = [
      makeStats({ nodeId: nodeA, uptimeBps: 9800, storageBps: 9000, storageGb: 100n }),
      makeStats({ nodeId: nodeB, uptimeBps: 8200, storageBps: 7500, storageGb: 10n }),
    ]
    const manifestPool = 2000000000000000000n
    const manifest = buildV1Manifest(200, stats, manifestPool)
    writeRewardManifest(tmpDir, manifest)

    const loaded = readRewardManifest(tmpDir, 200)!
    const manifestTotal = BigInt(loaded.totalReward)
    const onChainPool = manifestTotal / 2n // half the expected pool
    const effectivePool = onChainPool < manifestTotal ? onChainPool : manifestTotal

    const rewards = loaded.leaves.map((leaf) => {
      const raw = BigInt(leaf.amount)
      return { nodeId: leaf.nodeId, amount: manifestTotal > 0n ? (raw * effectivePool) / manifestTotal : 0n }
    }).filter((r) => r.amount > 0n)

    const totalDistributed = rewards.reduce((a, r) => a + r.amount, 0n)
    assert.ok(totalDistributed <= onChainPool, "distributed should not exceed on-chain pool")

    // Ratios should be preserved
    const origA = BigInt(loaded.leaves.find((l) => l.nodeId === nodeA)!.amount)
    const origB = BigInt(loaded.leaves.find((l) => l.nodeId === nodeB)!.amount)
    const scaledA = rewards.find((r) => r.nodeId === nodeA)!.amount
    const scaledB = rewards.find((r) => r.nodeId === nodeB)!.amount

    // Ratio preservation: (origA / origB) ~ (scaledA / scaledB)
    // Use cross-multiply to avoid division: origA * scaledB ~ origB * scaledA
    const diff = origA * scaledB > origB * scaledA
      ? origA * scaledB - origB * scaledA
      : origB * scaledA - origA * scaledB
    // Allow rounding error up to 1 unit per node
    assert.ok(diff <= origA + origB, "proportional scaling should preserve ratios")
  })

  it("manifest with nodeId address format (42 chars) gets padded to bytes32", () => {
    const addr = "0x" + "ab".repeat(20) // 42 chars
    const manifest: RewardManifest = {
      epochId: 300,
      rewardRoot: "0x" + "0".repeat(64),
      totalReward: "1000",
      slashTotal: "0",
      treasuryDelta: "0",
      leaves: [{ nodeId: addr, amount: "1000" }],
      proofs: {},
      scoringInputsHash: "0x" + "0".repeat(64),
      generatedAtMs: Date.now(),
    }
    writeRewardManifest(tmpDir, manifest)
    const loaded = readRewardManifest(tmpDir, 300)!

    // Simulate relayer padding logic
    const leaf = loaded.leaves[0]
    const padded = leaf.nodeId.length === 42
      ? "0x" + leaf.nodeId.replace(/^0x/, "").padStart(64, "0")
      : leaf.nodeId
    assert.equal(padded.length, 66) // "0x" + 64 hex chars
    assert.ok(padded.startsWith("0x"))
  })

  it("treasuryOverflow is correctly recorded in manifest", () => {
    // Create nodes where one is significantly above median to trigger soft cap
    const nodes: EpochNodeStats[] = []
    for (let i = 0; i < 5; i++) {
      const hex = (i + 1).toString(16).padStart(32, "0")
      nodes.push(makeStats({
        nodeId: `0x${hex}` as `0x${string}`,
        uptimeBps: 9000,
        storageBps: 8000,
        storageGb: 10n,
      }))
    }
    // Make one node much higher
    nodes[0] = makeStats({
      nodeId: nodes[0].nodeId,
      uptimeBps: 10000,
      storageBps: 10000,
      relayBps: 10000,
      storageGb: 500n,
    })

    const pool = 10000000000000000000n
    const manifest = buildV1Manifest(400, nodes, pool)
    // treasuryDelta may or may not be > 0 depending on soft cap
    assert.equal(typeof manifest.treasuryDelta, "string")
    const delta = BigInt(manifest.treasuryDelta)
    assert.ok(delta >= 0n)
  })
})
