import test from "node:test"
import assert from "node:assert/strict"
import { Wallet } from "ethers"
import {
  createNodeSigner,
  buildChallengeSignMessage,
  buildReceiptSignMessage,
} from "./signer.ts"

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const TEST_PK2 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

test("createNodeSigner returns correct nodeId", () => {
  const signer = createNodeSigner(TEST_PK)
  const expected = new Wallet(TEST_PK).address.toLowerCase()
  assert.equal(signer.nodeId, expected)
})

test("sign and verify round-trip succeeds", () => {
  const signer = createNodeSigner(TEST_PK)
  const message = "test message"
  const signature = signer.sign(message)

  assert.equal(signer.verifyNodeSig(message, signature, signer.nodeId), true)
})

test("verify rejects wrong address", () => {
  const signer = createNodeSigner(TEST_PK)
  const message = "test message"
  const signature = signer.sign(message)

  const wrongAddress = new Wallet(TEST_PK2).address
  assert.equal(signer.verifyNodeSig(message, signature, wrongAddress), false)
})

test("verify rejects tampered message", () => {
  const signer = createNodeSigner(TEST_PK)
  const signature = signer.sign("original")

  assert.equal(signer.verifyNodeSig("tampered", signature, signer.nodeId), false)
})

test("recoverAddress returns signer address", () => {
  const signer = createNodeSigner(TEST_PK)
  const message = "recover test"
  const signature = signer.sign(message)
  const recovered = signer.recoverAddress(message, signature)

  assert.equal(recovered, signer.nodeId)
})

test("signBytes produces verifiable signature", () => {
  const signer = createNodeSigner(TEST_PK)
  const data = new Uint8Array([1, 2, 3, 4, 5])
  const signature = signer.signBytes(data)

  assert.ok(signature.startsWith("0x"))
  assert.ok(signature.length > 10)
})

test("two different keys produce different signatures", () => {
  const signer1 = createNodeSigner(TEST_PK)
  const signer2 = createNodeSigner(TEST_PK2)
  const message = "same message"

  const sig1 = signer1.sign(message)
  const sig2 = signer2.sign(message)

  assert.notEqual(sig1, sig2)
})

test("nodeId is consistent with ethers Wallet address", () => {
  const signer = createNodeSigner(TEST_PK)
  const wallet = new Wallet(TEST_PK)
  assert.equal(signer.nodeId, wallet.address.toLowerCase())
})

test("buildChallengeSignMessage produces deterministic output", () => {
  const msg1 = buildChallengeSignMessage("0xabc", 1n, "0x123")
  const msg2 = buildChallengeSignMessage("0xabc", 1n, "0x123")
  assert.equal(msg1, msg2)
  assert.equal(msg1, "pose:challenge:0xabc:1:0x123")
})

test("buildReceiptSignMessage produces deterministic output", () => {
  const msg = buildReceiptSignMessage("0xabc", "0x123", "0xhash")
  assert.equal(msg, "pose:receipt:0xabc:0x123:0xhash")
  const msgWithTs = buildReceiptSignMessage("0xabc", "0x123", "0xhash", 1234567890n)
  assert.equal(msgWithTs, "pose:receipt:0xabc:0x123:0xhash:1234567890")
})

test("verify returns false for invalid signature format", () => {
  const signer = createNodeSigner(TEST_PK)
  assert.equal(signer.verifyNodeSig("msg", "invalid-sig", signer.nodeId), false)
})
