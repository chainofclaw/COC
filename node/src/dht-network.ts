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
import nodeCrypto from "node:crypto"
import { RoutingTable, ALPHA, K, sortByDistance, parseHostPort } from "./dht.ts"
import type { DhtPeer } from "./dht.ts"
import { isSSRFTarget } from "./peer-discovery.ts"
import { WireClient } from "./wire-client.ts"
import type { WireClientConfig } from "./wire-client.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("dht-network")

const REFRESH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const ANNOUNCE_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes
const LOOKUP_TIMEOUT_MS = 5_000
const LOOKUP_GLOBAL_TIMEOUT_MS = 30_000
const LOOKUP_MAX_ITERATIONS = 20
const LOOKUP_MAX_QUERIES = 60 // cap total outbound queries per lookup to prevent amplification
const PEER_VERIFY_TIMEOUT_MS = 3_000
const STALE_PEER_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours

// Provider records: which peers claim to hold which CIDs. Used by IPFS block
// fetch to route GET to the right node (C1.3) and by repair/replication
// (C3.2/C3.3) to decide when a CID is under-replicated. libp2p kad-dht uses
// a 24h provider TTL with republish every 12h; we mirror those defaults.
// Records live only in memory — nodes reannounce periodically (see C3.2).
export const DEFAULT_PROVIDER_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
// Cap providers per CID to keep the map bounded under hostile flooding.
// 64 is ample for any realistic replication factor (default K=3) while
// leaving room for transient restarts / split-brain temporary overclaim.
const MAX_PROVIDERS_PER_CID = 64
// C3.2 re-announce cadence: republish every TTL/2 so a record's expiry
// is always bumped before it lapses. 12h matches libp2p kad-dht default.
const REANNOUNCE_INTERVAL_MS = DEFAULT_PROVIDER_TTL_MS / 2
// Throttle per-tick batch size: at 100 CID/min a 10k-file blockstore
// drains in ~100 min, well within the 12h cadence. Prevents a fresh-
// restart node from flooding its own provider map.
const REANNOUNCE_BATCH_SIZE = 100
// Periodic flush of provider records to disk. 1 min is short enough that
// a crash loses ≤1 min of advertise state (re-derivable from local pins
// via reannounceSelfProviders within ≤TTL/2) and long enough to amortise
// the JSON serialization cost when the map is hot.
const PROVIDER_SAVE_INTERVAL_MS = 60_000

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
  /**
   * Path to save/load provider records (CID → peers-who-have-it). Without
   * persistence, restart wipes the in-memory map and `findProviders()`
   * returns [] for any CID until peers re-announce (≤ TTL/2 cadence).
   * Persisted records are filtered against the current TTL on load —
   * stale entries beyond their expiry are dropped.
   */
  providerStorePath?: string
  /** Enforce authenticated handshake verification; when true, disables TCP-only fallback. */
  requireAuthenticatedVerify?: boolean
}

export class DhtNetwork {
  private readonly cfg: DhtNetworkConfig
  readonly routingTable: RoutingTable
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private reannounceTimer: ReturnType<typeof setInterval> | null = null
  private providerSaveTimer: ReturnType<typeof setInterval> | null = null
  private reannouncePinSource: (() => Promise<string[]> | string[]) | null = null
  private reannouncesPerformed = 0
  private stopped = false
  private verifyAttempts = 0
  private verifySuccess = 0
  private verifyFailures = 0
  private verifyFallbackTcpAttempts = 0
  private verifyFallbackTcpFailures = 0

  /**
   * CID → peers-who-claim-to-hold-it mapping for content routing.
   * Outer key is lowercased CID string, inner key is lowercased peer id.
   * Inner value is absolute expiry timestamp (ms since epoch) — entries
   * past that time are dropped by `removeExpiredProviders()`, which
   * refresh() calls every 5 min. Entries are purely advisory: a peer can
   * advertise a CID then crash before it's actually fetchable, so callers
   * must tolerate BlockRequest returning `found:false` and fall through
   * to the next provider.
   */
  private providerRecords: Map<string, Map<string, number>> = new Map()
  private providersPut = 0
  private providersExpired = 0

  constructor(cfg: DhtNetworkConfig) {
    this.cfg = cfg
    this.routingTable = new RoutingTable(cfg.localId, {
      pingPeer: (peer) => this.verifyPeer(peer),
    })
  }

