import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Hex32 } from "../../services/common/pose-types.ts"
import { collectBatchWitnessSignatures, collectWitnesses } from "./witness-collector.ts"

// Test the bitmap/quorum logic in isolation (no real HTTP)
describe("witness-collector", () => {
  it("popcount correctly counts bits", () => {
    // Testing via the module's internal logic by simulating results
    function popcount(n: number): number {
      let count = 0
      let v = n
      while (v) {
        count += v & 1
        v >>>= 1
      }
      return count
    }

    assert.equal(popcount(0), 0)
    assert.equal(popcount(1), 1)
    assert.equal(popcount(0b111), 3)
    assert.equal(popcount(0b10101010), 4)
    assert.equal(popcount(0xFFFFFFFF), 32)
  })

  it("bitmap construction from witness indices", () => {
    const indices = [0, 2, 5]
    let bitmap = 0
    for (const i of indices) {
      bitmap |= (1 << i)
    }
    assert.equal(bitmap, 0b100101) // bits 0, 2, 5

    // Verify each bit
    assert.ok(bitmap & (1 << 0))
    assert.ok(!(bitmap & (1 << 1)))
    assert.ok(bitmap & (1 << 2))
    assert.ok(!(bitmap & (1 << 3)))
    assert.ok(!(bitmap & (1 << 4)))
    assert.ok(bitmap & (1 << 5))
  })

  it("quorum check: meets threshold", () => {
    const required = 3
    const bitmap = 0b1111 // 4 witnesses
    let count = 0
    let v = bitmap
    while (v) { count += v & 1; v >>>= 1 }

    assert.ok(count >= required)
  })

  it("quorum check: below threshold", () => {
    const required = 3
    const bitmap = 0b11 // 2 witnesses
    let count = 0
    let v = bitmap
    while (v) { count += v & 1; v >>>= 1 }

    assert.ok(count < required)
  })

  it("witness index capped at 32", () => {
    // indices >= 32 should be ignored
    let bitmap = 0
    const indices = [0, 1, 33, 64]
    for (const i of indices) {
      if (i < 32) {
        bitmap |= (1 << i)
      }
    }
    assert.equal(bitmap, 0b11) // only 0 and 1
  })

  it("partial results with some failures", () => {
    // Simulate: 5 witnesses, 2 fail, 3 succeed
    const results = [
      { ok: true, index: 0 },
      { ok: false, index: 1 },
      { ok: true, index: 2 },
      { ok: false, index: 3 },
      { ok: true, index: 4 },
    ]

    let bitmap = 0
    const attestations: unknown[] = []
    for (const r of results) {
      if (r.ok) {
        bitmap |= (1 << r.index)
        attestations.push({ witnessIndex: r.index })
      }
    }

    assert.equal(attestations.length, 3)
    assert.equal(bitmap, 0b10101) // bits 0, 2, 4

    let count = 0
    let v = bitmap
    while (v) { count += v & 1; v >>>= 1 }
    assert.equal(count, 3)
  })

  it("collectBatchWitnessSignatures returns ordered signatures and quorum", async () => {
    const merkleRoot = `0x${"ab".repeat(32)}` as Hex32
    const witnessSet = [
      `0x${"01".repeat(32)}`,
      `0x${"02".repeat(32)}`,
      `0x${"03".repeat(32)}`,
    ] as Hex32[]
    const mkSig = (byte: string) => `0x${byte.repeat(130)}`

    const result = await collectBatchWitnessSignatures(
      merkleRoot,
      witnessSet,
      (_nodeId, witnessIndex) => `http://witness-${witnessIndex}.local`,
      async (url, _method, body) => {
        const payload = body as { witnessIndex: number; nodeId: string; challengeId: string; responseBodyHash: string }
        const index = Number(url.split("-").at(-1)?.split(".")[0] ?? "0")
        return {
          status: 200,
          json: {
            challengeId: payload.challengeId,
            nodeId: payload.nodeId,
            responseBodyHash: payload.responseBodyHash,
            witnessIndex: index,
            witnessSig: mkSig((index + 1).toString(16)),
          },
        }
      },
    )

    assert.equal(result.bitmap, 0b111)
    assert.equal(result.signedCount, 3)
    assert.equal(result.requiredCount, 2)
    assert.equal(result.quorumMet, true)
    assert.equal(result.signatures.length, 3)
    assert.equal(result.signatures[0], mkSig("1"))
    assert.equal(result.signatures[1], mkSig("2"))
    assert.equal(result.signatures[2], mkSig("3"))
  })

  it("collectBatchWitnessSignatures drops invalid responses and reports quorum miss", async () => {
    const merkleRoot = `0x${"cd".repeat(32)}` as Hex32
    const witnessSet = [
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
      `0x${"33".repeat(32)}`,
    ] as Hex32[]
    const validSig = `0x${"aa".repeat(65)}`

    const result = await collectBatchWitnessSignatures(
      merkleRoot,
      witnessSet,
      (_nodeId, witnessIndex) => (witnessIndex === 2 ? null : `http://witness-${witnessIndex}.local`),
      async (url, _method, body) => {
        const payload = body as { witnessIndex: number; nodeId: string; challengeId: string; responseBodyHash: string }
        if (url.includes("witness-0")) {
          return {
            status: 200,
            json: {
              challengeId: payload.challengeId,
              nodeId: payload.nodeId,
              responseBodyHash: payload.responseBodyHash,
              witnessIndex: 0,
              witnessSig: validSig,
            },
          }
        }
        return {
          status: 200,
          json: {
            challengeId: payload.challengeId,
            nodeId: `0x${"ff".repeat(32)}`, // wrong node id -> should be dropped
            responseBodyHash: payload.responseBodyHash,
            witnessIndex: 1,
            witnessSig: validSig,
          },
        }
      },
    )

    assert.equal(result.bitmap, 0b001)
    assert.equal(result.signedCount, 1)
    assert.equal(result.requiredCount, 2)
    assert.equal(result.quorumMet, false)
    assert.equal(result.signatures.length, 1)
  })

  it("collectWitnesses sets each bit from the assigned index", async () => {
    const challengeId = `0x${"a1".repeat(32)}` as Hex32
    const nodeId = `0x${"b2".repeat(32)}` as Hex32
    const responseBodyHash = `0x${"c3".repeat(32)}` as Hex32
    const sig = `0x${"dd".repeat(65)}`

    const result = await collectWitnesses(
      {
        witnessNodes: [
          { url: "http://w0.local", witnessIndex: 0 },
          { url: "http://w1.local", witnessIndex: 1 },
          { url: "http://w2.local", witnessIndex: 2 },
        ],
        requiredWitnesses: 2,
        timeoutMs: 1000,
      },
      challengeId,
      nodeId,
      responseBodyHash,
      async (_url, _method, body) => {
        const p = body as { witnessIndex: number }
        return {
          status: 200,
          json: {
            challengeId, nodeId, responseBodyHash,
            witnessIndex: p.witnessIndex,
            attestedAtMs: 1n,
            witnessSig: sig,
          },
        }
      },
    )

    assert.equal(result.bitmap, 0b111)
    assert.equal(result.attestations.length, 3)
    assert.equal(result.quorumMet, true)
  })

  it("collectWitnesses rejects a response claiming a slot it was not assigned (#668)", async () => {
    const challengeId = `0x${"a1".repeat(32)}` as Hex32
    const nodeId = `0x${"b2".repeat(32)}` as Hex32
    const responseBodyHash = `0x${"c3".repeat(32)}` as Hex32
    const sig = `0x${"dd".repeat(65)}`

    // The witness assigned slot 1 lies and claims slot 0. Its response must
    // be dropped — the bitmap bit is pinned to the collector-assigned index,
    // never the witness-claimed one, so evidenceLeaf.witnessBitmap stays
    // semantically honest ("bit i == witness i attested").
    const result = await collectWitnesses(
      {
        witnessNodes: [
          { url: "http://w0.local", witnessIndex: 0 },
          { url: "http://w1.local", witnessIndex: 1 },
          { url: "http://w2.local", witnessIndex: 2 },
        ],
        requiredWitnesses: 2,
        timeoutMs: 1000,
      },
      challengeId,
      nodeId,
      responseBodyHash,
      async (url, _method, body) => {
        const p = body as { witnessIndex: number }
        const claimed = url.includes("w1.local") ? 0 : p.witnessIndex
        return {
          status: 200,
          json: {
            challengeId, nodeId, responseBodyHash,
            witnessIndex: claimed,
            attestedAtMs: 1n,
            witnessSig: sig,
          },
        }
      },
    )

    // w1's wrong-index response is dropped; only honest w0 + w2 remain.
    assert.equal(result.bitmap, 0b101)
    assert.equal(result.attestations.length, 2)
    assert.equal(result.quorumMet, true)
  })
})
