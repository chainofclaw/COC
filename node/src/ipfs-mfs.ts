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
    // #600: kubo CLI errors `mkdir /existing` with "file already exists"
    // when called without -p; only `mkdir -p` is idempotent. Pre-fix this
    // returned silently for both shapes, so a caller running
    //   files/mkdir?arg=/data&parents=false
    // twice got back 200 ok both times, never learning their first call
    // had won the race. Sibling write() still relies on idempotence via
    // its own parents=true call (line 124), which is still honoured.
    if (this.dirs.has(normalized)) {
      if (opts?.parents) return
      throw new Error(`file already exists: ${normalized}`)
    }

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
          // #555: pre-fix the message interpolated `parent` (the dir we
          // just successfully walked into) instead of `current` (the
          // path we just found is missing). A user running
          // `mkdir /no_such_a/sub_b` got "parent directory not found: /"
          // and concluded the root was gone. Same wording-drift family
          // as #543/#545 — error built from visited-so-far instead of
          // failed-now state.
          throw new Error(`parent directory not found: ${current}`)
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

    let finalData = data
    // #541: partial-overwrite merge must run whenever truncate is off, NOT
    // only for explicit-offset writes. Kubo's `files write` defaults to
    // truncate=false + offset=0, meaning a short write overwrites bytes
    // [0, data.length) and PRESERVES trailing bytes. The pre-fix
    // `opts?.offset !== undefined` clause skipped the merge for the common
    // default-offset case, so every short write silently truncated the
    // file — data loss for log appenders, journal patches, JSON merges.
    // truncate=true still bypasses the merge to replace the whole file.
    if (existing && !opts?.truncate) {
      const offset = opts?.offset ?? 0
      if (offset < 0) throw new Error("offset must be non-negative")
      // Guard against memory exhaustion from large offset + data.length
      const MAX_WRITE_SIZE = 64 * 1024 * 1024 // 64 MiB
      const mergedSize = offset + data.length
      if (mergedSize > MAX_WRITE_SIZE) throw new Error(`write would exceed max size (${MAX_WRITE_SIZE} bytes)`)
      // Append/overwrite at offset, preserving any trailing bytes.
      const existingData = await this.unixfs.readFile(existing.cid)
      const merged = new Uint8Array(Math.max(existingData.length, mergedSize))
      merged.set(existingData)
      merged.set(data, offset)
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

    const { dir: srcDir, base: srcBase } = splitPath(srcNorm)
    const { dir: destDir, base: destBase } = splitPath(destNorm)

    // #477: validate source exists BEFORE applying the same-path no-op
    // short-circuit. Pre-fix `mv /missing /missing` silently returned
    // ok:true even though no file existed — POSIX mv and kubo go-ipfs-
    // mfs both error in this case. The early return masked client bugs
    // where dest computation yielded the same path as src.
    const srcParent = this.dirs.get(srcDir)
    if (!srcParent) throw new Error(`source not found: ${srcNorm}`)

    const entry = srcParent.entries.get(srcBase)
    if (!entry) throw new Error(`source not found: ${srcNorm}`)

    // #420: pre-fix `if (srcNorm === destNorm) return` silently succeeded
    // for `mv /a /a`, masking client typos (variable confusion, accidental
    // copy-paste). POSIX `mv /a /a` rejects with "are the same file"; kubo's
    // MFS does the same. Reject so a buggy client learns about misuse
    // instead of getting a silent 200 ok. Same class as #380 (empty mkdir
    // arg silent ok) and #418 (whitespace-only path components).
    if (srcNorm === destNorm) {
      throw new Error(`source and destination are the same: ${srcNorm}`)
    }

    // Prevent moving a directory into its own subtree
    if (destNorm.startsWith(srcNorm + "/")) {
      throw new Error(`cannot move directory into its own subdirectory: ${srcNorm} -> ${destNorm}`)
    }

    const destParent = this.dirs.get(destDir)
    if (!destParent) throw new Error(`destination directory not found: ${destDir}`)

    // #539: kubo's `files/mv` MUST error if destination already exists —
    // pre-fix the `destParent.entries.set(destBase, ...)` call silently
    // overwrote any existing entry at the destination path, clobbering the
    // file the caller didn't intend to replace. Live testnet 88780 repro
    // (pre-fix): mv /src.txt(AAA) → /dst.txt(BBB) succeeded with no
    // warning, then dst.txt's content was AAA — BBB lost. This is a
    // data-loss bug for any client that uses MFS as a versioned filesystem
    // (web3.storage clones, distributed wikis, archive systems).
    if (destParent.entries.has(destBase)) {
      throw new Error(`destination already exists: ${destNorm}`)
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

    const { dir: srcDir, base: srcBase } = splitPath(srcNorm)
    const { dir: destDir, base: destBase } = splitPath(destNorm)

    // #477: validate source exists BEFORE the same-path no-op short-
    // circuit. Pre-fix `cp /missing /missing` silently returned ok:true.
    // POSIX cp + kubo go-ipfs-mfs both error on missing source even
    // when src == dst.
    const srcParent = this.dirs.get(srcDir)
    if (!srcParent) throw new Error(`source not found: ${srcNorm}`)

    const entry = srcParent.entries.get(srcBase)
    if (!entry) throw new Error(`source not found: ${srcNorm}`)

    // #420: same POSIX/kubo alignment as mv above — `cp /a /a` rejects
    // instead of silent no-op so client typos surface.
    if (srcNorm === destNorm) {
      throw new Error(`source and destination are the same: ${srcNorm}`)
    }

    // Prevent copying a directory into its own subtree (infinite recursion)
    if (destNorm.startsWith(srcNorm + "/")) {
      throw new Error(`cannot copy directory into its own subdirectory: ${srcNorm} -> ${destNorm}`)
    }

    const destParent = this.dirs.get(destDir)
    if (!destParent) throw new Error(`destination directory not found: ${destDir}`)

    // #539: kubo's `files/cp` MUST error if destination already exists —
    // same fix as `mv` above. Pre-fix the `destParent.entries.set` call
    // silently overwrote any existing entry, losing the original file
    // content. Even though IPFS data is content-addressed (the original
    // CID is still recoverable in theory), the MFS namespace mapping is
    // lost, breaking any tooling that uses MFS paths as a stable
    // reference.
    if (destParent.entries.has(destBase)) {
      throw new Error(`destination already exists: ${destNorm}`)
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
      // kubo's files/stat returns the directory's content-addressed CID,
      // not an empty string. Reuse flush()'s listing-based CID build so
      // stat and flush agree on the same hash for the same directory.
      // CumulativeSize is the sum of immediate-child sizes — a coarse
      // approximation of kubo's dag-pb cumulative size, but non-zero so
      // clients can spot the dir has content.
      const hash = await this.flush(normalized)
      let cumulativeSize = 0
      for (const entry of dir.entries.values()) cumulativeSize += entry.size
      return {
        hash,
        size: 0,
        cumulativeSize,
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
    // #418: sibling of #380 (which rejected empty arg). Whitespace-only
    // path components (`%20`, `%09`, `%20%20%20`) sailed through here
    // pre-fix and downstream mkdir/write created files/dirs named " ",
    // "\t", "   " — silent garbage in the MFS namespace, indistinguishable
    // from a real empty-name component. Reject so client typos surface
    // (e.g. forgetting to fill in a template variable, accidental
    // urlencoded space, copy-paste of leading/trailing whitespace).
    if (part.length > 0 && /^\s+$/.test(part)) {
      throw new Error(`path component cannot be whitespace-only: ${path}`)
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
