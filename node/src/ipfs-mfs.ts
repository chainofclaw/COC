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
const MAX_MFS_DEPTH = 64

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

      // #302: even with parents=true, every intermediate component must
      // either not exist OR exist as a directory. Pre-fix, mkdir blindly
      // overwrote a file entry with a directory entry (line 75/81), silently
      // orphaning UnixFS file content and producing dirs.get() + parent.entries
      // pointing to the same name with different types. Reproduced live on
      // 88780: `write /a/file.txt` then `mkdir /a/file.txt/sub --parents`
      // returned 200 and `ls /a/file.txt` then listed `sub` as a child entry.
      const parentDir = this.dirs.get(parent)
      const existingEntry = parentDir?.entries.get(parts[i])
      if (existingEntry && existingEntry.type === "file") {
        throw new Error(`not a directory: ${current}`)
      }

      if (!opts?.parents && i < parts.length - 1) {
        if (!parentDir?.entries.has(parts[i])) {
          throw new Error(`parent directory not found: ${parent}`)
        }
      }

      // Create directory node
      this.dirs.set(current, { entries: new Map() })

      // Register in parent
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

    // #306: validate offset on ALL paths (new file, truncate, and overwrite),
    // not just the `existing && !truncate` overwrite path. Pre-fix the offset
    // check lived inside the overwrite branch only, so:
    //   - `create:true` (no existing) + negative offset → silently dropped
    //   - `create:true` + non-numeric offset → silently dropped (NaN)
    //   - `truncate:true` + offset → silently dropped
    // The HTTP route never forwarded offset to mfs.write either (#306 sibling
    // fix in ipfs-http.ts), so these were doubly hidden. Now offset is
    // validated up-front and applied uniformly per kubo MFS semantics:
    //   write(path, data, {offset:N})  → file = zeros(N) + data + tail(existing)
    if (opts?.offset !== undefined) {
      if (!Number.isFinite(opts.offset) || !Number.isInteger(opts.offset) || opts.offset < 0) {
        throw new Error(`invalid offset: ${opts.offset} (must be non-negative integer)`)
      }
    }

    const MAX_WRITE_SIZE = 64 * 1024 * 1024 // 64 MiB
    let finalData = data

    if (opts?.offset !== undefined && opts.offset > 0) {
      const mergedSize = opts.offset + data.length
      if (mergedSize > MAX_WRITE_SIZE) {
        throw new Error(`write would exceed max size (${MAX_WRITE_SIZE} bytes)`)
      }

      // For new-file or truncate cases, start from a zero buffer of length offset.
      // For existing+!truncate, start from existing content (preserve tail).
      const useExisting = existing && !opts?.truncate
      const existingData = useExisting ? await this.unixfs.readFile(existing!.cid) : new Uint8Array(0)
      const merged = new Uint8Array(Math.max(existingData.length, mergedSize))
      if (useExisting) merged.set(existingData)
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
      if (start > data.length) return new Uint8Array()
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

    // No-op when source and destination are identical
    if (srcNorm === destNorm) return

    // Prevent moving a directory into its own subtree
    if (destNorm.startsWith(srcNorm + "/")) {
      throw new Error(`cannot move directory into its own subdirectory: ${srcNorm} -> ${destNorm}`)
    }

    const { dir: srcDir, base: srcBase } = splitPath(srcNorm)
    const { dir: destDir, base: destBase } = splitPath(destNorm)

    const srcParent = this.dirs.get(srcDir)
    if (!srcParent) throw new Error(`source not found: ${srcNorm}`)

    const entry = srcParent.entries.get(srcBase)
    if (!entry) throw new Error(`source not found: ${srcNorm}`)

    const destParent = this.dirs.get(destDir)
    if (!destParent) throw new Error(`destination directory not found: ${destDir}`)

    // #304: dst is itself a directory — pre-fix this silently overwrote
    // the parent's entry to point at src's CID while leaving the dir node
    // in `this.dirs` intact, producing a path that responds as a directory
    // to ls/stat AND returns the moved file's content to /api/v0/files/read.
    // Live-reproducible on 88780; data integrity break. POSIX kubo would
    // copy/move INTO the dir as `dst/<basename(src)>`; that's the right
    // long-term behaviour but for now reject so the silent corruption
    // cannot happen. Filed as follow-up in #304.
    if (this.dirs.has(destNorm)) {
      throw new Error(`destination is a directory: ${destNorm}`)
    }
    // #304 sibling: dst parent entry exists with a DIFFERENT type than src
    // (e.g. mv directory onto an existing file). Pre-fix would clobber the
    // file entry with a directory entry without removing the orphan UnixFS
    // CID — same data-integrity hole. POSIX errors out, so do we.
    const existingAtDest = destParent.entries.get(destBase)
    if (existingAtDest && existingAtDest.type !== entry.type) {
      throw new Error(
        `destination type mismatch: ${destNorm} is a ${existingAtDest.type}, source is a ${entry.type}`,
      )
    }

    // Move entry
    destParent.entries.set(destBase, { ...entry, name: destBase, modifiedMs: Date.now() })
    srcParent.entries.delete(srcBase)

    // If it's a directory, relocate it and all nested subdirectories in the dirs map
    if (entry.type === "directory") {
      const srcPrefix = srcNorm + "/"
      const keysToMove: string[] = []
      for (const key of this.dirs.keys()) {
        if (key === srcNorm || key.startsWith(srcPrefix)) {
          keysToMove.push(key)
        }
      }
      for (const key of keysToMove) {
        const dirNode = this.dirs.get(key)!
        const newKey = key === srcNorm ? destNorm : destNorm + key.slice(srcNorm.length)
        this.dirs.set(newKey, dirNode)
        this.dirs.delete(key)
      }
    }
  }

  /**
   * Copy a file or directory.
   */
  async cp(source: string, dest: string): Promise<void> {
    const srcNorm = normalizePath(source)
    const destNorm = normalizePath(dest)

    // No-op when source and destination are identical
    if (srcNorm === destNorm) return

    // Prevent copying a directory into its own subtree (infinite recursion)
    if (destNorm.startsWith(srcNorm + "/")) {
      throw new Error(`cannot copy directory into its own subdirectory: ${srcNorm} -> ${destNorm}`)
    }

    const { dir: srcDir, base: srcBase } = splitPath(srcNorm)
    const { dir: destDir, base: destBase } = splitPath(destNorm)

    const srcParent = this.dirs.get(srcDir)
    if (!srcParent) throw new Error(`source not found: ${srcNorm}`)

    const entry = srcParent.entries.get(srcBase)
    if (!entry) throw new Error(`source not found: ${srcNorm}`)

    const destParent = this.dirs.get(destDir)
    if (!destParent) throw new Error(`destination directory not found: ${destDir}`)

    // #304: same type-clobbering bug as mv — see comments at mv() above.
    // cp src dst where dst is itself a directory pre-fix overwrote the
    // parent entry to a file entry while leaving the dir node intact,
    // making read(dst) return src's content while ls(dst) still listed
    // the original children. Reject; kubo "cp into dir" is deferred.
    if (this.dirs.has(destNorm)) {
      throw new Error(`destination is a directory: ${destNorm}`)
    }
    const existingAtDest = destParent.entries.get(destBase)
    if (existingAtDest && existingAtDest.type !== entry.type) {
      throw new Error(
        `destination type mismatch: ${destNorm} is a ${existingAtDest.type}, source is a ${entry.type}`,
      )
    }

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

  private async removeRecursive(path: string, depth = 0): Promise<void> {
    if (depth >= MAX_MFS_DEPTH) throw new Error(`directory nesting too deep (max ${MAX_MFS_DEPTH}): ${path}`)
    const dir = this.dirs.get(path)
    if (!dir) return

    for (const [name, entry] of dir.entries) {
      if (entry.type === "directory") {
        const childPath = path === "/" ? `/${name}` : `${path}/${name}`
        await this.removeRecursive(childPath, depth + 1)
        this.dirs.delete(childPath)
      }
    }
  }

  private async deepCopyDir(src: string, dest: string, depth = 0): Promise<void> {
    if (depth >= MAX_MFS_DEPTH) throw new Error(`directory nesting too deep (max ${MAX_MFS_DEPTH}): ${src}`)
    const srcDir = this.dirs.get(src)
    if (!srcDir) return

    const destDir: DirNode = { entries: new Map(srcDir.entries) }
    this.dirs.set(dest, destDir)

    for (const [name, entry] of srcDir.entries) {
      if (entry.type === "directory") {
        const srcChild = src === "/" ? `/${name}` : `${src}/${name}`
        const destChild = dest === "/" ? `/${name}` : `${dest}/${name}`
        await this.deepCopyDir(srcChild, destChild, depth + 1)
      }
    }
  }
}

