import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  calculateExcessBlobGas,
  computeBlobGasPrice,
  TARGET_BLOB_GAS_PER_BLOCK,
  MAX_BLOB_GAS_PER_BLOCK,
} from "./base-fee.ts"

describe("calculateExcessBlobGas", () => {
  it("returns 0 when parent excess and blob gas used are both 0", () => {
    assert.equal(calculateExcessBlobGas(0n, 0n), 0n)
  })

  it("returns 0 when total is below target", () => {
    assert.equal(calculateExcessBlobGas(0n, TARGET_BLOB_GAS_PER_BLOCK - 1n), 0n)
  })

  it("returns 0 when total equals target exactly", () => {
    assert.equal(calculateExcessBlobGas(0n, TARGET_BLOB_GAS_PER_BLOCK), 0n)
  })

  it("returns excess when blob gas used exceeds target", () => {
    const used = TARGET_BLOB_GAS_PER_BLOCK + 131_072n // 1 blob over target
    const excess = calculateExcessBlobGas(0n, used)
    assert.equal(excess, 131_072n)
  })

  it("accumulates excess across blocks", () => {
    // Block 1: parent excess 0, used = max (6 blobs)
    const excess1 = calculateExcessBlobGas(0n, MAX_BLOB_GAS_PER_BLOCK)
    assert.equal(excess1, MAX_BLOB_GAS_PER_BLOCK - TARGET_BLOB_GAS_PER_BLOCK)

    // Block 2: parent excess from block 1, used = max again
    const excess2 = calculateExcessBlobGas(excess1, MAX_BLOB_GAS_PER_BLOCK)
    assert.equal(excess2, excess1 + MAX_BLOB_GAS_PER_BLOCK - TARGET_BLOB_GAS_PER_BLOCK)
  })

  it("excess drains back to 0 when no blobs used", () => {
    // Start with some excess, then no blobs used
    const initialExcess = 100_000n
    const result = calculateExcessBlobGas(initialExcess, 0n)
    // 100_000 + 0 < TARGET (393_216), so result = 0
    assert.equal(result, 0n)
  })
})

describe("computeBlobGasPrice", () => {
  it("returns 1 (minimum) when excess blob gas is 0", () => {
    assert.equal(computeBlobGasPrice(0n), 1n)
  })

  it("returns 1 for small excess values", () => {
    // With small excess, the exponential is close to 1
    assert.equal(computeBlobGasPrice(1n), 1n)
    assert.equal(computeBlobGasPrice(1000n), 1n)
  })

  it("increases with larger excess blob gas", () => {
    const price1 = computeBlobGasPrice(0n)
    const price2 = computeBlobGasPrice(10_000_000n)
    const price3 = computeBlobGasPrice(20_000_000n)
    assert.ok(price2 >= price1, "price should increase with excess")
    assert.ok(price3 > price2, "price should increase monotonically")
  })

  it("matches known EIP-4844 reference value at specific excess", () => {
    // At excessBlobGas = BLOB_GAS_PRICE_UPDATE_FRACTION (3338477),
    // price should be approximately e^1 ≈ 2.718..., so floor = 2
    const price = computeBlobGasPrice(3_338_477n)
    assert.ok(price >= 2n, `expected >= 2, got ${price}`)
    assert.ok(price <= 3n, `expected <= 3, got ${price}`)
  })
})
