/**
 * FoundationVesting security regression tests.
 */

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

async function deployVesting(beneficiary) {
  const [deployer] = await ethers.getSigners()
  const Factory = await ethers.getContractFactory("FoundationVesting")
  const vesting = await upgrades.deployProxy(
    Factory,
    [beneficiary, deployer.address],
    { initializer: "initialize", kind: "uups" },
  )
  await vesting.waitForDeployment()
  return vesting
}

async function installRejectingReceiverCode(address) {
  const Rejecting = await ethers.getContractFactory("EthRejectingReceiver")
  const rejecting = await Rejecting.deploy()
  await rejecting.waitForDeployment()
  const code = await ethers.provider.getCode(await rejecting.getAddress())
  await ethers.provider.send("hardhat_setCode", [address, code])
}

describe("FoundationVesting: release payments", () => {
  it("credits pending withdrawal when beneficiary rejects ETH", async () => {
    const [, funder, beneficiary] = await ethers.getSigners()
    const vesting = await deployVesting(beneficiary.address)
    const amount = ethers.parseEther("10")
    const funding = ethers.parseEther("100")

    await funder.sendTransaction({ to: await vesting.getAddress(), value: funding })
    await installRejectingReceiverCode(beneficiary.address)

    await expect(vesting.connect(beneficiary).release(amount))
      .to.emit(vesting, "WithdrawalCredited")
      .withArgs(beneficiary.address, amount)
      .and.to.emit(vesting, "Released")
      .withArgs(beneficiary.address, amount)

    expect(await vesting.pendingWithdrawals(beneficiary.address)).to.equal(amount)
    expect(await vesting.pendingWithdrawalTotal()).to.equal(amount)
    expect(await vesting.availableBalance()).to.equal(funding - amount)
    expect(await vesting.totalReleased()).to.equal(amount)

    await ethers.provider.send("hardhat_setCode", [beneficiary.address, "0x"])

    await expect(vesting.connect(beneficiary).withdrawPayments())
      .to.emit(vesting, "WithdrawalClaimed")
      .withArgs(beneficiary.address, amount)

    expect(await vesting.pendingWithdrawals(beneficiary.address)).to.equal(0n)
    expect(await vesting.pendingWithdrawalTotal()).to.equal(0n)
    expect(await vesting.availableBalance()).to.equal(funding - amount)
    expect(await ethers.provider.getBalance(await vesting.getAddress())).to.equal(funding - amount)
  })

  it("rejects withdrawPayments without pending credit", async () => {
    const [, beneficiary] = await ethers.getSigners()
    const vesting = await deployVesting(beneficiary.address)

    await expect(vesting.connect(beneficiary).withdrawPayments())
      .to.be.revertedWithCustomError(vesting, "NoPendingWithdrawal")
  })
})
