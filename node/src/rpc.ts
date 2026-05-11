import http from "node:http"
import { timingSafeEqual, randomBytes } from "node:crypto"
import { hexToBytes } from "@ethereumjs/util"
import { SigningKey, keccak256, hashMessage, Transaction, TypedDataEncoder, getCreateAddress } from "ethers"
import type { IChainEngine } from "./chain-engine-types.ts"
import { hasGovernance, hasConfig, hasBlockIndex } from "./chain-engine-types.ts"
import type { EvmChain, ExecutionContext } from "./evm.ts"
import type { Hex, PendingFilter } from "./blockchain-types.ts"
import type { P2PNode } from "./p2p.ts"
import type { PoSeEngine } from "./pose-engine.ts"
import { registerPoseRoutes, handlePoseRequest } from "./pose-http.ts"
import type { PoseInboundAuthOptions } from "./pose-http.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import { calculateBaseFee, computeBlobGasPrice, genesisBaseFee, BLOCK_GAS_LIMIT } from "./base-fee.ts"
import { FeeOracle } from "./fee-oracle.ts"
import { traceBlockTransactions, traceTransactionResult } from "./debug-trace.ts"
import type { BftCoordinator } from "./bft-coordinator.ts"
import { RateLimiter } from "./rate-limiter.ts"
import { createLogger } from "./logger.ts"
import { buildBlockHeaderView } from "./block-header.ts"
import { aggregateBlockLogsBloom } from "./block-header.ts"
import { lookupRewardClaim, readBestRewardManifest } from "../../runtime/lib/reward-manifest.ts"
import type { CallTrace, CallTraceResult, TxTraceResult } from "./trace-types.ts"

const log = createLogger("rpc")

// Per-account nonce serialization: prevents concurrent eth_sendTransaction from getting same nonce
const sendTxLocks = new Map<string, Promise<unknown>>()

const MAX_FILTERS = 1000
export const FILTER_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CHAIN_STATS_CACHE_TTL_MS = 5_000
let chainStatsCache: { result: unknown; height: bigint; cachedAtMs: number } | null = null
let chainStatsComputing: Promise<unknown> | null = null
let solcLoaderPromise: Promise<{ compile(input: string): string; version(): string }> | null = null

const FILTER_CLEANUP_THROTTLE_MS = 30_000 // run cleanup at most once per 30s
let lastFilterCleanupMs = 0

const feeOracle = new FeeOracle()

export function cleanupExpiredFilters(filters: Map<string, PendingFilter>, opts?: { force?: boolean }): void {
  const now = Date.now()
  if (!opts?.force && now - lastFilterCleanupMs < FILTER_CLEANUP_THROTTLE_MS) return
  lastFilterCleanupMs = now
  for (const [id, filter] of filters) {
    // Use last-poll time (falling back to creation time) so actively
    // polled filters don't get reaped from under their subscribers.
    // Polling-based clients (the standard fallback when WebSocket isn't
    // available) often live for hours and call getFilterChanges every
    // few seconds; using createdAtMs killed those after 5 min.
    const lastSeen = filter.lastAccessedAtMs ?? filter.createdAtMs
    if (lastSeen && now - lastSeen > FILTER_TTL_MS) {
      filters.delete(id)
    }
  }
}

// BigInt-safe JSON serializer for RPC responses
/** Constant-time string comparison to prevent timing attacks on auth tokens.
 *  Pads both buffers to the same length so the comparison time is independent
 *  of the secret token length (prevents length oracle via timing). */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  const maxLen = Math.max(bufA.length, bufB.length)
  const paddedA = Buffer.alloc(maxLen)
  const paddedB = Buffer.alloc(maxLen)
  bufA.copy(paddedA)
  bufB.copy(paddedB)
  const equal = timingSafeEqual(paddedA, paddedB)
  return equal && bufA.length === bufB.length
}

/** JSON stringify that serializes bigint values as hex strings (EVM RPC convention). */
export function jsonStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) =>
    typeof value === "bigint" ? `0x${value.toString(16)}` : value
  )
}

// RPC parameter validation helpers
function requireHexParam(params: unknown[], index: number, name: string): Hex {
  const value = (params ?? [])[index]
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw { code: -32602, message: `invalid ${name}: expected hex string` }
  }
  // Validate hex content and cap length to prevent injection of arbitrary strings
  if (value.length > 66 || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw { code: -32602, message: `invalid ${name}: malformed hex string` }
  }
  return value as Hex
}

/**
 * #122: strict 20-byte address validator. requireHexParam accepts any
 * hex up to 66 chars, so "0x123" slipped through and downstream code
 * either echoed back the raw input (eth_getBalance) or silently missed
 * the index (coc_getContractInfo). Use this at the RPC boundary for
 * methods whose param is documented as an Ethereum address.
 */
function requireAddressParam(params: unknown[], index: number, name = "address"): Hex {
  const value = (params ?? [])[index]
  if (typeof value !== "string") {
    throw { code: -32602, message: `invalid ${name}: expected string` }
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw { code: -32602, message: `invalid ${name}: must match /^0x[0-9a-fA-F]{40}$/` }
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
function requireTxHashParam(params: unknown[], index: number, name = "transaction hash"): Hex {
  const value = (params ?? [])[index]
  if (typeof value !== "string") {
    throw { code: -32602, message: `invalid ${name}: expected string` }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw { code: -32602, message: `invalid ${name}: must match /^0x[0-9a-fA-F]{64}$/` }
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
function requireBlockHashParam(params: unknown[], index: number): Hex {
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
function requireIndexParam(params: unknown[], index: number, name = "index"): number {
  const raw = (params ?? [])[index]
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw { code: -32602, message: `invalid ${name} at param ${index}: must match /^0x[0-9a-fA-F]+$/` }
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw { code: -32602, message: `invalid ${name} at param ${index}: must be non-negative integer` }
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
function requireFilterId(params: unknown[], index: number): string {
  const value = (params ?? [])[index]
  if (typeof value !== "string") {
    throw { code: -32602, message: `invalid filter id at index ${index}: expected string` }
  }
  if (!/^0x[0-9a-fA-F]{32}$/.test(value)) {
    throw { code: -32602, message: `invalid filter id at index ${index}: must match /^0x[0-9a-fA-F]{32}$/` }
  }
  return value.toLowerCase()
}

/**
 * Validate that the first param of eth_call / eth_estimateGas /
 * eth_sendTransaction / eth_createAccessList is an object — not a
 * string, number, array, or boolean. #172: pre-fix the type assertion
 * `as Record<string, string>` was a no-op at runtime; non-object input
 * coerced to an effectively-empty tx and the EVM returned "0x".
 * null/undefined pass through as `undefined` so the caller can still
 * fall back to `{}` (matches geth's `eth_call(null)` ergonomic).
 */
function requireCallObject(raw: unknown, methodName: string): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw { code: -32602, message: `invalid ${methodName} object: expected object, got ${Array.isArray(raw) ? "array" : typeof raw}` }
  }
  return raw as Record<string, unknown>
}

function optionalHexParam(params: unknown[], index: number): Hex | undefined {
  const value = (params ?? [])[index]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !value.startsWith("0x")) return undefined
  if (value.length > 66 || !/^0x[0-9a-fA-F]*$/.test(value)) return undefined
  return value as Hex
}

/**
 * #148: validate the numeric/data fields of an eth_call / estimateGas /
 * sendTransaction-shaped object. Pre-fix, malformed `value`/`gas`/etc
 * either flowed through to the EVM (which silently treated non-hex as
 * 0) or surfaced as -32603 internal-error with the V8 message leaked.
 * Rejects each field at the boundary with -32602.
 */
const HEX_QUANTITY_RE = /^0x[0-9a-fA-F]+$/
const HEX_DATA_RE = /^0x([0-9a-fA-F]{2})*$/
function validateTxCallFields(callParams: Record<string, unknown>): void {
  for (const field of ["value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"] as const) {
    const v = callParams[field]
    if (v === undefined || v === null || v === "") continue
    if (typeof v !== "string" || !HEX_QUANTITY_RE.test(v)) {
      throw { code: -32602, message: `invalid ${field}: must match /^0x[0-9a-fA-F]+$/` }
    }
  }
  const data = callParams.data
  if (data !== undefined && data !== null && data !== "") {
    if (typeof data !== "string" || !HEX_DATA_RE.test(data)) {
      throw { code: -32602, message: "invalid data: must match /^0x([0-9a-fA-F]{2})*$/" }
    }
  }
}

const MAX_RPC_BODY = 1024 * 1024 // 1 MB max request body for RPC
const rateLimiter = new RateLimiter()
// Cleanup expired buckets every 5 minutes
setInterval(() => rateLimiter.cleanup(), 300_000).unref()

function isDevAccountsEnabled(): boolean {
  // Only enable dev accounts with explicit opt-in — NODE_ENV=test no longer sufficient
  // to prevent accidental exposure of hardcoded private keys in production
  return process.env.COC_DEV_ACCOUNTS === "1"
}

// Debug/trace RPC feature gate: only enabled when COC_DEBUG_RPC=1
const DEBUG_RPC_ENABLED = process.env.COC_DEBUG_RPC === "1"

// Test account manager (dev/test only)
interface TestAccount {
  address: string
  privateKey: string
  signingKey: SigningKey
}

const testAccounts = new Map<string, TestAccount>()

// 初始化测试账户（仅用于开发/测试）
function initializeTestAccounts() {
  if (testAccounts.size > 0) return // 已初始化

  // 创建 10 个确定性测试账户
  const testPrivateKeys = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  ]

  for (const pk of testPrivateKeys) {
    const signingKey = new SigningKey(pk)
    const address = computeAddressFromPublicKey(signingKey.publicKey).toLowerCase()
    testAccounts.set(address, { address, privateKey: pk, signingKey })
  }

  log.info("initialized test accounts", { count: testAccounts.size })
}

function computeAddressFromPublicKey(publicKey: string): string {
  // publicKey = 0x04... (65 bytes uncompressed)
  // Ethereum address = keccak256(pubkey_without_04_prefix)[last 20 bytes]
  const pubkeyNoPrefix = Buffer.from(publicKey.slice(4), "hex")
  const hash = keccak256(pubkeyNoPrefix)
  return "0x" + hash.slice(-40)
}

interface JsonRpcRequest {
  id: string | number | null
  jsonrpc: string
  method: string
  params?: unknown[]
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { message: string }
}

interface RpcAuthOptions {
  /** Bearer token for RPC authentication. Undefined = no auth required. */
  authToken?: string
  /** Enable admin RPC namespace (admin_*) */
  enableAdminRpc?: boolean
}

interface RpcRuntimeOptions {
  nodeId?: string
  getP2PStats?: () => unknown
  getWireStats?: () => unknown
  getDhtStats?: () => unknown
  /**
   * Phase C2.2: expose DHT provider lookups to the PoSe challenger so it
   * can pre-filter monopoly CIDs before issuing a Storage challenge.
   * When omitted, `coc_dhtFindProviders` returns an empty array and
   * the challenger falls back to trying without a DHT hint.
   */
  findProviders?: (cid: string, maxK?: number) => string[]
  /**
   * Phase C2.4: fetch a raw IPFS block from DHT-advertised peers,
   * optionally excluding a specific peer (the challenge's prover)
   * so the audit sampling gets bytes from an independent source.
   * Returns null when no non-excluded provider serves the CID within
   * the local node's peer-pull timeout.
   */
  fetchBlockFromPeer?: (cid: string, excludePeerId?: string) => Promise<Uint8Array | null>
  rewardManifestDir?: string
  getBftEquivocations?: (sinceMs: number) => Array<{ rawEvidence?: Record<string, unknown>; [key: string]: unknown }>
  /**
   * Phase Q.4 / #108: expose erasure-coded manifest availability to RPC
   * clients. The HTTP /api/v0/erasure/status endpoint has had this since
   * Phase Q but the matching RPC method (which the runbook + skills
   * spec reference) was never wired. Bridge accepts the manifest CID
   * and returns per-stripe data/parity availability + total file size.
   * Throws on invalid_cid / not_a_manifest / not_found so the catch in
   * handleRpcMethod can surface the appropriate JSON-RPC error.
   */
  getErasureStatus?: (cid: string) => Promise<{
    fileSize: number
    scheme: string
    n: number
    m: number
    stripes: Array<{
      stripeIndex: number
      dataAvailable: number
      parityAvailable: number
      needsRepair: boolean
    }>
  }>
  getSyncProgress?: () => Promise<{ syncing: boolean; currentHeight: bigint; highestPeerHeight: bigint; startingHeight: bigint }>
  didResolver?: { resolve: (did: string) => Promise<unknown> }
  didDataProvider?: {
    getCapabilities(id: string): Promise<number>
    getFullDelegations(id: string): Promise<Array<Record<string, unknown>>>
    getLineage?(id: string): Promise<unknown>
    getVerificationMethods?(id: string): Promise<unknown[]>
    getDIDDocumentUpdatedAt?(id: string): Promise<number>
    getCredentialAnchor?(id: string): Promise<unknown>
  }
}

export function startRpcServer(
  bind: string,
  port: number,
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  pose?: PoSeEngine,
  bftCoordinator?: BftCoordinator,
  nodeId?: string,
  poseAuthOptions?: PoseInboundAuthOptions,
  runtimeOptions?: RpcRuntimeOptions,
  rpcAuthOptions?: RpcAuthOptions,
) {
  if (isDevAccountsEnabled()) {
    initializeTestAccounts()
  }

  const filters = new Map<string, PendingFilter>()
  const poseRoutes = pose ? registerPoseRoutes(pose) : []

  const server = http.createServer(async (req, res) => {
    // CORS headers (restrict origin via COC_CORS_ORIGIN env, default localhost)
    const allowedOrigin = process.env.COC_CORS_ORIGIN ?? "http://localhost:3000"
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin)
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

    if (req.method === "OPTIONS") {
      res.writeHead(200)
      res.end()
      return
    }

    // Rate limiting per IP (normalize IPv4-mapped IPv6)
    const rawClientIp = req.socket.remoteAddress ?? "unknown"
    const clientIp = rawClientIp.startsWith("::ffff:") ? rawClientIp.slice(7) : rawClientIp
    if (!rateLimiter.allow(clientIp)) {
      log.warn("RPC rate limit exceeded", { ip: clientIp, url: req.url })
      res.writeHead(429, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "rate limit exceeded" } }))
      return
    }

    // RPC authentication (Bearer token)
    if (rpcAuthOptions?.authToken) {
      const authHeader = req.headers["authorization"] ?? ""
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
      if (!constantTimeEqual(token, rpcAuthOptions.authToken)) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32003, message: "unauthorized" } }))
        return
      }
    }

    // Handle PoSe routes first
    if (pose && handlePoseRequest(poseRoutes, req, res, poseAuthOptions)) {
      return
    }

    if (req.method !== "POST") {
      res.writeHead(405)
      res.end()
      return
    }

    let body = ""
    let bodySize = 0
    let aborted = false
    req.on("data", (chunk: Buffer | string) => {
      if (aborted) return
      bodySize += typeof chunk === "string" ? chunk.length : chunk.byteLength
      if (bodySize > MAX_RPC_BODY) {
        aborted = true
        res.writeHead(413, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } }))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on("end", async () => {
      if (aborted) return
      try {
        if (!body || body.trim().length === 0) {
          // #138: empty body is "Invalid Request" per JSON-RPC §5.1.
          // Pre-fix this fell through to -32603 internal error.
          return sendError(res, null, "empty request", -32600)
        }

        let payload: JsonRpcRequest | JsonRpcRequest[]
        try {
          payload = JSON.parse(body)
        } catch {
          // #138: malformed JSON is "Parse error" -32700 per §5.1.
          // Pre-fix the V8 JSON.parse message ("Expected property name
          // or '}' in JSON at position 1...") leaked through as -32603,
          // coupling clients to internal Node phrasing.
          return sendError(res, null, "parse error: invalid JSON", -32700)
        }
        const rpcOpts: Record<string, unknown> = {}
        if (rpcAuthOptions?.enableAdminRpc) {
          rpcOpts.enableAdminRpc = true
        }
        const resolvedNodeId = nodeId ?? runtimeOptions?.nodeId
        if (resolvedNodeId) {
          rpcOpts.nodeId = resolvedNodeId
        }
        const p2pStats = runtimeOptions?.getP2PStats?.() ?? p2p?.getStats?.()
        if (p2pStats) {
          rpcOpts.p2pStats = p2pStats
        }
        const wireStats = runtimeOptions?.getWireStats?.()
        if (wireStats) {
          rpcOpts.wireStats = wireStats
        }
        const dhtStats = runtimeOptions?.getDhtStats?.()
        if (dhtStats) {
          rpcOpts.dhtStats = dhtStats
        }
        if (runtimeOptions?.rewardManifestDir) {
          rpcOpts.rewardManifestDir = runtimeOptions.rewardManifestDir
        }
        if (runtimeOptions?.getBftEquivocations) {
          rpcOpts.getBftEquivocations = runtimeOptions.getBftEquivocations
        }
        if (runtimeOptions?.getSyncProgress) {
          rpcOpts.getSyncProgress = runtimeOptions.getSyncProgress
        }
        if (runtimeOptions?.didResolver) {
          rpcOpts.didResolver = runtimeOptions.didResolver
        }
        if (runtimeOptions?.didDataProvider) {
          rpcOpts.didDataProvider = runtimeOptions.didDataProvider
        }
        // Phase C2.2/C2.4: plumb the DHT provider-lookup and peer-fetch
        // callbacks through so coc_dhtFindProviders / coc_ipfsFetchBlockFromPeer
        // handlers can invoke them. Without these forwards the handlers
        // see `opts.findProviders === undefined` and return empty.
        if (runtimeOptions?.findProviders) {
          rpcOpts.findProviders = runtimeOptions.findProviders
        }
        if (runtimeOptions?.fetchBlockFromPeer) {
          rpcOpts.fetchBlockFromPeer = runtimeOptions.fetchBlockFromPeer
        }
        if (runtimeOptions?.getErasureStatus) {
          rpcOpts.getErasureStatus = runtimeOptions.getErasureStatus
        }
        const scopedOpts = Object.keys(rpcOpts).length > 0 ? rpcOpts : undefined
        const MAX_BATCH_SIZE = 100
        // Batch RPC: charge rate limit for each item in the batch, not just the outer request.
        // Without this, a single batch of 100 items counts as 1 rate-limit hit.
        if (Array.isArray(payload) && payload.length > 1) {
          const batchCost = Math.min(payload.length, MAX_BATCH_SIZE) - 1 // -1 because outer request already counted
          for (let i = 0; i < batchCost; i++) {
            if (!rateLimiter.allow(clientIp)) {
              log.warn("RPC batch rate limit exceeded", { ip: clientIp, batchSize: payload.length })
              res.writeHead(429, { "content-type": "application/json" })
              res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "rate limit exceeded (batch)" } }))
              return
            }
          }
        }
        // #140: §6 says an empty batch must return a single Invalid
        // Request error (NOT an empty array).
        if (Array.isArray(payload) && payload.length === 0) {
          if (!res.headersSent) {
            res.writeHead(200, { "content-type": "application/json" })
          }
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: empty batch" } }))
          return
        }
        // #164: pre-fix oversized batches were silently truncated via
        // payload.slice(0, MAX_BATCH_SIZE) — clients got 100 results and
        // had no way to tell their other 900 requests were dropped. If
        // those were state-changing (eth_sendRawTransaction), the client
        // thinks the txs were sent when they never ran. Reject the whole
        // batch with a single -32600 instead; same pattern as the
        // oversized-body rejection at line 373.
        if (Array.isArray(payload) && payload.length > MAX_BATCH_SIZE) {
          if (!res.headersSent) {
            res.writeHead(200, { "content-type": "application/json" })
          }
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: `batch too large: ${payload.length} items (max ${MAX_BATCH_SIZE})` },
          }))
          return
        }

        const response = Array.isArray(payload)
          ? await Promise.all(payload.map((item) => handleOne(item, chainId, evm, chain, p2p, filters, bftCoordinator, scopedOpts)))
          : await handleOne(payload, chainId, evm, chain, p2p, filters, bftCoordinator, scopedOpts)

        // #140: §4.1 server MUST NOT reply to notifications (requests
        // without "id"). handleOne returns null for notifications;
        // strip nulls here. If everything was a notification (single
        // or batch), respond with HTTP 204 no-body.
        if (response === null) {
          if (!res.headersSent) {
            res.writeHead(204)
          }
          res.end()
          return
        }
        let finalResponse: unknown = response
        if (Array.isArray(response)) {
          const filtered = response.filter((r) => r !== null)
          if (filtered.length === 0) {
            if (!res.headersSent) {
              res.writeHead(204)
            }
            res.end()
            return
          }
          finalResponse = filtered
        }

        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "application/json" })
        }
        res.end(jsonStringify(finalResponse))
      } catch (error) {
        sendError(res, null, error instanceof Error ? error.message : "internal error")
      }
    })
  })

  server.listen(port, bind, () => {
    log.info("listening", { bind, port })
  })
  return server
}

