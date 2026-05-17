// Phase Q — Reed-Solomon erasure coding helpers.
//
// Pure module: no I/O, no network, no blockstore handle. Callers feed bytes
// in and get blocks + a manifest out (encode), or feed a manifest + a
// fetch-shard callback in and get bytes out (decode).
//
// Layered above the existing K=3 push-to-K replication. Each shard produced
// here is an ordinary IPFS raw block (codec 0x55, sha256 multihash) and is
// expected to be stored + replicated by the caller via the standard
// IpfsBlockstore.put + DHT push-to-K wiring.
//
// See docs/phase-q-erasure-coding.md for the design and tracking issue
// chainofclaw/COC#68 for the milestone breakdown.

import { createRequire } from "node:module"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import * as dagCbor from "@ipld/dag-cbor"
import type { CidString, IpfsBlock } from "./ipfs-types.ts"

// Native binding (binding.node) cannot be loaded via dynamic ESM import().
// Wrap via createRequire so the rest of the module stays ESM-clean.
const require = createRequire(import.meta.url)
const ReedSolomon = require("@ronomon/reed-solomon") as ReedSolomonAPI

interface ReedSolomonAPI {
  MAX_K: number
  MAX_M: number
  create(k: number, m: number): unknown
  encode(
    context: unknown,
    sources: number,
    targets: number,
    buffer: Buffer,
    bufferOffset: number,
    bufferSize: number,
    parity: Buffer,
    parityOffset: number,
    paritySize: number,
    callback: (err: Error | null) => void,
  ): void
}

// Raw codec: shards are opaque bytes, not DAG nodes. Multicodec 0x55.
// dag-cbor codec: 0x71. (See multicodec table.)
const RAW_CODEC = 0x55

// Library limits — enforced at validation time so callers get an early,
// structured error instead of a binding-level abort.
export const MAX_DATA_SHARDS = ReedSolomon.MAX_K
export const MAX_PARITY_SHARDS = ReedSolomon.MAX_M

// Shard size must be a multiple of 8 (binding requirement). 256 KB matches
// the existing UnixFS chunk size in `ipfs-unixfs.ts:DEFAULT_BLOCK_SIZE`.
export const DEFAULT_SHARD_SIZE = 262144
export const SHARD_SIZE_ALIGNMENT = 8

// Decode-side resource caps. An erasure manifest is attacker-controllable:
// any CID a client asks `/api/v0/cat` to resolve can be a crafted dag-cbor
// manifest, and `decodeFile` derives Buffer.alloc sizes and a fetch loop
// directly from manifest fields. Without these caps a few-hundred-byte
// manifest declaring a huge `shardSize` / `stripes` count forces a
// multi-GB allocation and OOMs the node.
export const MAX_SHARD_SIZE = 16 * 1024 * 1024          // 16 MiB — wire payload cap; a larger shard could never be fetched as a block
export const MAX_STRIPES = 16_384                       // bounds the decode loop + shard-fetch fan-out
export const MAX_ERASURE_FILE_SIZE = 256 * 1024 * 1024  // 256 MiB — bounds the decoded-output buffer

/** A single erasure-coded stripe — N data shard CIDs + M parity shard CIDs. */
export interface ErasureStripe {
  data: CidString[]
  parity: CidString[]
}

/**
 * On-disk / on-wire manifest. Encoded as dag-cbor; the encoded bytes form a
 * regular IPFS block whose CID is the entry-point identifier returned by
 * `/api/v0/add?erasure=N+M`.
 *
 * `originalCid` is optional and intentionally NOT computed by this pure
 * module — Q.4 (HTTP integration) populates it from the parallel UnixFS
 * write so callers retain plain-DAG retrieval as a back-compat fallback.
 */
export interface ErasureManifest {
  v: 1
  scheme: "rs"
  n: number
  m: number
  shardSize: number
  fileSize: number
  originalCid?: CidString
  stripes: ErasureStripe[]
}

export interface ErasureParams {
  n: number
  m: number
  shardSize?: number
  /** Optional UnixFS root for back-compat (not used by encode itself). */
  originalCid?: CidString
}

export interface EncodeResult {
  manifestCid: CidString
  manifestBlock: IpfsBlock
  manifest: ErasureManifest
  shardBlocks: IpfsBlock[]
}

/** Structured error class so callers can branch on `code`. */
export class ErasureError extends Error {
  readonly code: string
  constructor(code: string, msg?: string) {
    super(msg ?? code)
    this.code = code
  }
}

