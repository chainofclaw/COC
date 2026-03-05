import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  hashRewardLeaf,
  buildRewardTree,
  scoringResultToRewardLeaves,
  buildRewardRoot,
} from "./reward-tree.ts"
import { buildMerkleRoot } from "./merkle.ts"
import type { Hex32 } from "./pose-types.ts"
import type { RewardLeaf } from "./pose-types-v2.ts"
import type { EpochRewardResult } from "../verifier/scoring.ts"

describe("reward-tree", () => {
  const node1 = `0x${"aa".repeat(32)}` as Hex32
  const node2 = `0x${"bb".repeat(32)}` as Hex32
  const node3 = `0x${"cc".repeat(32)}` as Hex32

  it("hashRewardLeaf produces consistent 32-byte hash", () => {
    const leaf: RewardLeaf = { epochId: 100n, nodeId: node1, amount: 1000000000000000000n }
    const hash = hashRewardLeaf(leaf)
    assert.ok(hash.startsWith("0x"))
    assert.equal(hash.length, 66) // 0x + 64 hex chars

    // Same input → same hash
    const hash2 = hashRewardLeaf({ epochId: 100n, nodeId: node1, amount: 1000000000000000000n })
    assert.equal(hash, hash2)
  })

  it("different inputs produce different hashes", () => {
    const h1 = hashRewardLeaf({ epochId: 1n, nodeId: node1, amount: 100n })
    const h2 = hashRewardLeaf({ epochId: 1n, nodeId: node2, amount: 100n })
    const h3 = hashRewardLeaf({ epochId: 1n, nodeId: node1, amount: 200n })
    assert.notEqual(h1, h2)
    assert.notEqual(h1, h3)
  })

  it("buildRewardTree with empty leaves returns zero root", () => {
    const tree = buildRewardTree([])
    assert.equal(tree.root, `0x${"0".repeat(64)}`)
    assert.equal(tree.leafHashes.length, 0)
    assert.equal(tree.proofs.size, 0)
  })

  it("buildRewardTree with single leaf", () => {
    const leaves: RewardLeaf[] = [{ epochId: 1n, nodeId: node1, amount: 500n }]
    const tree = buildRewardTree(leaves)
    assert.ok(tree.root.startsWith("0x"))
    assert.equal(tree.leafHashes.length, 1)
    assert.equal(tree.proofs.size, 1)
  })

  it("buildRewardTree with multiple leaves produces valid proofs", () => {
    const leaves: RewardLeaf[] = [
      { epochId: 1n, nodeId: node1, amount: 100n },
      { epochId: 1n, nodeId: node2, amount: 200n },
      { epochId: 1n, nodeId: node3, amount: 300n },
    ]

    const tree = buildRewardTree(leaves)
    assert.ok(tree.root.startsWith("0x"))
    assert.equal(tree.leafHashes.length, 3)
    assert.equal(tree.proofs.size, 3)

    // Root should match independently computed root
    const independentRoot = buildMerkleRoot(tree.leafHashes)
    assert.equal(tree.root, independentRoot)
  })

  it("deterministic ordering: same inputs produce same root", () => {
    const leaves: RewardLeaf[] = [
      { epochId: 1n, nodeId: node3, amount: 300n },
      { epochId: 1n, nodeId: node1, amount: 100n },
      { epochId: 1n, nodeId: node2, amount: 200n },
    ]

    const tree1 = buildRewardTree(leaves)

    // Reverse order
    const leavesReversed: RewardLeaf[] = [
      { epochId: 1n, nodeId: node2, amount: 200n },
      { epochId: 1n, nodeId: node3, amount: 300n },
      { epochId: 1n, nodeId: node1, amount: 100n },
    ]

    const tree2 = buildRewardTree(leavesReversed)

    assert.equal(tree1.root, tree2.root)
    assert.deepEqual(tree1.leafHashes, tree2.leafHashes)
  })

  it("scoringResultToRewardLeaves filters zero amounts", () => {
    const result: EpochRewardResult = {
      rewards: {
        [node1]: 100n,
        [node2]: 0n,
        [node3]: 300n,
      } as Record<Hex32, bigint>,
      bucketRewards: { uptime: 100n, storage: 0n, relay: 0n },
      cappedNodes: [],
      treasuryOverflow: 0n,
    }

    const leaves = scoringResultToRewardLeaves(5n, result)
    assert.equal(leaves.length, 2)
    assert.ok(leaves.every((l) => l.amount > 0n))
    assert.ok(leaves.every((l) => l.epochId === 5n))
  })

  it("buildRewardRoot end-to-end", () => {
    const result: EpochRewardResult = {
      rewards: {
        [node1]: 100n,
        [node2]: 200n,
      } as Record<Hex32, bigint>,
      bucketRewards: { uptime: 100n, storage: 100n, relay: 0n },
      cappedNodes: [],
      treasuryOverflow: 0n,
    }

    const { root, leaves, proofs } = buildRewardRoot(10n, result)
    assert.ok(root.startsWith("0x"))
    assert.equal(leaves.length, 2)
    assert.equal(proofs.size, 2)
  })
})
