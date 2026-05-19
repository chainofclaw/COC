/**
 * MultiSigWallet Tests
 *
 * Covers the wallet used as the owner of COC governance / settlement
 * contracts:
 * - Constructor validation (owner set, threshold bounds, dedup, zero address)
 * - submit / confirm / execute happy path (N-of-M threshold)
 * - Threshold enforcement (cannot execute below `required`)
 * - revoke confirmation
 * - Access control (non-owners rejected)
 * - Failed inner call reverts the whole execution (executed flag rolled back)
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

describe("MultiSigWallet", function () {
  let wallet
  let signers
  let owners
  let outsider
  let recipient

  const REQUIRED = 3

  beforeEach(async function () {
    const accounts = await ethers.getSigners()
    signers = accounts.slice(0, 5)
    owners = signers.map((s) => s.address)
    outsider = accounts[5]
    recipient = accounts[6]

    const Factory = await ethers.getContractFactory("MultiSigWallet")
    wallet = await Factory.deploy(owners, REQUIRED)
    await wallet.waitForDeployment()
  })

  describe("constructor", function () {
    it("records owners and threshold", async function () {
      expect(await wallet.required()).to.equal(REQUIRED)
      expect(await wallet.getOwners()).to.deep.equal(owners)
      for (const o of owners) {
        expect(await wallet.isOwner(o)).to.equal(true)
      }
      expect(await wallet.isOwner(outsider.address)).to.equal(false)
    })

    it("rejects empty owner set", async function () {
      const Factory = await ethers.getContractFactory("MultiSigWallet")
      await expect(Factory.deploy([], 1)).to.be.revertedWith("Owners required")
    })

    it("rejects a threshold above the owner count", async function () {
      const Factory = await ethers.getContractFactory("MultiSigWallet")
      await expect(Factory.deploy(owners, 6)).to.be.revertedWith(
        "Invalid required count",
      )
    })

    it("rejects a zero threshold", async function () {
      const Factory = await ethers.getContractFactory("MultiSigWallet")
      await expect(Factory.deploy(owners, 0)).to.be.revertedWith(
        "Invalid required count",
      )
    })

    it("rejects a zero owner address", async function () {
      const Factory = await ethers.getContractFactory("MultiSigWallet")
      await expect(
        Factory.deploy([owners[0], ethers.ZeroAddress], 1),
      ).to.be.revertedWith("Invalid owner")
    })

    it("rejects duplicate owners", async function () {
      const Factory = await ethers.getContractFactory("MultiSigWallet")
      await expect(
        Factory.deploy([owners[0], owners[0]], 1),
      ).to.be.revertedWith("Duplicate owner")
    })
  })

  describe("submit / confirm / execute", function () {
    const VALUE = ethers.parseEther("1")

    beforeEach(async function () {
      await signers[0].sendTransaction({
        to: await wallet.getAddress(),
        value: ethers.parseEther("5"),
      })
    })

    it("executes an ETH transfer once the threshold is met", async function () {
      await wallet.connect(signers[0]).submitTransaction(recipient.address, VALUE, "0x")

      await wallet.connect(signers[0]).confirmTransaction(0)
      await wallet.connect(signers[1]).confirmTransaction(0)
      await wallet.connect(signers[2]).confirmTransaction(0)

      const before = await ethers.provider.getBalance(recipient.address)
      await expect(wallet.connect(signers[2]).executeTransaction(0))
        .to.emit(wallet, "Execute")
        .withArgs(0)
      const after = await ethers.provider.getBalance(recipient.address)
      expect(after - before).to.equal(VALUE)
    })

    it("rejects execution below the confirmation threshold", async function () {
      await wallet.connect(signers[0]).submitTransaction(recipient.address, VALUE, "0x")
      await wallet.connect(signers[0]).confirmTransaction(0)
      await wallet.connect(signers[1]).confirmTransaction(0)

      await expect(
        wallet.connect(signers[1]).executeTransaction(0),
      ).to.be.revertedWith("Not enough confirmations")
    })

    it("rejects double execution", async function () {
      await wallet.connect(signers[0]).submitTransaction(recipient.address, VALUE, "0x")
      for (let i = 0; i < REQUIRED; i++) {
        await wallet.connect(signers[i]).confirmTransaction(0)
      }
      await wallet.connect(signers[0]).executeTransaction(0)

      await expect(
        wallet.connect(signers[0]).executeTransaction(0),
      ).to.be.revertedWith("Already executed")
    })

    it("revoking a confirmation drops the count below threshold", async function () {
      await wallet.connect(signers[0]).submitTransaction(recipient.address, VALUE, "0x")
      for (let i = 0; i < REQUIRED; i++) {
        await wallet.connect(signers[i]).confirmTransaction(0)
      }
      await wallet.connect(signers[2]).revokeConfirmation(0)

      await expect(
        wallet.connect(signers[0]).executeTransaction(0),
      ).to.be.revertedWith("Not enough confirmations")
    })

    it("rolls back the executed flag when the inner call reverts", async function () {
      // Inner call: confirmTransaction(999) on the wallet itself — reverts
      // because the tx does not exist, so executeTransaction must revert too.
      const badData = wallet.interface.encodeFunctionData("confirmTransaction", [999])
      await wallet
        .connect(signers[0])
        .submitTransaction(await wallet.getAddress(), 0, badData)
      for (let i = 0; i < REQUIRED; i++) {
        await wallet.connect(signers[i]).confirmTransaction(0)
      }

      await expect(
        wallet.connect(signers[0]).executeTransaction(0),
      ).to.be.revertedWith("Execution failed")

      const txn = await wallet.transactions(0)
      expect(txn.executed).to.equal(false)
    })
  })

  describe("access control", function () {
    it("rejects submitTransaction from a non-owner", async function () {
      await expect(
        wallet.connect(outsider).submitTransaction(recipient.address, 0, "0x"),
      ).to.be.revertedWith("Not owner")
    })

    it("rejects confirmTransaction from a non-owner", async function () {
      await wallet.connect(signers[0]).submitTransaction(recipient.address, 0, "0x")
      await expect(
        wallet.connect(outsider).confirmTransaction(0),
      ).to.be.revertedWith("Not owner")
    })

    it("rejects confirming a non-existent transaction", async function () {
      await expect(
        wallet.connect(signers[0]).confirmTransaction(0),
      ).to.be.revertedWith("Tx does not exist")
    })

    it("rejects a double confirmation from the same owner", async function () {
      await wallet.connect(signers[0]).submitTransaction(recipient.address, 0, "0x")
      await wallet.connect(signers[0]).confirmTransaction(0)
      await expect(
        wallet.connect(signers[0]).confirmTransaction(0),
      ).to.be.revertedWith("Already confirmed")
    })
  })
})
