/**
 * Block index tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { BlockIndex } from "./block-index.ts"
import { MemoryDatabase, LevelDatabase } from "./db.ts"
import type { ChainBlock, Hex } from "../blockchain-types.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const createTestBlock = (num: number): ChainBlock => ({
  number: BigInt(num),
  hash: `0x${num.toString(16).padStart(64, "0")}` as Hex,
  parentHash: `0x${(num - 1).toString(16).padStart(64, "0")}` as Hex,
  proposer: "validator1",
  timestampMs: Date.now(),
  txs: [],
  finalized: false,
})

test("BlockIndex: put and get block by number", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const block = createTestBlock(123)
  await index.putBlock(block)

  const retrieved = await index.getBlockByNumber(123n)
  assert.ok(retrieved)
  assert.strictEqual(retrieved.number, 123n)
  assert.strictEqual(retrieved.hash, block.hash)
  assert.strictEqual(retrieved.proposer, "validator1")
})

test("BlockIndex: get block by hash", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const block = createTestBlock(456)
  await index.putBlock(block)

  const retrieved = await index.getBlockByHash(block.hash)
  assert.ok(retrieved)
  assert.strictEqual(retrieved.number, 456n)
  assert.strictEqual(retrieved.hash, block.hash)
})

test("BlockIndex: get latest block", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  // Put multiple blocks
  await index.putBlock(createTestBlock(100))
  await index.putBlock(createTestBlock(101))
  await index.putBlock(createTestBlock(102))

  const latest = await index.getLatestBlock()
  assert.ok(latest)
  assert.strictEqual(latest.number, 102n)
})

test("BlockIndex: get non-existent block", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const byNum = await index.getBlockByNumber(999n)
  assert.strictEqual(byNum, null)

  const byHash = await index.getBlockByHash("0x1234" as Hex)
  assert.strictEqual(byHash, null)
})

test("BlockIndex: put and get transaction", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const tx = {
    rawTx: "0xabcd" as Hex,
    receipt: {
      transactionHash: "0x1111" as Hex,
      blockNumber: 100n,
      blockHash: "0xaaaa" as Hex,
      from: "0xfrom" as Hex,
      to: "0xto" as Hex,
      gasUsed: 21000n,
      status: 1n,
      logs: [],
    },
  }

  await index.putTransaction("0x1111" as Hex, tx)

  const retrieved = await index.getTransactionByHash("0x1111" as Hex)
  assert.ok(retrieved)
  assert.strictEqual(retrieved.rawTx, "0xabcd")
  assert.strictEqual(retrieved.receipt.blockNumber, 100n)
  assert.strictEqual(retrieved.receipt.gasUsed, 21000n)
})

test("BlockIndex: persistence across restarts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-block-test-"))

  try {
    // First session
    const db1 = new LevelDatabase(tmpDir, "blocks")
    await db1.open()
    const index1 = new BlockIndex(db1)

    const block = createTestBlock(777)
    await index1.putBlock(block)

    await db1.close()

    // Second session - simulate restart
    const db2 = new LevelDatabase(tmpDir, "blocks")
    await db2.open()
    const index2 = new BlockIndex(db2)

    const retrieved = await index2.getBlockByNumber(777n)
    assert.ok(retrieved)
    assert.strictEqual(retrieved.number, 777n)
    assert.strictEqual(retrieved.hash, block.hash)

    await db2.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("BlockIndex: multiple blocks in sequence", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  // Put blocks 1-10
  for (let i = 1; i <= 10; i++) {
    await index.putBlock(createTestBlock(i))
  }

  // Verify all blocks
  for (let i = 1; i <= 10; i++) {
    const block = await index.getBlockByNumber(BigInt(i))
    assert.ok(block)
    assert.strictEqual(block.number, BigInt(i))
  }

  // Latest should be block 10
  const latest = await index.getLatestBlock()
  assert.ok(latest)
  assert.strictEqual(latest.number, 10n)
})
