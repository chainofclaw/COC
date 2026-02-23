import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import * as dagPB from "@ipld/dag-pb"
import { UnixFS } from "ipfs-unixfs"
import type { CidString, IpfsBlock, UnixFsFileMeta, StorageProof } from "./ipfs-types.ts"
import { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { buildMerkleRoot, buildMerklePath, hashLeaf } from "./ipfs-merkle.ts"

const DEFAULT_BLOCK_SIZE = 262144
const MAX_READ_LINKS = 10_000
const MAX_READ_SIZE = 50 * 1024 * 1024 // 50 MB

export class UnixFsBuilder {
  private readonly store: IpfsBlockstore

  constructor(store: IpfsBlockstore) {
    this.store = store
  }

  async addFile(name: string, bytes: Uint8Array, blockSize = DEFAULT_BLOCK_SIZE): Promise<UnixFsFileMeta> {
    const chunks = chunkBytes(bytes, blockSize)
    const leafCids: CidString[] = []
    const leafHashes = chunks.map((c) => hashLeaf(c))

    for (const chunk of chunks) {
      const unixfs = new UnixFS({ type: "file", data: chunk })
      const node = dagPB.prepare({ Data: unixfs.marshal(), Links: [] })
      const encoded = dagPB.encode(node)
      const digest = await sha256.digest(encoded)
      const cid = CID.createV1(dagPB.code, digest)
      await this.store.put({ cid: cid.toString(), bytes: encoded })
      leafCids.push(cid.toString())
    }

    const rootNode = buildUnixFsRoot(leafCids, bytes.length)
    const rootBytes = dagPB.encode(rootNode)
    const rootDigest = await sha256.digest(rootBytes)
    const rootCid = CID.createV1(dagPB.code, rootDigest)
    await this.store.put({ cid: rootCid.toString(), bytes: rootBytes })

    const merkleRoot = buildMerkleRoot(leafHashes)

    return {
      cid: rootCid.toString(),
      size: bytes.length,
      blockSize,
      leaves: leafCids,
      root: rootCid.toString(),
      merkleRoot,
      merkleLeaves: leafHashes,
    }
  }

  async readFile(rootCid: CidString): Promise<Uint8Array> {
    const rootBlock = await this.store.get(rootCid)
    const rootNode = dagPB.decode(rootBlock.bytes)
    const unixfs = UnixFS.unmarshal(rootNode.Data ?? new Uint8Array())
    if (unixfs.type !== "file") {
      throw new Error("not a unixfs file")
    }

    if (!rootNode.Links || rootNode.Links.length === 0) {
      return unixfs.data ?? new Uint8Array()
    }

    if (rootNode.Links.length > MAX_READ_LINKS) {
      throw new Error(`too many DAG links: ${rootNode.Links.length} (max ${MAX_READ_LINKS})`)
    }

    const parts: Uint8Array[] = []
    let totalSize = 0
    for (const link of rootNode.Links) {
      const cid = link.Hash?.toString()
      if (!cid) continue
      const leaf = await this.store.get(cid)
      const leafNode = dagPB.decode(leaf.bytes)
      const leafFs = UnixFS.unmarshal(leafNode.Data ?? new Uint8Array())
      const chunk = leafFs.data ?? new Uint8Array()
      totalSize += chunk.length
      if (totalSize > MAX_READ_SIZE) {
        throw new Error(`readFile exceeds max size: ${totalSize} > ${MAX_READ_SIZE}`)
      }
      parts.push(chunk)
    }

    return concat(parts)
  }

  async getProof(meta: UnixFsFileMeta, chunkIndex: number): Promise<StorageProof> {
    const leafHash = meta.merkleLeaves[chunkIndex]
    if (!leafHash) {
      throw new Error("invalid chunk index")
    }
    const merklePath = buildMerklePath(meta.merkleLeaves, chunkIndex)
    return {
      chunkIndex,
      leafHash,
      merkleRoot: meta.merkleRoot,
      merklePath,
    }
  }
}

export async function storeRawBlock(store: IpfsBlockstore, bytes: Uint8Array): Promise<IpfsBlock> {
  const digest = await sha256.digest(bytes)
  const cid = CID.createV1(0x55, digest)
  await store.put({ cid: cid.toString(), bytes })
  return { cid: cid.toString(), bytes }
}

export async function loadRawBlock(store: IpfsBlockstore, cid: CidString): Promise<IpfsBlock> {
  return await store.get(cid)
}

function buildUnixFsRoot(leaves: CidString[], totalSize: number): dagPB.PBNode {
  const unixfs = new UnixFS({ type: "file", filesize: totalSize })
  const links = leaves.map((cid) => dagPB.createLink("", 0, CID.parse(cid)))
  return dagPB.prepare({ Data: unixfs.marshal(), Links: links })
}

function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  if (size <= 0) throw new Error(`invalid block size: ${size}`)
  if (bytes.length === 0) return [new Uint8Array()]
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.subarray(i, i + size))
  }
  return chunks
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