const MAX_PATH_LENGTH = 4096

function normalizePath(path: string): string {
  if (path.length > MAX_PATH_LENGTH) {
    throw new Error(`path too long (max ${MAX_PATH_LENGTH}): ${path.length} chars`)
  }
  // Reject null bytes which can truncate paths in filesystem operations
  if (path.includes("\0")) {
    throw new Error(`null byte in path not allowed`)
  }
  if (!path.startsWith("/")) path = "/" + path
  // Remove trailing slash (except root)
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1)
  }
  // Collapse double slashes
  path = path.replace(/\/+/g, "/")
  // Reject path traversal components
  const parts = path.split("/")
  if (parts.length > MAX_MFS_DEPTH) {
    throw new Error(`path too deep (max ${MAX_MFS_DEPTH} components): ${path}`)
  }
  for (const part of parts) {
    if (part === ".." || part === ".") {
      throw new Error(`path traversal not allowed: ${path}`)
    }
  }
  return path
}

function splitPath(path: string): { dir: string; base: string } {
  const normalized = normalizePath(path)
  if (normalized === "/") throw new Error("cannot operate on root path directly")
  const lastSlash = normalized.lastIndexOf("/")
  if (lastSlash <= 0) return { dir: "/", base: normalized.slice(1) }
  return {
    dir: normalized.slice(0, lastSlash),
    base: normalized.slice(lastSlash + 1),
  }
}
