/**
 * EIP-712 Cross-Check Tests
 *
 * Verifies that TypeScript (ethers.TypedDataEncoder) and Solidity (PoSeTypesV2)
 * produce identical EIP-712 hashes for the same inputs.
 */

const { expect } = require("chai")
const { ethers } = require("hardhat")

const DOMAIN_NAME = "COCPoSe"
const DOMAIN_VERSION = "2"

// Mirror of node/src/crypto/eip712-types.ts
const EVIDENCE_LEAF_TYPES = {
  EvidenceLeaf: [
    { name: "epoch", type: "uint64" },
    { name: "nodeId", type: "bytes32" },
    { name: "nonce", type: "bytes16" },
    { name: "tipHash", type: "bytes32" },
    { name: "tipHeight", type: "uint64" },
    { name: "latencyMs", type: "uint32" },
    { name: "resultCode", type: "uint8" },
    { name: "witnessBitmap", type: "uint32" },
  ],
}

const REWARD_LEAF_TYPES = {
  RewardLeaf: [
    { name: "epochId", type: "uint64" },
    { name: "nodeId", type: "bytes32" },
    { name: "amount", type: "uint256" },
  ],
}

const WITNESS_TYPES = {
  WitnessAttestation: [
    { name: "challengeId", type: "bytes32" },
    { name: "nodeId", type: "bytes32" },
    { name: "responseBodyHash", type: "bytes32" },
    { name: "witnessIndex", type: "uint8" },
  ],
}

describe("EIP-712 Cross-Check (TS ↔ Solidity)", function () {
  let harness
  let domain
  const chainId = 31337 // Hardhat default

  beforeEach(async function () {
    const Factory = await ethers.getContractFactory("Eip712Harness")
    harness = await Factory.deploy()
    await harness.waitForDeployment()
    const harnessAddr = await harness.getAddress()

    await harness.setDomainSeparator(chainId, harnessAddr)

    domain = {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId,
      verifyingContract: harnessAddr,
    }
  })

  it("DOMAIN_SEPARATOR matches ethers TypedDataEncoder", async function () {
    const solDomain = await harness.DOMAIN_SEPARATOR()

    // ethers computes the domain separator internally; extract it via hashDomain
    const tsDomain = ethers.TypedDataEncoder.hashDomain(domain)

    expect(solDomain).to.equal(tsDomain)
  })

  it("EVIDENCE_LEAF_TYPEHASH matches", async function () {
    const solTypeHash = await harness.evidenceLeafTypeHash()

    // Manually compute the same string Solidity uses
    const expected = ethers.keccak256(
      ethers.toUtf8Bytes(
        "EvidenceLeaf(uint64 epoch,bytes32 nodeId,bytes16 nonce,bytes32 tipHash,uint64 tipHeight,uint32 latencyMs,uint8 resultCode,uint32 witnessBitmap)"
      )
    )
    expect(solTypeHash).to.equal(expected)
  })

  it("REWARD_LEAF_TYPEHASH matches", async function () {
    const solTypeHash = await harness.rewardLeafTypeHash()
    const expected = ethers.keccak256(
      ethers.toUtf8Bytes("RewardLeaf(uint64 epochId,bytes32 nodeId,uint256 amount)")
    )
    expect(solTypeHash).to.equal(expected)
  })

  it("WITNESS_TYPEHASH matches", async function () {
    const solTypeHash = await harness.witnessTypeHash()
    const expected = ethers.keccak256(
      ethers.toUtf8Bytes(
        "WitnessAttestation(bytes32 challengeId,bytes32 nodeId,bytes32 responseBodyHash,uint8 witnessIndex)"
      )
    )
    expect(solTypeHash).to.equal(expected)
  })

  it("EvidenceLeaf structHash matches", async function () {
    const leaf = {
      epoch: 42,
      nodeId: ethers.keccak256(ethers.toUtf8Bytes("node-1")),
      nonce: "0x" + "ab".repeat(16),
      tipHash: ethers.keccak256(ethers.toUtf8Bytes("tip")),
      tipHeight: 100,
      latencyMs: 150,
      resultCode: 0,
      witnessBitmap: 7,
    }

    const solHash = await harness.hashEvidenceLeaf(
      leaf.epoch, leaf.nodeId, leaf.nonce, leaf.tipHash,
      leaf.tipHeight, leaf.latencyMs, leaf.resultCode, leaf.witnessBitmap
    )

    const tsHash = ethers.TypedDataEncoder.hashStruct(
      "EvidenceLeaf", EVIDENCE_LEAF_TYPES, leaf
    )

    expect(solHash).to.equal(tsHash)
  })

  it("RewardLeaf structHash matches", async function () {
    const leaf = {
      epochId: 7,
      nodeId: ethers.keccak256(ethers.toUtf8Bytes("node-2")),
      amount: ethers.parseEther("1.5"),
    }

    const solHash = await harness.hashRewardLeaf(leaf.epochId, leaf.nodeId, leaf.amount)
    const tsHash = ethers.TypedDataEncoder.hashStruct("RewardLeaf", REWARD_LEAF_TYPES, leaf)

    expect(solHash).to.equal(tsHash)
  })

  it("WitnessAttestation structHash matches", async function () {
    const att = {
      challengeId: ethers.keccak256(ethers.toUtf8Bytes("challenge-1")),
      nodeId: ethers.keccak256(ethers.toUtf8Bytes("node-3")),
      responseBodyHash: ethers.keccak256(ethers.toUtf8Bytes("body")),
      witnessIndex: 2,
    }

    const solHash = await harness.hashWitnessAttestation(
      att.challengeId, att.nodeId, att.responseBodyHash, att.witnessIndex
    )
    const tsHash = ethers.TypedDataEncoder.hashStruct(
      "WitnessAttestation", WITNESS_TYPES, att
    )

    expect(solHash).to.equal(tsHash)
  })

  it("full EIP-712 digest matches (sign + recover roundtrip)", async function () {
    const [signer] = await ethers.getSigners()

    const leaf = {
      challengeId: ethers.keccak256(ethers.toUtf8Bytes("chal-rt")),
      nodeId: ethers.keccak256(ethers.toUtf8Bytes("node-rt")),
      responseBodyHash: ethers.keccak256(ethers.toUtf8Bytes("resp-rt")),
      witnessIndex: 0,
    }

    // TypeScript: sign typed data
    const sig = await signer.signTypedData(domain, WITNESS_TYPES, leaf)

    // TypeScript: compute digest
    const tsDigest = ethers.TypedDataEncoder.hash(domain, WITNESS_TYPES, leaf)

    // Solidity: compute digest
    const structHash = await harness.hashWitnessAttestation(
      leaf.challengeId, leaf.nodeId, leaf.responseBodyHash, leaf.witnessIndex
    )
    const solDigest = await harness.eip712Digest(structHash)

    expect(solDigest).to.equal(tsDigest)

    // Verify recovered address matches signer
    const recovered = ethers.verifyTypedData(domain, WITNESS_TYPES, leaf, sig)
    expect(recovered.toLowerCase()).to.equal(signer.address.toLowerCase())
  })
})
