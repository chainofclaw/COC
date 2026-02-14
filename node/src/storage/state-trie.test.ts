/**
 * State Trie tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { InMemoryStateTrie, PersistentStateTrie } from "./state-trie.ts"
import { MemoryDatabase, LevelDatabase } from "./db.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testAccount = {
  nonce: 5n,
  balance: 1000000000000000000n, // 1 ETH in wei
  storageRoot: "0x" + "0".repeat(64),
  codeHash: "0x" + "0".repeat(64),
}

test("InMemoryStateTrie: put and get account", async () => {
  const trie = new InMemoryStateTrie()

  await trie.put("0x1234", testAccount)

  const retrieved = await trie.get("0x1234")
  assert.ok(retrieved)
  assert.strictEqual(retrieved.nonce, 5n)
  assert.strictEqual(retrieved.balance, 1000000000000000000n)
})

test("InMemoryStateTrie: get non-existent account", async () => {
  const trie = new InMemoryStateTrie()

  const account = await trie.get("0x9999")
  assert.strictEqual(account, null)
})

test("InMemoryStateTrie: storage slots", async () => {
  const trie = new InMemoryStateTrie()

  const address = "0xabcd"
  const slot = "0x0000000000000000000000000000000000000000000000000000000000000001"
  const value = "0x0000000000000000000000000000000000000000000000000000000000000042"

  // Initially empty
  const initial = await trie.getStorageAt(address, slot)
  assert.strictEqual(initial, "0x0")

  // Set value
  await trie.putStorageAt(address, slot, value)

  // Retrieve value
  const retrieved = await trie.getStorageAt(address, slot)
  assert.strictEqual(retrieved, value)
})

test("InMemoryStateTrie: contract code", async () => {
  const trie = new InMemoryStateTrie()

  const code = new Uint8Array([0x60, 0x80, 0x60, 0x40]) // Simple bytecode

  // Store code
  const codeHash = await trie.putCode(code)
  assert.ok(codeHash.startsWith("0x"))
  assert.strictEqual(codeHash.length, 66) // 0x + 64 hex chars

  // Retrieve code
  const retrieved = await trie.getCode(codeHash)
  assert.ok(retrieved)
  assert.deepStrictEqual(retrieved, code)
})

test("InMemoryStateTrie: checkpoint and revert", async () => {
  const trie = new InMemoryStateTrie()

  // Initial state
  await trie.put("0x1111", { ...testAccount, nonce: 1n })

  // Checkpoint
  await trie.checkpoint()

  // Modify state
  await trie.put("0x1111", { ...testAccount, nonce: 2n })
  await trie.put("0x2222", { ...testAccount, nonce: 3n })

  // Verify modifications
  const modified1 = await trie.get("0x1111")
  assert.strictEqual(modified1?.nonce, 2n)

  const modified2 = await trie.get("0x2222")
  assert.strictEqual(modified2?.nonce, 3n)

  // Revert
  await trie.revert()

  // State should be restored
  const reverted1 = await trie.get("0x1111")
  assert.strictEqual(reverted1?.nonce, 1n)

  const reverted2 = await trie.get("0x2222")
  assert.strictEqual(reverted2, null)
})

test("InMemoryStateTrie: commit returns state root", async () => {
  const trie = new InMemoryStateTrie()

  await trie.put("0x1111", testAccount)
  await trie.put("0x2222", testAccount)

  const root = await trie.commit()
  assert.ok(root.startsWith("0x"))
  assert.strictEqual(root.length, 66)
})

test("PersistentStateTrie: basic account operations", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  await trie.put("0x5678", testAccount)

  const retrieved = await trie.get("0x5678")
  assert.ok(retrieved)
  assert.strictEqual(retrieved.nonce, 5n)
  assert.strictEqual(retrieved.balance, 1000000000000000000n)
})

test("PersistentStateTrie: storage operations", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  const address = "0xdead"
  const slot = "0x0000000000000000000000000000000000000000000000000000000000000005"
  const value = "0x00000000000000000000000000000000000000000000000000000000000000ff"

  await trie.putStorageAt(address, slot, value)

  const retrieved = await trie.getStorageAt(address, slot)
  assert.strictEqual(retrieved, value)
})

test("PersistentStateTrie: persistence across instances", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "coc-trie-test-"))

  try {
    let stateRoot: string

    // First instance
    {
      const db1 = new LevelDatabase(tmpDir, "state")
      await db1.open()
      const trie1 = new PersistentStateTrie(db1)

      await trie1.put("0xbeef", testAccount)
      stateRoot = await trie1.commit()

      await db1.close()
    }

    // Second instance - simulate restart
    {
      const db2 = new LevelDatabase(tmpDir, "state")
      await db2.open()
      const trie2 = new PersistentStateTrie(db2)
      await trie2.init() // Restore from persisted state root

      // Should retrieve the account
      const retrieved = await trie2.get("0xbeef")
      assert.ok(retrieved)
      assert.strictEqual(retrieved.nonce, 5n)

      // State root should match
      const root2 = await trie2.commit()
      assert.strictEqual(root2, stateRoot)

      await db2.close()
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("PersistentStateTrie: multiple accounts", async () => {
  const db = new MemoryDatabase()
  const trie = new PersistentStateTrie(db)

  const accounts = [
    { addr: "0xaaaa", nonce: 1n },
    { addr: "0xbbbb", nonce: 2n },
    { addr: "0xcccc", nonce: 3n },
    { addr: "0xdddd", nonce: 4n },
  ]

  // Put all accounts
  for (const acc of accounts) {
    await trie.put(acc.addr, { ...testAccount, nonce: acc.nonce })
  }

  // Verify all accounts
  for (const acc of accounts) {
    const retrieved = await trie.get(acc.addr)
    assert.ok(retrieved)
    assert.strictEqual(retrieved.nonce, acc.nonce)
  }

  // Commit and verify state root
  const root = await trie.commit()
  assert.ok(root.startsWith("0x"))
})
