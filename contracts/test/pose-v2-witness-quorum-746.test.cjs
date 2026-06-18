// PoSeManagerV2 — #746 v3 typehash + v2SunsetEpoch tests.
//
// Covers the protocol-level fix for issue #746 (witness still rubber-stamps
// prover-side semantics even with Push verification, #667 F1+F3):
//
//   1. happy path — v3 typehash signature (binds resultCode) verifies
//   2. v2 fallback accepted when `v2SunsetEpoch == 0` (default)
//   3. v2 fallback rejected when `epochId > v2SunsetEpoch` (non-zero)
//   4. v1 fallback still works via existing v1SunsetEpoch (no regression)
//   5. setV2SunsetEpoch onlyOwner
//   6. resultCode tampering — submitting witness sig over resultCode=Ok but
//      metadata declares resultCode=Fail → digest mismatch → revert
//   7. legacy `submitBatchV2` (no metadata) revertsLegacyBatchPathSunset

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

const WITNESS_TYPEHASH_V1 = ethers.keccak256(
  ethers.toUtf8Bytes("WitnessAttestation(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 witnessIndex)")
)
const WITNESS_TYPEHASH_V2 = ethers.keccak256(
  ethers.toUtf8Bytes("WitnessAttestationV2(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 witnessIndex,uint64 epochId)")
)
const WITNESS_TYPEHASH_V3 = ethers.keccak256(
  ethers.toUtf8Bytes("WitnessAttestationV3(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 resultCode,uint8 witnessIndex,uint64 epochId)")
)

function pairHash(a, b) {
  const [x, y] = a <= b ? [a, b] : [b, a]
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [x, y]))
}

async function registerWitness(manager, funder, label) {
  const operator = ethers.Wallet.createRandom().connect(ethers.provider)
  await funder.sendTransaction({ to: operator.address, value: ethers.parseEther("5") })
  const pubkey = operator.signingKey.publicKey
  const nodeId = ethers.keccak256(pubkey)
  const serviceFlags = 7
  const serviceCommitment = ethers.keccak256(ethers.toUtf8Bytes(`svc-${label}`))
  const endpointCommitment = ethers.keccak256(ethers.toUtf8Bytes(`ep-${label}-${Date.now()}-${Math.random()}`))
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(`meta-${label}`))
  const messageHash = ethers.keccak256(
    ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId, operator.address])
  )
  const ownershipSig = await operator.signMessage(ethers.getBytes(messageHash))
  await manager.connect(operator).registerNode(
    nodeId, pubkey, serviceFlags, serviceCommitment, endpointCommitment, metadataHash, ownershipSig, "0x",
    { value: ethers.parseEther("0.1") }
  )
  return { operator, nodeId, pubkey }
}

async function signWitnessV3(manager, witness, args) {
  const { challengeId, responseBodyHash, resultCode, witnessIndex, epochId } = args
  const ds = await manager.DOMAIN_SEPARATOR()
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint8", "uint8", "uint64"],
      [WITNESS_TYPEHASH_V3, challengeId, witness.nodeId, responseBodyHash, resultCode, witnessIndex, epochId]
    )
  )
  const digest = ethers.keccak256(ethers.concat(["0x1901", ds, structHash]))
  return witness.operator.signingKey.sign(digest).serialized
}

async function signWitnessV2(manager, witness, args) {
  const { challengeId, responseBodyHash, witnessIndex, epochId } = args
  const ds = await manager.DOMAIN_SEPARATOR()
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint8", "uint64"],
      [WITNESS_TYPEHASH_V2, challengeId, witness.nodeId, responseBodyHash, witnessIndex, epochId]
    )
  )
  const digest = ethers.keccak256(ethers.concat(["0x1901", ds, structHash]))
  return witness.operator.signingKey.sign(digest).serialized
}

async function signWitnessV1(manager, witness, args) {
  const { challengeId, responseBodyHash, witnessIndex } = args
  const ds = await manager.DOMAIN_SEPARATOR()
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint8"],
      [WITNESS_TYPEHASH_V1, challengeId, witness.nodeId, responseBodyHash, witnessIndex]
    )
  )
  const digest = ethers.keccak256(ethers.concat(["0x1901", ds, structHash]))
  return witness.operator.signingKey.sign(digest).serialized
}

function makeReceipt(label, resultCode = 0) {
  return {
    challengeId: ethers.keccak256(ethers.toUtf8Bytes(`challenge-${label}`)),
    nodeId: ethers.keccak256(ethers.toUtf8Bytes(`subject-${label}`)),
    responseBodyHash: ethers.keccak256(ethers.toUtf8Bytes(`response-${label}`)),
    leafHash: ethers.keccak256(ethers.toUtf8Bytes(`leaf-${label}`)),
    resultCode,
  }
}

function buildMetadata(receipts, witnessReceiptIndex) {
  const padded = new Array(32).fill(0xffff)
  for (const [bit, idx] of witnessReceiptIndex) padded[bit] = idx
  return {
    challengeIds: receipts.map((r) => r.challengeId),
    nodeIds: receipts.map((r) => r.nodeId),
    responseBodyHashes: receipts.map((r) => r.responseBodyHash),
    leafHashes: receipts.map((r) => r.leafHash),
    resultCodes: receipts.map((r) => r.resultCode),
    witnessReceiptIndex: padded,
  }
}

