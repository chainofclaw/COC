/**
 * DHT Network Layer
 *
 * Wraps RoutingTable with network operations:
 * - Bootstrap from seed peers
 * - Iterative FIND_NODE lookups (alpha=3 parallelism)
 * - Periodic bucket refresh
 * - Feeds discovered peers into PeerDiscovery
 */

import fs from "node:fs"
import path from "node:path"
import { RoutingTable, ALPHA, K } from "./dht.ts"
import type { DhtPeer } from "./dht.ts"
import type { WireClient } from "./wire-client.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("dht-network")

const REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const ANNOUNCE_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes
const LOOKUP_TIMEOUT_MS = 5_000

export interface DhtNetworkConfig {
  localId: string
  localAddress: string
  bootstrapPeers: Array<{ id: string; address: string; port: number }>
  wireClients: WireClient[]
  onPeerDiscovered: (peer: DhtPeer) => void
  /** Path to save/load routing table peers (optional) */
  peerStorePath?: string
}

export class DhtNetwork {
  private readonly cfg: DhtNetworkConfig
  readonly routingTable: RoutingTable
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(cfg: DhtNetworkConfig) {
    this.cfg = cfg
    this.routingTable = new RoutingTable(cfg.localId)
  }

  start(): void {
    this.stopped = false

    // Add bootstrap peers to routing table
    for (const peer of this.cfg.bootstrapPeers) {
      this.routingTable.addPeer({
        id: peer.id,
        address: `${peer.address}:${peer.port}`,
        lastSeenMs: Date.now(),
      })
    }

    // Bootstrap lookup for our own ID to populate routing table
    void this.bootstrap()

    // Periodic refresh: random lookup in each non-empty bucket
    this.refreshTimer = setInterval(() => {
      void this.refresh()
    }, REFRESH_INTERVAL_MS)

    // Periodic announce: broadcast our presence to known peers
    this.announceTimer = setInterval(() => {
      this.announce()
    }, ANNOUNCE_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
  }

  /** Bootstrap the DHT by looking up our own node ID */
  async bootstrap(): Promise<DhtPeer[]> {
    log.info("bootstrapping DHT", { seeds: this.cfg.bootstrapPeers.length })
    return await this.iterativeLookup(this.cfg.localId)
  }

  /** Iterative FIND_NODE lookup for a target ID */
  async iterativeLookup(targetId: string): Promise<DhtPeer[]> {
    const closest = this.routingTable.findClosest(targetId, K)
    if (closest.length === 0) return []

    const queried = new Set<string>()
    const found = new Map<string, DhtPeer>()

    // Seed with initial closest
    for (const peer of closest) {
      found.set(peer.id, peer)
    }

    let improved = true
    while (improved && !this.stopped) {
      improved = false

      // Select ALPHA unqueried peers closest to target
      const candidates = [...found.values()]
        .filter((p) => !queried.has(p.id))
        .slice(0, ALPHA)

      if (candidates.length === 0) break

      // Query in parallel
      const results = await Promise.allSettled(
        candidates.map(async (peer) => {
          queried.add(peer.id)
          return await this.findNode(peer, targetId)
        }),
      )

      for (const result of results) {
        if (result.status !== "fulfilled") continue
        for (const newPeer of result.value) {
          if (newPeer.id === this.cfg.localId) continue
          if (!found.has(newPeer.id)) {
            found.set(newPeer.id, newPeer)
            this.routingTable.addPeer(newPeer)
            this.cfg.onPeerDiscovered(newPeer)
            improved = true
          }
        }
      }
    }

    return this.routingTable.findClosest(targetId, K)
  }

  /** Query a peer for nodes closest to a target */
  private async findNode(peer: DhtPeer, targetId: string): Promise<DhtPeer[]> {
    // Find a wire client connected to this peer
    const client = this.cfg.wireClients.find(
      (c) => c.getRemoteNodeId() === peer.id && c.isConnected(),
    )

    if (!client) {
      // No direct wire connection — return peers from local routing table as fallback
      return this.routingTable.findClosest(targetId, ALPHA)
    }

    // Send FIND_NODE request via wire protocol and await response
    const remotePeers = await client.findNode(targetId, LOOKUP_TIMEOUT_MS)
    return remotePeers.map((p) => ({
      id: p.id,
      address: p.address,
      lastSeenMs: Date.now(),
    }))
  }

  /** Refresh the routing table by performing random lookups */
  private async refresh(): Promise<void> {
    if (this.stopped) return

    // Generate a random target for lookup
    const randomBytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256)
    }
    const randomId = "0x" + Array.from(randomBytes).map((b) => b.toString(16).padStart(2, "0")).join("")

    log.debug("DHT refresh lookup", { tableSize: this.routingTable.size() })
    await this.iterativeLookup(randomId)
  }

  /** Announce our presence to all connected peers */
  announce(): void {
    if (this.stopped) return

    const localPeer: DhtPeer = {
      id: this.cfg.localId,
      address: this.cfg.localAddress,
      lastSeenMs: Date.now(),
    }

    // Add ourselves to routing table (for consistency)
    // and notify each connected wire client
    let announced = 0
    for (const client of this.cfg.wireClients) {
      if (client.isConnected()) {
        // Use FindNode for our own ID — peers will add us to their routing table
        void client.findNode(this.cfg.localId, 3000)
        announced++
      }
    }

    if (announced > 0) {
      log.debug("DHT announce sent", { peers: announced })
    }
  }

  /**
   * Save routing table peers to disk.
   * Returns number of peers saved.
   */
  savePeers(): number {
    if (!this.cfg.peerStorePath) return 0

    const peers = this.routingTable.exportPeers()
    try {
      const dir = path.dirname(this.cfg.peerStorePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(this.cfg.peerStorePath, JSON.stringify(peers, null, 2))
      log.info("DHT peers saved", { count: peers.length, path: this.cfg.peerStorePath })
      return peers.length
    } catch (err) {
      log.warn("failed to save DHT peers", { error: String(err) })
      return 0
    }
  }

  /**
   * Load routing table peers from disk.
   * Returns number of peers loaded.
   */
  loadPeers(): number {
    if (!this.cfg.peerStorePath) return 0

    try {
      if (!fs.existsSync(this.cfg.peerStorePath)) return 0
      const data = fs.readFileSync(this.cfg.peerStorePath, "utf-8")
      const peers = JSON.parse(data) as Array<{ id: string; address: string; lastSeenMs?: number }>

      if (!Array.isArray(peers)) return 0
      const added = this.routingTable.importPeers(peers)
      log.info("DHT peers loaded", { loaded: added, total: peers.length, path: this.cfg.peerStorePath })
      return added
    } catch (err) {
      log.warn("failed to load DHT peers", { error: String(err) })
      return 0
    }
  }

  /** Get routing table stats */
  getStats(): { totalPeers: number; nonEmptyBuckets: number; maxBucketSize: number } {
    return this.routingTable.stats()
  }
}
