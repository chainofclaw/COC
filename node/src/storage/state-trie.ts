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
import { createLogger } from "../logger.ts"

const log = createLogger("state-trie")

const STATE_TRIE_PREFIX = "s:"
const CODE_PREFIX = "c:"
const STATE_ROOT_KEY = "meta:stateRoot"

export interface AccountState {
  nonce: bigint
  balance: bigint
  storageRoot: string // Hex string
  codeHash: string // Hex string
}

export interface IStateTrie {
  get(address: string): Promise<AccountState | null>
  put(address: string, state: AccountState): Promise<void>
  delete(address: string): Promise<void>
  getStorageAt(address: string, slot: string): Promise<string>
  putStorageAt(address: string, slot: string, value: string): Promise<void>
  getCode(codeHash: string): Promise<Uint8Array | null>
  putCode(code: Uint8Array): Promise<string> // Returns code hash
  commit(): Promise<string> // Returns state root
  checkpoint(): Promise<void>
  revert(): Promise<void>
  close(): Promise<void>
  stateRoot(): string | null
  setStateRoot(root: string): Promise<void>
  hasStateRoot(root: string): Promise<boolean>
  clearStorage(address: string): Promise<void>
  /** Iterate all accounts in the trie */
  iterateAccounts(): AsyncIterable<{ address: string; state: AccountState }>
  /** Iterate all storage slots for an address */
  iterateStorage(address: string): AsyncIterable<{ slot: string; value: string }>
}

/**
 * Adapter to make IDatabase compatible with @ethereumjs/trie v6 DB interface.
 * Trie v6 passes unprefixed hex strings for both keys AND values (not Uint8Array).
 * We convert hex string values to/from binary for LevelDB storage.
 */
class TrieDBAdapter {
  private db: IDatabase
  private prefix: string

  constructor(db: IDatabase, prefix: string = STATE_TRIE_PREFIX) {
    this.db = db
    this.prefix = prefix
  }

  private toKeyStr(key: string | Uint8Array): string {
    return typeof key === "string" ? key : bytesToHex(key)
  }

  // Convert value from trie (hex string or Uint8Array) to bytes for storage
  private toBytes(value: Uint8Array | string): Uint8Array {
    if (typeof value === "string") {
      // Trie v6 passes unprefixed hex strings
      return hexToBytes(value.startsWith("0x") ? value : `0x${value}`)
    }
    return value
  }

  // Convert stored bytes back to unprefixed hex string for trie consumption
  private fromBytes(data: Uint8Array): string {
    const hex = bytesToHex(data)
    return hex.startsWith("0x") ? hex.slice(2) : hex
  }

  async get(key: string | Uint8Array): Promise<string | undefined> {
    const prefixedKey = this.prefix + this.toKeyStr(key)
    const result = await this.db.get(prefixedKey)
    if (!result) return undefined
    return this.fromBytes(result)
  }

  async put(key: string | Uint8Array, value: Uint8Array | string): Promise<void> {
    const prefixedKey = this.prefix + this.toKeyStr(key)
    await this.db.put(prefixedKey, this.toBytes(value))
  }

  async del(key: string | Uint8Array): Promise<void> {
    const prefixedKey = this.prefix + this.toKeyStr(key)
    await this.db.del(prefixedKey)
  }

  async batch(ops: Array<{ type: "put" | "del"; key: string | Uint8Array; value?: Uint8Array | string }>): Promise<void> {
    const batchOps = ops.map((op) => ({
      type: op.type,
      key: this.prefix + this.toKeyStr(op.key),
      value: op.value ? this.toBytes(op.value) : undefined,
    }))
    await this.db.batch(batchOps)
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}
}

const DEFAULT_MAX_CACHED_TRIES = 128
const DEFAULT_MAX_ACCOUNT_CACHE = 10_000

export class PersistentStateTrie implements IStateTrie {
  private trie: Trie
  private db: IDatabase
  private storageTries = new Map<string, Trie>()
  private storageTrieAccess: string[] = [] // LRU tracking
  private dirtyAddresses = new Set<string>() // Dirty tracking for commit
  private accountCache = new Map<string, AccountState | null>() // Read cache
  private readonly maxCachedTries: number
  private readonly maxAccountCache: number
  private lastStateRoot: string | null = null

  private trieDb: TrieDBAdapter

  constructor(db: IDatabase, opts?: { maxCachedTries?: number; maxAccountCache?: number }) {
    this.db = db
    this.maxCachedTries = opts?.maxCachedTries ?? DEFAULT_MAX_CACHED_TRIES
    this.maxAccountCache = opts?.maxAccountCache ?? DEFAULT_MAX_ACCOUNT_CACHE
    this.trieDb = new TrieDBAdapter(db)
    this.trie = new Trie({ db: this.trieDb as any })
  }

