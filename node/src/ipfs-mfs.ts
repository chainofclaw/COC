/**
 * IPFS Mutable File System (MFS)
 *
 * Implements a mutable file system layer on top of IPFS content-addressed storage.
 * Provides POSIX-like file operations (mkdir, write, read, ls, rm, mv, cp, stat, flush).
 * Files are stored as content-addressed blocks; the MFS tree maps paths to CIDs.
 */

import type { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder } from "./ipfs-unixfs.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("ipfs-mfs")

export interface MfsEntry {
  name: string
  type: "file" | "directory"
  cid: string
  size: number
  createdMs: number
  modifiedMs: number
}

interface DirNode {
  entries: Map<string, MfsEntry>
}

export interface MfsStat {
  hash: string
  size: number
  cumulativeSize: number
  type: "file" | "directory"
  blocks: number
}

export class IpfsMfs {
  private readonly store: IpfsBlockstore
  private readonly unixfs: UnixFsBuilder
  // In-memory MFS tree rooted at "/"
  private readonly dirs = new Map<string, DirNode>()

  constructor(store: IpfsBlockstore, unixfs: UnixFsBuilder) {
    this.store = store
    this.unixfs = unixfs

    // Initialize root directory
    this.dirs.set("/", { entries: new Map() })
  }

  /**
   * Create a directory (and parents if needed).
   */
  async mkdir(path: string, opts?: { parents?: boolean }): Promise<void> {
    const normalized = normalizePath(path)
    if (this.dirs.has(normalized)) return

    const parts = normalized.split("/").filter(Boolean)
    let current = "/"

    for (let i = 0; i < parts.length; i++) {
      const parent = current
      current = current === "/" ? `/${parts[i]}` : `${current}/${parts[i]}`

      if (this.dirs.has(current)) continue

      if (!opts?.parents && i < parts.length - 1) {
        const parentDir = this.dirs.get(parent)
        if (!parentDir?.entries.has(parts[i])) {
          throw new Error(`parent directory not found: ${parent}`)
        }
      }

      // Create directory node
      this.dirs.set(current, { entries: new Map() })

      // Register in parent
      const parentDir = this.dirs.get(parent)
      if (parentDir) {
        const now = Date.now()
        parentDir.entries.set(parts[i], {
          name: parts[i],
          type: "directory",
          cid: "",
          size: 0,
          createdMs: now,
          modifiedMs: now,
        })
      }
    }
  }

  /**
   * Write data to a file path. Creates parent directories if needed.
   */
  async write(
    path: string,
    data: Uint8Array,
    opts?: { create?: boolean; truncate?: boolean; parents?: boolean; offset?: number },
  ): Promise<void> {
    const normalized = normalizePath(path)
    const { dir, base } = splitPath(normalized)

    // Ensure parent directory exists
    if (opts?.parents) {
      await this.mkdir(dir, { parents: true })
    }

    const parentDir = this.dirs.get(dir)
    if (!parentDir) {
      throw new Error(`parent directory not found: ${dir}`)
    }

    const existing = parentDir.entries.get(base)
    if (existing && existing.type === "directory") {
      throw new Error(`path is a directory: ${normalized}`)
    }

    if (!existing && !opts?.create) {
      throw new Error(`file not found: ${normalized} (use create=true to create)`)
    }

    let finalData = data
    if (existing && !opts?.truncate && opts?.offset !== undefined) {
      if (opts.offset < 0) throw new Error("offset must be non-negative")
      // Append/overwrite at offset
      const existingData = await this.unixfs.readFile(existing.cid)
      const merged = new Uint8Array(Math.max(existingData.length, opts.offset + data.length))
      merged.set(existingData)
      merged.set(data, opts.offset)
      finalData = merged
    }

    // Store file via UnixFS
    const meta = await this.unixfs.addFile(base, finalData)
    await this.store.pin(meta.cid)

    const now = Date.now()
    parentDir.entries.set(base, {
      name: base,
      type: "file",
      cid: meta.cid,
      size: finalData.length,
      createdMs: existing?.createdMs ?? now,
      modifiedMs: now,
    })
  }

