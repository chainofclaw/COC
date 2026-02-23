import http from "node:http"
import { request as httpRequest } from "node:http"
import crypto from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ChainBlock, ChainSnapshot, Hex, NodePeer } from "./blockchain-types.ts"
import { PeerScoring } from "./peer-scoring.ts"
import { PeerDiscovery } from "./peer-discovery.ts"
import { createLogger } from "./logger.ts"
import { RateLimiter } from "./rate-limiter.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"

const log = createLogger("p2p")

const MAX_REQUEST_BODY = 2 * 1024 * 1024 // 2 MB max request body
const MAX_RESPONSE_BODY = 4 * 1024 * 1024 // 4 MB max response body
const REQUEST_TIMEOUT_MS = 10_000
const BROADCAST_CONCURRENCY = 5 // max concurrent peer broadcasts
const DEFAULT_P2P_AUTH_MAX_CLOCK_SKEW_MS = 120_000

export interface P2PAuthEnvelope {
  senderId: string
  timestampMs: number
  nonce: string
  signature: string
}

interface AuthNonceTracker {
  has(value: string): boolean
  add(value: string): void
}

export interface BftMessagePayload {
  type: "prepare" | "commit"
  height: string
  blockHash: Hex
  senderId: string
  signature?: string
}

export interface P2PHandlers {
  onTx: (rawTx: Hex) => Promise<void>
  onBlock: (block: ChainBlock) => Promise<void>
  onSnapshotRequest: () => ChainSnapshot | Promise<ChainSnapshot>
  onBftMessage?: (msg: BftMessagePayload) => Promise<void>
  onStateSnapshotRequest?: () => Promise<unknown | null>
  getHeight?: () => Promise<bigint> | bigint
}

export interface P2PConfig {
  bind: string
  port: number
  peers: NodePeer[]
  nodeId?: string
  maxPeers?: number
  maxDiscoveredPerBatch?: number
  enableDiscovery?: boolean
  peerStorePath?: string
  dnsSeeds?: string[]
  peerMaxAgeMs?: number
  inboundRateLimitWindowMs?: number
  inboundRateLimitMaxRequests?: number
  enableInboundAuth?: boolean
  inboundAuthMode?: "off" | "monitor" | "enforce"
  authMaxClockSkewMs?: number
  authNonceRegistryPath?: string
  authNonceTtlMs?: number
  authNonceMaxEntries?: number
  signer?: NodeSigner
  verifier?: SignatureVerifier
}

export function buildP2PAuthMessage(path: string, senderId: string, timestampMs: number, nonce: string, payloadHash: Hex): string {
  return `p2p:${path}:${senderId}:${timestampMs}:${nonce}:${payloadHash}`
}

export function buildP2PIdentityChallengeMessage(challenge: string, nodeId: string): string {
  return `p2p:identity:${challenge}:${nodeId.toLowerCase()}`
}

export function buildSignedP2PPayload(
  path: string,
  payload: Record<string, unknown>,
  signer: NodeSigner,
  nowMs = Date.now(),
): Record<string, unknown> {
  const payloadHash = hashP2PPayload(payload)
  const nonce = crypto.randomUUID()
  const signature = signer.sign(buildP2PAuthMessage(path, signer.nodeId, nowMs, nonce, payloadHash))
  return {
    ...payload,
    _auth: {
      senderId: signer.nodeId,
      timestampMs: nowMs,
      nonce,
      signature,
    } satisfies P2PAuthEnvelope,
  }
}

/** Build a signed auth header value for GET endpoints (no body). */
export function buildSignedGetAuth(
  path: string,
  signer: NodeSigner,
  nowMs = Date.now(),
): string {
  const emptyPayloadHash = hashP2PPayload({})
  const nonce = crypto.randomUUID()
  const signature = signer.sign(buildP2PAuthMessage(path, signer.nodeId, nowMs, nonce, emptyPayloadHash))
  return JSON.stringify({
    senderId: signer.nodeId,
    timestampMs: nowMs,
    nonce,
    signature,
  } satisfies P2PAuthEnvelope)
}

export function verifySignedP2PPayload(
  path: string,
  payload: unknown,
  verifier: SignatureVerifier,
  opts: {
    maxClockSkewMs?: number
    nowMs?: number
    nonceTracker?: AuthNonceTracker
  } = {},
): { ok: true; senderId: string; payload: Record<string, unknown> } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid payload object" }
  }

  const obj = payload as Record<string, unknown>
  const auth = obj._auth
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return { ok: false, reason: "missing auth envelope" }
  }

  const authObj = auth as Record<string, unknown>
  const senderId = String(authObj.senderId ?? "")
  const timestampMs = Number(authObj.timestampMs ?? 0)
  const nonce = String(authObj.nonce ?? "")
  const signature = String(authObj.signature ?? "")
  if (!senderId || !signature || !nonce || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return { ok: false, reason: "invalid auth envelope fields" }
  }

  const nowMs = opts.nowMs ?? Date.now()
  const maxClockSkewMs = opts.maxClockSkewMs ?? DEFAULT_P2P_AUTH_MAX_CLOCK_SKEW_MS
  if (Math.abs(nowMs - timestampMs) > maxClockSkewMs) {
    return { ok: false, reason: "auth timestamp out of range" }
  }

  const payloadNoAuth = stripAuthEnvelope(obj)
  const replayKey = `${senderId.toLowerCase()}:${nonce}`
  if (opts.nonceTracker?.has(replayKey)) {
    return { ok: false, reason: "auth nonce replay detected" }
  }

  const payloadHash = hashP2PPayload(payloadNoAuth)
  const message = buildP2PAuthMessage(path, senderId, timestampMs, nonce, payloadHash)
  if (!verifier.verifyNodeSig(message, signature, senderId)) {
    return { ok: false, reason: "invalid auth signature" }
  }

  opts.nonceTracker?.add(replayKey)
  return { ok: true, senderId, payload: payloadNoAuth }
}

