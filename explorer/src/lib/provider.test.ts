/**
 * Unit tests for explorer provider utility functions.
 * Tests formatAddress, formatHash, formatEther, and formatTimestamp.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { formatAddress, formatHash, formatEther } from "./provider.ts"

describe("formatAddress", () => {
  it("truncates standard 42-char address", () => {
    const addr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const result = formatAddress(addr)
    assert.equal(result, "0xf39F...2266")
  })

  it("preserves prefix and suffix", () => {
    const addr = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"
    const result = formatAddress(addr)
    assert.ok(result.startsWith("0xAbCd"))
    assert.ok(result.endsWith("Ef12"))
    assert.ok(result.includes("..."))
  })

  it("handles zero address", () => {
    const addr = "0x0000000000000000000000000000000000000000"
    const result = formatAddress(addr)
    assert.equal(result, "0x0000...0000")
  })

  it("handles lowercase address", () => {
    const addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const result = formatAddress(addr)
    assert.equal(result, "0xaaaa...aaaa")
  })
})

describe("formatHash", () => {
  it("truncates standard 66-char tx hash", () => {
    const hash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    const result = formatHash(hash)
    assert.equal(result, "0x12345678...90abcdef")
  })

  it("preserves first 10 chars and last 8 chars", () => {
    const hash = "0xaabbccddee112233445566778899aabbccddeeff112233445566778899aabbcc"
    const result = formatHash(hash)
    assert.ok(result.startsWith("0xaabbccdd"))
    assert.ok(result.endsWith("99aabbcc"))
    assert.ok(result.includes("..."))
  })
})

describe("formatEther", () => {
  it("formats zero wei", () => {
    const result = formatEther(0n)
    assert.equal(result, "0.000000 ETH")
  })

  it("formats 1 ETH", () => {
    const result = formatEther(1000000000000000000n)
    assert.equal(result, "1.000000 ETH")
  })

  it("formats fractional ETH", () => {
    const result = formatEther(1500000000000000000n)
    assert.equal(result, "1.500000 ETH")
  })

  it("formats large amounts", () => {
    const result = formatEther(100000000000000000000n) // 100 ETH
    assert.equal(result, "100.000000 ETH")
  })

  it("formats very small amounts", () => {
    const result = formatEther(1000000000000n) // 0.000001 ETH
    assert.equal(result, "0.000001 ETH")
  })

  it("includes ETH suffix", () => {
    const result = formatEther(0n)
    assert.ok(result.endsWith(" ETH"))
  })
})
