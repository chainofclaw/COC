/**
 * Tests for runtime/diagnostics/state-diff.ts (Phase H8).
 *
 * Builds two PersistentStateTrie instances on disposable temp directories,
 * seeds known accounts + storage, then asserts the diff tool surfaces:
 *   - matching accounts
 *   - accounts only on one side
 *   - accounts on both sides with field differences
 *   - per-storage-slot differences for divergent storageRoot accounts
 */

import { test } from "node:test"
import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LevelDatabase } from "../storage/db.ts"
import { PersistentStateTrie } from "../storage/state-trie.ts"
import { compareStates } from "./state-diff.ts"

async function withTrie<T>(
  fn: (trie: PersistentStateTrie, dbPath: string) => Promise<T>,
): Promise<{ result: T; dbPath: string }> {
  const dbPath = mkdtempSync(join(tmpdir(), "coc-state-diff-test-"))
  const db = new LevelDatabase(dbPath)
  await db.open()
  const trie = new PersistentStateTrie(db)
  await trie.init()
  const result = await fn(trie, dbPath)
  await db.close()
  return { result, dbPath }
}

const ADDR_A = "0x" + "11".repeat(20)
const ADDR_B = "0x" + "22".repeat(20)
const ADDR_C = "0x" + "33".repeat(20)
const EMPTY_STORAGE_ROOT = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"

test("Phase H8: compareStates returns zero diffs when both tries identical", async () => {
  const { dbPath: dbA } = await withTrie(async (trie) => {
    await trie.put(ADDR_A, {
      nonce: 1n,
      balance: 100n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    await trie.commit()
  })
  const { dbPath: dbB } = await withTrie(async (trie) => {
    await trie.put(ADDR_A, {
      nonce: 1n,
      balance: 100n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    await trie.commit()
  })
  try {
    const report = await compareStates({ pathA: dbA, pathB: dbB })
    assert.strictEqual(report.differingCount, 0)
    assert.strictEqual(report.onlyInACount, 0)
    assert.strictEqual(report.onlyInBCount, 0)
    assert.strictEqual(report.matchingCount, 1)
  } finally {
    rmSync(dbA, { recursive: true, force: true })
    rmSync(dbB, { recursive: true, force: true })
  }
})

test("Phase H8: surfaces field-level differences (balance + nonce)", async () => {
  const { dbPath: dbA } = await withTrie(async (trie) => {
    await trie.put(ADDR_A, {
      nonce: 5n,
      balance: 100n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    await trie.commit()
  })
  const { dbPath: dbB } = await withTrie(async (trie) => {
    await trie.put(ADDR_A, {
      nonce: 5n,
      balance: 200n, // different balance
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    await trie.commit()
  })
  try {
    const report = await compareStates({ pathA: dbA, pathB: dbB })
    assert.strictEqual(report.differingCount, 1)
    const diff = report.differingAccounts[0]
    assert.strictEqual(diff.address, ADDR_A.toLowerCase())
    assert.deepStrictEqual(diff.fieldChanges, ["balance"])
    assert.strictEqual(diff.a?.balance, 100n)
    assert.strictEqual(diff.b?.balance, 200n)
  } finally {
    rmSync(dbA, { recursive: true, force: true })
    rmSync(dbB, { recursive: true, force: true })
  }
})

test("Phase H8: surfaces accounts present only on one side", async () => {
  const { dbPath: dbA } = await withTrie(async (trie) => {
    await trie.put(ADDR_A, {
      nonce: 1n,
      balance: 100n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    await trie.put(ADDR_B, {
      nonce: 0n,
      balance: 0n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    await trie.commit()
  })
  const { dbPath: dbB } = await withTrie(async (trie) => {
    await trie.put(ADDR_A, {
      nonce: 1n,
      balance: 100n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    // ADDR_C added only on side B
    await trie.put(ADDR_C, {
      nonce: 0n,
      balance: 50n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    await trie.commit()
  })
  try {
    const report = await compareStates({ pathA: dbA, pathB: dbB })
    assert.strictEqual(report.matchingCount, 1, "ADDR_A is identical")
    assert.strictEqual(report.onlyInACount, 1, "ADDR_B is in A only")
    assert.strictEqual(report.onlyInBCount, 1, "ADDR_C is in B only")
    assert.strictEqual(report.onlyInASample[0].address, ADDR_B.toLowerCase())
    assert.strictEqual(report.onlyInBSample[0].address, ADDR_C.toLowerCase())
  } finally {
    rmSync(dbA, { recursive: true, force: true })
    rmSync(dbB, { recursive: true, force: true })
  }
})

test("Phase H8: enumerates per-slot differences for accounts with divergent storageRoot", async () => {
  const SLOT_1 = "0x" + "01".padStart(64, "0")
  const SLOT_2 = "0x" + "02".padStart(64, "0")
  const SLOT_3 = "0x" + "03".padStart(64, "0")

  const { dbPath: dbA } = await withTrie(async (trie) => {
    await trie.put(ADDR_A, {
      nonce: 1n,
      balance: 100n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    await trie.putStorageAt(ADDR_A, SLOT_1, "0x" + "aa".padStart(64, "0"))
    await trie.putStorageAt(ADDR_A, SLOT_2, "0x" + "bb".padStart(64, "0"))
    await trie.commit()
  })
  const { dbPath: dbB } = await withTrie(async (trie) => {
    await trie.put(ADDR_A, {
      nonce: 1n,
      balance: 100n,
      storageRoot: EMPTY_STORAGE_ROOT,
      codeHash: EMPTY_CODE_HASH,
    })
    // Same SLOT_1 value, different SLOT_2 value, NEW SLOT_3
    await trie.putStorageAt(ADDR_A, SLOT_1, "0x" + "aa".padStart(64, "0"))
    await trie.putStorageAt(ADDR_A, SLOT_2, "0x" + "cc".padStart(64, "0"))
    await trie.putStorageAt(ADDR_A, SLOT_3, "0x" + "dd".padStart(64, "0"))
    await trie.commit()
  })
  try {
    const report = await compareStates({ pathA: dbA, pathB: dbB })
    // Account-level diff: storageRoot changed.
    assert.strictEqual(report.differingCount, 1)
    assert.ok(report.differingAccounts[0].fieldChanges?.includes("storageRoot"))
    // Storage diff: SLOT_2 differs, SLOT_3 only on B; SLOT_1 should not appear.
    assert.strictEqual(report.storageDiffs.length, 1)
    const sd = report.storageDiffs[0]
    assert.strictEqual(sd.address, ADDR_A.toLowerCase())
    assert.ok(sd.slots.has(SLOT_2.toLowerCase()), "SLOT_2 differs")
    assert.ok(sd.slots.has(SLOT_3.toLowerCase()), "SLOT_3 absent on A")
    assert.ok(!sd.slots.has(SLOT_1.toLowerCase()), "SLOT_1 matches; not in diff")
  } finally {
    rmSync(dbA, { recursive: true, force: true })
    rmSync(dbB, { recursive: true, force: true })
  }
})
