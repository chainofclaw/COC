import test from "node:test"
import assert from "node:assert/strict"
import { retryAsync } from "./retry.ts"

test("retryAsync retries transient failures", async () => {
  let attempts = 0
  const result = await retryAsync(async () => {
    attempts += 1
    if (attempts < 3) {
      throw new Error("try again")
    }
    return "ok"
  }, { retries: 3, baseDelayMs: 1, jitterMs: 0 })

  assert.equal(result, "ok")
  assert.equal(attempts, 3)
})

test("retryAsync stops when shouldRetry returns false", async () => {
  let attempts = 0
  await assert.rejects(
    () => retryAsync(async () => {
      attempts += 1
      throw new Error("fatal")
    }, {
      retries: 5,
      baseDelayMs: 1,
      jitterMs: 0,
      shouldRetry: () => false,
    }),
    /fatal/,
  )
  assert.equal(attempts, 1)
})
