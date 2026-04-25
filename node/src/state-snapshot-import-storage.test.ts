import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MemoryDatabase } from "./storage/db.ts"
import { PersistentStateTrie } from "./storage/state-trie.ts"
import { importStateSnapshot } from "./state-snapshot.ts"

// Regression for the 2026-04-25 testnet snap-sync failure: peer snapshots
// listed contract accounts with non-zero storageRoots; the importer wrote
// those roots verbatim and then walked a storage trie rooted at a hash whose
// nodes did not exist locally, causing @ethereumjs/trie to throw "Stack
// underflow" on the first putStorageAt. Ground truth: the importer must
// derive the storage root locally by accumulating slots into a fresh trie.
describe("importStateSnapshot: contract accounts with storage", () => {
  it("imports a contract-like account with a NON-zero peer storageRoot", async () => {
    const db = new MemoryDatabase()
    const trie = new PersistentStateTrie(db)
    await trie.init()

    const peerStorageRoot = "0x9d3a3e4b95a9c2fa6c0a3f86ae72d7f5e0c10ad04a4b6ba4d1bb46c4a1e7b6c2"
    const snapshot = {
      version: 1 as const,
      stateRoot: "0x" + "aa".repeat(32),
      blockHeight: "100",
      blockHash: "0x" + "00".repeat(32),
      createdAtMs: Date.now(),
      accounts: [
        {
          address: "0x" + "ab".repeat(20),
          nonce: "0",
          balance: "0",
          storageRoot: peerStorageRoot,  // non-zero, peer-side
          codeHash: "0x" + "cd".repeat(32),
          storage: [
            { slot: "0x" + "00".repeat(32), value: "0x" + "11".repeat(32) },
          ],
        },
      ],
    }

    await importStateSnapshot(trie, snapshot)
    const acc = await trie.get("0x" + "ab".repeat(20))
    assert.ok(acc, "account should be present after import")
    const v = await trie.getStorageAt("0x" + "ab".repeat(20), "0x" + "00".repeat(32))
    assert.equal(v, "0x" + "11".repeat(32), "storage slot should be readable")
  })

  it("preserves peer storageRoot for accounts with no storage", async () => {
    // Externally-touched accounts on testnet can carry storageRoot equal to
    // EthereumJS's KECCAK256_RLP_S (canonical empty trie root, 0x56e81f17…)
    // instead of COC's 0x000… sentinel. Earlier fix attempts overrode every
    // account's storageRoot to 0x000, which made the encoded account JSON
    // diverge from the peer's and cascaded into a stateRoot mismatch on
    // verify. Verify the importer keeps the peer's value when there are no
    // slots to import — both forms must round-trip exactly as written.
    const db = new MemoryDatabase()
    const trie = new PersistentStateTrie(db)
    await trie.init()

    const KECCAK256_RLP_S =
      "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"

    const snapshot = {
      version: 1 as const,
      stateRoot: "0x" + "aa".repeat(32),
      blockHeight: "1",
      blockHash: "0x" + "00".repeat(32),
      createdAtMs: Date.now(),
      accounts: [
        {
          address: "0x" + "aa".repeat(20),
          nonce: "1",
          balance: "0",
          storageRoot: KECCAK256_RLP_S,
          codeHash: "0x" + "00".repeat(32),
          storage: [],
        },
        {
          address: "0x" + "bb".repeat(20),
          nonce: "1",
          balance: "0",
          storageRoot: "0x" + "00".repeat(32),
          codeHash: "0x" + "00".repeat(32),
          storage: [],
        },
      ],
    }

    await importStateSnapshot(trie, snapshot)
    const a = await trie.get("0x" + "aa".repeat(20))
    const b = await trie.get("0x" + "bb".repeat(20))
    assert.equal(a?.storageRoot, KECCAK256_RLP_S, "EthereumJS empty root must round-trip")
    assert.equal(b?.storageRoot, "0x" + "00".repeat(32), "COC sentinel must round-trip")
  })

  it("imports a snapshot with storage into a fresh PersistentStateTrie (zero peer root)", async () => {
    const db = new MemoryDatabase()
    const trie = new PersistentStateTrie(db)
    await trie.init()

    const snapshot = {
      version: 1 as const,
      stateRoot: "0x" + "aa".repeat(32),
      blockHeight: "100",
      blockHash: "0x" + "00".repeat(32),
      createdAtMs: Date.now(),
      accounts: [
        {
          address: "0x" + "11".repeat(20),
          nonce: "1",
          balance: "1000000000000000000",
          storageRoot: "0x" + "00".repeat(32),
          codeHash: "0x" + "00".repeat(32),
          storage: [],
        },
        {
          address: "0x" + "22".repeat(20),
          nonce: "5",
          balance: "5000000000000000000",
          storageRoot: "0x" + "00".repeat(32),
          codeHash: "0x" + "00".repeat(32),
          storage: [
            { slot: "0x" + "00".repeat(32), value: "0x" + "ff".repeat(32) },
            { slot: "0x" + ("01" + "00".repeat(31)), value: "0x" + "ee".repeat(32) },
          ],
        },
      ],
    }

    await importStateSnapshot(trie, snapshot)
    const acc = await trie.get("0x" + "22".repeat(20))
    assert.ok(acc, "account 0x22... should be present")
    assert.equal(acc.nonce, 5n)
    const v0 = await trie.getStorageAt("0x" + "22".repeat(20), "0x" + "00".repeat(32))
    assert.equal(v0, "0x" + "ff".repeat(32))
  })
})
