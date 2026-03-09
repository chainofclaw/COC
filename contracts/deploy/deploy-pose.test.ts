import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { resolveDeployParams, validateDeployParams, deployPoSeManagerV2 } from "./deploy-pose.ts"

describe("deploy-pose", () => {
  it("resolves L1 mainnet config", () => {
    const params = resolveDeployParams("l1-mainnet")
    assert.equal(params.chainId, 1)
    assert.equal(params.confirmations, 3)
    assert.equal(params.gasStrategy, "eip1559")
    assert.equal(params.slashBurnBps, 5000)
  })

  it("resolves L1 sepolia config", () => {
    const params = resolveDeployParams("l1-sepolia")
    assert.equal(params.chainId, 11155111)
    assert.equal(params.confirmations, 2)
  })

  it("resolves L2 COC config", () => {
    const params = resolveDeployParams("l2-coc")
    assert.equal(params.chainId, 18780)
    assert.equal(params.gasStrategy, "legacy")
    assert.equal(params.confirmations, 1)
  })

  it("resolves L2 arbitrum config", () => {
    const params = resolveDeployParams("l2-arbitrum")
    assert.equal(params.chainId, 42161)
  })

  it("resolves L2 optimism config", () => {
    const params = resolveDeployParams("l2-optimism")
    assert.equal(params.chainId, 10)
  })

  it("validates correct params", () => {
    const params = resolveDeployParams("l1-mainnet")
    const errors = validateDeployParams(params)
    assert.equal(errors.length, 0)
  })

  it("validates slash distribution sums to 10000", () => {
    const params = resolveDeployParams("l1-mainnet")
    const errors = validateDeployParams({ ...params, slashBurnBps: 1000 })
    assert.ok(errors.some(e => e.includes("slash distribution")))
  })

  it("rejects invalid chainId", () => {
    const params = resolveDeployParams("l1-mainnet")
    const errors = validateDeployParams({ ...params, chainId: 0 })
    assert.ok(errors.some(e => e.includes("chainId")))
  })

  it("throws on unknown target", () => {
    assert.throws(
      () => resolveDeployParams("unknown" as "l1-mainnet"),
      { message: /unknown deploy target/ },
    )
  })

  it("deployPoSeManagerV2 rejects without private key", async () => {
    const origPk = process.env.DEPLOYER_PRIVATE_KEY
    delete process.env.DEPLOYER_PRIVATE_KEY
    try {
      await assert.rejects(
        () => deployPoSeManagerV2("l2-coc", [], "0x", undefined),
        { message: /DEPLOYER_PRIVATE_KEY/ },
      )
    } finally {
      if (origPk !== undefined) process.env.DEPLOYER_PRIVATE_KEY = origPk
    }
  })

  it("deployPoSeManagerV2 rejects invalid private key format", async () => {
    await assert.rejects(
      () => deployPoSeManagerV2(
        "l2-coc",
        [],
        "0x",
        "0xdead",
      ),
      /invalid|private key|hex|BytesLike/i,
    )
  })

  it("deployPoSeManagerV2 rejects malformed bytecode before deployment", async () => {
    await assert.rejects(
      () => deployPoSeManagerV2(
        "l2-coc",
        [],
        "0xzz",
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ),
      /invalid|hex|BytesLike/i,
    )
  })

  it("deployPoSeManagerV2 exposes the public 4-argument interface", () => {
    assert.equal(typeof deployPoSeManagerV2, "function")
    assert.equal(deployPoSeManagerV2.length, 4)
  })
})
