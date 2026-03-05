import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Wallet } from "ethers"
import { ChallengeFactoryV2 } from "./challenge-factory-v2.ts"
import { createEip712Signer } from "../../node/src/crypto/eip712-signer.ts"
import { buildDomain, CHALLENGE_TYPES } from "../../node/src/crypto/eip712-types.ts"
import type { Hex32 } from "../common/pose-types.ts"

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const CHAIN_ID = 20241224n
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3"

describe("ChallengeFactoryV2", () => {
  it("issues a v2 challenge with EIP-712 signature", async () => {
    const wallet = new Wallet(TEST_KEY)
    const domain = buildDomain(CHAIN_ID, CONTRACT)
    const eip712Signer = createEip712Signer(wallet, domain)
    const challengerId = `0x${wallet.address.slice(2).toLowerCase().padStart(64, "0")}` as Hex32

    const factory = new ChallengeFactoryV2({
      challengerId,
      eip712Signer,
    })

    const challenge = await factory.issue({
      epochId: 100n,
      nodeId: `0x${"ab".repeat(32)}` as Hex32,
      challengeType: "Uptime",
      issuedAtMs: BigInt(Date.now()),
      querySpec: { type: "ping" },
      challengeNonce: 42n,
    })

    assert.equal(challenge.version, 2)
    assert.ok(challenge.challengeId.startsWith("0x"))
    assert.equal(challenge.challengeId.length, 66)
    assert.ok(challenge.challengerSig.startsWith("0x"))
    assert.equal(challenge.challengerSig.length, 132)
    assert.equal(challenge.challengeType, "U")
    assert.equal(challenge.deadlineMs, 2500)
    assert.equal(challenge.challengeNonce, 42n)
    assert.ok(challenge.querySpecHash.startsWith("0x"))
  })

  it("verifies the signature roundtrip", async () => {
    const wallet = new Wallet(TEST_KEY)
    const domain = buildDomain(CHAIN_ID, CONTRACT)
    const eip712Signer = createEip712Signer(wallet, domain)
    const challengerId = `0x${wallet.address.slice(2).toLowerCase().padStart(64, "0")}` as Hex32

    const factory = new ChallengeFactoryV2({ challengerId, eip712Signer })

    const challenge = await factory.issue({
      epochId: 50n,
      nodeId: `0x${"cd".repeat(32)}` as Hex32,
      challengeType: "Storage",
      issuedAtMs: 1000n,
      querySpec: { cid: "QmTest" },
      challengeNonce: 7n,
    })

    // Verify signature
    const challengeTypeNum = challenge.challengeType === "U" ? 0 : challenge.challengeType === "S" ? 1 : 2
    const challengeData = {
      challengeId: challenge.challengeId,
      epochId: challenge.epochId,
      nodeId: challenge.nodeId,
      challengeType: challengeTypeNum,
      nonce: challenge.nonce,
      challengeNonce: challenge.challengeNonce,
      querySpecHash: challenge.querySpecHash,
      issuedAtMs: challenge.issuedAtMs,
      deadlineMs: BigInt(challenge.deadlineMs),
      challengerId: challenge.challengerId,
    }

    const valid = eip712Signer.verifyTypedData(
      CHALLENGE_TYPES,
      challengeData as unknown as Record<string, unknown>,
      challenge.challengerSig,
      wallet.address,
    )
    assert.ok(valid)
  })

  it("Storage challenge has 6s deadline", async () => {
    const wallet = new Wallet(TEST_KEY)
    const domain = buildDomain(CHAIN_ID, CONTRACT)
    const eip712Signer = createEip712Signer(wallet, domain)
    const challengerId = `0x${"00".repeat(32)}` as Hex32

    const factory = new ChallengeFactoryV2({ challengerId, eip712Signer })
    const challenge = await factory.issue({
      epochId: 1n,
      nodeId: `0x${"ab".repeat(32)}` as Hex32,
      challengeType: "Storage",
      issuedAtMs: 1n,
      querySpec: {},
      challengeNonce: 0n,
    })

    assert.equal(challenge.deadlineMs, 6000)
    assert.equal(challenge.challengeType, "S")
  })
})