export class BoundedSet<T> {
  private readonly maxSize: number
  private readonly items = new Set<T>()
  private readonly insertOrder: T[] = []

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  has(value: T): boolean {
    return this.items.has(value)
  }

  add(value: T): void {
    if (this.items.has(value)) return
    if (this.items.size >= this.maxSize) {
      const oldest = this.insertOrder.shift()
      if (oldest !== undefined) {
        this.items.delete(oldest)
      }
    }
    this.items.add(value)
    this.insertOrder.push(value)
  }

  get size(): number {
    return this.items.size
  }
}

export interface PersistentAuthNonceTrackerOptions {
  maxSize: number
  ttlMs: number
  persistencePath?: string
  nowFn?: () => number
}

export class PersistentAuthNonceTracker implements AuthNonceTracker {
  private readonly maxSize: number
  private readonly ttlMs: number
  private readonly persistencePath?: string
  private readonly nowFn: () => number
  private readonly items = new Map<string, number>()

  constructor(options: PersistentAuthNonceTrackerOptions) {
    this.maxSize = options.maxSize
    this.ttlMs = options.ttlMs
    this.persistencePath = options.persistencePath
    this.nowFn = options.nowFn ?? (() => Date.now())
    this.loadPersisted()
    this.cleanup()
  }

  has(value: string): boolean {
    const now = this.nowFn()
    this.pruneExpired(now)
    const ts = this.items.get(value)
    if (ts === undefined) return false
    if (this.isExpired(ts, now)) {
      this.items.delete(value)
      return false
    }
    return true
  }

  add(value: string): void {
    const now = this.nowFn()
    this.pruneExpired(now)
    if (this.items.has(value)) return

    while (this.items.size >= this.maxSize) {
      const oldestKey = this.items.keys().next().value
      if (oldestKey === undefined) break
      this.items.delete(oldestKey)
    }

    this.items.set(value, now)
    this.persistEntry(value, now)
  }

  cleanup(): void {
    this.pruneExpired(this.nowFn())
  }

  compact(): void {
    if (!this.persistencePath) return
    this.cleanup()
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      const lines = [...this.items.entries()].map(([key, ts]) => `${ts}\t${key}`)
      writeFileSync(this.persistencePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8")
    } catch {
      // keep in-memory safety even if compaction fails
    }
  }

  get size(): number {
    return this.items.size
  }

  private loadPersisted(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return
    try {
      const now = this.nowFn()
      const raw = readFileSync(this.persistencePath, "utf8")
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const tab = trimmed.indexOf("\t")
        let ts = now
        let key = trimmed
        if (tab > 0) {
          const parsedTs = Number(trimmed.slice(0, tab))
          if (Number.isFinite(parsedTs) && parsedTs > 0) {
            ts = parsedTs
          }
          key = trimmed.slice(tab + 1)
        }
        if (!key) continue
        if (this.isExpired(ts, now)) continue
        this.items.set(key, ts)
      }
      while (this.items.size > this.maxSize) {
        const oldestKey = this.items.keys().next().value
        if (oldestKey === undefined) break
        this.items.delete(oldestKey)
      }
    } catch {
      // fall back to in-memory if persisted file is unreadable
    }
  }

  private persistEntry(key: string, ts: number): void {
    if (!this.persistencePath) return
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true })
      appendFileSync(this.persistencePath, `${ts}\t${key}\n`, "utf8")
    } catch {
      // fail-open: in-memory replay protection remains active
    }
  }

  private pruneExpired(now: number): void {
    if (this.ttlMs <= 0) return
    const cutoff = now - this.ttlMs
    for (const [key, ts] of this.items.entries()) {
      if (ts < cutoff) {
        this.items.delete(key)
      }
    }
  }

  private isExpired(ts: number, now: number): boolean {
    return this.ttlMs > 0 && ts < (now - this.ttlMs)
  }
}

