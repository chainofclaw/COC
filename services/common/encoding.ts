// Shared encoding utilities for PoSe message serialization.
// Extracted from challenge-factory.ts for v1/v2 reuse.

import type { Hex32 } from "./pose-types.ts"

export function u64Bytes(value: bigint): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error("value out of uint64 range")
  }
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(value)
  return out
}

export function u32Bytes(value: number): Buffer {
  if (value < 0 || value > 0xffffffff) {
    throw new Error("value out of uint32 range")
  }
  const b = Buffer.alloc(4)
  b.writeUInt32BE(value)
  return b
}

export function hex32Bytes(value: Hex32): Buffer {
  const n = value.slice(2)
  if (!/^[0-9a-fA-F]{64}$/.test(n)) {
    throw new Error("invalid hex32")
  }
  return Buffer.from(n, "hex")
}

export function hexSizedBytes(value: `0x${string}`, bytes: number): Buffer {
  const n = value.slice(2)
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(n)) {
    throw new Error(`expected ${bytes} bytes hex`)
  }
  return Buffer.from(n, "hex")
}

export function stableStringify(value: unknown): string {
  if (typeof value === "bigint") return value.toString()
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((x) => stableStringify(x)).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const props = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${props.join(",")}}`
}
