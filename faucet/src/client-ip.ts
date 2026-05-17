import type { IncomingMessage } from "node:http"

type HeaderValue = string | string[] | undefined

export function isFaucetTrustProxyEnabled(value = process.env.COC_FAUCET_TRUST_PROXY): boolean {
  return value === "1"
}

export function normalizeRemoteAddress(ip?: string): string {
  if (!ip) return "unknown"
  if (ip.startsWith("::ffff:")) return ip.slice(7)
  return ip
}

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).find(Boolean)
  }
  const trimmed = value?.trim()
  return trimmed || undefined
}

function firstForwardedFor(value: HeaderValue): string | undefined {
  return firstHeaderValue(value)
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean)
}

export function resolveFaucetClientIp(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxy = isFaucetTrustProxyEnabled(),
): string {
  if (trustProxy) {
    const realIp = firstHeaderValue(req.headers["x-real-ip"])
    if (realIp) return realIp

    const forwardedFor = firstForwardedFor(req.headers["x-forwarded-for"])
    if (forwardedFor) return forwardedFor
  }

  return normalizeRemoteAddress(req.socket.remoteAddress)
}
