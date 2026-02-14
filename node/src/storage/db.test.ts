/**
 * Database abstraction layer tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { MemoryDatabase, LevelDatabase } from "./db.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

test("MemoryDatabase: basic CRUD operations", async () => {
  const db = new MemoryDatabase()

  // Put
  await db.put("key1", encoder.encode("value1"))

  // Get
  const val1 = await db.get("key1")
  assert.strictEqual(decoder.decode(val1!), "value1")

  // Get non-existent
  const val2 = await db.get("key2")
  assert.strictEqual(val2, null)

  // Delete
  await db.del("key1")
  const val3 = await db.get("key1")
  assert.strictEqual(val3, null)
})

test("MemoryDatabase: batch operations", async () => {
  const db = new MemoryDatabase()

  await db.batch([
    { type: "put", key: "a", value: encoder.encode("1") },
    { type: "put", key: "b", value: encoder.encode("2") },
    { type: "put", key: "c", value: encoder.encode("3") },
  ])

  assert.strictEqual(decoder.decode((await db.get("a"))!), "1")
  assert.strictEqual(decoder.decode((await db.get("b"))!), "2")
  assert.strictEqual(decoder.decode((await db.get("c"))!), "3")

  await db.batch([
    { type: "del", key: "a" },
    { type: "put", key: "d", value: encoder.encode("4") },
  ])

  assert.strictEqual(await db.get("a"), null)
  assert.strictEqual(decoder.decode((await db.get("d"))!), "4")
})

test("MemoryDatabase: clear", async () => {
  const db = new MemoryDatabase()

  await db.put("key1", encoder.encode("value1"))
  await db.put("key2", encoder.encode("value2"))

  await db.clear()

  assert.strictEqual(await db.get("key1"), null)
  assert.strictEqual(await db.get("key2"), null)
})

test("LevelDatabase: basic CRUD operations", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-db-test-"))
  const db = new LevelDatabase(tmpDir, "test")

  try {
    await db.open()

    // Put
    await db.put("key1", encoder.encode("value1"))

    // Get
    const val1 = await db.get("key1")
    assert.strictEqual(decoder.decode(val1!), "value1")

    // Get non-existent
    const val2 = await db.get("key2")
    assert.strictEqual(val2, null)

    // Delete
    await db.del("key1")
    const val3 = await db.get("key1")
    assert.strictEqual(val3, null)

    await db.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("LevelDatabase: batch operations", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-db-test-"))
  const db = new LevelDatabase(tmpDir, "test")

  try {
    await db.open()

    await db.batch([
      { type: "put", key: "a", value: encoder.encode("1") },
      { type: "put", key: "b", value: encoder.encode("2") },
      { type: "put", key: "c", value: encoder.encode("3") },
    ])

    assert.strictEqual(decoder.decode((await db.get("a"))!), "1")
    assert.strictEqual(decoder.decode((await db.get("b"))!), "2")
    assert.strictEqual(decoder.decode((await db.get("c"))!), "3")

    await db.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("LevelDatabase: persistence across restarts", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-db-test-"))

  try {
    // First session
    const db1 = new LevelDatabase(tmpDir, "test")
    await db1.open()
    await db1.put("persistent", encoder.encode("data"))
    await db1.close()

    // Second session
    const db2 = new LevelDatabase(tmpDir, "test")
    await db2.open()
    const val = await db2.get("persistent")
    assert.strictEqual(decoder.decode(val!), "data")
    await db2.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
