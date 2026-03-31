import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { compressBatch, decompressBatch, estimateCompressionRatio } from "./rollup-batch-codec.ts"
import type { L2BlockData, Hex } from "./rollup-types.ts"

function makeBlock(num: bigint, txCount: number): L2BlockData {
  const hash = ("0x" + num.toString(16).padStart(64, "0")) as Hex
  const parentHash = ("0x" + (num > 0n ? (num - 1n).toString(16) : "0").padStart(64, "0")) as Hex
  const stateRoot = ("0x" + "ab".repeat(32)) as Hex
  const txs: Hex[] = []
  for (let i = 0; i < txCount; i++) {
    // Simple transfer tx ~110 bytes
    txs.push(("0x" + "ff".repeat(110)) as Hex)
  }
  return { number: num, hash, parentHash, stateRoot, timestampMs: Date.now(), txs }
}

describe("rollup-batch-codec", () => {
  describe("compressBatch / decompressBatch round-trip", () => {
    it("handles empty block list", () => {
      const compressed = compressBatch([])
      const result = decompressBatch(compressed)
      assert.equal(result.length, 0)
    })

    it("handles single block with no txs", () => {
      const blocks = [makeBlock(1n, 0)]
      const compressed = compressBatch(blocks)
      const result = decompressBatch(compressed)

      assert.equal(result.length, 1)
      assert.equal(result[0].number, 1n)
      assert.equal(result[0].txs.length, 0)
    })

    it("round-trips a single block with transactions", () => {
      const blocks = [makeBlock(42n, 5)]
      const compressed = compressBatch(blocks)
      const result = decompressBatch(compressed)

      assert.equal(result.length, 1)
      assert.equal(result[0].number, 42n)
      assert.equal(result[0].hash, blocks[0].hash)
      assert.equal(result[0].stateRoot, blocks[0].stateRoot)
      assert.equal(result[0].txs.length, 5)
      for (let i = 0; i < 5; i++) {
        assert.equal(result[0].txs[i], blocks[0].txs[i])
      }
    })

    it("round-trips multiple blocks", () => {
      const blocks = [makeBlock(10n, 3), makeBlock(11n, 7), makeBlock(12n, 0)]
      const compressed = compressBatch(blocks)
      const result = decompressBatch(compressed)

      assert.equal(result.length, 3)
      assert.equal(result[0].number, 10n)
      assert.equal(result[0].txs.length, 3)
      assert.equal(result[1].number, 11n)
      assert.equal(result[1].txs.length, 7)
      assert.equal(result[2].number, 12n)
      assert.equal(result[2].txs.length, 0)
    })

    it("preserves stateRoot and hash exactly", () => {
      const stateRoot = ("0x" + "cd".repeat(32)) as Hex
      const hash = ("0x" + "ef".repeat(32)) as Hex
      const block: L2BlockData = {
        number: 99n,
        hash,
        parentHash: ("0x" + "00".repeat(32)) as Hex,
        stateRoot,
        timestampMs: 1234567890,
        txs: [],
      }
      const result = decompressBatch(compressBatch([block]))
      assert.equal(result[0].hash, hash)
      assert.equal(result[0].stateRoot, stateRoot)
    })
  })

  describe("compression ratio", () => {
    it("achieves > 1x compression for typical blocks", () => {
      const blocks: L2BlockData[] = []
      for (let i = 0; i < 100; i++) {
        blocks.push(makeBlock(BigInt(i), 10))
      }
      const ratio = estimateCompressionRatio(blocks)
      assert.ok(ratio > 1, `expected compression ratio > 1, got ${ratio.toFixed(2)}`)
      console.log(`  100 blocks x 10 txs: compression ratio ${ratio.toFixed(2)}x`)
    })

    it("returns 1 for empty blocks", () => {
      const ratio = estimateCompressionRatio([])
      assert.equal(ratio, 1)
    })
  })

  describe("error handling", () => {
    it("rejects invalid codec version", async () => {
      const { deflateSync } = await import("node:zlib")
      const raw = new Uint8Array([99, 0, 0, 0, 0]) // version 99
      const compressed = deflateSync(Buffer.from(raw))
      assert.throws(() => decompressBatch(compressed), /unsupported batch codec version/)
    })

    it("rejects corrupt compressed data", () => {
      assert.throws(() => decompressBatch(new Uint8Array([1, 2, 3, 4])))
    })
  })
})