function validateParams(params: ErasureParams): { n: number; m: number; shardSize: number } {
  const n = params.n
  const m = params.m
  const shardSize = params.shardSize ?? DEFAULT_SHARD_SIZE
  if (!Number.isInteger(n) || n < 1) throw new ErasureError("invalid_params", "n must be a positive integer")
  if (!Number.isInteger(m) || m < 1) throw new ErasureError("invalid_params", "m must be a positive integer")
  if (n > MAX_DATA_SHARDS) throw new ErasureError("invalid_params", `n exceeds MAX_DATA_SHARDS (${MAX_DATA_SHARDS})`)
  if (m > MAX_PARITY_SHARDS) throw new ErasureError("invalid_params", `m exceeds MAX_PARITY_SHARDS (${MAX_PARITY_SHARDS})`)
  if (!Number.isInteger(shardSize) || shardSize < SHARD_SIZE_ALIGNMENT) {
    throw new ErasureError("invalid_params", "shardSize must be a positive integer ≥ 8")
  }
  if (shardSize % SHARD_SIZE_ALIGNMENT !== 0) {
    throw new ErasureError("invalid_params", `shardSize must be a multiple of ${SHARD_SIZE_ALIGNMENT}`)
  }
  if (shardSize > MAX_SHARD_SIZE) {
    throw new ErasureError("invalid_params", `shardSize exceeds MAX_SHARD_SIZE (${MAX_SHARD_SIZE})`)
  }
  return { n, m, shardSize }
}

async function rawShardCid(bytes: Uint8Array): Promise<CidString> {
  const digest = await sha256.digest(bytes)
  return CID.createV1(RAW_CODEC, digest).toString()
}

/**
 * Encode `file` into N+M shards per stripe. The original file is padded with
 * zeros up to a multiple of `n * shardSize`; the true file size is recorded
 * in the manifest so decode can truncate.
 *
 * Returns the manifest CID (the entry point), the manifest block (also an
 * IpfsBlock so the caller can `store.put` it), the parsed manifest, and all
 * shard blocks (data + parity, in stripe-major order).
 *
 * The caller is responsible for storing every block: `manifestBlock` plus
 * everything in `shardBlocks`. None of the shard blocks need to be pinned
 * individually if the caller pins the manifest recursively — the existing
 * pin-set logic + `pin/ls` walk will follow the manifest's stripe arrays.
 */
export async function encodeFile(
  file: Uint8Array,
  params: ErasureParams,
): Promise<EncodeResult> {
  const { n, m, shardSize } = validateParams(params)
  const stripeSize = n * shardSize
  const fileSize = file.byteLength
  const stripes = Math.max(1, Math.ceil(fileSize / stripeSize))
  const padded = stripes * stripeSize

  // Build a single padded buffer so the binding can encode each stripe
  // in-place. Allocate fresh — never mutate the caller's input.
  const buffer = Buffer.alloc(padded)
  buffer.set(file, 0)
  const parity = Buffer.alloc(shardSize * m * stripes)

  // Bit-mask: bits 0..n-1 are data shards, bits n..n+m-1 are parity shards.
  let dataSourcesMask = 0
  for (let i = 0; i < n; i++) dataSourcesMask |= 1 << i
  let parityTargetsMask = 0
  for (let i = n; i < n + m; i++) parityTargetsMask |= 1 << i

  const ctx = ReedSolomon.create(n, m)

  await Promise.all(
    Array.from({ length: stripes }, (_, s) => new Promise<void>((resolve, reject) => {
      ReedSolomon.encode(
        ctx,
        dataSourcesMask,
        parityTargetsMask,
        buffer,
        s * stripeSize,
        stripeSize,
        parity,
        s * shardSize * m,
        shardSize * m,
        (err) => err ? reject(err) : resolve(),
      )
    })),
  )

  // Build per-stripe shard arrays + flat block list.
  const shardBlocks: IpfsBlock[] = []
  const stripeMetas: ErasureStripe[] = []
  for (let s = 0; s < stripes; s++) {
    const dataCids: CidString[] = []
    const parityCids: CidString[] = []
    for (let i = 0; i < n; i++) {
      const start = s * stripeSize + i * shardSize
      // Slice from the padded buffer — encoded data shards are unchanged
      // from the original input + zero padding. Use a copy so callers can
      // mutate the IpfsBlock without disturbing the encoder buffer.
      const bytes = Uint8Array.prototype.slice.call(buffer.subarray(start, start + shardSize))
      const cid = await rawShardCid(bytes)
      dataCids.push(cid)
      shardBlocks.push({ cid, bytes })
    }
    for (let j = 0; j < m; j++) {
      const start = s * shardSize * m + j * shardSize
      const bytes = Uint8Array.prototype.slice.call(parity.subarray(start, start + shardSize))
      const cid = await rawShardCid(bytes)
      parityCids.push(cid)
      shardBlocks.push({ cid, bytes })
    }
    stripeMetas.push({ data: dataCids, parity: parityCids })
  }

  const manifest: ErasureManifest = {
    v: 1,
    scheme: "rs",
    n,
    m,
    shardSize,
    fileSize,
    ...(params.originalCid ? { originalCid: params.originalCid } : {}),
    stripes: stripeMetas,
  }
  const manifestBytes = dagCbor.encode(manifest)
  const manifestDigest = await sha256.digest(manifestBytes)
  const manifestCid = CID.createV1(dagCbor.code, manifestDigest).toString()
  return {
    manifestCid,
    manifestBlock: { cid: manifestCid, bytes: manifestBytes },
    manifest,
    shardBlocks,
  }
}

