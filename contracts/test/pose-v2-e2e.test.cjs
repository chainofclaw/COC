/**
 * PoSe v2 E2E Test — Full Protocol Lifecycle
 *
 * Covers the complete flow:
 *   register nodes → initEpochNonce → submitBatchV2 (with faulty + healthy leaves)
 *   → fault proof commit-reveal-settle → finalizeEpochV2 → Merkle reward claim
 *
 * Each helper mirrors the TypeScript off-chain code (reward-tree.ts, pose-v2-fault-proof.ts,
 * batch-aggregator-v2.ts) to prove TS↔Solidity formula consistency.
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

// ---------------------------------------------------------------------------
//  Helpers (mirror TypeScript off-chain libraries)
// ---------------------------------------------------------------------------

function pairHash(a, b) {
  const [x, y] = a <= b ? [a, b] : [b, a]
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [x, y]))
}

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

/** Mirror: hashEvidenceLeafV2 from batch-aggregator-v2.ts */
function hashEvidenceLeafV2(leaf) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["uint64", "bytes32", "bytes16", "bytes32", "uint64", "uint32", "uint8", "uint32"],
      [leaf.epoch, leaf.nodeId, leaf.nonce, leaf.tipHash, leaf.tipHeight, leaf.latencyMs, leaf.resultCode, leaf.witnessBitmap]
    )
  )
}

/** Mirror: hashRewardLeaf from reward-tree.ts */
function hashRewardLeaf(epochId, nodeId, amount) {
  return ethers.keccak256(
    ethers.solidityPacked(["uint64", "bytes32", "uint256"], [epochId, nodeId, amount])
  )
}

/** Mirror: encodeEvidenceData from pose-v2-fault-proof.ts */
function encodeEvidenceData(batchId, merkleProof, leaf) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "bytes32",
      "bytes32[]",
      "tuple(uint64 epoch,bytes32 nodeId,bytes16 nonce,bytes32 tipHash,uint64 tipHeight,uint32 latencyMs,uint8 resultCode,uint32 witnessBitmap)",
    ],
    [batchId, merkleProof, leaf]
  )
}

/** Mirror: computeCommitHash from pose-v2-fault-proof.ts */
function computeCommitHash(targetNodeId, faultType, evidenceLeafHash, salt) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint8", "bytes32", "bytes32"],
      [targetNodeId, faultType, evidenceLeafHash, salt]
    )
  )
}

/** Mirror: computeRevealDigest from pose-v2-fault-proof.ts */
function computeRevealDigest(challengeId, targetNodeId, faultType, evidenceLeafHash, salt, evidenceData) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["string", "bytes32", "bytes32", "uint8", "bytes32", "bytes32", "bytes32"],
      [
        "coc-fault:",
        challengeId,
        targetNodeId,
        faultType,
        evidenceLeafHash,
        salt,
        ethers.keccak256(evidenceData),
      ]
    )
  )
}

/** Mirror: buildSummaryHash from batch-aggregator-v2.ts */
function buildSummaryHash(epochId, merkleRoot, sampleProofs) {
  let rolling = ethers.ZeroHash
  for (const proof of sampleProofs) {
    rolling = ethers.keccak256(
      ethers.solidityPacked(
        ["bytes32", "uint32", "bytes32"],
        [rolling, proof.leafIndex, proof.leaf]
      )
    )
  }
  return ethers.keccak256(
    ethers.solidityPacked(
      ["uint64", "bytes32", "bytes32", "uint32"],
      [epochId, merkleRoot, rolling, sampleProofs.length]
    )
  )
}

