import crypto from "node:crypto"
import type http from "node:http"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { PoSeEngine } from "./pose-engine.ts"
import type { ChallengeMessage, ReceiptMessage } from "../../services/common/pose-types.ts"
import { RateLimiter } from "./rate-limiter.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"

const MAX_POSE_BODY = 1024 * 1024 // 1 MB
const poseRateLimiter = new RateLimiter(60_000, 60)
setInterval(() => poseRateLimiter.cleanup(), 300_000).unref()
const DEFAULT_POSE_AUTH_MAX_CLOCK_SKEW_MS = 120_000
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/

export interface PoseAuthEnvelope {
  senderId: string
  timestampMs: number
  nonce: string
  signature: string
}

interface AuthNonceTracker {
  has(value: string): boolean
  add(value: string): void
}

export interface PoseAuthNonceTrackerOptions {
  maxSize: number
  ttlMs: number
  persistencePath?: string
  nowFn?: () => number
}

export class PersistentPoseAuthNonceTracker implements AuthNonceTracker {
  private readonly maxSize: number
  private readonly ttlMs: number
  private readonly persistencePath?: string
  private readonly nowFn: () => number
  private readonly items = new Map<string, number>()

  constructor(options: PoseAuthNonceTrackerOptions) {
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
      // fall back to in-memory tracker if persisted file is unreadable
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

export interface PoseInboundAuthOptions {
  enableInboundAuth?: boolean
  inboundAuthMode?: "off" | "monitor" | "enforce"
  authMaxClockSkewMs?: number
  verifier?: SignatureVerifier
  allowedChallengers?: string[]
  nonceTracker?: AuthNonceTracker
}

const defaultNonceTracker = new PersistentPoseAuthNonceTracker({
  maxSize: 100_000,
  ttlMs: 24 * 60 * 60 * 1000,
})
setInterval(() => defaultNonceTracker.cleanup(), 300_000).unref()

interface PoseRouteHandler {
  method: string
  path: string
  handler: (payload: Record<string, unknown>, res: http.ServerResponse) => void
}

export function registerPoseRoutes(
  pose: PoSeEngine,
): PoseRouteHandler[] {
  return [
    {
      method: "POST",
      path: "/pose/challenge",
      handler: (payload, res) => {
        const nodeId = String(payload.nodeId ?? "").trim()
        if (!nodeId) {
          return jsonResponse(res, 400, { error: "missing nodeId" })
        }
        if (!HEX32_RE.test(nodeId)) {
          return jsonResponse(res, 400, { error: "invalid nodeId: expected hex32" })
        }
        const challenge = pose.issueChallenge(nodeId)
        if (!challenge) {
          return jsonResponse(res, 429, { error: "challenge quota exceeded" })
        }
        return jsonResponse(res, 200, challenge)
      },
    },
    {
      method: "POST",
      path: "/pose/receipt",
      handler: (payload, res) => {
        if (!payload.receipt) {
          return jsonResponse(res, 400, { error: "missing receipt" })
        }

        const rc = payload.receipt as Record<string, unknown>
        if (!rc.challengeId || !rc.nodeId || !rc.nodeSig) {
          return jsonResponse(res, 400, { error: "invalid receipt: missing challengeId, nodeId, or nodeSig" })
        }
        const challengeId = payload.challengeId
          ?? String((payload.challenge as Record<string, unknown> | undefined)?.challengeId ?? rc.challengeId)
        if (!HEX32_RE.test(challengeId)) {
          return jsonResponse(res, 400, { error: "invalid challengeId" })
        }

        try {
          const receipt: ReceiptMessage = {
            ...rc,
            responseAtMs: BigInt(String(rc.responseAtMs ?? 0)),
            responseBody: (rc.responseBody ?? {}) as Record<string, unknown>,
          } as ReceiptMessage
          if (payload.challenge) {
            // If caller sends a full challenge object, enforce it matches the issued one.
            const ch = payload.challenge as Record<string, unknown>
            if (!ch.epochId || !ch.nodeId) {
              return jsonResponse(res, 400, { error: "invalid challenge: missing epochId or nodeId" })
            }
            const challenge: ChallengeMessage = {
              ...ch,
              challengeId: challengeId as `0x${string}`,
              epochId: BigInt(String(ch.epochId)),
              issuedAtMs: BigInt(String(ch.issuedAtMs ?? 0)),
            } as ChallengeMessage
            pose.submitReceipt(challenge, receipt)
          } else {
            pose.submitReceiptByChallengeId(challengeId as `0x${string}`, receipt)
          }
          return jsonResponse(res, 200, { accepted: true })
        } catch (error) {
          return jsonResponse(res, 400, { error: `receipt rejected: ${String(error)}` })
        }
      },
    },
    {
      method: "GET",
      path: "/pose/status",
      handler: (_payload, res) => {
        return jsonResponse(res, 200, {
          epochId: pose.getEpochId().toString(),
          ts: Date.now(),
        })
      },
    },
  ]
}

export function handlePoseRequest(
  routes: PoseRouteHandler[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authOptions: PoseInboundAuthOptions = {},
): boolean {
  const method = req.method ?? ""
  const url = req.url ?? ""

  const route = routes.find((r) => r.method === method && r.path === url)
  if (!route) return false

  // Rate limiting
  const clientIp = req.socket.remoteAddress ?? "unknown"
  if (!poseRateLimiter.allow(clientIp)) {
    jsonResponse(res, 429, { error: "rate limit exceeded" })
    return true
  }

  if (method === "GET") {
    route.handler({}, res)
    return true
  }

  let body = ""
  let bodySize = 0
  let aborted = false
  req.on("data", (chunk: Buffer | string) => {
    bodySize += typeof chunk === "string" ? chunk.length : chunk.byteLength
    if (bodySize > MAX_POSE_BODY) {
      aborted = true
      jsonResponse(res, 413, { error: "body too large" })
      req.destroy()
      return
    }
    body += chunk
  })
  req.on("end", () => {
    if (aborted) return
    try {
      const parsedBody = JSON.parse(body || "{}")
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
        jsonResponse(res, 400, { error: "invalid JSON object body" })
        return
      }

      const authMode = resolveInboundAuthMode(authOptions)
      const allowedChallengers = new Set(
        (authOptions.allowedChallengers ?? []).map((x) => x.toLowerCase()),
      )
      let payload = parsedBody as Record<string, unknown>

      if (authMode !== "off") {
        if (!authOptions.verifier) {
          jsonResponse(res, 500, { error: "pose inbound auth enabled without verifier" })
          return
        }

        if (!hasAuthEnvelope(payload)) {
          if (authMode === "enforce") {
            jsonResponse(res, 401, { error: "missing auth envelope" })
            return
          }
        } else {
          const authCheck = verifySignedPosePayload(url, payload, authOptions.verifier, {
            maxClockSkewMs: authOptions.authMaxClockSkewMs ?? DEFAULT_POSE_AUTH_MAX_CLOCK_SKEW_MS,
            nonceTracker: authOptions.nonceTracker ?? defaultNonceTracker,
          })
          if (!authCheck.ok) {
            if (authMode === "enforce") {
              jsonResponse(res, 401, { error: authCheck.reason })
              return
            }
          } else {
            if (allowedChallengers.size > 0 && !allowedChallengers.has(authCheck.senderId.toLowerCase())) {
              if (authMode === "enforce") {
                jsonResponse(res, 403, { error: "challenger not allowed" })
                return
              }
            } else {
              payload = authCheck.payload
            }
          }
        }
      }

      route.handler(payload, res)
    } catch (error) {
      jsonResponse(res, 400, { error: String(error) })
    }
  })
  return true
}

export function buildPoseAuthMessage(path: string, senderId: string, timestampMs: number, nonce: string, payloadHash: string): string {
  return `pose:http:${path}:${senderId}:${timestampMs}:${nonce}:${payloadHash}`
}

export function buildSignedPosePayload(
  path: string,
  payload: Record<string, unknown>,
  signer: NodeSigner,
  nowMs = Date.now(),
): Record<string, unknown> {
  const payloadHash = hashPayload(payload)
  const nonce = crypto.randomUUID()
  const signature = signer.sign(buildPoseAuthMessage(path, signer.nodeId, nowMs, nonce, payloadHash))
  return {
    ...payload,
    _auth: {
      senderId: signer.nodeId,
      timestampMs: nowMs,
      nonce,
      signature,
    } satisfies PoseAuthEnvelope,
  }
}

export function verifySignedPosePayload(
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
  const maxClockSkewMs = opts.maxClockSkewMs ?? DEFAULT_POSE_AUTH_MAX_CLOCK_SKEW_MS
  if (Math.abs(nowMs - timestampMs) > maxClockSkewMs) {
    return { ok: false, reason: "auth timestamp out of range" }
  }

  const payloadNoAuth = stripAuthEnvelope(obj)
  const replayKey = `${senderId.toLowerCase()}:${nonce}`
  if (opts.nonceTracker?.has(replayKey)) {
    return { ok: false, reason: "auth nonce replay detected" }
  }

  const payloadHash = hashPayload(payloadNoAuth)
  const message = buildPoseAuthMessage(path, senderId, timestampMs, nonce, payloadHash)
  if (!verifier.verifyNodeSig(message, signature, senderId)) {
    return { ok: false, reason: "invalid auth signature" }
  }

  opts.nonceTracker?.add(replayKey)
  return { ok: true, senderId, payload: payloadNoAuth }
}

function jsonResponse(res: http.ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  ))
}

function hasAuthEnvelope(payload: Record<string, unknown>): boolean {
  return !!payload._auth && typeof payload._auth === "object" && !Array.isArray(payload._auth)
}

function stripAuthEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const next = { ...payload }
  delete next._auth
  return next
}

function hashPayload(payload: Record<string, unknown>): `0x${string}` {
  const stable = stableStringify(payload)
  return `0x${keccak256Hex(Buffer.from(stable, "utf8"))}`
}

function resolveInboundAuthMode(opts: PoseInboundAuthOptions): "off" | "monitor" | "enforce" {
  if (opts.inboundAuthMode === "off" || opts.inboundAuthMode === "monitor" || opts.inboundAuthMode === "enforce") {
    return opts.inboundAuthMode
  }
  if (opts.enableInboundAuth === true) {
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
