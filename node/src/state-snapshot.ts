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

export interface StateSnapshotValidator {
  id: string
  address: string
  stake: string
  active: boolean
}

export interface StateSnapshot {
  version: number
  stateRoot: string
  blockHeight: string
  blockHash: string
  accounts: StateSnapshotAccount[]
  createdAtMs: number
  /** Validator set for governance state sync (optional for backward compat) */
  validators?: StateSnapshotValidator[]
}

/**
 * Export the current EVM state as a serializable snapshot.
 * When addresses is omitted, iterates the full trie to discover all accounts.
 */
export async function exportStateSnapshot(
  stateTrie: IStateTrie,
  addresses: string[] | undefined,
  blockHeight: bigint,
  blockHash: Hex,
  validators?: Array<{ id: string; address: string; stake: bigint; active: boolean }>,
): Promise<StateSnapshot> {
  const stateRoot = stateTrie.stateRoot()
  if (!stateRoot) {
    throw new Error("state trie has no committed root")
  }

  const accounts: StateSnapshotAccount[] = []

  if (addresses) {
    // Legacy path: export only specified addresses
    for (const address of addresses) {
      const acc = await exportAccount(stateTrie, address)
      if (acc) accounts.push(acc)
    }
  } else {
    // Full trie traversal
    for await (const { address } of stateTrie.iterateAccounts()) {
      const acc = await exportAccount(stateTrie, address)
      if (acc) accounts.push(acc)
    }
  }

  // Serialize validators for governance state sync
  const snapshotValidators: StateSnapshotValidator[] | undefined = validators?.map((v) => ({
    id: v.id,
    address: v.address,
    stake: v.stake.toString(),
    active: v.active,
  }))

  return {
    version: 1,
    stateRoot,
    blockHeight: blockHeight.toString(),
    blockHash,
    accounts,
    createdAtMs: Date.now(),
    ...(snapshotValidators ? { validators: snapshotValidators } : {}),
  }
}

async function exportAccount(
  stateTrie: IStateTrie,
  address: string,
): Promise<StateSnapshotAccount | null> {
  const account = await stateTrie.get(address)
  if (!account) return null

  // Collect storage slots via trie iteration
  const storage: Array<{ slot: string; value: string }> = []
  for await (const entry of stateTrie.iterateStorage(address)) {
    storage.push(entry)
  }

  // Export contract code if present
  let code: string | undefined
  if (account.codeHash && account.codeHash !== "0x" + "0".repeat(64)) {
    const codeBytes = await stateTrie.getCode(account.codeHash)
    if (codeBytes) {
      code = bytesToHexStr(codeBytes)
    }
  }

  return {
    address,
    nonce: account.nonce.toString(),
    balance: account.balance.toString(),
    storageRoot: account.storageRoot,
    codeHash: account.codeHash,
    storage,
    code,
  }
}

/**
 * Import a state snapshot into the state trie.
 * Overwrites current state.
 */
export async function importStateSnapshot(
  stateTrie: IStateTrie,
  snapshot: StateSnapshot,
  expectedStateRoot?: string,
): Promise<{ accountsImported: number; codeImported: number; validators?: Array<{ id: string; address: string; stake: bigint; active: boolean }> }> {
  validateSnapshot(snapshot)

  // Checkpoint for atomic rollback on failure
  await stateTrie.checkpoint()

  let accountsImported = 0
  let codeImported = 0

  try {
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

    // Verify stateRoot if expected value provided
    if (expectedStateRoot && newRoot !== expectedStateRoot) {
      throw new Error(
        `state root mismatch after import: expected ${expectedStateRoot}, got ${newRoot}`,
      )
    }

    // Deserialize validators if present
    const importedValidators = snapshot.validators?.map((v) => ({
      id: v.id,
      address: v.address,
      stake: BigInt(v.stake),
      active: v.active,
    }))

    log.info("state snapshot imported", {
      accounts: accountsImported,
      code: codeImported,
      validators: importedValidators?.length ?? 0,
      originalRoot: snapshot.stateRoot,
      newRoot,
    })

    return { accountsImported, codeImported, validators: importedValidators }
  } catch (err) {
    // Rollback partial import on any failure
    await stateTrie.revert()
    throw err
  }
}

