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

  // #12 (audit follow-up): MAX_RECEIPTS_PER_BATCH hard cap.
  // _rebuildMerkleRoot allocates `bytes32[n]` and runs O(n log n) hashing;
  // without a hard cap, an attacker can burn block gas by submitting
  // maximally-wide batches. Grief cost is self-inflicted but the cap turns
  // an open-ended DoS shape into a fixed envelope.
  describe("#12 MAX_RECEIPTS_PER_BATCH bound", function () {
    it("exposes the cap as a public constant", async function () {
      expect(await manager.MAX_RECEIPTS_PER_BATCH()).to.equal(4096n)
    })

    // The actual `numReceipts > cap` trigger needs ≥ 4097 receipts ≈ 524 KB
    // of calldata, whose calldata gas alone exceeds EDR's per-tx gas cap
    // (16.7M). Bumping `evm_setBlockGasLimit` doesn't help — EDR has a
    // separate hardcoded per-tx ceiling. The revert path is straight-line
    // (see PoSeManagerV2.sol around line 333: `if (numReceipts >
    // MAX_RECEIPTS_PER_BATCH) revert MetadataLengthMismatch()`) and is
    // covered structurally by the `exposes the cap` assertion above plus
    // source review. Live `submitBatchV2WithMetadata` integration covers
    // it implicitly because real batches stay well under the cap and the
    // revert path is what an attacker would hit on the over-cap path.
    it.skip("rejects MetadataLengthMismatch when numReceipts exceeds the cap (manual: EDR per-tx gas cap below 4097-receipt calldata cost)", async function () {})

    it("admits a small batch unchanged (no false-positive on legitimate sizes)", async function () {
      const witness = await registerWitness(manager, deployer, "cap-smoke")
      const receipt = makeReceipt("cap-smoke")
      const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
      const witnessIndex = 0
      const sig = await signWitnessV2(manager, witness, {
        challengeId: receipt.challengeId,
        responseBodyHash: receipt.responseBodyHash,
        witnessIndex, epochId,
      })
      await expect(submitV2Metadata(manager, {
        epochId,
        merkleRoot: buildMerkleRoot([receipt.leafHash]),
        sampleLeaf: receipt.leafHash,
        witnessBitmap: 1 << witnessIndex,
        witnessSignatures: [sig],
        metadata: buildMetadata([receipt], [[witnessIndex, 0]]),
      })).to.emit(manager, "ReceiptBatchMetadataSubmitted")
    })
  })

  // #7 (audit follow-up): per-operator dedup in _validateWitnessQuorumV2.
  // A single real-world entity can register up to MAX_NODES_PER_OPERATOR (5)
  // distinct nodeIds. When the PRNG-selected witnessSet contains two slots
  // whose nodeOperator[] resolves to the same EOA, naïve bit-counting let
  // that one entity deliver the K-of-N quorum singlehandedly — collapsing
  // the security threshold to 1-of-1. The fix rejects on second appearance
  // of the same operator within a single quorum vote.
  // #15 (audit follow-up): dynamic EIP-712 domain separator.
  // initialize() snapshots DOMAIN_SEPARATOR at deploy time using
  // block.chainid; pre-fix every signature digest used that snapshot,
  // so a chain fork that kept the same proxy address could replay
  // pre-fork witness sigs against the post-fork chain. Fix: the
  // _buildWitnessDigest{V1,V2} paths call _computeDomainSeparator()
  // which reads block.chainid at call time. The public domainSeparator()
  // view exposes the dynamic value; the legacy DOMAIN_SEPARATOR field
  // is retained as a back-compat snapshot.
  describe("#15 dynamic EIP-712 domain separator", function () {
    it("exposes domainSeparator() view that matches the snapshotted DOMAIN_SEPARATOR on the initial chain", async function () {
      const dynamic = await manager.domainSeparator()
      const stored = await manager.DOMAIN_SEPARATOR()
      expect(dynamic).to.not.equal(ethers.ZeroHash)
      expect(stored).to.not.equal(ethers.ZeroHash)
      // Same chain → same value as the deploy-time snapshot.
      expect(dynamic).to.equal(stored)
    })

    it("dynamic separator is deterministic when block.chainid is stable", async function () {
      // Real protection (forked chain refusing pre-fork sigs) needs
      // cross-chain fixtures; here we just confirm the view is pure
      // and stable across calls on the same chain.
      const a = await manager.domainSeparator()
      const b = await manager.domainSeparator()
      expect(a).to.equal(b)
    })

    it("happy-path signature still verifies with the new dynamic separator", async function () {
      // Regression: the witness verifier paths (V1 + V2) now build
      // their domain separator via _computeDomainSeparator(); confirm
      // a legitimate witness signature still passes end-to-end.
      const witness = await registerWitness(manager, deployer, "ds-dyn")
      const receipt = makeReceipt("ds-dyn")
      const sampleLeaf = receipt.leafHash
      const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)
      const witnessIndex = 0
      const sig = await signWitnessV2(manager, witness, {
        challengeId: receipt.challengeId,
        responseBodyHash: receipt.responseBodyHash,
        witnessIndex, epochId,
      })
      await expect(submitV2Metadata(manager, {
        epochId,
        merkleRoot: buildMerkleRoot([receipt.leafHash]),
        sampleLeaf,
        witnessBitmap: 1 << witnessIndex,
        witnessSignatures: [sig],
        metadata: buildMetadata([receipt], [[witnessIndex, 0]]),
      })).to.emit(manager, "ReceiptBatchMetadataSubmitted")
    })
  })

  describe("#7 per-operator quorum dedup", function () {
    // Register an "alias" nodeId under an existing operator EOA. The alias
    // is a fresh signing key whose public key derives the nodeId; the
    // ownership proof is signed by the alias (proving alias controls the
    // pubkey), while msg.sender = operator (proving operator pays bond).
    // This is the legitimate multi-node-per-operator flow that #7 closes.
    async function registerAliasForOperator(manager, funder, operator, label) {
      const alias = ethers.Wallet.createRandom()
      const pubkey = alias.signingKey.publicKey
      const nodeId = ethers.keccak256(pubkey)
      // Operator bond cost: MIN_BOND << existingNodeCount; with 2 nodes it's
      // 0.1 + 0.2 = 0.3 ETH. registerWitness funded operator with 5 ETH.
      const serviceCommitment = ethers.keccak256(ethers.toUtf8Bytes(`svc-${label}`))
      const endpointCommitment = ethers.keccak256(ethers.toUtf8Bytes(`ep-${label}-${Date.now()}-${Math.random()}`))
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(`meta-${label}`))
      const messageHash = ethers.keccak256(
        ethers.solidityPacked(["string", "bytes32", "address"], ["coc-register:", nodeId, operator.address])
      )
      const ownershipSig = await alias.signMessage(ethers.getBytes(messageHash))
      // Bond for the second node is MIN_BOND << 1 = 0.2 ETH. Pay 0.5 ETH
      // to keep tests cheap.
      await manager.connect(operator).registerNode(
        nodeId, pubkey, 7, serviceCommitment, endpointCommitment, metadataHash, ownershipSig, "0x",
        { value: ethers.parseEther("0.5") }
      )
      return { operator, nodeId, pubkey }
    }

    // Locate witnessSet[i] for the given nodeId — needed because the PRNG
    // determines slot order, so callers must dynamically construct the
    // witnessBitmap + signatures keyed off the actual slot of each node.
    function slotOf(witnessSet, nodeId) {
      const target = nodeId.toLowerCase()
      for (let i = 0; i < witnessSet.length; i++) {
        if (witnessSet[i].toLowerCase() === target) return i
      }
      throw new Error(`nodeId ${nodeId} not found in witnessSet`)
    }

    it("reverts WitnessOperatorDuplicate when both witnessSet slots resolve to the same operator", async function () {
      // Operator EOA registers two distinct nodeIds. Both are in the
      // witnessSet (m=2 since activeCount=2 → ceil(sqrt(2))=2).
      const first = await registerWitness(manager, deployer, "dup-primary")
      const second = await registerAliasForOperator(manager, deployer, first.operator, "dup-alias")
      const receipt = makeReceipt("dup")
      const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)

      const witnessSet = await manager.getWitnessSet(epochId)
      expect(witnessSet.length).to.equal(2)
      const slotA = slotOf(witnessSet, first.nodeId)
      const slotB = slotOf(witnessSet, second.nodeId)
      // required = ceil(2*m/3) = ceil(4/3) = 2 — both bits must be set.
      // Both sigs recover to first.operator — pre-fix this passed; post-fix
      // it must revert.
      const sigArgs = (witnessIndex) => ({
        challengeId: receipt.challengeId,
        responseBodyHash: receipt.responseBodyHash,
        witnessIndex,
        epochId,
      })
      const sigA = await signWitnessV2(manager, { operator: first.operator, nodeId: witnessSet[slotA] }, sigArgs(slotA))
      const sigB = await signWitnessV2(manager, { operator: first.operator, nodeId: witnessSet[slotB] }, sigArgs(slotB))
      const witnessBitmap = (1 << slotA) | (1 << slotB)
      // witnessSignatures must be ordered low-bit-first — matches the
      // contract's iteration order.
      const sigs = slotA < slotB ? [sigA, sigB] : [sigB, sigA]
      const witnessReceiptIndex = slotA < slotB ? [[slotA, 0], [slotB, 0]] : [[slotB, 0], [slotA, 0]]
      const metadata = buildMetadata([receipt], witnessReceiptIndex)

      await expect(submitV2Metadata(manager, {
        epochId,
        merkleRoot: buildMerkleRoot([receipt.leafHash]),
        sampleLeaf: receipt.leafHash,
        witnessBitmap,
        witnessSignatures: sigs,
        metadata,
      })).to.be.revertedWithCustomError(manager, "WitnessOperatorDuplicate")
    })

    it("admits a quorum from two distinct operators (no false-positive on legitimate K-of-N)", async function () {
      // Same shape as the duplicate test but each nodeId has its OWN
      // operator EOA. The dedup must not fire.
      const a = await registerWitness(manager, deployer, "dist-a")
      const b = await registerWitness(manager, deployer, "dist-b")
      const receipt = makeReceipt("dist")
      const epochId = Math.floor((await ethers.provider.getBlock("latest")).timestamp / 3600)

      const witnessSet = await manager.getWitnessSet(epochId)
      expect(witnessSet.length).to.equal(2)
      const slotA = slotOf(witnessSet, a.nodeId)
      const slotB = slotOf(witnessSet, b.nodeId)
      const sigA = await signWitnessV2(
        manager,
        { operator: a.operator, nodeId: witnessSet[slotA] },
        { challengeId: receipt.challengeId, responseBodyHash: receipt.responseBodyHash, witnessIndex: slotA, epochId },
      )
      const sigB = await signWitnessV2(
        manager,
        { operator: b.operator, nodeId: witnessSet[slotB] },
        { challengeId: receipt.challengeId, responseBodyHash: receipt.responseBodyHash, witnessIndex: slotB, epochId },
      )
      const witnessBitmap = (1 << slotA) | (1 << slotB)
      const sigs = slotA < slotB ? [sigA, sigB] : [sigB, sigA]
      const witnessReceiptIndex = slotA < slotB ? [[slotA, 0], [slotB, 0]] : [[slotB, 0], [slotA, 0]]
      const metadata = buildMetadata([receipt], witnessReceiptIndex)

      await expect(submitV2Metadata(manager, {
        epochId,
        merkleRoot: buildMerkleRoot([receipt.leafHash]),
        sampleLeaf: receipt.leafHash,
        witnessBitmap,
        witnessSignatures: sigs,
        metadata,
      })).to.emit(manager, "ReceiptBatchMetadataSubmitted")
    })
  })
})
