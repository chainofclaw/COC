import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { handleRpcMethod, jsonStringify } from "../rpc.ts"
import type { OnChainCredentialAnchorResult, DelegationRecord } from "./did-data-provider.ts"

// Minimal stubs for EVM/chain/P2P — DID RPCs don't touch these
const stubEvm = {} as any
const stubChain = { getHeight: () => 0n, mempool: { stats: () => ({}) } } as any
const stubP2p = {} as any
const CHAIN_ID = 20241224

// Mock DID resolver and data provider
function createMockDidOpts() {
  const mockProvider = {
    getCapabilities: async () => 0x0007, // storage + compute + validation
    getFullDelegations: async () => [{
      delegationId: "0x" + "dd".repeat(32),
      delegator: "0x" + "aa".repeat(32),
      delegatee: "0x" + "bb".repeat(32),
      parentDelegation: "0x" + "00".repeat(32),
      scopeHash: "0x" + "cc".repeat(32),
      issuedAt: 1000,
      expiresAt: 2000,
      depth: 1,
      revoked: false,
    }] as DelegationRecord[],
    getLineage: async () => ({
      parentAgentId: "0x" + "ee".repeat(32),
      forkHeight: 100n,
      generation: 2,
    }),
    getVerificationMethods: async () => [{
      keyId: "0x" + "ff".repeat(32),
      keyAddress: "0x" + "11".repeat(20),
      keyPurpose: 3,
      addedAt: 500n,
      revokedAt: 0n,
      active: true,
    }],
    getCredentialAnchor: async (id: string): Promise<OnChainCredentialAnchorResult> => {
      if (id === "0x" + "99".repeat(32)) {
        return { valid: true, anchor: {
          credentialHash: "0x" + "88".repeat(32),
          issuerAgentId: "0x" + "aa".repeat(32),
          subjectAgentId: "0x" + "bb".repeat(32),
          credentialCid: "0x" + "77".repeat(32),
          issuedAt: 1000, expiresAt: 9999999999, revoked: false,
        }}
      }
      return { valid: false, error: "credential not found" }
    },
  }

  const mockResolver = {
    resolve: async (did: string) => ({
      didDocument: { "@context": ["https://www.w3.org/ns/did/v1"], id: did },
      didResolutionMetadata: { contentType: "application/did+json" },
      didDocumentMetadata: { created: "2026-01-01T00:00:00Z" },
    }),
  }

  return {
    didResolver: mockResolver,
    didDataProvider: mockProvider,
  }
}

