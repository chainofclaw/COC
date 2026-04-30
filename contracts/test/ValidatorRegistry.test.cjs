/**
 * ValidatorRegistry Test Suite
 *
 * Sprint 3 deliverable per /home/baominghao/.claude/plans/coc-evm-abstract-turtle.md.
 *
 * Covers:
 *   - stake() lifecycle: success, nodeId-pubkey mismatch, low stake, double
 *     register, active set cap.
 *   - requestUnstake / withdrawStake: lockup enforcement, only-operator
 *     guard, removal from active set on unstake.
 *   - slashValidator: only-slasher guard, BPS calculation, stake decrement,
 *     deactivation when active, recipient credit, repeated slash.
 *   - Owner ops: setSlasher / setSlashRecipient / transferOwnership.
 *   - Gas budget per Sprint 3 plan: register < 200k, slash < 100k.
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const MIN_STAKE = ethers.parseEther("32")
const UNSTAKE_LOCKUP = 14 * 24 * 60 * 60 // 14 days in seconds
const MAX_VALIDATORS = 21
const SLASH_BPS = 1000n
const BPS_DENOM = 10_000n

/**
 * Build the canonical (nodeId, pubkey65) pair for a fresh random wallet,
 * funded from `funder` so the wallet can pay gas + the stake.
 *
 * Hardhat's HardhatEthersSigner doesn't expose `signingKey`, so we can't
 * derive the uncompressed pubkey from getSigners(). A random Wallet does
 * expose `signingKey.publicKey` (65 B with 0x04 prefix). For repeatability
 * tests can pass an explicit private key.
 */
async function makeOperator(funder, fundEth = 33n) {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider)
  const pubkey = wallet.signingKey.publicKey // 0x04 || X || Y, 65 B
  const xy = "0x" + pubkey.slice(4)
  const nodeId = ethers.keccak256(xy)
  // Fund: stake amount + gas cushion.
  await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther(String(fundEth)) })
  return { wallet, pubkey, nodeId }
}

async function deployRegistry() {
  const signers = await ethers.getSigners()
  const owner = signers[0]
  const Factory = await ethers.getContractFactory("ValidatorRegistry")
  const registry = await Factory.deploy()
  await registry.waitForDeployment()
  // `signers` doubles as funder pool; tests that need named extras (e.g.
  // a stranger to assert revert) take from the tail.
  return { registry, owner, signers }
}

async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds])
  await ethers.provider.send("evm_mine", [])
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("ValidatorRegistry: constants", () => {
  it("exposes Sprint 3 plan parameters", async () => {
    const { registry } = await deployRegistry()
    expect(await registry.MIN_STAKE()).to.equal(MIN_STAKE)
    expect(await registry.UNSTAKE_LOCKUP()).to.equal(BigInt(UNSTAKE_LOCKUP))
    expect(await registry.MAX_VALIDATORS()).to.equal(BigInt(MAX_VALIDATORS))
    expect(await registry.SLASH_BPS()).to.equal(SLASH_BPS)
    expect(await registry.BPS_DENOM()).to.equal(BPS_DENOM)
  })

  it("constructor sets owner = slasher = slashRecipient = msg.sender", async () => {
    const { registry, owner } = await deployRegistry()
    expect(await registry.owner()).to.equal(owner.address)
    expect(await registry.slasher()).to.equal(owner.address)
    expect(await registry.slashRecipient()).to.equal(owner.address)
  })
})

