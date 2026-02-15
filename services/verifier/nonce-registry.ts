import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { keccak256Hex } from "../relayer/keccak256.ts"
import type { ChallengeMessage } from "../common/pose-types.ts"

export interface NonceRegistryLike {
  consume(challenge: ChallengeMessage): boolean
}

export interface NonceRegistryOptions {
  persistencePath?: string
  ttlMs?: number
  maxEntries?: number
  compactEveryWrites?: number
  nowFn?: () => number
}

export class NonceRegistry implements NonceRegistryLike {
  private readonly used = new Map<string, number>()
  private readonly persistencePath?: string
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly compactEveryWrites: number
  private readonly nowFn: () => number
  private writesSinceCompact = 0

  constructor(options: NonceRegistryOptions = {}) {
    this.persistencePath = options.persistencePath
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000
    this.maxEntries = Math.max(1, options.maxEntries ?? 500_000)
    this.compactEveryWrites = Math.max(1, options.compactEveryWrites ?? 20_000)
    this.nowFn = options.nowFn ?? (() => Date.now())
    this.loadPersisted()
    this.cleanup()
  }

  consume(challenge: ChallengeMessage): boolean {
    const now = this.nowFn()
    this.pruneExpired(now)
    const key = this.buildKey(challenge)
    if (this.used.has(key)) {
      return false
    }
    this.evictIfNeeded()
    this.used.set(key, now)
    this.persistKey(key, now)
    return true
  }

  cleanup(): void {
    this.pruneExpired(this.nowFn())
  }

  compact(): void {
    if (!this.persistencePath) {
      return
    }
    this.cleanup()
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      const lines = [...this.used.entries()].map(([key, ts]) => `${ts}\t${key}`)
      writeFileSync(this.persistencePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8")
      this.writesSinceCompact = 0
    } catch {
      // keep in-memory replay protection even if compaction fails
    }
  }

  private buildKey(challenge: ChallengeMessage): string {
    const raw = Buffer.concat([
      Buffer.from(challenge.challengerId.slice(2), "hex"),
      Buffer.from(challenge.nodeId.slice(2), "hex"),
      Buffer.from(challenge.nonce.slice(2), "hex"),
      Buffer.from(challenge.challengeType, "utf8"),
      u64(challenge.epochId),
    ])
    return keccak256Hex(raw)
  }

  private loadPersisted(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) {
      return
    }
    try {
      const now = this.nowFn()
      const raw = readFileSync(this.persistencePath, "utf8")
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const tab = trimmed.indexOf("\t")
        let ts = now
        let key = trimmed
        if (tab > 0) {
          const parsedTs = Number(trimmed.slice(0, tab))
          if (Number.isFinite(parsedTs) && parsedTs > 0) {
            ts = parsedTs
          }
          key = trimmed.slice(tab + 1)
        }
        if (!key) continue
        if (this.isExpired(ts, now)) continue
        this.used.set(key, ts)
      }
      this.evictIfNeeded()
      if (this.persistencePath && this.used.size > 0 && raw.includes("\t") === false) {
        // One-time migration from legacy plain-line format into timestamped format.
        this.compact()
      }
    } catch {
      // ignore corrupted persistence file and fallback to in-memory mode
    }
  }

  private persistKey(key: string, ts: number): void {
    if (!this.persistencePath) {
      return
    }
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      appendFileSync(this.persistencePath, `${ts}\t${key}\n`, "utf8")
      this.writesSinceCompact += 1
      if (this.writesSinceCompact >= this.compactEveryWrites) {
        this.compact()
      }
    } catch {
      // fail-open: replay protection still works in-memory for current process
    }
  }

  private pruneExpired(now: number): void {
    if (this.ttlMs <= 0) return
    const cutoff = now - this.ttlMs
    for (const [key, ts] of this.used.entries()) {
      if (ts < cutoff) {
        this.used.delete(key)
      }
    }
  }

  private evictIfNeeded(): void {
    while (this.used.size >= this.maxEntries) {
      const oldest = this.used.keys().next().value
      if (oldest === undefined) break
      this.used.delete(oldest)
    }
  }

  private isExpired(ts: number, now: number): boolean {
    return this.ttlMs > 0 && ts < (now - this.ttlMs)
  }
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(value)
  return out
}
