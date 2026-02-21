/**
 * Relay Witness Security Tests
 *
 * Validates strict verification of relay-type challenge receipts to prevent:
 * - Forged relay witnesses (wrong hash, tampered body)
 * - Timestamp manipulation (future timestamps, pre-issuance responses)
 * - Missing required relay data fields
 * - Replay attacks via nonce re-use
 * - Cross-node relay witness reuse (wrong nodeId)
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { ReceiptVerifier } from "./receipt-verifier.ts"
import { NonceRegistry } from "./nonce-registry.ts"
import { ChallengeType } from "../common/pose-types.ts"
import type { ChallengeMessage, ReceiptMessage, Hex32 } from "../common/pose-types.ts"

function makeChallenge(overrides?: Partial<ChallengeMessage>): ChallengeMessage {
  return {
    challengeId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    epochId: 1n,
    nodeId: "0x2222222222222222222222222222222222222222222222222222222222222222",
    challengeType: ChallengeType.Relay,
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    randSeed: "0x3333333333333333333333333333333333333333333333333333333333333333",
    issuedAtMs: 1000n,
    deadlineMs: 5000,
    querySpec: { method: "eth_getBlockByNumber", params: ["latest", false] },
    challengerId: "0x4444444444444444444444444444444444444444444444444444444444444444",
    challengerSig: "0xabc",
    ...overrides,
  }
}

function makeReceipt(overrides?: Partial<ReceiptMessage>): ReceiptMessage {
  return {
    challengeId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    nodeId: "0x2222222222222222222222222222222222222222222222222222222222222222",
    responseAtMs: 1200n,
    responseBody: {
      relayTarget: "http://peer-node:18780",
      relayMethod: "eth_getBlockByNumber",
      relayResult: { number: "0xa", hash: "0xdeadbeef" },
      relayLatencyMs: 45,
    },
    nodeSig: "0xdef",
    ...overrides,
  }
}

describe("Relay Witness Security", () => {
  describe("valid relay receipt", () => {
    it("should accept a properly formed relay receipt", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: (_ch, receipt) => {
          const body = receipt.responseBody
          return Boolean(body.relayTarget && body.relayMethod && body.relayResult)
        },
      })

      const result = verifier.verify(makeChallenge(), makeReceipt())
      assert.equal(result.ok, true)
      assert.ok(result.responseBodyHash)
    })
  })

  describe("forged relay witness", () => {
    it("should reject when relay verifier detects forged result", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => false, // relay verification fails
      })

      const result = verifier.verify(makeChallenge(), makeReceipt())
      assert.equal(result.ok, false)
      assert.equal(result.reason, "relay witness invalid")
    })

    it("should reject when relay result body is empty", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: (_ch, receipt) => {
          return Object.keys(receipt.responseBody).length > 0 &&
            Boolean(receipt.responseBody.relayResult)
        },
      })

      const receipt = makeReceipt({ responseBody: {} })
      const result = verifier.verify(makeChallenge(), receipt)
      assert.equal(result.ok, false)
      assert.equal(result.reason, "relay witness invalid")
    })

    it("should reject when relay target is missing", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: (_ch, receipt) => {
          return Boolean(receipt.responseBody.relayTarget)
        },
      })

      const receipt = makeReceipt({
        responseBody: { relayMethod: "eth_getBlockByNumber", relayResult: { number: "0xa" } },
      })
      const result = verifier.verify(makeChallenge(), receipt)
      assert.equal(result.ok, false)
      assert.equal(result.reason, "relay witness invalid")
    })
  })

  describe("timestamp manipulation", () => {
    it("should reject response before challenge issuance", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      const receipt = makeReceipt({ responseAtMs: 500n }) // before issuedAtMs=1000
      const result = verifier.verify(makeChallenge(), receipt)
      assert.equal(result.ok, false)
      assert.equal(result.reason, "receipt timestamp before challenge issuance")
    })

    it("should reject response after deadline", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      const receipt = makeReceipt({ responseAtMs: 7000n }) // issuedAtMs=1000 + deadlineMs=5000 = 6000
      const result = verifier.verify(makeChallenge(), receipt)
      assert.equal(result.ok, false)
      assert.equal(result.reason, "receipt timeout")
    })

    it("should accept response exactly at deadline boundary", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      // issuedAtMs=1000 + deadlineMs=5000 = 6000, response at 6000 should pass
      const receipt = makeReceipt({ responseAtMs: 6000n })
      const result = verifier.verify(makeChallenge(), receipt)
      assert.equal(result.ok, true)
    })
  })

  describe("signature verification", () => {
    it("should reject invalid challenger signature", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => false,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      const result = verifier.verify(makeChallenge(), makeReceipt())
      assert.equal(result.ok, false)
      assert.equal(result.reason, "invalid challenger signature")
    })

    it("should reject invalid node signature", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => false,
        verifyRelayResult: () => true,
      })

      const result = verifier.verify(makeChallenge(), makeReceipt())
      assert.equal(result.ok, false)
      assert.equal(result.reason, "invalid node signature")
    })
  })

  describe("challenge/receipt mismatch", () => {
    it("should reject mismatched challengeId", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      const receipt = makeReceipt({
        challengeId: "0x9999999999999999999999999999999999999999999999999999999999999999",
      })
      const result = verifier.verify(makeChallenge(), receipt)
      assert.equal(result.ok, false)
      assert.equal(result.reason, "challenge/receipt mismatch")
    })

    it("should reject mismatched nodeId (cross-node witness reuse)", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      const receipt = makeReceipt({
        nodeId: "0x8888888888888888888888888888888888888888888888888888888888888888",
      })
      const result = verifier.verify(makeChallenge(), receipt)
      assert.equal(result.ok, false)
      assert.equal(result.reason, "challenge/receipt mismatch")
    })
  })

  describe("nonce replay protection", () => {
    it("should reject replayed relay challenge nonce", () => {
      const registry = new NonceRegistry({ ttlMs: 60_000 })
      const verifier = new ReceiptVerifier({
        nonceRegistry: registry,
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      const challenge = makeChallenge()
      const receipt = makeReceipt()

      const first = verifier.verify(challenge, receipt)
      assert.equal(first.ok, true)

      const replay = verifier.verify(challenge, receipt)
      assert.equal(replay.ok, false)
      assert.equal(replay.reason, "nonce replay detected")
    })

    it("should allow different nonces for same node", () => {
      const registry = new NonceRegistry({ ttlMs: 60_000 })
      const verifier = new ReceiptVerifier({
        nonceRegistry: registry,
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      const ch1 = makeChallenge({ nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
      const ch2 = makeChallenge({
        challengeId: "0x5555555555555555555555555555555555555555555555555555555555555555",
        nonce: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })
      const r1 = makeReceipt()
      const r2 = makeReceipt({
        challengeId: "0x5555555555555555555555555555555555555555555555555555555555555555",
      })

      assert.equal(verifier.verify(ch1, r1).ok, true)
      assert.equal(verifier.verify(ch2, r2).ok, true)
    })
  })

  describe("challenge type enforcement", () => {
    it("should not call relay verifier for non-relay challenge type", () => {
      let relayCalled = false
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => { relayCalled = true; return true },
        verifyUptimeResult: () => true,
      })

      const uptimeChallenge = makeChallenge({ challengeType: ChallengeType.Uptime })
      const result = verifier.verify(uptimeChallenge, makeReceipt())
      assert.equal(result.ok, true)
      assert.equal(relayCalled, false)
    })

    it("should call relay verifier only for relay challenge type", () => {
      let relayCalled = false
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => { relayCalled = true; return true },
      })

      const result = verifier.verify(makeChallenge(), makeReceipt())
      assert.equal(result.ok, true)
      assert.equal(relayCalled, true)
    })
  })

  describe("response body hash determinism", () => {
    it("should produce consistent hash for same relay body", () => {
      const hashes: (Hex32 | undefined)[] = []
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      for (let i = 0; i < 3; i++) {
        const result = verifier.verify(makeChallenge(), makeReceipt())
        hashes.push(result.responseBodyHash)
      }

      assert.ok(hashes[0])
      assert.equal(hashes[0], hashes[1])
      assert.equal(hashes[1], hashes[2])
    })

    it("should produce different hash for different relay body", () => {
      const verifier = new ReceiptVerifier({
        verifyChallengerSig: () => true,
        verifyNodeSig: () => true,
        verifyRelayResult: () => true,
      })

      const r1 = verifier.verify(makeChallenge(), makeReceipt())
      const r2 = verifier.verify(
        makeChallenge(),
        makeReceipt({ responseBody: { relayResult: { different: "data" } } }),
      )

      assert.ok(r1.responseBodyHash)
      assert.ok(r2.responseBodyHash)
      assert.notEqual(r1.responseBodyHash, r2.responseBodyHash)
    })
  })
})
