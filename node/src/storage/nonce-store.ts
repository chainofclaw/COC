/**
 * Persistent nonce registry
 *
 * Prevents replay attacks by tracking used nonces across node restarts.
 * Stores nonces in LevelDB with timestamp for automatic cleanup of old entries.
 */

import type { IDatabase, BatchOp } from "./db.ts"

const NONCE_PREFIX = "n:"
const CLEANUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface INonceStore {
  markUsed(nonce: string): Promise<void>
  buildMarkUsedOps(nonces: string[]): BatchOp[]
  isUsed(nonce: string): Promise<boolean>
  cleanup(olderThan?: number): Promise<number>
  close(): Promise<void>
}

export class PersistentNonceStore implements INonceStore {
  private db: IDatabase

  constructor(db: IDatabase) {
    this.db = db
  }

  buildMarkUsedOps(nonces: string[]): BatchOp[] {
    const timestamp = Date.now().toString()
    const encoded = new TextEncoder().encode(timestamp)
    return nonces.map(nonce => ({
      type: "put" as const,
      key: NONCE_PREFIX + nonce,
      value: encoded,
    }))
  }

  async markUsed(nonce: string): Promise<void> {
    const key = NONCE_PREFIX + nonce
    const timestamp = Date.now().toString()
    await this.db.put(key, new TextEncoder().encode(timestamp))
  }

  async isUsed(nonce: string): Promise<boolean> {
    const key = NONCE_PREFIX + nonce
    const value = await this.db.get(key)
    return value !== null
  }

  /**
   * Remove nonces older than threshold
   * @param olderThan Timestamp threshold (default: 7 days ago)
   * @returns Number of nonces cleaned up
   */
  async cleanup(olderThan?: number): Promise<number> {
    const threshold = olderThan ?? Date.now() - CLEANUP_THRESHOLD_MS
    const MAX_CLEANUP_BATCH = 1000 // cap per-call to avoid blocking event loop on large tables
    let count = 0

    const keys = await this.db.getKeysWithPrefix(NONCE_PREFIX)
    for (const key of keys) {
      if (count >= MAX_CLEANUP_BATCH) break
      const value = await this.db.get(key)
      if (!value) continue
      const timestamp = Number(new TextDecoder().decode(value))
      if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp < threshold) {
        await this.db.del(key)
        count++
      }
    }

    return count
  }

  async close(): Promise<void> {
    // Database close is handled by the parent database instance
  }
}

/**
 * In-memory nonce store for testing and backward compatibility
 */
export class InMemoryNonceStore implements INonceStore {
  private used = new Set<string>()
  private timestamps = new Map<string, number>()

  buildMarkUsedOps(nonces: string[]): BatchOp[] {
    // In-memory store does not use BatchOps; this is a no-op for interface compliance.
    // Callers using InMemoryNonceStore should call markUsed() individually or batch-mark inline.
    return []
  }

  async markUsed(nonce: string): Promise<void> {
    this.used.add(nonce)
    this.timestamps.set(nonce, Date.now())
  }

  async isUsed(nonce: string): Promise<boolean> {
    return this.used.has(nonce)
  }

  async cleanup(olderThan?: number): Promise<number> {
    const threshold = olderThan ?? Date.now() - CLEANUP_THRESHOLD_MS
    let count = 0

    for (const [nonce, timestamp] of this.timestamps.entries()) {
      if (timestamp < threshold) {
        this.used.delete(nonce)
        this.timestamps.delete(nonce)
        count++
      }
    }

    return count
  }

  async close(): Promise<void> {
    // No-op
  }
}
