import { CID } from "multiformats/cid"
import { exporter } from "ipfs-unixfs-exporter"
import type { UnixFSEntry } from "ipfs-unixfs-exporter"
import type { InterfaceBlockstoreAdapter } from "./ipfs-blockstore-adapter.ts"

/**
 * Read-path UnixFS directory DAG navigation (issue #468).
 *
 * Resolves `<rootCid>/<seg>/<seg>…` by walking the DAG one path component
 * at a time. Each hop delegates to `ipfs-unixfs-exporter`, so plain
 * `directory` nodes (name lookup) **and** `hamt-sharded-directory` nodes
 * (transparent shard descent) both work without us re-implementing the
 * murmur3/bucket math.
 *
 * Walking segment-by-segment (rather than handing the whole path to the
 * exporter in one call) lets us distinguish the two failure modes the
 * exporter conflates into `ERR_NOT_FOUND`: a missing path component
 * (404 "no such file") vs. trying to descend into a file (400 "not a
 * directory").
 */

/** Max number of path components after the root CID. Guards against a
 * malicious arg with thousands of segments forcing thousands of hops. */
export const MAX_PATH_DEPTH = 64
/** Max directory entries enumerated by {@link listDirectory}. Aligned with
 * `ipfs-unixfs.ts`'s `MAX_READ_LINKS`. */
export const MAX_DIR_ENTRIES = 10_000
/** Max cumulative bytes streamed by {@link readEntryBytes}. Aligned with
 * `ipfs-unixfs.ts`'s `MAX_READ_SIZE`. */
export const MAX_READ_SIZE = 50 * 1024 * 1024
/** Max blocks a single resolve/read may pull through the blockstore. */
export const MAX_BLOCK_READS = 50_000

export type ResolvedType = "file" | "directory" | "raw"

export class PathResolveError extends Error {
  readonly kind: "not_found" | "not_a_directory"
  /** 0-based index of the path segment that failed. 0 means the root
   * node itself (e.g. a file CID given a subpath). */
  readonly depth: number
  constructor(kind: "not_found" | "not_a_directory", message: string, depth = 0) {
    super(message)
    this.name = "PathResolveError"
    this.kind = kind
    this.depth = depth
  }

  /**
   * #15 (audit follow-up): the constructor's `message` carries the
   * specific CID + path segment that failed (useful for operator
   * logs), but echoing it back to anonymous callers is a side-channel
   * — by enumerating `<known-dir-cid>/<guess>` an attacker can learn
   * which CIDs the node has resolved (timing + "no link named 'foo'"
   * vs "block not found" distinguishes hot/cold paths) and which
   * link names exist inside a private directory.
   *
   * HTTP responders MUST surface `publicMessage` rather than `message`
   * so the wire body is a non-enumerable short code; full detail
   * still lands in `log.warn`.
   */
  get publicMessage(): string {
    return this.kind === "not_a_directory"
      ? "this dag node is not a directory"
      : "no such file"
  }
}

export interface ResolvedEntry {
  /** CID of the resolved node (a leaf/sub-CID, not necessarily the root). */
  cid: string
  type: ResolvedType
  /** UnixFS logical size: file byte count, or directory entry count. */
  size: number
  /** The underlying exporter entry — used for content()/listing. */
  entry: UnixFSEntry
}

export interface DirectoryLink {
  name: string
  cid: string
  size: number
  type: "file" | "directory"
}

function isNotFound(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: string }).code === "ERR_NOT_FOUND"
}

function normalizeType(t: UnixFSEntry["type"]): ResolvedType {
  if (t === "directory") return "directory"
  if (t === "file") return "file"
  // raw / identity / object — treat as opaque leaf bytes.
  return "raw"
}

/**
 * Resolve `rootCid` plus zero or more path `segments` to a single DAG node.
 *
 * @throws {PathResolveError} `not_found` for a missing component,
 *   `not_a_directory` when a non-directory is encountered mid-path.
 */
export async function resolveUnixfsPath(
  rootCid: string,
  segments: string[],
  blockstore: InterfaceBlockstoreAdapter,
  signal?: AbortSignal,
): Promise<ResolvedEntry> {
  if (segments.length > MAX_PATH_DEPTH) {
    throw new PathResolveError("not_found", `path too deep (max ${MAX_PATH_DEPTH} segments)`)
  }

  let currentCid = rootCid
  let entry: UnixFSEntry
  try {
    entry = await exporter(rootCid, blockstore, { signal })
  } catch (err) {
    if (isNotFound(err)) throw new PathResolveError("not_found", `block not found: ${rootCid}`)
    throw err
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const type = normalizeType(entry.type)
    if (type !== "directory") {
      throw new PathResolveError(
        "not_a_directory",
        `cannot descend into '${seg}': ${currentCid} is not a directory`,
        i,
      )
    }
    try {
      // One hop. The exporter does plain-name lookup or HAMT shard descent
      // for `<dir-cid>/<seg>` depending on the directory node type.
      entry = await exporter(`${currentCid}/${seg}`, blockstore, { signal })
    } catch (err) {
      if (isNotFound(err)) {
        throw new PathResolveError("not_found", `no link named '${seg}' under ${currentCid}`, i)
      }
      throw err
    }
    currentCid = entry.cid.toString()
  }

  return { cid: currentCid, type: normalizeType(entry.type), size: Number(entry.size), entry }
}

/**
 * List the children of a resolved directory entry. Throws if the entry is
 * not a directory. Enumeration is capped at {@link MAX_DIR_ENTRIES}.
 */
export async function listDirectory(resolved: ResolvedEntry, signal?: AbortSignal): Promise<DirectoryLink[]> {
  if (resolved.type !== "directory") {
    throw new PathResolveError("not_a_directory", `${resolved.cid} is not a directory`)
  }
  const links: DirectoryLink[] = []
  for await (const child of resolved.entry.content({ signal }) as AsyncIterable<UnixFSEntry>) {
    links.push({
      name: child.name,
      cid: child.cid.toString(),
      size: Number(child.size),
      type: child.type === "directory" ? "directory" : "file",
    })
    if (links.length >= MAX_DIR_ENTRIES) {
      throw new PathResolveError("not_found", `directory has too many entries (max ${MAX_DIR_ENTRIES})`)
    }
  }
  return links
}

/**
 * Read the full byte content of a resolved file/raw entry into one buffer.
 * Enforces {@link MAX_READ_SIZE}. Optional `offset`/`length` slice the file.
 */
export async function readEntryBytes(
  resolved: ResolvedEntry,
  range?: { offset?: number; length?: number },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (resolved.type === "directory") {
    throw new PathResolveError("not_a_directory", `${resolved.cid} is a directory, not a file`)
  }
  const parts: Uint8Array[] = []
  let total = 0
  const opts = { signal, ...(range?.offset !== undefined ? { offset: range.offset } : {}), ...(range?.length !== undefined ? { length: range.length } : {}) }
  for await (const chunk of resolved.entry.content(opts) as AsyncIterable<Uint8Array>) {
    total += chunk.length
    if (total > MAX_READ_SIZE) {
      throw new PathResolveError("not_found", `file exceeds max read size (${MAX_READ_SIZE})`)
    }
    parts.push(chunk)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** True when `value` parses as a CID — used to validate the root component. */
export function isParsableCid(value: string): boolean {
  try {
    CID.parse(value)
    return true
  } catch {
    return false
  }
}
