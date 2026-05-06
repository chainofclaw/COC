import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  computeCredentialHash,
  buildFieldMerkleTree,
  verifySelectiveDisclosure,
} from "./verifiable-credentials.ts"
import type { Hex32 } from "./did-types.ts"

const ISSUER = "0x" + "aa".repeat(32) as Hex32
const SUBJECT = "0x" + "bb".repeat(32) as Hex32

// --- computeCredentialHash ---

describe("computeCredentialHash", () => {
  it("produces deterministic hash", () => {
    const cred = {
      "@context": ["https://www.w3.org/2018/credentials/v1"] as string[],
      type: ["VerifiableCredential", "CocCapabilityCredential"],
      issuer: ISSUER,
      issuanceDate: "2026-03-15T00:00:00Z",
      credentialSubject: {
        id: SUBJECT,
        capability: "storage",
        score: 95,
      },
    }
    const h1 = computeCredentialHash(cred)
    const h2 = computeCredentialHash(cred)
    assert.equal(h1, h2)
    assert.ok(h1.startsWith("0x"))
    assert.equal(h1.length, 66) // 0x + 64 hex chars
  })

  it("different credentials produce different hashes", () => {
    const base = {
      "@context": ["https://www.w3.org/2018/credentials/v1"] as string[],
      type: ["VerifiableCredential"],
      issuer: ISSUER,
      issuanceDate: "2026-03-15T00:00:00Z",
      credentialSubject: { id: SUBJECT, score: 95 },
    }
    const h1 = computeCredentialHash(base)
    const h2 = computeCredentialHash({
      ...base,
      credentialSubject: { id: SUBJECT, score: 50 },
    })
    assert.notEqual(h1, h2)
  })
})

// --- buildFieldMerkleTree ---

describe("buildFieldMerkleTree", () => {
  it("builds tree from multiple fields", () => {
    const subject = {
      id: SUBJECT,
      capability: "storage",
      score: 95,
      uptime: 0.99,
    }
    const tree = buildFieldMerkleTree(subject)

    // 3 fields (excluding id)
    assert.equal(tree.leaves.length, 3)
    assert.ok(tree.root.startsWith("0x"))
    assert.equal(tree.root.length, 66)

    // Each field should have a proof
    assert.ok(tree.proofs.has("capability"))
    assert.ok(tree.proofs.has("score"))
    assert.ok(tree.proofs.has("uptime"))
  })

  it("handles single field", () => {
    const tree = buildFieldMerkleTree({ id: SUBJECT, score: 42 })
    assert.equal(tree.leaves.length, 1)
    assert.ok(tree.root.startsWith("0x"))
  })

  it("handles empty subject", () => {
    const tree = buildFieldMerkleTree({ id: SUBJECT })
    assert.equal(tree.leaves.length, 0)
  })

  it("produces deterministic root", () => {
    const subject = { id: SUBJECT, a: 1, b: 2 }
    const t1 = buildFieldMerkleTree(subject)
    const t2 = buildFieldMerkleTree(subject)
    assert.equal(t1.root, t2.root)
  })
})

// --- verifySelectiveDisclosure ---

describe("verifySelectiveDisclosure", () => {
  it("verifies single field disclosure", () => {
    const subject = {
      id: SUBJECT,
      capability: "storage",
      score: 95,
    }
    const tree = buildFieldMerkleTree(subject)

    const disclosure = {
      credentialHash: "0x" + "cc".repeat(32) as Hex32,
      disclosedFields: [{
        fieldName: "score",
        fieldValue: 95,
        merkleProof: tree.proofs.get("score")!,
      }],
      fieldMerkleRoot: tree.root,
    }

    assert.ok(verifySelectiveDisclosure(disclosure))
  })

  it("verifies multiple field disclosures", () => {
    const subject = {
      id: SUBJECT,
      capability: "storage",
      score: 95,
    }
    const tree = buildFieldMerkleTree(subject)

    const disclosure = {
      credentialHash: "0x" + "cc".repeat(32) as Hex32,
      disclosedFields: [
        {
          fieldName: "capability",
          fieldValue: "storage",
          merkleProof: tree.proofs.get("capability")!,
        },
        {
          fieldName: "score",
          fieldValue: 95,
          merkleProof: tree.proofs.get("score")!,
        },
      ],
      fieldMerkleRoot: tree.root,
    }

    assert.ok(verifySelectiveDisclosure(disclosure))
  })

  it("rejects tampered field value", () => {
    const subject = {
      id: SUBJECT,
      score: 95,
    }
    const tree = buildFieldMerkleTree(subject)

    const disclosure = {
      credentialHash: "0x" + "cc".repeat(32) as Hex32,
      disclosedFields: [{
        fieldName: "score",
        fieldValue: 100, // tampered!
        merkleProof: tree.proofs.get("score")!,
      }],
      fieldMerkleRoot: tree.root,
    }

    assert.ok(!verifySelectiveDisclosure(disclosure))
  })

  it("rejects wrong merkle root", () => {
    const subject = { id: SUBJECT, score: 95 }
    const tree = buildFieldMerkleTree(subject)

    const disclosure = {
      credentialHash: "0x" + "cc".repeat(32) as Hex32,
      disclosedFields: [{
        fieldName: "score",
        fieldValue: 95,
        merkleProof: tree.proofs.get("score")!,
      }],
      fieldMerkleRoot: "0x" + "ff".repeat(32) as Hex32, // wrong root
    }

    assert.ok(!verifySelectiveDisclosure(disclosure))
  })

  it("empty disclosure is valid", () => {
    const disclosure = {
      credentialHash: "0x" + "cc".repeat(32) as Hex32,
      disclosedFields: [],
      fieldMerkleRoot: "0x" + "00".repeat(32) as Hex32,
    }
    assert.ok(verifySelectiveDisclosure(disclosure))
  })
})
