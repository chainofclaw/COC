import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { keccak256Hex } from "../relayer/keccak256.ts"
import type { ChallengeMessage } from "../common/pose-types.ts"

export interface NonceRegistryLike {
  consume(challenge: ChallengeMessage): boolean
}

export interface NonceRegistryOptions {
  persistencePath?: string
}

export class NonceRegistry implements NonceRegistryLike {
  private readonly used = new Set<string>()
  private readonly persistencePath?: string

  constructor(options: NonceRegistryOptions = {}) {
    this.persistencePath = options.persistencePath
    this.loadPersisted()
  }

  consume(challenge: ChallengeMessage): boolean {
    const key = this.buildKey(challenge)
    if (this.used.has(key)) {
      return false
    }
    this.used.add(key)
    this.persistKey(key)
    return true
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
      const raw = readFileSync(this.persistencePath, "utf8")
      for (const line of raw.split("\n")) {
        const key = line.trim()
        if (key.length > 0) {
          this.used.add(key)
        }
      }
    } catch {
      // ignore corrupted persistence file and fallback to in-memory mode
    }
  }

  private persistKey(key: string): void {
    if (!this.persistencePath) {
      return
    }
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      appendFileSync(this.persistencePath, `${key}\n`, "utf8")
    } catch {
      // fail-open: replay protection still works in-memory for current process
    }
  }
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(value)
  return out
}
