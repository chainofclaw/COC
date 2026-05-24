import http from "node:http"
import type net from "node:net"
import { parse as parseUrl } from "node:url"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder, storeRawBlock, loadRawBlock } from "./ipfs-unixfs.ts"
import type { IpfsAddResult, UnixFsFileMeta } from "./ipfs-types.ts"
import type { IpfsMfs } from "./ipfs-mfs.ts"
import type { IpfsPubsub } from "./ipfs-pubsub.ts"
import { createTarArchive } from "./ipfs-tar.ts"
import { RateLimiter } from "./rate-limiter.ts"
import { ByteQuota, type QuotaReservation } from "./byte-quota.ts"
import { createLogger } from "./logger.ts"
import {
  encodeFile as erasureEncode,
  ErasureError,
  type ErasureManifest,
  MAX_DATA_SHARDS,
  MAX_PARITY_SHARDS,
} from "./ipfs-erasure.ts"
import {
  resolveCid,
  readErasureFile,
  erasureStatus,
} from "./ipfs-erasure-reader.ts"
import { InterfaceBlockstoreAdapter, BlockstoreReadBudgetError } from "./ipfs-blockstore-adapter.ts"
import { buildDirectoryDag, type DirEntryInput } from "./ipfs-unixfs-dir.ts"
import {
  resolveUnixfsPath,
  listDirectory,
  readEntryBytes,
  PathResolveError,
  MAX_BLOCK_READS,
  type ResolvedEntry,
  type DirectoryLink,
} from "./ipfs-path-resolve.ts"

const log = createLogger("ipfs")
const ipfsRateLimiter = new RateLimiter(60_000, 100)
setInterval(() => ipfsRateLimiter.cleanup(), 300_000).unref()

/**
 * #468: hard deadline for a single UnixFS DAG resolve / directory listing.
 * A pathological (deep / wide / heavily-sharded) DAG cannot pin a request
 * handler past this — the exporter's async iterators abort on the signal.
 */
const IPFS_RESOLVE_TIMEOUT_MS = 20_000

/**
 * #468: aggregate caps for `/api/v0/get` of a directory tree. The tar is
 * assembled fully in memory, so the per-file `MAX_READ_SIZE` cap is not
 * enough — the cumulative byte count, file count, and nesting depth must
 * all be bounded so a malicious wide/deep directory CID cannot exhaust
 * node memory (the endpoint is not auth-gated).
 */
const MAX_DIRECTORY_GET_BYTES = 64 * 1024 * 1024
const MAX_DIRECTORY_GET_FILES = 10_000
const MAX_DIRECTORY_GET_DEPTH = 64
/**
 * Cap on the total number of DAG nodes (files AND directories) visited
 * while assembling a directory tar. The byte / file caps do not bound a
 * tree built entirely of empty sub-directories — depth alone would still
 * allow an enormous traversal — so every visited entry is counted here.
 */
const MAX_DIRECTORY_GET_NODES = 50_000

class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, msg?: string) {
    super(msg ?? code)
    this.status = status
    this.code = code
  }
}

/**
 * #192: Node's `parseUrl(req.url, true).query[key]` returns
 * `string | string[] | undefined` — duplicate query params arrive as
 * arrays. Pre-fix, every route in this file cast it as `string`, a
 * runtime no-op; the array reached downstream handlers expecting
 * strings, threw downstream, and surfaced as `500 "internal error"`
 * across 9 IPFS endpoints — a textbook validation-by-cast bug.
 *
 * Coalesce to the first occurrence (matches kubo for non-batch
 * endpoints) so single-arg routes get a predictable string and the
 * existing per-handler validation can reject empty/invalid values
 * with 400 like it was designed to.
 */
function firstQueryValue(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) return raw[0]
  return raw
}

// #236: kubo's /files/cp + /files/mv both take destination as a SECOND
// `?arg=` value. firstQueryValue coalesced everything to [0]; this
// returns the Nth value so the second arg lands on the dest field.
function nthQueryValue(raw: string | string[] | undefined, n: number): string | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) return raw[n]
  return n === 0 ? raw : undefined
}

/**
 * #370: kubo's `/api/v0/*` endpoints accept the `arg` parameter as
 * either a bare CID (`bafy…`) OR a path-form `/ipfs/<cid>[/<subpath>]`.
 * The kubo CLI default and js-ipfs both emit the path form. Pre-fix
 * our `isValidCid` rejected any string containing `/` so every
 * `arg=/ipfs/<cid>` call surfaced as `400 invalid cid` — silently
 * breaking interop with the official client tooling.
 *
 * Strip a leading `/ipfs/` (or `ipfs/` without leading slash for
 * permissiveness) so the remaining string is the bare CID and falls
 * through the normal `isValidCid` check. Subpaths under directory
 * CIDs aren't supported here (we don't expose directory navigation),
 * so any string containing `/` after the strip still fails `isValidCid`
 * with the same clean 400.
 *
 * IPNS (`/ipns/<key>`) is NOT supported on this server; the prefix
 * stays intact so `isValidCid` returns false with a clean "invalid cid"
 * instead of pretending the IPNS name is a CID.
 */
function stripIpfsPathPrefix(arg: string | undefined): string | undefined {
  if (arg === undefined) return undefined
  if (arg.startsWith("/ipfs/")) return arg.slice(6)
  if (arg.startsWith("ipfs/")) return arg.slice(5)
  return arg
}

// #372: kubo's /api/v0/pin/{add,rm,ls} and /api/v0/block/rm accept BATCH
// args via repeated `?arg=cid1&arg=cid2&…`. Pre-fix firstQueryValue
// coalesced everything to [0], silently dropping CIDs 2..N — clients
// got `{Pins:[cid1]}` and assumed success while cid2..N never actually
// pinned/unpinned. Normalize into an always-array shape at the boundary.
//
// #590-regression-fix: #370 strips `/ipfs/<cid>` path-form prefix at the
// dispatcher boundary so kubo-default `arg=/ipfs/<cid>` works on every
// route. The batch helpers above bypassed `stripIpfsPathPrefix` for
// pin/{add,rm,ls} + block/rm, so `arg=/ipfs/<cid>` came back as 400
// invalid_cid after #372 landed. Apply the strip per-element here to
// preserve #370's invariant for batch endpoints too.
function allQueryValues(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const vs = Array.isArray(raw) ? raw : [raw]
  return vs.map((v) => stripIpfsPathPrefix(v) ?? v)
}

function splitCidPath(arg: string): { cid: string; path: string[] } {
  const slashIdx = arg.indexOf("/")
  const cid = slashIdx < 0 ? arg : arg.slice(0, slashIdx)
  const rest = slashIdx < 0 ? "" : arg.slice(slashIdx + 1)
  const path = rest.split("/").filter((segment) => segment.length > 0)
  return { cid, path }
}

interface ResolvedCidPath {
  rootCid: string
  cid: string
  path: string[]
  leafIndex?: number
  leafSize?: number
  /**
   * Present when the CID/path resolved through the UnixFS DAG walker
   * (issue #468 directory support). Carries the exporter entry so
   * read handlers can stream file content or list directory children
   * without a second blockstore round-trip. Absent for bare non-UnixFS
   * CIDs and the #704 numeric chunk-link fallback.
   */
  entry?: ResolvedEntry
}

function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "ENOENT") return true
  const msg = String(err instanceof Error ? err.message : err)
  return /not\s*found|no such|ENOENT/i.test(msg)
}

/**
 * #468: classify a UnixFS-resolve failure. Returns an `HttpError` when the
 * failure is a *resource limit* — the per-request block-read budget was
 * exhausted, or the resolve `AbortSignal` timed out — so callers surface a
 * clean 504 instead of letting it fall through as a misleading 500 (or, in
 * the bare-CID probe, get swallowed entirely). Returns `null` for ordinary
 * "not a navigable UnixFS node" errors, which callers handle themselves.
 */
function resolveLimitError(err: unknown, signal: AbortSignal): HttpError | null {
  if (signal.aborted) {
    return new HttpError(504, "resolve timeout",
      `UnixFS path resolution exceeded ${IPFS_RESOLVE_TIMEOUT_MS}ms`)
  }
  if (err instanceof BlockstoreReadBudgetError) {
    return new HttpError(504, "resolve aborted", err.message)
  }
  return null
}

/**
 * #353: /api/v0/add silently ignored kubo params that materially change
 * the resulting CID (cid-version, hash, chunker, raw-leaves, trickle,
 * wrap-with-directory, inline, nocopy). A client requesting
 * `cid-version=0` got back a `bafy...` v1 CID; the upload succeeded,
 * the client recomputed its expected v0 `Qm...` digest, and the two
 * never matched — content-addressed verification silently broke.
 *
 * This server's UnixFS builder is hard-coded to: cid-version=1 (raw
 * dag-pb), hash=sha2-256, chunker=size-262144 (256 KiB), unixfs-
 * wrapped leaves (i.e. raw-leaves=false), balanced layout (trickle=
 * false), no directory wrap. Reject any client request that demands
 * a different shape so they can fall back / retry with the right
 * settings instead of pinning a CID that doesn't match their hash.
 *
 * Benign params (progress, silent, quieter, quiet, fscache,
 * stdin-name, only-hash, hash-fun-code) are passed through — they
 * either don't change the CID or the response shape we already
 * emit (single newline-terminated JSON object) is a strict subset
 * of kubo's progress stream.
 */
function validateAddParams(query: Record<string, string | string[] | undefined>): void {
  const exactDefault = (key: string, expected: string): void => {
    const raw = firstQueryValue(query[key])
    if (raw !== undefined && raw !== expected) {
      throw new HttpError(400, "unsupported_param",
        `${key}: only '${expected}' is supported (got '${raw}')`)
    }
  }

  exactDefault("cid-version", "1")
  exactDefault("hash", "sha2-256")
  exactDefault("chunker", "size-262144")

  // Booleans we don't honor — accept "false" / absent, reject "true".
  // Case-insensitive to match kubo's go-flag parser.
  //
  // #468: `wrap-with-directory` left this list — it IS honored now (the
  // directory-DAG write path). It is still validated as a boolean below
  // so `wrap-with-directory=maybe` gets the same 400 kubo emits.
  const booleanRejectsTrue = [
    "raw-leaves",
    "nocopy",
    "inline",
    "trickle",
  ]
  for (const key of booleanRejectsTrue) {
    const raw = firstQueryValue(query[key])
    if (raw === undefined) continue
    const norm = raw.toLowerCase()
    if (norm === "true" || norm === "1") {
      throw new HttpError(400, "unsupported_param",
        `${key}: not supported by this server (only 'false' / unset)`)
    }
    // Reject obvious garbage like "maybe", "yes". kubo's flag parser
    // accepts true/false/0/1 (case-insensitive) and 400s on the rest.
    if (norm !== "false" && norm !== "0") {
      throw new HttpError(400, "unsupported_param",
        `${key}: expected boolean (true/false/0/1), got '${raw}'`)
    }
  }

  // #468: `wrap-with-directory` is a supported flag — only reject a
  // non-boolean value, matching kubo's strconv.ParseBool behaviour.
  const wrapRaw = firstQueryValue(query["wrap-with-directory"])
  if (wrapRaw !== undefined) {
    const norm = wrapRaw.toLowerCase()
    if (norm !== "true" && norm !== "1" && norm !== "false" && norm !== "0") {
      throw new HttpError(400, "unsupported_param",
        `wrap-with-directory: expected boolean (true/false/0/1), got '${wrapRaw}'`)
    }
  }

  // #553: pin was previously listed as a "benign passed-through" param
  // — but `handleAdd` always pins regardless of the query value, so a
  // client passing `pin=false` got a 200 indistinguishable from "pinned
  // anyway" and burned disk it asked us to skip. `pin=garbage` was also
  // silently accepted, drifting from kubo's strconv.ParseBool reject.
  // This server always pins, so the policy is: accept true/1/unset,
  // reject false/0 as "unsupported (this server always pins)", reject
  // everything else as the same boolean-parse 400 kubo emits.
  const pinRaw = firstQueryValue(query.pin)
  if (pinRaw !== undefined) {
    const norm = pinRaw.toLowerCase()
    if (norm === "false" || norm === "0") {
      throw new HttpError(400, "unsupported_param",
        `pin: this server always pins uploaded blobs (only 'true' / unset)`)
    }
    if (norm !== "true" && norm !== "1") {
      throw new HttpError(400, "unsupported_param",
        `pin: expected boolean (true/false/0/1), got '${pinRaw}'`)
    }
  }
}

/**
 * #344: gate state-destroying IPFS admin operations (repo/gc, block/rm)
 * behind either loopback origin OR a configured X-COC-IPFS-Admin-Token
 * header. Pre-fix every anonymous internet caller could destroy data.
 *
 * Mirrors the RPC admin gate (#336): defaults to loopback-only so
 * unconfigured production deployments are secure-by-default; operators
 * who need remote access set COC_IPFS_ADMIN_TOKEN and pass it via
 * X-COC-IPFS-Admin-Token header.
 */
export function isIpfsAdminAuthorized(
  req: http.IncomingMessage,
  clientIp: string,
  cfg: IpfsServerConfig,
): boolean {
  // 1) Loopback always allowed (typical operator workflow via SSH tunnel
  //    or local CLI).
  const stripped = clientIp.startsWith("::ffff:") ? clientIp.slice(7) : clientIp
  if (stripped === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(stripped)) return true
  // 2) Configured admin token via header. Constant-time comparison so the
  //    token length isn't a timing oracle.
  if (cfg.adminAuthToken) {
    const headerRaw = req.headers["x-coc-ipfs-admin-token"]
    const provided = typeof headerRaw === "string" ? headerRaw : ""
    return safeStringEq(provided, cfg.adminAuthToken)
  }
  return false
}

/**
 * #9 (audit follow-up): admin gate + anonymous byte-quota gate for
 * /api/v0/add. Module-level + exported so unit tests can exercise the
 * three auth tiers (admin / anonymous-quota / denied) without spinning
 * up an HTTP server bound to a non-loopback address.
 *
 * Returns:
 *   - `{ ok: true, reservation }` when the request may proceed. Caller
 *     MUST commit / refund the reservation against actual bytes.
 *   - `{ ok: false, status, body, headers? }` when the request was
 *     rejected. Caller writes status + body to the response.
 */
export type AddAuthResult =
  | { ok: true; reservation: QuotaReservation }
  | { ok: false; status: number; body: Record<string, unknown>; headers?: Record<string, string> }

export function enforceAddAuth(
  req: http.IncomingMessage,
  clientIp: string,
  cfg: IpfsServerConfig,
  anonQuota: ByteQuota | null,
): AddAuthResult {
  if (isIpfsAdminAuthorized(req, clientIp, cfg)) {
    return { ok: true, reservation: { commit: () => {}, refund: () => {} } }
  }
  if (!anonQuota) {
    return {
      ok: false,
      status: 403,
      headers: { "www-authenticate": "X-COC-IPFS-Admin-Token" },
      body: {
        error: "forbidden",
        message: "/api/v0/add requires loopback or X-COC-IPFS-Admin-Token; set anonymousAdd to opt in",
      },
    }
  }
  const declared = Number(req.headers["content-length"])
  if (!Number.isFinite(declared) || declared <= 0) {
    return {
      ok: false,
      status: 411,
      body: {
        error: "length_required",
        message: "/api/v0/add anonymous tier requires a Content-Length header",
      },
    }
  }
  const result = anonQuota.tryReserve(clientIp, declared)
  if (!result.ok) {
    return {
      ok: false,
      status: 413,
      headers: { "x-coc-quota-scope": result.reason ?? "unknown" },
      body: {
        error: "quota_exceeded",
        scope: result.reason,
        remaining: result.remaining ?? 0,
        message: `anonymous add quota exhausted (scope=${result.reason}); retry after window roll-over`,
      },
    }
  }
  return { ok: true, reservation: result.reservation! }
}

