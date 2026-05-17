import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  isFaucetTrustProxyEnabled,
  normalizeRemoteAddress,
  resolveFaucetClientIp,
} from "./client-ip.ts"

function requestWith(headers: Record<string, string | string[] | undefined>, remoteAddress?: string) {
  return {
    headers,
    socket: { remoteAddress },
  } as Parameters<typeof resolveFaucetClientIp>[0]
}

describe("faucet client IP resolution", () => {
  it("does not trust proxy headers by default", () => {
    const req = requestWith(
      {
        "x-real-ip": "203.0.113.10",
        "x-forwarded-for": "203.0.113.11, 10.0.0.2",
      },
      "127.0.0.1",
    )

    assert.equal(resolveFaucetClientIp(req, false), "127.0.0.1")
  })

  it("uses x-real-ip when trust proxy is enabled", () => {
    const req = requestWith(
      {
        "x-real-ip": "203.0.113.10",
        "x-forwarded-for": "203.0.113.11, 10.0.0.2",
      },
      "127.0.0.1",
    )

    assert.equal(resolveFaucetClientIp(req, true), "203.0.113.10")
  })

  it("uses the last (trusted-proxy-appended) forwarded-for hop", () => {
    // The rightmost entry is the address the trusted proxy observed; the
    // leftmost is whatever the client chose to send.
    const req = requestWith({ "x-forwarded-for": "203.0.113.11, 10.0.0.2" }, "127.0.0.1")

    assert.equal(resolveFaucetClientIp(req, true), "10.0.0.2")
  })

  it("does not let a client spoof its IP by prepending X-Forwarded-For", () => {
    // Attacker prepends a fake IP; the trusted proxy appends the real one.
    // Per-IP rate limiting must key on the real (rightmost) address so the
    // attacker cannot mint a fresh identity per request.
    const req = requestWith({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }, "127.0.0.1")

    assert.equal(resolveFaucetClientIp(req, true), "198.51.100.7")
  })

  it("normalizes IPv4-mapped socket addresses", () => {
    assert.equal(normalizeRemoteAddress("::ffff:127.0.0.1"), "127.0.0.1")
  })

  it("only enables proxy trust with explicit opt-in", () => {
    assert.equal(isFaucetTrustProxyEnabled("1"), true)
    assert.equal(isFaucetTrustProxyEnabled("true"), false)
    assert.equal(isFaucetTrustProxyEnabled(undefined), false)
  })
})
