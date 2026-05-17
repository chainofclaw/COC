/**
 * RPC input-validation stress test — captures the Ralph-loop (2026-05-17)
 * coc_* malformed-input probes as a reusable suite: every malformed param must
 * return a clean -32602 (invalid params), never -32603 / HTTP 500 / crash.
 *
 * Targets a live chain via COC_STRESS_RPC (default 127.0.0.1:18780). The whole
 * suite skips gracefully when no chain is reachable, so it is CI-safe.
 *
 * Run: COC_STRESS_RPC=http://host:port node --experimental-strip-types --test tests/stress/rpc-validation.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { rpc, tryGetHead } from "../../scripts/lib/rpc-helper.ts"

const RPC = process.env.COC_STRESS_RPC ?? "http://127.0.0.1:18780"
const reachable = (await tryGetHead(RPC)) !== null

const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

/** Malformed values an address/string param should reject with -32602. */
const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["object", { evil: true }],
  ["array", [1, 2, 3]],
  ["not-an-address", "not-an-address"],
  ["path-traversal", "../../../../etc/passwd"],
  ["oversized-string", "0x" + "f".repeat(4096)],
  ["empty-string", ""],
  ["number", 12345],
  ["boolean", true],
]

describe("RPC input validation (live chain)", { skip: !reachable ? `no chain at ${RPC}` : false }, () => {
  it("coc_chainStats responds cleanly (no-param sanity)", async () => {
    const r = await rpc(RPC, "coc_chainStats", [])
    assert.equal(r.error, undefined, "coc_chainStats must not error")
    assert.notEqual(r.result, undefined, "coc_chainStats returns a result")
  })

  it("coc_getContractInfo rejects every malformed address with -32602", async () => {
    for (const [label, value] of MALFORMED) {
      const r = await rpc(RPC, "coc_getContractInfo", [value])
      assert.ok(r.error, `${label}: must produce an error envelope`)
      assert.notEqual(r.error!.code, INTERNAL_ERROR, `${label}: must not be -32603 internal error`)
      assert.equal(r.error!.code, INVALID_PARAMS, `${label}: must be -32602 invalid params`)
    }
  })

  it("coc_getTransactionsByAddress rejects malformed address with -32602", async () => {
    for (const [label, value] of MALFORMED) {
      const r = await rpc(RPC, "coc_getTransactionsByAddress", [value])
      assert.ok(r.error, `${label}: must produce an error envelope`)
      assert.notEqual(r.error!.code, INTERNAL_ERROR, `${label}: must not be -32603 internal error`)
      assert.equal(r.error!.code, INVALID_PARAMS, `${label}: must be -32602 invalid params`)
    }
  })

  it("coc_getTransactionsByAddress rejects malformed limit/offset with -32602", async () => {
    const valid = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    for (const bad of [-1, 0, 99_999_999, "lots", {}, [5]]) {
      const r = await rpc(RPC, "coc_getTransactionsByAddress", [valid, bad])
      assert.ok(r.error, `limit=${JSON.stringify(bad)}: must error`)
      assert.notEqual(r.error!.code, INTERNAL_ERROR, `limit=${JSON.stringify(bad)}: not -32603`)
      assert.equal(r.error!.code, INVALID_PARAMS, `limit=${JSON.stringify(bad)}: -32602`)
    }
  })

  it("coc_getContractInfo accepts a well-formed address (no -32602)", async () => {
    const r = await rpc(RPC, "coc_getContractInfo", ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"])
    assert.equal(r.error, undefined, "valid address must not be rejected")
  })

  it("eth_getLogs accepts a bounded recent range and returns an array", async () => {
    const headRes = await rpc<string>(RPC, "eth_blockNumber", [])
    const head = parseInt(headRes.result ?? "0x0", 16)
    // A bounded window — full genesis-to-head exceeds the node's range cap on
    // any long-lived chain (see the over-cap test below).
    const from = `0x${Math.max(0, head - 5000).toString(16)}`
    const r = await rpc<unknown[]>(RPC, "eth_getLogs", [{ fromBlock: from, toBlock: headRes.result ?? "latest" }])
    assert.equal(r.error, undefined, "bounded-range eth_getLogs must not error")
    assert.ok(Array.isArray(r.result), "eth_getLogs returns an array")
  })

  it("eth_getLogs rejects an over-cap block range cleanly (-32602, not -32603)", async () => {
    // Genesis-to-head on a long chain exceeds the node's max-range cap; the
    // node must reject it as invalid params, never crash with an internal error.
    const headRes = await rpc<string>(RPC, "eth_blockNumber", [])
    const r = await rpc(RPC, "eth_getLogs", [{ fromBlock: "0x0", toBlock: headRes.result ?? "latest" }])
    if (r.error) {
      assert.notEqual(r.error.code, INTERNAL_ERROR, "over-cap range must not be -32603")
      assert.equal(r.error.code, INVALID_PARAMS, "over-cap range → -32602 invalid params")
    } else {
      assert.ok(Array.isArray(r.result), "short chain: full range still returns an array")
    }
  })

  it("eth_getLogs rejects an inverted block range cleanly", async () => {
    const r = await rpc(RPC, "eth_getLogs", [{ fromBlock: "0x1000000", toBlock: "0x1" }])
    if (r.error) {
      assert.notEqual(r.error.code, INTERNAL_ERROR, "inverted range must not be -32603")
    } else {
      assert.ok(Array.isArray(r.result), "inverted range degrades to empty array")
    }
  })

  it("never crashes the node — chain still answers after the malformed barrage", async () => {
    const r = await rpc<string>(RPC, "eth_blockNumber", [])
    assert.equal(r.error, undefined, "node still healthy")
    assert.match(r.result ?? "", /^0x[0-9a-f]+$/, "eth_blockNumber hex quantity")
  })
})
