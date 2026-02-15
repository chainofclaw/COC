import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import assert from "node:assert/strict"
import { NonceRegistry } from "./nonce-registry.ts"
import type { ChallengeMessage } from "../common/pose-types.ts"

const challenge: ChallengeMessage = {
  challengeId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  epochId: 1n,
  nodeId: "0x2222222222222222222222222222222222222222222222222222222222222222",
  challengeType: "U",
  nonce: "0x1234567890abcdef1234567890abcdef",
  randSeed: "0x3333333333333333333333333333333333333333333333333333333333333333",
  issuedAtMs: 1000n,
  deadlineMs: 2500,
  querySpec: {},
  challengerId: "0x4444444444444444444444444444444444444444444444444444444444444444",
  challengerSig: "0xabc",
}

test("nonce registry rejects replay", () => {
  const registry = new NonceRegistry()
  assert.equal(registry.consume(challenge), true)
  assert.equal(registry.consume(challenge), false)
})

test("nonce registry restores persisted keys after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "nonce-registry-"))
  const filePath = join(dir, "used-nonces.log")
  try {
    const first = new NonceRegistry({ persistencePath: filePath })
    assert.equal(first.consume(challenge), true)

    const second = new NonceRegistry({ persistencePath: filePath })
    assert.equal(second.consume(challenge), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("nonce registry prunes expired persisted entries by ttl", () => {
  const dir = mkdtempSync(join(tmpdir(), "nonce-registry-"))
  const filePath = join(dir, "used-nonces.log")
  try {
    const first = new NonceRegistry({
      persistencePath: filePath,
      ttlMs: 50,
      nowFn: () => 100,
    })
    assert.equal(first.consume(challenge), true)

    const second = new NonceRegistry({
      persistencePath: filePath,
      ttlMs: 50,
      nowFn: () => 200,
    })
    // Previously consumed nonce expired at restart and can be accepted again.
    assert.equal(second.consume(challenge), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("nonce registry enforces maxEntries and evicts oldest", () => {
  const registry = new NonceRegistry({
    maxEntries: 2,
    ttlMs: 60_000,
    nowFn: () => 1000,
  })

  const c1 = { ...challenge, nonce: "0x00000000000000000000000000000001" }
  const c2 = { ...challenge, nonce: "0x00000000000000000000000000000002" }
  const c3 = { ...challenge, nonce: "0x00000000000000000000000000000003" }

  assert.equal(registry.consume(c1), true)
  assert.equal(registry.consume(c2), true)
  assert.equal(registry.consume(c3), true)

  // c1 should have been evicted by maxEntries cap, so it can be consumed again.
  assert.equal(registry.consume(c1), true)
})
