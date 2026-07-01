// #772 — regression test for the per-epoch dynamic witnessSet resolution.
//
// The pipeline pre-#772 broadcast to `config.witnessNodes` (static) with
// each entry's hardcoded `witnessIndex`. That index-space had no relation
// to `getWitnessSet(epochId)`'s per-epoch PRNG-sampled subset, so
// `_validateWitnessQuorumV2` recovered signers that didn't sit at the
// contract-expected slots and every batch reverted `InvalidWitnessQuorum()`.
//
// Fix (Option A, coc-agent.ts:computeDynamicWitnessNodesForEpoch): call
// `getWitnessSet(epochId)` at every tick and translate the returned
// nodeIds into WitnessNodeConfig entries whose `witnessIndex = position
// in getWitnessSet(...) result`. The tests below assert the alignment
// contract that keeps the on-chain and off-chain index spaces in sync.

import { test } from "node:test"
import assert from "node:assert/strict"
import type { WitnessNodeConfig } from "./witness-collector.ts"
import { collectWitnesses, type WitnessCollectorConfig } from "./witness-collector.ts"

type Hex32 = `0x${string}`

const CHALLENGE_ID: Hex32 = ("0x" + "aa".repeat(32)) as Hex32
const NODE_ID: Hex32 = ("0x" + "bb".repeat(32)) as Hex32
const RESPONSE_BODY_HASH: Hex32 = ("0x" + "cc".repeat(32)) as Hex32

/**
 * Simulate the per-epoch dynamic witnessSet build. This mirrors the shape
 * `computeDynamicWitnessNodesForEpoch` produces in coc-agent.ts, minus
 * the on-chain lookup — we're testing that the resulting shape drives
 * `collectWitnesses` to write a bitmap whose bit positions match the
 * on-chain witnessSet indices.
 */
function buildDynamicWitnessNodes(witnessSet: Hex32[], resolveEndpoint: (nodeId: Hex32) => string | null): WitnessNodeConfig[] {
  const nodes: WitnessNodeConfig[] = []
  for (let idx = 0; idx < witnessSet.length && idx < 32; idx++) {
    const url = resolveEndpoint(witnessSet[idx])
    if (!url) continue
    nodes.push({ url, witnessIndex: idx })
  }
  return nodes
}

test("#772: dynamic witnessNodes assigns witnessIndex == position in on-chain witnessSet", () => {
  const witnessSet: Hex32[] = [
    ("0x" + "11".repeat(32)) as Hex32,
    ("0x" + "22".repeat(32)) as Hex32,
    ("0x" + "33".repeat(32)) as Hex32,
  ]
  const nodes = buildDynamicWitnessNodes(witnessSet, () => "http://witness.example")
  assert.equal(nodes.length, 3)
  assert.equal(nodes[0].witnessIndex, 0)
  assert.equal(nodes[1].witnessIndex, 1)
  assert.equal(nodes[2].witnessIndex, 2)
})

test("#772: nodeIds with missing endpoints are skipped (dead witness), preserving the index of live members", () => {
  const witnessSet: Hex32[] = [
    ("0x" + "11".repeat(32)) as Hex32, // live
    ("0x" + "22".repeat(32)) as Hex32, // DEAD — no endpoint
    ("0x" + "33".repeat(32)) as Hex32, // live
  ]
  const nodes = buildDynamicWitnessNodes(witnessSet, (id) =>
    id === ("0x" + "22".repeat(32)) as Hex32 ? null : "http://witness.example",
  )
  assert.equal(nodes.length, 2, "dead node[1] must be filtered out")
  // Critical: nodes[1]'s witnessIndex must stay 2, NOT collapse to 1 —
  // otherwise the contract expects nodeOperator[witnessSet[1]] (dead) at
  // bit 1 while we'd be sending live node[2]'s signer there.
  assert.equal(nodes[0].witnessIndex, 0)
  assert.equal(nodes[1].witnessIndex, 2)
})