export class P2PNode {
  private readonly cfg: P2PConfig
  private readonly handlers: P2PHandlers
  private readonly inboundRateLimiter: RateLimiter
  private readonly stateSnapshotRateLimiter: RateLimiter
  private readonly authNonceTracker: PersistentAuthNonceTracker
  public readonly seenTx = new BoundedSet<Hex>(50_000)
  public readonly seenBlocks = new BoundedSet<Hex>(10_000)
  private rateLimitedRequests = 0
  private authAcceptedRequests = 0
  private authMissingRequests = 0
  private authInvalidRequests = 0
  private authRejectedRequests = 0
  private discoveryIdentityFailures = 0
  // Per-peer tracking: avoid sending same hash to same peer
  private readonly sentToPeer = new Map<string, BoundedSet<string>>()
  private txReceived = 0
  private txBroadcast = 0
  private blocksReceived = 0
  private blocksBroadcast = 0
  private bytesReceived = 0
  private bytesSent = 0
  private startedAtMs = 0
  readonly scoring: PeerScoring
  readonly discovery: PeerDiscovery
  private pubsubHandler: ((topic: string, message: unknown) => void) | null = null

  constructor(cfg: P2PConfig, handlers: P2PHandlers) {
    this.cfg = cfg
    this.handlers = handlers
    this.authNonceTracker = new PersistentAuthNonceTracker({
      maxSize: cfg.authNonceMaxEntries ?? 100_000,
      ttlMs: cfg.authNonceTtlMs ?? (24 * 60 * 60 * 1000),
      persistencePath: cfg.authNonceRegistryPath,
    })
    this.inboundRateLimiter = new RateLimiter(
      cfg.inboundRateLimitWindowMs ?? 60_000,
      cfg.inboundRateLimitMaxRequests ?? 240,
    )
    // Independent rate limiter for expensive state-snapshot endpoint (2 req per 60s per IP)
    this.stateSnapshotRateLimiter = new RateLimiter(60_000, 2)
    setInterval(() => this.inboundRateLimiter.cleanup(), 300_000).unref()
    setInterval(() => this.stateSnapshotRateLimiter.cleanup(), 300_000).unref()
    setInterval(() => this.authNonceTracker.cleanup(), 300_000).unref()
    if (cfg.authNonceRegistryPath) {
      setInterval(() => this.authNonceTracker.compact(), 60 * 60 * 1000).unref()
    }
    this.scoring = new PeerScoring()
    this.discovery = new PeerDiscovery(
      cfg.peers,
      this.scoring,
      {
        selfId: cfg.nodeId ?? "node-1",
        selfUrl: `http://${cfg.bind}:${cfg.port}`,
        maxPeers: cfg.maxPeers ?? 50,
        maxDiscoveredPerBatch: cfg.maxDiscoveredPerBatch ?? 200,
        peerStorePath: cfg.peerStorePath,
        dnsSeeds: cfg.dnsSeeds,
        peerMaxAgeMs: cfg.peerMaxAgeMs,
        verifyPeerIdentity: async (peer) => await this.verifyDiscoveredPeerIdentity(peer),
      },
    )

    // Register static peers in scoring
    for (const peer of cfg.peers) {
      this.scoring.addPeer(peer.id, peer.url)
    }
  }

  start(): void {
    this.startedAtMs = Date.now()
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(serializeJson({ ok: true, ts: Date.now() }))
        return
      }

      const clientIp = req.socket.remoteAddress ?? "unknown"
      const inboundIpPeerId = this.inboundIpPeerId(clientIp)
      this.scoring.addPeer(inboundIpPeerId, `inbound://${clientIp}`)
      if ((req.url ?? "").startsWith("/p2p/") && this.scoring.isBanned(inboundIpPeerId)) {
        res.writeHead(429, { "content-type": "application/json" })
        res.end(serializeJson({ error: "peer temporarily banned" }))
        return
      }
      if ((req.url ?? "").startsWith("/p2p/") && !this.inboundRateLimiter.allow(clientIp)) {
        this.rateLimitedRequests += 1
        this.scoring.recordTimeout(inboundIpPeerId)
        res.writeHead(429, { "content-type": "application/json" })
        res.end(serializeJson({ error: "rate limit exceeded" }))
        return
      }

      if (req.method === "GET" && req.url === "/p2p/chain-snapshot") {
        try {
          const snapshot = await this.handlers.onSnapshotRequest()
          res.writeHead(200, { "content-type": "application/json" })
          res.end(serializeJson(snapshot))
        } catch (err) {
          log.error("snapshot request error", { error: String(err) })
          res.writeHead(500, { "content-type": "application/json" })
          res.end(serializeJson({ error: "internal error" }))
        }
        return
      }

      if (req.method === "GET" && req.url === "/p2p/state-snapshot") {
        // Independent rate limit for expensive state-snapshot export
        if (!this.stateSnapshotRateLimiter.allow(clientIp)) {
          this.rateLimitedRequests += 1
          res.writeHead(429, { "content-type": "application/json" })
          res.end(serializeJson({ error: "state snapshot rate limit exceeded" }))
          return
        }
        // Require P2P auth in enforce mode (state snapshot is a high-cost GET)
        if (!this.verifyGetAuth(req, res, "state snapshot")) return
        if (this.handlers.onStateSnapshotRequest) {
          try {
            const snapshot = await this.handlers.onStateSnapshotRequest()
            if (snapshot) {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(serializeJson(snapshot))
            } else {
              res.writeHead(404, { "content-type": "application/json" })
              res.end(serializeJson({ error: "no state snapshot available" }))
            }
          } catch (err) {
            log.error("state snapshot request error", { error: String(err) })
            res.writeHead(500, { "content-type": "application/json" })
            res.end(serializeJson({ error: "internal error" }))
          }
        } else {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(serializeJson({ error: "state snapshot not enabled" }))
        }
        return
      }

