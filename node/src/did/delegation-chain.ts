// Delegation chain verification and scope subset checking for did:coc.

import { keccak256, toUtf8Bytes, AbiCoder } from "ethers"
import type { DelegationCredential, DelegationScope, DelegationProof, Hex32 } from "./did-types.ts"
import type { Eip712Signer } from "../crypto/eip712-signer.ts"
import { GRANT_DELEGATION_TYPES } from "../crypto/did-registry-types.ts"

const MAX_DELEGATION_DEPTH = 3
const ZERO32 = ("0x" + "00".repeat(32)) as Hex32

// --- Scope checking ---

export function scopeCovers(parent: DelegationScope, child: DelegationScope): boolean {
  // Resource pattern matching
  if (!resourceMatches(parent.resource, child.resource)) return false

  // Action matching
  if (parent.action !== "*" && parent.action !== child.action) return false

  // Constraint narrowing
  if (child.constraints && parent.constraints) {
    if (parent.constraints.epochMin !== undefined && child.constraints.epochMin !== undefined) {
      if (child.constraints.epochMin < parent.constraints.epochMin) return false
    }
    if (parent.constraints.epochMax !== undefined && child.constraints.epochMax !== undefined) {
      if (child.constraints.epochMax > parent.constraints.epochMax) return false
    }
    if (parent.constraints.maxValue !== undefined && child.constraints.maxValue !== undefined) {
      if (child.constraints.maxValue > parent.constraints.maxValue) return false
    }
    if (parent.constraints.nodeIds && child.constraints.nodeIds) {
      const parentSet = new Set(parent.constraints.nodeIds.map(id => id.toLowerCase()))
      for (const nodeId of child.constraints.nodeIds) {
        if (!parentSet.has(nodeId.toLowerCase())) return false
      }
    }
  } else if (child.constraints && !parent.constraints) {
    // Child has constraints parent doesn't — child is narrower, that's fine
  }

  return true
}

export function isScopeSubset(parentScopes: readonly DelegationScope[], childScopes: readonly DelegationScope[]): boolean {
  return childScopes.every(child =>
    parentScopes.some(parent => scopeCovers(parent, child)),
  )
}

function resourceMatches(parentPattern: string, childResource: string): boolean {
  if (parentPattern === "*") return true
  if (parentPattern === childResource) return true

  // Wildcard suffix matching: "pose:receipt:*" covers "pose:receipt:submit"
  if (parentPattern.endsWith(":*")) {
    const prefix = parentPattern.slice(0, -1) // "pose:receipt:"
    return childResource.startsWith(prefix)
  }

  // Wildcard glob: "rpc:method:eth_*" covers "rpc:method:eth_getBalance"
  if (parentPattern.endsWith("*")) {
    const prefix = parentPattern.slice(0, -1)
    return childResource.startsWith(prefix)
  }

  return false
}

// --- Scope hashing ---

export function computeScopeHash(scopes: readonly DelegationScope[]): Hex32 {
  const encoder = new AbiCoder()
  const parts = scopes.map(s => {
    const constraintStr = s.constraints
      ? JSON.stringify(s.constraints, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        )
      : ""
    return encoder.encode(
      ["string", "string", "string"],
      [s.resource, s.action, constraintStr],
    )
  })
  const combined = encoder.encode(["bytes[]"], [parts])
  return keccak256(combined) as Hex32
}

// --- Delegation chain verification ---

export interface DelegationVerificationContext {
  // Check if delegation is revoked on-chain
  isDelegationRevoked(delegationId: Hex32): Promise<boolean>
  // Check global revocation epoch for an agent
  getGlobalRevocationEpoch(agentId: Hex32): Promise<bigint>
  // Resolve agent owner address for signature verification
  resolveAgentOwner(agentId: Hex32): Promise<string | null>
}

export interface DelegationChainResult {
  valid: boolean
  error?: string
  principalAgentId?: Hex32
  leafDelegateeId?: Hex32
}

