// File downloader: retrieves files from IPFS and decrypts as needed

import { mkdir, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import type { IpfsClient } from "../ipfs-client.ts"
import { decrypt } from "../crypto.ts"
import type { SnapshotManifest, ManifestFileEntry } from "../types.ts"

export interface DownloadResult {
  filesWritten: number
  totalBytes: number
  errors: Array<{ path: string; error: string }>
}

/**
 * Download all files from a manifest and write to the target directory.
 * Decrypts encrypted files using the provided key.
 */
export async function downloadManifestFiles(
  manifest: SnapshotManifest,
  targetDir: string,
  ipfs: IpfsClient,
  privateKeyOrPassword: string,
  isPassword: boolean,
): Promise<DownloadResult> {
  let filesWritten = 0
  let totalBytes = 0
  const errors: Array<{ path: string; error: string }> = []

  for (const [relPath, entry] of Object.entries(manifest.files)) {
    try {
      let content = await ipfs.cat(entry.cid)

      if (entry.encrypted) {
        content = decrypt(content, privateKeyOrPassword, isPassword)
      }

      const fullPath = join(targetDir, relPath)
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content)

      filesWritten++
      totalBytes += content.length
    } catch (error) {
      errors.push({ path: relPath, error: String(error) })
    }
  }

  return { filesWritten, totalBytes, errors }
}

/**
 * Apply a chain of manifests (full + incrementals) to restore state.
 * Applies in order: full backup first, then each incremental on top.
 */
export async function applyManifestChain(
  chain: SnapshotManifest[],
  targetDir: string,
  ipfs: IpfsClient,
  privateKeyOrPassword: string,
  isPassword: boolean,
): Promise<DownloadResult> {
  let totalFilesWritten = 0
  let totalBytesWritten = 0
  const allErrors: Array<{ path: string; error: string }> = []

  // Track which files have been written (later manifests override earlier ones)
  const writtenPaths = new Set<string>()

  // Process from newest to oldest to avoid writing files that will be overwritten
  // Actually, for correctness with deletions, apply oldest-first
  for (const manifest of chain) {
    const result = await downloadManifestFiles(
      manifest,
      targetDir,
      ipfs,
      privateKeyOrPassword,
      isPassword,
    )

    totalFilesWritten += result.filesWritten
    totalBytesWritten += result.totalBytes
    allErrors.push(...result.errors)

    for (const path of Object.keys(manifest.files)) {
      writtenPaths.add(path)
    }
  }

  return {
    filesWritten: totalFilesWritten,
    totalBytes: totalBytesWritten,
    errors: allErrors,
  }
}
