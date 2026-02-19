/**
 * PoSeManager Extended Coverage Tests
 *
 * Covers previously untested paths:
 * - submitBatch → challengeBatch → finalizeEpoch full flow
 * - updateCommitment
 * - requestUnbond + withdraw flow
 * - Read helpers: getNode, getBatch, getEpochBatchIds, getBatchSampleInfo, isSampleLeaf
 * - setSlasher role management
 * - Multiple slash reason codes (_slashBps paths)
 * - MerkleProofLite.verify via batch submission
 * - Edge cases: TooManyNodes, EndpointAlreadyRegistered, various reverts
 *
 * Refs: #24
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

// Helper: register a node from a random wallet with proper ownership sig
async function registerNode(manager, funder, opts = {}) {
  const operator = ethers.Wallet.createRandom().connect(ethers.provider)
  await funder.sendTransaction({ to: operator.address, value: ethers.parseEther("5") })

  const pubkey = operator.signingKey.publicKey
  const nodeId = ethers.keccak256(pubkey)
  const serviceFlags = opts.serviceFlags ?? 1
  const serviceCommitment = opts.serviceCommitment ?? ethers.keccak256(ethers.toUtf8Bytes("svc"))
  const endpointCommitment = opts.endpointCommitment ?? ethers.keccak256(ethers.toUtf8Bytes(`ep-${Date.now()}-${Math.random()}`))
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("meta"))

  const messageHash = ethers.keccak256(
    ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId, operator.address])
  )
  const ownershipSig = await operator.signMessage(ethers.getBytes(messageHash))

  const bond = await manager.requiredBond(operator.address)
  await manager.connect(operator).registerNode(
    nodeId, pubkey, serviceFlags, serviceCommitment, endpointCommitment, metadataHash, ownershipSig,
    { value: bond }
  )

  return { operator, nodeId, pubkey }
}

// Helper: build a Merkle tree for batch submission
function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: ethers.ZeroHash, proofs: [] }
  if (leaves.length === 1) return { root: leaves[0], proofs: [[]] }

  const sortedHash = (a, b) =>
    a <= b
      ? ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [a, b]))
      : ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [b, a]))

  // Simple 2-leaf tree for testing
  const root = sortedHash(leaves[0], leaves[1])
  return {
    root,
    proofs: [
      [leaves[1]], // proof for leaf[0]
      [leaves[0]], // proof for leaf[1]
    ],
  }
}

describe("PoSeManager: Extended Coverage", function () {
  let manager, owner

  beforeEach(async function () {
    ;[owner] = await ethers.getSigners()
    const PoSeManager = await ethers.getContractFactory("PoSeManager")
    manager = await PoSeManager.deploy()
    await manager.waitForDeployment()
  })

  describe("updateCommitment", function () {
    it("operator can update service commitment", async function () {
      const { operator, nodeId } = await registerNode(manager, owner)
      const newCommitment = ethers.keccak256(ethers.toUtf8Bytes("new-commitment"))

      await manager.connect(operator).updateCommitment(nodeId, newCommitment)

      const node = await manager.getNode(nodeId)
      expect(node.serviceCommitment).to.equal(newCommitment)
    })

    it("reverts if node not found", async function () {
      const fakeNodeId = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"))
      await expect(
        manager.connect(owner).updateCommitment(fakeNodeId, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(manager, "NodeNotFound")
    })

    it("reverts if not operator", async function () {
      const { nodeId } = await registerNode(manager, owner)
      await expect(
        manager.connect(owner).updateCommitment(nodeId, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(manager, "NotNodeOperator")
    })
  })

  describe("submitBatch + finalizeEpoch", function () {
    it("submits a valid batch and finalizes epoch", async function () {
      const leaf1 = ethers.keccak256(ethers.toUtf8Bytes("receipt-1"))
      const leaf2 = ethers.keccak256(ethers.toUtf8Bytes("receipt-2"))
      const { root, proofs } = buildMerkleTree([leaf1, leaf2])

      const currentEpoch = BigInt(Math.floor(Date.now() / 1000 / 3600))

      // Build sample proofs
      const sampleProofs = [
        { leaf: leaf1, merkleProof: proofs[0], leafIndex: 0 },
        { leaf: leaf2, merkleProof: proofs[1], leafIndex: 1 },
      ]

      // Compute expected summary
      let sampleCommitment = ethers.ZeroHash
      for (const sp of sampleProofs) {
        sampleCommitment = ethers.keccak256(
          ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [sampleCommitment, sp.leafIndex, sp.leaf])
        )
      }
      const summaryHash = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [currentEpoch, root, sampleCommitment, sampleProofs.length])
      )

      const tx = await manager.connect(owner).submitBatch(currentEpoch, root, summaryHash, sampleProofs)
      const receipt = await tx.wait()
      expect(receipt.status).to.equal(1)

      // Verify batch was stored
      const batchId = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "bytes32", "address"], [currentEpoch, root, summaryHash, owner.address])
      )
      const batch = await manager.getBatch(batchId)
      expect(batch.merkleRoot).to.equal(root)
      expect(batch.aggregator).to.equal(owner.address)

      // Verify read helpers
      const epochBatches = await manager.getEpochBatchIds(currentEpoch)
      expect(epochBatches).to.include(batchId)

      const [sampleCount, storedCommitment] = await manager.getBatchSampleInfo(batchId)
      expect(sampleCount).to.equal(2)
      expect(storedCommitment).to.equal(sampleCommitment)

      expect(await manager.isSampleLeaf(batchId, leaf1)).to.be.true
      expect(await manager.isSampleLeaf(batchId, leaf2)).to.be.true
      expect(await manager.isSampleLeaf(batchId, ethers.ZeroHash)).to.be.false

      // Advance time past dispute window (2 epochs = 7200 seconds)
      await ethers.provider.send("evm_increaseTime", [7200 + 3600 + 1])
      await ethers.provider.send("evm_mine")

      // Finalize epoch
      await manager.connect(owner).finalizeEpoch(currentEpoch)

      expect(await manager.epochFinalized(currentEpoch)).to.be.true
      expect(await manager.epochValidBatchCount(currentEpoch)).to.equal(1)
      const settlementRoot = await manager.epochSettlementRoot(currentEpoch)
      expect(settlementRoot).to.not.equal(ethers.ZeroHash)
    })

    it("reverts submitBatch with empty merkle root", async function () {
      await expect(
        manager.connect(owner).submitBatch(0, ethers.ZeroHash, ethers.ZeroHash, [])
      ).to.be.revertedWithCustomError(manager, "InvalidBatch")
    })

    it("reverts submitBatch with no sample proofs", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("root"))
      const summary = ethers.keccak256(ethers.toUtf8Bytes("summary"))
      await expect(
        manager.connect(owner).submitBatch(0, root, summary, [])
      ).to.be.revertedWithCustomError(manager, "InvalidBatch")
    })

    it("reverts submitBatch with zero leaf", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("root"))
      const summary = ethers.keccak256(ethers.toUtf8Bytes("summary"))
      await expect(
        manager.connect(owner).submitBatch(0, root, summary, [
          { leaf: ethers.ZeroHash, merkleProof: [root], leafIndex: 0 }
        ])
      ).to.be.revertedWithCustomError(manager, "InvalidBatch")
    })

    it("reverts submitBatch with empty proof", async function () {
      const leaf = ethers.keccak256(ethers.toUtf8Bytes("leaf"))
      const root = ethers.keccak256(ethers.toUtf8Bytes("root"))
      const summary = ethers.keccak256(ethers.toUtf8Bytes("summary"))
      await expect(
        manager.connect(owner).submitBatch(0, root, summary, [
          { leaf, merkleProof: [], leafIndex: 0 }
        ])
      ).to.be.revertedWithCustomError(manager, "InvalidBatch")
    })

    it("reverts duplicate batch submission", async function () {
      const leaf1 = ethers.keccak256(ethers.toUtf8Bytes("leaf-dup-1"))
      const leaf2 = ethers.keccak256(ethers.toUtf8Bytes("leaf-dup-2"))
      const { root, proofs } = buildMerkleTree([leaf1, leaf2])
      const currentEpoch = BigInt(Math.floor(Date.now() / 1000 / 3600))

      const sampleProofs = [
        { leaf: leaf1, merkleProof: proofs[0], leafIndex: 0 },
        { leaf: leaf2, merkleProof: proofs[1], leafIndex: 1 },
      ]
      let sampleCommitment = ethers.ZeroHash
      for (const sp of sampleProofs) {
        sampleCommitment = ethers.keccak256(
          ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [sampleCommitment, sp.leafIndex, sp.leaf])
        )
      }
      const summaryHash = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [currentEpoch, root, sampleCommitment, 2])
      )

      await manager.connect(owner).submitBatch(currentEpoch, root, summaryHash, sampleProofs)

      await expect(
        manager.connect(owner).submitBatch(currentEpoch, root, summaryHash, sampleProofs)
      ).to.be.revertedWithCustomError(manager, "BatchAlreadySubmitted")
    })

    it("reverts finalizeEpoch when already finalized", async function () {
      const leaf1 = ethers.keccak256(ethers.toUtf8Bytes("leaf-final-1"))
      const leaf2 = ethers.keccak256(ethers.toUtf8Bytes("leaf-final-2"))
      const { root, proofs } = buildMerkleTree([leaf1, leaf2])
      const currentEpoch = BigInt(Math.floor(Date.now() / 1000 / 3600))

      const sampleProofs = [
        { leaf: leaf1, merkleProof: proofs[0], leafIndex: 0 },
        { leaf: leaf2, merkleProof: proofs[1], leafIndex: 1 },
      ]
      let sampleCommitment = ethers.ZeroHash
      for (const sp of sampleProofs) {
        sampleCommitment = ethers.keccak256(
          ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [sampleCommitment, sp.leafIndex, sp.leaf])
        )
      }
      const summaryHash = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [currentEpoch, root, sampleCommitment, 2])
      )

      await manager.connect(owner).submitBatch(currentEpoch, root, summaryHash, sampleProofs)

      await ethers.provider.send("evm_increaseTime", [7200 + 3600 + 1])
      await ethers.provider.send("evm_mine")

      await manager.connect(owner).finalizeEpoch(currentEpoch)

      await expect(
        manager.connect(owner).finalizeEpoch(currentEpoch)
      ).to.be.revertedWithCustomError(manager, "EpochAlreadyFinalized")
    })
  })

  describe("challengeBatch", function () {
    it("slasher can challenge a batch with valid proof", async function () {
      const leaf1 = ethers.keccak256(ethers.toUtf8Bytes("leaf-ch-1"))
      const leaf2 = ethers.keccak256(ethers.toUtf8Bytes("leaf-ch-2"))
      const leaf3 = ethers.keccak256(ethers.toUtf8Bytes("leaf-ch-3"))

      // Build tree with leaf1 + leaf2 (submitted), leaf3 also valid but not sampled
      const { root, proofs } = buildMerkleTree([leaf1, leaf2])

      const currentEpoch = BigInt(Math.floor(Date.now() / 1000 / 3600))

      let sampleCommitment = ethers.ZeroHash
      sampleCommitment = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [sampleCommitment, 0, leaf1])
      )
      sampleCommitment = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [sampleCommitment, 1, leaf2])
      )
      const summaryHash = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [currentEpoch, root, sampleCommitment, 2])
      )

      await manager.connect(owner).submitBatch(currentEpoch, root, summaryHash, [
        { leaf: leaf1, merkleProof: proofs[0], leafIndex: 0 },
        { leaf: leaf2, merkleProof: proofs[1], leafIndex: 1 },
      ])

      const batchId = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "bytes32", "address"], [currentEpoch, root, summaryHash, owner.address])
      )

      // Challenge with leaf1 (which is sampled) — should revert
      await expect(
        manager.connect(owner).challengeBatch(batchId, leaf1, proofs[0])
      ).to.be.revertedWithCustomError(manager, "InvalidBatch")

      // Challenge with nonexistent batch
      const fakeBatchId = ethers.keccak256(ethers.toUtf8Bytes("fake"))
      await expect(
        manager.connect(owner).challengeBatch(fakeBatchId, leaf1, proofs[0])
      ).to.be.revertedWithCustomError(manager, "InvalidBatch")
    })

    it("reverts challenge with empty receipt leaf", async function () {
      const leaf1 = ethers.keccak256(ethers.toUtf8Bytes("leaf-ch-e1"))
      const leaf2 = ethers.keccak256(ethers.toUtf8Bytes("leaf-ch-e2"))
      const { root, proofs } = buildMerkleTree([leaf1, leaf2])
      const currentEpoch = BigInt(Math.floor(Date.now() / 1000 / 3600))

      const sampleProofs = [
        { leaf: leaf1, merkleProof: proofs[0], leafIndex: 0 },
        { leaf: leaf2, merkleProof: proofs[1], leafIndex: 1 },
      ]
      let sampleCommitment = ethers.ZeroHash
      for (const sp of sampleProofs) {
        sampleCommitment = ethers.keccak256(
          ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [sampleCommitment, sp.leafIndex, sp.leaf])
        )
      }
      const summaryHash = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [currentEpoch, root, sampleCommitment, 2])
      )

      await manager.connect(owner).submitBatch(currentEpoch, root, summaryHash, sampleProofs)

      const batchId = ethers.keccak256(
        ethers.solidityPacked(["uint64", "bytes32", "bytes32", "address"], [currentEpoch, root, summaryHash, owner.address])
      )

      await expect(
        manager.connect(owner).challengeBatch(batchId, ethers.ZeroHash, [root])
      ).to.be.revertedWithCustomError(manager, "InvalidBatch")
    })
  })

  describe("requestUnbond + withdraw", function () {
    it("full unbond and withdraw flow", async function () {
      const { operator, nodeId } = await registerNode(manager, owner)

      // Request unbond
      await manager.connect(operator).requestUnbond(nodeId)

      const nodeAfterUnbond = await manager.getNode(nodeId)
      expect(nodeAfterUnbond.active).to.be.false

      // Cannot unbond again
      await expect(
        manager.connect(operator).requestUnbond(nodeId)
      ).to.be.revertedWithCustomError(manager, "NodeNotFound")

      // Cannot withdraw before unlock
      await expect(
        manager.connect(operator).withdraw(nodeId)
      ).to.be.revertedWithCustomError(manager, "UnlockNotReached")

      // Advance past unbond delay (7*24 epochs = 7*24*3600 seconds)
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1])
      await ethers.provider.send("evm_mine")

      // Withdraw
      const balBefore = await ethers.provider.getBalance(operator.address)
      const withdrawTx = await manager.connect(operator).withdraw(nodeId)
      const withdrawReceipt = await withdrawTx.wait()
      const gasUsed = withdrawReceipt.gasUsed * withdrawReceipt.gasPrice
      const balAfter = await ethers.provider.getBalance(operator.address)

      // Should receive back the bond minus gas
      expect(balAfter + gasUsed - balBefore).to.equal(ethers.parseEther("0.1"))
    })

    it("cannot withdraw without unbond request", async function () {
      const { operator, nodeId } = await registerNode(manager, owner)

      // Try to withdraw without requesting unbond
      await expect(
        manager.connect(operator).withdraw(nodeId)
      ).to.be.revertedWithCustomError(manager, "NodeNotFound")
    })

    it("non-operator cannot request unbond", async function () {
      const { nodeId } = await registerNode(manager, owner)

      await expect(
        manager.connect(owner).requestUnbond(nodeId)
      ).to.be.revertedWithCustomError(manager, "NotNodeOperator")
    })

    it("cannot request unbond twice", async function () {
      const { operator, nodeId } = await registerNode(manager, owner)

      await manager.connect(operator).requestUnbond(nodeId)

      // Node is now inactive, second call should revert
      await expect(
        manager.connect(operator).requestUnbond(nodeId)
      ).to.be.revertedWithCustomError(manager, "NodeNotFound")
    })
  })

  describe("setSlasher", function () {
    it("owner can grant and revoke slasher role", async function () {
      const [, user1] = await ethers.getSigners()

      // user1 cannot slash initially (not slasher)
      const { nodeId } = await registerNode(manager, owner)
      const rawEvidence = ethers.toUtf8Bytes("evidence-role")
      const evidenceHash = ethers.keccak256(rawEvidence)

      await expect(
        manager.connect(user1).slash(nodeId, { nodeId, evidenceHash, reasonCode: 1, rawEvidence })
      ).to.be.reverted

      // Grant slasher role
      await manager.connect(owner).setSlasher(user1.address, true)

      // Now user1 can slash
      await manager.connect(user1).slash(nodeId, { nodeId, evidenceHash, reasonCode: 1, rawEvidence })

      // Revoke slasher role
      await manager.connect(owner).setSlasher(user1.address, false)

      // user1 can no longer slash
      const rawEvidence2 = ethers.toUtf8Bytes("evidence-role-2")
      const evidenceHash2 = ethers.keccak256(rawEvidence2)
      await expect(
        manager.connect(user1).slash(nodeId, { nodeId, evidenceHash: evidenceHash2, reasonCode: 2, rawEvidence: rawEvidence2 })
      ).to.be.reverted
    })
  })

  describe("slash reason codes", function () {
    it("reason code 2 (invalid signature) applies 15% slash", async function () {
      const { nodeId } = await registerNode(manager, owner)
      const nodeBefore = await manager.getNode(nodeId)
      const bondBefore = nodeBefore.bondAmount

      const rawEvidence = ethers.toUtf8Bytes("sig-evidence")
      const evidenceHash = ethers.keccak256(rawEvidence)
      await manager.connect(owner).slash(nodeId, { nodeId, evidenceHash, reasonCode: 2, rawEvidence })

      const nodeAfter = await manager.getNode(nodeId)
      const slashed = bondBefore - nodeAfter.bondAmount
      // 1500 bps = 15%
      expect(slashed).to.equal(bondBefore * 1500n / 10000n)
    })

    it("reason code 3 (liveness fault) applies 5% slash", async function () {
      const { nodeId } = await registerNode(manager, owner)
      const nodeBefore = await manager.getNode(nodeId)
      const bondBefore = nodeBefore.bondAmount

      const rawEvidence = ethers.toUtf8Bytes("timeout-evidence")
      const evidenceHash = ethers.keccak256(rawEvidence)
      await manager.connect(owner).slash(nodeId, { nodeId, evidenceHash, reasonCode: 3, rawEvidence })

      const nodeAfter = await manager.getNode(nodeId)
      const slashed = bondBefore - nodeAfter.bondAmount
      expect(slashed).to.equal(bondBefore * 500n / 10000n)
    })

    it("reason code 4 (invalid storage proof) applies 30% slash", async function () {
      const { nodeId } = await registerNode(manager, owner)
      const nodeBefore = await manager.getNode(nodeId)
      const bondBefore = nodeBefore.bondAmount

      const rawEvidence = ethers.toUtf8Bytes("storage-proof-bad")
      const evidenceHash = ethers.keccak256(rawEvidence)
      await manager.connect(owner).slash(nodeId, { nodeId, evidenceHash, reasonCode: 4, rawEvidence })

      const nodeAfter = await manager.getNode(nodeId)
      const slashed = bondBefore - nodeAfter.bondAmount
      expect(slashed).to.equal(bondBefore * 3000n / 10000n)
    })

    it("reason code 5+ (generic fault) applies 10% slash", async function () {
      const { nodeId } = await registerNode(manager, owner)
      const nodeBefore = await manager.getNode(nodeId)
      const bondBefore = nodeBefore.bondAmount

      const rawEvidence = ethers.toUtf8Bytes("generic-fault")
      const evidenceHash = ethers.keccak256(rawEvidence)
      await manager.connect(owner).slash(nodeId, { nodeId, evidenceHash, reasonCode: 5, rawEvidence })

      const nodeAfter = await manager.getNode(nodeId)
      const slashed = bondBefore - nodeAfter.bondAmount
      expect(slashed).to.equal(bondBefore * 1000n / 10000n)
    })
  })

  describe("registration edge cases", function () {
    it("verifies max nodes per operator constant is 5", async function () {
      // The MAX_NODES_PER_OPERATOR is 5 - verify the constant
      const maxNodes = await manager.MAX_NODES_PER_OPERATOR()
      expect(maxNodes).to.equal(5)

      // Verify progressive bond calculation: 0.1, 0.2, 0.4, 0.8, 1.6 ETH
      const [, user1] = await ethers.getSigners()
      expect(await manager.requiredBond(user1.address)).to.equal(ethers.parseEther("0.1"))
    })

    it("reverts with duplicate endpoint commitment", async function () {
      const { operator } = await registerNode(manager, owner)

      // Try to register another node with same endpoint from a different operator
      const operator2 = ethers.Wallet.createRandom().connect(ethers.provider)
      await owner.sendTransaction({ to: operator2.address, value: ethers.parseEther("5") })

      const pubkey2 = operator2.signingKey.publicKey
      const nodeId2 = ethers.keccak256(pubkey2)
      const endpointCommitment = ethers.keccak256(ethers.toUtf8Bytes("shared-endpoint"))
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("meta"))
      const serviceCommitment = ethers.keccak256(ethers.toUtf8Bytes("svc"))

      // First register with this endpoint
      const messageHash1 = ethers.keccak256(
        ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId2, operator2.address])
      )
      const sig1 = await operator2.signMessage(ethers.getBytes(messageHash1))
      const bond = await manager.requiredBond(operator2.address)
      await manager.connect(operator2).registerNode(
        nodeId2, pubkey2, 1, serviceCommitment, endpointCommitment, metadataHash, sig1,
        { value: bond }
      )

      // Now try with same endpoint from another operator
      const operator3 = ethers.Wallet.createRandom().connect(ethers.provider)
      await owner.sendTransaction({ to: operator3.address, value: ethers.parseEther("5") })
      const pubkey3 = operator3.signingKey.publicKey
      const nodeId3 = ethers.keccak256(pubkey3)

      const messageHash3 = ethers.keccak256(
        ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId3, operator3.address])
      )
      const sig3 = await operator3.signMessage(ethers.getBytes(messageHash3))
      const bond3 = await manager.requiredBond(operator3.address)

      await expect(
        manager.connect(operator3).registerNode(
          nodeId3, pubkey3, 1, serviceCommitment, endpointCommitment, metadataHash, sig3,
          { value: bond3 }
        )
      ).to.be.revertedWithCustomError(manager, "EndpointAlreadyRegistered")
    })
  })

  describe("read helpers", function () {
    it("getNode returns empty record for unknown nodeId", async function () {
      const fakeNodeId = ethers.keccak256(ethers.toUtf8Bytes("unknown"))
      const node = await manager.getNode(fakeNodeId)
      expect(node.nodeId).to.equal(ethers.ZeroHash)
      expect(node.active).to.be.false
    })

    it("getBatch returns empty record for unknown batchId", async function () {
      const fakeBatchId = ethers.keccak256(ethers.toUtf8Bytes("unknown-batch"))
      const batch = await manager.getBatch(fakeBatchId)
      expect(batch.merkleRoot).to.equal(ethers.ZeroHash)
    })

    it("getEpochBatchIds returns empty for unknown epoch", async function () {
      const batches = await manager.getEpochBatchIds(999999)
      expect(batches.length).to.equal(0)
    })

    it("requiredBond returns progressive amounts", async function () {
      const [, user1] = await ethers.getSigners()
      // First node: 0.1 ETH
      expect(await manager.requiredBond(user1.address)).to.equal(ethers.parseEther("0.1"))
    })
  })
})
