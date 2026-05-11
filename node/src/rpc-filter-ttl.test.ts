import { test } from "node:test"
import assert from "node:assert/strict"
import { cleanupExpiredFilters, FILTER_TTL_MS } from "./rpc.ts"
import type { PendingFilter } from "./blockchain-types.ts"

test("#102: cleanupExpiredFilters preserves filters whose lastAccessedAtMs is fresh, even if createdAtMs is stale", () => {
  const filters = new Map<string, PendingFilter>()
  const now = Date.now()
  const wayBack = now - FILTER_TTL_MS - 60_000 // 6 min ago — well past TTL

  // Pre-fix bug: cleanup looked only at createdAtMs, so this filter
  // would be deleted even though the client polled it 10s ago.
  filters.set("0xactive", {
    id: "0xactive",
    kind: "block",
    fromBlock: 0n,
    lastCursor: 0n,
    createdAtMs: wayBack,
    lastAccessedAtMs: now - 10_000, // just polled 10s ago
  })

  // Genuinely idle filter — created and last polled long ago. Must be reaped.
  filters.set("0xidle", {
    id: "0xidle",
    kind: "log",
    fromBlock: 0n,
    lastCursor: 0n,
    createdAtMs: wayBack,
    lastAccessedAtMs: wayBack,
  })

  // No lastAccessedAtMs set (older code path) — falls back to createdAtMs.
  // Stale createdAtMs → should reap.
  filters.set("0xlegacy-stale", {
    id: "0xlegacy-stale",
    kind: "log",
    fromBlock: 0n,
    lastCursor: 0n,
    createdAtMs: wayBack,
  })

  // No lastAccessedAtMs, fresh createdAtMs → kept.
  filters.set("0xlegacy-fresh", {
    id: "0xlegacy-fresh",
    kind: "log",
    fromBlock: 0n,
    lastCursor: 0n,
    createdAtMs: now - 30_000,
  })

  cleanupExpiredFilters(filters, { force: true })

  assert.equal(filters.has("0xactive"), true, "actively polled filter must survive")
  assert.equal(filters.has("0xidle"), false, "idle filter must be reaped")
  assert.equal(filters.has("0xlegacy-stale"), false, "legacy filter with stale createdAt must be reaped")
  assert.equal(filters.has("0xlegacy-fresh"), true, "legacy filter with fresh createdAt must survive")
})

test("#102: cleanup throttles non-forced calls", () => {
  const filters = new Map<string, PendingFilter>()
  const now = Date.now()
  const wayBack = now - FILTER_TTL_MS - 60_000
  filters.set("0xs", {
    id: "0xs",
    kind: "log",
    fromBlock: 0n,
    lastCursor: 0n,
    createdAtMs: wayBack,
    lastAccessedAtMs: wayBack,
  })

  // Force-call first to set lastFilterCleanupMs to "now", reaping the entry.
  cleanupExpiredFilters(filters, { force: true })
  assert.equal(filters.has("0xs"), false)

  // Re-add a stale filter and call without force — should be throttled
  // (skipped because last cleanup happened a few microseconds ago).
  filters.set("0xs2", {
    id: "0xs2",
    kind: "log",
    fromBlock: 0n,
    lastCursor: 0n,
    createdAtMs: wayBack,
    lastAccessedAtMs: wayBack,
  })
  cleanupExpiredFilters(filters)
  assert.equal(filters.has("0xs2"), true, "throttled non-forced cleanup should skip work")
})
