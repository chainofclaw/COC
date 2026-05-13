/**
 * Shared RPC / HTTP / WebSocket / IPFS / PoSe input validation layer.
 *
 * Extracted (PR-1Q, 2026-05-12) from rpc.ts top-of-file helpers
 * (lines 82-265 + parseBlockTag at 2721 + validateLogFilter at 3623)
 * so the same shape-checking is available to other request boundaries:
 *
 *   - rpc.ts                  — main HTTP JSON-RPC server
 *   - websocket-rpc.ts        — WebSocket JSON-RPC + subscriptions
 *   - ipfs-http.ts            — Kubo-compat /api/v0/* endpoints
 *   - pose-http.ts            — PoSe v1/v2 HTTP routes
 *   - runtime/coc-node.ts     — node-local POST endpoints
 *
 * Design constraints (must preserve, otherwise breaks RPC clients):
 *
 *   - All validation failures throw the literal `{ code, message }`
 *     object — NOT an `Error` instance. The HTTP/WS layer relies on
 *     `(err as { code?, message? }).code` to build the JSON-RPC error
 *     response; throwing `new Error(...)` would surface -32603 instead.
 *
 *   - Error codes are JSON-RPC 2.0 standard:
 *       -32700  parse error (JSON malformed at envelope level)
 *       -32600  invalid request (envelope shape)
 *       -32601  method not found / method disabled
 *       -32602  invalid params
 *       -32603  internal server error
 *     plus the COC custom:
 *       -32005  limit exceeded (#132, #200, #208, #224)
 *
 *   - Helper-thrown messages must NOT leak V8 internals (TypeError /
 *     SyntaxError stacks / line numbers) or ethers private state
 *     (`INVALID_ARGUMENT`, `BUFFER_OVERRUN`, `.version`). Sanitization
 *     helpers below replace ad-hoc per-site error wrapping.
 */

import type { Hex } from "./blockchain-types.ts"

// ---------------------------------------------------------------------------
// Standardized error throws — replaces literal `throw { code: -32602, ... }`
// strewn across rpc.ts / ipfs-http.ts / pose-http.ts / coc-node.ts.
// ---------------------------------------------------------------------------

/** Throw JSON-RPC §5.1 -32602 "invalid params". Never returns. */
export function invalidParams(message: string): never {
  throw { code: -32602, message }
}

/** Throw JSON-RPC §5.1 -32601 "method not found" / "method disabled". Never returns. */
export function methodNotFound(message: string): never {
  throw { code: -32601, message }
}

/** Throw JSON-RPC §5.1 -32600 "invalid request" (envelope shape). Never returns. */
export function invalidRequest(message: string): never {
  throw { code: -32600, message }
}

/** Throw -32700 "parse error" (envelope-level JSON malformed). Never returns. */
export function parseError(message: string): never {
  throw { code: -32700, message }
}

/** Throw COC-custom -32005 "limit exceeded" (too many filters, oversized batch, etc.). Never returns. */
export function limitExceeded(message: string): never {
  throw { code: -32005, message }
}

/** Throw JSON-RPC §5.1 -32603 "internal error" (server-side fault). Never returns. */
export function internalError(message: string): never {
  throw { code: -32603, message }
}

// ---------------------------------------------------------------------------
// BigInt + numeric parsers
// ---------------------------------------------------------------------------

/**
 * Parse a string into BigInt, rejecting oversized inputs (DoS guard:
 * BigInt(huge_decimal) is O(n²)). Throws -32602 on malformed/oversized.
 */
export function safeBigInt(input: string): bigint {
  if (typeof input !== "string" || input.length > 78) {
    invalidParams("invalid block number: input too large")
  }
  // #250: pre-fix `BigInt("")` returned 0n silently. The bug surfaced
  // upstream when eth_getBlockByNumber's `String(params[0] ?? "latest")`
  // coerced arrays/objects to "" — parseBlockTag fell through to here
  // and quietly returned the genesis block. Sibling of #188 / #194.
  if (input === "") {
    invalidParams("invalid block number: empty string")
  }
  try {
    return BigInt(input)
  } catch {
    invalidParams(`invalid block number: ${input.slice(0, 40)}`)
  }
}

