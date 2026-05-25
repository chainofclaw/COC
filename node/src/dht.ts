/**
 * Kademlia DHT Routing Table
 *
 * Implements XOR-distance-based peer routing with K-buckets.
 * Each bucket holds up to K peers at a specific distance range.
 */

import { isIP } from "node:net"
import { createLogger } from "./logger.ts"

const log = createLogger("dht")

export const K = 20 // max peers per bucket
export const ID_BITS = 256 // keccak256 produces 256-bit IDs
export const ALPHA = 3 // parallel lookups
export const MAX_PEERS_PER_IP_PER_BUCKET = 2 // Sybil protection: max nodes per IP per K-bucket
export const MAX_PEERS_PER_IP_GLOBAL = 10 // Sybil protection: max nodes per IP across all buckets

export interface DhtPeer {
  id: string // hex-encoded node ID
  address: string // host:port
  lastSeenMs: number
}

export interface KBucket {
  peers: DhtPeer[]
}

/**
 * Compute XOR distance between two hex node IDs.
 * Returns a BigInt representing the distance.
 */
export function xorDistance(a: string, b: string): bigint {
  const aBuf = hexToBytes(a)
  const bBuf = hexToBytes(b)
  const len = Math.max(aBuf.length, bBuf.length)
  // Left-pad shorter buffer with zeros so both are aligned at the MSB end
  const aOff = len - aBuf.length
  const bOff = len - bBuf.length
  let result = 0n

  for (let i = 0; i < len; i++) {
    const aByte = i >= aOff ? aBuf[i - aOff] : 0
    const bByte = i >= bOff ? bBuf[i - bOff] : 0
    result = (result << 8n) | BigInt(aByte ^ bByte)
  }

  return result
}

/**
 * Determine which bucket index a peer should be placed in.
 * Based on the position of the highest set bit in the XOR distance.
 */
export function bucketIndex(localId: string, remoteId: string): number {
  const dist = xorDistance(localId, remoteId)
  if (dist === 0n) return 0

  // Find highest bit position
  let bits = 0
  let val = dist
  while (val > 0n) {
    bits++
    val >>= 1n
  }
  return bits - 1
}

/**
 * Sort peers by XOR distance to a target ID.
 */
export function sortByDistance(target: string, peers: DhtPeer[]): DhtPeer[] {
  return [...peers].sort((a, b) => {
    const distA = xorDistance(target, a.id)
    const distB = xorDistance(target, b.id)
    if (distA < distB) return -1
    if (distA > distB) return 1
    return 0
  })
}

/**
 * Kademlia routing table with K-buckets.
 */
export class RoutingTable {
  readonly localId: string
  private readonly buckets: KBucket[]
  private readonly pingPeer: ((peer: DhtPeer) => Promise<boolean>) | null
  // Pre-computed global IP count index for O(1) Sybil checks (avoids O(n²) full scan)
  private readonly globalIpCount = new Map<string, number>()
  /**
   * #13 (audit follow-up): resolver for the *observed* source IP of a
   * given nodeId — the IP a verified inbound wire handshake came from,
   * supplied by `WireServer.observedIpForNodeId`. When attached, the
   * per-IP Sybil cap (`MAX_PEERS_PER_IP_*`) prefers this over the
   * peer-self-reported `peer.address`. Without it, an attacker who
   * connects from one real IP but advertises N different addresses can
   * occupy N bucket slots that look distinct to the cap.
   *
   * Returns null when:
   *   - the wire server has no verifier (we can't trust the link
   *     between nodeId and IP), OR
   *   - we've never had a verified handshake from that nodeId (e.g.
   *     learned via DHT gossip, not a direct connection).
   * Falls back to the advertised host in either case.
   */
  private readonly observedIpResolver: ((nodeId: string) => string | null) | null

  constructor(localId: string, opts?: {
    pingPeer?: (peer: DhtPeer) => Promise<boolean>
    observedIpResolver?: (nodeId: string) => string | null
  }) {
    this.localId = localId
    this.buckets = Array.from({ length: ID_BITS }, () => ({ peers: [] }))
    this.pingPeer = opts?.pingPeer ?? null
    this.observedIpResolver = opts?.observedIpResolver ?? null
  }

