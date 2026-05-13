import test from "node:test"
import assert from "node:assert/strict"
import { ReceiptVerifier } from "./receipt-verifier.ts"
import { NonceRegistry } from "./nonce-registry.ts"
import type { ChallengeMessage, ReceiptMessage } from "../common/pose-types.ts"

const challenge: ChallengeMessage = {
  challengeId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  epochId: 1n,
  nodeId: "0x2222222222222222222222222222222222222222222222222222222222222222",
  challengeType: "U",
  nonce: "0x1234567890abcdef1234567890abcdef",
  randSeed: "0x3333333333333333333333333333333333333333333333333333333333333333",
  issuedAtMs: 1000n,
  deadlineMs: 2500,
  querySpec: { method: "eth_blockNumber" },
  challengerId: "0x4444444444444444444444444444444444444444444444444444444444444444",
  challengerSig: "0xabc",
}

const okReceipt: ReceiptMessage = {
  challengeId: challenge.challengeId,
  nodeId: challenge.nodeId,
  responseAtMs: 1200n,
  responseBody: { result: "0x10" },
  nodeSig: "0xdef",
}

test("receipt verifier accepts valid receipt", () => {
  const verifier = new ReceiptVerifier({
    verifyChallengerSig: () => true,
    verifyNodeSig: () => true,
    verifyUptimeResult: () => true,
  })

  const result = verifier.verify(challenge, okReceipt)
  assert.equal(result.ok, true)
  assert.equal(Boolean(result.responseBodyHash), true)
})

test("receipt verifier rejects timeout", () => {
  const verifier = new ReceiptVerifier({
    verifyChallengerSig: () => true,
    verifyNodeSig: () => true,
  })

  const bad: ReceiptMessage = { ...okReceipt, responseAtMs: 4000n }
  const result = verifier.verify(challenge, bad)
  assert.equal(result.ok, false)
  assert.equal(result.reason, "receipt timeout")
})

test("receipt verifier rejects response before challenge issuance", () => {
  const verifier = new ReceiptVerifier({
    verifyChallengerSig: () => true,
    verifyNodeSig: () => true,
  })

  const bad: ReceiptMessage = { ...okReceipt, responseAtMs: 900n }
  const result = verifier.verify(challenge, bad)
  assert.equal(result.ok, false)
  assert.equal(result.reason, "receipt timestamp before challenge issuance")
})

test("receipt verifier rejects nonce replay", () => {
  const verifier = new ReceiptVerifier({
    nonceRegistry: new NonceRegistry(),
    verifyChallengerSig: () => true,
    verifyNodeSig: () => true,
  })

  const first = verifier.verify(challenge, okReceipt)
  assert.equal(first.ok, true)

  const second = verifier.verify(challenge, okReceipt)
  assert.equal(second.ok, false)
  assert.equal(second.reason, "nonce replay detected")
})

test("#298: failed challenger-sig verify does NOT consume nonce (no poisoning)", () => {
  // Pre-fix the verifier consumed the nonce BEFORE verifying the
  // challenger signature. An attacker who submitted a (challenge,
  // receipt) pair with a forged sig could poison the nonce so a
  // legitimate challenger's later real receipt would get "nonce replay
  // detected." Currently the call sites are local-trusted but the
  // defensive ordering is fail-fast and survives future externally-
  // reachable receipt endpoints.
  let sigVerifyCalls = 0
  const nonceRegistry = new NonceRegistry()
  const verifier = new ReceiptVerifier({
    nonceRegistry,
    verifyChallengerSig: () => {
      sigVerifyCalls++
      // First call: bad sig (attacker's forged pair). Later calls: good.
      return sigVerifyCalls > 1
    },
    verifyNodeSig: () => true,
    verifyUptimeResult: () => true,
  })

  // Attempt 1: bad sig — must reject AND must NOT consume nonce.
  const attack = verifier.verify(challenge, okReceipt)
  assert.equal(attack.ok, false)
  assert.equal(attack.reason, "invalid challenger signature",
    "bad-sig must fail with sig reason, not nonce reason")

  // Attempt 2: same nonce + good sig — must succeed.
  // KEY invariant: nonce registry was not poisoned by the previous failed-sig attempt.
  const legit = verifier.verify(challenge, okReceipt)
  assert.equal(legit.ok, true,
    `legitimate receipt with same nonce must still succeed after bad-sig attempt; got ${JSON.stringify(legit)}`)

  // Attempt 3: same nonce a 3rd time — now nonce is legitimately consumed.
  const replay = verifier.verify(challenge, okReceipt)
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, "nonce replay detected",
    "3rd attempt with same nonce must hit replay detection (this is the legit nonce-protection path)")
})