/**
 * Parse a block tag (RPC "latest"/"earliest"/"pending"/"safe"/"finalized"
 * or hex quantity). Returns the resolved bigint height. Rejects
 * non-string/non-number shapes (array, object, bool) at -32602.
 *
 * #188: pre-fix `BigInt(Math.floor(input))` silently truncated fractional
 * values (1.5 → 1).
 * #194: pre-fix every non-string, non-number shape silently fell through
 * to fallback (which silently mapped malformed input to latest).
 */
export function parseBlockTag(input: unknown, fallback: bigint, finalizedHeight?: bigint): bigint {
  if (input === undefined || input === null) return fallback
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0 || !Number.isInteger(input)) {
      invalidParams(`invalid block number: ${input}`)
    }
    return BigInt(input)
  }
  if (typeof input === "string") {
    if (input === "latest" || input === "pending") return fallback
    if (input === "safe" || input === "finalized") return finalizedHeight ?? fallback
    if (input === "earliest") return 0n
    const n = safeBigInt(input)
    if (n < 0n) invalidParams(`invalid block number: ${input}`)
    return n
  }
  invalidParams("invalid block tag: must be hex quantity or named tag")
}

// ---------------------------------------------------------------------------
// Hex / address / hash parameter validators
// ---------------------------------------------------------------------------

const HEX_PARAM_RE = /^0x[0-9a-fA-F]*$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const FILTER_ID_RE = /^0x[0-9a-fA-F]{32}$/
const HEX_INTEGER_RE = /^0x[0-9a-fA-F]+$/

/** 0x-prefixed hex, max 66 chars (= 32 bytes). Looser than {@link requireAddressParam}; use only when callers
 *  need an opaque hex blob whose exact byte length isn't yet known. */
export function requireHexParam(params: unknown[], index: number, name: string): Hex {
  const value = (params ?? [])[index]
  if (typeof value !== "string" || !value.startsWith("0x")) {
    invalidParams(`invalid ${name}: expected hex string`)
  }
  if (value.length > 66 || !HEX_PARAM_RE.test(value)) {
    invalidParams(`invalid ${name}: malformed hex string`)
  }
  return value as Hex
}

/** Optional hex param — returns undefined for null/undefined/malformed rather than throwing. */
export function optionalHexParam(params: unknown[], index: number): Hex | undefined {
  const value = (params ?? [])[index]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !value.startsWith("0x")) return undefined
  if (value.length > 66 || !HEX_PARAM_RE.test(value)) return undefined
  return value as Hex
}

/**
 * #122: strict 20-byte address validator. requireHexParam accepts any
 * hex up to 66 chars, so "0x123" slipped through and downstream code
 * either echoed back the raw input (eth_getBalance) or silently missed
 * the index (coc_getContractInfo). Use this at the RPC boundary for
 * methods whose param is documented as an Ethereum address.
 */
export function requireAddressParam(params: unknown[], index: number, name = "address"): Hex {
  const value = (params ?? [])[index]
  if (typeof value !== "string") {
    invalidParams(`invalid ${name}: expected string`)
  }
  if (!ADDRESS_RE.test(value as string)) {
    invalidParams(`invalid ${name}: must match /^0x[0-9a-fA-F]{40}$/`)
  }
  return value as Hex
}

/**
 * #150: strict 32-byte (64 hex chars) tx-hash validator. The loose
 * requireHexParam accepts 0x-prefixed hex up to 66 chars, so a typo
 * like "0x123" slipped through and the downstream tx lookup returned
 * null ("tx not found"). Clients couldn't distinguish a typo from a
 * tx that doesn't exist on-chain.
 */
