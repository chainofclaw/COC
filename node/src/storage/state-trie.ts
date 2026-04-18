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
  setStateRoot(root: string, opts?: { persist?: boolean }): Promise<void>
  hasStateRoot(root: string): Promise<boolean>
  clearStorage(address: string): Promise<void>
  /** Iterate all accounts in the trie */
  iterateAccounts(): AsyncIterable<{ address: string; state: AccountState }>
  /** Iterate all storage slots for an address */
  iterateStorage(address: string): AsyncIterable<{ slot: string; value: string }>
  /** Create a copy-on-write branch sharing the underlying data */
  fork(): Promise<IStateTrie>
  /** Merge branch differences back into this trie */
  merge(branch: IStateTrie): Promise<void>
  /** Discard a forked branch and release resources */
  discard(): void
  /** Create an account trie proof for the provided address key */
  createAccountProof(address: string): Promise<Uint8Array[]>
  /** Create a storage trie proof for the provided account/slot key */
  createStorageProof(address: string, slot: string): Promise<Uint8Array[]>
}

/**
 * Adapter to make IDatabase compatible with @ethereumjs/trie v6 DB interface.
 * Trie v6 passes unprefixed hex strings for both keys AND values (not Uint8Array).
 * We convert hex string values to/from binary for LevelDB storage.
 */
/**
 * Adapter making IDatabase compatible with @ethereumjs/trie v6 DB interface.
 *
 * Supports an in-memory write overlay for atomic checkpoint/revert:
 * - enableOverlay(): all writes go to an in-memory Map instead of LevelDB
 * - flushOverlay(): batch-write all buffered entries to LevelDB
 * - discardOverlay(): throw away buffered writes (revert)
 * - Reads check overlay first, then fall through to LevelDB
 *
 * This prevents partial LevelDB pollution when applyBlock fails mid-execution.
 */
class TrieDBAdapter {
  private db: IDatabase
  private prefix: string
  private overlay: Map<string, Uint8Array | null> | null = null // null = overlay disabled

  constructor(db: IDatabase, prefix: string = STATE_TRIE_PREFIX) {
    this.db = db
    this.prefix = prefix
  }

  enableOverlay(): void {
    if (!this.overlay) this.overlay = new Map()
  }

  async flushOverlay(): Promise<void> {
    if (!this.overlay || this.overlay.size === 0) {
      this.overlay = null
      return
    }
    const ops: Array<{ type: "put" | "del"; key: string; value?: Uint8Array }> = []
    for (const [key, value] of this.overlay) {
      if (value === null) {
        ops.push({ type: "del", key })
      } else {
        ops.push({ type: "put", key, value })
      }
    }
    await this.db.batch(ops)
    this.overlay = null
  }

  discardOverlay(): void {
    this.overlay = null
  }

  private toKeyStr(key: string | Uint8Array): string {
    return typeof key === "string" ? key : bytesToHex(key)
  }

  private toBytes(value: Uint8Array | string): Uint8Array {
    if (typeof value === "string") {
      return hexToBytes(value.startsWith("0x") ? value : `0x${value}`)
    }
    return value
  }

  private fromBytes(data: Uint8Array): string {
    const hex = bytesToHex(data)
    return hex.startsWith("0x") ? hex.slice(2) : hex
  }

  async get(key: string | Uint8Array): Promise<string | undefined> {
    const prefixedKey = this.prefix + this.toKeyStr(key)
    // Check overlay first
    if (this.overlay?.has(prefixedKey)) {
      const val = this.overlay.get(prefixedKey)
      if (val === null) return undefined // deleted in overlay
      return this.fromBytes(val)
    }
    const result = await this.db.get(prefixedKey)
    if (!result) return undefined
    return this.fromBytes(result)
  }

  async put(key: string | Uint8Array, value: Uint8Array | string): Promise<void> {
    const prefixedKey = this.prefix + this.toKeyStr(key)
    if (this.overlay) {
      this.overlay.set(prefixedKey, this.toBytes(value))
      return
    }
    await this.db.put(prefixedKey, this.toBytes(value))
  }

  async del(key: string | Uint8Array): Promise<void> {
    const prefixedKey = this.prefix + this.toKeyStr(key)
    if (this.overlay) {
      this.overlay.set(prefixedKey, null) // mark as deleted
      return
    }
    await this.db.del(prefixedKey)
  }

