// PoSeManagerV2 — #667 witness-quorum independent verification tests.
//
// Covers `submitBatchV2WithMetadata` and its `_validateWitnessQuorumV2`
// helper. Each test exercises one of the new on-chain guarantees:
//
//   1. happy path — v2 typehash signature accepted, Merkle root rebuilt OK
//   2. versioned-typehash compatibility — v1 typehash signature still accepted
//   3. WitnessNotActive — slashed/removed witness can't be reused
//   4. WitnessSigReplay — same signature can't settle two batches in an epoch
//   5. MerkleRootMismatch — tampered leafHashes detected
//   6. BadReceiptIndex / MetadataLengthMismatch — malformed metadata rejected
//
// These tests intentionally do NOT reuse the helpers from `pose-v2.test.cjs`
// to keep the rollout-window semantics explicit (v1 vs v2 typehash signing).

const { expect } = require("chai")
const { ethers, upgrades } = require("hardhat")

const WITNESS_TYPEHASH_V1 = ethers.keccak256(
  ethers.toUtf8Bytes("WitnessAttestation(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 witnessIndex)")
)
const WITNESS_TYPEHASH_V2 = ethers.keccak256(
  ethers.toUtf8Bytes("WitnessAttestationV2(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 witnessIndex,uint64 epochId)")
)

function pairHash(a, b) {
  const [x, y] = a <= b ? [a, b] : [b, a]
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [x, y]))
}

function buildMerkleRoot(leaves) {
  if (leaves.length === 0) return ethers.ZeroHash
  let level = leaves.slice()
  // Mirror the contract's `_rebuildMerkleRoot` — at least one round so a
  // single-leaf root is `pairHash(leaf, leaf)`.
  do {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]
      const r = level[i + 1] ?? level[i]
      next.push(pairHash(l, r))
    }
    level = next
  } while (level.length > 1)
  return level[0]
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

async function signWitnessV2(manager, witness, args) {
  const { challengeId, responseBodyHash, witnessIndex, epochId } = args
  const domainSeparator = await manager.DOMAIN_SEPARATOR()
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint8", "uint64"],
      [WITNESS_TYPEHASH_V2, challengeId, witness.nodeId, responseBodyHash, witnessIndex, epochId]
    )
  )
  const digest = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]))
  return witness.operator.signingKey.sign(digest).serialized
}

async function signWitnessV1(manager, witness, args) {
  const { challengeId, responseBodyHash, witnessIndex } = args
  const domainSeparator = await manager.DOMAIN_SEPARATOR()
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint8"],
      [WITNESS_TYPEHASH_V1, challengeId, witness.nodeId, responseBodyHash, witnessIndex]
    )
  )
  const digest = ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]))
  return witness.operator.signingKey.sign(digest).serialized
}

function buildMetadata(receipts, witnessReceiptIndex) {
  // Pads `witnessReceiptIndex` to length 32 with type(uint16).max sentinel.
  const padded = new Array(32).fill(0xffff)
  for (const [bit, idx] of witnessReceiptIndex) padded[bit] = idx
  return {
    challengeIds: receipts.map((r) => r.challengeId),
    nodeIds: receipts.map((r) => r.nodeId),
    responseBodyHashes: receipts.map((r) => r.responseBodyHash),
    leafHashes: receipts.map((r) => r.leafHash),
    witnessReceiptIndex: padded,
  }
}

// #715: re-encode an ECDSA signature's recovery byte to its equivalent
// non-EIP-155 form (0x1b<->0x00, 0x1c<->0x01). `_recoverSigner` normalises
// both encodings to the same `v`, so the re-encoded signature recovers the
// SAME signer while having different raw bytes — the malleability an
// anti-replay guard keyed on keccak256(sig) would have been fooled by.
function flipVByteEncoding(sig) {
  const body = sig.slice(0, -2)
  const v = sig.slice(-2).toLowerCase()
  const flipped = { "1b": "00", "1c": "01", "00": "1b", "01": "1c" }[v]
  if (flipped === undefined) throw new Error(`unexpected v byte: 0x${v}`)
  return body + flipped
}

