/**
 * Unit tests for the shared RPC validation layer (PR-1Q).
 *
 * Covers every exported helper plus the byte-level guarantee that
 * validation failures throw a literal `{ code, message }` object — NOT
 * an Error instance — so the HTTP / WebSocket layers' error-envelope
 * building stays unchanged.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import {
  invalidParams,
  methodNotFound,
  invalidRequest,
  parseError,
  limitExceeded,
  internalError,
  safeBigInt,
  parseBlockTag,
  requireHexParam,
  optionalHexParam,
  requireAddressParam,
  requireTxHashParam,
  requireBlockHashParam,
  requireIndexParam,
  requireFilterId,
  requireCallObject,
  requireFilterObject,
  requireStringParam,
  validateTxCallFields,
  validateLogFilter,
  sanitizeEthersError,
  sanitizeJsonParseError,
} from "./rpc-validators.ts"

function captureThrow(fn: () => unknown): { code?: number; message?: string } {
  try {
    fn()
    assert.fail("expected throw, but function returned normally")
  } catch (e) {
    assert.ok(e && typeof e === "object", `thrown value must be object, got ${typeof e}`)
    assert.ok(!(e instanceof Error), "must throw plain object, not Error instance")
    return e as { code?: number; message?: string }
  }
}

describe("rpc-validators: error throws (byte-identical JSON-RPC shape)", () => {
  test("invalidParams throws { code: -32602, message }", () => {
    const e = captureThrow(() => invalidParams("bad"))
    assert.equal(e.code, -32602)
    assert.equal(e.message, "bad")
  })

  test("methodNotFound throws { code: -32601, message }", () => {
    const e = captureThrow(() => methodNotFound("nope"))
    assert.equal(e.code, -32601)
    assert.equal(e.message, "nope")
  })

  test("invalidRequest throws { code: -32600, message }", () => {
    const e = captureThrow(() => invalidRequest("envelope"))
    assert.equal(e.code, -32600)
    assert.equal(e.message, "envelope")
  })

  test("parseError throws { code: -32700, message }", () => {
    const e = captureThrow(() => parseError("malformed"))
    assert.equal(e.code, -32700)
    assert.equal(e.message, "malformed")
  })

  test("limitExceeded throws { code: -32005, message }", () => {
    const e = captureThrow(() => limitExceeded("too many"))
    assert.equal(e.code, -32005)
    assert.equal(e.message, "too many")
  })

  test("internalError throws { code: -32603, message }", () => {
    const e = captureThrow(() => internalError("oops"))
    assert.equal(e.code, -32603)
    assert.equal(e.message, "oops")
  })
})

describe("safeBigInt", () => {
  test("accepts decimal string", () => {
    assert.equal(safeBigInt("12345"), 12345n)
  })

  test("accepts 0x hex string", () => {
    assert.equal(safeBigInt("0xff"), 255n)
  })

  test("rejects oversized input (>78 chars) without BigInt() invocation", () => {
    const huge = "1".repeat(80)
    const e = captureThrow(() => safeBigInt(huge))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /input too large/)
  })

  test("rejects malformed input via BigInt() catch", () => {
    const e = captureThrow(() => safeBigInt("abc"))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /invalid block number/)
  })

  test("#250: rejects empty string (no silent BigInt('') = 0n)", () => {
    const e = captureThrow(() => safeBigInt(""))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /empty/)
  })

  test("rejects non-string input", () => {
    const e = captureThrow(() => safeBigInt(42 as unknown as string))
    assert.equal(e.code, -32602)
  })

  test("truncates ridiculously long input in error message to ≤40 chars", () => {
    const e = captureThrow(() => safeBigInt("zz" + "x".repeat(50)))
    assert.equal(e.code, -32602)
    assert.ok((e.message ?? "").length < 80, "error message must not echo full input")
  })
})

describe("parseBlockTag", () => {
  test("undefined/null fall back to fallback height", () => {
    assert.equal(parseBlockTag(undefined, 100n), 100n)
    assert.equal(parseBlockTag(null, 100n), 100n)
  })

  test('"latest" / "pending" return fallback', () => {
    assert.equal(parseBlockTag("latest", 100n), 100n)
    assert.equal(parseBlockTag("pending", 100n), 100n)
  })

  test('"safe" / "finalized" return finalizedHeight if provided', () => {
    assert.equal(parseBlockTag("safe", 100n, 80n), 80n)
    assert.equal(parseBlockTag("finalized", 100n, 80n), 80n)
  })

  test('"safe" / "finalized" fall back to height when finalizedHeight unset', () => {
    assert.equal(parseBlockTag("safe", 100n), 100n)
  })

  test('"earliest" returns 0n', () => {
    assert.equal(parseBlockTag("earliest", 100n), 0n)
  })

  test("hex quantity returns parsed bigint", () => {
    assert.equal(parseBlockTag("0x10", 100n), 16n)
  })

  test("integer number returns as bigint", () => {
    assert.equal(parseBlockTag(5, 100n), 5n)
  })

  test("rejects fractional number (#188)", () => {
    const e = captureThrow(() => parseBlockTag(1.5, 100n))
    assert.equal(e.code, -32602)
  })

  test("rejects negative number", () => {
    const e = captureThrow(() => parseBlockTag(-1, 100n))
    assert.equal(e.code, -32602)
  })

  test("rejects negative hex (string form)", () => {
    // safeBigInt("-1") returns -1n which validates to rejection
    const e = captureThrow(() => parseBlockTag("-1", 100n))
    assert.equal(e.code, -32602)
  })

  test("rejects array / object / boolean shapes (#194)", () => {
    assert.equal(captureThrow(() => parseBlockTag([], 100n)).code, -32602)
    assert.equal(captureThrow(() => parseBlockTag({}, 100n)).code, -32602)
    assert.equal(captureThrow(() => parseBlockTag(true, 100n)).code, -32602)
  })
})

describe("requireHexParam", () => {
  test("accepts valid 0x-prefixed hex", () => {
    assert.equal(requireHexParam(["0xabcd"], 0, "data"), "0xabcd")
  })

  test("rejects non-string", () => {
    const e = captureThrow(() => requireHexParam([42], 0, "data"))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /expected hex string/)
  })

  test("rejects missing 0x prefix", () => {
    const e = captureThrow(() => requireHexParam(["abcd"], 0, "data"))
    assert.equal(e.code, -32602)
  })

  test("rejects > 66 char hex", () => {
    const tooLong = "0x" + "f".repeat(65)
    const e = captureThrow(() => requireHexParam([tooLong], 0, "data"))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /malformed hex/)
  })

  test("rejects non-hex chars", () => {
    const e = captureThrow(() => requireHexParam(["0xzz"], 0, "data"))
    assert.equal(e.code, -32602)
  })

  test("rejects undefined params array", () => {
    const e = captureThrow(() => requireHexParam(undefined as unknown as unknown[], 0, "data"))
    assert.equal(e.code, -32602)
  })
})

describe("optionalHexParam", () => {
  test("returns undefined for null/undefined", () => {
    assert.equal(optionalHexParam([null], 0), undefined)
    assert.equal(optionalHexParam([undefined], 0), undefined)
    assert.equal(optionalHexParam([], 0), undefined)
  })

  test("returns undefined for malformed (no throw)", () => {
    assert.equal(optionalHexParam(["abcd"], 0), undefined)
    assert.equal(optionalHexParam([42], 0), undefined)
  })

  test("returns valid hex unchanged", () => {
    assert.equal(optionalHexParam(["0xff"], 0), "0xff")
  })
})

describe("requireAddressParam (#122)", () => {
  const valid = "0x" + "a".repeat(40)

  test("accepts 40-hex address", () => {
    assert.equal(requireAddressParam([valid], 0), valid)
  })

  test("rejects short hex (40 chars total fail)", () => {
    const e = captureThrow(() => requireAddressParam(["0x123"], 0))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /\{40\}/)
  })

  test("rejects long hex", () => {
    const e = captureThrow(() => requireAddressParam(["0x" + "a".repeat(41)], 0))
    assert.equal(e.code, -32602)
  })

  test("rejects non-string", () => {
    const e = captureThrow(() => requireAddressParam([42], 0))
    assert.equal(e.code, -32602)
  })

  test("uses custom name in error", () => {
    const e = captureThrow(() => requireAddressParam(["x"], 0, "from"))
    assert.match(e.message ?? "", /from/)
  })
})

describe("requireTxHashParam (#150)", () => {
  const validHash = "0x" + "1".repeat(64)

  test("accepts 64-hex hash", () => {
    assert.equal(requireTxHashParam([validHash], 0), validHash)
  })

  test("rejects short hash", () => {
    const e = captureThrow(() => requireTxHashParam(["0x123"], 0))
    assert.equal(e.code, -32602)
  })

  test("rejects long hash", () => {
    const e = captureThrow(() => requireTxHashParam(["0x" + "1".repeat(65)], 0))
    assert.equal(e.code, -32602)
  })

  test("rejects non-string", () => {
    const e = captureThrow(() => requireTxHashParam([null], 0))
    assert.equal(e.code, -32602)
  })

  test("#364: normalizes mixed-case to lowercase for Map.get parity", () => {
    // ETH JSON-RPC hashes are case-INsensitive — geth accepts both
    // `0xABCD…` and `0xabcd…`. Pre-fix the downstream `chain.blockByHash
    // .get(hash)` / `txByHash.get(hash)` used the as-received case, so
    // `0xBBAD…` returned null indistinguishable from "no such tx" even
    // when the lowercased equivalent existed.
    const mixed  = "0xBBaD93Ae799eCB20E5A0Dd43Dc1211Bb4141572399cD0E23E40F9B92388B3D31"
    const lower  = "0xbbad93ae799ecb20e5a0dd43dc1211bb4141572399cd0e23e40f9b92388b3d31"
    assert.equal(requireTxHashParam([mixed], 0), lower)
    // All-caps must also normalize.
    const upper = "0xBBAD93AE799ECB20E5A0DD43DC1211BB4141572399CD0E23E40F9B92388B3D31"
    assert.equal(requireTxHashParam([upper], 0), lower)
    // Already-lowercased passes through unchanged.
    assert.equal(requireTxHashParam([lower], 0), lower)
  })
})

describe("requireBlockHashParam (#166)", () => {
  const validHash = "0x" + "f".repeat(64)

  test("accepts 64-hex hash", () => {
    assert.equal(requireBlockHashParam([validHash], 0), validHash)
  })

  test("error message labels as 'block hash'", () => {
    const e = captureThrow(() => requireBlockHashParam(["0x"], 0))
    assert.match(e.message ?? "", /block hash/)
  })
})

describe("requireIndexParam (#198)", () => {
  test("accepts 0x0", () => {
    assert.equal(requireIndexParam(["0x0"], 0), 0)
  })

  test("accepts 0xff", () => {
    assert.equal(requireIndexParam(["0xff"], 0), 255)
  })

  test("rejects decimal string", () => {
    const e = captureThrow(() => requireIndexParam(["5"], 0))
    assert.equal(e.code, -32602)
  })

  test("rejects non-string (true was the historical bug)", () => {
    const e = captureThrow(() => requireIndexParam([true], 0))
    assert.equal(e.code, -32602)
  })

  test("rejects missing 0x prefix", () => {
    const e = captureThrow(() => requireIndexParam(["ff"], 0))
    assert.equal(e.code, -32602)
  })

  test("rejects 0x alone (no digits)", () => {
    const e = captureThrow(() => requireIndexParam(["0x"], 0))
    assert.equal(e.code, -32602)
  })
})

describe("requireFilterId (#196)", () => {
  const validId = "0x" + "0".repeat(32)

  test("accepts 32-hex filter id and lowercases it", () => {
    // FILTER_ID_RE is case-insensitive on the hex chars; the `0x` prefix
    // must be lowercase. Mix-case hex stays valid but is normalized to
    // lowercase by the helper.
    const mixed = "0x" + "AaBbCcDdEeFf00112233445566778899".slice(0, 32)
    const out = requireFilterId([mixed], 0)
    assert.equal(out, mixed.toLowerCase())
  })

  test("rejects short id", () => {
    const e = captureThrow(() => requireFilterId(["0x123"], 0))
    assert.equal(e.code, -32602)
  })

  test("rejects non-string (true / number / array)", () => {
    assert.equal(captureThrow(() => requireFilterId([true], 0)).code, -32602)
    assert.equal(captureThrow(() => requireFilterId([42], 0)).code, -32602)
    assert.equal(captureThrow(() => requireFilterId([[]], 0)).code, -32602)
  })
})

describe("requireCallObject (#172)", () => {
  test("returns undefined for null / undefined (geth ergonomic)", () => {
    assert.equal(requireCallObject(null, "eth_call"), undefined)
    assert.equal(requireCallObject(undefined, "eth_call"), undefined)
  })

  test("accepts object", () => {
    const obj = { to: "0x1" }
    assert.equal(requireCallObject(obj, "eth_call"), obj)
  })

  test("rejects string", () => {
    const e = captureThrow(() => requireCallObject("0x1", "eth_call"))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /eth_call/)
  })

  test("rejects array", () => {
    const e = captureThrow(() => requireCallObject([], "eth_call"))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /array/)
  })

  test("rejects number / boolean", () => {
    assert.equal(captureThrow(() => requireCallObject(1, "eth_call")).code, -32602)
    assert.equal(captureThrow(() => requireCallObject(true, "eth_call")).code, -32602)
  })
})

describe("requireFilterObject (#238)", () => {
  test("returns {} for null / undefined (eth_getLogs(null) default range)", () => {
    assert.deepEqual(requireFilterObject(null), {})
    assert.deepEqual(requireFilterObject(undefined), {})
  })

  test("accepts object", () => {
    assert.deepEqual(requireFilterObject({ fromBlock: "0x0" }), { fromBlock: "0x0" })
  })

  test("rejects array", () => {
    const e = captureThrow(() => requireFilterObject([]))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /array/)
  })

  test("rejects string / boolean / number", () => {
    assert.equal(captureThrow(() => requireFilterObject("x")).code, -32602)
    assert.equal(captureThrow(() => requireFilterObject(true)).code, -32602)
    assert.equal(captureThrow(() => requireFilterObject(5)).code, -32602)
  })
})

describe("requireStringParam (#242)", () => {
  test("accepts non-empty string", () => {
    assert.equal(requireStringParam(["abc"], 0, "agentId"), "abc")
  })

  test("rejects null / undefined / empty string as missing", () => {
    assert.match(captureThrow(() => requireStringParam([null], 0, "x")).message ?? "", /missing/)
    assert.match(captureThrow(() => requireStringParam([undefined], 0, "x")).message ?? "", /missing/)
    assert.match(captureThrow(() => requireStringParam([""], 0, "x")).message ?? "", /missing/)
  })

  test("rejects non-string (number / boolean / array / object)", () => {
    assert.equal(captureThrow(() => requireStringParam([42], 0, "x")).code, -32602)
    assert.equal(captureThrow(() => requireStringParam([true], 0, "x")).code, -32602)
    assert.equal(captureThrow(() => requireStringParam([[1]], 0, "x")).code, -32602)
    assert.equal(captureThrow(() => requireStringParam([{}], 0, "x")).code, -32602)
  })
})

describe("validateTxCallFields (#148)", () => {
  test("accepts all hex quantity fields", () => {
    validateTxCallFields({
      value: "0x10",
      gas: "0x5208",
      gasPrice: "0x1",
      maxFeePerGas: "0x2",
      maxPriorityFeePerGas: "0x1",
      data: "0xabcd",
    })
  })

  test("accepts omitted / empty fields", () => {
    validateTxCallFields({})
    validateTxCallFields({ value: undefined, gas: null, gasPrice: "" })
  })

  test("rejects non-hex value", () => {
    const e = captureThrow(() => validateTxCallFields({ value: "100" }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /value/)
  })

  test("rejects non-hex gas", () => {
    const e = captureThrow(() => validateTxCallFields({ gas: 21000 as unknown as string }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /gas/)
  })

  test("rejects odd-length data", () => {
    const e = captureThrow(() => validateTxCallFields({ data: "0xabc" }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /data/)
  })

  test("accepts empty data (0x)", () => {
    validateTxCallFields({ data: "0x" })
  })

  test("#352: rejects gas hex over 16-digit uint64 cap (BigInt O(n²) DoS)", () => {
    const overlong = "0x" + "a".repeat(17) // 19 chars total > 18 cap
    const e = captureThrow(() => validateTxCallFields({ gas: overlong }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /gas too large.*uint64/)
  })

  test("#352: rejects nonce hex over 16-digit uint64 cap", () => {
    const overlong = "0x" + "f".repeat(20)
    const e = captureThrow(() => validateTxCallFields({ nonce: overlong }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /nonce too large.*uint64/)
  })

  test("#352: rejects value hex over 64-digit uint256 cap", () => {
    const overlong = "0x" + "1".repeat(65)
    const e = captureThrow(() => validateTxCallFields({ value: overlong }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /value too large.*uint256/)
  })

  test("#352: rejects 100k-char hex gas (CPU DoS payload)", () => {
    const huge = "0x" + "a".repeat(100_000)
    const e = captureThrow(() => validateTxCallFields({ gas: huge }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /gas too large/)
  })

  test("#352: accepts exactly uint256-max value (regression guard)", () => {
    const max256 = "0x" + "f".repeat(64)
    validateTxCallFields({ value: max256 })
    validateTxCallFields({ gasPrice: max256 })
  })

  test("#352: accepts exactly uint64-max gas (regression guard)", () => {
    const max64 = "0x" + "f".repeat(16)
    validateTxCallFields({ gas: max64, nonce: max64 })
  })
})

describe("validateLogFilter", () => {
  test("returns address / addresses / topics on valid input", () => {
    const addr = "0x" + "a".repeat(40)
    const topic = "0x" + "1".repeat(64)
    const q: Record<string, unknown> = { address: addr, topics: [topic, null, [topic]] }
    const out = validateLogFilter(q)
    assert.equal(out.address, addr)
    assert.deepEqual(out.topics, [topic, null, [topic]])
  })

  test("normalizes blockHash + address + topics to lowercase", () => {
    const addr = "0x" + "A".repeat(40)
    const topic = "0x" + "B".repeat(64)
    const q: Record<string, unknown> = { blockHash: topic, address: addr, topics: [topic] }
    const out = validateLogFilter(q)
    assert.equal(out.address, addr.toLowerCase())
    assert.deepEqual(out.topics, [topic.toLowerCase()])
    assert.equal(q.blockHash, topic.toLowerCase())
  })

  test("#186: rejects malformed blockHash shape", () => {
    const e = captureThrow(() => validateLogFilter({ blockHash: "0x123" }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /blockHash/)
  })

  test("rejects malformed address", () => {
    const e = captureThrow(() => validateLogFilter({ address: "0xabc" }))
    assert.equal(e.code, -32602)
  })

  test("accepts address array up to 100 entries", () => {
    const addr = "0x" + "a".repeat(40)
    validateLogFilter({ address: Array.from({ length: 100 }, () => addr) })
  })

  test("rejects address array >100", () => {
    const addr = "0x" + "a".repeat(40)
    const e = captureThrow(() => validateLogFilter({ address: Array.from({ length: 101 }, () => addr) }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /address array too large/)
  })

  test("#190: rejects non-array topics", () => {
    const e = captureThrow(() => validateLogFilter({ topics: "0xabc" }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /array/)
  })

  test("rejects topics array >4", () => {
    const topic = "0x" + "1".repeat(64)
    const e = captureThrow(() => validateLogFilter({ topics: [topic, topic, topic, topic, topic] }))
    assert.equal(e.code, -32602)
    assert.match(e.message ?? "", /topics array too large/)
  })

  test("rejects malformed topic inside OR-array", () => {
    const e = captureThrow(() => validateLogFilter({ topics: [["0x123"]] }))
    assert.equal(e.code, -32602)
  })
})

describe("sanitizeEthersError", () => {
  test("strips INVALID_ARGUMENT code to fallback", () => {
    const err = { code: "INVALID_ARGUMENT", message: "leaked ethers wording" }
    assert.equal(sanitizeEthersError(err), "encoding failed")
  })

  test("strips BUFFER_OVERRUN code to fallback", () => {
    const err = { code: "BUFFER_OVERRUN" }
    assert.equal(sanitizeEthersError(err), "encoding failed")
  })

  test("uses custom fallback message", () => {
    const err = { code: "INVALID_ARGUMENT" }
    assert.equal(sanitizeEthersError(err, "transaction decode failed"), "transaction decode failed")
  })

  test("strips .reason containing 'version' (leak)", () => {
    const err = { reason: "ethers version 6.x mismatch" }
    assert.equal(sanitizeEthersError(err), "encoding failed")
  })

  test("returns fallback for non-object input", () => {
    assert.equal(sanitizeEthersError(null), "encoding failed")
    assert.equal(sanitizeEthersError(undefined), "encoding failed")
    assert.equal(sanitizeEthersError("raw string error"), "encoding failed")
  })

  test("returns fallback for object without recognized fields", () => {
    assert.equal(sanitizeEthersError({}), "encoding failed")
  })
})

describe("sanitizeJsonParseError", () => {
  test("strips V8 SyntaxError to constant phrase", () => {
    const err = new SyntaxError("Unexpected token } in JSON at position 47")
    assert.equal(sanitizeJsonParseError(err), "malformed JSON request body")
  })

  test("returns same phrase for null / undefined / non-Error", () => {
    assert.equal(sanitizeJsonParseError(null), "malformed JSON request body")
    assert.equal(sanitizeJsonParseError(undefined), "malformed JSON request body")
    assert.equal(sanitizeJsonParseError("string"), "malformed JSON request body")
  })
})
