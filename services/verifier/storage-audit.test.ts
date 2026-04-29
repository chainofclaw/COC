import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hashLeaf } from "../../node/src/ipfs-merkle.ts"
import {
  auditStorageReceipt,
  shouldSampleAudit,
  type StorageAuditDeps,
  type StorageAuditInput,
} from "./storage-audit.ts"

// Deterministic RNG for sample tests. Cycles through a fixed sequence
// of values so assertions can rely on exactly which receipts sample.
function seqRng(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

describe("shouldSampleAudit", () => {
  it("never samples when sampleBps <= 0", () => {
    assert.equal(shouldSampleAudit(() => 0, 0), false)
    assert.equal(shouldSampleAudit(() => 0, -100), false)
  })

  it("always samples when sampleBps >= 10000", () => {
    assert.equal(shouldSampleAudit(() => 0.9999, 10_000), true)
    assert.equal(shouldSampleAudit(() => 0.9999, 20_000), true)
  })

  it("samples when RNG draw falls below threshold", () => {
    // 500 bps = 5%. RNG value 0.04 → 0.04*10000 = 400, below 500 → sample.
    assert.equal(shouldSampleAudit(() => 0.04, 500), true)
    // RNG value 0.06 → 600, above 500 → skip.
    assert.equal(shouldSampleAudit(() => 0.06, 500), false)
  })
})

describe("auditStorageReceipt", () => {
  const claimedCid = "bafyProver"
  const proverBytes = Buffer.from("real chunk content")
  const expectedLeafHash = hashLeaf(proverBytes)

  const input: StorageAuditInput = {
    cid: claimedCid,
    leafHash: expectedLeafHash,
    proverNodeId: "0xprover",
    chunkIndex: 0,
  }

  function mkDeps(overrides: Partial<StorageAuditDeps>): StorageAuditDeps {
    return {
      fetchChunkExcluding: async () => proverBytes,
      rng: () => 0.01, // default: always sample
      auditSampleBps: 10_000, // default: always sample
      ...overrides,
    }
  }

  it("returns not-sampled when draw is above threshold", async () => {
    const result = await auditStorageReceipt(
      mkDeps({ rng: () => 0.99, auditSampleBps: 500 }),
      input,
    )
    assert.deepEqual(result, { audited: false, reason: "not-sampled" })
  })

  it("returns pass when peer bytes hash matches prover leafHash", async () => {
    const result = await auditStorageReceipt(mkDeps({}), input)
    assert.deepEqual(result, { audited: true, passed: true })
  })

  it("returns fail with mismatch details when peer bytes reproduce a different hash", async () => {
    const fakeBytes = Buffer.from("different content, fabricated proof")
    const result = await auditStorageReceipt(
      mkDeps({ fetchChunkExcluding: async () => fakeBytes }),
      input,
    )
    assert.equal(result.audited, true)
    if (result.audited) {
      assert.equal(result.passed, false)
      if (!result.passed) {
        assert.equal(result.reason, "leaf-hash-mismatch")
        assert.equal(result.expected.toLowerCase(), expectedLeafHash.toLowerCase())
        assert.equal(result.actual.toLowerCase(), hashLeaf(fakeBytes).toLowerCase())
      }
    }
  })

  it("returns no-bytes-returned when fetch yields null (inconclusive)", async () => {
    const result = await auditStorageReceipt(
      mkDeps({ fetchChunkExcluding: async () => null }),
      input,
    )
    assert.deepEqual(result, { audited: false, reason: "no-bytes-returned" })
  })

  it("returns no-bytes-returned when fetch throws (inconclusive)", async () => {
    const result = await auditStorageReceipt(
      mkDeps({ fetchChunkExcluding: async () => { throw new Error("net") } }),
      input,
    )
    assert.deepEqual(result, { audited: false, reason: "no-bytes-returned" })
  })

  it("returns no-bytes-returned when fetch yields zero-length buffer", async () => {
    const result = await auditStorageReceipt(
      mkDeps({ fetchChunkExcluding: async () => new Uint8Array(0) }),
      input,
    )
    assert.deepEqual(result, { audited: false, reason: "no-bytes-returned" })
  })

  it("passes excludePeerId through to the fetch implementation", async () => {
    let calledWithExclude: string | null = null
    await auditStorageReceipt(
      mkDeps({
        fetchChunkExcluding: async (_cid, excludePeerId) => {
          calledWithExclude = excludePeerId
          return proverBytes
        },
      }),
      input,
    )
    assert.equal(calledWithExclude, "0xprover")
  })

  it("compares leafHash case-insensitively", async () => {
    const mixedCaseInput: StorageAuditInput = {
      ...input,
      leafHash: expectedLeafHash.toUpperCase(),
    }
    const result = await auditStorageReceipt(mkDeps({}), mixedCaseInput)
    assert.deepEqual(result, { audited: true, passed: true })
  })

  it("sampling frequency matches the configured basis points", async () => {
    // Across 10000 draws with a uniform-enough RNG, the sampled
    // fraction should be ~5% (±1% tolerance).
    const values: number[] = []
    for (let i = 0; i < 10_000; i++) values.push(i / 10_000)
    const rng = seqRng(values)
    let sampled = 0
    for (let i = 0; i < 10_000; i++) {
      if (shouldSampleAudit(rng, 500)) sampled++
    }
    assert.ok(
      sampled > 480 && sampled < 520,
      `expected ~500 samples (±20), got ${sampled}`,
    )
  })
})
