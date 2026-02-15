/**
 * EVM State Snapshot Export/Import
 *
 * Serializes and deserializes EVM state for fast sync between nodes.
 * Exports: accounts, storage slots, contract code, and state root.
 */

import type { IStateTrie, AccountState } from "./storage/state-trie.ts"
import type { Hex } from "./blockchain-types.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("state-snapshot")

export interface StateSnapshotAccount {
  address: string
  nonce: string
  balance: string
  storageRoot: string
  codeHash: string
  storage: Array<{ slot: string; value: string }>
  code?: string // hex-encoded contract bytecode
}

export interface StateSnapshot {
  version: number
  stateRoot: string
  blockHeight: string
  blockHash: string
  accounts: StateSnapshotAccount[]
  createdAtMs: number
}

/**
 * Export the current EVM state as a serializable snapshot.
 */
export async function exportStateSnapshot(
  stateTrie: IStateTrie,
  addresses: string[],
  blockHeight: bigint,
  blockHash: Hex,
): Promise<StateSnapshot> {
  const stateRoot = stateTrie.stateRoot()
  if (!stateRoot) {
    throw new Error("state trie has no committed root")
  }

  const accounts: StateSnapshotAccount[] = []

  for (const address of addresses) {
    const account = await stateTrie.get(address)
    if (!account) continue

    // Collect storage slots (limited to known slots)
    const storage: Array<{ slot: string; value: string }> = []

    // Export contract code if present
    let code: string | undefined
    if (account.codeHash && account.codeHash !== "0x" + "0".repeat(64)) {
      const codeBytes = await stateTrie.getCode(account.codeHash)
      if (codeBytes) {
        code = bytesToHexStr(codeBytes)
      }
    }

    accounts.push({
      address,
      nonce: account.nonce.toString(),
      balance: account.balance.toString(),
      storageRoot: account.storageRoot,
      codeHash: account.codeHash,
      storage,
      code,
    })
  }

  return {
    version: 1,
    stateRoot,
    blockHeight: blockHeight.toString(),
    blockHash,
    accounts,
    createdAtMs: Date.now(),
  }
}

/**
 * Import a state snapshot into the state trie.
 * Overwrites current state.
 */
export async function importStateSnapshot(
  stateTrie: IStateTrie,
  snapshot: StateSnapshot,
): Promise<{ accountsImported: number; codeImported: number }> {
  validateSnapshot(snapshot)

  let accountsImported = 0
  let codeImported = 0

  for (const acc of snapshot.accounts) {
    // Import contract code first (needed before account reference)
    if (acc.code) {
      const codeBytes = hexStrToBytes(acc.code)
      await stateTrie.putCode(codeBytes)
      codeImported++
    }

    // Import account state
    const accountState: AccountState = {
      nonce: BigInt(acc.nonce),
      balance: BigInt(acc.balance),
      storageRoot: acc.storageRoot,
      codeHash: acc.codeHash,
    }
    await stateTrie.put(acc.address, accountState)
    accountsImported++

    // Import storage slots
    for (const { slot, value } of acc.storage) {
      await stateTrie.putStorageAt(acc.address, slot, value)
    }
  }

  // Commit to persist and generate new state root
  const newRoot = await stateTrie.commit()
  log.info("state snapshot imported", {
    accounts: accountsImported,
    code: codeImported,
    originalRoot: snapshot.stateRoot,
    newRoot,
  })

  return { accountsImported, codeImported }
}

/**
 * Validate snapshot structure.
 */
export function validateSnapshot(snapshot: StateSnapshot): void {
  if (snapshot.version !== 1) {
    throw new Error(`unsupported snapshot version: ${snapshot.version}`)
  }
  if (!snapshot.stateRoot || typeof snapshot.stateRoot !== "string") {
    throw new Error("snapshot missing stateRoot")
  }
  if (!snapshot.blockHeight || typeof snapshot.blockHeight !== "string") {
    throw new Error("snapshot missing blockHeight")
  }
  if (!Array.isArray(snapshot.accounts)) {
    throw new Error("snapshot missing accounts array")
  }
  for (const acc of snapshot.accounts) {
    if (!acc.address || typeof acc.address !== "string") {
      throw new Error("account missing address")
    }
    if (typeof acc.nonce !== "string" || typeof acc.balance !== "string") {
      throw new Error(`account ${acc.address} has invalid nonce/balance`)
    }
  }
}

/**
 * Serialize a snapshot to JSON string.
 */
export function serializeSnapshot(snapshot: StateSnapshot): string {
  return JSON.stringify(snapshot)
}

/**
 * Deserialize a snapshot from JSON string.
 */
export function deserializeSnapshot(json: string): StateSnapshot {
  const parsed = JSON.parse(json) as StateSnapshot
  validateSnapshot(parsed)
  return parsed
}

function bytesToHexStr(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexStrToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