  /**
   * Read file contents from a path.
   */
  async read(path: string, opts?: { offset?: number; count?: number }): Promise<Uint8Array> {
    const normalized = normalizePath(path)
    const { dir, base } = splitPath(normalized)

    const parentDir = this.dirs.get(dir)
    if (!parentDir) throw new Error(`not found: ${normalized}`)

    const entry = parentDir.entries.get(base)
    if (!entry) throw new Error(`not found: ${normalized}`)
    if (entry.type === "directory") throw new Error(`is a directory: ${normalized}`)

    const data = await this.unixfs.readFile(entry.cid)

    if (opts?.offset !== undefined || opts?.count !== undefined) {
      const start = Math.max(0, opts?.offset ?? 0)
      const count = opts?.count !== undefined ? Math.max(0, opts.count) : undefined
      const end = count !== undefined ? Math.min(start + count, data.length) : data.length
      return data.slice(start, end)
    }

    return data
  }

  /**
   * List directory contents.
   */
  async ls(path: string): Promise<MfsEntry[]> {
    const normalized = normalizePath(path)
    const dir = this.dirs.get(normalized)

    if (!dir) {
      // Check if it's a file
      const { dir: parent, base } = splitPath(normalized)
      const parentDir = this.dirs.get(parent)
      if (parentDir?.entries.has(base)) {
        const entry = parentDir.entries.get(base)!
        return [entry]
      }
      throw new Error(`not found: ${normalized}`)
    }

    return [...dir.entries.values()]
  }

  /**
   * Remove a file or directory.
   */
  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const normalized = normalizePath(path)
    if (normalized === "/") throw new Error("cannot remove root directory")

    const { dir, base } = splitPath(normalized)
    const parentDir = this.dirs.get(dir)
    if (!parentDir) throw new Error(`not found: ${normalized}`)

    const entry = parentDir.entries.get(base)
    if (!entry) throw new Error(`not found: ${normalized}`)

    if (entry.type === "directory") {
      const dirNode = this.dirs.get(normalized)
      if (dirNode && dirNode.entries.size > 0 && !opts?.recursive) {
        throw new Error(`directory not empty: ${normalized}`)
      }

      // Recursively remove subdirectories
      if (opts?.recursive) {
        await this.removeRecursive(normalized)
      }
      this.dirs.delete(normalized)
    }

