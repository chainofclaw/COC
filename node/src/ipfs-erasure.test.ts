import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import {
  encodeFile,
  decodeFile,
  encodeManifest,
  decodeManifest,
  computeManifestCid,
  ErasureError,
  MAX_DATA_SHARDS,
  MAX_PARITY_SHARDS,
  DEFAULT_SHARD_SIZE,
  MAX_SHARD_SIZE,
  MAX_STRIPES,
  type ErasureManifest,
  type ErasureStripe,
} from "./ipfs-erasure.ts"
import type { CidString } from "./ipfs-types.ts"

/**
 * Build an in-memory shard fetcher from a list of blocks. Returns a fetch
 * function compatible with `decodeFile` plus mutators for tests that simulate
 * shard loss.
 */
function makeShardStore(blocks: Array<{ cid: CidString; bytes: Uint8Array }>) {
  const map = new Map<CidString, Uint8Array>()
  for (const b of blocks) map.set(b.cid, b.bytes)
  return {
    fetch: async (cid: CidString) => map.get(cid) ?? null,
    drop: (cid: CidString) => map.delete(cid),
    has: (cid: CidString) => map.has(cid),
    size: () => map.size,
  }
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

describe("ipfs-erasure encode/decode roundtrip", () => {
  for (const size of [1024, 65536, 262144, 1048576]) {
    it(`RS(4+2) ${size}-byte file roundtrips byte-identical`, async () => {
      const file = randomBytes(size)
      const r = await encodeFile(file, { n: 4, m: 2 })
      const store = makeShardStore(r.shardBlocks)
      const back = await decodeFile(r.manifest, store.fetch)
      assert.equal(back.byteLength, file.byteLength)
      assert.ok(eqBytes(back, file), "decoded bytes differ from original")
    })
  }

  it("RS(4+2) 10 MB roundtrip", async () => {
    const file = randomBytes(10 * 1024 * 1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(r.manifest.stripes.length, 10)
    const store = makeShardStore(r.shardBlocks)
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })

  it("RS(6+3) 11 MB roundtrip", async () => {
    const file = randomBytes(11 * 1024 * 1024)
    const r = await encodeFile(file, { n: 6, m: 3 })
    const stripeSize = 6 * DEFAULT_SHARD_SIZE
    assert.equal(r.manifest.stripes.length, Math.ceil(file.byteLength / stripeSize))
    const store = makeShardStore(r.shardBlocks)
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })

  it("RS(8+4) 5 MB roundtrip", async () => {
    const file = randomBytes(5 * 1024 * 1024)
    const r = await encodeFile(file, { n: 8, m: 4 })
    const store = makeShardStore(r.shardBlocks)
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })
})

describe("ipfs-erasure padding edge cases", () => {
  it("zero-byte file produces one all-zero stripe", async () => {
    const file = new Uint8Array(0)
    const r = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(r.manifest.fileSize, 0)
    assert.equal(r.manifest.stripes.length, 1, "always at least one stripe")
    const store = makeShardStore(r.shardBlocks)
    const back = await decodeFile(r.manifest, store.fetch)
    assert.equal(back.byteLength, 0)
  })

  it("1-byte file roundtrips correctly with full padding", async () => {
    const file = new Uint8Array([42])
    const r = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(r.manifest.fileSize, 1)
    const back = await decodeFile(r.manifest, makeShardStore(r.shardBlocks).fetch)
    assert.equal(back.byteLength, 1)
    assert.equal(back[0], 42)
  })

  it("file exactly one stripe long", async () => {
    const stripeSize = 4 * DEFAULT_SHARD_SIZE
    const file = randomBytes(stripeSize)
    const r = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(r.manifest.stripes.length, 1)
    const back = await decodeFile(r.manifest, makeShardStore(r.shardBlocks).fetch)
    assert.ok(eqBytes(back, file))
  })

  it("file one byte past one stripe spans two stripes", async () => {
    const stripeSize = 4 * DEFAULT_SHARD_SIZE
    const file = randomBytes(stripeSize + 1)
    const r = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(r.manifest.stripes.length, 2)
    const back = await decodeFile(r.manifest, makeShardStore(r.shardBlocks).fetch)
    assert.ok(eqBytes(back, file))
  })
})

describe("ipfs-erasure parity recovery — corrupt M shards", () => {
  it("RS(4+2) recovers from 2 missing data shards in stripe 0", async () => {
    const file = randomBytes(2 * 1024 * 1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const store = makeShardStore(r.shardBlocks)
    store.drop(r.manifest.stripes[0].data[0])
    store.drop(r.manifest.stripes[0].data[1])
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })

  it("RS(4+2) recovers from 1 missing data + 1 missing parity", async () => {
    // File size chosen to fill all 4 data shards with non-zero content so
    // shards have distinct CIDs (a small file zero-pads later shards →
    // identical content → identical CIDs, which makes drop()-by-CID take
    // multiple logical shards out at once. That's a content-addressed
    // storage property, not an erasure-code property; tests for the latter
    // need distinct shard content.).
    const file = randomBytes(4 * 256 * 1024 + 17)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const store = makeShardStore(r.shardBlocks)
    store.drop(r.manifest.stripes[0].data[2])
    store.drop(r.manifest.stripes[0].parity[1])
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })

  it("identical-content shards (all-zero stripe) share one CID — single fetch covers all duplicates", async () => {
    // Sanity test for content-addressing semantics: if data shards share
    // bytes, they share a CID. The decoder fetches each logical shard by
    // its CID; a single map hit on the shared CID satisfies all of them.
    // The file fills only shard 0 with non-zero bytes; shards 1..3 are
    // all zeros and share one CID. Drop nothing — verify the fetch
    // succeeds for every logical shard despite the dedup.
    const fileBytes = randomBytes(64)
    const file = new Uint8Array(64)
    file.set(fileBytes)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const uniqueDataCids = new Set(r.manifest.stripes[0].data)
    assert.ok(uniqueDataCids.size < 4, "small file with sparse content produces duplicate-CID shards as expected")
    const store = makeShardStore(r.shardBlocks)
    // No drops — verify the duplicate-CID dedup doesn't break decode.
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })

  it("RS(6+3) recovers from 3 missing data shards", async () => {
    const file = randomBytes(2 * 1024 * 1024)
    const r = await encodeFile(file, { n: 6, m: 3 })
    const store = makeShardStore(r.shardBlocks)
    store.drop(r.manifest.stripes[0].data[0])
    store.drop(r.manifest.stripes[0].data[2])
    store.drop(r.manifest.stripes[0].data[4])
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })

  it("RS(4+2) recovers per-stripe — different shards missing in each stripe", async () => {
    const file = randomBytes(3 * 1024 * 1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(r.manifest.stripes.length, 3)
    const store = makeShardStore(r.shardBlocks)
    // stripe 0: drop two data shards
    store.drop(r.manifest.stripes[0].data[0])
    store.drop(r.manifest.stripes[0].data[3])
    // stripe 1: drop one parity, one data
    store.drop(r.manifest.stripes[1].parity[0])
    store.drop(r.manifest.stripes[1].data[2])
    // stripe 2: drop two parity (decode is fast-path; parity loss is repair-loop's job)
    store.drop(r.manifest.stripes[2].parity[0])
    store.drop(r.manifest.stripes[2].parity[1])
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })

  it("RS(4+2) fast path: all shards present, no decode work", async () => {
    const file = randomBytes(1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const store = makeShardStore(r.shardBlocks)
    const back = await decodeFile(r.manifest, store.fetch)
    assert.ok(eqBytes(back, file))
  })
})

describe("ipfs-erasure parity recovery — M+1 missing fails predictably", () => {
  it("RS(4+2) with 3 missing shards in one stripe throws insufficient_shards", async () => {
    const file = randomBytes(1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const store = makeShardStore(r.shardBlocks)
    store.drop(r.manifest.stripes[0].data[0])
    store.drop(r.manifest.stripes[0].data[1])
    store.drop(r.manifest.stripes[0].data[2])
    await assert.rejects(
      () => decodeFile(r.manifest, store.fetch),
      (err) => err instanceof ErasureError && err.code === "insufficient_shards",
    )
  })

  it("RS(4+2) with 3 missing across data+parity (2 data + 1 parity) fails", async () => {
    const file = randomBytes(1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const store = makeShardStore(r.shardBlocks)
    store.drop(r.manifest.stripes[0].data[0])
    store.drop(r.manifest.stripes[0].data[1])
    store.drop(r.manifest.stripes[0].parity[0])
    await assert.rejects(
      () => decodeFile(r.manifest, store.fetch),
      (err) => err instanceof ErasureError && err.code === "insufficient_shards",
    )
  })

  it("RS(8+4) with 5 missing in one stripe fails (max tolerance is 4)", async () => {
    const file = randomBytes(2 * 1024 * 1024)
    const r = await encodeFile(file, { n: 8, m: 4 })
    const store = makeShardStore(r.shardBlocks)
    for (let i = 0; i < 5; i++) store.drop(r.manifest.stripes[0].data[i])
    await assert.rejects(
      () => decodeFile(r.manifest, store.fetch),
      (err) => err instanceof ErasureError && err.code === "insufficient_shards",
    )
  })

  it("failure in late stripe still surfaces the insufficient_shards error", async () => {
    const file = randomBytes(3 * 1024 * 1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const store = makeShardStore(r.shardBlocks)
    // Stripe 2 catastrophically lost.
    store.drop(r.manifest.stripes[2].data[0])
    store.drop(r.manifest.stripes[2].data[1])
    store.drop(r.manifest.stripes[2].data[2])
    await assert.rejects(
      () => decodeFile(r.manifest, store.fetch),
      (err) => err instanceof ErasureError && err.code === "insufficient_shards",
    )
  })
})

describe("ipfs-erasure param validation", () => {
  it("rejects n=0", async () => {
    await assert.rejects(
      () => encodeFile(new Uint8Array(8), { n: 0, m: 2 }),
      (err) => err instanceof ErasureError && err.code === "invalid_params",
    )
  })

  it("rejects m=0", async () => {
    await assert.rejects(
      () => encodeFile(new Uint8Array(8), { n: 4, m: 0 }),
      (err) => err instanceof ErasureError && err.code === "invalid_params",
    )
  })

  it("rejects n > MAX_DATA_SHARDS", async () => {
    await assert.rejects(
      () => encodeFile(new Uint8Array(8), { n: MAX_DATA_SHARDS + 1, m: 2 }),
      (err) => err instanceof ErasureError && err.code === "invalid_params",
    )
  })

  it("rejects m > MAX_PARITY_SHARDS", async () => {
    await assert.rejects(
      () => encodeFile(new Uint8Array(8), { n: 4, m: MAX_PARITY_SHARDS + 1 }),
      (err) => err instanceof ErasureError && err.code === "invalid_params",
    )
  })

  it("rejects non-integer n / m", async () => {
    await assert.rejects(
      () => encodeFile(new Uint8Array(8), { n: 4.5, m: 2 }),
      (err) => err instanceof ErasureError,
    )
    await assert.rejects(
      () => encodeFile(new Uint8Array(8), { n: 4, m: 2.5 }),
      (err) => err instanceof ErasureError,
    )
  })

  it("rejects shardSize that is not a multiple of 8", async () => {
    await assert.rejects(
      () => encodeFile(new Uint8Array(8), { n: 4, m: 2, shardSize: 1023 }),
      (err) => err instanceof ErasureError && err.code === "invalid_params",
    )
  })

  it("rejects shardSize < 8", async () => {
    await assert.rejects(
      () => encodeFile(new Uint8Array(8), { n: 4, m: 2, shardSize: 4 }),
      (err) => err instanceof ErasureError && err.code === "invalid_params",
    )
  })

  it("accepts custom multiple-of-8 shardSize", async () => {
    const file = randomBytes(2048)
    const r = await encodeFile(file, { n: 4, m: 2, shardSize: 1024 })
    assert.equal(r.manifest.shardSize, 1024)
    const back = await decodeFile(r.manifest, makeShardStore(r.shardBlocks).fetch)
    assert.ok(eqBytes(back, file))
  })
})

describe("ipfs-erasure manifest CID determinism", () => {
  it("identical inputs produce identical manifest CIDs", async () => {
    const file = new Uint8Array(1024).fill(0x55)
    const r1 = await encodeFile(file, { n: 4, m: 2 })
    const r2 = await encodeFile(file, { n: 4, m: 2 })
    assert.equal(r1.manifestCid, r2.manifestCid)
  })

  it("differing fileSize changes manifest CID", async () => {
    const a = new Uint8Array(1024).fill(0x55)
    const b = new Uint8Array(2048).fill(0x55)
    const ra = await encodeFile(a, { n: 4, m: 2 })
    const rb = await encodeFile(b, { n: 4, m: 2 })
    assert.notEqual(ra.manifestCid, rb.manifestCid)
  })

  it("different scheme changes manifest CID for same file", async () => {
    const file = new Uint8Array(1024).fill(0x77)
    const r1 = await encodeFile(file, { n: 4, m: 2 })
    const r2 = await encodeFile(file, { n: 6, m: 3 })
    assert.notEqual(r1.manifestCid, r2.manifestCid)
  })

  it("computeManifestCid matches encode result", async () => {
    const file = new Uint8Array(1024).fill(0xee)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const recomputed = await computeManifestCid(r.manifest)
    assert.equal(recomputed, r.manifestCid)
  })

  it("originalCid presence changes manifest CID", async () => {
    const file = new Uint8Array(1024).fill(0x99)
    const r1 = await encodeFile(file, { n: 4, m: 2 })
    const r2 = await encodeFile(file, { n: 4, m: 2, originalCid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
    assert.notEqual(r1.manifestCid, r2.manifestCid)
    assert.equal(r2.manifest.originalCid, "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  })
})

describe("ipfs-erasure manifest dag-cbor codec", () => {
  it("encodeManifest then decodeManifest is identity", async () => {
    const file = randomBytes(1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const bytes = encodeManifest(r.manifest)
    const back = decodeManifest(bytes)
    assert.deepEqual(back, r.manifest)
  })

  it("decodeManifest rejects missing version", () => {
    const bad = { scheme: "rs", n: 4, m: 2, shardSize: 256, fileSize: 0, stripes: [] }
    const bytes = encodeManifest(bad as unknown as ErasureManifest)
    assert.throws(() => decodeManifest(bytes), (err) => err instanceof ErasureError && err.code === "unsupported_manifest")
  })

  it("decodeManifest rejects unsupported scheme", () => {
    const bad = { v: 1, scheme: "raptorq", n: 4, m: 2, shardSize: 256, fileSize: 0, stripes: [] }
    const bytes = encodeManifest(bad as unknown as ErasureManifest)
    assert.throws(() => decodeManifest(bytes), (err) => err instanceof ErasureError && err.code === "unsupported_manifest")
  })
})

describe("ipfs-erasure shard CID stability", () => {
  it("same input bytes produce same shard CIDs (raw codec, sha256)", async () => {
    const file = new Uint8Array(2048).fill(0x33)
    const a = await encodeFile(file, { n: 4, m: 2 })
    const b = await encodeFile(file, { n: 4, m: 2 })
    assert.deepEqual(
      a.shardBlocks.map((s) => s.cid),
      b.shardBlocks.map((s) => s.cid),
    )
  })

  it("shard CIDs are unique across distinct shards", async () => {
    const file = randomBytes(4 * 256 * 1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const ids = r.shardBlocks.map((s) => s.cid)
    assert.equal(new Set(ids).size, ids.length, "all shard CIDs are unique")
  })
})

describe("ipfs-erasure decode tolerance for malformed inputs", () => {
  it("rejects manifest with mismatching stripe.data.length vs n", async () => {
    const bad: ErasureManifest = {
      v: 1, scheme: "rs", n: 4, m: 2, shardSize: 256, fileSize: 1,
      stripes: [{ data: ["x"], parity: ["y", "z"] }] as ErasureStripe[],
    }
    await assert.rejects(
      () => decodeFile(bad, async () => null),
      (err) => err instanceof ErasureError && err.code === "malformed_manifest",
    )
  })

  it("rejects manifest with mismatching stripe.parity.length vs m", async () => {
    const bad: ErasureManifest = {
      v: 1, scheme: "rs", n: 4, m: 2, shardSize: 256, fileSize: 1,
      stripes: [{ data: ["a", "b", "c", "d"], parity: ["e"] }] as ErasureStripe[],
    }
    await assert.rejects(
      () => decodeFile(bad, async () => null),
      (err) => err instanceof ErasureError && err.code === "malformed_manifest",
    )
  })

  it("rejects manifest with unsupported version", async () => {
    const bad = {
      v: 2, scheme: "rs", n: 4, m: 2, shardSize: 256, fileSize: 1,
      stripes: [{ data: ["a", "b", "c", "d"], parity: ["e", "f"] }],
    } as unknown as ErasureManifest
    await assert.rejects(
      () => decodeFile(bad, async () => null),
      (err) => err instanceof ErasureError && err.code === "unsupported_manifest",
    )
  })

  it("rejects shard returned with wrong size", async () => {
    const file = new Uint8Array(1024)
    const r = await encodeFile(file, { n: 4, m: 2 })
    // First fetch returns a too-small shard; should surface as size_mismatch.
    let calls = 0
    const fetch = async (cid: CidString): Promise<Uint8Array | null> => {
      const original = r.shardBlocks.find((b) => b.cid === cid)?.bytes
      if (!original) return null
      if (calls++ === 0) return new Uint8Array(8) // first shard is wrong size
      return original
    }
    await assert.rejects(
      () => decodeFile(r.manifest, fetch),
      (err) => err instanceof ErasureError && err.code === "shard_size_mismatch",
    )
  })

  it("fileSize larger than stripe coverage rejected", async () => {
    const r = await encodeFile(new Uint8Array(8), { n: 4, m: 2 })
    const tampered: ErasureManifest = { ...r.manifest, fileSize: 999_999_999 }
    const store = makeShardStore(r.shardBlocks)
    await assert.rejects(
      () => decodeFile(tampered, store.fetch),
      (err) => err instanceof ErasureError && err.code === "malformed_manifest",
    )
  })
})

describe("ipfs-erasure storage-overhead expectations", () => {
  it("RS(4+2) writes (n+m)/n × file bytes (1.5×) for full stripes", async () => {
    const file = randomBytes(4 * DEFAULT_SHARD_SIZE) // exactly 1 stripe @ 256K shards
    const r = await encodeFile(file, { n: 4, m: 2 })
    const totalShardBytes = r.shardBlocks.reduce((sum, b) => sum + b.bytes.byteLength, 0)
    const expected = file.byteLength * (4 + 2) / 4
    assert.equal(totalShardBytes, expected, "shard inventory matches RS(4+2) overhead")
  })

  it("RS(6+3) is 1.5× overhead on full stripes", async () => {
    const file = randomBytes(6 * DEFAULT_SHARD_SIZE)
    const r = await encodeFile(file, { n: 6, m: 3 })
    const totalShardBytes = r.shardBlocks.reduce((sum, b) => sum + b.bytes.byteLength, 0)
    const expected = file.byteLength * (6 + 3) / 6
    assert.equal(totalShardBytes, expected)
  })
})

describe("ipfs-erasure decode resource caps (crafted-manifest DoS)", () => {
  // Security regression: an erasure manifest is content-addressed but its
  // *content* is attacker-chosen — anyone can publish a crafted dag-cbor
  // manifest and have a victim resolve its CID via /api/v0/cat. decodeFile
  // derives Buffer.alloc sizes and a fetch loop straight from manifest
  // fields, so a few-hundred-byte manifest declaring a huge shardSize /
  // stripe count could force a multi-GB allocation and OOM the node.
  const noFetch = async () => null

  it("rejects a manifest whose shardSize would force a multi-GB allocation", async () => {
    const manifest = {
      v: 1, scheme: "rs", n: 4, m: 2,
      shardSize: 2_000_000_000, // ~2 GB — pre-fix fed straight into Buffer.alloc
      fileSize: 0,
      stripes: [{ data: [], parity: [] }],
    } as unknown as ErasureManifest
    await assert.rejects(
      () => decodeFile(manifest, noFetch),
      (err: ErasureError) => err.code === "invalid_params",
      "an oversized shardSize must be rejected before allocation",
    )
  })

  it("rejects a manifest declaring more stripes than MAX_STRIPES", async () => {
    const stripes = Array.from({ length: MAX_STRIPES + 1 }, () => ({ data: [], parity: [] }))
    const manifest = {
      v: 1, scheme: "rs", n: 4, m: 2, shardSize: DEFAULT_SHARD_SIZE, fileSize: 0, stripes,
    } as unknown as ErasureManifest
    await assert.rejects(
      () => decodeFile(manifest, noFetch),
      (err: ErasureError) => err.code === "malformed_manifest",
    )
  })

  it("rejects a manifest whose decoded coverage exceeds the cap", async () => {
    // Each field is individually in range; only the product is abusive:
    // 64 stripes × 4 data shards × 16 MiB = 4 GiB of output buffer.
    const stripes = Array.from({ length: 64 }, () => ({ data: [], parity: [] }))
    const manifest = {
      v: 1, scheme: "rs", n: 4, m: 2, shardSize: MAX_SHARD_SIZE, fileSize: 0, stripes,
    } as unknown as ErasureManifest
    await assert.rejects(
      () => decodeFile(manifest, noFetch),
      (err: ErasureError) => err.code === "malformed_manifest",
    )
  })

  it("decodeManifest rejects a manifest whose stripes is not an array", async () => {
    const bytes = encodeManifest({
      v: 1, scheme: "rs", n: 4, m: 2, shardSize: DEFAULT_SHARD_SIZE, fileSize: 0,
      stripes: "not-an-array",
    } as unknown as ErasureManifest)
    assert.throws(
      () => decodeManifest(bytes),
      (err: ErasureError) => err.code === "malformed_manifest",
    )
  })

  it("a well-formed manifest still decodes (caps are not over-broad)", async () => {
    const file = randomBytes(3 * DEFAULT_SHARD_SIZE + 17)
    const r = await encodeFile(file, { n: 4, m: 2 })
    const back = await decodeFile(r.manifest, makeShardStore(r.shardBlocks).fetch)
    assert.deepEqual(Array.from(back), Array.from(file))
  })
})