async function handleOne(
  payload: JsonRpcRequest,
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  filters: Map<string, PendingFilter>,
  bftCoordinator?: BftCoordinator,
  opts?: Record<string, unknown>,
): Promise<JsonRpcResponse | null> {
  if (!payload || typeof payload !== "object") {
    // #138: per JSON-RPC §5.1 invalid-request must carry code -32600.
    // Pre-fix this returned only { message }, which clients couldn't
    // distinguish from a malformed response.
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }
  }
  // #202: §1 — `jsonrpc` MUST be exactly "2.0". Pre-fix any value (or
  // omission) flowed through and the server happily echoed back a 2.0
  // response, masking buggy clients sending "1.0" / "1.1" / numeric 2.
  if (payload.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: jsonrpc must be exactly '2.0'" } }
  }
  if (typeof payload.method !== "string" || payload.method.length === 0) {
    // Pre-fix only rejected `!payload.method`, accepting `0` and `""`
    // via JS truthy semantics. Method MUST be a non-empty string.
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: method must be a non-empty string" } }
  }
  // #202: §4.1 — id MUST be String, Number, or NULL when present.
  // Pre-fix objects, arrays, bools were silently echoed back, which
  // either crashed strict-typed client response parsers or masked
  // bugs on the caller side.
  if ("id" in payload) {
    const id = (payload as JsonRpcRequest).id
    const idOk = id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
    if (!idOk) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: id must be string, number, or null" } }
    }
  }

  // #204: §4.2 — params, when present, MUST be a Structured value
  // (Array or Object). Pre-fix passing a string / bool / number flowed
  // through to `payload.params ?? []` and most methods just returned
  // their default response, masking buggy clients. Allow omission and
  // explicit `null` (we treat both as "no params"); reject everything
  // else with -32600.
  const rawParams = (payload as JsonRpcRequest).params
  if (rawParams !== undefined && rawParams !== null && typeof rawParams !== "object") {
    return { jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32600, message: "invalid request: params must be Array or Object" } }
  }

  // #140: §4.1 — a request without an `id` field is a Notification.
  // The server processes it but MUST NOT respond. Return null and let
  // the dispatcher omit the response from the wire.
  const isNotification = !("id" in payload)

  try {
    const result = await handleRpc(payload, chainId, evm, chain, p2p, filters, bftCoordinator, opts)
    if (isNotification) return null
    return { jsonrpc: "2.0", id: payload.id ?? null, result }
  } catch (error: unknown) {
    if (isNotification) return null
    // Support structured RPC errors (e.g. { code, message } from param validation)
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      const rpcErr = error as { code: unknown; message: unknown }
      // JSON-RPC 2.0 §5.1 requires error.code to be a number. Our internal
      // handlers throw { code: -32xxx, ... } objects (legitimate), but
      // downstream libraries like ethers throw errors with string codes
      // ("INVALID_ARGUMENT", "BUFFER_OVERRUN"). Coerce non-integer codes
      // to -32603 (Internal error) so the response stays spec-compliant
      // and clients aren't forced to handle the union type.
      const numericCode =
        typeof rpcErr.code === "number" && Number.isInteger(rpcErr.code) ? rpcErr.code : -32603
      const message = typeof rpcErr.message === "string" ? rpcErr.message : "internal error"
      return { jsonrpc: "2.0", id: payload.id ?? null, error: { code: numericCode, message } }
    }
    return { jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : "internal error" } }
  }
}

function sendError(res: http.ServerResponse, id: string | number | null, message: string, code = -32603) {
  if (!res.headersSent) {
    res.writeHead(200, { "content-type": "application/json" })
  }
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }))
}

/**
 * Exported RPC method handler for reuse by WebSocket server.
 * Handles all standard JSON-RPC methods except eth_subscribe/eth_unsubscribe.
 */
export async function handleRpcMethod(
  method: string,
  params: unknown[],
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  bftCoordinator?: BftCoordinator,
  opts?: Record<string, unknown>,
): Promise<unknown> {
  const payload = { method, params, id: null, jsonrpc: "2.0" as const }
  const filters = new Map<string, PendingFilter>()
  return handleRpc(payload, chainId, evm, chain, p2p, filters, bftCoordinator, opts)
}

