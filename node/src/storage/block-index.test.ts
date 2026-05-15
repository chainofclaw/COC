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

test("#300: getLogs accepts OR-set topic slot (Array<Hex>) without TypeError", async () => {
  // Pre-fix: matchLogFilter called expected.toLowerCase() unconditionally, so
  // any caller passing a Hex[] OR-set (standard Ethereum eth_getLogs form,
  // e.g. "topic[0] is Transfer OR Approval") crashed with
  //   TypeError: expected.toLowerCase is not a function
  // surfaced as JSON-RPC -32603 to the client. The bug shipped to 88780 testnet.
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const logs: IndexedLog[] = [
    {
      address: "0xaaaa" as Hex,
      topics: ["0xTRANSFER" as Hex, "0xfrom1" as Hex],
      data: "0x01" as Hex,
      blockNumber: 1n,
      blockHash: "0xbh1" as Hex,
      transactionHash: "0xtx1" as Hex,
      transactionIndex: 0,
      logIndex: 0,
    },
    {
      address: "0xbbbb" as Hex,
      topics: ["0xAPPROVAL" as Hex, "0xfrom2" as Hex],
      data: "0x02" as Hex,
      blockNumber: 1n,
      blockHash: "0xbh1" as Hex,
      transactionHash: "0xtx2" as Hex,
      transactionIndex: 1,
      logIndex: 1,
    },
    {
      address: "0xcccc" as Hex,
      topics: ["0xMINT" as Hex, "0xfrom3" as Hex],
      data: "0x03" as Hex,
      blockNumber: 1n,
      blockHash: "0xbh1" as Hex,
      transactionHash: "0xtx3" as Hex,
      transactionIndex: 2,
      logIndex: 2,
    },
  ]
  await index.putBlock(createTestBlock(1))
  await index.putLogs(1n, logs)

  // OR-set at slot 0: should match Transfer OR Approval, NOT Mint
  const orResult = await index.getLogs({
    fromBlock: 1n,
    toBlock: 1n,
    topics: [["0xTRANSFER" as Hex, "0xAPPROVAL" as Hex]],
  })
  assert.strictEqual(orResult.length, 2,
    `OR-set must match both Transfer and Approval; got ${orResult.length}`)
  const addrs = orResult.map((l) => l.address).sort()
  assert.deepStrictEqual(addrs, ["0xaaaa", "0xbbbb"])

  // Single-element OR-set must behave like exact match
  const singletonOr = await index.getLogs({
    fromBlock: 1n,
    toBlock: 1n,
    topics: [["0xMINT" as Hex]],
  })
  assert.strictEqual(singletonOr.length, 1)
  assert.strictEqual(singletonOr[0].address, "0xcccc")

  // Empty OR-set must NOT crash and must NOT exclude (treated as null/any)
  const emptyOr = await index.getLogs({
    fromBlock: 1n,
    toBlock: 1n,
    topics: [[]],
  })
  assert.strictEqual(emptyOr.length, 3, "empty OR-set should not filter anything")

  // Mixed: slot 0 OR-set + slot 1 exact must AND across slots
  const mixed = await index.getLogs({
    fromBlock: 1n,
    toBlock: 1n,
    topics: [["0xTRANSFER" as Hex, "0xAPPROVAL" as Hex], "0xfrom2" as Hex],
  })
  assert.strictEqual(mixed.length, 1,
    "OR-set on slot 0 AND exact on slot 1 must yield only Approval-from2")
  assert.strictEqual(mixed[0].address, "0xbbbb")

  // KEY invariant: case-insensitive match still works inside OR-set
  const caseInsensitive = await index.getLogs({
    fromBlock: 1n,
    toBlock: 1n,
    topics: [["0xtransfer" as Hex, "0xAPPROVAL" as Hex]],
  })
  assert.strictEqual(caseInsensitive.length, 2,
    "OR-set match must be case-insensitive like the single-topic path")
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

test("BlockIndex: address index - putTransaction indexes from/to", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const fromAddr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex
  const toAddr = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex

  await index.putTransaction("0x1111" as Hex, {
    rawTx: "0x00" as Hex,
    receipt: {
      transactionHash: "0x1111" as Hex,
      blockNumber: 5n,
      blockHash: "0xblock5" as Hex,
      from: fromAddr,
      to: toAddr,
      gasUsed: 21000n,
      status: 1n,
      logs: [],
    },
  })

  // Query by sender
  const fromTxs = await index.getTransactionsByAddress(fromAddr)
  assert.strictEqual(fromTxs.length, 1)
  assert.strictEqual(fromTxs[0].receipt.transactionHash, "0x1111")

  // Query by recipient
  const toTxs = await index.getTransactionsByAddress(toAddr)
  assert.strictEqual(toTxs.length, 1)
  assert.strictEqual(toTxs[0].receipt.transactionHash, "0x1111")
})

test("BlockIndex: #624 contract-creation tx is indexed under the new contract address", async () => {
  // Pre-fix the address index only included receipt.from and receipt.to.
  // Contract-creation txs have `to: null` and put the new contract's address
  // in `receipt.contractAddress`, so querying coc_getTransactionsByAddress
  // for that contract returned an empty list — even though the deploy tx
  // is part of the address's history (etherscan / explorer convention).
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const deployer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex
  const contractAddr = "0xb2ff9d5e60d68a52cea3cd041b32f1390a880365" as Hex

  const deployHash = ("0x" + "de".repeat(32)) as Hex
  await index.putTransaction(deployHash, {
    rawTx: "0x00" as Hex,
    receipt: {
      transactionHash: deployHash,
      blockNumber: 5n,
      blockHash: ("0x" + "55".repeat(32)) as Hex,
      from: deployer,
      to: null,
      contractAddress: contractAddr,
      gasUsed: 54250n,
      status: 1n,
      logs: [],
    },
  })

  // Deployer still sees the tx (via from index)
  const deployerTxs = await index.getTransactionsByAddress(deployer)
  assert.strictEqual(deployerTxs.length, 1, "deployer's history includes the deploy tx")

  // NEW: contract address also surfaces the deploy tx
  const contractTxs = await index.getTransactionsByAddress(contractAddr)
  assert.strictEqual(contractTxs.length, 1, "contract address must surface its own deploy tx")
  assert.strictEqual(contractTxs[0].receipt.transactionHash, deployHash)
})

test("BlockIndex: address index - multiple txs ordered by block", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex

  for (let i = 1; i <= 5; i++) {
    await index.putTransaction(`0x${i.toString().padStart(64, "0")}` as Hex, {
      rawTx: "0x00" as Hex,
      receipt: {
        transactionHash: `0x${i.toString().padStart(64, "0")}` as Hex,
        blockNumber: BigInt(i * 10),
        blockHash: `0xblock${i}` as Hex,
        from: addr,
        to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
        gasUsed: 21000n,
        status: 1n,
        logs: [],
      },
    })
  }

  // Default: reverse order (newest first)
  const txsReverse = await index.getTransactionsByAddress(addr, { reverse: true })
  assert.strictEqual(txsReverse.length, 5)
  assert.strictEqual(txsReverse[0].receipt.blockNumber, 50n)
  assert.strictEqual(txsReverse[4].receipt.blockNumber, 10n)

  // Forward order (oldest first)
  const txsForward = await index.getTransactionsByAddress(addr, { reverse: false })
  assert.strictEqual(txsForward.length, 5)
  assert.strictEqual(txsForward[0].receipt.blockNumber, 10n)
  assert.strictEqual(txsForward[4].receipt.blockNumber, 50n)

  // Limit
  const limited = await index.getTransactionsByAddress(addr, { limit: 2, reverse: true })
  assert.strictEqual(limited.length, 2)
  assert.strictEqual(limited[0].receipt.blockNumber, 50n)
})

test("BlockIndex: address index - empty result for unknown address", async () => {
  const db = new MemoryDatabase()
  const index = new BlockIndex(db)

  const txs = await index.getTransactionsByAddress("0xcccccccccccccccccccccccccccccccccccccccc" as Hex)
  assert.strictEqual(txs.length, 0)
})