describe("DID RPC methods via handleRpcMethod", () => {
  const opts = createMockDidOpts()

  it("coc_resolveDid returns DIDResolutionResult", async () => {
    const result = await handleRpcMethod(
      "coc_resolveDid", ["did:coc:0xtest"],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as any
    assert.ok(result.didDocument)
    assert.equal(result.didDocument.id, "did:coc:0xtest")
    assert.ok(result.didResolutionMetadata)
  })

  it("coc_getDIDDocument returns DIDDocument, not DIDResolutionResult", async () => {
    const result = await handleRpcMethod(
      "coc_getDIDDocument", ["0xtest"],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as any
    assert.equal(result.id, "did:coc:0xtest")
    // Should NOT have didResolutionMetadata at top level
    assert.equal(result.didResolutionMetadata, undefined)
  })

  it("coc_getAgentCapabilities returns { capabilities, bitmask }", async () => {
    const result = await handleRpcMethod(
      "coc_getAgentCapabilities", ["0x" + "aa".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as any
    assert.ok(Array.isArray(result.capabilities))
    assert.equal(typeof result.bitmask, "number")
    assert.equal(result.bitmask, 7)
    assert.ok(result.capabilities.includes("storage"))
  })

  it("coc_getDelegations returns DelegationRecord[]", async () => {
    const result = await handleRpcMethod(
      "coc_getDelegations", ["0x" + "aa".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as DelegationRecord[]
    assert.ok(Array.isArray(result))
    assert.equal(result.length, 1)
    assert.equal(result[0].delegationId, "0x" + "dd".repeat(32))
    assert.equal(typeof result[0].issuedAt, "number")
    assert.equal(typeof result[0].revoked, "boolean")
  })

  it("coc_getAgentLineage returns lineage with bigint serialized", async () => {
    const result = await handleRpcMethod(
      "coc_getAgentLineage", ["0x" + "aa".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as any
    assert.ok(result)
    assert.equal(result.parentAgentId, "0x" + "ee".repeat(32))
    // bigint fields — verify they exist (JSON serialization handled by rpc response layer)
    assert.ok("forkHeight" in result)
    assert.equal(result.generation, 2)
  })

  it("coc_getVerificationMethods returns array", async () => {
    const result = await handleRpcMethod(
      "coc_getVerificationMethods", ["0x" + "aa".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as any[]
    assert.ok(Array.isArray(result))
    assert.equal(result.length, 1)
    assert.equal(result[0].keyAddress, "0x" + "11".repeat(20))
    assert.equal(result[0].keyPurpose, 3)
    assert.equal(result[0].active, true)
  })

  it("coc_getCredentialAnchor returns { valid, error?, anchor? }", async () => {
    // Valid anchor
    const valid = await handleRpcMethod(
      "coc_getCredentialAnchor", ["0x" + "99".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as OnChainCredentialAnchorResult
    assert.equal(valid.valid, true)
    assert.ok(valid.anchor)
    assert.equal(valid.anchor!.issuerAgentId, "0x" + "aa".repeat(32))

    // Not found
    const notFound = await handleRpcMethod(
      "coc_getCredentialAnchor", ["0x" + "00".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as OnChainCredentialAnchorResult
    assert.equal(notFound.valid, false)
    assert.equal(notFound.error, "credential not found")
  })

  it("bigint fields serialize as hex strings through jsonStringify", async () => {
    // coc_getAgentLineage returns bigint forkHeight
    const lineage = await handleRpcMethod(
      "coc_getAgentLineage", ["0x" + "aa".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as { forkHeight: bigint; generation: number; parentAgentId: string }

    // In-memory result has real bigint
    assert.equal(typeof lineage.forkHeight, "bigint")

    // After jsonStringify (what goes over the wire), bigints become hex strings
    const serialized = jsonStringify(lineage)
    const wireShape = JSON.parse(serialized)
    assert.equal(typeof wireShape.forkHeight, "string")
    assert.equal(wireShape.forkHeight, "0x64") // 100 in hex
    assert.equal(wireShape.generation, 2) // small numbers stay as numbers
    assert.equal(wireShape.parentAgentId, "0x" + "ee".repeat(32))
  })

  it("coc_getVerificationMethods bigint timestamps serialize as hex", async () => {
    const methods = await handleRpcMethod(
      "coc_getVerificationMethods", ["0x" + "aa".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as Array<{ addedAt: bigint; revokedAt: bigint; keyAddress: string }>

    assert.equal(typeof methods[0].addedAt, "bigint")

    const wireShape = JSON.parse(jsonStringify(methods)) as Array<Record<string, unknown>>
    assert.equal(typeof wireShape[0].addedAt, "string")
    assert.equal(wireShape[0].addedAt, "0x1f4") // 500 in hex
    assert.equal(wireShape[0].revokedAt, "0x0")
    assert.equal(wireShape[0].keyAddress, "0x" + "11".repeat(20)) // addresses unchanged
  })

  it("coc_getCredentialAnchor wire shape: hex bytes32 + number timestamps", async () => {
    const result = await handleRpcMethod(
      "coc_getCredentialAnchor", ["0x" + "99".repeat(32)],
      CHAIN_ID, stubEvm, stubChain, stubP2p, undefined, opts,
    ) as OnChainCredentialAnchorResult

    // In-memory: issuedAt/expiresAt are plain numbers (provider uses Number())
    assert.equal(typeof result.anchor!.issuedAt, "number")
    assert.equal(typeof result.anchor!.expiresAt, "number")
    assert.equal(typeof result.anchor!.revoked, "boolean")
    assert.equal(typeof result.anchor!.credentialHash, "string")

    // Wire shape: JSON round-trip should preserve number timestamps (not hex-encode them)
    const wire = JSON.parse(jsonStringify(result)) as any
    assert.equal(wire.valid, true)
    assert.equal(wire.anchor.issuedAt, 1000)        // stays as number
    assert.equal(wire.anchor.expiresAt, 9999999999) // stays as number
    assert.equal(wire.anchor.revoked, false)
    assert.equal(wire.anchor.credentialHash, "0x" + "88".repeat(32))
    assert.equal(wire.anchor.issuerAgentId, "0x" + "aa".repeat(32))
  })

  it("_readError flag appears in DelegationRecord type + wire shape", async () => {
    // Verify at the type level (TS will fail compile if _readError is missing from type)
    const errorRecord: DelegationRecord = {
      delegationId: "0x" + "ee".repeat(32),
      delegator: "", delegatee: "", parentDelegation: "", scopeHash: "",
      issuedAt: 0, expiresAt: 0, depth: 0, revoked: false,
      _readError: true,
    }
    assert.equal(errorRecord._readError, true)

    // Verify it round-trips through JSON serialization
    const wire = JSON.parse(jsonStringify(errorRecord))
    assert.equal(wire._readError, true)
    assert.equal(wire.delegator, "")
  })

  it("DID RPCs throw when resolver not configured", async () => {
    await assert.rejects(
      () => handleRpcMethod("coc_resolveDid", ["did:coc:0x1"], CHAIN_ID, stubEvm, stubChain, stubP2p),
      { message: /DID resolver not configured/ },
    )
    await assert.rejects(
      () => handleRpcMethod("coc_getAgentCapabilities", ["0x1"], CHAIN_ID, stubEvm, stubChain, stubP2p),
      { message: /DID data provider not configured/ },
    )
  })
})
