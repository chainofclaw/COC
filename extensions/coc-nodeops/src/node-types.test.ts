import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { NODE_TYPE_PRESETS, NODE_TYPE_LABELS, isValidNodeType } from "./node-types.ts"
import type { NodeType } from "./node-types.ts"

describe("node-types", () => {
  it("defines all 5 node types", () => {
    const types: NodeType[] = ["validator", "fullnode", "archive", "gateway", "dev"]
    for (const t of types) {
      assert.ok(NODE_TYPE_PRESETS[t], `Missing preset for ${t}`)
      assert.ok(NODE_TYPE_LABELS[t], `Missing label for ${t}`)
      assert.ok(NODE_TYPE_PRESETS[t].description.length > 0)
      assert.ok(NODE_TYPE_PRESETS[t].services.length > 0)
    }
  })

  it("validator enables BFT, wire, DHT, snap sync", () => {
    const v = NODE_TYPE_PRESETS.validator
    assert.strictEqual(v.configOverrides.enableBft, true)
    assert.strictEqual(v.configOverrides.enableWireProtocol, true)
    assert.strictEqual(v.configOverrides.enableDht, true)
    assert.strictEqual(v.configOverrides.enableSnapSync, true)
    assert.deepStrictEqual(v.services, ["node", "agent"])
  })

  it("fullnode disables BFT, clears validators", () => {
    const f = NODE_TYPE_PRESETS.fullnode
    assert.strictEqual(f.configOverrides.enableBft, false)
    assert.deepStrictEqual(f.configOverrides.validators, [])
    assert.deepStrictEqual(f.services, ["node"])
  })

  it("archive disables pruning", () => {
    const a = NODE_TYPE_PRESETS.archive
    const storage = a.configOverrides.storage as Record<string, unknown>
    assert.strictEqual(storage.enablePruning, false)
  })

  it("gateway uses memory backend and disables all protocols", () => {
    const g = NODE_TYPE_PRESETS.gateway
    const storage = g.configOverrides.storage as Record<string, unknown>
    assert.strictEqual(storage.backend, "memory")
    assert.strictEqual(g.configOverrides.enableBft, false)
    assert.strictEqual(g.configOverrides.enableWireProtocol, false)
    assert.strictEqual(g.configOverrides.enableDht, false)
  })

  it("dev uses single-node validator with test prefund", () => {
    const d = NODE_TYPE_PRESETS.dev
    assert.deepStrictEqual(d.configOverrides.validators, ["dev-node"])
    const prefund = d.configOverrides.prefund as Array<{ address: string }>
    assert.ok(prefund.length >= 3)
    assert.ok(prefund[0].address.startsWith("0x"))
  })

  it("isValidNodeType validates correctly", () => {
    assert.strictEqual(isValidNodeType("validator"), true)
    assert.strictEqual(isValidNodeType("fullnode"), true)
    assert.strictEqual(isValidNodeType("archive"), true)
    assert.strictEqual(isValidNodeType("gateway"), true)
    assert.strictEqual(isValidNodeType("dev"), true)
    assert.strictEqual(isValidNodeType("unknown"), false)
    assert.strictEqual(isValidNodeType(""), false)
  })
})