describe("ValidatorRegistry: stake()", () => {
  it("registers + activates a validator on success", async () => {
    const { registry, owner } = await deployRegistry()
    const { wallet, pubkey, nodeId } = await makeOperator(owner)

    const tx = await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })
    const receipt = await tx.wait()

    // Two events: ValidatorRegistered + ValidatorActivated
    const registered = receipt.logs.find((l) => l.fragment?.name === "ValidatorRegistered")
    const activated = receipt.logs.find((l) => l.fragment?.name === "ValidatorActivated")
    expect(registered).to.exist
    expect(activated).to.exist
    expect(registered.args[0]).to.equal(nodeId)
    expect(registered.args[1]).to.equal(wallet.address)
    expect(registered.args[2]).to.equal(MIN_STAKE)
    // Event also carries the 65-byte pubkey (off-chain readers depend on this
    // since the contract drops pubkey from storage to fit the 200k gas budget).
    expect(registered.args[3]).to.equal(pubkey)

    // View: getValidator + isActive + getActiveValidators
    const v = await registry.getValidator(nodeId)
    expect(v.nodeId).to.equal(nodeId)
    expect(v.operator).to.equal(wallet.address)
    expect(v.stake).to.equal(MIN_STAKE)
    expect(v.active).to.equal(true)
    expect(v.unstakeRequestedAt).to.equal(0n)

    expect(await registry.isActive(nodeId)).to.equal(true)
    const activeSet = await registry.getActiveValidators()
    expect(activeSet).to.deep.equal([nodeId])
    expect(await registry.activeValidatorCount()).to.equal(1n)
  })

  it("reverts when nodeId doesn't match keccak256(pubkey[1:])", async () => {
    const { registry, owner } = await deployRegistry()
    const { wallet, pubkey } = await makeOperator(owner)
    const wrongNodeId = ethers.hexlify(ethers.randomBytes(32))

    await expect(
      registry.connect(wallet).stake(wrongNodeId, pubkey, { value: MIN_STAKE }),
    ).to.be.revertedWithCustomError(registry, "NodeIdMismatch")
  })

  it("reverts when pubkey length != 65", async () => {
    const { registry, owner } = await deployRegistry()
    const { wallet } = await makeOperator(owner)
    const shortPubkey = "0x" + "ab".repeat(64)
    const wrongNodeId = ethers.keccak256(shortPubkey)

    await expect(
      registry.connect(wallet).stake(wrongNodeId, shortPubkey, { value: MIN_STAKE }),
    ).to.be.revertedWithCustomError(registry, "InvalidPubkey")
  })

  it("reverts when stake is below MIN_STAKE", async () => {
    const { registry, owner } = await deployRegistry()
    const { wallet, pubkey, nodeId } = await makeOperator(owner)

    await expect(
      registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE - 1n }),
    ).to.be.revertedWithCustomError(registry, "StakeTooLow")
  })

  it("reverts on duplicate registration of the same nodeId", async () => {
    const { registry, owner } = await deployRegistry()
    const { wallet, pubkey, nodeId } = await makeOperator(owner, 66n)

    await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })
    await expect(
      registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE }),
    ).to.be.revertedWithCustomError(registry, "AlreadyRegistered")
  })

  it("reverts when active set is full (caps at MAX_VALIDATORS)", async () => {
    const { registry, owner } = await deployRegistry()

    // Stake 21 random validators.
    for (let i = 0; i < MAX_VALIDATORS; i++) {
      const { wallet, pubkey, nodeId } = await makeOperator(owner)
      await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })
    }
    expect(await registry.activeValidatorCount()).to.equal(BigInt(MAX_VALIDATORS))

    // 22nd attempt must revert.
    const { wallet, pubkey, nodeId } = await makeOperator(owner)
    await expect(
      registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE }),
    ).to.be.revertedWithCustomError(registry, "ValidatorSetFull")
  })

  it("respects gas budget for register (< 200k)", async () => {
    const { registry, owner } = await deployRegistry()
    const { wallet, pubkey, nodeId } = await makeOperator(owner)

    const tx = await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(200_000n)
  })
})

