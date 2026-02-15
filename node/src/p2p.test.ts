import test, { describe, it } from "node:test"
import assert from "node:assert/strict"
import { BoundedSet, P2PNode, buildP2PIdentityChallengeMessage } from "./p2p.ts"
import type { Hex, ChainBlock, ChainSnapshot } from "./blockchain-types.ts"
import { createNodeSigner } from "./crypto/signer.ts"

test("BoundedSet add and has", () => {
  const set = new BoundedSet<string>(5)
  set.add("a")
  set.add("b")
  assert.equal(set.has("a"), true)
  assert.equal(set.has("b"), true)
  assert.equal(set.has("c"), false)
  assert.equal(set.size, 2)
})

test("BoundedSet deduplicates", () => {
  const set = new BoundedSet<string>(5)
  set.add("a")
  set.add("a")
  set.add("a")
  assert.equal(set.size, 1)
})

test("BoundedSet evicts oldest when full", () => {
  const set = new BoundedSet<string>(3)
  set.add("a")
  set.add("b")
  set.add("c")
  assert.equal(set.size, 3)

  // Adding fourth item should evict "a"
  set.add("d")
  assert.equal(set.size, 3)
  assert.equal(set.has("a"), false)
  assert.equal(set.has("b"), true)
  assert.equal(set.has("c"), true)
  assert.equal(set.has("d"), true)
})

test("BoundedSet handles 100k insertions without growing beyond limit", () => {
  const limit = 1000
  const set = new BoundedSet<string>(limit)

  for (let i = 0; i < 100_000; i++) {
    set.add(`0x${i.toString(16).padStart(64, "0")}`)
  }

  assert.equal(set.size, limit)
  // Most recent items should still be present
  assert.equal(set.has(`0x${(99_999).toString(16).padStart(64, "0")}`), true)
  // Old items should be evicted
  assert.equal(set.has(`0x${"0".padStart(64, "0")}`), false)
})

test("BoundedSet eviction order is FIFO", () => {
  const set = new BoundedSet<number>(3)
  set.add(1)
  set.add(2)
  set.add(3)
  set.add(4) // evicts 1
  set.add(5) // evicts 2

  assert.equal(set.has(1), false)
  assert.equal(set.has(2), false)
  assert.equal(set.has(3), true)
  assert.equal(set.has(4), true)
  assert.equal(set.has(5), true)
})

test("BoundedSet with size 1", () => {
  const set = new BoundedSet<string>(1)
  set.add("a")
  assert.equal(set.has("a"), true)
  set.add("b")
  assert.equal(set.has("a"), false)
  assert.equal(set.has("b"), true)
  assert.equal(set.size, 1)
})

describe("P2P node-info endpoint", () => {
  it("returns node metadata via /p2p/node-info", async () => {
    const port = 29700 + Math.floor(Math.random() * 200)
    const p2p = new P2PNode(
      {
        bind: "127.0.0.1",
        port,
        peers: [],
        nodeId: "test-node-42",
        enableDiscovery: false,
      },
      {
        onTx: async () => {},
        onBlock: async () => {},
        onSnapshotRequest: () => ({ height: 0, latestHash: "0x0" as Hex, blocks: [] }) as unknown as ChainSnapshot,
        getHeight: () => 123n,
      },
    )
    p2p.start()
    await new Promise((r) => setTimeout(r, 100))

    const res = await fetch(`http://127.0.0.1:${port}/p2p/node-info`)
    assert.equal(res.status, 200)

    const info = await res.json()
    assert.equal(info.nodeId, "test-node-42")
    assert.equal(info.blockHeight, "123")
    assert.equal(info.protocol, "http-gossip")
    assert.ok(typeof info.peerCount === "number")
    assert.ok(typeof info.stats === "object")
    assert.ok(typeof info.stats.txReceived === "number")
    assert.ok(typeof info.uptimeMs === "number")
  })

  it("returns signed identity proof via /p2p/identity-proof", async () => {
    const signer = createNodeSigner("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
    const port = 29700 + Math.floor(Math.random() * 200)
    const p2p = new P2PNode(
      {
        bind: "127.0.0.1",
        port,
        peers: [],
        nodeId: signer.nodeId,
        signer,
        enableDiscovery: false,
      },
      {
        onTx: async () => {},
        onBlock: async () => {},
        onSnapshotRequest: () => ({ height: 0, latestHash: "0x0" as Hex, blocks: [] }) as unknown as ChainSnapshot,
      },
    )
    p2p.start()
    await new Promise((r) => setTimeout(r, 100))

    const challenge = "identity-proof-test"
    const res = await fetch(`http://127.0.0.1:${port}/p2p/identity-proof?challenge=${challenge}`)
    assert.equal(res.status, 200)
    const proof = await res.json()
    assert.equal(proof.nodeId, signer.nodeId)
    assert.equal(proof.challenge, challenge)
    const message = buildP2PIdentityChallengeMessage(challenge, signer.nodeId)
    assert.equal(signer.verifyNodeSig(message, proof.signature, signer.nodeId), true)
  })
})

describe("P2P inbound rate limit", () => {
  it("returns 429 when request rate exceeds configured limit", async () => {
    const port = 29900 + Math.floor(Math.random() * 200)
    const p2p = new P2PNode(
      {
        bind: "127.0.0.1",
        port,
        peers: [],
        nodeId: "test-node-rate-limit",
        enableDiscovery: false,
        inboundRateLimitWindowMs: 30_000,
        inboundRateLimitMaxRequests: 2,
      },
      {
        onTx: async () => {},
        onBlock: async () => {},
        onSnapshotRequest: () => ({ height: 0, latestHash: "0x0" as Hex, blocks: [] }) as unknown as ChainSnapshot,
      },
    )
    p2p.start()
    await new Promise((r) => setTimeout(r, 100))

    const url = `http://127.0.0.1:${port}/p2p/peers`
    const r1 = await fetch(url)
    const r2 = await fetch(url)
    const r3 = await fetch(url)

    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    assert.equal(r3.status, 429)
  })
})