  async batch(ops: Array<{ type: "put" | "del"; key: string | Uint8Array; value?: Uint8Array | string }>): Promise<void> {
    if (this.overlay) {
      for (const op of ops) {
        const prefixedKey = this.prefix + this.toKeyStr(op.key)
        if (op.type === "del") {
          this.overlay.set(prefixedKey, null)
        } else {
          this.overlay.set(prefixedKey, op.value ? this.toBytes(op.value) : new Uint8Array(0))
        }
      }
      return
    }
    const batchOps = ops.map((op) => ({
      type: op.type,
      key: this.prefix + this.toKeyStr(op.key),
      value: op.value ? this.toBytes(op.value) : undefined,
    }))
    await this.db.batch(batchOps)
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  shallowCopy(): TrieDBAdapter {
    const copy = new TrieDBAdapter(this.db, this.prefix)
    // Share overlay reference so forked tries also buffer
    if (this.overlay) copy.overlay = this.overlay
    return copy
  }
}

const DEFAULT_MAX_CACHED_TRIES = 512
const DEFAULT_MAX_ACCOUNT_CACHE = 50_000

export class PersistentStateTrie implements IStateTrie {
  private trie: Trie
  private db: IDatabase
  private storageTries = new Map<string, Trie>()
  // LRU tracking uses Map insertion order (storageTries) — no separate array needed
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
        try {
          const rootBytes = hexToBytes(rootHex)
          const candidate = new Trie({ db: this.trieDb as any, root: rootBytes })
          // Verify root node is readable (detects missing/corrupted root after LevelDB repair)
          await candidate.get(new Uint8Array(20))
          this.trie = candidate
          this.lastStateRoot = rootHex
        } catch (err) {
          // Corrupted state root on disk — start with fresh trie instead of crashing
          log.warn("corrupted state root in storage, starting fresh trie", {
            rootHex,
            error: String(err),
          })
        }
      }
    }
  }

  async get(address: string): Promise<AccountState | null> {
    // Check read cache first — return a copy to prevent external mutation of cache
    if (this.accountCache.has(address)) {
      const cached = this.accountCache.get(address)!
      return cached ? { ...cached } : null
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
    this.evictAccountCache()
    this.accountCache.set(address, { ...state })
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

  async setStateRoot(root: string, opts?: { persist?: boolean }): Promise<void> {
    const rootBytes = hexToBytes(root)
    this.trie.root(rootBytes)
    this.lastStateRoot = root
    this.accountCache.clear()
    this.storageTries.clear()
    this.dirtyAddresses.clear()

    if (opts?.persist !== false) {
      const encoder = new TextEncoder()
      await this.db.put(STATE_ROOT_KEY, encoder.encode(root))
    }
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
    // Snapshot and clear dirty set upfront — direct trie.put below won't re-dirty
    const dirtySnapshot = [...this.dirtyAddresses]
    this.dirtyAddresses.clear()

    const encoder = new TextEncoder()

    // Batch: sync storage roots into account trie for all dirty addresses
    for (const address of dirtySnapshot) {
      const storageTrie = this.storageTries.get(address)
      if (!storageTrie) continue

      // Read from accountCache directly — guaranteed to exist since put() populates it
      const cached = this.accountCache.get(address)
      if (!cached) continue

      const newRoot = bytesToHex(storageTrie.root())
      if (cached.storageRoot === newRoot) continue // No storage change — skip trie write

      const updatedAccount: AccountState = { ...cached, storageRoot: newRoot }

      // Direct trie.put — bypasses this.put() to avoid re-dirtying, cache eviction,
      // and redundant stateRoot invalidation during the commit loop
      const json = {
        nonce: updatedAccount.nonce.toString(),
        balance: updatedAccount.balance.toString(),
        storageRoot: updatedAccount.storageRoot,
        codeHash: updatedAccount.codeHash,
      }
      await this.trie.put(hexToBytes(address), encoder.encode(JSON.stringify(json)))
      this.accountCache.set(address, updatedAccount)
    }

    await (this.trie as Trie & { persistRoot?: () => Promise<void> }).persistRoot?.()
    this.lastStateRoot = bytesToHex(this.trie.root())

    // Flush all overlay writes to LevelDB atomically.
    // This must happen AFTER trie.persistRoot() so all trie nodes are in the overlay,
    // and BEFORE returning so the committed state is durable.
    await this.trieDb.flushOverlay()
    for (const [addr, adapter] of this.storageTrieAdapters) {
      await adapter.flushOverlay()
    }

    // Persist state root for recovery across restarts
    await this.db.put(STATE_ROOT_KEY, encoder.encode(this.lastStateRoot))

    return this.lastStateRoot
  }

  /**
   * Get the last committed state root without recomputing.
   */
  stateRoot(): string | null {
    return this.lastStateRoot
  }

  /**
   * Track storage trie DB adapters so we can enable/flush/discard overlays on them.
   * Storage tries are created dynamically (e.g. during contract deploy), so we
   * need to track their adapters separately from the main trie adapter.
   */
  private storageTrieAdapters = new Map<string, TrieDBAdapter>()

  async checkpoint(): Promise<void> {
    // Enable write overlay on the main trie adapter — all subsequent writes
    // go to an in-memory buffer instead of LevelDB. This prevents partial
    // DB pollution when applyBlock fails mid-execution (e.g. contract deploy
    // creates new storage trie nodes that can't be reverted from LevelDB).
    this.trieDb.enableOverlay()
    await this.trie.checkpoint()
    for (const [addr, storageTrie] of this.storageTries.entries()) {
      const adapter = this.storageTrieAdapters.get(addr)
      if (adapter) adapter.enableOverlay()
      await storageTrie.checkpoint()
    }
  }

  async revert(): Promise<void> {
    try {
      await this.trie.revert()
    } catch (err) {
      log.warn("trie revert failed (no matching checkpoint?)", { error: String(err) })
    }
    // Discard all buffered writes — nothing hits LevelDB
    this.trieDb.discardOverlay()
    for (const [addr, storageTrie] of this.storageTries.entries()) {
      const adapter = this.storageTrieAdapters.get(addr)
      if (adapter) adapter.discardOverlay()
      try {
        await storageTrie.revert()
      } catch {
        // Storage trie created after checkpoint has no checkpoint to revert — remove it
        this.storageTries.delete(addr)
        this.storageTrieAdapters.delete(addr)
      }
    }
    // Invalidate caches and dirty tracking on revert
    this.accountCache.clear()
    this.dirtyAddresses.clear()
    this.lastStateRoot = null
  }

  async clearStorage(address: string): Promise<void> {
    this.storageTries.delete(address)
    this.storageTrieAdapters.delete(address)
    // Reset account storage root to empty
    const account = await this.get(address)
    if (account) {
      await this.put(address, { ...account, storageRoot: "0x" + "0".repeat(64) })
    }
  }

  async *iterateAccounts(): AsyncIterable<{ address: string; state: AccountState }> {
    const stream = this.trie.createReadStream()
    let skipped = 0
    let yielded = 0
    const MAX_ITERATE = 500_000
    for await (const item of stream) {
      if (yielded >= MAX_ITERATE) {
        log.warn("iterateAccounts capped at limit", { limit: MAX_ITERATE })
        break
      }
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
        yielded++
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
    this.storageTrieAdapters.clear()
    this.accountCache.clear()
    this.dirtyAddresses.clear()
  }

  async createAccountProof(address: string): Promise<Uint8Array[]> {
    return this.trie.createProof(hexToBytes(address))
  }

  async createStorageProof(address: string, slot: string): Promise<Uint8Array[]> {
    const account = await this.get(address)
    if (!account || account.storageRoot === "0x" + "0".repeat(64)) {
      const emptyTrie = new Trie({ db: new TrieDBAdapter(this.db, `ss:${address}:`) as any })
      return emptyTrie.createProof(hexToBytes(slot))
    }
    const storageTrie = await this.getStorageTrie(address, account.storageRoot)
    return storageTrie.createProof(hexToBytes(slot))
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
      // Verify cached trie root matches expected storage root to prevent stale reads
      const cachedRoot = bytesToHex(storageTrie.root())
      const emptyRoot = "0x" + "0".repeat(64)
      if (storageRoot !== emptyRoot && cachedRoot !== storageRoot) {
        // Stale cache — discard and recreate
        this.storageTries.delete(address)
        storageTrie = undefined
      } else {
        // Update LRU order
        this.touchLru(address)
        return storageTrie
      }
    }

    // Evict if over limit
    this.evictLru()

    const trieDb = new TrieDBAdapter(this.db, `ss:${address}:`)
    // If main trie is in overlay mode (checkpoint active), enable overlay on new
    // storage tries too — prevents LevelDB pollution for newly deployed contracts.
    if (this.trieDb["overlay"]) trieDb.enableOverlay()
    this.storageTrieAdapters.set(address, trieDb)
    const rootBytes = storageRoot !== "0x" + "0".repeat(64) ? hexToBytes(storageRoot) : undefined

    storageTrie = new Trie({ db: trieDb as any, root: rootBytes })
    this.storageTries.set(address, storageTrie)

    return storageTrie
  }

  private touchLru(address: string): void {
    // O(1) LRU via Map delete + re-set: Map iterates in insertion order
    const trie = this.storageTries.get(address)
    if (trie) {
      this.storageTries.delete(address)
      this.storageTries.set(address, trie)
    }
  }

  private evictLru(): void {
    // Early exit: if all cached tries are dirty, nothing can be evicted
    if (this.dirtyAddresses.size >= this.storageTries.size) return
    // Compute evictable count upfront to avoid wasted iterations
    const evictableCount = this.storageTries.size - this.dirtyAddresses.size
    if (evictableCount <= 0) return
    const toEvict = this.storageTries.size - this.maxCachedTries + 1
    if (toEvict <= 0) return
    // Cap iterations to evictable count (skip dirty moves entirely)
    let evicted = 0
    let attempts = 0
    const maxAttempts = this.storageTries.size
    while (evicted < toEvict && this.storageTries.size > 0 && attempts < maxAttempts) {
      attempts++
      const oldest = this.storageTries.keys().next().value as string
      if (this.dirtyAddresses.has(oldest)) {
        // Move dirty entry to end; but if we've moved more than evictableCount entries, stop
        const trie = this.storageTries.get(oldest)!
        this.storageTries.delete(oldest)
        this.storageTries.set(oldest, trie)
        continue
      }
      this.storageTries.delete(oldest)
      evicted++
    }
  }

  /** Create a COW branch: snapshot current state root, create independent instance */
  async fork(): Promise<IStateTrie> {
    const forked = new PersistentStateTrie(this.db, {
      maxCachedTries: this.maxCachedTries,
      maxAccountCache: this.maxAccountCache,
    })
    forked.trie = this.trie.shallowCopy(true)
    forked.lastStateRoot = this.lastStateRoot
    return forked
  }

  /** Merge all accounts from branch into this trie */
  async merge(branch: IStateTrie): Promise<void> {
    for await (const { address, state } of branch.iterateAccounts()) {
      await this.put(address, state)
      for await (const { slot, value } of branch.iterateStorage(address)) {
        await this.putStorageAt(address, slot, value)
      }
    }
    await this.commit()
  }

  /** Discard fork: clear caches and dirty tracking */
  discard(): void {
    this.accountCache.clear()
    this.storageTries.clear()
    this.dirtyAddresses.clear()
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
    const account = this.accounts.get(address)
    return account ? { ...account } : null
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

  async setStateRoot(_root: string, _opts?: { persist?: boolean }): Promise<void> {
    // No-op for in-memory; state root is just a hash
    this.lastRoot = _root
  }

  async hasStateRoot(_root: string): Promise<boolean> {
    return true
  }

  async checkpoint(): Promise<void> {
    const accountsCopy = new Map<string, AccountState>()
    for (const [addr, state] of this.accounts) {
      accountsCopy.set(addr, { ...state })
    }
    this.checkpoints.push({
      accounts: accountsCopy,
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

  async createAccountProof(address: string): Promise<Uint8Array[]> {
    const trie = await this.buildAccountProofTrie()
    return trie.createProof(hexToBytes(address))
  }

  async createStorageProof(address: string, slot: string): Promise<Uint8Array[]> {
    const trie = await this.buildStorageProofTrie(address)
    return trie.createProof(hexToBytes(slot))
  }

  /** COW fork: deep-copy all maps into a new InMemoryStateTrie */
  async fork(): Promise<IStateTrie> {
    const forked = new InMemoryStateTrie()
    for (const [addr, state] of this.accounts) {
      forked.accounts.set(addr, { ...state })
    }
    for (const [addr, slots] of this.storage) {
      forked.storage.set(addr, new Map(slots))
    }
    for (const [hash, data] of this.code) {
      forked.code.set(hash, new Uint8Array(data))
    }
    forked.lastRoot = this.lastRoot
    return forked
  }

  /** Merge branch state into this trie (branch wins on conflict) */
  async merge(branch: IStateTrie): Promise<void> {
    for await (const { address, state } of branch.iterateAccounts()) {
      this.accounts.set(address, { ...state })
      for await (const { slot, value } of branch.iterateStorage(address)) {
        let slots = this.storage.get(address)
        if (!slots) {
          slots = new Map()
          this.storage.set(address, slots)
        }
        slots.set(slot, value)
      }
    }
  }

  /** Discard all state in this fork */
  discard(): void {
    this.accounts.clear()
    this.storage.clear()
    this.code.clear()
    this.checkpoints.length = 0
    this.lastRoot = null
  }

  private async buildAccountProofTrie(): Promise<Trie> {
    const trie = new Trie()
    for (const [address, state] of this.accounts) {
      await trie.put(hexToBytes(address), encodeAccountState(state))
    }
    return trie
  }

  private async buildStorageProofTrie(address: string): Promise<Trie> {
    const trie = new Trie()
    const slots = this.storage.get(address)
    if (!slots) return trie
    for (const [slot, value] of slots) {
      await trie.put(hexToBytes(slot), hexToBytes(value))
    }
    return trie
  }
}

function encodeAccountState(state: AccountState): Uint8Array {
  const encoder = new TextEncoder()
  return encoder.encode(JSON.stringify({
    nonce: state.nonce.toString(),
    balance: state.balance.toString(),
    storageRoot: state.storageRoot,
    codeHash: state.codeHash,
  }))
}
