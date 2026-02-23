import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { CrossLayerEnvelope } from "./message-types.ts"
import { keccak256Hex } from "./keccak256.ts"

export interface ReplayGuardOptions {
  persistencePath?: string
  maxReplayKeys?: number
}

export class ReplayGuard {
  private readonly lastNonceByChannel = new Map<string, bigint>()
  private readonly replayKeys = new Set<string>()
  private readonly persistencePath?: string
  private readonly maxReplayKeys: number

  constructor(options: ReplayGuardOptions = {}) {
    this.persistencePath = options.persistencePath
    this.maxReplayKeys = options.maxReplayKeys ?? 100_000
    this.loadPersisted()
  }

  buildReplayKey(envelope: CrossLayerEnvelope): string {
    const encoded = Buffer.concat([
      encodeU64(envelope.srcChainId),
      encodeU64(envelope.dstChainId),
      encodeBytes32(envelope.channelId),
      encodeU64(envelope.nonce),
      encodeBytes32(envelope.payloadHash),
    ])
    return keccak256Hex(encoded)
  }

  validate(envelope: CrossLayerEnvelope): { ok: boolean; reason?: string; replayKey: string } {
    if (envelope.srcChainId === envelope.dstChainId) {
      return { ok: false, reason: "invalid chain route", replayKey: "" }
    }

    const channelKey = `${envelope.srcChainId}:${envelope.channelId}`
    const last = this.lastNonceByChannel.get(channelKey)
    if (last !== undefined && envelope.nonce <= last) {
      return { ok: false, reason: "nonce not monotonic", replayKey: "" }
    }

    const replayKey = this.buildReplayKey(envelope)
    if (this.replayKeys.has(replayKey)) {
      return { ok: false, reason: "replay key already seen", replayKey }
    }

    return { ok: true, replayKey }
  }

  commit(envelope: CrossLayerEnvelope, replayKey: string): void {
    const channelKey = `${envelope.srcChainId}:${envelope.channelId}`
    this.lastNonceByChannel.set(channelKey, envelope.nonce)
    // Evict oldest entries if at capacity (Set iterates in insertion order)
    while (this.replayKeys.size >= this.maxReplayKeys) {
      const oldest = this.replayKeys.values().next().value
      if (oldest === undefined) break
      this.replayKeys.delete(oldest)
    }
    this.replayKeys.add(replayKey)
    this.persistState()
  }

  private loadPersisted(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) {
      return
    }
    try {
      const raw = readFileSync(this.persistencePath, "utf8")
      const parsed = JSON.parse(raw) as {
        lastNonceByChannel?: Array<[string, string]>
        replayKeys?: string[]
      }
      for (const [key, nonceStr] of parsed.lastNonceByChannel ?? []) {
        this.lastNonceByChannel.set(key, BigInt(nonceStr))
      }
      for (const key of parsed.replayKeys ?? []) {
        this.replayKeys.add(key)
      }
    } catch {
      // ignore corrupted persistence file and fallback to in-memory mode
    }
  }

  private persistState(): void {
    if (!this.persistencePath) {
      return
    }
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      const tmpPath = `${this.persistencePath}.tmp`
      const payload = JSON.stringify({
        lastNonceByChannel: [...this.lastNonceByChannel.entries()].map(([k, v]) => [k, v.toString()]),
        replayKeys: [...this.replayKeys.values()],
      })
      writeFileSync(tmpPath, payload, "utf8")
      renameSync(tmpPath, this.persistencePath)
    } catch {
      // fail-open: replay protection remains active in-memory
    }
  }
}

function encodeU64(value: number | bigint): Buffer {
  const n = typeof value === "bigint" ? value : BigInt(value)
  if (n < 0n || n > 0xffffffffffffffffn) {
    throw new Error("u64 out of range")
  }
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(n)
  return out
}

function encodeBytes32(hex: string): Buffer {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("bytes32 hex required")
  }
  return Buffer.from(normalized, "hex")
}
