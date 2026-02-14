/**
 * Storage layer integration tests
 *
 * Tests the interaction between different storage components
 * to ensure they work correctly together.
 */

import { test } from "node:test"
import assert from "node:assert"
import { MemoryDatabase, LevelDatabase } from "./db.ts"
import { BlockIndex } from "./block-index.ts"
import { PersistentNonceStore } from "./nonce-store.ts"
import { InMemoryStateTrie } from "./state-trie.ts"
import { SnapshotManager } from "./snapshot-manager.ts"
import { migrateLegacySnapshot } from "./migrate-legacy.ts"
import type { ChainBlock, Hex } from "../blockchain-types.ts"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const createBlock = (num: number, txCount: number = 2): ChainBlock => ({
  number: BigInt(num),
  hash: `0x${num.toString(16).padStart(64, "0")}` as Hex,
  parentHash: `0x${(num - 1).toString(16).padStart(64, "0")}` as Hex,
  proposer: "validator1",
  timestampMs: Date.now(),
  txs: Array.from({ length: txCount }, (_, i) =>
    `0x${(num * 1000 + i).toString(16).padStart(64, "0")}` as Hex
  ),
  finalized: num > 2,
})

test("Integration: Block index + Snapshot manager", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()
  const snapshotMgr = new SnapshotManager(blockIndex, stateTrie)

  // Build a small chain
  for (let i = 1; i <= 5; i++) {
    await blockIndex.putBlock(createBlock(i))
  }

  // Create snapshot
  const snapshot = await snapshotMgr.createSnapshot()

  assert.strictEqual(snapshot.blockNumber, 5n)
  assert.strictEqual(snapshot.txCount, 10n) // 5 blocks * 2 txs

  // Verify we can retrieve blocks
  for (let i = 1; i <= 5; i++) {
    const block = await blockIndex.getBlockByNumber(BigInt(i))
    assert.ok(block)
    assert.strictEqual(block.number, BigInt(i))
  }
})

test("Integration: State trie + Block index", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()

  // Simulate processing blocks with state changes
  const addresses = ["0xaaaa", "0xbbbb", "0xcccc"]

  for (let blockNum = 1; blockNum <= 3; blockNum++) {
    await blockIndex.putBlock(createBlock(blockNum))

    // Update state for each address
    for (const addr of addresses) {
      const existing = await stateTrie.get(addr)
      const nonce = existing ? existing.nonce + 1n : 1n

      await stateTrie.put(addr, {
        nonce,
        balance: BigInt(blockNum) * 1000n,
        storageRoot: "0x" + "0".repeat(64),
        codeHash: "0x" + "0".repeat(64),
      })
    }
  }

  // Verify final state
  for (const addr of addresses) {
    const state = await stateTrie.get(addr)
    assert.ok(state)
    assert.strictEqual(state.nonce, 3n)
    assert.strictEqual(state.balance, 3000n)
  }

  // Verify latest block
  const latest = await blockIndex.getLatestBlock()
  assert.ok(latest)
  assert.strictEqual(latest.number, 3n)
})

test("Integration: Nonce store + Block processing", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const nonceStore = new PersistentNonceStore(db)

  // Simulate processing blocks with nonce tracking
  for (let blockNum = 1; blockNum <= 3; blockNum++) {
    const block = createBlock(blockNum, 3)
    await blockIndex.putBlock(block)

    // Mark transaction nonces as used
    for (const txHash of block.txs) {
      const nonce = `nonce-${txHash}`
      await nonceStore.markUsed(nonce)
    }
  }

  // Verify all nonces are marked
  const block2 = await blockIndex.getBlockByNumber(2n)
  assert.ok(block2)

  for (const txHash of block2.txs) {
    const nonce = `nonce-${txHash}`
    const isUsed = await nonceStore.isUsed(nonce)
    assert.strictEqual(isUsed, true)
  }

  // Verify unused nonce
  const unusedNonce = "nonce-fake"
  const isUnused = await nonceStore.isUsed(unusedNonce)
  assert.strictEqual(isUnused, false)
})