async function handleRpc(
  payload: JsonRpcRequest,
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  filters: Map<string, PendingFilter>,
  bftCoordinator?: BftCoordinator,
  opts?: Record<string, unknown>,
) {
  switch (payload.method) {
    case "web3_clientVersion":
      return "COC/0.2"
    case "net_version":
      return String(chainId)
    case "eth_chainId":
      return `0x${chainId.toString(16)}`
    case "eth_blockNumber": {
      const height = await Promise.resolve(chain.getHeight())
      return `0x${height.toString(16)}`
    }
    case "eth_getBalance": {
      // #122: validate at the boundary so a typo gives -32602 instead of
      // -32603 with the raw input echoed back from the EVM.
      const address = requireAddressParam(payload.params ?? [], 0)
      const stateRoot = await resolveHistoricalStateRoot((payload.params ?? [])[1], chain)
      const balance = await evm.getBalance(address, stateRoot)
      return `0x${balance.toString(16)}`
    }
    case "eth_getTransactionCount": {
      // #122: same boundary check as eth_getBalance so address typos
      // surface consistently across read-state RPCs.
      const address = requireAddressParam(payload.params ?? [], 0)
      const tag = (payload.params ?? [])[1]
      if (tag === "pending") {
        const onchainNonce = await evm.getNonce(address)
        const pendingNonce = chain.mempool.getPendingNonce(address as Hex, onchainNonce)
        return `0x${pendingNonce.toString(16)}`
      }
      const stateRoot = await resolveHistoricalStateRoot(tag, chain)
      const nonce = await evm.getNonce(address, stateRoot)
      return `0x${nonce.toString(16)}`
    }
    case "eth_getTransactionReceipt": {
      const hash = requireTxHashParam(payload.params ?? [], 0)
      // Try persistent index first, then fall back to EVM memory
      if (typeof chain.getTransactionByHash === "function") {
        const tx = await chain.getTransactionByHash(hash as Hex)
        if (tx?.receipt) {
          return formatPersistentReceipt(tx, chain)
        }
      }
      return evm.getReceipt(hash)
    }
    case "eth_getTransactionByHash": {
      const hash = requireTxHashParam(payload.params ?? [], 0)
      // Try persistent index first, then fall back to EVM memory
      if (typeof chain.getTransactionByHash === "function") {
        const tx = await chain.getTransactionByHash(hash as Hex)
        if (tx) {
          const block = await Promise.resolve(chain.getBlockByNumber(tx.receipt.blockNumber))
          const transactionIndex = block ? findTransactionIndex(block.txs, tx.receipt.transactionHash) : null
          return formatRawTransaction(tx.rawTx, {
            blockHash: tx.receipt.blockHash,
            blockNumber: tx.receipt.blockNumber,
            transactionIndex,
          })
        }
      }
      const evmResult = evm.getTransaction(hash)
      if (evmResult) return evmResult
      // Check mempool for pending transactions
      const allPending = chain.mempool.getAll()
      const pendingTx = allPending.find((mtx) => mtx.hash.toLowerCase() === hash.toLowerCase())
      if (pendingTx) {
        return formatRawTransaction(pendingTx.rawTx, {
          blockHash: null as unknown as Hex,
          blockNumber: null as unknown as bigint,
          transactionIndex: null,
        })
      }
      return null
    }
    case "eth_getBlockByNumber": {
      const tag = String((payload.params ?? [])[0] ?? "latest")
      const includeTx = Boolean((payload.params ?? [])[1])
      const number = await resolveBlockNumber(tag, chain)
      const block = await Promise.resolve(chain.getBlockByNumber(number))
      // #112: synthesise a genesis block when block 0 is missing. The
      // chain starts producing at height 1, so resolveBlockNumber("earliest")
      // → 0n → null. Standard Ethereum tooling expects "earliest" to return
      // *something*. Match block-1's parentHash (all zeros) + timestamp 0,
      // matching the convention already on the wire.
      if (!block && number === 0n) {
        const height = await Promise.resolve(chain.getHeight())
        if (height >= 1n) {
          return formatGenesisBlock(includeTx)
        }
      }
      return formatBlock(block, includeTx, chain, evm)
    }
    case "eth_getBlockByHash": {
      // #166: pre-fix loose String() conversion accepted any input —
      // undefined, null, short hex, non-hex — and returned null,
      // indistinguishable from "valid hash, no such block". Symmetric
      // with #150's eth_getTransactionByHash fix.
      const hash = requireBlockHashParam(payload.params ?? [], 0)
      const includeTx = Boolean((payload.params ?? [])[1])
      const block = await Promise.resolve(chain.getBlockByHash(hash))
      return formatBlock(block, includeTx, chain, evm)
    }
    case "eth_gasPrice": {
      const baseFee = await computeCurrentBaseFee(chain)
      // Gas price = baseFee + suggested tip (1 gwei)
      const suggestedPrice = baseFee + 1_000_000_000n
      return `0x${suggestedPrice.toString(16)}`
    }
    case "eth_estimateGas": {
      // #172: reject non-object first param (string/array/number/bool)
      // upfront — the `as Record<string,string>` cast was a no-op at
      // runtime so garbage input coerced to {} and returned a default
      // 21000-ish gas estimate.
      const estParams = (requireCallObject((payload.params ?? [])[0], "eth_estimateGas") ?? {}) as Record<string, string>
      // #128: pre-fix the regex was /^0x[0-9a-fA-F]{1,40}$/ which
      // accepted "0x1" or any 1-39 hex chars. Same class as #124 fix
      // for eth_call but eth_estimateGas was missed in that pass.
      // Address must be exactly 20 bytes (40 hex chars). Empty `to`
      // still permitted for contract-creation gas estimates.
      if (estParams.to && !/^0x[0-9a-fA-F]{40}$/.test(estParams.to)) {
        throw { code: -32602, message: "invalid to address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      if (estParams.from && !/^0x[0-9a-fA-F]{40}$/.test(estParams.from)) {
        throw { code: -32602, message: "invalid from address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      // #148: validate value/gas/data shape — pre-fix the EVM silently
      // treated non-hex as 0, so {value:"not-hex"} gave a clean gas
      // estimate that ignored the value transfer.
      validateTxCallFields(estParams)
      // Default gas cap to block gas limit (30M) to prevent DoS via unbounded execution
      const gasForEstimate = estParams.gas ?? "0x1c9c380"
      const executionContext = await resolveHistoricalExecutionContext((payload.params ?? [])[1], chain)
      const estimated = await evm.estimateGas({
        from: estParams.from,
        to: estParams.to ?? "",
        data: estParams.data,
        value: estParams.value,
        gas: gasForEstimate,
      }, executionContext.stateRoot, executionContext)
      return `0x${estimated.toString(16)}`
    }
    case "eth_getCode": {
      const codeAddr = requireAddressParam(payload.params ?? [], 0)
      const stateRoot = await resolveHistoricalStateRoot((payload.params ?? [])[1], chain)
      return await evm.getCode(codeAddr, stateRoot)
    }
    case "eth_call": {
      // #172: reject non-object first param upfront — runtime type
      // assertion bypass let strings/arrays/numbers coerce to {} and
      // return a no-op "0x" instead of the expected -32602.
      const callParams = (requireCallObject((payload.params ?? [])[0], "eth_call") ?? {}) as Record<string, string>
      const to = callParams.to ?? ""
      // #124: pre-fix the regex was /^0x[0-9a-fA-F]{1,40}$/ which
      // accepted "0x1" or any 1-39 hex chars. An address must be
      // exactly 20 bytes (40 hex chars). Allow empty `to` for contract
      // creation calls.
      if (to && !/^0x[0-9a-fA-F]{40}$/.test(to)) {
        throw { code: -32602, message: "invalid to address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      if (callParams.from && !/^0x[0-9a-fA-F]{40}$/.test(callParams.from)) {
        throw { code: -32602, message: "invalid from address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      // #148: validate value/gas/data shape before reaching the EVM,
      // where malformed input either silently becomes 0 (value) or
      // surfaces as -32603 with V8 message leak (data).
      validateTxCallFields(callParams)
      const executionContext = await resolveHistoricalExecutionContext((payload.params ?? [])[1], chain)
      const callResult = await evm.callRaw({
        from: callParams.from,
        to,
        data: callParams.data,
        value: callParams.value,
        gas: callParams.gas,
      }, executionContext.stateRoot, executionContext)
      return callResult.returnValue
    }
    case "eth_getStorageAt": {
      const storageAddr = requireAddressParam(payload.params ?? [], 0)
      // #118: validate the slot before forwarding to evm. Pre-fix, an
      // unsanitised slot like "-1" or unprefixed "1" was concatenated +
      // padded inside the EVM layer, surfacing either as -32603 with a
      // leaked padded-hex string ("0x000…-1") or as silent zero returns
      // that masked the underlying input bug.
      const slotRaw = (payload.params ?? [])[1]
      if (typeof slotRaw !== "string" || slotRaw.length === 0) {
        throw { code: -32602, message: "invalid storage slot: expected non-empty 0x-prefixed hex string" }
      }
      const storageSlot = slotRaw
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(storageSlot)) {
        throw { code: -32602, message: `invalid storage slot: must match /^0x[0-9a-fA-F]{1,64}$/` }
      }
      const stateRoot = await resolveHistoricalStateRoot((payload.params ?? [])[2], chain)
      return await evm.getStorageAt(storageAddr, storageSlot, stateRoot)
    }
    case "eth_getProof": {
      const proofAddr = requireAddressParam(payload.params ?? [], 0)
      const rawSlots = (payload.params ?? [])[1]
      if (!Array.isArray(rawSlots)) {
        throw { code: -32602, message: "invalid storage keys: expected array" }
      }
      const proofSlots = rawSlots.map((slot, index) => {
        if (typeof slot !== "string" || !slot.startsWith("0x")) {
          throw { code: -32602, message: `invalid storage key at index ${index}` }
        }
        const normalized = slot.replace(/^0x/, "")
        if (!/^[0-9a-fA-F]*$/.test(normalized) || normalized.length > 64) {
          throw { code: -32602, message: `invalid storage key at index ${index}` }
        }
        return `0x${normalized.padStart(64, "0")}`
      })
      const stateRoot = await resolveHistoricalStateRoot((payload.params ?? [])[2], chain)
      return await evm.getProof(proofAddr, proofSlots, stateRoot)
    }
    case "eth_syncing": {
      const syncProgressGetter = (opts as Record<string, unknown> | undefined)?.getSyncProgress as RpcRuntimeOptions["getSyncProgress"] | undefined
      if (syncProgressGetter) {
        const progress = await syncProgressGetter()
        if (progress.syncing) {
          return {
            startingBlock: `0x${progress.startingHeight.toString(16)}`,
            currentBlock: `0x${progress.currentHeight.toString(16)}`,
            highestBlock: `0x${progress.highestPeerHeight.toString(16)}`,
          }
        }
      }
      return false
    }
    case "net_listening":
      return true
    case "net_peerCount":
      return `0x${(p2p?.getPeers?.()?.length ?? 0).toString(16)}`
    case "eth_accounts":
      if (!isDevAccountsEnabled()) return []
      return Array.from(testAccounts.keys())
    case "web3_sha3": {
      // #170: pre-fix `Buffer.from("not-hex", "hex")` silently dropped
      // every invalid char and produced an empty buffer — so every
      // garbage input ("not-hex", "", null, undefined) returned the
      // same keccak256("") hash. Worse, `Buffer.from("ff0g", "hex")`
      // truncates at the first bad char and returns keccak256(0xff).
      // Validate shape upfront; only well-formed hex hashes.
      const raw = (payload.params ?? [])[0]
      if (typeof raw !== "string") {
        throw { code: -32602, message: "invalid input: expected hex string" }
      }
      if (!raw.startsWith("0x")) {
        throw { code: -32602, message: "invalid input: must be 0x-prefixed" }
      }
      const body = raw.slice(2)
      if (body.length % 2 !== 0 || (body.length > 0 && !/^[0-9a-fA-F]+$/.test(body))) {
        throw { code: -32602, message: "invalid input: must be even-length hex" }
      }
      const bytes = Buffer.from(body, "hex")
      return `0x${keccak256Hex(bytes)}`
    }
    case "eth_sendRawTransaction": {
      // #156: pre-fix bogus/short/non-hex inputs flowed straight into
      // ethers.Transaction.from() and surfaced as -32603 with messages
      // like "data short segment too short (buffer=0xff, length=1,
      // offset=9, code=BUFFER_OVERRUN, version=6.16.0)" — leaking the
      // ethers.js version + internal error class to any unauthenticated
      // caller. Validate shape upfront so clients get -32602 with a
      // clean message; only post-parse errors (signature, nonce, gas
      // pricing) bubble through as -32603.
      const rawInput = (payload.params ?? [])[0]
      if (typeof rawInput !== "string") {
        throw { code: -32602, message: "invalid raw transaction: expected hex string" }
      }
      if (!rawInput.startsWith("0x")) {
        throw { code: -32602, message: "invalid raw transaction: must be 0x-prefixed" }
      }
      const body = rawInput.slice(2)
      if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
        throw { code: -32602, message: "invalid raw transaction: must be even-length hex" }
      }
      // Smallest legitimate signed legacy tx is ~50 bytes (100 hex chars).
      // Reject anything obviously below the floor to avoid handing ethers
      // a truncated buffer it'll panic on.
      if (body.length < 100) {
        throw { code: -32602, message: "invalid raw transaction: too short to be a signed transaction" }
      }
      // Reject oversized raw transactions to prevent CPU abuse (128 KB ~= Ethereum mainnet limit)
      if (rawInput.length > 262_144) {
        throw { code: -32602, message: `raw transaction too large: ${rawInput.length} chars` }
      }
      const raw = rawInput as Hex
      let tx
      try {
        tx = await chain.addRawTx(raw)
      } catch (parseErr) {
        // ethers errors carry .code as a string ("BUFFER_OVERRUN" etc.)
        // and embed the library version in .message. Rethrow as a clean
        // -32602 so we don't leak that surface.
        const isEthersShapeError =
          parseErr && typeof parseErr === "object" && typeof (parseErr as { code?: unknown }).code === "string"
        if (isEthersShapeError) {
          throw { code: -32602, message: "invalid raw transaction: failed to decode" }
        }
        throw parseErr
      }
      await p2p.receiveTx(raw)
      return tx.hash
    }
    case "eth_getLogs": {
      const query = ((payload.params ?? [])[0] ?? {}) as Record<string, unknown>
      // EIP-234: blockHash is mutually exclusive with fromBlock/toBlock.
      // Pre-fix this silently processed the range and surfaced a confusing
      // "block range too large" error referencing the full chain height.
      if (query.blockHash !== undefined && (query.fromBlock !== undefined || query.toBlock !== undefined)) {
        throw { code: -32602, message: "eth_getLogs: blockHash is mutually exclusive with fromBlock/toBlock" }
      }
      // #162: validate filter address/topic shape so malformed inputs
      // surface as -32602 instead of silently matching nothing. PR #142
      // already did this for eth_newFilter; eth_getLogs was the wide-open
      // backdoor that bypassed validation despite taking the same shape.
      validateLogFilter(query)
      const logsHeight = await Promise.resolve(chain.getHeight())
      return await queryLogs(chain, query, logsHeight)
    }
    case "eth_newFilter": {
      if (filters.size >= MAX_FILTERS) {
        cleanupExpiredFilters(filters)
        if (filters.size >= MAX_FILTERS) throw { code: -32005, message: "filter limit exceeded" }
      }
      const query = ((payload.params ?? [])[0] ?? {}) as Record<string, unknown>
      const id = `0x${randomBytes(16).toString("hex")}`
      const newFilterHeight = await Promise.resolve(chain.getHeight())
      const fromBlock = parseBlockTag(query.fromBlock, newFilterHeight)
      const toBlock = query.toBlock !== undefined ? parseBlockTag(query.toBlock, newFilterHeight) : undefined
      // #142 / #162: validate address + topic shape so malformed inputs
      // reject at the boundary. Shared with eth_getLogs (#162) — both
      // consume the same filter shape, both should reject the same way.
      const { address: filterAddress, addresses: filterAddresses, topics: normalizedTopics } = validateLogFilter(query)
      const filter: PendingFilter = {
        id,
        kind: "log",
        fromBlock,
        toBlock,
        address: filterAddress,
        addresses: filterAddresses,
        topics: normalizedTopics,
        lastCursor: fromBlock > 0n ? fromBlock - 1n : 0n,
        createdAtMs: Date.now(),
      }
      filters.set(id, filter)
      return id
    }
    case "eth_getFilterChanges": {
      // #196: validate filter-id shape upfront so a buggy client polling
      // with the wrong type (number, array, null) sees -32602 instead of
      // a perpetual empty stream that mimics "no new events."
      const id = requireFilterId(payload.params ?? [], 0)
      const filter = filters.get(id)
      if (!filter) return []
      // Refresh the filter's last-access timestamp so cleanupExpiredFilters
      // doesn't reap an actively polled subscriber.
      filter.lastAccessedAtMs = Date.now()
      // pendingTx filter: return mempool tx hashes that haven't been
      // returned to this filter yet, then record them so the next poll
      // only sees newly-arrived hashes.
      if (filter.kind === "pendingTx") {
        filter.seenPendingTxs ??= new Set<Hex>()
        const seen = filter.seenPendingTxs
        const fresh: Hex[] = []
        for (const tx of chain.mempool.getAll()) {
          if (!seen.has(tx.hash)) {
            fresh.push(tx.hash)
            seen.add(tx.hash)
          }
        }
        return fresh
      }
      const start = filter.lastCursor + 1n
      const filterHeight = await Promise.resolve(chain.getHeight())
      const end = filter.toBlock ?? filterHeight
      // Skip if cursor has already passed the end (e.g. toBlock reached)
      if (start > end) { return [] }
      // Cap scan range to prevent DoS from long-idle filters
      const cappedEnd = (end - start > MAX_LOG_BLOCK_RANGE) ? start + MAX_LOG_BLOCK_RANGE : end
      // block filter: return block hashes for [start..cappedEnd] inclusive.
      if (filter.kind === "block") {
        const hashes: Hex[] = []
        for (let h = start; h <= cappedEnd; h++) {
          const block = await Promise.resolve(chain.getBlockByNumber(h))
          if (block) hashes.push(block.hash)
        }
        filter.lastCursor = cappedEnd
        return hashes
      }
      // log filter (default): existing behaviour.
      const logs = await collectLogs(chain, start, cappedEnd, filter)
      filter.lastCursor = cappedEnd
      return logs
    }
    case "eth_uninstallFilter": {
      // #196: same shape validation as eth_getFilterChanges so a
      // malformed id surfaces as -32602 rather than silently returning
      // `false` (which clients can't distinguish from "filter already
      // expired or never existed").
      const id = requireFilterId(payload.params ?? [], 0)
      return filters.delete(id)
    }
    case "eth_sendTransaction": {
      // #172: same shape validation as eth_call. Pre-fix the type
      // assertion bypass let non-object input through; downstream
      // "missing from address" was the only thing that caught it.
      const txParams = (requireCallObject((payload.params ?? [])[0], "eth_sendTransaction") ?? {}) as Record<string, string>
      const from = txParams.from?.toLowerCase()
      if (!from) throw { code: -32602, message: "missing from address" }
      if (!/^0x[0-9a-fA-F]{40}$/.test(from)) {
        throw { code: -32602, message: "invalid from address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      if (txParams.to && !/^0x[0-9a-fA-F]{40}$/.test(txParams.to)) {
        throw { code: -32602, message: "invalid to address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      // #148: validate value/gas/data shape before reaching the mempool.
      validateTxCallFields(txParams)

      const account = testAccounts.get(from)
      if (!account) throw { code: -32004, message: `account not found: ${from}. Use eth_accounts to list available test accounts.` }

      // #178: pre-fix the user's `nonce` field was silently dropped —
      // every call used the next sequential mempool nonce regardless.
      // Negative, NaN, far-future, or "not-hex" all "worked" with the
      // user's value ignored. Validate shape and honor it when present
      // (matches the Ethereum JSON-RPC spec).
      let userNonce: bigint | undefined
      if (txParams.nonce !== undefined && txParams.nonce !== null && txParams.nonce !== "") {
        if (typeof txParams.nonce !== "string" || !/^0x[0-9a-fA-F]+$/.test(txParams.nonce)) {
          throw { code: -32602, message: "invalid nonce: must match /^0x[0-9a-fA-F]+$/" }
        }
        userNonce = BigInt(txParams.nonce)
      }

      // Serialize per-account to prevent concurrent nonce collision
      const prev = sendTxLocks.get(from) ?? Promise.resolve()
      const work = prev.catch(() => {}).then(async () => {
        const onchainNonce = await evm.getNonce(from)
        const nonce = userNonce ?? chain.mempool.getPendingNonce(from as Hex, onchainNonce)
        const gasPrice = txParams.gasPrice ?? "0x3b9aca00" // 1 gwei
        const gasLimitRaw = txParams.gas ?? "0x" + (await evm.estimateGas({
          from: txParams.from,
          to: txParams.to ?? "",
          data: txParams.data ?? "0x",
          value: txParams.value ?? "0x0",
        })).toString(16)

        if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`nonce too large for safe conversion: ${nonce}`)
        }
        const tx = Transaction.from({
          to: txParams.to,
          value: txParams.value ?? "0x0",
          data: txParams.data ?? "0x",
          nonce: Number(nonce),
          gasLimit: gasLimitRaw,
          gasPrice,
          chainId,
        })

        const sig = account.signingKey.sign(tx.unsignedHash)
        const signed = tx.clone()
        signed.signature = sig
        const serialized = signed.serialized as Hex
        const result = await chain.addRawTx(serialized)
        await p2p.receiveTx(serialized)
        return result.hash
      })
      sendTxLocks.set(from, work)
      work.finally(() => { if (sendTxLocks.get(from) === work) sendTxLocks.delete(from) })
      return await work
    }
    case "eth_sign": {
      // #154: pre-fix bogus address + missing params surfaced as
      // -32603 "account not found: <raw input>" leaking the typo
      // back. Validate shape upfront so clients get -32602; only
      // address-not-in-dev-keystore yields -32004 (resource not
      // available — the address is well-formed, just not loaded).
      const address = requireAddressParam(payload.params ?? [], 0).toLowerCase() as Hex
      const rawMessage = (payload.params ?? [])[1]
      if (typeof rawMessage !== "string") {
        throw { code: -32602, message: "invalid message: expected hex string" }
      }
      const messageBody = rawMessage.startsWith("0x") ? rawMessage.slice(2) : rawMessage
      if (messageBody.length % 2 !== 0 || (messageBody.length > 0 && !/^[0-9a-fA-F]+$/.test(messageBody))) {
        throw { code: -32602, message: "invalid message: must be even-length hex (with optional 0x prefix)" }
      }

      const account = testAccounts.get(address)
      if (!account) throw { code: -32004, message: `account not in dev keystore: ${address}` }

      const messageHash = hashMessage(Buffer.from(messageBody, "hex"))
      const signature = account.signingKey.sign(messageHash)
      return signature.serialized
    }
    case "eth_signTypedData_v4": {
      // #154: same fix as eth_sign — validate address and typedData
      // shape upfront so malformed inputs return -32602 not -32603.
      const address = requireAddressParam(payload.params ?? [], 0).toLowerCase() as Hex
      const typedData = (payload.params ?? [])[1]
      if (typedData === null || typeof typedData !== "object" || Array.isArray(typedData)) {
        throw { code: -32602, message: "invalid typedData: expected object" }
      }

      const account = testAccounts.get(address)
      if (!account) throw { code: -32004, message: `account not in dev keystore: ${address}` }

      // EIP-712 compliant: use TypedDataEncoder for correct domain-separated hash
      const td = typedData as Record<string, unknown>
      const types = (td.types ?? {}) as Record<string, Array<{ name: string; type: string }>>
      const domain = (td.domain ?? {}) as Record<string, unknown>
      const message = (td.message ?? {}) as Record<string, unknown>
      // Remove EIP712Domain from types (TypedDataEncoder handles it internally)
      const filteredTypes = { ...types }
      delete filteredTypes.EIP712Domain
      // #182: pre-fix structural errors from TypedDataEncoder.hash
      // (missing primaryType, primaryType not in types, circular type
      // references) bubbled up as -32603 with ethers' raw message
      // including version=6.16.0 and code=INVALID_ARGUMENT. Same class
      // of leak as #156 (Transaction.from) and #176 (V8 SyntaxError).
      let dataHash: string
      try {
        dataHash = TypedDataEncoder.hash(domain, filteredTypes, message)
      } catch (encErr) {
        const isEthersShapeError =
          encErr && typeof encErr === "object" && typeof (encErr as { code?: unknown }).code === "string"
        if (isEthersShapeError) {
          throw { code: -32602, message: "invalid typedData: failed to encode" }
        }
        throw encErr
      }
      const signature = account.signingKey.sign(dataHash)
      return signature.serialized
    }
    case "eth_createAccessList": {
      // #172: shape validation symmetric with eth_call.
      const callParams = (requireCallObject((payload.params ?? [])[0], "eth_createAccessList") ?? {}) as Record<string, string>
      // #148: validate address + value/gas/data shape upfront.
      if (callParams.to && !/^0x[0-9a-fA-F]{40}$/.test(callParams.to)) {
        throw { code: -32602, message: "invalid to address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      if (callParams.from && !/^0x[0-9a-fA-F]{40}$/.test(callParams.from)) {
        throw { code: -32602, message: "invalid from address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      validateTxCallFields(callParams)
      const executionContext = await resolveHistoricalExecutionContext((payload.params ?? [])[1], chain)
      const result = await evm.traceCall({
        from: callParams.from,
        to: callParams.to ?? "",
        data: callParams.data,
        value: callParams.value,
        gas: callParams.gas,
      }, {}, executionContext.stateRoot, executionContext)
      return {
        accessList: result.accessList,
        gasUsed: `0x${result.gasUsed.toString(16)}`,
      }
    }
    case "debug_traceCall": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      // #172: shape validation symmetric with eth_call.
      const callParams = (requireCallObject((payload.params ?? [])[0], "debug_traceCall") ?? {}) as Record<string, string>
      // #148: validate shape — same as eth_call.
      if (callParams.to && !/^0x[0-9a-fA-F]{40}$/.test(callParams.to)) {
        throw { code: -32602, message: "invalid to address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      if (callParams.from && !/^0x[0-9a-fA-F]{40}$/.test(callParams.from)) {
        throw { code: -32602, message: "invalid from address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      validateTxCallFields(callParams)
      const executionContext = await resolveHistoricalExecutionContext((payload.params ?? [])[1], chain)
      const traceOpts = ((payload.params ?? [])[2] ?? {}) as Record<string, unknown>
      const result = await evm.traceCall({
        from: callParams.from,
        to: callParams.to ?? "",
        data: callParams.data,
        value: callParams.value,
        gas: callParams.gas,
      }, {
        disableStorage: Boolean(traceOpts.disableStorage),
        disableMemory: Boolean(traceOpts.disableMemory),
        disableStack: Boolean(traceOpts.disableStack),
        tracer: traceOpts.tracer ? String(traceOpts.tracer) : undefined,
      }, executionContext.stateRoot, executionContext)
      return formatDebugTraceResult(result, traceOpts)
    }
    case "debug_traceTransaction": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const txHash = String((payload.params ?? [])[0] ?? "") as Hex
      const traceOpts = ((payload.params ?? [])[1] ?? {}) as Record<string, unknown>
      const traceResult = await traceTransactionResult(txHash, chain, evm, {
        disableStorage: Boolean(traceOpts.disableStorage),
        disableMemory: Boolean(traceOpts.disableMemory),
        disableStack: Boolean(traceOpts.disableStack),
        tracer: traceOpts.tracer ? String(traceOpts.tracer) : undefined,
      })
      return formatDebugTraceResult(traceResult, traceOpts)
    }
    case "debug_traceBlockByNumber": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const blockTag = String((payload.params ?? [])[0] ?? "latest")
      const traceBlockNum = await resolveBlockNumber(blockTag, chain)
      const traceOpts2 = ((payload.params ?? [])[1] ?? {}) as Record<string, unknown>
      const traced = await traceBlockTransactions(traceBlockNum, chain, evm, {
        disableStorage: Boolean(traceOpts2.disableStorage),
        disableMemory: Boolean(traceOpts2.disableMemory),
        disableStack: Boolean(traceOpts2.disableStack),
        tracer: traceOpts2.tracer ? String(traceOpts2.tracer) : undefined,
      })
      return traced.map((entry) => ({
        txHash: entry.txHash,
        result: formatDebugTraceResult(entry, traceOpts2),
      }))
    }
    case "trace_transaction": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const txHash = String((payload.params ?? [])[0] ?? "") as Hex
      const txContext = await locateTraceTransactionContext(chain, txHash)
      if (!txContext) {
        throw new Error(`transaction not found: ${txHash}`)
      }
      const result = await traceTransactionResult(txHash, chain, evm)
      return formatLocalizedOpenEthereumCallTraces(result.callTraces, txContext)
    }
    case "trace_call": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      // #172: shape validation symmetric with eth_call.
      const callParams = (requireCallObject((payload.params ?? [])[0], "trace_call") ?? {}) as Record<string, string>
      const traceTypes = normalizeReplayTraceTypes((payload.params ?? [])[1])
      const executionContext = await resolveHistoricalExecutionContext((payload.params ?? [])[2], chain)
      const result = await evm.traceCall({
        from: callParams.from,
        to: callParams.to ?? "",
        data: callParams.data,
        value: callParams.value,
        gas: callParams.gas,
      }, {}, executionContext.stateRoot, executionContext)
      return formatTraceReplayResult(result, traceTypes)
    }
    case "trace_callMany": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const callRequests = normalizeTraceCallManyRequests((payload.params ?? [])[0])
      const executionContext = await resolveHistoricalExecutionContext((payload.params ?? [])[1], chain)
      const results = await evm.traceCallMany(
        callRequests.map((request) => request.call),
        {},
        executionContext.stateRoot,
        executionContext,
      )
      return results.map((result, index) => formatTraceReplayResult(result, callRequests[index].traceTypes))
    }
    case "trace_replayTransaction": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const txHash = String((payload.params ?? [])[0] ?? "") as Hex
      const traceTypes = normalizeReplayTraceTypes((payload.params ?? [])[1])
      const result = await traceTransactionResult(txHash, chain, evm)
      return formatTraceReplayResult(result, traceTypes)
    }
    case "trace_replayBlockTransactions": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const blockTag = String((payload.params ?? [])[0] ?? "latest")
      const traceTypes = normalizeReplayTraceTypes((payload.params ?? [])[1])
      const blockNumber = await resolveBlockNumber(blockTag, chain)
      const results = await traceBlockTransactions(blockNumber, chain, evm)
      return results.map((result) => formatTraceReplayResult(result, traceTypes))
    }
    case "trace_rawTransaction": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const rawTx = String((payload.params ?? [])[0] ?? "")
      const traceTypes = normalizeReplayTraceTypes((payload.params ?? [])[1])
      const result = await evm.traceRawTxOnState(rawTx)
      return formatTraceReplayResult(result, traceTypes)
    }
    case "trace_block": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const blockTag = String((payload.params ?? [])[0] ?? "latest")
      const blockNumber = await resolveBlockNumber(blockTag, chain)
      const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
      if (!block) {
        throw new Error(`block not found: ${blockTag}`)
      }
      const traces = await traceBlockTransactions(blockNumber, chain, evm)
      return traces.flatMap((traceResult, txIndex) =>
        formatLocalizedOpenEthereumCallTraces(traceResult.callTraces, {
          blockHash: block.hash,
          blockNumber,
          transactionHash: traceResult.txHash,
          transactionPosition: txIndex,
        }),
      )
    }
    case "trace_filter": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const query = ((payload.params ?? [])[0] ?? {}) as Record<string, unknown>
      return await queryTraceFilter(chain, evm, query)
    }
    case "trace_get": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const txHash = String((payload.params ?? [])[0] ?? "") as Hex
      const traceAddress = normalizeTraceAddressPath((payload.params ?? [])[1])
      const txContext = await locateTraceTransactionContext(chain, txHash)
      if (!txContext) {
        throw new Error(`transaction not found: ${txHash}`)
      }
      const result = await traceTransactionResult(txHash, chain, evm)
      const matched = result.callTraces.find((callTrace) =>
        traceAddressEquals(callTrace.traceAddress ?? [], traceAddress)
      )
      if (!matched) {
        return null
      }
      return formatLocalizedOpenEthereumCallTraces([matched], txContext)[0] ?? null
    }
    case "rpc_modules":
      return {
        eth: "1.0", net: "1.0", web3: "1.0", txpool: "1.0",
        ...(DEBUG_RPC_ENABLED ? { debug: "1.0", trace: "1.0" } : {}),
        ...((opts as Record<string, unknown> | undefined)?.enableAdminRpc ? { admin: "1.0" } : {}),
        coc: "1.0",
      }
    case "debug_getRawTransaction": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const rawTxHash = String((payload.params ?? [])[0] ?? "") as Hex
      // Find block containing the transaction
      if (typeof chain.getTransactionByHash === "function") {
        const txRecord = await chain.getTransactionByHash(rawTxHash)
        if (txRecord?.rawTx) return txRecord.rawTx
      }
      // Fallback: scan recent blocks
      const scanHeight = await Promise.resolve(chain.getHeight())
      for (let h = scanHeight; h >= 0n && h > scanHeight - 256n; h--) {
        const blk = await Promise.resolve(chain.getBlockByNumber(h))
        if (!blk) continue
        for (const rawTx of blk.txs) {
          try {
            if (Transaction.from(rawTx).hash?.toLowerCase() === rawTxHash.toLowerCase()) {
              return rawTx
            }
          } catch { /* skip */ }
        }
      }
      return null
    }
    case "debug_getRawReceipts": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const rawReceiptTag = String((payload.params ?? [])[0] ?? "latest")
      const rawReceiptHeight = await Promise.resolve(chain.getHeight())
      const rawReceiptNum = parseBlockTag(rawReceiptTag, rawReceiptHeight)
      const rawReceiptBlock = await Promise.resolve(chain.getBlockByNumber(rawReceiptNum))
      if (!rawReceiptBlock) return []
      return rawReceiptBlock.txs
    }
    case "debug_getRawHeader":
    case "debug_getRawBlock": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      // Simplified: return JSON-encoded block data as hex (not RLP)
      // Full RLP encoding deferred to future phase
      const rawBlockTag = String((payload.params ?? [])[0] ?? "latest")
      const rawBlockHeight = await Promise.resolve(chain.getHeight())
      const rawBlockNum = parseBlockTag(rawBlockTag, rawBlockHeight)
      const rawBlock = await Promise.resolve(chain.getBlockByNumber(rawBlockNum))
      if (!rawBlock) return null
      if (payload.method === "debug_getRawHeader") {
        const headerData = {
          number: rawBlock.number.toString(),
          hash: rawBlock.hash,
          parentHash: rawBlock.parentHash,
          proposer: rawBlock.proposer,
          timestampMs: rawBlock.timestampMs,
          gasUsed: (rawBlock.gasUsed ?? 0n).toString(),
          baseFee: (rawBlock.baseFee ?? 0n).toString(),
        }
        return "0x" + Buffer.from(JSON.stringify(headerData)).toString("hex")
      }
      const blockData = {
        number: rawBlock.number.toString(),
        hash: rawBlock.hash,
        parentHash: rawBlock.parentHash,
        proposer: rawBlock.proposer,
        timestampMs: rawBlock.timestampMs,
        gasUsed: (rawBlock.gasUsed ?? 0n).toString(),
        baseFee: (rawBlock.baseFee ?? 0n).toString(),
        txs: rawBlock.txs,
      }
      return "0x" + Buffer.from(JSON.stringify(blockData)).toString("hex")
    }
    case "eth_getBlockTransactionCountByHash": {
      // #166: same hash-shape validation as eth_getBlockByHash.
      const hash = requireBlockHashParam(payload.params ?? [], 0)
      const block = await Promise.resolve(chain.getBlockByHash(hash))
      return block ? `0x${block.txs.length.toString(16)}` : null
    }
    case "eth_getBlockTransactionCountByNumber": {
      const tag = String((payload.params ?? [])[0] ?? "latest")
      const height = await Promise.resolve(chain.getHeight())
      const num = parseBlockTag(tag, height)
      const block = await Promise.resolve(chain.getBlockByNumber(num))
      return block ? `0x${block.txs.length.toString(16)}` : null
    }
    case "eth_getTransactionByBlockHashAndIndex": {
      // #166: same hash-shape validation as eth_getBlockByHash.
      const blockHash = requireBlockHashParam(payload.params ?? [], 0)
      // #198: validate index shape before Number() so non-hex / negative
      // surfaces as -32602 instead of silently returning null (which
      // mimics "valid index, no such tx" — a real not-found).
      const txIndex = requireIndexParam(payload.params ?? [], 1, "transaction index")
      const block = await Promise.resolve(chain.getBlockByHash(blockHash))
      if (!block || txIndex >= block.txs.length) return null
      return formatRawTransaction(block.txs[txIndex], {
        blockHash: block.hash,
        blockNumber: block.number,
        transactionIndex: txIndex,
      })
    }
    case "eth_getTransactionByBlockNumberAndIndex": {
      const tag = (payload.params ?? [])[0]
      // #198: validate index shape — same rationale as the *byHash sibling.
      const txIdx = requireIndexParam(payload.params ?? [], 1, "transaction index")
      const height = await Promise.resolve(chain.getHeight())
      const num = parseBlockTag(tag, height)
      const block = await Promise.resolve(chain.getBlockByNumber(num))
      if (!block || txIdx >= block.txs.length) return null
      return formatRawTransaction(block.txs[txIdx], {
        blockHash: block.hash,
        blockNumber: block.number,
        transactionIndex: txIdx,
      })
    }
    case "eth_getUncleCountByBlockHash":
    case "eth_getUncleCountByBlockNumber":
    case "eth_getUncleByBlockHashAndIndex":
    case "eth_getUncleByBlockNumberAndIndex":
      // COC uses PoSe consensus with no uncle blocks
      return payload.method.includes("Count") ? "0x0" : null
    case "eth_getWork":
      // PoW stub — COC uses PoSe consensus, no mining
      return ["0x" + "0".repeat(64), "0x" + "0".repeat(64), "0x" + "0".repeat(64)]
    case "eth_submitWork":
    case "eth_submitHashrate":
      // PoW stub — always returns false (no mining support)
      return false
    case "eth_protocolVersion":
      return "0x41" // 65
    case "eth_feeHistory": {
      // #224: pre-fix `Number(params[0] ?? 1)` silently coerced null,
      // true, {}, "-0x5", etc. to either the default 1 (when `??` fired
      // on null/undefined) or to NaN → fallback 1. Spec mandates a hex
      // QUANTITY for blockCount; geth rejects everything else with
      // -32602. Same class as #188 (parseBlockTag) for the outer slot.
      const rawBlockCount = (payload.params ?? [])[0]
      let blockCount: number
      if (rawBlockCount === undefined || rawBlockCount === null) {
        blockCount = 1
      } else if (typeof rawBlockCount === "number") {
        if (!Number.isInteger(rawBlockCount) || rawBlockCount < 1) {
          throw { code: -32602, message: "invalid blockCount: must be positive integer" }
        }
        blockCount = Math.min(rawBlockCount, 1024)
      } else if (typeof rawBlockCount === "string") {
        if (!/^0x[0-9a-fA-F]+$/.test(rawBlockCount)) {
          throw { code: -32602, message: "invalid blockCount: must match /^0x[0-9a-fA-F]+$/" }
        }
        const n = Number(rawBlockCount)
        if (!Number.isFinite(n) || n < 1) {
          throw { code: -32602, message: "invalid blockCount: must be >= 1" }
        }
        blockCount = Math.min(Math.floor(n), 1024)
      } else {
        throw { code: -32602, message: "invalid blockCount: expected hex quantity or positive integer" }
      }
      const newestBlock = String((payload.params ?? [])[1] ?? "latest")
      // #224: `as number[]` was a TS runtime no-op so an object/string/
      // bool silently passed through (`{}.length === undefined`
      // bypassed the >100 check and the for-loop). Reject non-array
      // shapes upfront so spec-violating clients get told.
      const rawPercentiles = (payload.params ?? [])[2]
      if (rawPercentiles !== undefined && rawPercentiles !== null && !Array.isArray(rawPercentiles)) {
        throw { code: -32602, message: "invalid rewardPercentiles: expected array" }
      }
      const rewardPercentiles = (rawPercentiles ?? []) as number[]
      if (rewardPercentiles.length > 100) {
        throw { code: -32602, message: `rewardPercentiles array too large: ${rewardPercentiles.length} (max 100)` }
      }
      // #160: pre-fix percentiles outside [0,100], non-numeric, or
      // non-monotonic silently flowed into feeOracle.computeFeeHistoryRewards
      // and returned "0x0" rewards. Spec requires a monotonically increasing
      // list of values in [0,100]; geth rejects with explicit error. Match
      // that so buggy clients learn about their misuse instead of getting
      // misleading zero rewards.
      let prevPercentile = -Infinity
      for (let i = 0; i < rewardPercentiles.length; i++) {
        const p = rewardPercentiles[i]
        if (typeof p !== "number" || !Number.isFinite(p)) {
          throw { code: -32602, message: `rewardPercentile at index ${i} must be a finite number` }
        }
        if (p < 0 || p > 100) {
          throw { code: -32602, message: `rewardPercentile at index ${i} out of range: ${p} (must be in [0,100])` }
        }
        if (p < prevPercentile) {
          throw { code: -32602, message: `rewardPercentiles must be monotonically non-decreasing: index ${i} (${p}) < index ${i - 1} (${prevPercentile})` }
        }
        prevPercentile = p
      }
      const newest = await resolveBlockNumber(newestBlock, chain)
      const count = Math.min(blockCount, Number(newest), 1024)
      const baseFees: string[] = []
      const gasUsedRatios: number[] = []
      const rewards: string[][] = []
      const oldestBlockNum = newest - BigInt(count) + 1n
      for (let i = 0; i < count; i++) {
        const blockNum = oldestBlockNum + BigInt(i)
        const blockBaseFee = await computeBaseFeeForBlock(blockNum, chain)
        baseFees.push(`0x${blockBaseFee.toString(16)}`)
        const blk = await Promise.resolve(chain.getBlockByNumber(blockNum))
        const gasUsed = blk?.gasUsed ?? 0n
        const ratio = Number(gasUsed) / Number(BLOCK_GAS_LIMIT)
        gasUsedRatios.push(Math.round(ratio * 10000) / 10000)
        if (rewardPercentiles.length > 0) {
          rewards.push(feeOracle.computeFeeHistoryRewards(blk, blockBaseFee, rewardPercentiles))
        }
      }
      // Extra entry for next block's baseFee prediction
      const nextBaseFee = await computeBaseFeeForBlock(newest + 1n, chain)
      baseFees.push(`0x${nextBaseFee.toString(16)}`)
      return {
        oldestBlock: `0x${oldestBlockNum.toString(16)}`,
        baseFeePerGas: baseFees,
        gasUsedRatio: gasUsedRatios,
        ...(rewardPercentiles.length > 0 ? { reward: rewards } : {}),
      }
    }
    case "eth_newBlockFilter": {
      if (filters.size >= MAX_FILTERS) {
        cleanupExpiredFilters(filters)
        if (filters.size >= MAX_FILTERS) throw { code: -32005, message: "filter limit exceeded" }
      }
      const id = `0x${randomBytes(16).toString("hex")}`
      const height = await Promise.resolve(chain.getHeight())
      const filter: PendingFilter = {
        id,
        kind: "block",
        fromBlock: height,
        lastCursor: height,
        createdAtMs: Date.now(),
      }
      filters.set(id, filter)
      return id
    }
    case "eth_newPendingTransactionFilter": {
      if (filters.size >= MAX_FILTERS) {
        cleanupExpiredFilters(filters)
        if (filters.size >= MAX_FILTERS) throw { code: -32005, message: "filter limit exceeded" }
      }
      const id = `0x${randomBytes(16).toString("hex")}`
      // Pre-populate seenPendingTxs with everything already in the mempool
      // when the filter was created. eth_newPendingTransactionFilter's spec
      // is "new pending tx hashes since the filter was created" — pre-existing
      // mempool entries don't qualify.
      const seenPendingTxs = new Set<Hex>()
      for (const tx of chain.mempool.getAll()) seenPendingTxs.add(tx.hash)
      const filter: PendingFilter = {
        id,
        kind: "pendingTx",
        fromBlock: 0n,
        lastCursor: 0n,
        createdAtMs: Date.now(),
        seenPendingTxs,
      }
      filters.set(id, filter)
      return id
    }
    case "eth_getFilterLogs": {
      // #196: parity with eth_getFilterChanges / eth_uninstallFilter.
      const id = requireFilterId(payload.params ?? [], 0)
      const filter = filters.get(id)
      if (!filter) return []
      // Refresh last-access time so active polls keep the filter alive.
      filter.lastAccessedAtMs = Date.now()
      // getFilterLogs is a log-filter-only method: block and pendingTx
      // filters have no historical "logs" to return. Match the kubo/geth
      // behaviour of returning [] rather than confusing the caller with
      // garbage from an unintended code path.
      if (filter.kind && filter.kind !== "log") return []
      const height = await Promise.resolve(chain.getHeight())
      const end = filter.toBlock ?? height
      if (end - filter.fromBlock > MAX_LOG_BLOCK_RANGE) {
        throw { code: -32602, message: `block range too large: max ${MAX_LOG_BLOCK_RANGE} blocks` }
      }
      return collectLogs(chain, filter.fromBlock, end, filter)
    }
    case "eth_maxPriorityFeePerGas": {
      const tip = await feeOracle.computeMaxPriorityFeePerGas(chain)
      return `0x${tip.toString(16)}`
    }
    case "eth_blobBaseFee": {
      const blobHeight = await Promise.resolve(chain.getHeight())
      const blobTipBlock = blobHeight > 0n ? await Promise.resolve(chain.getBlockByNumber(blobHeight)) : null
      const tipExcessBlobGas = blobTipBlock?.excessBlobGas ?? 0n
      const blobPrice = computeBlobGasPrice(tipExcessBlobGas)
      return `0x${blobPrice.toString(16)}`
    }
    case "eth_mining":
      return false
    case "eth_hashrate":
      return "0x0"
    case "eth_coinbase": {
      const cbHeight = await Promise.resolve(chain.getHeight())
      const proposer = chain.expectedProposer(cbHeight + 1n)
      return proposer && proposer.startsWith("0x") && proposer.length === 42
        ? proposer
        : "0x0000000000000000000000000000000000000000"
    }
    case "eth_getCompilers":
      return ["solidity"]
    case "eth_compileSolidity": {
      const source = String((payload.params ?? [])[0] ?? "")
      if (source.trim().length === 0) {
        throw { code: -32602, message: "invalid Solidity source: expected non-empty source string" }
      }
      return await compileSoliditySource(source)
    }
    case "eth_compileLLL":
    case "eth_compileSerpent":
      // #132: -32601 method not found per JSON-RPC §5.1 (these were
      // deprecated in geth long ago; clients should treat as "doesn't
      // exist" rather than a generic internal failure).
      throw { code: -32601, message: `${payload.method} is not supported` }
    case "eth_getBlockReceipts": {
      // #114: per-receipt shape must match eth_getTransactionReceipt exactly.
      // Pre-fix this returned a custom subset missing contractAddress,
      // cumulativeGasUsed, effectiveGasPrice, logsBloom, and type — breaking
      // indexers that batch via this method.
      //
      // Strategy: walk block.txs, parse each to derive its hash, then route
      // through the same persistent / evm fallback as eth_getTransactionReceipt
      // so a single receipt formatter is used for both methods.
      const tag = String((payload.params ?? [])[0] ?? "latest")
      const num = await resolveBlockNumber(tag, chain)
      const block = await Promise.resolve(chain.getBlockByNumber(num))
      if (!block) return null
      const receipts: unknown[] = []
      for (const rawTx of block.txs) {
        try {
          const parsed = Transaction.from(rawTx)
          const hash = parsed.hash as Hex
          let receipt: unknown = null
          if (typeof chain.getTransactionByHash === "function") {
            const tx = await chain.getTransactionByHash(hash)
            if (tx?.receipt) receipt = await formatPersistentReceipt(tx, chain)
          }
          // Fallback to in-memory EVM receipt for chain engines without
          // a persistent tx index (matches eth_getTransactionReceipt fallback).
          if (!receipt) receipt = evm.getReceipt(hash)
          if (receipt) receipts.push(receipt)
        } catch { /* skip unparseable */ }
      }
      return receipts
    }
    case "txpool_status": {
      const stats = chain.mempool.stats()
      return {
        pending: `0x${stats.size.toString(16)}`,
        queued: "0x0",
      }
    }
    case "txpool_content": {
      const allTxs = chain.mempool.getAll()
      const pending: Record<string, Record<string, unknown>> = {}
      for (const mtx of allTxs) {
        const sender = mtx.from
        if (!pending[sender]) pending[sender] = {}
        const parsed = Transaction.from(mtx.rawTx)
        pending[sender][mtx.nonce.toString()] = {
          hash: mtx.hash,
          nonce: `0x${mtx.nonce.toString(16)}`,
          from: mtx.from,
          to: parsed.to ?? null,
          value: `0x${(parsed.value ?? 0n).toString(16)}`,
          gas: `0x${mtx.gasLimit.toString(16)}`,
          gasPrice: `0x${mtx.gasPrice.toString(16)}`,
          input: parsed.data ?? "0x",
        }
      }
      return { pending, queued: {} }
    }
    case "coc_getTransactionsByAddress": {
      // #120: validate address shape so typos surface as -32602 instead
      // of silently missing the index → empty result. Pre-fix, "not-an-address"
      // and "0x123" both returned [] indistinguishable from a real empty
      // address.
      const rawAddr = String((payload.params ?? [])[0] ?? "")
      if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
        throw { code: -32602, message: "invalid address: must match /^0x[0-9a-fA-F]{40}$/" }
      }
      const addr = rawAddr.toLowerCase() as Hex
      const rawLimit = Number((payload.params ?? [])[1] ?? 50)
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 10_000) : 50
      const reverse = (payload.params ?? [])[2] !== false
      const rawOffset = Number((payload.params ?? [])[3] ?? 0)
      const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(rawOffset, 0), 100_000) : 0

      if (typeof chain.getTransactionsByAddress === "function") {
        const txs = await chain.getTransactionsByAddress(addr, { limit, reverse, offset })
        return txs.map((tx) => ({
          hash: tx.receipt.transactionHash,
          from: tx.receipt.from,
          to: tx.receipt.to,
          blockNumber: `0x${tx.receipt.blockNumber.toString(16)}`,
          blockHash: tx.receipt.blockHash,
          gasUsed: `0x${tx.receipt.gasUsed.toString(16)}`,
          status: `0x${tx.receipt.status.toString(16)}`,
          input: tx.rawTx,
          logs: tx.receipt.logs,
        }))
      }
      return []
    }
    case "coc_dhtFindProviders": {
      // Phase C2.2: the PoSe challenger pre-filters monopoly CIDs by
      // asking the local DHT who currently advertises a given CID.
      // #146: pre-fix this returned errors wrapped in `result.error`,
      // which clients that check `response.error` per JSON-RPC §5
      // never noticed. Switch to -32602 structured throws + sanitize
      // CID shape against path traversal / control chars (same
      // isValidCid policy as the IPFS HTTP layer).
      const rawCid = (payload.params ?? [])[0]
      if (typeof rawCid !== "string" || rawCid.length === 0) {
        throw { code: -32602, message: "cid must be a non-empty string" }
      }
      if (rawCid.length > 512 || /[\/\\]|\.\.|\0|\s/.test(rawCid)) {
        throw { code: -32602, message: "invalid cid: contains illegal characters or exceeds 512 chars" }
      }
      const cid = rawCid
      const rawMaxK = Number((payload.params ?? [])[1] ?? 3)
      const cap = Number.isFinite(rawMaxK) && rawMaxK > 0 ? Math.min(Math.floor(rawMaxK), 64) : 3
      const findProviders = opts?.findProviders as ((cid: string, maxK: number) => string[]) | undefined
      const providers = findProviders?.(cid, cap) ?? []
      return { providers }
    }
    case "coc_ipfsFetchBlockFromPeer": {
      // Phase C2.4: audit sampling. Fetch the raw chunk bytes for `cid`
      // from a DHT-advertised peer, optionally excluding `excludePeerId`
      // (the prover). Returns base64-encoded bytes so JSON-RPC can
      // transport the blob.
      // #146: same fix as coc_dhtFindProviders — structured error in
      // the `error` field, not embedded in `result`.
      const rawCid = (payload.params ?? [])[0]
      if (typeof rawCid !== "string" || rawCid.length === 0) {
        throw { code: -32602, message: "cid must be a non-empty string" }
      }
      if (rawCid.length > 512 || /[\/\\]|\.\.|\0|\s/.test(rawCid)) {
        throw { code: -32602, message: "invalid cid: contains illegal characters or exceeds 512 chars" }
      }
      const cid = rawCid
      const excludePeerId = String((payload.params ?? [])[1] ?? "")
      const fetchBlockFromPeer = opts?.fetchBlockFromPeer as ((cid: string, exclude?: string) => Promise<Uint8Array | null>) | undefined
      const bytes = await fetchBlockFromPeer?.(cid, excludePeerId || undefined)
      return { bytes: bytes ? Buffer.from(bytes).toString("base64") : null }
    }
    case "coc_nodeInfo": {
      const height = await Promise.resolve(chain.getHeight())
      const mempoolStats = chain.mempool.stats()
      return {
        clientVersion: "COC/0.2",
        chainId,
        blockHeight: height,
        mempool: mempoolStats,
        uptime: Math.floor(process.uptime()),
      }
    }
    case "coc_validators": {
      const height = await Promise.resolve(chain.getHeight())
      const nextHeight = height + 1n
      const currentProposer = chain.expectedProposer(nextHeight)
      // Return validator info from the chain engine's round-robin
      const validators: unknown[] = []
      const seen = new Set<string>()
      // Sample expected proposers to discover all validators
      for (let h = nextHeight; h < nextHeight + 200n; h++) {
        const v = chain.expectedProposer(h)
        if (seen.has(v)) continue
        seen.add(v)
        validators.push({
          id: v,
          isCurrentProposer: v === currentProposer,
          nextProposalBlock: Number(h),
        })
      }
      return { validators, currentHeight: height, nextProposer: currentProposer }
    }
    case "coc_prunerStats": {
      if (typeof chain.getPrunerStats === "function") {
        return await chain.getPrunerStats()
      }
      return { latestBlock: 0, pruningHeight: 0, retainedBlocks: 0 }
    }
    case "coc_getPeers": {
      // #108: doc-referenced in docs/runbooks/phase-q-erasure-coding.md:204
      // ("peers should appear in `coc_getPeers` output"). Public (non-admin)
      // peer list — only exposes the per-peer { id, url } fields already
      // visible in P2P gossip traffic; no sensitive routing/auth state.
      const peers = p2p.getPeers?.() ?? p2p.discovery?.getActivePeers?.() ?? []
      return peers.map((peer: { id: string; url?: string; advertisedUrl?: string }) => ({
        id: peer.id,
        url: peer.advertisedUrl ?? peer.url ?? "unknown",
      }))
    }
    case "coc_getValidators": {
      if (hasGovernance(chain)) {
        const validators = chain.governance.getActiveValidators()
        return validators.map((v) => ({
          id: v.id,
          address: v.address,
          stake: `0x${v.stake.toString(16)}`,
          votingPower: v.votingPower,
          active: v.active,
          joinedAtEpoch: `0x${v.joinedAtEpoch.toString(16)}`,
        }))
      }
      // Fallback (no on-chain governance): expose the hardcoded validator
      // set as an array so the return type stays a collection, consistent
      // with the governance-enabled branch above. Pre-fix this returned a
      // single string (the next-block proposer), which contradicted the
      // method name and broke any client treating it as an array.
      const cfgValidators = hasConfig(chain) ? chain.cfg.validators : []
      return cfgValidators.map((v) => ({
        id: v,
        address: v,
        active: true,
      }))
    }
    case "coc_submitProposal": {
      if (!hasGovernance(chain)) throw new Error("governance not enabled")
      // #220: pre-fix `(payload.params ?? [])[0] as Record<string,string>`
      // was a no-op cast. With params=[] or params=[null] the first param
      // was undefined/null; the next line then accessed `.proposer` and
      // threw a V8 TypeError ("Cannot read properties of undefined/null
      // (reading 'proposer')") which leaked through the outer catch.
      const rawParams = (payload.params ?? [])[0]
      if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
        throw { code: -32602, message: "invalid params: expected non-null object as first param" }
      }
      const proposalParams = rawParams as Record<string, string>
      // Only the local node can submit proposals via RPC
      const localNodeId = (opts as Record<string, unknown>)?.nodeId as string | undefined
      if (localNodeId && proposalParams.proposer !== localNodeId) {
        throw { code: -32003, message: "unauthorized: can only submit proposals as local node" }
      }
      // #218: validate stakeAmount shape before `BigInt(...)`. Pre-fix
      // an object/array/non-digit-string flowed straight into BigInt
      // and threw a V8 SyntaxError ("Cannot convert [object Object] to
      // a BigInt"). Same leak class as #212 (pose-http) — currently
      // dead path because governance is disabled on prod, but fixing
      // now avoids the leak surfacing once R3.2 (88780) enables it.
      const stakeRaw = proposalParams.stakeAmount as unknown
      let stakeAmount: bigint | undefined
      if (stakeRaw !== undefined && stakeRaw !== null && stakeRaw !== "") {
        const ok =
          (typeof stakeRaw === "number" && Number.isInteger(stakeRaw) && stakeRaw >= 0) ||
          (typeof stakeRaw === "string" && /^([0-9]+|0x[0-9a-fA-F]+)$/.test(stakeRaw))
        if (!ok) {
          throw { code: -32602, message: "invalid stakeAmount: must be a non-negative integer or 0x-hex" }
        }
        stakeAmount = BigInt(stakeRaw as string | number)
      }
      const proposal = chain.governance.submitProposal(
        proposalParams.type,
        proposalParams.targetId,
        proposalParams.proposer,
        {
          targetAddress: proposalParams.targetAddress,
          stakeAmount,
        },
      )
      return {
        id: proposal.id,
        type: proposal.type,
        targetId: proposal.targetId,
        status: proposal.status,
      }
    }
    case "coc_voteProposal": {
      if (!hasGovernance(chain)) throw new Error("governance not enabled")
      // #220: same null-check as coc_submitProposal — params=[] / [null]
      // pre-fix bubbled "Cannot read properties of null (reading 'voterId')"
      // through the outer catch as a -32603 V8 leak.
      const voteRaw = (payload.params ?? [])[0]
      if (!voteRaw || typeof voteRaw !== "object" || Array.isArray(voteRaw)) {
        throw { code: -32602, message: "invalid params: expected non-null object as first param" }
      }
      const voteParams = voteRaw as Record<string, unknown>
      // Only the local node can vote via RPC
      const localVoterId = (opts as Record<string, unknown>)?.nodeId as string | undefined
      if (localVoterId && String(voteParams.voterId) !== localVoterId) {
        throw { code: -32003, message: "unauthorized: can only vote as local node" }
      }
      chain.governance.vote(
        String(voteParams.proposalId),
        String(voteParams.voterId),
        Boolean(voteParams.approve),
      )
      const updated = chain.governance.getProposal(String(voteParams.proposalId))
      return {
        id: updated?.id,
        status: updated?.status,
        votes: updated?.votes ? Object.fromEntries(updated.votes) : {},
      }
    }
    case "coc_getGovernanceStats": {
      if (!hasGovernance(chain)) {
        return { enabled: false }
      }
      const gStats = chain.governance.getGovernanceStats()
      return {
        enabled: true,
        activeValidators: gStats.activeValidators,
        totalStake: `0x${gStats.totalStake.toString(16)}`,
        pendingProposals: gStats.pendingProposals,
        totalProposals: gStats.totalProposals,
        currentEpoch: `0x${gStats.currentEpoch.toString(16)}`,
      }
    }
    case "coc_getProposals": {
      if (!hasGovernance(chain)) return []
      // #226: pre-fix `as string | undefined` was a runtime no-op so
      // bool/number/object/array silently slipped through and the
      // `validStatuses.includes(...)` always returned false → silent
      // "no filter applied, return all" path. Same class as #220 / #224.
      const rawStatusFilter = (payload.params ?? [])[0]
      if (rawStatusFilter !== undefined && rawStatusFilter !== null && typeof rawStatusFilter !== "string") {
        throw { code: -32602, message: "invalid status filter: expected string or omitted" }
      }
      const validStatuses = ["pending", "approved", "rejected", "expired"]
      if (typeof rawStatusFilter === "string" && rawStatusFilter !== "" && !validStatuses.includes(rawStatusFilter)) {
        throw { code: -32602, message: `invalid status filter: must be one of ${validStatuses.join(", ")}` }
      }
      const filter = typeof rawStatusFilter === "string" && rawStatusFilter !== "" ? rawStatusFilter as "pending" | "approved" | "rejected" | "expired" : undefined
      const proposals = chain.governance.getProposals(filter)
      return proposals.map((p) => ({
        id: p.id,
        type: p.type,
        targetId: p.targetId,
        targetAddress: p.targetAddress ?? null,
        stakeAmount: p.stakeAmount !== undefined ? `0x${p.stakeAmount.toString(16)}` : null,
        proposer: p.proposer,
        createdAtEpoch: `0x${p.createdAtEpoch.toString(16)}`,
        expiresAtEpoch: `0x${p.expiresAtEpoch.toString(16)}`,
        status: p.status,
        voteCount: p.votes.size,
      }))
    }
    case "coc_getDaoProposal": {
      if (!hasGovernance(chain)) throw new Error("governance not enabled")
      const proposalId = (payload.params ?? [])[0]
      if (typeof proposalId !== "string" || !proposalId) {
        throw { code: -32602, message: "invalid proposal id: expected non-empty string" }
      }
      const gov = chain.governance
      const proposal = gov.getProposal(proposalId)
      if (!proposal) throw { code: -32602, message: `proposal not found: ${proposalId}` }
      // Return full proposal with vote details
      const fullProposal = gov.getProposals?.()?.find((p: { id: string }) => p.id === proposalId)
      if (fullProposal) {
        return {
          id: fullProposal.id,
          type: fullProposal.type,
          targetId: fullProposal.targetId,
          targetAddress: fullProposal.targetAddress ?? null,
          stakeAmount: fullProposal.stakeAmount !== undefined ? `0x${fullProposal.stakeAmount.toString(16)}` : null,
          proposer: fullProposal.proposer,
          createdAtEpoch: `0x${fullProposal.createdAtEpoch.toString(16)}`,
          expiresAtEpoch: `0x${fullProposal.expiresAtEpoch.toString(16)}`,
          status: fullProposal.status,
          votes: Object.fromEntries(fullProposal.votes),
          voteCount: fullProposal.votes.size,
        }
      }
      return { id: proposal.id, status: proposal.status, votes: Object.fromEntries(proposal.votes) }
    }
    case "coc_getDaoProposals": {
      if (!hasGovernance(chain)) return []
      const gov2 = chain.governance
      if (!gov2.getProposals) return []
      // #226: pre-fix the `as` cast was a runtime no-op so booleans,
      // numbers, and arrays silently bypassed both string/object
      // branches → all filters undefined → silent "return all" path.
      const filterParam = (payload.params ?? [])[0]
      if (
        filterParam !== undefined &&
        filterParam !== null &&
        typeof filterParam !== "string" &&
        !(typeof filterParam === "object" && !Array.isArray(filterParam))
      ) {
        throw { code: -32602, message: "invalid filter: expected string or object" }
      }
      let statusFilter2: string | undefined
      let typeFilter: string | undefined
      let proposerFilter: string | undefined
      if (typeof filterParam === "string") {
        statusFilter2 = filterParam
      } else if (filterParam && typeof filterParam === "object") {
        const obj = filterParam as Record<string, unknown>
        if (obj.status !== undefined && typeof obj.status !== "string") {
          throw { code: -32602, message: "invalid filter.status: expected string" }
        }
        if (obj.type !== undefined && typeof obj.type !== "string") {
          throw { code: -32602, message: "invalid filter.type: expected string" }
        }
        if (obj.proposer !== undefined && typeof obj.proposer !== "string") {
          throw { code: -32602, message: "invalid filter.proposer: expected string" }
        }
        statusFilter2 = obj.status as string | undefined
        typeFilter = obj.type as string | undefined
        proposerFilter = obj.proposer as string | undefined
      }
      const validStatuses2 = ["pending", "approved", "rejected", "expired"]
      if (statusFilter2 && !validStatuses2.includes(statusFilter2)) {
        throw { code: -32602, message: `invalid status filter: must be one of ${validStatuses2.join(", ")}` }
      }
      const sFilter = statusFilter2 && validStatuses2.includes(statusFilter2) ? statusFilter2 : undefined
      let results = gov2.getProposals(sFilter)
      if (typeFilter) results = results.filter((p: { type: string }) => p.type === typeFilter)
      if (proposerFilter) results = results.filter((p: { proposer: string }) => p.proposer === proposerFilter)
      return results.map((p) => ({
        id: p.id,
        type: p.type,
        targetId: p.targetId,
        targetAddress: p.targetAddress ?? null,
        stakeAmount: p.stakeAmount !== undefined ? `0x${p.stakeAmount.toString(16)}` : null,
        proposer: p.proposer,
        createdAtEpoch: `0x${p.createdAtEpoch.toString(16)}`,
        expiresAtEpoch: `0x${p.expiresAtEpoch.toString(16)}`,
        status: p.status,
        voteCount: p.votes.size,
      }))
    }
    case "coc_getDaoStats": {
      if (!hasGovernance(chain)) return { enabled: false }
      const gov3 = chain.governance
      const stats = gov3.getGovernanceStats?.() ?? { activeValidators: 0, totalStake: 0n, pendingProposals: 0, totalProposals: 0, currentEpoch: 0n }
      const factionStats = gov3.getFactionStats?.() ?? {}
      const treasury = gov3.getTreasuryBalance?.() ?? 0n
      return {
        enabled: true,
        activeValidators: stats.activeValidators,
        totalStake: `0x${stats.totalStake.toString(16)}`,
        pendingProposals: stats.pendingProposals,
        totalProposals: stats.totalProposals,
        currentEpoch: `0x${stats.currentEpoch.toString(16)}`,
        treasuryBalance: `0x${treasury.toString(16)}`,
        factions: factionStats,
      }
    }
    case "coc_getTreasuryBalance": {
      if (!hasGovernance(chain)) return { balance: "0x0" }
      const treasury2 = chain.governance.getTreasuryBalance?.() ?? 0n
      return { balance: `0x${treasury2.toString(16)}` }
    }
    case "coc_getFaction": {
      if (!hasGovernance(chain)) return null
      const address = (payload.params ?? [])[0]
      if (typeof address !== "string" || !address.startsWith("0x")) {
        throw { code: -32602, message: "invalid address: expected hex string" }
      }
      const factionInfo = chain.governance.getFaction?.(address)
      if (!factionInfo) return null
      return {
        address: factionInfo.address,
        faction: factionInfo.faction,
        joinedAtEpoch: `0x${factionInfo.joinedAtEpoch.toString(16)}`,
      }
    }
    case "coc_getBftStatus": {
      if (!bftCoordinator) {
        return { enabled: false, active: false }
      }
      const bftState = bftCoordinator.getRoundState()
      return {
        enabled: true,
        active: bftState.active,
        height: bftState.height ? `0x${bftState.height.toString(16)}` : null,
        phase: bftState.phase,
        prepareVotes: bftState.prepareVotes,
        commitVotes: bftState.commitVotes,
        equivocations: bftState.equivocations,
      }
    }
    case "coc_getNetworkStats": {
      const peerCount = p2p?.getPeers?.()?.length ?? 0
      const height = await Promise.resolve(chain.getHeight())
      const p2pStats = (opts as Record<string, unknown>)?.p2pStats
        ?? p2p?.getStats?.()

      // BFT status
      const bft = bftCoordinator
        ? { enabled: true, ...bftCoordinator.getRoundState() }
        : { enabled: false }

      const wireStats = (opts as Record<string, unknown>)?.wireStats ?? null

      const dhtStats = (opts as Record<string, unknown>)?.dhtStats ?? null

      return {
        blockHeight: `0x${height.toString(16)}`,
        peerCount,
        p2p: {
          peers: peerCount,
          protocol: "http-gossip",
          security: p2pStats ? {
            rateLimitedRequests: Number((p2pStats as Record<string, unknown>).rateLimitedRequests ?? 0),
            authAcceptedRequests: Number((p2pStats as Record<string, unknown>).authAcceptedRequests ?? 0),
            authMissingRequests: Number((p2pStats as Record<string, unknown>).authMissingRequests ?? 0),
            authInvalidRequests: Number((p2pStats as Record<string, unknown>).authInvalidRequests ?? 0),
            authRejectedRequests: Number((p2pStats as Record<string, unknown>).authRejectedRequests ?? 0),
            authNonceTrackerSize: Number((p2pStats as Record<string, unknown>).authNonceTrackerSize ?? 0),
            inboundAuthMode: String((p2pStats as Record<string, unknown>).inboundAuthMode ?? "off"),
            discoveryPendingPeers: Number((p2pStats as Record<string, unknown>).discoveryPendingPeers ?? 0),
            discoveryIdentityFailures: Number((p2pStats as Record<string, unknown>).discoveryIdentityFailures ?? 0),
          } : undefined,
        },
        wire: wireStats ? { enabled: true, ...wireStats } : { enabled: false },
        dht: dhtStats ? { enabled: true, ...dhtStats } : { enabled: false },
        bft,
        consensus: {
          state: "active",
        },
      }
    }
    case "coc_getRewardManifest": {
      const rewardManifestDir = typeof opts?.rewardManifestDir === "string" ? opts.rewardManifestDir : ""
      if (!rewardManifestDir) return null
      const epochId = Number((payload.params ?? [])[0] ?? -1)
      if (!Number.isInteger(epochId) || epochId < 0) {
        throw { code: -32602, message: "invalid epochId" }
      }
      const manifest = readBestRewardManifest(rewardManifestDir, epochId)
      if (!manifest) return null
      return {
        epochId: manifest.epochId,
        rewardRoot: manifest.rewardRoot,
        totalReward: manifest.totalReward,
        sourceNodeCount: manifest.sourceNodeCount ?? manifest.leaves.length,
        scoredNodeCount: manifest.scoredNodeCount ?? manifest.leaves.length,
        missingNodeIds: manifest.missingNodeIds ?? [],
        settled: manifest.settled === true,
        settledAtMs: manifest.settledAtMs ?? null,
        leaves: manifest.leaves.length,
      }
    }
    case "coc_getRewardClaim": {
      const rewardManifestDir = typeof opts?.rewardManifestDir === "string" ? opts.rewardManifestDir : ""
      if (!rewardManifestDir) return null
      const epochId = Number((payload.params ?? [])[0] ?? -1)
      const nodeId = String((payload.params ?? [])[1] ?? "")
      if (!Number.isInteger(epochId) || epochId < 0) {
        throw { code: -32602, message: "invalid epochId" }
      }
      if (!/^0x[0-9a-fA-F]+$/.test(nodeId)) {
        throw { code: -32602, message: "invalid nodeId" }
      }
      const manifest = readBestRewardManifest(rewardManifestDir, epochId)
      if (!manifest) return null
      return lookupRewardClaim(manifest, nodeId)
    }
    case "coc_chainStats": {
      const height = await Promise.resolve(chain.getHeight())
      const now = Date.now()
      if (chainStatsCache && chainStatsCache.height === height && now - chainStatsCache.cachedAtMs < CHAIN_STATS_CACHE_TTL_MS) {
        return chainStatsCache.result
      }
      // Thundering herd protection: coalesce concurrent requests
      if (chainStatsComputing) return await chainStatsComputing
      chainStatsComputing = (async () => {
        const latest = await Promise.resolve(chain.getBlockByNumber(height))
        const poolStats = chain.mempool.stats()
        const validators = hasConfig(chain) ? chain.cfg.validators : []

        // Calculate blocks per minute from last 10 blocks
        let blocksPerMin = 0
        if (height > 1n) {
          const lookback = height > 10n ? 10n : height
          const oldBlock = await Promise.resolve(chain.getBlockByNumber(height - lookback + 1n))
          if (oldBlock && latest) {
            const elapsed = (latest.timestampMs - oldBlock.timestampMs) / 1000
            blocksPerMin = elapsed > 0 ? Number(lookback) / elapsed * 60 : 0
          }
        }

        // Count total txs from last 100 blocks (parallel fetch)
        const scanFrom = height > 100n ? height - 99n : 1n
        const blockFetches: Promise<unknown>[] = []
        for (let i = scanFrom; i <= height; i++) {
          blockFetches.push(Promise.resolve(chain.getBlockByNumber(i)))
        }
        const scannedBlocks = await Promise.all(blockFetches) as Array<{ txs: unknown[] } | null>
        let recentTxCount = 0
        for (const b of scannedBlocks) {
          if (b) recentTxCount += b.txs.length
        }

        const statsResult = {
          blockHeight: `0x${height.toString(16)}`,
          latestBlockTime: latest?.timestampMs ?? 0,
          blocksPerMinute: Math.round(blocksPerMin * 100) / 100,
          pendingTxCount: poolStats.size,
          recentTxCount,
          validatorCount: validators.length,
          // #184: pre-fix the inner ternary assumed chain.cfg.chainId
          // was defined whenever hasConfig() returned true. But
          // ChainEngineConfig.chainId is optional in the type — the
          // constructor only defaults it for the mempool, not for cfg
          // itself. Bare `undefined.toString(16)` leaked to clients
          // as -32603 "Cannot read properties of undefined".
          chainId: `0x${chain.cfg?.chainId?.toString(16) ?? "1"}`,
        }
        chainStatsCache = { result: statsResult, height, cachedAtMs: now }
        return statsResult
      })().finally(() => { chainStatsComputing = null })
      return await chainStatsComputing
    }
    case "coc_getContracts": {
      if (hasBlockIndex(chain)) {
        const opts = (payload.params ?? [])[0] as Record<string, unknown> | undefined
        const contracts = await chain.blockIndex.getContracts({
          limit: Math.min(Math.max(Number(opts?.limit ?? 50) || 50, 1), 10_000),
          offset: Math.min(Math.max(Number(opts?.offset ?? 0) || 0, 0), 100_000),
          reverse: opts?.reverse !== false,
        })
        return contracts.map((c) => ({
          address: c.address,
          blockNumber: `0x${c.blockNumber.toString(16)}`,
          txHash: c.txHash,
          creator: c.creator,
          deployedAt: c.deployedAt,
        }))
      }
      return []
    }
    case "coc_blockIndexStatus": {
      // Exposes whether the node maintains a block index so clients can distinguish
      // "index empty" from "index not enabled" — avoids Explorer falling back to
      // slow serial block-scan on nodes that will never return data anyway.
      return { enabled: hasBlockIndex(chain) }
    }
    case "coc_getContractInfo": {
      // #122: stricter validation so typos return -32602 instead of
      // silently null (indistinguishable from "this address has no
      // deployed contract"). Mirrors the #120 fix for getTransactionsByAddress.
      const addr = requireAddressParam(payload.params ?? [], 0)
      if (hasBlockIndex(chain)) {
        const info = await chain.blockIndex.getContractInfo(addr as Hex)
        if (!info) return null
        return {
          address: info.address,
          blockNumber: `0x${info.blockNumber.toString(16)}`,
          txHash: info.txHash,
          creator: info.creator,
          deployedAt: info.deployedAt,
        }
      }
      return null
    }
    case "coc_erasureStatus": {
      // RPC bridge for the existing HTTP /api/v0/erasure/status handler.
      // Doc-referenced for ops tooling (phase-q-erasure-coding.md:233);
      // returns per-stripe data/parity availability for a Reed-Solomon
      // manifest CID. The runtime hook is wired from index.ts using
      // resolveCid + erasureStatus.
      const getter = (opts as RpcRuntimeOptions | undefined)?.getErasureStatus
      if (!getter) throw { code: -32601, message: "erasure status not available on this node" }
      const cid = String((payload.params ?? [])[0] ?? "")
      if (!cid) throw { code: -32602, message: "missing manifest CID" }
      return getter(cid)
    }
    case "coc_getEquivocationsTotal": {
      // Cheap counter for ops monitoring. The operator runbook
      // (docs/operator-runbook.{en,zh}.md section 5) instructs operators
      // to alert when this rises above zero, so the method must exist as
      // a first-class endpoint instead of forcing callers to fetch the
      // full evidence array via coc_getEquivocations and count it.
      const totalGetter = (opts as RpcRuntimeOptions | undefined)?.getBftEquivocations
      if (!totalGetter) return 0
      return totalGetter(0).length
    }
    case "coc_getEquivocations": {
      // #226: pre-fix `Number(params[0] ?? 0)` silently mapped {}, true,
      // non-numeric strings, NaN → 0 or NaN, and accepted negative
      // sinceMs that the getter treats as "from epoch start." Validate
      // upfront as non-negative finite integer.
      const rawSince = (payload.params ?? [])[0]
      let sinceMs = 0
      if (rawSince !== undefined && rawSince !== null) {
        if (typeof rawSince !== "number" || !Number.isFinite(rawSince) || !Number.isInteger(rawSince) || rawSince < 0) {
          throw { code: -32602, message: "invalid sinceMs: expected non-negative integer or omitted" }
        }
        sinceMs = rawSince
      }
      const getter = (opts as RpcRuntimeOptions | undefined)?.getBftEquivocations
      if (!getter) return []
      const evidence = getter(sinceMs)
      return evidence.map((e) => {
        const raw = (e.rawEvidence ?? {}) as Record<string, unknown>
        const round = raw.round
        return {
          validatorId: raw.validatorId ?? raw.nodeId ?? "",
          height: raw.height ?? "0",
          ...(typeof round === "number" && Number.isFinite(round) ? { round } : {}),
          vote1Hash: raw.blockHash1 ?? "",
          vote2Hash: raw.blockHash2 ?? "",
          timestamp: raw.detectedAtMs ?? 0,
          phase: raw.phase ?? "",
          type: raw.type ?? "bft-equivocation",
        }
      })
    }
    // --- Admin RPC namespace ---
    case "admin_nodeInfo": {
      if (!(opts as Record<string, unknown>)?.enableAdminRpc) {
        throw { code: -32601, message: "admin methods disabled (set enableAdminRpc=true)" }
      }
      const height = await Promise.resolve(chain.getHeight())
      const mempoolStats = chain.mempool.stats()
      return {
        nodeId: (opts as Record<string, unknown>)?.nodeId ?? "unknown",
        enode: `coc://${(opts as Record<string, unknown>)?.nodeId ?? "unknown"}@0.0.0.0:0`,
        clientVersion: "COC/0.2",
        chainId,
        blockHeight: `0x${height.toString(16)}`,
        peerCount: p2p?.getPeers?.()?.length ?? 0,
        mempool: mempoolStats,
        uptime: Math.floor(process.uptime()),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        p2pStats: (opts as Record<string, unknown>)?.p2pStats ?? null,
        wireStats: (opts as Record<string, unknown>)?.wireStats ?? null,
        dhtStats: (opts as Record<string, unknown>)?.dhtStats ?? null,
      }
    }
    case "admin_addPeer": {
      if (!(opts as Record<string, unknown>)?.enableAdminRpc) {
        throw { code: -32601, message: "admin methods disabled" }
      }
      const peerUrl = String((payload.params ?? [])[0] ?? "")
      const peerId = String((payload.params ?? [])[1] ?? `peer-${Date.now()}`)
      try { new URL(peerUrl) } catch {
        throw { code: -32602, message: "invalid peer URL" }
      }
      if (!/^[a-zA-Z0-9\-_.:]+$/.test(peerId)) {
        throw { code: -32602, message: "invalid peer ID: only alphanumeric, hyphens, underscores, dots, colons allowed" }
      }
      p2p.discovery.addDiscoveredPeers([{ id: peerId, url: peerUrl }])
      return true
    }
    case "admin_removePeer": {
      if (!(opts as Record<string, unknown>)?.enableAdminRpc) {
        throw { code: -32601, message: "admin methods disabled" }
      }
      const removePeerId = String((payload.params ?? [])[0] ?? "")
      if (!removePeerId) {
        throw { code: -32602, message: "peer id required" }
      }
      p2p.discovery.removePeer(removePeerId)
      return true
    }
    case "admin_peers": {
      if (!(opts as Record<string, unknown>)?.enableAdminRpc) {
        throw { code: -32601, message: "admin methods disabled" }
      }
      const peers = p2p.getPeers?.() ?? p2p.discovery.getActivePeers()
      return peers.map((peer: { id: string; url?: string }) => ({
        id: peer.id,
        url: peer.url ?? "unknown",
      }))
    }
    /**
     * PR-1K (2026-05-11): admin_pruneStalePhantoms — scan leveldb for blocks
     * with invalid proposers or stored above the current tip, and delete
     * them. Use this to clean up phantom block residue left behind by
     * failed validator-set transitions (e.g. the 2026-05-10 N=5 attempt that
     * left 0x0ba51e... proposer at h=71359 on server-1).
     */
    case "admin_pruneStalePhantoms": {
      if (!(opts as Record<string, unknown>)?.enableAdminRpc) {
        throw { code: -32601, message: "admin methods disabled" }
      }
      const persistentChain = chain as unknown as { pruneStalePhantoms?: () => Promise<{
        scanned: number
        prunedAboveTip: number
        prunedInvalidProposer: number
        tipHeight: bigint | null
        activeValidators: string[]
      }> }
      if (typeof persistentChain.pruneStalePhantoms !== "function") {
        throw { code: -32601, message: "engine does not support phantom pruning" }
      }
      const result = await persistentChain.pruneStalePhantoms()
      return {
        scanned: result.scanned,
        prunedAboveTip: result.prunedAboveTip,
        prunedInvalidProposer: result.prunedInvalidProposer,
        tipHeight: result.tipHeight !== null ? `0x${result.tipHeight.toString(16)}` : null,
        activeValidators: result.activeValidators,
      }
    }
    // --- Rollup RPC namespace ---
    case "rollup_getOutputAtBlock": {
      // #228: pre-fix this referenced bare `params[0]` instead of
      // `payload.params[0]`. Since `params` is not a defined variable
      // in scope, every call threw `ReferenceError: params is not
      // defined` BEFORE any handler logic ran. The rollup endpoint
      // was completely broken from inception and the V8 wording
      // leaked through the outer catch as -32603. No test caught it.
      const blockNumber = parseBlockTag(
        (payload.params ?? [])[0],
        await Promise.resolve(chain.getHeight()),
      )
      const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
      if (!block || !block.stateRoot) return null
      const { solidityPackedKeccak256 } = await import("ethers")
      const outputRoot = solidityPackedKeccak256(
        ["uint64", "bytes32", "bytes32"],
        [block.number, block.stateRoot, block.hash],
      )
      return {
        l2BlockNumber: `0x${block.number.toString(16)}`,
        outputRoot,
        stateRoot: block.stateRoot,
        blockHash: block.hash,
        timestamp: `0x${Math.floor(block.timestampMs / 1000).toString(16)}`,
      }
    }
    case "rollup_getSequencerMode": {
      const nodeMode = (opts as Record<string, unknown>)?.nodeMode ?? "full"
      return {
        sequencerMode: nodeMode === "sequencer",
        nodeMode,
      }
    }
    // ── DID Identity Layer ──────────────────────────────────────
    case "coc_resolveDid": {
      const didResolver = opts?.didResolver as { resolve: (did: string) => Promise<{ didDocument: unknown; didResolutionMetadata: unknown }> } | undefined
      if (!didResolver) throw { code: -32601, message: "DID resolver not configured on this node (requires soulRegistryAddress + didRegistryAddress)" }
      const did = String((payload.params ?? [])[0] ?? "")
      if (!did) throw { code: -32602, message: "missing DID parameter" }
      return didResolver.resolve(did)
    }
    case "coc_getDIDDocument": {
      const didResolver = opts?.didResolver as { resolve: (did: string) => Promise<{ didDocument: unknown }> } | undefined
      if (!didResolver) throw { code: -32601, message: "DID resolver not configured on this node" }
      const agentId = String((payload.params ?? [])[0] ?? "")
      if (!agentId) throw { code: -32602, message: "missing agentId parameter" }
      const result = await didResolver.resolve(`did:coc:${agentId}`)
      return result.didDocument ?? null
    }
    case "coc_getAgentCapabilities": {
      const didProvider = opts?.didDataProvider
      if (!didProvider) throw { code: -32601, message: "DID data provider not configured on this node" }
      const agentId = String((payload.params ?? [])[0] ?? "")
      if (!agentId) throw { code: -32602, message: "missing agentId parameter" }
      const bitmask = await didProvider.getCapabilities(agentId)
      // Import inline to avoid top-level dependency
      const { capabilityBitmaskToNames } = await import("./did/did-types.ts")
      return { capabilities: capabilityBitmaskToNames(bitmask), bitmask }
    }
    case "coc_getDelegations": {
      const didProvider = opts?.didDataProvider
      if (!didProvider) throw { code: -32601, message: "DID data provider not configured on this node" }
      const agentId = String((payload.params ?? [])[0] ?? "")
      if (!agentId) throw { code: -32602, message: "missing agentId parameter" }
      return didProvider.getFullDelegations(agentId)
    }
    case "coc_getAgentLineage": {
      const didProvider = opts?.didDataProvider
      if (!didProvider?.getLineage) throw { code: -32601, message: "DID data provider not configured on this node" }
      const agentId = String((payload.params ?? [])[0] ?? "")
      if (!agentId) throw { code: -32602, message: "missing agentId parameter" }
      return didProvider.getLineage(agentId)
    }
    case "coc_getVerificationMethods": {
      const didProvider = opts?.didDataProvider
      if (!didProvider?.getVerificationMethods) throw { code: -32601, message: "DID data provider not configured on this node" }
      const agentId = String((payload.params ?? [])[0] ?? "")
      if (!agentId) throw { code: -32602, message: "missing agentId parameter" }
      return didProvider.getVerificationMethods(agentId)
    }
    case "coc_getCredentialAnchor": {
      // Checks the on-chain credential anchor only: existence, revocation, expiry.
      // Does NOT verify VC content, signatures, or proofs — use verifiable-credentials.ts
      // for full credential verification.
      const didProvider = opts?.didDataProvider
      if (!didProvider?.getCredentialAnchor) throw { code: -32601, message: "DID data provider not configured on this node" }
      const credentialId = String((payload.params ?? [])[0] ?? "")
      if (!credentialId) throw { code: -32602, message: "missing credentialId parameter" }
      return didProvider.getCredentialAnchor(credentialId)
    }
    default:
      // #132: -32601 method not found per JSON-RPC §5.1. Pre-fix this
      // surfaced as -32603 internal-error, which made unknown-method
      // probes look like server-side faults to monitoring tools.
      throw { code: -32601, message: `method not supported: ${payload.method}` }
  }
}