export function requireTxHashParam(params: unknown[], index: number, name = "transaction hash"): Hex {
  const value = (params ?? [])[index]
  if (typeof value !== "string") {
    invalidParams(`invalid ${name}: expected string`)
  }
  if (!HASH_RE.test(value as string)) {
    invalidParams(`invalid ${name}: must match /^0x[0-9a-fA-F]{64}$/`)
  }
  return value as Hex
}

/**
 * Validate a 32-byte block hash (#166). Pre-fix the *byHash variants
 * silently accepted any input (undefined, null, short hex, non-hex) and
 * returned null indistinguishable from "valid hash, no such block".
 * Same shape rules as transaction hash; the separate name keeps error
 * messages readable for the caller's surface.
 */
export function requireBlockHashParam(params: unknown[], index: number): Hex {
  return requireTxHashParam(params, index, "block hash")
}

/**
 * Validate a JSON-RPC QUANTITY index parameter (#198). EIP-1474
 * requires indexes to be `0x`-prefixed hex strings. Pre-fix
 * `Number((payload.params ?? [])[idx] ?? 0)` accepted everything
 * (NaN for non-hex, negatives for `-0x1`, `1` for `true`) and the
 * downstream null-return silently masked the malformed cases —
 * caller couldn't distinguish a real not-found from a buggy query.
 */
export function requireIndexParam(params: unknown[], index: number, name = "index"): number {
  const raw = (params ?? [])[index]
  if (typeof raw !== "string" || !HEX_INTEGER_RE.test(raw)) {
    invalidParams(`invalid ${name} at param ${index}: must match /^0x[0-9a-fA-F]+$/`)
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    invalidParams(`invalid ${name} at param ${index}: must be non-negative integer`)
  }
  return n
}

/**
 * Validate a 16-byte filter ID (#196). Filter IDs are minted as
 * `0x` + `randomBytes(16).toString("hex")` (32 hex chars). Pre-fix
 * `String((payload.params ?? [])[0] ?? "")` silently coerced any
 * input — numbers, arrays, objects — to a never-matching string, so
 * `eth_getFilterChanges` / `eth_getFilterLogs` / `eth_uninstallFilter`
 * returned `[]` or `false` indistinguishable from "filter expired."
 */
export function requireFilterId(params: unknown[], index: number): string {
  const value = (params ?? [])[index]
  if (typeof value !== "string") {
    invalidParams(`invalid filter id at index ${index}: expected string`)
  }
  if (!FILTER_ID_RE.test(value as string)) {
    invalidParams(`invalid filter id at index ${index}: must match /^0x[0-9a-fA-F]{32}$/`)
  }
  return (value as string).toLowerCase()
}

// ---------------------------------------------------------------------------
// Object / array shape validators
// ---------------------------------------------------------------------------

/**
 * Validate that the first param of eth_call / eth_estimateGas /
 * eth_sendTransaction / eth_createAccessList is an object — not a
 * string, number, array, or boolean. #172: pre-fix the type assertion
 * `as Record<string, string>` was a no-op at runtime; non-object input
 * coerced to an effectively-empty tx and the EVM returned "0x".
 * null/undefined pass through as `undefined` so the caller can still
 * fall back to `{}` (matches geth's `eth_call(null)` ergonomic).
 */
export function requireCallObject(raw: unknown, methodName: string): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) {
    invalidParams(`invalid ${methodName} object: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`)
  }
  return raw as Record<string, unknown>
}

/**
 * #238: Filter param validator for eth_getLogs / eth_newFilter. Pre-fix
 * `(payload.params[0] ?? {}) as Record<string, unknown>` was a TS-only
 * runtime no-op so booleans, strings, numbers, and arrays slipped through.
 * Every `.fromBlock` / `.address` / `.topics` read returned undefined →
 * validateLogFilter saw nothing to reject → silent "no filter" path.
 * Worse for eth_newFilter: silently created a filter ID for garbage,
 * leaking entries in the MAX_FILTERS-capped map. Returns {} for
 * null/undefined to keep `eth_getLogs(null)` working as "default range".
 */
