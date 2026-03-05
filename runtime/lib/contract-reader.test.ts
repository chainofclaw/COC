import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ContractReader } from "./contract-reader.ts"

describe("ContractReader", () => {
  it("creates with default cache TTL", () => {
    const reader = new ContractReader({
      l2RpcUrl: "http://127.0.0.1:18780",
    })
    assert.ok(reader)
  })

  it("creates with custom cache TTL", () => {
    const reader = new ContractReader({
      l2RpcUrl: "http://127.0.0.1:18780",
      cacheTtlMs: 5000,
    })
    assert.ok(reader)
  })

  it("throws when poseManagerV2Address not set for getChallengeNonce", async () => {
    const reader = new ContractReader({
      l2RpcUrl: "http://127.0.0.1:0",
    })
    await assert.rejects(
      () => reader.getChallengeNonce(1n),
      /poseManagerV2Address not configured/,
    )
  })

  it("throws when poseManagerV2Address not set for getEpochRewardRoot", async () => {
    const reader = new ContractReader({
      l2RpcUrl: "http://127.0.0.1:0",
    })
    await assert.rejects(
      () => reader.getEpochRewardRoot(1n),
      /poseManagerV2Address not configured/,
    )
  })

  it("caching: expired entries are evicted", async () => {
    const reader = new ContractReader({
      l2RpcUrl: "http://127.0.0.1:0",
      cacheTtlMs: 1, // 1ms TTL
    })

    // Access private cache for testing
    const cache = (reader as any).cache as Map<string, { value: unknown; expiresAt: number }>
    cache.set("test:key", { value: 42n, expiresAt: Date.now() - 1000 })

    const result = (reader as any).getCached("test:key")
    assert.equal(result, undefined)
    assert.equal(cache.has("test:key"), false)
  })
})
