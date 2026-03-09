import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSettledRewardManifest, createV1SettledManifest, loadAndValidateManifest, planV1RewardDistribution } from "./reward-settlement.ts"
import type { RewardManifest } from "./reward-manifest.ts"

function sampleManifest(): RewardManifest {
  return {
    epochId: 7,
    rewardRoot: `0x${"00".repeat(32)}`,
    totalReward: "100",
    slashTotal: "0",
    treasuryDelta: "0",
    leaves: [
      { nodeId: `0x${"11".repeat(32)}`, amount: "70" },
      { nodeId: `0x${"22".repeat(32)}`, amount: "30" },
    ],
    proofs: {},
    scoringInputsHash: `0x${"33".repeat(32)}`,
    generatedAtMs: 1,
  }
}

test("createSettledRewardManifest rescales leaves and rebuilds proofs", () => {
  const settled = createSettledRewardManifest(sampleManifest(), 50n)
  assert.equal(settled.settled, true)
  assert.equal(settled.sourceTotalReward, "100")
  assert.equal(settled.totalReward, "50")
  assert.equal(settled.leaves.length, 2)
  assert.equal(settled.leaves[0].amount, "35")
  assert.equal(settled.leaves[1].amount, "15")
  assert.notEqual(settled.rewardRoot, `0x${"00".repeat(32)}`)
  assert.ok(settled.proofs["7:0x1111111111111111111111111111111111111111111111111111111111111111"])
})

test("planV1RewardDistribution filters inactive nodes and enforces per-node cap", async () => {
  const manifest = sampleManifest()
  const plan = await planV1RewardDistribution(
    manifest,
    100n,
    async (nodeId) => nodeId !== `0x${"22".repeat(32)}`,
    3000n,
  )

  assert.equal(plan.totalDistributed, 30n)
  assert.deepEqual(plan.rewards, [
    { nodeId: `0x${"11".repeat(32)}`, amount: 30n },
  ])
  assert.deepEqual(plan.skippedInactiveNodeIds, [
    `0x${"22".repeat(32)}`,
  ])
})

// --- createV1SettledManifest tests ---

test("createV1SettledManifest sets audit fields correctly", async () => {
  const manifest = sampleManifest()
  const plan = await planV1RewardDistribution(manifest, 100n, async () => true)

  const settled = createV1SettledManifest(manifest, plan, 100n, {
    distributionTxHash: "0xabc123",
    distributionBlockNumber: 42,
  })

  assert.equal(settled.settled, true)
  assert.equal(settled.distributionTxHash, "0xabc123")
  assert.equal(settled.distributionBlockNumber, 42)
  assert.equal(settled.sourceTotalReward, "100")
  assert.equal(settled.settlementBudgetWei, "100")
  assert.ok(settled.settledAtMs)
  assert.deepEqual(settled.skippedInactiveNodeIds, [])
  // rewardRoot should be preserved from original
  assert.equal(settled.rewardRoot, manifest.rewardRoot)
})

test("createV1SettledManifest preserves original rewardRoot", () => {
  const manifest = sampleManifest()
  const settled = createV1SettledManifest(manifest, {
    rewards: [],
    totalDistributed: 0n,
    skippedInactiveNodeIds: [],
  }, 0n, { distributionTxHash: "0x0" })

  assert.equal(settled.rewardRoot, manifest.rewardRoot)
  assert.equal(settled.leaves.length, 0)
})

test("createV1SettledManifest records skipped inactive node ids", async () => {
  const manifest = sampleManifest()
  const plan = await planV1RewardDistribution(
    manifest, 100n,
    async (nodeId) => nodeId !== `0x${"22".repeat(32)}`,
  )

  const settled = createV1SettledManifest(manifest, plan, 100n, {
    distributionTxHash: "0xdef",
  })

  assert.deepEqual(settled.skippedInactiveNodeIds, [`0x${"22".repeat(32)}`])
})

// --- loadAndValidateManifest tests ---

const tmpDir = join("/tmp", `reward-settlement-test-${process.pid}`)

test("loadAndValidateManifest returns not_found when file does not exist", () => {
  const result = loadAndValidateManifest(tmpDir, 999999)
  assert.equal(result.status, "not_found")
  assert.equal(result.manifest, null)
})

test("loadAndValidateManifest returns empty when leaves are empty", () => {
  mkdirSync(tmpDir, { recursive: true })
  const manifest: RewardManifest = {
    ...sampleManifest(),
    epochId: 111,
    leaves: [],
  }
  writeFileSync(join(tmpDir, "reward-epoch-111.json"), JSON.stringify(manifest))

  const result = loadAndValidateManifest(tmpDir, 111)
  assert.equal(result.status, "empty")
  assert.ok(result.manifest)
  assert.equal(result.manifest!.leaves.length, 0)

  rmSync(tmpDir, { recursive: true, force: true })
})

test("loadAndValidateManifest returns ok with allowEmpty when leaves are empty", () => {
  mkdirSync(tmpDir, { recursive: true })
  const manifest: RewardManifest = {
    ...sampleManifest(),
    epochId: 112,
    leaves: [],
  }
  writeFileSync(join(tmpDir, "reward-epoch-112.json"), JSON.stringify(manifest))

  const result = loadAndValidateManifest(tmpDir, 112, { allowEmpty: true })
  assert.equal(result.status, "ok")

  rmSync(tmpDir, { recursive: true, force: true })
})

test("loadAndValidateManifest returns incomplete_coverage when missingNodeIds present", () => {
  mkdirSync(tmpDir, { recursive: true })
  const manifest: RewardManifest = {
    ...sampleManifest(),
    epochId: 113,
    missingNodeIds: ["0xdead"],
  }
  writeFileSync(join(tmpDir, "reward-epoch-113.json"), JSON.stringify(manifest))

  const result = loadAndValidateManifest(tmpDir, 113)
  assert.equal(result.status, "incomplete_coverage")
  assert.deepEqual(result.missingNodeIds, ["0xdead"])

  rmSync(tmpDir, { recursive: true, force: true })
})

test("loadAndValidateManifest returns ok for valid manifest", () => {
  mkdirSync(tmpDir, { recursive: true })
  const manifest = sampleManifest()
  const epochId = 114
  const m = { ...manifest, epochId }
  writeFileSync(join(tmpDir, `reward-epoch-${epochId}.json`), JSON.stringify(m))

  const result = loadAndValidateManifest(tmpDir, epochId)
  assert.equal(result.status, "ok")
  assert.ok(result.manifest)
  assert.equal(result.manifest!.epochId, epochId)

  rmSync(tmpDir, { recursive: true, force: true })
})
