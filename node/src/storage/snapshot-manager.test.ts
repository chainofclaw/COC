/**
 * Snapshot manager tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { SnapshotManager, LegacySnapshotAdapter } from "./snapshot-manager.ts"
import { BlockIndex } from "./block-index.ts"
import { InMemoryStateTrie } from "./state-trie.ts"
import { MemoryDatabase } from "./db.ts"
import type { ChainBlock, Hex } from "../blockchain-types.ts"

const createTestBlock = (num: number): ChainBlock => ({
  number: BigInt(num),
  hash: `0x${num.toString(16).padStart(64, "0")}` as Hex,
  parentHash: `0x${(num - 1).toString(16).padStart(64, "0")}` as Hex,
  proposer: "validator1",
  timestampMs: Date.now(),
  txs: [
    `0x${(num * 100).toString(16).padStart(64, "0")}` as Hex,
    `0x${(num * 100 + 1).toString(16).padStart(64, "0")}` as Hex,
  ],
  finalized: true,
})

test("SnapshotManager: create snapshot", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()

  // Add some blocks
  await blockIndex.putBlock(createTestBlock(1))
  await blockIndex.putBlock(createTestBlock(2))
  await blockIndex.putBlock(createTestBlock(3))

  // Add some state
  await stateTrie.put("0x1111", {
    nonce: 1n,
    balance: 1000n,
    storageRoot: "0x" + "0".repeat(64),
    codeHash: "0x" + "0".repeat(64),
  })

  const manager = new SnapshotManager(blockIndex, stateTrie)

  const snapshot = await manager.createSnapshot()

  assert.strictEqual(snapshot.blockNumber, 3n)
  assert.ok(snapshot.blockHash.startsWith("0x"))
  assert.ok(snapshot.stateRoot.startsWith("0x"))
  assert.strictEqual(snapshot.txCount, 6n) // 3 blocks * 2 txs each
})

test("SnapshotManager: get latest snapshot", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()

  // Empty state
  const manager = new SnapshotManager(blockIndex, stateTrie)
  const empty = await manager.getLatestSnapshot()
  assert.strictEqual(empty, null)

  // With blocks
  await blockIndex.putBlock(createTestBlock(1))

  const snapshot = await manager.getLatestSnapshot()
  assert.ok(snapshot)
  assert.strictEqual(snapshot.blockNumber, 1n)
})

test("SnapshotManager: restore from snapshot", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()

  const manager = new SnapshotManager(blockIndex, stateTrie)

  // Create initial state
  await blockIndex.putBlock(createTestBlock(1))
  await blockIndex.putBlock(createTestBlock(2))

  const snapshot = await manager.createSnapshot()

  // Restore should verify block exists
  await manager.restoreFromSnapshot(snapshot)

  // Verify block can be retrieved
  const block = await blockIndex.getBlockByNumber(2n)
  assert.ok(block)
  assert.strictEqual(block.number, 2n)
})

test("SnapshotManager: restore fails for missing block", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()

  const manager = new SnapshotManager(blockIndex, stateTrie)

  const fakeSnapshot = {
    blockNumber: 999n,
    blockHash: "0x" + "0".repeat(64),
    stateRoot: "0x" + "0".repeat(64),
    timestamp: Date.now(),
    txCount: 0n,
  }

  await assert.rejects(
    async () => await manager.restoreFromSnapshot(fakeSnapshot),
    /Block 999 not found/
  )
})

test("LegacySnapshotAdapter: export to JSON", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()

  await blockIndex.putBlock(createTestBlock(1))

  const manager = new SnapshotManager(blockIndex, stateTrie)
  const adapter = new LegacySnapshotAdapter(manager)

  const json = await adapter.exportToJSON()
  const parsed = JSON.parse(json)

  assert.strictEqual(parsed.blockNumber, "1")
  assert.ok(parsed.blockHash)
  assert.ok(parsed.stateRoot)
})

test("LegacySnapshotAdapter: import from JSON", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()

  // Pre-populate block
  await blockIndex.putBlock(createTestBlock(5))

  const manager = new SnapshotManager(blockIndex, stateTrie)
  const adapter = new LegacySnapshotAdapter(manager)

  const json = JSON.stringify({
    blockNumber: "5",
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000005",
    stateRoot: "0x" + "0".repeat(64),
    txCount: "10",
    updatedAtMs: Date.now(),
  })

  // Should not throw
  await adapter.importFromJSON(json)
})