/**
 * #8: returns true when a request must read in local-only mode (no
 * fetchRemote on miss). Anonymous (non-loopback non-token) callers get
 * `true`; admin tier (loopback / X-COC-IPFS-Admin-Token) gets `false`.
 *
 * Without this guard, PR #711's directory-DAG walker could be
 * weaponized: a request for `/ipfs/<unknown-cid>/...` triggers one
 * `store.get` per visited block, each of which falls into
 * `fetchRemote → DHT findProviders + wire BlockRequest` on miss. That
 * turns the node into an N×-amplifying DHT-reflection / SSRF proxy.
 *
 * Module-level + exported so unit tests can exercise the gate without
 * spinning up an HTTP server bound to a non-loopback address (same
 * pattern as {@link isIpfsAdminAuthorized} / {@link enforceAddAuth}).
 */
export function isLocalOnlyRead(req: http.IncomingMessage, cfg: IpfsServerConfig): boolean {
  const raw = req.socket?.remoteAddress ?? ""
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw
  return !isIpfsAdminAuthorized(req, ip, cfg)
}

function safeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still iterate one of the strings so the timing leak is bounded
    // by the longer of the two — not by the shorter, which would
    // disclose length cheaply.
    let acc = 1
    const longer = a.length > b.length ? a : b
    for (let i = 0; i < longer.length; i++) acc |= 1
    return acc === 0
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export interface IpfsServerConfig {
  bind: string
  port: number
  storageDir: string
  nodeId?: string
  /**
   * #344: optional Bearer-token (via X-COC-IPFS-Admin-Token header) that
   * authorizes destructive ops (repo/gc, block/rm) from non-loopback
   * origins. When unset, those ops are loopback-only (secure default).
   */
  adminAuthToken?: string
  /**
   * Phase C3.1: the uploader blocks on replication results and gets a
   * warning header when fewer than `minReplicas` peers acknowledged the
   * push. `minReplicas=2` (default) matches the K=3 replication target
   * with 1 slack — a 3-validator testnet where any peer is temporarily
   * unreachable still returns 200 without the warning, but a cluster
   * where only the uploader holds the bytes emits the warning so
   * operators catch the under-replication before C3.3's repair loop
   * has a chance to react.
   */
  minReplicas?: number
  /**
   * Optional awaiter supplied by coc-ipfs-wiring.ts's
   * `awaitReplicationResult`. Keeps the HTTP server decoupled from the
   * DHT / wire manager — when undefined, the replication warning path
   * is a no-op and uploads behave exactly like pre-C3.1.
   */
  awaitReplicationResult?: (cid: string, timeoutMs?: number) => Promise<{
    attempted: number
    succeeded: string[]
    failed: string[]
    skippedLowPeers: boolean
  } | null>
  /**
   * Phase Q.6: stripe-aware batch push. When attached, the `?erasure=N+M`
   * branch of /api/v0/add stores shards with `deferStripePush` and then
   * calls this to fan out across distinct peers. Absent this, the erasure
   * path falls back to per-CID push-to-K (functionally correct, just less
   * peer-diverse).
   */
  pushStripe?: (shards: Array<{ cid: string; bytes: Uint8Array }>) => Promise<{
    perShard: Array<{ cid: string; attempted: number; succeeded: string[]; failed: string[]; skippedLowPeers: boolean }>
    distinctPeersUsed: number
    worstPeerOverlap: number
  }>
  /**
   * #590: kubo-standard `/api/v0/swarm/peers` route returns the set of
   * currently-connected P2P peers. The HTTP server is intentionally
   * decoupled from `P2PNode` — wiring injects this getter so client
   * libraries (js-ipfs, kubo-rpc-client, IPFS Companion) that depend on
   * the kubo wire shape stop receiving 404s. When undefined, the route
   * returns `{Peers: []}` (kubo's documented "no connections" shape)
   * rather than 404, so liveness probes don't false-alarm.
   */
  getSwarmPeers?: () => Array<{
    id: string
    url: string
    advertisedUrl?: string
  }>
  /**
   * #9 (audit follow-up): anonymous /api/v0/add policy.
   *
   * Default (undefined) is secure: anonymous (non-loopback, no admin
   * token) callers are 403'd, matching the existing #344 / #460 gate
   * pattern on repo/gc, block/rm, pin/rm. Operators who want to
   * accept anonymous uploads MUST opt-in AND pick byte budgets — the
   * config is intentionally non-default to force a conscious decision
   * given the disk-fill risk (obs-1 disk-full crash loop, 2026-05-24).
   *
   * Admin-authorized uploads (loopback OR X-COC-IPFS-Admin-Token) are
   * never quota-gated; only the anonymous tier hits the budget.
   */
  anonymousAdd?: {
    allowed: boolean
    /** Max bytes a single source IP can upload per `windowMs`. */
    perIpBytes: number
    /** Aggregate cap across all anonymous IPs per `windowMs` (Sybil cap). */
    totalBytes: number
    /** Window size (default 24h). */
    windowMs?: number
  }
}

export class IpfsHttpServer {
  private readonly cfg: IpfsServerConfig
  private readonly store: IpfsBlockstore
  private readonly unixfs: UnixFsBuilder
  private mfs: IpfsMfs | null = null
  private pubsub: IpfsPubsub | null = null
  private server: http.Server | null = null
  private readonly sockets = new Set<net.Socket>()
  /**
   * #9: byte-quota tracker for the anonymous /api/v0/add tier. Null when
   * anonymous uploads are disabled (secure default), so the auth-gate
   * fast-path skips quota math entirely.
   */
  private readonly anonymousAddQuota: ByteQuota | null

  constructor(cfg: IpfsServerConfig, store: IpfsBlockstore, unixfs: UnixFsBuilder) {
    this.cfg = cfg
    this.store = store
    this.unixfs = unixfs
    if (cfg.anonymousAdd?.allowed) {
      if (!Number.isFinite(cfg.anonymousAdd.perIpBytes) || cfg.anonymousAdd.perIpBytes <= 0) {
        throw new Error("anonymousAdd.perIpBytes must be a positive finite number")
      }
      if (!Number.isFinite(cfg.anonymousAdd.totalBytes) || cfg.anonymousAdd.totalBytes <= 0) {
        throw new Error("anonymousAdd.totalBytes must be a positive finite number")
      }
      this.anonymousAddQuota = new ByteQuota({
        windowMs: cfg.anonymousAdd.windowMs,
        perKeyMax: cfg.anonymousAdd.perIpBytes,
        globalMax: cfg.anonymousAdd.totalBytes,
      })
    } else {
      this.anonymousAddQuota = null
    }
  }

  /**
   * Post-construction attachment for Phase C3.1's replication awaiter.
   * index.ts builds the HTTP server before the blockstore/DHT wiring
   * is ready (to keep the IPFS API responsive during boot), so the
   * awaiter is injected once `buildCocIpfsWiring` returns. Absent this
   * call, `handleAdd` skips the replica-status check and no
   * `X-COC-Replicas-Warning` header is emitted — the safe default for
   * single-node deployments or during the boot window.
   */
  setAwaitReplicationResult(
    awaiter: IpfsServerConfig["awaitReplicationResult"],
    minReplicas?: number,
  ): void {
    this.cfg.awaitReplicationResult = awaiter
    if (typeof minReplicas === "number") this.cfg.minReplicas = minReplicas
  }

  /** Phase Q.6: attach the stripe-aware push helper. Symmetric with setAwaitReplicationResult. */
  setPushStripe(pushStripe: IpfsServerConfig["pushStripe"]): void {
    this.cfg.pushStripe = pushStripe
  }

  /**
   * Attach MFS and Pubsub subsystems.
   */
  attachSubsystems(opts: { mfs?: IpfsMfs; pubsub?: IpfsPubsub }): void {
    if (opts.mfs) this.mfs = opts.mfs
    if (opts.pubsub) this.pubsub = opts.pubsub
  }

