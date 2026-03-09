/**
 * PoSeManagerV2 Tests
 *
 * Covers:
 * - Node registration and active tracking
 * - initEpochNonce
 * - submitBatchV2 with sample proofs
 * - finalizeEpochV2 (including empty epoch)
 * - Merkle-claimable rewards (claim)
 * - Commit-reveal fault proof lifecycle (openChallenge → reveal → settle)
 * - Slash cap enforcement
 * - Bond mechanics
 * - Read helpers
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

// Register a node on PoSeManagerV2
async function registerNode(manager, funder, opts = {}) {
  const operator = ethers.Wallet.createRandom().connect(ethers.provider)
  await funder.sendTransaction({ to: operator.address, value: ethers.parseEther("5") })

  const pubkey = operator.signingKey.publicKey
  const nodeId = ethers.keccak256(pubkey)
  const serviceFlags = opts.serviceFlags ?? 7
  const serviceCommitment = opts.serviceCommitment ?? ethers.keccak256(ethers.toUtf8Bytes("svc"))
  const endpointCommitment = opts.endpointCommitment ?? ethers.keccak256(ethers.toUtf8Bytes(`ep-${Date.now()}-${Math.random()}`))
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("meta"))

  const messageHash = ethers.keccak256(
    ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId, operator.address])
  )
  const ownershipSig = await operator.signMessage(ethers.getBytes(messageHash))

  const bond = ethers.parseEther("0.1")
  await manager.connect(operator).registerNode(
    nodeId, pubkey, serviceFlags, serviceCommitment, endpointCommitment, metadataHash, ownershipSig, "0x",
    { value: bond }
  )

  return { operator, nodeId, pubkey }
}

// Build a simple merkle tree from leaves
function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, layers: [] }
  if (leaves.length === 1) {
    const root = pairHash(leaves[0], leaves[0])
    return { root, layers: [leaves, [root]] }
  }

  const layers = [leaves.slice()]
  while (layers[layers.length - 1].length > 1) {
    const layer = layers[layers.length - 1]
    const next = []
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]
      const right = layer[i + 1] ?? layer[i]
      next.push(pairHash(left, right))
    }
    layers.push(next)
  }
  return { root: layers[layers.length - 1][0], layers }
}

function buildMerkleProof(layers, index) {
  const proof = []
  let cursor = index
  for (let d = 0; d < layers.length - 1; d++) {
    const layer = layers[d]
    const siblingIndex = cursor % 2 === 0 ? cursor + 1 : cursor - 1
    const sibling = layer[siblingIndex] ?? layer[cursor]
    proof.push(sibling)
    cursor = Math.floor(cursor / 2)
  }
  return proof
}

function pairHash(a, b) {
  const [x, y] = a <= b ? [a, b] : [b, a]
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [x, y]))
}

async function submitSingleLeafBatchV2(manager, epochId, leafHash) {
  const sampleProofs = [{ leaf: leafHash, merkleProof: [leafHash], leafIndex: 0 }]
  const sampleCommitment = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [ethers.ZeroHash, 0, leafHash])
  )
  const summaryHash = ethers.keccak256(
    ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [epochId, pairHash(leafHash, leafHash), sampleCommitment, 1])
  )
  const tx = await manager.submitBatchV2(
    epochId,
    pairHash(leafHash, leafHash),
    summaryHash,
    sampleProofs,
    0,
    [],
  )
  const receipt = await tx.wait()
  const event = receipt.logs.find((l) => {
    try { return manager.interface.parseLog(l)?.name === "BatchSubmittedV2" } catch { return false }
  })
  return manager.interface.parseLog(event).args[1] // batchId
}

function hashEvidenceLeafV2(leaf) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["uint64", "bytes32", "bytes16", "bytes32", "uint64", "uint32", "uint8", "uint32"],
      [leaf.epoch, leaf.nodeId, leaf.nonce, leaf.tipHash, leaf.tipHeight, leaf.latencyMs, leaf.resultCode, leaf.witnessBitmap]
    )
  )
}

function encodeEvidenceData(batchId, merkleProof, leaf) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32[]", "tuple(uint64 epoch,bytes32 nodeId,bytes16 nonce,bytes32 tipHash,uint64 tipHeight,uint32 latencyMs,uint8 resultCode,uint32 witnessBitmap)"],
    [batchId, merkleProof, leaf]
  )
}

async function openChallengeAndGetId(manager, commitHash, bond) {
  const tx = await manager.openChallenge(commitHash, { value: bond })
  const receipt = await tx.wait()
  const event = receipt.logs.find((l) => {
    try { return manager.interface.parseLog(l)?.name === "ChallengeOpened" } catch { return false }
  })
  return manager.interface.parseLog(event).args[0]
}

describe("PoSeManagerV2", function () {
  let manager
  let deployer

  beforeEach(async function () {
    const signers = await ethers.getSigners()
    deployer = signers[0]

    const Factory = await ethers.getContractFactory("PoSeManagerV2")
    manager = await Factory.deploy()
    await manager.waitForDeployment()

    // Initialize with EIP-712 domain
    const chainId = (await ethers.provider.getNetwork()).chainId
    await manager.initialize(chainId, await manager.getAddress(), ethers.parseEther("0.01"))

    // Enable empty witness for most tests (strict mode tested separately)
    await manager.setAllowEmptyWitnessSubmission(true)
  })

  describe("Node registration", function () {
    it("registers a node and tracks it as active", async function () {
      const { nodeId } = await registerNode(manager, deployer)
      const node = await manager.getNode(nodeId)
      expect(node.active).to.equal(true)
      expect(await manager.getActiveNodeCount()).to.equal(1)
    })

    it("registers multiple nodes", async function () {
      await registerNode(manager, deployer)
      await registerNode(manager, deployer)
      await registerNode(manager, deployer)
      expect(await manager.getActiveNodeCount()).to.equal(3)
    })
  })

  describe("initEpochNonce", function () {
    it("stores a nonce for an epoch", async function () {
      await manager.initEpochNonce(1)
      const nonce = await manager.challengeNonces(1)
      // prevrandao is available in hardhat
      expect(nonce).to.not.equal(0)
    })

    it("reverts if nonce already set", async function () {
      await manager.initEpochNonce(5)
      await expect(manager.initEpochNonce(5)).to.be.revertedWithCustomError(manager, "EpochNonceAlreadySet")
    })
  })

  describe("submitBatchV2 witness mode", function () {
    it("reverts empty witness submissions when transition mode is disabled", async function () {
      await registerNode(manager, deployer)
      await manager.setAllowEmptyWitnessSubmission(false)
      const latestBlock = await ethers.provider.getBlock("latest")
      const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)
      const leafHash = ethers.keccak256(ethers.toUtf8Bytes("no-empty-witness"))

      await expect(
        submitSingleLeafBatchV2(manager, epochId, leafHash)
      ).to.be.revertedWithCustomError(manager, "InvalidWitnessQuorum")
    })
  })

  describe("finalizeEpochV2", function () {
    it("allows empty epoch finalization", async function () {
      // Advance time past dispute window (3 epochs = 3 hours)
      await ethers.provider.send("evm_increaseTime", [4 * 3600])
      await ethers.provider.send("evm_mine")

      const currentEpoch = Math.floor(Date.now() / (3600 * 1000))
      const pastEpoch = currentEpoch - 4

      const zeroRoot = ethers.ZeroHash
      await manager.finalizeEpochV2(pastEpoch, zeroRoot, 0, 0, 0)

      expect(await manager.epochFinalized(pastEpoch)).to.equal(true)
      expect(await manager.epochRewardRoots(pastEpoch)).to.equal(zeroRoot)
    })

    it("reverts if epoch already finalized", async function () {
      await ethers.provider.send("evm_increaseTime", [4 * 3600])
      await ethers.provider.send("evm_mine")
      const pastEpoch = 1

      await manager.finalizeEpochV2(pastEpoch, ethers.ZeroHash, 0, 0, 0)
      await expect(
        manager.finalizeEpochV2(pastEpoch, ethers.ZeroHash, 0, 0, 0)
      ).to.be.revertedWithCustomError(manager, "EpochAlreadyFinalized")
    })
  })

  describe("Merkle reward claim", function () {
    it("claim with valid proof succeeds", async function () {
      const { operator, nodeId } = await registerNode(manager, deployer)

      // Fund reward pool
      await manager.depositRewardPool({ value: ethers.parseEther("10") })

      // Advance time
      await ethers.provider.send("evm_increaseTime", [4 * 3600])
      await ethers.provider.send("evm_mine")

      const epochId = 1
      const amount = ethers.parseEther("1")

      // Build reward leaf: keccak256(abi.encodePacked(uint64 epochId, bytes32 nodeId, uint256 amount))
      const rewardLeaf = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "uint256"], [epochId, nodeId, amount])
      )

      // Single-leaf tree
      const root = pairHash(rewardLeaf, rewardLeaf)
      const proof = [rewardLeaf] // merkle proof for single leaf

      // Finalize with reward root
      await manager.finalizeEpochV2(epochId, root, amount, 0, 0)

      // Claim
      const balanceBefore = await ethers.provider.getBalance(operator.address)
      const tx = await manager.connect(operator).claim(epochId, nodeId, amount, proof)
      const receipt = await tx.wait()
      const gasUsed = receipt.gasUsed * receipt.gasPrice
      const balanceAfter = await ethers.provider.getBalance(operator.address)

      expect(balanceAfter + gasUsed - balanceBefore).to.be.closeTo(amount, ethers.parseEther("0.001"))
      expect(await manager.rewardClaimed(epochId, nodeId)).to.equal(true)
    })

    it("double claim reverts", async function () {
      const { operator, nodeId } = await registerNode(manager, deployer)
      await manager.depositRewardPool({ value: ethers.parseEther("10") })

      await ethers.provider.send("evm_increaseTime", [4 * 3600])
      await ethers.provider.send("evm_mine")

      const epochId = 2
      const amount = ethers.parseEther("0.5")
      const leaf = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "uint256"], [epochId, nodeId, amount])
      )
      const root = pairHash(leaf, leaf)

      await manager.finalizeEpochV2(epochId, root, amount, 0, 0)
      await manager.connect(operator).claim(epochId, nodeId, amount, [leaf])

      await expect(
        manager.connect(operator).claim(epochId, nodeId, amount, [leaf])
      ).to.be.revertedWithCustomError(manager, "AlreadyClaimed")
    })

    it("invalid proof reverts", async function () {
      const { operator, nodeId } = await registerNode(manager, deployer)
      await manager.depositRewardPool({ value: ethers.parseEther("10") })

      await ethers.provider.send("evm_increaseTime", [4 * 3600])
      await ethers.provider.send("evm_mine")

      const epochId = 3
      const amount = ethers.parseEther("1")
      const fakeRoot = ethers.keccak256(ethers.toUtf8Bytes("fake"))
      await manager.finalizeEpochV2(epochId, fakeRoot, amount, 0, 0)

      const wrongLeaf = ethers.keccak256(ethers.toUtf8Bytes("wrong"))
      await expect(
        manager.connect(operator).claim(epochId, nodeId, amount, [wrongLeaf])
      ).to.be.revertedWithCustomError(manager, "InvalidMerkleProof")
    })
  })

  describe("Commit-reveal fault proof", function () {
    it("full lifecycle: open → reveal → settle with valid fault", async function () {
      const { nodeId } = await registerNode(manager, deployer)

      // Set challenge bond min
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))

      const latestBlock = await ethers.provider.getBlock("latest")
      const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)

      // Build objective fault evidence leaf (resultCode=2 => InvalidSig)
      const targetNodeId = nodeId
      const faultType = 2
      const leaf = {
        epoch: epochId,
        nodeId: targetNodeId,
        nonce: "0x" + "11".repeat(16),
        tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip")),
        tipHeight: 100,
        latencyMs: 1200,
        resultCode: 2,
        witnessBitmap: 0,
      }
      const evidenceLeafHash = hashEvidenceLeafV2(leaf)
      const batchId = await submitSingleLeafBatchV2(manager, epochId, evidenceLeafHash)
      const evidenceData = encodeEvidenceData(batchId, [evidenceLeafHash], leaf)

      const salt = ethers.keccak256(ethers.toUtf8Bytes("salt"))
      const commitHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint8", "bytes32", "bytes32"],
          [targetNodeId, faultType, evidenceLeafHash, salt]
        )
      )

      const challengeId = await openChallengeAndGetId(manager, commitHash, ethers.parseEther("0.01"))

      const revealDigest = ethers.keccak256(
        ethers.solidityPacked(
          ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
          ["coc-fault:", challengeId, targetNodeId, faultType, evidenceLeafHash, salt, ethers.keccak256(evidenceData)]
        )
      )
      const challengerSig = await deployer.signMessage(ethers.getBytes(revealDigest))

      // Reveal
      await manager.revealChallenge(
        challengeId, targetNodeId, faultType, evidenceLeafHash, salt, evidenceData, challengerSig
      )

      const record = await manager.getChallenge(challengeId)
      expect(record.revealed).to.equal(true)
      expect(record.targetNodeId).to.equal(targetNodeId)

      // Advance time past adjudication window (reveal + 2 epochs = 4+ hours)
      await ethers.provider.send("evm_increaseTime", [5 * 3600])
      await ethers.provider.send("evm_mine")

      // Settle
      await manager.settleChallenge(challengeId)
      const settled = await manager.getChallenge(challengeId)
      expect(settled.settled).to.equal(true)
    })

    it("reverts when reusing the same fault evidence", async function () {
      const { nodeId } = await registerNode(manager, deployer)
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))

      const latestBlock = await ethers.provider.getBlock("latest")
      const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)
      const faultType = 2

      const leaf = {
        epoch: epochId,
        nodeId,
        nonce: "0x" + "33".repeat(16),
        tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-replay")),
        tipHeight: 321,
        latencyMs: 1800,
        resultCode: 2,
        witnessBitmap: 0,
      }
      const evidenceLeafHash = hashEvidenceLeafV2(leaf)
      const batchId = await submitSingleLeafBatchV2(manager, epochId, evidenceLeafHash)
      const evidenceData = encodeEvidenceData(batchId, [evidenceLeafHash], leaf)

      const saltA = ethers.keccak256(ethers.toUtf8Bytes("salt-a"))
      const commitA = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "uint8", "bytes32", "bytes32"], [nodeId, faultType, evidenceLeafHash, saltA])
      )
      const challengeA = await openChallengeAndGetId(manager, commitA, ethers.parseEther("0.01"))
      const digestA = ethers.keccak256(
        ethers.solidityPacked(
          ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
          ["coc-fault:", challengeA, nodeId, faultType, evidenceLeafHash, saltA, ethers.keccak256(evidenceData)]
        )
      )
      const sigA = await deployer.signMessage(ethers.getBytes(digestA))
      await manager.revealChallenge(challengeA, nodeId, faultType, evidenceLeafHash, saltA, evidenceData, sigA)

      const saltB = ethers.keccak256(ethers.toUtf8Bytes("salt-b"))
      const commitB = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "uint8", "bytes32", "bytes32"], [nodeId, faultType, evidenceLeafHash, saltB])
      )
      const challengeB = await openChallengeAndGetId(manager, commitB, ethers.parseEther("0.01"))
      const digestB = ethers.keccak256(
        ethers.solidityPacked(
          ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
          ["coc-fault:", challengeB, nodeId, faultType, evidenceLeafHash, saltB, ethers.keccak256(evidenceData)]
        )
      )
      const sigB = await deployer.signMessage(ethers.getBytes(digestB))

      await expect(
        manager.revealChallenge(challengeB, nodeId, faultType, evidenceLeafHash, saltB, evidenceData, sigB)
      ).to.be.revertedWithCustomError(manager, "InvalidFaultProof")
    })

    it("reverts when evidence leaf epoch mismatches batch epoch", async function () {
      const { nodeId } = await registerNode(manager, deployer)
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))

      const latestBlock = await ethers.provider.getBlock("latest")
      const batchEpoch = Math.floor(Number(latestBlock.timestamp) / 3600)
      const faultType = 2

      const leaf = {
        epoch: batchEpoch + 1,
        nodeId,
        nonce: "0x" + "66".repeat(16),
        tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-mismatch")),
        tipHeight: 777,
        latencyMs: 1300,
        resultCode: 2,
        witnessBitmap: 0,
      }
      const evidenceLeafHash = hashEvidenceLeafV2(leaf)
      const batchId = await submitSingleLeafBatchV2(manager, batchEpoch, evidenceLeafHash)
      const evidenceData = encodeEvidenceData(batchId, [evidenceLeafHash], leaf)
      const salt = ethers.keccak256(ethers.toUtf8Bytes("salt-mismatch"))
      const commitHash = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "uint8", "bytes32", "bytes32"], [nodeId, faultType, evidenceLeafHash, salt])
      )
      const challengeId = await openChallengeAndGetId(manager, commitHash, ethers.parseEther("0.01"))

      const digest = ethers.keccak256(
        ethers.solidityPacked(
          ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
          ["coc-fault:", challengeId, nodeId, faultType, evidenceLeafHash, salt, ethers.keccak256(evidenceData)]
        )
      )
      const challengerSig = await deployer.signMessage(ethers.getBytes(digest))

      await expect(
        manager.revealChallenge(challengeId, nodeId, faultType, evidenceLeafHash, salt, evidenceData, challengerSig)
      ).to.be.revertedWithCustomError(manager, "InvalidFaultProof")
    })

    it("reverts reveal when batch dispute window has elapsed", async function () {
      const { nodeId } = await registerNode(manager, deployer)
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))

      const latestBlock = await ethers.provider.getBlock("latest")
      const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)
      const faultType = 2
      const leaf = {
        epoch: epochId,
        nodeId,
        nonce: "0x" + "77".repeat(16),
        tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-expired")),
        tipHeight: 888,
        latencyMs: 1400,
        resultCode: 2,
        witnessBitmap: 0,
      }
      const evidenceLeafHash = hashEvidenceLeafV2(leaf)
      const batchId = await submitSingleLeafBatchV2(manager, epochId, evidenceLeafHash)
      const evidenceData = encodeEvidenceData(batchId, [evidenceLeafHash], leaf)

      await ethers.provider.send("evm_increaseTime", [3 * 3600])
      await ethers.provider.send("evm_mine")

      const salt = ethers.keccak256(ethers.toUtf8Bytes("salt-expired"))
      const commitHash = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "uint8", "bytes32", "bytes32"], [nodeId, faultType, evidenceLeafHash, salt])
      )
      const challengeId = await openChallengeAndGetId(manager, commitHash, ethers.parseEther("0.01"))
      const digest = ethers.keccak256(
        ethers.solidityPacked(
          ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
          ["coc-fault:", challengeId, nodeId, faultType, evidenceLeafHash, salt, ethers.keccak256(evidenceData)]
        )
      )
      const challengerSig = await deployer.signMessage(ethers.getBytes(digest))

      await expect(
        manager.revealChallenge(challengeId, nodeId, faultType, evidenceLeafHash, salt, evidenceData, challengerSig)
      ).to.be.revertedWithCustomError(manager, "InvalidFaultProof")
    })

    it("settles unrevealed challenge after reveal deadline to insurance", async function () {
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))
      const bond = ethers.parseEther("0.01")
      const challengeId = await openChallengeAndGetId(
        manager,
        ethers.keccak256(ethers.toUtf8Bytes("no-reveal")),
        bond,
      )

      await ethers.provider.send("evm_increaseTime", [3 * 3600])
      await ethers.provider.send("evm_mine")

      const insuranceBefore = await manager.insuranceBalance()
      await manager.settleChallenge(challengeId)
      const insuranceAfter = await manager.insuranceBalance()
      const record = await manager.getChallenge(challengeId)

      expect(record.settled).to.equal(true)
      expect(record.revealed).to.equal(false)
      expect(insuranceAfter - insuranceBefore).to.equal(bond)
    })

    it("caps slash by evidence epoch even when challenged in later epochs", async function () {
      const { nodeId } = await registerNode(manager, deployer)
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))

      const latestBlock = await ethers.provider.getBlock("latest")
      const evidenceEpoch = Math.floor(Number(latestBlock.timestamp) / 3600)
      const faultType = 2

      const leafA = {
        epoch: evidenceEpoch,
        nodeId,
        nonce: "0x" + "44".repeat(16),
        tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-a")),
        tipHeight: 500,
        latencyMs: 1000,
        resultCode: 2,
        witnessBitmap: 0,
      }
      const hashA = hashEvidenceLeafV2(leafA)
      const batchA = await submitSingleLeafBatchV2(manager, evidenceEpoch, hashA)
      const dataA = encodeEvidenceData(batchA, [hashA], leafA)

      const leafB = {
        epoch: evidenceEpoch,
        nodeId,
        nonce: "0x" + "55".repeat(16),
        tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-b")),
        tipHeight: 501,
        latencyMs: 1100,
        resultCode: 2,
        witnessBitmap: 0,
      }
      const hashB = hashEvidenceLeafV2(leafB)
      const batchB = await submitSingleLeafBatchV2(manager, evidenceEpoch, hashB)
      const dataB = encodeEvidenceData(batchB, [hashB], leafB)

      const saltA = ethers.keccak256(ethers.toUtf8Bytes("cap-a"))
      const commitA = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "uint8", "bytes32", "bytes32"], [nodeId, faultType, hashA, saltA])
      )
      const challengeA = await openChallengeAndGetId(manager, commitA, ethers.parseEther("0.01"))
      const digestA = ethers.keccak256(
        ethers.solidityPacked(
          ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
          ["coc-fault:", challengeA, nodeId, faultType, hashA, saltA, ethers.keccak256(dataA)]
        )
      )
      const sigA = await deployer.signMessage(ethers.getBytes(digestA))
      await manager.revealChallenge(challengeA, nodeId, faultType, hashA, saltA, dataA, sigA)

      // Move to a later challenge epoch while keeping reveal inside batch dispute window.
      await ethers.provider.send("evm_increaseTime", [1 * 3600])
      await ethers.provider.send("evm_mine")

      const saltB = ethers.keccak256(ethers.toUtf8Bytes("cap-b"))
      const commitB = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "uint8", "bytes32", "bytes32"], [nodeId, faultType, hashB, saltB])
      )
      const challengeB = await openChallengeAndGetId(manager, commitB, ethers.parseEther("0.01"))
      const digestB = ethers.keccak256(
        ethers.solidityPacked(
          ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
          ["coc-fault:", challengeB, nodeId, faultType, hashB, saltB, ethers.keccak256(dataB)]
        )
      )
      const sigB = await deployer.signMessage(ethers.getBytes(digestB))
      await manager.revealChallenge(challengeB, nodeId, faultType, hashB, saltB, dataB, sigB)

      await ethers.provider.send("evm_increaseTime", [5 * 3600])
      await ethers.provider.send("evm_mine")
      await manager.settleChallenge(challengeA)
      const afterFirst = await manager.getNode(nodeId)
      await manager.settleChallenge(challengeB)

      const afterSecond = await manager.getNode(nodeId)
      expect(afterSecond.bondAmount).to.equal(afterFirst.bondAmount)
    })

    it("bond too low reverts", async function () {
      await manager.setChallengeBondMin(ethers.parseEther("1"))
      const commitHash = ethers.keccak256(ethers.toUtf8Bytes("commit"))

      await expect(
        manager.openChallenge(commitHash, { value: ethers.parseEther("0.01") })
      ).to.be.revertedWithCustomError(manager, "BondTooLow")
    })

    it("reveal with wrong commit hash reverts", async function () {
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))
      const commitHash = ethers.keccak256(ethers.toUtf8Bytes("real-commit"))

      const tx = await manager.openChallenge(commitHash, { value: ethers.parseEther("0.01") })
      const receipt = await tx.wait()
      const event = receipt.logs.find(l => {
        try { return manager.interface.parseLog(l)?.name === "ChallengeOpened" } catch { return false }
      })
      const challengeId = manager.interface.parseLog(event).args[0]

      await expect(
        manager.revealChallenge(
          challengeId, ethers.ZeroHash, 1, ethers.ZeroHash, ethers.ZeroHash, "0x", "0x"
        )
      ).to.be.revertedWithCustomError(manager, "CommitHashMismatch")
    })

    it("settle before adjudication window reverts", async function () {
      const { nodeId } = await registerNode(manager, deployer)
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))
      const latestBlock = await ethers.provider.getBlock("latest")
      const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)

      const targetNode = nodeId
      const leaf = {
        epoch: epochId,
        nodeId: targetNode,
        nonce: "0x" + "22".repeat(16),
        tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-2")),
        tipHeight: 200,
        latencyMs: 2400,
        resultCode: 2,
        witnessBitmap: 0,
      }
      const evidenceHash = hashEvidenceLeafV2(leaf)
      const batchId = await submitSingleLeafBatchV2(manager, epochId, evidenceHash)
      const evidenceData = encodeEvidenceData(batchId, [evidenceHash], leaf)
      const salt = ethers.keccak256(ethers.toUtf8Bytes("s"))
      const faultType = 2
      const commitHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint8", "bytes32", "bytes32"],
          [targetNode, faultType, evidenceHash, salt]
        )
      )

      const challengeId = await openChallengeAndGetId(manager, commitHash, ethers.parseEther("0.01"))

      const revealDigest = ethers.keccak256(
        ethers.solidityPacked(
          ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
          ["coc-fault:", challengeId, targetNode, faultType, evidenceHash, salt, ethers.keccak256(evidenceData)]
        )
      )
      const challengerSig = await deployer.signMessage(ethers.getBytes(revealDigest))

      await manager.revealChallenge(challengeId, targetNode, faultType, evidenceHash, salt, evidenceData, challengerSig)

      await expect(
        manager.settleChallenge(challengeId)
      ).to.be.revertedWithCustomError(manager, "AdjudicationWindowNotElapsed")
    })
  })

  describe("Insurance and reward pool", function () {
    it("depositRewardPool increases balance", async function () {
      await manager.depositRewardPool({ value: ethers.parseEther("5") })
      expect(await manager.rewardPoolBalance()).to.equal(ethers.parseEther("5"))
    })

    it("depositInsurance increases insurance balance", async function () {
      await manager.depositInsurance({ value: ethers.parseEther("2") })
      expect(await manager.insuranceBalance()).to.equal(ethers.parseEther("2"))
    })
  })

  describe("Read helpers", function () {
    it("getNode returns registered node", async function () {
      const { nodeId } = await registerNode(manager, deployer)
      const node = await manager.getNode(nodeId)
      expect(node.nodeId).to.equal(nodeId)
      expect(node.active).to.equal(true)
    })

    it("getActiveNodeCount tracks nodes", async function () {
      expect(await manager.getActiveNodeCount()).to.equal(0)
      await registerNode(manager, deployer)
      expect(await manager.getActiveNodeCount()).to.equal(1)
      await registerNode(manager, deployer)
      expect(await manager.getActiveNodeCount()).to.equal(2)
    })

    it("getActiveNodeIds returns empty when offset >= length", async function () {
      await registerNode(manager, deployer)
      const result = await manager.getActiveNodeIds(100, 10)
      expect(result.length).to.equal(0)
    })

    it("getActiveNodeIds returns all nodes", async function () {
      const { nodeId: id1 } = await registerNode(manager, deployer)
      const { nodeId: id2 } = await registerNode(manager, deployer)
      const { nodeId: id3 } = await registerNode(manager, deployer)
      const result = await manager.getActiveNodeIds(0, 200)
      expect(result.length).to.equal(3)
      const resultSet = new Set(result.map(x => x.toLowerCase()))
      expect(resultSet.has(id1.toLowerCase())).to.equal(true)
      expect(resultSet.has(id2.toLowerCase())).to.equal(true)
      expect(resultSet.has(id3.toLowerCase())).to.equal(true)
    })

    it("getActiveNodeIds paginates with limit=1", async function () {
      await registerNode(manager, deployer)
      await registerNode(manager, deployer)
      await registerNode(manager, deployer)
      const page1 = await manager.getActiveNodeIds(0, 1)
      expect(page1.length).to.equal(1)
      const page2 = await manager.getActiveNodeIds(1, 1)
      expect(page2.length).to.equal(1)
      const page3 = await manager.getActiveNodeIds(2, 1)
      expect(page3.length).to.equal(1)
      const page4 = await manager.getActiveNodeIds(3, 1)
      expect(page4.length).to.equal(0)
      // All pages should return distinct nodes
      const allIds = new Set([...page1, ...page2, ...page3].map(x => x.toLowerCase()))
      expect(allIds.size).to.equal(3)
    })

    it("getActiveNodeIds clamps limit to 200", async function () {
      await registerNode(manager, deployer)
      // Requesting limit > 200 should still work (clamped)
      const result = await manager.getActiveNodeIds(0, 500)
      expect(result.length).to.equal(1)
    })

    it("getWitnessSet returns empty for no active nodes", async function () {
      await manager.initEpochNonce(10)
      const witnesses = await manager.getWitnessSet(10)
      expect(witnesses.length).to.equal(0)
    })

    it("getWitnessSet returns nodes when active", async function () {
      await registerNode(manager, deployer)
      await registerNode(manager, deployer)
      await registerNode(manager, deployer)
      await registerNode(manager, deployer)

      await manager.initEpochNonce(20)
      const witnesses = await manager.getWitnessSet(20)
      expect(witnesses.length).to.be.greaterThan(0)
      expect(witnesses.length).to.be.lessThanOrEqual(4)
    })
  })

  describe("Gas benchmarks", function () {
    it("initEpochNonce gas", async function () {
      const tx = await manager.initEpochNonce(100)
      const receipt = await tx.wait()
      console.log("    initEpochNonce gas:", receipt.gasUsed.toString())
    })

    it("registerNode gas", async function () {
      const operator = ethers.Wallet.createRandom().connect(ethers.provider)
      await deployer.sendTransaction({ to: operator.address, value: ethers.parseEther("5") })

      const pubkey = operator.signingKey.publicKey
      const nodeId = ethers.keccak256(pubkey)
      const messageHash = ethers.keccak256(
        ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId, operator.address])
      )
      const ownershipSig = await operator.signMessage(ethers.getBytes(messageHash))

      const tx = await manager.connect(operator).registerNode(
        nodeId, pubkey, 7,
        ethers.keccak256(ethers.toUtf8Bytes("svc")),
        ethers.keccak256(ethers.toUtf8Bytes(`ep-gas-${Date.now()}`)),
        ethers.keccak256(ethers.toUtf8Bytes("meta")),
        ownershipSig, "0x",
        { value: ethers.parseEther("0.1") }
      )
      const receipt = await tx.wait()
      console.log("    registerNode gas:", receipt.gasUsed.toString())
    })

    it("openChallenge gas", async function () {
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))
      const commitHash = ethers.keccak256(ethers.toUtf8Bytes("bench"))
      const tx = await manager.openChallenge(commitHash, { value: ethers.parseEther("0.01") })
      const receipt = await tx.wait()
      console.log("    openChallenge gas:", receipt.gasUsed.toString())
    })

    it("finalizeEpochV2 empty epoch gas", async function () {
      await ethers.provider.send("evm_increaseTime", [4 * 3600])
      await ethers.provider.send("evm_mine")
      const tx = await manager.finalizeEpochV2(0, ethers.ZeroHash, 0, 0, 0)
      const receipt = await tx.wait()
      console.log("    finalizeEpochV2 (empty) gas:", receipt.gasUsed.toString())
    })
  })
})
