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
  onSnapshotRequest: () => ChainSnapshot
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
  private readonly authNonceTracker: PersistentAuthNonceTracker
  private readonly seenTx = new BoundedSet<Hex>(50_000)
  private readonly seenBlocks = new BoundedSet<Hex>(10_000)
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
    setInterval(() => this.inboundRateLimiter.cleanup(), 300_000).unref()
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
      if ((req.url ?? "").startsWith("/p2p/") && !this.inboundRateLimiter.allow(clientIp)) {
        this.rateLimitedRequests += 1
        res.writeHead(429, { "content-type": "application/json" })
        res.end(serializeJson({ error: "rate limit exceeded" }))
        return
      }

      if (req.method === "GET" && req.url === "/p2p/chain-snapshot") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(serializeJson(this.handlers.onSnapshotRequest()))
        return
      }

      if (req.method === "GET" && req.url === "/p2p/state-snapshot") {
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
            res.writeHead(500, { "content-type": "application/json" })
            res.end(serializeJson({ error: String(err) }))
          }
        } else {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(serializeJson({ error: "state snapshot not enabled" }))
        }
        return
      }

      if (req.method === "GET" && req.url === "/p2p/peers") {
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
                  res.writeHead(401)
                  res.end(serializeJson({ error: authCheck.reason }))
                  return
                }
              } else {
                this.authAcceptedRequests += 1
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
          res.end(serializeJson({ error: String(error) }))
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
    const results: ChainSnapshot[] = []
    for (const peer of this.cfg.peers) {
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
   * Broadcast a BFT consensus message to all peers.
   */
  async broadcastBft(msg: BftMessagePayload): Promise<void> {
    const dedupeKey = `bft:${msg.type}:${msg.height}:${msg.senderId}`
    await this.broadcast("/p2p/bft-message", msg, dedupeKey)
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
        } catch {
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
        this.discoveryIdentityFailures += 1
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
        this.discoveryIdentityFailures += 1
        log.warn("peer identity signature verification failed", {
          claimed: peer.id,
          url: peer.url,
        })
        return false
      }
      return true
    } catch {
      this.discoveryIdentityFailures += 1
      return false
    }
  }
}

async function requestJson<T = unknown>(url: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const endpoint = new URL(url)

  return await new Promise<T>((resolve, reject) => {
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
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          try {
            const parsed = data.length > 0 ? JSON.parse(data) : {}
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`))
              return
            }
            resolve(parsed as T)
          } catch (error) {
            reject(error)
          }
        })
      },
    )

    req.on("error", reject)
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
