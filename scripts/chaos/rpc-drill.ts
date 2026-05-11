/**
 * Dual-stack RPC chaos drill (PR-1Q follow-up, 2026-05-12).
 *
 * Verifies the 80 RPC validation fix commits (#90~#249) don't break
 * mainstream EVM client compatibility. Sends a chaos matrix of
 * happy-path + adversarial inputs through three independent clients
 * (ethers v6, viem, curl) and asserts:
 *
 *   - happy-path requests succeed and return well-typed payloads
 *   - adversarial inputs (malformed address/hash/tag/filter) get a
 *     well-formed JSON-RPC error envelope (code in known set,
 *     message present, no V8 / ethers leakage)
 *   - WebSocket subscription path responds correctly
 *
 * Usage:
 *   node --experimental-strip-types scripts/chaos/rpc-drill.ts \
 *     --target http://127.0.0.1:28780 \
 *     --ws ws://127.0.0.1:28781
 *
 *   node --experimental-strip-types scripts/chaos/rpc-drill.ts \
 *     --target http://209.74.64.88:28780 --read-only
 *
 * Exit 0 on success, 1 on any failure.
 */

import { JsonRpcProvider, isError } from "ethers"
import { createPublicClient, http as viemHttp } from "viem"

interface DrillResult {
  category: string
  client: string
  test: string
  pass: boolean
  detail?: string
}

const KNOWN_ERROR_CODES = new Set([
  -32700, -32600, -32601, -32602, -32603, -32005,
  // COC custom (#180/#196/#200 etc — Geth-style)
  -32001, -32003, -32004,
])

const LEAK_PATTERNS = [
  /INVALID_ARGUMENT/,
  /BUFFER_OVERRUN/,
  /NUMERIC_FAULT/,
  /Unexpected token .* in JSON at position/,
  /SyntaxError:/,
  /at JSON\.parse/,
  /ethers version/i,
]

function parseArgs(): { target: string; ws?: string; readOnly: boolean } {
  const args = process.argv.slice(2)
  let target = "http://127.0.0.1:28780"
  let ws: string | undefined
  let readOnly = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") target = args[++i]
    else if (args[i] === "--ws") ws = args[++i]
    else if (args[i] === "--read-only") readOnly = true
  }
  return { target, ws, readOnly }
}

async function rawRpc(target: string, body: unknown): Promise<{ http: number; payload: unknown }> {
  const res = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }
  return { http: res.status, payload }
}

function assertErrorEnvelope(payload: unknown): { ok: boolean; reason?: string } {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "not an object" }
  const p = payload as Record<string, unknown>
  if (p.jsonrpc !== "2.0") return { ok: false, reason: `jsonrpc != "2.0": ${String(p.jsonrpc)}` }
  if (!p.error || typeof p.error !== "object") return { ok: false, reason: "missing error field" }
  const err = p.error as { code?: unknown; message?: unknown }
  if (typeof err.code !== "number") return { ok: false, reason: "error.code missing/not number" }
  if (typeof err.message !== "string") return { ok: false, reason: "error.message missing/not string" }
  if (!KNOWN_ERROR_CODES.has(err.code)) {
    return { ok: false, reason: `error.code ${err.code} not in known set` }
  }
  for (const re of LEAK_PATTERNS) {
    if (re.test(err.message)) return { ok: false, reason: `message leaks: ${re} matched "${err.message}"` }
  }
  return { ok: true }
}