  start(): void {
    this.stopped = false

    // Restore provider records from disk before any tick can fire so
    // findProviders() works for previously-PUT CIDs the moment we're
    // listening — without this, every restart loses ~12h of advertise
    // state and old CIDs return [] until peers re-announce.
    this.loadProviders()

    // Add bootstrap peers to routing table
    for (const peer of this.cfg.bootstrapPeers) {
      void this.routingTable.addPeer({
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
    this.refreshTimer.unref()

    // Periodic announce: broadcast our presence to known peers
    this.announceTimer = setInterval(() => {
      this.announce()
    }, ANNOUNCE_INTERVAL_MS)
    this.announceTimer.unref()

    // Phase C3.2: if the caller attached a pin source via
    // `setReannouncePinSource`, republish self-provider entries on a
    // TTL/2 cadence so long-lived nodes don't let their own records
    // expire. Timer starts unconditionally — the callback is a no-op
    // when no source is attached.
    this.reannounceTimer = setInterval(() => {
      void this.reannounceSelfProviders().catch((err) => {
        log.warn("reannounceSelfProviders failed", { error: String(err) })
      })
    }, REANNOUNCE_INTERVAL_MS)
    this.reannounceTimer.unref()

    // Periodically flush provider records to disk so a crash loses at
    // most one save interval. Cadence matches the routing table's
    // implicit save (savePeers is currently called by the host on stop
    // only, but the provider map churns every PUT so we save more often).
    if (this.cfg.providerStorePath) {
      this.providerSaveTimer = setInterval(() => {
        this.saveProviders()
      }, PROVIDER_SAVE_INTERVAL_MS)
      this.providerSaveTimer.unref()
    }
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
    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer)
      this.reannounceTimer = null
    }
    if (this.providerSaveTimer) {
      clearInterval(this.providerSaveTimer)
      this.providerSaveTimer = null
    }
    // Final flush on stop so a graceful shutdown captures the latest
    // self-announce + freshly-learned provider entries.
    if (this.cfg.providerStorePath) this.saveProviders()
  }

  /**
   * Phase C3.2: attach a pin source so the periodic re-announce loop
   * knows which CIDs to bump. Pulled lazily per tick so the timer never
   * captures a snapshot — new PUTs between ticks get picked up on the
   * next pass automatically.
   *
   * Kept as a setter rather than a constructor arg because the
   * blockstore is wired up after DhtNetwork in index.ts's startup order.
   */
  setReannouncePinSource(source: () => Promise<string[]> | string[]): void {
    this.reannouncePinSource = source
  }

  /**
   * Re-publish self-provider entries for every pinned CID. Called by
   * the timer every TTL/2 and exposed as a public helper so tests can
   * drive it deterministically without waiting 12h.
   *
   * Batches ≤ REANNOUNCE_BATCH_SIZE per call so a freshly-restarted
   * node with 100k pins doesn't burn a 10-ms tick on the hot path;
   * remainder picked up on the next tick. In practice the timer fires
   * every 12h so even a 1M-CID blockstore converges in ~7 ticks at
   * 100 CID/tick, but operators who care can shorten the interval via
   * the test helper.
   */
  async reannounceSelfProviders(): Promise<number> {
    if (this.stopped) return 0
    if (!this.reannouncePinSource) return 0
    const cids = await this.reannouncePinSource()
    if (!Array.isArray(cids) || cids.length === 0) return 0
    const batch = cids.slice(0, REANNOUNCE_BATCH_SIZE)
    for (const cid of batch) {
      this.putProvider(cid, this.cfg.localId)
    }
    this.reannouncesPerformed += batch.length
    log.debug("self-reannounce tick", { total: cids.length, reannounced: batch.length })
    return batch.length
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
    const startMs = Date.now()
    let iterations = 0
    let totalQueries = 0
    while (improved && !this.stopped) {
      improved = false
      iterations++
      if (iterations > LOOKUP_MAX_ITERATIONS || totalQueries >= LOOKUP_MAX_QUERIES || Date.now() - startMs > LOOKUP_GLOBAL_TIMEOUT_MS) {
        log.debug("iterative lookup terminated", { iterations, elapsedMs: Date.now() - startMs })
        break
      }

      // Select ALPHA unqueried peers closest to target (sorted by XOR distance)
      const unqueried = [...found.values()].filter((p) => !queried.has(p.id))
      const candidates = sortByDistance(targetId, unqueried).slice(0, ALPHA)

      if (candidates.length === 0) break

      // Query in parallel (cap by remaining query budget)
      const budget = LOOKUP_MAX_QUERIES - totalQueries
      const cappedCandidates = candidates.slice(0, Math.max(budget, 0))
      if (cappedCandidates.length === 0) break
      totalQueries += cappedCandidates.length

      const results = await Promise.allSettled(
        cappedCandidates.map(async (peer) => {
          queried.add(peer.id)
          return await this.findNode(peer, targetId)
        }),
      )

      // Collect all new peers from query results, then verify in parallel batch
      const pendingVerify: DhtPeer[] = []
      const preVerified: DhtPeer[] = []
      for (const result of results) {
        if (result.status !== "fulfilled") continue
        for (const newPeer of result.value) {
          const peerId = String(newPeer.id ?? "").toLowerCase()
          if (peerId === this.cfg.localId.toLowerCase()) continue
          if (!isValidNodeId(peerId)) continue
          if (!newPeer.address || typeof newPeer.address !== "string") continue
          // Reject peer addresses pointing at SSRF targets (cloud metadata /
          // link-local). FIND_NODE responses are untrusted; without this a
          // malicious peer could induce verification connects to internal
          // endpoints. Same canonical policy as peer-discovery.ts — devnet
          // loopback / RFC1918 stay allowed.
          const hostPort = parseHostPort(newPeer.address)
          if (hostPort && isSSRFTarget(hostPort.host)) continue

          const normalizedPeer: DhtPeer = {
            id: peerId,
            address: newPeer.address,
            lastSeenMs: newPeer.lastSeenMs ?? Date.now(),
          }

          if (found.has(normalizedPeer.id)) continue
          // Skip verification for peers returned from connected clients (already verified).
          // Issue #70: lookup by lowercase key — wireClientByPeerId is
          // populated with lowercased keys (see index.ts), and routing-
          // table peer IDs are lowercase, so a direct Map.get hits.
          const wantLower = normalizedPeer.id.toLowerCase()
          const hasConnectedClient = !!(
            this.cfg.wireClientByPeerId?.get(wantLower)?.isConnected() ||
            this.cfg.wireClients.find((c) => {
              if (!c.isConnected()) return false
              const remote = c.getRemoteNodeId()
              return remote ? remote.toLowerCase() === wantLower : false
            })
          )
          if (hasConnectedClient) {
            preVerified.push(normalizedPeer)
          } else {
            pendingVerify.push(normalizedPeer)
          }
        }
      }

      // Add pre-verified peers immediately
      for (const peer of preVerified) {
        if (found.has(peer.id)) continue
        found.set(peer.id, peer)
        await this.routingTable.addPeer(peer)
        this.cfg.onPeerDiscovered(peer)
        improved = true
      }

      // Verify remaining peers in parallel (concurrent batch instead of serial)
      if (pendingVerify.length > 0) {
        const VERIFY_CONCURRENCY = 5
        for (let i = 0; i < pendingVerify.length; i += VERIFY_CONCURRENCY) {
          const batch = pendingVerify.slice(i, i + VERIFY_CONCURRENCY)
          const verifyResults = await Promise.allSettled(
            batch.map(async (peer) => ({ peer, ok: await this.verifyPeer(peer) })),
          )
          for (const vr of verifyResults) {
            if (vr.status !== "fulfilled" || !vr.value.ok) continue
            const peer = vr.value.peer
            if (found.has(peer.id)) continue
            found.set(peer.id, peer)
            await this.routingTable.addPeer(peer)
            this.cfg.onPeerDiscovered(peer)
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
    // Try to find a wire client connected to this peer.
    // Issue #70: lookup is case-insensitive — wireClientByPeerId now uses
    // lowercased keys at insert (see index.ts), so DHT-sourced peer IDs
    // (lowercase) hit. Fall back to a wireClients scan with the same
    // case-folding for robustness.
    const wantLower = peer.id.toLowerCase()
    const client = this.cfg.wireClientByPeerId?.get(wantLower)
      ?? this.cfg.wireClients.find((c) => {
        if (!c.isConnected()) return false
        const remote = c.getRemoteNodeId()
        return remote ? remote.toLowerCase() === wantLower : false
      })

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

    if (this.cfg.requireAuthenticatedVerify !== false) {
      this.verifyFailures += 1
      log.warn("DHT handshake verification unavailable; rejecting peer by policy", {
        peer: peer.id,
        address: peer.address,
      })
      return false
    }

    // Fallback: lightweight TCP connect probe when handshake config is unavailable.
    this.verifyFallbackTcpAttempts += 1
    const parsed = parseHostPort(peer.address)
    if (!parsed) {
      this.verifyFailures += 1
      this.verifyFallbackTcpFailures += 1
      return false
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy()
        this.verifyFailures += 1
        this.verifyFallbackTcpFailures += 1
        resolve(false)
      }, PEER_VERIFY_TIMEOUT_MS)

      const socket = net.createConnection({ host: parsed.host, port: parsed.port }, () => {
        clearTimeout(timer)
        socket.destroy()
        this.verifySuccess += 1
        resolve(true)
      })

      socket.on("error", () => {
        clearTimeout(timer)
        socket.destroy() // Ensure socket is cleaned up on connection error
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

    const hp = parseHostPort(peer.address)
    if (!hp) return false

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
        host: hp.host,
        port: hp.port,
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
      try {
        probe = this.cfg.wireProbeFactory
          ? this.cfg.wireProbeFactory(probeCfg)
          : new WireClient(probeCfg)
        probe.connect()
      } catch {
        settle(false)
      }
    })
  }

  /** Query a peer for nodes closest to a target */
  private async findNode(peer: DhtPeer, targetId: string): Promise<DhtPeer[]> {
    // Priority 1: lookup by peer ID in the direct map (O(1)).
    // Issue #70: case-insensitive — keys in wireClientByPeerId are lowercased
    // at insert (see index.ts) so a lowercase peer.id from the routing
    // table hits. We also try the as-is case for unit tests that key the
    // map directly with whatever the caller chose.
    const mappedClient = this.cfg.wireClientByPeerId?.get(peer.id.toLowerCase())
      ?? this.cfg.wireClientByPeerId?.get(peer.id)
    if (mappedClient && mappedClient.isConnected()) {
      const remotePeers = await mappedClient.findNode(targetId, LOOKUP_TIMEOUT_MS)
      return remotePeers.map((p) => ({
        id: p.id,
        address: p.address,
        lastSeenMs: Date.now(),
      }))
    }

    // Priority 2: scan wireClients by remoteNodeId (backward compat, limited scan)
    // Cap the scan to first 20 clients to avoid O(n) on large peer sets.
    // Issue #70: case-insensitive — peer.id is lowercase from the routing
    // table, getRemoteNodeId() is mixed-case from the wire handshake.
    const wantLower = peer.id.toLowerCase()
    const scanLimit = Math.min(this.cfg.wireClients.length, 20)
    for (let i = 0; i < scanLimit; i++) {
      const c = this.cfg.wireClients[i]
      const remote = c.getRemoteNodeId()
      if (c.isConnected() && remote && remote.toLowerCase() === wantLower) {
        const remotePeers = await c.findNode(targetId, LOOKUP_TIMEOUT_MS)
        return remotePeers.map((p) => ({
          id: p.id,
          address: p.address,
          lastSeenMs: Date.now(),
        }))
      }
    }

    // Fallback: return peers from local routing table
    return this.routingTable.findClosest(targetId, ALPHA)
  }

  /** Refresh the routing table by performing random lookups */
  private async refresh(): Promise<void> {
    if (this.stopped) return

    // Generate a cryptographically secure random target for lookup.
    // Math.random() is predictable; an attacker could anticipate which DHT
    // bucket is refreshed and pre-position sybil nodes in that region.
    const randomBytes = nodeCrypto.randomBytes(32)
    const randomId = "0x" + Array.from(randomBytes).map((b) => b.toString(16).padStart(2, "0")).join("")

    log.debug("DHT refresh lookup", { tableSize: this.routingTable.size() })
    await this.iterativeLookup(randomId)

    // Sweep expired provider records in the same tick as the routing-table
    // refresh so we don't need a separate timer. 5-min cadence is fine: a
    // stale provider stays queryable for up to 5 min past its expiry, but
    // callers treat missing `found:true` responses as "try next provider"
    // anyway, so there's no correctness cost.
    this.removeExpiredProviders()
  }

  /**
   * Record that `peerId` holds `cid` for up to `ttlMs` from now.
   *
   * Called by the local node after a successful `IpfsBlockstore.put` to
   * self-announce, and by peers via wire `FindProviders` messages (added
   * in a later commit — for now, peers only learn about their own CIDs).
   *
   * If `peerId` already advertises `cid`, the expiry is bumped — acts as
   * a renewal. Provider count per CID is capped at `MAX_PROVIDERS_PER_CID`
   * to bound memory under sybil / flood attempts; when over the cap we
   * evict the soonest-to-expire entry to make room.
   */
  putProvider(cid: string, peerId: string, ttlMs: number = DEFAULT_PROVIDER_TTL_MS): void {
    if (this.stopped) return
    if (ttlMs <= 0) return
    const cidKey = cid.toLowerCase()
    const peerKey = peerId.toLowerCase()
    let providers = this.providerRecords.get(cidKey)
    if (!providers) {
      providers = new Map()
      this.providerRecords.set(cidKey, providers)
    }
    const expiresAt = Date.now() + ttlMs
    if (!providers.has(peerKey) && providers.size >= MAX_PROVIDERS_PER_CID) {
      // Evict the soonest-to-expire entry. Cheap linear scan is fine here —
      // capacity ceiling is 64 and puts are infrequent.
      let evictPeer: string | null = null
      let evictExpiry = Number.MAX_SAFE_INTEGER
      for (const [p, e] of providers) {
        if (e < evictExpiry) { evictExpiry = e; evictPeer = p }
      }
      if (evictPeer) providers.delete(evictPeer)
    }
    providers.set(peerKey, expiresAt)
    this.providersPut++
  }

  /**
   * Return up to `maxK` peer ids that currently claim to hold `cid`.
   *
   * Expired entries are dropped lazily during the query so callers never
   * see stale providers even if `removeExpiredProviders` hasn't fired yet.
   * Order preserved from the underlying map (insertion order) — for
   * locality the caller should shuffle or re-sort as desired; distance-
   * aware routing is deferred to a later commit since the current usage
   * (try one, fall through on miss) is robust to order.
   */
  findProviders(cid: string, maxK: number = 3): string[] {
    const cidKey = cid.toLowerCase()
    const providers = this.providerRecords.get(cidKey)
    if (!providers) return []
    const now = Date.now()
    const live: string[] = []
    const stale: string[] = []
    for (const [peerId, expiresAt] of providers) {
      if (expiresAt <= now) {
        stale.push(peerId)
        continue
      }
      live.push(peerId)
      if (live.length >= maxK) break
    }
    // Clean up stale entries we found so the map doesn't grow unbounded
    // between refresh() ticks — cheap because we already iterated past them.
    if (stale.length > 0) {
      for (const s of stale) providers.delete(s)
      if (providers.size === 0) this.providerRecords.delete(cidKey)
      this.providersExpired += stale.length
    }
    return live
  }

  /**
   * Drop provider entries whose expiry is past `now`. Returns the count
   * removed. Called by the periodic `refresh()` tick; safe to call
   * manually in tests via a shortened TTL to exercise expiry.
   */
  removeExpiredProviders(): number {
    const now = Date.now()
    let removed = 0
    for (const [cidKey, providers] of this.providerRecords) {
      for (const [peerId, expiresAt] of providers) {
        if (expiresAt <= now) {
          providers.delete(peerId)
          removed++
        }
      }
      if (providers.size === 0) this.providerRecords.delete(cidKey)
    }
    this.providersExpired += removed
    return removed
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
      // Atomic write: write to temp file then rename to prevent corruption on crash
      const tmpPath = this.cfg.peerStorePath + ".tmp"
      fs.writeFileSync(tmpPath, JSON.stringify(peers, null, 2))
      fs.renameSync(tmpPath, this.cfg.peerStorePath)
      log.info("DHT peers saved", { count: peers.length, path: this.cfg.peerStorePath })
      return peers.length
    } catch (err) {
      log.warn("failed to save DHT peers", { error: String(err) })
      return 0
    }
  }

  /**
   * Persist provider records to disk. Only entries whose expiry is in the
   * future are written — stale entries are dropped on save to keep the
   * file bounded. Atomic via temp + rename, mirroring savePeers().
   * Returns total entry count written (sum across all CIDs).
   */
  saveProviders(): number {
    if (!this.cfg.providerStorePath) return 0
    const now = Date.now()
    const records: Array<{ cid: string; peerId: string; expiresAt: number }> = []
    for (const [cid, providers] of this.providerRecords) {
      for (const [peerId, expiresAt] of providers) {
        if (expiresAt > now) {
          records.push({ cid, peerId, expiresAt })
        }
      }
    }
    try {
      const dir = path.dirname(this.cfg.providerStorePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const tmpPath = this.cfg.providerStorePath + ".tmp"
      fs.writeFileSync(tmpPath, JSON.stringify(records))
      fs.renameSync(tmpPath, this.cfg.providerStorePath)
      log.info("DHT providers saved", { entries: records.length, cids: this.providerRecords.size, path: this.cfg.providerStorePath })
      return records.length
    } catch (err) {
      log.warn("failed to save DHT providers", { error: String(err) })
      return 0
    }
  }

  /**
   * Load provider records from disk into memory. Entries whose expiry has
   * already passed are silently dropped. Records share the same TTL/eviction
   * semantics as `putProvider()`, so reloading a snapshot is safe even if
   * the cap (`MAX_PROVIDERS_PER_CID`) was exceeded between writes —
   * `putProvider`'s eviction logic kicks in on next put for the affected CID.
   * Returns number of live entries loaded.
   */
  loadProviders(): number {
    if (!this.cfg.providerStorePath) return 0
    try {
      if (!fs.existsSync(this.cfg.providerStorePath)) return 0
      const data = fs.readFileSync(this.cfg.providerStorePath, "utf-8")
      const records = JSON.parse(data) as unknown
      if (!Array.isArray(records)) return 0
      const now = Date.now()
      let loaded = 0
      let stale = 0
      for (const entry of records) {
        if (!entry || typeof entry !== "object") continue
        const r = entry as { cid?: unknown; peerId?: unknown; expiresAt?: unknown }
        if (typeof r.cid !== "string" || typeof r.peerId !== "string" || typeof r.expiresAt !== "number") continue
        if (r.expiresAt <= now) { stale++; continue }
        const cidKey = r.cid.toLowerCase()
        const peerKey = r.peerId.toLowerCase()
        let providers = this.providerRecords.get(cidKey)
        if (!providers) {
          providers = new Map()
          this.providerRecords.set(cidKey, providers)
        }
        providers.set(peerKey, r.expiresAt)
        loaded++
      }
      log.info("DHT providers loaded", { entries: loaded, stale, cids: this.providerRecords.size, path: this.cfg.providerStorePath })
      return loaded
    } catch (err) {
      log.warn("failed to load DHT providers", { error: String(err) })
      return 0
    }
  }

  /**
   * Load routing table peers from disk.
   * Returns number of peers loaded.
   */
  async loadPeers(): Promise<number> {
    if (!this.cfg.peerStorePath) return 0

    try {
      if (!fs.existsSync(this.cfg.peerStorePath)) return 0
      const data = fs.readFileSync(this.cfg.peerStorePath, "utf-8")
      const peers = JSON.parse(data) as Array<{ id: string; address: string; lastSeenMs?: number }>

      if (!Array.isArray(peers)) return 0
      // Validate peer entries: must have non-empty id and address strings
      const valid = peers.filter((p) =>
        p && typeof p.id === "string" && p.id.length > 0
        && typeof p.address === "string" && p.address.length > 0
      )
      // Filter out stale peers (not seen in 24h)
      const now = Date.now()
      const fresh = valid.filter((p) => {
        if (!p.lastSeenMs) return true // unknown age — keep
        return (now - p.lastSeenMs) < STALE_PEER_THRESHOLD_MS
      })
      const added = await this.routingTable.importPeers(fresh)
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
    providerCidsTracked: number
    providerEntriesTotal: number
    providersPut: number
    providersExpired: number
  } {
    let providerEntriesTotal = 0
    for (const providers of this.providerRecords.values()) {
      providerEntriesTotal += providers.size
    }
    return {
      ...this.routingTable.stats(),
      verifyAttempts: this.verifyAttempts,
      verifySuccess: this.verifySuccess,
      verifyFailures: this.verifyFailures,
      verifyFallbackTcpAttempts: this.verifyFallbackTcpAttempts,
      verifyFallbackTcpFailures: this.verifyFallbackTcpFailures,
      providerCidsTracked: this.providerRecords.size,
      providerEntriesTotal,
      providersPut: this.providersPut,
      providersExpired: this.providersExpired,
    }
  }
}

function isValidNodeId(id: string): boolean {
  if (!id.startsWith("0x")) return false
  if (id.length < 3 || id.length > 66) return false
  return /^[0-9a-f]+$/i.test(id.slice(2))
}
