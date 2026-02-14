/**
 * EVM State Trie with persistent storage
 *
 * Implements Merkle Patricia Trie for EVM state persistence.
 * Integrates @ethereumjs/trie with LevelDB backend for account state,
 * storage slots, and contract code.
 */

import { Trie } from "@ethereumjs/trie"
import type { IDatabase } from "./db.ts"
import { bytesToHex, hexToBytes } from "@ethereumjs/util"
import { keccak256, toUtf8Bytes } from "ethers"

const STATE_TRIE_PREFIX = "s:"
const CODE_PREFIX = "c:"

export interface AccountState {
  nonce: bigint
  balance: bigint
  storageRoot: string // Hex string
  codeHash: string // Hex string
}

export interface IStateTrie {
  get(address: string): Promise<AccountState | null>
  put(address: string, state: AccountState): Promise<void>
  getStorageAt(address: string, slot: string): Promise<string>
  putStorageAt(address: string, slot: string, value: string): Promise<void>
  getCode(codeHash: string): Promise<Uint8Array | null>
  putCode(code: Uint8Array): Promise<string> // Returns code hash
  commit(): Promise<string> // Returns state root
  checkpoint(): Promise<void>
  revert(): Promise<void>
  close(): Promise<void>
}

/**
 * Adapter to make IDatabase compatible with @ethereumjs/trie DB interface
 */
class TrieDBAdapter {
  private db: IDatabase
  private prefix: string

  constructor(db: IDatabase, prefix: string = STATE_TRIE_PREFIX) {
    this.db = db
    this.prefix = prefix
  }

  async get(key: Uint8Array): Promise<Uint8Array | null> {
    const prefixedKey = this.prefix + bytesToHex(key)
    return this.db.get(prefixedKey)
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    const prefixedKey = this.prefix + bytesToHex(key)
    await this.db.put(prefixedKey, value)
  }

  async del(key: Uint8Array): Promise<void> {
    const prefixedKey = this.prefix + bytesToHex(key)
    await this.db.del(prefixedKey)
  }

  async batch(ops: Array<{ type: "put" | "del"; key: Uint8Array; value?: Uint8Array }>): Promise<void> {
    const batchOps = ops.map((op) => ({
      type: op.type,
      key: this.prefix + bytesToHex(op.key),
      value: op.value,
    }))
    await this.db.batch(batchOps)
  }

  // Required by @ethereumjs/trie but not used in our case
  async open(): Promise<void> {}
  async close(): Promise<void> {}

  // Support for iterator (optional, can be implemented later)
  async *iterator(): AsyncIterable<[Uint8Array, Uint8Array]> {
    // Not implemented for now
    return
  }
}

export class PersistentStateTrie implements IStateTrie {
  private trie: Trie
  private db: IDatabase
  private storageTries = new Map<string, Trie>() // address -> storage trie

  constructor(db: IDatabase) {
    this.db = db
    const trieDb = new TrieDBAdapter(db)
    this.trie = new Trie({ db: trieDb as any })
  }

  async get(address: string): Promise<AccountState | null> {
    const addressBytes = hexToBytes(address)
    const encoded = await this.trie.get(addressBytes)

    if (!encoded) return null

    // Decode RLP-encoded account state
    // Format: [nonce, balance, storageRoot, codeHash]
    const decoder = new TextDecoder()
    const json = JSON.parse(decoder.decode(encoded))

    return {
      nonce: BigInt(json.nonce),
      balance: BigInt(json.balance),
      storageRoot: json.storageRoot,
      codeHash: json.codeHash,
    }
  }

  async put(address: string, state: AccountState): Promise<void> {
    const addressBytes = hexToBytes(address)

    // Encode account state as JSON (simple approach)
    const json = {
      nonce: state.nonce.toString(),
      balance: state.balance.toString(),
      storageRoot: state.storageRoot,
      codeHash: state.codeHash,
    }

    const encoder = new TextEncoder()
    const encoded = encoder.encode(JSON.stringify(json))

    await this.trie.put(addressBytes, encoded)
  }

  async getStorageAt(address: string, slot: string): Promise<string> {
    const account = await this.get(address)
    if (!account) return "0x0"

    const storageTrie = await this.getStorageTrie(address, account.storageRoot)
    const slotBytes = hexToBytes(slot)
    const value = await storageTrie.get(slotBytes)

    if (!value) return "0x0"

    return bytesToHex(value)
  }

