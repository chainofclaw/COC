/**
 * Legacy migration script tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateLegacySnapshot } from "./migrate-legacy.ts"
import { LevelDatabase } from "./db.ts"
import { BlockIndex } from "./block-index.ts"
import { PersistentNonceStore } from "./nonce-store.ts"
import type { Hex } from "../blockchain-types.ts"

function createLegacySnapshot(blockCount: number): string {
  const blocks = []
  for (let i = 1; i <= blockCount; i++) {
    blocks.push({
      number: i.toString(),
      hash: `0x${i.toString(16).padStart(64, "0")}`,
      parentHash: `0x${(i - 1).toString(16).padStart(64, "0")}`,
      proposer: "node-1",
      timestampMs: Date.now() - (blockCount - i) * 3000,
      txs: [
        `0x${(i * 100).toString(16).padStart(64, "0")}`,
        `0x${(i * 100 + 1).toString(16).padStart(64, "0")}`,
      ],
      finalized: i < blockCount - 2,
    })
  }
  return JSON.stringify({ blocks, updatedAtMs: Date.now() }, null, 2)
}

test("migrate-legacy: no legacy file", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-migrate-test-"))

  try {
    const result = await migrateLegacySnapshot(tmpDir)
    assert.strictEqual(result.blocksImported, 0)
    assert.strictEqual(result.noncesMarked, 0)
    assert.strictEqual(result.legacyFileRenamed, false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("migrate-legacy: empty blocks array", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-migrate-test-"))

  try {
    writeFileSync(
      join(tmpDir, "chain.json"),
      JSON.stringify({ blocks: [], updatedAtMs: 0 })
    )

    const result = await migrateLegacySnapshot(tmpDir)
    assert.strictEqual(result.blocksImported, 0)
    assert.strictEqual(result.noncesMarked, 0)
    assert.strictEqual(result.legacyFileRenamed, false)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("migrate-legacy: successful migration", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-migrate-test-"))

  try {
    // Write legacy snapshot with 5 blocks, each with 2 txs
    writeFileSync(join(tmpDir, "chain.json"), createLegacySnapshot(5))

    const result = await migrateLegacySnapshot(tmpDir)
    assert.strictEqual(result.blocksImported, 5)
    assert.strictEqual(result.noncesMarked, 10) // 5 blocks * 2 txs
    assert.strictEqual(result.legacyFileRenamed, true)

    // Verify chain.json was renamed
    await assert.rejects(async () => await stat(join(tmpDir, "chain.json")))

    // Verify .bak file exists
    const bakContent = await readFile(join(tmpDir, "chain.json.bak"), "utf-8")
    assert.ok(bakContent.includes('"blocks"'))

    // Verify data in LevelDB
    const db = new LevelDatabase(tmpDir, "chain")
    await db.open()

    const blockIndex = new BlockIndex(db)
    const nonceStore = new PersistentNonceStore(db)

    // Check latest block
    const latest = await blockIndex.getLatestBlock()
    assert.ok(latest)
    assert.strictEqual(latest.number, 5n)

    // Check all blocks
    for (let i = 1n; i <= 5n; i++) {
      const block = await blockIndex.getBlockByNumber(i)
      assert.ok(block, `Block ${i} should exist`)
      assert.strictEqual(block.number, i)
    }

    // Check nonces
    const block1 = await blockIndex.getBlockByNumber(1n)
    assert.ok(block1)
    for (const txHash of block1.txs) {
      const isUsed = await nonceStore.isUsed(`tx:${txHash}`)
      assert.strictEqual(isUsed, true, `Nonce for ${txHash} should be marked`)
    }

    await db.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("migrate-legacy: skip if LevelDB already has data", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-migrate-test-"))

  try {
    // Pre-populate LevelDB
    const db = new LevelDatabase(tmpDir, "chain")
    await db.open()
    const blockIndex = new BlockIndex(db)
    await blockIndex.putBlock({
      number: 1n,
      hash: "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
      parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
      proposer: "node-1",
      timestampMs: Date.now(),
      txs: [],
      finalized: true,
    })
    await db.close()

    // Write legacy file
    writeFileSync(join(tmpDir, "chain.json"), createLegacySnapshot(3))

    // Should skip migration
    const result = await migrateLegacySnapshot(tmpDir)
    assert.strictEqual(result.blocksImported, 0)
    assert.strictEqual(result.legacyFileRenamed, false)

    // chain.json should NOT be renamed
    const chainStat = await stat(join(tmpDir, "chain.json"))
    assert.ok(chainStat.isFile())
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("migrate-legacy: preserves block data integrity", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-migrate-test-"))

  try {
    writeFileSync(join(tmpDir, "chain.json"), createLegacySnapshot(3))
    await migrateLegacySnapshot(tmpDir)

    const db = new LevelDatabase(tmpDir, "chain")
    await db.open()
    const blockIndex = new BlockIndex(db)

    // Verify block 2 has correct data
    const block2 = await blockIndex.getBlockByNumber(2n)
    assert.ok(block2)
    assert.strictEqual(block2.proposer, "node-1")
    assert.strictEqual(block2.txs.length, 2)
    assert.ok(block2.hash.startsWith("0x"))
    assert.ok(block2.parentHash.startsWith("0x"))

    // Verify hash-based lookup
    const byHash = await blockIndex.getBlockByHash(block2.hash)
    assert.ok(byHash)
    assert.strictEqual(byHash.number, 2n)

    await db.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
