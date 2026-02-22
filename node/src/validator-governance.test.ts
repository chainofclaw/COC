/**
 * Tests for ValidatorGovernance
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { ValidatorGovernance } from "./validator-governance.ts"
import type { FactionId } from "./validator-governance.ts"

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
    assert.equal(v1.votingPower, 3333) // 33.33% in basis points
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
    assert.equal(proposal.votes.size, 0) // No auto-vote
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

    // Proposer must explicitly vote now
    gov.vote(proposal.id, "v1", true)
    gov.vote(proposal.id, "v2", true)

    const updated = gov.getProposal(proposal.id)!
    // v1 (33%) + v2 (33%) = 66% participation, 66% approval, need 67%
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

    gov.vote(proposal.id, "v1", true)  // proposer votes yes
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
    gov.vote(proposal.id, "v1", true)
    gov.vote(proposal.id, "v2", true)
    gov.vote(proposal.id, "v3", true)

    assert.equal(gov.activeCount(), 2)
    assert.equal(gov.getValidator("v3")!.active, false)
  })

  it("updates stake via proposal", () => {
    const newStake = 50000000000000000000n // 50 ETH
    const proposal = gov.submitProposal("update_stake", "v1", "v1", { stakeAmount: newStake })

    gov.vote(proposal.id, "v1", true)
    gov.vote(proposal.id, "v2", true)
    gov.vote(proposal.id, "v3", true)

    assert.equal(gov.getValidator("v1")!.stake, newStake)
  })

  it("recalculates voting power after stake change", () => {
    const newStake = 30000000000000000000n // 30 ETH (3x others)
    const proposal = gov.submitProposal("update_stake", "v1", "v1", { stakeAmount: newStake })
    gov.vote(proposal.id, "v1", true)
    gov.vote(proposal.id, "v2", true)
    gov.vote(proposal.id, "v3", true)

    // v1: 30 ETH, v2: 10 ETH, v3: 10 ETH → total 50 ETH
    // v1 power: 30/50 * 10000 = 6000 basis points
    const v1 = gov.getValidator("v1")!
    assert.equal(v1.votingPower, 6000)
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

  it("prunes finalized proposals older than retention threshold", () => {
    // Create and approve a proposal at epoch 0
    const p1 = gov.submitProposal("add_validator", "v4", "v1", { targetAddress: "0x4444", stakeAmount: STAKE })
    gov.vote(p1.id, "v1", true)
    gov.vote(p1.id, "v2", true)
    gov.vote(p1.id, "v3", true)
    assert.equal(gov.getProposal(p1.id)!.status, "approved")

    // Create and expire a proposal
    const p2 = gov.submitProposal("add_validator", "v5", "v2", { targetAddress: "0x5555", stakeAmount: STAKE })
    gov.advanceEpoch(100n)
    assert.equal(gov.getProposal(p2.id)!.status, "expired")

    // Create a pending proposal (should NOT be pruned)
    gov.advanceEpoch(100n) // reset epoch context
    const p3 = gov.submitProposal("add_validator", "v6", "v1", { targetAddress: "0x6666", stakeAmount: STAKE })

    // Prune with 10-epoch retention (cutoff = 100 - 10 = 90)
    const pruned = gov.pruneProposals(10n)
    assert.equal(pruned, 2) // p1 (approved, epoch 0) and p2 (expired, epoch 0) pruned
    assert.equal(gov.getProposal(p1.id), null)
    assert.equal(gov.getProposal(p2.id), null)
    assert.ok(gov.getProposal(p3.id)) // pending proposal preserved
  })

  it("does not prune pending proposals", () => {
    gov.submitProposal("add_validator", "v4", "v1", { targetAddress: "0x4444", stakeAmount: STAKE })
    gov.advanceEpoch(100n)
    // Proposal is now expired (not pending), but let's test with a fresh pending one
    const p2 = gov.submitProposal("add_validator", "v5", "v2", { targetAddress: "0x5555", stakeAmount: STAKE })
    gov.advanceEpoch(100n) // don't expire p2 (expires at 100+24=124)

    const pruned = gov.pruneProposals(5n)
    // p1 is expired (epoch 0, cutoff=95) → pruned
    // p2 is pending → not pruned
    assert.equal(pruned, 1)
    assert.ok(gov.getProposal(p2.id))
  })

  it("returns governance stats summary", () => {
    gov.advanceEpoch(5n)
    gov.submitProposal("add_validator", "v4", "v1", { targetAddress: "0x4444", stakeAmount: STAKE })

    const stats = gov.getGovernanceStats()
    assert.equal(stats.activeValidators, 3)
    assert.equal(stats.totalStake, STAKE * 3n)
    assert.equal(stats.pendingProposals, 1)
    assert.equal(stats.totalProposals, 1)
    assert.equal(stats.currentEpoch, 5n)
  })

  it("governance stats reflect approved proposals", () => {
    const p = gov.submitProposal("add_validator", "v4", "v1", { targetAddress: "0x4444", stakeAmount: STAKE })
    gov.vote(p.id, "v1", true)
    gov.vote(p.id, "v2", true)
    gov.vote(p.id, "v3", true)

    const stats = gov.getGovernanceStats()
    assert.equal(stats.activeValidators, 4)
    assert.equal(stats.totalStake, STAKE * 4n)
    assert.equal(stats.pendingProposals, 0)
    assert.equal(stats.totalProposals, 1)
  })

  it("treasury starts at zero", () => {
    assert.equal(gov.getTreasuryBalance(), 0n)
  })

  it("deposits into treasury", () => {
    gov.depositTreasury(5000000000000000000n)
    assert.equal(gov.getTreasuryBalance(), 5000000000000000000n)
    gov.depositTreasury(3000000000000000000n)
    assert.equal(gov.getTreasuryBalance(), 8000000000000000000n)
  })

  it("rejects non-positive treasury deposit", () => {
    assert.throws(() => gov.depositTreasury(0n), /deposit amount must be positive/)
    assert.throws(() => gov.depositTreasury(-1n), /deposit amount must be positive/)
  })

  it("sets and gets faction for address", () => {
    gov.setFaction("0xAbCd", "builders")
    const info = gov.getFaction("0xabcd") // case-insensitive
    assert.ok(info)
    assert.equal(info.faction, "builders")
    assert.equal(info.address, "0xabcd")
  })

  it("returns null for unknown faction address", () => {
    assert.equal(gov.getFaction("0x9999"), null)
  })

  it("tracks faction stats", () => {
    gov.setFaction("0xaaaa", "builders")
    gov.setFaction("0xbbbb", "guardians")
    gov.setFaction("0xcccc", "builders")
    gov.setFaction("0xdddd", "explorers")

    const stats = gov.getFactionStats()
    assert.equal(stats.builders, 2)
    assert.equal(stats.guardians, 1)
    assert.equal(stats.explorers, 1)
    assert.equal(stats.neutral, 0)
  })

  it("faction joinedAtEpoch tracks current epoch", () => {
    gov.advanceEpoch(10n)
    gov.setFaction("0xaaaa", "neutral")
    const info = gov.getFaction("0xaaaa")!
    assert.equal(info.joinedAtEpoch, 10n)
  })

  it("allows changing faction", () => {
    gov.setFaction("0xaaaa", "builders")
    gov.setFaction("0xaaaa", "guardians")
    assert.equal(gov.getFaction("0xaaaa")!.faction, "guardians")
    assert.equal(gov.getFactionStats().builders, 0)
    assert.equal(gov.getFactionStats().guardians, 1)
  })
})