      if (req.method === "GET" && req.url === "/p2p/peers") {
        // Require auth in enforce mode (exposes network topology)
        if (!this.verifyGetAuth(req, res, "peers")) return
        res.writeHead(200, { "content-type": "application/json" })
        res.end(serializeJson({ peers: this.discovery.getPeerListForExchange() }))
        return
      }

      if (req.method === "GET" && (req.url ?? "").startsWith("/p2p/identity-proof")) {
        const nodeId = this.cfg.nodeId ?? "unknown"
        const signer = this.cfg.signer
        if (!signer) {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(serializeJson({ error: "identity proof signer unavailable" }))
          return
        }
        try {
          const requestUrl = new URL(req.url ?? "", `http://${req.headers.host ?? "127.0.0.1"}`)
          const challenge = requestUrl.searchParams.get("challenge")?.trim() ?? ""
          if (!challenge || challenge.length > 256) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(serializeJson({ error: "invalid challenge" }))
            return
          }
          const message = buildP2PIdentityChallengeMessage(challenge, nodeId)
          const signature = signer.sign(message)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(serializeJson({ nodeId, challenge, signature }))
        } catch {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(serializeJson({ error: "invalid identity proof request" }))
        }
        return
      }

      if (req.method === "GET" && req.url === "/p2p/node-info") {
        // Require auth in enforce mode (exposes network topology and stats)
        if (!this.verifyGetAuth(req, res, "node-info")) return
        const height = this.handlers.getHeight ? await Promise.resolve(this.handlers.getHeight()) : 0n
        const stats = this.getStats()
        const activePeers = this.cfg.enableDiscovery !== false
          ? this.discovery.getActivePeers()
          : this.cfg.peers
        res.writeHead(200, { "content-type": "application/json" })
        res.end(serializeJson({
          nodeId: this.cfg.nodeId ?? "unknown",
          blockHeight: height.toString(),
          peerCount: activePeers.length,
          uptimeMs: stats.uptimeMs,
          protocol: "http-gossip",
          stats: {
            txReceived: stats.txReceived,
            txBroadcast: stats.txBroadcast,
            blocksReceived: stats.blocksReceived,
            blocksBroadcast: stats.blocksBroadcast,
            bytesReceived: stats.bytesReceived,
            bytesSent: stats.bytesSent,
            rateLimitedRequests: stats.rateLimitedRequests,
            authAcceptedRequests: stats.authAcceptedRequests,
            authMissingRequests: stats.authMissingRequests,
            authInvalidRequests: stats.authInvalidRequests,
            authRejectedRequests: stats.authRejectedRequests,
            authNonceTrackerSize: stats.authNonceTrackerSize,
            inboundAuthMode: stats.inboundAuthMode,
            discoveryPendingPeers: stats.discoveryPendingPeers,
            discoveryIdentityFailures: stats.discoveryIdentityFailures,
          },
        }))
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
        bodySize += typeof chunk === "string" ? chunk.length : chunk.byteLength
        if (bodySize > MAX_REQUEST_BODY) {
          aborted = true
          res.writeHead(413)
          res.end(serializeJson({ error: "request body too large" }))
          req.destroy()
          return
        }
        body += chunk
      })
      req.on("end", async () => {
        if (aborted) return
        this.bytesReceived += bodySize
        try {
          const parsedBody = JSON.parse(body || "{}") as Record<string, unknown>
          const declaredSenderId = extractAuthSenderId(parsedBody)
          const inboundSenderPeerId = declaredSenderId ? this.inboundSenderPeerId(declaredSenderId) : undefined
          if (inboundSenderPeerId) {
            this.scoring.addPeer(inboundSenderPeerId, `sender://${declaredSenderId}`)
            if (this.scoring.isBanned(inboundSenderPeerId)) {
              res.writeHead(429)
              res.end(serializeJson({ error: "peer temporarily banned" }))
              return
            }
          }

          const authMode = resolveInboundAuthMode(this.cfg)
          if (authMode !== "off") {
            if (!this.cfg.verifier) {
              res.writeHead(500)
              res.end(serializeJson({ error: "p2p inbound auth enabled without verifier" }))
              return
            }

            if (!hasAuthEnvelope(parsedBody)) {
              this.authMissingRequests += 1
              if (authMode === "enforce") {
                this.authRejectedRequests += 1
                this.recordInboundAuthFailure("missing", inboundIpPeerId, inboundSenderPeerId)
                res.writeHead(401)
                res.end(serializeJson({ error: "missing auth envelope" }))
                return
              }
            } else {
              const authCheck = verifySignedP2PPayload(req.url ?? "", parsedBody, this.cfg.verifier, {
                maxClockSkewMs: this.cfg.authMaxClockSkewMs ?? DEFAULT_P2P_AUTH_MAX_CLOCK_SKEW_MS,
                nonceTracker: this.authNonceTracker,
              })
              if (!authCheck.ok) {
                this.authInvalidRequests += 1
                if (authMode === "enforce") {
                  this.authRejectedRequests += 1
                  this.recordInboundAuthFailure("invalid", inboundIpPeerId, inboundSenderPeerId)
                  res.writeHead(401)
                  res.end(serializeJson({ error: authCheck.reason }))
                  return
                }
              } else {
                this.authAcceptedRequests += 1
                this.recordInboundAuthSuccess(inboundIpPeerId, inboundSenderPeerId)
              }
            }
          }

          const unsignedPayload = stripAuthEnvelope(parsedBody)

          if (req.url === "/p2p/gossip-tx") {
            const payload = unsignedPayload as { rawTx?: Hex }
            if (!payload.rawTx) throw new Error("missing rawTx")
            await this.receiveTx(payload.rawTx)
            res.writeHead(200)
            res.end(serializeJson({ ok: true }))
            return
          }

          if (req.url === "/p2p/gossip-block") {
            const payload = unsignedPayload as { block?: ChainBlock }
            if (!payload.block) throw new Error("missing block")
            // Restore BigInt fields lost during JSON serialization
            if (payload.block.number !== undefined) {
              payload.block.number = BigInt(payload.block.number)
            }
            if (payload.block.baseFee !== undefined) {
              payload.block.baseFee = BigInt(payload.block.baseFee)
            }
            if (payload.block.cumulativeWeight !== undefined) {
              payload.block.cumulativeWeight = BigInt(payload.block.cumulativeWeight)
            }
            if (payload.block.gasUsed !== undefined) {
              payload.block.gasUsed = BigInt(payload.block.gasUsed)
            }
            await this.receiveBlock(payload.block)
            res.writeHead(200)
            res.end(serializeJson({ ok: true }))
            return
          }

          if (req.url === "/p2p/pubsub-message") {
            const payload = unsignedPayload as { topic?: string; message?: unknown }
            if (!payload.topic || !payload.message) throw new Error("missing topic or message")
            if (this.pubsubHandler) {
              this.pubsubHandler(payload.topic, payload.message)
            }
            res.writeHead(200)
            res.end(serializeJson({ ok: true }))
            return
          }

          if (req.url === "/p2p/bft-message") {
            const payload = unsignedPayload as BftMessagePayload
            if (!payload.type || !payload.blockHash || !payload.senderId) {
              throw new Error("missing BFT message fields")
            }
            // Restore BigInt height lost during JSON serialization
            if (payload.height !== undefined) {
              payload.height = BigInt(payload.height)
            }
            if (this.handlers.onBftMessage) {
              await this.handlers.onBftMessage(payload)
            }
            res.writeHead(200)
            res.end(serializeJson({ ok: true }))
            return
          }

          res.writeHead(404)
          res.end(serializeJson({ error: "not found" }))
        } catch (error) {
          log.error("gossip handler error", { url: req.url, error: String(error) })
          res.writeHead(500)
          res.end(serializeJson({ error: "internal error" }))
        }
      })
    })

    server.listen(this.cfg.port, this.cfg.bind, () => {
      log.info("listening", { bind: this.cfg.bind, port: this.cfg.port })
    })

    // Start peer discovery and scoring if enabled
    if (this.cfg.enableDiscovery !== false) {
      this.discovery.start()
      this.scoring.startDecay()
    }
  }

  async receiveTx(rawTx: Hex): Promise<void> {
    if (this.seenTx.has(rawTx)) return
    this.seenTx.add(rawTx)
    this.txReceived++
    await this.handlers.onTx(rawTx)
    void this.broadcast("/p2p/gossip-tx", { rawTx }, rawTx)
  }

  async receiveBlock(block: ChainBlock): Promise<void> {
    if (this.seenBlocks.has(block.hash)) return
    this.seenBlocks.add(block.hash)
    this.blocksReceived++
    try {
      await this.handlers.onBlock(block)
      // Only broadcast after successful validation/application
      void this.broadcast("/p2p/gossip-block", { block }, block.hash)
    } catch (err) {
      // Don't broadcast invalid blocks to other peers
      log.warn("block validation failed, not broadcasting", { hash: block.hash, error: String(err) })
      throw err
    }
  }

  async fetchSnapshots(): Promise<ChainSnapshot[]> {
    // Query both static and discovered peers to sync from any reachable node
    const staticPeers = this.cfg.peers
    const discoveredPeers = this.cfg.enableDiscovery !== false
      ? this.discovery.getActivePeers()
      : []
    const seenUrls = new Set<string>()
    const allPeers: NodePeer[] = []
    for (const p of [...staticPeers, ...discoveredPeers]) {
      if (!seenUrls.has(p.url)) {
        seenUrls.add(p.url)
        allPeers.push(p)
      }
    }

    const results: ChainSnapshot[] = []
    for (const peer of allPeers) {
      try {
        const snapshot = await requestJson<ChainSnapshot>(`${peer.url}/p2p/chain-snapshot`, "GET")
        results.push(snapshot)
      } catch {
        // ignore peer failures
      }
    }
    return results
  }

  getPeers(): NodePeer[] {
    return this.cfg.enableDiscovery !== false
      ? this.discovery.getActivePeers()
      : this.cfg.peers
  }

  /**
   * Set handler for incoming pubsub messages from peers.
   */
  setPubsubHandler(handler: (topic: string, message: unknown) => void): void {
    this.pubsubHandler = handler
  }

  /**
   * Broadcast a pubsub message to all peers.
   */
  async broadcastPubsub(topic: string, message: unknown): Promise<void> {
    await this.broadcast("/p2p/pubsub-message", { topic, message })
  }

  /**
   * Broadcast a BFT consensus message to all configured peers.
   * Uses static peer list to ensure all validators receive BFT messages,
   * regardless of discovery status.
   */
  async broadcastBft(msg: BftMessagePayload): Promise<void> {
    // No outbound dedup for BFT — messages are rare (few per round) and commit
    // retries need to reach peers that missed the first broadcast.

    // BFT must reach ALL validators — use static peers + discovered peers
    const staticPeers = this.cfg.peers
    const discoveredPeers = this.cfg.enableDiscovery !== false
      ? this.discovery.getActivePeers()
      : []
    const seenIds = new Set<string>()
    const allPeers: NodePeer[] = []
    for (const p of [...staticPeers, ...discoveredPeers]) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id)
        allPeers.push(p)
      }
    }

    const payloadRecord = ensurePayloadObject(msg as unknown as Record<string, unknown>)
    const signedPayload = this.cfg.signer
      ? buildSignedP2PPayload("/p2p/bft-message", payloadRecord, this.cfg.signer)
      : payloadRecord
    const payloadSize = serializeJson(signedPayload).length

    for (let i = 0; i < allPeers.length; i += BROADCAST_CONCURRENCY) {
      const batch = allPeers.slice(i, i + BROADCAST_CONCURRENCY)
      await Promise.all(batch.map(async (peer) => {
        try {
          await requestJson(`${peer.url}/p2p/bft-message`, "POST", signedPayload)
          this.scoring.recordSuccess(peer.id)
          this.bytesSent += payloadSize
        } catch {
          this.scoring.recordFailure(peer.id)
        }
      }))
    }
  }

  getStats(): {
    txReceived: number; txBroadcast: number
    blocksReceived: number; blocksBroadcast: number
    seenTxSize: number; seenBlocksSize: number
    bytesReceived: number; bytesSent: number; uptimeMs: number
    rateLimitedRequests: number
    authAcceptedRequests: number
    authMissingRequests: number
    authInvalidRequests: number
    authRejectedRequests: number
    authNonceTrackerSize: number
    discoveryPendingPeers: number
    discoveryIdentityFailures: number
    inboundAuthMode: "off" | "monitor" | "enforce"
  } {
    return {
      txReceived: this.txReceived,
      txBroadcast: this.txBroadcast,
      blocksReceived: this.blocksReceived,
      blocksBroadcast: this.blocksBroadcast,
      seenTxSize: this.seenTx.size,
      seenBlocksSize: this.seenBlocks.size,
      bytesReceived: this.bytesReceived,
      bytesSent: this.bytesSent,
      uptimeMs: this.startedAtMs > 0 ? Date.now() - this.startedAtMs : 0,
      rateLimitedRequests: this.rateLimitedRequests,
      authAcceptedRequests: this.authAcceptedRequests,
      authMissingRequests: this.authMissingRequests,
      authInvalidRequests: this.authInvalidRequests,
      authRejectedRequests: this.authRejectedRequests,
      authNonceTrackerSize: this.authNonceTracker.size,
      discoveryPendingPeers: this.discovery.getPendingPeers().length,
      discoveryIdentityFailures: this.discoveryIdentityFailures,
      inboundAuthMode: resolveInboundAuthMode(this.cfg),
    }
  }

  private getPeerSentSet(peerId: string): BoundedSet<string> {
    let set = this.sentToPeer.get(peerId)
    if (!set) {
      // Evict oldest peer entry if map grows too large
      if (this.sentToPeer.size >= 200) {
        const oldest = this.sentToPeer.keys().next().value
        if (oldest !== undefined) this.sentToPeer.delete(oldest)
      }
      set = new BoundedSet<string>(5_000)
      this.sentToPeer.set(peerId, set)
    }
    return set
  }

  private async broadcast(path: string, payload: unknown, dedupeHash?: string): Promise<void> {
    const peers = this.cfg.enableDiscovery !== false
      ? this.discovery.getActivePeers()
      : this.cfg.peers

    const payloadRecord = ensurePayloadObject(payload)
    const signedPayload = this.cfg.signer
      ? buildSignedP2PPayload(path, payloadRecord, this.cfg.signer)
      : payloadRecord
    const payloadSize = serializeJson(signedPayload).length

    for (let i = 0; i < peers.length; i += BROADCAST_CONCURRENCY) {
      const batch = peers.slice(i, i + BROADCAST_CONCURRENCY)
      await Promise.all(batch.map(async (peer) => {
        // Skip if we already sent this hash to this peer
        if (dedupeHash) {
          const peerSent = this.getPeerSentSet(peer.id)
          if (peerSent.has(dedupeHash)) return
          peerSent.add(dedupeHash)
        }

        try {
          await requestJson(`${peer.url}${path}`, "POST", signedPayload)
          this.scoring.recordSuccess(peer.id)
          this.bytesSent += payloadSize
          if (path.includes("tx")) this.txBroadcast++
          else this.blocksBroadcast++
        } catch (err) {
          this.scoring.recordFailure(peer.id)
        }
      }))
    }
  }

  private async verifyDiscoveredPeerIdentity(peer: NodePeer): Promise<boolean> {
    const verifier = this.cfg.verifier
    if (!verifier) {
      this.discoveryIdentityFailures += 1
      return false
    }

    const challenge = crypto.randomUUID()
    try {
      const info = await requestJson<{ nodeId?: string; challenge?: string; signature?: string }>(
        `${peer.url}/p2p/identity-proof?challenge=${encodeURIComponent(challenge)}`,
        "GET",
      )
      const claimed = peer.id.toLowerCase()
      const reported = String(info?.nodeId ?? "").toLowerCase()
      const signedChallenge = String(info?.challenge ?? "")
      const signature = String(info?.signature ?? "")
      if (!reported || reported !== claimed || signedChallenge !== challenge || !signature) {
        this.recordDiscoveryIdentityFailure(peer, "invalid")
        log.warn("peer identity mismatch during discovery verification", {
          claimed: peer.id,
          reported: info?.nodeId,
          challenge,
          signedChallenge,
          url: peer.url,
        })
        return false
      }
      const message = buildP2PIdentityChallengeMessage(challenge, claimed)
      if (!verifier.verifyNodeSig(message, signature, claimed)) {
        this.recordDiscoveryIdentityFailure(peer, "invalid")
        log.warn("peer identity signature verification failed", {
          claimed: peer.id,
          url: peer.url,
        })
        return false
      }
      return true
    } catch {
      this.recordDiscoveryIdentityFailure(peer, "failure")
      return false
    }
  }

  private inboundIpPeerId(clientIp: string): string {
    const normalized = clientIp.startsWith("::ffff:")
      ? clientIp.slice(7)
      : clientIp
    return `inbound:ip:${normalized}`
  }

  private inboundSenderPeerId(senderId: string): string {
    return `inbound:sender:${senderId.toLowerCase()}`
  }

  /**
   * Verify GET endpoint auth header. Returns true if request should proceed, false if denied (response already sent).
   */
  private verifyGetAuth(req: http.IncomingMessage, res: http.ServerResponse, endpointLabel: string): boolean {
    const authMode = resolveInboundAuthMode(this.cfg)
    if (authMode === "off") return true
    if (!this.cfg.verifier) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(serializeJson({ error: "p2p inbound auth enabled without verifier" }))
      return false
    }

    const headerValue = req.headers["x-p2p-auth"]
    if (!headerValue || typeof headerValue !== "string") {
      this.authMissingRequests += 1
      if (authMode === "enforce") {
        this.authRejectedRequests += 1
        res.writeHead(401, { "content-type": "application/json" })
        res.end(serializeJson({ error: `missing auth for ${endpointLabel} endpoint` }))
        return false
      }
      return true // monitor mode: allow through
    }

    // Parse the header as a JSON auth envelope
    let authObj: Record<string, unknown>
    try {
      authObj = JSON.parse(headerValue)
    } catch {
      this.authInvalidRequests += 1
      if (authMode === "enforce") {
        this.authRejectedRequests += 1
        res.writeHead(401, { "content-type": "application/json" })
        res.end(serializeJson({ error: "invalid auth header JSON" }))
        return false
      }
      return true
    }

    const senderId = String(authObj.senderId ?? "")
    const timestampMs = Number(authObj.timestampMs ?? 0)
    const nonce = String(authObj.nonce ?? "")
    const signature = String(authObj.signature ?? "")

    if (!senderId || !signature || !nonce || !Number.isFinite(timestampMs) || timestampMs <= 0) {
      this.authInvalidRequests += 1
      if (authMode === "enforce") {
        this.authRejectedRequests += 1
        res.writeHead(401, { "content-type": "application/json" })
        res.end(serializeJson({ error: "invalid auth envelope fields" }))
        return false
      }
      return true
    }

    const maxClockSkewMs = this.cfg.authMaxClockSkewMs ?? DEFAULT_P2P_AUTH_MAX_CLOCK_SKEW_MS
    if (Math.abs(Date.now() - timestampMs) > maxClockSkewMs) {
      this.authInvalidRequests += 1
      if (authMode === "enforce") {
        this.authRejectedRequests += 1
        res.writeHead(401, { "content-type": "application/json" })
        res.end(serializeJson({ error: "auth timestamp out of range" }))
        return false
      }
      return true
    }

    // For GET requests, payload is empty — use empty object hash
    const emptyPayloadHash = hashP2PPayload({})
    const path = req.url ?? ""
    const message = buildP2PAuthMessage(path, senderId, timestampMs, nonce, emptyPayloadHash)
    if (!this.cfg.verifier.verifyNodeSig(message, signature, senderId)) {
      this.authInvalidRequests += 1
      if (authMode === "enforce") {
        this.authRejectedRequests += 1
        res.writeHead(401, { "content-type": "application/json" })
        res.end(serializeJson({ error: "invalid auth signature" }))
        return false
      }
      return true
    }

    // Replay check
    const replayKey = `${senderId.toLowerCase()}:${nonce}`
    if (this.authNonceTracker.has(replayKey)) {
      this.authInvalidRequests += 1
      if (authMode === "enforce") {
        this.authRejectedRequests += 1
        res.writeHead(401, { "content-type": "application/json" })
        res.end(serializeJson({ error: "auth nonce replay detected" }))
        return false
      }
      return true
    }
    this.authNonceTracker.add(replayKey)

    this.authAcceptedRequests += 1
    return true
  }

  private recordInboundAuthFailure(
    kind: "missing" | "invalid",
    inboundIpPeerId: string,
    inboundSenderPeerId?: string,
  ): void {
    if (kind === "invalid") {
      this.scoring.recordInvalidData(inboundIpPeerId)
      if (inboundSenderPeerId) this.scoring.recordInvalidData(inboundSenderPeerId)
      return
    }
    this.scoring.recordFailure(inboundIpPeerId)
    if (inboundSenderPeerId) this.scoring.recordFailure(inboundSenderPeerId)
  }

  private recordInboundAuthSuccess(
    inboundIpPeerId: string,
    inboundSenderPeerId?: string,
  ): void {
    this.scoring.recordSuccess(inboundIpPeerId)
    if (inboundSenderPeerId) this.scoring.recordSuccess(inboundSenderPeerId)
  }

  private recordDiscoveryIdentityFailure(peer: NodePeer, kind: "invalid" | "failure"): void {
    this.discoveryIdentityFailures += 1
    this.scoring.addPeer(peer.id, peer.url)
    if (kind === "invalid") {
      this.scoring.recordInvalidData(peer.id)
      return
    }
    this.scoring.recordFailure(peer.id)
  }
}