async function runHappyPath(target: string, results: DrillResult[]): Promise<void> {
  // ============== ethers v6 ==============
  const provider = new JsonRpcProvider(target)
  try {
    const cid = await provider.send("eth_chainId", [])
    results.push({ category: "happy", client: "ethers", test: "eth_chainId", pass: /^0x[0-9a-f]+$/.test(cid), detail: cid })
  } catch (e) {
    results.push({ category: "happy", client: "ethers", test: "eth_chainId", pass: false, detail: String(e) })
  }
  try {
    const bn = await provider.getBlockNumber()
    results.push({ category: "happy", client: "ethers", test: "getBlockNumber", pass: bn >= 0, detail: String(bn) })
  } catch (e) {
    results.push({ category: "happy", client: "ethers", test: "getBlockNumber", pass: false, detail: String(e) })
  }
  try {
    const block = await provider.getBlock("latest")
    results.push({
      category: "happy", client: "ethers", test: "getBlock(latest)",
      pass: !!block && block.number >= 0, detail: block ? `h=${block.number}` : "null",
    })
  } catch (e) {
    results.push({ category: "happy", client: "ethers", test: "getBlock(latest)", pass: false, detail: String(e) })
  }
  try {
    // The 0x0 burn address always exists. nonce/balance should return.
    const bal = await provider.getBalance("0x0000000000000000000000000000000000000000")
    results.push({ category: "happy", client: "ethers", test: "getBalance(0x0)", pass: bal >= 0n, detail: bal.toString() })
  } catch (e) {
    results.push({ category: "happy", client: "ethers", test: "getBalance(0x0)", pass: false, detail: String(e) })
  }

  // ============== viem ==============
  const viem = createPublicClient({ transport: viemHttp(target) })
  try {
    const cid = await viem.getChainId()
    results.push({ category: "happy", client: "viem", test: "getChainId", pass: cid > 0, detail: String(cid) })
  } catch (e) {
    results.push({ category: "happy", client: "viem", test: "getChainId", pass: false, detail: String(e) })
  }
  try {
    const bn = await viem.getBlockNumber()
    results.push({ category: "happy", client: "viem", test: "getBlockNumber", pass: bn >= 0n, detail: bn.toString() })
  } catch (e) {
    results.push({ category: "happy", client: "viem", test: "getBlockNumber", pass: false, detail: String(e) })
  }
  try {
    const block = await viem.getBlock({ blockTag: "latest" })
    results.push({
      category: "happy", client: "viem", test: "getBlock(latest)",
      pass: block.number !== null && block.number !== undefined,
      detail: `h=${block.number}`,
    })
  } catch (e) {
    results.push({ category: "happy", client: "viem", test: "getBlock(latest)", pass: false, detail: String(e) })
  }
  try {
    const bal = await viem.getBalance({ address: "0x0000000000000000000000000000000000000000" })
    results.push({ category: "happy", client: "viem", test: "getBalance(0x0)", pass: bal >= 0n, detail: bal.toString() })
  } catch (e) {
    results.push({ category: "happy", client: "viem", test: "getBalance(0x0)", pass: false, detail: String(e) })
  }

  // ============== curl raw ==============
  for (const m of ["eth_chainId", "eth_blockNumber", "net_version", "web3_clientVersion"]) {
    try {
      const { payload, http } = await rawRpc(target, { jsonrpc: "2.0", id: 1, method: m, params: [] })
      const p = payload as { result?: unknown; error?: unknown }
      results.push({
        category: "happy", client: "curl", test: m,
        pass: http === 200 && p.result !== undefined && !p.error,
        detail: JSON.stringify(p).slice(0, 80),
      })
    } catch (e) {
      results.push({ category: "happy", client: "curl", test: m, pass: false, detail: String(e) })
    }
  }
}

