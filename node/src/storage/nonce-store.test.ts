/**
 * Nonce store tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { InMemoryNonceStore, PersistentNonceStore } from "./nonce-store.ts"
import { MemoryDatabase, LevelDatabase } from "./db.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("InMemoryNonceStore: mark and check", async () => {
  const store = new InMemoryNonceStore()

  // Initially not used
  assert.strictEqual(await store.isUsed("nonce1"), false)

  // Mark as used
  await store.markUsed("nonce1")
  assert.strictEqual(await store.isUsed("nonce1"), true)

  // Different nonce still not used
  assert.strictEqual(await store.isUsed("nonce2"), false)
})

test("InMemoryNonceStore: cleanup old nonces", async () => {
  const store = new InMemoryNonceStore()

  // Mark nonces with different timestamps
  await store.markUsed("old1")
  await store.markUsed("old2")

  // Simulate old timestamps by cleaning up future nonces
  const futureTime = Date.now() + 10000
  const cleaned = await store.cleanup(futureTime)

  // Should have cleaned up both old nonces
  assert.strictEqual(cleaned, 2)
  assert.strictEqual(await store.isUsed("old1"), false)
  assert.strictEqual(await store.isUsed("old2"), false)
})

test("PersistentNonceStore: basic operations", async () => {
  const db = new MemoryDatabase()
  const store = new PersistentNonceStore(db)

  // Initially not used
  assert.strictEqual(await store.isUsed("nonce1"), false)

  // Mark as used
  await store.markUsed("nonce1")
  assert.strictEqual(await store.isUsed("nonce1"), true)

  // Different nonce still not used
  assert.strictEqual(await store.isUsed("nonce2"), false)
})

test("PersistentNonceStore: persistence across restarts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-nonce-test-"))

  try {
    // First session
    const db1 = new LevelDatabase(tmpDir, "nonces")
    await db1.open()
    const store1 = new PersistentNonceStore(db1)

    await store1.markUsed("persistent-nonce")
    assert.strictEqual(await store1.isUsed("persistent-nonce"), true)

    await db1.close()

    // Second session - simulate restart
    const db2 = new LevelDatabase(tmpDir, "nonces")
    await db2.open()
    const store2 = new PersistentNonceStore(db2)

    // Nonce should still be marked as used
    assert.strictEqual(await store2.isUsed("persistent-nonce"), true)

    await db2.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentNonceStore: multiple nonces", async () => {
  const db = new MemoryDatabase()
  const store = new PersistentNonceStore(db)

  const nonces = ["nonce1", "nonce2", "nonce3", "nonce4", "nonce5"]

  // Mark all nonces
  for (const nonce of nonces) {
    await store.markUsed(nonce)
  }

  // Verify all are marked
  for (const nonce of nonces) {
    assert.strictEqual(await store.isUsed(nonce), true)
  }

  // Verify non-existent nonce
  assert.strictEqual(await store.isUsed("nonce999"), false)
})