  /**
   * #13: attach the wire-server observed-IP resolver post-construction.
   * The routing table is built before the wire server is wired up in
   * `coc-ipfs-wiring.ts`; this hook lets the wiring inject the resolver
   * once both are alive, mirroring `setAwaitReplicationResult` and the
   * other post-construction injection sites in `IpfsHttpServer`.
   */
  setObservedIpResolver(resolver: (nodeId: string) => string | null): void {
    ;(this as { observedIpResolver: ((nodeId: string) => string | null) | null }).observedIpResolver = resolver
  }

  /**
   * #13: resolve a peer's effective host for Sybil-cap purposes —
   * observed IP wins when known (it's the cryptographically attested
   * source), else fall back to whatever the peer advertised.
   */
  private effectiveHost(peer: DhtPeer): string {
    const observed = this.observedIpResolver?.(peer.id) ?? null
    return normalizeHostForBucket(observed ?? extractHost(peer.address))
  }

  /**
   * Add or update a peer in the routing table.
   * When the bucket is full and a pingPeer callback is configured,
   * pings the oldest peer and evicts it if unreachable.
   * Returns true if the peer was added/updated.
   */
  async addPeer(peer: DhtPeer): Promise<boolean> {
    if (peer.id === this.localId) return false
    // Validate ID format: must be non-empty hex string (with optional 0x prefix)
    if (!peer.id || peer.id.length < 3) return false
    const cleanId = peer.id.startsWith("0x") ? peer.id.slice(2) : peer.id
    if (cleanId.length === 0 || !/^[0-9a-fA-F]+$/.test(cleanId)) return false

    const idx = bucketIndex(this.localId, peer.id)
    const bucket = this.buckets[idx]
    // #13: prefer the observed source IP when the wire server has
    // cryptographically attested it. Falls back to the peer's
    // self-reported `address` when no verified handshake has happened.
    const peerHost = this.effectiveHost(peer)

    // Check if peer already exists
    const existing = bucket.peers.findIndex((p) => p.id === peer.id)
    if (existing >= 0) {
      // Move to tail (most recently seen); update global IP count if address changed
      const oldPeer = bucket.peers[existing]
      const oldHost = this.effectiveHost(oldPeer)
      // #729: when the address normalises to a different host, re-validate
      // the per-IP Sybil caps against the new host BEFORE swapping. Without
      // this gate, an attacker who established N peers across N distinct
      // IPs could reconnect each from a single funnel address, every
      // update succeeding and globalIpCount[target] piling up past the
      // MAX_PEERS_PER_IP_GLOBAL cap (and same for the per-bucket cap) —
      // a standard precursor to eclipse attacks.
      if (oldHost !== peerHost && !isLoopbackHost(peerHost)) {
        let sameHostInBucket = 0
        for (let i = 0; i < bucket.peers.length; i++) {
          if (i === existing) continue // exclude the entry we'd be updating
          const h = this.effectiveHost(bucket.peers[i])
          if (h === peerHost) sameHostInBucket++
        }
        if (sameHostInBucket >= MAX_PEERS_PER_IP_PER_BUCKET) {
          log.debug("update rejected: per-IP bucket limit at target host", {
            ip: peerHost, bucket: idx, peerId: peer.id,
          })
          // Still bump lastSeenMs for the existing entry — only the address
          // swap is denied. Move to tail with the OLD address so refresh
          // ordering remains accurate.
          bucket.peers.splice(existing, 1)
          bucket.peers.push({ ...oldPeer, lastSeenMs: Date.now() })
          return false
        }
        const targetGlobalCount = this.globalIpCount.get(peerHost) ?? 0
        if (targetGlobalCount >= MAX_PEERS_PER_IP_GLOBAL) {
          log.debug("update rejected: global per-IP limit at target host", {
            ip: peerHost, peerId: peer.id,
          })
          bucket.peers.splice(existing, 1)
          bucket.peers.push({ ...oldPeer, lastSeenMs: Date.now() })
          return false
        }
      }
      bucket.peers.splice(existing, 1)
      bucket.peers.push({ ...peer, lastSeenMs: Date.now() })
      if (oldHost !== peerHost) {
        this.decrementGlobalIpCount(oldHost)
        this.incrementGlobalIpCount(peerHost)
      }
      return true
    }

    // Sybil protection: limit peers from the same IP within this bucket (skip loopback)
    if (!isLoopbackHost(peerHost)) {
      let sameHostInBucket = 0
      for (const p of bucket.peers) {
        const existingHost = this.effectiveHost(p)
        if (existingHost === peerHost) sameHostInBucket++
      }
      if (sameHostInBucket >= MAX_PEERS_PER_IP_PER_BUCKET) {
        log.debug("per-IP bucket limit reached, dropping peer", { ip: peerHost, bucket: idx, peerId: peer.id })
        return false
      }
      // Global per-IP limit across all buckets to prevent eclipse attacks
      // Uses pre-computed index for O(1) lookup instead of O(n) full scan
      const globalIpCount = this.globalIpCount.get(peerHost) ?? 0
      if (globalIpCount >= MAX_PEERS_PER_IP_GLOBAL) {
        log.debug("global per-IP limit reached, dropping peer", { ip: peerHost, peerId: peer.id })
        return false
      }
    }

    // Bucket not full, add at tail
    if (bucket.peers.length < K) {
      bucket.peers.push({ ...peer, lastSeenMs: Date.now() })
      this.incrementGlobalIpCount(peerHost)
      return true
    }

    // Bucket full — ping the oldest peer if callback is available
    if (this.pingPeer) {
      const oldest = bucket.peers[0]
      const oldestId = oldest.id
      const alive = await this.pingPeer(oldest)
      // Re-locate oldest by ID after async ping (bucket may have changed during await)
      const pos = bucket.peers.findIndex((p) => p.id === oldestId)
      // Re-check bucket size — concurrent addPeer calls may have changed it
      if (pos < 0) {
        // Oldest was removed during ping — bucket may have space now
        if (bucket.peers.length < K) {
          bucket.peers.push({ ...peer, lastSeenMs: Date.now() })
          this.incrementGlobalIpCount(peerHost)
          return true
        }
      } else if (!alive) {
        // Evict unreachable peer, add new peer at tail (only if bucket won't exceed K)
        const evictedHost = this.effectiveHost(bucket.peers[pos])
        bucket.peers.splice(pos, 1)
        this.decrementGlobalIpCount(evictedHost)
        if (bucket.peers.length < K) {
          bucket.peers.push({ ...peer, lastSeenMs: Date.now() })
          this.incrementGlobalIpCount(peerHost)
          log.debug("bucket full, evicted unreachable peer", { idx, evicted: oldestId, added: peer.id })
          return true
        }
      } else {
        // Oldest peer responded — move it to tail, reject new peer
        bucket.peers.splice(pos, 1)
        bucket.peers.push({ ...oldest, lastSeenMs: Date.now() })
      }
    }

    log.debug("bucket full, dropping peer", { idx, peerId: peer.id })
    return false
  }

