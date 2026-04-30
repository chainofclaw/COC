/**
 * Tests for runtime/lib/bft-slash-bridge.ts (Phase I3b).
 *
 * Round-trips: in-process EquivocationEvidence → submitEvidence calldata
 * → decodes back to the same fields. Plus rejection tests for malformed
 * input that the contract would otherwise revert on.
 */

import { test } from "node:test"
import assert from "node:assert"
import { Wallet } from "ethers"
import type { Hex } from "../../node/src/blockchain-types.ts"
import type { EquivocationEvidence } from "../../node/src/bft.ts"
import { buildSubmitEvidenceCall, decodeSubmitEvidenceCall } from "./bft-slash-bridge.ts"

const DETECTOR = "0x000000000000000000000000000000000000aBcD"

function bftCanonicalMessage(phase: string, height: bigint, blockHash: string): string {
  return `bft:${phase}:${height.toString()}:${blockHash}`
}

async function makeEvidence(
  wallet: Wallet,
  phase: "prepare" | "commit" = "prepare",
  height: bigint = 42n,
): Promise<{ evidence: EquivocationEvidence; nodeId: string }> {
  const hashA = "0x" + "11".repeat(32)
  const hashB = "0x" + "22".repeat(32)
  const sigA = (await wallet.signMessage(bftCanonicalMessage(phase, height, hashA))) as Hex
  const sigB = (await wallet.signMessage(bftCanonicalMessage(phase, height, hashB))) as Hex
  // nodeId for tests: 12 zero bytes + 20-byte address. Bridge only validates
  // the 20-byte trailer, so leading bytes are arbitrary.
  const addr = wallet.address.toLowerCase()
  const nodeId = "0x" + "00".repeat(12) + addr.slice(2)
  return {
    evidence: {
      validatorId: addr,
      height,
      phase,
      blockHash1: hashA as Hex,
      blockHash2: hashB as Hex,
      detectedAtMs: 0,
      signature1: sigA,
      signature2: sigB,
    },
    nodeId,
  }
}

test("Phase I3b: round-trip evidence → submitEvidence calldata → decodes back", async () => {
  const wallet = Wallet.createRandom()
  const { evidence, nodeId } = await makeEvidence(wallet)

  const call = buildSubmitEvidenceCall(evidence, { detectorAddress: DETECTOR, nodeId })
  assert.strictEqual(call.to, DETECTOR)
  assert.strictEqual(call.nodeId, nodeId)
  assert.ok(call.data.startsWith("0x"))

  const decoded = decodeSubmitEvidenceCall(call.data)
  assert.strictEqual(decoded.nodeId.toLowerCase(), nodeId.toLowerCase())
  assert.strictEqual(decoded.phase, evidence.phase)
  assert.strictEqual(decoded.height, evidence.height)
  assert.strictEqual(decoded.hashA.toLowerCase(), evidence.blockHash1.toLowerCase())
  assert.strictEqual(decoded.hashB.toLowerCase(), evidence.blockHash2.toLowerCase())
  assert.strictEqual(decoded.sigA.toLowerCase(), evidence.signature1!.toLowerCase())
  assert.strictEqual(decoded.sigB.toLowerCase(), evidence.signature2!.toLowerCase())
})

test("Phase I3b: rejects evidence with missing signatures", async () => {
  const wallet = Wallet.createRandom()
  const { evidence, nodeId } = await makeEvidence(wallet)
  const incomplete: EquivocationEvidence = { ...evidence, signature2: undefined }

  assert.throws(
    () => buildSubmitEvidenceCall(incomplete, { detectorAddress: DETECTOR, nodeId }),
    /missing signatures/,
  )
})

test("Phase I3b: rejects nodeId whose trailing 20 bytes don't match validatorId", async () => {
  const wallet = Wallet.createRandom()
  const { evidence } = await makeEvidence(wallet)
  // Wrong trailer
  const wrongNodeId =
    "0x" + "ff".repeat(12) + "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

  assert.throws(
    () => buildSubmitEvidenceCall(evidence, { detectorAddress: DETECTOR, nodeId: wrongNodeId }),
    /trailer .* does not match validatorId/,
  )
})

test("Phase I3b: rejects malformed detector address", async () => {
  const wallet = Wallet.createRandom()
  const { evidence, nodeId } = await makeEvidence(wallet)

  assert.throws(
    () => buildSubmitEvidenceCall(evidence, { detectorAddress: "0xdeadbeef", nodeId }),
    /malformed detector address/,
  )
})

test("Phase I3b: rejects equal hashes (not equivocation)", async () => {
  const wallet = Wallet.createRandom()
  const { evidence, nodeId } = await makeEvidence(wallet)
  const sameHash = evidence.blockHash1
  const broken: EquivocationEvidence = {
    ...evidence,
    blockHash2: sameHash,
  }

  assert.throws(
    () => buildSubmitEvidenceCall(broken, { detectorAddress: DETECTOR, nodeId }),
    /blockHashes are equal/,
  )
})