function safeBigInt(input: string): bigint {
  // Reject oversized inputs to prevent BigInt parsing DoS (O(n²) for huge decimal strings)
  if (typeof input !== "string" || input.length > 78) {
    throw { code: -32602, message: "invalid block number: input too large" }
  }
  try {
    return BigInt(input)
  } catch {
    throw { code: -32602, message: `invalid block number: ${input.slice(0, 40)}` }
  }
}

function parseBlockTag(input: unknown, fallback: bigint, finalizedHeight?: bigint): bigint {
  // #194: omitting the param (undefined / null) is the canonical
  // "latest" shorthand and stays a silent fallback. Every other
  // non-string, non-number shape (array, object, bool) used to fall
  // through to the same fallback, which silently mapped malformed
  // input to latest — sibling bug to #188.
  if (input === undefined || input === null) return fallback
  if (typeof input === "number") {
    // #188: pre-fix `BigInt(Math.floor(input))` silently truncated
    // fractional values (1.5 → 1). On a real chain the user would
    // get block 1's data without realizing their input was wrong.
    if (!Number.isFinite(input) || input < 0 || !Number.isInteger(input)) {
      throw { code: -32602, message: `invalid block number: ${input}` }
    }
    return BigInt(input)
  }
  if (typeof input === "string") {
    if (input === "latest" || input === "pending") return fallback
    if (input === "safe" || input === "finalized") return finalizedHeight ?? fallback
    if (input === "earliest") return 0n
    const n = safeBigInt(input)
    if (n < 0n) throw { code: -32602, message: `invalid block number: ${input}` }
    return n
  }
  throw { code: -32602, message: "invalid block tag: must be hex quantity or named tag" }
}

