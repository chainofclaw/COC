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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const padded = clean.length % 2 ? "0" + clean : clean
  const bytes = new Uint8Array(padded.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