/**
 * Recover bytes from the manifest using `fetchShard` to pull individual
 * shards. The fetcher returns null when a shard is unavailable; decode
 * tolerates up to M missing shards per stripe (any combination of data and
 * parity) by reconstructing the missing data shards from the surviving N
 * sources.
 *
 * Throws `ErasureError("insufficient_shards", ...)` when more than M shards
 * are missing in any single stripe — the file is unrecoverable from that
 * stripe alone, no point continuing.
 */
export async function decodeFile(
  manifest: ErasureManifest,
  fetchShard: (cid: CidString) => Promise<Uint8Array | null>,
): Promise<Uint8Array> {
  if (manifest.v !== 1 || manifest.scheme !== "rs") {
    throw new ErasureError("unsupported_manifest", `unsupported manifest version/scheme: v=${manifest.v}, scheme=${manifest.scheme}`)
  }
  const { n, m, shardSize, fileSize, stripes } = manifest
  validateParams({ n, m, shardSize })

  // Bound every allocation/iteration derived from the (attacker-controllable)
  // manifest before touching Buffer.alloc — see MAX_* cap rationale above.
  if (!Array.isArray(stripes)) {
    throw new ErasureError("malformed_manifest", "manifest stripes must be an array")
  }
  if (stripes.length > MAX_STRIPES) {
    throw new ErasureError("malformed_manifest", `stripe count ${stripes.length} exceeds MAX_STRIPES (${MAX_STRIPES})`)
  }
  const stripeSize = n * shardSize
  const totalCoverage = stripes.length * stripeSize
  if (totalCoverage > MAX_ERASURE_FILE_SIZE) {
    throw new ErasureError("malformed_manifest", `decoded size ${totalCoverage} exceeds MAX_ERASURE_FILE_SIZE (${MAX_ERASURE_FILE_SIZE})`)
  }
  const out = Buffer.alloc(totalCoverage)
  const ctx = ReedSolomon.create(n, m)

  for (let s = 0; s < stripes.length; s++) {
    const stripe = stripes[s]
    if (stripe.data.length !== n || stripe.parity.length !== m) {
      throw new ErasureError("malformed_manifest", `stripe ${s} has ${stripe.data.length} data + ${stripe.parity.length} parity, expected ${n} + ${m}`)
    }

    // Fetch all shards in parallel. Track which are present so we can
    // build the source/target masks for the decoder.
    const dataResults = await Promise.all(stripe.data.map((cid) => fetchShard(cid)))
    const parityResults = await Promise.all(stripe.parity.map((cid) => fetchShard(cid)))

    // Fast path: every data shard is present. No decode needed; copy the
    // data shards directly into the output buffer.
    if (dataResults.every((r) => r !== null)) {
      for (let i = 0; i < n; i++) {
        const shard = dataResults[i] as Uint8Array
        if (shard.byteLength !== shardSize) {
          throw new ErasureError("shard_size_mismatch", `data shard ${i} of stripe ${s} has size ${shard.byteLength}, expected ${shardSize}`)
        }
        out.set(shard, s * stripeSize + i * shardSize)
      }
      continue
    }

    // Slow path: some data shards missing — reconstruct via parity.
    // The library's `encode` is reused for "regenerate missing shard"
    // semantics: provide N intact sources (any combination of data +
    // parity) and the missing-shard indices as targets.
    const missingDataIdx: number[] = []
    for (let i = 0; i < n; i++) {
      if (dataResults[i] === null) missingDataIdx.push(i)
    }
    const surviving = dataResults.filter((r) => r !== null).length + parityResults.filter((r) => r !== null).length
    if (surviving < n) {
      throw new ErasureError("insufficient_shards", `stripe ${s}: only ${surviving} shards available, need ${n}`)
    }

    // Build the buffer the binding works on: data + parity slots, contiguous.
    // Missing shards stay zero-filled; sources mark the present ones; targets
    // mark the slots we want regenerated (the missing data shards).
    const stripeBuffer = Buffer.alloc(stripeSize)
    const stripeParity = Buffer.alloc(shardSize * m)
    let sources = 0
    let targets = 0
    for (let i = 0; i < n; i++) {
      const r = dataResults[i]
      if (r !== null) {
        if (r.byteLength !== shardSize) {
          throw new ErasureError("shard_size_mismatch", `data shard ${i} of stripe ${s} has size ${r.byteLength}, expected ${shardSize}`)
        }
        stripeBuffer.set(r, i * shardSize)
        sources |= 1 << i
      } else {
        targets |= 1 << i
      }
    }
    for (let j = 0; j < m; j++) {
      const r = parityResults[j]
      if (r !== null) {
        if (r.byteLength !== shardSize) {
          throw new ErasureError("shard_size_mismatch", `parity shard ${j} of stripe ${s} has size ${r.byteLength}, expected ${shardSize}`)
        }
        stripeParity.set(r, j * shardSize)
        sources |= 1 << (n + j)
      }
      // Missing parity slots are not regenerated here — they're not on the
      // critical path for delivering the file. The repair loop (Q.5) is
      // responsible for restoring the parity inventory.
    }

    if (missingDataIdx.length > m) {
      // Defence in depth — should already have tripped the surviving check above.
      throw new ErasureError("insufficient_shards", `stripe ${s}: ${missingDataIdx.length} data shards missing, max ${m}`)
    }

    await new Promise<void>((resolve, reject) => {
      ReedSolomon.encode(
        ctx,
        sources,
        targets,
        stripeBuffer,
        0,
        stripeSize,
        stripeParity,
        0,
        shardSize * m,
        (err) => err ? reject(err) : resolve(),
      )
    })

    out.set(stripeBuffer, s * stripeSize)
  }

  // Truncate to the original (pre-padding) file size.
  if (fileSize > out.byteLength) {
    throw new ErasureError("malformed_manifest", `manifest fileSize ${fileSize} > stripe coverage ${out.byteLength}`)
  }
  return Uint8Array.prototype.slice.call(out.subarray(0, fileSize))
}