  start(): void {
    if (this.server) return
    const server = http.createServer(async (req, res) => {
      try {
      // Rate limiting
      const rawClientIp = req.socket.remoteAddress ?? "unknown"
      const clientIp = rawClientIp.startsWith("::ffff:") ? rawClientIp.slice(7) : rawClientIp
      if (!ipfsRateLimiter.allow(clientIp)) {
        res.writeHead(429, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "rate limit exceeded" }))
        return
      }

      const url = parseUrl(req.url ?? "", true)

      // #328: CORS support. The gateway (/ipfs/<cid>) is read-only content
      // addressing and intentionally cross-origin-friendly, so it advertises
      // ACAO: * + the methods/headers browsers need (Range, conditional
      // headers, etc.) and exposes Content-Length / Content-Range / etc.
      // /api/v0/* is intentionally CORS-locked: kubo's POST-only rule
      // (#136) plus the absence of ACAO denies cross-origin POSTs, which
      // is the existing CSRF protection. The OPTIONS preflight here just
      // returns 204 with no ACAO so the browser denies the actual POST.
      if (req.method === "OPTIONS") {
        if (url.pathname?.startsWith("/ipfs/")) {
          res.writeHead(204, {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "Range, If-None-Match, If-Match, If-Modified-Since",
            "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
            "access-control-max-age": "86400",
          })
          res.end()
          return
        }
        // /api/v0/* and everything else: 204 no-CORS — preflight denied,
        // browser will not send the actual POST.
        res.writeHead(204)
        res.end()
        return
      }

      // #326: HEAD must be treated as GET-without-body per RFC 7231 §4.3.2.
      // Pre-fix the gateway only matched GET, so `curl -I /ipfs/<cid>` fell
      // through to the /api/v0/ 404 even when the block existed and a real
      // GET succeeded. Clients use HEAD for cache validation, pre-flight,
      // and resumable-download discovery — that capability was 100% broken.
      // #428: clean up stale GET-only handler stub that was supposed to be
      // replaced by this combined isGatewayMethod path. Earlier PR merges
      // (#326, #324, #328, #340) left both the OLD `if (req.method === "GET" …)`
      // block AND the NEW combined handler intermixed, with bare `})` /
      // `}` sequences between them that broke the file's syntax entirely.
      // This rewrite collapses all of them into the single intended handler:
      //   #326 — HEAD is identical to GET except no body
      //   #324 — HTTP Range support (RFC 7233)
      //   #328 — CORS `access-control-allow-origin: *` on /ipfs/ reads
      //   #340 — MIME-type sniffing so browsers render content correctly
      const isGatewayMethod = req.method === "GET" || req.method === "HEAD"
      if (isGatewayMethod && url.pathname?.startsWith("/ipfs/")) {
        // #545: pre-fix `url.pathname.slice(6)` treated the ENTIRE tail
        // (including subpaths like `/ipfs/<cid>/foo/bar`) as the CID
        // string. `isValidCid("<cid>/foo/bar")` rejected the embedded
        // slash and returned "invalid CID" — misleading because the CID
        // itself is well-formed; only the subpath traversal couldn't be
        // resolved. Kubo's gateway: returns 404 "no link named 'foo'
        // under <CID>" (or similar) for subpath misses, NOT "invalid
        // CID". Same anti-pattern family as #543 (regex-mismatch produces
        // misleading error for a well-formed input).
        //
        // Fix: split the path; treat the first segment as the CID
        // candidate. Numeric UnixFS leaf paths are resolved locally; other
        // subpaths surface 404 "no such file" explicitly so callers don't
        // think their CID is malformed.
        const tail = url.pathname.slice(6) // strip "/ipfs/"
        const parsed = splitCidPath(tail)
        const cid = parsed.cid
        if (!isValidCid(cid)) {
          res.writeHead(400, { "content-type": "application/json", "access-control-allow-origin": "*" })
          res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "invalid CID" }))
          return
        }
        // #468: resolve the full `<cid>/<subpath>` through the UnixFS DAG
        // walker. Maps both 404 (missing component) and 400 (mid-path
        // non-directory) to a structured JSON error with CORS preserved.
        // #8: anonymous gateway callers walk in local-only mode so unknown
        // CIDs can't be weaponized as DHT-reflection amplifiers.
        const gatewayLocalOnly = this.isLocalOnlyRead(req)
        let resolved: ResolvedCidPath
        try {
          resolved = await this.resolveCidPath(cid, parsed.path, { localOnly: gatewayLocalOnly })
        } catch (err) {
          if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
            res.writeHead(err.status, { "content-type": "application/json", "access-control-allow-origin": "*" })
            res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: err.code, message: err.message }))
            return
          }
          throw err
        }
        // #468: a directory CID — serve `index.html` if the directory has
        // one (the canonical static-site pattern), else a JSON listing.
        if (resolved.entry?.type === "directory") {
          await this.serveGatewayDirectory(req, res, resolved.entry)
          return
        }
        // #168: pre-fix ENOENT for valid-shape-missing CIDs propagated
        // to the outer 500 handler, logging a stacktrace for every probe.
        // Map to 404 explicitly so missing-block looks like missing-block.
        //
        // #272: pre-fix the gateway called `unixfs.readFile()` directly,
        // which throws `Error("not a unixfs file")` for raw blocks — falling
        // through to the outer 500. The sibling `/api/v0/cat` already
        // dispatches raw / erasure via `resolveCid`. Reuse `readByCid`
        // here so the gateway behaves identically; its HttpError throws
        // (404 for missing, 400 for invalid CID, etc.) flow through the
        // outer catch's structured handler. Same family as #168/#232/
        // #268/#270/#543 — generic 500 leak for a well-defined case.
        try {
          const data = await this.readResolved(resolved)
          // #324: HTTP Range support per RFC 7233. Pre-fix the gateway
          // returned the full body for every request, even when the
          // client sent `Range: bytes=N-M` — making resumable downloads,
          // video seek, and partial-content fetches all impossible.
          // kubo's gateway honors Range; ours had not. Parse a SINGLE
          // bytes-range request; multi-range (comma-separated) is
          // uncommon and falls back to 200 full body to avoid a
          // multipart/byteranges response generator. Malformed Range
          // → 416 Range Not Satisfiable per spec.
          const rangeHeader = req.headers["range"]
          if (typeof rangeHeader === "string" && rangeHeader.length > 0 && !rangeHeader.includes(",")) {
            const parsed = parseRangeBytes(rangeHeader, data.length)
            if (parsed === "invalid") {
              res.writeHead(416, {
                "content-type": "application/json",
                "content-range": `bytes */${data.length}`,
                "access-control-allow-origin": "*",
              })
              res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "range not satisfiable" }))
              return
            }
            if (parsed !== "ignore") {
              const slice = data.subarray(parsed.start, parsed.end + 1)
              res.writeHead(206, {
                "content-range": `bytes ${parsed.start}-${parsed.end}/${data.length}`,
                "content-length": slice.length,
                "accept-ranges": "bytes",
                "access-control-allow-origin": "*",
                "content-type": sniffMimeType(data),
              })
              res.end(req.method === "HEAD" ? undefined : slice)
              return
            }
          }
          // No Range header (or unsupported multi-range): full body
          // with #328 CORS + #340 MIME sniff + #326 HEAD body suppression.
          // #609: pre-fix the full-body GET branch omitted `content-length`
          // (the HEAD branch correctly emits it). Clients can't pre-
          // allocate, range-aware downloaders skip resume capability, and
          // HTTP caches fall back to chunked transfer for what is in fact
          // a known-length buffer. Sibling 206 path already sets it
          // (line ~487). Emit it on the 200 path too so all three responses
          // agree on the wire shape.
          const fullBodyHeaders: http.OutgoingHttpHeaders = {
            "content-type": sniffMimeType(data),
            "content-length": String(data.length),
            "accept-ranges": "bytes",
            "access-control-allow-origin": "*",
          }
          if (req.method === "HEAD") {
            res.writeHead(200, fullBodyHeaders)
            res.end()
          } else {
            res.writeHead(200, fullBodyHeaders)
            res.end(data)
          }
        } catch (err) {
          // #272: readByCid throws HttpError instead of raw "not found"
          // strings, so map back here to preserve the existing CORS-on-404
          // contract that browser callers rely on.
          if (isNotFoundError(err) || (err instanceof HttpError && err.status === 404)) {
            res.writeHead(404, { "content-type": "application/json", "access-control-allow-origin": "*" })
            res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "not found" }))
          } else {
            throw err
          }
        }
        return
      }

      if (!url.pathname?.startsWith("/api/v0/")) {
        // #382: pre-fix bare `writeHead(404); end()` had no Content-Length
        // and no Transfer-Encoding. HEAD clients waited 5s+ for the
        // keep-alive timeout because the response framing was ambiguous.
        // Set explicit Content-Length: 0 so HEAD short-circuits cleanly.
        res.writeHead(404, { "content-length": "0" })
        res.end()
        return
      }

      // #136: kubo's HTTP RPC spec requires POST for all /api/v0/*
      // endpoints to prevent CSRF — browsers fire GET on <img>/<script>
      // tags without Same-Origin Policy, which would otherwise let any
      // visited webpage trigger state-changing operations (pin/add,
      // block/rm, repo/gc) against a victim's local IPFS daemon.
      if (req.method !== "POST") {
        // #382: same Content-Length fix as the 404 above. For HEAD on
        // /api/v0/* the body is suppressed by Node but the framing must
        // still be unambiguous. JSON body length is computed here so HEAD
        // gets the exact byte count the server would have written.
        const body = JSON.stringify({ error: "method not allowed: /api/v0/* requires POST" })
        res.writeHead(405, {
          "allow": "POST",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        })
        res.end(req.method === "HEAD" ? undefined : body)
        return
      }

      // #192: coalesce dup query params at the dispatcher boundary so
      // route handlers always receive `string | undefined` (not the
      // `string | string[]` Node's url-parser actually returns).
      //
      // #370: also normalize kubo's path-form CID arg
      // (`arg=/ipfs/<cid>`) to the bare CID at the boundary so each
      // route's `isValidCid` check accepts both forms. kubo CLI and
      // js-ipfs both default to the path form.
      const argParam = stripIpfsPathPrefix(firstQueryValue(url.query.arg))
      if (url.pathname === "/api/v0/add") {
        // #353: reject unsupported kubo params *before* we read the
        // multipart body — a client requesting cid-version=0 should
        // get a fast 400 with `unsupported_param`, not a successful
        // upload + a v1 CID they can't reconcile against their v0
        // expectation.
        validateAddParams(url.query as Record<string, string | string[] | undefined>)
        const wrapRaw = firstQueryValue(url.query["wrap-with-directory"])?.toLowerCase()
        const wrapWithDirectory = wrapRaw === "true" || wrapRaw === "1"
        // #9 (audit follow-up): admin gate + anonymous byte quota.
        // Returns null when the gate already wrote the response; otherwise
        // returns a reservation handle (no-op for admin, real budget
        // for anonymous) that handleAdd must commit/refund.
        const reservation = this.enforceAddAuth(req, res, clientIp)
        if (!reservation) return
        try {
          await this.handleAdd(req, res, firstQueryValue(url.query.erasure), wrapWithDirectory, reservation)
        } catch (err) {
          reservation.refund()
          throw err
        }
        return
      }
      if (url.pathname === "/api/v0/version") {
        await this.handleVersion(res)
        return
      }
      if (url.pathname === "/api/v0/id") {
        await this.handleId(res)
        return
      }
      // #590: kubo-standard swarm/peers route. Many clients (IPFS Companion,
      // kubo-rpc-client, ipfs-http-client, archival indexers) poll this
      // for liveness; pre-fix every probe got 404 even when the node had
      // healthy P2P connections. Returns kubo's documented wire shape:
      // `{Peers: [{Peer, Addr, Direction, Latency, Muxer, Streams}, ...]}`.
      // When `getSwarmPeers` isn't wired, return an empty list (NOT 404)
      // so clients distinguish "node has no peers" from "endpoint missing".
      if (url.pathname === "/api/v0/swarm/peers") {
        const rawPeers = this.cfg.getSwarmPeers?.() ?? []
        const peers = rawPeers.map((p) => ({
          Peer: p.id,
          Addr: p.advertisedUrl ?? p.url,
          // COC doesn't yet track per-peer direction/latency/muxer/streams —
          // fill with kubo defaults so the wire shape is complete.
          Direction: 0,
          Latency: "",
          Muxer: "",
          Streams: null,
        }))
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ Peers: peers }))
        return
      }
      // #547: kubo-rpc-client / ipfs-http-client / web3.storage call
      // POST /api/v0/repo/stat (canonical) or POST /api/v0/stats/repo
      // (alias). The handler was only registered under the non-standard
      // /api/v0/stat path, so every canonical client got a 404 trying
      // to poll repo size. Keep /api/v0/stat as an internal alias for
      // backward compatibility with anything already calling it.
      if (
        url.pathname === "/api/v0/repo/stat" ||
        url.pathname === "/api/v0/stats/repo" ||
        url.pathname === "/api/v0/stat"
      ) {
        await this.handleStat(res)
        return
      }
      if (url.pathname === "/api/v0/ls") {
        await this.handleLs(req, res, argParam ?? "")
        return
      }
      if (url.pathname === "/api/v0/object/stat") {
        await this.handleObjectStat(req, res, argParam ?? "")
        return
      }
      if (url.pathname === "/api/v0/cat") {
        await this.handleCat(req, res, argParam ?? "", {
          offset: firstQueryValue(url.query.offset),
          length: firstQueryValue(url.query.length) ?? firstQueryValue(url.query.count),
        })
        return
      }
      if (url.pathname === "/api/v0/get") {
        await this.handleGet(req, res, argParam ?? "")
        return
      }
      if (url.pathname === "/api/v0/block/put") {
        await this.handleBlockPut(req, res)
        return
      }
      if (url.pathname === "/api/v0/block/get") {
        await this.handleBlockGet(req, res, argParam ?? "")
        return
      }
      if (url.pathname === "/api/v0/block/stat") {
        await this.handleBlockStat(res, argParam ?? "")
        return
      }
      if (url.pathname === "/api/v0/pin/add") {
        // #372: kubo treats pin/add as a BATCH op — `?arg=cid1&arg=cid2&…`.
        // Pre-fix only the first arg was passed; CIDs 2..N silently dropped.
        await this.handlePinAdd(req, res, allQueryValues(url.query?.arg))
        return
      }
      if (url.pathname === "/api/v0/pin/ls") {
        // #308: kubo `pin/ls?type=<all|direct|indirect|recursive>` was
        // silently dropped — the handler ignored the `type` query param
        // entirely and always returned the full set with hardcoded
        // Type:"recursive". Invalid types returned 200 with the full
        // list instead of 400. Forward + validate at the boundary so
        // clients filtering by type get correct results (or a clear
        // error for invalid values).
        // #372: pin/ls?arg=cid1&arg=cid2 must filter to the union of
        // requested CIDs (kubo batch shape). Pre-fix only cid1 was checked.
        const typeRaw = firstQueryValue(url.query?.type)
        await this.handlePinLs(res, allQueryValues(url.query?.arg), typeRaw)
        return
      }
      if (url.pathname === "/api/v0/pin/rm") {
        // #460: pin/rm is destructive. Pre-fix any anonymous internet
        // caller could enumerate pin/ls (intentionally public) and then
        // pin/rm each CID. Once unpinned, the next repo/gc cycle deletes
        // the blocks — permanent data loss. Same attack surface as
        // block/rm (#344), same auth gate.
        if (!isIpfsAdminAuthorized(req, clientIp, this.cfg)) {
          res.writeHead(403, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "forbidden", message: "pin/rm requires loopback or X-COC-IPFS-Admin-Token" }))
          return
        }
        // #372: batch shape — same as pin/add.
        await this.handlePinRm(res, allQueryValues(url.query?.arg))
        return
      }
      if (url.pathname === "/api/v0/block/rm") {
        // #344: block/rm destroys arbitrary blocks (pinned ones too:
        // removeBlock unpins as part of removal). Pre-fix any anonymous
        // internet caller could enumerate pin/ls and then block/rm each
        // CID to wipe the node's content. Restrict to loopback / configured
        // admin token so the operator workflow (chaos drill, manual cleanup)
        // still works without exposing the surface publicly.
        if (!isIpfsAdminAuthorized(req, clientIp, this.cfg)) {
          res.writeHead(403, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "forbidden", message: "block/rm requires loopback or X-COC-IPFS-Admin-Token" }))
          return
        }
        // #372: batch shape — kubo streams one {Hash, Error} per CID.
        await this.handleBlockRm(res, allQueryValues(url.query?.arg))
        return
      }
      if (url.pathname === "/api/v0/repo/gc") {
        // #344: same auth gate as block/rm. repo/gc walks the entire pin
        // set under a blockstore lock — concurrent reads/writes block
        // during the scan. Unauth'd repeated GC = persistent disk thrash
        // + every in-flight unpinned block gets swept.
        if (!isIpfsAdminAuthorized(req, clientIp, this.cfg)) {
          res.writeHead(403, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "forbidden", message: "repo/gc requires loopback or X-COC-IPFS-Admin-Token" }))
          return
        }
        await this.handleRepoGc(res)
        return
      }
      if (url.pathname === "/api/v0/erasure/status") {
        await this.handleErasureStatus(res, argParam)
        return
      }

      // MFS routes
      if (url.pathname?.startsWith("/api/v0/files/") && this.mfs) {
        await this.handleMfsRoute(req, res, url)
        return
      }

      // Pubsub routes
      if (url.pathname?.startsWith("/api/v0/pubsub/") && this.pubsub) {
        await this.handlePubsubRoute(req, res, url)
        return
      }

      // #382: dispatch-end 404 catch-all — set Content-Length so HEAD
      // doesn't hang waiting for chunked framing.
      const notFoundBody = JSON.stringify({ error: "not found" })
      res.writeHead(404, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(notFoundBody)),
      })
      res.end(req.method === "HEAD" ? undefined : notFoundBody)
      } catch (err) {
        // #180: defensively map ErasureError to 4xx — the inline
        // handleCat path already does this for read-side ErasureError,
        // but handleAdd's `erasureEncode` could also throw with
        // code="invalid_params" and bubble up as 500 with a useless
        // "internal error" body if a new ErasureError class slips in.
        let status = err instanceof HttpError ? err.status : 500
        let code = err instanceof HttpError ? err.code : "internal error"
        let message = err instanceof HttpError && err.message !== code ? err.message : undefined
        if (status === 500 && err instanceof ErasureError) {
          // #210: extend the original two-code mapping (invalid_params /
          // not_found) to the other ErasureError codes that resolveCid
          // can throw — pre-fix invalid_cid / not_a_manifest /
          // unsupported_codec fell through as 500 "internal error" even
          // though they're all client-input problems.
          if (err.code === "invalid_params") {
            status = 400
            code = "invalid erasure params"
            message = err.message
          } else if (err.code === "invalid_cid") {
            status = 400
            code = "invalid CID"
            message = err.message
          } else if (err.code === "not_found") {
            status = 404
            code = "not found"
            message = err.message
          } else if (err.code === "not_a_manifest" || err.code === "unsupported_codec") {
            // 415 Unsupported Media Type: server received a resource it
            // can't process — closer to the kubo semantic than 500.
            status = 415
            code = err.code
            message = err.message
          }
        }
        if (!res.headersSent) {
          res.writeHead(status, { "content-type": "application/json" })
        }
        if (status >= 500) {
          log.error("IPFS HTTP request failed", { error: String(err) })
        } else {
          log.warn("IPFS HTTP request rejected", { status, code })
        }
        try {
          res.end(JSON.stringify(message ? { error: code, message } : { error: code }))
        } catch { /* connection already closed */ }
      }
    })
    // #350: server-level slowloris protection — bound header / total
    // request / keep-alive idle times so an attacker can't pin the
    // request handler pool just by sending slow bytes. Mirrors p2p.ts's
    // long-standing values (10s/30s/5s). The body-level inactivity
    // timeout in readBody (30s) defends the same threat lower in the
    // stack; both layers are intentional defense-in-depth.
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    server.keepAliveTimeout = 5_000

    server.on("connection", (socket) => {
      this.sockets.add(socket)
      socket.on("close", () => {
        this.sockets.delete(socket)
      })
    })

    server.listen(this.cfg.port, this.cfg.bind, () => {
      log.info("listening", { bind: this.cfg.bind, port: this.cfg.port })
    })
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.sockets.clear()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
    })
  }

  /**
   * #8: instance wrapper around module-level {@link isLocalOnlyRead}.
   * See that function for the SSRF rationale.
   */
  private isLocalOnlyRead(req: http.IncomingMessage): boolean {
    return isLocalOnlyRead(req, this.cfg)
  }

  /**
   * #9: instance wrapper around module-level {@link enforceAddAuth}.
   * Writes the response when the gate denies; otherwise returns the
   * reservation that handleAdd must commit/refund.
   */
  private enforceAddAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    clientIp: string,
  ): QuotaReservation | null {
    const result = enforceAddAuth(req, clientIp, this.cfg, this.anonymousAddQuota)
    if (result.ok) return result.reservation
    res.writeHead(result.status, { "content-type": "application/json", ...(result.headers ?? {}) })
    res.end(JSON.stringify(result.body))
    return null
  }

  private async handleAdd(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    erasureSpec?: string,
    wrapWithDirectory = false,
    quotaReservation: QuotaReservation = { commit: () => {}, refund: () => {} },
  ): Promise<void> {
    // #468: read every multipart part. A request is a directory upload
    // when the client asked to wrap, OR sent more than one part, OR any
    // part carries a nested relative path / explicit-directory marker.
    let parts
    try {
      parts = await readMultipartFiles(req)
    } catch (err) {
      // Multipart parsing failed (truncated body, oversize, etc.) —
      // refund the anonymous reservation so the client isn't charged
      // for bytes we couldn't actually accept.
      quotaReservation.refund()
      throw err
    }
    const actualBytes = parts.reduce((sum, p) => sum + (p.bytes?.byteLength ?? 0), 0)
    // Reconcile reservation to the real bytes pinned (Content-Length
    // includes multipart boundaries / headers, so actual < declared).
    quotaReservation.commit(actualBytes)
    const nested = parts.some((p) => p.path !== undefined && p.path.includes("/"))
    const isDirectory =
      wrapWithDirectory || nested || parts.length > 1 || parts.some((p) => p.isDir)

    if (isDirectory) {
      await this.handleAddDirectory(res, parts, erasureSpec)
      return
    }

    // Single-file upload — the original code path, unchanged. It keeps
    // producing the PoSe `merkleRoot`/`merkleLeaves` side-tree.
    const filename = parts[0].path
    const bytes = parts[0].bytes

    // Phase Q.4: opt-in Reed-Solomon erasure coding via ?erasure=N+M.
    // The UnixFS DAG is still produced (for back-compat retrieval via
    // the original CID); we additionally encode + store the erasure
    // shards and return the manifest CID as the entry-point Hash.
    const params = parseErasureSpec(erasureSpec)
    if (params) {
      const meta = await this.unixfs.addFile(filename ?? "file", bytes)
      await this.saveFileMeta(meta)

      const enc = await erasureEncode(bytes, { ...params, originalCid: meta.cid })
      // Phase Q.6: store every shard with `deferStripePush` so the per-
      // CID onPut hook skips its individual push-to-K. Self-announce +
      // gossip still fire (so peers learn we hold each shard via DHT),
      // but we delay the actual peer-bytes push until we've collected
      // every shard, then fire `pushStripe` to spread them across
      // distinct peers. Falls back to per-CID push when the wiring
      // helper isn't attached (single-node devnet boot window).
      const useStripePush = typeof this.cfg.pushStripe === "function"
      for (const block of enc.shardBlocks) {
        await this.store.put(block, useStripePush ? { deferStripePush: true } : undefined)
      }
      // Manifest still uses normal put — single block, no spread issue.
      await this.store.put(enc.manifestBlock)
      for (const block of enc.shardBlocks) await this.store.pin(block.cid)
      await this.store.pin(enc.manifestCid)

      let stripeReplicaHeader: string | undefined
      if (useStripePush) {
        try {
          const r = await this.cfg.pushStripe!(enc.shardBlocks.map((b) => ({ cid: b.cid, bytes: b.bytes })))
          stripeReplicaHeader = `distinct=${r.distinctPeersUsed},worstOverlap=${r.worstPeerOverlap}`
          if (r.worstPeerOverlap > 1) {
            log.info("erasure stripe push: peer overlap detected", {
              rootCid: enc.manifestCid,
              distinctPeersUsed: r.distinctPeersUsed,
              worstPeerOverlap: r.worstPeerOverlap,
            })
          }
        } catch (err) {
          log.warn("erasure stripe push failed", { rootCid: enc.manifestCid, error: String(err) })
        }
      }
      // Track the manifest → originalCid mapping in file-meta so an
      // operator can look up the UnixFS fallback CID without re-decoding
      // the manifest.
      await this.saveFileMeta({
        ...meta,
        cid: enc.manifestCid,
      })

      const result: IpfsAddResult = {
        Name: filename ?? "file",
        Hash: enc.manifestCid,
        Size: bytes.byteLength.toString(),
      }
      const erasureHeaders: Record<string, string> = {
        "content-type": "application/json",
        "X-COC-Erasure-Scheme": `rs(${params.n}+${params.m})`,
        "X-COC-Erasure-Original-Cid": meta.cid,
      }
      if (stripeReplicaHeader) {
        erasureHeaders["X-COC-Erasure-Stripe-Spread"] = stripeReplicaHeader
      }
      res.writeHead(200, erasureHeaders)
      res.end(`${JSON.stringify(result)}\n`)
      return
    }

    const meta = await this.unixfs.addFile(filename ?? "file", bytes)
    await this.store.pin(meta.cid)
    await this.saveFileMeta(meta)

    // Phase C3.1: await the replication fan-out triggered by the onPut
    // hook on each chunk + the root CID, aggregate the worst-case
    // per-CID replica count, and emit a warning header when the figure
    // is below minReplicas. The response still returns 200 so small
    // clusters (e.g. 1-node devnet) don't block uploads entirely —
    // the warning surfaces the shortfall so the operator sees it, and
    // C3.3's repair loop will backfill as peers come online.
    const replicaStatus = await this.collectReplicaStatus(meta.cid, meta.leaves)
    const headers: Record<string, string> = { "content-type": "application/json" }
    const minReplicas = this.cfg.minReplicas ?? 2
    if (replicaStatus && replicaStatus.worstReplicaCount < minReplicas) {
      headers["X-COC-Replicas-Warning"] = `got ${replicaStatus.worstReplicaCount}/${minReplicas} (cid=${replicaStatus.worstCid})`
      log.warn("under-replicated PUT", {
        rootCid: meta.cid,
        worstCid: replicaStatus.worstCid,
        minReplicas,
        worst: replicaStatus.worstReplicaCount,
      })
    }

    const result: IpfsAddResult = {
      Name: filename ?? "file",
      Hash: meta.cid,
      Size: meta.size.toString(),
    }
    res.writeHead(200, headers)
    res.end(`${JSON.stringify(result)}\n`)
  }

  /**
   * #468: directory-DAG upload. Builds a UnixFS directory tree from the
   * multipart parts via `ipfs-unixfs-importer` (which auto-shards large
   * directories into HAMT nodes), pins every emitted block, and streams a
   * kubo-style NDJSON response — one `{Name,Hash,Size}` line per file and
   * sub-directory, the wrapping root directory last.
   */
  private async handleAddDirectory(
    res: http.ServerResponse,
    parts: MultipartPart[],
    erasureSpec?: string,
  ): Promise<void> {
    // Erasure coding operates on a single file's bytes — it has no
    // meaning for a directory tree. Reject the combination explicitly.
    if (erasureSpec) {
      throw new HttpError(400, "unsupported_param",
        "erasure coding and wrap-with-directory are mutually exclusive")
    }

    const entries: DirEntryInput[] = parts.map((p) =>
      p.isDir
        ? { path: p.path ?? "" }
        : { path: p.path ?? "file", content: p.bytes },
    )

    const adapter = new InterfaceBlockstoreAdapter(this.store, { maxBlockReads: MAX_BLOCK_READS })
    const imported = await buildDirectoryDag(entries, adapter)

    // Recursively pin every node the importer emitted. COC's blockstore
    // GC is flat (it does not walk a pinned root's children), so each
    // directory + file-root CID must be pinned explicitly to survive
    // `repo/gc`.
    for (const node of imported.all) {
      await this.store.pin(node.cid)
    }

    // kubo NDJSON: one JSON object per line, children first, root last.
    res.writeHead(200, { "content-type": "application/json" })
    for (const node of imported.all) {
      const line: IpfsAddResult = {
        Name: node.path,
        Hash: node.cid,
        Size: String(node.size),
      }
      res.write(`${JSON.stringify(line)}\n`)
    }
    res.end()
  }

  /**
   * Collect per-chunk replication status for the just-PUT DAG. Returns
   * null when the wiring isn't attached (replication gating is a no-op)
   * or when no push promises landed in the awaiter's tracking map
   * (happens on tiny clusters where pushToK skipped due to no peers).
   *
   * `worstReplicaCount` is the minimum successful-replica count across
   * every chunk + root. A single CID under-replicated in a large file
   * trips the warning even if the other 99 chunks landed cleanly —
   * that single missing chunk means the file isn't reliably retrievable.
   */
  private async collectReplicaStatus(
    rootCid: string,
    leafCids: string[],
  ): Promise<{ worstCid: string; worstReplicaCount: number } | null> {
    const awaiter = this.cfg.awaitReplicationResult
    if (!awaiter) return null
    const cidsToCheck = Array.from(new Set([rootCid, ...leafCids]))
    // Parallel awaits — onPut fires pushToK immediately per chunk so
    // these promises are already in flight by the time we get here.
    const results = await Promise.all(cidsToCheck.map(async (cid) => ({
      cid,
      status: await awaiter(cid, 8_000),
    })))
    let worstCid = rootCid
    let worstCount = Infinity
    let anyTracked = false
    for (const { cid, status } of results) {
      if (!status) continue // replication was skipped (no peers) or timed out
      anyTracked = true
      const replicas = status.succeeded.length
      if (replicas < worstCount) {
        worstCount = replicas
        worstCid = cid
      }
    }
    if (!anyTracked) return null
    return { worstCid, worstReplicaCount: worstCount === Infinity ? 0 : worstCount }
  }

  private async handleVersion(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      Version: "0.1.0-coc",
      Commit: "",
      Repo: "coc-ipfs",
      System: process.platform,
      Golang: "n/a",
    }))
  }

  private async handleId(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      ID: this.cfg.nodeId ?? "coc-node",
      Addresses: [`/ip4/${this.cfg.bind}/tcp/${this.cfg.port}`],
      AgentVersion: "coc-ipfs/0.1.0",
      ProtocolVersion: "ipfs/0.1.0",
    }))
  }

  private async handleStat(res: http.ServerResponse): Promise<void> {
    const stats = await this.store.stat()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      RepoSize: stats.repoSize,
      StorageMax: "0",
      NumObjects: stats.numBlocks,
      RepoPath: "<redacted>",
      Version: "0.1.0-coc",
    }))
  }

  private parseCidPathArg(res: http.ServerResponse, arg?: string): { cid: string; path: string[] } | null {
    if (!arg) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "missing cid" }))
      return null
    }
    const parsed = splitCidPath(arg)
    if (!isValidCid(parsed.cid)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "invalid cid" }))
      return null
    }
    if (parsed.path.some((segment) => segment === "." || segment === "..")) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "invalid path" }))
      return null
    }
    return parsed
  }

  /**
   * Shared wrapper around {@link resolveCidPath}:
   *   - validates the bare CID arg (write 400 + return null on bad shape)
   *   - splits `<cid>/<sub/path>` form into CID + path segments
   *   - delegates to {@link resolveCidPath}
   * `opts.localOnly` is forwarded so callers can suppress fetchRemote
   * on the public read tier (#8). `opts.probeDirectory: false` (#310)
   * keeps block-level endpoints off the directory walker.
   */
  private async resolveCidPathArg(
    res: http.ServerResponse,
    arg?: string,
    opts?: { probeDirectory?: boolean; localOnly?: boolean },
  ): Promise<ResolvedCidPath | null> {
    const parsed = this.parseCidPathArg(res, arg)
    if (!parsed) return null
    try {
      return await this.resolveCidPath(parsed.cid, parsed.path, opts)
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
        res.writeHead(err.status, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: err.code, message: err.message }))
        return null
      }
      throw err
    }
  }

  /**
   * #468: resolve `<rootCid>` plus optional path segments to a single DAG
   * node. Walks UnixFS directory DAGs (plain + HAMT) by Link name. For a
   * bare CID that resolves to a directory the entry is attached so
   * `ls`/`object/stat`/gateway can navigate it; bare file / non-UnixFS
   * CIDs return without an entry so the existing file-meta / `readByCid`
   * path handles them unchanged.
   *
   * Retains PR #704's numeric chunk-link fallback: `<file-cid>/<n>`
   * addresses chunk leaf `n` via the file-meta leaf table.
   */
  private async resolveCidPath(
    rootCid: string,
    path: string[],
    opts?: { probeDirectory?: boolean; localOnly?: boolean },
  ): Promise<ResolvedCidPath> {
    // `probeDirectory: false` keeps block-level endpoints (block/stat,
    // block/get) off the UnixFS DAG walker entirely — block/stat must
    // stay a local-only metadata query (#310: no fetchRemote on miss).
    const probeDirectory = opts?.probeDirectory !== false
    // #8: anonymous read paths pass `localOnly: true` so the directory
    // walker can't be weaponized as a DHT-reflection amplifier on
    // unknown CIDs. Admin paths leave it false for transparent peer fetch.
    const localOnly = opts?.localOnly === true
    const adapter = new InterfaceBlockstoreAdapter(this.store, { maxBlockReads: MAX_BLOCK_READS, localOnly })
    const signal = AbortSignal.timeout(IPFS_RESOLVE_TIMEOUT_MS)

    if (!probeDirectory) {
      // Block endpoints: bare CID resolves to itself; a subpath only
      // resolves via the fetch-free numeric chunk-link table (#704).
      if (path.length === 0) return { rootCid, cid: rootCid, path: [] }
      if (path.length === 1 && /^[0-9]+$/.test(path[0])) {
        const numeric = await this.resolveNumericLeaf(rootCid, path)
        if (numeric) return numeric
      }
      throw new HttpError(404, "no such file", `no link named '${path[0]}' under ${rootCid}`)
    }

    if (path.length === 0) {
      // Bare CID: probe for a UnixFS directory. Files / non-UnixFS CIDs
      // (raw blocks, erasure manifests, missing blocks) fall through with
      // no entry — the existing readByCid / file-meta path handles them.
      try {
        const entry = await resolveUnixfsPath(rootCid, [], adapter, signal)
        if (entry.type === "directory") {
          return { rootCid, cid: rootCid, path: [], entry }
        }
      } catch (err) {
        // A resource limit (read-budget exhausted / resolve timeout) is a
        // real failure — surface it instead of swallowing it and letting
        // the bare-CID path turn it into a misleading 500. Ordinary
        // "not navigable as UnixFS" errors fall through as before.
        const limit = resolveLimitError(err, signal)
        if (limit) throw limit
      }
      return { rootCid, cid: rootCid, path: [] }
    }

    try {
      const entry = await resolveUnixfsPath(rootCid, path, adapter, signal)
      return { rootCid, cid: entry.cid, path, entry }
    } catch (err) {
      if (err instanceof PathResolveError) {
        // A subpath directly under a file/raw root (depth 0): PR #704's
        // numeric chunk-link fallback applies. A single numeric segment
        // addresses chunk leaf `n`; anything else is a genuine miss.
        if (err.kind === "not_a_directory" && err.depth === 0) {
          if (path.length === 1 && /^[0-9]+$/.test(path[0])) {
            const numeric = await this.resolveNumericLeaf(rootCid, path)
            if (numeric) return numeric
          }
          throw new HttpError(404, "no such file", `no link named '${path[0]}' under ${rootCid}`)
        }
        // Mid-path non-directory → 400; missing component → 404.
        if (err.kind === "not_a_directory") {
          throw new HttpError(400, "not a directory", err.message)
        }
        throw new HttpError(404, "no such file", err.message)
      }
      // Read-budget / timeout → 504, not an opaque 500.
      const limit = resolveLimitError(err, signal)
      if (limit) throw limit
      throw err
    }
  }

  /** PR #704 numeric chunk-link lookup — `<file-cid>/<n>` → leaf `n`. */
  private async resolveNumericLeaf(rootCid: string, path: string[]): Promise<ResolvedCidPath | null> {
    const index = Number(path[0])
    const meta = await this.readFileMeta()
    const file = meta[rootCid]
    if (!Number.isSafeInteger(index) || !file || index < 0 || index >= file.leaves.length) {
      return null
    }
    const leafSize = index === file.leaves.length - 1
      ? file.size - file.blockSize * (file.leaves.length - 1)
      : file.blockSize
    return { rootCid, cid: file.leaves[index], path, leafIndex: index, leafSize }
  }

  /** #468: enumerate a resolved directory entry's children, under a hard
   * timeout so a maliciously huge / sharded directory can't hang. */
  private async listResolvedDirectory(entry: ResolvedEntry): Promise<DirectoryLink[]> {
    return listDirectory(entry, AbortSignal.timeout(IPFS_RESOLVE_TIMEOUT_MS))
  }

  private async handleLs(req: http.IncomingMessage, res: http.ServerResponse, cid?: string): Promise<void> {
    const localOnly = this.isLocalOnlyRead(req)
    const resolved = await this.resolveCidPathArg(res, cid, { localOnly })
    if (!resolved) {
      return
    }
    if (resolved.leafIndex !== undefined) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        Objects: [
          {
            Hash: resolved.cid,
            Links: [],
          },
        ],
      }))
      return
    }
    // #468: a CID/path that resolved through the UnixFS DAG walker.
    if (resolved.entry) {
      if (resolved.entry.type === "directory") {
        const links = await this.listResolvedDirectory(resolved.entry)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          Objects: [{
            Hash: resolved.cid,
            // kubo UnixFS ls Type enum: 1 = directory, 2 = file.
            Links: links.map((l) => ({
              Name: l.name,
              Hash: l.cid,
              Size: l.size,
              Type: l.type === "directory" ? 1 : 2,
            })),
          }],
        }))
        return
      }
      // A file resolved via a directory subpath has no file-meta entry.
      // kubo `ls` of a plain file CID returns it with no links.
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ Objects: [{ Hash: resolved.cid, Links: [] }] }))
      return
    }
    const meta = await this.readFileMeta()
    const file = meta[resolved.cid]
    if (!file) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: "file not found" }))
      return
    }
    // #134: kubo's /api/v0/ls Size field is the cumulative byte size
    // of the linked DAG. For terminal leaves that's the chunk's data
    // size, derivable from file.blockSize without extra block IO:
    //   leaves[0..n-1) each have `blockSize` bytes
    //   leaves[n-1] (last) has the remainder: size - blockSize*(n-1)
    // Pre-fix every leaf was hardcoded Size:0, breaking kubo client
    // progress accounting and Pinata/Web3.storage SDK size summation.
    const totalSize = file.size
    const chunkSize = file.blockSize
    const leafCount = file.leaves.length
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      Objects: [
        {
          Hash: resolved.cid,
          Links: file.leaves.map((leaf, index) => ({
            Name: String(index),
            Hash: leaf,
            Size: leafCount > 0 && index === leafCount - 1
              ? totalSize - chunkSize * (leafCount - 1)
              : chunkSize,
            Type: 2,
          })),
        }
      ],
    }))
  }

  private async handleObjectStat(req: http.IncomingMessage, res: http.ServerResponse, cid?: string): Promise<void> {
    const localOnly = this.isLocalOnlyRead(req)
    const resolved = await this.resolveCidPathArg(res, cid, { localOnly })
    if (!resolved) {
      return
    }
    // #468: a resolved UnixFS directory — report NumLinks from the live
    // child listing rather than the file-meta leaf table.
    if (resolved.entry?.type === "directory") {
      const links = await this.listResolvedDirectory(resolved.entry)
      const block = await this.store.get(resolved.cid, { localOnly })
      // kubo's CumulativeSize is the *recursive* byte size of the whole
      // subtree. Computing that exactly needs a full subtree walk — too
      // costly for a stat call — so report a lower-bound approximation:
      // the directory block plus the byte sizes of immediate *file*
      // children. A directory child's `size` is an entry count, not a
      // byte count, so it is deliberately excluded rather than summed
      // with the wrong unit.
      const immediateFileBytes = links.reduce(
        (sum, l) => sum + (l.type === "file" ? l.size : 0), 0)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        Hash: resolved.cid,
        NumLinks: links.length,
        BlockSize: block.bytes.length,
        LinksSize: Math.min(links.length * 36, block.bytes.length),
        DataSize: resolved.entry.size,
        CumulativeSize: block.bytes.length + immediateFileBytes,
      }))
      return
    }
    // #230: pre-fix the bare `store.get(cid)` call let ENOENT bubble
    // out as 500 "internal error" when the block was shape-valid but
    // not present locally. The sibling handleCat correctly maps this
    // to 404 via isNotFoundError. Mirror that here so observers
    // probing for a CID can distinguish "we don't have it" (404)
    // from a real server fault (500).
    let block: Awaited<ReturnType<typeof this.store.get>>
    try {
      block = await this.store.get(resolved.cid, { localOnly })
    } catch (err) {
      if (isNotFoundError(err)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "block not found" }))
        return
      }
      throw err
    }
    const meta = await this.readFileMeta()
    const file = meta[resolved.cid]
    // #134: DataSize and LinksSize were hardcoded to 0. For UnixFS
    // files, DataSize is the user-data byte count exposed by `ls`;
    // LinksSize is a rough estimate of CID-reference bytes. The
    // important field for clients summing file sizes is DataSize.
    const numLinks = resolved.leafSize !== undefined ? 0 : file?.leaves.length ?? 0
    const linksSize = numLinks > 0 ? Math.min(numLinks * 36, block.bytes.length) : 0
    const dataSize = resolved.leafSize ?? file?.size ?? Math.max(block.bytes.length - linksSize, 0)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      Hash: resolved.cid,
      NumLinks: numLinks,
      BlockSize: block.bytes.length,
      LinksSize: linksSize,
      DataSize: dataSize,
      CumulativeSize: file?.size ?? block.bytes.length,
    }))
  }

  private async handleCat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cid?: string,
    range?: { offset?: string; length?: string },
  ): Promise<void> {
    const localOnly = this.isLocalOnlyRead(req)
    const resolved = await this.resolveCidPathArg(res, cid, { localOnly })
    if (!resolved) {
      return
    }
    // #174: pre-fix the offset/length/count query params were accepted
    // by kubo's spec but the handler ignored them, returning the full
    // file regardless. Worse, malformed values (negative, non-numeric)
    // silently passed through. Validate + slice now.
    // #426: `Number.isFinite(n) && Number.isInteger(n)` accepted values
    // over `MAX_SAFE_INTEGER` (e.g. `offset=999999999999999999999`).
    // `Number("999…")` → 1e21, and `Number.isInteger(1e21)` is true
    // because the precision-lost value happens to be an integer in
    // JS-number space, just not the integer the user wrote.
    // `buf.subarray(1e21)` then returns an empty slice and the request
    // comes back as `HTTP 200` + empty body — indistinguishable from
    // "valid offset past EOF". Tighten to `Number.isSafeInteger`.
    let offset = 0
    let length: number | undefined
    if (range?.offset !== undefined) {
      const n = Number(range.offset)
      if (!Number.isSafeInteger(n) || n < 0) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid offset: must be a non-negative integer" }))
        return
      }
      offset = n
    }
    if (range?.length !== undefined) {
      const n = Number(range.length)
      if (!Number.isSafeInteger(n) || n < 0) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid length: must be a non-negative integer" }))
        return
      }
      length = n
    }
    // #468: `cat` of a directory CID is an error in kubo too.
    if (resolved.entry?.type === "directory") {
      throw new HttpError(400, "this dag node is a directory",
        `${resolved.cid} is a directory — use /api/v0/ls`)
    }
    const data = await this.readResolved(resolved)
    const buf = Buffer.from(data)
    const slice = length !== undefined ? buf.subarray(offset, offset + length) : buf.subarray(offset)
    res.writeHead(200)
    res.end(slice)
  }

  private async handleGet(req: http.IncomingMessage, res: http.ServerResponse, cid?: string): Promise<void> {
    const localOnly = this.isLocalOnlyRead(req)
    const resolved = await this.resolveCidPathArg(res, cid, { localOnly })
    if (!resolved) {
      return
    }
    // #468: `get` of a directory streams a tar of every file in the tree.
    if (resolved.entry?.type === "directory") {
      const files = await this.collectDirectoryFiles(resolved.entry, "", { bytes: 0, files: 0, nodes: 0 }, 0, localOnly)
      const archive = createTarArchive(files)
      res.writeHead(200, { "content-type": "application/x-tar" })
      res.end(archive)
      return
    }
    const data = await this.readResolved(resolved)
    const archive = createTarArchive([{ name: resolved.cid, data }])
    res.writeHead(200, { "content-type": "application/x-tar" })
    res.end(archive)
  }

  /**
   * #468: read a resolved entry's bytes. A file resolved through the
   * UnixFS DAG walker uses the exporter (handles arbitrary DAG depth);
   * a bare CID / numeric chunk-link falls back to `readByCid` (codec
   * dispatch: raw / erasure / single-level UnixFS).
   */
  private async readResolved(resolved: ResolvedCidPath): Promise<Uint8Array> {
    if (resolved.entry && resolved.entry.type !== "directory") {
      return readEntryBytes(resolved.entry, undefined, AbortSignal.timeout(IPFS_RESOLVE_TIMEOUT_MS))
    }
    return this.readByCid(resolved.cid)
  }

  /**
   * #468: recursively collect every file in a resolved directory tree as
   * `{ name, data }` tar entries, the name being the file's path relative
   * to the directory root.
   *
   * `acc` is a single object shared across the whole recursion so the
   * cumulative byte count, file count, and node count are bounded
   * globally (not just per-file); `depth` is per-branch. Exceeding any of
   * {@link MAX_DIRECTORY_GET_BYTES} / {@link MAX_DIRECTORY_GET_FILES} /
   * {@link MAX_DIRECTORY_GET_NODES} / {@link MAX_DIRECTORY_GET_DEPTH}
   * aborts the request — without this a malicious wide/deep directory CID
   * could exhaust node memory or pin the handler on an enormous traversal.
   */
  private async collectDirectoryFiles(
    dir: ResolvedEntry,
    prefix: string,
    acc: { bytes: number; files: number; nodes: number },
    depth: number,
    localOnly = false,
  ): Promise<Array<{ name: string; data: Uint8Array }>> {
    if (depth > MAX_DIRECTORY_GET_DEPTH) {
      throw new HttpError(400, "directory too deep",
        `directory nesting exceeds ${MAX_DIRECTORY_GET_DEPTH} levels`)
    }
    const out: Array<{ name: string; data: Uint8Array }> = []
    const links = await this.listResolvedDirectory(dir)
    for (const link of links) {
      // Count every entry — file or directory — so a tree made purely of
      // empty sub-directories (which never touches the byte/file caps) is
      // still bounded. Checked before the resolve so the (n+1)-th node's
      // blocks are never fetched.
      acc.nodes += 1
      if (acc.nodes > MAX_DIRECTORY_GET_NODES) {
        throw new HttpError(413, "directory too large",
          `directory tree exceeds ${MAX_DIRECTORY_GET_NODES} nodes`)
      }
      const childPath = prefix ? `${prefix}/${link.name}` : link.name
      const adapter = new InterfaceBlockstoreAdapter(this.store, { maxBlockReads: MAX_BLOCK_READS, localOnly })
      const child = await resolveUnixfsPath(link.cid, [], adapter,
        AbortSignal.timeout(IPFS_RESOLVE_TIMEOUT_MS))
      if (child.type === "directory") {
        out.push(...await this.collectDirectoryFiles(child, childPath, acc, depth + 1, localOnly))
      } else {
        const data = await readEntryBytes(child, undefined, AbortSignal.timeout(IPFS_RESOLVE_TIMEOUT_MS))
        acc.files += 1
        acc.bytes += data.length
        if (acc.files > MAX_DIRECTORY_GET_FILES) {
          throw new HttpError(413, "directory too large",
            `directory tar exceeds ${MAX_DIRECTORY_GET_FILES} files`)
        }
        if (acc.bytes > MAX_DIRECTORY_GET_BYTES) {
          throw new HttpError(413, "directory too large",
            `directory tar exceeds ${MAX_DIRECTORY_GET_BYTES} bytes`)
        }
        out.push({ name: childPath, data })
      }
    }
    return out
  }

  /**
   * #468: gateway response for a directory CID. Serves `index.html` when
   * present (the canonical browser-dApp / static-site pattern), otherwise
   * returns a JSON directory listing.
   */
  private async serveGatewayDirectory(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    dir: ResolvedEntry,
  ): Promise<void> {
    const localOnly = this.isLocalOnlyRead(req)
    const links = await this.listResolvedDirectory(dir)
    const index = links.find((l) => l.name === "index.html" && l.type === "file")
    if (index) {
      const adapter = new InterfaceBlockstoreAdapter(this.store, { maxBlockReads: MAX_BLOCK_READS, localOnly })
      const child = await resolveUnixfsPath(index.cid, [], adapter,
        AbortSignal.timeout(IPFS_RESOLVE_TIMEOUT_MS))
      const data = await readEntryBytes(child, undefined, AbortSignal.timeout(IPFS_RESOLVE_TIMEOUT_MS))
      const headers: http.OutgoingHttpHeaders = {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(data.length),
        "access-control-allow-origin": "*",
      }
      res.writeHead(200, headers)
      res.end(req.method === "HEAD" ? undefined : data)
      return
    }
    const body = JSON.stringify({
      Type: "directory",
      Hash: dir.cid,
      Links: links.map((l) => ({
        Name: l.name,
        Hash: l.cid,
        Size: l.size,
        Type: l.type === "directory" ? 1 : 2,
      })),
    })
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "access-control-allow-origin": "*",
    })
    res.end(req.method === "HEAD" ? undefined : body)
  }

  /**
   * Phase Q.3+Q.4: dispatch a CID to the right reader by codec.
   * - dag-cbor → erasure manifest path (parses + reconstructs from shards)
   * - dag-pb   → UnixFS reader (existing behaviour)
   * - raw      → return the raw block bytes verbatim
   *
   * `resolveCid` already inspects the codec and pre-fetches the manifest
   * (when applicable) so we don't re-fetch.
   */
  private async readByCid(cid: string): Promise<Uint8Array> {
    let resolved
    try {
      resolved = await resolveCid(cid, this.store)
    } catch (err) {
      if (err instanceof ErasureError) {
        if (err.code === "not_found") throw new HttpError(404, "block not found")
        if (err.code === "invalid_cid" || err.code === "unsupported_codec") {
          throw new HttpError(400, err.code)
        }
        if (err.code === "not_a_manifest") {
          throw new HttpError(415, err.code, err.message)
        }
        throw new HttpError(500, err.code, err.message)
      }
      throw err
    }

    if (resolved.kind === "raw") {
      return resolved.bytes!
    }
    if (resolved.kind === "erasure") {
      try {
        return await readErasureFile(resolved.manifest!, this.store)
      } catch (err) {
        if (err instanceof ErasureError && err.code === "insufficient_shards") {
          throw new HttpError(503, "insufficient_shards", err.message)
        }
        throw err
      }
    }
    // unixfs path
    try {
      return await this.unixfs.readFile(cid)
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpError(404, "block not found")
      throw err
    }
  }

  private async handleErasureStatus(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid || !isValidCid(cid)) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: !cid ? "missing cid" : "invalid cid" }))
      return
    }
    let resolved
    try {
      resolved = await resolveCid(cid, this.store)
    } catch (err) {
      if (err instanceof ErasureError && err.code === "not_found") {
        throw new HttpError(404, "block not found")
      }
      throw err
    }
    if (resolved.kind !== "erasure") {
      throw new HttpError(415, "not_a_manifest", `CID ${cid} is not an erasure manifest`)
    }
    const status = await erasureStatus(resolved.manifest!, this.store)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(status))
  }

  private async handleBlockPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Use readMultipartFile so kubo-standard multipart uploads
    // (Content-Type: multipart/form-data; boundary=...) get parsed —
    // otherwise the entire envelope is stored as block bytes. The helper
    // falls back to readBody for raw-body POSTs, so existing callers that
    // PUT plain bytes keep working.
    const { bytes: body } = await readMultipartFile(req)
    const block = await storeRawBlock(this.store, body)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Key: block.cid, Size: block.bytes.length }))
  }

  private async handleBlockGet(_req: http.IncomingMessage, res: http.ServerResponse, cid?: string): Promise<void> {
    // #468: block endpoints operate on blocks, not the UnixFS DAG — keep
    // them off the directory walker (block/stat must not fetchRemote).
    const resolved = await this.resolveCidPathArg(res, cid, { probeDirectory: false })
    if (!resolved) {
      return
    }
    // #168: pre-fix ENOENT for missing blocks propagated to the outer
    // 500 handler. Map to 404 so missing-block looks like missing-block.
    try {
      const block = await loadRawBlock(this.store, resolved.cid)
      res.writeHead(200)
      res.end(block.bytes)
    } catch (err) {
      if (isNotFoundError(err)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "block not found" }))
      } else {
        throw err
      }
    }
  }

  private async handleBlockStat(res: http.ServerResponse, cid?: string): Promise<void> {
    // #310/#468: block/stat is a local-only metadata query — never walk
    // the UnixFS DAG (would call store.get → fetchRemote on a miss).
    const resolved = await this.resolveCidPathArg(res, cid, { probeDirectory: false })
    if (!resolved) {
      return
    }
    // #310: kubo `block/stat` is a LOCAL metadata query. Pre-fix it routed
    // through `loadRawBlock` → `store.get` which calls `fetchRemote` (DHT
    // findProviders + 5s per-provider timeout + fallback to every
    // connected peer) on any local miss. Any client probing for an unknown
    // CID therefore waited ~5-10s for a 404, and an unauthenticated
    // attacker could pin ~100 wire-connection slots per minute (rate-limit
    // budget) by spraying unknown CIDs — a soft DoS surface on a "stat"
    // endpoint that semantically should never touch the network. Short-
    // circuit via `store.has()` so block/stat is a cheap fs.access check;
    // block/get keeps its network-fetch behaviour because that's the whole
    // point of bitswap-style block retrieval. TOCTOU: if GC races between
    // has() and loadRawBlock, the ENOENT branch still maps to 404, so the
    // worst case is one fetchRemote attempt (acceptable, vs. one EVERY
    // unknown-cid stat pre-fix).
    if (!(await this.store.has(resolved.cid))) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "block not found" }))
      return
    }
    // #168: same ENOENT → 404 mapping as handleBlockGet.
    try {
      const block = await loadRawBlock(this.store, resolved.cid)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ Key: block.cid, Size: block.bytes.length }))
    } catch (err) {
      if (isNotFoundError(err)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "block not found" }))
      } else {
        throw err
      }
    }
  }

  private async handlePinAdd(_req: http.IncomingMessage, res: http.ServerResponse, cids: string[]): Promise<void> {
    // #372: batch shape. Pre-fix only the first arg was processed; clients
    // batching `?arg=cid1&arg=cid2&…` got `{Pins:[cid1]}` and assumed
    // success while cid2..N never pinned (silent data loss).
    if (cids.length === 0) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    // Validate all CIDs first — fail-fast on any malformed input so we
    // don't half-pin (mirror kubo's atomic-batch semantics).
    for (const cid of cids) {
      if (!isValidCid(cid)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid cid" }))
        return
      }
    }
    // #280: pre-fix accepted any well-formed CID without requiring the
    // block to be stored locally. Attackers could mass-submit valid-format
    // CIDs to grow pins.json unboundedly (each pin add rewrites the whole
    // file → disk-fill + write-amplification DoS). Kubo's offline mode
    // returns "block not found locally" in the same scenario; mirror
    // that: pinning is allowed only for blocks already present in the
    // local store (put + pin → pin/add must check existence first).
    for (const cid of cids) {
      if (!(await this.store.has(cid))) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "block not found locally", message: `cid not local: ${cid}` }))
        return
      }
    }
    for (const cid of cids) {
      await this.store.pin(cid)
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Pins: cids }))
  }

  /**
   * #126: kubo-compatible `/api/v0/pin/rm?arg=<cid>`. Idempotent — if
   * the CID was never pinned, returns 404 to match kubo. The block
   * file itself stays on disk; call `/api/v0/repo/gc` or
   * `/api/v0/block/rm` to evict bytes.
   */
  private async handlePinRm(res: http.ServerResponse, cids: string[]): Promise<void> {
    // #372: batch shape. Pre-fix only the first arg was unpinned; CIDs
    // 2..N silently stayed pinned despite client expecting them gone.
    if (cids.length === 0) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    for (const cid of cids) {
      if (!isValidCid(cid)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid cid" }))
        return
      }
    }
    // Pre-check all CIDs are pinned (atomic-batch semantic) so a typo in
    // arg=N doesn't half-unpin and leave the caller confused. Use a
    // single listPins() snapshot + Set lookup rather than N store calls.
    const pinned = new Set(await this.store.listPins())
    for (const cid of cids) {
      if (!pinned.has(cid)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "not pinned", message: `cid not pinned: ${cid}` }))
        return
      }
    }
    for (const cid of cids) {
      await this.store.unpin(cid)
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Pins: cids }))
  }

  /**
   * #126: kubo-compatible `/api/v0/block/rm?arg=<cid>`. Force-evicts
   * the block from disk (and unpins it if pinned) — used by the
   * chaos kill-shard drill to simulate disk loss. Returns the kubo
   * `{Hash, Error}` shape; Error is empty string on success.
   */
  private async handleBlockRm(res: http.ServerResponse, cids: string[]): Promise<void> {
    // #372: batch shape. Pre-fix only the first arg was evicted; rest
    // stayed on disk despite the client expecting wholesale removal.
    // Kubo streams one `{Hash, Error}` JSON line per CID — kubo CLI
    // parses this as ndjson. Match that wire shape so canonical clients
    // see every result. Validation is per-CID (not fail-fast) because
    // kubo continues across malformed args and reports them inline.
    if (cids.length === 0) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    const lines: string[] = []
    for (const cid of cids) {
      if (!isValidCid(cid)) {
        lines.push(JSON.stringify({ Hash: cid, Error: "invalid cid" }))
        continue
      }
      const result = await this.store.removeBlock(cid)
      if (!result.removedFile && !result.wasPinned) {
        lines.push(JSON.stringify({ Hash: cid, Error: "block not found locally" }))
      } else {
        lines.push(JSON.stringify({ Hash: cid, Error: "" }))
      }
    }
    res.end(lines.join("\n"))
  }

  /**
   * #126: kubo-compatible `/api/v0/repo/gc`. Sweeps unpinned blocks
   * from disk. Returns one JSON object per removed CID, one per line
   * (kubo streams these). This is a flat GC — pinning a UnixFS root
   * does not recursively pin its chunks; callers must pin each chunk
   * CID explicitly to keep them across a GC pass.
   */
  private async handleRepoGc(res: http.ServerResponse): Promise<void> {
    const removed = await this.store.gc()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(removed.map((cid) => JSON.stringify({ Key: { "/": cid } })).join("\n"))
  }

  private async handlePinLs(res: http.ServerResponse, cids: string[], type?: string): Promise<void> {
    // #308: validate `type` against the kubo-defined set. COC's pin model
    // only stores recursive pins (no direct/indirect distinction), so
    // type=direct and type=indirect correctly return empty — but invalid
    // types must surface as 400, not silently degrade to "all".
    const allowedTypes = ["all", "direct", "indirect", "recursive"] as const
    type AllowedType = typeof allowedTypes[number]
    let resolvedType: AllowedType = "all"
    if (type !== undefined && type !== "") {
      if (!(allowedTypes as readonly string[]).includes(type)) {
        throw new HttpError(400, `invalid pin type: must be one of ${allowedTypes.join(", ")}`)
      }
      resolvedType = type as AllowedType
    }

    const pins = await this.store.listPins()
    // #372: batch shape. Pre-fix only the first arg was checked; clients
    // batching `?arg=cid1&arg=cid2&…` got back the entry for cid1 only.
    if (cids.length > 0) {
      // Validate shape per-arg first (kubo: 400 invalid_cid stops the batch).
      for (const cid of cids) {
        if (!isValidCid(cid)) throw new HttpError(400, "invalid cid")
      }
      // If the caller filtered by type and our (recursive-only) pin store
      // doesn't match, treat as "not pinned under that type" → 404 with no
      // body. Mirrors kubo: `pin/ls?arg=…&type=direct` returns 404 unless
      // the CID is specifically directly-pinned.
      if (resolvedType === "direct" || resolvedType === "indirect") {
        throw new HttpError(404, `not pinned (no ${resolvedType} pins in this store)`)
      }
      const pinnedSet = new Set(pins)
      // Kubo's pin/ls batch: 404 with the first missing CID in the body.
      for (const cid of cids) {
        if (!pinnedSet.has(cid)) {
          throw new HttpError(404, "not pinned", `cid not pinned: ${cid}`)
        }
      }
      const keys: Record<string, { Type: string }> = {}
      for (const cid of cids) keys[cid] = { Type: "recursive" }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ Keys: keys }))
      return
    }

    // No cid filter: return the recursive pin set unless caller asked for
    // a type COC doesn't store (direct / indirect) → empty Keys map.
    const showRecursive = resolvedType === "all" || resolvedType === "recursive"
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Keys: showRecursive
      ? pins.reduce((acc, c) => { acc[c] = { Type: "recursive" }; return acc }, {} as Record<string, { Type: string }>)
      : {} }))
  }

  private metaPath(): string {
    return join(this.cfg.storageDir, "file-meta.json")
  }

  private fileMetaLock: Promise<void> = Promise.resolve()

  private async saveFileMeta(meta: UnixFsFileMeta): Promise<void> {
    // Serialize concurrent writes to prevent TOCTOU race where two
    // concurrent adds both read the same file-meta.json, each writes
    // their own entry, and the second write silently overwrites the first.
    this.fileMetaLock = this.fileMetaLock.then(async () => {
      await mkdir(this.cfg.storageDir, { recursive: true })
      const all = await this.readFileMeta()
      all[meta.cid] = meta
      const tmpPath = this.metaPath() + ".tmp"
      await writeFile(tmpPath, JSON.stringify(all, null, 2))
      await rename(tmpPath, this.metaPath())
    }).catch(() => { /* prevent lock chain break */ })
    await this.fileMetaLock
  }

  async readFileMeta(): Promise<Record<string, UnixFsFileMeta>> {
    try {
      const raw = await readFile(this.metaPath(), "utf-8")
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {}
      }
      // Use Object.create(null) to prevent prototype pollution from
      // crafted file-meta.json containing __proto__ keys
      const safe: Record<string, UnixFsFileMeta> = Object.create(null)
      for (const key of Object.keys(parsed)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue
        safe[key] = parsed[key]
      }
      return safe
    } catch {
      return {}
    }
  }

  private async handleMfsRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: ReturnType<typeof parseUrl>,
  ): Promise<void> {
    if (!this.mfs) {
      res.writeHead(501)
      res.end(JSON.stringify({ error: "MFS not enabled" }))
      return
    }

    const route = url.pathname?.replace("/api/v0/files/", "") ?? ""
    // #192: dup query params arrive as arrays; coalesce to first.
    const arg = firstQueryValue(url.query?.arg) ?? ""

    try {
      switch (route) {
        case "mkdir": {
          // #380: pre-fix the handler passed empty `arg` (when no ?arg= was
          // supplied) straight to mfs.mkdir(""). normalizePath("") rewrites
          // it to "/", `dirs.has("/")` is always true, and the call returns
          // as a silent no-op — leaving the client a 200 `{ok:true}`
          // response indicating a directory that doesn't exist. The client
          // later `files/write`s into the path and fails with
          // "parent directory not found", masking the original mistake.
          //
          // kubo's CLI rejects empty / root with
          //   Error: argument "path" is required
          // Reject both shapes at the HTTP boundary so silent-success is
          // impossible.
          if (arg.length === 0) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "bad request", message: "missing path argument" }))
            break
          }
          if (arg === "/" || arg === "") {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "bad request", message: "cannot mkdir root path" }))
            break
          }
          const parents = url.query?.parents === "true"
          await this.mfs.mkdir(arg, { parents })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "write": {
          // kubo CLI + js-ipfs send file content as multipart/form-data; raw
          // body uploads (Uint8Array POSTs) also need to work. readMultipartFile
          // handles both: it extracts the file bytes from multipart, or returns
          // raw bytes when the request has no boundary in Content-Type.
          const { bytes: body } = await readMultipartFile(req)
          // #559: pre-fix the HTTP handler forwarded only create/truncate/
          // parents and silently dropped `offset`. The mfs-layer merge
          // branch (`if (existing && !opts?.truncate && opts?.offset !== undefined)`)
          // never ran, so `write?offset=10` to a 5-byte file produced a
          // 2-byte file containing only the new bytes — the pre-offset
          // content was permanently destroyed. Parse offset the same way
          // the sibling `read` handler does (#200/#426): reject non-
          // SafeInteger + negative with 400 invalid offset. Silent-param-
          // drop family as #174/#353/#460/#553 but data-destructive.
          const writeOpts: { create?: boolean; truncate?: boolean; parents?: boolean; offset?: number } = {
            create: url.query?.create === "true",
            truncate: url.query?.truncate === "true",
            parents: url.query?.parents === "true",
          }
          const writeOffsetRaw = firstQueryValue(url.query?.offset)
          if (writeOffsetRaw !== undefined) {
            const n = Number(writeOffsetRaw)
            if (!Number.isSafeInteger(n) || n < 0) {
              throw new HttpError(400, "invalid offset")
            }
            writeOpts.offset = n
          }
          await this.mfs.write(arg, body, writeOpts)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "read": {
          // Forward offset/count to IpfsMfs.read so partial reads work as
          // kubo CLI + js-ipfs expect. Pre-fix the params were silently
          // dropped and every read returned the whole file. The
          // route-level catch (below) maps MFS "not found" / "is a
          // directory" errors to structured 4xx for every MFS endpoint.
          const offsetRaw = url.query?.offset
          const countRaw = url.query?.count
          const opts: { offset?: number; count?: number } = {}
          // #200: pre-fix offset only checked `!Number.isFinite(n)`, so
          // negative or fractional values silently flowed to mfs.read and
          // either surfaced as 500 "internal error" or returned surprising
          // data. Match the (already correct) handleCat rule so MFS read
          // and unixfs cat share the same kubo-compatible shape contract.
          // #426: same MAX_SAFE_INTEGER hazard as the cat handler — values
          // like `999999999999999999999` slipped through because
          // `Number.isInteger(1e21)` is true after precision loss. Tighten
          // to `Number.isSafeInteger`.
          if (offsetRaw !== undefined) {
            const n = Number(offsetRaw)
            if (!Number.isSafeInteger(n) || n < 0) {
              throw new HttpError(400, "invalid offset")
            }
            opts.offset = n
          }
          if (countRaw !== undefined) {
            const n = Number(countRaw)
            if (!Number.isSafeInteger(n) || n < 0) {
              throw new HttpError(400, "invalid count")
            }
            opts.count = n
          }
          const data = await this.mfs.read(arg, opts)
          res.writeHead(200)
          res.end(data)
          break
        }
        case "ls": {
          const entries = await this.mfs.ls(arg || "/")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({
            Entries: entries.map((e) => ({
              Name: e.name,
              Type: e.type === "directory" ? 1 : 0,
              Size: e.size,
              Hash: e.cid,
            })),
          }))
          break
        }
        case "rm": {
          const recursive = url.query?.recursive === "true"
          await this.mfs.rm(arg, { recursive })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "mv": {
          // #236: kubo HTTP RPC sends two ?arg= values for src + dest.
          // Pre-fix this read `?dest=` (which kubo never sends) so the
          // dest was always "" → mfs.mv("/src","") → splitPath("/")
          // throws "cannot operate on root path directly" → 500 leak.
          const source = arg
          const dest = nthQueryValue(url.query?.arg, 1) ?? firstQueryValue(url.query?.dest) ?? ""
          if (!source || !dest) {
            throw new HttpError(400, "bad request", "mv requires two ?arg= values: source and destination")
          }
          await this.mfs.mv(source, dest)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "cp": {
          // #236: same kubo HTTP RPC contract as mv — two ?arg= values.
          // Keep `?dest=` as legacy fallback for any internal caller
          // still relying on the old shape.
          const source = arg
          const dest = nthQueryValue(url.query?.arg, 1) ?? firstQueryValue(url.query?.dest) ?? ""
          if (!source || !dest) {
            throw new HttpError(400, "bad request", "cp requires two ?arg= values: source and destination")
          }
          await this.mfs.cp(source, dest)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "stat": {
          // #158: pre-fix this serialized the internal MfsStat shape
          // (hash/size/cumulativeSize/type/blocks — camelCase) directly,
          // breaking kubo-compat clients like ipfs-http-client which
          // expect PascalCase Hash/Size/CumulativeSize/Type/Blocks. The
          // sibling `files/ls` handler already does the right mapping;
          // align stat with that convention.
          const stat = await this.mfs.stat(arg || "/")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({
            Hash: stat.hash,
            Size: stat.size,
            CumulativeSize: stat.cumulativeSize,
            Type: stat.type,
            Blocks: stat.blocks,
          }))
          break
        }
        case "flush": {
          const cid = await this.mfs.flush(arg || "/")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ Cid: cid }))
          break
        }
        default:
          res.writeHead(404)
          res.end(JSON.stringify({ error: `unknown MFS command: ${route}` }))
      }
    } catch (err) {
      // Mirror the main catch's HttpError handling so routes can opt into
      // structured 4xx responses (e.g. read of a missing path → 404).
      // For routes that throw a plain Error from IpfsMfs (e.g. "not found:
      // /x", "is a directory: /y", "parent directory not found: /z"),
      // promote those well-known message prefixes to 4xx here so every MFS
      // endpoint is consistent — clients can rely on stat/cp/mv/rm/ls all
      // emitting 404 for user typos instead of opaque 500s.
      let httpErr = err instanceof HttpError ? err : null
      if (!httpErr && err instanceof Error) {
        const msg = err.message
        // 404: any error message mentioning "not found" (e.g. "not found:",
        // "parent directory not found:", "file not found:", "source not
        // found:", "destination directory not found:").
        if (/not found/i.test(msg)) {
          httpErr = new HttpError(404, "not found", msg)
        } else if (
          /is a directory/i.test(msg) ||
          // #543: mkdir on (or under) an existing file path throws the #302
          // file-collision guard's `not a directory: <path>`. The chain had
          // `/is a directory/` (the inverse phrase) but no `/not a directory/`,
          // so the collision leaked as 500 "internal error" + an ERROR log
          // line per probe. Same regex-mismatch family as #232/#268/#270.
          /^not a directory/i.test(msg) ||
          /directory not empty/i.test(msg) ||
          // #270: sibling of `cannot copy directory into its own subdirectory`
          // — mfs.mv throws the same shape with `move` instead of `copy`. The
          // alternation was missing `move` so /files/mv falls through to 500
          // with the generic "internal error" body (and an ERROR log line per
          // probe). Same regex-mismatch family as #232/#268/#543.
          /^cannot (remove|operate on|copy|move)/i.test(msg) ||
          // #420: cp/mv reject src===dst with "source and destination are
          // the same: <path>" — map to 400 client-input error.
          /^source and destination are the same/i.test(msg) ||
          /must be/i.test(msg) ||
          /^missing /i.test(msg) ||
          /^write would exceed/i.test(msg) ||
          /^max mfs depth/i.test(msg) ||
          // #268: pre-fix `/^max mfs depth/i` was the only depth-cap regex
          // but normalizePath actually throws "path too deep (max N
          // components)" and the recursive helpers throw "directory
          // nesting too deep (max N)". Neither matched the existing regex,
          // so deep paths surfaced as 500 "internal error" + an ERROR log
          // line per probe. Same regex-mismatch family as #232.
          /^path too deep/i.test(msg) ||
          /^directory nesting too deep/i.test(msg) ||
          /^path too long/i.test(msg) ||
          /^null byte in path/i.test(msg) ||
          // #418: whitespace-only path components rejected at normalizePath
          // — map to 400 (sibling of path-traversal / null-byte / depth caps).
          /^path component cannot be whitespace-only/i.test(msg) ||
          // #232: pre-fix normalizePath threw `Error("path traversal not
          // allowed: ...")` for any input containing `..`, but the
          // catch had no regex for it → 500 "internal error" instead of
          // the 400 that path-too-long / null-byte / max-depth siblings
          // already emit. Treat as client-input error.
          /^path traversal/i.test(msg) ||
          /^invalid /i.test(msg) ||
          // #539: `mv` / `cp` reject existing destination (data-loss
          // prevention, kubo parity). Map to 400 same as the other
          // client-input-error siblings.
          /^destination already exists/i.test(msg) ||
          // #600: `mkdir` without parents=true on existing path now errors
          // with kubo parity ("file already exists: <path>"). Same shape
          // as the #539 destination guard — client-input error.
          /^file already exists/i.test(msg)
        ) {
          httpErr = new HttpError(400, "bad request", msg)
        }
      }
      const status = httpErr ? httpErr.status : 500
      const code = httpErr ? httpErr.code : "internal error"
      const message = httpErr && httpErr.message !== code ? httpErr.message : undefined
      if (status >= 500) {
        log.error("MFS route failed", { error: String(err) })
      } else {
        log.warn("MFS request rejected", { status, code })
      }
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json" })
      }
      try {
        res.end(JSON.stringify(message ? { error: code, message } : { error: code }))
      } catch { /* connection already closed */ }
    }
  }

  private async handlePubsubRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: ReturnType<typeof parseUrl>,
  ): Promise<void> {
    if (!this.pubsub) {
      res.writeHead(501)
      res.end(JSON.stringify({ error: "Pubsub not enabled" }))
      return
    }

    const route = url.pathname?.replace("/api/v0/pubsub/", "") ?? ""
    // #192: dup query params arrive as arrays; coalesce to first.
    const topic = firstQueryValue(url.query?.arg) ?? ""

    try {
      // Validate topic length to prevent memory exhaustion via oversized topic names
      if (topic.length > 512) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "topic too long (max 512 chars)" }))
        return
      }

      // Reject control characters (#312/#313): a NUL byte or other control codes in the
      // topic round-trip through libp2p but cause subscribers' string-based topic filters
      // to silently mismatch, masking publish drops. Reapplied after PR #429's rewrite of
      // the IPFS handler accidentally dropped the original check.
      if (topic && /[\x00-\x1F\x7F]/.test(topic)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "topic contains control characters" }))
        return
      }

      switch (route) {
        case "pub": {
          if (!topic) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "missing topic" }))
            break
          }
          // kubo's pubsub/pub accepts the message body as multipart/form-data;
          // raw-body POSTs (e2e tests, simple curl --data-binary) still work
          // because readMultipartFile falls back to raw bytes when there's no
          // boundary in Content-Type.
          const { bytes: body } = await readMultipartFile(req)
          // #284: IpfsPubsub.publish throws a plain Error("message too large:
          // N > M") when data.length exceeds maxMessageSize (default 1 MB).
          // Without this catch the error fell through the outer try/catch as
          // 500 "internal error" — clients couldn't tell server fault from
          // their own oversized payload. Same class as #276 (mempool plain
          // Errors leaking as -32603); remap to 413 per HTTP semantics.
          try {
            await this.pubsub.publish(topic, body)
          } catch (pubErr) {
            const msg = pubErr instanceof Error ? pubErr.message : String(pubErr)
            if (/^message too large/i.test(msg)) {
              throw new HttpError(413, "payload too large", msg)
            }
            throw pubErr
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "sub": {
          // Validate topic before sending headers to avoid double writeHead
          if (!topic) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "missing topic" }))
            break
          }

          // Long-polling: return recent messages and stream new ones via ndjson
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
            "transfer-encoding": "chunked",
          })

          const handler = (msg: { from: string; seqno: string; data: Uint8Array; topicIDs: string[] }) => {
            if (res.destroyed || res.writableEnded) return
            try {
              const encoded = Buffer.from(msg.data).toString("base64")
              res.write(JSON.stringify({
                from: msg.from,
                seqno: msg.seqno,
                data: encoded,
                topicIDs: msg.topicIDs,
              }) + "\n")
            } catch {
              // Connection already closed, unsubscribe on next tick
              this.pubsub?.unsubscribe(topic, handler)
            }
          }
          this.pubsub.subscribe(topic, handler)

          // Clean up on client disconnect
          req.on("close", () => {
            this.pubsub?.unsubscribe(topic, handler)
          })
          break
        }
        case "ls": {
          const topics = this.pubsub.getTopics()
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ Strings: topics }))
          break
        }
        case "peers": {
          // #416: sibling pub/sub already reject empty topic; peers was
          // missing the same guard. `?arg=` (empty) flowed through to
          // pubsub.getSubscribers("") and the response was the same
          // `{Strings: []}` as "real topic, no subscribers", so the
          // caller couldn't tell their topic was missing.
          if (!topic) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "missing topic" }))
            break
          }
          // #557: pre-fix the body was `{Strings:[], count}` — a non-
          // standard `count` field kubo never emits, plus an empty
          // `Strings` array. Clients deserializing into kubo's shape
          // either silently ignored count or (with strict-fields
          // deserializers) threw. Kubo emits exactly `{Strings:[peer…]}`.
          // We don't track per-peer IDs yet so Strings is empty, but
          // the wire shape now matches kubo. Same drift family as #547.
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ Strings: [] }))
          break
        }
        default:
          res.writeHead(404)
          res.end(JSON.stringify({ error: `unknown pubsub command: ${route}` }))
      }
    } catch (err) {
      // #284: pre-fix this route-level catch unconditionally surfaced 500
      // "internal error", masking client-input failures (e.g. pubsub
      // payload too large) as server faults. Honour HttpError throws —
      // the publish call site rethrows oversized messages as
      // HttpError(413), and future client-input errors from this route
      // should also bypass the 500 default.
      if (err instanceof HttpError) {
        if (!res.headersSent) {
          res.writeHead(err.status, { "content-type": "application/json" })
        }
        log.warn("IPFS pubsub request rejected", { status: err.status, code: err.code })
        const messageOut = err.message !== err.code ? err.message : undefined
        try {
          res.end(JSON.stringify(messageOut ? { error: err.code, message: messageOut } : { error: err.code }))
        } catch { /* connection already closed */ }
        return
      }
      log.error("pubsub route failed", { error: String(err) })
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "internal error" }))
    }
  }
}

