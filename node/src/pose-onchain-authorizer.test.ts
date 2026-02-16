import test from "node:test"
import assert from "node:assert/strict"
import { createOnchainOperatorResolver } from "./pose-onchain-authorizer.ts"

test("returns false for invalid senderId without querying contract", async () => {
  let calls = 0
  const resolver = createOnchainOperatorResolver({
    rpcUrl: "http://unused",
    poseManagerAddress: "0x0000000000000000000000000000000000000001",
    operatorNodeCountFn: async () => {
      calls += 1
      return 1
    },
  })
  assert.equal(await resolver("not-an-address"), false)
  assert.equal(calls, 0)
})

test("accepts operator when on-chain operatorNodeCount >= threshold", async () => {
  const resolver = createOnchainOperatorResolver({
    rpcUrl: "http://unused",
    poseManagerAddress: "0x0000000000000000000000000000000000000001",
    minOperatorNodes: 1,
    operatorNodeCountFn: async () => 2,
  })
  assert.equal(await resolver("0x0000000000000000000000000000000000000002"), true)
})

test("rejects operator when operatorNodeCount below threshold", async () => {
  const resolver = createOnchainOperatorResolver({
    rpcUrl: "http://unused",
    poseManagerAddress: "0x0000000000000000000000000000000000000001",
    minOperatorNodes: 2,
    operatorNodeCountFn: async () => 1,
  })
  assert.equal(await resolver("0x0000000000000000000000000000000000000002"), false)
})

test("throws on invalid resolver config", async () => {
  assert.throws(() => {
    createOnchainOperatorResolver({
      rpcUrl: "",
      poseManagerAddress: "0x0000000000000000000000000000000000000001",
    })
  }, /missing rpcUrl|invalid rpcUrl/)

  assert.throws(() => {
    createOnchainOperatorResolver({
      rpcUrl: "http://unused",
      poseManagerAddress: "not-an-address",
    })
  }, /invalid poseManagerAddress/)
})

test("times out long on-chain queries", async () => {
  const resolver = createOnchainOperatorResolver({
    rpcUrl: "http://unused",
    poseManagerAddress: "0x0000000000000000000000000000000000000001",
    timeoutMs: 100,
    operatorNodeCountFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return 1
    },
  })

  await assert.rejects(async () => {
    await resolver("0x0000000000000000000000000000000000000002")
  }, /timeout/)
})
