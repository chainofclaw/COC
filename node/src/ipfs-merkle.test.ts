import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hashLeaf, buildMerkleRoot, buildMerklePath, hashPair, hexToBytes, zeroHash } from "./ipfs-merkle.ts"
import type { Hex } from "./ipfs-types.ts"

describe("zeroHash", () => {
  it("returns 0x + 64 zeros", () => {
    const h = zeroHash()
    assert.equal(h.length, 66)
    assert.ok(h.startsWith("0x"))
    assert.equal(h, "0x" + "0".repeat(64))
  })
})

describe("hashLeaf", () => {
  it("produces deterministic hex hash", () => {
    const data = new TextEncoder().encode("hello")
    const h1 = hashLeaf(data)
    const h2 = hashLeaf(data)
    assert.equal(h1, h2)
    assert.ok(h1.startsWith("0x"))
    assert.equal(h1.length, 66)
  })

  it("different data produces different hash", () => {
    const a = hashLeaf(new TextEncoder().encode("a"))
    const b = hashLeaf(new TextEncoder().encode("b"))
    assert.notEqual(a, b)
  })
})

describe("hexToBytes", () => {
  it("converts hex string to bytes", () => {
    const bytes = hexToBytes("0xdeadbeef" as Hex)
    assert.equal(bytes.length, 4)
    assert.equal(bytes[0], 0xde)
    assert.equal(bytes[3], 0xef)
  })
})

describe("hashPair", () => {
  it("is deterministic", () => {
    const a = hashLeaf(new TextEncoder().encode("left"))
    const b = hashLeaf(new TextEncoder().encode("right"))
    assert.equal(hashPair(a, b), hashPair(a, b))
  })

  it("is order-sensitive", () => {
    const a = hashLeaf(new TextEncoder().encode("x"))
    const b = hashLeaf(new TextEncoder().encode("y"))
    assert.notEqual(hashPair(a, b), hashPair(b, a))
  })
})

describe("buildMerkleRoot", () => {
  it("returns zeroHash for empty leaves", () => {
    assert.equal(buildMerkleRoot([]), zeroHash())
  })

  it("returns leaf hash for single leaf", () => {
    const leaf = hashLeaf(new TextEncoder().encode("single"))
    assert.equal(buildMerkleRoot([leaf]), leaf)
  })

  it("is deterministic for multiple leaves", () => {
    const leaves = ["a", "b", "c", "d"].map((s) =>
      hashLeaf(new TextEncoder().encode(s))
    )
    assert.equal(buildMerkleRoot(leaves), buildMerkleRoot(leaves))
  })

  it("handles odd number of leaves (duplicates last)", () => {
    const leaves = ["x", "y", "z"].map((s) =>
      hashLeaf(new TextEncoder().encode(s))
    )
    const root = buildMerkleRoot(leaves)
    assert.ok(root.startsWith("0x"))
    assert.equal(root.length, 66)
  })

  it("different leaves produce different roots", () => {
    const a = ["1", "2"].map((s) => hashLeaf(new TextEncoder().encode(s)))
    const b = ["3", "4"].map((s) => hashLeaf(new TextEncoder().encode(s)))
    assert.notEqual(buildMerkleRoot(a), buildMerkleRoot(b))
  })
})

describe("buildMerklePath", () => {
  it("returns empty for empty leaves", () => {
    assert.deepEqual(buildMerklePath([], 0), [])
  })

  it("throws for index out of bounds", () => {
    const leaves = ["a", "b"].map((s) =>
      hashLeaf(new TextEncoder().encode(s))
    )
    assert.throws(() => buildMerklePath(leaves, 2), /out of bounds/)
    assert.throws(() => buildMerklePath(leaves, -1), /out of bounds/)
  })

  it("returns path for valid index", () => {
    const leaves = ["a", "b", "c", "d"].map((s) =>
      hashLeaf(new TextEncoder().encode(s))
    )
    const path = buildMerklePath(leaves, 0)
    assert.ok(path.length > 0)
    // For 4 leaves, path should have 2 elements (log2(4) = 2 levels)
    assert.equal(path.length, 2)
  })

  it("different indices produce different paths", () => {
    const leaves = ["a", "b", "c", "d"].map((s) =>
      hashLeaf(new TextEncoder().encode(s))
    )
    const p0 = buildMerklePath(leaves, 0)
    const p3 = buildMerklePath(leaves, 3)
    assert.notDeepEqual(p0, p3)
  })

  it("single leaf returns empty path", () => {
    const leaf = hashLeaf(new TextEncoder().encode("only"))
    const path = buildMerklePath([leaf], 0)
    assert.deepEqual(path, [])
  })
})
