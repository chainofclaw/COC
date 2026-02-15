import type http from "node:http"
import type { PoSeEngine } from "./pose-engine.ts"
import type { ChallengeMessage, ReceiptMessage } from "../../services/common/pose-types.ts"
import { RateLimiter } from "./rate-limiter.ts"

const MAX_POSE_BODY = 1024 * 1024 // 1 MB
const poseRateLimiter = new RateLimiter(60_000, 60)
setInterval(() => poseRateLimiter.cleanup(), 300_000).unref()

interface PoseRouteHandler {
  method: string
  path: string
  handler: (body: string, res: http.ServerResponse) => void
}

export function registerPoseRoutes(
  pose: PoSeEngine,
): PoseRouteHandler[] {
  return [
    {
      method: "POST",
      path: "/pose/challenge",
      handler: (body, res) => {
        const payload = JSON.parse(body || "{}") as { nodeId?: string }
        if (!payload.nodeId) {
          return jsonResponse(res, 400, { error: "missing nodeId" })
        }
        const challenge = pose.issueChallenge(payload.nodeId)
        if (!challenge) {
          return jsonResponse(res, 429, { error: "challenge quota exceeded" })
        }
        return jsonResponse(res, 200, challenge)
      },
    },
    {
      method: "POST",
      path: "/pose/receipt",
      handler: (body, res) => {
        const payload = JSON.parse(body || "{}") as { challengeId?: string; challenge?: unknown; receipt?: unknown }
        if (!payload.receipt) {
          return jsonResponse(res, 400, { error: "missing receipt" })
        }

        const rc = payload.receipt as Record<string, unknown>
        if (!rc.challengeId || !rc.nodeId || !rc.nodeSig) {
          return jsonResponse(res, 400, { error: "invalid receipt: missing challengeId, nodeId, or nodeSig" })
        }
        const challengeId = payload.challengeId
          ?? String((payload.challenge as Record<string, unknown> | undefined)?.challengeId ?? rc.challengeId)
        if (!challengeId.startsWith("0x")) {
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
      handler: (_body, res) => {
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
    route.handler("", res)
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
      route.handler(body, res)
    } catch (error) {
      jsonResponse(res, 500, { error: String(error) })
    }
  })
  return true
}

function jsonResponse(res: http.ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  ))
}
