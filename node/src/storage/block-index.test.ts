/**
 * Block index tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { BlockIndex } from "./block-index.ts"
import type { IndexedLog } from "./block-index.ts"
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

test("BlockIndex: put and get logs", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const logs: IndexedLog[] = [
    {
      address: "0xaaaa" as Hex,
      topics: ["0xtopic1" as Hex, "0xtopic2" as Hex],
      data: "0xdata1" as Hex,
      blockNumber: 1n,
      blockHash: "0xblockhash1" as Hex,
      transactionHash: "0xtxhash1" as Hex,
      transactionIndex: 0,
      logIndex: 0,
    },
    {
      address: "0xbbbb" as Hex,
      topics: ["0xtopic3" as Hex],
      data: "0xdata2" as Hex,
      blockNumber: 1n,
      blockHash: "0xblockhash1" as Hex,
      transactionHash: "0xtxhash1" as Hex,
      transactionIndex: 0,
      logIndex: 1,
    },
  ]

  await index.putBlock(createTestBlock(1))
  await index.putLogs(1n, logs)

  // Query all logs
  const allLogs = await index.getLogs({ fromBlock: 1n, toBlock: 1n })
  assert.strictEqual(allLogs.length, 2)
  assert.strictEqual(allLogs[0].address, "0xaaaa")
  assert.strictEqual(allLogs[1].address, "0xbbbb")

  // Filter by address
  const filtered = await index.getLogs({
    fromBlock: 1n,
    toBlock: 1n,
    address: "0xaaaa" as Hex,
  })
  assert.strictEqual(filtered.length, 1)
  assert.strictEqual(filtered[0].address, "0xaaaa")

  // Filter by topic
  const byTopic = await index.getLogs({
    fromBlock: 1n,
    toBlock: 1n,
    topics: ["0xtopic3" as Hex],
  })
  assert.strictEqual(byTopic.length, 1)
  assert.strictEqual(byTopic[0].address, "0xbbbb")
})

test("BlockIndex: getLogs across multiple blocks", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  // Add logs for blocks 1-3
  for (let i = 1; i <= 3; i++) {
    await index.putBlock(createTestBlock(i))
    await index.putLogs(BigInt(i), [
      {
        address: "0xcontract" as Hex,
        topics: [`0xevent${i}` as Hex],
        data: "0x" as Hex,
        blockNumber: BigInt(i),
        blockHash: `0xblock${i}` as Hex,
        transactionHash: `0xtx${i}` as Hex,
        transactionIndex: 0,
        logIndex: 0,
      },
    ])
  }

  // Query range
  const logs = await index.getLogs({ fromBlock: 1n, toBlock: 3n })
  assert.strictEqual(logs.length, 3)

  // Partial range
  const partial = await index.getLogs({ fromBlock: 2n, toBlock: 2n })
  assert.strictEqual(partial.length, 1)
  assert.strictEqual(partial[0].blockNumber, 2n)

  // No results for empty range
  const empty = await index.getLogs({ fromBlock: 10n, toBlock: 20n })
  assert.strictEqual(empty.length, 0)
})