export function requireFilterObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "object" || Array.isArray(raw)) {
    invalidParams(`invalid filter: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`)
  }
  return raw as Record<string, unknown>
}

/**
 * #242: Generic string-param validator. Pre-fix `String(...)` coercion
 * silently mapped numbers/booleans/objects to bogus identifiers
 * ("123"/"true"/"[object Object]") that downstream lookups couldn't
 * distinguish from real strings. Used for DID/agentId/credentialId
 * params. Same anti-pattern as #120/#220/#226/#240.
 */
export function requireStringParam(params: unknown[], index: number, name: string): string {
  const raw = (params ?? [])[index]
  if (raw === undefined || raw === null || raw === "") {
    invalidParams(`missing ${name} parameter`)
  }
  if (typeof raw !== "string") {
    invalidParams(`invalid ${name}: expected string, got ${Array.isArray(raw) ? "array" : typeof raw}`)
  }
  return raw as string
}

/**
 * #252: Generic non-negative integer-param validator. Pre-fix
 * `Number((params)[idx] ?? -1)` silently coerced `true`→1, `[1]`→1,
 * `"1"`→1, `null`→0 so callers got hits for non-integer inputs.
 * Used for epochId in `coc_getRewardManifest` / `coc_getRewardClaim`.
 * Same anti-pattern as #120/#220/#226/#240/#242.
 */
export function requireIntegerParam(params: unknown[], index: number, name: string): number {
  const raw = (params ?? [])[index]
  if (raw === undefined || raw === null) {
    invalidParams(`missing ${name} parameter`)
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    invalidParams(`invalid ${name}: expected non-negative integer, got ${Array.isArray(raw) ? "array" : typeof raw}`)
  }
  return raw as number
}

/**
 * #254: Optional non-negative integer with default. Treats `undefined`
 * and `null` as "omitted" and returns the supplied default; rejects
 * any other non-integer shape with -32602. Pre-fix the
 * `Number((params)[idx] ?? N)` idiom in `coc_getTransactionsByAddress`
 * (and similar paginated handlers) silently coerced `true`→1, `"5"`→5,
 * `[3]`→3, `{}`→NaN→fallback. Same family as #252/#251/#224.
 */
export function optionalIntegerParam(
  params: unknown[],
  index: number,
  name: string,
  defaultValue: number,
  opts?: { min?: number; max?: number },
): number {
  const raw = (params ?? [])[index]
  if (raw === undefined || raw === null) return defaultValue
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    invalidParams(`invalid ${name}: expected integer or omitted, got ${Array.isArray(raw) ? "array" : typeof raw}`)
  }
  const min = opts?.min ?? 0
  const max = opts?.max ?? Number.MAX_SAFE_INTEGER
  if (raw < min || raw > max) {
    invalidParams(`invalid ${name}: must be between ${min} and ${max}`)
  }
  return raw as number
}

/**
 * #254: Strict optional boolean. Pre-fix `(params[idx] !== false)` was
 * the worst kind of silent coercion — every non-`false` value (`0`,
 * `"false"`, `null`, `{}`, `[]`) parsed as `true`, which is usually the
 * opposite of what a sloppy client meant when sending `0` or `"false"`.
 * Returns the supplied default for `undefined`/`null`; rejects every
 * non-boolean shape with -32602.
 */
export function optionalBooleanParam(
  params: unknown[],
  index: number,
  name: string,
  defaultValue: boolean,
): boolean {
  const raw = (params ?? [])[index]
  if (raw === undefined || raw === null) return defaultValue
  if (typeof raw !== "boolean") {
    invalidParams(`invalid ${name}: expected boolean or omitted, got ${Array.isArray(raw) ? "array" : typeof raw}`)
  }
  return raw as boolean
}

