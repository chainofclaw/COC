import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  getVerifyRateLimitClientIp,
  isVerifyTrustProxyEnabled,
} from "./verify-client-ip.ts"

describe("verify API client IP resolution", () => {
  it("does not trust proxy headers by default", () => {
    const headers = new Headers({
      "x-real-ip": "203.0.113.10",
      "x-forwarded-for": "203.0.113.11, 10.0.0.2",
    })

    assert.equal(getVerifyRateLimitClientIp(headers, false), "direct")
  })

  it("uses x-real-ip when trust proxy is enabled", () => {
    const headers = new Headers({
      "x-real-ip": "203.0.113.10",
      "x-forwarded-for": "203.0.113.11, 10.0.0.2",
    })

    assert.equal(getVerifyRateLimitClientIp(headers, true), "203.0.113.10")
  })

  it("uses the last forwarded-for hop when trust proxy is enabled", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.11, 10.0.0.2",
    })

    assert.equal(getVerifyRateLimitClientIp(headers, true), "10.0.0.2")
  })

  it("returns unknown when trust proxy is enabled without forwarded headers", () => {
    assert.equal(getVerifyRateLimitClientIp(new Headers(), true), "unknown")
  })

  it("only enables proxy trust with explicit opt-in", () => {
    assert.equal(isVerifyTrustProxyEnabled("1"), true)
    assert.equal(isVerifyTrustProxyEnabled("true"), false)
    assert.equal(isVerifyTrustProxyEnabled(undefined), false)
  })
})
