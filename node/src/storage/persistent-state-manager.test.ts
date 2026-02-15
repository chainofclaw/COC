/**
 * PersistentStateManager tests
 */

import { test } from "node:test"
import assert from "node:assert"
import { PersistentStateManager } from "./persistent-state-manager.ts"
import { InMemoryStateTrie } from "./state-trie.ts"
import { Address, Account } from "@ethereumjs/util"

test("PersistentStateManager: put and get account", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  const account = Account.fromAccountData({ balance: 1000n, nonce: 5n })

  await sm.putAccount(addr, account)
  const retrieved = await sm.getAccount(addr)

  assert.ok(retrieved)
  assert.strictEqual(retrieved.balance, 1000n)
  assert.strictEqual(retrieved.nonce, 5n)
})

test("PersistentStateManager: get non-existent account returns undefined", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0x0000000000000000000000000000000000000001")
  const result = await sm.getAccount(addr)
  assert.strictEqual(result, undefined)
})

test("PersistentStateManager: delete account", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  const account = Account.fromAccountData({ balance: 1000n })

  await sm.putAccount(addr, account)
  await sm.deleteAccount(addr)

  // After delete, account should still exist but with zeroed fields
  const retrieved = await sm.getAccount(addr)
  assert.ok(retrieved)
  assert.strictEqual(retrieved.balance, 0n)
  assert.strictEqual(retrieved.nonce, 0n)
})

test("PersistentStateManager: storage put and get", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  const key = new Uint8Array(32)
  key[31] = 1
  const value = new Uint8Array(32)
  value[31] = 42

  await sm.putStorage(addr, key, value)
  const retrieved = await sm.getStorage(addr, key)
  assert.ok(retrieved.length > 0)
})

test("PersistentStateManager: get empty storage returns empty array", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  const key = new Uint8Array(32)
  const result = await sm.getStorage(addr, key)
  assert.strictEqual(result.length, 0)
})

test("PersistentStateManager: code put and get", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  const code = new Uint8Array([0x60, 0x80, 0x60, 0x40, 0x52])

  await sm.putCode(addr, code)
  const retrieved = await sm.getCode(addr)
  assert.deepStrictEqual(retrieved, code)
})

test("PersistentStateManager: getCodeSize", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  const code = new Uint8Array([0x60, 0x80, 0x60, 0x40, 0x52])

  await sm.putCode(addr, code)
  const size = await sm.getCodeSize(addr)
  assert.strictEqual(size, 5)
})

test("PersistentStateManager: checkpoint and revert", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  await sm.putAccount(addr, Account.fromAccountData({ balance: 100n }))

  await sm.checkpoint()
  await sm.putAccount(addr, Account.fromAccountData({ balance: 200n }))
  await sm.revert()

  const retrieved = await sm.getAccount(addr)
  assert.ok(retrieved)
  assert.strictEqual(retrieved.balance, 100n)
})

test("PersistentStateManager: accountExists", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  assert.strictEqual(await sm.accountExists(addr), false)

  await sm.putAccount(addr, Account.fromAccountData({ balance: 100n }))
  assert.strictEqual(await sm.accountExists(addr), true)
})

test("PersistentStateManager: modifyAccountFields", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  await sm.putAccount(addr, Account.fromAccountData({ balance: 100n, nonce: 1n }))

  await sm.modifyAccountFields(addr, { balance: 200n })

  const retrieved = await sm.getAccount(addr)
  assert.ok(retrieved)
  assert.strictEqual(retrieved.balance, 200n)
  assert.strictEqual(retrieved.nonce, 1n)
})

test("PersistentStateManager: modifyAccountFields creates account if not exists", async () => {
  const trie = new InMemoryStateTrie()
  const sm = new PersistentStateManager(trie)

  const addr = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
  await sm.modifyAccountFields(addr, { balance: 500n })

  const retrieved = await sm.getAccount(addr)
  assert.ok(retrieved)
  assert.strictEqual(retrieved.balance, 500n)
})
