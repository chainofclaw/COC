import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DhtNetwork } from "./dht-network.ts"
import type { DhtPeer } from "./dht.ts"
import type { WireClient } from "./wire-client.ts"

describe("DhtNetwork", () => {
  it("should add bootstrap peers to routing table", () => {
    const discovered: DhtPeer[] = []
    const network = new DhtNetwork({
      localId: "0xaaa",
      bootstrapPeers: [
        { id: "0xbbb", address: "192.168.1.1", port: 19781 },
        { id: "0xccc", address: "192.168.1.2", port: 19781 },
      ],
      wireClients: [],
      onPeerDiscovered: (peer) => discovered.push(peer),
    })

    network.start()

    const stats = network.getStats()
    assert.equal(stats.totalPeers, 2)

    network.stop()
  })

  it("should perform iterative lookup with local routing table", async () => {
    const discovered: DhtPeer[] = []
    const network = new DhtNetwork({
      localId: "0x0001",
      bootstrapPeers: [
        { id: "0x0010", address: "10.0.0.1", port: 19781 },
        { id: "0x0020", address: "10.0.0.2", port: 19781 },
        { id: "0x0030", address: "10.0.0.3", port: 19781 },
      ],
      wireClients: [],
      onPeerDiscovered: (peer) => discovered.push(peer),
    })

    network.start()

    // Perform a lookup for a target near one of the bootstrap peers
    const result = await network.iterativeLookup("0x0015")

    assert.ok(result.length > 0, "should find closest peers")
    // The closest peer to 0x0015 should be 0x0010 (XOR distance smallest)

    network.stop()
  })

  it("should bootstrap by looking up own ID", async () => {
    const network = new DhtNetwork({
      localId: "0xaaaa",
      bootstrapPeers: [
        { id: "0xbbbb", address: "10.0.0.1", port: 19781 },
      ],
      wireClients: [],
      onPeerDiscovered: () => {},
    })

    network.start()
    const result = await network.bootstrap()
    assert.ok(result.length > 0, "bootstrap should return closest peers")
    network.stop()
  })

  it("should return empty for lookup with no peers", async () => {
    const network = new DhtNetwork({
      localId: "0xaaaa",
      bootstrapPeers: [],
      wireClients: [],
      onPeerDiscovered: () => {},
    })

    const result = await network.iterativeLookup("0xbbbb")
    assert.equal(result.length, 0, "should return empty when no peers")
    network.stop()
  })

  it("should expose routing table stats", () => {
    const network = new DhtNetwork({
      localId: "0x01",
      bootstrapPeers: [
        { id: "0x10", address: "10.0.0.1", port: 19781 },
        { id: "0x20", address: "10.0.0.2", port: 19781 },
        { id: "0x30", address: "10.0.0.3", port: 19781 },
        { id: "0x40", address: "10.0.0.4", port: 19781 },
        { id: "0x50", address: "10.0.0.5", port: 19781 },
      ],
      wireClients: [],
      onPeerDiscovered: () => {},
    })

    network.start()

    const stats = network.getStats()
    assert.equal(stats.totalPeers, 5)
    assert.ok(stats.nonEmptyBuckets > 0)

    network.stop()
  })

  it("should not add self to routing table during lookup", async () => {
    const network = new DhtNetwork({
      localId: "0xaaaa",
      bootstrapPeers: [
        { id: "0xbbbb", address: "10.0.0.1", port: 19781 },
      ],
      wireClients: [],
      onPeerDiscovered: () => {},
    })

    await network.bootstrap()

    // Self should not be in routing table
    const peer = network.routingTable.getPeer("0xaaaa")
    assert.equal(peer, null, "self should not be in routing table")

    network.stop()
  })
})
