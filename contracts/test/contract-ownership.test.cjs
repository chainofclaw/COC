/**
 * Contract ownership transfer tests (#686).
 *
 * Every governance / settlement contract that has an onlyOwner-gated admin
 * surface must be able to hand ownership to a multisig — otherwise the owner
 * is permanently stuck on the deploy key (which on 88780 was a public Hardhat
 * test account). Verifies transferOwnership on each contract: owner can
 * transfer, non-owner rejected, zero address rejected, admin power follows
 * the new owner.
 *
 * Updated for gen-5 UUPS: every contract is deployed through
 * upgrades.deployProxy with the new `initialize(...)` signature.
 */

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

async function deploy(factoryName, args) {
  const Factory = await ethers.getContractFactory(factoryName)
  const proxy = await upgrades.deployProxy(Factory, args, {
    initializer: "initialize",
    kind: "uups",
  })
  await proxy.waitForDeployment()
  return proxy
}

describe("Contract ownership transfer (#686)", function () {
  let deployer, newOwner, outsider

  beforeEach(async function () {
    ;[deployer, newOwner, outsider] = await ethers.getSigners()
  })

  describe("FactionRegistry", function () {
    let c
    beforeEach(async function () {
      c = await deploy("FactionRegistry", [deployer.address, deployer.address])
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
      const fr = await deploy("FactionRegistry", [deployer.address, deployer.address])
      c = await deploy("GovernanceDAO", [await fr.getAddress(), deployer.address])
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
      c = await deploy("Treasury", [signers, deployer.address, deployer.address])
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
      c = await deploy("DelayedInbox", [3600, deployer.address, deployer.address])
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
      c = await deploy("PoSeManager", [deployer.address])
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
      c = await deploy("PoSeManagerV2", [ethers.parseEther("0.1"), deployer.address])
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