/**
 * Reject CIDs with path traversal, null bytes, whitespace, excessive length,
 * or that don't even look like base58-v0 (`Qm…`) / base32-v1 (`b…`/`B…`).
 * #168: pre-fix any non-traversal string like `"bogus"` passed, then the
 * blockstore opened `blocks/bogus`, hit ENOENT, and the handler surfaced
 * the stacktrace as a generic 500. The 10-char floor rejects typos like
 * "bogus" / "b" while allowing the fake-shape CIDs used in fixtures.
 */
/**
 * #340: minimal MIME sniffer for the /ipfs/<cid> gateway. Browsers
 * served `Content-Type: application/octet-stream` (or no Content-Type
 * at all — what the gateway used to do) trigger a download dialog
 * instead of rendering. kubo's gateway uses a similar sniffer; we
 * match the common cases the IPFS ecosystem actually serves:
 *
 *   - HTML, SVG, XML, JSON, plain text (the bulk of web content)
 *   - PNG, JPEG, GIF, WebP (images)
 *   - PDF, GZIP, ZIP (binary archives)
 *
 * Falls back to `application/octet-stream` when no signature matches.
 * Sniffs the first 512 bytes only (kubo limit) — large files don't pay
 * extra cost.
 */
export function sniffMimeType(data: Uint8Array): string {
  if (data.length === 0) return "application/octet-stream"
  const head = data.subarray(0, Math.min(data.length, 512))

  // Binary magic bytes (check before text — UTF-8 BOM is text but rare)
  if (head.length >= 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
      head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return "image/png"
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg"
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 &&
      head[3] === 0x38 && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
    return "image/gif"
  }
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 &&
      head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 &&
      head[10] === 0x42 && head[11] === 0x50) {
    return "image/webp"
  }
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 &&
      head[3] === 0x46 && head[4] === 0x2d) {
    return "application/pdf"
  }
  if (head.length >= 3 && head[0] === 0x1f && head[1] === 0x8b && head[2] === 0x08) {
    return "application/gzip"
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b &&
      (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) {
    return "application/zip"
  }

  // Text-based detection (strip UTF-8 BOM if present)
  let textStart = 0
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    textStart = 3
  }
  const text = Buffer.from(head.subarray(textStart)).toString("utf8").trimStart().toLowerCase()
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return "text/html; charset=utf-8"
  if (text.startsWith("<?xml")) return "application/xml; charset=utf-8"
  if (text.startsWith("<svg")) return "image/svg+xml"
  // JSON: starts with { or [ AND parses (only try-parse the first 512 bytes)
  if (text.length > 0 && (text[0] === "{" || text[0] === "[")) {
    try {
      JSON.parse(text)
      return "application/json"
    } catch {
      // Truncated head may not parse — fall through to plain-text check.
    }
  }

  // Plain text: at least 90% of bytes printable ASCII or common whitespace.
  let printable = 0
  for (const b of head.subarray(textStart)) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0x80) {
      printable++
    }
  }
  if (head.length - textStart > 0 && printable / (head.length - textStart) >= 0.9) {
    return "text/plain; charset=utf-8"
  }

  return "application/octet-stream"
}

