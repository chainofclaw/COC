/**
 * Database abstraction layer
 *
 * Provides a unified interface for key-value storage operations
 * backed by LevelDB with async/await support and error handling.
 */

import { Level } from "level"
import { resolve } from "node:path"

export interface BatchOp {
  type: "put" | "del"
  key: string
  value?: Uint8Array
}

export interface RangeOptions {
  limit?: number
  reverse?: boolean
}

export interface IDatabase {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array): Promise<void>
  del(key: string): Promise<void>
  batch(ops: BatchOp[]): Promise<void>
  close(): Promise<void>
  clear(): Promise<void>
  getKeysWithPrefix(prefix: string, opts?: RangeOptions): Promise<string[]>
}

export class LevelDatabase implements IDatabase {
  private db: Level<string, Uint8Array>
  private isOpen: boolean = false

  constructor(dataDir: string, namespace: string = "default") {
    const dbPath = resolve(dataDir, `leveldb-${namespace}`)
    this.db = new Level(dbPath, {
      keyEncoding: "utf8",
      valueEncoding: "view", // Uint8Array
    })
  }

  async open(): Promise<void> {
    if (this.isOpen) return
    await this.db.open()
    this.isOpen = true
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.ensureOpen()
    try {
      const value = await this.db.get(key)
      return value
    } catch (err: any) {
      if (err.code === "LEVEL_NOT_FOUND") {
        return null
      }
      throw err
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.ensureOpen()
    await this.db.put(key, value)
  }

  async del(key: string): Promise<void> {
    await this.ensureOpen()
    try {
      await this.db.del(key)
    } catch (err: any) {
      // Ignore not found errors on delete
      if (err.code !== "LEVEL_NOT_FOUND") {
        throw err
      }
    }
  }

  async batch(ops: BatchOp[]): Promise<void> {
    await this.ensureOpen()
    const batchOps = ops.map((op) => {
      if (op.type === "put" && op.value) {
        return { type: "put" as const, key: op.key, value: op.value }
      } else {
        return { type: "del" as const, key: op.key }
      }
    })
    await this.db.batch(batchOps)
  }

  async close(): Promise<void> {
    if (!this.isOpen) return
    await this.db.close()
    this.isOpen = false
  }

  async clear(): Promise<void> {
    await this.ensureOpen()
    await this.db.clear()
  }

  async getKeysWithPrefix(prefix: string, opts?: RangeOptions): Promise<string[]> {
    await this.ensureOpen()
    const keys: string[] = []
    for await (const key of this.db.keys({
      gte: prefix,
      lt: prefix + "\xff",
      reverse: opts?.reverse ?? false,
      limit: opts?.limit ?? -1,
    })) {
      keys.push(key)
    }
    return keys
  }

  private async ensureOpen(): Promise<void> {
    if (!this.isOpen) {
      await this.open()
    }
  }
}

/**
 * In-memory database for testing
 */
export class MemoryDatabase implements IDatabase {
  private store = new Map<string, Uint8Array>()

  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, value)
  }

  async del(key: string): Promise<void> {
    this.store.delete(key)
  }

  async batch(ops: BatchOp[]): Promise<void> {
    for (const op of ops) {
      if (op.type === "put" && op.value) {
        this.store.set(op.key, op.value)
      } else {
        this.store.delete(op.key)
      }
    }
  }

  async close(): Promise<void> {
    // No-op for memory
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  async getKeysWithPrefix(prefix: string, opts?: RangeOptions): Promise<string[]> {
    let keys = [...this.store.keys()].filter(k => k.startsWith(prefix)).sort()
    if (opts?.reverse) keys.reverse()
    if (opts?.limit && opts.limit > 0) keys = keys.slice(0, opts.limit)
    return keys
  }
}
