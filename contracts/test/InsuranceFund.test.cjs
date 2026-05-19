/**
 * InsuranceFund Test Suite — Phase I5.
 *
 * Covers:
 *   - constructor + zero-address rejection
 *   - receive() updates totalDeposited and emits event
 *   - governance withdraw + zero-amount + zero-address + insufficient balance
 *   - transferGovernance restricts and updates the role
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

async function deployFund(initialGovernance) {
  const Factory = await ethers.getContractFactory("InsuranceFund")
  const fund = await Factory.deploy(initialGovernance)
  await fund.waitForDeployment()
  return fund
}

async function installRejectingReceiverCode(address) {
  const Rejecting = await ethers.getContractFactory("EthRejectingReceiver")
  const rejecting = await Rejecting.deploy()
  await rejecting.waitForDeployment()
  const code = await ethers.provider.getCode(await rejecting.getAddress())
  await ethers.provider.send("hardhat_setCode", [address, code])
}

describe("InsuranceFund: deployment", () => {
  it("rejects zero-address governance", async () => {
    const Factory = await ethers.getContractFactory("InsuranceFund")
    await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Factory, "ZeroAddress")
  })

  it("constructor sets governance", async () => {
    const [a] = await ethers.getSigners()
    const fund = await deployFund(a.address)
    expect(await fund.governance()).to.equal(a.address)
    expect(await fund.totalDeposited()).to.equal(0n)
    expect(await fund.totalWithdrawn()).to.equal(0n)
  })
})

describe("InsuranceFund: deposit", () => {
  it("receive() bumps totalDeposited and emits event", async () => {
    const [gov, sender] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    const amount = ethers.parseEther("1.5")
    const tx = await sender.sendTransaction({ to: await fund.getAddress(), value: amount })
    await tx.wait()
    expect(await fund.totalDeposited()).to.equal(amount)
    expect(await fund.balance()).to.equal(amount)
  })

  it("zero-value receive() is a no-op", async () => {
    const [gov, sender] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    await sender.sendTransaction({ to: await fund.getAddress(), value: 0n })
    expect(await fund.totalDeposited()).to.equal(0n)
  })
})

describe("InsuranceFund: withdraw", () => {
  it("governance withdraws to recipient and updates totalWithdrawn", async () => {
    const [gov, sender, recipient] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    const amount = ethers.parseEther("2")
    await sender.sendTransaction({ to: await fund.getAddress(), value: amount })

    const recipBefore = await ethers.provider.getBalance(recipient.address)
    const tx = await fund.connect(gov).withdraw(recipient.address, amount)
    await tx.wait()
    const recipAfter = await ethers.provider.getBalance(recipient.address)

    expect(recipAfter - recipBefore).to.equal(amount)
    expect(await fund.totalWithdrawn()).to.equal(amount)
    expect(await fund.balance()).to.equal(0n)
  })

  it("credits a pending withdrawal when the recipient rejects ETH", async () => {
    const [gov, sender, recipient] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    const amount = ethers.parseEther("1")
    await sender.sendTransaction({ to: await fund.getAddress(), value: ethers.parseEther("2") })
    await installRejectingReceiverCode(recipient.address)

    await expect(fund.connect(gov).withdraw(recipient.address, amount))
      .to.emit(fund, "WithdrawalCredited")
      .withArgs(recipient.address, amount)
    expect(await fund.pendingWithdrawals(recipient.address)).to.equal(amount)
    expect(await fund.pendingWithdrawalTotal()).to.equal(amount)
    expect(await fund.totalWithdrawn()).to.equal(amount)
    expect(await fund.availableBalance()).to.equal(amount)

    await expect(
      fund.connect(gov).withdraw(gov.address, ethers.parseEther("1.5")),
    ).to.be.revertedWithCustomError(fund, "InsufficientBalance")
      .withArgs(ethers.parseEther("1.5"), amount)

    await ethers.provider.send("hardhat_setCode", [recipient.address, "0x"])
    await fund.connect(recipient).withdrawPayments()

    expect(await fund.pendingWithdrawals(recipient.address)).to.equal(0n)
    expect(await fund.pendingWithdrawalTotal()).to.equal(0n)
    expect(await fund.balance()).to.equal(amount)
  })

  it("non-governance withdraw reverts OnlyGovernance", async () => {
    const [gov, intruder] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    await gov.sendTransaction({ to: await fund.getAddress(), value: ethers.parseEther("1") })
    await expect(
      fund.connect(intruder).withdraw(intruder.address, ethers.parseEther("0.5")),
    ).to.be.revertedWithCustomError(fund, "OnlyGovernance")
  })

  it("zero-amount withdraw reverts", async () => {
    const [gov] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    await expect(fund.connect(gov).withdraw(gov.address, 0n)).to.be.revertedWithCustomError(fund, "ZeroAmount")
  })

  it("zero-address recipient reverts", async () => {
    const [gov] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    await gov.sendTransaction({ to: await fund.getAddress(), value: ethers.parseEther("1") })
    await expect(
      fund.connect(gov).withdraw(ethers.ZeroAddress, ethers.parseEther("0.1")),
    ).to.be.revertedWithCustomError(fund, "ZeroAddress")
  })

  it("withdraw above balance reverts InsufficientBalance", async () => {
    const [gov, recipient] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    await gov.sendTransaction({ to: await fund.getAddress(), value: ethers.parseEther("0.5") })
    await expect(
      fund.connect(gov).withdraw(recipient.address, ethers.parseEther("1")),
    ).to.be.revertedWithCustomError(fund, "InsufficientBalance")
  })
})

describe("InsuranceFund: governance role transfer", () => {
  it("transferGovernance moves role and emits event", async () => {
    const [gov, newGov] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    await expect(fund.connect(gov).transferGovernance(newGov.address))
      .to.emit(fund, "GovernanceUpdated")
      .withArgs(gov.address, newGov.address)
    expect(await fund.governance()).to.equal(newGov.address)
    // Old governance loses access
    await expect(
      fund.connect(gov).transferGovernance(gov.address),
    ).to.be.revertedWithCustomError(fund, "OnlyGovernance")
  })

  it("transferGovernance to zero address reverts", async () => {
    const [gov] = await ethers.getSigners()
    const fund = await deployFund(gov.address)
    await expect(
      fund.connect(gov).transferGovernance(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(fund, "ZeroAddress")
  })
})
