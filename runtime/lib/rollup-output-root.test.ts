import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { computeOutputRoot } from "./rollup-output-root.ts"
import { solidityPackedKeccak256 } from "ethers"
import type { Hex } from "./rollup-types.ts"

describe("computeOutputRoot", () => {
  const ZERO_HASH = ("0x" + "0".repeat(64)) as Hex
  const SAMPLE_STATE_ROOT = ("0x" + "ab".repeat(32)) as Hex
  const SAMPLE_BLOCK_HASH = ("0x" + "cd".repeat(32)) as Hex

  it("returns a 66-char hex string (0x + 64 hex)", () => {
    const root = computeOutputRoot(100n, SAMPLE_STATE_ROOT, SAMPLE_BLOCK_HASH)
    assert.ok(root.startsWith("0x"))
    assert.equal(root.length, 66)
  })

  it("matches manual keccak256(abi.encodePacked(uint64, bytes32, bytes32))", () => {
    const blockNumber = 42n
    const expected = solidityPackedKeccak256(
      ["uint64", "bytes32", "bytes32"],
      [blockNumber, SAMPLE_STATE_ROOT, SAMPLE_BLOCK_HASH],
    )
    const result = computeOutputRoot(blockNumber, SAMPLE_STATE_ROOT, SAMPLE_BLOCK_HASH)
    assert.equal(result, expected)
  })

  it("produces different roots for different block numbers", () => {
    const root1 = computeOutputRoot(1n, SAMPLE_STATE_ROOT, SAMPLE_BLOCK_HASH)
    const root2 = computeOutputRoot(2n, SAMPLE_STATE_ROOT, SAMPLE_BLOCK_HASH)
    assert.notEqual(root1, root2)
  })

  it("produces different roots for different state roots", () => {
    const stateA = ("0x" + "aa".repeat(32)) as Hex
    const stateB = ("0x" + "bb".repeat(32)) as Hex
    const root1 = computeOutputRoot(100n, stateA, SAMPLE_BLOCK_HASH)
    const root2 = computeOutputRoot(100n, stateB, SAMPLE_BLOCK_HASH)
    assert.notEqual(root1, root2)
  })

  it("produces different roots for different block hashes", () => {
    const hashA = ("0x" + "11".repeat(32)) as Hex
    const hashB = ("0x" + "22".repeat(32)) as Hex
    const root1 = computeOutputRoot(100n, SAMPLE_STATE_ROOT, hashA)
    const root2 = computeOutputRoot(100n, SAMPLE_STATE_ROOT, hashB)
    assert.notEqual(root1, root2)
  })

  it("handles zero values", () => {
    const root = computeOutputRoot(0n, ZERO_HASH, ZERO_HASH)
    assert.ok(root.startsWith("0x"))
    assert.equal(root.length, 66)
  })

  it("handles large block numbers", () => {
    const maxUint64 = (1n << 64n) - 1n
    const root = computeOutputRoot(maxUint64, SAMPLE_STATE_ROOT, SAMPLE_BLOCK_HASH)
    assert.ok(root.startsWith("0x"))
    assert.equal(root.length, 66)
  })

  it("is deterministic (same inputs always produce same output)", () => {
    const root1 = computeOutputRoot(999n, SAMPLE_STATE_ROOT, SAMPLE_BLOCK_HASH)
    const root2 = computeOutputRoot(999n, SAMPLE_STATE_ROOT, SAMPLE_BLOCK_HASH)
    assert.equal(root1, root2)
  })
})
