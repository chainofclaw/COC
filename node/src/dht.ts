/**
 * Kademlia DHT Routing Table
 *
 * Implements XOR-distance-based peer routing with K-buckets.
 * Each bucket holds up to K peers at a specific distance range.
 */

import { createLogger } from "./logger.ts"

const log = createLogger("dht")

export const K = 20 // max peers per bucket
export const ID_BITS = 256 // keccak256 produces 256-bit IDs
export const ALPHA = 3 // parallel lookups
export const MAX_PEERS_PER_IP_PER_BUCKET = 2 // Sybil protection: max nodes per IP per K-bucket

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
  let result = 0n

  for (let i = 0; i < len; i++) {
    const aByte = i < aBuf.length ? aBuf[i] : 0
    const bByte = i < bBuf.length ? bBuf[i] : 0
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

  constructor(localId: string, opts?: { pingPeer?: (peer: DhtPeer) => Promise<boolean> }) {
    this.localId = localId
    this.buckets = Array.from({ length: ID_BITS }, () => ({ peers: [] }))
    this.pingPeer = opts?.pingPeer ?? null
  }

  /**
   * Add or update a peer in the routing table.
   * When the bucket is full and a pingPeer callback is configured,
   * pings the oldest peer and evicts it if unreachable.
   * Returns true if the peer was added/updated.
   */
  async addPeer(peer: DhtPeer): Promise<boolean> {
    if (peer.id === this.localId) return false

    const idx = bucketIndex(this.localId, peer.id)
    const bucket = this.buckets[idx]

    // Check if peer already exists
    const existing = bucket.peers.findIndex((p) => p.id === peer.id)
    if (existing >= 0) {
      // Move to tail (most recently seen)
      bucket.peers.splice(existing, 1)
      bucket.peers.push({ ...peer, lastSeenMs: Date.now() })
      return true
    }

    // Sybil protection: limit peers from the same IP within this bucket (skip loopback)
    const peerIp = extractHost(peer.address)
    if (!peerIp.startsWith("127.") && peerIp !== "::1" && peerIp !== "localhost") {
      let sameIpInBucket = 0
      for (const p of bucket.peers) {
        if (extractHost(p.address) === peerIp) sameIpInBucket++
      }
      if (sameIpInBucket >= MAX_PEERS_PER_IP_PER_BUCKET) {
        log.debug("per-IP bucket limit reached, dropping peer", { ip: peerIp, bucket: idx, peerId: peer.id })
        return false
      }
    }

    // Bucket not full, add at tail
    if (bucket.peers.length < K) {
      bucket.peers.push({ ...peer, lastSeenMs: Date.now() })
      return true
    }

    // Bucket full — ping the oldest peer if callback is available
    if (this.pingPeer) {
      const oldest = bucket.peers[0]
      const alive = await this.pingPeer(oldest)
      if (!alive) {
        // Evict unreachable oldest peer, add new peer at tail
        bucket.peers.shift()
        bucket.peers.push({ ...peer, lastSeenMs: Date.now() })
        log.debug("bucket full, evicted unreachable peer", { idx, evicted: oldest.id, added: peer.id })
        return true
      }
      // Oldest peer responded — move it to tail, reject new peer
      bucket.peers.shift()
      bucket.peers.push({ ...oldest, lastSeenMs: Date.now() })
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
      bucket.peers.splice(pos, 1)
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
      const ok = await this.addPeer({
        id: p.id,
        address: p.address,
        lastSeenMs: p.lastSeenMs ?? Date.now(),
      })
      if (ok) added++
    }
    return added
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
  return { host, port }
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
