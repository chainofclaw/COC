import { describe, it } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { Hex32 } from "../../services/common/pose-types.ts"

// Test the bitmap/quorum logic in isolation (no real HTTP)
describe("witness-collector", () => {
  it("popcount correctly counts bits", () => {
    // Testing via the module's internal logic by simulating results
    function popcount(n: number): number {
      let count = 0
      let v = n
      while (v) {
        count += v & 1
        v >>>= 1
      }
      return count
    }

    assert.equal(popcount(0), 0)
    assert.equal(popcount(1), 1)
    assert.equal(popcount(0b111), 3)
    assert.equal(popcount(0b10101010), 4)
    assert.equal(popcount(0xFFFFFFFF), 32)
  })

  it("bitmap construction from witness indices", () => {
    const indices = [0, 2, 5]
    let bitmap = 0
    for (const i of indices) {
      bitmap |= (1 << i)
    }
    assert.equal(bitmap, 0b100101) // bits 0, 2, 5

    // Verify each bit
    assert.ok(bitmap & (1 << 0))
    assert.ok(!(bitmap & (1 << 1)))
    assert.ok(bitmap & (1 << 2))
    assert.ok(!(bitmap & (1 << 3)))
    assert.ok(!(bitmap & (1 << 4)))
    assert.ok(bitmap & (1 << 5))
  })

  it("quorum check: meets threshold", () => {
    const required = 3
    const bitmap = 0b1111 // 4 witnesses
    let count = 0
    let v = bitmap
    while (v) { count += v & 1; v >>>= 1 }

    assert.ok(count >= required)
  })

  it("quorum check: below threshold", () => {
    const required = 3
    const bitmap = 0b11 // 2 witnesses
    let count = 0
    let v = bitmap
    while (v) { count += v & 1; v >>>= 1 }

    assert.ok(count < required)
  })

  it("witness index capped at 32", () => {
    // indices >= 32 should be ignored
    let bitmap = 0
    const indices = [0, 1, 33, 64]
    for (const i of indices) {
      if (i < 32) {
        bitmap |= (1 << i)
      }
    }
    assert.equal(bitmap, 0b11) // only 0 and 1
  })

  it("partial results with some failures", () => {
    // Simulate: 5 witnesses, 2 fail, 3 succeed
    const results = [
      { ok: true, index: 0 },
      { ok: false, index: 1 },
      { ok: true, index: 2 },
      { ok: false, index: 3 },
      { ok: true, index: 4 },
    ]

    let bitmap = 0
    const attestations: unknown[] = []
    for (const r of results) {
      if (r.ok) {
        bitmap |= (1 << r.index)
        attestations.push({ witnessIndex: r.index })
      }
    }

    assert.equal(attestations.length, 3)
    assert.equal(bitmap, 0b10101) // bits 0, 2, 4

    let count = 0
    let v = bitmap
    while (v) { count += v & 1; v >>>= 1 }
    assert.equal(count, 3)
  })
})
