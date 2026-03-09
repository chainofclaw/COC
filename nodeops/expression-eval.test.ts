import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { evaluateCondition } from "./expression-eval.ts"

describe("expression-eval", () => {
  const vars = {
    cpuPct: 85,
    memPct: 70,
    diskPct: 50,
    p95LatencyMs: 200,
    peerCount: 12,
  }

  // Simple comparisons
  it("evaluates > correctly", () => {
    assert.equal(evaluateCondition("cpuPct > 80", vars), true)
    assert.equal(evaluateCondition("cpuPct > 90", vars), false)
  })

  it("evaluates < correctly", () => {
    assert.equal(evaluateCondition("memPct < 80", vars), true)
    assert.equal(evaluateCondition("memPct < 50", vars), false)
  })

  it("evaluates >= correctly", () => {
    assert.equal(evaluateCondition("cpuPct >= 85", vars), true)
    assert.equal(evaluateCondition("cpuPct >= 86", vars), false)
  })

  it("evaluates <= correctly", () => {
    assert.equal(evaluateCondition("diskPct <= 50", vars), true)
    assert.equal(evaluateCondition("diskPct <= 49", vars), false)
  })

  it("evaluates == correctly", () => {
    assert.equal(evaluateCondition("peerCount == 12", vars), true)
    assert.equal(evaluateCondition("peerCount == 13", vars), false)
  })

  it("evaluates != correctly", () => {
    assert.equal(evaluateCondition("peerCount != 10", vars), true)
    assert.equal(evaluateCondition("peerCount != 12", vars), false)
  })

  // Logical operators
  it("evaluates && correctly", () => {
    assert.equal(evaluateCondition("cpuPct > 80 && memPct > 60", vars), true)
    assert.equal(evaluateCondition("cpuPct > 80 && memPct > 80", vars), false)
  })

  it("evaluates || correctly", () => {
    assert.equal(evaluateCondition("cpuPct > 90 || memPct > 60", vars), true)
    assert.equal(evaluateCondition("cpuPct > 90 || memPct > 80", vars), false)
  })

  it("evaluates ! correctly", () => {
    assert.equal(evaluateCondition("!(cpuPct > 90)", vars), true)
    assert.equal(evaluateCondition("!(cpuPct > 80)", vars), false)
  })

  // Compound expressions
  it("evaluates complex compound expression", () => {
    assert.equal(
      evaluateCondition("cpuPct > 80 && (memPct > 60 || diskPct > 90)", vars),
      true,
    )
    assert.equal(
      evaluateCondition("cpuPct > 90 && (memPct > 80 || diskPct > 90)", vars),
      false,
    )
  })

  // Variable substitution
  it("substitutes all known variables", () => {
    assert.equal(evaluateCondition("p95LatencyMs > 100", vars), true)
    assert.equal(evaluateCondition("peerCount >= 10", vars), true)
  })

  // Error handling
  it("throws on undefined variable", () => {
    assert.throws(
      () => evaluateCondition("unknownVar > 5", vars),
      { message: /undefined variable/ },
    )
  })

  it("throws on empty expression", () => {
    assert.throws(
      () => evaluateCondition("", vars),
      { message: /empty expression/ },
    )
  })

  it("throws on syntax error", () => {
    assert.throws(
      () => evaluateCondition("cpuPct >", vars),
    )
  })

  it("throws on invalid characters", () => {
    assert.throws(
      () => evaluateCondition("cpuPct @ 90", vars),
      { message: /unexpected character/ },
    )
  })

  // Injection prevention
  it("rejects constructor/prototype injection attempts", () => {
    assert.throws(
      () => evaluateCondition("constructor > 0", vars),
      { message: /undefined variable/ },
    )
  })

  it("rejects expression exceeding max length", () => {
    const longExpr = "cpuPct > 0 && ".repeat(100)
    assert.throws(
      () => evaluateCondition(longExpr, vars),
      { message: /expression too long/ },
    )
  })

  // Parentheses
  it("handles nested parentheses", () => {
    assert.equal(
      evaluateCondition("((cpuPct > 80))", vars),
      true,
    )
  })

  // Decimal numbers
  it("handles decimal number literals", () => {
    assert.equal(evaluateCondition("cpuPct > 84.5", vars), true)
    assert.equal(evaluateCondition("cpuPct > 85.5", vars), false)
  })
})
