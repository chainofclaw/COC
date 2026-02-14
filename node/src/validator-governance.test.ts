/**
 * Tests for ValidatorGovernance
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { ValidatorGovernance } from "./validator-governance.ts"

const STAKE = 10000000000000000000n // 10 ETH

describe("ValidatorGovernance", () => {
  let gov: ValidatorGovernance

  beforeEach(() => {
    gov = new ValidatorGovernance({
      minStake: 1000000000000000000n, // 1 ETH
      maxValidators: 10,
      proposalDurationEpochs: 24n,
      approvalThresholdPercent: 67,
      minVoterPercent: 50,
    })
    gov.initGenesis([
      { id: "v1", address: "0x1111", stake: STAKE },
      { id: "v2", address: "0x2222", stake: STAKE },
      { id: "v3", address: "0x3333", stake: STAKE },
    ])
  })

  it("initializes genesis validators", () => {
    assert.equal(gov.activeCount(), 3)
    const v1 = gov.getValidator("v1")
    assert.ok(v1)
    assert.equal(v1.active, true)
    assert.equal(v1.stake, STAKE)
  })

  it("assigns equal voting power for equal stakes", () => {
    const v1 = gov.getValidator("v1")!
    assert.equal(v1.votingPower, 33) // 33% of total
  })

  it("returns ordered validator IDs", () => {
    const ids = gov.getValidatorIds()
    assert.deepEqual(ids, ["v1", "v2", "v3"])
  })

  it("creates add_validator proposal", () => {
    const proposal = gov.submitProposal("add_validator", "v4", "v1", {
      targetAddress: "0x4444",
      stakeAmount: STAKE,
    })
    assert.equal(proposal.type, "add_validator")
    assert.equal(proposal.status, "pending")
    assert.equal(proposal.votes.size, 1) // Proposer auto-votes
  })

  it("rejects proposal from non-validator", () => {
    assert.throws(
      () => gov.submitProposal("add_validator", "v4", "unknown", { targetAddress: "0x4444", stakeAmount: STAKE }),
      /proposer is not an active validator/,
    )
  })

  it("rejects adding already active validator", () => {
    assert.throws(
      () => gov.submitProposal("add_validator", "v1", "v2", { targetAddress: "0x1111", stakeAmount: STAKE }),
      /validator already active/,
    )
  })

  it("rejects removing last validator", () => {
    // Remove v2 and v3 first via direct governance
    const gov2 = new ValidatorGovernance({ minStake: 1n, approvalThresholdPercent: 50, minVoterPercent: 50 })
    gov2.initGenesis([{ id: "v1", address: "0x1111", stake: STAKE }])

    assert.throws(
      () => gov2.submitProposal("remove_validator", "v1", "v1"),
      /cannot remove last validator/,
    )
  })

  it("approves proposal with sufficient votes", () => {
    const proposal = gov.submitProposal("add_validator", "v4", "v1", {
      targetAddress: "0x4444",
      stakeAmount: STAKE,
    })

    // v1 auto-voted (33%), need 67%. v2 votes yes (33+33 = 66%), still not enough with 50% participation but 66% approval
    gov.vote(proposal.id, "v2", true)

    const updated = gov.getProposal(proposal.id)!
    // With 66% voted (v1+v2) and both approve, participation >= 50%
    // 66% approval but need 67%, so still pending
    // Actually 2/3 participation = 66%, each has 33% power
    // v1 (33) + v2 (33) = 66 voted, 66% approval, need 67%
    // So it's still pending
    assert.equal(updated.status, "pending")

    // v3 votes yes → 100% participation, 100% approval
    gov.vote(proposal.id, "v3", true)

    const final = gov.getProposal(proposal.id)!
    assert.equal(final.status, "approved")
    assert.equal(gov.activeCount(), 4)
    assert.ok(gov.getValidator("v4")?.active)
  })

  it("rejects proposal when votes against", () => {
    const proposal = gov.submitProposal("remove_validator", "v3", "v1")

    gov.vote(proposal.id, "v2", false)
    gov.vote(proposal.id, "v3", false)

    const updated = gov.getProposal(proposal.id)!
    assert.equal(updated.status, "rejected")
    assert.equal(gov.activeCount(), 3) // v3 still active
  })

  it("expires proposals after deadline", () => {
    const proposal = gov.submitProposal("add_validator", "v4", "v1", {
      targetAddress: "0x4444",
      stakeAmount: STAKE,
    })

    gov.advanceEpoch(100n)

    const updated = gov.getProposal(proposal.id)!
    assert.equal(updated.status, "expired")
  })

  it("removes validator via approved proposal", () => {
    const proposal = gov.submitProposal("remove_validator", "v3", "v1")
    gov.vote(proposal.id, "v2", true)
    gov.vote(proposal.id, "v3", true)

    assert.equal(gov.activeCount(), 2)
    assert.equal(gov.getValidator("v3")!.active, false)
  })

  it("updates stake via proposal", () => {
    const newStake = 50000000000000000000n // 50 ETH
    const proposal = gov.submitProposal("update_stake", "v1", "v1", { stakeAmount: newStake })

    gov.vote(proposal.id, "v2", true)
    gov.vote(proposal.id, "v3", true)

    assert.equal(gov.getValidator("v1")!.stake, newStake)
  })

  it("recalculates voting power after stake change", () => {
    const newStake = 30000000000000000000n // 30 ETH (3x others)
    const proposal = gov.submitProposal("update_stake", "v1", "v1", { stakeAmount: newStake })
    gov.vote(proposal.id, "v2", true)
    gov.vote(proposal.id, "v3", true)

    // v1: 30 ETH, v2: 10 ETH, v3: 10 ETH → total 50 ETH
    // v1 power: 30/50 * 100 = 60
    const v1 = gov.getValidator("v1")!
    assert.equal(v1.votingPower, 60)
  })

  it("rejects voting on non-pending proposal", () => {
    const proposal = gov.submitProposal("add_validator", "v4", "v1", {
      targetAddress: "0x4444",
      stakeAmount: STAKE,
    })
    gov.advanceEpoch(100n) // Expire it

    assert.throws(
      () => gov.vote(proposal.id, "v2", true),
      /proposal not pending/,
    )
  })

  it("lists proposals by status", () => {
    gov.submitProposal("add_validator", "v4", "v1", { targetAddress: "0x4444", stakeAmount: STAKE })
    gov.submitProposal("add_validator", "v5", "v2", { targetAddress: "0x5555", stakeAmount: STAKE })

    const pending = gov.getProposals("pending")
    assert.equal(pending.length, 2)

    const approved = gov.getProposals("approved")
    assert.equal(approved.length, 0)
  })
})
