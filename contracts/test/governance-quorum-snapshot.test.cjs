/**
 * Security regression: GovernanceDAO quorum must be measured against the
 * registered population SNAPSHOTTED at proposal creation, not the live count.
 *
 * Bug: `_isApproved` read `factionRegistry.humanCount() + clawCount()` live at
 * queue() time. `registerHuman()` is permissionless and free, so anyone could
 * inflate the denominator AFTER voting closed and retroactively force any
 * proposal below quorum — a zero-cost censorship/griefing vector.
 *
 * Fix: snapshot the registered count into the Proposal at createProposal().
 */
const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

async function advanceTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds])
  await ethers.provider.send("evm_mine")
}

describe("Security: GovernanceDAO quorum snapshot", function () {
  let factionRegistry, dao
  let members, attacker, sybils

  beforeEach(async function () {
    const all = await ethers.getSigners()
    members = all.slice(1, 4) // 3 honest registered voters
    attacker = all[4]
    sybils = all.slice(5, 25) // 20 sybil accounts the attacker controls

    const owner = all[0]
    const FR = await ethers.getContractFactory("FactionRegistry")
    factionRegistry = await upgrades.deployProxy(
      FR,
      [owner.address, owner.address],
      { initializer: "initialize", kind: "uups" },
    )
    await factionRegistry.waitForDeployment()

    const DAO = await ethers.getContractFactory("GovernanceDAO")
    dao = await upgrades.deployProxy(
      DAO,
      [await factionRegistry.getAddress(), owner.address],
      { initializer: "initialize", kind: "uups" },
    )
    await dao.waitForDeployment()

    for (const m of members) {
      await factionRegistry.connect(m).registerHuman()
    }
  })

  it("a passing proposal cannot be griefed by post-vote sybil registration", async function () {
    const descHash = ethers.keccak256(ethers.toUtf8Bytes("desc"))
    // At creation: 3 registered. quorum 40% -> needs >=2 votes; approval 60%.
    await dao.connect(members[0]).createProposal(5, "Honest Proposal", descHash, ethers.ZeroAddress, "0x", 0)

    // All 3 vote FOR: 3/3 = 100% turnout, 100% approval.
    for (const m of members) {
      await dao.connect(m).vote(1, 1)
    }

    await advanceTime(7 * 86400 + 1)

    // Attacker floods the registry with free sybil registrations AFTER voting.
    for (const s of sybils) {
      await factionRegistry.connect(s).registerHuman()
    }
    // Denominator is inflated far past 3 -> live quorum would now be <40%.
    expect(await factionRegistry.humanCount()).to.equal(BigInt(members.length + sybils.length))

    await dao.queue(1)
    const p = await dao.getProposal(1)
    // Must be Queued(3) — quorum is judged against the 3 registered at creation.
    expect(p.state).to.equal(3)
  })

  it("getProposalState also reports Approved against the creation-time snapshot", async function () {
    const descHash = ethers.keccak256(ethers.toUtf8Bytes("desc"))
    await dao.connect(members[0]).createProposal(5, "Honest Proposal", descHash, ethers.ZeroAddress, "0x", 0)
    for (const m of members) {
      await dao.connect(m).vote(1, 1)
    }
    await advanceTime(7 * 86400 + 1)
    for (const s of sybils) {
      await factionRegistry.connect(s).registerHuman()
    }
    // Approved(1) — not Rejected(2).
    expect(await dao.getProposalState(1)).to.equal(1)
  })

  it("genuine low-turnout proposals still fail quorum (snapshot is not a bypass)", async function () {
    // Register 7 more BEFORE the proposal so the snapshot is 10.
    const extra = (await ethers.getSigners()).slice(5, 12)
    for (const e of extra) {
      await factionRegistry.connect(e).registerHuman()
    }
    expect(await factionRegistry.humanCount()).to.equal(10n)

    const descHash = ethers.keccak256(ethers.toUtf8Bytes("desc"))
    await dao.connect(members[0]).createProposal(5, "Low Turnout", descHash, ethers.ZeroAddress, "0x", 0)
    // Only 3 of 10 vote -> 30% turnout < 40% quorum.
    for (const m of members) {
      await dao.connect(m).vote(1, 1)
    }
    await advanceTime(7 * 86400 + 1)
    await dao.queue(1)
    const p = await dao.getProposal(1)
    expect(p.state).to.equal(2) // Rejected — quorum genuinely not met.
  })
})
