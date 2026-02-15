/**
 * Peer Store - Persistent peer list storage
 *
 * Saves and loads peer information to/from disk with
 * expiration filtering to prune stale peers.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { NodePeer } from "./blockchain-types.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("peer-store")

export interface StoredPeer extends NodePeer {
  lastSeenMs: number
  addedMs: number
  failCount: number
}

export interface PeerStoreConfig {
  filePath: string
  maxAgeMs: number // Default 7 days
  maxPeers: number
  saveIntervalMs: number
}

const DEFAULT_CONFIG: PeerStoreConfig = {
  filePath: "peers.json",
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxPeers: 200,
  saveIntervalMs: 5 * 60 * 1000, // 5 minutes
}

export class PeerStore {
  private readonly cfg: PeerStoreConfig
  private peers = new Map<string, StoredPeer>()
  private dirty = false
  private saveTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<PeerStoreConfig>) {
    this.cfg = { ...DEFAULT_CONFIG, ...config }
  }

  async load(): Promise<StoredPeer[]> {
    try {
      const raw = await readFile(this.cfg.filePath, "utf-8")
      const data = JSON.parse(raw) as StoredPeer[]
      const now = Date.now()

      // Filter out expired peers
      const valid = data.filter((p) => now - p.lastSeenMs < this.cfg.maxAgeMs)

      this.peers.clear()
      for (const peer of valid) {
        this.peers.set(peer.id, peer)
      }

      log.info("loaded peers from disk", {
        total: data.length,
        valid: valid.length,
        expired: data.length - valid.length,
      })

      return valid
    } catch {
      // File doesn't exist or parse error
      return []
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return

    try {
      await mkdir(dirname(this.cfg.filePath), { recursive: true })
      const data = [...this.peers.values()]
      await writeFile(this.cfg.filePath, JSON.stringify(data, null, 2))
      this.dirty = false
    } catch (err) {
      log.error("failed to save peers", { error: String(err) })
    }
  }

  startAutoSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setInterval(() => {
      this.save().catch((err) => {
        log.error("auto-save failed", { error: String(err) })
      })
    }, this.cfg.saveIntervalMs)
    this.saveTimer.unref()
  }

  stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer)
      this.saveTimer = null
    }
  }

  addPeer(peer: NodePeer): void {
    const now = Date.now()
    const existing = this.peers.get(peer.id)

    if (existing) {
      // Update last seen time
      this.peers.set(peer.id, { ...existing, lastSeenMs: now, url: peer.url })
    } else {
      if (this.peers.size >= this.cfg.maxPeers) {
        this.evictOldest()
      }
      this.peers.set(peer.id, {
        ...peer,
        lastSeenMs: now,
        addedMs: now,
        failCount: 0,
      })
    }
    this.dirty = true
  }

  removePeer(id: string): void {
    if (this.peers.delete(id)) {
      this.dirty = true
    }
  }

  recordFailure(id: string): void {
    const peer = this.peers.get(id)
    if (peer) {
      this.peers.set(id, { ...peer, failCount: peer.failCount + 1 })
      // Remove peers with too many failures
      if (peer.failCount >= 10) {
        this.peers.delete(id)
      }
      this.dirty = true
    }
  }

  recordSuccess(id: string): void {
    const peer = this.peers.get(id)
    if (peer) {
      this.peers.set(id, { ...peer, lastSeenMs: Date.now(), failCount: 0 })
      this.dirty = true
    }
  }

  getPeers(): NodePeer[] {
    return [...this.peers.values()].map(({ id, url }) => ({ id, url }))
  }

  getStoredPeers(): StoredPeer[] {
    return [...this.peers.values()]
  }

  size(): number {
    return this.peers.size
  }

  private evictOldest(): void {
    let oldest: { id: string; lastSeenMs: number } | null = null
    for (const [id, peer] of this.peers) {
      if (!oldest || peer.lastSeenMs < oldest.lastSeenMs) {
        oldest = { id, lastSeenMs: peer.lastSeenMs }
      }
    }
    if (oldest) {
      this.peers.delete(oldest.id)
    }
  }
}
