import test from "node:test"
import assert from "node:assert/strict"
import { currentEpochId, resolveFinalizationCandidate } from "./epoch-utils.ts"

test("currentEpochId returns a positive integer matching hour-based epoch", () => {
  const expected = Math.floor(Date.now() / (60 * 60 * 1000))
  const result = currentEpochId()
  assert.equal(result, expected)
  assert.equal(Number.isInteger(result), true)
  assert.ok(result > 0)
})

test("resolveFinalizationCandidate returns null when candidate <= 0", () => {
  // Use a lastFinalizeEpoch that is impossibly large so candidate is always behind
  const result = resolveFinalizationCandidate(Number.MAX_SAFE_INTEGER)
  assert.equal(result, null)
})

test("resolveFinalizationCandidate returns null when candidate <= lastFinalizeEpoch", () => {
  const current = currentEpochId()
  const candidate = current - 3
  // lastFinalizeEpoch == candidate → should be null
  assert.equal(resolveFinalizationCandidate(candidate), null)
  // lastFinalizeEpoch > candidate → should also be null
  assert.equal(resolveFinalizationCandidate(candidate + 1), null)
})

test("resolveFinalizationCandidate returns candidate when eligible", () => {
  const current = currentEpochId()
  const candidate = current - 3
  // lastFinalizeEpoch is far behind
  const result = resolveFinalizationCandidate(0)
  assert.equal(result, candidate)
})

test("resolveFinalizationCandidate respects custom lagEpochs", () => {
  const current = currentEpochId()
  const result = resolveFinalizationCandidate(0, 5)
  assert.equal(result, current - 5)
})
