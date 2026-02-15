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

  it("issueChallenge uses non-constant randSeed", () => {
    const engine = makeEngine()
    const nodeId1 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const nodeId2 = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    const c1 = engine.issueChallenge(nodeId1)
    const c2 = engine.issueChallenge(nodeId2)
    assert.ok(c1 !== null && c2 !== null)
    assert.notEqual(c1!.randSeed, "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
    assert.notEqual(c1!.randSeed, c2!.randSeed)
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

  it("issueChallenge supports non-uptime challenge bucket", () => {
    const engine = makeEngine()
    const nodeId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const challenge = engine.issueChallenge(nodeId, { challengeBucket: "S" })
    assert.ok(challenge)
    assert.equal(challenge!.challengeType, "S")
  })

  it("issueChallenge respects global epoch budget", () => {
    const signer = createNodeSigner(TEST_KEY)
    const engine = new PoSeEngine(1n, { signer, maxChallengesPerEpoch: 2 })
    const n1 = "0x" + "11".repeat(32)
    const n2 = "0x" + "22".repeat(32)
    const n3 = "0x" + "33".repeat(32)
    const c1 = engine.issueChallenge(n1)
    const c2 = engine.issueChallenge(n2)
    const c3 = engine.issueChallenge(n3)
    assert.ok(c1)
    assert.ok(c2)
    assert.equal(c3, null)
  })

  it("issueChallenge applies restricted tier quota profile", () => {
    const signer = createNodeSigner(TEST_KEY)
    const nodeId = "0x" + "44".repeat(32)
    const engine = new PoSeEngine(1n, {
      signer,
      maxChallengesPerEpoch: 10,
      challengeTierResolver: () => "restricted",
      challengeBudgetProfiles: {
        restricted: {
          maxPerEpoch: { U: 3 },
          minIntervalMs: { U: 0 },
        },
      },
    })
    const results = Array.from({ length: 5 }, () => engine.issueChallenge(nodeId))
    assert.equal(results.filter((r) => r !== null).length, 3)
  })

  it("issueChallenge applies trusted tier quota profile for storage bucket", () => {
    const signer = createNodeSigner(TEST_KEY)
    const nodeId = "0x" + "55".repeat(32)
    const engine = new PoSeEngine(1n, {
      signer,
      maxChallengesPerEpoch: 10,
      challengeTierResolver: () => "trusted",
      challengeBudgetProfiles: {
        trusted: {
          maxPerEpoch: { S: 2 },
          minIntervalMs: { S: 0 },
        },
      },
    })
    const results = Array.from({ length: 4 }, () => engine.issueChallenge(nodeId, { challengeBucket: "S" }))
    const successes = results.filter((r): r is NonNullable<typeof r> => r !== null)
    assert.equal(successes.length, 2)
    assert.equal(successes[0].challengeType, "S")
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
    const responseBody = { ok: true, blockNumber: 123 }
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

  it("submitReceipt rejects unknown challenge ID", () => {
    const engine = makeEngine(1n)
    const signer = createNodeSigner(TEST_KEY)
    const nodeId = ("0x" + signer.nodeId.slice(2).padStart(64, "0")) as Hex32
    const challenge = engine.issueChallenge(nodeId)
    assert.ok(challenge)

    const responseBody = { ok: true, blockNumber: 1 }
    const bodyHashHex = `0x${keccak256Hex(Buffer.from(JSON.stringify(responseBody), "utf8"))}` as Hex32
    const msg = buildReceiptSignMessage(challenge!.challengeId, nodeId, bodyHashHex)
    const sig = signer.sign(msg)

    assert.throws(() => {
      engine.submitReceiptByChallengeId(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        {
          challengeId: challenge!.challengeId,
          nodeId,
          responseAtMs: challenge!.issuedAtMs + 100n,
          responseBody,
          nodeSig: sig as `0x${string}`,
        },
      )
    }, /unknown challenge/)
  })

  it("submitReceipt uses injected nonce registry", () => {
    let consumeCalls = 0
    const signer = createNodeSigner(TEST_KEY)
    const nodeId = ("0x" + signer.nodeId.slice(2).padStart(64, "0")) as Hex32
    const engine = new PoSeEngine(1n, {
      signer,
      nonceRegistry: {
        consume() {
          consumeCalls += 1
          return false
        },
      },
    })
    const challenge = engine.issueChallenge(nodeId)
    assert.ok(challenge)

    const responseBody = { ok: true, blockNumber: 1 }
    const bodyHashHex = `0x${keccak256Hex(Buffer.from(JSON.stringify(responseBody), "utf8"))}` as Hex32
    const msg = buildReceiptSignMessage(challenge!.challengeId, nodeId, bodyHashHex)
    const sig = signer.sign(msg)

    assert.throws(() => {
      engine.submitReceipt(challenge!, {
        challengeId: challenge!.challengeId,
        nodeId,
        responseAtMs: challenge!.issuedAtMs + 100n,
        responseBody,
        nodeSig: sig as `0x${string}`,
      })
    }, /nonce replay detected/)
    assert.equal(consumeCalls, 1)
  })
})
