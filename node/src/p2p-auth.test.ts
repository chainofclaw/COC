import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createNodeSigner } from "./crypto/signer.ts"
import { BoundedSet, P2PNode, buildSignedP2PPayload, verifySignedP2PPayload } from "./p2p.ts"

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

describe("P2P auth envelope", () => {
  it("accepts valid signed payload", () => {
    const signer = createNodeSigner(TEST_KEY)
    const payload = buildSignedP2PPayload("/p2p/gossip-tx", { rawTx: "0x1234" }, signer, 1000)
    const check = verifySignedP2PPayload("/p2p/gossip-tx", payload, signer, { nowMs: 1000 })
    assert.equal(check.ok, true)
  })

  it("rejects tampered payload body", () => {
    const signer = createNodeSigner(TEST_KEY)
    const signed = buildSignedP2PPayload("/p2p/gossip-tx", { rawTx: "0x1234" }, signer, 1000)
    const tampered = { ...signed, rawTx: "0xabcd" }
    const check = verifySignedP2PPayload("/p2p/gossip-tx", tampered, signer, { nowMs: 1000 })
    assert.equal(check.ok, false)
    if (!check.ok) {
      assert.match(check.reason, /invalid auth signature/)
    }
  })

  it("rejects stale timestamp", () => {
    const signer = createNodeSigner(TEST_KEY)
    const payload = buildSignedP2PPayload("/p2p/gossip-tx", { rawTx: "0x1234" }, signer, 1000)
    const check = verifySignedP2PPayload("/p2p/gossip-tx", payload, signer, {
      nowMs: 5000,
      maxClockSkewMs: 1000,
    })
    assert.equal(check.ok, false)
    if (!check.ok) {
      assert.match(check.reason, /timestamp out of range/)
    }
  })

  it("rejects nonce replay", () => {
    const signer = createNodeSigner(TEST_KEY)
    const payload = buildSignedP2PPayload("/p2p/gossip-tx", { rawTx: "0x1234" }, signer, 1000)
    const tracker = new BoundedSet<string>(100)
    const first = verifySignedP2PPayload("/p2p/gossip-tx", payload, signer, { nowMs: 1000, nonceTracker: tracker })
    const second = verifySignedP2PPayload("/p2p/gossip-tx", payload, signer, { nowMs: 1000, nonceTracker: tracker })
    assert.equal(first.ok, true)
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.match(second.reason, /nonce replay detected/)
    }
  })

  it("maps legacy enableInboundAuth=true to enforce mode", () => {
    const p2p = new P2PNode(
      {
        bind: "127.0.0.1",
        port: 0,
        peers: [],
        enableDiscovery: false,
        enableInboundAuth: true,
      },
      {
        onTx: async () => {},
        onBlock: async () => {},
        onSnapshotRequest: () => ({ blocks: [], updatedAtMs: Date.now() }),
      },
    )
    assert.equal(p2p.getStats().inboundAuthMode, "enforce")
  })

  it("respects explicit monitor mode", () => {
    const p2p = new P2PNode(
      {
        bind: "127.0.0.1",
        port: 0,
        peers: [],
        enableDiscovery: false,
        inboundAuthMode: "monitor",
      },
      {
        onTx: async () => {},
        onBlock: async () => {},
        onSnapshotRequest: () => ({ blocks: [], updatedAtMs: Date.now() }),
      },
    )
    assert.equal(p2p.getStats().inboundAuthMode, "monitor")
  })
})
