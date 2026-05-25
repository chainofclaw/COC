import { importer } from "ipfs-unixfs-importer"
import { fixedSize } from "ipfs-unixfs-importer/chunker"
import { balanced } from "ipfs-unixfs-importer/layout"
import type { InterfaceBlockstoreAdapter } from "./ipfs-blockstore-adapter.ts"

/**
 * Write-path directory DAG construction (issue #468).
 *
 * COC's bespoke `UnixFsBuilder.addFile` stays the single-file path (it
 * carries the PoSe `merkleRoot`/`merkleLeaves` side-tree). For multi-file
 * and nested-directory uploads we delegate to `ipfs-unixfs-importer`,
 * which builds the dag-pb directory tree from a flat list of POSIX paths
 * and — when a directory's serialized node exceeds the shard threshold —
 * automatically emits `hamt-sharded-directory` nodes. The importer is the
 * canonical IPFS implementation, so the produced DAGs are byte-identical
 * to kubo/Helia and interoperable with every public gateway.
 */

/** Fixed chunk size — mirrors `UnixFsBuilder` and the value advertised by
 * `validateAddParams` (`chunker=size-262144`). */
const CHUNK_SIZE = 262144

export interface DirEntryInput {
  /** POSIX-style relative path, e.g. `docs/img/logo.png`. */
  path: string
  /** File bytes. Omit for an explicit (possibly empty) directory entry. */
  content?: Uint8Array
}

export interface ImportedNode {
  path: string
  cid: string
  size: number
  type: "file" | "directory" | "hamt-sharded-directory" | "raw"
}

export interface DirectoryImportResult {
  /** The wrapping root directory (last node yielded by the importer). */
  root: ImportedNode
  /** Every node emitted — children first, root last. */
  all: ImportedNode[]
}

/**
 * Build a UnixFS directory DAG from a flat list of path/content entries.
 *
 * Intermediate directories are created implicitly (`a/b/c.txt` materialises
 * `a` and `a/b`). The result is always wrapped in a single root directory.
 *
 * The importer config is pinned for kubo parity and to match the leaf
 * encoding `UnixFsBuilder.addFile` produces (UnixFS-wrapped file leaves, not
 * raw leaves), so a file uploaded bare vs. inside a directory chunks the
 * same way:
 *   - `chunker: fixedSize(262144)`  — 256 KiB fixed chunks
 *   - `layout: balanced()`          — balanced DAG
 *   - `rawLeaves: false` + `leafType: 'file'` — UnixFS file leaves
 *   - `cidVersion: 1`               — base32 `bafy…` CIDs
 *   - `shardSplitThresholdBytes` / `shardFanoutBits` left at kubo defaults
 *     (256 KiB / fanout 256) so HAMT sharding triggers identically.
 */
export async function buildDirectoryDag(
  entries: DirEntryInput[],
  blockstore: InterfaceBlockstoreAdapter,
  signal?: AbortSignal,
): Promise<DirectoryImportResult> {
  const candidates = entries.map((e) =>
    e.content !== undefined ? { path: e.path, content: e.content } : { path: e.path },
  )

  // #15 (audit follow-up): honour an optional abort signal. The read
  // path (`resolveUnixfsPath`) has been timeout-bounded since #468;
  // the write path was not, leaving room for a slow / large upload to
  // pin the importer indefinitely. Callers in `ipfs-http.ts` set a
  // bounded `AbortSignal.timeout(IPFS_RESOLVE_TIMEOUT_MS)` so a stalled
  // importer surfaces as a fast error rather than wedging the handler.
  const all: ImportedNode[] = []
  for await (const node of importer(candidates, blockstore, {
    wrapWithDirectory: true,
    chunker: fixedSize({ chunkSize: CHUNK_SIZE }),
    layout: balanced(),
    rawLeaves: false,
    leafType: "file",
    cidVersion: 1,
    signal,
  } as Parameters<typeof importer>[2])) {
    // Fast-bail mid-import if the caller aborted (rare — the importer
    // already honours `signal` internally, but the throw-on-abort
    // contract is centralised here).
    if (signal?.aborted) {
      throw new Error(`buildDirectoryDag aborted: ${String(signal.reason ?? "AbortError")}`)
    }
    all.push({
      path: node.path ?? "",
      cid: node.cid.toString(),
      size: Number(node.size),
      type: (node.unixfs?.type as ImportedNode["type"]) ?? "raw",
    })
  }

  if (all.length === 0) {
    throw new Error("importer produced no nodes")
  }
  // With wrapWithDirectory the importer yields children first and the
  // wrapping root directory last.
  const root = all[all.length - 1]
  return { root, all }
}
