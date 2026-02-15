import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hashBlockPayload, validateBlockLink, zeroHash } from "./hash.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"

function makeBlock(num: bigint, parentHash: Hex, hash?: Hex): ChainBlock {
  const b: ChainBlock = {
    number: num,
    hash: hash ?? ("0xaaa" as Hex),
    parentHash,
    proposer: "node-1",
    timestampMs: 1700000000000,
    txs: [],
    stateRoot: "0x" as Hex,
  }
  // Compute real hash if not provided
  if (!hash) {
    b.hash = hashBlockPayload(b)
  }
  return b
}

describe("zeroHash", () => {
  it("returns 66-char hex string of zeros", () => {
    const h = zeroHash()
    assert.ok(h.startsWith("0x"))
    assert.equal(h.length, 66)
    assert.equal(h, "0x" + "0".repeat(64))
  })
})

describe("hashBlockPayload", () => {
  it("returns deterministic hash for same input", () => {
    const input = {
      number: 1n,
      parentHash: zeroHash(),
      proposer: "node-1",
      timestampMs: 1700000000000,
      txs: [] as Hex[],
    }
    const h1 = hashBlockPayload(input)
    const h2 = hashBlockPayload(input)
    assert.equal(h1, h2)
  })

  it("returns different hash for different block numbers", () => {
    const base = {
      parentHash: zeroHash(),
      proposer: "node-1",
      timestampMs: 1700000000000,
      txs: [] as Hex[],
    }
    const h1 = hashBlockPayload({ ...base, number: 1n })
    const h2 = hashBlockPayload({ ...base, number: 2n })
    assert.notEqual(h1, h2)
  })

  it("returns different hash for different txs", () => {
    const base = {
      number: 1n,
      parentHash: zeroHash(),
      proposer: "node-1",
      timestampMs: 1700000000000,
    }
    const h1 = hashBlockPayload({ ...base, txs: [] })
    const h2 = hashBlockPayload({ ...base, txs: ["0xdeadbeef" as Hex] })
    assert.notEqual(h1, h2)
  })

  it("returns different hash for different proposers", () => {
    const base = {
      number: 1n,
      parentHash: zeroHash(),
      timestampMs: 1700000000000,
      txs: [] as Hex[],
    }
    const h1 = hashBlockPayload({ ...base, proposer: "node-1" })
    const h2 = hashBlockPayload({ ...base, proposer: "node-2" })
    assert.notEqual(h1, h2)
  })

  it("produces valid hex string", () => {
    const h = hashBlockPayload({
      number: 42n,
      parentHash: zeroHash(),
      proposer: "v1",
      timestampMs: 0,
      txs: [],
    })
    assert.ok(h.startsWith("0x"))
    assert.equal(h.length, 66) // 0x + 64 hex chars
    assert.ok(/^0x[0-9a-f]{64}$/.test(h))
  })
})

describe("validateBlockLink", () => {
  it("validates genesis block (no prev, number=1, parentHash=zero)", () => {
    const genesis = makeBlock(1n, zeroHash())
    assert.equal(validateBlockLink(undefined, genesis), true)
  })

  it("rejects genesis with wrong number", () => {
    const bad = makeBlock(2n, zeroHash())
    assert.equal(validateBlockLink(undefined, bad), false)
  })

  it("rejects genesis with non-zero parentHash", () => {
    const bad = makeBlock(1n, "0xdeadbeef" as Hex)
    assert.equal(validateBlockLink(undefined, bad), false)
  })

  it("validates correct chain link", () => {
    const prev = makeBlock(5n, "0x000" as Hex)
    const next = makeBlock(6n, prev.hash)
    assert.equal(validateBlockLink(prev, next), true)
  })

  it("rejects wrong parent hash", () => {
    const prev = makeBlock(5n, "0x000" as Hex)
    const next = makeBlock(6n, "0xwronghash" as Hex)
    assert.equal(validateBlockLink(prev, next), false)
  })

  it("rejects non-sequential block number", () => {
    const prev = makeBlock(5n, "0x000" as Hex)
    const next = makeBlock(7n, prev.hash) // skipped 6
    assert.equal(validateBlockLink(prev, next), false)
  })
})
