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
  discoveryIntervalMs: number
  healthCheckIntervalMs: number
  healthCheckTimeoutMs: number
  selfId: string
  selfUrl: string
  peerStorePath?: string
  dnsSeeds?: string[]
  peerMaxAgeMs?: number
}

const DEFAULT_CONFIG: DiscoveryConfig = {
  maxPeers: 50,
  discoveryIntervalMs: 30_000,    // 30 seconds
  healthCheckIntervalMs: 60_000,  // 1 minute
  healthCheckTimeoutMs: 5_000,    // 5 seconds
  selfId: "node-1",
  selfUrl: "http://127.0.0.1:19780",
}

export class PeerDiscovery {
  private readonly peers = new Map<string, NodePeer>()
  private readonly scoring: PeerScoring
  private readonly cfg: DiscoveryConfig
  private readonly peerStore: PeerStore | null
  private readonly dnsResolver: DnsSeedResolver | null
  private discoveryTimer: ReturnType<typeof setInterval> | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null

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
      if (peer.id !== this.cfg.selfId) {
        this.peers.set(peer.id, peer)
        this.scoring.addPeer(peer.id, peer.url)
      }
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
    for (const peer of peers) {
      if (peer.id === this.cfg.selfId) continue
      if (this.peers.has(peer.id)) continue
      if (this.peers.size >= this.cfg.maxPeers) break

      this.peers.set(peer.id, peer)
      this.scoring.addPeer(peer.id, peer.url)
      if (this.peerStore) {
        this.peerStore.addPeer(peer)
      }
      added++
    }
    if (added > 0) {
      log.info("discovered new peers", { count: added })
    }
    return added
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
    return new Promise<NodePeer[]>((resolve, reject) => {
      const endpoint = new URL(`${peer.url}/p2p/peers`)
      const req = httpRequest(
        {
          hostname: endpoint.hostname,
          port: endpoint.port,
          path: endpoint.pathname,
          method: "GET",
          timeout: this.cfg.healthCheckTimeoutMs,
        },
        (res) => {
          let data = ""
          res.on("data", (chunk) => (data += chunk))
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
          let data = ""
          res.on("data", (chunk) => (data += chunk))
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
