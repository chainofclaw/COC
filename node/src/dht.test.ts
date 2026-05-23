import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  xorDistance,
  bucketIndex,
  sortByDistance,
  RoutingTable,
  K,
} from "./dht.ts"
import type { DhtPeer } from "./dht.ts"

function makePeer(id: string, addr?: string): DhtPeer {
  return { id, address: addr ?? `127.0.0.1:${Math.floor(Math.random() * 65535)}`, lastSeenMs: Date.now() }
}

describe("xorDistance", () => {
  it("returns 0 for identical IDs", () => {
    assert.equal(xorDistance("0xff", "0xff"), 0n)
  })

  it("computes correct distance", () => {
    // 0xff ^ 0x00 = 0xff = 255
    assert.equal(xorDistance("0xff", "0x00"), 255n)
  })

  it("is symmetric", () => {
    const a = "0xabcd"
    const b = "0x1234"
    assert.equal(xorDistance(a, b), xorDistance(b, a))
  })

  it("handles equal length IDs", () => {
    // Same-length IDs (typical case — all node IDs are 32 bytes)
    assert.equal(xorDistance("0xab", "0xab"), 0n)
    // 0xab ^ 0xcd = 0x66 = 102
    assert.equal(xorDistance("0xab", "0xcd"), 102n)
  })

  it("works with 256-bit IDs", () => {
    const a = "0x" + "ff".repeat(32)
    const b = "0x" + "00".repeat(32)
    const expected = (1n << 256n) - 1n
    assert.equal(xorDistance(a, b), expected)
  })
})

describe("bucketIndex", () => {
  it("returns 0 for distance 1", () => {
    // IDs that differ in only the last bit
    assert.equal(bucketIndex("0x02", "0x03"), 0)
  })

  it("returns higher index for greater distance", () => {
    // 0x01 ^ 0x80 = 0x81 = 129 -> highest bit is bit 7
    const idx = bucketIndex("0x01", "0x80")
    assert.equal(idx, 7)
  })

  it("handles 256-bit IDs", () => {
    const local = "0x" + "00".repeat(32)
    const remote = "0x80" + "00".repeat(31)
    // Distance highest bit is at position 255
    assert.equal(bucketIndex(local, remote), 255)
  })
})

describe("sortByDistance", () => {
  it("sorts peers closest first", () => {
    const target = "0x10"
    const peers = [
      makePeer("0xff"),
      makePeer("0x11"),
      makePeer("0x12"),
    ]
    const sorted = sortByDistance(target, peers)
    assert.equal(sorted[0].id, "0x11") // dist 1
    assert.equal(sorted[1].id, "0x12") // dist 2
    assert.equal(sorted[2].id, "0xff") // dist 0xef
  })

  it("does not mutate original array", () => {
    const peers = [makePeer("0xff"), makePeer("0x01")]
    const original = [...peers]
    sortByDistance("0x00", peers)
    assert.deepEqual(peers.map((p) => p.id), original.map((p) => p.id))
  })
})