  /**
   * Initialize trie from persisted state root if available.
   * Call after constructor for persistence across restarts.
   */
  async init(): Promise<void> {
    const rootData = await this.db.get(STATE_ROOT_KEY)
    if (rootData) {
      const rootHex = new TextDecoder().decode(rootData)
      if (rootHex.startsWith("0x") && rootHex.length === 66) {
        const rootBytes = hexToBytes(rootHex)
        this.trie = new Trie({ db: this.trieDb as any, root: rootBytes })
        this.lastStateRoot = rootHex
      }
    }
  }

  async get(address: string): Promise<AccountState | null> {
    // Check read cache first
    if (this.accountCache.has(address)) {
      return this.accountCache.get(address)!
    }

    const addressBytes = hexToBytes(address)
    const encoded = await this.trie.get(addressBytes)

    if (!encoded) {
      this.evictAccountCache()
      this.accountCache.set(address, null)
      return null
    }

    const decoder = new TextDecoder()
    const json = JSON.parse(decoder.decode(encoded))

    const state: AccountState = {
      nonce: BigInt(json.nonce),
      balance: BigInt(json.balance),
      storageRoot: json.storageRoot,
      codeHash: json.codeHash,
    }
    this.evictAccountCache()
    this.accountCache.set(address, state)
    return state
  }

  async put(address: string, state: AccountState): Promise<void> {
    const addressBytes = hexToBytes(address)

    const json = {
      nonce: state.nonce.toString(),
      balance: state.balance.toString(),
      storageRoot: state.storageRoot,
      codeHash: state.codeHash,
    }

    const encoder = new TextEncoder()
    const encoded = encoder.encode(JSON.stringify(json))

    await this.trie.put(addressBytes, encoded)
    this.accountCache.set(address, state)
    this.dirtyAddresses.add(address)
    this.lastStateRoot = null // Invalidate cached root
  }

  async delete(address: string): Promise<void> {
    const addressBytes = hexToBytes(address)
    await this.trie.del(addressBytes)
    this.accountCache.delete(address)
    this.dirtyAddresses.delete(address)
    this.storageTries.delete(address)
    this.lastStateRoot = null
  }

  async setStateRoot(root: string): Promise<void> {
    const rootBytes = hexToBytes(root)
    this.trie = new Trie({ db: this.trieDb as any, root: rootBytes })
    this.lastStateRoot = root
    this.accountCache.clear()
    this.storageTries.clear()
    this.storageTrieAccess.length = 0
    this.dirtyAddresses.clear()

    // Persist the new state root
    const encoder = new TextEncoder()
    await this.db.put(STATE_ROOT_KEY, encoder.encode(root))
  }

  async hasStateRoot(root: string): Promise<boolean> {
    // Check if we can initialize a trie with the given root
    try {
      const rootBytes = hexToBytes(root)
      const testTrie = new Trie({ db: this.trieDb as any, root: rootBytes })
      // Try to read from it; if root doesn't exist, it won't throw until access
      await testTrie.get(new Uint8Array(20))
      return true
    } catch {
      return false
    }
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
    const updatedAccount: AccountState = {
      ...account,
      storageRoot: bytesToHex(storageTrie.root()),
    }
    await this.put(address, updatedAccount)
    this.dirtyAddresses.add(address)
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
    // Only commit dirty storage tries
    for (const address of this.dirtyAddresses) {
      const storageTrie = this.storageTries.get(address)
      if (storageTrie) {
        const account = await this.get(address)
        if (account) {
          const updatedAccount: AccountState = {
            ...account,
            storageRoot: bytesToHex(storageTrie.root()),
          }
          await this.put(address, updatedAccount)
        }
      }
    }

    this.dirtyAddresses.clear()
    this.lastStateRoot = bytesToHex(this.trie.root())

    // Persist state root for recovery across restarts
    const encoder = new TextEncoder()
    await this.db.put(STATE_ROOT_KEY, encoder.encode(this.lastStateRoot))

    return this.lastStateRoot
  }

  /**
   * Get the last committed state root without recomputing.
   */
  stateRoot(): string | null {
    return this.lastStateRoot
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
    // Invalidate caches and dirty tracking on revert
    this.accountCache.clear()
    this.dirtyAddresses.clear()
    this.lastStateRoot = null
  }

  async clearStorage(address: string): Promise<void> {
    this.storageTries.delete(address)
    const idx = this.storageTrieAccess.indexOf(address)
    if (idx >= 0) this.storageTrieAccess.splice(idx, 1)
    // Reset account storage root to empty
    const account = await this.get(address)
    if (account) {
      await this.put(address, { ...account, storageRoot: "0x" + "0".repeat(64) })
    }
  }

