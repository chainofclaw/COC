/**
 * Peer Discovery
 *
 * Implements a simple peer discovery protocol:
 * - Bootstrap peers from static config
 * - Periodic peer exchange: ask known peers for their peer lists
 * - Health checking with automatic removal of unreachable peers
 * - Peer limit to prevent resource exhaustion
 */

import { request as httpRequest } from "node:http"
import type { NodePeer } from "./blockchain-types.ts"
import { PeerScoring } from "./peer-scoring.ts"
import { PeerStore } from "./peer-store.ts"
import { DnsSeedResolver } from "./dns-seeds.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("discovery")

export interface DiscoveryConfig {
  maxPeers: number
  maxDiscoveredPerBatch: number
  discoveryIntervalMs: number
  healthCheckIntervalMs: number
  healthCheckTimeoutMs: number
  selfId: string
  selfUrl: string
  peerStorePath?: string
  dnsSeeds?: string[]
  peerMaxAgeMs?: number
  verifyPeerIdentity?: (peer: NodePeer) => Promise<boolean>
  /** Build a signed auth header value for outbound GET requests (avoids circular dep on p2p.ts) */
  buildGetAuthHeader?: (path: string) => string
}

const DEFAULT_CONFIG: DiscoveryConfig = {
  maxPeers: 50,
  maxDiscoveredPerBatch: 200,
  discoveryIntervalMs: 30_000,    // 30 seconds
  healthCheckIntervalMs: 60_000,  // 1 minute
  healthCheckTimeoutMs: 5_000,    // 5 seconds
  selfId: "node-1",
  selfUrl: "http://127.0.0.1:19780",
}

export class PeerDiscovery {
  private readonly peers = new Map<string, NodePeer>()
  private readonly pendingPeers = new Map<string, NodePeer>()
  private readonly verifyingPeers = new Set<string>()
  private readonly scoring: PeerScoring
  private readonly cfg: DiscoveryConfig
  private readonly peerStore: PeerStore | null
  private readonly dnsResolver: DnsSeedResolver | null
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  /** Track peer count per IP to resist Sybil attacks via IP concentration */
  private readonly peersPerIp = new Map<string, number>()
  private static readonly MAX_PEERS_PER_IP = 3

  constructor(
    bootstrapPeers: NodePeer[],
    scoring: PeerScoring,
    config?: Partial<DiscoveryConfig>,
  ) {
    this.scoring = scoring
    this.cfg = { ...DEFAULT_CONFIG, ...config }

    // Initialize peer store for persistence
    this.peerStore = this.cfg.peerStorePath
      ? new PeerStore({
          filePath: this.cfg.peerStorePath,
          maxAgeMs: this.cfg.peerMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000,
        })
      : null

    // Initialize DNS seed resolver
    this.dnsResolver = this.cfg.dnsSeeds && this.cfg.dnsSeeds.length > 0
      ? new DnsSeedResolver({ seeds: this.cfg.dnsSeeds })
      : null

    // Register bootstrap peers
    for (const peer of bootstrapPeers) {
      const normalized = normalizePeer(peer)
      if (!normalized || normalized.id === this.cfg.selfId) continue
      this.peers.set(normalized.id, normalized)
      this.scoring.addPeer(normalized.id, normalized.url)
      const host = extractHost(normalized.url)
      this.peersPerIp.set(host, (this.peersPerIp.get(host) ?? 0) + 1)
    }
  }

  /**
   * Start periodic discovery and health checking.
   * Loads persisted peers and DNS seeds on startup.
   */
  start(): void {
    // Load persisted peers and DNS seeds asynchronously
    this.loadInitialPeers().catch((err) => {
      log.error("failed to load initial peers", { error: String(err) })
    })

    this.discoveryTimer = setInterval(() => {
      this.discoverPeers().catch((err) => {
        log.error("discovery round failed", { error: String(err) })
      })
    }, this.cfg.discoveryIntervalMs)

    this.healthTimer = setInterval(() => {
      this.healthCheck().catch((err) => {
        log.error("health check failed", { error: String(err) })
      })
    }, this.cfg.healthCheckIntervalMs)

    // Start auto-save for peer persistence
    if (this.peerStore) {
      this.peerStore.startAutoSave()
    }

    log.info("peer discovery started", {
      bootstrapPeers: this.peers.size,
      maxPeers: this.cfg.maxPeers,
      hasPeerStore: !!this.peerStore,
      hasDnsSeeds: !!this.dnsResolver,
      hasIdentityVerification: !!this.cfg.verifyPeerIdentity,
    })
  }

