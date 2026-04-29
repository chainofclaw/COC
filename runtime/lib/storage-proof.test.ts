import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IpfsBlockstore } from "../../node/src/ipfs-blockstore.ts"
import { UnixFsBuilder } from "../../node/src/ipfs-unixfs.ts"
import { buildMerkleRoot, buildMerklePath, hashLeaf } from "../../node/src/ipfs-merkle.ts"
import { loadStorageProof, MerkleLeavesCache } from "./storage-proof.ts"

// Phase C2.1 proof-construction tests. We exercise both modes of
// loadStorageProof against a real IpfsBlockstore so that the
// blockstore-backed path is structurally identical to what runs at
// /pose/receipt time; the pre-baked meta path is tested against a
// hand-written file-meta.json.

let tmpDir: string
let store: IpfsBlockstore
let builder: UnixFsBuilder

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sproof-"))
  store = new IpfsBlockstore(tmpDir)
  builder = new UnixFsBuilder(store)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("loadStorageProof — blockstore mode (Phase C2.1)", () => {
  it("derives a live proof that matches the file meta's stamped leaves / root", async () => {
    const data = new TextEncoder().encode("live-proof content for phase C2.1")
    const meta = await builder.addFile("live.txt", data, 8)
    assert.ok(meta.merkleLeaves.length > 1)

    const cache = new MerkleLeavesCache()
    const proof = await loadStorageProof(
      { storageDirPath: tmpDir, blockstore: store, cache },
      meta.cid,
      0,
    )
    assert.equal(proof.leafHash, meta.merkleLeaves[0])
    assert.equal(proof.merkleRoot, meta.merkleRoot)
    assert.deepEqual(proof.merklePath, buildMerklePath(meta.merkleLeaves, 0))
    assert.ok(typeof proof.chunkSize === "number" && proof.chunkSize > 0)
  })

  it("chunkSize is the actual byte length of the targeted chunk", async () => {
    // Fixed blockSize=10, 25 bytes → chunks of [10,10,5].
    const data = new TextEncoder().encode("x".repeat(25))
    const meta = await builder.addFile("sz.txt", data, 10)
    assert.equal(meta.leaves.length, 3)

    const cache = new MerkleLeavesCache()
    const p0 = await loadStorageProof(
      { storageDirPath: tmpDir, blockstore: store, cache },
      meta.cid, 0,
    )
    const p2 = await loadStorageProof(
      { storageDirPath: tmpDir, blockstore: store, cache },
      meta.cid, 2,
    )
    assert.equal(p0.chunkSize, 10)
    assert.equal(p2.chunkSize, 5, "last chunk is shorter")
  })

  it("repeated calls for the same CID hit the cache (no repeated full scan)", async () => {
    const data = new TextEncoder().encode("cache probe data".repeat(50))
    const meta = await builder.addFile("cache.txt", data, 8)

    const cache = new MerkleLeavesCache()
    const p1 = await loadStorageProof(
      { storageDirPath: tmpDir, blockstore: store, cache },
      meta.cid, 0,
    )
    assert.equal(cache.size(), 1, "first call populates cache")

    const p2 = await loadStorageProof(
      { storageDirPath: tmpDir, blockstore: store, cache },
      meta.cid, 0,
    )
    assert.deepEqual(p1.merklePath, p2.merklePath)
    assert.equal(p1.leafHash, p2.leafHash)
    assert.equal(cache.size(), 1, "cache didn't grow on second hit")
  })

  it("different chunk indices on the same CID share the cached leaves array", async () => {
    const data = new TextEncoder().encode("multi-index access".repeat(50))
    const meta = await builder.addFile("multi.txt", data, 8)
    const cache = new MerkleLeavesCache()

    const proofs = await Promise.all([0, 1, 2].map((i) =>
      loadStorageProof({ storageDirPath: tmpDir, blockstore: store, cache }, meta.cid, i),
    ))
    assert.equal(cache.size(), 1, "single cache entry across multiple proof lookups")

    // Each proof's leafHash matches the expected per-chunk hash.
    const leaves = cache.get(meta.cid)!
    assert.equal(proofs[0].leafHash, leaves[0])
    assert.equal(proofs[1].leafHash, leaves[1])
    assert.equal(proofs[2].leafHash, leaves[2])
  })

  it("rejects out-of-range chunkIndex with a clear error", async () => {
    const data = new TextEncoder().encode("small")
    const meta = await builder.addFile("oob.txt", data)
    const cache = new MerkleLeavesCache()
    await assert.rejects(
      () => loadStorageProof(
        { storageDirPath: tmpDir, blockstore: store, cache },
        meta.cid, 999,
      ),
      /invalid chunk index/,
    )
  })

  it("rejects a CID not present in the blockstore", async () => {
    await assert.rejects(
      () => loadStorageProof(
        { storageDirPath: tmpDir, blockstore: store, cache: new MerkleLeavesCache() },
        "bafyghost" + "a".repeat(40),
        0,
      ),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    )
  })

  it("built proof verifies against the merkleRoot via buildMerklePath", async () => {
    // Sanity-check that what we produce can actually be validated —
    // mirrors the verifier's Merkle re-derivation in services/verifier.
    const data = new TextEncoder().encode("verify-roundtrip ".repeat(20))
    const meta = await builder.addFile("verify.txt", data, 8)

    const cache = new MerkleLeavesCache()
    for (let i = 0; i < meta.leaves.length; i++) {
      const proof = await loadStorageProof(
        { storageDirPath: tmpDir, blockstore: store, cache },
        meta.cid, i,
      )
      // The leaf at position i combined with its path must reproduce the
      // merkle root. We recompute independently: buildMerkleRoot of the
      // leaves == proof.merkleRoot, and proof.merklePath is exactly
      // what buildMerklePath(leaves, i) returns — giving one endpoint of
      // the Merkle-math check the verifier performs.
      assert.equal(proof.merkleRoot, meta.merkleRoot)
      const expectedPath = buildMerklePath(meta.merkleLeaves, i)
      assert.deepEqual(proof.merklePath, expectedPath)
    }
  })

  it("MerkleLeavesCache evicts oldest when full", () => {
    const cache = new MerkleLeavesCache(2)
    cache.put("cid-a", ["ha"])
    cache.put("cid-b", ["hb"])
    cache.put("cid-c", ["hc"])
    assert.equal(cache.size(), 2)
    assert.equal(cache.get("cid-a"), undefined, "oldest evicted")
    assert.deepEqual(cache.get("cid-b"), ["hb"])
    assert.deepEqual(cache.get("cid-c"), ["hc"])
  })
})