  async *iterateAccounts(): AsyncIterable<{ address: string; state: AccountState }> {
    const stream = this.trie.createReadStream()
    let skipped = 0
    for await (const item of stream) {
      try {
        const address = bytesToHex(item.key as Uint8Array)
        const json = JSON.parse(new TextDecoder().decode(item.value as Uint8Array))
        yield {
          address,
          state: {
            nonce: BigInt(json.nonce),
            balance: BigInt(json.balance),
            storageRoot: json.storageRoot,
            codeHash: json.codeHash,
          },
        }
      } catch (err) {
        skipped++
        log.warn("skipped malformed account entry during iteration", { error: String(err), skipped })
      }
    }
    if (skipped > 0) {
      log.warn("account iteration completed with skipped entries", { skipped })
    }
  }

  async *iterateStorage(address: string): AsyncIterable<{ slot: string; value: string }> {
    const account = await this.get(address)
    if (!account || account.storageRoot === "0x" + "0".repeat(64)) return

    const storageTrie = await this.getStorageTrie(address, account.storageRoot)
    const stream = storageTrie.createReadStream()
    let skipped = 0
    for await (const item of stream) {
      try {
        yield {
          slot: bytesToHex(item.key as Uint8Array),
          value: bytesToHex(item.value as Uint8Array),
        }
      } catch (err) {
        skipped++
        log.warn("skipped malformed storage entry during iteration", { address, error: String(err), skipped })
      }
    }
    if (skipped > 0) {
      log.warn("storage iteration completed with skipped entries", { address, skipped })
    }
  }

  async close(): Promise<void> {
    this.storageTries.clear()
    this.storageTrieAccess.length = 0
    this.accountCache.clear()
    this.dirtyAddresses.clear()
  }

  private evictAccountCache(): void {
    while (this.accountCache.size >= this.maxAccountCache) {
      const oldest = this.accountCache.keys().next().value
      if (oldest === undefined) break
      this.accountCache.delete(oldest)
    }
  }

  private async getStorageTrie(address: string, storageRoot: string): Promise<Trie> {
    let storageTrie = this.storageTries.get(address)

    if (storageTrie) {
      // Update LRU order
      this.touchLru(address)
      return storageTrie
    }

    // Evict if over limit
    this.evictLru()

    const trieDb = new TrieDBAdapter(this.db, `ss:${address}:`)
    const rootBytes = storageRoot !== "0x" + "0".repeat(64) ? hexToBytes(storageRoot) : undefined

    storageTrie = new Trie({ db: trieDb as any, root: rootBytes })
    this.storageTries.set(address, storageTrie)
    this.storageTrieAccess.push(address)

    return storageTrie
  }

  private touchLru(address: string): void {
    const idx = this.storageTrieAccess.indexOf(address)
    if (idx >= 0) {
      this.storageTrieAccess.splice(idx, 1)
    }
    this.storageTrieAccess.push(address)
  }

  private evictLru(): void {
    // Guard: cap iterations to prevent infinite loop when all tries are dirty
    let attempts = 0
    const maxAttempts = this.storageTrieAccess.length
    while (this.storageTries.size >= this.maxCachedTries && this.storageTrieAccess.length > 0 && attempts < maxAttempts) {
      attempts++
      const oldest = this.storageTrieAccess.shift()!
      // Don't evict dirty tries — skip and try next
      if (this.dirtyAddresses.has(oldest)) {
        this.storageTrieAccess.push(oldest)
        continue
      }
      this.storageTries.delete(oldest)
    }
  }
}

/**
 * In-memory state trie for testing
 */
export class InMemoryStateTrie implements IStateTrie {
  private accounts = new Map<string, AccountState>()
  private storage = new Map<string, Map<string, string>>() // address -> slot -> value
  private code = new Map<string, Uint8Array>() // codeHash -> code
  private lastRoot: string | null = null
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

  async delete(address: string): Promise<void> {
    this.accounts.delete(address)
    this.storage.delete(address)
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
    this.lastRoot = keccak256(toUtf8Bytes(stateString))
    return this.lastRoot
  }

  stateRoot(): string | null {
    return this.lastRoot
  }

  async setStateRoot(_root: string): Promise<void> {
    // No-op for in-memory; state root is just a hash
    this.lastRoot = _root
  }

  async hasStateRoot(_root: string): Promise<boolean> {
    return true
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

  async clearStorage(address: string): Promise<void> {
    this.storage.delete(address)
  }

  async *iterateAccounts(): AsyncIterable<{ address: string; state: AccountState }> {
    for (const [address, state] of this.accounts) {
      yield { address, state: { ...state } }
    }
  }

  async *iterateStorage(address: string): AsyncIterable<{ slot: string; value: string }> {
    const accountStorage = this.storage.get(address)
    if (!accountStorage) return
    for (const [slot, value] of accountStorage) {
      yield { slot, value }
    }
  }

  async close(): Promise<void> {
    // No-op for in-memory
  }
}