test("#772: bitmap from collectWitnesses matches the sparse witnessIndex layout after skipping dead nodes", async () => {
  const witnessSet: Hex32[] = [
    ("0x" + "11".repeat(32)) as Hex32,
    ("0x" + "22".repeat(32)) as Hex32, // dead
    ("0x" + "33".repeat(32)) as Hex32,
  ]
  const dynamicNodes = buildDynamicWitnessNodes(witnessSet, (id) =>
    id === ("0x" + "22".repeat(32)) as Hex32 ? null : `http://w-${id.slice(2, 6)}`,
  )
  assert.equal(dynamicNodes.length, 2)

  const collectorConfig: WitnessCollectorConfig = {
    witnessNodes: dynamicNodes,
    requiredWitnesses: 2,
    timeoutMs: 500,
  }

  // Mock requestFn: each witness echoes the exact witnessIndex the
  // collector sent, plus a fake sig. This is what a well-behaved
  // coc-pose-witness does after our fix — the index it signs with is
  // the one the challenger assigned, not one it picked itself.
  let sigCounter = 0
  const requestFn = async (
    url: string,
    _method: string,
    body?: unknown,
  ) => {
    const req = body as { challengeId: string; nodeId: string; responseBodyHash: string; witnessIndex: number }
    return {
      status: 200,
      json: {
        challengeId: req.challengeId,
        nodeId: req.nodeId,
        responseBodyHash: req.responseBodyHash,
        witnessIndex: req.witnessIndex,
        attestedAtMs: 1,
        witnessSig: ("0x" + (++sigCounter).toString(16).padStart(130, "0")) as `0x${string}`,
      },
    }
  }

  const result = await collectWitnesses(
    collectorConfig,
    CHALLENGE_ID,
    NODE_ID,
    RESPONSE_BODY_HASH,
    requestFn,
  )

  // bitmap should have bits 0 and 2 set (the live members), NOT bits 0
  // and 1. That's the whole point of the fix.
  assert.equal(result.bitmap, 0b101, `expected sparse bitmap 0b101, got ${result.bitmap.toString(2)}`)
  assert.equal(result.attestations.length, 2)
})

test("#772: witness that echoes a different witnessIndex is rejected (guards against collision/replay across slots)", async () => {
  const witnessSet: Hex32[] = [
    ("0x" + "11".repeat(32)) as Hex32,
    ("0x" + "33".repeat(32)) as Hex32,
  ]
  const dynamicNodes = buildDynamicWitnessNodes(witnessSet, () => "http://witness.example")
  assert.equal(dynamicNodes.length, 2)

  // Malicious witness: server echoes witnessIndex=0 for every request,
  // trying to double-count as bit 0. The collector's per-request guard
  // must reject the second attempt so the bitmap only has bit 0 set.
  const requestFn = async (
    _url: string,
    _method: string,
    body?: unknown,
  ) => {
    const req = body as { challengeId: string; nodeId: string; responseBodyHash: string; witnessIndex: number }
    return {
      status: 200,
      json: {
        challengeId: req.challengeId,
        nodeId: req.nodeId,
        responseBodyHash: req.responseBodyHash,
        witnessIndex: 0, // ← malicious: echoes 0 regardless
        attestedAtMs: 1,
        witnessSig: ("0x" + "de".repeat(65)) as `0x${string}`,
      },
    }
  }

  const result = await collectWitnesses(
    {
      witnessNodes: dynamicNodes,
      requiredWitnesses: 1,
      timeoutMs: 500,
    },
    CHALLENGE_ID,
    NODE_ID,
    RESPONSE_BODY_HASH,
    requestFn,
  )

  // Only the witness assigned index 0 should pass — the one assigned
  // index 1 gets rejected because attest.witnessIndex !== w.witnessIndex.
  // Bitmap ends up 0b01, NOT 0b11.
  assert.equal(result.bitmap, 0b01, `expected 0b01 after collision rejection, got ${result.bitmap.toString(2)}`)
  assert.equal(result.attestations.length, 1)
})
