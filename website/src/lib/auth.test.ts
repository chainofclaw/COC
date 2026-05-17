import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { Wallet } from "ethers"

const {
  buildSignMessage,
  clearConsumedSignaturesForTests,
  consumeSignedAction,
  parseSignMessage,
  verifySignedAction,
} = await import("./auth." + "ts")

describe("signed action auth", () => {
  beforeEach(() => {
    clearConsumedSignaturesForTests()
  })

  it("builds and parses canonical signed action messages", () => {
    const message = buildSignMessage("vote", { type: "up", id: 7, target: "post", timestamp: 10 })

    assert.equal(message, 'COC Forum vote\n{"id":7,"target":"post","timestamp":10,"type":"up"}')
    assert.deepEqual(parseSignMessage(message), {
      action: "vote",
      data: { id: 7, target: "post", timestamp: 10, type: "up" },
    })
  })

  it("rejects a signature replayed across actions", async () => {
    const wallet = Wallet.createRandom()
    const now = Date.now()
    const message = buildSignMessage("vote", { target: "post", id: 7, type: "up", timestamp: now })
    const signature = await wallet.signMessage(message)

    assert.equal(
      verifySignedAction({
        action: "createPost",
        address: wallet.address,
        signature,
        message,
        expected: { title: "Hello", content: "Body", category: "general" },
        nowMs: now,
      }),
      false,
    )
  })

  it("rejects a signature replayed with changed request fields", async () => {
    const wallet = Wallet.createRandom()
    const now = Date.now()
    const message = buildSignMessage("createPost", {
      title: "Original",
      content: "Body",
      category: "general",
      timestamp: now,
    })
    const signature = await wallet.signMessage(message)

    assert.equal(
      verifySignedAction({
        action: "createPost",
        address: wallet.address,
        signature,
        message,
        expected: { title: "Edited", content: "Body", category: "general" },
        nowMs: now,
      }),
      false,
    )
  })

  it("rejects expired signatures", async () => {
    const wallet = Wallet.createRandom()
    const message = buildSignMessage("identityRegister", {
      address: wallet.address.toLowerCase(),
      faction: "human",
      timestamp: 1_000,
    })
    const signature = await wallet.signMessage(message)

    assert.equal(
      verifySignedAction({
        action: "identityRegister",
        address: wallet.address,
        signature,
        message,
        expected: { address: wallet.address.toLowerCase(), faction: "human" },
        nowMs: 1_000 + 5 * 60 * 1000 + 1,
      }),
      false,
    )
  })

  it("consumes exact signatures once per process", async () => {
    const wallet = Wallet.createRandom()
    const now = Date.now()
    const message = buildSignMessage("vote", { target: "reply", id: 3, type: "down", timestamp: now })
    const signature = await wallet.signMessage(message)
    const payload = {
      action: "vote",
      address: wallet.address,
      signature,
      message,
      expected: { target: "reply", id: 3, type: "down" },
      nowMs: now,
    }

    assert.equal(consumeSignedAction(payload), true)
    assert.equal(consumeSignedAction(payload), false)
  })
})
