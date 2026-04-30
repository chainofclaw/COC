/**
 * EquivocationDetector Test Suite
 *
 * Sprint I3 — Phase I deliverable per
 * /home/baominghao/.claude/plans/coc-evm-abstract-turtle.md.
 *
 * Covers:
 *   - submitEvidence happy path: legit two-signature evidence triggers slash
 *   - rejects equal hashes
 *   - rejects different signers
 *   - rejects invalid signature length
 *   - rejects signer that doesn't match nodeId trailer
 *   - cooldown blocks repeat slash within window
 *   - cooldown allows slash after window expires
 *   - owner ops: setSlashCooldown, transferOwnership
 *   - integration: detector wired as slasher, ValidatorRegistry executes slash
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

const MIN_STAKE = ethers.parseEther("32")
const SLASH_BPS = 1000n
const BPS_DENOM = 10_000n

// Match node/src/bft-coordinator.ts:bftCanonicalMessage exactly.
function bftCanonicalMessage(phase, height, blockHash) {
  return `bft:${phase}:${height.toString()}:${blockHash}`
}

async function makeOperator(funder, fundEth = 33n) {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider)
  const pubkey = wallet.signingKey.publicKey
  const xy = "0x" + pubkey.slice(4)
  const nodeId = ethers.keccak256(xy)
  await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther(String(fundEth)) })
  return { wallet, pubkey, nodeId }
}

async function deployStack() {
  const signers = await ethers.getSigners()
  const owner = signers[0]
  const RegistryFactory = await ethers.getContractFactory("ValidatorRegistry")
  const registry = await RegistryFactory.deploy()
  await registry.waitForDeployment()

  const DetectorFactory = await ethers.getContractFactory("EquivocationDetector")
  const detector = await DetectorFactory.deploy(await registry.getAddress())
  await detector.waitForDeployment()

  // Wire detector as the registry's slasher so it can call slashValidator.
  await registry.connect(owner).setSlasher(await detector.getAddress())

  return { registry, detector, owner, signers }
}

async function stakeValidator(registry, funder, fundEth = 33n) {
  const op = await makeOperator(funder, fundEth)
  await registry.connect(op.wallet).stake(op.nodeId, op.pubkey, { value: MIN_STAKE })
  return op
}

describe("EquivocationDetector: deployment", () => {
  it("constructor sets owner + cooldown defaults", async () => {
    const { detector, owner } = await deployStack()
    expect(await detector.owner()).to.equal(owner.address)
    expect(await detector.slashCooldownBlocks()).to.equal(1000n)
  })

  it("rejects zero-address registry in constructor", async () => {
    const Factory = await ethers.getContractFactory("EquivocationDetector")
    await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Factory,
      "ZeroAddress",
    )
  })
})

describe("EquivocationDetector: submitEvidence — happy path", () => {
  it("legit two-sig evidence triggers slash", async () => {
    const { registry, detector, owner } = await deployStack()
    const op = await stakeValidator(registry, owner)

    const stakeBefore = (await registry.getValidator(op.nodeId)).stake
    expect(stakeBefore).to.equal(MIN_STAKE)

    const phase = "prepare"
    const height = 42n
    const hashA = ethers.keccak256(ethers.toUtf8Bytes("blockA"))
    const hashB = ethers.keccak256(ethers.toUtf8Bytes("blockB"))
    const sigA = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    const sigB = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashB))

    const tx = await detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB)
    const receipt = await tx.wait()

    // EquivocationProven emitted by detector
    const proven = receipt.logs.find(
      (l) => l.fragment && l.fragment.name === "EquivocationProven",
    )
    expect(proven, "EquivocationProven event must fire").to.exist
    expect(proven.args[0]).to.equal(op.nodeId)
    expect(proven.args[1]).to.equal(op.wallet.address.toLowerCase() === op.wallet.address.toLowerCase()
      ? op.wallet.address
      : op.wallet.address)
    expect(proven.args[2]).to.equal(height)
    expect(proven.args[3]).to.equal(hashA)
    expect(proven.args[4]).to.equal(hashB)

    // Stake reduced by SLASH_BPS = 10%
    const stakeAfter = (await registry.getValidator(op.nodeId)).stake
    const expectedSlash = (MIN_STAKE * SLASH_BPS) / BPS_DENOM
    expect(stakeAfter).to.equal(MIN_STAKE - expectedSlash)

    // Validator deactivated by slash
    expect(await registry.isActive(op.nodeId)).to.equal(false)

    // Cooldown timestamp set
    expect(await detector.lastSlashedAtBlock(op.nodeId)).to.be.greaterThan(0n)
  })

  it("works for commit phase too", async () => {
    const { registry, detector, owner } = await deployStack()
    const op = await stakeValidator(registry, owner)
    const phase = "commit"
    const height = 100n
    const hashA = ethers.keccak256(ethers.toUtf8Bytes("commitA"))
    const hashB = ethers.keccak256(ethers.toUtf8Bytes("commitB"))
    const sigA = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    const sigB = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashB))

    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB),
    ).to.emit(detector, "EquivocationProven")
  })
})

describe("EquivocationDetector: submitEvidence — rejection paths", () => {
  it("reverts HashesEqual when hashA == hashB", async () => {
    const { registry, detector, owner } = await deployStack()
    const op = await stakeValidator(registry, owner)
    const phase = "prepare"
    const height = 42n
    const hash = ethers.keccak256(ethers.toUtf8Bytes("same"))
    const sig = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hash))

    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hash, sig, hash, sig),
    ).to.be.revertedWithCustomError(detector, "HashesEqual")
  })

  it("reverts InvalidPhase for unknown phase string", async () => {
    const { registry, detector, owner } = await deployStack()
    const op = await stakeValidator(registry, owner)
    const phase = "rogue"
    const height = 42n
    const hashA = ethers.keccak256(ethers.toUtf8Bytes("a"))
    const hashB = ethers.keccak256(ethers.toUtf8Bytes("b"))
    const sigA = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    const sigB = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashB))

    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB),
    ).to.be.revertedWithCustomError(detector, "InvalidPhase")
  })

  it("reverts SignersDiffer when signatures come from different wallets", async () => {
    const { registry, detector, owner } = await deployStack()
    const op = await stakeValidator(registry, owner)
    const otherWallet = ethers.Wallet.createRandom()
    const phase = "prepare"
    const height = 42n
    const hashA = ethers.keccak256(ethers.toUtf8Bytes("a"))
    const hashB = ethers.keccak256(ethers.toUtf8Bytes("b"))
    const sigA = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    // sigB is signed by a different wallet — recovers a different signer
    const sigB = await otherWallet.signMessage(bftCanonicalMessage(phase, height, hashB))

    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB),
    ).to.be.revertedWithCustomError(detector, "SignersDiffer")
  })

  it("reverts InvalidSignature on malformed sig length", async () => {
    const { registry, detector, owner } = await deployStack()
    const op = await stakeValidator(registry, owner)
    const phase = "prepare"
    const height = 42n
    const hashA = ethers.keccak256(ethers.toUtf8Bytes("a"))
    const hashB = ethers.keccak256(ethers.toUtf8Bytes("b"))
    const sigA = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    // Truncated signature
    const sigB = "0x1234"

    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB),
    ).to.be.revertedWithCustomError(detector, "InvalidSignature")
  })

  it("reverts SignerNotNodeIdTrailer when nodeId trailer != recovered signer", async () => {
    const { registry, detector, owner } = await deployStack()
    const op = await stakeValidator(registry, owner)
    // Mangle the trailing 20 bytes of nodeId to point at a different address.
    const lyingNodeId = "0x" + op.nodeId.slice(2, 26) + "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    const phase = "prepare"
    const height = 42n
    const hashA = ethers.keccak256(ethers.toUtf8Bytes("a"))
    const hashB = ethers.keccak256(ethers.toUtf8Bytes("b"))
    const sigA = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    const sigB = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashB))

    await expect(
      detector.submitEvidence(lyingNodeId, phase, height, hashA, sigA, hashB, sigB),
    ).to.be.revertedWithCustomError(detector, "SignerNotNodeIdTrailer")
  })
})

describe("EquivocationDetector: cooldown", () => {
  it("reverts CooldownActive on repeat slash within window", async () => {
    const { registry, detector, owner } = await deployStack()
    const op = await stakeValidator(registry, owner)
    const phase = "prepare"
    const height = 42n
    const hashA = ethers.keccak256(ethers.toUtf8Bytes("a"))
    const hashB = ethers.keccak256(ethers.toUtf8Bytes("b"))
    const hashC = ethers.keccak256(ethers.toUtf8Bytes("c"))
    const sigA = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    const sigB = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashB))
    const sigC = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashC))

    // First slash succeeds
    await detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB)

    // Immediately retrying with different sig pair must hit cooldown
    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashC, sigC),
    ).to.be.revertedWithCustomError(detector, "CooldownActive")
  })

  it("allows slash again after cooldown expires", async () => {
    const { registry, detector, owner } = await deployStack()
    // Lower cooldown to 1 block for fast test
    await detector.connect(owner).setSlashCooldown(1)

    const op = await stakeValidator(registry, owner, 100n)
    // Re-stake after 1st slash to make 2nd slash visible. Actually 2nd slash
    // works on the same nodeId regardless of active state — slashValidator
    // just decrements stake. We just need stake > 0.
    const phase = "prepare"
    const height = 42n
    const hashA = ethers.keccak256(ethers.toUtf8Bytes("a"))
    const hashB = ethers.keccak256(ethers.toUtf8Bytes("b"))
    const hashC = ethers.keccak256(ethers.toUtf8Bytes("c"))
    const sigA = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashA))
    const sigB = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashB))
    const sigC = await op.wallet.signMessage(bftCanonicalMessage(phase, height, hashC))

    await detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashB, sigB)
    // Mine 2 blocks to cross cooldown=1
    await ethers.provider.send("evm_mine", [])
    await ethers.provider.send("evm_mine", [])

    await expect(
      detector.submitEvidence(op.nodeId, phase, height, hashA, sigA, hashC, sigC),
    ).to.emit(detector, "EquivocationProven")
  })
})

describe("EquivocationDetector: owner ops", () => {
  it("setSlashCooldown updates value", async () => {
    const { detector, owner } = await deployStack()
    await expect(detector.connect(owner).setSlashCooldown(500))
      .to.emit(detector, "SlashCooldownUpdated")
      .withArgs(1000n, 500n)
    expect(await detector.slashCooldownBlocks()).to.equal(500n)
  })

  it("setSlashCooldown reverts for non-owner", async () => {
    const { detector, signers } = await deployStack()
    await expect(detector.connect(signers[1]).setSlashCooldown(500))
      .to.be.revertedWithCustomError(detector, "OnlyOwner")
  })

  it("transferOwnership moves owner role", async () => {
    const { detector, owner, signers } = await deployStack()
    const newOwner = signers[1]
    await expect(detector.connect(owner).transferOwnership(newOwner.address))
      .to.emit(detector, "OwnerUpdated")
      .withArgs(owner.address, newOwner.address)
    expect(await detector.owner()).to.equal(newOwner.address)

    // old owner can no longer change cooldown
    await expect(detector.connect(owner).setSlashCooldown(123))
      .to.be.revertedWithCustomError(detector, "OnlyOwner")
  })

  it("transferOwnership rejects zero address", async () => {
    const { detector, owner } = await deployStack()
    await expect(detector.connect(owner).transferOwnership(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(detector, "ZeroAddress")
  })
})
