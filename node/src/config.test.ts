import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { validateConfig } from "./config.ts"

describe("validateConfig", () => {
  it("returns no errors for valid partial config", () => {
    const errors = validateConfig({
      chainId: 18780,
      rpcPort: 8545,
      blockTimeMs: 3000,
      validators: ["node-1"],
    })
    assert.equal(errors.length, 0)
  })

  it("returns no errors for empty config (all defaults)", () => {
    assert.equal(validateConfig({}).length, 0)
  })

  it("rejects non-positive chainId", () => {
    assert.ok(validateConfig({ chainId: 0 }).length > 0)
    assert.ok(validateConfig({ chainId: -1 }).length > 0)
    assert.ok(validateConfig({ chainId: 1.5 }).length > 0)
  })

  it("rejects out-of-range ports", () => {
    assert.ok(validateConfig({ rpcPort: 0 }).length > 0)
    assert.ok(validateConfig({ rpcPort: 70000 }).length > 0)
    assert.ok(validateConfig({ wsPort: -1 }).length > 0)
    assert.ok(validateConfig({ p2pPort: 99999 }).length > 0)
    assert.ok(validateConfig({ ipfsPort: 0 }).length > 0)
  })

  it("accepts valid port range", () => {
    assert.equal(validateConfig({ rpcPort: 1 }).length, 0)
    assert.equal(validateConfig({ rpcPort: 65535 }).length, 0)
    assert.equal(validateConfig({ wsPort: 8080 }).length, 0)
  })

  it("rejects too-small blockTimeMs", () => {
    assert.ok(validateConfig({ blockTimeMs: 50 }).length > 0)
    assert.equal(validateConfig({ blockTimeMs: 100 }).length, 0)
  })

  it("rejects too-small syncIntervalMs", () => {
    assert.ok(validateConfig({ syncIntervalMs: 0 }).length > 0)
    assert.equal(validateConfig({ syncIntervalMs: 100 }).length, 0)
  })

  it("rejects non-positive finalityDepth", () => {
    assert.ok(validateConfig({ finalityDepth: 0 }).length > 0)
    assert.equal(validateConfig({ finalityDepth: 1 }).length, 0)
  })

  it("rejects non-positive maxTxPerBlock", () => {
    assert.ok(validateConfig({ maxTxPerBlock: 0 }).length > 0)
    assert.equal(validateConfig({ maxTxPerBlock: 1 }).length, 0)
  })

  it("rejects empty validators array", () => {
    assert.ok(validateConfig({ validators: [] }).length > 0)
    assert.equal(validateConfig({ validators: ["v1"] }).length, 0)
  })

  it("validates prefund addresses", () => {
    assert.ok(validateConfig({ prefund: [{ address: "invalid", balanceEth: "10" }] }).length > 0)
    assert.equal(
      validateConfig({ prefund: [{ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", balanceEth: "10" }] }).length,
      0,
    )
  })

  it("validates storage config", () => {
    assert.ok(validateConfig({ storage: { backend: "redis" as any, leveldbDir: "", cacheSize: 0, enablePruning: false, nonceRetentionDays: 1 } }).length > 0)
    assert.ok(validateConfig({ storage: { backend: "leveldb", leveldbDir: "", cacheSize: -1, enablePruning: false, nonceRetentionDays: 1 } }).length > 0)
    assert.ok(validateConfig({ storage: { backend: "leveldb", leveldbDir: "", cacheSize: 0, enablePruning: false, nonceRetentionDays: 0 } }).length > 0)
  })

  it("accumulates multiple errors", () => {
    const errors = validateConfig({
      chainId: -1,
      rpcPort: 0,
      blockTimeMs: 10,
      validators: [],
    })
    assert.ok(errors.length >= 4)
  })
})