async function resolveBlockNumber(input: unknown, chain: IChainEngine): Promise<bigint> {
  const height = await Promise.resolve(chain.getHeight())
  if (typeof input === "string" && (input === "safe" || input === "finalized")) {
    return Promise.resolve(chain.getHighestFinalizedBlock())
  }
  return parseBlockTag(input, height)
}

async function resolveHistoricalStateRoot(input: unknown, chain: IChainEngine): Promise<string | undefined> {
  return (await resolveHistoricalExecutionContext(input, chain)).stateRoot
}

async function resolveHistoricalExecutionContext(
  input: unknown,
  chain: IChainEngine,
): Promise<{ stateRoot?: string } & ExecutionContext> {
  if (
    input === undefined ||
    input === null ||
    input === "latest" ||
    input === "pending"
  ) {
    const height = await Promise.resolve(chain.getHeight())
    const block = await Promise.resolve(chain.getBlockByNumber(height))
    return {
      blockNumber: height,
      ...buildExecutionContextFromBlock(block),
    }
  }
  if (input === "safe" || input === "finalized") {
    const finalized = await Promise.resolve(chain.getHighestFinalizedBlock())
    const block = await Promise.resolve(chain.getBlockByNumber(finalized))
    return {
      stateRoot: block?.stateRoot,
      blockNumber: finalized,
      ...buildExecutionContextFromBlock(block),
    }
  }

  if (typeof input === "object" && input !== null && "blockHash" in input) {
    const blockHash = String((input as Record<string, unknown>).blockHash ?? "") as Hex
    const block = await Promise.resolve(chain.getBlockByHash(blockHash))
    if (!block) {
      throw { code: -32001, message: `block not found: ${blockHash}` }
    }
    if (!block.stateRoot) {
      throw { code: -32001, message: `state root unavailable for block ${blockHash}` }
    }
    return {
      stateRoot: block.stateRoot,
      blockNumber: block.number,
      ...buildExecutionContextFromBlock(block),
    }
  }

  const height = await Promise.resolve(chain.getHeight())
  const blockNumber = parseBlockTag(input, height)
  const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
  if (!block) {
    throw { code: -32001, message: `block not found: ${String(input)}` }
  }
  if (!block.stateRoot) {
    throw { code: -32001, message: `state root unavailable for block ${blockNumber}` }
  }
  return {
    stateRoot: block.stateRoot,
    blockNumber,
    ...buildExecutionContextFromBlock(block),
  }
}