// ---------------------------------------------------------------------------
// Tx-call field validators
// ---------------------------------------------------------------------------

const HEX_QUANTITY_RE = /^0x[0-9a-fA-F]+$/
const HEX_DATA_RE = /^0x([0-9a-fA-F]{2})*$/

/**
 * #148: validate the numeric/data fields of an eth_call / estimateGas /
 * sendTransaction-shaped object. Pre-fix, malformed `value`/`gas`/etc
 * either flowed through to the EVM (which silently treated non-hex as
 * 0) or surfaced as -32603 internal-error with the V8 message leaked.
 * Rejects each field at the boundary with -32602.
 */
export function validateTxCallFields(callParams: Record<string, unknown>): void {
  for (const field of ["value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"] as const) {
    const v = callParams[field]
    if (v === undefined || v === null || v === "") continue
    if (typeof v !== "string" || !HEX_QUANTITY_RE.test(v)) {
      invalidParams(`invalid ${field}: must match /^0x[0-9a-fA-F]+$/`)
    }
  }
  const data = callParams.data
  if (data !== undefined && data !== null && data !== "") {
    if (typeof data !== "string" || !HEX_DATA_RE.test(data)) {
      invalidParams("invalid data: must match /^0x([0-9a-fA-F]{2})*$/")
    }
  }
}

// ---------------------------------------------------------------------------
// Log filter (eth_getLogs / eth_newFilter) shape + normalization
// ---------------------------------------------------------------------------

const FILTER_ADDR_RE = /^0x[0-9a-fA-F]{40}$/
const FILTER_TOPIC_RE = /^0x[0-9a-fA-F]{64}$/
const MAX_FILTER_ADDRESSES = 100
const MAX_FILTER_TOPICS = 4

/**
 * Validate + normalize the address/topic/blockHash fields of a log
 * filter shape (the object accepted by `eth_getLogs`, `eth_newFilter`,
 * and downstream subscription paths). Mutates `query` in place with
 * normalized lowercase hex so downstream consumers don't need to
 * re-validate. Throws -32602 on malformed input.
 *
 * PR #142: added these rules for `eth_newFilter`
 * PR #162: extends them to `eth_getLogs`
 * PR #186: adds blockHash field check (sibling of #166)
 * PR #190: rejects non-array `topics` (silent-empty-result bug)
 */
