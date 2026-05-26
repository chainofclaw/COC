/**
 * GovernanceDAO — #735 isVerified gate on onlyRegistered.
 *
 * Bug: FactionRegistry.registerHuman/registerClaw are permissionless and
 * have no anti-Sybil cost (registerClaw's "attestation" is signed by
 * msg.sender itself, so any fresh EOA passes). The old onlyRegistered
 * modifier only checked `getFaction() != None`, so any number of EOAs
 * could spawn, register, and vote — fully Sybil-able governance.
 *
 * Fix: onlyRegistered now also requires `isVerified(msg.sender)`. The
 * `verified` flag is owner/verifier-gated via `FactionRegistry.verify()`,
 * so the bar moves from "1 tx per sybil" to "convince the verifier".
 *
 * This file proves:
 *  (1) registered-but-unverified accounts are blocked from createProposal/vote
 *  (2) verified accounts succeed normally
 *  (3) the verifier role can actually un-block an unverified registrant
 *  (4) the Sybil attack reproduction is blocked end-to-end:
 *      attacker spawns N EOAs, registers them all, none can vote
 *  (5) totally-unregistered addresses still revert with NotRegistered
 *      (the first leg of the modifier — preserves the existing error path)
 */

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

describe("Security: GovernanceDAO #735 isVerified gate", function () {
  let registry, dao
  let owner, alice, bob, claw1, attacker

  beforeEach(async function () {
    ;[owner, alice, bob, claw1, attacker] = await ethers.getSigners()

    const FR = await ethers.getContractFactory("FactionRegistry")
    registry = await upgrades.deployProxy(
      FR,
      [owner.address, owner.address],
      { initializer: "initialize", kind: "uups" },
    )
    await registry.waitForDeployment()

    const DAO = await ethers.getContractFactory("GovernanceDAO")
    dao = await upgrades.deployProxy(
      DAO,
      [await registry.getAddress(), owner.address],
      { initializer: "initialize", kind: "uups" },
    )
    await dao.waitForDeployment()
  })

  async function createProposalAs(signer) {
    return dao.connect(signer).createProposal(
      5, // FreeText
      "title",
      ethers.keccak256(ethers.toUtf8Bytes("desc")),
      ethers.ZeroAddress,
      "0x",
      0,
    )
  }

  it("registered-but-unverified human cannot createProposal", async function () {
    await registry.connect(alice).registerHuman()
    // alice is registered (faction != None) but verified == false.
    expect(await registry.isRegistered(alice.address)).to.equal(true)
    expect(await registry.isVerified(alice.address)).to.equal(false)
    await expect(createProposalAs(alice))
      .to.be.revertedWithCustomError(dao, "NotVerified")
  })

  it("registered-but-unverified human cannot vote", async function () {
    // Need a proposal first — created by a verified user.
    await registry.connect(alice).registerHuman()
    await registry.connect(owner).verify(alice.address)
    await createProposalAs(alice)

    // bob registers but is NOT verified — vote must revert.
    await registry.connect(bob).registerHuman()
    await expect(dao.connect(bob).vote(1, 1))
      .to.be.revertedWithCustomError(dao, "NotVerified")
  })

  it("totally-unregistered address still reverts with NotRegistered (legacy error path)", async function () {
    // alice is fully unregistered. The first leg of onlyRegistered fires,
    // so the externally-visible error stays NotRegistered (not NotVerified)
    // — important for any indexer/UI that already keys on the original
    // error selector.
    await expect(createProposalAs(alice))
      .to.be.revertedWithCustomError(dao, "NotRegistered")
  })

  it("verifier can lift the gate — verified registrant succeeds", async function () {
    await registry.connect(alice).registerHuman()
    await registry.connect(owner).verify(alice.address)
    expect(await registry.isVerified(alice.address)).to.equal(true)

    await createProposalAs(alice)
    expect(await dao.proposalCount()).to.equal(1)

    await dao.connect(alice).vote(1, 1)
    const [forHuman] = await dao.getVoteTotals(1)
    expect(forHuman).to.equal(1n)
  })

  it("verified claw also passes the gate", async function () {
    const agentId = ethers.keccak256(ethers.toUtf8Bytes("agent-735"))
    const messageHash = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "address"], [agentId, claw1.address]),
    )
    const attestation = await claw1.signMessage(ethers.getBytes(messageHash))
    await registry.connect(claw1).registerClaw(agentId, attestation)
    await registry.connect(owner).verify(claw1.address)

    await createProposalAs(claw1)
    await dao.connect(claw1).vote(1, 1)
    const [, , forClaw] = await dao.getVoteTotals(1)
    expect(forClaw).to.equal(1n)
  })

  it("Sybil reproduction is now blocked: attacker spawns 10 EOAs, registers all, zero can vote", async function () {
    // Set up a legitimate proposal (proposer is owner, who self-verifies).
    await registry.connect(owner).registerHuman()
    await registry.connect(owner).verify(owner.address)
    await createProposalAs(owner)

    // Attacker spawns 10 fresh sybils, funds each, registers each. None
    // are verified. The pre-fix world: every one of them would vote().
    const sybils = []
    for (let i = 0; i < 10; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider)
      await attacker.sendTransaction({ to: w.address, value: ethers.parseEther("0.1") })
      await registry.connect(w).registerHuman()
      sybils.push(w)
    }
    expect(await registry.humanCount()).to.equal(11n) // owner + 10 sybils

    for (const s of sybils) {
      await expect(dao.connect(s).vote(1, 1))
        .to.be.revertedWithCustomError(dao, "NotVerified")
    }

    // Owner is the only voter who got through.
    await dao.connect(owner).vote(1, 1)
    const [forHuman] = await dao.getVoteTotals(1)
    expect(forHuman).to.equal(1n)
  })

  it("verifier role transfer still gates verification correctly", async function () {
    // Sanity check that the verifier hand-off works — operationally,
    // the verifier role is what stands between "permissionless governance"
    // and "permissioned governance" under this fix.
    await registry.connect(alice).registerHuman()
    await registry.connect(owner).setVerifier(bob.address)
    // alice can be verified by either owner (the `onlyVerifier` modifier
    // accepts owner too) or by the new verifier bob.
    await registry.connect(bob).verify(alice.address)
    expect(await registry.isVerified(alice.address)).to.equal(true)
    // bob registers; attacker (not owner, not verifier) cannot verify them.
    await registry.connect(bob).registerHuman()
    await expect(registry.connect(attacker).verify(bob.address))
      .to.be.revertedWithCustomError(registry, "NotVerifier")
  })
})