test("Integration: Full chain restart simulation", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-integration-test-"))

  try {
    let stateRoot1: string
    let blockHash1: string

    // First session: build chain
    {
      const db = new LevelDatabase(tmpDir, "chain")
      await db.open()

      const blockIndex = new BlockIndex(db)
      const nonceStore = new PersistentNonceStore(db)
      const stateTrie = new InMemoryStateTrie()

      // Build chain with state
      for (let i = 1; i <= 3; i++) {
        const block = createBlock(i)
        await blockIndex.putBlock(block)

        // Update state
        await stateTrie.put(`0x${i}`, {
          nonce: BigInt(i),
          balance: BigInt(i) * 1000n,
          storageRoot: "0x" + "0".repeat(64),
          codeHash: "0x" + "0".repeat(64),
        })

        // Mark nonces
        for (const tx of block.txs) {
          await nonceStore.markUsed(`nonce-${tx}`)
        }
      }

      stateRoot1 = await stateTrie.commit()
      const latest = await blockIndex.getLatestBlock()
      blockHash1 = latest!.hash

      await db.close()
    }

    // Second session: verify persistence
    {
      const db = new LevelDatabase(tmpDir, "chain")
      await db.open()

      const blockIndex = new BlockIndex(db)
      const nonceStore = new PersistentNonceStore(db)

      // Verify blocks persisted
      const latest = await blockIndex.getLatestBlock()
      assert.ok(latest)
      assert.strictEqual(latest.number, 3n)
      assert.strictEqual(latest.hash, blockHash1)

      // Verify nonces persisted
      const block1 = await blockIndex.getBlockByNumber(1n)
      assert.ok(block1)

      for (const tx of block1.txs) {
        const isUsed = await nonceStore.isUsed(`nonce-${tx}`)
        assert.strictEqual(isUsed, true)
      }

      await db.close()
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Integration: Concurrent operations", async () => {
  const db = new MemoryDatabase()
  const blockIndex = new BlockIndex(db)
  const stateTrie = new InMemoryStateTrie()

  // Simulate concurrent block additions and state updates
  const operations = []

  for (let i = 1; i <= 10; i++) {
    operations.push(
      (async () => {
        await blockIndex.putBlock(createBlock(i))
        await stateTrie.put(`0x${i}`, {
          nonce: BigInt(i),
          balance: BigInt(i) * 100n,
          storageRoot: "0x" + "0".repeat(64),
          codeHash: "0x" + "0".repeat(64),
        })
      })()
    )
  }

  await Promise.all(operations)

  // Verify all operations completed
  const latest = await blockIndex.getLatestBlock()
  assert.ok(latest)
  assert.ok(latest.number >= 1n && latest.number <= 10n)

  // Verify state
  for (let i = 1; i <= 10; i++) {
    const state = await stateTrie.get(`0x${i}`)
    assert.ok(state)
    assert.strictEqual(state.nonce, BigInt(i))
  }
})

test("Integration: Legacy migration + LevelDB verification", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-integration-migrate-"))

  try {
    // Create legacy chain.json
    const blocks = []
    for (let i = 1; i <= 5; i++) {
      blocks.push({
        number: i.toString(),
        hash: `0x${i.toString(16).padStart(64, "0")}`,
        parentHash: `0x${(i - 1).toString(16).padStart(64, "0")}`,
        proposer: "node-1",
        timestampMs: Date.now(),
        txs: [
          `0x${(i * 100).toString(16).padStart(64, "0")}`,
          `0x${(i * 100 + 1).toString(16).padStart(64, "0")}`,
        ],
        finalized: i < 3,
      })
    }

    writeFileSync(
      join(tmpDir, "chain.json"),
      JSON.stringify({ blocks, updatedAtMs: Date.now() })
    )

    // Run migration
    const result = await migrateLegacySnapshot(tmpDir)
    assert.strictEqual(result.blocksImported, 5)
    assert.strictEqual(result.noncesMarked, 10)

    // Open LevelDB and verify with all storage components
    const db = new LevelDatabase(tmpDir, "chain")
    await db.open()

    const blockIndex = new BlockIndex(db)
    const nonceStore = new PersistentNonceStore(db)
    const stateTrie = new InMemoryStateTrie()
    const snapshotMgr = new SnapshotManager(blockIndex, stateTrie)

    // Verify latest block via snapshot
    const snapshot = await snapshotMgr.getLatestSnapshot()
    assert.ok(snapshot)
    assert.strictEqual(snapshot.blockNumber, 5n)

    // Verify nonce deduplication works after migration
    const block3 = await blockIndex.getBlockByNumber(3n)
    assert.ok(block3)
    for (const txHash of block3.txs) {
      const isUsed = await nonceStore.isUsed(`tx:${txHash}`)
      assert.strictEqual(isUsed, true)
    }

    // Second migration attempt should be a no-op
    const result2 = await migrateLegacySnapshot(tmpDir)
    assert.strictEqual(result2.blocksImported, 0)

    await db.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("Integration: BlockIndex query patterns with LevelDB", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-integration-query-"))

  try {
    const db = new LevelDatabase(tmpDir, "chain")
    await db.open()

    const blockIndex = new BlockIndex(db)

    // Build chain
    for (let i = 1; i <= 10; i++) {
      await blockIndex.putBlock(createBlock(i, i % 3 + 1))
    }

    // Query by number
    const block5 = await blockIndex.getBlockByNumber(5n)
    assert.ok(block5)
    assert.strictEqual(block5.number, 5n)

    // Query by hash
    const byHash = await blockIndex.getBlockByHash(block5.hash)
    assert.ok(byHash)
    assert.strictEqual(byHash.number, 5n)

    // Query latest
    const latest = await blockIndex.getLatestBlock()
    assert.ok(latest)
    assert.strictEqual(latest.number, 10n)

    // Query non-existent
    const missing = await blockIndex.getBlockByNumber(999n)
    assert.strictEqual(missing, null)

    await db.close()

    // Reopen and verify persistence
    const db2 = new LevelDatabase(tmpDir, "chain")
    await db2.open()
    const blockIndex2 = new BlockIndex(db2)

    const persistedLatest = await blockIndex2.getLatestBlock()
    assert.ok(persistedLatest)
    assert.strictEqual(persistedLatest.number, 10n)

    const persistedBlock5 = await blockIndex2.getBlockByHash(block5.hash)
    assert.ok(persistedBlock5)

    await db2.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
