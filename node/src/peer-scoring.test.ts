/**
 * Peer scoring and discovery tests
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PeerScoring } from "./peer-scoring.ts"
import { PeerDiscovery } from "./peer-discovery.ts"

describe("PeerScoring", () => {
  it("initializes peer with default score", () => {
    const scoring = new PeerScoring()
    scoring.addPeer("peer1", "http://localhost:9001")
    assert.equal(scoring.getScore("peer1"), 100)
  })

  it("increases score on success", () => {
    const scoring = new PeerScoring({ successReward: 5 })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.recordSuccess("peer1")
    assert.equal(scoring.getScore("peer1"), 105)
  })

  it("decreases score on failure", () => {
    const scoring = new PeerScoring({ failurePenalty: 10 })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.recordFailure("peer1")
    assert.equal(scoring.getScore("peer1"), 90)
  })

  it("applies heavier penalty for invalid data", () => {
    const scoring = new PeerScoring({ invalidDataPenalty: 30 })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.recordInvalidData("peer1")
    assert.equal(scoring.getScore("peer1"), 70)
  })

  it("bans peer when score drops below threshold", () => {
    const scoring = new PeerScoring({
      initialScore: 10,
      banThreshold: 0,
      failurePenalty: 15,
      banDurationMs: 60000,
    })
    scoring.addPeer("peer1", "http://localhost:9001")
    assert.equal(scoring.isBanned("peer1"), false)

    scoring.recordFailure("peer1") // score: -5
    assert.equal(scoring.isBanned("peer1"), true)
  })

  it("caps score at maxScore", () => {
    const scoring = new PeerScoring({ maxScore: 120, successReward: 50 })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.recordSuccess("peer1")
    assert.equal(scoring.getScore("peer1"), 120)
  })

  it("caps score at minScore", () => {
    const scoring = new PeerScoring({ minScore: -50, failurePenalty: 200 })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.recordFailure("peer1")
    assert.equal(scoring.getScore("peer1"), -50)
  })

  it("getActivePeers excludes banned peers", () => {
    const scoring = new PeerScoring({
      initialScore: 10,
      banThreshold: 0,
      failurePenalty: 15,
      banDurationMs: 60000,
    })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.addPeer("peer2", "http://localhost:9002")
    scoring.recordFailure("peer1") // banned

    const active = scoring.getActivePeers()
    assert.equal(active.length, 1)
    assert.equal(active[0].id, "peer2")
  })

  it("sorts active peers by score descending", () => {
    const scoring = new PeerScoring({ successReward: 10 })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.addPeer("peer2", "http://localhost:9002")
    scoring.recordSuccess("peer2")
    scoring.recordSuccess("peer2")

    const active = scoring.getActivePeers()
    assert.equal(active[0].id, "peer2")
    assert.equal(active[1].id, "peer1")
  })

  it("applies score decay toward initial score", () => {
    const scoring = new PeerScoring({ initialScore: 100, decayAmount: 5, successReward: 20 })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.recordSuccess("peer1") // 120
    assert.equal(scoring.getScore("peer1"), 120)

    scoring.applyDecay() // 115
    assert.equal(scoring.getScore("peer1"), 115)
  })

  it("stats returns correct metrics", () => {
    const scoring = new PeerScoring({
      initialScore: 10,
      banThreshold: 0,
      failurePenalty: 15,
      banDurationMs: 60000,
    })
    scoring.addPeer("peer1", "http://localhost:9001")
    scoring.addPeer("peer2", "http://localhost:9002")
    scoring.recordFailure("peer1") // banned

    const stats = scoring.stats()
    assert.equal(stats.total, 2)
    assert.equal(stats.active, 1)
    assert.equal(stats.banned, 1)
  })
})

describe("PeerDiscovery", () => {
  it("registers bootstrap peers", () => {
    const scoring = new PeerScoring()
    const discovery = new PeerDiscovery(
      [
        { id: "peer1", url: "http://localhost:9001" },
        { id: "peer2", url: "http://localhost:9002" },
      ],
      scoring,
      { selfId: "self", selfUrl: "http://localhost:9000" },
    )

    const peers = discovery.getAllPeers()
    assert.equal(peers.length, 2)
  })

  it("excludes self from peer list", () => {
    const scoring = new PeerScoring()
    const discovery = new PeerDiscovery(
      [
        { id: "self", url: "http://localhost:9000" },
        { id: "peer1", url: "http://localhost:9001" },
      ],
      scoring,
      { selfId: "self", selfUrl: "http://localhost:9000" },
    )

    const peers = discovery.getAllPeers()
    assert.equal(peers.length, 1)
    assert.equal(peers[0].id, "peer1")
  })

  it("adds discovered peers up to maxPeers limit", () => {
    const scoring = new PeerScoring()
    const discovery = new PeerDiscovery([], scoring, {
      selfId: "self",
      selfUrl: "http://localhost:9000",
      maxPeers: 3,
    })

    const added = discovery.addDiscoveredPeers([
      { id: "p1", url: "http://localhost:9001" },
      { id: "p2", url: "http://localhost:9002" },
      { id: "p3", url: "http://localhost:9003" },
      { id: "p4", url: "http://localhost:9004" },
    ])

    assert.equal(added, 3) // limited to maxPeers
    assert.equal(discovery.getAllPeers().length, 3)
  })

  it("does not add self or duplicate peers", () => {
    const scoring = new PeerScoring()
    const discovery = new PeerDiscovery(
      [{ id: "peer1", url: "http://localhost:9001" }],
      scoring,
      { selfId: "self", selfUrl: "http://localhost:9000" },
    )

    const added = discovery.addDiscoveredPeers([
      { id: "self", url: "http://localhost:9000" },   // self - skip
      { id: "peer1", url: "http://localhost:9001" },   // duplicate - skip
      { id: "peer2", url: "http://localhost:9002" },   // new
    ])

    assert.equal(added, 1)
    assert.equal(discovery.getAllPeers().length, 2)
  })

  it("getPeerListForExchange includes self", () => {
    const scoring = new PeerScoring()
    const discovery = new PeerDiscovery(
      [{ id: "peer1", url: "http://localhost:9001" }],
      scoring,
      { selfId: "self", selfUrl: "http://localhost:9000" },
    )

    const list = discovery.getPeerListForExchange()
    assert.ok(list.some((p) => p.id === "self"))
    assert.ok(list.some((p) => p.id === "peer1"))
  })

  it("getActivePeers excludes banned peers", () => {
    const scoring = new PeerScoring({
      initialScore: 10,
      banThreshold: 0,
      failurePenalty: 15,
      banDurationMs: 60000,
    })
    const discovery = new PeerDiscovery(
      [
        { id: "peer1", url: "http://localhost:9001" },
        { id: "peer2", url: "http://localhost:9002" },
      ],
      scoring,
      { selfId: "self", selfUrl: "http://localhost:9000" },
    )

    scoring.recordFailure("peer1") // banned
    const active = discovery.getActivePeers()
    assert.equal(active.length, 1)
    assert.equal(active[0].id, "peer2")
  })
})
