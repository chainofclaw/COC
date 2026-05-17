/**
 * Security regression: delegation scope narrowing must not be escapable by
 * omitting constraints.
 *
 * Bug: `scopeCovers` narrowed a constraint field only when BOTH parent and
 * child specified it (`if (parent.X !== undefined && child.X !== undefined)`).
 * A child scope that dropped a parent-set constraint (e.g. `maxValue`) fell
 * through to `return true` — so a re-delegation could WIDEN authority past
 * what the principal granted, defeating constraint-based scoping.
 *
 * Fix: every constraint the parent sets must be present in the child and at
 * least as restrictive; a child omitting it is wider → not covered.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { scopeCovers, isScopeSubset, verifyDelegationChain } from "./delegation-chain.ts"
import type { DelegationScope, DelegationCredential, Hex32 } from "./did-types.ts"

const ZERO32 = ("0x" + "00".repeat(32)) as Hex32
const id = (n: number) => ("0x" + String(n).padStart(64, "0")) as Hex32

test("scopeCovers: child omitting a parent-set constraint is NOT covered", () => {
  const parent: DelegationScope = {
    resource: "treasury:spend", action: "write", constraints: { maxValue: 100n },
  }
  const childUnconstrained: DelegationScope = { resource: "treasury:spend", action: "write" }
  assert.equal(
    scopeCovers(parent, childUnconstrained), false,
    "a child with no maxValue escapes the parent's maxValue cap",
  )
})

test("scopeCovers: genuine narrowing is still covered", () => {
  const parent: DelegationScope = {
    resource: "treasury:spend", action: "write", constraints: { maxValue: 100n },
  }
  const narrower: DelegationScope = {
    resource: "treasury:spend", action: "write", constraints: { maxValue: 50n },
  }
  assert.equal(scopeCovers(parent, narrower), true, "maxValue 50 <= 100 is narrower")
})

test("scopeCovers: widening a constraint is rejected", () => {
  const parent: DelegationScope = {
    resource: "treasury:spend", action: "write", constraints: { maxValue: 100n },
  }
  const wider: DelegationScope = {
    resource: "treasury:spend", action: "write", constraints: { maxValue: 200n },
  }
  assert.equal(scopeCovers(parent, wider), false, "maxValue 200 > 100 is wider")
})

test("scopeCovers: child constraints object missing a parent-set field still escapes", () => {
  const parent: DelegationScope = {
    resource: "pose:receipt:submit", action: "write",
    constraints: { nodeIds: [id(1)], maxValue: 100n },
  }
  // Has a constraints object, but omits nodeIds → unrestricted on nodeIds.
  const child: DelegationScope = {
    resource: "pose:receipt:submit", action: "write", constraints: { maxValue: 50n },
  }
  assert.equal(scopeCovers(parent, child), false, "omitting nodeIds escapes the node allowlist")
})

test("isScopeSubset: an unconstrained child scope is not a subset of a constrained parent", () => {
  const parent: DelegationScope[] = [
    { resource: "treasury:spend", action: "write", constraints: { maxValue: 100n } },
  ]
  const child: DelegationScope[] = [{ resource: "treasury:spend", action: "write" }]
  assert.equal(isScopeSubset(parent, child), false)
})

function cred(over: Partial<DelegationCredential>): DelegationCredential {
  return {
    delegationId: id(99), delegator: id(1), delegatee: id(2), parentDelegation: ZERO32,
    scopeHash: ZERO32, scopes: [], issuedAt: 1n, expiresAt: 10_000_000_000n, nonce: 0n,
    depth: 0, delegatorSig: "0x00",
    ...over,
  }
}

const ctx = {
  isDelegationRevoked: async () => false,
  getGlobalRevocationEpoch: async () => 0n,
  resolveAgentOwner: async () => null,
}

test("verifyDelegationChain rejects a child that drops the parent's maxValue", async () => {
  const root = cred({
    delegationId: id(10), delegator: id(1), delegatee: id(2), depth: 0,
    scopes: [
      { resource: "treasury:spend", action: "write", constraints: { maxValue: 100n } },
      { resource: "delegation:create", action: "write" },
    ],
  })
  const child = cred({
    delegationId: id(11), delegator: id(2), delegatee: id(3), depth: 1,
    parentDelegation: id(10),
    scopes: [{ resource: "treasury:spend", action: "write" }], // dropped maxValue
  })
  const res = await verifyDelegationChain([root, child], 1000n, ctx)
  assert.equal(res.valid, false, "constraint-escaping child must invalidate the chain")
})

test("verifyDelegationChain accepts a genuinely narrowed child", async () => {
  const root = cred({
    delegationId: id(20), delegator: id(1), delegatee: id(2), depth: 0,
    scopes: [
      { resource: "treasury:spend", action: "write", constraints: { maxValue: 100n } },
      { resource: "delegation:create", action: "write" },
    ],
  })
  const child = cred({
    delegationId: id(21), delegator: id(2), delegatee: id(3), depth: 1,
    parentDelegation: id(20),
    scopes: [{ resource: "treasury:spend", action: "write", constraints: { maxValue: 50n } }],
  })
  const res = await verifyDelegationChain([root, child], 1000n, ctx)
  assert.equal(res.valid, true, `narrowed child must stay valid, got: ${res.error}`)
})
