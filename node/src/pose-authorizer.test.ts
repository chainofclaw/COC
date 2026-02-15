import test from "node:test"
import assert from "node:assert/strict"
import { CachedPoseChallengerAuthorizer } from "./pose-authorizer.ts"

test("allows static allowlist match and rejects non-match when no dynamic resolver", async () => {
  const authorizer = new CachedPoseChallengerAuthorizer({
    staticAllowlist: ["0xabc"],
  })

  assert.equal(await authorizer.isAllowed("0xAbC"), true)
  assert.equal(await authorizer.isAllowed("0xdef"), false)
})

test("empty static allowlist without dynamic resolver remains allow-all", async () => {
  const authorizer = new CachedPoseChallengerAuthorizer()
  assert.equal(await authorizer.isAllowed("0xabc"), true)
})

test("caches dynamic resolver result by senderId", async () => {
  let calls = 0
  const authorizer = new CachedPoseChallengerAuthorizer({
    cacheTtlMs: 30_000,
    dynamicResolver: async (senderId) => {
      calls += 1
      return senderId === "0xabc"
    },
  })

  assert.equal(await authorizer.isAllowed("0xabc"), true)
  assert.equal(await authorizer.isAllowed("0xabc"), true)
  assert.equal(calls, 1)
})

test("supports fail-open mode when dynamic resolver throws", async () => {
  const strict = new CachedPoseChallengerAuthorizer({
    dynamicResolver: async () => {
      throw new Error("boom")
    },
  })
  const failOpen = new CachedPoseChallengerAuthorizer({
    failOpen: true,
    dynamicResolver: async () => {
      throw new Error("boom")
    },
  })

  assert.equal(await strict.isAllowed("0xabc"), false)
  assert.equal(await failOpen.isAllowed("0xabc"), true)
})