function isValidCid(cid: string): boolean {
  // #216: real-world CID max is ~80 chars (Qm v0 = 46, bafy v1 ≤ ~80).
  // 100 leaves comfortable headroom for any future codec without
  // exceeding the OS path-component limit (Linux NAME_MAX = 255).
  // Pre-fix the cap of 512 let synthetic over-long CIDs reach
  // store.get(cid) which then failed `open()` with ENAMETOOLONG —
  // leaking as `500 "internal error"` instead of a clean 400.
  //
  // #489: lower-bound check needs to accommodate identity-hash CIDs.
  // The canonical empty-raw-block CID `bafkqaaa` is 8 chars (CIDv1,
  // codec=raw, multihash=identity, digest length 0). Pre-fix the
  // length<10 guard rejected this universally-accepted CID; ipfs-
  // http-client and kubo both parse it as valid. The minimum
  // theoretical CIDv1 base32 length is 8 chars (1 'b' prefix +
  // 4-byte header encoded as 8 base32 chars); v0 Qm CIDs are always
  // 46 chars and have their own min via the regex.
  if (!cid || cid.length > 100) return false
  const trimmed = cid.trim()
  if (trimmed !== cid) return false
  if (/[\/\\]|\.\.|\0|\s/.test(cid)) return false
  // Base58 v0: "Qm" + base58 chars. Strict alphabet (no 0/O/I/l).
  // Qm CIDs are always exactly 46 chars (32-byte SHA-256 + 2 prefix).
  if (cid.startsWith("Qm")) {
    if (cid.length !== 46) return false
    return /^Qm[1-9A-HJ-NP-Za-km-z]+$/.test(cid)
  }
  // Base32 v1: "b"/"B" + RFC 4648 base32 chars (no 0/1/8/9).
  // Minimum length 8 covers identity-hash empty CIDs like `bafkqaaa`.
  if (cid.startsWith("b") || cid.startsWith("B")) {
    if (cid.length < 8) return false
    return /^[bB][a-z2-7]+$/.test(cid)
  }
  return false
}

