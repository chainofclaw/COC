/**
 * Batch compression/decompression for COC Optimistic Rollup.
 *
 * Encodes L2 block data into a compact binary format for L1 data availability posting.
 * Format: [version(1)] [blockCount(4)] [block0] [block1] ... [zlib compressed]
 *
 * Each block: [number(8)] [hash(32)] [stateRoot(32)] [timestampMs(8)] [txCount(4)] [tx0Len(4)+tx0Data] ...
 * parentHash is omitted (derivable from previous block's hash).
 */

import { deflateSync, inflateSync } from "node:zlib"
import type { L2BlockData, Hex } from "./rollup-types.ts"

const CODEC_VERSION = 1

/**
 * Compress a sequence of L2 blocks into a compact binary format.
 * @param blocks Ordered array of L2 blocks (must be contiguous)
 * @returns Compressed binary data
 */
export function compressBatch(blocks: readonly L2BlockData[]): Uint8Array {
  if (blocks.length === 0) {
    const empty = new Uint8Array([CODEC_VERSION, 0, 0, 0, 0])
    return deflateSync(Buffer.from(empty))
  }

  const parts: Uint8Array[] = []

  // Header: version + block count
  const header = new Uint8Array(5)
  header[0] = CODEC_VERSION
  new DataView(header.buffer).setUint32(1, blocks.length, false)
  parts.push(header)

  for (const block of blocks) {
    // Block number (8 bytes big-endian)
    const numBuf = new Uint8Array(8)
    new DataView(numBuf.buffer).setBigUint64(0, block.number, false)
    parts.push(numBuf)

    // Hash (32 bytes)
    parts.push(hexToBytes(block.hash))

    // State root (32 bytes)
    parts.push(hexToBytes(block.stateRoot))

    // Timestamp (8 bytes big-endian)
    const tsBuf = new Uint8Array(8)
    new DataView(tsBuf.buffer).setBigUint64(0, BigInt(block.timestampMs), false)
    parts.push(tsBuf)

    // Transaction count (4 bytes)
    const txCountBuf = new Uint8Array(4)
    new DataView(txCountBuf.buffer).setUint32(0, block.txs.length, false)
    parts.push(txCountBuf)

    // Each transaction: length (4 bytes) + data
    for (const tx of block.txs) {
      const txData = hexToBytes(tx)
      const lenBuf = new Uint8Array(4)
      new DataView(lenBuf.buffer).setUint32(0, txData.length, false)
      parts.push(lenBuf)
      parts.push(txData)
    }
  }

  // Concatenate all parts
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const raw = new Uint8Array(totalLen)
  let offset = 0
  for (const part of parts) {
    raw.set(part, offset)
    offset += part.length
  }

  // Compress with zlib
  return deflateSync(Buffer.from(raw))
}

/**
 * Decompress a batch back into L2 block data.
 * @param data Compressed binary data from compressBatch
 * @returns Array of L2 blocks
 */
export function decompressBatch(data: Uint8Array): L2BlockData[] {
  const raw = inflateSync(Buffer.from(data))
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let offset = 0

  const version = raw[offset++]
  if (version !== CODEC_VERSION) {
    throw new Error(`unsupported batch codec version: ${version}`)
  }

  const blockCount = view.getUint32(offset, false)
  offset += 4

  const blocks: L2BlockData[] = []
  let prevHash: Hex = "0x" + "0".repeat(64) as Hex

  for (let i = 0; i < blockCount; i++) {
    const number = view.getBigUint64(offset, false)
    offset += 8

    const hash = bytesToHex(raw.slice(offset, offset + 32))
    offset += 32

    const stateRoot = bytesToHex(raw.slice(offset, offset + 32))
    offset += 32

    const timestampMs = Number(view.getBigUint64(offset, false))
    offset += 8

    const txCount = view.getUint32(offset, false)
    offset += 4

    const txs: Hex[] = []
    for (let t = 0; t < txCount; t++) {
      const txLen = view.getUint32(offset, false)
      offset += 4
      const txData = raw.slice(offset, offset + txLen)
      offset += txLen
      txs.push(bytesToHex(txData))
    }

    blocks.push({
      number,
      hash,
      parentHash: prevHash,
      stateRoot,
      timestampMs,
      txs,
    })
    prevHash = hash
  }

  return blocks
}

/**
 * Estimate the compression ratio for a given set of blocks.
 * @returns ratio > 1 means compression saved space (e.g., 3.0 = 3x smaller)
 */
export function estimateCompressionRatio(blocks: readonly L2BlockData[]): number {
  if (blocks.length === 0) return 1

  // Estimate raw size: block headers + transaction bytes
  let rawSize = 0
  for (const block of blocks) {
    rawSize += 8 + 32 + 32 + 32 + 8 + 4 // number + hash + parentHash + stateRoot + ts + txCount
    for (const tx of block.txs) {
      rawSize += 4 + (tx.length - 2) / 2 // length prefix + tx bytes
    }
  }

  const compressed = compressBatch(blocks)
  return rawSize / compressed.length
}

// ── Helpers ───────────────────────────────────────────────────────────

function hexToBytes(hex: Hex): Uint8Array {
  const str = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(str.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(str.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): Hex {
  let hex = "0x"
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0")
  }
  return hex as Hex
}
