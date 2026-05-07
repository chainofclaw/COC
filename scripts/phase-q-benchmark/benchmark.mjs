#!/usr/bin/env node
// Phase Q.1 — benchmark @ronomon/reed-solomon for COC erasure coding.
//
// Measures end-to-end stripe encode + decode for file sizes 1 / 10 / 100 MB
// across a few (N+M) configurations. Reports wall ms + throughput.
// Verifies byte-identical decode.
import { createRequire } from "node:module"
import { randomBytes } from "node:crypto"
const require = createRequire(import.meta.url)
const ReedSolomon = require("@ronomon/reed-solomon")

const SHARD_SIZE = 262144 // 256 KB — must be a multiple of 8

async function bench(label, n, m, fileSizeBytes, runs = 3) {
  const stripeSize = SHARD_SIZE * n
  const stripes = Math.ceil(fileSizeBytes / stripeSize)
  const padded = stripes * stripeSize
  const ctx = ReedSolomon.create(n, m)

  const dataSourcesMask = (() => {
    let s = 0
    for (let i = 0; i < n; i++) s |= 1 << i
    return s
  })()
  const parityTargetsMask = (() => {
    let t = 0
    for (let i = n; i < n + m; i++) t |= 1 << i
    return t
  })()

  // Decode mask: assume worst-case M data shards lost, reconstruct from remaining.
  const lostDataIndices = []
  for (let i = 0; i < m; i++) lostDataIndices.push(i) // first m data shards
  const decodeTargetsMask = (() => {
    let t = 0
    for (const i of lostDataIndices) t |= 1 << i
    return t
  })()
  const decodeSourcesMask = (() => {
    let s = 0
    for (let i = 0; i < n + m; i++) {
      if (decodeTargetsMask & (1 << i)) continue
      s |= 1 << i
    }
    return s
  })()

  const file = randomBytes(padded)

  const encodeTimes = []
  const decodeTimes = []
  let lastVerified = false

  for (let run = 0; run < runs; run++) {
    // -------- ENCODE --------
    const buffer = Buffer.from(file)
    const parity = Buffer.alloc(SHARD_SIZE * m * stripes)

    const startEnc = process.hrtime.bigint()
    let pendingEnc = stripes
    await new Promise((resolve, reject) => {
      for (let s = 0; s < stripes; s++) {
        ReedSolomon.encode(
          ctx,
          dataSourcesMask,
          parityTargetsMask,
          buffer,
          s * stripeSize,
          stripeSize,
          parity,
          s * SHARD_SIZE * m,
          SHARD_SIZE * m,
          (err) => {
            if (err) return reject(err)
            if (--pendingEnc === 0) resolve()
          },
        )
      }
    })
    const encMs = Number(process.hrtime.bigint() - startEnc) / 1e6
    encodeTimes.push(encMs)

    // -------- SIMULATE LOSS + DECODE --------
    // Zero out the lost data shards in the buffer (simulate corruption).
    for (let s = 0; s < stripes; s++) {
      for (const i of lostDataIndices) {
        buffer.fill(0, s * stripeSize + i * SHARD_SIZE, s * stripeSize + (i + 1) * SHARD_SIZE)
      }
    }

    const startDec = process.hrtime.bigint()
    let pendingDec = stripes
    await new Promise((resolve, reject) => {
      for (let s = 0; s < stripes; s++) {
        ReedSolomon.encode(
          ctx,
          decodeSourcesMask,
          decodeTargetsMask,
          buffer,
          s * stripeSize,
          stripeSize,
          parity,
          s * SHARD_SIZE * m,
          SHARD_SIZE * m,
          (err) => {
            if (err) return reject(err)
            if (--pendingDec === 0) resolve()
          },
        )
      }
    })
    const decMs = Number(process.hrtime.bigint() - startDec) / 1e6
    decodeTimes.push(decMs)

    // Verify byte-identical to original.
    lastVerified = buffer.equals(file)
    if (!lastVerified) throw new Error("decode mismatch — RS recovery failed")
  }

  const min = (a) => Math.min(...a)
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y)
    return s[Math.floor(s.length / 2)]
  }
  const sizeMb = padded / (1024 * 1024)
  const encMs = median(encodeTimes)
  const decMs = median(decodeTimes)
  const encMbs = sizeMb / (encMs / 1000)
  const decMbs = sizeMb / (decMs / 1000)

  const target300ms10mb = label.includes("4+2") && fileSizeBytes === 10 * 1024 * 1024
  const target300hit = encMs < 300
  const targetTag = target300ms10mb ? (target300hit ? " ✅<300ms target" : " ❌target=300ms missed") : ""

  console.log(
    `  ${label.padEnd(8)} | ${(sizeMb.toFixed(0) + " MB").padStart(7)} | ${stripes.toString().padStart(4)} stripes | ` +
    `enc median ${encMs.toFixed(1).padStart(7)} ms (${encMbs.toFixed(0).padStart(5)} MB/s) | ` +
    `dec median ${decMs.toFixed(1).padStart(7)} ms (${decMbs.toFixed(0).padStart(5)} MB/s) | ` +
    `verify=${lastVerified}` + targetTag,
  )
}

console.log(`@ronomon/reed-solomon benchmark — Phase Q.1`)
console.log(`SHARD_SIZE=${SHARD_SIZE} (${SHARD_SIZE / 1024} KB)`)
console.log(`Node ${process.version}, ${process.platform}-${process.arch}, ${require("node:os").cpus().length} cores`)
console.log(`CPU: ${require("node:os").cpus()[0]?.model ?? "unknown"}`)
console.log("")
console.log(`  scheme   |    size |       stripes | encode median (throughput)         | decode median (throughput)         | verify`)
console.log(`  -----------------------------------------------------------------------------------------------------------------`)

const fileSizes = [1, 10, 100].map((mb) => mb * 1024 * 1024)
const schemes = [
  { label: "RS(4+2)", n: 4, m: 2 },
  { label: "RS(6+3)", n: 6, m: 3 },
  { label: "RS(8+4)", n: 8, m: 4 },
  { label: "RS(10+4)", n: 10, m: 4 },
]

for (const { label, n, m } of schemes) {
  for (const f of fileSizes) {
    await bench(label, n, m, f)
  }
  console.log("")
}
