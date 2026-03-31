/**
 * DelayedInbox Tests
 *
 * Covers:
 * - Transaction enqueue (happy path, empty tx, oversized tx)
 * - Force include (before delay, after delay, already included)
 * - Mark included (sequencer only, out of range)
 * - Queue state management
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

// Short inclusion delay for testing (120 seconds)
const INCLUSION_DELAY = 120

describe("DelayedInbox", function () {
  let inbox
  let deployer, sequencer, user1, user2

  beforeEach(async function () {
    ;[deployer, sequencer, user1, user2] = await ethers.getSigners()

    const Factory = await ethers.getContractFactory("DelayedInbox")
    inbox = await Factory.deploy(INCLUSION_DELAY, sequencer.address)
    await inbox.waitForDeployment()
  })

  describe("enqueueTransaction", function () {
    it("enqueues a valid transaction", async function () {
      const l2Tx = "0xabcdef1234"
      const txHash = ethers.keccak256(l2Tx)

      const tx = await inbox.connect(user1).enqueueTransaction(l2Tx)
      await expect(tx)
        .to.emit(inbox, "TransactionEnqueued")
        .withArgs(0, user1.address, txHash, () => true)

      expect(await inbox.getQueueLength()).to.equal(1)

      const item = await inbox.getQueueItem(0)
      expect(item.sender).to.equal(user1.address)
      expect(item.included).to.equal(false)
      expect(item.l2Tx).to.equal(l2Tx)
    })

    it("supports multiple enqueues from different users", async function () {
      await inbox.connect(user1).enqueueTransaction("0x01")
      await inbox.connect(user2).enqueueTransaction("0x02")
      await inbox.connect(user1).enqueueTransaction("0x03")

      expect(await inbox.getQueueLength()).to.equal(3)

      const item0 = await inbox.getQueueItem(0)
      const item1 = await inbox.getQueueItem(1)
      const item2 = await inbox.getQueueItem(2)

      expect(item0.sender).to.equal(user1.address)
      expect(item1.sender).to.equal(user2.address)
      expect(item2.sender).to.equal(user1.address)
    })

    it("rejects empty transaction", async function () {
      await expect(
        inbox.connect(user1).enqueueTransaction("0x"),
      ).to.be.revertedWith("empty transaction")
    })
  })

  describe("forceInclude", function () {
    beforeEach(async function () {
      await inbox.connect(user1).enqueueTransaction("0xdeadbeef")
    })

    it("rejects force-include before delay elapsed", async function () {
      await expect(
        inbox.connect(user1).forceInclude(0),
      ).to.be.revertedWithCustomError(inbox, "NotYetForceable")
    })

    it("allows force-include after delay elapsed", async function () {
      await ethers.provider.send("evm_increaseTime", [INCLUSION_DELAY + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await inbox.connect(user1).forceInclude(0)
      await expect(tx).to.emit(inbox, "TransactionForceIncluded").withArgs(0)
    })

    it("rejects force-include for out of range index", async function () {
      await expect(
        inbox.connect(user1).forceInclude(99),
      ).to.be.revertedWithCustomError(inbox, "QueueIndexOutOfRange")
    })

    it("rejects force-include for already included tx", async function () {
      // Mark as included first
      await inbox.connect(sequencer).markIncluded(0)

      await ethers.provider.send("evm_increaseTime", [INCLUSION_DELAY + 1])
      await ethers.provider.send("evm_mine", [])

      await expect(
        inbox.connect(user1).forceInclude(0),
      ).to.be.revertedWithCustomError(inbox, "AlreadyIncluded")
    })

    it("allows anyone to call forceInclude (not just sender)", async function () {
      await ethers.provider.send("evm_increaseTime", [INCLUSION_DELAY + 1])
      await ethers.provider.send("evm_mine", [])

      const tx = await inbox.connect(user2).forceInclude(0)
      await expect(tx).to.emit(inbox, "TransactionForceIncluded").withArgs(0)
    })
  })

  describe("markIncluded", function () {
    beforeEach(async function () {
      await inbox.connect(user1).enqueueTransaction("0xdeadbeef")
    })

    it("allows sequencer to mark tx as included", async function () {
      const tx = await inbox.connect(sequencer).markIncluded(0)
      await expect(tx).to.emit(inbox, "TransactionIncluded").withArgs(0)

      const item = await inbox.getQueueItem(0)
      expect(item.included).to.equal(true)
    })

    it("rejects non-sequencer caller", async function () {
      await expect(
        inbox.connect(user1).markIncluded(0),
      ).to.be.revertedWithCustomError(inbox, "NotSequencer")
    })

    it("rejects double inclusion", async function () {
      await inbox.connect(sequencer).markIncluded(0)
      await expect(
        inbox.connect(sequencer).markIncluded(0),
      ).to.be.revertedWithCustomError(inbox, "AlreadyIncluded")
    })

    it("rejects out of range index", async function () {
      await expect(
        inbox.connect(sequencer).markIncluded(99),
      ).to.be.revertedWithCustomError(inbox, "QueueIndexOutOfRange")
    })
  })

  describe("setSequencer", function () {
    it("allows owner to update sequencer", async function () {
      await inbox.connect(deployer).setSequencer(user2.address)
      expect(await inbox.sequencer()).to.equal(user2.address)

      // New sequencer can markIncluded
      await inbox.connect(user1).enqueueTransaction("0x01")
      await inbox.connect(user2).markIncluded(0)
    })

    it("rejects non-owner caller", async function () {
      await expect(
        inbox.connect(user1).setSequencer(user2.address),
      ).to.be.revertedWith("only owner")
    })

    it("rejects zero address", async function () {
      await expect(
        inbox.connect(deployer).setSequencer(ethers.ZeroAddress),
      ).to.be.revertedWith("zero address")
    })
  })

  describe("read helpers", function () {
    it("getQueueLength returns 0 initially", async function () {
      expect(await inbox.getQueueLength()).to.equal(0)
    })

    it("INCLUSION_DELAY returns configured value", async function () {
      expect(await inbox.INCLUSION_DELAY()).to.equal(INCLUSION_DELAY)
    })
  })
})
