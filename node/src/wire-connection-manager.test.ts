import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { WireConnectionManager } from "./wire-connection-manager.ts"

describe("WireConnectionManager", () => {
  const baseCfg = { nodeId: "node-1", chainId: 1 }

  it("creates with default max connections", () => {
    const mgr = new WireConnectionManager(baseCfg)
    const stats = mgr.getStats()
    assert.equal(stats.total, 0)
    assert.equal(stats.connected, 0)
    assert.equal(stats.maxConnections, 25)
    mgr.stop()
  })

  it("respects custom max connections", () => {
    const mgr = new WireConnectionManager({ ...baseCfg, maxConnections: 3 })
    assert.equal(mgr.getStats().maxConnections, 3)
    mgr.stop()
  })

  it("rejects duplicate peer", () => {
    const mgr = new WireConnectionManager(baseCfg)
    // addPeer starts a connection attempt (will fail since no server)
    const first = mgr.addPeer("127.0.0.1", 29999)
    assert.equal(first, true)
    const second = mgr.addPeer("127.0.0.1", 29999)
    assert.equal(second, false)
    assert.equal(mgr.getStats().total, 1)
    mgr.stop()
  })

  it("enforces max connections limit", () => {
    const mgr = new WireConnectionManager({ ...baseCfg, maxConnections: 2 })
    assert.equal(mgr.addPeer("127.0.0.1", 29990), true)
    assert.equal(mgr.addPeer("127.0.0.1", 29991), true)
    assert.equal(mgr.addPeer("127.0.0.1", 29992), false)
    assert.equal(mgr.getStats().total, 2)
    mgr.stop()
  })

  it("removes peer", () => {
    const mgr = new WireConnectionManager(baseCfg)
    mgr.addPeer("127.0.0.1", 29993)
    assert.equal(mgr.removePeer("127.0.0.1", 29993), true)
    assert.equal(mgr.getStats().total, 0)
    assert.equal(mgr.removePeer("127.0.0.1", 29993), false) // already removed
    mgr.stop()
  })

  it("stop clears all connections", () => {
    const mgr = new WireConnectionManager(baseCfg)
    mgr.addPeer("127.0.0.1", 29994)
    mgr.addPeer("127.0.0.1", 29995)
    mgr.stop()
    assert.equal(mgr.getStats().total, 0)
  })

  it("getConnectedClients returns empty when no server available", () => {
    const mgr = new WireConnectionManager(baseCfg)
    mgr.addPeer("127.0.0.1", 29996)
    // No server → client won't connect → empty list
    assert.equal(mgr.getConnectedClients().length, 0)
    mgr.stop()
  })

  it("findByNodeId returns undefined when not connected", () => {
    const mgr = new WireConnectionManager(baseCfg)
    mgr.addPeer("127.0.0.1", 29997)
    assert.equal(mgr.findByNodeId("some-node"), undefined)
    mgr.stop()
  })

  it("broadcast returns 0 when no connected peers", () => {
    const mgr = new WireConnectionManager(baseCfg)
    mgr.addPeer("127.0.0.1", 29998)
    const sent = mgr.broadcast(0x10, { test: true })
    assert.equal(sent, 0)
    mgr.stop()
  })
})
