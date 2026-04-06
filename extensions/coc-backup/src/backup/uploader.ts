// IPFS file uploader: reads files, optionally encrypts, uploads to IPFS

import { readFile } from "node:fs/promises"
import type { IpfsClient } from "../ipfs-client.ts"
import { encrypt, sha256Hex } from "../crypto.ts"
import type { FileState, ManifestFileEntry } from "../types.ts"
import { snapshotBinaryFile } from "./binary-handler.ts"
import type { BinarySnapshot } from "./binary-handler.ts"

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
    // For database files, create a consistent snapshot first
    let snapshot: BinarySnapshot | null = null
    let readPath = file.absolutePath
    if (file.category === "database") {
      snapshot = await snapshotBinaryFile(file.absolutePath, file.category)
      readPath = snapshot.tempPath
    }

    try {
      let content = await readFile(readPath)
      const hash = sha256Hex(content)

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
    } finally {
      if (snapshot) await snapshot.cleanup()
    }
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
