import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { PoSeEngine } from "./pose-engine.ts"
import { createNodeSigner, buildReceiptSignMessage } from "./crypto/signer.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import type { Hex32 } from "../../services/common/pose-types.ts"

// Hardhat test account #0
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

function makeEngine(epochId = 1n) {
  const signer = createNodeSigner(TEST_KEY)
  return new PoSeEngine(epochId, { signer })
}

describe("PoSeEngine", () => {
  it("initializes with correct epoch", () => {
    const engine = makeEngine(5n)
    assert.equal(engine.getEpochId(), 5n)
  })

  it("issueChallenge returns a valid challenge message", () => {
    const engine = makeEngine()
    const nodeId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const challenge = engine.issueChallenge(nodeId)
    assert.ok(challenge !== null)
    assert.ok(challenge!.challengeId)
    assert.equal(challenge!.challengeType, "U")
    assert.equal(challenge!.epochId, 1n)
  })

  it("issueChallenge respects quota limits", () => {
    const engine = makeEngine()
    const nodeId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const results: Array<unknown> = []
    for (let i = 0; i < 8; i++) {
      results.push(engine.issueChallenge(nodeId))
    }
    // First 6 should succeed, rest null (quota exhausted)
    const successes = results.filter((r) => r !== null)
    assert.ok(successes.length <= 6)
  })

  it("finalizeEpoch returns null when no receipts", () => {
    const engine = makeEngine()
    const result = engine.finalizeEpoch()
    assert.equal(result, null)
  })

  it("full challenge-receipt-finalize cycle", () => {
    const engine = makeEngine(10n)
    const signer = createNodeSigner(TEST_KEY)
    const nodeId = ("0x" + signer.nodeId.slice(2).padStart(64, "0")) as Hex32
    const challenge = engine.issueChallenge(nodeId)
    assert.ok(challenge !== null)

    // Build a proper ReceiptMessage matching the interface
    const responseBody = { status: 200, latencyMs: 50, result: "0x1" }
    const responseAtMs = challenge!.issuedAtMs + 500n // within deadline

    // Compute responseBodyHash the same way ReceiptVerifier does internally
    function stableStringify(value: unknown): string {
      if (value === null || typeof value !== "object") return JSON.stringify(value)
      if (Array.isArray(value)) return `[${value.map((x: unknown) => stableStringify(x)).join(",")}]`
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
    }
    const bodyHashHex = `0x${keccak256Hex(Buffer.from(stableStringify(responseBody), "utf8"))}` as Hex32

    const msg = buildReceiptSignMessage(challenge!.challengeId, nodeId, bodyHashHex)
    const sig = signer.sign(msg)

    engine.submitReceipt(challenge!, {
      challengeId: challenge!.challengeId,
      nodeId,
      responseAtMs,
      responseBody,
      nodeSig: sig as `0x${string}`,
    })

    const result = engine.finalizeEpoch()
    assert.ok(result !== null)
    assert.ok(result!.summaryHash)
    assert.ok(result!.merkleRoot)
    // Epoch incremented after finalization
    assert.equal(engine.getEpochId(), 11n)
  })
})