  /**
   * Remove a peer from the routing table.
   */
  removePeer(peerId: string): boolean {
    const idx = bucketIndex(this.localId, peerId)
    const bucket = this.buckets[idx]
    const pos = bucket.peers.findIndex((p) => p.id === peerId)
    if (pos >= 0) {
      const removedHost = this.effectiveHost(bucket.peers[pos])
      bucket.peers.splice(pos, 1)
      this.decrementGlobalIpCount(removedHost)
      return true
    }
    return false
  }

  /**
   * Find the K closest peers to a target ID.
   */
  findClosest(targetId: string, count: number = K): DhtPeer[] {
    const all = this.allPeers()
    return sortByDistance(targetId, all).slice(0, count)
  }

  /**
   * Get a peer by ID.
   */
  getPeer(peerId: string): DhtPeer | null {
    const idx = bucketIndex(this.localId, peerId)
    return this.buckets[idx].peers.find((p) => p.id === peerId) ?? null
  }

  /**
   * Get all peers in the routing table.
   */
  allPeers(): DhtPeer[] {
    const result: DhtPeer[] = []
    for (const bucket of this.buckets) {
      result.push(...bucket.peers)
    }
    return result
  }

  /**
   * Get the total number of peers.
   */
  size(): number {
    let count = 0
    for (const bucket of this.buckets) {
      count += bucket.peers.length
    }
    return count
  }

  /**
   * Export routing table to a JSON-serializable structure for persistence.
   */
  exportPeers(): Array<{ id: string; address: string; lastSeenMs: number }> {
    return this.allPeers().map((p) => ({
      id: p.id,
      address: p.address,
      lastSeenMs: p.lastSeenMs,
    }))
  }