/**
 * #324: parse a single bytes-range request per RFC 7233.
 * Returns:
 *   { start, end }   — valid single-range (inclusive bounds)
 *   "invalid"        — syntactically valid but unsatisfiable (e.g.
 *                      start > total-1, or both endpoints absent)
 *                      → caller returns 416
 *   "ignore"         — does not look like a `bytes=` range; treat as
 *                      no Range header → caller returns full 200
 *
 * Forms supported:
 *   bytes=N-M    (start N, end M; M defaults to total-1 when absent)
 *   bytes=N-     (start N, end is total-1)
 *   bytes=-N     (suffix; last N bytes; clamped to file size)
 * Multi-range (comma-separated) is rejected at the caller before we
 * get here, so we don't generate multipart/byteranges responses.
 */
function parseRangeBytes(header: string, totalSize: number):
  | { start: number; end: number }
  | "invalid"
  | "ignore"
{
  // RFC 7233 §3.1 — units are case-insensitive
  const trimmed = header.trim()
  const match = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)$/i.exec(trimmed)
  if (!match) return "ignore"
  const startStr = match[1]
  const endStr = match[2]
  if (startStr === "" && endStr === "") return "invalid"

  let start: number, end: number
  if (startStr === "") {
    // suffix-byte-range-spec: last N bytes
    const suffix = Number(endStr)
    if (!Number.isFinite(suffix) || !Number.isInteger(suffix) || suffix <= 0) return "invalid"
    if (totalSize === 0) return "invalid"
    start = Math.max(0, totalSize - suffix)
    end = totalSize - 1
  } else {
    start = Number(startStr)
    if (!Number.isFinite(start) || !Number.isInteger(start) || start < 0) return "invalid"
    if (start >= totalSize) return "invalid"
    if (endStr === "") {
      end = totalSize - 1
    } else {
      end = Number(endStr)
      if (!Number.isFinite(end) || !Number.isInteger(end) || end < start) return "invalid"
      // Per RFC 7233, clamp end to total-1 when client requests beyond EOF
      if (end > totalSize - 1) end = totalSize - 1
    }
  }
  return { start, end }
}

