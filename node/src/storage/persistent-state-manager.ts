/**
 * PersistentStateManager - Adapts IStateTrie to EthereumJS StateManagerInterface
 *
 * Bridges our persistent state trie with EthereumJS VM's state manager interface,
 * enabling EVM state to survive node restarts.
 */

import { Account, Address, bytesToHex, hexToBytes } from "@ethereumjs/util"
import { keccak256 } from "ethers"
import type { IStateTrie, AccountState } from "./state-trie.ts"

const EMPTY_CODE_HASH = keccak256(new Uint8Array(0))

export class PersistentStateManager {
  private readonly trie: IStateTrie
  private readonly codeCache = new Map<string, Uint8Array>()

  // Required by EthereumJS VM runTx — accessed as stateManager.originalStorageCache.clear()
  readonly originalStorageCache = {
    clear(): void { /* no-op; persistent storage doesn't use an in-memory cache layer */ },
    get(_address: Address, _key: Uint8Array): Uint8Array | undefined { return undefined },
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
    // Return a dummy root; the actual root is managed by PersistentStateTrie
    return new Uint8Array(32)
  }

  async setStateRoot(root: Uint8Array): Promise<void> {
    // State root restoration is handled by PersistentStateTrie.init()
  }

  async hasStateRoot(root: Uint8Array): Promise<boolean> {
    return true
  }

  shallowCopy(): PersistentStateManager {
    // Return same instance; persistent state is shared
    return this
  }

  // Required by some EthereumJS VM paths
  async accountExists(address: Address): Promise<boolean> {
    const account = await this.getAccount(address)
    return account !== undefined
  }

  clearCaches(): void {
    this.codeCache.clear()
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
}
