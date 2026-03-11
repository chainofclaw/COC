/**
 * PersistentStateManager - Adapts IStateTrie to EthereumJS StateManagerInterface
 *
 * Bridges our persistent state trie with EthereumJS VM's state manager interface,
 * enabling EVM state to survive node restarts.
 */

import { Account, Address, KECCAK256_NULL_S, KECCAK256_RLP_S, bigIntToHex, bytesToHex, hexToBytes } from "@ethereumjs/util"
import { keccak256 } from "ethers"
import type { IStateTrie, AccountState } from "./state-trie.ts"

const EMPTY_CODE_HASH = keccak256(new Uint8Array(0))

const MAX_CODE_CACHE_SIZE = 500

export class PersistentStateManager {
  private readonly trie: IStateTrie
  private readonly codeCache = new Map<string, Uint8Array>()

  // Required by EthereumJS VM runTx — accessed as stateManager.originalStorageCache.clear()
  readonly originalStorageCache = {
    clear(): void { /* no-op; persistent storage doesn't use an in-memory cache layer */ },
    get(_address: Address, _key: Uint8Array): Uint8Array { return new Uint8Array(0) },
  }

  constructor(trie: IStateTrie) {
    this.trie = trie
  }

  async getAccount(address: Address): Promise<Account | undefined> {
    const addr = address.toString().toLowerCase()
    const state = await this.trie.get(addr)
    if (!state) return undefined
    return Account.fromAccountData({
      nonce: state.nonce,
      balance: state.balance,
      storageRoot: state.storageRoot !== "0x" + "0".repeat(64)
        ? hexToBytes(state.storageRoot)
        : undefined,
      codeHash: state.codeHash !== "0x" + "0".repeat(64)
        ? hexToBytes(state.codeHash)
        : undefined,
    })
  }

  async putAccount(address: Address, account: Account | undefined): Promise<void> {
    const addr = address.toString().toLowerCase()
    if (!account) {
      // Truly delete account from trie (not zero-fill) for correct state root
      await this.trie.delete(addr)
      this.codeCache.delete(addr)
      return
    }
    const state: AccountState = {
      nonce: account.nonce,
      balance: account.balance,
      storageRoot: account.storageRoot
        ? bytesToHex(account.storageRoot)
        : "0x" + "0".repeat(64),
      codeHash: account.codeHash
        ? bytesToHex(account.codeHash)
        : "0x" + "0".repeat(64),
    }
    await this.trie.put(addr, state)
  }

  async deleteAccount(address: Address): Promise<void> {
    await this.putAccount(address, undefined)
  }

  async getStorage(address: Address, key: Uint8Array): Promise<Uint8Array> {
    const addr = address.toString().toLowerCase()
    const slot = bytesToHex(key)
    const value = await this.trie.getStorageAt(addr, slot)
    if (!value || value === "0x0" || value === "0x") return new Uint8Array(0)
    return hexToBytes(value)
  }

  async putStorage(address: Address, key: Uint8Array, value: Uint8Array): Promise<void> {
    const addr = address.toString().toLowerCase()
    const slot = bytesToHex(key)
    const val = bytesToHex(value)
    await this.trie.putStorageAt(addr, slot, val)
  }

  async getCode(address: Address): Promise<Uint8Array> {
    const addr = address.toString().toLowerCase()

    // Check code cache first
    if (this.codeCache.has(addr)) {
      return this.codeCache.get(addr)!
    }

    const state = await this.trie.get(addr)
    if (!state || state.codeHash === "0x" + "0".repeat(64) || state.codeHash === EMPTY_CODE_HASH) {
      return new Uint8Array(0)
    }

    const code = await this.trie.getCode(state.codeHash)
    if (!code) return new Uint8Array(0)

    this.evictCodeCache()
    this.codeCache.set(addr, code)
    return code
  }

  async putCode(address: Address, value: Uint8Array): Promise<void> {
    const addr = address.toString().toLowerCase()
    const codeHash = await this.trie.putCode(value)

    // Update account's codeHash
    const state = await this.trie.get(addr)
    if (state) {
      await this.trie.put(addr, { ...state, codeHash })
    } else {
      await this.trie.put(addr, {
        nonce: 0n,
        balance: 0n,
        storageRoot: "0x" + "0".repeat(64),
        codeHash,
      })
    }

    this.evictCodeCache()
    this.codeCache.set(addr, value)
  }

  async getCodeSize(address: Address): Promise<number> {
    const code = await this.getCode(address)
    return code.length
  }

  async checkpoint(): Promise<void> {
    await this.trie.checkpoint()
  }

