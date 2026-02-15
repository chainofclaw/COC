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
import net from "node:net"
import { RoutingTable, ALPHA, K } from "./dht.ts"
import type { DhtPeer } from "./dht.ts"
import { WireClient } from "./wire-client.ts"
import type { WireClientConfig } from "./wire-client.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("dht-network")

const REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const ANNOUNCE_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes
const LOOKUP_TIMEOUT_MS = 5_000
const PEER_VERIFY_TIMEOUT_MS = 3_000
const STALE_PEER_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface DhtNetworkConfig {
  localId: string
  localAddress?: string
  chainId?: number
  bootstrapPeers: Array<{ id: string; address: string; port: number }>
  wireClients: WireClient[]
  signer?: NodeSigner
  verifier?: SignatureVerifier
  /** Direct peer ID → WireClient mapping for efficient lookup */
  wireClientByPeerId?: Map<string, WireClient>
  wireProbeFactory?: (
    cfg: WireClientConfig,
  ) => Pick<WireClient, "connect" | "disconnect" | "getRemoteNodeId">
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
  private verifyAttempts = 0
  private verifySuccess = 0
  private verifyFailures = 0
  private verifyFallbackTcpAttempts = 0
  private verifyFallbackTcpFailures = 0

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
            // Verify peer before adding to routing table
            // Skip verification for peers returned from connected clients (already verified)
            const hasConnectedClient = !!(
              this.cfg.wireClientByPeerId?.get(newPeer.id)?.isConnected() ||
              this.cfg.wireClients.find((c) => c.getRemoteNodeId() === newPeer.id && c.isConnected())
            )
            const reachable = hasConnectedClient || await this.verifyPeer(newPeer)
            if (reachable) {
              this.routingTable.addPeer(newPeer)
              this.cfg.onPeerDiscovered(newPeer)
            }
            improved = true
          }
        }
      }
    }

    return this.routingTable.findClosest(targetId, K)
  }

  /** Verify a peer is reachable via wire protocol (TCP connect + Pong response) */
  async verifyPeer(peer: DhtPeer): Promise<boolean> {
    this.verifyAttempts += 1
    // Try to find a wire client connected to this peer
    const client = this.cfg.wireClientByPeerId?.get(peer.id)
      ?? this.cfg.wireClients.find((c) => c.getRemoteNodeId() === peer.id && c.isConnected())

    if (client?.isConnected()) {
      // Verify claimed ID matches actual remote node ID from wire handshake
      const remoteId = client.getRemoteNodeId()
      if (remoteId && remoteId.toLowerCase() !== peer.id.toLowerCase()) {
        this.verifyFailures += 1
        log.warn("DHT peer ID mismatch with wire handshake", { claimed: peer.id, actual: remoteId })
        return false
      }
      this.verifySuccess += 1
      return true
    }

    // Prefer authenticated wire handshake when crypto config is available.
    const handshakeVerified = await this.verifyPeerByHandshake(peer)
    if (handshakeVerified !== null) {
      if (handshakeVerified) {
        this.verifySuccess += 1
      } else {
        this.verifyFailures += 1
      }
      return handshakeVerified
    }

    // Fallback: lightweight TCP connect probe when handshake config is unavailable.
    this.verifyFallbackTcpAttempts += 1
    const [host, portStr] = peer.address.split(":")
    const port = parseInt(portStr, 10)
    if (!host || !port || isNaN(port)) return false

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy()
        this.verifyFailures += 1
        this.verifyFallbackTcpFailures += 1
        resolve(false)
      }, PEER_VERIFY_TIMEOUT_MS)

      const socket = net.createConnection({ host, port }, () => {
        clearTimeout(timer)
        socket.destroy()
        this.verifySuccess += 1
        resolve(true)
      })

      socket.on("error", () => {
        clearTimeout(timer)
        this.verifyFailures += 1
        this.verifyFallbackTcpFailures += 1
        resolve(false)
      })
    })
  }

  private async verifyPeerByHandshake(peer: DhtPeer): Promise<boolean | null> {
    if (!this.cfg.chainId || !this.cfg.signer || !this.cfg.verifier) {
      return null
    }

    const [host, portStr] = peer.address.split(":")
    const port = parseInt(portStr, 10)
    if (!host || !port || isNaN(port)) return false

    return await new Promise<boolean>((resolve) => {
      let settled = false
      let probe: WireClient | null = null
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        probe?.disconnect()
        resolve(ok)
      }

      const timer = setTimeout(() => {
        settle(false)
      }, PEER_VERIFY_TIMEOUT_MS)

      const probeCfg: WireClientConfig = {
        host,
        port,
        nodeId: this.cfg.localId,
        chainId: this.cfg.chainId!,
        signer: this.cfg.signer,
        verifier: this.cfg.verifier,
        onConnected: () => {
          const remote = probe?.getRemoteNodeId()?.toLowerCase()
          if (!remote) {
            settle(false)
            return
          }
          if (remote !== peer.id.toLowerCase()) {
            log.warn("DHT probe handshake node ID mismatch", { claimed: peer.id, remote })
            settle(false)
            return
          }
          settle(true)
        },
      }
      probe = this.cfg.wireProbeFactory
        ? this.cfg.wireProbeFactory(probeCfg)
        : new WireClient(probeCfg)

      probe.connect()
    })
  }

  /** Query a peer for nodes closest to a target */
  private async findNode(peer: DhtPeer, targetId: string): Promise<DhtPeer[]> {
    // Priority 1: lookup by peer ID in the direct map (O(1))
    const mappedClient = this.cfg.wireClientByPeerId?.get(peer.id)
    if (mappedClient && mappedClient.isConnected()) {
      const remotePeers = await mappedClient.findNode(targetId, LOOKUP_TIMEOUT_MS)
      return remotePeers.map((p) => ({
        id: p.id,
        address: p.address,
        lastSeenMs: Date.now(),
      }))
    }

    // Priority 2: scan wireClients by remoteNodeId (backward compat)
    const client = this.cfg.wireClients.find(
      (c) => c.getRemoteNodeId() === peer.id && c.isConnected(),
    )

    if (client) {
      const remotePeers = await client.findNode(targetId, LOOKUP_TIMEOUT_MS)
      return remotePeers.map((p) => ({
        id: p.id,
        address: p.address,
        lastSeenMs: Date.now(),
      }))
    }

    // Fallback: return peers from local routing table
    return this.routingTable.findClosest(targetId, ALPHA)
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
      // Filter out stale peers (not seen in 24h)
      const now = Date.now()
      const fresh = peers.filter((p) => {
        if (!p.lastSeenMs) return true // unknown age — keep
        return (now - p.lastSeenMs) < STALE_PEER_THRESHOLD_MS
      })
      const added = this.routingTable.importPeers(fresh)
      log.info("DHT peers loaded", { loaded: added, total: peers.length, fresh: fresh.length, path: this.cfg.peerStorePath })
      return added
    } catch (err) {
      log.warn("failed to load DHT peers", { error: String(err) })
      return 0
    }
  }

  /** Get routing table + security stats */
  getStats(): {
    totalPeers: number
    nonEmptyBuckets: number
    maxBucketSize: number
    verifyAttempts: number
    verifySuccess: number
    verifyFailures: number
    verifyFallbackTcpAttempts: number
    verifyFallbackTcpFailures: number
  } {
    return {
      ...this.routingTable.stats(),
      verifyAttempts: this.verifyAttempts,
      verifySuccess: this.verifySuccess,
      verifyFailures: this.verifyFailures,
      verifyFallbackTcpAttempts: this.verifyFallbackTcpAttempts,
      verifyFallbackTcpFailures: this.verifyFallbackTcpFailures,
    }
  }
}