  /**
   * Stop discovery and health checking. Saves peers to disk.
   */
  stop(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer)
      this.discoveryTimer = null
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    if (this.peerStore) {
      this.peerStore.stopAutoSave()
      this.peerStore.save().catch(() => {})
    }
    this.pendingPeers.clear()
    this.verifyingPeers.clear()
  }

  /**
   * Get all known active peers (non-banned)
   */
  getActivePeers(): NodePeer[] {
    return [...this.peers.values()].filter(
      (p) => !this.scoring.isBanned(p.id),
    )
  }

  /**
   * Get all known peers
   */
  getAllPeers(): NodePeer[] {
    return [...this.peers.values()]
  }

  /**
   * Get peers waiting for identity verification.
   */
  getPendingPeers(): NodePeer[] {
    return [...this.pendingPeers.values()]
  }

  /**
   * Remove a peer by ID
   */
  removePeer(id: string): boolean {
    const peer = this.peers.get(id)
    const had = this.peers.delete(id)
    this.pendingPeers.delete(id)
    // Decrement IP diversity counter
    if (peer) {
      const host = extractHost(peer.url)
      const count = this.peersPerIp.get(host) ?? 0
      if (count <= 1) this.peersPerIp.delete(host)
      else this.peersPerIp.set(host, count - 1)
    }
    if (this.peerStore) {
      this.peerStore.removePeer(id)
    }
    return had
  }

  /**
   * Get peer list for exchange (shared with requesting peers)
   */
  getPeerListForExchange(): NodePeer[] {
    const active = this.getActivePeers()
    // Include self in the exchange list
    return [
      { id: this.cfg.selfId, url: this.cfg.selfUrl },
      ...active.slice(0, 20), // Limit to 20 peers per exchange
    ]
  }

  /**
   * Process peer list received from another peer
   */
  addDiscoveredPeers(peers: NodePeer[]): number {
    let added = 0
    const limited = peers.slice(0, this.cfg.maxDiscoveredPerBatch)
    for (const peer of limited) {
      const normalized = normalizePeer(peer)
      if (!normalized) continue
      if (normalized.id === this.cfg.selfId) continue
      if (this.peers.has(normalized.id)) continue
      if (this.pendingPeers.has(normalized.id)) continue
      if (this.peers.size + this.pendingPeers.size >= this.cfg.maxPeers) break

      // IP diversity: reject if too many peers share the same IP
      const host = extractHost(normalized.url)
      const ipCount = this.peersPerIp.get(host) ?? 0
      if (ipCount >= PeerDiscovery.MAX_PEERS_PER_IP) continue

      if (this.cfg.verifyPeerIdentity) {
        this.pendingPeers.set(normalized.id, normalized)
        void this.verifyAndPromotePeer(normalized.id)
      } else {
        this.promotePeer(normalized)
      }
      added++
    }
    if (added > 0) {
      log.info("discovered new peers", { count: added })
    }
    return added
  }

  private promotePeer(peer: NodePeer): void {
    this.peers.set(peer.id, peer)
    this.scoring.addPeer(peer.id, peer.url)
    // Track IP diversity
    const host = extractHost(peer.url)
    this.peersPerIp.set(host, (this.peersPerIp.get(host) ?? 0) + 1)
    if (this.peerStore) {
      this.peerStore.addPeer(peer)
    }
  }

  private async verifyAndPromotePeer(peerId: string): Promise<void> {
    if (!this.cfg.verifyPeerIdentity) return
    if (this.verifyingPeers.has(peerId)) return
    const peer = this.pendingPeers.get(peerId)
    if (!peer) return

    this.verifyingPeers.add(peerId)
    try {
      const ok = await this.cfg.verifyPeerIdentity(peer)
      if (ok) {
        // Re-check capacity/state AND IP diversity after async verification
        const host = extractHost(peer.url)
        const ipCount = this.peersPerIp.get(host) ?? 0
        if (!this.peers.has(peer.id) && this.peers.size < this.cfg.maxPeers && ipCount < PeerDiscovery.MAX_PEERS_PER_IP) {
          this.promotePeer(peer)
        }
      } else {
        log.warn("peer identity verification failed", { id: peer.id, url: peer.url })
      }
    } catch (err) {
      log.warn("peer identity verification error", { id: peer.id, error: String(err) })
    } finally {
      this.pendingPeers.delete(peerId)
      this.verifyingPeers.delete(peerId)
    }
  }

  /**
   * Ask known peers for their peer lists
   */
  async discoverPeers(): Promise<void> {
    const activePeers = this.getActivePeers()
    if (activePeers.length === 0) return

    // Ask up to 3 random peers
    const sample = shuffleArray(activePeers).slice(0, 3)

    for (const peer of sample) {
      try {
        const peerList = await this.fetchPeerList(peer)
        this.addDiscoveredPeers(peerList)
        this.scoring.recordSuccess(peer.id)
      } catch {
        this.scoring.recordFailure(peer.id)
      }
    }
  }

  /**
   * Health-check all known peers
   */
  async healthCheck(): Promise<void> {
    const peers = [...this.peers.values()]
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const healthy = await this.checkPeerHealth(peer)
        if (healthy) {
          this.scoring.recordSuccess(peer.id)
        } else {
          this.scoring.recordTimeout(peer.id)
        }
        return { id: peer.id, healthy }
      }),
    )

    // Remove peers that have been banned
    for (const result of results) {
      if (result.status === "fulfilled" && !result.value.healthy) {
        if (this.scoring.isBanned(result.value.id)) {
          log.info("peer banned", { id: result.value.id })
        }
      }
    }
  }

  private async fetchPeerList(peer: NodePeer): Promise<NodePeer[]> {
    const MAX_RESPONSE_BODY = 512 * 1024 // 512 KB
    return new Promise<NodePeer[]>((resolve, reject) => {
      const endpoint = new URL(`${peer.url}/p2p/peers`)
      const authHeaders: Record<string, string> = {}
      if (this.cfg.buildGetAuthHeader) {
        authHeaders["x-p2p-auth"] = this.cfg.buildGetAuthHeader("/p2p/peers")
      }
      const req = httpRequest(
        {
          hostname: endpoint.hostname,
          port: endpoint.port,
          path: endpoint.pathname,
          method: "GET",
          timeout: this.cfg.healthCheckTimeoutMs,
          headers: authHeaders,
        },
        (res) => {
          let data = ""
          let size = 0
          res.on("data", (chunk: string | Buffer) => {
            size += typeof chunk === "string" ? chunk.length : chunk.byteLength
            if (size > MAX_RESPONSE_BODY) {
              req.destroy()
              reject(new Error("peer list response too large"))
              return
            }
            data += chunk
          })
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data) as { peers?: NodePeer[] }
              resolve(parsed.peers ?? [])
            } catch {
              reject(new Error("invalid peer list response"))
            }
          })
        },
      )
      req.on("error", reject)
      req.on("timeout", () => {
        req.destroy()
        reject(new Error("timeout"))
      })
      req.end()
    })
  }

  /**
   * Load peers from disk and DNS seeds on startup.
   */
  private async loadInitialPeers(): Promise<void> {
    // Load persisted peers from disk
    if (this.peerStore) {
      const stored = await this.peerStore.load()
      this.addDiscoveredPeers(stored.map(({ id, url }) => ({ id, url })))
    }

    // Resolve DNS seeds
    if (this.dnsResolver) {
      const dnsPeers = await this.dnsResolver.resolve()
      this.addDiscoveredPeers(dnsPeers)
    }
  }

  private async checkPeerHealth(peer: NodePeer): Promise<boolean> {
    const MAX_HEALTH_BODY = 64 * 1024 // 64 KB
    return new Promise<boolean>((resolve) => {
      const endpoint = new URL(`${peer.url}/health`)
      const req = httpRequest(
        {
          hostname: endpoint.hostname,
          port: endpoint.port,
          path: endpoint.pathname,
          method: "GET",
          timeout: this.cfg.healthCheckTimeoutMs,
        },
        (res) => {
          let size = 0
          res.on("data", (chunk: string | Buffer) => {
            size += typeof chunk === "string" ? chunk.length : chunk.byteLength
            if (size > MAX_HEALTH_BODY) {
              req.destroy()
              resolve(false)
              return
            }
          })
          res.on("end", () => {
            resolve((res.statusCode ?? 500) < 400)
          })
        },
      )
      req.on("error", () => resolve(false))
      req.on("timeout", () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }
}

function normalizePeer(peer: NodePeer): NodePeer | null {
  if (!isValidPeerId(peer.id)) return null
  if (!peer.url) return null

  try {
    const url = new URL(peer.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null
    }
    if (!url.hostname) {
      return null
    }
    if (url.port && !/^\d+$/.test(url.port)) {
      return null
    }
    return {
      id: peer.id.trim(),
      url: `${url.protocol}//${url.host}`,
    }
  } catch {
    return null
  }
}

function isValidPeerId(id: string): boolean {
  const trimmed = id.trim()
  if (trimmed.length < 1 || trimmed.length > 128) return false
  return /^[a-zA-Z0-9._:-]+$/.test(trimmed)
}

/** Extract hostname (IP or domain) from a peer URL for IP diversity tracking */
function extractHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = result[i]
    result[i] = result[j]
    result[j] = tmp
  }
  return result
}
