import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { SlashEvidence } from "../services/verifier/anti-cheat-policy.ts"
import {
  buildBftEquivocationSlashEvidence,
  normalizeEquivocationRpcEntry,
  type EquivocationEvidence,
} from "./lib/bft-equivocation.ts"

describe("BFT -> PoSe slash bridge", () => {
  it("normalizes RPC evidence with phase-first semantics", () => {
    const evidence = normalizeEquivocationRpcEntry({
      validatorId: "node-1",
      height: "100",
      phase: "prepare",
      vote1Hash: "0x" + "aa".repeat(32),
      vote2Hash: "0x" + "bb".repeat(32),
      timestamp: 1700000000000,
    })

    assert.ok(evidence)
    assert.equal(evidence?.validatorId, "node-1")
    assert.equal(evidence?.height, 100n)
    assert.equal(evidence?.phase, "prepare")
    assert.equal(evidence?.round, undefined)
  })

  it("falls back to round when phase is not available", () => {
    const evidence = normalizeEquivocationRpcEntry({
      validatorId: "node-2",
      height: "200",
      round: 3,
      vote1Hash: "0x" + "cc".repeat(32),
      vote2Hash: "0x" + "dd".repeat(32),
      timestamp: 1700000001000,
    })

    assert.ok(evidence)
    assert.equal(evidence?.phase, undefined)
    assert.equal(evidence?.round, 3)
  })

  it("builds slash evidence with phase in reason and raw payload", () => {
    const evidence: EquivocationEvidence = {
      validatorId: "node-3",
      height: 300n,
      phase: "commit",
      vote1Hash: "0x" + "11".repeat(32),
      vote2Hash: "0x" + "22".repeat(32),
      timestamp: 1700000002000,
    }

    const slashEvidence: SlashEvidence = buildBftEquivocationSlashEvidence(evidence)

    assert.equal(slashEvidence.offender, "node-3")
    assert.equal(slashEvidence.rawEvidence.protocolVersion, 2)
    assert.equal(slashEvidence.rawEvidence.faultType, "equivocation")
    assert.equal(slashEvidence.rawEvidence.phase, "commit")
    assert.ok(slashEvidence.reason.includes("phase commit"))
  })

  it("rejects malformed RPC evidence without hashes", () => {
    const evidence = normalizeEquivocationRpcEntry({
      validatorId: "node-4",
      height: "400",
      phase: "prepare",
      vote1Hash: "",
    })

    assert.equal(evidence, null)
  })
})