function buildExecutionContextFromBlock(block: { timestampMs: number; baseFee?: bigint; excessBlobGas?: bigint; parentBeaconBlockRoot?: Hex } | null | undefined): ExecutionContext {
  if (!block) {
    return {}
  }
  return {
    timestamp: BigInt(Math.floor(block.timestampMs / 1000)),
    baseFeePerGas: block.baseFee ?? 0n,
    excessBlobGas: block.excessBlobGas,
    parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
  }
}

type ReplayTraceType = "trace" | "vmTrace" | "stateDiff"

function formatDebugTraceResult(
  result:
    | Pick<CallTraceResult, "callTraces" | "trace" | "prestate" | "poststate">
    | Pick<TxTraceResult, "callTraces" | "trace" | "prestate" | "poststate">,
  traceOpts: Record<string, unknown>,
): unknown {
  const tracer = traceOpts.tracer ? String(traceOpts.tracer) : undefined
  if (!tracer) {
    return result.trace
  }
  if (tracer === "callTracer") {
    return formatGethCallTracer(result.callTraces, (traceOpts.tracerConfig ?? {}) as Record<string, unknown>)
  }
  if (tracer === "prestateTracer") {
    return formatGethPrestateTracer(
      result.prestate ?? {},
      result.poststate ?? {},
      (traceOpts.tracerConfig ?? {}) as Record<string, unknown>,
    )
  }
  throw { code: -32602, message: `unsupported tracer: ${tracer}` }
}

function normalizeReplayTraceTypes(input: unknown): ReplayTraceType[] {
  if (input === undefined || input === null) return ["trace"]
  if (!Array.isArray(input) || input.length === 0) return ["trace"]
  const normalized: ReplayTraceType[] = []
  for (const rawType of input) {
    if (rawType !== "trace" && rawType !== "vmTrace" && rawType !== "stateDiff") {
      throw { code: -32602, message: `invalid trace type: ${String(rawType)}` }
    }
    normalized.push(rawType)
  }
  return normalized
}

function normalizeTraceCallManyRequests(input: unknown): Array<{
  call: { from?: string; to: string; data?: string; value?: string; gas?: string }
  traceTypes: ReplayTraceType[]
}> {
  if (!Array.isArray(input)) {
    throw { code: -32602, message: "invalid trace_callMany payload: expected array" }
  }
  return input.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw { code: -32602, message: `invalid trace_callMany entry at index ${index}` }
    }
    const [call, traceTypes] = entry
    const callParams = (call ?? {}) as Record<string, string>
    if (typeof callParams !== "object" || callParams === null) {
      throw { code: -32602, message: `invalid trace_callMany call at index ${index}` }
    }
    return {
      call: {
        from: callParams.from,
        to: callParams.to ?? "",
        data: callParams.data,
        value: callParams.value,
        gas: callParams.gas,
      },
      traceTypes: normalizeReplayTraceTypes(traceTypes),
    }
  })
}