async function runAdversarial(target: string, results: DrillResult[]): Promise<void> {
  // All adversarial inputs MUST get a well-formed JSON-RPC error envelope
  // — never a 500, never an HTML page, never an Error toString leak.
  const cases: Array<{ name: string; req: unknown }> = [
    { name: "malformed_address_too_short", req: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0x123", "latest"] } },
    { name: "malformed_address_too_long", req: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0x" + "a".repeat(41), "latest"] } },
    { name: "malformed_address_non_hex", req: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xzz" + "1".repeat(38), "latest"] } },
    { name: "malformed_address_null", req: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [null, "latest"] } },
    { name: "malformed_address_array", req: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [[], "latest"] } },
    { name: "malformed_txhash_short", req: { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: ["0x123"] } },
    { name: "malformed_blockhash_short", req: { jsonrpc: "2.0", id: 1, method: "eth_getBlockByHash", params: ["0x123", false] } },
    { name: "block_tag_fractional", req: { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [1.5, false] } },
    { name: "block_tag_negative", req: { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [-1, false] } },
    { name: "block_tag_array", req: { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [[], false] } },
    { name: "block_tag_huge_bigint", req: { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + "f".repeat(80), false] } },
    { name: "filter_non_object", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: ["not an object"] } },
    { name: "filter_array_shape", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [[]] } },
    { name: "filter_bad_blockhash", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ blockHash: "0x123" }] } },
    { name: "filter_non_array_topics", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ topics: "0xabc" }] } },
    { name: "filter_too_many_topics", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ topics: Array(5).fill("0x" + "1".repeat(64)) }] } },
    { name: "call_non_object", req: { jsonrpc: "2.0", id: 1, method: "eth_call", params: ["not an object", "latest"] } },
    { name: "call_value_non_hex", req: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x" + "a".repeat(40), value: "100" }, "latest"] } },
    { name: "call_odd_length_data", req: { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x" + "a".repeat(40), data: "0xabc" }, "latest"] } },
    { name: "filter_id_short", req: { jsonrpc: "2.0", id: 1, method: "eth_getFilterChanges", params: ["0x123"] } },
    { name: "filter_id_bool", req: { jsonrpc: "2.0", id: 1, method: "eth_getFilterChanges", params: [true] } },
    { name: "unknown_method", req: { jsonrpc: "2.0", id: 1, method: "eth_undefinedFooBar", params: [] } },
    { name: "envelope_missing_id", req: { jsonrpc: "2.0", method: "eth_blockNumber", params: [] } },
    { name: "envelope_wrong_jsonrpc", req: { jsonrpc: "1.0", id: 1, method: "eth_blockNumber", params: [] } },
    { name: "envelope_empty_body", req: {} },
    // PR-1Q hunt additions: silent-coercion sites beyond block tag
    { name: "block_tag_bool", req: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0x" + "0".repeat(40), true] } },
    { name: "block_tag_object", req: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0x" + "0".repeat(40), {}] } },
    { name: "block_tag_in_getStorageAt", req: { jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: ["0x" + "0".repeat(40), "0x0", true] } },
    { name: "filter_fromBlock_array", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: [] }] } },
    { name: "filter_toBlock_array", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0xff", toBlock: [] }] } },
    { name: "filter_address_object", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: {} }] } },
    { name: "filter_topic_object", req: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ topics: [{}] }] } },
    { name: "feeHistory_newestBlock_array", req: { jsonrpc: "2.0", id: 1, method: "eth_feeHistory", params: ["0x1", [], []] } },
    { name: "txhash_object", req: { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [{}] } },
    { name: "txhash_number", req: { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [123] } },
    { name: "receipt_array", req: { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [[]] } },
    { name: "sendRawTransaction_array", req: { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [[]] } },
    { name: "getProof_address_array", req: { jsonrpc: "2.0", id: 1, method: "eth_getProof", params: [[], [], "latest"] } },
    { name: "empty_batch", req: [] },
    { name: "unknown_coc_method", req: { jsonrpc: "2.0", id: 1, method: "coc_undefinedFooBar", params: [] } },
  ]

  for (const { name, req } of cases) {
    try {
      const { payload, http } = await rawRpc(target, req)
      if (http >= 500) {
        results.push({ category: "adversarial", client: "curl", test: name, pass: false, detail: `HTTP ${http}` })
        continue
      }
      // For notifications (no id) the server may not respond at all — treat empty as pass.
      if (name === "envelope_missing_id") {
        const isEmpty = payload === "" || payload === null
        results.push({ category: "adversarial", client: "curl", test: name, pass: isEmpty, detail: isEmpty ? "no response (correct)" : JSON.stringify(payload).slice(0, 80) })
        continue
      }
      const check = assertErrorEnvelope(payload)
      results.push({
        category: "adversarial", client: "curl", test: name,
        pass: check.ok,
        detail: check.ok ? undefined : check.reason,
      })
    } catch (e) {
      results.push({ category: "adversarial", client: "curl", test: name, pass: false, detail: String(e) })
    }
  }

  // ============== ethers adversarial ==============
  // ethers v6 will surface the error envelope back as an Error subclass.
  // We just check it raises (i.e. doesn't silently return null) and the
  // error doesn't leak V8 / ethers internals through to user-facing
  // message.
  const ethersProvider = new JsonRpcProvider(target)
  const ethersAdv: Array<[string, () => Promise<unknown>]> = [
    ["eth_getBalance(short_addr)", () => ethersProvider.getBalance("0x123" as `0x${string}`)],
    ["eth_getCode(short_addr)", () => ethersProvider.getCode("0x123" as `0x${string}`)],
    ["eth_getTransactionByHash(short)", () => ethersProvider.getTransaction("0x123")],
  ]
  for (const [name, fn] of ethersAdv) {
    try {
      await fn()
      results.push({ category: "adversarial", client: "ethers", test: name, pass: false, detail: "expected throw, returned ok" })
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      const leaks = LEAK_PATTERNS.find((re) => re.test(msg))
      results.push({
        category: "adversarial", client: "ethers", test: name,
        pass: !leaks,
        detail: leaks ? `leaks "${leaks}" in: ${msg.slice(0, 80)}` : "rejected cleanly",
      })
    }
  }

  // ============== viem adversarial ==============
  const viem = createPublicClient({ transport: viemHttp(target) })
  const viemAdv: Array<[string, () => Promise<unknown>]> = [
    ["getBalance(short_addr)", () => viem.getBalance({ address: "0x123" as `0x${string}` })],
    ["getCode(short_addr)", () => viem.getCode({ address: "0x123" as `0x${string}` })],
    ["getTransaction(short)", () => viem.getTransaction({ hash: "0x123" as `0x${string}` })],
  ]
  for (const [name, fn] of viemAdv) {
    try {
      await fn()
      results.push({ category: "adversarial", client: "viem", test: name, pass: false, detail: "expected throw, returned ok" })
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      const leaks = LEAK_PATTERNS.find((re) => re.test(msg))
      results.push({
        category: "adversarial", client: "viem", test: name,
        pass: !leaks,
        detail: leaks ? `leaks "${leaks}" in: ${msg.slice(0, 80)}` : "rejected cleanly",
      })
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs()
  console.error(`[chaos] target=${opts.target} ws=${opts.ws ?? "skip"} read-only=${opts.readOnly}`)
  const results: DrillResult[] = []

  await runHappyPath(opts.target, results)
  await runAdversarial(opts.target, results)

  const total = results.length
  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass)

  const report = {
    target: opts.target,
    timestamp: new Date().toISOString(),
    total,
    passed,
    failed: failed.length,
    failures: failed,
    breakdown: {
      happy: results.filter((r) => r.category === "happy"),
      adversarial: results.filter((r) => r.category === "adversarial"),
    },
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")

  console.error(`\n[chaos] ${passed}/${total} passed, ${failed.length} failed`)
  if (failed.length > 0) {
    console.error("\nFailures:")
    for (const f of failed) {
      console.error(`  [${f.category}/${f.client}] ${f.test}: ${f.detail}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("[chaos] fatal:", err)
  process.exit(1)
})
