import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Interface } from "ethers"
import { createContractDIDDataProvider } from "./did-data-provider.ts"
import type { EthCallFn } from "./did-data-provider.ts"

const SOUL_ADDR = "0x" + "aa".repeat(20)
const DID_ADDR = "0x" + "bb".repeat(20)
const AGENT_ID = "0x" + "cc".repeat(32) as `0x${string}`
const ZERO32 = "0x" + "00".repeat(32)

// Build a mock ethCall that returns pre-encoded ABI data
function createMockEthCall(responses: Map<string, string>): EthCallFn {
  return async (to: string, data: string) => {
    const selector = data.slice(0, 10)
    const key = `${to}:${selector}`
    const result = responses.get(key)
    if (!result) throw new Error(`No mock for ${key}`)
    return result
  }
}

// Helper to encode a simple getSoul response
const soulIface = new Interface([
  "function getSoul(bytes32) external view returns (tuple(bytes32 agentId, address owner, bytes32 identityCid, bytes32 latestSnapshotCid, uint64 registeredAt, uint64 lastBackupAt, uint32 backupCount, uint16 version, bool active))",
])
const didIface = new Interface([
  "function agentCapabilities(bytes32) external view returns (uint256)",
  "function getAgentDelegations(bytes32) external view returns (bytes32[])",
  "function didDocumentUpdatedAt(bytes32) external view returns (uint64)",
])

