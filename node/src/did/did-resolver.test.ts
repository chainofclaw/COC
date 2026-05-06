import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createDIDResolver, parseDID, formatDID } from "./did-resolver.ts"
import type { DIDDataProvider } from "./did-resolver.ts"
import type { SoulIdentityData, GuardianData, ResurrectionConfigData } from "./did-document-builder.ts"
import type { Hex32 } from "./did-types.ts"
import { DEFAULT_CHAIN_ID } from "./did-types.ts"

const ZERO32 = "0x" + "00".repeat(32)
const AGENT_ID = "0x" + "ab".repeat(32) as Hex32
const OWNER = "0x1234567890abcdef1234567890abcdef12345678"

function makeSoul(overrides?: Partial<SoulIdentityData>): SoulIdentityData {
  return {
    agentId: AGENT_ID,
    owner: OWNER,
    identityCid: "0x" + "11".repeat(32),
    latestSnapshotCid: "0x" + "22".repeat(32),
    registeredAt: 1710000000n,
    lastBackupAt: 1710086400n,
    backupCount: 3,
    version: 1,
    active: true,
    ...overrides,
  }
}

function makeProvider(soul: SoulIdentityData | null, guardians?: GuardianData[]): DIDDataProvider {
  return {
    async getSoul(_agentId: Hex32) { return soul },
    async getGuardians(_agentId: Hex32) { return guardians ?? [] },
    async getResurrectionConfig(_agentId: Hex32) { return null },
  }
}

// --- parseDID ---

describe("parseDID", () => {
  it("parses simple did:coc:<agentId>", () => {
    const result = parseDID(`did:coc:${AGENT_ID}`)
    assert.ok(result)
    assert.equal(result.method, "coc")
    assert.equal(result.chainId, DEFAULT_CHAIN_ID)
    assert.equal(result.identifierType, "agent")
    assert.equal(result.identifier, AGENT_ID.toLowerCase())
  })

  it("parses did:coc:<chainId>:<agentId>", () => {
    const result = parseDID(`did:coc:18780:${AGENT_ID}`)
    assert.ok(result)
    assert.equal(result.chainId, 18780)
    assert.equal(result.identifier, AGENT_ID.toLowerCase())
  })

  it("parses did:coc:<chainId>:agent:<agentId>", () => {
    const result = parseDID(`did:coc:18780:agent:${AGENT_ID}`)
    assert.ok(result)
    assert.equal(result.chainId, 18780)
    assert.equal(result.identifierType, "agent")
  })

  it("parses did:coc:<chainId>:node:<nodeId>", () => {
    const result = parseDID(`did:coc:18780:node:${AGENT_ID}`)
    assert.ok(result)
    assert.equal(result.identifierType, "node")
  })

  it("returns null for invalid DID format", () => {
    assert.equal(parseDID("did:eth:0x123"), null)
    assert.equal(parseDID("did:coc:"), null)
    assert.equal(parseDID("not-a-did"), null)
    assert.equal(parseDID("did:coc:0:0xabc"), null) // chainId=0 invalid
  })

  it("returns null for non-hex identifier", () => {
    assert.equal(parseDID("did:coc:not-hex"), null)
    assert.equal(parseDID("did:coc:0xZZZZ"), null)
  })
})

// --- formatDID ---

describe("formatDID", () => {
  it("formats with default chainId (omitted)", () => {
    const did = formatDID(AGENT_ID)
    assert.equal(did, `did:coc:${AGENT_ID.toLowerCase()}`)
  })

  it("formats with default chainId explicitly (omitted)", () => {
    const did = formatDID(AGENT_ID, DEFAULT_CHAIN_ID)
    assert.equal(did, `did:coc:${AGENT_ID.toLowerCase()}`)
  })

  it("formats with non-default chainId", () => {
    const did = formatDID(AGENT_ID, 18780)
    assert.equal(did, `did:coc:18780:${AGENT_ID.toLowerCase()}`)
  })
})

// --- createDIDResolver ---

describe("createDIDResolver", () => {
  it("resolves active soul to DID document", async () => {
    const provider = makeProvider(makeSoul())
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve(`did:coc:${AGENT_ID}`)

    assert.ok(result.didDocument)
    assert.equal(result.didResolutionMetadata.error, undefined)
    assert.ok(result.didDocument.id.includes(AGENT_ID.toLowerCase()))
    assert.ok(result.didDocument.verificationMethod)
    assert.ok(result.didDocument.verificationMethod.length > 0)
    assert.equal(result.didDocumentMetadata.deactivated, false)
  })

  it("returns notFound for unknown agent", async () => {
    const provider = makeProvider(null)
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve(`did:coc:${AGENT_ID}`)

    assert.equal(result.didDocument, null)
    assert.equal(result.didResolutionMetadata.error, "notFound")
  })

  it("returns deactivated document for inactive soul", async () => {
    const provider = makeProvider(makeSoul({ active: false }))
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve(`did:coc:${AGENT_ID}`)

    assert.ok(result.didDocument)
    assert.deepStrictEqual(result.didDocument.verificationMethod, [])
    assert.equal(result.didDocumentMetadata.deactivated, true)
  })

  it("returns invalidDid for malformed DID", async () => {
    const provider = makeProvider(makeSoul())
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve("did:eth:0x123")

    assert.equal(result.didDocument, null)
    assert.equal(result.didResolutionMetadata.error, "invalidDid")
  })

  it("returns methodNotSupported for wrong chainId", async () => {
    const provider = makeProvider(makeSoul())
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve(`did:coc:99999:${AGENT_ID}`)

    assert.equal(result.didDocument, null)
    assert.equal(result.didResolutionMetadata.error, "methodNotSupported")
  })

  it("returns methodNotSupported for node type (Phase 2)", async () => {
    const provider = makeProvider(makeSoul())
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve(`did:coc:${DEFAULT_CHAIN_ID}:node:${AGENT_ID}`)

    assert.equal(result.didDocument, null)
    assert.equal(result.didResolutionMetadata.error, "methodNotSupported")
  })

  it("includes guardians as controllers in resolved document", async () => {
    const guardians: GuardianData[] = [
      { guardian: "0xaaaa000000000000000000000000000000000001", addedAt: 1n, active: true },
    ]
    const provider = makeProvider(makeSoul(), guardians)
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve(`did:coc:${AGENT_ID}`)

    assert.ok(result.didDocument)
    assert.ok(Array.isArray(result.didDocument.controller))
    const controllers = result.didDocument.controller as string[]
    assert.equal(controllers.length, 2) // self + 1 guardian
  })

  it("sets updated metadata from lastBackupAt", async () => {
    const provider = makeProvider(makeSoul({ lastBackupAt: 1710100000n }))
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve(`did:coc:${AGENT_ID}`)

    assert.ok(result.didDocumentMetadata.updated)
    assert.ok(result.didDocumentMetadata.created)
  })

  it("omits updated when lastBackupAt is zero", async () => {
    const provider = makeProvider(makeSoul({ lastBackupAt: 0n }))
    const resolver = createDIDResolver({ defaultChainId: DEFAULT_CHAIN_ID, provider })

    const result = await resolver.resolve(`did:coc:${AGENT_ID}`)

    assert.equal(result.didDocumentMetadata.updated, undefined)
  })
})
