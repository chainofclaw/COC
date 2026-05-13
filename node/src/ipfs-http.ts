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

const log = createLogger("ipfs")
const ipfsRateLimiter = new RateLimiter(60_000, 100)
setInterval(() => ipfsRateLimiter.cleanup(), 300_000).unref()

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

function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "ENOENT") return true
  const msg = String(err instanceof Error ? err.message : err)
  return /not\s*found|no such|ENOENT/i.test(msg)
}

export interface IpfsServerConfig {
  bind: string
  port: number
  storageDir: string
  nodeId?: string
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
}

export class IpfsHttpServer {
  private readonly cfg: IpfsServerConfig
  private readonly store: IpfsBlockstore
  private readonly unixfs: UnixFsBuilder
  private mfs: IpfsMfs | null = null
  private pubsub: IpfsPubsub | null = null
  private server: http.Server | null = null
  private readonly sockets = new Set<net.Socket>()

  constructor(cfg: IpfsServerConfig, store: IpfsBlockstore, unixfs: UnixFsBuilder) {
    this.cfg = cfg
    this.store = store
    this.unixfs = unixfs
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

      if (req.method === "GET" && url.pathname?.startsWith("/ipfs/")) {
        const cid = url.pathname.slice(6) // strip "/ipfs/"
        if (!isValidCid(cid)) {
          res.writeHead(400, { "content-type": "application/json", "access-control-allow-origin": "*" })
          res.end(JSON.stringify({ error: "invalid CID" }))
          return
        }
        // #168: pre-fix ENOENT for valid-shape-missing CIDs propagated
        // to the outer 500 handler, logging a stacktrace for every probe.
        // Map to 404 explicitly so missing-block looks like missing-block.
        try {
          const data = await this.unixfs.readFile(cid)
          // #328: ACAO: * on gateway success — content addressing is
          // immutable + read-only, so cross-origin reads carry no CSRF
          // risk and unlock browser-side IPFS clients.
          res.writeHead(200, { "access-control-allow-origin": "*" })
          res.end(data)
        } catch (err) {
          if (isNotFoundError(err)) {
            res.writeHead(404, { "content-type": "application/json", "access-control-allow-origin": "*" })
            res.end(JSON.stringify({ error: "not found" }))
          } else {
            throw err
          }
        }
        return
      }

      if (!url.pathname?.startsWith("/api/v0/")) {
        res.writeHead(404)
        res.end()
        return
      }

      // #136: kubo's HTTP RPC spec requires POST for all /api/v0/*
      // endpoints to prevent CSRF — browsers fire GET on <img>/<script>
      // tags without Same-Origin Policy, which would otherwise let any
      // visited webpage trigger state-changing operations (pin/add,
      // block/rm, repo/gc) against a victim's local IPFS daemon.
      if (req.method !== "POST") {
        res.writeHead(405, { "allow": "POST", "content-type": "application/json" })
        res.end(JSON.stringify({ error: "method not allowed: /api/v0/* requires POST" }))
        return
      }

      // #192: coalesce dup query params at the dispatcher boundary so
      // route handlers always receive `string | undefined` (not the
      // `string | string[]` Node's url-parser actually returns).
      const argParam = firstQueryValue(url.query.arg)
      if (url.pathname === "/api/v0/add") {
        await this.handleAdd(req, res, firstQueryValue(url.query.erasure))
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
      if (url.pathname === "/api/v0/stat") {
        await this.handleStat(res)
        return
      }
      if (url.pathname === "/api/v0/ls") {
        await this.handleLs(res, argParam ?? "")
        return
      }
      if (url.pathname === "/api/v0/object/stat") {
        await this.handleObjectStat(res, argParam ?? "")
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
        await this.handleGet(res, argParam ?? "")
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
        await this.handlePinAdd(req, res, argParam ?? "")
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
        const typeRaw = firstQueryValue(url.query?.type)
        await this.handlePinLs(res, argParam, typeRaw)
        return
      }
      if (url.pathname === "/api/v0/pin/rm") {
        await this.handlePinRm(res, argParam)
        return
      }
      if (url.pathname === "/api/v0/block/rm") {
        await this.handleBlockRm(res, argParam)
        return
      }
      if (url.pathname === "/api/v0/repo/gc") {
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

      res.writeHead(404)
      res.end(JSON.stringify({ error: "not found" }))
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

  private async handleAdd(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    erasureSpec?: string,
  ): Promise<void> {
    const { filename, bytes } = await readMultipartFile(req)

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

  private async handleLs(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid || !isValidCid(cid)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: !cid ? "missing cid" : "invalid cid" }))
      return
    }
    const meta = await this.readFileMeta()
    const file = meta[cid]
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
          Hash: cid,
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

  private async handleObjectStat(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid || !isValidCid(cid)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: !cid ? "missing cid" : "invalid cid" }))
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
      block = await this.store.get(cid)
    } catch (err) {
      if (isNotFoundError(err)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "block not found" }))
        return
      }
      throw err
    }
    const meta = await this.readFileMeta()
    const file = meta[cid]
    // #134: DataSize and LinksSize were hardcoded to 0. For UnixFS
    // files, DataSize is the user-data byte count exposed by `ls`;
    // LinksSize is a rough estimate of CID-reference bytes. The
    // important field for clients summing file sizes is DataSize.
    const numLinks = file?.leaves.length ?? 0
    const linksSize = numLinks > 0 ? Math.min(numLinks * 36, block.bytes.length) : 0
    const dataSize = file?.size ?? Math.max(block.bytes.length - linksSize, 0)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      Hash: cid,
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
    if (!cid || !isValidCid(cid)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: !cid ? "missing cid" : "invalid cid" }))
      return
    }
    // #174: pre-fix the offset/length/count query params were accepted
    // by kubo's spec but the handler ignored them, returning the full
    // file regardless. Worse, malformed values (negative, non-numeric)
    // silently passed through. Validate + slice now.
    let offset = 0
    let length: number | undefined
    if (range?.offset !== undefined) {
      const n = Number(range.offset)
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid offset: must be a non-negative integer" }))
        return
      }
      offset = n
    }
    if (range?.length !== undefined) {
      const n = Number(range.length)
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid length: must be a non-negative integer" }))
        return
      }
      length = n
    }
    const data = await this.readByCid(cid)
    const buf = Buffer.from(data)
    const slice = length !== undefined ? buf.subarray(offset, offset + length) : buf.subarray(offset)
    res.writeHead(200)
    res.end(slice)
  }

  private async handleGet(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid || !isValidCid(cid)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: !cid ? "missing cid" : "invalid cid" }))
      return
    }
    const data = await this.readByCid(cid)
    const archive = createTarArchive([{ name: cid, data }])
    res.writeHead(200, { "content-type": "application/x-tar" })
    res.end(archive)
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
    if (!cid || !isValidCid(cid)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: !cid ? "missing cid" : "invalid cid" }))
      return
    }
    // #168: pre-fix ENOENT for missing blocks propagated to the outer
    // 500 handler. Map to 404 so missing-block looks like missing-block.
    try {
      const block = await loadRawBlock(this.store, cid)
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
    if (!cid || !isValidCid(cid)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: !cid ? "missing cid" : "invalid cid" }))
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
    if (!(await this.store.has(cid))) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "block not found" }))
      return
    }
    // #168: same ENOENT → 404 mapping as handleBlockGet.
    try {
      const block = await loadRawBlock(this.store, cid)
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

  private async handlePinAdd(_req: http.IncomingMessage, res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid || !isValidCid(cid)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: !cid ? "missing cid" : "invalid cid" }))
      return
    }
    // #280: pre-fix accepted any well-formed CID without requiring the
    // block to be stored locally. Attackers could mass-submit valid-format
    // CIDs to grow pins.json unboundedly (each pin add rewrites the whole
    // file → disk-fill + write-amplification DoS). Kubo's offline mode
    // returns "block not found locally" in the same scenario; mirror
    // that: pinning is allowed only for blocks already present in the
    // local store (put + pin → pin/add must check existence first).
    if (!(await this.store.has(cid))) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "block not found locally" }))
      return
    }
    await this.store.pin(cid)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Pins: [cid] }))
  }

  /**
   * #126: kubo-compatible `/api/v0/pin/rm?arg=<cid>`. Idempotent — if
   * the CID was never pinned, returns 404 to match kubo. The block
   * file itself stays on disk; call `/api/v0/repo/gc` or
   * `/api/v0/block/rm` to evict bytes.
   */
  private async handlePinRm(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    if (!isValidCid(cid)) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "invalid cid" }))
      return
    }
    const wasPinned = await this.store.unpin(cid)
    if (!wasPinned) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "not pinned" }))
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Pins: [cid] }))
  }

  /**
   * #126: kubo-compatible `/api/v0/block/rm?arg=<cid>`. Force-evicts
   * the block from disk (and unpins it if pinned) — used by the
   * chaos kill-shard drill to simulate disk loss. Returns the kubo
   * `{Hash, Error}` shape; Error is empty string on success.
   */
  private async handleBlockRm(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    if (!isValidCid(cid)) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "invalid cid" }))
      return
    }
    const result = await this.store.removeBlock(cid)
    if (!result.removedFile && !result.wasPinned) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ Hash: cid, Error: "block not found locally" }))
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Hash: cid, Error: "" }))
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

  private async handlePinLs(res: http.ServerResponse, cid?: string, type?: string): Promise<void> {
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
    if (cid !== undefined) {
      // Match the kubo `/api/v0/pin/ls?arg=<cid>` semantics: 404 when the
      // CID is not pinned, otherwise return only that CID. Without the
      // filter we returned the entire pin set regardless of arg, which
      // confused callers that relied on the absence of a CID to mean
      // "not pinned".
      if (!isValidCid(cid)) throw new HttpError(400, "invalid cid")
      if (!pins.includes(cid)) throw new HttpError(404, "not pinned")
      // If the caller filtered by type and our (recursive-only) pin store
      // doesn't match, treat as "not pinned under that type" → 404. This
      // mirrors kubo: `pin/ls?arg=<cid>&type=direct` returns 404 unless
      // the CID is specifically directly-pinned.
      if (resolvedType === "direct" || resolvedType === "indirect") {
        throw new HttpError(404, `not pinned (no ${resolvedType} pins in this store)`)
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ Keys: { [cid]: { Type: "recursive" } } }))
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
          await this.mfs.write(arg, body, {
            create: url.query?.create === "true",
            truncate: url.query?.truncate === "true",
            parents: url.query?.parents === "true",
          })
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
          if (offsetRaw !== undefined) {
            const n = Number(offsetRaw)
            if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
              throw new HttpError(400, "invalid offset")
            }
            opts.offset = n
          }
          if (countRaw !== undefined) {
            const n = Number(countRaw)
            if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
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
          /directory not empty/i.test(msg) ||
          /^cannot (remove|operate on|copy)/i.test(msg) ||
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
          // #232: pre-fix normalizePath threw `Error("path traversal not
          // allowed: ...")` for any input containing `..`, but the
          // catch had no regex for it → 500 "internal error" instead of
          // the 400 that path-too-long / null-byte / max-depth siblings
          // already emit. Treat as client-input error.
          /^path traversal/i.test(msg) ||
          /^invalid /i.test(msg)
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
          await this.pubsub.publish(topic, body)
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
          const count = this.pubsub.getSubscribers(topic)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ Strings: [], count }))
          break
        }
        default:
          res.writeHead(404)
          res.end(JSON.stringify({ error: `unknown pubsub command: ${route}` }))
      }
    } catch (err) {
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
function isValidCid(cid: string): boolean {
  // #216: real-world CID max is ~80 chars (Qm v0 = 46, bafy v1 ≤ ~80).
  // 100 leaves comfortable headroom for any future codec without
  // exceeding the OS path-component limit (Linux NAME_MAX = 255).
  // Pre-fix the cap of 512 let synthetic over-long CIDs reach
  // store.get(cid) which then failed `open()` with ENAMETOOLONG —
  // leaking as `500 "internal error"` instead of a clean 400.
  if (!cid || cid.length < 10 || cid.length > 100) return false
  const trimmed = cid.trim()
  if (trimmed !== cid) return false
  if (/[\/\\]|\.\.|\0|\s/.test(cid)) return false
  // Base58 v0: "Qm" + base58 chars. Strict alphabet (no 0/O/I/l).
  if (cid.startsWith("Qm")) {
    return /^Qm[1-9A-HJ-NP-Za-km-z]+$/.test(cid)
  }
  // Base32 v1: "b"/"B" + RFC 4648 base32 chars (no 0/1/8/9).
  if (cid.startsWith("b") || cid.startsWith("B")) {
    return /^[bB][a-z2-7]+$/.test(cid)
  }
  return false
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

async function readMultipartFile(req: http.IncomingMessage): Promise<{ filename?: string; bytes: Uint8Array }> {
  const contentType = req.headers["content-type"] ?? ""
  // Limit boundary length to prevent split amplification DoS
  const boundaryMatch = /boundary=([^;\s]{1,256})/.exec(contentType)
  if (!boundaryMatch) {
    const raw = await readBody(req)
    return { bytes: raw }
  }

  const boundary = `--${boundaryMatch[1]}`
  const raw = Buffer.from(await readBody(req))
  const parts = raw.toString("binary").split(boundary)
  for (const part of parts) {
    if (!part || part === "--\r\n") continue
    // Use indexOf to split only at the FIRST \r\n\r\n (body may contain \r\n\r\n)
    const separatorIdx = part.indexOf("\r\n\r\n")
    if (separatorIdx === -1) continue
    const headerRaw = part.slice(0, separatorIdx)
    let body = part.slice(separatorIdx + 4)
    const filenameMatch = /filename="([^"]+)"/.exec(headerRaw)
    const rawFilename = filenameMatch ? filenameMatch[1] : undefined
    // Strip path components to prevent directory traversal in metadata
    const filename = rawFilename ? rawFilename.replace(/.*[/\\]/, "").slice(0, 255) || undefined : undefined
    if (body.endsWith("\r\n")) body = body.slice(0, -2)
    return { filename, bytes: Buffer.from(body, "binary") }
  }

  return { bytes: new Uint8Array() }
}