function formatTraceReplayResult(
  result: Pick<CallTraceResult, "returnValue" | "callTraces" | "trace" | "stateDiff" | "poststate"> | Pick<TxTraceResult, "returnValue" | "callTraces" | "trace" | "stateDiff" | "poststate">,
  traceTypes: ReplayTraceType[],
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    output: result.returnValue,
  }
  if (traceTypes.includes("trace")) {
    response.trace = formatOpenEthereumCallTraces(result.callTraces)
  }
  if (traceTypes.includes("vmTrace")) {
    response.vmTrace = formatVmTrace(result.trace, result.callTraces, result.poststate)
  }
  if (traceTypes.includes("stateDiff")) {
    response.stateDiff = result.stateDiff ?? {}
  }
  return response
}

function formatOpenEthereumCallTraces(callTraces: CallTrace[]): unknown[] {
  return callTraces.map((callTrace) => {
    const traceAddress = callTrace.traceAddress ?? []
    const subtraces = callTrace.subtraces ?? 0
    const type = callTrace.type.toLowerCase()

    if (type === "create") {
      const createTrace: Record<string, unknown> = {
        action: {
          from: callTrace.from,
          gas: callTrace.gas,
          init: callTrace.input,
          value: callTrace.value,
        },
        subtraces,
        traceAddress,
        type: "create",
      }
      if (callTrace.error) {
        createTrace.error = callTrace.error
      } else {
        createTrace.result = {
          address: callTrace.to,
          code: callTrace.output,
          gasUsed: callTrace.gasUsed,
        }
      }
      return createTrace
    }

    const callEntry: Record<string, unknown> = {
      action: {
        callType: type,
        from: callTrace.from,
        to: callTrace.to,
        gas: callTrace.gas,
        input: callTrace.input,
        value: callTrace.value,
      },
      subtraces,
      traceAddress,
      type: "call",
    }
    if (callTrace.error) {
      callEntry.error = callTrace.error
    } else {
      callEntry.result = {
        gasUsed: callTrace.gasUsed,
        output: callTrace.output,
      }
    }
    return callEntry
  })
}

function formatLocalizedOpenEthereumCallTraces(
  callTraces: CallTrace[],
  context: { blockHash: string; blockNumber: bigint; transactionHash: string; transactionPosition: number },
): unknown[] {
  return formatOpenEthereumCallTraces(callTraces).map((trace) => ({
    ...trace as Record<string, unknown>,
    blockHash: context.blockHash,
    blockNumber: toRpcQuantity(context.blockNumber),
    transactionHash: context.transactionHash,
    transactionPosition: toRpcQuantity(context.transactionPosition),
  }))
}

function formatVmTrace(
  trace: { structLogs: Array<{ pc: number; op: string; gas: string; gasCost: string; depth?: number; memory: string[]; stack: string[]; storage: Record<string, string> }> },
  callTraces: CallTrace[],
  poststate?: Record<string, unknown>,
): Record<string, unknown> {
  if (trace.structLogs.length === 0) {
    return { code: resolveVmTraceCode(callTraces[0], poststate), ops: [] }
  }

  const sortedCallTraces = [...callTraces].sort((left, right) => compareTraceAddress(left.traceAddress ?? [], right.traceAddress ?? []))
  const rootDepth = trace.structLogs[0]?.depth ?? 0
  const built = buildVmTraceFrame(trace.structLogs, 0, rootDepth, sortedCallTraces, 0, poststate)
  return built.trace
}

function buildVmTraceFrame(
  structLogs: Array<{ pc: number; op: string; gas: string; gasCost: string; depth?: number; memory: string[]; stack: string[]; storage: Record<string, string> }>,
  startIndex: number,
  depth: number,
  callTraces: CallTrace[],
  callIndex: number,
  poststate?: Record<string, unknown>,
): { trace: Record<string, unknown>; nextStepIndex: number; nextCallIndex: number } {
  const currentCall = callTraces[callIndex]
  const ops: Array<Record<string, unknown>> = []
  let stepIndex = startIndex
  let nextCallIndex = currentCall ? callIndex + 1 : callIndex

  while (stepIndex < structLogs.length) {
    const step = structLogs[stepIndex]
    const stepDepth = step.depth ?? depth
    if (stepDepth < depth) {
      break
    }
    if (stepDepth > depth) {
      const nested = buildVmTraceFrame(structLogs, stepIndex, stepDepth, callTraces, nextCallIndex, poststate)
      stepIndex = nested.nextStepIndex
      nextCallIndex = nested.nextCallIndex
      if (ops.length > 0) {
        ops[ops.length - 1].sub = nested.trace
      }
      continue
    }

    const opNode: Record<string, unknown> = {
      idx: stepIndex,
      pc: step.pc,
      op: step.op,
      cost: step.gasCost,
      ex: {
        used: step.gas,
        push: step.stack.length > 0 ? step.stack[step.stack.length - 1] : null,
        mem: step.memory.length > 0 ? step.memory : undefined,
        store: Object.keys(step.storage).length > 0 ? step.storage : undefined,
      },
      sub: null,
    }
    ops.push(opNode)
    stepIndex += 1
  }

  return {
    trace: {
      code: resolveVmTraceCode(currentCall, poststate),
      ops,
    },
    nextStepIndex: stepIndex,
    nextCallIndex,
  }
}

function resolveVmTraceCode(callTrace: CallTrace | undefined, poststate?: Record<string, unknown>): string | null {
  if (!callTrace) {
    return null
  }
  if (callTrace.type.toLowerCase() === "create") {
    return callTrace.input !== "0x" ? callTrace.input : null
  }
  const address = callTrace.to.toLowerCase()
  const entry = (poststate?.[address] ?? null) as { code?: unknown } | null
  return typeof entry?.code === "string" ? entry.code : null
}

function compareTraceAddress(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index]
    }
  }
  return left.length - right.length
}

function formatGethCallTracer(callTraces: CallTrace[], tracerConfig: Record<string, unknown>): Record<string, unknown> {
  if (callTraces.length === 0) {
    return {}
  }

  const onlyTopCall = tracerConfig.onlyTopCall === true
  const nodes = new Map<string, Record<string, unknown>>()
  let root: Record<string, unknown> | null = null

  for (const callTrace of callTraces) {
    const traceAddress = callTrace.traceAddress ?? []
    const key = traceAddress.join("/")
    const node = applyCallTracerConfig(
      formatGethCallTracerNode(callTrace),
      callTrace,
      tracerConfig,
    )
    nodes.set(key, node)

    if (traceAddress.length === 0) {
      root = node
      continue
    }

    if (onlyTopCall) {
      continue
    }

    const parent = nodes.get(traceAddress.slice(0, -1).join("/"))
    if (!parent) {
      continue
    }
    const existingCalls = (parent.calls as Record<string, unknown>[] | undefined) ?? []
    existingCalls.push(node)
    parent.calls = existingCalls
  }
  return root ?? applyCallTracerConfig(formatGethCallTracerNode(callTraces[0]), callTraces[0], tracerConfig)
}

function formatGethCallTracerNode(callTrace: CallTrace): Record<string, unknown> {
  const type = callTrace.type.toUpperCase()
  const node: Record<string, unknown> = {
    type,
    from: callTrace.from,
    to: callTrace.to,
    value: callTrace.value,
    gas: callTrace.gas,
    gasUsed: callTrace.gasUsed,
    input: callTrace.input,
    output: callTrace.output,
  }

  if (type === "CREATE") {
    node.input = callTrace.input
    node.output = callTrace.output
  }
  if (callTrace.error) {
    node.error = callTrace.error
  }
  if (callTrace.revertReason) {
    node.revertReason = callTrace.revertReason
  }
  return node
}

function applyCallTracerConfig(
  node: Record<string, unknown>,
  callTrace: CallTrace,
  tracerConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (tracerConfig.withLog === true && Array.isArray(callTrace.logs) && callTrace.logs.length > 0) {
    node.logs = callTrace.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
    }))
  }
  return node
}

function formatGethPrestateTracer(
  prestate: Record<string, unknown>,
  poststate: Record<string, unknown>,
  tracerConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (tracerConfig.diffMode === true) {
    return applyPrestateTracerConfigToDiff(buildGethPrestateDiff(prestate, poststate), tracerConfig)
  }
  return applyPrestateTracerConfigToEntries(prestate, tracerConfig)
}

function applyPrestateTracerConfigToEntries(
  entries: Record<string, unknown>,
  tracerConfig: Record<string, unknown>,
): Record<string, unknown> {
  const disableCode = tracerConfig.disableCode === true
  const disableStorage = tracerConfig.disableStorage === true
  if (!disableCode && !disableStorage) {
    return entries
  }

  const filtered: Record<string, unknown> = {}
  for (const [address, rawEntry] of Object.entries(entries)) {
    const entry = { ...(rawEntry as Record<string, unknown>) }
    if (disableCode) {
      delete entry.code
    }
    if (disableStorage) {
      delete entry.storage
    }
    filtered[address] = entry
  }
  return filtered
}

function applyPrestateTracerConfigToDiff(
  diff: Record<string, unknown>,
  tracerConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    pre: applyPrestateTracerConfigToEntries((diff.pre ?? {}) as Record<string, unknown>, tracerConfig),
    post: applyPrestateTracerConfigToEntries((diff.post ?? {}) as Record<string, unknown>, tracerConfig),
  }
}

function buildGethPrestateDiff(
  prestate: Record<string, unknown>,
  poststate: Record<string, unknown>,
): Record<string, unknown> {
  const pre: Record<string, unknown> = {}
  const post: Record<string, unknown> = {}
  const addresses = new Set([...Object.keys(prestate), ...Object.keys(poststate)])

  for (const address of addresses) {
    const before = (prestate[address] ?? {}) as Record<string, unknown>
    const after = (poststate[address] ?? {}) as Record<string, unknown>
    const preEntry: Record<string, unknown> = {}
    const postEntry: Record<string, unknown> = {}

    collectPrestateFieldDiff("balance", before, after, preEntry, postEntry)
    collectPrestateFieldDiff("nonce", before, after, preEntry, postEntry)
    collectPrestateFieldDiff("code", before, after, preEntry, postEntry)

    const preStorage = (before.storage ?? {}) as Record<string, unknown>
    const postStorage = (after.storage ?? {}) as Record<string, unknown>
    const storageKeys = new Set([...Object.keys(preStorage), ...Object.keys(postStorage)])
    const preStorageDiff: Record<string, unknown> = {}
    const postStorageDiff: Record<string, unknown> = {}
    for (const key of storageKeys) {
      if (preStorage[key] === postStorage[key]) continue
      if (preStorage[key] !== undefined) preStorageDiff[key] = preStorage[key]
      if (postStorage[key] !== undefined) postStorageDiff[key] = postStorage[key]
    }
    if (Object.keys(preStorageDiff).length > 0) {
      preEntry.storage = preStorageDiff
    }
    if (Object.keys(postStorageDiff).length > 0) {
      postEntry.storage = postStorageDiff
    }

    if (Object.keys(preEntry).length > 0) {
      pre[address] = preEntry
    }
    if (Object.keys(postEntry).length > 0) {
      post[address] = postEntry
    }
  }

  return { pre, post }
}

function collectPrestateFieldDiff(
  field: "balance" | "nonce" | "code",
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  preEntry: Record<string, unknown>,
  postEntry: Record<string, unknown>,
): void {
  if (before[field] === after[field]) {
    return
  }
  if (before[field] !== undefined) {
    preEntry[field] = before[field]
  }
  if (after[field] !== undefined) {
    postEntry[field] = after[field]
  }
}

