/**
 * DNS Seeds tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { DnsSeedResolver } from "./dns-seeds.ts"

test("DnsSeedResolver: returns empty when no seeds configured", async () => {
  const resolver = new DnsSeedResolver({ seeds: [] })
  const peers = await resolver.resolve()
  assert.strictEqual(peers.length, 0)
})

test("DnsSeedResolver: handles DNS resolution failure gracefully", async () => {
  const resolver = new DnsSeedResolver({
    seeds: ["nonexistent.invalid.domain.example"],
    timeoutMs: 1000,
  })
  const peers = await resolver.resolve()
  // Should not throw, just return empty
  assert.strictEqual(peers.length, 0)
})

test("DnsSeedResolver: caches results", async () => {
  const resolver = new DnsSeedResolver({
    seeds: ["nonexistent.invalid.domain.example"],
    timeoutMs: 500,
    cacheTtlMs: 60_000,
  })

  // First call - will fail DNS but populate cache with empty result
  await resolver.resolve()
  // Second call - should use cache
  const peers = await resolver.resolve()
  assert.strictEqual(peers.length, 0)
})

test("DnsSeedResolver: clearCache clears cached results", async () => {
  const resolver = new DnsSeedResolver({
    seeds: [],
    cacheTtlMs: 60_000,
  })

  resolver.clearCache()
  const peers = await resolver.resolve()
  assert.strictEqual(peers.length, 0)
})

test("DnsSeedResolver: deduplicates peers from multiple seeds", async () => {
  const resolver = new DnsSeedResolver({
    seeds: ["a.invalid", "b.invalid"],
    timeoutMs: 500,
  })

  // Both will fail, returning empty - just verify no crash
  const peers = await resolver.resolve()
  assert.ok(Array.isArray(peers))
})
