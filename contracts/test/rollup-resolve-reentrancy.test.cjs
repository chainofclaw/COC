/**
 * Security regression: RollupStateManager.resolveChallenge must invalidate the
 * disputed output BEFORE paying out, so a reentrant finalizeOutput cannot
 * refund an at-fault proposer's bond.
 *
 * Bug: in the proposer-at-fault branch, `delete _outputs[l2BlockNumber]` ran
 * AFTER the `_safeTransfer` to the challenger. A malicious challenger contract
 * reentered `finalizeOutput()` during that payout — the output was still
 * present and the challenge already `resolved`, so finalizeOutput finalized it
 * and refunded `PROPOSER_BOND` to the faulty proposer. Net: the contract paid
 * out 1.5x PROPOSER_BOND for a dispute it only collected 1x for, draining
 * other participants' bonds.
 *
 * Fix: CEI — delete the output (and reset lastSubmittedBlock) before transfers.
 */
const { expect } = require("chai")
const { ethers } = require("hardhat")

const CHALLENGE_WINDOW = 1000
const PROPOSER_BOND = ethers.parseEther("1")
const CHALLENGER_BOND = ethers.parseEther("1")

describe("Security: RollupStateManager resolveChallenge reentrancy", function () {
  let manager, attacker
  let deployer, proposer, insuranceFund
  let badStateRoot, correctStateRoot, outputRoot

  beforeEach(async function () {
    ;[deployer, proposer, insuranceFund] = await ethers.getSigners()

    manager = await (await ethers.getContractFactory("RollupStateManager")).deploy(
      CHALLENGE_WINDOW,
      PROPOSER_BOND,
      CHALLENGER_BOND,
      insuranceFund.address,
      proposer.address,
    )
    await manager.waitForDeployment()

    attacker = await (await ethers.getContractFactory("RollupReentrancyAttacker")).deploy(
      await manager.getAddress(),
    )
    await attacker.waitForDeployment()

    // Pre-fund the manager with other participants' locked bonds.
    await deployer.sendTransaction({ to: await manager.getAddress(), value: ethers.parseEther("5") })

    badStateRoot = ethers.keccak256(ethers.toUtf8Bytes("wrong-state"))
    correctStateRoot = ethers.keccak256(ethers.toUtf8Bytes("correct-state"))
    outputRoot = ethers.keccak256(ethers.toUtf8Bytes("output"))
  })

  it("a faulty proposer's bond is not refunded via reentrant finalizeOutput", async function () {
    // Proposer submits a deliberately wrong output.
    await manager.connect(proposer).submitOutputRoot(100, outputRoot, badStateRoot, {
      value: PROPOSER_BOND,
    })
    // Malicious challenger contract challenges it.
    await attacker.challenge(100, { value: CHALLENGER_BOND })

    const proposerBefore = await ethers.provider.getBalance(proposer.address)

    // Honest resolver finds the proposer at fault (badStateRoot != correct).
    await manager.connect(deployer).resolveChallenge(100, correctStateRoot)

    // The attacker did attempt the reentrancy...
    expect(await attacker.reentered()).to.equal(true)
    // ...but the faulty proposer must NOT have been refunded PROPOSER_BOND.
    expect(await ethers.provider.getBalance(proposer.address)).to.equal(proposerBefore)
    // The disputed output is invalidated, not finalized.
    expect((await manager.getOutputProposal(100)).l1Timestamp).to.equal(0)
  })

  it("contract stays solvent — only the burned half is retained from the bond", async function () {
    await manager.connect(proposer).submitOutputRoot(100, outputRoot, badStateRoot, {
      value: PROPOSER_BOND,
    })
    await attacker.challenge(100, { value: CHALLENGER_BOND })
    await manager.connect(deployer).resolveChallenge(100, correctStateRoot)

    // In(7) = prefund 5 + PROPOSER_BOND 1 + CHALLENGER_BOND 1.
    // Out = challenger CB+0.3·PB, insurance 0.2·PB. Retained = prefund + 0.5·PB burn.
    const expected = ethers.parseEther("5") + (PROPOSER_BOND * 5000n) / 10000n
    expect(await ethers.provider.getBalance(await manager.getAddress())).to.equal(expected)
  })
})