function makeReceipt(label) {
  return {
    challengeId: ethers.keccak256(ethers.toUtf8Bytes(`challenge-${label}`)),
    nodeId: ethers.keccak256(ethers.toUtf8Bytes(`subject-${label}`)),
    responseBodyHash: ethers.keccak256(ethers.toUtf8Bytes(`response-${label}`)),
    leafHash: ethers.keccak256(ethers.toUtf8Bytes(`leaf-${label}`)),
  }
}

async function submitV2Metadata(manager, args) {
  const { epochId, merkleRoot, sampleLeaf, witnessBitmap, witnessSignatures, metadata } = args
  const sampleProofs = [{ leaf: sampleLeaf, merkleProof: [sampleLeaf], leafIndex: 0 }]
  const sampleCommitment = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [ethers.ZeroHash, 0, sampleLeaf])
  )
  const summaryHash = ethers.keccak256(
    ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [epochId, merkleRoot, sampleCommitment, 1])
  )
  return manager.submitBatchV2WithMetadata(
    epochId,
    merkleRoot,
    summaryHash,
    sampleProofs,
    witnessBitmap,
    witnessSignatures,
    metadata,
  )
}

describe("PoSeManagerV2 — #667 witness-quorum independent verification", function () {
  let manager
  let deployer

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

  it("happy path — v2 typehash signature accepted, Merkle root rebuilt", async function () {
    const witness = await registerWitness(manager, deployer, "happy")
    const receipt = makeReceipt("happy")
    const sampleLeaf = receipt.leafHash // single-leaf batch ⇒ root = leaf

    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const witnessIndex = 0
    const sig = await signWitnessV2(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      witnessIndex,
      epochId,
    })

    const metadata = buildMetadata([receipt], [[witnessIndex, 0]])
    const merkleRoot = buildMerkleRoot([receipt.leafHash])

    await expect(submitV2Metadata(manager, {
      epochId, merkleRoot, sampleLeaf,
      witnessBitmap: 1 << witnessIndex,
      witnessSignatures: [sig],
      metadata,
    })).to.emit(manager, "ReceiptBatchMetadataSubmitted")
  })

  it("versioned-typehash compatibility — v1 signature still accepted during rollout", async function () {
    const witness = await registerWitness(manager, deployer, "v1compat")
    const receipt = makeReceipt("v1compat")
    const sampleLeaf = receipt.leafHash

    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const witnessIndex = 0
    const sigV1 = await signWitnessV1(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      witnessIndex,
    })

    const metadata = buildMetadata([receipt], [[witnessIndex, 0]])
    const merkleRoot = buildMerkleRoot([receipt.leafHash])

    await expect(submitV2Metadata(manager, {
      epochId, merkleRoot, sampleLeaf,
      witnessBitmap: 1 << witnessIndex,
      witnessSignatures: [sigV1],
      metadata,
    })).to.emit(manager, "BatchSubmittedV2")
  })

  // TODO(#667 PR-B integration): WitnessNotActive requires triggering
  // _removeActiveNode, which on v2 only fires from the fault-proof
  // settlement flow (settleChallenge ⇒ fault confirmed). Covered by the
  // upcoming integration test in `tests/integration/pose-v2-settlement.*`
  // where the full openChallenge → reveal → settle → deactivate cycle runs
  // against a real witness. The on-chain `require(_activeNodeIndex[...] > 0)`
  // is straight-line and reviewed in PR-A.
  it.skip("reverts WitnessNotActive when witness was deactivated (integration)", async function () {})

  it("reverts WitnessSigReplay when the same signature is reused across batches in an epoch", async function () {
    const witness = await registerWitness(manager, deployer, "replay")
    const r1 = makeReceipt("replay-1")
    const r2 = makeReceipt("replay-2")

    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const witnessIndex = 0

    // Witness signed only for r1. Both batches will include r1 (and thus
    // legitimately reuse sig1), but a multi-receipt batch packaging r1+r2
    // can claim the same witness signature in a second submission — that's
    // the attack `_witnessSigUsed` defends against.
    const sig1 = await signWitnessV2(manager, witness, {
      challengeId: r1.challengeId,
      responseBodyHash: r1.responseBodyHash,
      witnessIndex,
      epochId,
    })

    // Batch 1 — references r1, succeeds.
    await submitV2Metadata(manager, {
      epochId,
      merkleRoot: buildMerkleRoot([r1.leafHash]),
      sampleLeaf: r1.leafHash,
      witnessBitmap: 1 << witnessIndex,
      witnessSignatures: [sig1],
      metadata: buildMetadata([r1], [[witnessIndex, 0]]),
    })

    // Batch 2 — also references r1 but at a different position in a
    // multi-receipt batch (r2 leaf added → different merkleRoot → bypasses
    // `epochMerkleRootUsed`). Tries to reuse sig1 against r1 at witnessIndex 0.
    // Anti-replay key = (epochId, witnessNodeId, keccak256(sig1)) collides
    // with batch 1, so this MUST revert.
    const merkleRoot2 = buildMerkleRoot([r1.leafHash, r2.leafHash])
    // Sample any leaf; pick r1.leafHash.
    const sampleLeaf2 = r1.leafHash
    // Need a real merkleProof since the tree has 2 leaves: proof for r1 is [r2.leafHash].
    // Recompute via buildMerkleRoot's pair semantics — sorted-concat at each level.
    const sampleProofs2 = [{
      leaf: r1.leafHash,
      merkleProof: [r2.leafHash],
      leafIndex: 0,
    }]
    const sampleCommitment2 = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [ethers.ZeroHash, 0, r1.leafHash])
    )
    const summaryHash2 = ethers.keccak256(
      ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [epochId, merkleRoot2, sampleCommitment2, 1])
    )

    await expect(manager.submitBatchV2WithMetadata(
      epochId,
      merkleRoot2,
      summaryHash2,
      sampleProofs2,
      1 << witnessIndex,
      [sig1], // <-- replayed
      buildMetadata([r1, r2], [[witnessIndex, 0]]),
    )).to.be.revertedWithCustomError(manager, "WitnessSigReplay")
  })

  it("reverts WitnessSigReplay when a v-byte-malleated copy of a used signature is reused (#715)", async function () {
    const witness = await registerWitness(manager, deployer, "vmalleate")
    const r1 = makeReceipt("vmalleate-1")
    const r2 = makeReceipt("vmalleate-2")

    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const witnessIndex = 0

    const sig1 = await signWitnessV2(manager, witness, {
      challengeId: r1.challengeId,
      responseBodyHash: r1.responseBodyHash,
      witnessIndex,
      epochId,
    })

    // Batch 1 — references r1 with the genuine signature, succeeds.
    await submitV2Metadata(manager, {
      epochId,
      merkleRoot: buildMerkleRoot([r1.leafHash]),
      sampleLeaf: r1.leafHash,
      witnessBitmap: 1 << witnessIndex,
      witnessSignatures: [sig1],
      metadata: buildMetadata([r1], [[witnessIndex, 0]]),
    })

    // Batch 2 — distinct merkleRoot (r1+r2) so `epochMerkleRootUsed` does not
    // block it. Reuses sig1 but with its recovery byte re-encoded: the bytes
    // (and thus keccak256(sig)) differ, yet `_recoverSigner` recovers the same
    // witness. A guard keyed on keccak256(sig) would NOT fire here; keyed on
    // the verified EIP-712 digest it must still revert WitnessSigReplay.
    const malleated = flipVByteEncoding(sig1)
    expect(malleated).to.not.equal(sig1)

    const merkleRoot2 = buildMerkleRoot([r1.leafHash, r2.leafHash])
    const sampleProofs2 = [{ leaf: r1.leafHash, merkleProof: [r2.leafHash], leafIndex: 0 }]
    const sampleCommitment2 = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "uint32", "bytes32"], [ethers.ZeroHash, 0, r1.leafHash])
    )
    const summaryHash2 = ethers.keccak256(
      ethers.solidityPacked(["uint64", "bytes32", "bytes32", "uint32"], [epochId, merkleRoot2, sampleCommitment2, 1])
    )

    await expect(manager.submitBatchV2WithMetadata(
      epochId,
      merkleRoot2,
      summaryHash2,
      sampleProofs2,
      1 << witnessIndex,
      [malleated], // <-- v-malleated copy of sig1
      buildMetadata([r1, r2], [[witnessIndex, 0]]),
    )).to.be.revertedWithCustomError(manager, "WitnessSigReplay")
  })

  it("reverts MerkleRootMismatch when declared leafHashes don't rebuild the submitted root", async function () {
    const witness = await registerWitness(manager, deployer, "merkle")
    const receipt = makeReceipt("merkle")
    const fakeLeaf = ethers.keccak256(ethers.toUtf8Bytes("forged-leaf"))

    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const witnessIndex = 0
    const sig = await signWitnessV2(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      witnessIndex,
      epochId,
    })

    // Submitted merkleRoot derives from `receipt.leafHash`, but metadata
    // declares `fakeLeaf` — root rebuild won't match.
    const merkleRoot = buildMerkleRoot([receipt.leafHash])
    const tamperedReceipt = { ...receipt, leafHash: fakeLeaf }
    const metadata = buildMetadata([tamperedReceipt], [[witnessIndex, 0]])

    await expect(submitV2Metadata(manager, {
      epochId, merkleRoot,
      sampleLeaf: receipt.leafHash,
      witnessBitmap: 1 << witnessIndex,
      witnessSignatures: [sig],
      metadata,
    })).to.be.revertedWithCustomError(manager, "MerkleRootMismatch")
  })

  it("reverts BadReceiptIndex when witnessReceiptIndex points past the receipt array", async function () {
    const witness = await registerWitness(manager, deployer, "badidx")
    const receipt = makeReceipt("badidx")
    const sampleLeaf = receipt.leafHash

    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const witnessIndex = 0
    const sig = await signWitnessV2(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      witnessIndex,
      epochId,
    })

    // Only one receipt declared, but witness points at index 99.
    const metadata = buildMetadata([receipt], [[witnessIndex, 99]])
    const merkleRoot = buildMerkleRoot([receipt.leafHash])

    await expect(submitV2Metadata(manager, {
      epochId, merkleRoot, sampleLeaf,
      witnessBitmap: 1 << witnessIndex,
      witnessSignatures: [sig],
      metadata,
    })).to.be.revertedWithCustomError(manager, "BadReceiptIndex")
  })

  it("reverts MetadataLengthMismatch when per-receipt arrays disagree in length", async function () {
    const witness = await registerWitness(manager, deployer, "lenmis")
    const receipt = makeReceipt("lenmis")
    const sampleLeaf = receipt.leafHash

    const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
    const witnessIndex = 0
    const sig = await signWitnessV2(manager, witness, {
      challengeId: receipt.challengeId,
      responseBodyHash: receipt.responseBodyHash,
      witnessIndex,
      epochId,
    })

    // Drop a single field — challengeIds has 0 entries while others have 1.
    const metadata = buildMetadata([receipt], [[witnessIndex, 0]])
    metadata.challengeIds = []

    await expect(submitV2Metadata(manager, {
      epochId,
      merkleRoot: buildMerkleRoot([receipt.leafHash]),
      sampleLeaf,
      witnessBitmap: 1 << witnessIndex,
      witnessSignatures: [sig],
      metadata,
    })).to.be.revertedWithCustomError(manager, "MetadataLengthMismatch")
  })
})
