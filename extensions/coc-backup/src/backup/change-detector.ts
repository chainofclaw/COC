// Change detection: compare current files against previous manifest
// Uses mtime for fast pre-filter, then SHA-256 for confirmation

import { readdir, stat, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const MAX_FILE_BYTES = 100 * 1024 * 1024 // 100 MB
import { sha256Hex } from "../crypto.ts"
import type { FileState, FileCategory, ChangeSet, SnapshotManifest } from "../types.ts"
import type { CocBackupConfig } from "../config-schema.ts"

// File classification rules
const FILE_RULES: Array<{ pattern: RegExp; category: FileCategory; encrypt: boolean }> = [
  { pattern: /^IDENTITY\.md$/, category: "identity", encrypt: false },
  { pattern: /^SOUL\.md$/, category: "identity", encrypt: false },
  { pattern: /^identity\/device\.json$/, category: "config", encrypt: true },
  { pattern: /^auth\.json$/, category: "config", encrypt: true },
  { pattern: /^MEMORY\.md$/, category: "memory", encrypt: false },
  { pattern: /^memory\/.*\.md$/, category: "memory", encrypt: false },
  { pattern: /^USER\.md$/, category: "memory", encrypt: false },
  { pattern: /^agents\/.*\/sessions\/.*\.jsonl$/, category: "chat", encrypt: false },
  { pattern: /^workspace-state\.json$/, category: "workspace", encrypt: false },
  { pattern: /^AGENTS\.md$/, category: "workspace", encrypt: false },
]

function classifyFile(relativePath: string): { category: FileCategory; encrypt: boolean } | null {
  for (const rule of FILE_RULES) {
    if (rule.pattern.test(relativePath)) {
      return { category: rule.category, encrypt: rule.encrypt }
    }
  }
  return null
}

/** Recursively scan directory for backup-eligible files */
async function scanFiles(baseDir: string, config: CocBackupConfig): Promise<FileState[]> {
  const files: FileState[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Skip hidden dirs except .claude
        if (entry.name.startsWith(".") && entry.name !== ".claude") continue
        await walk(fullPath)
      } else if (entry.isFile()) {
        const relPath = relative(baseDir, fullPath)
        const classification = classifyFile(relPath)
        if (!classification) continue

        // Check if category is enabled
        const catKey = classification.category as keyof typeof config.categories
        if (config.categories[catKey] === false) continue

        const fileStat = await stat(fullPath)
        if (fileStat.size > MAX_FILE_BYTES) continue
        const content = await readFile(fullPath)
        const hash = sha256Hex(content)

        // Memory encryption override
        const shouldEncrypt = classification.encrypt ||
          (classification.category === "memory" && config.encryptMemory)

        files.push({
          relativePath: relPath,
          absolutePath: fullPath,
          hash,
          sizeBytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          encrypted: shouldEncrypt,
          category: classification.category,
        })
      }
    }
  }

  await walk(baseDir)
  return files
}

/** Detect changes between current files and previous manifest */
export async function detectChanges(
  baseDir: string,
  config: CocBackupConfig,
  previousManifest: SnapshotManifest | null,
): Promise<ChangeSet> {
  const currentFiles = await scanFiles(baseDir, config)

  if (!previousManifest) {
    // No previous backup — everything is new
    return {
      added: currentFiles,
      modified: [],
      deleted: [],
      unchanged: [],
    }
  }

  const prevFiles = previousManifest.files
  const prevPaths = new Set(Object.keys(prevFiles))

  const added: FileState[] = []
  const modified: FileState[] = []
  const unchanged: FileState[] = []

  for (const file of currentFiles) {
    const prev = prevFiles[file.relativePath]
    if (!prev) {
      added.push(file)
    } else if (prev.hash !== file.hash) {
      modified.push(file)
    } else {
      unchanged.push(file)
    }
    prevPaths.delete(file.relativePath)
  }

  // Remaining paths in prevPaths were deleted
  const deleted = [...prevPaths]

  return { added, modified, deleted, unchanged }
}