/** Manifest dag-cbor codec helpers (exported for Q.4 + tests). */
export function encodeManifest(manifest: ErasureManifest): Uint8Array {
  return dagCbor.encode(manifest)
}

export function decodeManifest(bytes: Uint8Array): ErasureManifest {
  const decoded = dagCbor.decode(bytes) as ErasureManifest
  if (!decoded || typeof decoded !== "object") {
    throw new ErasureError("malformed_manifest", "manifest is not an object")
  }
  if (decoded.v !== 1 || decoded.scheme !== "rs") {
    throw new ErasureError("unsupported_manifest", `unsupported v=${decoded.v} scheme=${decoded.scheme}`)
  }
  // Structural guard at the parse boundary: `stripes` must be an array so
  // `decodeFile`'s `stripes.length` / iteration cannot fault or be tricked.
  // Allocation-size caps (shardSize / stripe count / coverage) are enforced
  // in decodeFile, where the dangerous Buffer.alloc math lives.
  if (!Array.isArray(decoded.stripes)) {
    throw new ErasureError("malformed_manifest", "manifest stripes must be an array")
  }
  return decoded
}

/** Compute the manifest CID without re-encoding all the shard data. */
export async function computeManifestCid(manifest: ErasureManifest): Promise<CidString> {
  const bytes = encodeManifest(manifest)
  const digest = await sha256.digest(bytes)
  return CID.createV1(dagCbor.code, digest).toString()
}
