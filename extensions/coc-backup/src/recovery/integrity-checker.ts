// Merkle integrity verification: verifies manifest against on-chain Merkle root

import { readFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { sha256Hex } from "../crypto.ts"
import { computeDataMerkleRoot } from "../backup/manifest-builder.ts"
import type { SnapshotManifest } from "../types.ts"

export interface IntegrityResult {
  valid: boolean
  manifestMerkleRoot: string
  expectedMerkleRoot: string
  fileResults: Array<{
    path: string
    valid: boolean
    expectedHash: string
    actualHash: string
  }>
}

/**
 * Verify the integrity of a manifest's Merkle root.
 * Recomputes the Merkle root from the file entries and compares
 * with the stored value.
 */
export function verifyManifestMerkleRoot(manifest: SnapshotManifest): boolean {
  const computed = computeDataMerkleRoot(manifest.files)
  return computed === manifest.merkleRoot
}

/**
 * Verify the integrity of restored files against the manifest.
 * Reads each file from disk and compares SHA-256 hash with manifest entry.
 */
export async function verifyRestoredFiles(
  manifest: SnapshotManifest,
  targetDir: string,
): Promise<IntegrityResult> {
  const fileResults: IntegrityResult["fileResults"] = []
  let allValid = true

  const resolvedTarget = resolve(targetDir)
  for (const [relPath, entry] of Object.entries(manifest.files)) {
    try {
      const fullPath = resolve(join(targetDir, relPath))
      if (!fullPath.startsWith(resolvedTarget + sep) && fullPath !== resolvedTarget) {
        throw new Error(`Path traversal detected: ${relPath}`)
      }
      const content = await readFile(fullPath)
      const actualHash = sha256Hex(content)
      const valid = actualHash === entry.hash

      if (!valid) allValid = false

      fileResults.push({
        path: relPath,
        valid,
        expectedHash: entry.hash,
        actualHash,
      })
    } catch {
      allValid = false
      fileResults.push({
        path: relPath,
        valid: false,
        expectedHash: entry.hash,
        actualHash: "FILE_NOT_FOUND",
      })
    }
  }

  const manifestMerkleRoot = computeDataMerkleRoot(manifest.files)
  return {
    valid: allValid && manifestMerkleRoot === manifest.merkleRoot,
    manifestMerkleRoot,
    expectedMerkleRoot: manifest.merkleRoot,
    fileResults,
  }
}

/**
 * Verify on-chain anchor matches manifest.
 * Compares the manifest's Merkle root with what's stored on-chain.
 */
export function verifyOnChainAnchor(
  manifestMerkleRoot: string,
  onChainMerkleRoot: string,
): boolean {
  return manifestMerkleRoot === onChainMerkleRoot
}