  async putStorageAt(address: string, slot: string, value: string): Promise<void> {
    let account = await this.get(address)

    // Create account if it doesn't exist
    if (!account) {
      account = {
        nonce: 0n,
        balance: 0n,
        storageRoot: "0x" + "0".repeat(64),
        codeHash: "0x" + "0".repeat(64),
      }
    }

    const storageTrie = await this.getStorageTrie(address, account.storageRoot)
    const slotBytes = hexToBytes(slot)
    const valueBytes = hexToBytes(value)

    await storageTrie.put(slotBytes, valueBytes)

    // Update storage root in account
    account.storageRoot = bytesToHex(storageTrie.root())
    await this.put(address, account)
  }

  async getCode(codeHash: string): Promise<Uint8Array | null> {
    const key = CODE_PREFIX + codeHash
    return this.db.get(key)
  }

  async putCode(code: Uint8Array): Promise<string> {
    const codeHash = keccak256(code)
    const key = CODE_PREFIX + codeHash

    await this.db.put(key, code)
    return codeHash
  }

  async commit(): Promise<string> {
    // Commit all storage tries
    for (const [address, storageTrie] of this.storageTries.entries()) {
      const account = await this.get(address)
      if (account) {
        account.storageRoot = bytesToHex(storageTrie.root())
        await this.put(address, account)
      }
    }

    // Return main state root
    return bytesToHex(this.trie.root())
  }

  async checkpoint(): Promise<void> {
    await this.trie.checkpoint()
    for (const storageTrie of this.storageTries.values()) {
      await storageTrie.checkpoint()
    }
  }

  async revert(): Promise<void> {
    await this.trie.revert()
    for (const storageTrie of this.storageTries.values()) {
      await storageTrie.revert()
    }
  }

  async close(): Promise<void> {
    // Clear storage tries cache
    this.storageTries.clear()
  }

  private async getStorageTrie(address: string, storageRoot: string): Promise<Trie> {
    // Check cache first
    let storageTrie = this.storageTries.get(address)

    if (!storageTrie) {
      const trieDb = new TrieDBAdapter(this.db, `ss:${address}:`)
      const rootBytes = storageRoot !== "0x" + "0".repeat(64) ? hexToBytes(storageRoot) : undefined

      storageTrie = new Trie({ db: trieDb as any, root: rootBytes })
      this.storageTries.set(address, storageTrie)
    }

    return storageTrie
  }
}

/**
 * In-memory state trie for testing
 */
export class InMemoryStateTrie implements IStateTrie {
  private accounts = new Map<string, AccountState>()
  private storage = new Map<string, Map<string, string>>() // address -> slot -> value
  private code = new Map<string, Uint8Array>() // codeHash -> code
  private checkpoints: Array<{
    accounts: Map<string, AccountState>
    storage: Map<string, Map<string, string>>
  }> = []

  async get(address: string): Promise<AccountState | null> {
    return this.accounts.get(address) ?? null
  }

  async put(address: string, state: AccountState): Promise<void> {
    this.accounts.set(address, { ...state })
  }

  async getStorageAt(address: string, slot: string): Promise<string> {
    const accountStorage = this.storage.get(address)
    if (!accountStorage) return "0x0"
    return accountStorage.get(slot) ?? "0x0"
  }

  async putStorageAt(address: string, slot: string, value: string): Promise<void> {
    let accountStorage = this.storage.get(address)
    if (!accountStorage) {
      accountStorage = new Map()
      this.storage.set(address, accountStorage)
    }
    accountStorage.set(slot, value)
  }

  async getCode(codeHash: string): Promise<Uint8Array | null> {
    return this.code.get(codeHash) ?? null
  }

  async putCode(code: Uint8Array): Promise<string> {
    const codeHash = keccak256(code)
    this.code.set(codeHash, code)
    return codeHash
  }

  async commit(): Promise<string> {
    // Simple hash of all account addresses for in-memory implementation
    const addresses = Array.from(this.accounts.keys()).sort()
    const stateString = addresses.join(",")
    return keccak256(toUtf8Bytes(stateString))
  }

  async checkpoint(): Promise<void> {
    this.checkpoints.push({
      accounts: new Map(this.accounts),
      storage: new Map(
        Array.from(this.storage.entries()).map(([addr, slots]) => [addr, new Map(slots)])
      ),
    })
  }

  async revert(): Promise<void> {
    const checkpoint = this.checkpoints.pop()
    if (checkpoint) {
      this.accounts = checkpoint.accounts
      this.storage = checkpoint.storage
    }
  }

  async close(): Promise<void> {
    // No-op for in-memory
  }
}