  /**
   * Import peers from a previously exported list.
   * Returns number of peers successfully added.
   */
  async importPeers(peers: Array<{ id: string; address: string; lastSeenMs?: number }>): Promise<number> {
    let added = 0
    for (const p of peers) {
      // Validate ID format (must be 0x-prefixed hex, reasonable length)
      if (typeof p.id !== "string" || !p.id.startsWith("0x") || p.id.length < 3 || p.id.length > 66) continue
      if (!/^[0-9a-fA-F]+$/.test(p.id.slice(2))) continue
      // Validate address is parseable as host:port
      if (typeof p.address !== "string" || !parseHostPort(p.address)) continue
      // Validate timestamp is not far-future (1 minute tolerance)
      const lastSeenMs = p.lastSeenMs ?? Date.now()
      if (lastSeenMs < 0 || lastSeenMs > Date.now() + 60_000) continue
      const ok = await this.addPeer({
        id: p.id,
        address: p.address,
        lastSeenMs,
      })
      if (ok) added++
    }
    return added
  }

  private incrementGlobalIpCount(host: string): void {
    this.globalIpCount.set(host, (this.globalIpCount.get(host) ?? 0) + 1)
  }

  private decrementGlobalIpCount(host: string): void {
    const count = (this.globalIpCount.get(host) ?? 1) - 1
    if (count <= 0) {
      this.globalIpCount.delete(host)
    } else {
      this.globalIpCount.set(host, count)
    }
  }

  /**
   * Get bucket occupancy stats.
   */
  stats(): { totalPeers: number; nonEmptyBuckets: number; maxBucketSize: number } {
    let totalPeers = 0
    let nonEmptyBuckets = 0
    let maxBucketSize = 0

    for (const bucket of this.buckets) {
      totalPeers += bucket.peers.length
      if (bucket.peers.length > 0) nonEmptyBuckets++
      if (bucket.peers.length > maxBucketSize) maxBucketSize = bucket.peers.length
    }

    return { totalPeers, nonEmptyBuckets, maxBucketSize }
  }
}

/**
 * Extract host from address string, handling both IPv4 (host:port) and IPv6 ([host]:port).
 */
export function extractHost(address: string): string {
  if (address.startsWith("[")) {
    const closeBracket = address.indexOf("]")
    if (closeBracket > 0) return address.slice(1, closeBracket)
  }
  const lastColon = address.lastIndexOf(":")
  if (lastColon <= 0) return address
  // If there are multiple colons and no brackets, it's a bare IPv6 address
  const firstColon = address.indexOf(":")
  if (firstColon !== lastColon) return address
  return address.slice(0, lastColon)
}

/**
 * Parse host:port string into { host, port }, handling IPv6 bracket notation.
 * Returns null if the address cannot be parsed.
 */
export function parseHostPort(address: string): { host: string; port: number } | null {
  let host: string
  let portStr: string
  if (address.startsWith("[")) {
    // IPv6 bracket notation: [host]:port
    const closeBracket = address.indexOf("]")
    if (closeBracket < 0) return null
    host = address.slice(1, closeBracket)
    if (address[closeBracket + 1] !== ":") return null
    portStr = address.slice(closeBracket + 2)
  } else {
    const lastColon = address.lastIndexOf(":")
    const firstColon = address.indexOf(":")
    if (lastColon <= 0) return null
    // Multiple colons without brackets = bare IPv6 without port
    if (firstColon !== lastColon) return null
    host = address.slice(0, lastColon)
    portStr = address.slice(lastColon + 1)
  }
  const port = parseInt(portStr, 10)
  if (!host || isNaN(port) || port <= 0 || port > 65535) return null
  // Reject trailing non-numeric chars (parseInt is lenient: "8080abc" → 8080)
  if (portStr !== String(port)) return null
  return { host, port }
}

function normalizeHostForBucket(host: string): string {
  let normalized = host.trim().toLowerCase()
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1)
  }

  // Canonicalize IPv4-mapped IPv6 so 192.0.2.1 and ::ffff:192.0.2.1 count as same host.
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length)
    if (isIP(mapped) === 4) {
      return mapped
    }
  }

  // DNS hostnames (non-IP addresses) bypass per-IP Sybil protection because each
  // hostname gets its own quota. Map all non-IP hostnames to a single sentinel
  // so they share a unified quota, preventing DNS-based Sybil attacks.
  if (isIP(normalized) === 0 && normalized !== "localhost") {
    return "__dns_hostname__"
  }

  return normalized
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true
  if (host.startsWith("127.")) return true
  if (host.startsWith("::ffff:127.")) return true
  return false
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  if (clean.length > 0 && !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("hexToBytes: invalid hex characters")
  }
  const padded = clean.length % 2 ? "0" + clean : clean
  const bytes = new Uint8Array(padded.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
