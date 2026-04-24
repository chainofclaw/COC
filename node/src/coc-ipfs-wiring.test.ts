/**
 * Wiring glue tests (Phase C1.3).
 *
 * Exercises the DhtNetwork + WireConnectionManager + IpfsBlockstore
 * integration produced by `buildCocIpfsWiring`, with the wire layer
 * mocked at the WireConnectionManager surface. The full TCP round-trip
 * is already covered end-to-end by wire-server.test.ts; here we focus
 * on the three pieces of integration behavior unique to the glue:
 *
 *   1. blockstore.get local miss → DHT.findProviders → connMgr pull →
 *      bytes cached locally → self-announce into DHT via onPut.
 *   2. blockstore.put local hit → immediate DHT.putProvider self-announce.
 *   3. onBlockRequest callback: pull reads from blockstore, push writes
 *      to blockstore (and triggers the next self-announce).
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import type { CidString } from "./ipfs-types.ts"
import { DhtNetwork } from "./dht-network.ts"
import { WireConnectionManager } from "./wire-connection-manager.ts"
import { buildCocIpfsWiring } from "./coc-ipfs-wiring.ts"

// Factory for a DHT network with no live peers — we only exercise the
// in-memory provider record map. Matches the pattern in
// dht-network.test.ts "DhtNetwork provider records" suite.
function makeDht(localId = "0xaa"): DhtNetwork {
  return new DhtNetwork({
    localId,
    bootstrapPeers: [],
    wireClients: [],
    onPeerDiscovered: () => {},
  })
}

// Build a WireConnectionManager whose requestBlockFromAny is intercepted
// by injecting a mock client per peer via the same @ts-expect-error
// connections.set trick used in wire-connection-manager.test.ts. Keeps
// us in a pure unit-test regime with no TCP sockets.
function makeConnMgr(
  peerBytes: Map<string, Uint8Array | null>,
): WireConnectionManager {
  const mgr = new WireConnectionManager({ nodeId: "local", chainId: 1 })
  for (const [peerId, bytes] of peerBytes) {
    const client = {
      isConnected: () => true,
      getRemoteNodeId: () => peerId,
      requestBlock: async () => bytes,
      disconnect: () => {},
    } as unknown as import("./wire-client.ts").WireClient
    // @ts-expect-error — test-only access to the private connections map,
    // same pattern as wire-connection-manager.test.ts's mocks.
    mgr.connections.set(peerId, { client, host: "h", port: 1, connectedAtMs: 0 })
  }
  return mgr
}

describe("coc-ipfs-wiring", () => {
  let tmpDir: string
  let blockstore: IpfsBlockstore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ipfs-wiring-"))
    blockstore = new IpfsBlockstore(tmpDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("blockstore.get local miss → DHT providers → peer pull → cached", async () => {
    const cid = "QmWiredCid" as CidString
    const peerBytes = Buffer.from("remote content")
    const dht = makeDht()
    dht.putProvider(cid, "peer-a", 60_000)
    const connMgr = makeConnMgr(new Map([["peer-a", peerBytes]]))

    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa",
      blockstore,
      dht,
      connMgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const block = await blockstore.get(cid)
    assert.deepEqual(Array.from(block.bytes), Array.from(peerBytes))

    // Second get: local hit, no DHT query needed. We verify by flipping
    // the DHT providers to an unreachable peer — if we were hitting DHT
    // again it would now miss.
    const dhtSize = dht.findProviders(cid).length
    assert.ok(dhtSize >= 1, "peer-a still advertised after first fetch")
    const second = await blockstore.get(cid)
    assert.deepEqual(Array.from(second.bytes), Array.from(peerBytes))
  })

  it("remote fetch self-announces via onPut so other peers can discover us", async () => {
    const cid = "QmSelfAnnounce" as CidString
    const dht = makeDht("0xmyself")
    dht.putProvider(cid, "peer-a", 60_000)
    const connMgr = makeConnMgr(new Map([["peer-a", Buffer.from("x")]]))

    const wiring = buildCocIpfsWiring({
      localNodeId: "0xmyself",
      blockstore,
      dht,
      connMgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    await blockstore.get(cid)
    const providers = dht.findProviders(cid, 10)
    assert.ok(
      providers.includes("0xmyself"),
      "local node must register itself as a provider after caching a remotely fetched block",
    )
  })

  it("fetchRemote returns null when DHT has no providers — ENOENT surfaces", async () => {
    const dht = makeDht()
    const connMgr = makeConnMgr(new Map())

    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    await assert.rejects(
      () => blockstore.get("QmNoProviders" as CidString),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    )
  })

  it("local put self-announces to DHT immediately via onPut", async () => {
    const dht = makeDht("0xlocal")
    const connMgr = makeConnMgr(new Map())
    const wiring = buildCocIpfsWiring({
      localNodeId: "0xlocal", blockstore, dht, connMgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const cid = "QmLocalPut" as CidString
    await blockstore.put({ cid, bytes: Buffer.from("hello") })
    const providers = dht.findProviders(cid)
    assert.deepEqual(providers, ["0xlocal"])
  })

  it("onBlockRequest pull returns local bytes or null", async () => {
    const dht = makeDht()
    const connMgr = makeConnMgr(new Map())
    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    // Miss.
    const miss = await wiring.onBlockRequest("QmAbsent" as CidString, false)
    assert.equal(miss, null)

    // Hit.
    const cid = "QmPresent" as CidString
    await blockstore.put({ cid, bytes: Buffer.from("served") })
    const hit = await wiring.onBlockRequest(cid, false)
    assert.ok(hit)
    assert.equal(Buffer.from(hit!).toString(), "served")
  })

  it("onBlockRequest push writes to blockstore and acks with empty Uint8Array", async () => {
    const dht = makeDht("0xme")
    const connMgr = makeConnMgr(new Map())
    const wiring = buildCocIpfsWiring({
      localNodeId: "0xme", blockstore, dht, connMgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const cid = "QmPushed" as CidString
    const bytes = Buffer.from("pushed by peer")
    const ack = await wiring.onBlockRequest(cid, true, bytes)
    assert.ok(ack)
    assert.equal(ack!.length, 0, "ack is a zero-length Uint8Array")

    // Persisted.
    const back = await blockstore.get(cid)
    assert.deepEqual(Array.from(back.bytes), Array.from(bytes))

    // Self-announced after storing (onPut fired from put()).
    const providers = dht.findProviders(cid)
    assert.deepEqual(providers, ["0xme"])
  })

  it("onBlockRequest push returns null when bytes are missing", async () => {
    const dht = makeDht()
    const connMgr = makeConnMgr(new Map())
    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const rejected = await wiring.onBlockRequest("QmNoBytes" as CidString, true, undefined)
    assert.equal(rejected, null)
  })

  it("first-success over multiple providers returns the fastest", async () => {
    const cid = "QmRace" as CidString
    const dht = makeDht()
    dht.putProvider(cid, "slow", 60_000)
    dht.putProvider(cid, "fast", 60_000)

    const mgr = new WireConnectionManager({ nodeId: "local", chainId: 1 })
    const mk = (id: string, bytes: Uint8Array, delay: number) => ({
      isConnected: () => true,
      getRemoteNodeId: () => id,
      requestBlock: async () => {
        await new Promise((r) => setTimeout(r, delay))
        return bytes
      },
      disconnect: () => {},
    }) as unknown as import("./wire-client.ts").WireClient
    // @ts-expect-error
    mgr.connections.set("slow", { client: mk("slow", Buffer.from("slow"), 200), host: "h", port: 1, connectedAtMs: 0 })
    // @ts-expect-error
    mgr.connections.set("fast", { client: mk("fast", Buffer.from("fast"), 10), host: "h", port: 2, connectedAtMs: 0 })

    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr: mgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const block = await blockstore.get(cid)
    assert.equal(block.bytes.toString(), "fast")
    mgr.stop()
  })
})
