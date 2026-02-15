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
import { InMemoryStateTrie } from "./storage/state-trie.ts"
import type { Hex } from "./blockchain-types.ts"

const zeroHash = ("0x" + "00".repeat(32)) as Hex

describe("exportStateSnapshot", () => {
  it("exports accounts from state trie", async () => {
    const trie = new InMemoryStateTrie()
    await trie.put("0x1111111111111111111111111111111111111111", {
      nonce: 5n,
      balance: 1000n,
      storageRoot: "0x" + "00".repeat(32),
      codeHash: "0x" + "00".repeat(32),
    })
    await trie.commit()

    const snapshot = await exportStateSnapshot(
      trie,
      ["0x1111111111111111111111111111111111111111"],
      10n,
      zeroHash,
    )

    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.accounts.length, 1)
    assert.equal(snapshot.accounts[0].nonce, "5")
    assert.equal(snapshot.accounts[0].balance, "1000")
    assert.equal(snapshot.blockHeight, "10")
  })

  it("skips non-existent addresses", async () => {
    const trie = new InMemoryStateTrie()
    await trie.commit()

    const snapshot = await exportStateSnapshot(
      trie,
      ["0xdead000000000000000000000000000000000000"],
      1n,
      zeroHash,
    )

    assert.equal(snapshot.accounts.length, 0)
  })

  it("exports contract code", async () => {
    const trie = new InMemoryStateTrie()
    const bytecode = new Uint8Array([0x60, 0x80, 0x60, 0x40, 0x52])
    const codeHash = await trie.putCode(bytecode)

    await trie.put("0x2222222222222222222222222222222222222222", {
      nonce: 0n,
      balance: 0n,
      storageRoot: "0x" + "00".repeat(32),
      codeHash,
    })
    await trie.commit()

    const snapshot = await exportStateSnapshot(
      trie,
      ["0x2222222222222222222222222222222222222222"],
      1n,
      zeroHash,
    )

    assert.equal(snapshot.accounts.length, 1)
    assert.ok(snapshot.accounts[0].code)
    assert.ok(snapshot.accounts[0].code!.startsWith("0x"))
  })

  it("throws if trie has no committed root", async () => {
    const trie = new InMemoryStateTrie()
    await assert.rejects(
      () => exportStateSnapshot(trie, [], 1n, zeroHash),
      /no committed root/,
    )
  })
})

describe("importStateSnapshot", () => {
  it("imports accounts into a fresh trie", async () => {
    const trie = new InMemoryStateTrie()

    const snapshot: StateSnapshot = {
      version: 1,
      stateRoot: "0x" + "aa".repeat(32),
      blockHeight: "5",
      blockHash: zeroHash,
      accounts: [
        {
          address: "0x3333333333333333333333333333333333333333",
          nonce: "10",
          balance: "5000",
          storageRoot: "0x" + "00".repeat(32),
          codeHash: "0x" + "00".repeat(32),
          storage: [],
        },
      ],
      createdAtMs: Date.now(),
    }

    const result = await importStateSnapshot(trie, snapshot)
    assert.equal(result.accountsImported, 1)

    const account = await trie.get("0x3333333333333333333333333333333333333333")
    assert.ok(account)
    assert.equal(account.nonce, 10n)
    assert.equal(account.balance, 5000n)
  })

  it("imports contract code", async () => {
    const trie = new InMemoryStateTrie()

    const snapshot: StateSnapshot = {
      version: 1,
      stateRoot: "0x" + "bb".repeat(32),
      blockHeight: "1",
      blockHash: zeroHash,
      accounts: [
        {
          address: "0x4444444444444444444444444444444444444444",
          nonce: "0",
          balance: "0",
          storageRoot: "0x" + "00".repeat(32),
          codeHash: "0x" + "cc".repeat(32),
          storage: [],
          code: "0x608060405234",
        },
      ],
      createdAtMs: Date.now(),
    }

    const result = await importStateSnapshot(trie, snapshot)
    assert.equal(result.codeImported, 1)
  })

  it("imports storage slots", async () => {
    const trie = new InMemoryStateTrie()

    const snapshot: StateSnapshot = {
      version: 1,
      stateRoot: "0x" + "dd".repeat(32),
      blockHeight: "1",
      blockHash: zeroHash,
      accounts: [
        {
          address: "0x5555555555555555555555555555555555555555",
          nonce: "0",
          balance: "0",
          storageRoot: "0x" + "00".repeat(32),
          codeHash: "0x" + "00".repeat(32),
          storage: [
            { slot: "0x" + "00".repeat(32), value: "0x" + "ff".repeat(32) },
          ],
        },
      ],
      createdAtMs: Date.now(),
    }

    await importStateSnapshot(trie, snapshot)

    const value = await trie.getStorageAt(
      "0x5555555555555555555555555555555555555555",
      "0x" + "00".repeat(32),
    )
    assert.equal(value, "0x" + "ff".repeat(32))
  })
})

describe("validateSnapshot", () => {
  it("accepts valid snapshot", () => {
    assert.doesNotThrow(() =>
      validateSnapshot({
        version: 1,
        stateRoot: "0x" + "aa".repeat(32),
        blockHeight: "10",
        blockHash: zeroHash,
        accounts: [],
        createdAtMs: Date.now(),
      }),
    )
  })

  it("rejects unsupported version", () => {
    assert.throws(
      () => validateSnapshot({ version: 2 } as StateSnapshot),
      /unsupported snapshot version/,
    )
  })

  it("rejects missing stateRoot", () => {
    assert.throws(
      () =>
        validateSnapshot({
          version: 1,
          stateRoot: "",
          blockHeight: "1",
          blockHash: zeroHash,
          accounts: [],
          createdAtMs: 0,
        }),
      /missing stateRoot/,
    )
  })

  it("rejects account with invalid nonce", () => {
    assert.throws(
      () =>
        validateSnapshot({
          version: 1,
          stateRoot: "0xabc",
          blockHeight: "1",
          blockHash: zeroHash,
          accounts: [
            { address: "0x1234", nonce: 5 as any, balance: "0", storageRoot: "", codeHash: "", storage: [] },
          ],
          createdAtMs: 0,
        }),
      /invalid nonce/,
    )
  })
})

describe("serialize / deserialize", () => {
  it("round-trips a snapshot", () => {
    const snapshot: StateSnapshot = {
      version: 1,
      stateRoot: "0x" + "ab".repeat(32),
      blockHeight: "42",
      blockHash: zeroHash,
      accounts: [
        {
          address: "0x1111111111111111111111111111111111111111",
          nonce: "3",
          balance: "1000000000000000000",
          storageRoot: "0x" + "00".repeat(32),
          codeHash: "0x" + "00".repeat(32),
          storage: [],
        },
      ],
      createdAtMs: 1700000000000,
    }

    const json = serializeSnapshot(snapshot)
    const restored = deserializeSnapshot(json)

    assert.equal(restored.version, 1)
    assert.equal(restored.blockHeight, "42")
    assert.equal(restored.accounts.length, 1)
    assert.equal(restored.accounts[0].balance, "1000000000000000000")
  })

  it("throws on invalid JSON", () => {
    assert.throws(() => deserializeSnapshot("not json"), /Unexpected token/)
  })
})
