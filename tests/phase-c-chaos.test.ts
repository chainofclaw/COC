/**
 * Phase C4.2/C4.3 — chaos tests for the storage-distribution layer.
 *
 * Two narrow slices deliberately kept at the unit/integration boundary
 * (not full multi-node) because the heavy end-to-end drill lives in
 * scripts/distributed-storage-e2e.sh, which spins a real devnet:
 *
 *   C4.2 — lying-node scoring: when a prover returns a Merkle-valid
 *     receipt but the audit-sampled peer re-fetch produces a different
 *     leafHash, the receipt collapses to resultCode=InvalidStorageAudit.
 *     Wiring the audit result into scoring lives in coc-agent.ts; the
 *     contract tested here is that `auditStorageReceipt` correctly
 *     classifies a fabricated proof as `audited: true, passed: false`.
 *
 *   C4.3 — DHT provider TTL expiry: short-TTL putProvider entries are
 *     dropped both lazily by findProviders (so callers never route a
 *     GET to a stale peer) and actively by the refresh timer.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DhtNetwork, DEFAULT_PROVIDER_TTL_MS } from "../node/src/dht-network.ts"
import { auditStorageReceipt } from "../services/verifier/storage-audit.ts"
import { hashLeaf } from "../node/src/ipfs-merkle.ts"

describe("Phase C4.3 — DHT provider TTL expiry", () => {
  function newNetwork(): DhtNetwork {
    return new DhtNetwork({
      localId: "0xaa",
      bootstrapPeers: [],
      wireClients: [],
      onPeerDiscovered: () => {},
    })
  }

  const cid = "bafyC4TTL" + "x".repeat(40)
  const peer = "0xcccccccccccccccccccccccccccccccccccccccc"

  it("short-TTL entry disappears from findProviders after expiry", async () => {
    const net = newNetwork()
    net.putProvider(cid, peer, 50)
    assert.deepEqual(net.findProviders(cid), [peer.toLowerCase()], "peer claimable before TTL")

    await new Promise((r) => setTimeout(r, 80))

    // findProviders must not return the expired peer — this is the
    // contract the C1.3 fetchRemote path relies on: it never sees a
    // stale peer as a candidate.
    assert.deepEqual(net.findProviders(cid), [], "peer culled after TTL")
  })

  it("removeExpiredProviders actively sweeps past-expiry entries", async () => {
    const net = newNetwork()
    const short1 = "0x1111111111111111111111111111111111111111"
    const short2 = "0x2222222222222222222222222222222222222222"
    const long = "0x3333333333333333333333333333333333333333"
    net.putProvider(cid, short1, 30)
    net.putProvider(cid, short2, 30)
    net.putProvider(cid, long, 60_000)

    await new Promise((r) => setTimeout(r, 60))

    const removed = net.removeExpiredProviders()
    assert.equal(removed, 2, "2 short-TTL entries swept")
    assert.deepEqual(net.findProviders(cid, 10), [long.toLowerCase()], "only long-TTL entry remains")
  })

  it("DEFAULT_PROVIDER_TTL_MS is 24 h (libp2p kad-dht parity)", () => {
    // Contract check: the re-announce loop (C3.2) bumps at TTL/2.
    // If this constant ever drifts, C3.2's re-announce cadence needs
    // to be retuned. Make that explicit.
    assert.equal(DEFAULT_PROVIDER_TTL_MS, 24 * 60 * 60 * 1000)
  })

  it("TTL renewal extends expiry (verifies C3.2 re-announce semantics)", async () => {
    const net = newNetwork()
    net.putProvider(cid, peer, 30) // expires soon
    // Simulate the C3.2 reannounce tick by calling putProvider again.
    net.putProvider(cid, peer) // default TTL = 24 h

    await new Promise((r) => setTimeout(r, 60))

    // Original 30ms entry would be gone; renewal kept us alive.
    assert.deepEqual(net.findProviders(cid), [peer.toLowerCase()], "renewal bumped expiry past the 30ms mark")
  })
})

describe("Phase C4.2 — lying-node audit catches fabricated proofs", () => {
  const claimedCid = "bafyLying" + "y".repeat(40)
  const proverNodeId = "0xliar"

  it("audit flips to passed=false when peer bytes produce a different leafHash", async () => {
    const realBytes = Buffer.from("the bytes the prover actually has")
    const fakeBytes = Buffer.from("what the prover's fabricated proof implied")
    const fabricatedLeafHash = hashLeaf(fakeBytes)

    // The prover returned `fabricatedLeafHash` in its receipt — a
    // Merkle-math-valid hash — but the peer we sample has the *real*
    // bytes, so re-hashing gives a different leafHash. The audit must
    // classify this as `audited: true, passed: false`.
    const result = await auditStorageReceipt(
      {
        fetchChunkExcluding: async () => realBytes,
        rng: () => 0.01,
        auditSampleBps: 10_000,
      },
      {
        cid: claimedCid,
        leafHash: fabricatedLeafHash,
        proverNodeId,
        chunkIndex: 0,
      },
    )

    assert.equal(result.audited, true, "receipt was sampled for audit")
    if (result.audited) {
      assert.equal(result.passed, false, "audit caught the fabrication")
      if (!result.passed) {
        assert.equal(result.reason, "leaf-hash-mismatch")
        // `actual` is the hash of what the honest peer holds; `expected`
        // is what the prover claimed. The runtime plumbs this mismatch
        // into `resultCode = InvalidStorageAudit` via the coc-agent
        // scoring pipe, which is the scoring-level punishment we rely on.
        assert.equal(
          result.expected.toLowerCase(),
          fabricatedLeafHash.toLowerCase(),
        )
        assert.equal(
          result.actual.toLowerCase(),
          hashLeaf(realBytes).toLowerCase(),
        )
      }
    }
  })

  it("audit passes silently when prover and peer bytes agree (honest baseline)", async () => {
    const honestBytes = Buffer.from("matching bytes")
    const honestLeafHash = hashLeaf(honestBytes)

    const result = await auditStorageReceipt(
      {
        fetchChunkExcluding: async () => honestBytes,
        rng: () => 0.01,
        auditSampleBps: 10_000,
      },
      {
        cid: claimedCid,
        leafHash: honestLeafHash,
        proverNodeId,
        chunkIndex: 0,
      },
    )

    assert.deepEqual(result, { audited: true, passed: true })
  })

  it("audit is inconclusive (not failed) when no independent peer serves the bytes", async () => {
    // The prover might be the only advertised provider — that's a yellow
    // flag the C3.3 repair loop handles, not an audit failure. A liar
    // who colludes with the DHT (by being the sole provider) *does not*
    // get a resultCode=InvalidStorageAudit from us; the receipt stays
    // `Ok` and the under-replication symptom is surfaced elsewhere.
    const result = await auditStorageReceipt(
      {
        fetchChunkExcluding: async () => null, // no non-excluded peer responded
        rng: () => 0.01,
        auditSampleBps: 10_000,
      },
      {
        cid: claimedCid,
        leafHash: "0xabcd",
        proverNodeId,
        chunkIndex: 0,
      },
    )

    assert.deepEqual(result, { audited: false, reason: "no-bytes-returned" })
  })
})
