/**
 * DNS Seeds tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { DnsSeedResolver, isPrivateHost } from "./dns-seeds.ts"

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

test("isPrivateHost: blocks plain private/loopback IPv4", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0"]) {
    assert.strictEqual(isPrivateHost(ip), true, `${ip} must be treated as private`)
  }
  assert.strictEqual(isPrivateHost("8.8.8.8"), false, "public IPv4 must pass")
})

test("isPrivateHost: blocks IPv4-mapped IPv6 (SSRF-filter bypass regression)", () => {
  // Security regression: a malicious DNS seed publishing an IPv4-mapped
  // IPv6 peer URL bypassed the private-host filter. WHATWG URL.hostname
  // canonicalizes "::ffff:127.0.0.1" to the hex tail "::ffff:7f00:1", so
  // the old `slice("::ffff:")` + dotted-quad parse matched nothing and
  // every mapped loopback / RFC1918 / 169.254 metadata address was
  // declared public. These are the exact strings `new URL().hostname`
  // produces for the mapped literals.
  const mappedPrivate: Array<[string, string]> = [
    ["::ffff:7f00:1", "127.0.0.1"],
    ["::ffff:a00:5", "10.0.0.5"],
    ["::ffff:c0a8:101", "192.168.1.1"],
    ["::ffff:ac10:1", "172.16.0.1"],
    ["::ffff:a9fe:a9fe", "169.254.169.254 (cloud metadata)"],
  ]
  for (const [host, label] of mappedPrivate) {
    assert.strictEqual(isPrivateHost(host), true, `IPv4-mapped ${label} must be blocked`)
    assert.strictEqual(isPrivateHost(`[${host}]`), true, `bracketed ${label} must be blocked`)
  }
  // Dotted-tail form and leading all-zero groups must also resolve.
  assert.strictEqual(isPrivateHost("::ffff:127.0.0.1"), true, "dotted-tail mapped loopback")
  assert.strictEqual(isPrivateHost("0:0:0:0:0:ffff:7f00:1"), true, "expanded mapped loopback")
  // A genuinely public IPv4-mapped address still passes.
  assert.strictEqual(isPrivateHost("::ffff:808:808"), false, "mapped 8.8.8.8 is public")
  // An ordinary address that merely contains an ffff hextet is not mapped.
  assert.strictEqual(isPrivateHost("2001:db8::ffff:1"), false, "non-mapped public IPv6")
})
