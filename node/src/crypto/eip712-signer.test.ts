import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Wallet, verifyTypedData } from "ethers"
import { createEip712Signer } from "./eip712-signer.ts"
import {
  buildDomain,
  toEthersDomain,
  CHALLENGE_TYPES,
  RECEIPT_TYPES,
  WITNESS_TYPES,
  EVIDENCE_LEAF_TYPES,
  REWARD_LEAF_TYPES,
} from "./eip712-types.ts"
import { createNodeSignerV2 } from "./signer.ts"

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const TEST_CHAIN_ID = 20241224n
const TEST_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

function makeDomain() {
  return buildDomain(TEST_CHAIN_ID, TEST_CONTRACT)
}

describe("EIP-712 signer", () => {
  it("sign and verify Challenge roundtrip", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const signer = createEip712Signer(wallet, makeDomain())

    const challenge = {
      challengeId: "0x" + "ab".repeat(32),
      epochId: 100n,
      nodeId: "0x" + "cd".repeat(32),
      challengeType: 0,
      nonce: "0x" + "ef".repeat(16),
      challengeNonce: 42n,
      querySpecHash: "0x" + "11".repeat(32),
      issuedAtMs: BigInt(Date.now()),
      deadlineMs: BigInt(Date.now() + 5000),
      challengerId: "0x" + "22".repeat(32),
    }

    const sig = await signer.signTypedData(CHALLENGE_TYPES, challenge)
    assert.ok(sig.startsWith("0x"))
    assert.equal(sig.length, 132) // 65 bytes hex = 0x + 130

    const valid = signer.verifyTypedData(CHALLENGE_TYPES, challenge, sig, wallet.address)
    assert.ok(valid)
  })

  it("sign and verify Receipt roundtrip", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const signer = createEip712Signer(wallet, makeDomain())

    const receipt = {
      challengeId: "0x" + "ab".repeat(32),
      nodeId: "0x" + "cd".repeat(32),
      responseAtMs: BigInt(Date.now()),
      responseBodyHash: "0x" + "ff".repeat(32),
      tipHash: "0x" + "ee".repeat(32),
      tipHeight: 1000n,
    }

    const sig = await signer.signTypedData(RECEIPT_TYPES, receipt)
    const valid = signer.verifyTypedData(RECEIPT_TYPES, receipt, sig, wallet.address)
    assert.ok(valid)
  })

  it("sign and verify WitnessAttestation roundtrip", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const signer = createEip712Signer(wallet, makeDomain())

    const attestation = {
      challengeId: "0x" + "ab".repeat(32),
      nodeId: "0x" + "cd".repeat(32),
      responseBodyHash: "0x" + "ff".repeat(32),
      witnessIndex: 3,
    }

    const sig = await signer.signTypedData(WITNESS_TYPES, attestation)
    const valid = signer.verifyTypedData(WITNESS_TYPES, attestation, sig, wallet.address)
    assert.ok(valid)
  })

  it("sign and verify EvidenceLeaf roundtrip", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const signer = createEip712Signer(wallet, makeDomain())

    const leaf = {
      epoch: 100n,
      nodeId: "0x" + "cd".repeat(32),
      nonce: "0x" + "ef".repeat(16),
      tipHash: "0x" + "ee".repeat(32),
      tipHeight: 1000n,
      latencyMs: 250,
      resultCode: 0,
      witnessBitmap: 7, // 0b111
    }

    const sig = await signer.signTypedData(EVIDENCE_LEAF_TYPES, leaf)
    const valid = signer.verifyTypedData(EVIDENCE_LEAF_TYPES, leaf, sig, wallet.address)
    assert.ok(valid)
  })

  it("sign and verify RewardLeaf roundtrip", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const signer = createEip712Signer(wallet, makeDomain())

    const leaf = {
      epochId: 100n,
      nodeId: "0x" + "cd".repeat(32),
      amount: 1000000000000000000n, // 1 ETH
    }

    const sig = await signer.signTypedData(REWARD_LEAF_TYPES, leaf)
    const valid = signer.verifyTypedData(REWARD_LEAF_TYPES, leaf, sig, wallet.address)
    assert.ok(valid)
  })

  it("recover address from signature", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const signer = createEip712Signer(wallet, makeDomain())

    const challenge = {
      challengeId: "0x" + "ab".repeat(32),
      epochId: 1n,
      nodeId: "0x" + "cd".repeat(32),
      challengeType: 1,
      nonce: "0x" + "ef".repeat(16),
      challengeNonce: 0n,
      querySpecHash: "0x" + "11".repeat(32),
      issuedAtMs: 1000n,
      deadlineMs: 2000n,
      challengerId: "0x" + "22".repeat(32),
    }

    const sig = await signer.signTypedData(CHALLENGE_TYPES, challenge)
    const recovered = signer.recoverTypedData(CHALLENGE_TYPES, challenge, sig)
    assert.equal(recovered, wallet.address.toLowerCase())
  })

  it("rejects wrong domain", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const domain1 = buildDomain(1n, TEST_CONTRACT)
    const domain2 = buildDomain(2n, TEST_CONTRACT)
    const signer1 = createEip712Signer(wallet, domain1)
    const signer2 = createEip712Signer(wallet, domain2)

    const leaf = {
      epochId: 1n,
      nodeId: "0x" + "cd".repeat(32),
      amount: 100n,
    }

    const sig = await signer1.signTypedData(REWARD_LEAF_TYPES, leaf)
    // Verify with different domain should fail
    const valid = signer2.verifyTypedData(REWARD_LEAF_TYPES, leaf, sig, wallet.address)
    assert.equal(valid, false)
  })

  it("rejects wrong signer address", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const signer = createEip712Signer(wallet, makeDomain())
    const otherAddr = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

    const leaf = {
      epochId: 1n,
      nodeId: "0x" + "cd".repeat(32),
      amount: 100n,
    }

    const sig = await signer.signTypedData(REWARD_LEAF_TYPES, leaf)
    const valid = signer.verifyTypedData(REWARD_LEAF_TYPES, leaf, sig, otherAddr)
    assert.equal(valid, false)
  })

  it("cross-checks with raw ethers verifyTypedData", async () => {
    const wallet = new Wallet(TEST_PRIVATE_KEY)
    const domain = makeDomain()
    const signer = createEip712Signer(wallet, domain)

    const receipt = {
      challengeId: "0x" + "ab".repeat(32),
      nodeId: "0x" + "cd".repeat(32),
      responseAtMs: 1234567890n,
      responseBodyHash: "0x" + "ff".repeat(32),
      tipHash: "0x" + "ee".repeat(32),
      tipHeight: 500n,
    }

    const sig = await signer.signTypedData(RECEIPT_TYPES, receipt)

    // Direct ethers verification
    const recovered = verifyTypedData(
      toEthersDomain(domain),
      { ...RECEIPT_TYPES },
      receipt,
      sig,
    )
    assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase())
  })

  it("NodeSignerV2 creation and usage", async () => {
    const domain = makeDomain()
    const signerV2 = createNodeSignerV2(TEST_PRIVATE_KEY, domain)

    // v1 capabilities still work
    assert.ok(signerV2.nodeId.startsWith("0x"))
    const v1Sig = signerV2.sign("test message")
    assert.ok(v1Sig.startsWith("0x"))

    // v2 EIP-712 capabilities
    const leaf = {
      epochId: 1n,
      nodeId: "0x" + "cd".repeat(32),
      amount: 100n,
    }
    const sig = await signerV2.eip712.signTypedData(REWARD_LEAF_TYPES, leaf)
    const valid = signerV2.eip712.verifyTypedData(REWARD_LEAF_TYPES, leaf, sig, signerV2.nodeId)
    assert.ok(valid)
  })
})