export async function verifyDelegationChain(
  chain: readonly DelegationCredential[],
  nowMs: bigint,
  context: DelegationVerificationContext,
  eip712Verifier?: Eip712Signer,
): Promise<DelegationChainResult> {
  if (chain.length === 0) {
    return { valid: false, error: "empty delegation chain" }
  }

  if (chain.length > MAX_DELEGATION_DEPTH + 1) {
    return { valid: false, error: `chain too long: ${chain.length} > ${MAX_DELEGATION_DEPTH + 1}` }
  }

  const nowSec = nowMs / 1000n

  for (let i = 0; i < chain.length; i++) {
    const cred = chain[i]

    // Check depth
    if (cred.depth !== i) {
      return { valid: false, error: `depth mismatch at index ${i}: expected ${i}, got ${cred.depth}` }
    }

    // Check expiry
    if (cred.expiresAt <= nowSec) {
      return { valid: false, error: `delegation at index ${i} expired` }
    }

    // Check on-chain revocation
    const revoked = await context.isDelegationRevoked(cred.delegationId)
    if (revoked) {
      return { valid: false, error: `delegation at index ${i} revoked` }
    }

    // Check global revocation
    const globalEpoch = await context.getGlobalRevocationEpoch(cred.delegator)
    if (globalEpoch > 0n && cred.issuedAt < globalEpoch) {
      return { valid: false, error: `delegation at index ${i} invalidated by global revocation` }
    }

    // Verify parent chain
    if (i > 0) {
      const parent = chain[i - 1]

      // Parent reference
      if (cred.parentDelegation !== parent.delegationId) {
        return { valid: false, error: `parent mismatch at index ${i}` }
      }

      // Delegatee of parent must be delegator of child
      if (parent.delegatee !== cred.delegator) {
        return { valid: false, error: `chain break at index ${i}: parent delegatee != child delegator` }
      }

      // Expiry ceiling
      if (cred.expiresAt > parent.expiresAt) {
        return { valid: false, error: `expiry ceiling violated at index ${i}` }
      }

      // Scope narrowing
      if (!isScopeSubset(parent.scopes, cred.scopes)) {
        return { valid: false, error: `scope not a subset at index ${i}` }
      }

      // Re-delegation authority check
      const hasDelegationScope = parent.scopes.some(
        s => s.resource === "delegation:create" && (s.action === "write" || s.action === "*"),
      )
      if (!hasDelegationScope) {
        return { valid: false, error: `parent at index ${i - 1} lacks delegation:create scope` }
      }
    } else {
      // Root delegation must have zero parent
      if (cred.parentDelegation !== ZERO32) {
        return { valid: false, error: "root delegation must have zero parentDelegation" }
      }
    }

    // Verify EIP-712 signature (if verifier provided)
    if (eip712Verifier) {
      const delegatorOwner = await context.resolveAgentOwner(cred.delegator)
      if (!delegatorOwner) {
        return { valid: false, error: `cannot resolve owner for delegator at index ${i}` }
      }

      const valid = eip712Verifier.verifyTypedData(
        GRANT_DELEGATION_TYPES,
        {
          delegator: cred.delegator,
          delegatee: cred.delegatee,
          parentDelegation: cred.parentDelegation,
          scopeHash: cred.scopeHash,
          expiresAt: cred.expiresAt,
          depth: cred.depth,
          nonce: cred.nonce,
        },
        cred.delegatorSig,
        delegatorOwner,
      )
      if (!valid) {
        return { valid: false, error: `invalid signature at index ${i}` }
      }
    }
  }

  return {
    valid: true,
    principalAgentId: chain[0].delegator,
    leafDelegateeId: chain[chain.length - 1].delegatee,
  }
}

// --- Delegation proof verification ---

export async function verifyDelegationProof(
  proof: DelegationProof,
  nowMs: bigint,
  context: DelegationVerificationContext,
  eip712Verifier?: Eip712Signer,
): Promise<DelegationChainResult> {
  const chainResult = await verifyDelegationChain(proof.chain, nowMs, context, eip712Verifier)
  if (!chainResult.valid) return chainResult

  // Verify that the leaf delegatee's scopes cover the requested action
  const leafCred = proof.chain[proof.chain.length - 1]
  const actionScope: DelegationScope = {
    resource: proof.leafAction.resource,
    action: proof.leafAction.action,
  }
  const covered = leafCred.scopes.some(s => scopeCovers(s, actionScope))
  if (!covered) {
    return { valid: false, error: "leaf delegation scopes do not cover the requested action" }
  }

  return chainResult
}
