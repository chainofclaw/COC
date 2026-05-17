/**
 * Security regression for two DID library-module flaws (not yet wired into a
 * production auth path — latent until the DID handshake integration lands):
 *
 *  1. verifiable-credentials: buildFieldMerkleTree hashed each internal pair
 *     positionally, but verifySelectiveDisclosure folds proofs smaller-hash-
 *     first. Every legit disclosure whose pair was out of sort-order failed
 *     verification — the selective-disclosure feature was broken.
 *
 *  2. did-auth: verifyDIDAuth treated `timestampMs <= 0n` as "skip freshness"
 *     (diff collapsed to 0n), so a 0-timestamp auth never expired — a
 *     replay hole if such a signature ever existed.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { buildFieldMerkleTree, verifySelectiveDisclosure } from "./verifiable-credentials.ts"
import { signDIDAuth, verifyDIDAuth } from "./did-auth.ts"
import { createNodeSigner } from "../crypto/signer.ts"

test("VC selective disclosure: every field of a built tree verifies against its root", () => {
  const subject: Record<string, unknown> = {
    id: "did:coc:x", name: "alice", age: 30, country: "US", role: "admin", level: 7, tier: "gold",
  }
  const tree = buildFieldMerkleTree(subject)
  assert.ok(tree.leaves.length >= 6, "multi-field tree")
  for (const leaf of tree.leaves) {
    const proof = tree.proofs.get(leaf.fieldName)!
    const ok = verifySelectiveDisclosure({
      fieldMerkleRoot: tree.root,
      disclosedFields: [
        { fieldName: leaf.fieldName, fieldValue: subject[leaf.fieldName], merkleProof: proof },
      ],
    } as Parameters<typeof verifySelectiveDisclosure>[0])
    assert.equal(ok, true, `field "${leaf.fieldName}" must verify against its own tree`)
  }
})

test("VC selective disclosure: a forged field value does not verify", () => {
  const subject: Record<string, unknown> = { id: "did:coc:x", role: "user", level: 1 }
  const tree = buildFieldMerkleTree(subject)
  const proof = tree.proofs.get("role")!
  const ok = verifySelectiveDisclosure({
    fieldMerkleRoot: tree.root,
    disclosedFields: [{ fieldName: "role", fieldValue: "admin", merkleProof: proof }],
  } as Parameters<typeof verifySelectiveDisclosure>[0])
  assert.equal(ok, false, "tampered field value must fail verification")
})

test("did-auth: a zero / negative timestamp fails the freshness check", () => {
  const signer = createNodeSigner("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
  const did = "did:coc:test"
  const challenge = "nonce-abc"

  // Sign with timestampMs = 0 — pre-fix this auth never expired.
  const zeroResp = signDIDAuth(did, challenge, 0n, signer)
  assert.equal(
    verifyDIDAuth(zeroResp, 0n, signer, signer.nodeId), false,
    "a 0-timestamp auth must not pass the freshness check",
  )

  // A genuinely fresh timestamp still verifies.
  const now = BigInt(Date.now())
  const freshResp = signDIDAuth(did, challenge, now, signer)
  assert.equal(
    verifyDIDAuth(freshResp, now, signer, signer.nodeId), true,
    "a fresh, correctly-signed auth must still verify",
  )

  // A stale timestamp (beyond the skew window) is rejected.
  const stale = now - 1_000_000n
  const staleResp = signDIDAuth(did, challenge, stale, signer)
  assert.equal(
    verifyDIDAuth(staleResp, stale, signer, signer.nodeId), false,
    "a stale auth must be rejected",
  )
})
