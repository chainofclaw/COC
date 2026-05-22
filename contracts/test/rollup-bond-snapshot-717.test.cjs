// RollupStateManager — #717 proposer-bond snapshot regression.
//
// The 88780 gen-5 UUPS conversion turned PROPOSER_BOND from `immutable` into
// a mutable storage variable ("mutable across upgrades"). OutputProposal did
// not record the bond a proposer actually escrowed, so finalizeOutput and
// resolveChallenge read the live global PROPOSER_BOND — mis-accounting every
// in-flight proposal once that global changes.
//
// These tests use a test-only subclass (RollupStateManagerBondConfigurable)
// that exposes setProposerBondForTest to simulate the post-deploy retune
// that on production would happen via a UUPS upgrade.

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

const CHALLENGE_WINDOW = 60
const PROPOSER_BOND = ethers.parseEther("1")
const CHALLENGER_BOND = ethers.parseEther("0.5")
const RAISED_BOND = ethers.parseEther("3")

describe("RollupStateManager — #717 proposer bond snapshot", function () {
  let manager
  let deployer, proposer, challenger, insuranceFund
  let outputRoot, stateRoot

  beforeEach(async function () {
    ;[deployer, proposer, challenger, insuranceFund] = await ethers.getSigners()

    const Factory = await ethers.getContractFactory("RollupStateManagerBondConfigurable")
    manager = await upgrades.deployProxy(
      Factory,
      [
        CHALLENGE_WINDOW,
        PROPOSER_BOND,
        CHALLENGER_BOND,
        insuranceFund.address,
        proposer.address,
        deployer.address,
      ],
      { initializer: "initialize", kind: "uups" },
    )
    await manager.waitForDeployment()

    // Pre-fund the contract so a buggy over-refund (live bond > escrowed
    // bond) would actually succeed and be observable, instead of failing on
    // insufficient balance and masking the bug as a pull-payment credit.
    await deployer.sendTransaction({ to: await manager.getAddress(), value: ethers.parseEther("10") })

    stateRoot = ethers.keccak256(ethers.toUtf8Bytes("state-root-1"))
    const blockHash = ethers.keccak256(ethers.toUtf8Bytes("block-hash-1"))
    outputRoot = ethers.solidityPackedKeccak256(
      ["uint64", "bytes32", "bytes32"],
      [100, stateRoot, blockHash],
    )
  })

  it("submitOutputRoot records the escrowed bond on the proposal", async function () {
    await manager.connect(proposer).submitOutputRoot(100, outputRoot, stateRoot, { value: PROPOSER_BOND })
    const proposal = await manager.getOutputProposal(100)
    expect(proposal.bond).to.equal(PROPOSER_BOND)
  })

  it("finalizeOutput refunds the escrowed bond even after PROPOSER_BOND is raised", async function () {
    await manager.connect(proposer).submitOutputRoot(100, outputRoot, stateRoot, { value: PROPOSER_BOND })

    // Simulate a post-deploy parameter retune (on prod: a UUPS upgrade):
    // the live global is now 3x the bond this proposal escrowed.
    await manager.setProposerBondForTest(RAISED_BOND)
    expect(await manager.PROPOSER_BOND()).to.equal(RAISED_BOND)

    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1])
    await ethers.provider.send("evm_mine", [])

    const before = await ethers.provider.getBalance(proposer.address)
    // Finalize from deployer so proposer's balance reflects only the refund.
    await manager.connect(deployer).finalizeOutput(100)
    const after = await ethers.provider.getBalance(proposer.address)

    // Must refund exactly what was posted (1 ETH), not the live 3 ETH.
    expect(after - before).to.equal(PROPOSER_BOND)
  })

  it("resolveChallenge slashes the escrowed bond even after PROPOSER_BOND is raised", async function () {
    await manager.connect(proposer).submitOutputRoot(100, outputRoot, stateRoot, { value: PROPOSER_BOND })
    await manager.connect(challenger).challengeOutputRoot(100, { value: CHALLENGER_BOND })

    await manager.setProposerBondForTest(RAISED_BOND)

    const challengerBefore = await ethers.provider.getBalance(challenger.address)
    const insuranceBefore = await ethers.provider.getBalance(insuranceFund.address)

    // Wrong state root => proposer at fault => slash the escrowed bond.
    const correctRoot = ethers.keccak256(ethers.toUtf8Bytes("correct-root"))
    await manager.connect(deployer).resolveChallenge(100, correctRoot)

    // Slash distribution is 30% challenger / 20% insurance of the ESCROWED
    // 1 ETH bond (challenger also gets its own 0.5 ETH bond back) — not of
    // the live 3 ETH global.
    const challengerAfter = await ethers.provider.getBalance(challenger.address)
    const insuranceAfter = await ethers.provider.getBalance(insuranceFund.address)
    expect(challengerAfter - challengerBefore).to.equal(
      CHALLENGER_BOND + (PROPOSER_BOND * 3000n) / 10000n,
    )
    expect(insuranceAfter - insuranceBefore).to.equal((PROPOSER_BOND * 2000n) / 10000n)
  })
})
