import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { allocateChallengerRewards } from "./epoch-finalizer.ts"

describe("allocateChallengerRewards", () => {
  it("single challenger gets full share", () => {
    const rewards = allocateChallengerRewards(
      [{ challenger: "0xAAA", challengeCount: 10, validReceiptCount: 10 }],
      1000000n, // 1M wei pool
      500, // 5%
    )
    assert.equal(rewards.size, 1)
    assert.equal(rewards.get("0xAAA"), 50000n) // 5% of 1M
  })

  it("multiple challengers split proportionally", () => {
    const rewards = allocateChallengerRewards(
      [
        { challenger: "0xAAA", challengeCount: 30, validReceiptCount: 30 },
        { challenger: "0xBBB", challengeCount: 70, validReceiptCount: 70 },
      ],
      1000000n,
      1000, // 10%
    )
    assert.equal(rewards.size, 2)
    // 0xAAA: 30% of 100000 = 30000
    assert.equal(rewards.get("0xAAA"), 30000n)
    // 0xBBB gets remainder
    assert.equal(rewards.get("0xBBB"), 70000n)
  })

  it("returns empty map for no batches", () => {
    const rewards = allocateChallengerRewards([], 1000000n)
    assert.equal(rewards.size, 0)
  })

  it("returns empty map for zero reward pool", () => {
    const rewards = allocateChallengerRewards(
      [{ challenger: "0xAAA", challengeCount: 10, validReceiptCount: 10 }],
      0n,
    )
    assert.equal(rewards.size, 0)
  })

  it("aggregates multiple batches from same challenger", () => {
    const rewards = allocateChallengerRewards(
      [
        { challenger: "0xAAA", challengeCount: 5, validReceiptCount: 5 },
        { challenger: "0xAAA", challengeCount: 5, validReceiptCount: 5 },
        { challenger: "0xBBB", challengeCount: 10, validReceiptCount: 10 },
      ],
      2000000n,
      500,
    )
    assert.equal(rewards.size, 2)
    // 0xAAA has 10 out of 20 = 50% of 100000 = 50000
    assert.equal(rewards.get("0xAAA"), 50000n)
  })

  it("handles default challengerShareBps of 500 (5%)", () => {
    const rewards = allocateChallengerRewards(
      [{ challenger: "0xAAA", challengeCount: 1, validReceiptCount: 1 }],
      10000n,
    )
    assert.equal(rewards.get("0xAAA"), 500n) // 5% of 10000
  })
})
