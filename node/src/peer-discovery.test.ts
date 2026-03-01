import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PeerDiscovery } from "./peer-discovery.ts"
import { PeerScoring } from "./peer-scoring.ts"
import type { NodePeer } from "./blockchain-types.ts"

function makeScoring() {
  return new PeerScoring({ banThreshold: 0, banDurationMs: 60_000 })
}

function makePeer(id: string): NodePeer {
  return { id, url: `http://127.0.0.1:${19000 + parseInt(id.replace("node-", ""))}` }
}

describe("PeerDiscovery", () => {
  it("registers bootstrap peers excluding self", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery(
      [makePeer("node-1"), makePeer("node-2"), makePeer("node-3")],
      scoring,
      { selfId: "node-1", selfUrl: "http://127.0.0.1:19001" },
    )
    const peers = discovery.getAllPeers()
    assert.equal(peers.length, 2)
    assert.ok(peers.every((p) => p.id !== "node-1"))
  })

  it("getActivePeers filters out banned peers", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery(
      [makePeer("node-1"), makePeer("node-2"), makePeer("node-3")],
      scoring,
      { selfId: "node-0", selfUrl: "http://127.0.0.1:19000" },
    )
    // Ban node-2 by driving score below threshold
    for (let i = 0; i < 25; i++) scoring.recordFailure("node-2")
    const active = discovery.getActivePeers()
    assert.ok(active.every((p) => p.id !== "node-2"))
    assert.equal(active.length, 2)
  })

  it("getPeerListForExchange includes self and limits to 20", () => {
    const scoring = makeScoring()
    const bootstrapPeers = Array.from({ length: 25 }, (_, i) => makePeer(`node-${i + 1}`))
    const discovery = new PeerDiscovery(bootstrapPeers, scoring, {
      selfId: "node-0",
      selfUrl: "http://127.0.0.1:19000",
      maxPeers: 50,
    })
    const exchangeList = discovery.getPeerListForExchange()
    // Self + up to 20 peers
    assert.ok(exchangeList.length <= 21)
    assert.equal(exchangeList[0].id, "node-0")
  })

  it("addDiscoveredPeers skips self and duplicates", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery(
      [makePeer("node-1")],
      scoring,
      { selfId: "node-0", selfUrl: "http://127.0.0.1:19000" },
    )
    const added = discovery.addDiscoveredPeers([
      makePeer("node-0"), // self - skip
      makePeer("node-1"), // duplicate - skip
      makePeer("node-2"), // new
      makePeer("node-3"), // new
    ])
    assert.equal(added, 2)
    assert.equal(discovery.getAllPeers().length, 3)
  })

  it("addDiscoveredPeers respects maxPeers limit", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery(
      [makePeer("node-1"), makePeer("node-2")],
      scoring,
      { selfId: "node-0", selfUrl: "http://127.0.0.1:19000", maxPeers: 3 },
    )
    const added = discovery.addDiscoveredPeers([
      makePeer("node-3"),
      makePeer("node-4"),
      makePeer("node-5"),
    ])
    assert.equal(added, 1)
    assert.equal(discovery.getAllPeers().length, 3)
  })

  it("addDiscoveredPeers rejects malformed peers", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery([], scoring, {
      selfId: "node-0",
      selfUrl: "http://127.0.0.1:19000",
      maxPeers: 10,
    })
    const added = discovery.addDiscoveredPeers([
      { id: "", url: "http://127.0.0.1:19001" },
      { id: "node/evil", url: "http://127.0.0.1:19002" },
      { id: "node-1", url: "javascript:alert(1)" },
      { id: "node-2", url: "http://127.0.0.1:19003/path" },
    ])

    assert.equal(added, 1)
    const peers = discovery.getAllPeers()
    assert.equal(peers.length, 1)
    assert.equal(peers[0].id, "node-2")
    assert.equal(peers[0].url, "http://127.0.0.1:19003")
  })

  it("addDiscoveredPeers enforces per-batch input cap", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery([], scoring, {
      selfId: "node-0",
      selfUrl: "http://127.0.0.1:19000",
      maxPeers: 500,
      maxDiscoveredPerBatch: 3,
    })
    const incoming = Array.from({ length: 10 }, (_, i) => makePeer(`node-${i + 1}`))
    const added = discovery.addDiscoveredPeers(incoming)
    assert.equal(added, 3)
    assert.equal(discovery.getAllPeers().length, 3)
  })

  it("quarantines peers until identity verification passes", async () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery([], scoring, {
      selfId: "node-0",
      selfUrl: "http://127.0.0.1:19000",
      maxPeers: 10,
      verifyPeerIdentity: async (peer) => peer.id === "node-1",
    })

    const added = discovery.addDiscoveredPeers([makePeer("node-1"), makePeer("node-2")])
    assert.equal(added, 2)
    assert.equal(discovery.getAllPeers().length, 0)
    assert.equal(discovery.getPendingPeers().length, 2)

    await new Promise((resolve) => setTimeout(resolve, 10))

    const all = discovery.getAllPeers()
    assert.equal(all.length, 1)
    assert.equal(all[0].id, "node-1")
    assert.equal(discovery.getPendingPeers().length, 0)
  })

  it("stop clears timers without error", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery(
      [makePeer("node-1")],
      scoring,
      { selfId: "node-0", selfUrl: "http://127.0.0.1:19000" },
    )
    // Stop before start should be safe
    discovery.stop()
    // Start then stop
    discovery.start()
    discovery.stop()
  })

  it("default config is applied when no config provided", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery([], scoring)
    assert.equal(discovery.getAllPeers().length, 0)
    assert.equal(discovery.getActivePeers().length, 0)
  })

  it("empty bootstrap peers is valid", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery([], scoring, {
      selfId: "node-0",
      selfUrl: "http://127.0.0.1:19000",
    })
    assert.equal(discovery.getAllPeers().length, 0)
    const exchangeList = discovery.getPeerListForExchange()
    assert.equal(exchangeList.length, 1)
    assert.equal(exchangeList[0].id, "node-0")
  })

  it("rejects SSRF target IPs (link-local / cloud metadata)", () => {
    const scoring = makeScoring()
    const discovery = new PeerDiscovery([], scoring, {
      selfId: "node-0",
      selfUrl: "http://127.0.0.1:19000",
      maxPeers: 50,
    })
    const added = discovery.addDiscoveredPeers([
      { id: "aws-meta", url: "http://169.254.169.254:80" },
      { id: "link-local", url: "http://169.254.1.1:19780" },
      { id: "null-addr", url: "http://0.0.0.0:19780" },
      { id: "mapped-v6", url: "http://[::ffff:169.254.169.254]:80" },
      { id: "legit", url: "http://192.168.1.100:19780" }, // RFC1918 allowed
    ])
    assert.equal(added, 1)
    const peers = discovery.getAllPeers()
    assert.equal(peers.length, 1)
    assert.equal(peers[0].id, "legit")
  })
})
