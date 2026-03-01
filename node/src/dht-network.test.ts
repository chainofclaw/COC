import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { DhtNetwork } from "./dht-network.ts"
import type { DhtPeer } from "./dht.ts"
import type { WireClient } from "./wire-client.ts"
import { createNodeSigner } from "./crypto/signer.ts"

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

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

  it("should save and load peers from disk", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dht-test-"))
    const storePath = path.join(tmpDir, "dht-peers.json")

    // Create network with bootstrap peers
    const net1 = new DhtNetwork({
      localId: "0xaaa",
      localAddress: "127.0.0.1:19780",
      bootstrapPeers: [
        { id: "0xbbb", address: "10.0.0.1", port: 19781 },
        { id: "0xccc", address: "10.0.0.2", port: 19782 },
      ],
      wireClients: [],
      onPeerDiscovered: () => {},
      peerStorePath: storePath,
    })
    net1.start()

    // Save peers
    const saved = net1.savePeers()
    assert.equal(saved, 2)
    assert.ok(fs.existsSync(storePath))
    net1.stop()

    // Create a new network and load saved peers
    const net2 = new DhtNetwork({
      localId: "0xaaa",
      localAddress: "127.0.0.1:19780",
      bootstrapPeers: [],
      wireClients: [],
      onPeerDiscovered: () => {},
      peerStorePath: storePath,
    })

    const loaded = await net2.loadPeers()
    assert.equal(loaded, 2)
    assert.equal(net2.getStats().totalPeers, 2)

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true })
  })

  it("should handle missing peer store gracefully", async () => {
    const net = new DhtNetwork({
      localId: "0xaaa",
      localAddress: "127.0.0.1:19780",
      bootstrapPeers: [],
      wireClients: [],
      onPeerDiscovered: () => {},
      peerStorePath: "/tmp/nonexistent-dht-path-12345/peers.json",
    })

    const loaded = await net.loadPeers()
    assert.equal(loaded, 0)
  })

  it("should return 0 when no peerStorePath configured", async () => {
    const net = new DhtNetwork({
      localId: "0xaaa",
      localAddress: "127.0.0.1:19780",
      bootstrapPeers: [{ id: "0xbbb", address: "10.0.0.1", port: 19781 }],
      wireClients: [],
      onPeerDiscovered: () => {},
    })
    net.start()
    assert.equal(net.savePeers(), 0)
    assert.equal(await net.loadPeers(), 0)
    net.stop()
  })

  it("should use wireClientByPeerId for findNode when available", async () => {
    let findNodeCalled = false
    const mockClient = {
      isConnected: () => true,
      findNode: async () => {
        findNodeCalled = true
        return [{ id: "0xddd", address: "10.0.0.4:19781" }]
      },
      getRemoteNodeId: () => "0xbbb",
    } as unknown as WireClient

    // Mock client for discovered peer 0xddd (so verifyPeer won't TCP probe)
    const mockClientDdd = {
      isConnected: () => true,
      findNode: async () => [],
      getRemoteNodeId: () => "0xddd",
    } as unknown as WireClient

    const wireClientByPeerId = new Map<string, WireClient>()
    wireClientByPeerId.set("0xbbb", mockClient)
    wireClientByPeerId.set("0xddd", mockClientDdd)

    const discovered: DhtPeer[] = []
    const network = new DhtNetwork({
      localId: "0xaaa",
      localAddress: "127.0.0.1:19780",
      bootstrapPeers: [{ id: "0xbbb", address: "10.0.0.1", port: 19781 }],
      wireClients: [],
      wireClientByPeerId,
      onPeerDiscovered: (peer) => discovered.push(peer),
    })

    network.start()
    await network.iterativeLookup("0xccc")
    network.stop()

    assert.ok(findNodeCalled, "should use wireClientByPeerId for FIND_NODE")
    assert.ok(discovered.length > 0, "should discover peers via wire client")
  })

  it("should ignore malformed peer IDs returned by FIND_NODE", async () => {
    const badAndGoodClient = {
      isConnected: () => true,
      findNode: async () => [
        { id: "bad-id", address: "10.0.0.9:19781" },
        { id: "0xddd", address: "10.0.0.4:19781" },
      ],
      getRemoteNodeId: () => "0xbbb",
    } as unknown as WireClient
    const goodPeerClient = {
      isConnected: () => true,
      findNode: async () => [],
      getRemoteNodeId: () => "0xddd",
    } as unknown as WireClient

    const wireClientByPeerId = new Map<string, WireClient>()
    wireClientByPeerId.set("0xbbb", badAndGoodClient)
    wireClientByPeerId.set("0xddd", goodPeerClient)

    const discovered: DhtPeer[] = []
    const network = new DhtNetwork({
      localId: "0xaaa",
      bootstrapPeers: [{ id: "0xbbb", address: "10.0.0.1", port: 19781 }],
      wireClients: [],
      wireClientByPeerId,
      onPeerDiscovered: (peer) => discovered.push(peer),
    })

    network.start()
    const result = await network.iterativeLookup("0xccc")
    network.stop()

    assert.ok(discovered.some((p) => p.id === "0xddd"), "valid peer should be discovered")
    assert.ok(!discovered.some((p) => p.id === "bad-id"), "invalid peer ID should be dropped")
    assert.ok(result.every((p) => /^0x[0-9a-f]+$/i.test(p.id)))
  })

  it("should not keep newly discovered peers that fail verification", async () => {
    const seedClient = {
      isConnected: () => true,
      findNode: async () => [
        { id: "0xddd", address: "10.0.0.9:19781" }, // unverifiable
        { id: "0xeee", address: "10.0.0.10:19781" }, // verifiable
      ],
      getRemoteNodeId: () => "0xbbb",
    } as unknown as WireClient

    const discovered: DhtPeer[] = []
    const network = new DhtNetwork({
      localId: "0xaaa",
      bootstrapPeers: [{ id: "0xbbb", address: "10.0.0.1", port: 19781 }],
      wireClients: [],
      wireClientByPeerId: new Map([["0xbbb", seedClient]]),
      onPeerDiscovered: (peer) => discovered.push(peer),
    })

    ;(network as any).verifyPeer = async (peer: DhtPeer) => peer.id === "0xeee"

    network.start()
    await network.iterativeLookup("0xccc")
    network.stop()

    assert.equal(network.routingTable.getPeer("0xddd"), null)
    assert.ok(network.routingTable.getPeer("0xeee"))
    assert.ok(!discovered.some((p) => p.id === "0xddd"))
    assert.ok(discovered.some((p) => p.id === "0xeee"))
  })

  it("should fall back to wireClients scan when wireClientByPeerId has no match", async () => {
    let scanCalled = false
    const mockClient = {
      isConnected: () => true,
      findNode: async () => {
        scanCalled = true
        return [{ id: "0xeee", address: "10.0.0.5:19781" }]
      },
      getRemoteNodeId: () => "0xbbb",
    } as unknown as WireClient

    // Mock client for discovered peer so verifyPeer skips TCP probe
    const mockClientEee = {
      isConnected: () => true,
      findNode: async () => [],
      getRemoteNodeId: () => "0xeee",
    } as unknown as WireClient

    const discovered: DhtPeer[] = []
    const network = new DhtNetwork({
      localId: "0xaaa",
      localAddress: "127.0.0.1:19780",
      bootstrapPeers: [{ id: "0xbbb", address: "10.0.0.1", port: 19781 }],
      wireClients: [mockClient, mockClientEee],
      wireClientByPeerId: new Map(), // empty map
      onPeerDiscovered: (peer) => discovered.push(peer),
    })

    network.start()
    await network.iterativeLookup("0xccc")
    network.stop()

    assert.ok(scanCalled, "should fall back to scanning wireClients")
  })

  it("should fall back to local routing table when no wire client available", async () => {
    const network = new DhtNetwork({
      localId: "0xaaa",
      localAddress: "127.0.0.1:19780",
      bootstrapPeers: [
        { id: "0xbbb", address: "10.0.0.1", port: 19781 },
        { id: "0xccc", address: "10.0.0.2", port: 19782 },
      ],
      wireClients: [],
      wireClientByPeerId: new Map(),
      onPeerDiscovered: () => {},
    })

    network.start()
    const result = await network.iterativeLookup("0xbbb")
    network.stop()

    assert.ok(result.length > 0, "should return peers from local routing table fallback")
  })

  it("should verify discovered peer via authenticated handshake probe", async () => {
    const signer = createNodeSigner(TEST_KEY)
    let probeCalled = false
    const network = new DhtNetwork({
      localId: signer.nodeId,
      localAddress: "127.0.0.1:19780",
      chainId: 18780,
      bootstrapPeers: [],
      wireClients: [],
      signer,
      verifier: signer,
      wireProbeFactory: (cfg) => {
        probeCalled = true
        return {
          connect() {
            cfg.onConnected?.()
          },
          disconnect() {},
          getRemoteNodeId() {
            return "0xbbb"
          },
        } as WireClient
      },
      onPeerDiscovered: () => {},
    })

    const ok = await network.verifyPeer({
      id: "0xbbb",
      address: "127.0.0.1:19781",
      lastSeenMs: Date.now(),
    })

    assert.equal(ok, true)
    assert.equal(probeCalled, true)
  })

  it("should reject handshake probe when claimed ID mismatches remote ID", async () => {
    const signer = createNodeSigner(TEST_KEY)
    const network = new DhtNetwork({
      localId: signer.nodeId,
      localAddress: "127.0.0.1:19780",
      chainId: 18780,
      bootstrapPeers: [],
      wireClients: [],
      signer,
      verifier: signer,
      wireProbeFactory: (cfg) => {
        return {
          connect() {
            cfg.onConnected?.()
          },
          disconnect() {},
          getRemoteNodeId() {
            return "0xccc"
          },
        } as WireClient
      },
      onPeerDiscovered: () => {},
    })

    const ok = await network.verifyPeer({
      id: "0xbbb",
      address: "127.0.0.1:19781",
      lastSeenMs: Date.now(),
    })

    assert.equal(ok, false)
  })

  it("should reject peers when authenticated verify is required but handshake config is unavailable", async () => {
    const network = new DhtNetwork({
      localId: "0xaaa",
      bootstrapPeers: [],
      wireClients: [],
      onPeerDiscovered: () => {},
      requireAuthenticatedVerify: true,
    })

    const ok = await network.verifyPeer({
      id: "0xbbb",
      address: "127.0.0.1:19781",
      lastSeenMs: Date.now(),
    })
    const stats = network.getStats()

    assert.equal(ok, false)
    assert.equal(stats.verifyFailures, 1)
    assert.equal(stats.verifyFallbackTcpAttempts, 0)
  })

  it("should attempt TCP fallback when authenticated verify is disabled", async () => {
    const network = new DhtNetwork({
      localId: "0xaaa",
      bootstrapPeers: [],
      wireClients: [],
      onPeerDiscovered: () => {},
      requireAuthenticatedVerify: false,
    })

    const ok = await network.verifyPeer({
      id: "0xbbb",
      address: "127.0.0.1:1",
      lastSeenMs: Date.now(),
    })
    const stats = network.getStats()

    assert.equal(ok, false)
    assert.equal(stats.verifyFallbackTcpAttempts, 1)
    assert.equal(stats.verifyFallbackTcpFailures, 1)
  })
})