describe("ValidatorRegistry: requestUnstake() / withdrawStake()", () => {
  async function fixture() {
    const { registry, owner, signers } = await deployRegistry()
    const { wallet, pubkey, nodeId } = await makeOperator(owner)
    await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })
    return { registry, op: wallet, nodeId, pubkey, signers, owner }
  }

  it("removes from active set + emits ValidatorDeactivated", async () => {
    const { registry, op, nodeId } = await fixture()
    const tx = await registry.connect(op).requestUnstake(nodeId)
    const receipt = await tx.wait()

    const ev = receipt.logs.find((l) => l.fragment?.name === "ValidatorDeactivated")
    expect(ev).to.exist
    expect(ev.args[0]).to.equal(nodeId)
    expect(ev.args[1]).to.be.greaterThan(0n) // unstakeRequestedAt timestamp

    expect(await registry.isActive(nodeId)).to.equal(false)
    expect(await registry.activeValidatorCount()).to.equal(0n)
  })

  it("rejects request from non-operator", async () => {
    const { registry, nodeId, signers } = await fixture()
    const stranger = signers[2]
    await expect(
      registry.connect(stranger).requestUnstake(nodeId),
    ).to.be.revertedWithCustomError(registry, "NotOperator")
  })

  it("rejects double-deactivation", async () => {
    const { registry, op, nodeId } = await fixture()
    await registry.connect(op).requestUnstake(nodeId)
    await expect(
      registry.connect(op).requestUnstake(nodeId),
    ).to.be.revertedWithCustomError(registry, "AlreadyDeactivated")
  })

  it("withdrawStake reverts before lockup elapsed", async () => {
    const { registry, op, nodeId } = await fixture()
    await registry.connect(op).requestUnstake(nodeId)
    await expect(
      registry.connect(op).withdrawStake(nodeId),
    ).to.be.revertedWithCustomError(registry, "StillLockedUp")
  })

  it("withdrawStake transfers stake + deletes record after lockup", async () => {
    const { registry, op, nodeId } = await fixture()
    await registry.connect(op).requestUnstake(nodeId)

    await increaseTime(UNSTAKE_LOCKUP + 1)

    const balanceBefore = await ethers.provider.getBalance(op.address)
    const tx = await registry.connect(op).withdrawStake(nodeId)
    const receipt = await tx.wait()
    const gasCost = receipt.gasUsed * receipt.gasPrice
    const balanceAfter = await ethers.provider.getBalance(op.address)

    // Operator should have gained MIN_STAKE - gas
    expect(balanceAfter - balanceBefore + gasCost).to.equal(MIN_STAKE)

    // Record cleared (operator zeroed)
    const v = await registry.getValidator(nodeId)
    expect(v.operator).to.equal(ethers.ZeroAddress)
    expect(v.stake).to.equal(0n)
  })

  it("withdrawStake rejects when called while active (i.e., requestUnstake never called)", async () => {
    const { registry, op, nodeId } = await fixture()
    // Active — never requested unstake.
    await expect(
      registry.connect(op).withdrawStake(nodeId),
    ).to.be.revertedWithCustomError(registry, "NotActive")
  })
})

describe("ValidatorRegistry: slashValidator()", () => {
  async function fixture() {
    const { registry, owner, signers } = await deployRegistry()
    const { wallet, pubkey, nodeId } = await makeOperator(owner)
    await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })
    return { registry, op: wallet, nodeId, pubkey, signers, owner }
  }

  it("rejects slash from non-slasher", async () => {
    const { registry, nodeId, signers } = await fixture()
    const stranger = signers[5]
    await expect(
      registry.connect(stranger).slashValidator(nodeId, ethers.id("test-evidence")),
    ).to.be.revertedWithCustomError(registry, "OnlySlasher")
  })

  it("deducts SLASH_BPS, deactivates active validator, credits slashRecipient", async () => {
    const { registry, op, nodeId } = await fixture()

    const expectedSlash = (MIN_STAKE * SLASH_BPS) / BPS_DENOM
    const recipient = await registry.slashRecipient()
    const recipientBefore = await ethers.provider.getBalance(recipient)

    // Calculate the deployer's gas cost since it's also the recipient:
    // recipient == owner == slasher. Gas comes out of the same balance,
    // but the slash credit is added to balance.
    const tx = await registry.slashValidator(nodeId, ethers.id("evidence"))
    const receipt = await tx.wait()
    const gasCost = receipt.gasUsed * receipt.gasPrice
    const recipientAfter = await ethers.provider.getBalance(recipient)

    // Net change: -gasCost + expectedSlash
    expect(recipientAfter - recipientBefore + gasCost).to.equal(expectedSlash)

    const v = await registry.getValidator(nodeId)
    expect(v.stake).to.equal(MIN_STAKE - expectedSlash)
    expect(v.active).to.equal(false)
    expect(await registry.activeValidatorCount()).to.equal(0n)

    // Event check
    const ev = receipt.logs.find((l) => l.fragment?.name === "ValidatorSlashed")
    expect(ev).to.exist
    expect(ev.args[0]).to.equal(nodeId)
    expect(ev.args[1]).to.equal(expectedSlash)
  })

  it("respects gas budget for slash (< 100k)", async () => {
    const { registry, nodeId } = await fixture()
    const tx = await registry.slashValidator(nodeId, ethers.id("evidence"))
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(100_000n)
  })

  it("repeated slashes geometrically reduce stake", async () => {
    const { registry, nodeId } = await fixture()
    // After 1st slash: 32 - 3.2 = 28.8 ETH
    // After 2nd slash: 28.8 * 0.9 = 25.92 ETH
    await registry.slashValidator(nodeId, ethers.id("e1"))
    await registry.slashValidator(nodeId, ethers.id("e2"))

    const v = await registry.getValidator(nodeId)
    const expected = (MIN_STAKE * 9000n / 10000n) * 9000n / 10000n
    expect(v.stake).to.equal(expected)
  })

  it("can slash an already-deactivated validator (during lockup)", async () => {
    const { registry, op, nodeId } = await fixture()
    await registry.connect(op).requestUnstake(nodeId)
    expect(await registry.isActive(nodeId)).to.equal(false)

    // Slasher can still take from the locked-up stake.
    await registry.slashValidator(nodeId, ethers.id("late-evidence"))
    const v = await registry.getValidator(nodeId)
    expect(v.stake).to.equal(MIN_STAKE - (MIN_STAKE * SLASH_BPS) / BPS_DENOM)
  })
})

