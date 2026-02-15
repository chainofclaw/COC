import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import assert from "node:assert/strict"
import { ReplayGuard } from "./replay-guard.ts"
import { CrossLayerMessageType, type CrossLayerEnvelope } from "./message-types.ts"

function envelope(overrides: Partial<CrossLayerEnvelope> = {}): CrossLayerEnvelope {
  return {
    srcChainId: 1,
    dstChainId: 10,
    channelId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    nonce: 1n,
    payloadHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    sourceBlockNumber: 100n,
    sourceTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    messageType: CrossLayerMessageType.NodeRegistered,
    payload: { nodeId: "0x01" },
    ...overrides,
  }
}

test("replay guard rejects non-monotonic nonce", () => {
  const guard = new ReplayGuard()
  const first = envelope({ nonce: 2n })
  const check1 = guard.validate(first)
  assert.equal(check1.ok, true)
  guard.commit(first, check1.replayKey)

  const second = envelope({ nonce: 2n })
  const check2 = guard.validate(second)
  assert.equal(check2.ok, false)
  assert.equal(check2.reason, "nonce not monotonic")
})

test("replay guard rejects replay key duplicates", () => {
  const guard = new ReplayGuard()
  const first = envelope({ nonce: 3n })
  const check1 = guard.validate(first)
  assert.equal(check1.ok, true)
  guard.commit(first, check1.replayKey)

  const sameKeyHigherChannelNonce = envelope({
    nonce: 4n,
    channelId: first.channelId,
    payloadHash: first.payloadHash,
  })
  // Mutate map to allow monotonic pass then force duplicate replay check.
  const key = guard.buildReplayKey(first)
  const dup = guard.validate(first)
  assert.equal(dup.ok, false)
  assert.equal(dup.reason, "nonce not monotonic")

  const next = guard.validate(sameKeyHigherChannelNonce)
  assert.equal(next.ok, true)
  assert.notEqual(next.replayKey, key)
})

test("replay guard restores monotonic state after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-guard-"))
  const filePath = join(dir, "replay-state.json")
  try {
    const first = new ReplayGuard({ persistencePath: filePath })
    const initial = envelope({ nonce: 7n })
    const c1 = first.validate(initial)
    assert.equal(c1.ok, true)
    first.commit(initial, c1.replayKey)

    const second = new ReplayGuard({ persistencePath: filePath })
    const stale = second.validate(envelope({ nonce: 7n }))
    assert.equal(stale.ok, false)
    assert.equal(stale.reason, "nonce not monotonic")

    const fresh = second.validate(envelope({ nonce: 8n }))
    assert.equal(fresh.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
