// Treasury — #719 signer-rotation confirmation accounting.
//
// `replaceSigner` removes a signer but does not revisit pending proposals,
// so the raw `p.confirmations` counter can include confirmations from
// signers that have since been removed. `executeWithdrawal` must gate on
// confirmations counted over the CURRENT signer set, not the raw counter.

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

describe("Treasury — #719 signer rotation confirmation accounting", function () {
  let treasury
  let s0, s1, s2, s3, s4 // initial 3-of-5 multisig signers
  let owner, newSigner, governance, recipient

  beforeEach(async function () {
    const all = await ethers.getSigners()
    ;[s0, s1, s2, s3, s4, owner, newSigner, governance, recipient] = all

    const Treasury = await ethers.getContractFactory("Treasury")
    treasury = await upgrades.deployProxy(
      Treasury,
      [
        [s0.address, s1.address, s2.address, s3.address, s4.address],
        governance.address,
        owner.address,
      ],
      { initializer: "initialize", kind: "uups" },
    )
    await treasury.waitForDeployment()

    // Fund the treasury so withdrawals can execute.
    await owner.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("100") })
  })

  it("does not count a removed signer's stale confirmation toward the threshold", async function () {
    // s0 proposes (auto-confirms), s1 confirms — 2 genuine confirmations.
    await treasury.connect(s0).proposeWithdrawal(recipient.address, ethers.parseEther("1"))
    await treasury.connect(s1).confirmWithdrawal(0)
    expect(await treasury.currentConfirmations(0)).to.equal(2)

    // Owner rotates s0 out of the multisig (routine rotation / key eviction).
    await treasury.connect(owner).replaceSigner(0, newSigner.address)

    // s2 confirms. The raw counter is now 3 (s0 ghost + s1 + s2), but only
    // s1 and s2 are current signers who confirmed.
    await treasury.connect(s2).confirmWithdrawal(0)
    const raw = (await treasury.proposals(0)).confirmations
    expect(raw).to.equal(3)
    expect(await treasury.currentConfirmations(0)).to.equal(2)

    // Execution must be blocked: only 2 current-signer confirmations.
    await expect(
      treasury.connect(s1).executeWithdrawal(0),
    ).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations")

    // The newly-added signer confirms → 3 current-signer confirmations.
    await treasury.connect(newSigner).confirmWithdrawal(0)
    expect(await treasury.currentConfirmations(0)).to.equal(3)

    const before = await ethers.provider.getBalance(recipient.address)
    await treasury.connect(s1).executeWithdrawal(0)
    const after = await ethers.provider.getBalance(recipient.address)
    expect(after - before).to.equal(ethers.parseEther("1"))
  })

  it("executes normally with three genuine current-signer confirmations", async function () {
    await treasury.connect(s0).proposeWithdrawal(recipient.address, ethers.parseEther("1"))
    await treasury.connect(s1).confirmWithdrawal(0)
    await treasury.connect(s2).confirmWithdrawal(0)
    expect(await treasury.currentConfirmations(0)).to.equal(3)

    const before = await ethers.provider.getBalance(recipient.address)
    await treasury.connect(s3).executeWithdrawal(0)
    const after = await ethers.provider.getBalance(recipient.address)
    expect(after - before).to.equal(ethers.parseEther("1"))
  })
})
