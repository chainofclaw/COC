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

  // Phase C1.2: requestBlockFromAny. Exercises the "first-success"
  // fan-out against a mock WireClient pool, so we don't need a real TCP
  // server. We poke the private connections map directly via the typed
  // surface — ugly but keeps the test focused on fan-out semantics.

  it("requestBlockFromAny resolves with the first non-null bytes", async () => {
    const mgr = new WireConnectionManager(baseCfg)
    // Inject mock clients keyed by nodeId.
    const mk = (id: string, bytes: Uint8Array | null, delayMs: number) => ({
      isConnected: () => true,
      getRemoteNodeId: () => id,
      requestBlock: async () => {
        await new Promise((r) => setTimeout(r, delayMs))
        return bytes
      },
      disconnect: () => {},
    }) as unknown as import("./wire-client.ts").WireClient

    // @ts-expect-error private map access for test wiring
    mgr.connections.set("a", { client: mk("peer-a", null, 50), host: "h", port: 1, connectedAtMs: 0 })
    // @ts-expect-error
    mgr.connections.set("b", { client: mk("peer-b", new Uint8Array([9, 9]), 10), host: "h", port: 2, connectedAtMs: 0 })
    // @ts-expect-error
    mgr.connections.set("c", { client: mk("peer-c", new Uint8Array([7, 7]), 200), host: "h", port: 3, connectedAtMs: 0 })

    const t0 = Date.now()
    const out = await mgr.requestBlockFromAny(["peer-a", "peer-b", "peer-c"], "0xcid", { concurrency: 3 })
    const elapsed = Date.now() - t0
    assert.ok(out, "some peer should have returned bytes")
    // peer-b is the fastest non-null responder at ~10ms, so result is its payload.
    assert.deepEqual(Array.from(out!), [9, 9])
    // And we didn't wait for peer-c's 200ms response.
    assert.ok(elapsed < 150, `elapsed=${elapsed}ms, should abort on first hit`)
    mgr.stop()
  })

  it("requestBlockFromAny returns null when all peers miss", async () => {
    const mgr = new WireConnectionManager(baseCfg)
    const mk = (id: string) => ({
      isConnected: () => true,
      getRemoteNodeId: () => id,
      requestBlock: async () => null,
      disconnect: () => {},
    }) as unknown as import("./wire-client.ts").WireClient
    // @ts-expect-error
    mgr.connections.set("a", { client: mk("peer-a"), host: "h", port: 1, connectedAtMs: 0 })
    // @ts-expect-error
    mgr.connections.set("b", { client: mk("peer-b"), host: "h", port: 2, connectedAtMs: 0 })

    const out = await mgr.requestBlockFromAny(["peer-a", "peer-b"], "0xcid")
    assert.equal(out, null)
    mgr.stop()
  })

  it("requestBlockFromAny skips disconnected peers and tries next", async () => {
    const mgr = new WireConnectionManager(baseCfg)
    const mkDisconnected = (id: string) => ({
      isConnected: () => false,
      getRemoteNodeId: () => id,
      requestBlock: async () => new Uint8Array([1]),
      disconnect: () => {},
    }) as unknown as import("./wire-client.ts").WireClient
    const mkConnected = (id: string, bytes: Uint8Array) => ({
      isConnected: () => true,
      getRemoteNodeId: () => id,
      requestBlock: async () => bytes,
      disconnect: () => {},
    }) as unknown as import("./wire-client.ts").WireClient
    // @ts-expect-error
    mgr.connections.set("a", { client: mkDisconnected("peer-a"), host: "h", port: 1, connectedAtMs: null })
    // @ts-expect-error
    mgr.connections.set("b", { client: mkConnected("peer-b", new Uint8Array([42])), host: "h", port: 2, connectedAtMs: 0 })

    const out = await mgr.requestBlockFromAny(["peer-a", "peer-b"], "0xcid")
    assert.deepEqual(Array.from(out!), [42])
    mgr.stop()
  })

  it("requestBlockFromAny returns null for empty peer list", async () => {
    const mgr = new WireConnectionManager(baseCfg)
    const out = await mgr.requestBlockFromAny([], "0xcid")
    assert.equal(out, null)
    mgr.stop()
  })
})