  async commit(): Promise<void> {
    await this.trie.commit()
  }

  async revert(): Promise<void> {
    await this.trie.revert()
    this.codeCache.clear()
  }

  async flush(): Promise<void> {
    await this.trie.commit()
  }

  getStateRoot(): Uint8Array {
    const root = this.trie.stateRoot()
    return root ? hexToBytes(root) : new Uint8Array(32)
  }

  async setStateRoot(root: Uint8Array): Promise<void> {
    await this.trie.setStateRoot(bytesToHex(root), { persist: false })
    this.codeCache.clear()
  }

  async hasStateRoot(root: Uint8Array): Promise<boolean> {
    return this.trie.hasStateRoot(bytesToHex(root))
  }

  async shallowCopy(): Promise<PersistentStateManager> {
    const root = this.trie.stateRoot()
    if (root) {
      return this.forkAtStateRoot(root)
    }
    const forkedTrie = await this.trie.fork()
    return new PersistentStateManager(forkedTrie)
  }

  // Required by some EthereumJS VM paths
  async accountExists(address: Address): Promise<boolean> {
    const account = await this.getAccount(address)
    return account !== undefined
  }

  clearCaches(): void {
    this.codeCache.clear()
  }

  /** Evict oldest code cache entries when over limit (LRU via Map insertion order) */
  private evictCodeCache(): void {
    while (this.codeCache.size >= MAX_CODE_CACHE_SIZE) {
      const oldest = this.codeCache.keys().next().value
      if (oldest === undefined) break
      this.codeCache.delete(oldest)
    }
  }

  async clearStorage(address: Address): Promise<void> {
    const addr = address.toString().toLowerCase()
    await this.trie.clearStorage(addr)
  }

  async modifyAccountFields(address: Address, fields: Partial<{ nonce: bigint; balance: bigint }>): Promise<void> {
    let account = await this.getAccount(address)
    if (!account) {
      account = new Account()
    }
    if (fields.nonce !== undefined) {
      account.nonce = fields.nonce
    }
    if (fields.balance !== undefined) {
      account.balance = fields.balance
    }
    await this.putAccount(address, account)
  }

  async forkAtStateRoot(root: string | Uint8Array): Promise<PersistentStateManager> {
    const rootHex = typeof root === "string" ? root : bytesToHex(root)
    if (!(await this.trie.hasStateRoot(rootHex))) {
      throw new Error(`unknown state root: ${rootHex}`)
    }
    const forkedTrie = await this.trie.fork()
    await forkedTrie.setStateRoot(rootHex, { persist: false })
    return new PersistentStateManager(forkedTrie)
  }

  async getProof(address: Address, storageSlots: Uint8Array[] = []): Promise<{
    address: string
    balance: string
    codeHash: string
    nonce: string
    storageHash: string
    accountProof: string[]
    storageProof: Array<{ key: string; value: string; proof: string[] }>
  }> {
    const addr = address.toString().toLowerCase()
    const accountState = await this.trie.get(addr)
    const account = await this.getAccount(address)

    const accountProof = (await this.trie.createAccountProof(addr)).map((node) => bytesToHex(node))
    const storageProof = await Promise.all(storageSlots.map(async (slot) => {
      const key = normalizeProofSlot(bytesToHex(slot))
      const proof = await this.trie.createStorageProof(addr, key)
      const value = await this.trie.getStorageAt(addr, key)
      return {
        key,
        value: normalizeProofValue(value),
        proof: proof.map((node) => bytesToHex(node)),
      }
    }))

    if (!accountState || !account) {
      return {
        address: address.toString(),
        balance: "0x0",
        codeHash: KECCAK256_NULL_S,
        nonce: "0x0",
        storageHash: KECCAK256_RLP_S,
        accountProof,
        storageProof,
      }
    }

    return {
      address: address.toString(),
      balance: bigIntToHex(account.balance),
      codeHash: bytesToHex(account.codeHash),
      nonce: bigIntToHex(account.nonce),
      storageHash: bytesToHex(account.storageRoot),
      accountProof,
      storageProof,
    }
  }
}

function normalizeProofSlot(slot: string): string {
  return slot.length === 66 ? slot : `0x${slot.replace(/^0x/, "").padStart(64, "0")}`
}

function normalizeProofValue(value: string): string {
  if (!value || value === "0x" || value === "0x0") return "0x0"
  const stripped = value.replace(/^0x/, "").replace(/^0+/, "")
  return stripped.length > 0 ? `0x${stripped}` : "0x0"
}