describe("ValidatorRegistry: active-set bookkeeping", () => {
  it("swap-pop preserves active set integrity across mid-set deactivation", async () => {
    const { registry, owner } = await deployRegistry()
    const ops = []
    const ids = []
    for (let i = 0; i < 3; i++) {
      const { wallet, pubkey, nodeId } = await makeOperator(owner)
      await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })
      ops.push(wallet)
      ids.push(nodeId)
    }

    expect(await registry.getActiveValidators()).to.deep.equal(ids)

    // Deactivate the middle one — last should swap into its slot.
    await registry.connect(ops[1]).requestUnstake(ids[1])

    const after = await registry.getActiveValidators()
    expect(after.length).to.equal(2)
    expect(after).to.include(ids[0])
    expect(after).to.include(ids[2])
    expect(after).to.not.include(ids[1])
  })
})

describe("ValidatorRegistry: owner ops", () => {
  it("setSlasher rotates the slasher role", async () => {
    const { registry, owner, signers } = await deployRegistry()
    const newSlasher = signers[1]

    await registry.connect(owner).setSlasher(newSlasher.address)
    expect(await registry.slasher()).to.equal(newSlasher.address)

    // Old slasher (owner) can no longer slash.
    const { wallet, pubkey, nodeId } = await makeOperator(owner)
    await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })

    await expect(
      registry.connect(owner).slashValidator(nodeId, ethers.id("test")),
    ).to.be.revertedWithCustomError(registry, "OnlySlasher")

    await registry.connect(newSlasher).slashValidator(nodeId, ethers.id("ok"))
  })

  it("setSlasher rejects zero address", async () => {
    const { registry } = await deployRegistry()
    await expect(
      registry.setSlasher(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(registry, "ZeroAddress")
  })

  it("transferOwnership moves owner authority", async () => {
    const { registry, owner, signers } = await deployRegistry()
    const newOwner = signers[3]

    await registry.connect(owner).transferOwnership(newOwner.address)
    expect(await registry.owner()).to.equal(newOwner.address)

    // Old owner can no longer change slasher.
    await expect(
      registry.connect(owner).setSlasher(signers[1].address),
    ).to.be.revertedWithCustomError(registry, "OnlyOwner")

    await registry.connect(newOwner).setSlasher(signers[1].address)
    expect(await registry.slasher()).to.equal(signers[1].address)
  })
})