    parentDir.entries.delete(base)
  }

  /**
   * Move/rename a file or directory.
   */
  async mv(source: string, dest: string): Promise<void> {
    const srcNorm = normalizePath(source)
    const destNorm = normalizePath(dest)

    const { dir: srcDir, base: srcBase } = splitPath(srcNorm)
    const { dir: destDir, base: destBase } = splitPath(destNorm)

    const srcParent = this.dirs.get(srcDir)
    if (!srcParent) throw new Error(`source not found: ${srcNorm}`)

    const entry = srcParent.entries.get(srcBase)
    if (!entry) throw new Error(`source not found: ${srcNorm}`)

    const destParent = this.dirs.get(destDir)
    if (!destParent) throw new Error(`destination directory not found: ${destDir}`)

    // Move entry
    destParent.entries.set(destBase, { ...entry, name: destBase, modifiedMs: Date.now() })
    srcParent.entries.delete(srcBase)

    // If it's a directory, update the dirs map
    if (entry.type === "directory") {
      const dirNode = this.dirs.get(srcNorm)
      if (dirNode) {
        this.dirs.set(destNorm, dirNode)
        this.dirs.delete(srcNorm)
      }
    }
  }

  /**
   * Copy a file or directory.
   */
  async cp(source: string, dest: string): Promise<void> {
    const srcNorm = normalizePath(source)
    const destNorm = normalizePath(dest)

    const { dir: srcDir, base: srcBase } = splitPath(srcNorm)
    const { dir: destDir, base: destBase } = splitPath(destNorm)

    const srcParent = this.dirs.get(srcDir)
    if (!srcParent) throw new Error(`source not found: ${srcNorm}`)

    const entry = srcParent.entries.get(srcBase)
    if (!entry) throw new Error(`source not found: ${srcNorm}`)

    const destParent = this.dirs.get(destDir)
    if (!destParent) throw new Error(`destination directory not found: ${destDir}`)

    // Copy entry (content-addressed, so CID reuse is safe)
    const now = Date.now()
    destParent.entries.set(destBase, {
      ...entry,
      name: destBase,
      createdMs: now,
      modifiedMs: now,
    })

    // If it's a directory, deep copy the tree
    if (entry.type === "directory") {
      await this.deepCopyDir(srcNorm, destNorm)
    }
  }

  /**
   * Get stat info for a path.
   */
  async stat(path: string): Promise<MfsStat> {
    const normalized = normalizePath(path)

    // Check if it's a directory
    const dir = this.dirs.get(normalized)
    if (dir) {
      return {
        hash: "",
        size: 0,
        cumulativeSize: 0,
        type: "directory",
        blocks: dir.entries.size,
      }
    }

    // Check if it's a file
    const { dir: parentPath, base } = splitPath(normalized)
    const parentDir = this.dirs.get(parentPath)
    if (!parentDir) throw new Error(`not found: ${normalized}`)

    const entry = parentDir.entries.get(base)
    if (!entry) throw new Error(`not found: ${normalized}`)

    return {
      hash: entry.cid,
      size: entry.size,
      cumulativeSize: entry.size,
      type: entry.type,
      blocks: 1,
    }
  }

  /**
   * Flush MFS path (ensure data is persisted).
   * Returns the CID of the flushed path.
   */
  async flush(path: string): Promise<string> {
    const normalized = normalizePath(path)
    const dir = this.dirs.get(normalized)

    if (!dir) {
      // File flush: return its CID
      const { dir: parentPath, base } = splitPath(normalized)
      const parentDir = this.dirs.get(parentPath)
      const entry = parentDir?.entries.get(base)
      if (!entry) throw new Error(`not found: ${normalized}`)
      return entry.cid
    }

    // Directory flush: create a directory listing as content
    const listing = JSON.stringify(
      [...dir.entries.values()].map((e) => ({ name: e.name, cid: e.cid, type: e.type, size: e.size })),
    )
    const meta = await this.unixfs.addFile("_dir", new TextEncoder().encode(listing))
    return meta.cid
  }

  private async removeRecursive(path: string): Promise<void> {
    const dir = this.dirs.get(path)
    if (!dir) return

    for (const [name, entry] of dir.entries) {
      if (entry.type === "directory") {
        const childPath = path === "/" ? `/${name}` : `${path}/${name}`
        await this.removeRecursive(childPath)
        this.dirs.delete(childPath)
      }
    }
  }

  private async deepCopyDir(src: string, dest: string): Promise<void> {
    const srcDir = this.dirs.get(src)
    if (!srcDir) return

    const destDir: DirNode = { entries: new Map(srcDir.entries) }
    this.dirs.set(dest, destDir)

    for (const [name, entry] of srcDir.entries) {
      if (entry.type === "directory") {
        const srcChild = src === "/" ? `/${name}` : `${src}/${name}`
        const destChild = dest === "/" ? `/${name}` : `${dest}/${name}`
        await this.deepCopyDir(srcChild, destChild)
      }
    }
  }
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = "/" + path
  // Remove trailing slash (except root)
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1)
  }
  // Collapse double slashes
  path = path.replace(/\/+/g, "/")
  // Reject path traversal components
  const parts = path.split("/")
  for (const part of parts) {
    if (part === ".." || part === ".") {
      throw new Error(`path traversal not allowed: ${path}`)
    }
  }
  return path
}

function splitPath(path: string): { dir: string; base: string } {
  const normalized = normalizePath(path)
  const lastSlash = normalized.lastIndexOf("/")
  if (lastSlash <= 0) return { dir: "/", base: normalized.slice(1) }
  return {
    dir: normalized.slice(0, lastSlash),
    base: normalized.slice(lastSlash + 1),
  }
}
