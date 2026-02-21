/**
 * BFT Slashing Integration Tests
 *
 * End-to-end tests for the equivocation detection → slashing → governance penalty pipeline:
 * 1. EquivocationDetector detects double-voting
 * 2. BftSlashingHandler calculates and applies penalty
 * 3. ValidatorGovernance reduces stake and deposits treasury
 * 4. Validator removed if stake falls below threshold
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { EquivocationDetector } from "./bft.ts"
import type { EquivocationEvidence } from "./bft.ts"
import { BftSlashingHandler } from "./bft-slashing.ts"
import type { SlashEvent } from "./bft-slashing.ts"
import { ValidatorGovernance } from "./validator-governance.ts"
import type { Hex } from "./blockchain-types.ts"

function setupGovernance(stakes: bigint[] = [100n, 100n, 100n]): ValidatorGovernance {
  const gov = new ValidatorGovernance({
    minStake: 10n,
    maxValidators: 10,
    proposalDurationEpochs: 24n,
    approvalThresholdPercent: 67,
    minVoterPercent: 50,
  })
  gov.initGenesis(
    stakes.map((stake, i) => ({
      id: `validator-${i}`,
      address: `0x${"0".repeat(39)}${i}`,
      stake,
    })),
  )
  return gov
}

describe("BFT Slashing Integration", () => {
  describe("equivocation detection → slashing pipeline", () => {
    it("should detect equivocation and slash validator stake", () => {
      const gov = setupGovernance([100n, 100n, 100n])
      const detector = new EquivocationDetector()
      const slasher = new BftSlashingHandler(gov, { slashPercent: 10 })

      // Validator-0 votes for two different blocks at same height
      const ev1 = detector.recordVote("validator-0", 10n, "prepare", "0xaaa" as Hex)
      assert.equal(ev1, null) // first vote is fine

      const ev2 = detector.recordVote("validator-0", 10n, "prepare", "0xbbb" as Hex)
      assert.ok(ev2) // equivocation detected!
      assert.equal(ev2.validatorId, "validator-0")
      assert.equal(ev2.blockHash1, "0xaaa")
      assert.equal(ev2.blockHash2, "0xbbb")

      // Apply slashing
      const slashEvent = slasher.handleEquivocation(ev2)
      assert.ok(slashEvent)
      assert.equal(slashEvent.slashedAmount, 10n) // 10% of 100
      assert.equal(slashEvent.remainingStake, 90n)
      assert.equal(slashEvent.removed, false) // 90 > minStake(10)

      // Verify governance state
      const v0 = gov.getValidator("validator-0")
      assert.ok(v0)
      assert.equal(v0.stake, 90n)
      assert.equal(v0.active, true)

      // Treasury received slashed amount
      assert.equal(gov.getTreasuryBalance(), 10n)
    })

    it("should remove validator when stake falls below minimum after slash", () => {
      const gov = setupGovernance([15n, 100n, 100n]) // validator-0 has low stake
      const detector = new EquivocationDetector()
      const slasher = new BftSlashingHandler(gov, { slashPercent: 50 })

      // Create equivocation
      detector.recordVote("validator-0", 5n, "prepare", "0xaaa" as Hex)
      const ev = detector.recordVote("validator-0", 5n, "prepare", "0xbbb" as Hex)
      assert.ok(ev)

      // Slash 50% of 15 = 7 → remaining 8 < minStake(10)
      const slashEvent = slasher.handleEquivocation(ev)
      assert.ok(slashEvent)
      assert.equal(slashEvent.slashedAmount, 7n) // floor(15 * 50 / 100)
      assert.equal(slashEvent.remainingStake, 8n)
      assert.equal(slashEvent.removed, true)

      // Validator should be inactive
      const v0 = gov.getValidator("validator-0")
      assert.ok(v0)
      assert.equal(v0.active, false)

      // Active validator count reduced
      assert.equal(gov.activeCount(), 2)
    })
  })

  describe("repeated equivocations", () => {
    it("should apply cumulative slashing for repeat offenders", () => {
      const gov = setupGovernance([1000n, 100n, 100n])
      const detector = new EquivocationDetector()
      const slasher = new BftSlashingHandler(gov, { slashPercent: 10 })

      // First equivocation at height 10
      detector.recordVote("validator-0", 10n, "prepare", "0xaaa" as Hex)
      const ev1 = detector.recordVote("validator-0", 10n, "prepare", "0xbbb" as Hex)
      assert.ok(ev1)
      slasher.handleEquivocation(ev1)

      let v0 = gov.getValidator("validator-0")!
      assert.equal(v0.stake, 900n) // 1000 - 100

      // Second equivocation at height 20
      detector.recordVote("validator-0", 20n, "commit", "0xccc" as Hex)
      const ev2 = detector.recordVote("validator-0", 20n, "commit", "0xddd" as Hex)
      assert.ok(ev2)
      slasher.handleEquivocation(ev2)

      v0 = gov.getValidator("validator-0")!
      assert.equal(v0.stake, 810n) // 900 - 90 (10% of 900)

      // Total slashed
      assert.equal(slasher.getTotalSlashed(), 190n) // 100 + 90
      assert.equal(slasher.getSlashesFor("validator-0").length, 2)
      assert.equal(gov.getTreasuryBalance(), 190n)
    })
  })

  describe("slash event callback", () => {
    it("should invoke onSlash callback with event details", () => {
      const gov = setupGovernance([100n, 100n, 100n])
      const events: SlashEvent[] = []
      const slasher = new BftSlashingHandler(
        gov,
        { slashPercent: 25 },
        (ev) => events.push(ev),
      )

      const evidence: EquivocationEvidence = {
        validatorId: "validator-1",
        height: 42n,
        phase: "commit",
        blockHash1: "0xaaa" as Hex,
        blockHash2: "0xbbb" as Hex,
        detectedAtMs: Date.now(),
      }

      slasher.handleEquivocation(evidence)

      assert.equal(events.length, 1)
      assert.equal(events[0].validatorId, "validator-1")
      assert.equal(events[0].slashedAmount, 25n)
      assert.equal(events[0].height, 42n)
      assert.equal(events[0].phase, "commit")
    })
  })

  describe("edge cases", () => {
    it("should handle unknown validator gracefully", () => {
      const gov = setupGovernance([100n, 100n, 100n])
      const slasher = new BftSlashingHandler(gov)

      const evidence: EquivocationEvidence = {
        validatorId: "unknown-validator",
        height: 1n,
        phase: "prepare",
        blockHash1: "0xaaa" as Hex,
        blockHash2: "0xbbb" as Hex,
        detectedAtMs: Date.now(),
      }

      const result = slasher.handleEquivocation(evidence)
      assert.equal(result, null) // no penalty for unknown validator
    })

    it("should handle zero stake validator", () => {
      const gov = setupGovernance([0n, 100n, 100n])
      const slasher = new BftSlashingHandler(gov, { slashPercent: 50 })

      const evidence: EquivocationEvidence = {
        validatorId: "validator-0",
        height: 1n,
        phase: "prepare",
        blockHash1: "0xaaa" as Hex,
        blockHash2: "0xbbb" as Hex,
        detectedAtMs: Date.now(),
      }

      const result = slasher.handleEquivocation(evidence)
      assert.ok(result)
      assert.equal(result.slashedAmount, 0n)
      assert.equal(result.removed, true) // 0 < minStake(10)
    })

    it("should reject invalid slashPercent", () => {
      const gov = setupGovernance()
      assert.throws(
        () => new BftSlashingHandler(gov, { slashPercent: -5 }),
        /slashPercent must be between 0 and 100/,
      )
      assert.throws(
        () => new BftSlashingHandler(gov, { slashPercent: 101 }),
        /slashPercent must be between 0 and 100/,
      )
    })

    it("should not remove validator when autoRemove is false", () => {
      const gov = setupGovernance([15n, 100n, 100n])
      const slasher = new BftSlashingHandler(gov, { slashPercent: 80, autoRemove: false })

      const evidence: EquivocationEvidence = {
        validatorId: "validator-0",
        height: 1n,
        phase: "prepare",
        blockHash1: "0xaaa" as Hex,
        blockHash2: "0xbbb" as Hex,
        detectedAtMs: Date.now(),
      }

      const result = slasher.handleEquivocation(evidence)
      assert.ok(result)
      assert.equal(result.removed, false)

      const v0 = gov.getValidator("validator-0")!
      assert.equal(v0.active, true) // still active despite low stake
      assert.equal(v0.stake, 3n) // 15 - 12 (80%)
    })
  })

  describe("full BFT coordinator integration", () => {
    it("should detect equivocation via coordinator callback and slash", () => {
      const gov = setupGovernance([500n, 500n, 500n])
      const detector = new EquivocationDetector()
      const slasher = new BftSlashingHandler(gov, { slashPercent: 20 })

      // Simulate coordinator's onEquivocation callback
      const onEquivocation = (ev: EquivocationEvidence) => {
        slasher.handleEquivocation(ev)
      }

      // Validator double-votes (simulating what BftCoordinator does)
      const ev = detector.recordVote("validator-2", 100n, "prepare", "0xfff" as Hex)
      assert.equal(ev, null) // first vote

      const evidence = detector.recordVote("validator-2", 100n, "prepare", "0x000" as Hex)
      assert.ok(evidence)

      onEquivocation(evidence)

      // Verify results
      const v2 = gov.getValidator("validator-2")!
      assert.equal(v2.stake, 400n) // 500 - 100
      assert.equal(v2.active, true)
      assert.equal(gov.getTreasuryBalance(), 100n)
      assert.equal(slasher.getSlashHistory().length, 1)
    })
  })
})
