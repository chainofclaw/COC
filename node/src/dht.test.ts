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
