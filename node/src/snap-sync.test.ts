import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  exportStateSnapshot,
  importStateSnapshot,
  validateSnapshot,
  serializeSnapshot,
  deserializeSnapshot,
} from "./state-snapshot.ts"
import type { StateSnapshot } from "./state-snapshot.ts"
import type { IStateTrie, AccountState } from "./storage/state-trie.ts"
import type { Hex } from "./blockchain-types.ts"

function createMockStateTrie(): IStateTrie & { accounts: Map<string, AccountState>; codes: Map<string, Uint8Array>; storageSlots: Map<string, Map<string, string>> } {
  const accounts = new Map<string, AccountState>()
  const codes = new Map<string, Uint8Array>()
  const storageSlots = new Map<string, Map<string, string>>()
  let root = "0x" + "a".repeat(64)

  return {
    accounts,
    codes,
    storageSlots,
    stateRoot: () => root,
    init: async () => {},
    get: async (address: string) => accounts.get(address) ?? null,
    put: async (address: string, account: AccountState) => {
      accounts.set(address, account)
    },
    delete: async () => {},
    getStorageAt: async (address: string, slot: string) => {
      return storageSlots.get(address)?.get(slot) ?? null
    },
    putStorageAt: async (address: string, slot: string, value: string) => {
      if (!storageSlots.has(address)) storageSlots.set(address, new Map())
      storageSlots.get(address)!.set(slot, value)
    },
    getCode: async (codeHash: string) => codes.get(codeHash) ?? null,
    putCode: async (code: Uint8Array) => {
      const hash = "0x" + Array.from(code).map((b) => b.toString(16).padStart(2, "0")).join("")
      codes.set(hash, code)
    },
    commit: async () => {
      root = "0x" + Math.random().toString(16).slice(2).padEnd(64, "0")
      return root
    },
    checkpoint: () => {},
    revert: async () => {},
    hasStateRoot: async () => true,
    setStateRoot: async (newRoot: string) => { root = newRoot },
    clearStorage: async (address: string) => { storageSlots.delete(address) },
    async *iterateAccounts() {
      for (const [address, state] of accounts) {
        yield { address, state: { ...state } }
      }
    },
    async *iterateStorage(address: string) {
      const slots = storageSlots.get(address)
      if (!slots) return
      for (const [slot, value] of slots) {
        yield { slot, value }
      }
    },
  }
}

describe("State snapshot export/import", () => {
  it("should export and import accounts correctly", async () => {
    // Setup source trie with accounts
    const sourceTrie = createMockStateTrie()
    const addr1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const addr2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

    await sourceTrie.put(addr1, {
      nonce: 5n,
      balance: 10000000000000000000n,
      storageRoot: "0x" + "0".repeat(64),
      codeHash: "0x" + "0".repeat(64),
    })
    await sourceTrie.put(addr2, {
      nonce: 0n,
      balance: 500000000000000000n,
      storageRoot: "0x" + "0".repeat(64),
      codeHash: "0x" + "0".repeat(64),
    })

    // Export
    const snapshot = await exportStateSnapshot(
      sourceTrie,
      [addr1, addr2],
      100n,
      "0xblockhash" as Hex,
    )

    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.accounts.length, 2)
    assert.equal(snapshot.blockHeight, "100")

    // Import into a fresh trie
    const destTrie = createMockStateTrie()
    const result = await importStateSnapshot(destTrie, snapshot)

    assert.equal(result.accountsImported, 2)

    // Verify accounts match
    const imported1 = await destTrie.get(addr1)
    assert.ok(imported1, "addr1 should be imported")
    assert.equal(imported1!.nonce, 5n)
    assert.equal(imported1!.balance, 10000000000000000000n)

    const imported2 = await destTrie.get(addr2)
    assert.ok(imported2, "addr2 should be imported")
    assert.equal(imported2!.nonce, 0n)
    assert.equal(imported2!.balance, 500000000000000000n)
  })

  it("should serialize and deserialize snapshot roundtrip", async () => {
    const trie = createMockStateTrie()
    const addr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

    await trie.put(addr, {
      nonce: 1n,
      balance: 100n,
      storageRoot: "0x" + "0".repeat(64),
      codeHash: "0x" + "0".repeat(64),
    })

    const snapshot = await exportStateSnapshot(trie, [addr], 50n, "0xabc" as Hex)
    const json = serializeSnapshot(snapshot)
    const deserialized = deserializeSnapshot(json)

    assert.equal(deserialized.version, 1)
    assert.equal(deserialized.accounts.length, 1)
    assert.equal(deserialized.blockHeight, "50")
    assert.equal(deserialized.accounts[0].address, addr)
  })

  it("should validate snapshot structure", () => {
    // Valid snapshot
    const valid: StateSnapshot = {
      version: 1,
      stateRoot: "0xabc",
      blockHeight: "100",
      blockHash: "0xdef" as Hex,
      accounts: [
        {
          address: "0xabc",
          nonce: "0",
          balance: "100",
          storageRoot: "0x0",
          codeHash: "0x0",
          storage: [],
        },
      ],
      createdAtMs: Date.now(),
    }
    assert.doesNotThrow(() => validateSnapshot(valid))

    // Invalid version
    assert.throws(() => validateSnapshot({ ...valid, version: 2 }), /unsupported snapshot version/)

    // Missing stateRoot
    assert.throws(() => validateSnapshot({ ...valid, stateRoot: "" }), /missing stateRoot/)

    // Missing accounts
    assert.throws(
      () => validateSnapshot({ ...valid, accounts: "not-array" as unknown as StateSnapshot["accounts"] }),
      /missing accounts array/,
    )
  })

  it("should handle contract code export/import", async () => {
    const sourceTrie = createMockStateTrie()
    const addr = "0xContractAddress"
    const codeBytes = new Uint8Array([0x60, 0x80, 0x60, 0x40, 0x52])
    const codeHash = "0x" + Array.from(codeBytes).map((b) => b.toString(16).padStart(2, "0")).join("")

    sourceTrie.codes.set(codeHash, codeBytes)
    await sourceTrie.put(addr, {
      nonce: 0n,
      balance: 0n,
      storageRoot: "0x" + "0".repeat(64),
      codeHash,
    })

    const snapshot = await exportStateSnapshot(sourceTrie, [addr], 10n, "0xhash" as Hex)
    assert.equal(snapshot.accounts.length, 1)
    assert.ok(snapshot.accounts[0].code, "should include contract code")

    // Import
    const destTrie = createMockStateTrie()
    const result = await importStateSnapshot(destTrie, snapshot)
    assert.equal(result.codeImported, 1)
  })

  it("should handle empty state gracefully", async () => {
    const trie = createMockStateTrie()
    const snapshot = await exportStateSnapshot(trie, [], 0n, "0x0" as Hex)

    assert.equal(snapshot.accounts.length, 0)

    const destTrie = createMockStateTrie()
    const result = await importStateSnapshot(destTrie, snapshot)
    assert.equal(result.accountsImported, 0)
  })
})