/**
 * Validate snapshot structure.
 */
const MAX_SNAPSHOT_ACCOUNTS = 100_000
const MAX_STORAGE_PER_ACCOUNT = 50_000
const MAX_CODE_HEX_LENGTH = 49_154 // 24577 bytes * 2 + "0x" prefix

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
  if (!snapshot.blockHash || typeof snapshot.blockHash !== "string" || !snapshot.blockHash.startsWith("0x")) {
    throw new Error("snapshot missing or invalid blockHash")
  }
  if (!Array.isArray(snapshot.accounts)) {
    throw new Error("snapshot missing accounts array")
  }
  if (snapshot.accounts.length > MAX_SNAPSHOT_ACCOUNTS) {
    throw new Error(`snapshot too large: ${snapshot.accounts.length} accounts (max ${MAX_SNAPSHOT_ACCOUNTS})`)
  }
  for (const acc of snapshot.accounts) {
    if (!acc.address || typeof acc.address !== "string" || !acc.address.startsWith("0x")) {
      throw new Error("account has invalid address format")
    }
    if (typeof acc.nonce !== "string" || typeof acc.balance !== "string") {
      throw new Error(`account ${acc.address} has invalid nonce/balance`)
    }
    // Validate numeric format before BigInt conversion (reject negative values)
    try {
      const nonceVal = BigInt(acc.nonce)
      if (nonceVal < 0n) throw new Error("negative")
    } catch { throw new Error(`account ${acc.address} has invalid nonce: ${acc.nonce}`) }
    try {
      const balanceVal = BigInt(acc.balance)
      if (balanceVal < 0n) throw new Error("negative")
    } catch { throw new Error(`account ${acc.address} has invalid balance: ${acc.balance}`) }
    // Validate hex format for storageRoot, codeHash, and storage entries
    if (typeof acc.storageRoot === "string" && !isValidHex(acc.storageRoot)) {
      throw new Error(`account ${acc.address} has invalid storageRoot hex`)
    }
    if (typeof acc.codeHash === "string" && !isValidHex(acc.codeHash)) {
      throw new Error(`account ${acc.address} has invalid codeHash hex`)
    }
    if (acc.code !== undefined && typeof acc.code === "string" && !isValidHex(acc.code)) {
      throw new Error(`account ${acc.address} has invalid code hex`)
    }
    if (acc.code !== undefined && typeof acc.code === "string" && acc.code.length > MAX_CODE_HEX_LENGTH) {
      throw new Error(`account ${acc.address} code too large: ${acc.code.length} chars (max ${MAX_CODE_HEX_LENGTH})`)
    }
    if (Array.isArray(acc.storage)) {
      if (acc.storage.length > MAX_STORAGE_PER_ACCOUNT) {
        throw new Error(`account ${acc.address} has too many storage slots: ${acc.storage.length} (max ${MAX_STORAGE_PER_ACCOUNT})`)
      }
      for (const entry of acc.storage) {
        if (!isValidHex(entry.slot)) throw new Error(`account ${acc.address} has invalid storage slot hex: ${entry.slot}`)
        if (!isValidHex(entry.value)) throw new Error(`account ${acc.address} has invalid storage value hex: ${entry.value}`)
      }
    }
  }
  // Validate validator stakes if present
  if (snapshot.validators) {
    for (const v of snapshot.validators) {
      if (typeof v.stake !== "string") throw new Error(`validator ${v.id} has invalid stake type`)
      try {
        const stakeVal = BigInt(v.stake)
        if (stakeVal < 0n) throw new Error("negative")
      } catch { throw new Error(`validator ${v.id} has invalid stake: ${v.stake}`) }
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

function isValidHex(str: string): boolean {
  // Must be "0x" + even number of hex chars (byte-aligned)
  return /^0x([0-9a-fA-F]{2})*$/.test(str)
}

function bytesToHexStr(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexStrToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error(`hexStrToBytes: odd-length hex string (${clean.length} chars)`)
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("hexStrToBytes: invalid hex characters")
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
