import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createNodeSigner } from "./crypto/signer.ts"
import {
  BoundedSet,
  P2PNode,
  PersistentAuthNonceTracker,
  buildP2PIdentityChallengeMessage,
  buildSignedP2PPayload,
  verifySignedP2PPayload,
} from "./p2p.ts"

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

  it("persists auth nonce across tracker restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-p2p-auth-"))
    try {
      const file = join(dir, "nonce.log")
      const tracker1 = new PersistentAuthNonceTracker({
        maxSize: 100,
        ttlMs: 60_000,
        persistencePath: file,
        nowFn: () => 1000,
      })
      tracker1.add("node-1:nonce-a")

      const tracker2 = new PersistentAuthNonceTracker({
        maxSize: 100,
        ttlMs: 60_000,
        persistencePath: file,
        nowFn: () => 1000,
      })
      assert.equal(tracker2.has("node-1:nonce-a"), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("drops expired persisted nonces based on ttl", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-p2p-auth-"))
    try {
      const file = join(dir, "nonce.log")
      writeFileSync(file, "100\told-nonce\n80\tolder-nonce\n")
      const tracker = new PersistentAuthNonceTracker({
        maxSize: 100,
        ttlMs: 50,
        persistencePath: file,
        nowFn: () => 200,
      })
      assert.equal(tracker.has("old-nonce"), false)
      assert.equal(tracker.has("older-nonce"), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("verifies identity challenge signatures", () => {
    const signer = createNodeSigner(TEST_KEY)
    const challenge = "unit-test-challenge"
    const message = buildP2PIdentityChallengeMessage(challenge, signer.nodeId)
    const signature = signer.sign(message)
    assert.equal(signer.verifyNodeSig(message, signature, signer.nodeId), true)
  })
})
