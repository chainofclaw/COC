// Manifest-aware reader: dispatches a CID to the right decoder by inspecting
// its multicodec.
//
// - dag-cbor (0x71) → parse as ErasureManifest → call decodeFile
// - dag-pb (0x70)   → existing UnixFS reader (handled by caller, since the
//                     UnixFsBuilder lives in another module)
// - raw (0x55)      → raw block (return bytes as-is)
//
// This module is the "front door" for `/api/v0/cat` and `/api/v0/get`. Q.3 +
// Q.4 of Phase Q. Lives separately from `ipfs-erasure.ts` so the pure encode/
// decode helpers stay I/O-free; this module is the integration seam.

import { CID } from "multiformats/cid"
import * as dagCbor from "@ipld/dag-cbor"
import type { CidString } from "./ipfs-types.ts"
import type { IpfsBlockstore } from "./ipfs-blockstore.ts"
import {
  decodeFile,
  decodeManifest,
  ErasureError,
  type ErasureManifest,
} from "./ipfs-erasure.ts"

const CODEC_DAG_PB = 0x70
const CODEC_RAW = 0x55
const CODEC_DAG_CBOR = 0x71

export type ResolvedKind = "erasure" | "unixfs" | "raw"

export interface ResolveResult {
  kind: ResolvedKind
  /** Manifest, only present when kind === "erasure". */
  manifest?: ErasureManifest
  /** Raw bytes, only present when kind === "raw". */
  bytes?: Uint8Array
}

/**
 * Inspect a CID's multicodec + (when needed) its block bytes to decide how
 * to read it. Caller passes a blockstore to fetch; missing-block errors
 * propagate as ErasureError("not_found").
 *
 * Side-effect free for `unixfs` and `raw` paths (no block fetch when the
 * codec alone is dispositive). For `erasure` we fetch the manifest block —
 * the caller still needs to fetch shards via `decodeFile`, but they get
 * the parsed manifest back so they don't have to re-fetch + re-decode.
 */
export async function resolveCid(
  cid: CidString,
  store: IpfsBlockstore,
): Promise<ResolveResult> {
  let parsed: CID
  try {
    parsed = CID.parse(cid)
  } catch (err) {
    throw new ErasureError("invalid_cid", `unparseable CID: ${(err as Error).message ?? err}`)
  }

  if (parsed.code === CODEC_DAG_PB) {
    return { kind: "unixfs" }
  }

  if (parsed.code === CODEC_DAG_CBOR) {
    let block
    try {
      block = await store.get(cid)
    } catch (err) {
      throw new ErasureError("not_found", `manifest block missing: ${(err as Error).message ?? err}`)
    }
    let manifest: ErasureManifest
    try {
      manifest = decodeManifest(block.bytes)
    } catch {
      // Block is dag-cbor but not a Phase-Q manifest (could be an arbitrary
      // dag-cbor block from another DAG). Surface as a structured error so
      // the HTTP layer can return 415 / 422 instead of accidentally trying
      // to UnixFS-read it.
      throw new ErasureError("not_a_manifest", `CID ${cid} is dag-cbor but not a Phase-Q erasure manifest`)
    }
    return { kind: "erasure", manifest }
  }

  if (parsed.code === CODEC_RAW) {
    let block
    try {
      block = await store.get(cid)
    } catch (err) {
      throw new ErasureError("not_found", `raw block missing: ${(err as Error).message ?? err}`)
    }
    return { kind: "raw", bytes: block.bytes }
  }

  // Unknown codec — surface clearly so the HTTP layer can map it.
  throw new ErasureError("unsupported_codec", `unsupported CID codec: 0x${parsed.code.toString(16)}`)
}

/**
 * Convenience wrapper: read a manifest's full file via the blockstore.
 * The caller is `IpfsHttpServer.handleCat/handleGet`; we adapt
 * `IpfsBlockstore.get` (throws on missing) to the `(cid) => bytes | null`
 * shape `decodeFile` expects.
 */
export async function readErasureFile(
  manifest: ErasureManifest,
  store: IpfsBlockstore,
): Promise<Uint8Array> {
  return decodeFile(manifest, async (cid) => {
    try {
      const block = await store.get(cid)
      return block.bytes
    } catch {
      // Treat any failure (ENOENT or remote miss) as "shard absent" so the
      // erasure decoder can use parity to reconstruct. The decoder itself
      // surfaces ErasureError("insufficient_shards") if too many are gone.
      return null
    }
  })
}

/**
 * Per-stripe availability snapshot for the `/api/v0/erasure/status` endpoint.
 *
 * The figures are local-store-only — they tell the operator whether THIS
 * node has each shard pinned/cached, which is the right signal for "should
 * we kick the repair loop?" but not for "is this file globally retrievable?"
 * (the latter requires a DHT findProviders sweep, deferred to Q.5).
 */
export async function erasureStatus(
  manifest: ErasureManifest,
  store: IpfsBlockstore,
): Promise<{
  fileSize: number
  scheme: string
  n: number
  m: number
  stripes: Array<{
    dataAvailable: number
    parityAvailable: number
    needsRepair: boolean
  }>
}> {
  const stripes = await Promise.all(manifest.stripes.map(async (stripe) => {
    const dataChecks = await Promise.all(stripe.data.map((cid) => store.has(cid)))
    const parityChecks = await Promise.all(stripe.parity.map((cid) => store.has(cid)))
    const dataAvailable = dataChecks.filter(Boolean).length
    const parityAvailable = parityChecks.filter(Boolean).length
    // needsRepair: any shard missing locally. Conservative — if a shard is
    // available remotely we can still serve, but the local node should pull
    // it down to maintain its replica set.
    const needsRepair = dataAvailable + parityAvailable < manifest.n + manifest.m
    return { dataAvailable, parityAvailable, needsRepair }
  }))
  return {
    fileSize: manifest.fileSize,
    scheme: manifest.scheme,
    n: manifest.n,
    m: manifest.m,
    stripes,
  }
}
