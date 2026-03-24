// File downloader: retrieves files from IPFS and decrypts as needed

import { mkdir, writeFile, unlink } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
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

  const resolvedTarget = resolve(targetDir)

  for (const [relPath, entry] of Object.entries(manifest.files)) {
    try {
      const fullPath = resolve(join(targetDir, relPath))
      if (!fullPath.startsWith(resolvedTarget + "/") && fullPath !== resolvedTarget) {
        throw new Error(`Path traversal blocked: ${relPath}`)
      }

      let content = await ipfs.cat(entry.cid)

      if (entry.encrypted) {
        content = decrypt(content, privateKeyOrPassword, isPassword)
      }

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

  // Apply oldest-first so later manifests overwrite earlier ones
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

  // Delete files from earlier manifests that are absent in the latest manifest
  const resolvedTarget = resolve(targetDir)
  const latestFiles = new Set(Object.keys(chain[chain.length - 1].files))
  for (const p of writtenPaths) {
    if (!latestFiles.has(p)) {
      const full = resolve(join(targetDir, p))
      if (!full.startsWith(resolvedTarget + "/")) continue
      try {
        await unlink(full)
      } catch {
        // File may already be absent
      }
    }
  }

  return {
    filesWritten: totalFilesWritten,
    totalBytes: totalBytesWritten,
    errors: allErrors,
  }
}