export function validateLogFilter(query: Record<string, unknown>): {
  address: Hex | undefined
  addresses: Hex[] | undefined
  topics: Array<Hex | Hex[] | null> | undefined
} {
  // #186: blockHash field shape validation was missed by #162's
  // address+topics work. Pre-fix `{blockHash: "0x123"}` silently
  // returned `result: []` indistinguishable from "no logs". Match
  // the 32-byte hex shape of eth_getBlockByHash (#166).
  if (query.blockHash !== undefined && query.blockHash !== null) {
    if (typeof query.blockHash !== "string" || !FILTER_TOPIC_RE.test(query.blockHash)) {
      invalidParams("invalid blockHash: must match /^0x[0-9a-fA-F]{64}$/")
    }
    query.blockHash = (query.blockHash as string).toLowerCase()
  }
  const validateFilterAddr = (raw: unknown, idx: number): Hex => {
    if (typeof raw !== "string" || !FILTER_ADDR_RE.test(raw)) {
      invalidParams(`invalid filter address at index ${idx}: must match /^0x[0-9a-fA-F]{40}$/`)
    }
    return (raw as string).toLowerCase() as Hex
  }
  let address: Hex | undefined
  let addresses: Hex[] | undefined
  if (query.address !== undefined && query.address !== null) {
    if (Array.isArray(query.address)) {
      if (query.address.length > MAX_FILTER_ADDRESSES) {
        invalidParams(`address array too large: ${query.address.length} > ${MAX_FILTER_ADDRESSES}`)
      }
      addresses = (query.address as unknown[]).map((a, i) => validateFilterAddr(a, i))
      address = addresses.length > 0 ? addresses[0] : undefined
    } else {
      address = validateFilterAddr(query.address, 0)
    }
    query.address = addresses ?? address
  }
  let topics: Array<Hex | Hex[] | null> | undefined
  if (query.topics !== undefined && query.topics !== null) {
    // #190: pre-fix, a non-array `topics` (string, object, number) silently
    // bypassed the entire validation block — clients got the same empty-result
    // response as a syntactically-valid query and never learned their filter
    // was malformed.
    if (!Array.isArray(query.topics)) {
      invalidParams("invalid filter topics: must be array or omitted")
    }
    if ((query.topics as unknown[]).length > MAX_FILTER_TOPICS) {
      invalidParams(`topics array too large: ${(query.topics as unknown[]).length} > ${MAX_FILTER_TOPICS} (max indexed log topics)`)
    }
    topics = (query.topics as unknown[]).map((t, i) => {
      if (t === null || t === undefined) return null
      if (Array.isArray(t)) {
        return t.map((tt, j) => {
          if (typeof tt !== "string" || !FILTER_TOPIC_RE.test(tt)) {
            invalidParams(`invalid filter topic at index ${i}[${j}]: must match /^0x[0-9a-fA-F]{64}$/ or null`)
          }
          return (tt as string).toLowerCase() as Hex
        })
      }
      if (typeof t !== "string" || !FILTER_TOPIC_RE.test(t)) {
        invalidParams(`invalid filter topic at index ${i}: must match /^0x[0-9a-fA-F]{64}$/ or null`)
      }
      return (t as string).toLowerCase() as Hex
    })
    query.topics = topics
  }
  return { address, addresses, topics }
}

// ---------------------------------------------------------------------------
// Error sanitization helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize an ethers v6 error before surfacing it to a JSON-RPC client.
 *
 * Ethers errors carry private state (`.code === "INVALID_ARGUMENT"`,
 * `"BUFFER_OVERRUN"`, `"NUMERIC_FAULT"`, etc. — see ethers/utils/errors.ts)
 * and version strings that leak the running ethers version. Bare
 * propagation (e.g. `throw new Error(err.message)`) gave clients
 * brittle copy-paste failures and probe surfaces. Centralise the strip
 * here so every call site behaves the same way (rpc.ts:1026 #156,
 * rpc.ts:1257 #182, websocket-rpc.ts WS error path #214, etc.).
 *
 * Returns the sanitized message string for the caller to use as the
 * `message` field of an invalidParams() throw. Pass a `fallbackMsg` to
 * produce a domain-specific surface (e.g. "transaction decode failed").
 */
export function sanitizeEthersError(err: unknown, fallbackMsg = "encoding failed"): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; reason?: unknown; message?: unknown }
    // Ethers errors always have a `.code` like "INVALID_ARGUMENT". Strip
    // that and `.shortMessage`, since both leak ethers-internal vocabulary.
    if (typeof e.code === "string") return fallbackMsg
    // Some ethers wrappers expose `.reason` containing ".version" — also strip.
    if (typeof e.reason === "string" && /version/i.test(e.reason)) return fallbackMsg
  }
  return fallbackMsg
}

/**
 * Sanitize a V8 JSON.parse SyntaxError before returning it to clients.
 *
 * V8's `JSON.parse` failure messages include source position info
 * (`"Unexpected token } in JSON at position 47"`) which (a) leaks
 * internal request body content and (b) ties the API surface to the
 * V8 version (the format has changed between major Node versions).
 *
 * Pre-fix sites: rpc.ts:246/496, ipfs-http.ts (kubo /api/v0/* POST
 * bodies #232), pose-http.ts (#176), coc-node.ts (#222). All replace
 * the raw exception message with a generic phrase.
 */
export function sanitizeJsonParseError(_err: unknown): string {
  return "malformed JSON request body"
}