async function loadSolcCompiler(): Promise<{ compile(input: string): string; version(): string }> {
  if (!solcLoaderPromise) {
    solcLoaderPromise = import("solc")
      .then((module) => {
        const solc = (module.default ?? module) as { compile?: (input: string) => string; version?: () => string }
        if (typeof solc.compile !== "function" || typeof solc.version !== "function") {
          throw new Error("solc module does not expose compile/version")
        }
        return {
          compile: solc.compile.bind(solc),
          version: solc.version.bind(solc),
        }
      })
      .catch((error) => {
        solcLoaderPromise = null
        throw new Error(`Solidity compiler is unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  return solcLoaderPromise
}

async function compileSoliditySource(source: string): Promise<Record<string, unknown>> {
  const solc = await loadSolcCompiler()
  const input = {
    language: "Solidity",
    sources: {
      "input.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: false, runs: 200 },
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "metadata",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "evm.bytecode.sourceMap",
            "evm.deployedBytecode.sourceMap",
            "evm.methodIdentifiers",
            "devdoc",
            "userdoc",
          ],
        },
      },
    },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    contracts?: Record<string, Record<string, any>>
    errors?: Array<{ formattedMessage?: string; message?: string; severity?: string }>
  }

  const fatalErrors = (output.errors ?? []).filter((entry) => entry.severity === "error")
  if (fatalErrors.length > 0) {
    throw {
      code: -32000,
      message: fatalErrors.map((entry) => entry.formattedMessage ?? entry.message ?? "solc compilation error").join("\n"),
    }
  }

  const contracts = output.contracts?.["input.sol"] ?? {}
  const compilerVersion = solc.version()
  const compiled: Record<string, unknown> = {}
  for (const [contractName, artifact] of Object.entries(contracts)) {
    const bytecode = normalizeCompiledBytecode(artifact.evm?.bytecode?.object)
    const runtimeCode = normalizeCompiledBytecode(artifact.evm?.deployedBytecode?.object)
    compiled[contractName] = {
      code: bytecode,
      runtimeCode,
      info: {
        source,
        language: "Solidity",
        languageVersion: "Solidity",
        compilerVersion,
        abiDefinition: artifact.abi ?? [],
        userDoc: artifact.userdoc ?? {},
        developerDoc: artifact.devdoc ?? {},
        metadata: artifact.metadata ?? "",
        hashes: artifact.evm?.methodIdentifiers ?? {},
        srcMap: artifact.evm?.bytecode?.sourceMap ?? "",
        srcMapRuntime: artifact.evm?.deployedBytecode?.sourceMap ?? "",
      },
    }
  }
  return compiled
}

function normalizeCompiledBytecode(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "0x"
  }
  return value.startsWith("0x") ? value : `0x${value}`
}

function toRpcQuantity(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`
}

function toRpcHexOrNull(value: string | null | undefined): string | null {
  return value ?? null
}

function formatSignatureV(value: bigint | number | null | undefined): string {
  if (value === undefined || value === null) return "0x0"
  return toRpcQuantity(value)
}

function normalizePersistedTo(value: string | null | undefined): string | null {
  if (!value || value === "0x0") return null
  return value
}

function formatRawTransaction(
  rawTx: Hex,
  context?: { blockHash?: Hex; blockNumber?: bigint; transactionIndex?: number | null },
): Record<string, unknown> | null {
  try {
    const parsed = Transaction.from(rawTx)
    return {
      hash: parsed.hash,
      from: parsed.from,
      to: toRpcHexOrNull(parsed.to ?? null),
      nonce: toRpcQuantity(parsed.nonce),
      value: toRpcQuantity(parsed.value ?? 0n),
      gas: toRpcQuantity(parsed.gasLimit ?? 21_000n),
      gasPrice: toRpcQuantity(parsed.gasPrice ?? parsed.maxFeePerGas ?? 0n),
      ...(parsed.maxFeePerGas !== null && parsed.maxFeePerGas !== undefined
        ? { maxFeePerGas: toRpcQuantity(parsed.maxFeePerGas) }
        : {}),
      ...(parsed.maxPriorityFeePerGas !== null && parsed.maxPriorityFeePerGas !== undefined
        ? { maxPriorityFeePerGas: toRpcQuantity(parsed.maxPriorityFeePerGas) }
        : {}),
      input: parsed.data ?? "0x",
      blockHash: context?.blockHash ?? null,
      blockNumber: context?.blockNumber != null ? toRpcQuantity(context.blockNumber) : null,
      transactionIndex: context?.transactionIndex != null
        ? toRpcQuantity(context.transactionIndex)
        : null,
      type: toRpcQuantity(parsed.type ?? 0),
      chainId: parsed.chainId !== null && parsed.chainId !== undefined ? toRpcQuantity(parsed.chainId) : undefined,
      v: formatSignatureV(parsed.signature?.v),
      r: parsed.signature?.r ?? "0x0",
      s: parsed.signature?.s ?? "0x0",
    }
  } catch {
    return null
  }
}

function findTransactionIndex(rawTxs: Hex[], txHash: Hex): number | null {
  for (let i = 0; i < rawTxs.length; i++) {
    try {
      if (Transaction.from(rawTxs[i]).hash.toLowerCase() === txHash.toLowerCase()) {
        return i
      }
    } catch {
      continue
    }
  }
  return null
}

function computeCumulativeGasUsed(
  receipts: Array<{ transactionHash: string; gasUsed: bigint | string }>,
  txHash: Hex,
): bigint {
  let total = 0n
  for (const receipt of receipts) {
    total += typeof receipt.gasUsed === "bigint" ? receipt.gasUsed : BigInt(receipt.gasUsed)
    if (receipt.transactionHash.toLowerCase() === txHash.toLowerCase()) {
      break
    }
  }
  return total
}

async function formatPersistentReceipt(
  tx: Awaited<ReturnType<NonNullable<IChainEngine["getTransactionByHash"]>>>,
  chain: IChainEngine,
): Promise<Record<string, unknown> | null> {
  if (!tx?.receipt) return null
  const parsed = formatRawTransaction(tx.rawTx, {
    blockHash: tx.receipt.blockHash,
    blockNumber: tx.receipt.blockNumber,
  })
  if (!parsed) return null

  const block = await Promise.resolve(chain.getBlockByNumber(tx.receipt.blockNumber))
  const transactionIndex = block ? findTransactionIndex(block.txs, tx.receipt.transactionHash) : null
  const receipts = block
    ? await Promise.resolve(chain.getReceiptsByBlock(block.number))
    : [tx.receipt]
  const cumulativeGasUsed = computeCumulativeGasUsed(
    receipts.map((receipt) => ({
      transactionHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed,
    })),
    tx.receipt.transactionHash,
  )
  const normalizedTo = normalizePersistedTo(tx.receipt.to)
  const contractAddress = normalizedTo === null && tx.receipt.status === 1n
    ? getCreateAddress({ from: tx.receipt.from, nonce: parsed.nonce as string })
    : null
  const logsBloom = aggregateBlockLogsBloom([
    {
      transactionHash: tx.receipt.transactionHash,
      gasUsed: tx.receipt.gasUsed,
      status: tx.receipt.status,
      logs: tx.receipt.logs,
    },
  ])

  return {
    transactionHash: tx.receipt.transactionHash,
    transactionIndex: transactionIndex !== null ? toRpcQuantity(transactionIndex) : "0x0",
    blockNumber: toRpcQuantity(tx.receipt.blockNumber),
    blockHash: tx.receipt.blockHash,
    from: tx.receipt.from,
    to: normalizedTo,
    cumulativeGasUsed: toRpcQuantity(cumulativeGasUsed),
    gasUsed: toRpcQuantity(tx.receipt.gasUsed),
    status: tx.receipt.status === 1n ? "0x1" : "0x0",
    logsBloom,
    logs: (tx.receipt.logs ?? []).map((log, idx) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: toRpcQuantity(tx.receipt.blockNumber),
      blockHash: tx.receipt.blockHash,
      transactionHash: tx.receipt.transactionHash,
      transactionIndex: transactionIndex !== null ? toRpcQuantity(transactionIndex) : "0x0",
      logIndex: toRpcQuantity(idx),
      removed: false,
    })),
    effectiveGasPrice: String((parsed as Record<string, unknown>).gasPrice ?? "0x0"),
    contractAddress,
    type: String((parsed as Record<string, unknown>).type ?? "0x0"),
  }
}

/**
 * #112: synthesise a genesis block (block 0) for `eth_getBlockByNumber("earliest")`
 * when the chain didn't store block 0 explicitly. Match the convention block 1
 * already uses on the wire (parentHash = 0x000…000, timestamp = 0). Empty txs,
 * empty proposer, default 30M gasLimit. Hash is all-zeros — the same value
 * block 1 carries as parentHash, so chain integrity checks line up.
 */
function formatGenesisBlock(includeTx: boolean) {
  const ZERO_HASH = `0x${"0".repeat(64)}`
  const ZERO_ADDR = `0x${"0".repeat(40)}`
  return {
    number: "0x0",
    hash: ZERO_HASH,
    parentHash: ZERO_HASH,
    nonce: "0x0000000000000000",
    sha3Uncles: ZERO_HASH,
    logsBloom: `0x${"0".repeat(512)}`,
    transactionsRoot: ZERO_HASH,
    stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    miner: ZERO_ADDR,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: "0x0",
    transactions: includeTx ? [] : [],
    uncles: [],
    mixHash: ZERO_HASH,
    baseFeePerGas: "0x0",
  }
}

async function formatBlock(block: Awaited<ReturnType<IChainEngine["getBlockByNumber"]>>, includeTx: boolean, chain?: IChainEngine, evm?: EvmChain) {
  if (!block) return null

  const receipts = chain
    ? await Promise.resolve(chain.getReceiptsByBlock(block.number))
    : []
  const headerView = await buildBlockHeaderView(block, receipts)

  // Parse raw txs directly instead of O(n*m) search through EVM receipts
  let transactions: unknown[]
  const blockNumHex = `0x${block.number.toString(16)}`
  if (includeTx) {
    transactions = block.txs.map((rawTx, i) => {
      return formatRawTransaction(rawTx, {
        blockHash: block.hash,
        blockNumber: block.number,
        transactionIndex: i,
      }) ?? rawTx
    })
  } else {
    transactions = block.txs.map((rawTx) => {
      try {
        return Transaction.from(rawTx).hash
      } catch {
        return keccak256Hex(Buffer.from(rawTx.slice(2), "hex"))
      }
    })
  }

  // Approximate block size: header overhead + sum of tx hex byte lengths
  const HEADER_OVERHEAD = 508
  let txBytesSize = 0
  for (const rawTx of block.txs) {
    // Each hex char = 0.5 bytes, minus "0x" prefix
    txBytesSize += Math.max(0, (rawTx.length - 2)) / 2
  }
  const blockSize = HEADER_OVERHEAD + Math.floor(txBytesSize)

  return {
    number: `0x${block.number.toString(16)}`,
    hash: block.hash,
    parentHash: block.parentHash,
    nonce: "0x0000000000000000",
    sha3Uncles: "0x" + "0".repeat(64),
    logsBloom: headerView.logsBloom,
    transactionsRoot: headerView.transactionsRoot,
    stateRoot: headerView.stateRoot,
    receiptsRoot: headerView.receiptsRoot,
    miner: block.proposer.startsWith("0x") ? block.proposer : "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: `0x${Buffer.from(block.proposer, "utf-8").toString("hex")}`,
    mixHash: "0x" + "0".repeat(64),
    size: `0x${blockSize.toString(16)}`,
    gasLimit: `0x${BLOCK_GAS_LIMIT.toString(16)}`,
    gasUsed: `0x${headerView.gasUsed.toString(16)}`,
    timestamp: `0x${Math.floor(block.timestampMs / 1000).toString(16)}`,
    baseFeePerGas: `0x${headerView.baseFeePerGas.toString(16)}`,
    withdrawals: [],
    withdrawalsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
    blobGasUsed: `0x${(block.blobGasUsed ?? 0n).toString(16)}`,
    excessBlobGas: `0x${(block.excessBlobGas ?? 0n).toString(16)}`,
    parentBeaconBlockRoot: block.parentBeaconBlockRoot ?? ("0x" + "0".repeat(64)),
    finalized: block.finalized,
    transactions,
  }
}

const MAX_LOG_BLOCK_RANGE = 10_000n
const MAX_LOG_RESULTS = 10_000
const MAX_TRACE_BLOCK_RANGE = 1_024n
const MAX_TRACE_RESULTS = 1_000

/**
 * Validate + normalize the address/topic fields of a log filter shape
 * (the object accepted by `eth_getLogs`, `eth_newFilter`, and downstream
 * subscription paths). Mutates `query` in place with normalized lowercase
 * hex so downstream consumers don't need to re-validate. Throws -32602
 * on malformed input; PR #142 added these rules for `eth_newFilter`;
 * PR #162 extends them to `eth_getLogs`.
 */
function validateLogFilter(query: Record<string, unknown>): {
  address: Hex | undefined
  addresses: Hex[] | undefined
  topics: Array<Hex | Hex[] | null> | undefined
} {
  const FILTER_ADDR_RE = /^0x[0-9a-fA-F]{40}$/
  const FILTER_TOPIC_RE = /^0x[0-9a-fA-F]{64}$/
  const MAX_FILTER_ADDRESSES = 100
  const MAX_FILTER_TOPICS = 4
  // #186: blockHash field shape validation was missed by #162's
  // address+topics work. Pre-fix `{blockHash: "0x123"}` silently
  // returned `result: []` indistinguishable from "no logs". Match
  // the 32-byte hex shape of eth_getBlockByHash (#166).
  if (query.blockHash !== undefined && query.blockHash !== null) {
    if (typeof query.blockHash !== "string" || !FILTER_TOPIC_RE.test(query.blockHash)) {
      throw { code: -32602, message: "invalid blockHash: must match /^0x[0-9a-fA-F]{64}$/" }
    }
    // Normalize for downstream consumers (lowercase canonical form).
    query.blockHash = query.blockHash.toLowerCase()
  }
  const validateFilterAddr = (raw: unknown, idx: number): Hex => {
    if (typeof raw !== "string" || !FILTER_ADDR_RE.test(raw)) {
      throw { code: -32602, message: `invalid filter address at index ${idx}: must match /^0x[0-9a-fA-F]{40}$/` }
    }
    return raw.toLowerCase() as Hex
  }
  let address: Hex | undefined
  let addresses: Hex[] | undefined
  if (query.address !== undefined && query.address !== null) {
    if (Array.isArray(query.address)) {
      if (query.address.length > MAX_FILTER_ADDRESSES) {
        throw { code: -32602, message: `address array too large: ${query.address.length} > ${MAX_FILTER_ADDRESSES}` }
      }
      addresses = (query.address as unknown[]).map((a, i) => validateFilterAddr(a, i))
      address = addresses.length > 0 ? addresses[0] : undefined
    } else {
      address = validateFilterAddr(query.address, 0)
    }
    // Mutate the query in-place so downstream collectLogs / chain.getLogs
    // see the lowercased canonical form and don't need to re-validate.
    query.address = addresses ?? address
  }
  let topics: Array<Hex | Hex[] | null> | undefined
  if (query.topics !== undefined && query.topics !== null) {
    // #190: pre-fix, a non-array `topics` (string, object, number) silently
    // bypassed the entire validation block — clients got the same empty-result
    // response as a syntactically-valid query and never learned their filter
    // was malformed.
    if (!Array.isArray(query.topics)) {
      throw { code: -32602, message: "invalid filter topics: must be array or omitted" }
    }
    if (query.topics.length > MAX_FILTER_TOPICS) {
      throw { code: -32602, message: `topics array too large: ${query.topics.length} > ${MAX_FILTER_TOPICS} (max indexed log topics)` }
    }
    topics = query.topics.map((t, i) => {
      if (t === null || t === undefined) return null
      if (Array.isArray(t)) {
        return t.map((tt, j) => {
          if (typeof tt !== "string" || !FILTER_TOPIC_RE.test(tt)) {
            throw { code: -32602, message: `invalid filter topic at index ${i}[${j}]: must match /^0x[0-9a-fA-F]{64}$/ or null` }
          }
          return tt.toLowerCase() as Hex
        })
      }
      if (typeof t !== "string" || !FILTER_TOPIC_RE.test(t)) {
        throw { code: -32602, message: `invalid filter topic at index ${i}: must match /^0x[0-9a-fA-F]{64}$/ or null` }
      }
      return t.toLowerCase() as Hex
    })
    query.topics = topics
  }
  return { address, addresses, topics }
}

async function queryLogs(chain: IChainEngine, query: Record<string, unknown>, resolvedHeight?: bigint): Promise<unknown[]> {
  const height = resolvedHeight ?? await Promise.resolve(chain.getHeight())
  const finalizedHeight = await Promise.resolve(chain.getHighestFinalizedBlock())
  const fromBlock = parseBlockTag(query.fromBlock, height, finalizedHeight)
  const toBlock = parseBlockTag(query.toBlock, height, finalizedHeight)

  // Reject invalid range where fromBlock > toBlock
  if (fromBlock > toBlock) {
    throw { code: -32602, message: `invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}` }
  }
  // Enforce block range limit to prevent resource exhaustion
  if (toBlock - fromBlock > MAX_LOG_BLOCK_RANGE) {
    throw { code: -32602, message: `block range too large: max ${MAX_LOG_BLOCK_RANGE} blocks, got ${toBlock - fromBlock}` }
  }

  // Normalize address filter: single string or array of strings
  let address: Hex | undefined
  let addresses: Hex[] | undefined
  if (query.address) {
    if (Array.isArray(query.address)) {
      addresses = (query.address as string[]).map((a) => a.toLowerCase() as Hex)
    } else {
      address = String(query.address).toLowerCase() as Hex
    }
  }

  // Normalize topics: each position can be null, single topic, or array of topics (OR)
  const topics = Array.isArray(query.topics)
    ? query.topics.map((t) => {
        if (t === null || t === undefined) return null
        if (Array.isArray(t)) return (t as string[]).map((s) => s.toLowerCase() as Hex)
        return String(t).toLowerCase() as Hex
      })
    : undefined

  // Use persistent log index when available
  if (typeof chain.getLogs === "function") {
    const results = await chain.getLogs({
      fromBlock,
      toBlock,
      address,
      addresses,
      topics: topics as Array<Hex | null> | undefined,
    })
    return results.slice(0, MAX_LOG_RESULTS)
  }

  // Fallback to receipt-based log collection
  return collectLogs(chain, fromBlock, toBlock, {
    id: "inline",
    fromBlock,
    toBlock,
    address,
    addresses,
    topics,
    lastCursor: fromBlock,
  })
}

async function queryTraceFilter(chain: IChainEngine, evm: EvmChain, query: Record<string, unknown>): Promise<unknown[]> {
  const height = await Promise.resolve(chain.getHeight())
  const finalizedHeight = await Promise.resolve(chain.getHighestFinalizedBlock())
  const fromBlock = parseBlockTag(query.fromBlock ?? "earliest", height, finalizedHeight)
  const toBlock = parseBlockTag(query.toBlock ?? "latest", height, finalizedHeight)
  if (fromBlock > toBlock) {
    throw { code: -32602, message: `invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}` }
  }
  if (toBlock - fromBlock > MAX_TRACE_BLOCK_RANGE) {
    throw { code: -32602, message: `trace block range too large: max ${MAX_TRACE_BLOCK_RANGE} blocks, got ${toBlock - fromBlock}` }
  }

  const fromAddresses = normalizeTraceAddressFilter(query.fromAddress)
  const toAddresses = normalizeTraceAddressFilter(query.toAddress)
  const after = parseTracePaginationValue(query.after, 0)
  const count = Math.min(parseTracePaginationValue(query.count, MAX_TRACE_RESULTS), MAX_TRACE_RESULTS)
  if (count === 0) {
    return []
  }

  const replay = await evm.createReplayChain()
  await replayTraceBlocksBefore(replay, chain, fromBlock)

  const traces: unknown[] = []
  let skipped = 0
  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1n) {
    const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
    if (!block) continue
    for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
      const traced = await replay.traceRawTx(block.txs[txIndex], {}, {
        blockNumber: block.number,
        txIndex,
        blockHash: block.hash,
        baseFeePerGas: block.baseFee ?? 0n,
        excessBlobGas: block.excessBlobGas,
        parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
        timestamp: BigInt(Math.floor(block.timestampMs / 1000)),
      })
      const filteredCalls = traced.callTraces.filter((callTrace) =>
        matchesTraceAddressFilter(callTrace, fromAddresses, toAddresses)
      )
      if (filteredCalls.length === 0) {
        continue
      }
      const localized = formatLocalizedOpenEthereumCallTraces(filteredCalls, {
        blockHash: block.hash,
        blockNumber: block.number,
        transactionHash: traced.txHash,
        transactionPosition: txIndex,
      })
      for (const trace of localized) {
        if (skipped < after) {
          skipped += 1
          continue
        }
        traces.push(trace)
        if (traces.length >= count) {
          return traces
        }
      }
    }
  }

  return traces
}

function normalizeTraceAddressPath(input: unknown): number[] {
  if (input === undefined || input === null) {
    return []
  }
  if (!Array.isArray(input)) {
    throw { code: -32602, message: "invalid traceAddress path: expected array" }
  }
  return input.map((value, index) => {
    let normalized: number
    if (typeof value === "number") {
      normalized = value
    } else if (typeof value === "string") {
      normalized = value.startsWith("0x") ? Number(BigInt(value)) : Number(value)
    } else {
      throw { code: -32602, message: `invalid traceAddress[${index}]: expected integer` }
    }
    if (!Number.isSafeInteger(normalized) || normalized < 0) {
      throw { code: -32602, message: `invalid traceAddress[${index}]: expected non-negative integer` }
    }
    return normalized
  })
}

function traceAddressEquals(left: number[], right: number[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false
    }
  }
  return true
}

async function locateTraceTransactionContext(
  chain: IChainEngine,
  txHash: Hex,
): Promise<{ blockHash: string; blockNumber: bigint; transactionHash: string; transactionPosition: number } | null> {
  if (typeof chain.getTransactionByHash === "function") {
    const stored = await chain.getTransactionByHash(txHash)
    if (stored?.receipt) {
      const block = await Promise.resolve(chain.getBlockByHash(stored.receipt.blockHash))
        ?? await Promise.resolve(chain.getBlockByNumber(stored.receipt.blockNumber))
      if (!block) {
        throw new Error(`block not found: ${stored.receipt.blockNumber}`)
      }
      const transactionPosition = findTransactionIndex(block.txs, stored.receipt.transactionHash)
      if (transactionPosition === null) {
        throw new Error(`transaction not found in block: ${stored.receipt.transactionHash}`)
      }
      return {
        blockHash: block.hash,
        blockNumber: block.number,
        transactionHash: stored.receipt.transactionHash,
        transactionPosition,
      }
    }
  }

  const height = await Promise.resolve(chain.getHeight())
  for (let blockNumber = 1n; blockNumber <= height; blockNumber += 1n) {
    const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
    if (!block) continue
    const transactionPosition = findTransactionIndex(block.txs, txHash)
    if (transactionPosition === null) {
      continue
    }
    return {
      blockHash: block.hash,
      blockNumber: block.number,
      transactionHash: txHash,
      transactionPosition,
    }
  }

  return null
}

async function replayTraceBlocksBefore(replay: EvmChain, chain: IChainEngine, targetBlockNumber: bigint): Promise<void> {
  for (let blockNumber = 1n; blockNumber < targetBlockNumber; blockNumber += 1n) {
    const block = await Promise.resolve(chain.getBlockByNumber(blockNumber))
    if (!block) {
      throw new Error(`block not found: ${blockNumber}`)
    }
    const executionTimestamp = BigInt(Math.floor(block.timestampMs / 1000))
    await replay.applyBlockContext({
      blockNumber: block.number,
      baseFeePerGas: block.baseFee ?? 0n,
      excessBlobGas: block.excessBlobGas,
      parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
      timestamp: executionTimestamp,
    })
    for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
      await replay.executeRawTx(block.txs[txIndex], block.number, txIndex, block.hash, block.baseFee ?? 0n, {
        excessBlobGas: block.excessBlobGas,
        parentBeaconBlockRoot: block.parentBeaconBlockRoot ? hexToBytes(block.parentBeaconBlockRoot) : undefined,
        timestamp: executionTimestamp,
      })
    }
  }
}

function normalizeTraceAddressFilter(input: unknown): string[] | undefined {
  if (input === undefined || input === null) {
    return undefined
  }
  const values = Array.isArray(input) ? input : [input]
  const normalized = values.map((value) => String(value).toLowerCase())
  for (const address of normalized) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw { code: -32602, message: `invalid trace address filter: ${address}` }
    }
  }
  return normalized
}

function parseTracePaginationValue(input: unknown, fallback: number): number {
  if (input === undefined || input === null) {
    return fallback
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw { code: -32602, message: "invalid trace pagination value" }
    }
    return Math.floor(input)
  }
  if (typeof input === "string") {
    const value = safeBigInt(input)
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw { code: -32602, message: `invalid trace pagination value: ${input}` }
    }
    return Number(value)
  }
  throw { code: -32602, message: "invalid trace pagination value" }
}

function matchesTraceAddressFilter(
  callTrace: CallTrace,
  fromAddresses?: string[],
  toAddresses?: string[],
): boolean {
  if (fromAddresses && !fromAddresses.includes(callTrace.from.toLowerCase())) {
    return false
  }
  if (toAddresses && !toAddresses.includes(callTrace.to.toLowerCase())) {
    return false
  }
  return true
}

async function collectLogs(
  chain: IChainEngine,
  from: bigint,
  to: bigint,
  filter: PendingFilter & { addresses?: Hex[] },
): Promise<unknown[]> {
  const logs: unknown[] = []
  for (let n = from; n <= to; n += 1n) {
    const receipts = await Promise.resolve(chain.getReceiptsByBlock(n))
    for (const receipt of receipts) {
      const recLogs = Array.isArray(receipt.logs) ? receipt.logs : []
      for (const log of recLogs as Array<Record<string, unknown>>) {
        if (!matchesFilter(log, filter)) continue
        logs.push(log)
        if (logs.length >= MAX_LOG_RESULTS) return logs
      }
    }
  }
  return logs
}

/**
 * Compute the current base fee from the latest block's gas usage.
 */
async function computeCurrentBaseFee(chain: IChainEngine): Promise<bigint> {
  const height = await Promise.resolve(chain.getHeight())
  return computeBaseFeeForBlock(height, chain)
}

async function computeBaseFeeForBlock(blockNum: bigint, chain: IChainEngine): Promise<bigint> {
  if (blockNum <= 1n) return genesisBaseFee()

  // Read baseFee from block if available (populated by buildBlock)
  const block = await Promise.resolve(chain.getBlockByNumber(blockNum))
  if (block?.baseFee !== undefined) return block.baseFee

  // Fallback: compute from parent for blocks without stored baseFee
  const parentNum = blockNum - 1n
  const parentBlock = await Promise.resolve(chain.getBlockByNumber(parentNum))
  const parentBaseFee = parentBlock?.baseFee ?? genesisBaseFee()
  const parentGasUsed = parentBlock?.gasUsed ?? 0n
  return calculateBaseFee({ parentBaseFee, parentGasUsed })
}

/**
 * Match a log entry against filter criteria.
 * Supports: single/multi address, null/single/OR-array per topic position.
 */
function matchesFilter(
  log: Record<string, unknown>,
  filter: PendingFilter & { addresses?: Hex[] },
): boolean {
  const logAddr = String(log.address ?? "").toLowerCase()

  // Address filter: prefer array if available, otherwise single
  if (filter.addresses && filter.addresses.length > 0) {
    if (!filter.addresses.some((a) => a === logAddr)) return false
  } else if (filter.address && logAddr !== filter.address.toLowerCase()) {
    return false
  }

  if (!filter.topics || filter.topics.length === 0) return true

  const logTopics = Array.isArray(log.topics) ? (log.topics as string[]) : []
  for (let i = 0; i < filter.topics.length; i++) {
    const expected = filter.topics[i]
    if (expected === null || expected === undefined) continue

    const logTopic = (logTopics[i] ?? "").toLowerCase()

    // OR-array: log topic must match any one
    if (Array.isArray(expected)) {
      if (!expected.some((e: string) => e.toLowerCase() === logTopic)) return false
    } else {
      if (String(expected).toLowerCase() !== logTopic) return false
    }
  }
  return true
}
