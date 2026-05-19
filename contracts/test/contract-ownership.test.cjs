/**
 * Contract ownership transfer tests (#686).
 *
 * Every governance / settlement contract that has an onlyOwner-gated admin
 * surface must be able to hand ownership to a multisig — otherwise the owner
 * is permanently stuck on the deploy key (which on 88780 was a public Hardhat
 * test account). This verifies transferOwnership on each contract that had it
 * added: owner can transfer, non-owner is rejected, the zero address is
 * rejected, and admin power follows the new owner.
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

describe("Contract ownership transfer (#686)", function () {
  let deployer, newOwner, outsider

  beforeEach(async function () {
    ;[deployer, newOwner, outsider] = await ethers.getSigners()
  })

  describe("FactionRegistry", function () {
    let c
    beforeEach(async function () {
      c = await (await ethers.getContractFactory("FactionRegistry")).deploy()
      await c.waitForDeployment()
    })

    it("transfers ownership and emits OwnerUpdated", async function () {
      expect(await c.owner()).to.equal(deployer.address)
      await expect(c.transferOwnership(newOwner.address))
        .to.emit(c, "OwnerUpdated")
        .withArgs(deployer.address, newOwner.address)
      expect(await c.owner()).to.equal(newOwner.address)
    })

    it("rejects a non-owner and the zero address", async function () {
      await expect(
        c.connect(outsider).transferOwnership(outsider.address),
      ).to.be.revertedWithCustomError(c, "NotOwner")
      await expect(
        c.transferOwnership(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(c, "ZeroAddress")
    })

    it("moves admin power to the new owner", async function () {
      await c.transferOwnership(newOwner.address)
      await expect(
        c.connect(deployer).setVerifier(outsider.address),
      ).to.be.revertedWithCustomError(c, "NotOwner")
      await c.connect(newOwner).setVerifier(outsider.address)
      expect(await c.verifier()).to.equal(outsider.address)
    })
  })

  describe("GovernanceDAO", function () {
    let c
    beforeEach(async function () {
      const fr = await (await ethers.getContractFactory("FactionRegistry")).deploy()
      await fr.waitForDeployment()
      c = await (await ethers.getContractFactory("GovernanceDAO")).deploy(
        await fr.getAddress(),
      )
      await c.waitForDeployment()
    })

    it("transfers ownership and emits OwnerUpdated", async function () {
      await expect(c.transferOwnership(newOwner.address))
        .to.emit(c, "OwnerUpdated")
        .withArgs(deployer.address, newOwner.address)
      expect(await c.owner()).to.equal(newOwner.address)
    })

    it("rejects a non-owner and the zero address", async function () {
      await expect(
        c.connect(outsider).transferOwnership(outsider.address),
      ).to.be.revertedWithCustomError(c, "NotOwner")
      await expect(c.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith(
        "zero owner",
      )
    })
  })

  describe("Treasury", function () {
    let c
    beforeEach(async function () {
      const accounts = await ethers.getSigners()
      const signers = accounts.slice(3, 8).map((s) => s.address)
      c = await (await ethers.getContractFactory("Treasury")).deploy(
        signers,
        deployer.address,
      )
      await c.waitForDeployment()
    })

    it("transfers ownership and emits OwnerUpdated", async function () {
      await expect(c.transferOwnership(newOwner.address))
        .to.emit(c, "OwnerUpdated")
        .withArgs(deployer.address, newOwner.address)
      expect(await c.owner()).to.equal(newOwner.address)
    })

    it("rejects a non-owner and the zero address", async function () {
      await expect(
        c.connect(outsider).transferOwnership(outsider.address),
      ).to.be.revertedWithCustomError(c, "NotOwner")
      await expect(
        c.transferOwnership(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(c, "ZeroAddress")
    })
  })

  describe("DelayedInbox", function () {
    let c
    beforeEach(async function () {
      c = await (await ethers.getContractFactory("DelayedInbox")).deploy(
        3600,
        deployer.address,
      )
      await c.waitForDeployment()
    })

    it("transfers ownership and emits OwnerUpdated", async function () {
      await expect(c.transferOwnership(newOwner.address))
        .to.emit(c, "OwnerUpdated")
        .withArgs(deployer.address, newOwner.address)
      expect(await c.owner()).to.equal(newOwner.address)
    })

    it("rejects a non-owner and the zero address", async function () {
      await expect(
        c.connect(outsider).transferOwnership(outsider.address),
      ).to.be.revertedWith("only owner")
      await expect(c.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith(
        "zero address",
      )
    })
  })

  describe("PoSeManager (v1)", function () {
    let c
    beforeEach(async function () {
      c = await (await ethers.getContractFactory("PoSeManager")).deploy()
      await c.waitForDeployment()
    })

    it("transfers ownership and emits OwnerUpdated", async function () {
      await expect(c.transferOwnership(newOwner.address))
        .to.emit(c, "OwnerUpdated")
        .withArgs(deployer.address, newOwner.address)
      expect(await c.owner()).to.equal(newOwner.address)
    })

    it("rejects a non-owner and the zero address", async function () {
      await expect(
        c.connect(outsider).transferOwnership(outsider.address),
      ).to.be.revertedWith("not owner")
      await expect(c.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith(
        "zero owner",
      )
    })
  })

  describe("PoSeManagerV2", function () {
    let c
    beforeEach(async function () {
      c = await (await ethers.getContractFactory("PoSeManagerV2")).deploy()
      await c.waitForDeployment()
    })

    it("transfers ownership and emits OwnerUpdated", async function () {
      await expect(c.transferOwnership(newOwner.address))
        .to.emit(c, "OwnerUpdated")
        .withArgs(deployer.address, newOwner.address)
      expect(await c.owner()).to.equal(newOwner.address)
    })

    it("rejects a non-owner and the zero address", async function () {
      await expect(
        c.connect(outsider).transferOwnership(outsider.address),
      ).to.be.revertedWith("not owner")
      await expect(c.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith(
        "zero owner",
      )
    })

    it("moves admin power to the new owner", async function () {
      await c.transferOwnership(newOwner.address)
      await expect(
        c.connect(deployer).setChallengeBondMin(1),
      ).to.be.revertedWith("not owner")
      await c.connect(newOwner).setChallengeBondMin(1)
      expect(await c.challengeBondMin()).to.equal(1)
    })
  })
})
