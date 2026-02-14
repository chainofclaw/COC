/**
 * Tests for StoragePruner
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { StoragePruner } from "./pruner.ts"
import { BlockIndex } from "./block-index.ts"
import { MemoryDatabase } from "./db.ts"
import type { ChainBlock, Hex } from "../blockchain-types.ts"

function makeBlock(number: bigint, hash: string): ChainBlock {
  return {
    number,
    hash: hash as Hex,
    parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    proposer: "node-1",
    txs: [],
    timestamp: Math.floor(Date.now() / 1000),
    final: false,
  }
}

describe("StoragePruner", () => {
  let db: MemoryDatabase
  let blockIndex: BlockIndex
  let pruner: StoragePruner

  beforeEach(async () => {
    db = new MemoryDatabase()
    blockIndex = new BlockIndex(db)

    // Store 20 blocks
    for (let i = 1; i <= 20; i++) {
      const block = makeBlock(BigInt(i), `0x${i.toString(16).padStart(64, "0")}`)
      await blockIndex.putBlock(block)
    }
  })

  it("prunes blocks below retention height", async () => {
    pruner = new StoragePruner(db, blockIndex, { retentionBlocks: 10, batchSize: 100 })
    await pruner.init()

    const result = await pruner.prune()
    assert.equal(result.blocksRemoved, 10)
    assert.equal(result.newPruningHeight, 10n)

    // Block 10 should be pruned
    const b10 = await blockIndex.getBlockByNumber(10n)
    assert.equal(b10, null)

    // Block 11 should still exist
    const b11 = await blockIndex.getBlockByNumber(11n)
    assert.ok(b11)
    assert.equal(b11.number, 11n)
  })

  it("respects batch size limit", async () => {
    pruner = new StoragePruner(db, blockIndex, { retentionBlocks: 5, batchSize: 3 })
    await pruner.init()

    const result1 = await pruner.prune()
    assert.equal(result1.blocksRemoved, 3) // Only 3 pruned (batch limit)
    assert.equal(result1.newPruningHeight, 3n)

    const result2 = await pruner.prune()
    assert.equal(result2.blocksRemoved, 3)
    assert.equal(result2.newPruningHeight, 6n)
  })

  it("does nothing when already pruned", async () => {
    pruner = new StoragePruner(db, blockIndex, { retentionBlocks: 20, batchSize: 100 })
    await pruner.init()

    const result = await pruner.prune()
    assert.equal(result.blocksRemoved, 0)
  })

  it("persists pruning height across instances", async () => {
    pruner = new StoragePruner(db, blockIndex, { retentionBlocks: 10, batchSize: 100 })
    await pruner.init()
    await pruner.prune()
    assert.equal(pruner.getPruningHeight(), 10n)

    // Create new instance
    const pruner2 = new StoragePruner(db, blockIndex, { retentionBlocks: 10, batchSize: 100 })
    await pruner2.init()
    assert.equal(pruner2.getPruningHeight(), 10n)
  })

  it("reports storage stats", async () => {
    pruner = new StoragePruner(db, blockIndex, { retentionBlocks: 10, batchSize: 100 })
    await pruner.init()

    const statsBefore = await pruner.stats()
    assert.equal(statsBefore.latestBlock, 20n)
    assert.equal(statsBefore.pruningHeight, 0n)
    assert.equal(statsBefore.retainedBlocks, 20n)

    await pruner.prune()

    const statsAfter = await pruner.stats()
    assert.equal(statsAfter.pruningHeight, 10n)
    assert.equal(statsAfter.retainedBlocks, 10n)
  })

  it("removes block hash index on prune", async () => {
    pruner = new StoragePruner(db, blockIndex, { retentionBlocks: 10, batchSize: 100 })
    await pruner.init()
    await pruner.prune()

    // Block 5's hash should no longer resolve
    const hash5 = `0x${(5).toString(16).padStart(64, "0")}` as Hex
    const b5 = await blockIndex.getBlockByHash(hash5)
    assert.equal(b5, null)

    // Block 15's hash should still work
    const hash15 = `0x${(15).toString(16).padStart(64, "0")}` as Hex
    const b15 = await blockIndex.getBlockByHash(hash15)
    assert.ok(b15)
  })

  it("handles empty database", async () => {
    const emptyDb = new MemoryDatabase()
    const emptyIndex = new BlockIndex(emptyDb)
    pruner = new StoragePruner(emptyDb, emptyIndex, { retentionBlocks: 10, batchSize: 100 })
    await pruner.init()

    const result = await pruner.prune()
    assert.equal(result.blocksRemoved, 0)
  })

  it("returns duration in result", async () => {
    pruner = new StoragePruner(db, blockIndex, { retentionBlocks: 10, batchSize: 100 })
    await pruner.init()

    const result = await pruner.prune()
    assert.ok(result.durationMs >= 0)
  })
})