describe("ValidatorRegistry: Phase I5 — slash split when insuranceFund set", () => {
  const SPLIT_BURN_BPS = 5000n
  const SPLIT_REPORTER_BPS = 3000n

  async function fixtureWithSplit() {
    const { registry, owner, signers } = await deployRegistry()
    const reporter = signers[1]
    const InsuranceFundFactory = await ethers.getContractFactory("InsuranceFund")
    const insuranceFund = await InsuranceFundFactory.deploy(owner.address)
    await insuranceFund.waitForDeployment()

    // Wire: slashRecipient = reporter; insuranceFund = the new contract.
    await registry.connect(owner).setSlashRecipient(reporter.address)
    await registry.connect(owner).setInsuranceFund(await insuranceFund.getAddress())

    const { wallet, pubkey, nodeId } = await makeOperator(owner)
    await registry.connect(wallet).stake(nodeId, pubkey, { value: MIN_STAKE })

    return { registry, owner, signers, reporter, insuranceFund, op: wallet, nodeId }
  }

  it("splits slashed amount 50/30/20 to burnSink/reporter/insuranceFund", async () => {
    const { registry, owner, reporter, insuranceFund, nodeId } = await fixtureWithSplit()
    const expectedSlash = (MIN_STAKE * SLASH_BPS) / BPS_DENOM
    const expectedBurn = (expectedSlash * SPLIT_BURN_BPS) / BPS_DENOM
    const expectedReporter = (expectedSlash * SPLIT_REPORTER_BPS) / BPS_DENOM
    const expectedInsurance = expectedSlash - expectedBurn - expectedReporter

    const burnSinkAddr = "0x000000000000000000000000000000000000dEaD"
    const burnBefore = await ethers.provider.getBalance(burnSinkAddr)
    const reporterBefore = await ethers.provider.getBalance(reporter.address)
    const fundBefore = await ethers.provider.getBalance(await insuranceFund.getAddress())

    const tx = await registry.connect(owner).slashValidator(nodeId, ethers.id("evidence-i5"))
    const receipt = await tx.wait()

    expect((await ethers.provider.getBalance(burnSinkAddr)) - burnBefore).to.equal(expectedBurn)
    expect((await ethers.provider.getBalance(reporter.address)) - reporterBefore).to.equal(expectedReporter)
    expect(
      (await ethers.provider.getBalance(await insuranceFund.getAddress())) - fundBefore,
    ).to.equal(expectedInsurance)

    expect(expectedBurn + expectedReporter + expectedInsurance).to.equal(expectedSlash)

    const evDistributed = receipt.logs.find((l) => l.fragment?.name === "SlashDistributed")
    expect(evDistributed, "SlashDistributed must fire").to.exist
    expect(evDistributed.args[1]).to.equal(expectedBurn)
    expect(evDistributed.args[2]).to.equal(expectedReporter)
    expect(evDistributed.args[3]).to.equal(expectedInsurance)
  })

  it("setBurnSink redirects burn share to override address", async () => {
    const { registry, owner, signers, reporter, insuranceFund, nodeId } = await fixtureWithSplit()
    const altBurn = signers[5]
    await registry.connect(owner).setBurnSink(altBurn.address)
    const expectedSlash = (MIN_STAKE * SLASH_BPS) / BPS_DENOM
    const expectedBurn = (expectedSlash * SPLIT_BURN_BPS) / BPS_DENOM

    const altBefore = await ethers.provider.getBalance(altBurn.address)
    await registry.connect(owner).slashValidator(nodeId, ethers.id("evidence-i5"))
    const altAfter = await ethers.provider.getBalance(altBurn.address)
    expect(altAfter - altBefore).to.equal(expectedBurn)
  })

  it("clearing insuranceFund (setInsuranceFund=0) reverts to legacy 100% behaviour", async () => {
    const { registry, owner, reporter, insuranceFund, nodeId } = await fixtureWithSplit()
    const expectedSlash = (MIN_STAKE * SLASH_BPS) / BPS_DENOM

    await registry.connect(owner).setInsuranceFund(ethers.ZeroAddress)
    const reporterBefore = await ethers.provider.getBalance(reporter.address)
    const fundBefore = await ethers.provider.getBalance(await insuranceFund.getAddress())
    await registry.connect(owner).slashValidator(nodeId, ethers.id("evidence-i5"))
    expect((await ethers.provider.getBalance(reporter.address)) - reporterBefore).to.equal(expectedSlash)
    // No deposit to insurance — fully reverted to legacy.
    expect(await ethers.provider.getBalance(await insuranceFund.getAddress())).to.equal(fundBefore)
  })

  it("non-owner cannot setInsuranceFund / setBurnSink", async () => {
    const { registry, signers } = await deployRegistry()
    await expect(
      registry.connect(signers[1]).setInsuranceFund(signers[2].address),
    ).to.be.revertedWithCustomError(registry, "OnlyOwner")
    await expect(
      registry.connect(signers[1]).setBurnSink(signers[2].address),
    ).to.be.revertedWithCustomError(registry, "OnlyOwner")
  })
})
