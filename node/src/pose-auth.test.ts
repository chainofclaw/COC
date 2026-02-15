import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createNodeSigner } from "./crypto/signer.ts"
import { buildSignedPosePayload, verifySignedPosePayload } from "./pose-http.ts"

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

class ReplayTracker {
  private readonly used = new Set<string>()

  has(value: string): boolean {
    return this.used.has(value)
  }

  add(value: string): void {
    this.used.add(value)
  }
}

describe("pose auth envelope", () => {
  it("accepts valid signed payload", () => {
    const signer = createNodeSigner(TEST_KEY)
    const payload = buildSignedPosePayload("/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, signer, 1000)
    const check = verifySignedPosePayload("/pose/challenge", payload, signer, { nowMs: 1000 })
    assert.equal(check.ok, true)
  })

  it("rejects tampered payload body", () => {
    const signer = createNodeSigner(TEST_KEY)
    const signed = buildSignedPosePayload("/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, signer, 1000)
    const tampered = { ...signed, nodeId: "0x1111111111111111111111111111111111111111111111111111111111111111" }
    const check = verifySignedPosePayload("/pose/challenge", tampered, signer, { nowMs: 1000 })
    assert.equal(check.ok, false)
    if (!check.ok) {
      assert.match(check.reason, /invalid auth signature/)
    }
  })

  it("rejects stale timestamp", () => {
    const signer = createNodeSigner(TEST_KEY)
    const payload = buildSignedPosePayload("/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, signer, 1000)
    const check = verifySignedPosePayload("/pose/challenge", payload, signer, {
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
    const payload = buildSignedPosePayload("/pose/challenge", {
      nodeId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, signer, 1000)
    const tracker = new ReplayTracker()
    const first = verifySignedPosePayload("/pose/challenge", payload, signer, { nowMs: 1000, nonceTracker: tracker })
    const second = verifySignedPosePayload("/pose/challenge", payload, signer, { nowMs: 1000, nonceTracker: tracker })
    assert.equal(first.ok, true)
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.match(second.reason, /nonce replay detected/)
    }
  })
})
