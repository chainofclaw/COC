/**
 * Security regression: EquivocationDetector must consume each distinct
 * equivocation exactly once.
 *
 * Bug: the contract gated repeat slashes only with a block-count cooldown.
 * The cooldown rate-limits but never *prevents* replay — the identical
 * evidence tuple (nodeId, phase, height, hashA, hashB) could be resubmitted
 * every cooldown window, slashing a validator 10% each time until its stake
 * is drained, all from a single past equivocation. (The NatSpec even claims
 * the cooldown "protects against the same evidence being replayed to drain a
 * single validator" — which it does not.)
 *
 * Fix: an order-independent `consumedEvidence` mark — one equivocation, one
 * slash, forever.
 */
const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

const MIN_STAKE = ethers.parseEther("32")

const bftMsg = (phase, height, blockHash) => `bft:${phase}:${height.toString()}:${blockHash}`

async function makeOperator(funder) {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider)
  const pubkey = wallet.signingKey.publicKey
  const nodeId = ethers.keccak256("0x" + pubkey.slice(4))
  await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther("33") })
  return { wallet, pubkey, nodeId }
}

async function deployStack() {
  const [owner] = await ethers.getSigners()
  const registry = await upgrades.deployProxy(
    await ethers.getContractFactory("ValidatorRegistry"),
    [owner.address, owner.address, owner.address],
    { initializer: "initialize", kind: "uups" },
  )
  await registry.waitForDeployment()
  const detector = await upgrades.deployProxy(
    await ethers.getContractFactory("EquivocationDetector"),
    [await registry.getAddress(), owner.address],
    { initializer: "initialize", kind: "uups" },
  )
  await detector.waitForDeployment()
  await registry.connect(owner).setSlasher(await detector.getAddress())
  return { registry, detector, owner }
}

describe("Security: EquivocationDetector evidence replay", function () {
  let registry, detector, owner, op
  const phase = "prepare"
  const height = 42n
  const hashA = ethers.keccak256(ethers.toUtf8Bytes("blockA"))
  const hashB = ethers.keccak256(ethers.toUtf8Bytes("blockB"))
  let sigA, sigB

  beforeEach(async function () {
    ;({ registry, detector, owner } = await deployStack())
    await detector.connect(owner).setSlashCooldown(1) // 1 block — fast test
    op = await makeOperator(owner)
    await registry.connect(op.wallet).stake(op.nodeId, op.pubkey, { value: MIN_STAKE })
    sigA = await op.wallet.signMessage(bftMsg(phase, height, hashA))
    sigB = await op.wallet.signMessage(bftMsg(phase, height, hashB))
  })

  it("the same equivocation evidence cannot be replayed after the cooldown", async function () {
    await detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB)
    const stakeAfterFirst = (await registry.getValidator(op.nodeId)).stake

    await ethers.provider.send("evm_mine", [])
    await ethers.provider.send("evm_mine", [])

    // Identical evidence must be rejected as already consumed — not slash again.
    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB),
    ).to.be.revertedWithCustomError(detector, "EvidenceAlreadyUsed")
    expect((await registry.getValidator(op.nodeId)).stake).to.equal(stakeAfterFirst)
  })

  it("evidence dedup is order-independent (swapping the hash pair is still the same proof)", async function () {
    await detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB)
    await ethers.provider.send("evm_mine", [])
    await ethers.provider.send("evm_mine", [])

    // Same equivocation, hashes swapped — must not mint a fresh slash.
    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hashB, sigB, hashA, sigA),
    ).to.be.revertedWithCustomError(detector, "EvidenceAlreadyUsed")
  })

  it("a genuinely distinct equivocation is still slashable", async function () {
    await detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB)
    await ethers.provider.send("evm_mine", [])
    await ethers.provider.send("evm_mine", [])

    // Different height — a separate offense — must still slash.
    const h2 = 99n
    const sA2 = await op.wallet.signMessage(bftMsg(phase, h2, hashA))
    const sB2 = await op.wallet.signMessage(bftMsg(phase, h2, hashB))
    await expect(
      detector.submitEvidence(op.nodeId, phase, h2, hashA, sA2, hashB, sB2),
    ).to.emit(detector, "EquivocationProven")
  })
})
