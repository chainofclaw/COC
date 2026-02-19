/**
 * Governance Lifecycle Integration Test
 *
 * Simulates the full lifecycle of Prowl testnet governance proposals:
 * 1. FreeText proposal for parameter recommendations
 * 2. Multi-voter participation with quorum checks
 * 3. Proposal state transitions: Pending → Approved/Rejected
 * 4. Queue and timelock mechanics
 * 5. Owner applies approved parameter changes
 *
 * ProposalState: Pending=0, Approved=1, Rejected=2, Queued=3, Executed=4, Cancelled=5, Expired=6
 *
 * Refs: #22
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

describe("Governance Lifecycle: Prowl Testnet Proposals", function () {
  let dao, registry, treasury
  let owner, human1, human2, human3, human4, human5

  beforeEach(async function () {
    ;[owner, human1, human2, human3, human4, human5] = await ethers.getSigners()

    const FactionRegistry = await ethers.getContractFactory("FactionRegistry")
    registry = await FactionRegistry.deploy()
    await registry.waitForDeployment()

    const GovernanceDAO = await ethers.getContractFactory("GovernanceDAO")
    dao = await GovernanceDAO.deploy(await registry.getAddress())
    await dao.waitForDeployment()

    const Treasury = await ethers.getContractFactory("Treasury")
    treasury = await Treasury.deploy(await dao.getAddress())
    await treasury.waitForDeployment()
    await dao.setTreasury(await treasury.getAddress())

    // Register 6 participants
    await registry.connect(owner).registerHuman()
    await registry.connect(human1).registerHuman()
    await registry.connect(human2).registerHuman()
    await registry.connect(human3).registerHuman()
    await registry.connect(human4).registerHuman()
    await registry.connect(human5).registerHuman()
  })

  it("creates and approves the first testnet parameter proposal", async function () {
    // Propose: "Set Prowl Testnet Parameters"
    const descHash = ethers.keccak256(ethers.toUtf8Bytes(
      "Voting period: 3 days, Quorum: 40%, Approval: 60%, Timelock: 1 day, Bicameral: No"
    ))

    const tx = await dao.connect(owner).createProposal(
      5, // FreeText
      "Set Prowl Testnet Parameters",
      descHash,
      ethers.ZeroAddress,
      "0x",
      0,
    )
    const receipt = await tx.wait()
    expect(receipt.status).to.equal(1)

    // Verify proposal
    const proposal = await dao.getProposal(1)
    expect(proposal.title).to.equal("Set Prowl Testnet Parameters")
    expect(proposal.state).to.equal(0) // Pending

    // 5 unique voters (quorum 40% of 6 = 3 needed)
    await dao.connect(owner).vote(1, 1) // For
    await dao.connect(human1).vote(1, 1) // For
    await dao.connect(human2).vote(1, 1) // For
    await dao.connect(human3).vote(1, 1) // For
    await dao.connect(human4).vote(1, 0) // Against

    // human5 abstains — still 5 unique voters

    // Advance past voting period (7 days default)
    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1])
    await ethers.provider.send("evm_mine")

    // Queue — should succeed (4 For / 5 voted = 80% approval > 60%)
    await dao.connect(owner).queue(1)

    const queuedState = await dao.getProposalState(1)
    expect(queuedState).to.equal(3) // Queued

    // Advance past timelock (2 days default)
    await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60 + 1])
    await ethers.provider.send("evm_mine")

    // Execute (FreeText has no execution target)
    await dao.connect(owner).execute(1)

    const executedState = await dao.getProposalState(1)
    expect(executedState).to.equal(4) // Executed
  })

  it("owner applies approved parameter changes after vote", async function () {
    // After the FreeText proposal is approved, the owner applies changes

    // Verify defaults first
    expect(await dao.votingPeriod()).to.equal(7n * 24n * 60n * 60n) // 7 days
    expect(await dao.timelockDelay()).to.equal(2n * 24n * 60n * 60n) // 2 days
    expect(await dao.quorumPercent()).to.equal(40n)
    expect(await dao.approvalPercent()).to.equal(60n)

    // Owner applies testnet parameters per the approved proposal
    await dao.connect(owner).setVotingPeriod(3 * 24 * 60 * 60) // 3 days
    await dao.connect(owner).setTimelockDelay(1 * 24 * 60 * 60) // 1 day

    // Verify parameter changes
    expect(await dao.votingPeriod()).to.equal(3n * 24n * 60n * 60n)
    expect(await dao.timelockDelay()).to.equal(1n * 24n * 60n * 60n)
    expect(await dao.quorumPercent()).to.equal(40n) // unchanged
    expect(await dao.approvalPercent()).to.equal(60n) // unchanged
  })

  it("proposal rejected when quorum not reached", async function () {
    const descHash = ethers.keccak256(ethers.toUtf8Bytes("test quorum"))

    await dao.connect(owner).createProposal(5, "Low Turnout", descHash, ethers.ZeroAddress, "0x", 0)

    // Only 1 voter out of 6 — below 40% quorum
    await dao.connect(owner).vote(1, 1)

    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1])
    await ethers.provider.send("evm_mine")

    // Queue sets state to Rejected (not a revert)
    await dao.connect(owner).queue(1)

    const state = await dao.getProposalState(1)
    expect(state).to.equal(2) // Rejected
  })

  it("proposal rejected when approval threshold not met", async function () {
    const descHash = ethers.keccak256(ethers.toUtf8Bytes("test approval"))

    await dao.connect(owner).createProposal(5, "Low Approval", descHash, ethers.ZeroAddress, "0x", 0)

    // 2 For, 4 Against → 33% approval < 60% threshold
    await dao.connect(owner).vote(1, 1)
    await dao.connect(human1).vote(1, 1)
    await dao.connect(human2).vote(1, 0)
    await dao.connect(human3).vote(1, 0)
    await dao.connect(human4).vote(1, 0)
    await dao.connect(human5).vote(1, 0)

    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1])
    await ethers.provider.send("evm_mine")

    await dao.connect(owner).queue(1)

    const state = await dao.getProposalState(1)
    expect(state).to.equal(2) // Rejected
  })

  it("proposal cancelled by proposer", async function () {
    const descHash = ethers.keccak256(ethers.toUtf8Bytes("cancel test"))

    await dao.connect(human1).createProposal(5, "To Be Cancelled", descHash, ethers.ZeroAddress, "0x", 0)

    await dao.connect(human1).cancel(1)

    const state = await dao.getProposalState(1)
    expect(state).to.equal(5) // Cancelled
  })

  it("cannot vote after deadline", async function () {
    const descHash = ethers.keccak256(ethers.toUtf8Bytes("deadline test"))

    await dao.connect(owner).createProposal(5, "Late Vote Test", descHash, ethers.ZeroAddress, "0x", 0)

    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1])
    await ethers.provider.send("evm_mine")

    await expect(
      dao.connect(owner).vote(1, 1)
    ).to.be.revertedWithCustomError(dao, "VotingClosed")
  })

  it("cannot execute before timelock elapses", async function () {
    const descHash = ethers.keccak256(ethers.toUtf8Bytes("timelock test"))

    await dao.connect(owner).createProposal(5, "Early Execute", descHash, ethers.ZeroAddress, "0x", 0)

    // Get quorum
    await dao.connect(owner).vote(1, 1)
    await dao.connect(human1).vote(1, 1)
    await dao.connect(human2).vote(1, 1)
    await dao.connect(human3).vote(1, 1)

    await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1])
    await ethers.provider.send("evm_mine")

    await dao.queue(1)

    // Try to execute immediately (before timelock)
    await expect(
      dao.execute(1)
    ).to.be.revertedWithCustomError(dao, "TimelockNotElapsed")
  })
})
