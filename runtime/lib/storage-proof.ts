/**
 * Storage proof construction for PoSe Storage challenges.
 *
 * Two modes, gated on the `useBlockstore` flag that
 * runtime/coc-node.ts wires from `config.poseStorageFromBlockstore`:
 *
 * 1. Blockstore mode (Phase C2.1): read the UnixFS DAG under `cid` live
 *    via `resolveChunks`, hash every chunk with `hashLeaf`, derive the
 *    Merkle root and the target leaf's proof path on the fly. With
 *    blockstore fetchRemote (C1.3) in play, missing chunks cascade into
 *    peer pulls so a node can answer challenges for CIDs it doesn't
 *    fully pin locally.
 *
 * 2. Pre-baked meta mode (legacy): read `file-meta.json` from the
 *    storage directory. This is the behavior that shipped before
 *    Phase C and stays the default until operators flip the FF after
 *    their cluster has soaked on the new peer-fetch path.
 *
 * Lifted out of `runtime/coc-node.ts` so we can unit-test the logic
 * without starting the HTTP server.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { buildMerklePath, buildMerkleRoot, hashLeaf } from "../../node/src/ipfs-merkle.ts"
import type { UnixFsFileMeta } from "../../node/src/ipfs-types.ts"
import type { IpfsBlockstore } from "../../node/src/ipfs-blockstore.ts"
import { resolveChunks } from "../../node/src/ipfs-unixfs.ts"

export interface StorageProofResult {
  leafHash: string
  merkleRoot: string
  merklePath: string[]
  /**
   * Byte length of the targeted chunk. Optional because the legacy path
   * has no way to derive it without scanning — C2.3's storageBps
   * accumulator only reads this when live mode is on.
   */
  chunkSize?: number
}

/**
 * Bounded LRU of (cid → leafHashes[]). Content-addressed bytes give us
 * immutability by construction, so no invalidation logic is needed;
 * just a size cap against adversarial challenge patterns. Keyed by
 * plain CID string. Export so wrappers / tests can reset or inspect.
 */
export class MerkleLeavesCache {
  private readonly cache = new Map<string, string[]>()
  private readonly maxEntries: number

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries
  }

  get(cid: string): string[] | undefined {
    return this.cache.get(cid)
  }

  put(cid: string, leaves: string[]): void {
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.cache.set(cid, leaves)
  }

  size(): number {
    return this.cache.size
  }

  clear(): void {
    this.cache.clear()
  }
}

export interface LoadStorageProofDeps {
  storageDirPath: string
  /** When present, derive proof from live blockstore content (C2.1). */
  blockstore?: IpfsBlockstore
  /** Shared LRU cache. Caller owns lifetime. */
  cache?: MerkleLeavesCache
}

export async function loadStorageProof(
  deps: LoadStorageProofDeps,
  cid: string,
  chunkIndex: number,
): Promise<StorageProofResult> {
  if (deps.blockstore) {
    return loadFromBlockstore(deps.blockstore, deps.cache, cid, chunkIndex)
  }
  return loadFromMeta(deps.storageDirPath, cid, chunkIndex)
}

async function loadFromBlockstore(
  store: IpfsBlockstore,
  cache: MerkleLeavesCache | undefined,
  cid: string,
  chunkIndex: number,
): Promise<StorageProofResult> {
  const cached = cache?.get(cid)
  let leaves: string[]
  let chunkSize: number | undefined

  if (cached) {
    leaves = cached
    chunkSize = await probeChunkSize(store, cid, chunkIndex)
  } else {
    const scanned = await scanMerkleLeaves(store, cid, chunkIndex)
    leaves = scanned.leaves
    chunkSize = scanned.targetChunkSize
    cache?.put(cid, leaves)
  }

  if (chunkIndex < 0 || chunkIndex >= leaves.length) {
    throw new Error(`invalid chunk index ${chunkIndex} (leaves=${leaves.length})`)
  }

  return {
    leafHash: leaves[chunkIndex],
    merkleRoot: buildMerkleRoot(leaves),
    merklePath: buildMerklePath(leaves, chunkIndex),
    chunkSize,
  }
}

async function loadFromMeta(
  storageDirPath: string,
  cid: string,
  chunkIndex: number,
): Promise<StorageProofResult> {
  const meta = await readFileMeta(storageDirPath)
  const file = meta[cid]
  if (!file) {
    throw new Error(`file meta not found for cid ${cid}`)
  }
  const leafHash = file.merkleLeaves[chunkIndex]
  if (!leafHash) {
    throw new Error(`invalid chunk index ${chunkIndex}`)
  }
  return {
    leafHash,
    merkleRoot: file.merkleRoot,
    merklePath: buildMerklePath(file.merkleLeaves, chunkIndex),
  }
}

async function scanMerkleLeaves(
  store: IpfsBlockstore,
  cid: string,
  targetIndex: number,
): Promise<{ leaves: string[]; targetChunkSize: number | undefined }> {
  const leaves: string[] = []
  let targetChunkSize: number | undefined
  for await (const { index, bytes } of resolveChunks(store, cid)) {
    leaves.push(hashLeaf(bytes))
    if (index === targetIndex) targetChunkSize = bytes.length
  }
  return { leaves, targetChunkSize }
}

async function probeChunkSize(
  store: IpfsBlockstore,
  cid: string,
  index: number,
): Promise<number | undefined> {
  for await (const chunk of resolveChunks(store, cid)) {
    if (chunk.index === index) return chunk.bytes.length
  }
  return undefined
}

async function readFileMeta(storageDirPath: string): Promise<Record<string, UnixFsFileMeta>> {
  try {
    const raw = await readFile(join(storageDirPath, "file-meta.json"), "utf-8")
    return JSON.parse(raw) as Record<string, UnixFsFileMeta>
  } catch {
    return {}
  }
}
