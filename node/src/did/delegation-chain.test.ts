import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  scopeCovers,
  isScopeSubset,
  computeScopeHash,
  verifyDelegationChain,
  verifyDelegationProof,
} from "./delegation-chain.ts"
import type { DelegationScope, DelegationCredential, Hex32 } from "./did-types.ts"
import type { DelegationVerificationContext } from "./delegation-chain.ts"

const ZERO32 = ("0x" + "00".repeat(32)) as Hex32

function mockContext(overrides?: Partial<DelegationVerificationContext>): DelegationVerificationContext {
  return {
    isDelegationRevoked: async () => false,
    getGlobalRevocationEpoch: async () => 0n,
    resolveAgentOwner: async () => "0x1234567890abcdef1234567890abcdef12345678",
    ...overrides,
  }
}

function makeCred(overrides?: Partial<DelegationCredential>): DelegationCredential {
  return {
    delegationId: "0x" + "aa".repeat(32) as Hex32,
    delegator: "0x" + "bb".repeat(32) as Hex32,
    delegatee: "0x" + "cc".repeat(32) as Hex32,
    parentDelegation: ZERO32,
    scopeHash: "0x" + "dd".repeat(32) as Hex32,
    scopes: [{ resource: "pose:receipt:*", action: "submit" }],
    issuedAt: 1000n,
    expiresAt: 99999999999n,
    nonce: 0n,
    depth: 0,
    delegatorSig: "0x" + "ee".repeat(65) as `0x${string}`,
    ...overrides,
  }
}

// --- scopeCovers ---

describe("scopeCovers", () => {
  it("exact match", () => {
    assert.ok(scopeCovers(
      { resource: "pose:receipt:submit", action: "submit" },
      { resource: "pose:receipt:submit", action: "submit" },
    ))
  })

  it("wildcard resource covers specific", () => {
    assert.ok(scopeCovers(
      { resource: "pose:receipt:*", action: "submit" },
      { resource: "pose:receipt:submit", action: "submit" },
    ))
  })

  it("global wildcard covers all", () => {
    assert.ok(scopeCovers(
      { resource: "*", action: "*" },
      { resource: "anything:here", action: "do" },
    ))
  })

  it("action wildcard covers specific action", () => {
    assert.ok(scopeCovers(
      { resource: "ipfs:cid:Qm123", action: "*" },
      { resource: "ipfs:cid:Qm123", action: "read" },
    ))
  })

  it("rejects non-matching resource", () => {
    assert.ok(!scopeCovers(
      { resource: "pose:receipt:*", action: "submit" },
      { resource: "ipfs:cid:Qm123", action: "submit" },
    ))
  })

  it("rejects non-matching action", () => {
    assert.ok(!scopeCovers(
      { resource: "pose:receipt:*", action: "submit" },
      { resource: "pose:receipt:foo", action: "read" },
    ))
  })

  it("epoch constraint narrowing", () => {
    assert.ok(scopeCovers(
      { resource: "pose:*", action: "*", constraints: { epochMin: 100n, epochMax: 200n } },
      { resource: "pose:receipt", action: "submit", constraints: { epochMin: 120n, epochMax: 180n } },
    ))
  })

  it("rejects epoch constraint widening", () => {
    assert.ok(!scopeCovers(
      { resource: "pose:*", action: "*", constraints: { epochMin: 100n, epochMax: 200n } },
      { resource: "pose:receipt", action: "submit", constraints: { epochMin: 50n, epochMax: 180n } },
    ))
  })

  it("child with constraints, parent without — allowed (child is narrower)", () => {
    assert.ok(scopeCovers(
      { resource: "pose:*", action: "*" },
      { resource: "pose:receipt", action: "submit", constraints: { epochMin: 100n } },
    ))
  })
})

// --- isScopeSubset ---