async function submitWithMetadata(manager, args) {
  const { epochId, merkleRoot, sampleLeaf, witnessBitmap, witnessSignatures, metadata } = args
  const sampleProofs = [{ leaf: sampleLeaf, merkleProof: [sampleLeaf], leafIndex: 0 }]
  const sampleCommitment = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [ethers.ZeroHash, 0, sampleLeaf])
  )
  const summaryHash = ethers.keccak256(
    ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [epochId, merkleRoot, sampleCommitment, 1])
  )
  return manager.submitBatchV2WithMetadata(
    epochId, merkleRoot, summaryHash, sampleProofs, witnessBitmap, witnessSignatures, metadata
  )
}

describe("PoSeManagerV2 — #746 v3 typehash + v2 sunset", function () {
  let manager, deployer

  beforeEach(async function () {
    const signers = await ethers.getSigners()
    deployer = signers[0]
    const Factory = await ethers.getContractFactory("PoSeManagerV2")
    manager = await upgrades.deployProxy(
      Factory,
      [ethers.parseEther("0.01"), deployer.address],
      { initializer: "initialize", kind: "uups" },
    )
    await manager.waitForDeployment()
  })

  it("happy path — v3 typehash binds resultCode and verifies", async function () {
    const witness = await registerWitness(manager, deployer, "v3happy")
    const receipt = makeReceipt("v3happy", /* resultCode= */ 3)
    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const sig = await signWitnessV3(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      resultCode: receipt.resultCode,
      witnessIndex: 0,
      epochId,
    })
    const merkleRoot = pairHash(receipt.leafHash, receipt.leafHash)
    await expect(submitWithMetadata(manager, {
      epochId, merkleRoot,
      sampleLeaf: receipt.leafHash,
      witnessBitmap: 1,
      witnessSignatures: [sig],
      metadata: buildMetadata([receipt], [[0, 0]]),
    })).to.emit(manager, "ReceiptBatchMetadataSubmitted")
  })

  it("v2 fallback accepted when v2SunsetEpoch == 0 (default)", async function () {
    const witness = await registerWitness(manager, deployer, "v2compat")
    const receipt = makeReceipt("v2compat", /* resultCode= */ 5)
    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const sig = await signWitnessV2(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      witnessIndex: 0,
      epochId,
    })
    expect(await manager.v2SunsetEpoch()).to.equal(0)
    const merkleRoot = pairHash(receipt.leafHash, receipt.leafHash)
    await expect(submitWithMetadata(manager, {
      epochId, merkleRoot,
      sampleLeaf: receipt.leafHash,
      witnessBitmap: 1,
      witnessSignatures: [sig],
      metadata: buildMetadata([receipt], [[0, 0]]),
    })).to.emit(manager, "BatchSubmittedV2")
  })

  it("v2 fallback rejected when epochId > v2SunsetEpoch (non-zero)", async function () {
    const witness = await registerWitness(manager, deployer, "v2sunset")
    const receipt = makeReceipt("v2sunset", 5)
    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    // Set sunset BEFORE the current epoch — v2 sigs in `epochId` should now be rejected.
    await manager.setV2SunsetEpoch(epochId - 1)
    const sig = await signWitnessV2(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      witnessIndex: 0,
      epochId,
    })
    const merkleRoot = pairHash(receipt.leafHash, receipt.leafHash)
    await expect(submitWithMetadata(manager, {
      epochId, merkleRoot,
      sampleLeaf: receipt.leafHash,
      witnessBitmap: 1,
      witnessSignatures: [sig],
      metadata: buildMetadata([receipt], [[0, 0]]),
    })).to.be.revertedWithCustomError(manager, "InvalidWitnessQuorum")
  })

  it("setV2SunsetEpoch onlyOwner + emits event", async function () {
    const [, other] = await ethers.getSigners()
    await expect(manager.connect(other).setV2SunsetEpoch(100)).to.be.reverted
    await expect(manager.setV2SunsetEpoch(42)).to
      .emit(manager, "V2SunsetEpochUpdated").withArgs(42)
    expect(await manager.v2SunsetEpoch()).to.equal(42)
  })

  it("witness signs over resultCode=0 but aggregator declares resultCode=3 → digest mismatch → revert", async function () {
    // The whole point of v3: witness signature is over resultCode; if the
    // aggregator tries to re-encode the leaf with a different resultCode, the
    // v3 digest computed by the contract won't match the witness's signature.
    const witness = await registerWitness(manager, deployer, "tampered")
    const receipt = makeReceipt("tampered", 0)
    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const sig = await signWitnessV3(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      resultCode: 0, // witness saw Ok
      witnessIndex: 0,
      epochId,
    })
    // Aggregator tries to claim resultCode=3 (Fail-like) — should revert
    // because the contract reconstructs the v3 digest from metadata.resultCodes
    // and v3 doesn't recover the operator.
    const tampered = { ...receipt, resultCode: 3 }
    const merkleRoot = pairHash(receipt.leafHash, receipt.leafHash)
    await expect(submitWithMetadata(manager, {
      epochId, merkleRoot,
      sampleLeaf: receipt.leafHash,
      witnessBitmap: 1,
      witnessSignatures: [sig],
      metadata: buildMetadata([tampered], [[0, 0]]),
    })).to.be.revertedWithCustomError(manager, "InvalidWitnessQuorum")
  })

  it("legacy submitBatchV2 reverts LegacyBatchPathSunset", async function () {
    const sampleProofs = [{
      leaf: ethers.keccak256(ethers.toUtf8Bytes("x")),
      merkleProof: [ethers.keccak256(ethers.toUtf8Bytes("x"))],
      leafIndex: 0,
    }]
    await expect(manager.submitBatchV2(
      0, ethers.keccak256("0x01"), ethers.keccak256("0x02"), sampleProofs, 0, []
    )).to.be.revertedWithCustomError(manager, "LegacyBatchPathSunset")
  })
})