/**
 * Parse `?erasure=N+M` query value. Returns null when absent (caller takes
 * the plain-UnixFS path). Throws `HttpError(400)` when malformed so callers
 * never silently fall back on a typo.
 */
function parseErasureSpec(spec: string | undefined): { n: number; m: number } | null {
  if (!spec) return null
  const match = /^(\d+)\+(\d+)$/.exec(spec.trim())
  if (!match) {
    throw new HttpError(400, "invalid erasure spec", `expected '?erasure=N+M', got '${spec}'`)
  }
  const n = Number(match[1])
  const m = Number(match[2])
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1) {
    throw new HttpError(400, "invalid erasure spec", `n and m must be positive integers, got n=${n} m=${m}`)
  }
  // #180: pre-fix the upper bound (MAX_DATA_SHARDS / MAX_PARITY_SHARDS)
  // wasn't enforced here. `erasureEncode` later threw an ErasureError
  // which handleAdd didn't catch — surfaced as a generic 500 after the
  // multipart body was fully read and the UnixFS file was already
  // added. Reject at parse time instead so we don't waste the upload.
  if (n > MAX_DATA_SHARDS) {
    throw new HttpError(400, "invalid erasure spec", `n=${n} exceeds MAX_DATA_SHARDS (${MAX_DATA_SHARDS})`)
  }
  if (m > MAX_PARITY_SHARDS) {
    throw new HttpError(400, "invalid erasure spec", `m=${m} exceeds MAX_PARITY_SHARDS (${MAX_PARITY_SHARDS})`)
  }
  return { n, m }
}