async function requestJson<T = unknown>(url: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const endpoint = new URL(url)

  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const settleResolve = (value: T) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const settleReject = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const req = httpRequest(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: `${endpoint.pathname}${endpoint.search}`,
        method,
        headers: {
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let totalBytes = 0

        res.on("data", (chunk: Buffer | string) => {
          const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
          totalBytes += buf.byteLength
          if (totalBytes > MAX_RESPONSE_BODY) {
            req.destroy(new Error(`response body too large: ${totalBytes} > ${MAX_RESPONSE_BODY}`))
            return
          }
          chunks.push(buf)
        })
        res.on("error", settleReject)
        res.on("end", () => {
          if (settled) return
          try {
            const data = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : ""
            const parsed = data.length > 0 ? JSON.parse(data) : {}
            if ((res.statusCode ?? 500) >= 400) {
              settleReject(new Error(`HTTP ${res.statusCode}: ${data}`))
              return
            }
            settleResolve(parsed as T)
          } catch (error) {
            settleReject(error)
          }
        })
      },
    )

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`))
    })
    req.on("error", settleReject)
    if (method === "POST") {
      req.write(serializeJson(body ?? {}))
    }
    req.end()
  })
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, input) => {
    if (typeof input === "bigint") {
      return input.toString()
    }
    return input
  })
}

function ensurePayloadObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("p2p payload must be an object")
  }
  return payload as Record<string, unknown>
}

function stripAuthEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const next = { ...payload }
  delete next._auth
  return next
}

function hashP2PPayload(payload: Record<string, unknown>): Hex {
  const stable = stableStringify(payload)
  return `0x${keccak256Hex(Buffer.from(stable, "utf8"))}` as Hex
}

function hasAuthEnvelope(payload: Record<string, unknown>): boolean {
  return !!payload._auth && typeof payload._auth === "object" && !Array.isArray(payload._auth)
}

function extractAuthSenderId(payload: Record<string, unknown>): string | undefined {
  const auth = payload._auth
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined
  const senderId = String((auth as Record<string, unknown>).senderId ?? "").trim().toLowerCase()
  if (!senderId) return undefined
  return senderId
}

function resolveInboundAuthMode(cfg: P2PConfig): "off" | "monitor" | "enforce" {
  if (cfg.inboundAuthMode === "off" || cfg.inboundAuthMode === "monitor" || cfg.inboundAuthMode === "enforce") {
    return cfg.inboundAuthMode
  }
  if (cfg.enableInboundAuth === true) {
    return "enforce"
  }
  return "off"
}

function stableStringify(value: unknown): string {
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString())
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const props = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${props.join(",")}}`
}
