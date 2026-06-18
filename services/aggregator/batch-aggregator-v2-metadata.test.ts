// #667 — BatchAggregatorV2 metadata + signature output tests.
//
// Covers the new pieces buildBatch emits for `submitBatchV2WithMetadata`:
//   - challengeIds/nodeIds/responseBodyHashes/leafHashes are aligned and
//     length-equal across all receipts in the batch.
//   - witnessReceiptIndex[i] points at the first receipt whose
//     per-receipt bitmap has bit i set (primary attribution).
//   - witnessReceiptIndex unused slots default to 0xffff sentinel.
//   - witnessSignatures are ordered by bitmap bit position (ascending)
//     and prefer the v2 (witnessSigV2) signature when available.
//   - Throws when a per-receipt witness attestation is missing for a
//     set bit — fail loud rather than ship a quorum-failing batch.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { BatchAggregatorV2, type ReceiptBatchV2 } from "./batch-aggregator-v2.ts"
import { WITNESS_INDEX_UNUSED } from "../common/pose-types-v2.ts"
import type { VerifiedReceiptV2, WitnessAttestation } from "../common/pose-types-v2.ts"
import type { Hex32 } from "../common/pose-types.ts"

function hex32(label: string): Hex32 {
  const padded = label.padStart(64, "0")
  return `0x${padded}` as Hex32
}

function nonce16(label: string): `0x${string}` {
  return `0x${label.padStart(32, "0")}` as `0x${string}`
}

function makeWitness(
  bit: number,
  challengeId: Hex32,
  nodeId: Hex32,
  responseBodyHash: Hex32,
  withV2 = true,
): WitnessAttestation {
  return {
    challengeId,
    nodeId,
    responseBodyHash,
    witnessIndex: bit,
    attestedAtMs: 1n,
    witnessSig: `0x${"aa".repeat(64)}${bit.toString(16).padStart(2, "0")}` as `0x${string}`,
    ...(withV2
      ? { witnessSigV2: `0x${"bb".repeat(64)}${bit.toString(16).padStart(2, "0")}` as `0x${string}` }
      : {}),
  }
}

/** v3 variant — additionally carries a `witnessSigV3` (prefix cc...). */
function makeWitnessV3(
  bit: number,
  challengeId: Hex32,
  nodeId: Hex32,
  responseBodyHash: Hex32,
): WitnessAttestation {
  return {
    ...makeWitness(bit, challengeId, nodeId, responseBodyHash, true),
    witnessSigV3: `0x${"cc".repeat(64)}${bit.toString(16).padStart(2, "0")}` as `0x${string}`,
  }
}

function makeReceipt(label: string, witnessBits: number[], v2Sig = true, resultCode = 0): VerifiedReceiptV2 {
  const challengeId = hex32(label + "ch")
  const nodeId = hex32(label + "nd")
  const responseBodyHash = hex32(label + "rb")
  let bitmap = 0
  const witnesses: WitnessAttestation[] = []
  for (const bit of witnessBits) {
    bitmap |= 1 << bit
    witnesses.push(makeWitness(bit, challengeId, nodeId, responseBodyHash, v2Sig))
  }
  return {
    challenge: {
      version: 2,
      challengeId,
      epochId: 100n,
      nodeId,
      challengeType: "compute" as any,
      nonce: nonce16(label + "no"),
      challengeNonce: 1n,
      querySpec: {},
      querySpecHash: hex32(label + "qs"),
      issuedAtMs: 0n,
      deadlineMs: 9999,
      challengerId: hex32(label + "cr"),
      challengerSig: "0x" as `0x${string}`,
    },
    receipt: {
      challengeId,
      nodeId,
      responseAtMs: 1n,
      responseBody: {},
      responseBodyHash,
      tipHash: hex32(label + "tp"),
      tipHeight: 1n,
      nodeSig: "0x" as `0x${string}`,
    },
    witnesses,
    witnessBitmap: bitmap,
    evidenceLeaf: {
      epoch: 100n,
      nodeId,
      nonce: nonce16(label + "no"),
      tipHash: hex32(label + "tp"),
      tipHeight: 1n,
      latencyMs: 1,
      resultCode,
      witnessBitmap: bitmap,
    },
    verifiedAtMs: 0n,
  }
}

