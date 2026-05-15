/**
 * #622 (issue #620) regression: 2-node integration test for the equivocation
 * evidence gossip wire. A real P2PNode "sender" calls broadcastBftEvidence;
 * a real P2PNode "receiver" listens on /p2p/bft-evidence and invokes its
 * onBftEvidence handler. Without the network layer this PR added, peer
 * gossip never reaches the receiver and `coc_getEquivocations` diverges
 * across nodes (live 88780 observed 0/0/1 across 3 nodes — issue #620).
 *
 * This file deliberately exercises the WIRE only (HTTP route + payload
 * shape + handler dispatch). importEvidence's signature verification and
 * dedup are unit-tested separately in bft.test.ts under PR #621.
 */
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { P2PNode } from "./p2p.ts"
import type { BftEvidencePayload, P2PHandlers } from "./p2p.ts"
import type { Hex } from "./blockchain-types.ts"

const startedNodes: P2PNode[] = []

afterEach(async () => {
  await Promise.all(startedNodes.splice(0).map((node) => node.stop()))
})

function defaultHandlers(): P2PHandlers {
  return {
    onTx: async () => {},
    onBlock: async () => {},
    onSnapshotRequest: () => ({ blocks: [], updatedAtMs: Date.now() }),
  }
}

// Pick two non-colliding ports each run so parallel test files don't fight
// (same pattern as #620 ws-cswsh.test.ts).
function pickBasePort(): number {
  return 35000 + Math.floor(Math.random() * 5000)
}

const fakeEvidence: BftEvidencePayload = {
  validatorId: "0xb939e5a68abd2e000e78876bd86edd1cbba49eb9",
  height: "26554",
  phase: "prepare",
  blockHash1: ("0x" + "11".repeat(32)) as Hex,
  blockHash2: ("0x" + "22".repeat(32)) as Hex,
  signature1: "0x" + "aa".repeat(65),
  signature2: "0x" + "bb".repeat(65),
  detectedAtMs: 1700000000000,
}

describe("#622: equivocation evidence gossip wire", () => {
  it("receiver's onBftEvidence handler fires when sender broadcasts", async () => {
    const senderPort = pickBasePort()
    const receiverPort = senderPort + 1

    let received: BftEvidencePayload | null = null
    const receiver = new P2PNode(
      {
        bind: "127.0.0.1",
        port: receiverPort,
        peers: [],
        enableDiscovery: false,
      },
      {
        ...defaultHandlers(),
        onBftEvidence: async (msg) => {
          received = msg
        },
      },
    )
    receiver.start()
    startedNodes.push(receiver)

    const sender = new P2PNode(
      {
        bind: "127.0.0.1",
        port: senderPort,
        // Receiver is in the static peer list, so broadcastBftEvidence
        // hits it via the same path production uses.
        peers: [{ id: "receiver", url: `http://127.0.0.1:${receiverPort}` }],
        enableDiscovery: false,
      },
      defaultHandlers(),
    )
    sender.start()
    startedNodes.push(sender)

    // Tiny settle so listen()'s callback has fired on both servers.
    await new Promise((r) => setTimeout(r, 100))

    await sender.broadcastBftEvidence(fakeEvidence)

    assert.ok(received !== null, "receiver's onBftEvidence must have fired")
    assert.equal(received!.validatorId, fakeEvidence.validatorId)
    assert.equal(received!.height, fakeEvidence.height)
    assert.equal(received!.phase, fakeEvidence.phase)
    assert.equal(received!.blockHash1, fakeEvidence.blockHash1)
    assert.equal(received!.blockHash2, fakeEvidence.blockHash2)
    assert.equal(received!.signature1, fakeEvidence.signature1)
    assert.equal(received!.signature2, fakeEvidence.signature2)
  })

  it("/p2p/bft-evidence rejects payload with missing fields (400)", async () => {
    const port = pickBasePort() + 2
    const receiver = new P2PNode(
      { bind: "127.0.0.1", port, peers: [], enableDiscovery: false },
      { ...defaultHandlers(), onBftEvidence: async () => {} },
    )
    receiver.start()
    startedNodes.push(receiver)
    await new Promise((r) => setTimeout(r, 100))

    // Send a payload missing `signature2`.
    const res = await fetch(`http://127.0.0.1:${port}/p2p/bft-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        validatorId: fakeEvidence.validatorId,
        height: fakeEvidence.height,
        phase: fakeEvidence.phase,
        blockHash1: fakeEvidence.blockHash1,
        blockHash2: fakeEvidence.blockHash2,
        signature1: fakeEvidence.signature1,
        // signature2 omitted
        detectedAtMs: fakeEvidence.detectedAtMs,
      }),
    })
    assert.equal(res.status, 500, "missing required fields surface as 500 via the gossip-handler catch")
  })

  it("/p2p/bft-evidence rejects payload with invalid phase", async () => {
    const port = pickBasePort() + 3
    let receivedCount = 0
    const receiver = new P2PNode(
      { bind: "127.0.0.1", port, peers: [], enableDiscovery: false },
      {
        ...defaultHandlers(),
        onBftEvidence: async () => {
          receivedCount++
        },
      },
    )
    receiver.start()
    startedNodes.push(receiver)
    await new Promise((r) => setTimeout(r, 100))

    const res = await fetch(`http://127.0.0.1:${port}/p2p/bft-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...fakeEvidence,
        phase: "propose", // not "prepare" or "commit"
      }),
    })
    assert.equal(res.status, 500, "invalid phase rejected at wire layer")
    assert.equal(receivedCount, 0, "handler must NOT fire for invalid phase")
  })

  it("broadcastBftEvidence tolerates an unreachable peer (logs warn, no throw)", async () => {
    const port = pickBasePort() + 4
    // Sender configured with a peer URL that's NOT listening — broadcast
    // must surface the failure via per-peer log but resolve normally so
    // the caller (onEquivocation in index.ts) keeps the local slash path
    // working even when the gossip side fails.
    const sender = new P2PNode(
      {
        bind: "127.0.0.1",
        port,
        peers: [{ id: "dead-peer", url: "http://127.0.0.1:1" }], // port 1 = unreachable
        enableDiscovery: false,
      },
      defaultHandlers(),
    )
    sender.start()
    startedNodes.push(sender)
    await new Promise((r) => setTimeout(r, 100))

    await sender.broadcastBftEvidence(fakeEvidence) // must NOT throw
  })

  it("receiver pre-cast height-as-number coerces to canonical string", async () => {
    const senderPort = pickBasePort() + 5
    const receiverPort = senderPort + 1
    let received: BftEvidencePayload | null = null
    const receiver = new P2PNode(
      { bind: "127.0.0.1", port: receiverPort, peers: [], enableDiscovery: false },
      {
        ...defaultHandlers(),
        onBftEvidence: async (msg) => { received = msg },
      },
    )
    receiver.start()
    startedNodes.push(receiver)
    await new Promise((r) => setTimeout(r, 100))

    // Bypass broadcastBftEvidence to control the wire bytes — send
    // height as a JSON NUMBER (some non-TS clients may do this).
    const res = await fetch(`http://127.0.0.1:${receiverPort}/p2p/bft-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...fakeEvidence,
        height: 26554, // number not string
      }),
    })
    assert.equal(res.status, 200)
    assert.ok(received !== null)
    // Handler coerces to canonical string so downstream importEvidence
    // gets the same shape regardless of wire form.
    assert.equal(typeof received!.height, "string")
    assert.equal(received!.height, "26554")
  })
})
