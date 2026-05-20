const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

describe("COCToken", function () {
  let token
  let owner
  let minter

  beforeEach(async function () {
    ;[owner, minter] = await ethers.getSigners()

    const Factory = await ethers.getContractFactory("COCToken")
    token = await upgrades.deployProxy(
      Factory,
      [[owner.address], [ethers.parseEther("250000000")], owner.address],
      { initializer: "initialize", kind: "uups" },
    )
    await token.waitForDeployment()
  })

  it("rejects zero-address minter updates", async function () {
    await expect(
      token.setMinter(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(token, "ZeroAddress")
  })

  it("allows the owner to set a nonzero minter", async function () {
    await expect(token.setMinter(minter.address))
      .to.emit(token, "MinterUpdated")
      .withArgs(ethers.ZeroAddress, minter.address)

    expect(await token.minter()).to.equal(minter.address)
  })
})