// Aligned with UnixFsBuilder.MAX_READ_SIZE (50 MB on the read side).
// Multipart envelope adds ~300B of boundary/headers, so 10MB exact would
// reject a real 10MB payload — set the ceiling well above the read cap to
// leave room for envelope overhead and for legitimately large uploads.
const DEFAULT_MAX_UPLOAD_SIZE = 50 * 1024 * 1024 + 64 * 1024 // 50 MB + 64 KB headroom

const READ_BODY_TIMEOUT_MS = 30_000

async function readBody(req: http.IncomingMessage, maxSize = DEFAULT_MAX_UPLOAD_SIZE): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let totalSize = 0
  const timer = setTimeout(() => { req.destroy(new Error("upload timeout")) }, READ_BODY_TIMEOUT_MS)
  try {
    for await (const chunk of req) {
      const buf = Buffer.from(chunk)
      totalSize += buf.byteLength
      if (totalSize > maxSize) {
        throw new HttpError(413, "payload too large", `upload exceeds max size: ${totalSize} > ${maxSize}`)
      }
      chunks.push(buf)
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * #338: RFC 2046 §5.1.1-compliant multipart split.
 *
 * Pre-fix used `raw.split("--" + boundary)` which split on the boundary
 * substring ANYWHERE in the body — file content containing those bytes
 * silently truncated the upload. The CID then pointed to partial data
 * and the user didn't know.
 *
 * Per RFC 2046, the delimiter is one of:
 *   - Initial:    "--" + boundary                  (allowed at start of body)
 *   - Encapsulating:  CRLF + "--" + boundary + CRLF
 *   - Closing:    CRLF + "--" + boundary + "--"
 *
 * The CRLF prefix on subsequent boundaries (RFC §5.1.1: "The body
 * must therefore include an additional CRLF preceding the boundary
 * delimiter line") is the bit that turns a substring match into a
 * delimiter match. Match it.
 *
 * Returns the indices of each part's start (after the leading
 * CRLF/initial-marker) so the caller can extract the slice.
 */
function findMultipartParts(raw: Buffer, boundary: string): Array<{ start: number; end: number }> {
  const delim = Buffer.from(`--${boundary}`, "binary")
  const crlfDelim = Buffer.from(`\r\n--${boundary}`, "binary")
  const parts: Array<{ start: number; end: number }> = []
  // First boundary may start at byte 0 OR be preceded by CRLF; check both.
  let cursor = 0
  if (raw.length >= delim.length && raw.compare(delim, 0, delim.length, 0, delim.length) === 0) {
    cursor = delim.length
  } else {
    const firstIdx = raw.indexOf(crlfDelim)
    if (firstIdx === -1) return parts
    cursor = firstIdx + crlfDelim.length
  }
  while (cursor < raw.length) {
    // After the delimiter, we expect either CRLF (next part), "--"
    // (close boundary), or nothing-recognized (malformed → stop).
    if (raw[cursor] === 0x2d /* '-' */ && raw[cursor + 1] === 0x2d /* '-' */) {
      // Close boundary — no more parts.
      break
    }
    // Require CRLF after delimiter for regular boundary.
    if (raw[cursor] !== 0x0d /* '\r' */ || raw[cursor + 1] !== 0x0a /* '\n' */) {
      // Not a valid delimiter trail; bail.
      break
    }
    const partStart = cursor + 2
    const nextDelimIdx = raw.indexOf(crlfDelim, partStart)
    if (nextDelimIdx === -1) break
    parts.push({ start: partStart, end: nextDelimIdx })
    cursor = nextDelimIdx + crlfDelim.length
  }
  return parts
}

async function readMultipartFile(req: http.IncomingMessage): Promise<{ filename?: string; bytes: Uint8Array }> {
  const contentType = req.headers["content-type"] ?? ""
  // Limit boundary length to prevent split amplification DoS
  const boundaryMatch = /boundary=([^;\s]{1,256})/.exec(contentType)
  if (!boundaryMatch) {
    // #356: pre-fix `Content-Type: multipart/form-data` (no boundary param)
    // fell through to the raw-body fallback and the multipart envelope
    // bytes were stored verbatim as a "file" — the literal
    // `--XYZ\r\nContent-Disposition...\r\n\r\nfile-bytes\r\n--XYZ--`
    // got content-addressed and returned as the CID. Reject multipart/*
    // without boundary so clients can't accidentally upload envelope
    // bytes thinking they uploaded the inner file. Non-multipart
    // Content-Types (octet-stream, empty, etc.) still pass through —
    // kubo CLI + curl --data-binary depend on the raw-body fallback.
    if (/^multipart\//i.test(contentType.trim())) {
      throw new HttpError(400, "invalid_multipart",
        "multipart/* Content-Type requires boundary param")
    }
    const raw = await readBody(req)
    return { bytes: raw }
  }

  const boundary = boundaryMatch[1]
  const raw = Buffer.from(await readBody(req))
  const parts = findMultipartParts(raw, boundary)
  // #356: pre-fix the loop returned on the FIRST part and silently
  // dropped any additional parts. A 2-file multipart upload returned
  // a CID for file #1 and the client believed both files were stored.
  // Accumulate validParts and reject !=1 — this endpoint is single-file.
  const validParts: Array<{ filename?: string; bytes: Uint8Array }> = []
  for (const { start, end } of parts) {
    const part = raw.subarray(start, end)
    // Headers/body separator is the FIRST \r\n\r\n inside the part.
    const sepIdx = part.indexOf("\r\n\r\n")
    if (sepIdx === -1) continue
    const headerRaw = part.subarray(0, sepIdx).toString("binary")
    const body = part.subarray(sepIdx + 4)
    const filenameMatch = /filename="([^"]+)"/.exec(headerRaw)
    const rawFilename = filenameMatch ? filenameMatch[1] : undefined
    // Strip path components to prevent directory traversal in metadata
    const filename = rawFilename ? rawFilename.replace(/.*[/\\]/, "").slice(0, 255) || undefined : undefined
    validParts.push({ filename, bytes: new Uint8Array(body) })
  }

  // #356: pre-fix returned `{bytes: new Uint8Array()}` (empty file's CID)
  // when no parts matched — clients uploading their (non-empty) file got
  // a success response carrying the empty-file CID and silently lost
  // their data. Reject empty multipart bodies with 400.
  if (validParts.length === 0) {
    throw new HttpError(400, "invalid_multipart",
      "no part found in multipart body")
  }
  if (validParts.length > 1) {
    throw new HttpError(400, "unsupported_multipart",
      `multipart body has ${validParts.length} parts, but this endpoint accepts at most 1`)
  }
  return validParts[0]
}

// #468 — directory-upload multipart parsing.

/** Max parts in one directory upload. */
const MAX_MULTIPART_PARTS = 10_000
/** Max path components in a single uploaded file's relative path. */
const MAX_PATH_SEGMENTS = 64
/** Max total length of a relative path. */
const MAX_PATH_LENGTH = 1024
/** Max length of a single path segment. */
const MAX_SEGMENT_LENGTH = 255

interface MultipartPart {
  /** Relative POSIX path. Undefined for a raw (non-multipart) body. */
  path?: string
  bytes: Uint8Array
  /** True for an explicit empty-directory part (kubo `application/x-directory`). */
  isDir?: boolean
}

/**
 * #468: validate and normalise a multipart `filename` into a safe relative
 * POSIX path. Unlike `readMultipartFile` (which strips to a basename), this
 * preserves directory components so nested-directory uploads work — but
 * rejects traversal (`..`), absolute paths, backslashes, NUL bytes, and
 * over-long paths/segments.
 */
function sanitizeRelPath(raw: string): string {
  if (raw.includes("\0")) {
    throw new HttpError(400, "invalid_path", "path contains a NUL byte")
  }
  if (raw.includes("\\")) {
    throw new HttpError(400, "invalid_path", `path contains a backslash: '${raw}'`)
  }
  if (raw.startsWith("/")) {
    throw new HttpError(400, "invalid_path", `absolute paths are not allowed: '${raw}'`)
  }
  if (raw.length > MAX_PATH_LENGTH) {
    throw new HttpError(400, "invalid_path", `path too long (max ${MAX_PATH_LENGTH})`)
  }
  const segments = raw.split("/").filter((s) => s.length > 0)
  if (segments.length > MAX_PATH_SEGMENTS) {
    throw new HttpError(400, "invalid_path", `path too deep (max ${MAX_PATH_SEGMENTS} segments)`)
  }
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new HttpError(400, "invalid_path", `path traversal segment '${seg}' is not allowed`)
    }
    if (seg.length > MAX_SEGMENT_LENGTH) {
      throw new HttpError(400, "invalid_path", `path segment too long (max ${MAX_SEGMENT_LENGTH})`)
    }
  }
  if (segments.length === 0) {
    throw new HttpError(400, "invalid_path", "empty path")
  }
  return segments.join("/")
}

/**
 * #468: parse a multipart body into N parts, preserving each part's
 * relative path so directory trees can be reconstructed. Falls back to a
 * single pathless part for raw (non-multipart) bodies — keeping the
 * single-file `curl --data-binary` upload path working.
 */
async function readMultipartFiles(req: http.IncomingMessage): Promise<MultipartPart[]> {
  const contentType = req.headers["content-type"] ?? ""
  const boundaryMatch = /boundary=([^;\s]{1,256})/.exec(contentType)
  if (!boundaryMatch) {
    // Same #356 guard as readMultipartFile: multipart/* without a boundary
    // is a client error; anything else is a raw-body upload.
    if (/^multipart\//i.test(contentType.trim())) {
      throw new HttpError(400, "invalid_multipart",
        "multipart/* Content-Type requires boundary param")
    }
    const raw = await readBody(req)
    return [{ bytes: raw }]
  }

  const boundary = boundaryMatch[1]
  const raw = Buffer.from(await readBody(req))
  const rawParts = findMultipartParts(raw, boundary)
  const parts: MultipartPart[] = []
  for (const { start, end } of rawParts) {
    const part = raw.subarray(start, end)
    const sepIdx = part.indexOf("\r\n\r\n")
    if (sepIdx === -1) continue
    const headerRaw = part.subarray(0, sepIdx).toString("binary")
    const body = part.subarray(sepIdx + 4)
    const filenameMatch = /filename="([^"]+)"/.exec(headerRaw)
    const rawFilename = filenameMatch ? filenameMatch[1] : undefined
    // kubo marks directory entries with an `application/x-directory`
    // (or legacy `x-directory`) Content-Type and an empty body.
    const isDir = /content-type:\s*application\/x-directory/i.test(headerRaw) ||
      /content-type:\s*x-directory/i.test(headerRaw)
    const path = rawFilename !== undefined ? sanitizeRelPath(rawFilename) : undefined
    parts.push({ path, bytes: new Uint8Array(body), isDir })
    if (parts.length > MAX_MULTIPART_PARTS) {
      throw new HttpError(400, "unsupported_multipart",
        `multipart body has more than ${MAX_MULTIPART_PARTS} parts`)
    }
  }

  if (parts.length === 0) {
    throw new HttpError(400, "invalid_multipart", "no part found in multipart body")
  }
  return parts
}
