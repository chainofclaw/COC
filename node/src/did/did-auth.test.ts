import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildDIDAuthMessage,
  signDIDAuth,
  verifyDIDAuth,
  isDIDEnhanced,
  isDIDEnhancedP2P,
  verifyDIDPeer,
} from "./did-auth.ts"
import type { DIDHandshakePayload, DIDP2PAuthEnvelope } from "./did-auth.ts"
import { createNodeSigner } from "../crypto/signer.ts"
import type { DIDDataProvider } from "./did-resolver.ts"
import type { Hex32 } from "./did-types.ts"
import { DEFAULT_CHAIN_ID } from "./did-types.ts"
import { Wallet, keccak256 } from "ethers"

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

// --- buildDIDAuthMessage ---

describe("buildDIDAuthMessage", () => {
  it("formats canonical message", () => {
    const msg = buildDIDAuthMessage("did:coc:0xabc", "nonce123", 1710000000000n)
    assert.equal(msg, "did-auth:did:coc:0xabc:nonce123:1710000000000")
  })
})

// --- signDIDAuth / verifyDIDAuth ---

describe("signDIDAuth + verifyDIDAuth", () => {
  it("round-trips sign and verify", () => {
    const signer = createNodeSigner(TEST_PRIVATE_KEY)
    const did = `did:coc:${keccak256("0x01")}`
    const challenge = "test-challenge-123"
    const timestampMs = BigInt(Date.now())

    const response = signDIDAuth(did, challenge, timestampMs, signer)
    assert.equal(response.did, did)
    assert.equal(response.challenge, challenge)
    assert.ok(response.signature.startsWith("0x"))

    const valid = verifyDIDAuth(response, timestampMs, signer, signer.nodeId)
    assert.ok(valid)
  })

  it("rejects wrong address", () => {
    const signer = createNodeSigner(TEST_PRIVATE_KEY)
    const did = "did:coc:0xabc"
    const timestampMs = BigInt(Date.now())

    const response = signDIDAuth(did, "nonce", timestampMs, signer)
    const valid = verifyDIDAuth(response, timestampMs, signer, "0x0000000000000000000000000000000000000000")
    assert.ok(!valid)
  })
})

// --- isDIDEnhanced ---

describe("isDIDEnhanced", () => {
  it("returns true for DID-enhanced payload", () => {
    const payload: DIDHandshakePayload = {
      nodeId: "0x123",
      chainId: 18780,
      height: "100",
      did: "did:coc:0xabc",
    }
    assert.ok(isDIDEnhanced(payload))
  })

  it("returns false for standard payload", () => {
    const payload: DIDHandshakePayload = {
      nodeId: "0x123",
      chainId: 18780,
      height: "100",
    }
    assert.ok(!isDIDEnhanced(payload))
  })

  it("returns false for non-coc DID", () => {
    const payload: DIDHandshakePayload = {
      nodeId: "0x123",
      chainId: 18780,
      height: "100",
      did: "did:eth:0xabc",
    }
    assert.ok(!isDIDEnhanced(payload))
  })
})

// --- isDIDEnhancedP2P ---

describe("isDIDEnhancedP2P", () => {
  it("returns true for DID-enhanced envelope", () => {
    const envelope: DIDP2PAuthEnvelope = {
      path: "/p2p/block",
      senderId: "0x123",
      timestampMs: Date.now(),
      nonce: "abc",
      signature: "0x",
      did: "did:coc:0xabc",
    }
    assert.ok(isDIDEnhancedP2P(envelope))
  })

  it("returns false without DID", () => {
    const envelope: DIDP2PAuthEnvelope = {
      path: "/p2p/block",
      senderId: "0x123",
      timestampMs: Date.now(),
      nonce: "abc",
      signature: "0x",
    }
    assert.ok(!isDIDEnhancedP2P(envelope))
  })
})

// --- verifyDIDPeer ---

describe("verifyDIDPeer", () => {
  const AGENT_ID = "0x" + "ab".repeat(32) as Hex32
  const wallet = new Wallet(TEST_PRIVATE_KEY)
  const ownerAddress = wallet.address.toLowerCase()

  function makeProvider(): DIDDataProvider {
    return {
      async getSoul() {
        return {
          agentId: AGENT_ID,
          owner: ownerAddress,
          identityCid: "0x" + "11".repeat(32),
          latestSnapshotCid: "0x" + "22".repeat(32),
          registeredAt: 1710000000n,
          lastBackupAt: 0n,
          backupCount: 0,
          version: 1,
          active: true,
        }
      },
      async getGuardians() { return [] },
      async getResurrectionConfig() { return null },
    }
  }

  it("verifies valid DID peer", async () => {
    const signer = createNodeSigner(TEST_PRIVATE_KEY)
    const did = `did:coc:${AGENT_ID}`
    const challenge = "peer-challenge-456"
    const timestampMs = BigInt(Date.now())

    const message = `did-auth:${did}:${challenge}:${timestampMs.toString()}`
    const signature = signer.sign(message)

    const result = await verifyDIDPeer(
      did,
      signature,
      challenge,
      timestampMs,
      makeProvider(),
      signer,
      DEFAULT_CHAIN_ID,
    )

    assert.ok(result.verified)
    assert.equal(result.did, did)
    assert.equal(result.agentId, AGENT_ID.toLowerCase())
  })

  it("rejects invalid DID format", async () => {
    const signer = createNodeSigner(TEST_PRIVATE_KEY)
    const result = await verifyDIDPeer(
      "not-a-did",
      "0x123",
      "challenge",
      BigInt(Date.now()),
      makeProvider(),
      signer,
      DEFAULT_CHAIN_ID,
    )
    assert.ok(!result.verified)
    assert.ok(result.error?.includes("invalid DID"))
  })

  it("rejects unknown agent", async () => {
    const signer = createNodeSigner(TEST_PRIVATE_KEY)
    const nullProvider: DIDDataProvider = {
      async getSoul() { return null },
      async getGuardians() { return [] },
      async getResurrectionConfig() { return null },
    }

    const result = await verifyDIDPeer(
      `did:coc:${AGENT_ID}`,
      "0x123",
      "challenge",
      BigInt(Date.now()),
      nullProvider,
      signer,
      DEFAULT_CHAIN_ID,
    )
    assert.ok(!result.verified)
    assert.ok(result.error?.includes("notFound") || result.error?.includes("not found"))
  })

  it("rejects wrong signature", async () => {
    const signer = createNodeSigner(TEST_PRIVATE_KEY)
    const otherSigner = createNodeSigner("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
    const did = `did:coc:${AGENT_ID}`
    const challenge = "peer-challenge-789"
    const timestampMs = BigInt(Date.now())

    // Sign with a different key
    const message = `did-auth:${did}:${challenge}:${timestampMs.toString()}`
    const wrongSig = otherSigner.sign(message)

    const result = await verifyDIDPeer(
      did,
      wrongSig,
      challenge,
      timestampMs,
      makeProvider(),
      signer,
      DEFAULT_CHAIN_ID,
    )
    assert.ok(!result.verified)
    assert.ok(result.error?.includes("verification failed"))
  })
})
