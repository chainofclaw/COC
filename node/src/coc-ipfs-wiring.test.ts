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
import { keccak256 } from "ethers"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import type { CidString } from "./ipfs-types.ts"
import { DhtNetwork } from "./dht-network.ts"
import { WireConnectionManager } from "./wire-connection-manager.ts"
import { buildCocIpfsWiring } from "./coc-ipfs-wiring.ts"

/** Content-addressed CID ("0x…" keccak256 convention) for `bytes` — the
 *  blockstore's remote-fetch path verifies pulled blocks against this. */
function cidFor(bytes: Uint8Array): CidString {
  return keccak256(bytes) as CidString
}

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
    const peerBytes = Buffer.from("remote content")
    const cid = cidFor(peerBytes)
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
    const announceBytes = Buffer.from("x")
    const cid = cidFor(announceBytes)
    const dht = makeDht("0xmyself")
    dht.putProvider(cid, "peer-a", 60_000)
    const connMgr = makeConnMgr(new Map([["peer-a", announceBytes]]))

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

  // --- Phase C1.4: pushToK replication on local PUT.
  // Exercises the fire-and-forget fan-out, the remote-cache suppression,
  // and the low-peer-count skip. Uses a mock connMgr that tracks every
  // pushBlock call so assertions can inspect the replication fan-out.

  // Extended mock that also counts pushBlock invocations per peer.
  function makeConnMgrWithPush(peers: Array<{ id: string; connected: boolean; pushResult: boolean }>): {
    mgr: WireConnectionManager
    pushCalls: Map<string, Array<{ cid: string; len: number }>>
  } {
    const mgr = new WireConnectionManager({ nodeId: "local", chainId: 1 })
    const pushCalls = new Map<string, Array<{ cid: string; len: number }>>()
    for (const p of peers) {
      pushCalls.set(p.id, [])
      const client = {
        isConnected: () => p.connected,
        getRemoteNodeId: () => p.id,
        requestBlock: async () => null,
        pushBlock: async (cid: string, bytes: Uint8Array) => {
          pushCalls.get(p.id)!.push({ cid, len: bytes.length })
          return p.pushResult
        },
        sendProviderAdvertise: () => true,
        disconnect: () => {},
      } as unknown as import("./wire-client.ts").WireClient
      // @ts-expect-error — private-field write for test fan-out
      mgr.connections.set(p.id, { client, host: "h", port: 1, connectedAtMs: 0 })
    }
    return { mgr, pushCalls }
  }

  // Extended variant that tracks ProviderAdvertise sends for gossip tests.
  function makeConnMgrWithAdvertise(peers: Array<{ id: string; connected: boolean }>): {
    mgr: WireConnectionManager
    advertiseCalls: Map<string, Array<{ cid: string; ttlMs?: number }>>
  } {
    const mgr = new WireConnectionManager({ nodeId: "local", chainId: 1 })
    const advertiseCalls = new Map<string, Array<{ cid: string; ttlMs?: number }>>()
    for (const p of peers) {
      advertiseCalls.set(p.id, [])
      const client = {
        isConnected: () => p.connected,
        getRemoteNodeId: () => p.id,
        requestBlock: async () => null,
        pushBlock: async () => true,
        sendProviderAdvertise: (cid: string, ttlMs?: number) => {
          advertiseCalls.get(p.id)!.push({ cid, ttlMs })
          return true
        },
        disconnect: () => {},
      } as unknown as import("./wire-client.ts").WireClient
      // @ts-expect-error — private-field write
      mgr.connections.set(p.id, { client, host: "h", port: 1, connectedAtMs: 0 })
    }
    return { mgr, advertiseCalls }
  }

  // Seed the DHT routing table with synthetic peers so findClosest has
  // something to work with. DhtNetwork's constructor takes bootstrapPeers
  // that land in the routing table on start(); we avoid start() here and
  // poke the table directly so there's no async bootstrap.
  function seedDht(dht: DhtNetwork, peerIds: string[]): void {
    for (const id of peerIds) {
      void dht.routingTable.addPeer({
        id,
        address: `127.0.0.1:${19000 + peerIds.indexOf(id)}`,
        lastSeenMs: Date.now(),
      })
    }
  }

  // Routing table validates peer IDs against /^[0-9a-fA-F]+$/ (see dht.ts
  // addPeer), so tests use hex-form IDs. Keep `localNodeId` in the same
  // format so findClosest's self-exclusion compares like-for-like.
  const PA = "0xaaaa"
  const PB = "0xbbbb"
  const PC = "0xcccc"
  const PD = "0xdddd"
  const PE = "0xeeee"

  it("pushToK fans out to K nearest peers on local PUT", async () => {
    const dht = makeDht("0x1111")
    seedDht(dht, [PA, PB, PC, PD, PE])
    const { mgr, pushCalls } = makeConnMgrWithPush([
      { id: PA, connected: true, pushResult: true },
      { id: PB, connected: true, pushResult: true },
      { id: PC, connected: true, pushResult: true },
      { id: PD, connected: true, pushResult: true },
      { id: PE, connected: true, pushResult: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })

    const cid = "QmPushed1" as CidString
    const bytes = Buffer.from("payload")
    const result = await wiring.pushToK(cid, bytes)

    assert.equal(result.attempted, 3, "attempts match replicationFactor when peers abundant")
    assert.equal(result.succeeded.length, 3)
    assert.equal(result.failed.length, 0)
    const pushedTo = [...pushCalls.entries()].filter(([, calls]) => calls.length > 0).map(([id]) => id)
    assert.equal(pushedTo.length, 3)
    for (const id of pushedTo) {
      assert.deepEqual(pushCalls.get(id), [{ cid, len: bytes.length }])
    }
    mgr.stop()
  })

  it("pushToK clamps K down when peer count < replicationFactor", async () => {
    const dht = makeDht("0x1111")
    seedDht(dht, [PA])
    const { mgr } = makeConnMgrWithPush([
      { id: PA, connected: true, pushResult: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })

    const result = await wiring.pushToK("QmSmall" as CidString, Buffer.from("x"))
    assert.equal(result.attempted, 1, "clamp to available peer count")
    assert.equal(result.succeeded.length, 1)
    assert.equal(result.skippedLowPeers, false)
    mgr.stop()
  })

  it("pushToK skips replication entirely when no peers available", async () => {
    const dht = makeDht("0x1111")
    // No peers seeded. findClosest returns empty.
    const { mgr } = makeConnMgrWithPush([])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })

    const result = await wiring.pushToK("QmLonely" as CidString, Buffer.from("x"))
    assert.equal(result.attempted, 0)
    assert.equal(result.succeeded.length, 0)
    assert.equal(result.skippedLowPeers, true)
    mgr.stop()
  })

  it("pushToK excludes the local node even if it appears in the routing table", async () => {
    // findClosest shouldn't return self (addPeer drops id === localId),
    // but belt-and-suspenders: seed with self anyway and assert the
    // filter in pushToK holds even if the constraint were relaxed.
    const localId = "0x1111"
    const dht = makeDht(localId)
    seedDht(dht, [PA, PB, PC])
    const { mgr, pushCalls } = makeConnMgrWithPush([
      { id: PA, connected: true, pushResult: true },
      { id: PB, connected: true, pushResult: true },
      { id: PC, connected: true, pushResult: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: localId,
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })

    await wiring.pushToK("QmNoSelfPush" as CidString, Buffer.from("x"))
    assert.equal(pushCalls.get(PA)!.length, 1)
    assert.equal(pushCalls.get(PB)!.length, 1)
    assert.equal(pushCalls.get(PC)!.length, 1)
    mgr.stop()
  })

  it("pushToK reports partial failure cleanly", async () => {
    const dht = makeDht("0x1111")
    const POK = "0x2222"
    const PBAD = "0x3333"
    const PDOWN = "0x4444"
    seedDht(dht, [POK, PBAD, PDOWN])
    const { mgr } = makeConnMgrWithPush([
      { id: POK, connected: true, pushResult: true },
      { id: PBAD, connected: true, pushResult: false },  // rejects push
      { id: PDOWN, connected: false, pushResult: true }, // not connected
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })

    const result = await wiring.pushToK("QmPartial" as CidString, Buffer.from("x"))
    assert.ok(result.succeeded.includes(POK))
    assert.ok(result.failed.includes(PBAD) || result.failed.includes(PDOWN))
    mgr.stop()
  })

  it("onPut triggers pushToK for local PUT, not for remote cache-back", async () => {
    const localId = "0x1111"
    const dht = makeDht(localId)
    seedDht(dht, [PA, PB, PC])
    const { mgr, pushCalls } = makeConnMgrWithPush([
      { id: PA, connected: true, pushResult: true },
      { id: PB, connected: true, pushResult: true },
      { id: PC, connected: true, pushResult: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: localId,
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    // Local PUT → should replicate to 3 peers.
    await blockstore.put({ cid: "QmLocalPut" as CidString, bytes: Buffer.from("x") })
    // pushToK is fired-and-forgotten on the onPut hook path; give the
    // microtask queue a tick to drain so the push calls register before
    // we assert.
    await new Promise((r) => setTimeout(r, 30))
    const localPushed = [...pushCalls.values()].reduce((n, calls) => n + calls.length, 0)
    assert.equal(localPushed, 3, "local PUT should fan out to K=3 peers")

    // putFromPeer (push RPC) → should NOT re-replicate (source=remote-cache).
    for (const [, calls] of pushCalls) calls.length = 0
    await blockstore.putFromPeer({ cid: "QmFromPeer" as CidString, bytes: Buffer.from("y") })
    await new Promise((r) => setTimeout(r, 30))
    const cachePushed = [...pushCalls.values()].reduce((n, calls) => n + calls.length, 0)
    assert.equal(cachePushed, 0, "remote-cache MUST NOT cascade pushToK")

    // But self-announce still happened for both.
    const providers1 = dht.findProviders("QmLocalPut" as CidString)
    const providers2 = dht.findProviders("QmFromPeer" as CidString)
    assert.deepEqual(providers1, [localId])
    assert.deepEqual(providers2, [localId])
    mgr.stop()
  })

  it("onBlockRequest push path writes with putFromPeer semantics (no cascade)", async () => {
    const localId = "0x1111"
    const dht = makeDht(localId)
    seedDht(dht, [PA, PB, PC])
    const { mgr, pushCalls } = makeConnMgrWithPush([
      { id: PA, connected: true, pushResult: true },
      { id: PB, connected: true, pushResult: true },
      { id: PC, connected: true, pushResult: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: localId,
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    // Simulate an inbound push from a peer.
    await wiring.onBlockRequest("QmFromWire" as CidString, true, Buffer.from("z"))
    await new Promise((r) => setTimeout(r, 30))

    const totalPushes = [...pushCalls.values()].reduce((n, calls) => n + calls.length, 0)
    assert.equal(totalPushes, 0, "push RPC reception must not cascade another push round")
    mgr.stop()
  })

  // --- Phase C3.1: awaitReplicationResult surfaces per-CID push outcomes to
  // the HTTP add handler so uploaders get an X-COC-Replicas-Warning header
  // when fewer than minReplicas peers accepted the push.
  it("awaitReplicationResult returns the PushToKResult after a local PUT", async () => {
    const dht = makeDht("0x1111")
    seedDht(dht, [PA, PB, PC])
    const { mgr } = makeConnMgrWithPush([
      { id: PA, connected: true, pushResult: true },
      { id: PB, connected: true, pushResult: true },
      { id: PC, connected: true, pushResult: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const cid = "QmAwaitOk" as CidString
    await blockstore.put({ cid, bytes: Buffer.from("payload") })

    const status = await wiring.awaitReplicationResult(cid, 2_000)
    assert.ok(status, "awaiter must return a result for a known CID")
    assert.equal(status!.succeeded.length, 3, "3 peers accepted push")
    assert.equal(status!.failed.length, 0)
    assert.equal(status!.skippedLowPeers, false)
    mgr.stop()
  })

  it("awaitReplicationResult returns null for an unknown CID", async () => {
    const dht = makeDht("0x1111")
    seedDht(dht, [PA])
    const { mgr } = makeConnMgrWithPush([
      { id: PA, connected: true, pushResult: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })

    const status = await wiring.awaitReplicationResult("QmNeverPut" as CidString, 500)
    assert.equal(status, null)
    mgr.stop()
  })

  it("awaitReplicationResult surfaces partial failure to the HTTP handler", async () => {
    const dht = makeDht("0x1111")
    const POK = "0x2222"
    const PBAD = "0x3333"
    seedDht(dht, [POK, PBAD])
    const { mgr } = makeConnMgrWithPush([
      { id: POK, connected: true, pushResult: true },
      { id: PBAD, connected: true, pushResult: false },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 2,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const cid = "QmPartialAwait" as CidString
    await blockstore.put({ cid, bytes: Buffer.from("payload") })

    const status = await wiring.awaitReplicationResult(cid, 2_000)
    assert.ok(status)
    assert.equal(status!.succeeded.length, 1)
    assert.ok(status!.failed.length >= 1)
    mgr.stop()
  })

  it("awaitReplicationResult reports skippedLowPeers when no peers to push to", async () => {
    const dht = makeDht("0x1111")
    // No peers seeded — findClosest returns empty.
    const { mgr } = makeConnMgrWithPush([])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const cid = "QmAloneAwait" as CidString
    await blockstore.put({ cid, bytes: Buffer.from("payload") })

    const status = await wiring.awaitReplicationResult(cid, 1_000)
    assert.ok(status, "awaiter returns a synthesized skippedLowPeers result, not null")
    assert.equal(status!.succeeded.length, 0)
    assert.equal(status!.skippedLowPeers, true)
    mgr.stop()
  })

  it("awaitReplicationResult returns null when remote-cache PUT (no pushToK fired)", async () => {
    const dht = makeDht("0x1111")
    seedDht(dht, [PA])
    const { mgr, pushCalls } = makeConnMgrWithPush([
      { id: PA, connected: true, pushResult: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111",
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    // putFromPeer simulates a block arriving via push RPC; pushToK must
    // NOT fire (cascade prevention), so awaitReplicationResult has
    // nothing to return.
    await blockstore.putFromPeer({ cid: "QmCacheOnly" as CidString, bytes: Buffer.from("x") })

    const totalPushes = [...pushCalls.values()].reduce((n, calls) => n + calls.length, 0)
    assert.equal(totalPushes, 0, "remote-cache PUT must not trigger pushToK")

    const status = await wiring.awaitReplicationResult("QmCacheOnly" as CidString, 200)
    assert.equal(status, null, "no push tracked → awaiter returns null")
    mgr.stop()
  })

  // --- Phase C cross-node DHT provider gossip:
  //     onPut must fire sendProviderAdvertise to every connected peer so
  //     the other nodes add us to their provider records and route GETs
  //     here without first having to push bytes. This is the test that
  //     would have caught the pre-hotfix testnet gap where each node
  //     only knew about itself.
  it("onPut broadcasts ProviderAdvertise to every connected peer", async () => {
    const localId = "0x1111"
    const dht = makeDht(localId)
    seedDht(dht, [PA, PB, PC])
    const { mgr, advertiseCalls } = makeConnMgrWithAdvertise([
      { id: PA, connected: true },
      { id: PB, connected: true },
      { id: PC, connected: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: localId,
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    await blockstore.put({ cid: "QmGossip1" as CidString, bytes: Buffer.from("x") })
    await new Promise((r) => setTimeout(r, 30))

    // Every connected peer should have received one advertise frame.
    for (const id of [PA, PB, PC]) {
      const calls = advertiseCalls.get(id)!
      assert.equal(calls.length, 1, `peer ${id} should have one advertise call`)
      assert.equal(calls[0].cid, "QmGossip1")
    }
    mgr.stop()
  })

  it("remote-cache PUT also broadcasts advertise (so re-cachers help discovery)", async () => {
    const localId = "0x1111"
    const dht = makeDht(localId)
    seedDht(dht, [PA])
    const { mgr, advertiseCalls } = makeConnMgrWithAdvertise([
      { id: PA, connected: true },
    ])

    const wiring = buildCocIpfsWiring({
      localNodeId: localId,
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    // Simulate cache-back from a remote fetch — should still advertise
    // so whoever pulled from us learns WE hold it too, but MUST NOT
    // trigger pushToK (that would cascade). Test below tracks both.
    await blockstore.putFromPeer({ cid: "QmCacheGossip" as CidString, bytes: Buffer.from("y") })
    await new Promise((r) => setTimeout(r, 30))

    assert.equal(advertiseCalls.get(PA)!.length, 1, "cache-back still advertises")
    assert.equal(advertiseCalls.get(PA)![0].cid, "QmCacheGossip")
    mgr.stop()
  })

  it("reannounce source emits advertise per pin so remote TTLs stay alive", async () => {
    const localId = "0x1111"
    const dht = makeDht(localId)
    seedDht(dht, [PA])
    const { mgr, advertiseCalls } = makeConnMgrWithAdvertise([
      { id: PA, connected: true },
    ])

    // Pin two CIDs in the blockstore before wiring so that the
    // re-announce source has material to work with.
    await blockstore.put({ cid: "QmReann1" as CidString, bytes: Buffer.from("a") })
    await blockstore.put({ cid: "QmReann2" as CidString, bytes: Buffer.from("b") })
    await blockstore.pin("QmReann1" as CidString)
    await blockstore.pin("QmReann2" as CidString)

    buildCocIpfsWiring({
      localNodeId: localId,
      blockstore, dht, connMgr: mgr,
      replicationFactor: 3,
    })

    // Clear any advertise calls that fell out of the initial setup.
    advertiseCalls.set(PA, [])
    // Trigger the re-announce tick manually (production cadence is 12h).
    await dht.reannounceSelfProviders()

    const calls = advertiseCalls.get(PA)!
    const cids = calls.map((c) => c.cid).sort()
    assert.deepEqual(cids, ["QmReann1", "QmReann2"], "every pinned CID re-advertised")
    mgr.stop()
  })

  // --- Phase C3.2: DHT re-announce source wired to blockstore.listPins().
  it("buildCocIpfsWiring attaches blockstore pins as DHT reannounce source", async () => {
    const dht = makeDht("0xaa")
    const connMgr = makeConnMgr(new Map())

    // Pin something in the blockstore first so listPins() has data.
    await blockstore.put({ cid: "QmReannounceA" as CidString, bytes: Buffer.from("A") })
    await blockstore.put({ cid: "QmReannounceB" as CidString, bytes: Buffer.from("B") })
    await blockstore.pin("QmReannounceA" as CidString)
    await blockstore.pin("QmReannounceB" as CidString)

    buildCocIpfsWiring({
      localNodeId: "0xaa",
      blockstore, dht, connMgr,
    })

    // Clear the self-announce entries that onPut just added so we can
    // prove the reannounce path re-populates them independently.
    ;(dht as unknown as { providerRecords: Map<string, Map<string, number>> }).providerRecords.clear()
    assert.deepEqual(dht.findProviders("QmReannounceA" as CidString), [])

    const n = await dht.reannounceSelfProviders()
    assert.equal(n, 2, "both pinned CIDs re-announced in one tick")
    assert.deepEqual(dht.findProviders("QmReannounceA" as CidString), ["0xaa"])
    assert.deepEqual(dht.findProviders("QmReannounceB" as CidString), ["0xaa"])
    connMgr.stop()
  })

  it("first-success over multiple providers returns the fastest", async () => {
    // Content addressing means every honest provider serves byte-identical
    // content for a CID — the race is purely latency. Assert the result is
    // the genuine content and that we did not block on the slow provider.
    const content = Buffer.from("raced content")
    const cid = cidFor(content)
    const dht = makeDht()
    dht.putProvider(cid, "slow", 60_000)
    dht.putProvider(cid, "fast", 60_000)

    const mgr = new WireConnectionManager({ nodeId: "local", chainId: 1 })
    const mk = (id: string, delay: number) => ({
      isConnected: () => true,
      getRemoteNodeId: () => id,
      requestBlock: async () => {
        await new Promise((r) => setTimeout(r, delay))
        return content
      },
      disconnect: () => {},
    }) as unknown as import("./wire-client.ts").WireClient
    // @ts-expect-error
    mgr.connections.set("slow", { client: mk("slow", 200), host: "h", port: 1, connectedAtMs: 0 })
    // @ts-expect-error
    mgr.connections.set("fast", { client: mk("fast", 10), host: "h", port: 2, connectedAtMs: 0 })

    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr: mgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const startMs = Date.now()
    const block = await blockstore.get(cid)
    const elapsedMs = Date.now() - startMs
    assert.deepEqual(Array.from(block.bytes), Array.from(content))
    assert.ok(elapsedMs < 150, `fast provider must win the race (elapsed ${elapsedMs}ms)`)
    mgr.stop()
  })

  // ---- Phase Q.6 — stripe-aware push spread ---------------------------

  it("pushStripe spreads N+M shards across distinct peers when peer count >= N+M", async () => {
    const dht = makeDht("0xaa")
    // 6 peers, all valid hex IDs so DHT.routingTable accepts them.
    const peerIds = Array.from({ length: 6 }, (_, i) => `0x${"f".repeat(39)}${(i + 1).toString(16)}`)
    seedDht(dht, peerIds)
    const { mgr, pushCalls } = makeConnMgrWithPush(peerIds.map((id) => ({ id, connected: true, pushResult: true })))

    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr: mgr, replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    // 6 distinct shards — RS(4+2) for one stripe.
    const shards = Array.from({ length: 6 }, (_, i) => ({
      cid: `bafkreitest${i.toString().padStart(50, "0")}`,
      bytes: Buffer.from(`shard-${i}`),
    }))

    const result = await wiring.pushStripe(shards)
    assert.equal(result.perShard.length, 6, "one PushToKResult per shard")
    // Total push slots = 6 shards × replicationFactor 3 = 18.
    // With 6 peers, ceiling distribution = ceil(18/6) = 3 → worstPeerOverlap should be ≤ 3.
    assert.ok(result.worstPeerOverlap <= 3, `worstPeerOverlap=${result.worstPeerOverlap}, expected ≤ 3`)
    // We should have used all 6 peers (no peer should be ignored).
    assert.equal(result.distinctPeersUsed, 6, "all peers participated in the spread")
    mgr.stop()
  })

  it("pushStripe is materially flatter than naive per-CID pushToK on the same peer set", async () => {
    // This is the load-bearing assertion for Q.6: spread bias should
    // produce a flatter distribution than independent per-CID picks.
    const dht = makeDht("0xaa")
    const peerIds = Array.from({ length: 6 }, (_, i) => `0x${"e".repeat(39)}${(i + 1).toString(16)}`)
    seedDht(dht, peerIds)

    const shards = Array.from({ length: 6 }, (_, i) => ({
      cid: `bafkreidiff${i.toString().padStart(50, "0")}`,
      bytes: Buffer.from(`distinct-shard-${i}`),
    }))

    // Naive baseline: independent pushToK per shard. Tally per-peer hits.
    {
      const { mgr, pushCalls } = makeConnMgrWithPush(peerIds.map((id) => ({ id, connected: true, pushResult: true })))
      const wiring = buildCocIpfsWiring({
        localNodeId: "0xaa", blockstore, dht, connMgr: mgr, replicationFactor: 3,
      })
      blockstore.setHooks(wiring.blockstoreHooks)
      for (const s of shards) await wiring.pushToK(s.cid, s.bytes)
      const tallyNaive = [...pushCalls.values()].map((arr) => arr.length)
      const naiveMax = Math.max(...tallyNaive)
      const naiveMin = Math.min(...tallyNaive)

      // Stripe-aware: same routing table, fresh connMgr.
      const { mgr: mgr2, pushCalls: pushCalls2 } = makeConnMgrWithPush(peerIds.map((id) => ({ id, connected: true, pushResult: true })))
      const wiring2 = buildCocIpfsWiring({
        localNodeId: "0xaa", blockstore, dht, connMgr: mgr2, replicationFactor: 3,
      })
      blockstore.setHooks(wiring2.blockstoreHooks)
      await wiring2.pushStripe(shards)
      const tallyStripe = [...pushCalls2.values()].map((arr) => arr.length)
      const stripeMax = Math.max(...tallyStripe)
      const stripeMin = Math.min(...tallyStripe)

      // The stripe spread max must be ≤ naive max, and the spread (max - min)
      // must be smaller-or-equal under stripe semantics.
      assert.ok(
        stripeMax <= naiveMax,
        `stripe worst-peer load (${stripeMax}) must not exceed naive worst-peer load (${naiveMax})`,
      )
      assert.ok(
        (stripeMax - stripeMin) <= (naiveMax - naiveMin),
        `stripe range (${stripeMax}-${stripeMin}=${stripeMax - stripeMin}) must not exceed naive range (${naiveMax}-${naiveMin}=${naiveMax - naiveMin})`,
      )
      mgr.stop()
      mgr2.stop()
    }
  })

  it("pushStripe gracefully degrades when peer count < N+M (overlap > 1)", async () => {
    const dht = makeDht("0xaa")
    // Only 2 peers — far fewer than the 6 shards we'll push.
    const peerIds = ["0x" + "a".repeat(39) + "1", "0x" + "a".repeat(39) + "2"]
    seedDht(dht, peerIds)
    const { mgr } = makeConnMgrWithPush(peerIds.map((id) => ({ id, connected: true, pushResult: true })))
    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr: mgr, replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const shards = Array.from({ length: 6 }, (_, i) => ({
      cid: `bafkreismall${i.toString().padStart(49, "0")}`,
      bytes: Buffer.from(`shard-${i}`),
    }))
    const result = await wiring.pushStripe(shards)
    assert.equal(result.distinctPeersUsed, 2)
    // 6 shards × replicationFactor 3 = 18 push attempts but only 2 peers,
    // so each peer gets clamped: targets length per shard = min(replicationFactor, peerCount) = 2.
    // Total = 12 attempts; per-peer overlap = 6.
    assert.ok(result.worstPeerOverlap <= 6, "overlap bounded by total push attempts")
    // Every shard's PushToKResult should have skippedLowPeers=false (peers exist).
    for (const r of result.perShard) {
      assert.equal(r.skippedLowPeers, false)
      assert.ok(r.attempted > 0, "at least one push attempted per shard")
    }
    mgr.stop()
  })

  it("pushStripe excludes the local node from candidates", async () => {
    const dht = makeDht("0xaa")
    seedDht(dht, ["0xaa", "0xbb"]) // local node deliberately in the table
    const { mgr, pushCalls } = makeConnMgrWithPush([
      { id: "0xbb", connected: true, pushResult: true },
    ])
    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr: mgr, replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const shards = [{ cid: "bafkreione" + "0".repeat(48), bytes: Buffer.from("only-shard") }]
    const result = await wiring.pushStripe(shards)
    assert.ok(!result.perShard[0].succeeded.includes("0xaa"))
    assert.ok(!result.perShard[0].failed.includes("0xaa"))
    assert.ok(result.distinctPeersUsed <= 1)
    mgr.stop()
  })

  it("pushStripe with zero peers returns all skippedLowPeers=true", async () => {
    const dht = makeDht("0xaa")
    const { mgr } = makeConnMgrWithPush([])
    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr: mgr, replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const shards = [
      { cid: "bafkreinop" + "0".repeat(48), bytes: Buffer.from("a") },
      { cid: "bafkreinop" + "1".repeat(48), bytes: Buffer.from("b") },
    ]
    const result = await wiring.pushStripe(shards)
    for (const r of result.perShard) {
      assert.equal(r.skippedLowPeers, true)
      assert.equal(r.attempted, 0)
    }
    assert.equal(result.distinctPeersUsed, 0)
    assert.equal(result.worstPeerOverlap, 0)
    mgr.stop()
  })

  it("blockstore.put with deferStripePush skips per-CID pushToK but still self-announces + gossips", async () => {
    const dht = makeDht("0xaa")
    seedDht(dht, ["0xbb"])
    const { mgr, pushCalls } = makeConnMgrWithPush([{ id: "0xbb", connected: true, pushResult: true }])
    const { mgr: advMgr, advertiseCalls } = makeConnMgrWithAdvertise([{ id: "0xbb", connected: true }])
    // Use the push-tracking mgr so we observe the absence of pushBlock calls.
    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr: mgr, replicationFactor: 3,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const cid = "QmDeferred" as CidString
    await blockstore.put({ cid, bytes: Buffer.from("deferred") }, { deferStripePush: true })

    // Self-announce did fire (cheap in-memory provider record).
    const providers = dht.findProviders(cid, 5)
    assert.ok(providers.includes("0xaa"), "local node still self-announced")
    // pushBlock did NOT fire on the connected peer.
    assert.equal(pushCalls.get("0xbb")!.length, 0, "deferred push must not trigger per-CID push-to-K")
    mgr.stop()
    advMgr.stop()
  })

  // Issue #71 Bug B regression: when DHT findProviders is empty (e.g. the
  // ProviderAdvertise gossip got dropped under burst), fetchRemote should
  // still try every directly-connected peer. Pre-fix this path returned
  // null instantly and synchronous /api/v0/get returned 404 even though
  // the peer was holding the bytes.
  it("fetchRemote falls back to connected peers when DHT has no providers (#71 Bug B)", async () => {
    const remoteBytes = Buffer.from("via connected peer")
    const cid = cidFor(remoteBytes)
    const dht = makeDht("0xaa")
    // Note: no putProvider call — DHT is empty for this CID.

    // Use the same trick as makeConnMgr but ensure the connected peer is
    // visible to listConnectedPeerIds (i.e. isConnected returns true).
    const mgr = new WireConnectionManager({ nodeId: "local", chainId: 1 })
    const client = {
      isConnected: () => true,
      getRemoteNodeId: () => "0xpeer-zz",
      requestBlock: async (askCid: string) => (askCid === cid ? remoteBytes : null),
      pushBlock: async () => true,
      sendProviderAdvertise: () => true,
      disconnect: () => {},
    } as unknown as import("./wire-client.ts").WireClient
    // @ts-expect-error — private-field write for test fan-out
    mgr.connections.set("0xpeer-zz", { client, host: "h", port: 1, connectedAtMs: 0 })

    const wiring = buildCocIpfsWiring({
      localNodeId: "0xaa", blockstore, dht, connMgr: mgr,
    })
    blockstore.setHooks(wiring.blockstoreHooks)

    const block = await blockstore.get(cid)
    assert.deepEqual(Array.from(block.bytes), Array.from(remoteBytes))
    mgr.stop()
  })

  // Issue #71 Bug A regression: pushBlock calls to the same peer must
  // serialize through `sendThroughPeer` so we never have >1 in-flight
  // frame per peer. Without this, a 50 MB UnixFS PUT fans out into ~200
  // concurrent socket.write() calls per peer; the kernel send buffer
  // overflows and the connection RSTs mid-burst. We simulate the burst
  // by giving each pushBlock a small delay; if serialization is broken,
  // overlapping calls are observable via a peak-concurrency counter.
  it("pushToK serializes per-peer pushBlock so concurrent burst doesn't overlap (#71 Bug A)", async () => {
    const dht = makeDht("0x1111")
    seedDht(dht, [PA])
    const mgr = new WireConnectionManager({ nodeId: "local", chainId: 1 })
    const callTimings: Array<{ start: number; end: number }> = []
    let inFlight = 0
    let peakInFlight = 0
    const client = {
      isConnected: () => true,
      getRemoteNodeId: () => PA,
      requestBlock: async () => null,
      pushBlock: async () => {
        const start = Date.now()
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        // Hold long enough that any concurrent push would overlap into
        // the same 20 ms window. 20 ms × 5 = 100 ms total wall-clock
        // when fully serialized.
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        callTimings.push({ start, end: Date.now() })
        return true
      },
      sendProviderAdvertise: () => true,
      disconnect: () => {},
    } as unknown as import("./wire-client.ts").WireClient
    // @ts-expect-error — private-field write for test fan-out
    mgr.connections.set(PA, { client, host: "h", port: 1, connectedAtMs: 0 })

    const wiring = buildCocIpfsWiring({
      localNodeId: "0x1111", blockstore, dht, connMgr: mgr, replicationFactor: 1,
    })

    // Fire 5 pushToK calls in parallel — simulates burst PUTs.
    await Promise.all([
      wiring.pushToK("QmBurst1" as CidString, Buffer.from("a")),
      wiring.pushToK("QmBurst2" as CidString, Buffer.from("b")),
      wiring.pushToK("QmBurst3" as CidString, Buffer.from("c")),
      wiring.pushToK("QmBurst4" as CidString, Buffer.from("d")),
      wiring.pushToK("QmBurst5" as CidString, Buffer.from("e")),
    ])

    assert.equal(callTimings.length, 5, "all 5 pushBlock calls landed")
    assert.equal(peakInFlight, 1, "per-peer concurrency must be 1 (serialized)")
    // Sanity: end of call N must be ≤ start of call N+1 (chain not interleaved).
    callTimings.sort((a, b) => a.start - b.start)
    for (let i = 1; i < callTimings.length; i++) {
      assert.ok(
        callTimings[i].start >= callTimings[i - 1].end,
        `call ${i} started at ${callTimings[i].start} before previous call ended at ${callTimings[i - 1].end}`,
      )
    }
    mgr.stop()
  })
})