async function registerNode(manager, funder, opts = {}) {
  const operator = ethers.Wallet.createRandom().connect(ethers.provider)
  await funder.sendTransaction({ to: operator.address, value: ethers.parseEther("5") })

  const pubkey = operator.signingKey.publicKey
  const nodeId = ethers.keccak256(pubkey)
  const serviceFlags = opts.serviceFlags ?? 7
  const serviceCommitment = opts.serviceCommitment ?? ethers.keccak256(ethers.toUtf8Bytes("svc"))
  const endpointCommitment =
    opts.endpointCommitment ?? ethers.keccak256(ethers.toUtf8Bytes(`ep-${Date.now()}-${Math.random()}`))
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("meta"))

  const messageHash = ethers.keccak256(
    ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId, operator.address])
  )
  const ownershipSig = await operator.signMessage(ethers.getBytes(messageHash))

  const bond = ethers.parseEther("1")
  await manager.connect(operator).registerNode(
    nodeId, pubkey, serviceFlags, serviceCommitment, endpointCommitment, metadataHash, ownershipSig, "0x",
    { value: bond }
  )

  return { operator, nodeId, pubkey }
}

function extractEvent(manager, receipt, eventName) {
  const log = receipt.logs.find((l) => {
    try { return manager.interface.parseLog(l)?.name === eventName } catch { return false }
  })
  if (!log) throw new Error(`event ${eventName} not found`)
  return manager.interface.parseLog(log)
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("PoSe v2 E2E: Full Protocol Lifecycle", function () {
  let manager
  let deployer

  beforeEach(async function () {
    const signers = await ethers.getSigners()
    deployer = signers[0]

    const Factory = await ethers.getContractFactory("PoSeManagerV2")
    manager = await Factory.deploy()
    await manager.waitForDeployment()

    const chainId = (await ethers.provider.getNetwork()).chainId
    await manager.initialize(chainId, await manager.getAddress(), ethers.parseEther("0.01"))
    await manager.setAllowEmptyWitnessSubmission(true)
  })

  it("complete lifecycle: batch → fault proof → slash → finalize → claim", async function () {
    // ---------------------------------------------------------------
    // Phase 1: Setup — register 3 nodes, fund reward pool
    // ---------------------------------------------------------------
    const nodeA = await registerNode(manager, deployer)
    const nodeB = await registerNode(manager, deployer)
    const nodeC = await registerNode(manager, deployer)

    await manager.depositRewardPool({ value: ethers.parseEther("10") })

    const latestBlock = await ethers.provider.getBlock("latest")
    const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)

    // Init epoch nonce
    await manager.initEpochNonce(epochId)
    const nonce = await manager.challengeNonces(epochId)
    expect(nonce).to.not.equal(0n)

    // ---------------------------------------------------------------
    // Phase 2: Build batch — 3 evidence leaves (A=Ok, B=InvalidSig, C=Ok)
    // ---------------------------------------------------------------
    const leafA = {
      epoch: epochId,
      nodeId: nodeA.nodeId,
      nonce: "0x" + "a1".repeat(16),
      tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-a")),
      tipHeight: 1000,
      latencyMs: 50,
      resultCode: 0,      // Ok
      witnessBitmap: 0,
    }
    const leafB = {
      epoch: epochId,
      nodeId: nodeB.nodeId,
      nonce: "0x" + "b2".repeat(16),
      tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-b")),
      tipHeight: 1001,
      latencyMs: 1200,
      resultCode: 2,      // InvalidSig — fault evidence
      witnessBitmap: 0,
    }
    const leafC = {
      epoch: epochId,
      nodeId: nodeC.nodeId,
      nonce: "0x" + "c3".repeat(16),
      tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip-c")),
      tipHeight: 1002,
      latencyMs: 80,
      resultCode: 0,      // Ok
      witnessBitmap: 0,
    }

    const leafHashA = hashEvidenceLeafV2(leafA)
    const leafHashB = hashEvidenceLeafV2(leafB)
    const leafHashC = hashEvidenceLeafV2(leafC)

    const leafHashes = [leafHashA, leafHashB, leafHashC]
    const { root: merkleRoot, layers } = buildMerkleTree(leafHashes)

    // Build sample proofs (all 3 leaves as samples)
    const sampleProofs = leafHashes.map((leaf, i) => ({
      leaf,
      merkleProof: buildMerkleProof(layers, i),
      leafIndex: i,
    }))
    const summaryHash = buildSummaryHash(epochId, merkleRoot, sampleProofs)

    // Submit batch
    const submitTx = await manager.submitBatchV2(
      epochId, merkleRoot, summaryHash, sampleProofs, 0, []
    )
    const submitReceipt = await submitTx.wait()
    const batchEvent = extractEvent(manager, submitReceipt, "BatchSubmittedV2")
    const batchId = batchEvent.args[1]
    expect(batchId).to.not.equal(ethers.ZeroHash)

    // Verify batch stored
    const batchData = await manager.getBatch(batchId)
    expect(batchData.epochId).to.equal(BigInt(epochId))
    expect(batchData.merkleRoot).to.equal(merkleRoot)

    // ---------------------------------------------------------------
    // Phase 3: Fault proof — target nodeB (InvalidSig, faultType=2)
    // ---------------------------------------------------------------
    const targetNodeId = nodeB.nodeId
    const faultType = 2   // InvalidSig

    // Build evidence data (ABI-encoded matching contract abi.decode)
    const merkleProofB = buildMerkleProof(layers, 1) // leafB at index 1
    const evidenceData = encodeEvidenceData(batchId, merkleProofB, leafB)

    const salt = ethers.keccak256(ethers.toUtf8Bytes("e2e-salt"))
    const commitHash = computeCommitHash(targetNodeId, faultType, leafHashB, salt)

    // Phase 3a: Commit (open challenge)
    const bond = ethers.parseEther("0.01")
    const openTx = await manager.openChallenge(commitHash, { value: bond })
    const openReceipt = await openTx.wait()
    const openEvent = extractEvent(manager, openReceipt, "ChallengeOpened")
    const challengeId = openEvent.args[0]

    // Verify challenge stored
    const challengeRecord = await manager.getChallenge(challengeId)
    expect(challengeRecord.commitHash).to.equal(commitHash)
    expect(challengeRecord.challenger).to.equal(deployer.address)
    expect(challengeRecord.bond).to.equal(bond)
    expect(challengeRecord.revealed).to.equal(false)
    expect(challengeRecord.settled).to.equal(false)

    // Phase 3b: Reveal
    const revealDigest = computeRevealDigest(
      challengeId, targetNodeId, faultType, leafHashB, salt, evidenceData
    )
    const challengerSig = await deployer.signMessage(ethers.getBytes(revealDigest))

    const revealTx = await manager.revealChallenge(
      challengeId, targetNodeId, faultType, leafHashB, salt, evidenceData, challengerSig
    )
    const revealReceipt = await revealTx.wait()
    const revealEvent = extractEvent(manager, revealReceipt, "ChallengeRevealed")
    expect(revealEvent.args[0]).to.equal(challengeId)

    const revealedRecord = await manager.getChallenge(challengeId)
    expect(revealedRecord.revealed).to.equal(true)
    expect(revealedRecord.targetNodeId).to.equal(targetNodeId)
    expect(revealedRecord.faultType).to.equal(faultType)

    // Phase 3c: Settle (advance past adjudication window: revealDeadline + 2 epochs)
    await ethers.provider.send("evm_increaseTime", [5 * 3600])
    await ethers.provider.send("evm_mine")

    const nodeBBondBefore = (await manager.getNode(targetNodeId)).bondAmount
    const insuranceBefore = await manager.insuranceBalance()
    const challengerBalBefore = await ethers.provider.getBalance(deployer.address)

    const settleTx = await manager.settleChallenge(challengeId)
    const settleReceipt = await settleTx.wait()
    const settleGas = settleReceipt.gasUsed * settleReceipt.gasPrice

    const settleEvent = extractEvent(manager, settleReceipt, "ChallengeSettled")
    expect(settleEvent.args[0]).to.equal(challengeId)

    // Verify slash distribution (50% burn / 30% challenger / 20% insurance)
    const nodeBBondAfter = (await manager.getNode(targetNodeId)).bondAmount
    const slashAmount = nodeBBondBefore - nodeBBondAfter
    expect(slashAmount).to.be.greaterThan(0n)

    // Slash cap = 5% of bond (500 bps)
    const maxSlash = (nodeBBondBefore * 500n) / 10000n
    expect(slashAmount).to.be.lessThanOrEqual(maxSlash)

    const insuranceAfter = await manager.insuranceBalance()
    const insuranceDelta = insuranceAfter - insuranceBefore
    // 20% of slash goes to insurance
    expect(insuranceDelta).to.equal((slashAmount * 2000n) / 10000n)

    // 30% of slash goes to challenger (+ bond returned)
    const challengerBalAfter = await ethers.provider.getBalance(deployer.address)
    const challengerNet = challengerBalAfter + settleGas - challengerBalBefore
    const expectedChallengerPayout = bond + (slashAmount * 3000n) / 10000n
    expect(challengerNet).to.be.closeTo(expectedChallengerPayout, ethers.parseEther("0.0001"))

    const settled = await manager.getChallenge(challengeId)
    expect(settled.settled).to.equal(true)

    // ---------------------------------------------------------------
    // Phase 4: Finalize epoch with reward tree
    // ---------------------------------------------------------------
    // Rewards for A and C (healthy nodes), nothing for B (slashed)
    const rewardA = ethers.parseEther("3")
    const rewardC = ethers.parseEther("2")
    const totalReward = rewardA + rewardC

    const rewardLeafA = hashRewardLeaf(epochId, nodeA.nodeId, rewardA)
    const rewardLeafC = hashRewardLeaf(epochId, nodeC.nodeId, rewardC)

    // Sort by nodeId for deterministic ordering (mirrors reward-tree.ts)
    const sortedRewardLeaves =
      nodeA.nodeId.toLowerCase() < nodeC.nodeId.toLowerCase()
        ? [rewardLeafA, rewardLeafC]
        : [rewardLeafC, rewardLeafA]
    const sortedAmounts =
      nodeA.nodeId.toLowerCase() < nodeC.nodeId.toLowerCase()
        ? [rewardA, rewardC]
        : [rewardC, rewardA]
    const sortedNodes =
      nodeA.nodeId.toLowerCase() < nodeC.nodeId.toLowerCase()
        ? [nodeA, nodeC]
        : [nodeC, nodeA]

    const rewardTree = buildMerkleTree(sortedRewardLeaves)
    const rewardRoot = rewardTree.root

    await manager.finalizeEpochV2(epochId, rewardRoot, totalReward, slashAmount, 0)

    expect(await manager.epochFinalized(epochId)).to.equal(true)
    expect(await manager.epochRewardRoots(epochId)).to.equal(rewardRoot)

    // ---------------------------------------------------------------
    // Phase 5: Claim rewards
    // ---------------------------------------------------------------
    // Claim for first sorted node
    const proofFirst = buildMerkleProof(rewardTree.layers, 0)
    const balBefore0 = await ethers.provider.getBalance(sortedNodes[0].operator.address)
    const claimTx0 = await manager
      .connect(sortedNodes[0].operator)
      .claim(epochId, sortedNodes[0].nodeId, sortedAmounts[0], proofFirst)
    const claimReceipt0 = await claimTx0.wait()
    const claimGas0 = claimReceipt0.gasUsed * claimReceipt0.gasPrice
    const balAfter0 = await ethers.provider.getBalance(sortedNodes[0].operator.address)

    expect(balAfter0 + claimGas0 - balBefore0).to.be.closeTo(
      sortedAmounts[0], ethers.parseEther("0.001")
    )
    expect(await manager.rewardClaimed(epochId, sortedNodes[0].nodeId)).to.equal(true)

    // Claim for second sorted node
    const proofSecond = buildMerkleProof(rewardTree.layers, 1)
    const balBefore1 = await ethers.provider.getBalance(sortedNodes[1].operator.address)
    const claimTx1 = await manager
      .connect(sortedNodes[1].operator)
      .claim(epochId, sortedNodes[1].nodeId, sortedAmounts[1], proofSecond)
    const claimReceipt1 = await claimTx1.wait()
    const claimGas1 = claimReceipt1.gasUsed * claimReceipt1.gasPrice
    const balAfter1 = await ethers.provider.getBalance(sortedNodes[1].operator.address)

    expect(balAfter1 + claimGas1 - balBefore1).to.be.closeTo(
      sortedAmounts[1], ethers.parseEther("0.001")
    )
    expect(await manager.rewardClaimed(epochId, sortedNodes[1].nodeId)).to.equal(true)

    // Double claim must revert
    await expect(
      manager.connect(sortedNodes[0].operator).claim(
        epochId, sortedNodes[0].nodeId, sortedAmounts[0], proofFirst
      )
    ).to.be.revertedWithCustomError(manager, "AlreadyClaimed")
  })

  it("multi-leaf batch: only faulty nodes get slashed, healthy nodes unaffected", async function () {
    const nodeGood = await registerNode(manager, deployer)
    const nodeBad = await registerNode(manager, deployer)
    await manager.setChallengeBondMin(ethers.parseEther("0.01"))

    const latestBlock = await ethers.provider.getBlock("latest")
    const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)

    // Build 2-leaf batch: good + bad
    const goodLeaf = {
      epoch: epochId,
      nodeId: nodeGood.nodeId,
      nonce: "0x" + "01".repeat(16),
      tipHash: ethers.keccak256(ethers.toUtf8Bytes("good-tip")),
      tipHeight: 500,
      latencyMs: 30,
      resultCode: 0,
      witnessBitmap: 0,
    }
    const badLeaf = {
      epoch: epochId,
      nodeId: nodeBad.nodeId,
      nonce: "0x" + "02".repeat(16),
      tipHash: ethers.keccak256(ethers.toUtf8Bytes("bad-tip")),
      tipHeight: 501,
      latencyMs: 5000,
      resultCode: 1,  // Timeout → faultType=3 (TimeoutMiss)
      witnessBitmap: 0,
    }

    const goodHash = hashEvidenceLeafV2(goodLeaf)
    const badHash = hashEvidenceLeafV2(badLeaf)
    const leafHashes = [goodHash, badHash]
    const { root: merkleRoot, layers } = buildMerkleTree(leafHashes)

    const sampleProofs = leafHashes.map((leaf, i) => ({
      leaf,
      merkleProof: buildMerkleProof(layers, i),
      leafIndex: i,
    }))
    const summaryHash = buildSummaryHash(epochId, merkleRoot, sampleProofs)

    const submitTx = await manager.submitBatchV2(epochId, merkleRoot, summaryHash, sampleProofs, 0, [])
    const submitReceipt = await submitTx.wait()
    const batchId = extractEvent(manager, submitReceipt, "BatchSubmittedV2").args[1]

    // Fault proof against bad node (Timeout → faultType=3)
    const faultType = 3
    const merkleProofBad = buildMerkleProof(layers, 1)
    const evidenceData = encodeEvidenceData(batchId, merkleProofBad, badLeaf)
    const salt = ethers.keccak256(ethers.toUtf8Bytes("timeout-salt"))
    const commitHash = computeCommitHash(nodeBad.nodeId, faultType, badHash, salt)

    const openTx = await manager.openChallenge(commitHash, { value: ethers.parseEther("0.01") })
    const challengeId = extractEvent(manager, await openTx.wait(), "ChallengeOpened").args[0]

    const digest = computeRevealDigest(challengeId, nodeBad.nodeId, faultType, badHash, salt, evidenceData)
    const sig = await deployer.signMessage(ethers.getBytes(digest))
    await manager.revealChallenge(challengeId, nodeBad.nodeId, faultType, badHash, salt, evidenceData, sig)

    await ethers.provider.send("evm_increaseTime", [5 * 3600])
    await ethers.provider.send("evm_mine")

    const goodBondBefore = (await manager.getNode(nodeGood.nodeId)).bondAmount
    const badBondBefore = (await manager.getNode(nodeBad.nodeId)).bondAmount

    await manager.settleChallenge(challengeId)

    const goodBondAfter = (await manager.getNode(nodeGood.nodeId)).bondAmount
    const badBondAfter = (await manager.getNode(nodeBad.nodeId)).bondAmount

    // Good node unaffected, bad node slashed
    expect(goodBondAfter).to.equal(goodBondBefore)
    expect(badBondAfter).to.be.lessThan(badBondBefore)
  })

  it("empty epoch finalization succeeds with zero reward", async function () {
    await ethers.provider.send("evm_increaseTime", [4 * 3600])
    await ethers.provider.send("evm_mine")

    const pastEpoch = 1
    await manager.finalizeEpochV2(pastEpoch, ethers.ZeroHash, 0, 0, 0)

    expect(await manager.epochFinalized(pastEpoch)).to.equal(true)
    expect(await manager.epochRewardRoots(pastEpoch)).to.equal(ethers.ZeroHash)
  })

  it("unrevealed challenge forfeits bond to insurance", async function () {
    await manager.setChallengeBondMin(ethers.parseEther("0.1"))
    const bond = ethers.parseEther("0.1")
    const commitHash = ethers.keccak256(ethers.toUtf8Bytes("never-reveal"))

    const openTx = await manager.openChallenge(commitHash, { value: bond })
    const challengeId = extractEvent(manager, await openTx.wait(), "ChallengeOpened").args[0]

    // Advance past reveal deadline (commitEpoch + REVEAL_WINDOW_EPOCHS = 2 epochs)
    await ethers.provider.send("evm_increaseTime", [3 * 3600])
    await ethers.provider.send("evm_mine")

    const insuranceBefore = await manager.insuranceBalance()
    await manager.settleChallenge(challengeId)
    const insuranceAfter = await manager.insuranceBalance()

    // Entire bond goes to insurance (unrevealed penalty)
    expect(insuranceAfter - insuranceBefore).to.equal(bond)

    const record = await manager.getChallenge(challengeId)
    expect(record.settled).to.equal(true)
    expect(record.revealed).to.equal(false)
  })

  it("TS helper formulas match contract: commitHash + revealDigest + evidenceLeafHash", async function () {
    const { nodeId } = await registerNode(manager, deployer)
    await manager.setChallengeBondMin(ethers.parseEther("0.01"))

    const latestBlock = await ethers.provider.getBlock("latest")
    const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)

    const leaf = {
      epoch: epochId,
      nodeId,
      nonce: "0x" + "dd".repeat(16),
      tipHash: ethers.keccak256(ethers.toUtf8Bytes("cross-check")),
      tipHeight: 42,
      latencyMs: 99,
      resultCode: 2,
      witnessBitmap: 7,
    }

    // TS helper produces same hash as contract expects
    const tsHash = hashEvidenceLeafV2(leaf)

    // Submit batch with this leaf to prove contract accepts the hash
    const { root: merkleRoot, layers } = buildMerkleTree([tsHash])
    const sampleProofs = [{ leaf: tsHash, merkleProof: buildMerkleProof(layers, 0), leafIndex: 0 }]
    const summaryHash = buildSummaryHash(epochId, merkleRoot, sampleProofs)

    const submitTx = await manager.submitBatchV2(epochId, merkleRoot, summaryHash, sampleProofs, 0, [])
    const batchId = extractEvent(manager, await submitTx.wait(), "BatchSubmittedV2").args[1]

    // Build fault proof using TS helpers
    const faultType = 2
    const merkleProof = buildMerkleProof(layers, 0)
    const evidenceData = encodeEvidenceData(batchId, merkleProof, leaf)
    const salt = ethers.keccak256(ethers.toUtf8Bytes("cross-salt"))
    const tsCommitHash = computeCommitHash(nodeId, faultType, tsHash, salt)

    // Open + reveal proves commit hash formula matches
    const openTx = await manager.openChallenge(tsCommitHash, { value: ethers.parseEther("0.01") })
    const challengeId = extractEvent(manager, await openTx.wait(), "ChallengeOpened").args[0]

    const tsRevealDigest = computeRevealDigest(challengeId, nodeId, faultType, tsHash, salt, evidenceData)
    const challengerSig = await deployer.signMessage(ethers.getBytes(tsRevealDigest))

    // If any formula diverges, revealChallenge would revert
    await expect(
      manager.revealChallenge(challengeId, nodeId, faultType, tsHash, salt, evidenceData, challengerSig)
    ).to.not.be.reverted

    const record = await manager.getChallenge(challengeId)
    expect(record.revealed).to.equal(true)
  })

  it("reward tree with 4 nodes: TS proof structure accepted on-chain", async function () {
    const nodes = []
    for (let i = 0; i < 4; i++) {
      nodes.push(await registerNode(manager, deployer))
    }

    await manager.depositRewardPool({ value: ethers.parseEther("20") })

    await ethers.provider.send("evm_increaseTime", [4 * 3600])
    await ethers.provider.send("evm_mine")

    const epochId = 1
    const rewards = [
      ethers.parseEther("5"),
      ethers.parseEther("3"),
      ethers.parseEther("1.5"),
      ethers.parseEther("0.5"),
    ]
    const totalReward = rewards.reduce((a, b) => a + b, 0n)

    // Sort by nodeId (mirrors reward-tree.ts deterministic ordering)
    const indexed = nodes.map((n, i) => ({ ...n, reward: rewards[i] }))
    indexed.sort((a, b) =>
      a.nodeId.toLowerCase() < b.nodeId.toLowerCase() ? -1 :
      a.nodeId.toLowerCase() > b.nodeId.toLowerCase() ? 1 : 0
    )

    const rewardLeafHashes = indexed.map((n) =>
      hashRewardLeaf(epochId, n.nodeId, n.reward)
    )
    const rewardTree = buildMerkleTree(rewardLeafHashes)

    await manager.finalizeEpochV2(epochId, rewardTree.root, totalReward, 0, 0)

    // Each node claims with their merkle proof
    for (let i = 0; i < indexed.length; i++) {
      const proof = buildMerkleProof(rewardTree.layers, i)
      const balBefore = await ethers.provider.getBalance(indexed[i].operator.address)

      const claimTx = await manager
        .connect(indexed[i].operator)
        .claim(epochId, indexed[i].nodeId, indexed[i].reward, proof)
      const receipt = await claimTx.wait()
      const gas = receipt.gasUsed * receipt.gasPrice

      const balAfter = await ethers.provider.getBalance(indexed[i].operator.address)
      expect(balAfter + gas - balBefore).to.be.closeTo(indexed[i].reward, ethers.parseEther("0.001"))
    }

    // All 4 claimed
    for (const n of indexed) {
      expect(await manager.rewardClaimed(epochId, n.nodeId)).to.equal(true)
    }
  })

  it("sequential epochs: finalize epoch N, then epoch N+1 independently", async function () {
    const node = await registerNode(manager, deployer)
    await manager.depositRewardPool({ value: ethers.parseEther("20") })

    // Advance enough time for both epochs to be finalizable
    await ethers.provider.send("evm_increaseTime", [6 * 3600])
    await ethers.provider.send("evm_mine")

    const epoch1 = 1
    const epoch2 = 2
    const amount1 = ethers.parseEther("2")
    const amount2 = ethers.parseEther("3")

    // Finalize epoch 1
    const leaf1 = hashRewardLeaf(epoch1, node.nodeId, amount1)
    const tree1 = buildMerkleTree([leaf1])
    await manager.finalizeEpochV2(epoch1, tree1.root, amount1, 0, 0)

    // Finalize epoch 2
    const leaf2 = hashRewardLeaf(epoch2, node.nodeId, amount2)
    const tree2 = buildMerkleTree([leaf2])
    await manager.finalizeEpochV2(epoch2, tree2.root, amount2, 0, 0)

    // Claim epoch 2 first (out of order)
    const proof2 = buildMerkleProof(tree2.layers, 0)
    await manager.connect(node.operator).claim(epoch2, node.nodeId, amount2, proof2)
    expect(await manager.rewardClaimed(epoch2, node.nodeId)).to.equal(true)
    expect(await manager.rewardClaimed(epoch1, node.nodeId)).to.equal(false)

    // Then claim epoch 1
    const proof1 = buildMerkleProof(tree1.layers, 0)
    await manager.connect(node.operator).claim(epoch1, node.nodeId, amount1, proof1)
    expect(await manager.rewardClaimed(epoch1, node.nodeId)).to.equal(true)
  })

  describe("Gas benchmarks", function () {
    it("full lifecycle gas report", async function () {
      const node = await registerNode(manager, deployer)
      await manager.depositRewardPool({ value: ethers.parseEther("10") })
      await manager.setChallengeBondMin(ethers.parseEther("0.01"))

      const latestBlock = await ethers.provider.getBlock("latest")
      const epochId = Math.floor(Number(latestBlock.timestamp) / 3600)

      // submitBatchV2
      const leaf = {
        epoch: epochId, nodeId: node.nodeId, nonce: "0x" + "ff".repeat(16),
        tipHash: ethers.keccak256(ethers.toUtf8Bytes("gas")),
        tipHeight: 100, latencyMs: 50, resultCode: 2, witnessBitmap: 0,
      }
      const leafHash = hashEvidenceLeafV2(leaf)
      const { root, layers } = buildMerkleTree([leafHash])
      const sampleProofs = [{ leaf: leafHash, merkleProof: buildMerkleProof(layers, 0), leafIndex: 0 }]
      const summary = buildSummaryHash(epochId, root, sampleProofs)

      const batchTx = await manager.submitBatchV2(epochId, root, summary, sampleProofs, 0, [])
      const batchReceipt = await batchTx.wait()
      const batchId = extractEvent(manager, batchReceipt, "BatchSubmittedV2").args[1]
      console.log("    submitBatchV2 gas:", batchReceipt.gasUsed.toString())

      // openChallenge
      const faultType = 2
      const mProof = buildMerkleProof(layers, 0)
      const eData = encodeEvidenceData(batchId, mProof, leaf)
      const salt = ethers.keccak256(ethers.toUtf8Bytes("gas-salt"))
      const commit = computeCommitHash(node.nodeId, faultType, leafHash, salt)

      const openTx = await manager.openChallenge(commit, { value: ethers.parseEther("0.01") })
      const openReceipt = await openTx.wait()
      const cId = extractEvent(manager, openReceipt, "ChallengeOpened").args[0]
      console.log("    openChallenge gas:", openReceipt.gasUsed.toString())

      // revealChallenge
      const digest = computeRevealDigest(cId, node.nodeId, faultType, leafHash, salt, eData)
      const sig = await deployer.signMessage(ethers.getBytes(digest))
      const revealTx = await manager.revealChallenge(cId, node.nodeId, faultType, leafHash, salt, eData, sig)
      const revealReceipt = await revealTx.wait()
      console.log("    revealChallenge gas:", revealReceipt.gasUsed.toString())

      // settleChallenge
      await ethers.provider.send("evm_increaseTime", [5 * 3600])
      await ethers.provider.send("evm_mine")
      const settleTx = await manager.settleChallenge(cId)
      const settleReceipt = await settleTx.wait()
      console.log("    settleChallenge gas:", settleReceipt.gasUsed.toString())

      // finalizeEpochV2
      const amount = ethers.parseEther("1")
      const rLeaf = hashRewardLeaf(epochId, node.nodeId, amount)
      const rTree = buildMerkleTree([rLeaf])
      const finTx = await manager.finalizeEpochV2(epochId, rTree.root, amount, 0, 0)
      const finReceipt = await finTx.wait()
      console.log("    finalizeEpochV2 gas:", finReceipt.gasUsed.toString())

      // claim
      const claimProof = buildMerkleProof(rTree.layers, 0)
      const claimTx = await manager.connect(node.operator).claim(epochId, node.nodeId, amount, claimProof)
      const claimReceipt = await claimTx.wait()
      console.log("    claim gas:", claimReceipt.gasUsed.toString())
    })
  })
})
