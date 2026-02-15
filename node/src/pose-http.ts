import type http from "node:http"
import type { PoSeEngine } from "./pose-engine.ts"
import type { ChallengeMessage, ReceiptMessage } from "../../services/common/pose-types.ts"

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
        const payload = JSON.parse(body || "{}") as { challenge?: unknown; receipt?: unknown }
        if (!payload.challenge || !payload.receipt) {
          return jsonResponse(res, 400, { error: "missing challenge or receipt" })
        }
        // Validate required fields on challenge and receipt
        const ch = payload.challenge as Record<string, unknown>
        const rc = payload.receipt as Record<string, unknown>
        if (!ch.challengeId || !ch.epochId || !ch.nodeId) {
          return jsonResponse(res, 400, { error: "invalid challenge: missing challengeId, epochId, or nodeId" })
        }
        if (!rc.challengeId || !rc.nodeId || !rc.nodeSig) {
          return jsonResponse(res, 400, { error: "invalid receipt: missing challengeId, nodeId, or nodeSig" })
        }
        try {
          // Convert epochId and timestamp bigints from string/number
          const challenge: ChallengeMessage = {
            ...ch,
            epochId: BigInt(String(ch.epochId)),
            issuedAtMs: BigInt(String(ch.issuedAtMs ?? 0)),
          } as ChallengeMessage
          const receipt: ReceiptMessage = {
            ...rc,
            responseAtMs: BigInt(String(rc.responseAtMs ?? 0)),
            responseBody: (rc.responseBody ?? {}) as Record<string, unknown>,
          } as ReceiptMessage
          pose.submitReceipt(challenge, receipt)
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

  if (method === "GET") {
    route.handler("", res)
    return true
  }

  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
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