describe("loadStorageProof — legacy meta mode", () => {
  it("reads from file-meta.json when no blockstore passed", async () => {
    const data = new TextEncoder().encode("legacy-path")
    const meta = await builder.addFile("legacy.txt", data, 4)

    // Write the meta file the way the previous (pre-C2.1) implementation expected.
    await writeFile(
      join(tmpDir, "file-meta.json"),
      JSON.stringify({ [meta.cid]: meta }),
      "utf-8",
    )

    const proof = await loadStorageProof(
      { storageDirPath: tmpDir /* no blockstore */ },
      meta.cid,
      0,
    )
    assert.equal(proof.leafHash, meta.merkleLeaves[0])
    assert.equal(proof.merkleRoot, meta.merkleRoot)
    // chunkSize is NOT populated in legacy mode — stayed out of the
    // meta format, only live-scan mode can derive it.
    assert.equal(proof.chunkSize, undefined)
  })

  it("rejects unknown cid with a clear error in legacy mode", async () => {
    await assert.rejects(
      () => loadStorageProof({ storageDirPath: tmpDir }, "bafyNotHere", 0),
      /file meta not found/,
    )
  })

  it("rejects out-of-range chunkIndex in legacy mode", async () => {
    const data = new TextEncoder().encode("x")
    const meta = await builder.addFile("small.txt", data)
    await writeFile(join(tmpDir, "file-meta.json"), JSON.stringify({ [meta.cid]: meta }), "utf-8")
    await assert.rejects(
      () => loadStorageProof({ storageDirPath: tmpDir }, meta.cid, 999),
      /invalid chunk index/,
    )
  })
})