describe("isScopeSubset", () => {
  it("returns true when child is subset", () => {
    const parent: DelegationScope[] = [
      { resource: "pose:*", action: "*" },
      { resource: "ipfs:*", action: "read" },
    ]
    const child: DelegationScope[] = [
      { resource: "pose:receipt:submit", action: "submit" },
    ]
    assert.ok(isScopeSubset(parent, child))
  })

  it("returns false when child exceeds parent", () => {
    const parent: DelegationScope[] = [
      { resource: "pose:receipt:*", action: "submit" },
    ]
    const child: DelegationScope[] = [
      { resource: "ipfs:cid:Qm123", action: "read" },
    ]
    assert.ok(!isScopeSubset(parent, child))
  })

  it("empty child is always subset", () => {
    assert.ok(isScopeSubset([{ resource: "*", action: "*" }], []))
  })
})

// --- computeScopeHash ---

describe("computeScopeHash", () => {
  it("produces deterministic hash", () => {
    const scopes: DelegationScope[] = [
      { resource: "pose:receipt:*", action: "submit" },
    ]
    const h1 = computeScopeHash(scopes)
    const h2 = computeScopeHash(scopes)
    assert.equal(h1, h2)
  })

  it("different scopes produce different hashes", () => {
    const h1 = computeScopeHash([{ resource: "pose:*", action: "*" }])
    const h2 = computeScopeHash([{ resource: "ipfs:*", action: "read" }])
    assert.notEqual(h1, h2)
  })
})

// --- verifyDelegationChain ---

