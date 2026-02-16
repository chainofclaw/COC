const { expect } = require("chai")
const { ethers } = require("hardhat")

describe("Governance Contracts", function () {
  let factionRegistry, governanceDAO, treasury
  let owner, human1, human2, claw1, claw2

  beforeEach(async function () {
    ;[owner, human1, human2, claw1, claw2] = await ethers.getSigners()

    // Deploy FactionRegistry
    const FactionRegistry = await ethers.getContractFactory("FactionRegistry")
    factionRegistry = await FactionRegistry.deploy()
    await factionRegistry.waitForDeployment()

    // Deploy GovernanceDAO
    const GovernanceDAO = await ethers.getContractFactory("GovernanceDAO")
    governanceDAO = await GovernanceDAO.deploy(await factionRegistry.getAddress())
    await governanceDAO.waitForDeployment()

    // Deploy Treasury
    const Treasury = await ethers.getContractFactory("Treasury")
    treasury = await Treasury.deploy(await governanceDAO.getAddress())
    await treasury.waitForDeployment()

    // Set treasury in governance
    await governanceDAO.setTreasury(await treasury.getAddress())
  })

  describe("FactionRegistry", function () {
    it("should register a human", async function () {
      await factionRegistry.connect(human1).registerHuman()
      expect(await factionRegistry.getFaction(human1.address)).to.equal(1) // Human
      expect(await factionRegistry.isRegistered(human1.address)).to.be.true
      expect(await factionRegistry.humanCount()).to.equal(1)
    })

    it("should register a claw with valid attestation", async function () {
      const agentId = ethers.keccak256(ethers.toUtf8Bytes("agent-001"))
      const messageHash = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "address"], [agentId, claw1.address])
      )
      const attestation = await claw1.signMessage(ethers.getBytes(messageHash))

      await factionRegistry.connect(claw1).registerClaw(agentId, attestation)
      expect(await factionRegistry.getFaction(claw1.address)).to.equal(2) // Claw
      expect(await factionRegistry.clawCount()).to.equal(1)
    })

    it("should prevent double registration", async function () {
      await factionRegistry.connect(human1).registerHuman()
      await expect(factionRegistry.connect(human1).registerHuman()).to.be.revertedWithCustomError(
        factionRegistry,
        "AlreadyRegistered"
      )
    })

    it("should prevent invalid attestation for claw", async function () {
      const agentId = ethers.keccak256(ethers.toUtf8Bytes("agent-002"))
      // Sign with wrong signer
      const messageHash = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "address"], [agentId, claw1.address])
      )
      const attestation = await human1.signMessage(ethers.getBytes(messageHash))

      await expect(
        factionRegistry.connect(claw1).registerClaw(agentId, attestation)
      ).to.be.revertedWithCustomError(factionRegistry, "InvalidAttestation")
    })

    it("should verify identity", async function () {
      await factionRegistry.connect(human1).registerHuman()
      expect(await factionRegistry.isVerified(human1.address)).to.be.false

      await factionRegistry.connect(owner).verify(human1.address)
      expect(await factionRegistry.isVerified(human1.address)).to.be.true
    })

    it("should prevent non-verifier from verifying", async function () {
      await factionRegistry.connect(human1).registerHuman()
      await expect(
        factionRegistry.connect(human2).verify(human1.address)
      ).to.be.revertedWithCustomError(factionRegistry, "NotVerifier")
    })

    it("should return correct identity info", async function () {
      await factionRegistry.connect(human1).registerHuman()
      const identity = await factionRegistry.getIdentity(human1.address)
      expect(identity.faction).to.equal(1)
      expect(identity.verified).to.be.false
      expect(identity.registeredAt).to.be.gt(0)
    })
  })

  describe("GovernanceDAO", function () {
    beforeEach(async function () {
      // Register participants
      await factionRegistry.connect(human1).registerHuman()
      await factionRegistry.connect(human2).registerHuman()

      const agentId = ethers.keccak256(ethers.toUtf8Bytes("agent-001"))
      const messageHash = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "address"], [agentId, claw1.address])
      )
      const attestation = await claw1.signMessage(ethers.getBytes(messageHash))
      await factionRegistry.connect(claw1).registerClaw(agentId, attestation)
    })

    it("should create a proposal", async function () {
      const descHash = ethers.keccak256(ethers.toUtf8Bytes("Test proposal description"))
      await governanceDAO
        .connect(human1)
        .createProposal(5, "Test Proposal", descHash, ethers.ZeroAddress, "0x", 0)

      expect(await governanceDAO.proposalCount()).to.equal(1)
      const proposal = await governanceDAO.getProposal(1)
      expect(proposal.title).to.equal("Test Proposal")
      expect(proposal.proposer).to.equal(human1.address)
    })

    it("should reject proposal from unregistered address", async function () {
      const descHash = ethers.keccak256(ethers.toUtf8Bytes("Test"))
      await expect(
        governanceDAO
          .connect(claw2)
          .createProposal(5, "Test", descHash, ethers.ZeroAddress, "0x", 0)
      ).to.be.revertedWithCustomError(governanceDAO, "NotRegistered")
    })

    it("should allow voting from registered users", async function () {
      const descHash = ethers.keccak256(ethers.toUtf8Bytes("Test"))
      await governanceDAO
        .connect(human1)
        .createProposal(5, "Test", descHash, ethers.ZeroAddress, "0x", 0)

      await governanceDAO.connect(human1).vote(1, 1) // For
      await governanceDAO.connect(human2).vote(1, 0) // Against
      await governanceDAO.connect(claw1).vote(1, 1) // For

      const [forH, againstH, forC, againstC, abstain] = await governanceDAO.getVoteTotals(1)
      expect(forH).to.equal(1)
      expect(againstH).to.equal(1)
      expect(forC).to.equal(1)
      expect(againstC).to.equal(0)
      expect(abstain).to.equal(0)
    })

    it("should prevent double voting", async function () {
      const descHash = ethers.keccak256(ethers.toUtf8Bytes("Test"))
      await governanceDAO
        .connect(human1)
        .createProposal(5, "Test", descHash, ethers.ZeroAddress, "0x", 0)

      await governanceDAO.connect(human1).vote(1, 1)
      await expect(governanceDAO.connect(human1).vote(1, 1)).to.be.revertedWithCustomError(
        governanceDAO,
        "AlreadyVoted"
      )
    })

    it("should allow cancelling by proposer", async function () {
      const descHash = ethers.keccak256(ethers.toUtf8Bytes("Test"))
      await governanceDAO
        .connect(human1)
        .createProposal(5, "Test", descHash, ethers.ZeroAddress, "0x", 0)

      await governanceDAO.connect(human1).cancel(1)
      const proposal = await governanceDAO.getProposal(1)
      expect(proposal.state).to.equal(5) // Cancelled
    })

    it("should reject cancelling by non-proposer", async function () {
      const descHash = ethers.keccak256(ethers.toUtf8Bytes("Test"))
      await governanceDAO
        .connect(human1)
        .createProposal(5, "Test", descHash, ethers.ZeroAddress, "0x", 0)

      await expect(governanceDAO.connect(human2).cancel(1)).to.be.revertedWithCustomError(
        governanceDAO,
        "NotProposer"
      )
    })
  })

  describe("Treasury", function () {
    it("should receive deposits", async function () {
      await owner.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther("1.0"),
      })
      expect(await treasury.balance()).to.equal(ethers.parseEther("1.0"))
    })

    it("should allow governance to withdraw", async function () {
      // Fund treasury
      await owner.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther("1.0"),
      })

      const balBefore = await ethers.provider.getBalance(human1.address)
      await treasury.connect(owner).withdraw(human1.address, ethers.parseEther("0.5"), 1)
      const balAfter = await ethers.provider.getBalance(human1.address)

      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.5"))
    })

    it("should reject withdrawal from non-governance", async function () {
      await owner.sendTransaction({
        to: await treasury.getAddress(),
        value: ethers.parseEther("1.0"),
      })

      await expect(
        treasury.connect(human1).withdraw(human1.address, ethers.parseEther("0.5"), 1)
      ).to.be.revertedWithCustomError(treasury, "NotGovernance")
    })

    it("should reject withdrawal exceeding balance", async function () {
      await expect(
        treasury.connect(owner).withdraw(human1.address, ethers.parseEther("1.0"), 1)
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance")
    })
  })
})
