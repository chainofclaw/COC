// IPFS file uploader: reads files, optionally encrypts, uploads to IPFS

import { readFile } from "node:fs/promises"
import type { IpfsClient } from "../ipfs-client.ts"
import { encrypt, sha256Hex } from "../crypto.ts"
import type { FileState, ManifestFileEntry } from "../types.ts"

export interface UploadResult {
  entries: Record<string, ManifestFileEntry>
  totalBytes: number
  fileCount: number
}

/**
 * Upload a set of files to IPFS.
 * Encrypts files marked as encrypted.
 * Returns manifest entries keyed by relative path.
 */
export async function uploadFiles(
  files: FileState[],
  ipfs: IpfsClient,
  privateKey: string,
  encryptionPassword?: string,
): Promise<UploadResult> {
  const entries: Record<string, ManifestFileEntry> = {}
  let totalBytes = 0
  let fileCount = 0

  for (const file of files) {
    let content = await readFile(file.absolutePath)
    const hash = sha256Hex(content)
    const originalSize = content.length

    if (file.encrypted) {
      const keyOrPassword = encryptionPassword ?? privateKey
      const isPassword = encryptionPassword !== undefined
      content = Buffer.from(encrypt(content, keyOrPassword, isPassword))
    }

    const cid = await ipfs.add(content)

    entries[file.relativePath] = {
      cid,
      hash,
      sizeBytes: content.length,
      encrypted: file.encrypted,
      category: file.category,
    }

    totalBytes += content.length
    fileCount++
  }

  return { entries, totalBytes, fileCount }
}

/**
 * Upload files that carry over from previous manifest (unchanged).
 * Re-uses CID from previous manifest without re-uploading.
 */
export function carryOverEntries(
  unchangedFiles: FileState[],
  previousEntries: Record<string, ManifestFileEntry>,
): Record<string, ManifestFileEntry> {
  const entries: Record<string, ManifestFileEntry> = {}
  for (const file of unchangedFiles) {
    const prev = previousEntries[file.relativePath]
    if (prev) {
      entries[file.relativePath] = { ...prev }
    }
  }
  return entries
}
