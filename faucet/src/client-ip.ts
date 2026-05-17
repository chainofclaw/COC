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

function lastForwardedFor(value: HeaderValue): string | undefined {
  // A trusted reverse proxy APPENDS the address it observed to
  // X-Forwarded-For (standard nginx `proxy_add_x_forwarded_for`). The
  // rightmost entry is therefore the only one a client cannot forge —
  // taking the leftmost would let any client prepend an arbitrary IP and
  // bypass per-IP rate limiting entirely.
  const items = firstHeaderValue(value)
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return items && items.length > 0 ? items[items.length - 1] : undefined
}

export function resolveFaucetClientIp(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxy = isFaucetTrustProxyEnabled(),
): string {
  if (trustProxy) {
    const realIp = firstHeaderValue(req.headers["x-real-ip"])
    if (realIp) return realIp

    const forwardedFor = lastForwardedFor(req.headers["x-forwarded-for"])
    if (forwardedFor) return forwardedFor
  }

  return normalizeRemoteAddress(req.socket.remoteAddress)
}
