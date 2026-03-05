import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { computeEpochRewards } from "./scoring.ts"
import { buildRewardRoot } from "../common/reward-tree.ts"
import type { Hex32 } from "../common/pose-types.ts"
import type { EpochNodeStats } from "./scoring.ts"

describe("Scoring determinism", () => {
  const node1 = `0x${"aa".repeat(32)}` as Hex32
  const node2 = `0x${"bb".repeat(32)}` as Hex32
  const node3 = `0x${"cc".repeat(32)}` as Hex32
  const node4 = `0x${"dd".repeat(32)}` as Hex32

  function makeStats(): EpochNodeStats[] {
    return [
      { nodeId: node1, uptimeBps: 9500, storageBps: 8200, relayBps: 6100, storageGb: 50n },
      { nodeId: node2, uptimeBps: 9800, storageBps: 7800, relayBps: 5800, storageGb: 120n },
      { nodeId: node3, uptimeBps: 8500, storageBps: 9000, relayBps: 7000, storageGb: 10n },
      { nodeId: node4, uptimeBps: 9200, storageBps: 7200, relayBps: 5200, storageGb: 200n },
    ]
  }

  it("same inputs on two runs produce identical rewardRoot", () => {
    const pool = 5000000000000000000n // 5 ETH
    const epochId = 42n

    const result1 = computeEpochRewards(pool, makeStats())
    const result2 = computeEpochRewards(pool, makeStats())

    const tree1 = buildRewardRoot(epochId, result1)
    const tree2 = buildRewardRoot(epochId, result2)

    assert.equal(tree1.root, tree2.root)
    assert.equal(tree1.leaves.length, tree2.leaves.length)

    for (let i = 0; i < tree1.leaves.length; i++) {
      assert.equal(tree1.leaves[i].nodeId, tree2.leaves[i].nodeId)
      assert.equal(tree1.leaves[i].amount, tree2.leaves[i].amount)
    }
  })

  it("different pool amounts produce different roots", () => {
    const epochId = 10n
    const stats = makeStats()

    const r1 = computeEpochRewards(1000000000000000000n, stats)
    const r2 = computeEpochRewards(2000000000000000000n, stats)

    const t1 = buildRewardRoot(epochId, r1)
    const t2 = buildRewardRoot(epochId, r2)

    assert.notEqual(t1.root, t2.root)
  })

  it("different epoch IDs produce different roots", () => {
    const pool = 1000000000000000000n
    const stats = makeStats()
    const result = computeEpochRewards(pool, stats)

    const t1 = buildRewardRoot(1n, result)
    const t2 = buildRewardRoot(2n, result)

    assert.notEqual(t1.root, t2.root)
  })

  it("order-independent: shuffled stats produce same root", () => {
    const pool = 3000000000000000000n
    const epochId = 99n

    const stats1 = makeStats()
    const stats2 = [stats1[2], stats1[0], stats1[3], stats1[1]] // shuffled

    const r1 = computeEpochRewards(pool, stats1)
    const r2 = computeEpochRewards(pool, stats2)

    const t1 = buildRewardRoot(epochId, r1)
    const t2 = buildRewardRoot(epochId, r2)

    assert.equal(t1.root, t2.root)
  })

  it("empty stats produce zero root", () => {
    const pool = 1000000000000000000n
    const result = computeEpochRewards(pool, [])
    const tree = buildRewardRoot(1n, result)
    assert.equal(tree.root, `0x${"0".repeat(64)}`)
    assert.equal(tree.leaves.length, 0)
  })

  it("100 runs produce identical roots (stress test)", () => {
    const pool = 10000000000000000000n
    const epochId = 777n
    const stats = makeStats()

    const baseline = computeEpochRewards(pool, stats)
    const baselineTree = buildRewardRoot(epochId, baseline)

    for (let i = 0; i < 100; i++) {
      const result = computeEpochRewards(pool, makeStats())
      const tree = buildRewardRoot(epochId, result)
      assert.equal(tree.root, baselineTree.root, `mismatch on run ${i}`)
    }
  })
})
