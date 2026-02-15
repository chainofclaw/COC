import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { calculateBaseFee, genesisBaseFee } from "./base-fee.ts"

const ONE_GWEI = 1_000_000_000n
const GAS_LIMIT = 30_000_000n
const TARGET = GAS_LIMIT / 2n // 15M

describe("calculateBaseFee", () => {
  it("returns same fee when gas usage equals target", () => {
    const result = calculateBaseFee({
      parentBaseFee: 10n * ONE_GWEI,
      parentGasUsed: TARGET,
      gasLimit: GAS_LIMIT,
    })
    assert.equal(result, 10n * ONE_GWEI)
  })

  it("increases fee when gas usage exceeds target", () => {
    const base = 10n * ONE_GWEI
    const result = calculateBaseFee({
      parentBaseFee: base,
      parentGasUsed: GAS_LIMIT, // 100% utilization (2x target)
      gasLimit: GAS_LIMIT,
    })
    // delta = GAS_LIMIT - TARGET = TARGET
    // increase = base * TARGET / TARGET / 8 = base / 8
    assert.equal(result, base + base / 8n)
  })

  it("decreases fee when gas usage below target", () => {
    const base = 10n * ONE_GWEI
    const result = calculateBaseFee({
      parentBaseFee: base,
      parentGasUsed: 0n, // 0% utilization
      gasLimit: GAS_LIMIT,
    })
    // delta = TARGET - 0 = TARGET
    // decrease = base * TARGET / TARGET / 8 = base / 8
    assert.equal(result, base - base / 8n)
  })

  it("enforces minimum base fee floor (1 gwei)", () => {
    const result = calculateBaseFee({
      parentBaseFee: ONE_GWEI, // already at floor
      parentGasUsed: 0n,
      gasLimit: GAS_LIMIT,
    })
    assert.equal(result, ONE_GWEI)
  })

  it("ensures at least 1 wei increase when over target", () => {
    // Use very small base fee where calculated increase would round to 0
    const result = calculateBaseFee({
      parentBaseFee: 1n,
      parentGasUsed: TARGET + 1n, // just barely over target
      gasLimit: GAS_LIMIT,
    })
    // Increase formula would yield 0 (1n * 1n / 15M / 8 = 0), so minimum 1 is applied
    assert.equal(result, 2n)
  })

  it("handles zero gas used (empty blocks)", () => {
    const base = 5n * ONE_GWEI
    const result = calculateBaseFee({
      parentBaseFee: base,
      parentGasUsed: 0n,
      gasLimit: GAS_LIMIT,
    })
    // Should decrease by max 12.5%
    assert.equal(result, base - base / 8n)
  })

  it("uses default gas limit when not provided", () => {
    const base = 10n * ONE_GWEI
    const result = calculateBaseFee({
      parentBaseFee: base,
      parentGasUsed: TARGET,
    })
    assert.equal(result, base) // At target, no change
  })

  it("handles zero target gas gracefully", () => {
    const base = 10n * ONE_GWEI
    const result = calculateBaseFee({
      parentBaseFee: base,
      parentGasUsed: 0n,
      gasLimit: 0n, // Zero limit -> zero target
    })
    assert.equal(result, base) // Returns unchanged when target is 0
  })

  it("converges toward equilibrium over multiple blocks", () => {
    let baseFee = 10n * ONE_GWEI
    // Simulate 20 blocks all at target utilization
    for (let i = 0; i < 20; i++) {
      baseFee = calculateBaseFee({
        parentBaseFee: baseFee,
        parentGasUsed: TARGET,
        gasLimit: GAS_LIMIT,
      })
    }
    assert.equal(baseFee, 10n * ONE_GWEI) // Should stay stable
  })

  it("increases monotonically under sustained high usage", () => {
    let baseFee = ONE_GWEI
    const fees: bigint[] = [baseFee]
    for (let i = 0; i < 10; i++) {
      baseFee = calculateBaseFee({
        parentBaseFee: baseFee,
        parentGasUsed: GAS_LIMIT, // Full blocks
        gasLimit: GAS_LIMIT,
      })
      fees.push(baseFee)
    }
    // Each fee should be greater than the previous
    for (let i = 1; i < fees.length; i++) {
      assert.ok(fees[i] > fees[i - 1], `fee[${i}] (${fees[i]}) should > fee[${i - 1}] (${fees[i - 1]})`)
    }
  })

  it("decreases toward floor under sustained empty blocks", () => {
    let baseFee = 100n * ONE_GWEI
    for (let i = 0; i < 100; i++) {
      baseFee = calculateBaseFee({
        parentBaseFee: baseFee,
        parentGasUsed: 0n,
        gasLimit: GAS_LIMIT,
      })
    }
    assert.equal(baseFee, ONE_GWEI) // Should reach floor
  })
})

describe("genesisBaseFee", () => {
  it("returns 1 gwei", () => {
    assert.equal(genesisBaseFee(), ONE_GWEI)
  })
})
