import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { NETWORK_PRESETS, NETWORK_LABELS, isValidNetworkId, getNetworkPreset } from "./network-presets.ts"
import type { NetworkId } from "./network-presets.ts"

describe("network-presets", () => {
  it("defines testnet, mainnet, local presets", () => {
    const ids: Array<Exclude<NetworkId, "custom">> = ["testnet", "mainnet", "local"]
    for (const id of ids) {
      const preset = NETWORK_PRESETS[id]
      assert.ok(preset, `Missing preset for ${id}`)
      assert.ok(typeof preset.chainId === "number")
      assert.ok(Array.isArray(preset.bootstrapPeers))
      assert.ok(typeof preset.rpcPort === "number")
    }
  })

  it("testnet has correct chainId and bootstrap peers", () => {
    const t = NETWORK_PRESETS.testnet
    assert.strictEqual(t.chainId, 18780)
    assert.ok(t.bootstrapPeers.length > 0)
    assert.ok(t.dhtBootstrapPeers.length > 0)
  })

  it("local has localhost defaults", () => {
    const l = NETWORK_PRESETS.local
    assert.strictEqual(l.chainId, 18780)
    assert.strictEqual(l.rpcPort, 18780)
    assert.strictEqual(l.p2pPort, 19780)
    assert.strictEqual(l.wirePort, 19781)
  })

  it("mainnet is placeholder with chainId 1", () => {
    const m = NETWORK_PRESETS.mainnet
    assert.strictEqual(m.chainId, 1)
    assert.strictEqual(m.bootstrapPeers.length, 0)
  })

  it("labels cover all network ids", () => {
    const allIds: NetworkId[] = ["testnet", "mainnet", "local", "custom"]
    for (const id of allIds) {
      assert.ok(NETWORK_LABELS[id], `Missing label for ${id}`)
    }
  })

  it("isValidNetworkId validates correctly", () => {
    assert.strictEqual(isValidNetworkId("testnet"), true)
    assert.strictEqual(isValidNetworkId("mainnet"), true)
    assert.strictEqual(isValidNetworkId("local"), true)
    assert.strictEqual(isValidNetworkId("custom"), true)
    assert.strictEqual(isValidNetworkId("devnet"), false)
    assert.strictEqual(isValidNetworkId(""), false)
  })

  it("getNetworkPreset returns correct preset", () => {
    const preset = getNetworkPreset("testnet")
    assert.strictEqual(preset.chainId, 18780)
  })
})
