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

      const tx = await manager.openChallenge(commitHash, { value: ethers.parseEther("0.01") })
      const receipt = await tx.wait()
      const event = receipt.logs.find(l => {
        try { return manager.interface.parseLog(l)?.name === "ChallengeOpened" } catch { return false }
      })
      const challengeId = manager.interface.parseLog(event).args[0]

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

      const tx = await manager.openChallenge(commitHash, { value: ethers.parseEther("0.01") })
      const receipt = await tx.wait()
      const event = receipt.logs.find(l => {
        try { return manager.interface.parseLog(l)?.name === "ChallengeOpened" } catch { return false }
      })
      const challengeId = manager.interface.parseLog(event).args[0]

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
