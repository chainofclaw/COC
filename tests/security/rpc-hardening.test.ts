/**
 * RPC hardening security suite — codifies the testnet security probes
 * (2026-05-17) into a reusable regression test: dangerous-method gating,
 * malformed-input handling, and DoS-amplification limits.
 *
 * Distinct from tests/stress/rpc-validation.test.ts (which checks coc_* param
 * validation): this suite is the attack-surface / hardening view — what an
 * unauthenticated client must NOT be able to do.
 *
 * Targets a live chain via COC_STRESS_RPC (default 127.0.0.1:28780). Skips
 * gracefully when no chain is reachable, so it is CI-safe.
 *
 * Run: COC_STRESS_RPC=http://host:port node --experimental-strip-types --test tests/security/rpc-hardening.test.ts
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { rpc, tryGetHead } from "../../scripts/lib/rpc-helper.ts"

const RPC = process.env.COC_STRESS_RPC ?? "http://127.0.0.1:28780"
const reachable = (await tryGetHead(RPC)) !== null

const METHOD_NOT_FOUND = -32601
const RATE_LIMITED = -32005

interface RawResponse {
  status: number
  body: string
  json: unknown
}

/** POST an arbitrary (possibly malformed) body and capture status + body. */
async function rawPost(body: string): Promise<RawResponse> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let json: unknown = undefined
  try {
    json = JSON.parse(text)
  } catch {
    /* leave undefined — caller asserts on .status / .body */
  }
  return { status: res.status, body: text, json }
}

function assertNodeStillResponds(r: Awaited<ReturnType<typeof rpc<string>>>) {
  if (r.error?.code === RATE_LIMITED) {
    return
  }
  assert.equal(r.error, undefined, "node still answers after malformed traffic")
  assert.match(r.result ?? "", /^0x[0-9a-f]+$/, "eth_blockNumber still answers")
}

describe("RPC hardening (live chain)", { skip: !reachable ? `no chain at ${RPC}` : false }, () => {
  it("gates privileged method namespaces (personal/admin/debug/miner)", async () => {
    for (const method of [
      "personal_listAccounts",
      "personal_unlockAccount",
      "admin_nodeInfo",
      "admin_peers",
      "debug_traceBlockByNumber",
      "miner_start",
    ]) {
      const r = await rpc(RPC, method, [])
      assert.ok(r.error, `${method}: must not be served to an unauthenticated client`)
      assert.equal(r.error!.code, METHOD_NOT_FOUND, `${method}: must be -32601 (gated/unsupported)`)
    }
  })

  it("never exposes unlocked accounts via eth_accounts", async () => {
    const r = await rpc<string[]>(RPC, "eth_accounts", [])
    assert.equal(r.error, undefined, "eth_accounts must not error")
    assert.ok(Array.isArray(r.result), "eth_accounts returns an array")
    assert.equal(r.result!.length, 0, "a public node must hold no unlocked keys")
  })

  it("rejects malformed JSON with a clean parse error (-32700, no HTTP 5xx)", async () => {
    const r = await rawPost("{not valid json")
    assert.notEqual(r.status, 500, "malformed JSON must not produce HTTP 500")
    const env = r.json as { error?: { code: number } }
    assert.equal(env?.error?.code, -32700, "malformed JSON -> -32700 parse error")
  })

  it("rejects an empty request body cleanly", async () => {
    const r = await rawPost("")
    assert.notEqual(r.status, 500, "empty body must not produce HTTP 500")
    const env = r.json as { error?: { code: number } }
    assert.ok(env?.error, "empty body must yield an error envelope")
  })

  it("caps JSON-RPC batch size (no unbounded batch amplification)", async () => {
    const huge = JSON.stringify(
      Array.from({ length: 5000 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_blockNumber", params: [] })),
    )
    const r = await rawPost(huge)
    // Either a hard batch-size cap (single error envelope) or a 4xx — never a
    // 5000-element response and never a crash.
    if (Array.isArray(r.json)) {
      assert.ok(r.json.length < 5000, "batch must not be served unbounded")
    } else {
      const env = r.json as { error?: { code: number } }
      assert.ok(env?.error || r.status >= 400, "oversized batch must be rejected")
    }
  })

  it("rejects an oversized request body without crashing", async () => {
    const huge = `{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x${"a".repeat(8_000_000)}","latest"]}`
    const r = await rawPost(huge)
    assert.notEqual(r.status, 500, "oversized body must not produce HTTP 500")
    assert.ok(r.status === 413 || (r.json as { error?: unknown })?.error, "oversized body -> 413 or clean error")
  })

  it("survives a deeply nested JSON payload (no stack-overflow crash)", async () => {
    const depth = 20_000
    const nested = `{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[${"[".repeat(depth)}${"]".repeat(depth)}]}`
    await rawPost(nested).catch(() => {
      /* a connection-level rejection is acceptable; the liveness check below is what matters */
    })
    const r = await rpc<string>(RPC, "eth_blockNumber", [])
    assertNodeStillResponds(r)
  })

  it("stays healthy after the malformed barrage", async () => {
    const r = await rpc<string>(RPC, "eth_blockNumber", [])
    assertNodeStillResponds(r)
  })
})
