import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ChainStorage } from "./storage.ts"
import type { ChainBlock, ChainSnapshot, Hex } from "./blockchain-types.ts"

let tmpDir: string
let storage: ChainStorage

function makeBlock(num: bigint): ChainBlock {
  return {
    number: num,
    hash: `0x${num.toString(16).padStart(64, "0")}` as Hex,
    parentHash: `0x${(num - 1n).toString(16).padStart(64, "0")}` as Hex,
    proposer: "node-1",
    timestampMs: Date.now(),
    txs: [`0xaaa${num}` as Hex],
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "storage-test-"))
  storage = new ChainStorage(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("ChainStorage", () => {
  it("load returns empty snapshot for fresh directory", async () => {
    const snapshot = await storage.load()
    assert.equal(snapshot.blocks.length, 0)
    assert.equal(snapshot.updatedAtMs, 0)
  })

  it("save and load roundtrip preserves blocks", async () => {
    const blocks = [makeBlock(1n), makeBlock(2n), makeBlock(3n)]
    const snapshot: ChainSnapshot = { blocks, updatedAtMs: 1700000000000 }
    await storage.save(snapshot)

    const loaded = await storage.load()
    assert.equal(loaded.blocks.length, 3)
    assert.equal(loaded.updatedAtMs, 1700000000000)
    assert.equal(loaded.blocks[0].number, 1n)
    assert.equal(loaded.blocks[2].number, 3n)
  })

  it("preserves block fields through serialization", async () => {
    const block = makeBlock(42n)
    block.proposer = "validator-x"
    block.finalized = true
    await storage.save({ blocks: [block], updatedAtMs: 0 })

    const loaded = await storage.load()
    assert.equal(loaded.blocks[0].proposer, "validator-x")
    assert.equal(loaded.blocks[0].finalized, true)
    assert.equal(typeof loaded.blocks[0].hash, "string")
    assert.ok(loaded.blocks[0].hash.startsWith("0x"))
  })

  it("preserves BigInt block numbers", async () => {
    const block = makeBlock(999999n)
    await storage.save({ blocks: [block], updatedAtMs: 0 })

    const loaded = await storage.load()
    assert.equal(loaded.blocks[0].number, 999999n)
    assert.equal(typeof loaded.blocks[0].number, "bigint")
  })

  it("handles txs array", async () => {
    const block = makeBlock(1n)
    block.txs = ["0xdeadbeef" as Hex, "0xcafebabe" as Hex]
    await storage.save({ blocks: [block], updatedAtMs: 0 })

    const loaded = await storage.load()
    assert.equal(loaded.blocks[0].txs.length, 2)
    assert.equal(loaded.blocks[0].txs[0], "0xdeadbeef")
  })

  it("overwrites existing snapshot", async () => {
    await storage.save({ blocks: [makeBlock(1n)], updatedAtMs: 100 })
    await storage.save({ blocks: [makeBlock(5n), makeBlock(6n)], updatedAtMs: 200 })

    const loaded = await storage.load()
    assert.equal(loaded.blocks.length, 2)
    assert.equal(loaded.blocks[0].number, 5n)
    assert.equal(loaded.updatedAtMs, 200)
  })

  it("handles empty blocks array", async () => {
    await storage.save({ blocks: [], updatedAtMs: 0 })
    const loaded = await storage.load()
    assert.equal(loaded.blocks.length, 0)
  })
})