describe("verifyDelegationChain", () => {
  const nowMs = BigInt(Date.now())

  it("validates single-hop chain", async () => {
    const cred = makeCred()
    const result = await verifyDelegationChain([cred], nowMs, mockContext())
    assert.ok(result.valid)
    assert.equal(result.principalAgentId, cred.delegator)
    assert.equal(result.leafDelegateeId, cred.delegatee)
  })

  it("rejects empty chain", async () => {
    const result = await verifyDelegationChain([], nowMs, mockContext())
    assert.ok(!result.valid)
    assert.ok(result.error?.includes("empty"))
  })

  it("rejects expired delegation", async () => {
    const cred = makeCred({ expiresAt: 1n }) // expired
    const result = await verifyDelegationChain([cred], nowMs, mockContext())
    assert.ok(!result.valid)
    assert.ok(result.error?.includes("expired"))
  })

  it("rejects revoked delegation", async () => {
    const cred = makeCred()
    const ctx = mockContext({ isDelegationRevoked: async () => true })
    const result = await verifyDelegationChain([cred], nowMs, ctx)
    assert.ok(!result.valid)
    assert.ok(result.error?.includes("revoked"))
  })

  it("rejects globally revoked delegation", async () => {
    const cred = makeCred({ issuedAt: 500n })
    const ctx = mockContext({ getGlobalRevocationEpoch: async () => 1000n })
    const result = await verifyDelegationChain([cred], nowMs, ctx)
    assert.ok(!result.valid)
    assert.ok(result.error?.includes("global revocation"))
  })

  it("validates two-hop chain", async () => {
    const delegatorA = "0x" + "01".repeat(32) as Hex32
    const delegateeB = "0x" + "02".repeat(32) as Hex32
    const delegateeC = "0x" + "03".repeat(32) as Hex32
    const delegationIdAB = "0x" + "a1".repeat(32) as Hex32

    const credAB = makeCred({
      delegationId: delegationIdAB,
      delegator: delegatorA,
      delegatee: delegateeB,
      parentDelegation: ZERO32,
      depth: 0,
      scopes: [
        { resource: "pose:*", action: "*" },
        { resource: "delegation:create", action: "write" },
      ],
    })
    const credBC = makeCred({
      delegationId: "0x" + "a2".repeat(32) as Hex32,
      delegator: delegateeB,
      delegatee: delegateeC,
      parentDelegation: delegationIdAB,
      depth: 1,
      scopes: [{ resource: "pose:receipt:*", action: "submit" }],
    })

    const result = await verifyDelegationChain([credAB, credBC], nowMs, mockContext())
    assert.ok(result.valid)
    assert.equal(result.principalAgentId, delegatorA)
    assert.equal(result.leafDelegateeId, delegateeC)
  })

  it("rejects chain with scope widening", async () => {
    const delegatorA = "0x" + "01".repeat(32) as Hex32
    const delegateeB = "0x" + "02".repeat(32) as Hex32
    const delegateeC = "0x" + "03".repeat(32) as Hex32
    const delegationIdAB = "0x" + "a1".repeat(32) as Hex32

    const credAB = makeCred({
      delegationId: delegationIdAB,
      delegator: delegatorA,
      delegatee: delegateeB,
      depth: 0,
      scopes: [
        { resource: "pose:receipt:*", action: "submit" },
        { resource: "delegation:create", action: "write" },
      ],
    })
    const credBC = makeCred({
      delegationId: "0x" + "a2".repeat(32) as Hex32,
      delegator: delegateeB,
      delegatee: delegateeC,
      parentDelegation: delegationIdAB,
      depth: 1,
      scopes: [{ resource: "ipfs:*", action: "read" }], // NOT covered by parent
    })

    const result = await verifyDelegationChain([credAB, credBC], nowMs, mockContext())
    assert.ok(!result.valid)
    assert.ok(result.error?.includes("scope not a subset"))
  })

  it("rejects chain without delegation:create scope in parent", async () => {
    const delegatorA = "0x" + "01".repeat(32) as Hex32
    const delegateeB = "0x" + "02".repeat(32) as Hex32
    const delegateeC = "0x" + "03".repeat(32) as Hex32
    const delegationIdAB = "0x" + "a1".repeat(32) as Hex32

    const credAB = makeCred({
      delegationId: delegationIdAB,
      delegator: delegatorA,
      delegatee: delegateeB,
      depth: 0,
      scopes: [{ resource: "pose:*", action: "*" }], // no delegation:create
    })
    const credBC = makeCred({
      delegationId: "0x" + "a2".repeat(32) as Hex32,
      delegator: delegateeB,
      delegatee: delegateeC,
      parentDelegation: delegationIdAB,
      depth: 1,
      scopes: [{ resource: "pose:receipt:*", action: "submit" }],
    })

    const result = await verifyDelegationChain([credAB, credBC], nowMs, mockContext())
    assert.ok(!result.valid)
    assert.ok(result.error?.includes("delegation:create"))
  })

  it("rejects depth mismatch", async () => {
    const cred = makeCred({ depth: 2 }) // should be 0
    const result = await verifyDelegationChain([cred], nowMs, mockContext())
    assert.ok(!result.valid)
    assert.ok(result.error?.includes("depth mismatch"))
  })
})

// --- verifyDelegationProof ---

describe("verifyDelegationProof", () => {
  const nowMs = BigInt(Date.now())

  it("validates proof with matching scope", async () => {
    const cred = makeCred({
      scopes: [{ resource: "pose:receipt:*", action: "submit" }],
    })
    const result = await verifyDelegationProof(
      {
        chain: [cred],
        leafAction: { resource: "pose:receipt:submit", action: "submit", payload: {} },
        proofTimestamp: BigInt(Date.now()),
        proofSignature: "0x" + "ff".repeat(65) as `0x${string}`,
      },
      nowMs,
      mockContext(),
    )
    assert.ok(result.valid)
  })

  it("rejects proof with uncovered action", async () => {
    const cred = makeCred({
      scopes: [{ resource: "pose:receipt:*", action: "submit" }],
    })
    const result = await verifyDelegationProof(
      {
        chain: [cred],
        leafAction: { resource: "ipfs:cid:Qm123", action: "read", payload: {} },
        proofTimestamp: BigInt(Date.now()),
        proofSignature: "0x" + "ff".repeat(65) as `0x${string}`,
      },
      nowMs,
      mockContext(),
    )
    assert.ok(!result.valid)
    assert.ok(result.error?.includes("do not cover"))
  })
})
