/**
 * Gas Benchmark Tests
 *
 * Validates that key operations stay within gas budget.
 * These tests run with gas reporting enabled to track gas usage over time.
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

describe("Gas Benchmarks: FactionRegistry", function () {
  let registry

  beforeEach(async function () {
    const FactionRegistry = await ethers.getContractFactory("FactionRegistry")
    registry = await FactionRegistry.deploy()
    await registry.waitForDeployment()
  })

  it("registerHuman gas < 100k", async function () {
    const [, user] = await ethers.getSigners()
    const tx = await registry.connect(user).registerHuman()
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(100000n)
  })

  it("registerClaw gas < 150k", async function () {
    const [, user] = await ethers.getSigners()
    const agentId = ethers.keccak256(ethers.toUtf8Bytes("agent-bench"))
    const messageHash = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "address"], [agentId, user.address])
    )
    const attestation = await user.signMessage(ethers.getBytes(messageHash))
    const tx = await registry.connect(user).registerClaw(agentId, attestation)
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(150000n)
  })

  it("verify gas < 80k", async function () {
    const [owner, user] = await ethers.getSigners()
    await registry.connect(user).registerHuman()
    const tx = await registry.connect(owner).verify(user.address)
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(80000n)
  })
})

describe("Gas Benchmarks: GovernanceDAO", function () {
  let dao, registry

  beforeEach(async function () {
    const FactionRegistry = await ethers.getContractFactory("FactionRegistry")
    registry = await FactionRegistry.deploy()
    await registry.waitForDeployment()

    const GovernanceDAO = await ethers.getContractFactory("GovernanceDAO")
    dao = await GovernanceDAO.deploy(await registry.getAddress())
    await dao.waitForDeployment()

    const [owner] = await ethers.getSigners()
    await registry.connect(owner).registerHuman()
  })

  it("createProposal gas < 250k", async function () {
    const tx = await dao.createProposal(
      0, // ValidatorAdd
      "Benchmark proposal",
      ethers.keccak256(ethers.toUtf8Bytes("description")),
      ethers.ZeroAddress,
      "0x",
      0
    )
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(250000n)
  })

  it("vote gas < 120k", async function () {
    await dao.createProposal(
      0,
      "Vote benchmark",
      ethers.keccak256(ethers.toUtf8Bytes("desc")),
      ethers.ZeroAddress,
      "0x",
      0
    )
    const tx = await dao.vote(1, 1) // 1 = For
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(120000n)
  })
})

describe("Gas Benchmarks: PoSeManager", function () {
  let manager, owner, operator

  beforeEach(async function () {
    const PoSeManager = await ethers.getContractFactory("PoSeManager")
    manager = await PoSeManager.deploy()
    await manager.waitForDeployment()

    const [signer] = await ethers.getSigners()
    owner = signer
    operator = ethers.Wallet.createRandom().connect(ethers.provider)
    await owner.sendTransaction({ to: operator.address, value: ethers.parseEther("5") })
  })

  it("registerNode gas < 400k", async function () {
    const pubkeyNode = operator.signingKey.publicKey
    const nodeId = ethers.keccak256(pubkeyNode)
    const bondRequired = await manager.requiredBond(operator.address)
    const serviceCommitment = ethers.keccak256(ethers.toUtf8Bytes("service:bench"))
    const endpointCommitment = ethers.keccak256(ethers.toUtf8Bytes("endpoint:bench"))
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("gas-bench"))
    const ownershipMessageHash = ethers.keccak256(
      ethers.solidityPacked(
        ["string", "bytes32", "address"],
        ["coc-register:", nodeId, operator.address]
      )
    )
    const ownershipSig = await operator.signMessage(ethers.getBytes(ownershipMessageHash))
    const tx = await manager.connect(operator).registerNode(
      nodeId, pubkeyNode, 0x07, serviceCommitment, endpointCommitment, metadataHash, ownershipSig,
      { value: bondRequired }
    )
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(400000n)
  })

  it("slash gas < 100k", async function () {
    const pubkeyNode = operator.signingKey.publicKey
    const nodeId = ethers.keccak256(pubkeyNode)
    const bondRequired = await manager.requiredBond(operator.address)
    const serviceCommitment = ethers.keccak256(ethers.toUtf8Bytes("service:slash-bench"))
    const endpointCommitment = ethers.keccak256(ethers.toUtf8Bytes("endpoint:slash-bench"))
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("slash-bench"))
    const ownershipMessageHash = ethers.keccak256(
      ethers.solidityPacked(
        ["string", "bytes32", "address"],
        ["coc-register:", nodeId, operator.address]
      )
    )
    const ownershipSig = await operator.signMessage(ethers.getBytes(ownershipMessageHash))
    await manager.connect(operator).registerNode(
      nodeId, pubkeyNode, 0x07, serviceCommitment, endpointCommitment, metadataHash, ownershipSig,
      { value: bondRequired }
    )

    const rawEvidence = ethers.toUtf8Bytes("evidence-bench")
    const evidenceHash = ethers.keccak256(rawEvidence)
    const tx = await manager.slash(nodeId, { nodeId, evidenceHash, reasonCode: 1, rawEvidence })
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(100000n)
  })
})

describe("Gas Benchmarks: Treasury", function () {
  let treasury

  beforeEach(async function () {
    const [owner] = await ethers.getSigners()
    const Treasury = await ethers.getContractFactory("Treasury")
    treasury = await Treasury.deploy(owner.address)
    await treasury.waitForDeployment()
  })

  it("deposit gas < 50k", async function () {
    const [owner] = await ethers.getSigners()
    const tx = await owner.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("1"),
    })
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(50000n)
  })

  it("withdraw gas < 60k", async function () {
    const [owner] = await ethers.getSigners()
    await owner.sendTransaction({
      to: await treasury.getAddress(),
      value: ethers.parseEther("1"),
    })
    const tx = await treasury.withdraw(owner.address, ethers.parseEther("0.5"), 1)
    const receipt = await tx.wait()
    expect(receipt.gasUsed).to.be.lessThan(60000n)
  })
})
