import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createNodeSigner } from "./crypto/signer.ts"
import { buildSignedPosePayload, verifySignedPosePayload, PersistentPoseAuthNonceTracker } from "./pose-http.ts"

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

  it("persists nonce across tracker restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-pose-auth-"))
    try {
      const file = join(dir, "nonce.log")
      const tracker1 = new PersistentPoseAuthNonceTracker({
        maxSize: 100,
        ttlMs: 60_000,
        persistencePath: file,
        nowFn: () => 1000,
      })
      tracker1.add("node-1:nonce-a")

      const tracker2 = new PersistentPoseAuthNonceTracker({
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

  it("drops expired persisted nonce by ttl", () => {
    const dir = mkdtempSync(join(tmpdir(), "coc-pose-auth-"))
    try {
      const file = join(dir, "nonce.log")
      writeFileSync(file, "100\told-nonce\n80\tolder-nonce\n")
      const tracker = new PersistentPoseAuthNonceTracker({
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
})