describe("createContractDIDDataProvider", () => {
  it("getSoul returns parsed data for active soul", async () => {
    const encoded = soulIface.encodeFunctionResult("getSoul", [{
      agentId: AGENT_ID,
      owner: "0x" + "11".repeat(20),
      identityCid: "0x" + "22".repeat(32),
      latestSnapshotCid: ZERO32,
      registeredAt: 1000,
      lastBackupAt: 2000,
      backupCount: 5,
      version: 1,
      active: true,
    }])
    const selector = soulIface.getFunction("getSoul")!.selector
    const responses = new Map([[`${SOUL_ADDR}:${selector}`, encoded]])
    const provider = createContractDIDDataProvider({
      soulRegistryAddress: SOUL_ADDR,
      didRegistryAddress: DID_ADDR,
      ethCall: createMockEthCall(responses),
    })
    const soul = await provider.getSoul(AGENT_ID)
    assert.ok(soul)
    assert.equal(soul.agentId, AGENT_ID)
    assert.equal(soul.active, true)
    assert.equal(soul.backupCount, 5)
  })

  it("getSoul returns null for zero-owner", async () => {
    const encoded = soulIface.encodeFunctionResult("getSoul", [{
      agentId: AGENT_ID,
      owner: "0x" + "0".repeat(40),
      identityCid: ZERO32,
      latestSnapshotCid: ZERO32,
      registeredAt: 0,
      lastBackupAt: 0,
      backupCount: 0,
      version: 0,
      active: false,
    }])
    const selector = soulIface.getFunction("getSoul")!.selector
    const responses = new Map([[`${SOUL_ADDR}:${selector}`, encoded]])
    const provider = createContractDIDDataProvider({
      soulRegistryAddress: SOUL_ADDR,
      didRegistryAddress: DID_ADDR,
      ethCall: createMockEthCall(responses),
    })
    const soul = await provider.getSoul(AGENT_ID)
    assert.equal(soul, null)
  })

  it("getCapabilities returns number", async () => {
    const encoded = didIface.encodeFunctionResult("agentCapabilities", [0x0007])
    const selector = didIface.getFunction("agentCapabilities")!.selector
    const responses = new Map([[`${DID_ADDR}:${selector}`, encoded]])
    const provider = createContractDIDDataProvider({
      soulRegistryAddress: SOUL_ADDR,
      didRegistryAddress: DID_ADDR,
      ethCall: createMockEthCall(responses),
    })
    const caps = await provider.getCapabilities(AGENT_ID)
    assert.equal(caps, 7)
  })

  it("getAgentDelegations returns ID list", async () => {
    const id1 = "0x" + "dd".repeat(32)
    const id2 = "0x" + "ee".repeat(32)
    const encoded = didIface.encodeFunctionResult("getAgentDelegations", [[id1, id2]])
    const selector = didIface.getFunction("getAgentDelegations")!.selector
    const responses = new Map([[`${DID_ADDR}:${selector}`, encoded]])
    const provider = createContractDIDDataProvider({
      soulRegistryAddress: SOUL_ADDR,
      didRegistryAddress: DID_ADDR,
      ethCall: createMockEthCall(responses),
    })
    const ids = await provider.getAgentDelegations(AGENT_ID)
    assert.deepStrictEqual(ids, [id1, id2])
  })

  it("getDIDDocumentUpdatedAt returns timestamp", async () => {
    const encoded = didIface.encodeFunctionResult("didDocumentUpdatedAt", [1700000000])
    const selector = didIface.getFunction("didDocumentUpdatedAt")!.selector
    const responses = new Map([[`${DID_ADDR}:${selector}`, encoded]])
    const provider = createContractDIDDataProvider({
      soulRegistryAddress: SOUL_ADDR,
      didRegistryAddress: DID_ADDR,
      ethCall: createMockEthCall(responses),
    })
    const ts = await provider.getDIDDocumentUpdatedAt(AGENT_ID)
    assert.equal(ts, 1700000000)
  })

  it("getFullDelegations returns complete DelegationRecord[]", async () => {
    const id1 = "0x" + "dd".repeat(32)
    const delegationsIface = new Interface([
      "function getAgentDelegations(bytes32) external view returns (bytes32[])",
      "function delegations(bytes32) external view returns (bytes32 delegator, bytes32 delegatee, bytes32 parentDelegation, bytes32 scopeHash, uint64 issuedAt, uint64 expiresAt, uint8 depth, bool revoked)",
    ])
    const listEncoded = delegationsIface.encodeFunctionResult("getAgentDelegations", [[id1]])
    const recordEncoded = delegationsIface.encodeFunctionResult("delegations", [
      AGENT_ID, "0x" + "ee".repeat(32), ZERO32, "0x" + "ff".repeat(32),
      1000, 2000, 1, false,
    ])
    const listSelector = delegationsIface.getFunction("getAgentDelegations")!.selector
    const recordSelector = delegationsIface.getFunction("delegations")!.selector
    const responses = new Map([
      [`${DID_ADDR}:${listSelector}`, listEncoded],
      [`${DID_ADDR}:${recordSelector}`, recordEncoded],
    ])
    const provider = createContractDIDDataProvider({
      soulRegistryAddress: SOUL_ADDR,
      didRegistryAddress: DID_ADDR,
      ethCall: createMockEthCall(responses),
    })
    const records = await provider.getFullDelegations(AGENT_ID)
    assert.equal(records.length, 1)
    assert.equal(records[0].delegationId, id1)
    assert.equal(records[0].delegator, AGENT_ID)
    assert.equal(records[0].issuedAt, 1000)
    assert.equal(records[0].expiresAt, 2000)
    assert.equal(records[0].depth, 1)
    assert.equal(records[0].revoked, false)
  })

  it("returns safe defaults on error", async () => {
    const provider = createContractDIDDataProvider({
      soulRegistryAddress: SOUL_ADDR,
      didRegistryAddress: DID_ADDR,
      ethCall: async () => { throw new Error("revert") },
    })
    assert.equal(await provider.getSoul(AGENT_ID), null)
    assert.deepStrictEqual(await provider.getGuardians(AGENT_ID), [])
    assert.equal(await provider.getResurrectionConfig(AGENT_ID), null)
    assert.deepStrictEqual(await provider.getVerificationMethods(AGENT_ID), [])
    assert.equal(await provider.getCapabilities(AGENT_ID), 0)
    assert.equal(await provider.getLineage(AGENT_ID), null)
    assert.equal(await provider.getDIDDocumentCid(AGENT_ID), null)
    assert.deepStrictEqual(await provider.getAgentDelegations(AGENT_ID), [])
    assert.deepStrictEqual(await provider.getFullDelegations(AGENT_ID), [])
    assert.equal(await provider.getDIDDocumentUpdatedAt(AGENT_ID), 0)
  })
})
