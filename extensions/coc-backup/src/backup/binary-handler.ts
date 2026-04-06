// Binary file snapshot handler for consistent database backups
// Handles SQLite (VACUUM INTO) and LanceDB (directory tar) snapshots

import { execFile } from "node:child_process"
import { mkdtemp, readdir, stat, readFile, writeFile, rm, mkdir } from "node:fs/promises"
import { join, basename, relative } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import type { FileCategory } from "../types.ts"

const execFileAsync = promisify(execFile)

export interface BinarySnapshot {
  tempPath: string
  originalPath: string
  cleanup: () => Promise<void>
}

/**
 * Create a consistent snapshot of a binary file (SQLite or LanceDB directory).
 * Returns a temporary copy safe for reading while the original may be actively written.
 */
export async function snapshotBinaryFile(
  absolutePath: string,
  _category: FileCategory,
): Promise<BinarySnapshot> {
  const fileStat = await stat(absolutePath)

  if (fileStat.isDirectory()) {
    return snapshotDirectory(absolutePath)
  }

  if (absolutePath.endsWith(".sqlite")) {
    return snapshotSqlite(absolutePath)
  }

  // Fallback: plain file copy
  return snapshotFileCopy(absolutePath)
}

/**
 * Snapshot a SQLite database using VACUUM INTO for consistency.
 * Falls back to WAL checkpoint + file copy if VACUUM INTO is unavailable.
 */
async function snapshotSqlite(dbPath: string): Promise<BinarySnapshot> {
  const tempDir = await mkdtemp(join(tmpdir(), "coc-backup-sqlite-"))
  const tempPath = join(tempDir, basename(dbPath))

  try {
    // Primary: VACUUM INTO creates a self-contained consistent copy
    await execFileAsync("sqlite3", [dbPath, `.backup '${tempPath}'`], {
      timeout: 30_000,
    })
    return {
      tempPath,
      originalPath: dbPath,
      cleanup: () => rm(tempDir, { recursive: true, force: true }),
    }
  } catch {
    // Fallback: direct file copy (less safe but works without sqlite3 CLI)
    try {
      const content = await readFile(dbPath)
      await writeFile(tempPath, content)

      // Also copy WAL and SHM if they exist
      for (const suffix of ["-wal", "-shm"]) {
        try {
          const walContent = await readFile(dbPath + suffix)
          await writeFile(tempPath + suffix, walContent)
        } catch {
          // WAL/SHM may not exist, that's fine
        }
      }

      return {
        tempPath,
        originalPath: dbPath,
        cleanup: () => rm(tempDir, { recursive: true, force: true }),
      }
    } catch (copyError) {
      await rm(tempDir, { recursive: true, force: true })
      throw new Error(`Failed to snapshot SQLite database ${dbPath}: ${String(copyError)}`)
    }
  }
}

/**
 * Snapshot a directory (e.g., LanceDB) by creating a tar archive.
 * The tar file is uploaded as a single IPFS block.
 */
async function snapshotDirectory(dirPath: string): Promise<BinarySnapshot> {
  const tempDir = await mkdtemp(join(tmpdir(), "coc-backup-dir-"))
  const tarPath = join(tempDir, `${basename(dirPath)}.tar`)

  try {
    // Collect all files recursively
    const files = await collectFiles(dirPath)
    const entries: Array<{ relativePath: string; content: Buffer }> = []

    for (const filePath of files) {
      const content = await readFile(filePath)
      entries.push({
        relativePath: relative(dirPath, filePath),
        content: Buffer.from(content),
      })
    }

    // Build a simple tar-like archive (header + content pairs)
    const archive = buildSimpleTar(entries)
    await writeFile(tarPath, archive)

    return {
      tempPath: tarPath,
      originalPath: dirPath,
      cleanup: () => rm(tempDir, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw new Error(`Failed to snapshot directory ${dirPath}: ${String(error)}`)
  }
}

/** Plain file copy fallback */
async function snapshotFileCopy(filePath: string): Promise<BinarySnapshot> {
  const tempDir = await mkdtemp(join(tmpdir(), "coc-backup-file-"))
  const tempPath = join(tempDir, basename(filePath))
  const content = await readFile(filePath)
  await writeFile(tempPath, content)
  return {
    tempPath,
    originalPath: filePath,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  }
}

/** Recursively collect all file paths in a directory */
async function collectFiles(dirPath: string): Promise<string[]> {
  const result: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        result.push(full)
      }
    }
  }

  await walk(dirPath)
  return result
}

/**
 * Build a simple archive format: JSON index + concatenated file contents.
 * Format: [4-byte index length][JSON index][file1 content][file2 content]...
 * Each index entry: { path, offset, size }
 */
function buildSimpleTar(
  entries: Array<{ relativePath: string; content: Buffer }>,
): Buffer {
  let dataOffset = 0
  const index = entries.map((entry) => {
    const item = {
      path: entry.relativePath,
      offset: dataOffset,
      size: entry.content.length,
    }
    dataOffset += entry.content.length
    return item
  })

  const indexJson = JSON.stringify(index)
  const indexBuf = Buffer.from(indexJson, "utf8")
  const headerBuf = Buffer.alloc(4)
  headerBuf.writeUInt32BE(indexBuf.length, 0)

  return Buffer.concat([
    headerBuf,
    indexBuf,
    ...entries.map((e) => e.content),
  ])
}

/**
 * Extract files from a simple archive created by buildSimpleTar.
 */
export function extractSimpleTar(
  archive: Buffer,
): Array<{ relativePath: string; content: Buffer }> {
  const indexLen = archive.readUInt32BE(0)
  const indexJson = archive.subarray(4, 4 + indexLen).toString("utf8")
  const index: Array<{ path: string; offset: number; size: number }> = JSON.parse(indexJson)

  const dataStart = 4 + indexLen
  return index.map((entry) => ({
    relativePath: entry.path,
    content: Buffer.from(archive.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size)),
  }))
}
