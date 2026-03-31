/**
 * RollupStateManager Tests
 *
 * Covers:
 * - Output root submission (happy path, duplicate, insufficient bond)
 * - Challenge lifecycle (open, resolve proposer fault, resolve challenger fault)
 * - Finalization (after window, with resolved challenge)
 * - Read helpers (getOutputProposal, getLatestFinalizedL2Block, isOutputFinalized)
 * - Slash distribution (50% burn, 30% challenger, 20% insurance)
 * - Bond refund on finalization
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

// Short challenge window for testing (60 seconds)
const CHALLENGE_WINDOW = 60
const PROPOSER_BOND = ethers.parseEther("1")
const CHALLENGER_BOND = ethers.parseEther("0.5")

describe("RollupStateManager", function () {
  let manager
  let deployer, proposer, challenger, insuranceFund
  let sampleOutputRoot, sampleStateRoot

  beforeEach(async function () {
    ;[deployer, proposer, challenger, insuranceFund] = await ethers.getSigners()

    const Factory = await ethers.getContractFactory("RollupStateManager")
    manager = await Factory.deploy(
      CHALLENGE_WINDOW,
      PROPOSER_BOND,
      CHALLENGER_BOND,
      insuranceFund.address,
    )
    await manager.waitForDeployment()

    // Sample data
    sampleStateRoot = ethers.keccak256(ethers.toUtf8Bytes("state-root-1"))
    const blockHash = ethers.keccak256(ethers.toUtf8Bytes("block-hash-1"))
    sampleOutputRoot = ethers.solidityPackedKeccak256(
      ["uint64", "bytes32", "bytes32"],
      [100, sampleStateRoot, blockHash],
    )
  })

  describe("submitOutputRoot", function () {
    it("accepts a valid output root with sufficient bond", async function () {
      const tx = await manager
        .connect(proposer)
        .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
          value: PROPOSER_BOND,
        })

      await expect(tx)
        .to.emit(manager, "OutputProposed")
        .withArgs(100, sampleOutputRoot, proposer.address)

      const proposal = await manager.getOutputProposal(100)
      expect(proposal.outputRoot).to.equal(sampleOutputRoot)
      expect(proposal.l2StateRoot).to.equal(sampleStateRoot)
      expect(proposal.l2BlockNumber).to.equal(100)
      expect(proposal.proposer).to.equal(proposer.address)
      expect(proposal.challenged).to.equal(false)
      expect(proposal.finalized).to.equal(false)

      expect(await manager.lastSubmittedBlock()).to.equal(100)
    })

    it("rejects insufficient bond", async function () {
      await expect(
        manager
          .connect(proposer)
          .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
            value: ethers.parseEther("0.5"),
          }),
      ).to.be.revertedWithCustomError(manager, "InsufficientBond")
    })

    it("rejects duplicate block number (caught by non-increasing check)", async function () {
      await manager
        .connect(proposer)
        .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
          value: PROPOSER_BOND,
        })

      await expect(
        manager
          .connect(proposer)
          .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
            value: PROPOSER_BOND,
          }),
      ).to.be.revertedWithCustomError(manager, "BlockNumberNotIncreasing")
    })

    it("rejects non-increasing block number", async function () {
      await manager
        .connect(proposer)
        .submitOutputRoot(200, sampleOutputRoot, sampleStateRoot, {
          value: PROPOSER_BOND,
        })

      await expect(
        manager
          .connect(proposer)
          .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
            value: PROPOSER_BOND,
          }),
      ).to.be.revertedWithCustomError(manager, "BlockNumberNotIncreasing")
    })

    it("allows sequential increasing block numbers", async function () {
      await manager
        .connect(proposer)
        .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
          value: PROPOSER_BOND,
        })

      const root2 = ethers.keccak256(ethers.toUtf8Bytes("output-root-2"))
      const state2 = ethers.keccak256(ethers.toUtf8Bytes("state-root-2"))
      await manager
        .connect(proposer)
        .submitOutputRoot(200, root2, state2, { value: PROPOSER_BOND })

      expect(await manager.lastSubmittedBlock()).to.equal(200)
    })
  })

  describe("challengeOutputRoot", function () {
    beforeEach(async function () {
      await manager
        .connect(proposer)
        .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
          value: PROPOSER_BOND,
        })
    })

    it("accepts a valid challenge within the window", async function () {
      const tx = await manager
        .connect(challenger)
        .challengeOutputRoot(100, { value: CHALLENGER_BOND })

      await expect(tx)
        .to.emit(manager, "OutputChallenged")
        .withArgs(100, challenger.address, CHALLENGER_BOND)

      const proposal = await manager.getOutputProposal(100)
      expect(proposal.challenged).to.equal(true)

      const challenge = await manager.getChallenge(100)
      expect(challenge.challenger).to.equal(challenger.address)
      expect(challenge.resolved).to.equal(false)
    })

    it("rejects challenge for non-existent output", async function () {
      await expect(
        manager
          .connect(challenger)
          .challengeOutputRoot(999, { value: CHALLENGER_BOND }),
      ).to.be.revertedWithCustomError(manager, "OutputNotFound")
    })

    it("rejects duplicate challenge", async function () {
      await manager
        .connect(challenger)
        .challengeOutputRoot(100, { value: CHALLENGER_BOND })

      await expect(
        manager
          .connect(challenger)
          .challengeOutputRoot(100, { value: CHALLENGER_BOND }),
      ).to.be.revertedWithCustomError(manager, "AlreadyChallenged")
    })

    it("rejects insufficient challenger bond", async function () {
      await expect(
        manager
          .connect(challenger)
          .challengeOutputRoot(100, { value: ethers.parseEther("0.1") }),
      ).to.be.revertedWithCustomError(manager, "InsufficientBond")
    })

    it("rejects challenge after window elapsed", async function () {
      await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1])
      await ethers.provider.send("evm_mine", [])

      await expect(
        manager
          .connect(challenger)
          .challengeOutputRoot(100, { value: CHALLENGER_BOND }),
      ).to.be.revertedWithCustomError(manager, "ChallengeWindowElapsed")
    })
  })

  describe("resolveChallenge", function () {
    beforeEach(async function () {
      await manager
        .connect(proposer)
        .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
          value: PROPOSER_BOND,
        })
      await manager
        .connect(challenger)
        .challengeOutputRoot(100, { value: CHALLENGER_BOND })
    })

    it("resolves in proposer fault (wrong state root)", async function () {
      const correctRoot = ethers.keccak256(ethers.toUtf8Bytes("correct-root"))
      const challengerBefore = await ethers.provider.getBalance(
        challenger.address,
      )

      const tx = await manager.resolveChallenge(100, correctRoot)
      await expect(tx)
        .to.emit(manager, "ChallengeResolved")
        .withArgs(100, true)

      const challenge = await manager.getChallenge(100)
      expect(challenge.resolved).to.equal(true)
      expect(challenge.proposerFault).to.equal(true)

      // Challenger should receive bond back + 30% of proposer bond
      const challengerAfter = await ethers.provider.getBalance(
        challenger.address,
      )
      const expectedReward =
        CHALLENGER_BOND + (PROPOSER_BOND * 3000n) / 10000n
      expect(challengerAfter - challengerBefore).to.equal(expectedReward)
    })

    it("resolves in challenger fault (correct state root)", async function () {
      const proposerBefore = await ethers.provider.getBalance(proposer.address)

      const tx = await manager.resolveChallenge(100, sampleStateRoot)
      await expect(tx)
        .to.emit(manager, "ChallengeResolved")
        .withArgs(100, false)

      const challenge = await manager.getChallenge(100)
      expect(challenge.resolved).to.equal(true)
      expect(challenge.proposerFault).to.equal(false)

      // Proposer should receive challenger's bond
      const proposerAfter = await ethers.provider.getBalance(proposer.address)
      expect(proposerAfter - proposerBefore).to.equal(CHALLENGER_BOND)
    })

    it("sends insurance portion to insurance fund on proposer fault", async function () {
      const insuranceBefore = await ethers.provider.getBalance(
        insuranceFund.address,
      )
      const correctRoot = ethers.keccak256(ethers.toUtf8Bytes("correct-root"))

      await manager.resolveChallenge(100, correctRoot)

      const insuranceAfter = await ethers.provider.getBalance(
        insuranceFund.address,
      )
      const expectedInsurance = (PROPOSER_BOND * 2000n) / 10000n
      expect(insuranceAfter - insuranceBefore).to.equal(expectedInsurance)
    })

    it("rejects resolution for non-existent challenge", async function () {
      await expect(
        manager.resolveChallenge(999, sampleStateRoot),
      ).to.be.revertedWithCustomError(manager, "ChallengeNotFound")
    })

    it("rejects double resolution", async function () {
      await manager.resolveChallenge(100, sampleStateRoot)
      await expect(
        manager.resolveChallenge(100, sampleStateRoot),
      ).to.be.revertedWithCustomError(manager, "ChallengeAlreadyResolved")
    })
  })

  describe("finalizeOutput", function () {
    beforeEach(async function () {
      await manager
        .connect(proposer)
        .submitOutputRoot(100, sampleOutputRoot, sampleStateRoot, {
          value: PROPOSER_BOND,
        })
    })

    it("finalizes after challenge window with no challenge", async function () {
      await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1])
      await ethers.provider.send("evm_mine", [])

      const proposerBefore = await ethers.provider.getBalance(proposer.address)
      const tx = await manager.finalizeOutput(100)
      await expect(tx)
        .to.emit(manager, "OutputFinalized")
        .withArgs(100, sampleOutputRoot)

      expect(await manager.isOutputFinalized(100)).to.equal(true)
      expect(await manager.getLatestFinalizedL2Block()).to.equal(100)

      // Proposer bond refunded
      const proposerAfter = await ethers.provider.getBalance(proposer.address)
      expect(proposerAfter - proposerBefore).to.be.greaterThan(
        PROPOSER_BOND - ethers.parseEther("0.01"),
      ) // minus gas
    })

    it("rejects finalization before window elapsed", async function () {
      await expect(
        manager.finalizeOutput(100),
      ).to.be.revertedWithCustomError(
        manager,
        "ChallengeWindowNotElapsed",
      )
    })

    it("rejects finalization of non-existent output", async function () {
      await expect(
        manager.finalizeOutput(999),
      ).to.be.revertedWithCustomError(manager, "OutputNotFound")
    })

    it("rejects double finalization", async function () {
      await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1])
      await ethers.provider.send("evm_mine", [])

      await manager.finalizeOutput(100)

      await expect(
        manager.finalizeOutput(100),
      ).to.be.revertedWithCustomError(
        manager,
        "OutputAlreadyFinalized",
      )
    })

    it("allows finalization after challenge resolved in proposer favor", async function () {
      await manager
        .connect(challenger)
        .challengeOutputRoot(100, { value: CHALLENGER_BOND })

      // Resolve in proposer's favor
      await manager.resolveChallenge(100, sampleStateRoot)

      // Can finalize immediately (challenge resolved)
      const tx = await manager.finalizeOutput(100)
      await expect(tx).to.emit(manager, "OutputFinalized")

      expect(await manager.isOutputFinalized(100)).to.equal(true)
    })

    it("rejects finalization while challenge is unresolved", async function () {
      await manager
        .connect(challenger)
        .challengeOutputRoot(100, { value: CHALLENGER_BOND })

      await expect(
        manager.finalizeOutput(100),
      ).to.be.revertedWithCustomError(
        manager,
        "ChallengeWindowNotElapsed",
      )
    })
  })

  describe("read helpers", function () {
    it("getLatestFinalizedL2Block returns 0 initially", async function () {
      expect(await manager.getLatestFinalizedL2Block()).to.equal(0)
    })

    it("isOutputFinalized returns false for non-existent", async function () {
      expect(await manager.isOutputFinalized(999)).to.equal(false)
    })

    it("getOutputProposal returns zero struct for non-existent", async function () {
      const proposal = await manager.getOutputProposal(999)
      expect(proposal.l1Timestamp).to.equal(0)
    })

    it("CHALLENGE_WINDOW returns configured value", async function () {
      expect(await manager.CHALLENGE_WINDOW()).to.equal(CHALLENGE_WINDOW)
    })

    it("PROPOSER_BOND returns configured value", async function () {
      expect(await manager.PROPOSER_BOND()).to.equal(PROPOSER_BOND)
    })

    it("CHALLENGER_BOND returns configured value", async function () {
      expect(await manager.CHALLENGER_BOND()).to.equal(CHALLENGER_BOND)
    })
  })
})
