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

  it("uses the first forwarded-for hop when trust proxy is enabled", () => {
    const req = requestWith({ "x-forwarded-for": "203.0.113.11, 10.0.0.2" }, "127.0.0.1")

    assert.equal(resolveFaucetClientIp(req, true), "203.0.113.11")
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
