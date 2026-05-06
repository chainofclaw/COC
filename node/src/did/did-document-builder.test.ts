import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildDIDDocument, buildDeactivatedDocument, registerKeyLabel } from "./did-document-builder.ts"
import type { BuilderInput, SoulIdentityData, GuardianData, ResurrectionConfigData, VerificationMethodData } from "./did-document-builder.ts"
import { KEY_PURPOSE } from "../crypto/did-registry-types.ts"
import { W3C_DID_CONTEXT, COC_DID_CONTEXT } from "./did-types.ts"
import { keccak256, toUtf8Bytes } from "ethers"

const ZERO32 = "0x" + "00".repeat(32)
const AGENT_ID = "0x" + "ab".repeat(32)
const OWNER = "0x1234567890abcdef1234567890abcdef12345678"
const CHAIN_ID = 20241224

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

describe("buildDIDDocument", () => {
  it("builds minimal document from soul data", () => {
    const input: BuilderInput = { chainId: CHAIN_ID, soul: makeSoul() }
    const doc = buildDIDDocument(input)

    assert.deepStrictEqual(doc["@context"], [W3C_DID_CONTEXT, COC_DID_CONTEXT])
    assert.ok(doc.id.includes(AGENT_ID.toLowerCase()))
    assert.ok(doc.id.startsWith("did:coc:"))

    assert.ok(doc.verificationMethod)
    assert.equal(doc.verificationMethod.length, 1)
    assert.equal(doc.verificationMethod[0].id, `${doc.id}#master`)
    assert.ok(doc.verificationMethod[0].blockchainAccountId?.includes(OWNER))

    assert.deepStrictEqual(doc.authentication, ["#master"])
    assert.deepStrictEqual(doc.assertionMethod, ["#master"])
    assert.deepStrictEqual(doc.capabilityInvocation, ["#master"])
    assert.deepStrictEqual(doc.capabilityDelegation, ["#master"])

    assert.equal(doc.controller, doc.id)
  })

  it("includes guardians as controllers", () => {
    const guardians: GuardianData[] = [
      { guardian: "0xaaaa000000000000000000000000000000000001", addedAt: 1n, active: true },
      { guardian: "0xaaaa000000000000000000000000000000000002", addedAt: 2n, active: false },
      { guardian: "0xaaaa000000000000000000000000000000000003", addedAt: 3n, active: true },
    ]
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul(), guardians })

    assert.ok(Array.isArray(doc.controller))
    const controllers = doc.controller as string[]
    // Self + 2 active guardians
    assert.equal(controllers.length, 3)
    assert.ok(controllers[0].startsWith("did:coc:"))
    assert.ok(controllers[1].includes("0xaaaa000000000000000000000000000000000001"))
    assert.ok(!controllers.some(c => c.includes("0xaaaa000000000000000000000000000000000002")))
  })

  it("includes resurrection key when configured", () => {
    const resConfig: ResurrectionConfigData = {
      resurrectionKeyHash: "0x" + "ff".repeat(32),
      maxOfflineDuration: 86400n,
      lastHeartbeat: 1710000000n,
      configured: true,
    }
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul(), resurrectionConfig: resConfig })

    assert.ok(doc.verificationMethod)
    assert.equal(doc.verificationMethod.length, 2)
    const resVm = doc.verificationMethod.find(vm => vm.id.endsWith("#resurrection"))
    assert.ok(resVm)
    assert.equal(resVm!.publicKeyHex, resConfig.resurrectionKeyHash)
  })

  it("skips resurrection key when not configured", () => {
    const resConfig: ResurrectionConfigData = {
      resurrectionKeyHash: ZERO32,
      maxOfflineDuration: 0n,
      lastHeartbeat: 0n,
      configured: false,
    }
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul(), resurrectionConfig: resConfig })
    assert.ok(doc.verificationMethod)
    assert.equal(doc.verificationMethod.length, 1)
  })

  it("includes additional verification methods from DIDRegistry", () => {
    const keyId = keccak256(toUtf8Bytes("operational"))
    registerKeyLabel(keyId, "operational")

    const vms: VerificationMethodData[] = [
      {
        keyId,
        keyAddress: "0xbbbb000000000000000000000000000000000001",
        keyPurpose: KEY_PURPOSE.AUTHENTICATION | KEY_PURPOSE.ASSERTION,
        addedAt: 100n,
        revokedAt: 0n,
        active: true,
      },
      {
        keyId: keccak256(toUtf8Bytes("revoked-key")),
        keyAddress: "0xbbbb000000000000000000000000000000000002",
        keyPurpose: KEY_PURPOSE.AUTHENTICATION,
        addedAt: 50n,
        revokedAt: 200n,
        active: false,
      },
    ]
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul(), verificationMethods: vms })

    assert.ok(doc.verificationMethod)
    // master + 1 active (revoked one excluded)
    assert.equal(doc.verificationMethod.length, 2)

    const opVm = doc.verificationMethod.find(vm => vm.id.endsWith("#operational"))
    assert.ok(opVm)
    assert.ok(opVm!.blockchainAccountId?.includes("0xbbbb000000000000000000000000000000000001"))

    // Auth refs: master + operational
    assert.ok(doc.authentication)
    assert.equal((doc.authentication as string[]).length, 2)
    assert.ok((doc.authentication as string[]).includes("#operational"))
  })

  it("includes capabilities in agent metadata", () => {
    const bitmask = 0x0001 | 0x0004 | 0x0020 // storage + validation + witness
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul(), capabilities: bitmask })

    assert.ok(doc.cocAgent?.capabilities)
    assert.ok(doc.cocAgent!.capabilities!.includes("storage"))
    assert.ok(doc.cocAgent!.capabilities!.includes("validation"))
    assert.ok(doc.cocAgent!.capabilities!.includes("witness"))
    assert.equal(doc.cocAgent!.capabilities!.length, 3)
  })

  it("includes lineage when parent is set", () => {
    const lineage = {
      parentAgentId: "0x" + "cc".repeat(32),
      forkHeight: 1000n,
      generation: 2,
    }
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul(), lineage })

    assert.ok(doc.cocAgent?.lineage)
    assert.equal(doc.cocAgent!.lineage!.parent, lineage.parentAgentId)
    assert.equal(doc.cocAgent!.lineage!.generation, 2)
  })

  it("omits lineage when parent is zero", () => {
    const lineage = { parentAgentId: ZERO32, forkHeight: 0n, generation: 0 }
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul(), lineage })
    assert.equal(doc.cocAgent?.lineage, undefined)
  })

  it("includes service endpoints", () => {
    const services = [
      { id: "#rpc", type: "CocRpcEndpoint", serviceEndpoint: "http://localhost:18780" },
      { id: "#wire", type: "CocWireProtocol", serviceEndpoint: "tcp://localhost:19781" },
    ]
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul(), services })

    assert.ok(doc.service)
    assert.equal(doc.service!.length, 2)
    assert.equal(doc.service![0].type, "CocRpcEndpoint")
  })

  it("omits service array when empty", () => {
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul() })
    assert.equal(doc.service, undefined)
  })

  it("includes registration timestamp in cocAgent", () => {
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul: makeSoul() })
    assert.ok(doc.cocAgent?.registeredAt)
    assert.ok(doc.cocAgent!.registeredAt!.includes("2024"))
  })

  it("omits zero CIDs from agent metadata", () => {
    const soul = makeSoul({ identityCid: ZERO32, latestSnapshotCid: ZERO32 })
    const doc = buildDIDDocument({ chainId: CHAIN_ID, soul })
    assert.equal(doc.cocAgent?.identityCid, undefined)
    assert.equal(doc.cocAgent?.latestSnapshotCid, undefined)
  })
})

describe("buildDeactivatedDocument", () => {
  it("returns document with empty verification methods", () => {
    const doc = buildDeactivatedDocument(AGENT_ID, CHAIN_ID)

    assert.deepStrictEqual(doc["@context"], [W3C_DID_CONTEXT, COC_DID_CONTEXT])
    assert.ok(doc.id.includes(AGENT_ID.toLowerCase()))
    assert.deepStrictEqual(doc.verificationMethod, [])
    assert.deepStrictEqual(doc.authentication, [])
    assert.deepStrictEqual(doc.assertionMethod, [])
    assert.equal(doc.controller, undefined)
  })
})