describe("BatchAggregatorV2 — #667 metadata + signatures", () => {
  const agg = new BatchAggregatorV2({ sampleSize: 1 })

  it("emits aligned per-receipt arrays", () => {
    const receipts = [
      makeReceipt("a", [0, 1]),
      makeReceipt("b", [1, 2]),
      makeReceipt("c", [3]),
    ]
    const batch = agg.buildBatch(100n, receipts)
    const m = batch.metadata
    assert.equal(m.challengeIds.length, 3)
    assert.equal(m.nodeIds.length, 3)
    assert.equal(m.responseBodyHashes.length, 3)
    assert.equal(m.leafHashes.length, 3)
    assert.equal(m.witnessReceiptIndex.length, 32)
    assert.equal(m.leafHashes[0], batch.leafHashes[0])
  })

  it("witnessReceiptIndex points to first receipt whose bitmap has the bit set", () => {
    // bit 0 only on receipt 0; bit 1 on both 0 and 1 (primary=0); bit 2 on receipt 1; bit 3 on receipt 2
    const receipts = [
      makeReceipt("a", [0, 1]),
      makeReceipt("b", [1, 2]),
      makeReceipt("c", [3]),
    ]
    const m = agg.buildBatch(100n, receipts).metadata
    assert.equal(m.witnessReceiptIndex[0], 0, "bit 0 → receipt 0")
    assert.equal(m.witnessReceiptIndex[1], 0, "bit 1 primary should be receipt 0 (first match)")
    assert.equal(m.witnessReceiptIndex[2], 1, "bit 2 → receipt 1")
    assert.equal(m.witnessReceiptIndex[3], 2, "bit 3 → receipt 2")
  })

  it("unused witnessReceiptIndex slots are 0xffff sentinel", () => {
    const receipts = [makeReceipt("only", [0, 5])]
    const m = agg.buildBatch(100n, receipts).metadata
    for (const bit of [1, 2, 3, 4, 6, 7, 31]) {
      assert.equal(
        m.witnessReceiptIndex[bit],
        WITNESS_INDEX_UNUSED,
        `bit ${bit} should be ${WITNESS_INDEX_UNUSED}`,
      )
    }
    assert.equal(m.witnessReceiptIndex[0], 0)
    assert.equal(m.witnessReceiptIndex[5], 0)
  })

  it("witnessSignatures are emitted in ascending bit order and prefer v2", () => {
    // bit 0 + bit 3 set; receipt index 0 has both, with v2 sigs.
    const r = makeReceipt("z", [0, 3])
    const batch = agg.buildBatch(100n, [r])
    assert.equal(batch.witnessSignatures.length, 2, "popcount(0b1001) = 2 → 2 sigs")
    // Must be the v2 signatures (witnessSigV2 prefix bb...)
    for (const sig of batch.witnessSignatures) {
      assert.ok(sig.toLowerCase().startsWith("0xbb"), `expected v2 prefix, got ${sig.slice(0, 6)}`)
    }
    // Trailing byte encodes the witness bit — ascending order.
    assert.equal(batch.witnessSignatures[0].slice(-2), "00", "first sig is bit 0")
    assert.equal(batch.witnessSignatures[1].slice(-2), "03", "second sig is bit 3")
  })

  it("falls back to v1 signature when v2 is not available", () => {
    const r = makeReceipt("v1only", [0], /* v2Sig */ false)
    const batch = agg.buildBatch(100n, [r])
    assert.equal(batch.witnessSignatures.length, 1)
    assert.ok(batch.witnessSignatures[0].toLowerCase().startsWith("0xaa"), "v1 prefix")
  })

  it("throws when a witness attestation is missing for a set bit", () => {
    // bit 0 is set in r.witnessBitmap but receipt has no attestation for it.
    const r = makeReceipt("z", [])
    r.witnessBitmap = 1 // claim bit 0 without the matching attestation
    assert.throws(() => agg.buildBatch(100n, [r]), /witness attestation missing for bit 0/)
  })

  // ── #746 — v3 + resultCodes coverage ────────────────────────────────────

  it("#746: prefers v3 signature when present (over v2 and v1)", () => {
    const challengeId = hex32("v3" + "ch")
    const nodeId = hex32("v3" + "nd")
    const responseBodyHash = hex32("v3" + "rb")
    const r = makeReceipt("v3", [0])
    // Replace the witness with one that carries v1+v2+v3 sigs.
    r.witnesses = [makeWitnessV3(0, challengeId, nodeId, responseBodyHash)]
    const batch = agg.buildBatch(100n, [r])
    assert.equal(batch.witnessSignatures.length, 1)
    assert.ok(
      batch.witnessSignatures[0].toLowerCase().startsWith("0xcc"),
      `expected v3 prefix, got ${batch.witnessSignatures[0].slice(0, 6)}`,
    )
  })

  it("#746: metadata.resultCodes is aligned with leafHashes and reads from evidenceLeaf", () => {
    // Three receipts with distinct resultCodes — aggregator must propagate
    // them in metadata so the contract can rebuild the v3 EIP-712 digest
    // using the same uint8 each witness signed.
    const receipts = [
      makeReceipt("ok", [0], true, /* resultCode */ 0),
      makeReceipt("tip", [1], true, /* resultCode */ 5),
      makeReceipt("rly", [2], true, /* resultCode */ 4),
    ]
    const batch = agg.buildBatch(100n, receipts)
    assert.deepEqual(batch.metadata.resultCodes, [0, 5, 4])
    assert.equal(batch.metadata.resultCodes.length, batch.metadata.leafHashes.length)
  })
})
