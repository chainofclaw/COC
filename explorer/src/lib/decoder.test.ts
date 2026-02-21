/**
 * Unit tests for explorer decoder utilities.
 * Tests decodeMethodSelector, decodeTransferLog, and formatTokenAmount.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { decodeMethodSelector, decodeTransferLog, formatTokenAmount } from "./decoder.ts"

describe("decodeMethodSelector", () => {
  it("returns null for empty input", () => {
    assert.equal(decodeMethodSelector(""), null)
    assert.equal(decodeMethodSelector("0x"), null)
  })

  it("returns null for short input", () => {
    assert.equal(decodeMethodSelector("0x1234"), null)
  })

  it("decodes known ERC-20 transfer selector", () => {
    const result = decodeMethodSelector("0xa9059cbb0000000000000000000000001234")
    assert.ok(result)
    assert.equal(result.selector, "0xa9059cbb")
    assert.equal(result.name, "transfer(address,uint256)")
  })

  it("decodes known approve selector", () => {
    const result = decodeMethodSelector("0x095ea7b30000000000000000000000001234")
    assert.ok(result)
    assert.equal(result.name, "approve(address,uint256)")
  })

  it("decodes transferFrom selector", () => {
    const result = decodeMethodSelector("0x23b872dd0000000000000000000000001234")
    assert.ok(result)
    assert.equal(result.name, "transferFrom(address,address,uint256)")
  })

  it("decodes balanceOf selector", () => {
    const result = decodeMethodSelector("0x70a08231000000000000000000000000abcd")
    assert.ok(result)
    assert.equal(result.name, "balanceOf(address)")
  })

  it("decodes mint selector", () => {
    const result = decodeMethodSelector("0x40c10f190000000000000000000000001234")
    assert.ok(result)
    assert.equal(result.name, "mint(address,uint256)")
  })

  it("decodes burn selector", () => {
    const result = decodeMethodSelector("0x42966c680000000000000000000000001234")
    assert.ok(result)
    assert.equal(result.name, "burn(uint256)")
  })

  it("decodes deposit (WETH-style) selector", () => {
    const result = decodeMethodSelector("0xd0e30db0")
    assert.ok(result)
    assert.equal(result.name, "deposit()")
  })

  it("decodes withdraw selector", () => {
    const result = decodeMethodSelector("0x2e1a7d4d0000000000000000000000001234")
    assert.ok(result)
    assert.equal(result.name, "withdraw(uint256)")
  })

  it("returns unknown for unrecognized selector", () => {
    const result = decodeMethodSelector("0xdeadbeef0000000000000000000000001234")
    assert.ok(result)
    assert.equal(result.selector, "0xdeadbeef")
    assert.match(result.name, /Unknown/)
  })

  it("handles uppercase hex in selector", () => {
    const result = decodeMethodSelector("0xA9059CBB0000000000000000000000001234")
    assert.ok(result)
    assert.equal(result.name, "transfer(address,uint256)")
  })

  it("works with exact 10-char input (selector only)", () => {
    const result = decodeMethodSelector("0xa9059cbb")
    assert.ok(result)
    assert.equal(result.name, "transfer(address,uint256)")
  })
})

describe("decodeTransferLog", () => {
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"

  const padAddress = (addr: string) =>
    "0x" + "0".repeat(24) + addr.replace("0x", "").toLowerCase()

  it("returns null for empty topics", () => {
    assert.equal(decodeTransferLog({ address: "0x1234", topics: [], data: "0x" }), null)
  })

  it("returns null for insufficient topics", () => {
    assert.equal(
      decodeTransferLog({ address: "0x1234", topics: [TRANSFER_TOPIC], data: "0x" }),
      null,
    )
    assert.equal(
      decodeTransferLog({ address: "0x1234", topics: [TRANSFER_TOPIC, padAddress("0xaabb")], data: "0x" }),
      null,
    )
  })

  it("decodes ERC-20 Transfer event", () => {
    const from = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const to = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const value = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000" // 1e18

    const result = decodeTransferLog({
      address: "0xTokenContract",
      topics: [TRANSFER_TOPIC, padAddress(from), padAddress(to)],
      data: value,
    })

    assert.ok(result)
    assert.equal(result.type, "ERC20-Transfer")
    assert.equal(result.from, from)
    assert.equal(result.to, to)
    assert.equal(result.value, "1000000000000000000")
    assert.equal(result.contractAddress, "0xTokenContract")
  })

  it("decodes ERC-20 Approval event", () => {
    const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const spender = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const value = "0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff"

    const result = decodeTransferLog({
      address: "0xTokenContract",
      topics: [APPROVAL_TOPIC, padAddress(owner), padAddress(spender)],
      data: value,
    })

    assert.ok(result)
    assert.equal(result.type, "ERC20-Approval")
    assert.equal(result.from, owner)
    assert.equal(result.to, spender)
    assert.equal(result.contractAddress, "0xTokenContract")
  })

  it("returns null for unknown event topic", () => {
    const result = decodeTransferLog({
      address: "0x1234",
      topics: [
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        padAddress("0xaaaa"),
        padAddress("0xbbbb"),
      ],
      data: "0x0000000000000000000000000000000000000000000000000000000000000001",
    })
    assert.equal(result, null)
  })

  it("handles zero value transfer", () => {
    const result = decodeTransferLog({
      address: "0xToken",
      topics: [
        TRANSFER_TOPIC,
        padAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        padAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      ],
      data: "0x0000000000000000000000000000000000000000000000000000000000000000",
    })
    assert.ok(result)
    assert.equal(result.value, "0")
  })

  it("handles empty data field", () => {
    const result = decodeTransferLog({
      address: "0xToken",
      topics: [
        TRANSFER_TOPIC,
        padAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        padAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      ],
      data: "0x",
    })
    assert.ok(result)
    assert.equal(result.value, "0")
  })
})

describe("formatTokenAmount", () => {
  it("formats 1e18 as 1", () => {
    assert.equal(formatTokenAmount("1000000000000000000"), "1")
  })

  it("formats 0 as 0", () => {
    assert.equal(formatTokenAmount("0"), "0")
  })

  it("formats fractional amounts", () => {
    const result = formatTokenAmount("1500000000000000000") // 1.5 ETH
    assert.equal(result, "1.5")
  })

  it("formats small fractional amounts", () => {
    const result = formatTokenAmount("100000000000000") // 0.0001 ETH
    assert.equal(result, "0.0001")
  })

  it("formats large amounts", () => {
    const result = formatTokenAmount("1000000000000000000000") // 1000 ETH
    assert.equal(result, "1000")
  })

  it("handles non-standard decimals", () => {
    const result = formatTokenAmount("1000000", 6) // 1 USDC
    assert.equal(result, "1")
  })

  it("handles invalid input gracefully", () => {
    const result = formatTokenAmount("not-a-number")
    assert.equal(result, "not-a-number")
  })

  it("strips trailing zeros from fraction", () => {
    const result = formatTokenAmount("1100000000000000000") // 1.1 ETH
    assert.equal(result, "1.1")
  })
})