describe("RoutingTable", () => {
  it("starts empty", () => {
    const rt = new RoutingTable("0x01")
    assert.equal(rt.size(), 0)
    assert.deepEqual(rt.allPeers(), [])
  })

  it("adds a peer", async () => {
    const rt = new RoutingTable("0x01")
    const added = await rt.addPeer(makePeer("0x02"))
    assert.equal(added, true)
    assert.equal(rt.size(), 1)
  })

  it("rejects self as peer", async () => {
    const rt = new RoutingTable("0x01")
    const added = await rt.addPeer(makePeer("0x01"))
    assert.equal(added, false)
    assert.equal(rt.size(), 0)
  })

  it("updates existing peer (move to tail)", async () => {
    const rt = new RoutingTable("0x01")
    await rt.addPeer(makePeer("0x02"))
    await rt.addPeer(makePeer("0x03"))
    // Re-add 0x02
    await rt.addPeer(makePeer("0x02"))
    assert.equal(rt.size(), 2)
  })

  it("removes a peer", async () => {
    const rt = new RoutingTable("0x01")
    await rt.addPeer(makePeer("0x02"))
    assert.equal(rt.removePeer("0x02"), true)
    assert.equal(rt.size(), 0)
  })

  it("returns false for removing non-existent peer", () => {
    const rt = new RoutingTable("0x01")
    assert.equal(rt.removePeer("0x99"), false)
  })

  it("findClosest returns peers sorted by distance", async () => {
    const rt = new RoutingTable("0x00")
    await rt.addPeer(makePeer("0xff"))
    await rt.addPeer(makePeer("0x01"))
    await rt.addPeer(makePeer("0x10"))

    const closest = rt.findClosest("0x00", 2)
    assert.equal(closest.length, 2)
    assert.equal(closest[0].id, "0x01")
    assert.equal(closest[1].id, "0x10")
  })

  it("getPeer retrieves stored peer", async () => {
    const rt = new RoutingTable("0x01")
    await rt.addPeer(makePeer("0x02", "192.168.1.1:9000"))
    const peer = rt.getPeer("0x02")
    assert.ok(peer)
    assert.equal(peer.address, "192.168.1.1:9000")
  })

  it("getPeer returns null for unknown peer", () => {
    const rt = new RoutingTable("0x01")
    assert.equal(rt.getPeer("0x99"), null)
  })

  it("respects K bucket limit", async () => {
    const rt = new RoutingTable("0x" + "00".repeat(32))

    // Add K+5 peers that all fall into the same bucket
    // Use IDs that differ only in the high bit (same bucket index)
    let added = 0
    for (let i = 1; i <= K + 5; i++) {
      // All these peers have distance in the same high-bit range
      const id = "0x80" + i.toString(16).padStart(62, "0")
      if (await rt.addPeer(makePeer(id))) added++
    }

    assert.equal(added, K) // only K accepted
  })

  it("applies per-IP limit across IPv4 and mapped IPv6 aliases", async () => {
    const rt = new RoutingTable("0x" + "00".repeat(32))
    const ids = [1, 2, 3].map((n) => "0x80" + n.toString(16).padStart(62, "0"))

    const add1 = await rt.addPeer(makePeer(ids[0], "192.0.2.10:9001"))
    const add2 = await rt.addPeer(makePeer(ids[1], "[::ffff:192.0.2.10]:9002"))
    const add3 = await rt.addPeer(makePeer(ids[2], "192.0.2.10:9003"))

    assert.equal(add1, true)
    assert.equal(add2, true)
    assert.equal(add3, false, "third alias of same IP should hit per-IP bucket limit")
  })

  it("rejects address-update to a host that would exceed the per-IP global cap (#729)", async () => {
    // Pre-fix: addPeer's existing-id branch updated the address in-place and
    // re-balanced globalIpCount with no cap check. An attacker who'd
    // established N peers from N distinct IPs could reconnect each from a
    // single funnel IP, every update succeeding and globalIpCount[funnel]
    // piling up far past MAX_PEERS_PER_IP_GLOBAL = 10.
    const rt = new RoutingTable("0x" + "00".repeat(32))

    // Use bucket indices 255 down to 245 — distinct buckets, distinct
    // starting IPs, so the initial inserts all succeed.
    const N = 11
    const ids: string[] = []
    for (let i = 1; i <= N; i++) {
      // High byte 0x80 >> (i-1) keeps each ID in a unique high bucket.
      const bucket = i - 1
      const hi = (0x80 >> bucket).toString(16).padStart(2, "0")
      const id = "0x" + hi + i.toString(16).padStart(62, "0")
      ids.push(id)
      const ok = await rt.addPeer(makePeer(id, `192.0.2.${10 + i}:9000`))
      assert.equal(ok, true, `initial add for peer ${i} should succeed (distinct IPs)`)
    }
    assert.equal(rt.size(), N)

    // Funnel: update each peer's address to a single target IP. The first
    // 10 updates fill globalIpCount[target] up to the cap; the 11th must be
    // rejected so the funnel cannot eclipse the routing table.
    const target = "203.0.113.7:9100"
    let accepted = 0
    let rejected = 0
    for (let i = 0; i < N; i++) {
      const ok = await rt.addPeer({ id: ids[i], address: target, lastSeenMs: Date.now() })
      if (ok) accepted++
      else rejected++
    }
    assert.equal(accepted, 10, "first 10 updates fit under the per-IP global cap")
    assert.equal(rejected, 1, "11th update must be rejected to stop the eclipse funnel")

    // The 11th peer must still be in the table with its original address —
    // the rejected update only denies the address swap, not the entry.
    const eleventh = rt.getPeer(ids[N - 1])
    assert.ok(eleventh, "rejected peer must still exist in the table")
    assert.equal(eleventh.address, "192.0.2.21:9000", "rejected peer keeps original address")
  })

  it("evicts unreachable oldest peer via ping-evict", async () => {
    const rt = new RoutingTable("0x" + "00".repeat(32), {
      pingPeer: async () => false, // oldest peer always unreachable
    })

    // Fill a bucket to K
    for (let i = 1; i <= K; i++) {
      const id = "0x80" + i.toString(16).padStart(62, "0")
      await rt.addPeer(makePeer(id))
    }
    assert.equal(rt.size(), K)

    // Adding one more should evict the oldest (ping returns false)
    const newId = "0x80" + (K + 1).toString(16).padStart(62, "0")
    const added = await rt.addPeer(makePeer(newId))
    assert.equal(added, true)
    assert.equal(rt.size(), K) // still K, oldest was evicted

    // The new peer should be in the table
    assert.ok(rt.getPeer(newId))
    // The oldest peer should be evicted
    const oldestId = "0x80" + "1".padStart(62, "0")
    assert.equal(rt.getPeer(oldestId), null)
  })

  it("keeps reachable oldest peer and rejects new peer via ping-evict", async () => {
    const rt = new RoutingTable("0x" + "00".repeat(32), {
      pingPeer: async () => true, // oldest peer always reachable
    })

    // Fill a bucket to K
    for (let i = 1; i <= K; i++) {
      const id = "0x80" + i.toString(16).padStart(62, "0")
      await rt.addPeer(makePeer(id))
    }

    // Adding one more should fail (oldest is reachable)
    const newId = "0x80" + (K + 1).toString(16).padStart(62, "0")
    const added = await rt.addPeer(makePeer(newId))
    assert.equal(added, false)
    assert.equal(rt.size(), K)
    assert.equal(rt.getPeer(newId), null)
  })

  it("stats reports correct values", async () => {
    const rt = new RoutingTable("0x01")
    await rt.addPeer(makePeer("0x02"))
    await rt.addPeer(makePeer("0x03"))
    await rt.addPeer(makePeer("0xff"))

    const stats = rt.stats()
    assert.equal(stats.totalPeers, 3)
    assert.ok(stats.nonEmptyBuckets >= 1)
    assert.ok(stats.maxBucketSize >= 1)
  })

  it("handles many peers across different buckets", async () => {
    const rt = new RoutingTable("0x" + "00".repeat(32))

    // Add peers with different distance ranges
    const ids = [
      "0x01" + "00".repeat(31), // bucket 0
      "0x80" + "00".repeat(31), // bucket 255
      "0x40" + "00".repeat(31), // bucket 254
      "0x20" + "00".repeat(31), // bucket 253
      "0x10" + "00".repeat(31), // bucket 252
    ]

    for (const id of ids) {
      await rt.addPeer(makePeer(id))
    }

    assert.equal(rt.size(), 5)
    const stats = rt.stats()
    assert.equal(stats.nonEmptyBuckets, 5)
  })
})
