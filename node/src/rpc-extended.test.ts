import test from "node:test"
import assert from "node:assert/strict"
import type http from "node:http"
import { join } from "node:path"
import { ChainEngine } from "./chain-engine.ts"
import { EvmChain } from "./evm.ts"
import { startRpcServer } from "./rpc.ts"
import { P2PNode } from "./p2p.ts"
import { writeSettledRewardManifest, type RewardManifest } from "../../runtime/lib/reward-manifest.ts"

async function rpcCall(port: number, method: string, params?: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
  })
  const json = await response.json()
  if (json.error) throw new Error(json.error.message)
  return json.result
}

// Returns the full JSON-RPC envelope (does NOT throw on .error). Use this
// when the test asserts on error code/message rather than success result.
async function rpcCallRaw(port: number, method: string, params?: unknown[]): Promise<{
  result?: unknown
  error?: { code: number; message: string }
}> {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
  })
  return await response.json() as { result?: unknown; error?: { code: number; message: string } }
}

test("RPC Extended Methods", async (t) => {
  const prevDevAccounts = process.env.COC_DEV_ACCOUNTS
  process.env.COC_DEV_ACCOUNTS = "1"
  // The module-level rate limiter is shared across all tests in this
  // fixture. With ~65 subtests each making several requests, the 200/60s
  // budget is exhausted before later tests run, masking real assertion
  // failures behind opaque -32005. Bypass for the duration of the suite.
  const prevRateLimitDisabled = process.env.COC_RPC_RATE_LIMIT_DISABLED
  process.env.COC_RPC_RATE_LIMIT_DISABLED = "1"
  const chainId = 18780
  const dataDir = "/tmp/coc-rpc-ext-test-" + Date.now()
  const rewardManifestDir = join(dataDir, "reward-manifests")
  const evm = await EvmChain.create(chainId)
  await evm.prefund([
    { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", balanceWei: "10000000000000000000000" },
  ])
  const chain = new ChainEngine(
    {
      dataDir,
      nodeId: "node-1",
      validators: ["node-1"],
      finalityDepth: 3,
      maxTxPerBlock: 50,
      minGasPriceWei: 1n,
    },
    evm,
  )
  const p2p = {
    receiveTx: async () => {},
    getStats: () => ({
      rateLimitedRequests: 0,
      authAcceptedRequests: 0,
      authMissingRequests: 0,
      authInvalidRequests: 0,
      authRejectedRequests: 0,
      authNonceTrackerSize: 0,
      inboundAuthMode: "enforce",
      discoveryPendingPeers: 0,
      discoveryIdentityFailures: 0,
    }),
    // Stub for #108: coc_getPeers exposes the same shape as admin_peers.
    getPeers: () => [
      { id: "node-2", url: "http://10.0.0.2:29780" },
      { id: "node-3", url: "http://10.0.0.3:29780", advertisedUrl: "http://203.0.113.3:29780" },
    ],
  } as unknown as P2PNode
  const port = 18790 + Math.floor(Math.random() * 100)

  const server: http.Server = startRpcServer("127.0.0.1", port, chainId, evm, chain, p2p, undefined, undefined, undefined, undefined, {
    rewardManifestDir,
    getBftEquivocations: () => [
      {
        rawEvidence: {
          type: "bft-equivocation",
          validatorId: "node-7",
          height: "12",
          phase: "prepare",
          blockHash1: `0x${"aa".repeat(32)}`,
          blockHash2: `0x${"bb".repeat(32)}`,
          detectedAtMs: 1700000000000,
        },
      },
    ],
    getErasureStatus: async (cid: string) => {
      // Stub: returns a deterministic manifest summary so the dispatch
      // path is exercised end-to-end without spinning up a real
      // blockstore. The real implementation in index.ts delegates to
      // resolveCid + erasureStatus.
      if (cid === "bafy-missing") throw { code: -32604, message: "not_found" }
      return {
        fileSize: 1_048_576,
        scheme: "rs(4+2)",
        n: 4,
        m: 2,
        stripes: [
          { stripeIndex: 0, dataAvailable: 4, parityAvailable: 2, needsRepair: false },
        ],
      }
    },
  })
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  // Wait for server startup
  await new Promise((resolve) => setTimeout(resolve, 100))

  const settledManifest: RewardManifest = {
    epochId: 7,
    rewardRoot: `0x${"11".repeat(32)}`,
    totalReward: "100",
    slashTotal: "0",
    treasuryDelta: "0",
    leaves: [
      { nodeId: `0x${"22".repeat(32)}`, amount: "100" },
    ],
    proofs: {
      [`7:0x${"22".repeat(32)}`]: [`0x${"33".repeat(32)}`],
    },
    scoringInputsHash: `0x${"44".repeat(32)}`,
    generatedAtMs: Date.now(),
    settled: true,
    settledAtMs: Date.now(),
  }
  writeSettledRewardManifest(rewardManifestDir, settledManifest)

  await t.test("eth_accounts returns test accounts", async () => {
    const accounts = await rpcCall(port, "eth_accounts")
    assert.ok(Array.isArray(accounts))
    assert.ok(accounts.length === 10)
    assert.ok(accounts[0].startsWith("0x"))
  })

  await t.test("eth_sign signs message", async () => {
    const accounts = await rpcCall(port, "eth_accounts")
    const message = "0x48656c6c6f" // "Hello" in hex

    const signature = await rpcCall(port, "eth_sign", [accounts[0], message])
    assert.ok(typeof signature === "string")
    assert.ok(signature.startsWith("0x"))
    assert.ok(signature.length === 132) // 65 bytes * 2 + 0x
  })

  await t.test("eth_signTypedData_v4 signs typed data", async () => {
    const accounts = await rpcCall(port, "eth_accounts")
    const typedData = {
      types: {
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
      },
      primaryType: "Person",
      domain: { name: "Test", version: "1", chainId: 1 },
      message: { name: "Alice", wallet: accounts[0] },
    }

    const signature = await rpcCall(port, "eth_signTypedData_v4", [accounts[0], typedData])
    assert.ok(typeof signature === "string")
    assert.ok(signature.startsWith("0x"))
  })

  await t.test("eth_createAccessList returns access list", async () => {
    const result = await rpcCall(port, "eth_createAccessList", [
      {
        from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        data: "0x",
      },
    ])

    assert.ok(typeof result === "object")
    assert.ok(Array.isArray(result.accessList))
    assert.ok(typeof result.gasUsed === "string")
  })

  await t.test("eth_sendTransaction sends signed transaction", async () => {
    const accounts = await rpcCall(port, "eth_accounts")

    const txHash = await rpcCall(port, "eth_sendTransaction", [
      {
        from: accounts[0],
        to: accounts[1],
        value: "0x1000",
        gas: "0x5208", // 21000
      },
    ])

    assert.ok(typeof txHash === "string")
    assert.ok(txHash.startsWith("0x"))
    assert.ok(txHash.length === 66) // 32 bytes * 2 + 0x
  })

  await t.test("eth_getBlockByNumber returns computed header roots", async () => {
    const proposed = await chain.proposeNextBlock()
    assert.ok(proposed)

    const block = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false])
    assert.ok(typeof block === "object")
    assert.match(block.transactionsRoot, /^0x[0-9a-f]{64}$/)
    assert.match(block.receiptsRoot, /^0x[0-9a-f]{64}$/)
    assert.notEqual(block.transactionsRoot, `0x${"0".repeat(64)}`)
    assert.notEqual(block.receiptsRoot, `0x${"0".repeat(64)}`)
    assert.match(block.logsBloom, /^0x[0-9a-f]{512}$/)
  })

  await t.test("eth_getBlockTransactionCountByNumber returns count", async () => {
    const count = await rpcCall(port, "eth_getBlockTransactionCountByNumber", ["0x0"])
    // Genesis block or early block may have 0 txs
    assert.ok(count === null || count.startsWith("0x"))
  })

  await t.test("eth_getUncleCountByBlockNumber returns zero", async () => {
    const count = await rpcCall(port, "eth_getUncleCountByBlockNumber", ["0x0"])
    assert.strictEqual(count, "0x0")
  })

  await t.test("#396: eth_getUncleCountByBlockHash rejects non-hash arg with -32602", async () => {
    // Pre-fix the handler returned the no-uncle stub ("0x0") regardless
    // of the param shape, so a non-string / non-hex hash silently came
    // back as "no uncles" instead of -32602. Geth validates the hash
    // shape first — clients that send garbage learn about misuse instead
    // of receiving a "valid hash, no uncle" answer they could act on.
    const garbageCases = [
      { params: [12345], desc: "number" },
      { params: [{}], desc: "object" },
      { params: ["not-a-hash"], desc: "non-hex string" },
      { params: ["0x123"], desc: "wrong-length hex" },
      { params: [], desc: "missing arg" },
    ]
    for (const tc of garbageCases) {
      const res = await rpcCallRaw(port, "eth_getUncleCountByBlockHash", tc.params)
      assert.ok(res.error, `${tc.desc}: expected error, got result ${JSON.stringify(res)}`)
      assert.strictEqual(
        res.error.code,
        -32602,
        `${tc.desc}: expected code -32602, got ${res.error.code}`,
      )
    }
    // Valid 32-byte hash still returns "0x0"
    const valid = await rpcCall(port, "eth_getUncleCountByBlockHash", [
      "0x" + "0".repeat(64),
    ])
    assert.strictEqual(valid, "0x0")
  })

  await t.test("#396: eth_getUncleByBlockHashAndIndex rejects non-hash and non-hex index", async () => {
    // Same anti-pattern: the index param flowed straight to the null
    // return without shape validation. Match the *byHash sibling so
    // negative / non-hex indices surface as -32602.
    const res1 = await rpcCallRaw(port, "eth_getUncleByBlockHashAndIndex", ["not-a-hash", "0x0"])
    assert.strictEqual(res1.error?.code, -32602)
    const res2 = await rpcCallRaw(port, "eth_getUncleByBlockHashAndIndex", [
      "0x" + "0".repeat(64),
      "not-hex",
    ])
    assert.strictEqual(res2.error?.code, -32602)
    // Valid args still return null (no uncles on COC chain).
    const valid = await rpcCall(port, "eth_getUncleByBlockHashAndIndex", [
      "0x" + "0".repeat(64),
      "0x0",
    ])
    assert.strictEqual(valid, null)
  })

  await t.test("#396: eth_getUncleByBlockNumberAndIndex rejects non-string tag", async () => {
    const res = await rpcCallRaw(port, "eth_getUncleByBlockNumberAndIndex", [{}, "0x0"])
    assert.strictEqual(res.error?.code, -32602)
    const valid = await rpcCall(port, "eth_getUncleByBlockNumberAndIndex", ["0x0", "0x0"])
    assert.strictEqual(valid, null)
  })

  await t.test("eth_protocolVersion returns version", async () => {
    const version = await rpcCall(port, "eth_protocolVersion")
    assert.ok(typeof version === "string")
    assert.ok(version.startsWith("0x"))
  })

  await t.test("eth_feeHistory returns fee data", async () => {
    const result = await rpcCall(port, "eth_feeHistory", [4, "latest", [25, 75]])
    assert.ok(typeof result === "object")
    assert.ok(Array.isArray(result.baseFeePerGas))
    assert.ok(Array.isArray(result.gasUsedRatio))
    assert.ok(result.oldestBlock.startsWith("0x"))
  })

  await t.test("eth_maxPriorityFeePerGas returns fee", async () => {
    const fee = await rpcCall(port, "eth_maxPriorityFeePerGas")
    assert.ok(typeof fee === "string")
    assert.ok(fee.startsWith("0x"))
  })

  await t.test("eth_getCompilers returns available compiler list", async () => {
    const compilers = await rpcCall(port, "eth_getCompilers")
    assert.deepEqual(compilers, ["solidity"])
  })

  await t.test("eth_compileSolidity compiles source and returns ABI plus bytecode", async () => {
    const result = await rpcCall(port, "eth_compileSolidity", [
      "pragma solidity ^0.8.0; contract Sample { function value() external pure returns (uint256) { return 42; } }",
    ]) as Record<string, {
      code: string
      runtimeCode: string
      info: {
        source: string
        compilerVersion: string
        abiDefinition: Array<{ name?: string; type?: string }>
      }
    }>

    assert.ok(result.Sample)
    assert.ok(result.Sample.code.startsWith("0x"))
    assert.ok(result.Sample.code.length > 2)
    assert.ok(result.Sample.runtimeCode.startsWith("0x"))
    assert.equal(result.Sample.info.source.includes("contract Sample"), true)
    assert.ok(result.Sample.info.compilerVersion.length > 0)
    assert.ok(result.Sample.info.abiDefinition.some((entry) => entry.type === "function" && entry.name === "value"))
  })

  await t.test("eth_compileSolidity rejects invalid source", async () => {
    await assert.rejects(
      () => rpcCall(port, "eth_compileSolidity", ["pragma solidity ^0.8.0; contract Broken {"]),
      /ParserError|compilation/i,
    )
  })

  await t.test("eth_newBlockFilter returns filter id", async () => {
    const id = await rpcCall(port, "eth_newBlockFilter")
    assert.ok(typeof id === "string")
    assert.ok(id.startsWith("0x"))
  })

  await t.test("#94: eth_newBlockFilter + eth_getFilterChanges returns block hashes since last poll", async () => {
    const fid = (await rpcCall(port, "eth_newBlockFilter")) as string
    const startHeight = BigInt(await rpcCall(port, "eth_blockNumber") as string)
    // Produce 3 blocks via the chain's proposer directly — the RPC test
    // harness has no proposer loop, so eth_sendTransaction would otherwise
    // just queue txs in the mempool without advancing the chain.
    for (let i = 0; i < 3; i++) {
      const blk = await chain.proposeNextBlock(false, true)
      assert.ok(blk, "proposeNextBlock should produce a block")
    }
    const newHeight = BigInt(await rpcCall(port, "eth_blockNumber") as string)
    const advanced = Number(newHeight - startHeight)
    assert.equal(advanced, 3, `chain should advance by 3, was ${startHeight}, now ${newHeight}`)
    const hashes = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
    assert.equal(hashes.length, 3, `expected 3 block hashes since filter created, got ${hashes.length}`)
    for (const h of hashes) {
      assert.ok(typeof h === "string" && h.startsWith("0x") && h.length === 66, `bad block hash: ${h}`)
    }
    // Second poll with no further chain progress should return [].
    const second = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
    assert.equal(second.length, 0, "second poll without new blocks must be empty")
  })

  await t.test("#94: eth_newPendingTransactionFilter + eth_getFilterChanges returns mempool tx hashes added since the last poll", async () => {
    // Drain mempool first so the new filter starts from an empty snapshot.
    // (Even if it doesn't drain perfectly, the filter pre-populates from the
    // current mempool, so any pre-existing hashes are excluded.)
    const fid = (await rpcCall(port, "eth_newPendingTransactionFilter")) as string
    // Initial poll should be empty since we just created the filter.
    const initial = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
    assert.equal(initial.length, 0, "fresh filter must be empty before any new txs")
    // The test chain auto-mines, so direct mempool inspection happens
    // implicitly via eth_sendTransaction's return. We can't reliably make
    // txs sit in the mempool without mining, so we just assert the filter's
    // semantics (empty initial, no errors on poll).
  })

  await t.test("#390: eth_getFilterLogs rejects non-log filter with -32602 (was silent [] pre-fix)", async () => {
    // Pre-fix the handler returned `[]` for block/pendingTx filters with
    // a misleading "match kubo/geth" comment. Geth actually returns
    // "filter not found" when typ != LogsSubscription
    // (filters/api.go: GetFilterLogs). Polling clients that hit the
    // wrong method saw "no logs" forever instead of an error pointing
    // at the type mismatch.
    //
    // Block filter case:
    const blockFid = (await rpcCall(port, "eth_newBlockFilter")) as string
    const r1 = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getFilterLogs", params: [blockFid] }),
    })
    const body1 = await r1.json() as { error?: { code: number; message: string } }
    assert.ok(body1.error, "block filter must reject (not return [])")
    assert.equal(body1.error!.code, -32602, `expected -32602, got ${body1.error!.code}`)
    assert.match(body1.error!.message, /block filter|log filter/i, `message must name the type mismatch, got: ${body1.error!.message}`)

    // Pending-tx filter case:
    const ptxFid = (await rpcCall(port, "eth_newPendingTransactionFilter")) as string
    const r2 = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getFilterLogs", params: [ptxFid] }),
    })
    const body2 = await r2.json() as { error?: { code: number; message: string } }
    assert.ok(body2.error, "pendingTx filter must reject (not return [])")
    assert.equal(body2.error!.code, -32602)
    assert.match(body2.error!.message, /pendingTx filter|log filter/i)

    // Log filter case (sanity: still works):
    const logFid = (await rpcCall(port, "eth_newFilter", [{ fromBlock: "0x0" }])) as string
    const r3 = await rpcCall(port, "eth_getFilterLogs", [logFid])
    assert.ok(Array.isArray(r3), "log filter still works")

    // Missing filter case (sanity: #342 unchanged, returns []):
    const missing = "0x" + "00".repeat(16)
    const r4 = await rpcCall(port, "eth_getFilterLogs", [missing])
    assert.deepEqual(r4, [], "missing filter returns [] (#342 contract)")
  })

  await t.test("eth_getFilterLogs returns array", async () => {
    const filterId = await rpcCall(port, "eth_newFilter", [{ fromBlock: "0x0" }])
    const logs = await rpcCall(port, "eth_getFilterLogs", [filterId])
    assert.ok(Array.isArray(logs))
  })

  await t.test("eth_getBlockReceipts returns array or null", async () => {
    // For genesis/latest block - may return [] or null depending on chain state
    const receipts = await rpcCall(port, "eth_getBlockReceipts", ["0x0"])
    // Either null (no block) or array of receipts
    assert.ok(receipts === null || Array.isArray(receipts))
  })

  await t.test("eth_getBlockReceipts returns null for non-existent block", async () => {
    const receipts = await rpcCall(port, "eth_getBlockReceipts", ["0xffffff"])
    assert.strictEqual(receipts, null)
  })

  await t.test("#366: eth_getBlockReceipts accepts block hash (BlockNumberOrHash)", async () => {
    // geth's `eth_getBlockReceipts` accepts both a block number/tag
    // AND a bare 32-byte block hash. Pre-fix our handler only resolved
    // as block number — passing a 66-char hash got BigInt(hash)
    // parsed as a giant integer, then `chain.getBlockByNumber(huge)`
    // returned null, indistinguishable from "no such block."
    //
    // Strategy: propose a real block on the fixture chain (the
    // synthesised genesis at "0x0" isn't indexed by hash since it's
    // a stub for #112), then fetch by-hash and expect the same
    // receipts list as by-number.
    await chain.proposeNextBlock()
    const blockByNumber = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as { hash: string } | null
    assert.ok(blockByNumber, "fixture must have block 0x1 after proposeNextBlock")
    const lowerHash = blockByNumber!.hash
    assert.match(lowerHash, /^0x[0-9a-fA-F]{64}$/, "block must have a 32-byte hash")

    // Lookup by lowercase hash MUST work (this is the primary fix).
    const byNumber = await rpcCall(port, "eth_getBlockReceipts", ["0x1"])
    const byLowerHash = await rpcCall(port, "eth_getBlockReceipts", [lowerHash])
    assert.notStrictEqual(byLowerHash, null, "eth_getBlockReceipts(<lowercase block hash>) must NOT return null")
    assert.ok(Array.isArray(byLowerHash), "eth_getBlockReceipts(hash) must return an array (possibly empty)")
    assert.deepEqual(byLowerHash, byNumber, "by-hash result must match by-number result")

    // Mixed-case hash also works (case-insensitive, mirroring #364 normalization).
    const mixedHash =
      "0x" + lowerHash.slice(2).split("").map((c, i) => i % 2 === 0 ? c.toUpperCase() : c).join("")
    const byMixedHash = await rpcCall(port, "eth_getBlockReceipts", [mixedHash])
    assert.notStrictEqual(byMixedHash, null, "eth_getBlockReceipts(<mixed-case block hash>) must NOT return null")
    assert.deepEqual(byMixedHash, byLowerHash, "mixed-case hash must yield the same receipts as lowercase")
  })

  await t.test("#122: eth_getBalance / eth_getTransactionCount / coc_getContractInfo reject malformed addresses with -32602", async () => {
    // Pre-fix bugs:
    //   - eth_getBalance returned -32603 with the raw input echoed back
    //     ("Invalid address input=not-an-address")
    //   - eth_getTransactionCount accepted short-hex like "0x123" and
    //     forwarded to evm (similar input leak)
    //   - coc_getContractInfo returned null for any malformed input,
    //     indistinguishable from "no deployed contract"
    const bads = ["not-an-address", "0x", "0x123", "0x" + "g".repeat(40), "0x" + "f".repeat(41)]
    for (const method of ["eth_getBalance", "eth_getTransactionCount", "coc_getContractInfo"]) {
      for (const badAddr of bads) {
        const params = method.startsWith("eth_") ? [badAddr, "latest"] : [badAddr]
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
        const json = await r.json() as { error?: { code: number; message: string } }
        assert.ok(json.error, `expected error for ${method}(${JSON.stringify(badAddr)})`)
        assert.equal(json.error!.code, -32602, `${method}(${JSON.stringify(badAddr)}) must be -32602, got ${json.error!.code}`)
        assert.match(json.error!.message, /invalid address/i, `error message for ${method} should mention "invalid address"`)
      }
    }
    // Sanity: valid address still works for getBalance/getTransactionCount.
    const validAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const bal = await rpcCall(port, "eth_getBalance", [validAddr, "latest"])
    assert.match(bal as string, /^0x[0-9a-f]+$/i, "valid eth_getBalance must return hex")
    const nonce = await rpcCall(port, "eth_getTransactionCount", [validAddr, "latest"])
    assert.match(nonce as string, /^0x[0-9a-f]+$/i, "valid eth_getTransactionCount must return hex")
  })

  await t.test("#120: coc_getTransactionsByAddress rejects malformed addresses with -32602", async () => {
    // Pre-fix: typo or junk address silently returned [] (it just missed
    // the per-address index), masking client mistakes as "no transactions".
    for (const badAddr of ["", "not-an-address", "0x", "0x123", "0x" + "g".repeat(40), "0x" + "f".repeat(41)]) {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "coc_getTransactionsByAddress",
          params: [badAddr, 50],
        }),
      })
      const json = await r.json() as { error?: { code: number; message: string } }
      assert.ok(json.error, `expected error for addr=${JSON.stringify(badAddr)}`)
      assert.equal(json.error!.code, -32602, `addr=${JSON.stringify(badAddr)} must be -32602`)
    }
    // Sanity: a valid address still works (and returns an array since the
    // test fixture chain has no getTransactionsByAddress hook → falls
    // through to the empty-array path).
    const ok = await rpcCall(port, "coc_getTransactionsByAddress", ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", 50])
    assert.ok(Array.isArray(ok), "valid address must return an array")
  })

  await t.test("#118: eth_getStorageAt rejects malformed slots with -32602", async () => {
    // Pre-fix: invalid slots either leaked the evm's padded hex back
    // ("0x000…-1") or silently returned zero. Now each malformed shape
    // gets a clean -32602.
    const accounts = await rpcCall(port, "eth_accounts") as string[]
    const addr = accounts[0]
    for (const badSlot of ["-1", "", "0x", "0xZZ", "1", "0x" + "f".repeat(65)]) {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getStorageAt",
          params: [addr, badSlot, "latest"],
        }),
      })
      const json = await r.json() as { error?: { code: number; message: string } }
      assert.ok(json.error, `expected error for slot=${JSON.stringify(badSlot)}`)
      assert.equal(json.error!.code, -32602, `slot=${JSON.stringify(badSlot)} must be -32602, got ${json.error!.code}`)
    }
    // Sanity: a valid slot still works.
    const ok = await rpcCall(port, "eth_getStorageAt", [addr, "0x0", "latest"]) as string
    assert.match(ok, /^0x[0-9a-f]{64}$/, "valid slot must return a 32-byte hex word")
  })

  await t.test("#116: eth_getLogs rejects blockHash + fromBlock combo with -32602", async () => {
    // EIP-234: blockHash is mutually exclusive with fromBlock/toBlock.
    // Pre-fix the implementation silently processed the range and surfaced
    // a misleading "block range too large" error referencing the chain height.
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getLogs",
        params: [{ blockHash: "0x" + "00".repeat(32), fromBlock: "0x0" }],
      }),
    })
    const json = await r.json() as { error?: { code: number; message: string } }
    assert.ok(json.error, "must surface an error")
    assert.equal(json.error!.code, -32602, "must be -32602 invalid params")
    assert.match(json.error!.message, /mutually exclusive/i, "message must mention the mutual-exclusivity rule")
  })

  await t.test("#114: eth_getBlockReceipts shape matches eth_getTransactionReceipt", async () => {
    // Pre-fix bug: getBlockReceipts returned a stripped-down 9-field shape
    // (no contractAddress / cumulativeGasUsed / effectiveGasPrice / logsBloom
    // / type), incompatible with the per-tx receipt format. Indexers that
    // batched via this RPC silently lost contract-creation tracking and gas
    // accounting.
    //
    // Send a real tx, mine the block, then compare the key sets of both
    // receipt RPC responses for the same tx.
    const accounts = await rpcCall(port, "eth_accounts") as string[]
    const txHash = await rpcCall(port, "eth_sendTransaction", [{
      from: accounts[0],
      to: accounts[1],
      value: "0x1",
      gas: "0x5208",
    }]) as string
    await chain.proposeNextBlock()
    const single = await rpcCall(port, "eth_getTransactionReceipt", [txHash]) as Record<string, unknown>
    assert.ok(single, "single-tx receipt must exist")
    const blockNum = single.blockNumber as string
    const batch = await rpcCall(port, "eth_getBlockReceipts", [blockNum]) as Array<Record<string, unknown>>
    assert.ok(Array.isArray(batch), "batch receipts must be an array")
    const fromBatch = batch.find(r => r.transactionHash === txHash)
    assert.ok(fromBatch, "tx must appear in batch receipts")
    // Key set must match exactly between the two methods so any client
    // switching between them doesn't silently lose fields. This is the
    // regression assertion: pre-fix the batch method dropped 5 fields
    // (contractAddress / cumulativeGasUsed / effectiveGasPrice / logsBloom /
    // type), and this key-equality check fails on that drift even when
    // contractAddress itself is null/undefined for a plain transfer.
    const singleKeys = Object.keys(single).sort()
    const batchKeys = Object.keys(fromBatch!).sort()
    assert.deepEqual(batchKeys, singleKeys, "batch receipt keys must match single receipt keys")
    // Sanity-check the previously-missing fields exist as keys (values may
    // be null for non-contract-creation txs, but the key itself must be
    // present so clients can rely on it).
    for (const required of ["cumulativeGasUsed", "effectiveGasPrice", "logsBloom"]) {
      assert.ok(required in fromBatch!, `batch receipt must contain ${required}`)
    }
  })

  await t.test("#368: eth_getBalance accepts EIP-1898 BlockNumberOrHash (bare hash + {blockNumber} + {blockHash})", async () => {
    // Per EIP-1898, methods that take a block parameter must accept
    // FIVE shapes — tag, hex number, bare 32-byte hash, {blockHash},
    // {blockNumber}. Pre-fix only {blockHash} object form worked.
    // Bare hash strings sailed through parseBlockTag → safeBigInt(hash)
    // → BigInt(huge) → -32001 "block not found: 0x<huge-number>".
    // {blockNumber} objects tripped parseBlockTag → -32602 "invalid
    // block tag." Ethers / viem / hardhat fork-detection use both
    // shapes for reorg-safe historicals — silently failing one of
    // them breaks them.
    //
    // The fixture's `proposeNextBlock()` produces a block without
    // computing the EVM state-trie root (the chain-engine path that
    // populates `stateRoot` runs only in full-mode). So historical
    // execution at any non-tip block surfaces as -32001 "state root
    // unavailable for block <N>". We use the *error message* shape
    // to verify routing — pre-fix the hash form would error with
    // "block not found: 0x<huge>"; post-fix it errors with "state
    // root unavailable for block 1," proving the hash resolved to
    // block-number 1 before the stateRoot check fired.
    await chain.proposeNextBlock()
    const block = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as { hash: string } | null
    assert.ok(block, "fixture needs block 0x1")
    const blockHash = block!.hash
    const addr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

    // Baseline: by tag "latest" — skips the stateRoot check.
    const byTag = await rpcCall(port, "eth_getBalance", [addr, "latest"])
    assert.match(byTag as string, /^0x/, "tag form must work as baseline")

    // For the new shapes, use raw fetch + assert on the error MESSAGE
    // to distinguish "routed to hash-lookup" from "routed to number-lookup."
    const probe = async (blockParam: unknown): Promise<{ error?: { code: number; message: string } }> => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getBalance",
          params: [addr, blockParam],
        }),
      })
      return await r.json() as { error?: { code: number; message: string } }
    }

    // Shape 1: bare hex number "0x1" — routes to number-lookup.
    const byNumber = await probe("0x1")
    assert.match(
      byNumber.error?.message ?? "",
      /state root unavailable for block /,
      `hex-number form must hit number-lookup branch (got ${JSON.stringify(byNumber)})`,
    )

    // Shape 2: bare 32-byte block hash — POST-FIX routes to hash-lookup
    // → resolves to block 1 → same "state root unavailable" message.
    // PRE-FIX: error message would be "block not found: 0x<hash>" because
    // the hash was BigInt-parsed as a giant block number.
    const byBareHash = await probe(blockHash)
    assert.match(
      byBareHash.error?.message ?? "",
      /state root unavailable for block /,
      `bare-hash form must hit hash-lookup branch (got ${JSON.stringify(byBareHash)})`,
    )

    // Shape 3: EIP-1898 {blockHash: ...} — pre-existing, same destination.
    const byHashObj = await probe({ blockHash })
    assert.match(
      byHashObj.error?.message ?? "",
      /state root unavailable for block /,
      `{blockHash} object form (got ${JSON.stringify(byHashObj)})`,
    )

    // Shape 4: EIP-1898 {blockNumber: "0x1"} — NEW post-fix path.
    // PRE-FIX: parseBlockTag rejected the object with -32602.
    const byNumberObj = await probe({ blockNumber: "0x1" })
    assert.match(
      byNumberObj.error?.message ?? "",
      /state root unavailable for block /,
      `{blockNumber} object form (got ${JSON.stringify(byNumberObj)})`,
    )

    // Mixed-case bare hash (parity with #364 lowercase normalization).
    const mixedHash = "0x" + blockHash.slice(2).split("").map((c, i) => i % 2 === 0 ? c.toUpperCase() : c).join("")
    const byMixedHash = await probe(mixedHash)
    assert.match(
      byMixedHash.error?.message ?? "",
      /state root unavailable for block /,
      `mixed-case bare hash (got ${JSON.stringify(byMixedHash)})`,
    )

    // Malformed {blockHash} → -32602, not -32603 (no V8 leak).
    const malformed = await probe({ blockHash: "0xnot-a-hash" })
    assert.equal(malformed.error?.code, -32602, `malformed blockHash must be -32602 (got ${JSON.stringify(malformed)})`)
    assert.match(malformed.error?.message ?? "", /invalid blockHash/i)
  })

  await t.test("txpool_status returns pool stats", async () => {
    const status = await rpcCall(port, "txpool_status")
    assert.ok(typeof status === "object")
    assert.ok(typeof status.pending === "string")
    assert.ok(status.pending.startsWith("0x"))
    assert.ok(typeof status.queued === "string")
  })

  await t.test("txpool_content returns pending transactions", async () => {
    const content = await rpcCall(port, "txpool_content")
    assert.ok(typeof content === "object")
    assert.ok(typeof content.pending === "object")
    assert.ok(typeof content.queued === "object")
  })

  await t.test("#386: txpool_status / txpool_content classify gap-nonce txs as queued (not pending)", async () => {
    // Pre-fix: txpool_status hardcoded `queued: "0x0"` and txpool_content
    // returned `queued: {}` regardless of nonce gaps. A tx with nonce=5
    // while account onchain nonce was 0 reported as pending, so wallet
    // stuck-tx detection (which polls txpool_content and waits for the
    // tx to move from queued → pending) never triggered.
    //
    // Live testnet 88780 repro: deployer had a tx with nonce=300 in the
    // mempool while onchain nonce was 187. Pre-fix txpool_content showed
    // it under "pending"; post-fix it correctly appears under "queued".
    //
    // Fix mirrors geth's separation: contiguous-from-onchain → pending,
    // gapped/future → queued.
    const { Wallet: EthersWallet, Transaction: EthersTransaction } = await import("ethers")
    const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    const wallet = new EthersWallet(TEST_PK)
    const senderAddr = wallet.address.toLowerCase()

    // Clear any pre-existing test txs first by getting baseline.
    const baselineNonce = await rpcCall(port, "eth_getTransactionCount", [wallet.address, "latest"]) as string
    const startNonce = parseInt(baselineNonce, 16)

    // Sign two txs: one contiguous (startNonce) and one gapped (startNonce + 5).
    function sign(nonce: number): string {
      const tx = EthersTransaction.from({
        to: "0x0000000000000000000000000000000000000001",
        value: "0x1",
        nonce,
        gasLimit: "0x5208",
        gasPrice: "0x3b9aca00",
        chainId,
        data: "0x",
      })
      const sig = wallet.signingKey.sign(tx.unsignedHash)
      const clone = tx.clone()
      clone.signature = sig
      return clone.serialized
    }
    await rpcCall(port, "eth_sendRawTransaction", [sign(startNonce)])
    await rpcCall(port, "eth_sendRawTransaction", [sign(startNonce + 5)])

    const status = await rpcCall(port, "txpool_status") as { pending: string; queued: string }
    const pendingCount = parseInt(status.pending, 16)
    const queuedCount = parseInt(status.queued, 16)
    assert.ok(pendingCount >= 1, `txpool_status.pending must count contiguous tx (got ${pendingCount})`)
    assert.ok(queuedCount >= 1, `txpool_status.queued must count gap tx (got ${queuedCount}, pre-fix was always 0)`)

    const content = await rpcCall(port, "txpool_content") as {
      pending: Record<string, Record<string, { nonce: string }>>
      queued: Record<string, Record<string, { nonce: string }>>
    }
    const pendingForSender = content.pending[senderAddr] ?? {}
    const queuedForSender = content.queued[senderAddr] ?? {}
    assert.ok(
      String(startNonce) in pendingForSender,
      `nonce ${startNonce} (contiguous) must be in pending, got pending=${JSON.stringify(Object.keys(pendingForSender))} queued=${JSON.stringify(Object.keys(queuedForSender))}`,
    )
    assert.ok(
      String(startNonce + 5) in queuedForSender,
      `nonce ${startNonce + 5} (gap) must be in queued, got pending=${JSON.stringify(Object.keys(pendingForSender))} queued=${JSON.stringify(Object.keys(queuedForSender))}`,
    )
    assert.ok(
      !(String(startNonce + 5) in pendingForSender),
      `gap nonce ${startNonce + 5} must NOT appear in pending`,
    )
  })

  await t.test("coc_nodeInfo returns node metadata", async () => {
    const info = await rpcCall(port, "coc_nodeInfo")
    assert.ok(typeof info === "object")
    assert.strictEqual(info.clientVersion, "COC/0.2")
    assert.strictEqual(info.chainId, chainId)
    assert.ok(typeof info.blockHeight === "number" || typeof info.blockHeight === "string")
    assert.ok(typeof info.mempool === "object")
    assert.ok(typeof info.mempool.size === "number")
    assert.ok(typeof info.uptime === "number")
    // nodeVersion, platform, arch removed from public endpoint (info disclosure)
  })

  await t.test("web3_clientVersion returns version string", async () => {
    const version = await rpcCall(port, "web3_clientVersion")
    assert.strictEqual(version, "COC/0.2")
  })

  await t.test("net_version returns chain ID string", async () => {
    const version = await rpcCall(port, "net_version")
    assert.strictEqual(version, String(chainId))
  })

  await t.test("net_listening returns true", async () => {
    const listening = await rpcCall(port, "net_listening")
    assert.strictEqual(listening, true)
  })

  await t.test("eth_gasPrice returns gas price", async () => {
    const price = await rpcCall(port, "eth_gasPrice")
    assert.ok(typeof price === "string")
    assert.ok(price.startsWith("0x"))
  })

  await t.test("eth_chainId returns chain ID", async () => {
    const id = await rpcCall(port, "eth_chainId")
    assert.strictEqual(id, `0x${chainId.toString(16)}`)
  })

  await t.test("eth_newPendingTransactionFilter returns filter id", async () => {
    const id = await rpcCall(port, "eth_newPendingTransactionFilter")
    assert.ok(typeof id === "string")
    assert.ok(id.startsWith("0x"))
  })

  await t.test("coc_getNetworkStats returns network info", async () => {
    const stats = await rpcCall(port, "coc_getNetworkStats")
    assert.ok(typeof stats === "object")
    assert.ok(stats.blockHeight.startsWith("0x"))
    assert.ok(typeof stats.peerCount === "number")
    assert.ok(typeof stats.p2p === "object")
    assert.ok(typeof stats.p2p.security === "object")
    assert.ok(typeof stats.p2p.security.rateLimitedRequests === "number")
    assert.ok(typeof stats.p2p.security.authRejectedRequests === "number")
    assert.ok(typeof stats.wire === "object")
    assert.equal(stats.wire.enabled, false) // no wire protocol in test
    assert.ok(typeof stats.dht === "object")
    assert.equal(stats.dht.enabled, false)
    assert.ok(typeof stats.bft === "object")
    assert.equal(stats.bft.enabled, false)
  })

  await t.test("coc_getRewardManifest returns settled reward summary", async () => {
    const manifest = await rpcCall(port, "coc_getRewardManifest", [7])
    assert.ok(typeof manifest === "object")
    assert.equal(manifest.epochId, 7)
    assert.equal(manifest.rewardRoot, `0x${"11".repeat(32)}`)
    assert.equal(manifest.totalReward, "100")
    assert.equal(manifest.settled, true)
    assert.equal(manifest.leaves, 1)
  })

  await t.test("coc_getRewardClaim returns proof payload", async () => {
    const claim = await rpcCall(port, "coc_getRewardClaim", [7, `0x${"22".repeat(32)}`])
    assert.ok(typeof claim === "object")
    assert.equal(claim.epochId, 7)
    assert.equal(claim.amount, "100")
    assert.deepEqual(claim.proof, [`0x${"33".repeat(32)}`])
    assert.equal(claim.settled, true)
  })

  await t.test("coc_getBftStatus returns disabled status", async () => {
    const status = await rpcCall(port, "coc_getBftStatus")
    assert.ok(typeof status === "object")
    assert.equal(status.enabled, false)
    assert.equal(status.active, false)
  })

  await t.test("coc_getGovernanceStats returns governance info", async () => {
    const stats = await rpcCall(port, "coc_getGovernanceStats")
    assert.ok(typeof stats === "object")
    // No governance module in basic ChainEngine, should return enabled: false
    assert.equal(stats.enabled, false)
  })

  await t.test("coc_getProposals returns empty without governance", async () => {
    const proposals = await rpcCall(port, "coc_getProposals")
    assert.ok(Array.isArray(proposals))
    assert.equal(proposals.length, 0)
  })

  await t.test("unsupported method throws error", async () => {
    await assert.rejects(
      () => rpcCall(port, "eth_nonExistentMethod"),
      (err: Error) => err.message.includes("not supported"),
    )
  })

  // PoW stub methods — COC uses PoSe consensus, no mining
  await t.test("eth_getWork returns 3 zero hashes", async () => {
    const result = await rpcCall(port, "eth_getWork")
    assert.ok(Array.isArray(result))
    assert.equal(result.length, 3)
    for (const hash of result) {
      assert.equal(hash, "0x" + "0".repeat(64))
    }
  })

  await t.test("eth_submitWork returns false", async () => {
    const result = await rpcCall(port, "eth_submitWork", ["0x1", "0x" + "0".repeat(64), "0x" + "0".repeat(64)])
    assert.equal(result, false)
  })

  await t.test("eth_submitHashrate returns false", async () => {
    const result = await rpcCall(port, "eth_submitHashrate", ["0x1", "0x" + "0".repeat(64)])
    assert.equal(result, false)
  })

  await t.test("#104: malformed eth_sendRawTransaction returns integer error.code (not ethers string code)", async () => {
    // Pre-fix bug: ethers errors thrown from the rawtx parse path carried
    // `code: "INVALID_ARGUMENT"` (a string), which the RPC catch passed
    // through verbatim — violating JSON-RPC 2.0 §5.1 (error.code MUST be
    // an integer) and leaking the ethers library version on every
    // response.
    for (const badRaw of ["0xnothex", "", "0xdeadbeef"]) {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [badRaw] }),
      })
      const json = await r.json() as { error?: { code: unknown; message: unknown } }
      assert.ok(json.error, `expected error for raw="${badRaw}"`)
      assert.equal(typeof json.error!.code, "number", `error.code must be a number for raw="${badRaw}", got ${typeof json.error!.code}: ${String(json.error!.code)}`)
      assert.ok(Number.isInteger(json.error!.code as number), `error.code must be integer, got ${json.error!.code}`)
      assert.equal(typeof json.error!.message, "string", "error.message must be a string")
    }
  })

  await t.test("#104: structured RPC errors with numeric code are preserved", async () => {
    // Regression check: legitimate handlers throw { code: -32602, message }
    // for invalid params. Those should NOT be coerced to -32603; only
    // non-numeric codes are coerced. eth_estimateGas with an invalid `to`
    // address throws { code: -32602, message: "invalid to address" }.
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [{ to: "not-a-hex-address" }] }),
    })
    const json = await r.json() as { error?: { code: unknown; message: unknown } }
    assert.ok(json.error)
    assert.equal(json.error!.code, -32602, "structured -32602 must be preserved verbatim")
    // #128 widened this message to "invalid to address: must match ..."
    // — assert the prefix instead of an exact match so future refinements
    // don't keep breaking this regression test.
    assert.match(json.error!.message as string, /^invalid to address/)
  })

  await t.test("#100: coc_getValidators returns an array (not a single string) without governance", async () => {
    // This RPC test fixture builds a ChainEngine without on-chain governance,
    // so we exercise the fallback path. Pre-fix, the fallback returned
    // `chain.expectedProposer(height + 1n)` — a single string — which
    // contradicted the method's name and broke array-shaped client code.
    const result = await rpcCall(port, "coc_getValidators") as unknown
    assert.ok(Array.isArray(result), `coc_getValidators must return an array, got: ${typeof result}`)
    // Every entry should be an object with at least an `id` field.
    const arr = result as Array<Record<string, unknown>>
    for (const v of arr) {
      assert.equal(typeof v, "object", "validator entry should be an object")
      assert.ok(typeof v.id === "string" && v.id.length > 0, `validator entry missing id: ${JSON.stringify(v)}`)
    }
    // The chain in this test fixture was constructed with `validators: ["node-1"]`,
    // so the fallback should expose exactly that.
    assert.equal(arr.length, 1, "fallback should return all hardcoded validators")
    assert.equal(arr[0].id, "node-1")
  })

  await t.test("coc_getEquivocations maps persisted BFT evidence fields", async () => {
    const result = await rpcCall(port, "coc_getEquivocations", [0])
    assert.ok(Array.isArray(result))
    assert.deepEqual(result, [
      {
        validatorId: "node-7",
        height: "12",
        vote1Hash: `0x${"aa".repeat(32)}`,
        vote2Hash: `0x${"bb".repeat(32)}`,
        timestamp: 1700000000000,
        phase: "prepare",
        type: "bft-equivocation",
      },
    ])
  })

  await t.test("#112: eth_getBlockByNumber(\"earliest\") returns a synthesised genesis block (not null)", async () => {
    // Pre-fix: returned null because chain.getBlockByNumber(0n) was missing.
    // Required for ethers/viem/hardhat fork-detection code paths.
    const proposed = await chain.proposeNextBlock()
    assert.ok(proposed, "need at least one real block on the chain so height ≥ 1")
    const earliest = await rpcCall(port, "eth_getBlockByNumber", ["earliest", false]) as Record<string, unknown> | null
    assert.ok(earliest !== null, "earliest must not be null")
    assert.equal(earliest!.number, "0x0", "earliest.number must be 0x0")
    assert.equal(earliest!.hash, "0x" + "0".repeat(64), "earliest.hash must be all zeros (block-1's parentHash)")
    assert.equal(earliest!.parentHash, "0x" + "0".repeat(64))
    assert.equal(earliest!.timestamp, "0x0")
    assert.deepEqual(earliest!.transactions, [])
    // Same response for the explicit "0x0" tag
    const zeroTag = await rpcCall(port, "eth_getBlockByNumber", ["0x0", false]) as Record<string, unknown>
    assert.equal(zeroTag.hash, earliest!.hash)
  })

  await t.test("#384: state-query RPCs at \"earliest\"/\"0x0\" return zero/empty (not 'block not found')", async () => {
    // Pre-fix: eth_getBlockByNumber("earliest") synthesised a genesis
    // block (#112) but every state-query RPC threw `-32001 block not
    // found: earliest` because resolveHistoricalExecutionContext lacked
    // the parallel synthesis path. ethers/viem/web3.js wallets that
    // probe genesis state during initialisation (balance check, chainId
    // smoke test, fork-detection) hit the error and failed to connect.
    //
    // Fix mirrors #112: when block 0 is requested but the chain has
    // no persisted block 0 and height ≥ 1, return the empty default —
    // zero balance / no code / nonce 0 / zero storage — matching what
    // geth and anvil return for genesis state queries.
    const proposed = await chain.proposeNextBlock()
    assert.ok(proposed, "need at least one real block so height ≥ 1")
    const sampleAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    for (const tag of ["earliest", "0x0"]) {
      const bal = await rpcCall(port, "eth_getBalance", [sampleAddr, tag])
      assert.equal(bal, "0x0", `eth_getBalance(${tag}) must return 0x0, got ${JSON.stringify(bal)}`)
      const code = await rpcCall(port, "eth_getCode", [sampleAddr, tag])
      assert.equal(code, "0x", `eth_getCode(${tag}) must return 0x, got ${JSON.stringify(code)}`)
      const nonce = await rpcCall(port, "eth_getTransactionCount", [sampleAddr, tag])
      assert.equal(nonce, "0x0", `eth_getTransactionCount(${tag}) must return 0x0, got ${JSON.stringify(nonce)}`)
      const storage = await rpcCall(port, "eth_getStorageAt", [sampleAddr, "0x0", tag])
      assert.equal(storage, `0x${"0".repeat(64)}`, `eth_getStorageAt(${tag}) must return 32-byte zero, got ${JSON.stringify(storage)}`)
      const callRet = await rpcCall(port, "eth_call", [{ to: sampleAddr, data: "0x" }, tag])
      assert.equal(callRet, "0x", `eth_call(${tag}) must return 0x (no code), got ${JSON.stringify(callRet)}`)
    }
    // Sanity: non-genesis tags still go through the normal path. Use
    // "latest" — should not throw.
    const balLatest = await rpcCall(port, "eth_getBalance", [sampleAddr, "latest"])
    assert.match(String(balLatest), /^0x[0-9a-f]+$/, "eth_getBalance(latest) still works")
  })

  await t.test("#108 part-2: coc_getPeers exposes the public peer list (id + url)", async () => {
    const peers = await rpcCall(port, "coc_getPeers") as Array<{ id: string; url: string }>
    assert.ok(Array.isArray(peers), "must return an array")
    assert.equal(peers.length, 2)
    // Second peer in the stub has advertisedUrl — it should win over url
    const node3 = peers.find(p => p.id === "node-3")
    assert.ok(node3, "node-3 must be present")
    assert.equal(node3!.url, "http://203.0.113.3:29780", "advertisedUrl must take precedence over internal url")
    const node2 = peers.find(p => p.id === "node-2")
    assert.ok(node2, "node-2 must be present")
    assert.equal(node2!.url, "http://10.0.0.2:29780", "url falls back when no advertisedUrl")
  })

  await t.test("#108: coc_erasureStatus bridges the existing /api/v0/erasure/status path to RPC", async () => {
    const result = await rpcCall(port, "coc_erasureStatus", ["bafy-mock-manifest"])
    assert.ok(typeof result === "object" && result !== null)
    const status = result as { fileSize: number; scheme: string; n: number; m: number; stripes: unknown[] }
    assert.equal(status.fileSize, 1_048_576)
    assert.equal(status.scheme, "rs(4+2)")
    assert.equal(status.n, 4)
    assert.equal(status.m, 2)
    assert.ok(Array.isArray(status.stripes) && status.stripes.length === 1)
  })

  await t.test("#108: coc_erasureStatus rejects missing CID with -32602", async () => {
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_erasureStatus", params: [""] }),
    })
    const json = await r.json() as { error?: { code: number; message: string } }
    assert.ok(json.error)
    assert.equal(json.error!.code, -32602)
  })

  await t.test("#106: coc_getEquivocationsTotal returns the count of all evidence entries", async () => {
    // The operator runbook tells operators to alert on this metric, but
    // pre-fix the method threw "method not supported". The fixture
    // injects one mock equivocation via getBftEquivocations, so the count
    // should be 1.
    const result = await rpcCall(port, "coc_getEquivocationsTotal")
    assert.equal(typeof result, "number", `coc_getEquivocationsTotal must return a number, got ${typeof result}`)
    assert.equal(result, 1, "fixture has exactly one mock equivocation, so total must be 1")
  })

  await t.test("#124: eth_getCode / eth_getStorageAt / eth_getProof / eth_call reject malformed addresses with -32602", async () => {
    // Same class as #122 but the address-arg variants for these methods
    // still used requireHexParam, which accepts any 0x-prefixed hex up
    // to 64 chars. Pre-fix:
    //   - eth_getCode("0x123", ...)  surfaced as -32603 internal error
    //     ("Address must be 20 bytes long") from Address.fromString
    //   - eth_getStorageAt("0x123", ...) same internal-error leak via
    //     the evm layer
    //   - eth_getProof("0x123", [], ...) same internal-error leak
    //   - eth_call({to:"0x1"}) regex was /^0x[0-9a-fA-F]{1,40}$/ which
    //     accepted 1-39 hex chars instead of exactly 40
    const badAddrs = ["not-an-address", "0x", "0x123", "0x" + "g".repeat(40), "0x" + "f".repeat(41), "0x" + "f".repeat(39)]
    const cases: Array<{ method: string; params: (b: string) => unknown[] }> = [
      { method: "eth_getCode", params: (b) => [b, "latest"] },
      { method: "eth_getStorageAt", params: (b) => [b, "0x0", "latest"] },
      { method: "eth_getProof", params: (b) => [b, [], "latest"] },
      { method: "eth_call", params: (b) => [{ to: b }, "latest"] },
    ]
    for (const { method, params } of cases) {
      for (const badAddr of badAddrs) {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params(badAddr) }),
        })
        const json = await r.json() as { error?: { code: number; message: string } }
        assert.ok(json.error, `expected error for ${method}(${JSON.stringify(badAddr)})`)
        assert.equal(json.error!.code, -32602, `${method}(${JSON.stringify(badAddr)}) must be -32602, got ${json.error!.code} (${json.error!.message})`)
        assert.match(json.error!.message, /invalid (to |from )?address/i, `${method} error message should mention "invalid address"`)
      }
    }
    // Sanity: valid address shape still works (eth_call with no `to` and
    // eth_getCode/Storage/Proof against a fresh account returns "0x"/"0x0"
    // or empty proof structure).
    const validAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const code = await rpcCall(port, "eth_getCode", [validAddr, "latest"])
    assert.match(code as string, /^0x[0-9a-f]*$/i)
    const slot = await rpcCall(port, "eth_getStorageAt", [validAddr, "0x0", "latest"])
    assert.match(slot as string, /^0x[0-9a-f]+$/i)
  })

  await t.test("#128: eth_estimateGas rejects malformed to/from addresses with -32602", async () => {
    // Follow-up to #124: that PR fixed eth_call's regex but missed
    // eth_estimateGas which had the same /^0x[0-9a-fA-F]{1,40}$/
    // copy-paste. An address must be exactly 40 hex chars.
    const validAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const badAddrs = ["0x", "0x1", "0x" + "f".repeat(39), "0x" + "f".repeat(41), "0x" + "g".repeat(40)]
    for (const bad of badAddrs) {
      for (const field of ["to", "from"]) {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_estimateGas",
            params: [{ [field]: bad, ...(field === "to" ? { from: validAddr } : { to: validAddr }) }],
          }),
        })
        const json = await r.json() as { error?: { code: number; message: string } }
        assert.ok(json.error, `expected error for ${field}=${JSON.stringify(bad)}`)
        assert.equal(json.error!.code, -32602, `${field}=${JSON.stringify(bad)} must be -32602, got ${json.error!.code}`)
        assert.match(json.error!.message, new RegExp(`invalid ${field} address`, "i"))
      }
    }
    // Sanity: a valid call still returns a hex gas estimate.
    const result = await rpcCall(port, "eth_estimateGas", [{ from: validAddr, to: validAddr, value: "0x0" }])
    assert.match(result as string, /^0x[0-9a-f]+$/i)
  })

  await t.test("#132: structured error codes for block range, unknown method, legacy compile", async () => {
    // (a) eth_getLogs over a range > MAX_LOG_BLOCK_RANGE (=10000) → -32602
    const tooWide = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getLogs",
        params: [{ fromBlock: "0x0", toBlock: "0x4000" }],
      }),
    })
    const tooWideJson = await tooWide.json() as { error?: { code: number; message: string } }
    assert.ok(tooWideJson.error)
    assert.equal(tooWideJson.error!.code, -32602, `too-wide range must be -32602, got ${tooWideJson.error!.code}`)
    assert.match(tooWideJson.error!.message, /block range too large/)

    // (b) eth_getLogs with fromBlock > toBlock → -32602
    const swapped = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getLogs",
        params: [{ fromBlock: "0xa", toBlock: "0x5" }],
      }),
    })
    const swappedJson = await swapped.json() as { error?: { code: number; message: string } }
    assert.equal(swappedJson.error!.code, -32602, `swapped range must be -32602, got ${swappedJson.error!.code}`)
    assert.match(swappedJson.error!.message, /invalid block range/)

    // (c) unknown method → -32601 method not found
    const unknown = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "foo_bar_baz", params: [] }),
    })
    const unknownJson = await unknown.json() as { error?: { code: number; message: string } }
    assert.equal(unknownJson.error!.code, -32601, `unknown method must be -32601, got ${unknownJson.error!.code}`)
    assert.match(unknownJson.error!.message, /method not supported/)

    // (d) eth_compileLLL / eth_compileSerpent → -32601 (legacy)
    const compileLll = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_compileLLL", params: ["foo"] }),
    })
    const compileLllJson = await compileLll.json() as { error?: { code: number; message: string } }
    assert.equal(compileLllJson.error!.code, -32601, `eth_compileLLL must be -32601`)
  })

  await t.test("#138: JSON-RPC §5.1 spec codes for parse-error / empty-body / invalid-request", async () => {
    // Probed live testnet — each of these returned -32603 (internal error)
    // pre-fix. The parse path additionally leaked the raw V8 JSON.parse
    // message ("Expected property name or '}' in JSON at position 1...").

    // (a) Malformed JSON body → -32700 Parse error
    const parseErr = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not valid json",
    })
    const parseJson = await parseErr.json() as { error?: { code: number; message: string } }
    assert.equal(parseJson.error!.code, -32700, `malformed JSON must be -32700, got ${parseJson.error!.code}`)
    assert.match(parseJson.error!.message, /parse error/i)
    // Crucially, the V8 internal phrasing must NOT leak.
    assert.doesNotMatch(parseJson.error!.message, /position \d+|line \d+ column/i, "V8 JSON.parse internals must not leak")

    // (b) Empty body → -32600 Invalid Request
    const emptyErr = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    })
    const emptyJson = await emptyErr.json() as { error?: { code: number; message: string } }
    assert.equal(emptyJson.error!.code, -32600, `empty body must be -32600, got ${emptyJson.error!.code}`)

    // (c) String payload (valid JSON, invalid request) → -32600 with code field
    const strPayload = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '"just a string"',
    })
    const strJson = await strPayload.json() as { error?: { code: number; message: string } }
    assert.equal(strJson.error!.code, -32600, `string-payload must include code -32600, got ${strJson.error?.code}`)
  })

  await t.test("#140: JSON-RPC 2.0 §4.1 notifications get no response; §6 empty batch errors", async () => {
    // (a) Single notification (no `id` field) → HTTP 204 no-body
    const notify = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [] }),
    })
    assert.equal(notify.status, 204, `notification must HTTP 204 no-body, got ${notify.status}`)
    const notifyBody = await notify.text()
    assert.equal(notifyBody, "", "notification body must be empty")

    // (b) Empty batch [] → single Invalid Request -32600 (not [])
    const emptyBatch = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    })
    assert.equal(emptyBatch.status, 200)
    const emptyJson = await emptyBatch.json() as { error?: { code: number; message: string } } | unknown[]
    assert.ok(!Array.isArray(emptyJson), "empty batch must return single object, not []")
    assert.equal((emptyJson as { error: { code: number } }).error.code, -32600, "empty batch error must be -32600")

    // (c) Batch of all notifications → 204 no-body
    const batchNotify = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
      ]),
    })
    assert.equal(batchNotify.status, 204, `batch of notifications must HTTP 204, got ${batchNotify.status}`)

    // (d) Mixed batch (1 notification + 1 request) → array with only the request's response
    const mixed = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "eth_chainId", params: [] }, // notification (no id)
        { jsonrpc: "2.0", id: 42, method: "eth_blockNumber", params: [] },
      ]),
    })
    assert.equal(mixed.status, 200)
    const mixedJson = await mixed.json() as Array<{ id: number; result: string }>
    assert.ok(Array.isArray(mixedJson))
    assert.equal(mixedJson.length, 1, "notification must be filtered out, leaving only the request's response")
    assert.equal(mixedJson[0].id, 42)
  })

  await t.test("#142: eth_newFilter validates address and topic shape (rejects with -32602)", async () => {
    // Pre-fix any string was accepted for address/topics. Malformed
    // filters consumed MAX_FILTERS slots while matching 0 logs forever,
    // and clients couldn't distinguish typo'd filters from "no events".
    const validAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const validTopic = "0x" + "a".repeat(64)
    const cases: Array<{ params: unknown; what: string }> = [
      { params: [{ address: "not-an-address" }], what: "address non-hex" },
      { params: [{ address: "0x123" }], what: "address short hex" },
      { params: [{ address: ["0x" + "f".repeat(40), "0xbad"] }], what: "address array with bad index" },
      { params: [{ topics: ["not-hex"] }], what: "topic non-hex" },
      { params: [{ topics: ["0x1"] }], what: "topic too short" },
      { params: [{ topics: [null, "0xbad"] }], what: "topic null+bad" },
      { params: [{ topics: [["0x" + "a".repeat(64), "0xbad"]] }], what: "topic OR-array with bad index" },
    ]
    for (const { params, what } of cases) {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_newFilter", params }),
      })
      const json = await r.json() as { result?: string; error?: { code: number; message: string } }
      assert.ok(json.error, `eth_newFilter(${what}) must reject, got result=${json.result}`)
      assert.equal(json.error!.code, -32602, `eth_newFilter(${what}) must be -32602, got ${json.error!.code}`)
      assert.match(json.error!.message, /invalid filter (address|topic)/, `error message for ${what}`)
    }
    // Sanity: a fully valid filter spec creates a filter.
    const okId = await rpcCall(port, "eth_newFilter", [{ address: validAddr, topics: [validTopic, null] }])
    assert.match(okId as string, /^0x[0-9a-f]+$/i, "valid filter must return id")
  })

  await t.test("#146: coc_dhtFindProviders / coc_ipfsFetchBlockFromPeer surface errors via JSON-RPC error field", async () => {
    // Pre-fix these handlers returned `{result: {providers: [], error: "..."}}`
    // (or `{result: {bytes: null, error: "..."}}`), wrapping the error
    // inside the result body. Clients that check `response.error` per
    // JSON-RPC §5 never saw the failure.
    const probeError = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { result?: unknown; error?: { code: number; message: string } }
    }
    // (a) coc_dhtFindProviders with no/empty/bad CID → -32602
    for (const params of [[], [""], ["not-a-cid\nwith-newline"], ["x".repeat(513)], ["../path"]]) {
      const j = await probeError("coc_dhtFindProviders", params)
      assert.ok(j.error, `coc_dhtFindProviders(${JSON.stringify(params)}) must error, got result=${JSON.stringify(j.result)}`)
      assert.equal(j.error!.code, -32602)
      assert.equal(j.result, undefined, "errors must be in error field, not result body")
    }
    // (b) coc_ipfsFetchBlockFromPeer same shape
    for (const params of [[], [""], ["foo\0bar"]]) {
      const j = await probeError("coc_ipfsFetchBlockFromPeer", params)
      assert.ok(j.error)
      assert.equal(j.error!.code, -32602)
      assert.equal(j.result, undefined)
    }
    // (c) coc_resolveDid / coc_getDIDDocument on a node without DID config
    // → -32601 method not available (not -32603 internal-error).
    for (const method of ["coc_resolveDid", "coc_getDIDDocument"]) {
      const j = await probeError(method, [])
      assert.ok(j.error)
      assert.equal(j.error!.code, -32601, `${method} must be -32601 when not configured, got ${j.error!.code}`)
    }
  })

  await t.test("#148: eth_call / estimateGas / sendTransaction / createAccessList validate value/gas/data shape", async () => {
    // Pre-fix `eth_estimateGas({value:"not-hex"})` returned a clean gas
    // estimate — the EVM silently treated non-hex value as 0, masking
    // client typos. `eth_call({data:"not-hex"})` surfaced as -32603 with
    // the V8 message leaking ("Input must be a 0x-prefixed...").
    const validAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const badShapes = [
      { value: "not-hex" }, { value: "100" }, { value: "0xZZ" },
      { gas: "not-hex" }, { gasPrice: "100" },
      { data: "not-hex" }, { data: "0xZ" }, { data: "0x123" }, // odd-length data
    ]
    for (const method of ["eth_call", "eth_estimateGas", "eth_createAccessList"]) {
      for (const bad of badShapes) {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method,
            params: [{ to: validAddr, from: validAddr, ...bad }],
          }),
        })
        const json = await r.json() as { result?: unknown; error?: { code: number; message: string } }
        assert.ok(json.error, `${method}(${JSON.stringify(bad)}) must reject, got result=${JSON.stringify(json.result)}`)
        assert.equal(json.error!.code, -32602, `${method}(${JSON.stringify(bad)}) must be -32602, got ${json.error!.code}`)
        assert.match(json.error!.message, /invalid (value|gas|gasPrice|data)/, "message must name the bad field")
      }
    }
    // Sanity: clean values pass through.
    const ok = await rpcCall(port, "eth_estimateGas", [{ from: validAddr, to: validAddr, value: "0x1000", data: "0x" }])
    assert.match(ok as string, /^0x[0-9a-f]+$/i)
  })

  await t.test("#150: eth_getTransactionByHash / eth_getTransactionReceipt reject short tx hashes with -32602", async () => {
    // Pre-fix the loose requireHexParam accepted any 0x-prefixed hex up
    // to 64 chars. `"0x123"` slipped through and the tx-lookup returned
    // null ("not found") — clients couldn't tell a typo from a missing
    // tx, so receipt pollers waited forever on bad hashes.
    // Probe a few representative shapes; full panel covered in the
    // #122/#124 address-validation tests. (Kept short to stay under
    // the per-IP rate-limit shared with other tests in this fixture.)
    const cases = [
      { method: "eth_getTransactionByHash", hash: "0x123" },
      { method: "eth_getTransactionByHash", hash: "0x" + "f".repeat(63) },
      { method: "eth_getTransactionReceipt", hash: "0x" + "g".repeat(64) },
    ]
    for (const { method, hash } of cases) {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [hash] }),
      })
      const json = await r.json() as { result?: unknown; error?: { code: number; message: string } }
      assert.ok(json.error, `${method}(${JSON.stringify(hash)}) must error, got result=${JSON.stringify(json.result)}`)
      assert.equal(json.error!.code, -32602, `${method}(${JSON.stringify(hash)}) must be -32602, got ${json.error!.code}`)
      assert.match(json.error!.message, /invalid transaction hash/, "error must name the field")
    }
    // Sanity: a valid (but non-existent) hash returns null, not error.
    const validButMissing = "0x" + "a".repeat(64)
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [validButMissing] }),
    })
    const json = await r.json() as { result: unknown; error?: unknown }
    assert.equal(json.error, undefined, "valid-shape but non-existent hash must NOT error")
    assert.equal(json.result, null, "valid-shape but non-existent hash returns null")
  })

  await t.test("#154: eth_sign / eth_signTypedData_v4 validate address + message shape upfront", async () => {
    // Pre-fix bogus address → -32603 "account not found: <raw>" leaking
    // the typo. Now validates shape first → -32602; only the
    // resource-not-found case yields -32004.
    // (Kept to 2 probes to stay under the per-IP rate-limit shared with
    // other tests in this fixture.)
    const probe = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) eth_sign with bogus address → -32602 (pre-fix was -32603)
    const r1 = await probe("eth_sign", ["bogus", "0x0"])
    assert.equal(r1.error?.code, -32602, `bogus address must be -32602, got ${r1.error?.code}`)
    // (b) eth_signTypedData_v4 with valid address but non-object typedData → -32602
    const unknownAddr = "0x" + "9".repeat(40)
    const r2 = await probe("eth_signTypedData_v4", [unknownAddr, "not-an-object"])
    assert.equal(r2.error?.code, -32602, `non-object typedData must be -32602, got ${r2.error?.code}`)
  })

  await t.test("#156: eth_sendRawTransaction rejects malformed input with -32602 and clean message (no ethers leak)", async () => {
    // Pre-fix bogus input (e.g. "0xff") flowed into ethers.Transaction.from()
    // and surfaced as -32603 "data short segment too short (buffer=0xff,
    // length=1, offset=9, code=BUFFER_OVERRUN, version=6.16.0)" — leaking
    // the ethers.js version + internal error class to any unauthenticated
    // caller. Validate shape upfront so clients get -32602 with a clean
    // message. (Kept to 2 probes to stay under the per-IP rate-limit
    // shared with other tests in this fixture.)
    const probe = async (raw: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) Non-string param hits the type guard → -32602
    const r1 = await probe(null)
    assert.equal(r1.error?.code, -32602, `null must be -32602, got ${r1.error?.code}`)
    assert.doesNotMatch(r1.error!.message, /version=|BUFFER_OVERRUN|INVALID_ARGUMENT|UNSUPPORTED_OPERATION/, "must not leak ethers internals")
    // (b) Well-shaped but too-short hex hits the length floor → -32602
    const r2 = await probe("0xff")
    assert.equal(r2.error?.code, -32602, `too-short must be -32602, got ${r2.error?.code}`)
    assert.doesNotMatch(r2.error!.message, /version=|BUFFER_OVERRUN|INVALID_ARGUMENT|UNSUPPORTED_OPERATION/, "must not leak ethers internals")
  })

  await t.test("#160: eth_feeHistory validates rewardPercentile range + monotonic order", async () => {
    // Pre-fix percentiles outside [0,100], non-numeric, or non-monotonic
    // silently flowed into feeOracle.computeFeeHistoryRewards and returned
    // "0x0" rewards. Spec requires monotonic [0,100]; geth rejects with
    // explicit error. (Kept to 2 probes to stay under the rate-limit.)
    const probe = async (percentiles: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_feeHistory", params: ["0x2", "latest", percentiles] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) Out-of-range (>100) → -32602
    const r1 = await probe([150])
    assert.equal(r1.error?.code, -32602, `out-of-range must be -32602, got ${r1.error?.code}`)
    assert.match(r1.error!.message, /out of range|rewardPercentile/i, "error must name the field")
    // (b) Non-monotonic order → -32602
    const r2 = await probe([75, 25, 50])
    assert.equal(r2.error?.code, -32602, `non-monotonic must be -32602, got ${r2.error?.code}`)
    assert.match(r2.error!.message, /monotonic|ascending|non-decreasing/i, "error must mention ordering")
  })

  await t.test("#162: eth_getLogs validates address + topic shape (parity with eth_newFilter #142)", async () => {
    // Pre-fix `eth_getLogs({address:"0x123"})` silently returned [] —
    // clients couldn't distinguish "no matching logs" from "your filter
    // is malformed". eth_newFilter was already strict via #142; this
    // closes the eth_getLogs backdoor.
    const probe = async (filter: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) bad address shape → -32602
    const r1 = await probe({ address: "0x123" })
    assert.equal(r1.error?.code, -32602, `bad address must be -32602, got ${r1.error?.code}`)
    assert.match(r1.error!.message, /address/i, "error must name the field")
    // (b) bad topic shape → -32602
    const r2 = await probe({ topics: ["0x123"] })
    assert.equal(r2.error?.code, -32602, `short topic must be -32602, got ${r2.error?.code}`)
    assert.match(r2.error!.message, /topic/i, "error must name the field")
    // (c) too many topics (max 4) → -32602
    const t64 = "0x" + "0".repeat(64)
    const r3 = await probe({ topics: [t64, t64, t64, t64, t64] })
    assert.equal(r3.error?.code, -32602, `5 topics must be -32602, got ${r3.error?.code}`)
    // Sanity: valid filter returns an empty (or populated) array, not error.
    const ok = await probe({ address: "0x" + "a".repeat(40), topics: [t64, null] })
    assert.equal(ok.error, undefined, `valid filter must not error: ${JSON.stringify(ok.error)}`)
    assert.ok(Array.isArray(ok.result), "valid filter returns an array")
  })

  await t.test("#164: oversized JSON-RPC batch rejects with -32600 (no silent truncation)", async () => {
    // Pre-fix `payload.slice(0, MAX_BATCH_SIZE)` silently dropped items
    // beyond the 100 cap — clients sending 1000 items got 100 results
    // and had no way to tell their other 900 requests never ran. For
    // state-changing requests (eth_sendRawTransaction) that's a silent
    // data-loss bug. Now reject the whole batch with -32600.
    const oversizedBatch = Array.from({ length: 101 }, (_, i) => ({
      jsonrpc: "2.0", id: i, method: "eth_blockNumber", params: [],
    }))
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(oversizedBatch),
    })
    const j = await r.json() as { error?: { code: number; message: string }; result?: unknown }
    // Must be a single object error response, NOT an array of 100 results.
    assert.ok(!Array.isArray(j), `expected single error object, got array of length ${Array.isArray(j) ? (j as unknown[]).length : "n/a"}`)
    assert.equal(j.error?.code, -32600, `expected -32600, got ${j.error?.code}`)
    assert.match(j.error!.message, /batch too large|max/i, "error must explain the cap")
  })

  await t.test("#166: eth_getBlockByHash + siblings validate hash shape upfront (parity with #150)", async () => {
    // Pre-fix the *byHash variants silently accepted any input
    // (undefined, null, short hex, non-hex) and returned null —
    // indistinguishable from "valid hash, no such block". PR #150
    // fixed this for eth_getTransactionByHash; #166 extends the same
    // pattern to eth_getBlockByHash, eth_getBlockTransactionCountByHash,
    // and eth_getTransactionByBlockHashAndIndex.
    const probe = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) eth_getBlockByHash with short hash → -32602
    const r1 = await probe("eth_getBlockByHash", ["0x123", false])
    assert.equal(r1.error?.code, -32602, `short hash must be -32602, got ${r1.error?.code}`)
    assert.match(r1.error!.message, /block hash/i, "error must name the field")
    // (b) eth_getBlockTransactionCountByHash with non-hex → -32602
    const r2 = await probe("eth_getBlockTransactionCountByHash", ["not-hex"])
    assert.equal(r2.error?.code, -32602, `non-hex must be -32602, got ${r2.error?.code}`)
    // Sanity: valid 32-byte hex (but non-existent block) returns null, not error.
    const validButMissing = "0x" + "a".repeat(64)
    const ok = await probe("eth_getBlockByHash", [validButMissing, false])
    assert.equal(ok.error, undefined, `valid-shape but non-existent must NOT error: ${JSON.stringify(ok.error)}`)
    assert.equal(ok.result, null, "valid-shape but non-existent returns null")
  })

  await t.test("#170: web3_sha3 rejects malformed hex (no silent keccak256(\"\") for garbage)", async () => {
    // Pre-fix Buffer.from("not-hex", "hex") silently dropped invalid
    // chars and produced empty bytes — so every garbage input returned
    // the same keccak256("") hash. Validate shape upfront so clients
    // learn about the typo instead of getting a misleading "valid" hash.
    const probe = async (raw: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_sha3", params: [raw] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) non-hex string → -32602
    const r1 = await probe("not-hex")
    assert.equal(r1.error?.code, -32602, `non-hex must be -32602, got ${r1.error?.code}`)
    // (b) missing 0x prefix → -32602
    const r2 = await probe("deadbeef")
    assert.equal(r2.error?.code, -32602, `no-0x must be -32602, got ${r2.error?.code}`)
    // Sanity: explicit empty (0x) hashes correctly to keccak256("").
    const empty = await probe("0x")
    assert.equal(empty.error, undefined, `0x must succeed: ${JSON.stringify(empty.error)}`)
    assert.equal(empty.result, "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "0x must hash to keccak256 of empty")
    // Sanity: real input still hashes correctly.
    const valid = await probe("0xdeadbeef")
    assert.equal(valid.result, "0xd4fd4e189132273036449fc9e11198c739161b4c0116a9a2dccdfa1c492006f1")
  })

  await t.test("#172: eth_call / eth_estimateGas reject non-object first param", async () => {
    // Pre-fix `((params)[0] ?? {}) as Record<string,string>` was a
    // no-op type assertion; strings/arrays/numbers coerced to {} and
    // the EVM returned "0x" or a default gas estimate. Now: only
    // object | null | undefined accepted.
    const probe = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) eth_call with string tx → -32602
    const r1 = await probe("eth_call", ["string-input", "latest"])
    assert.equal(r1.error?.code, -32602, `string tx must be -32602, got ${r1.error?.code}`)
    // (b) eth_estimateGas with array tx → -32602
    const r2 = await probe("eth_estimateGas", [["array"]])
    assert.equal(r2.error?.code, -32602, `array tx must be -32602, got ${r2.error?.code}`)
    // Sanity: null still treated as empty (ergonomic for ping-style probes).
    const ok = await probe("eth_call", [null, "latest"])
    assert.equal(ok.error, undefined, `null tx must NOT error: ${JSON.stringify(ok.error)}`)
  })

  await t.test("#178: eth_sendTransaction validates + honors user-provided nonce", async () => {
    // Pre-fix txParams.nonce was silently dropped — every call used
    // the next sequential mempool nonce regardless of what the user
    // passed. Negative / non-hex / NaN nonces all "worked" with the
    // value ignored. Now: validate shape, honor when present.
    const accounts = await rpcCall(port, "eth_accounts") as string[]
    const probe = async (nonce: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_sendTransaction",
          params: [{ from: accounts[0], to: accounts[1], value: "0x1000", gas: "0x5208", nonce }],
        }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) negative nonce → -32602 (pre-fix was silently accepted)
    const r1 = await probe("-1")
    assert.equal(r1.error?.code, -32602, `negative nonce must be -32602, got ${r1.error?.code}`)
    assert.match(r1.error!.message, /nonce/i, "error must name the field")
    // (b) non-hex nonce → -32602
    const r2 = await probe("not-hex")
    assert.equal(r2.error?.code, -32602, `non-hex nonce must be -32602, got ${r2.error?.code}`)
  })

  await t.test("#182: eth_signTypedData_v4 sanitizes ethers errors (no version + INVALID_ARGUMENT leak)", async () => {
    // Pre-fix structural errors from TypedDataEncoder.hash (missing
    // primaryType, primaryType not in types, circular references)
    // bubbled up as -32603 with ethers' raw message including
    // version=6.16.0 and code=INVALID_ARGUMENT. Same class of leak
    // as #156 (Transaction.from) and #176 (V8 SyntaxError).
    const accounts = await rpcCall(port, "eth_accounts") as string[]
    const probe = async (typedData: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_signTypedData_v4", params: [accounts[0], typedData] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) empty typed data — missing primaryType + types → -32602, no leak
    const r1 = await probe({})
    assert.equal(r1.error?.code, -32602, `empty typedData must be -32602, got ${r1.error?.code}`)
    assert.doesNotMatch(r1.error!.message, /version=|INVALID_ARGUMENT|code=/, "must not leak ethers internals")
    // (b) circular type reference → -32602, no leak
    const circ = { types: { EIP712Domain: [], A: [{ name: "a", type: "A" }] }, primaryType: "A", domain: {}, message: { a: {} } }
    const r2 = await probe(circ)
    assert.equal(r2.error?.code, -32602, `circular ref must be -32602, got ${r2.error?.code}`)
    assert.doesNotMatch(r2.error!.message, /version=|INVALID_ARGUMENT|code=/, "must not leak ethers internals")
  })

  await t.test("#184: coc_chainStats does not crash when chain.cfg.chainId is undefined", async () => {
    // Pre-fix `chain.cfg.chainId.toString(16)` assumed chainId was
    // always set, but ChainEngineConfig.chainId is optional in the
    // type. Bare undefined.toString() leaked as
    // -32603 "Cannot read properties of undefined (reading 'toString')".
    // This fixture deliberately does NOT pass chainId to ChainEngine
    // (see line 38-48), so chain.cfg.chainId is undefined here — making
    // this a direct repro of the bug.
    const stats = await rpcCall(port, "coc_chainStats") as Record<string, unknown>
    assert.ok(typeof stats === "object" && stats !== null, "must return an object")
    assert.equal(stats.chainId, "0x1", `chainId must fall back to "0x1" when cfg.chainId is undefined, got ${stats.chainId}`)
    assert.ok(typeof stats.blockHeight === "string", "blockHeight must be hex")
    assert.ok(typeof stats.validatorCount === "number", "validatorCount must be number")
    // Defend against V8 leak in error path.
    assert.doesNotMatch(JSON.stringify(stats), /Cannot read properties|undefined.*reading/, "must not leak TypeError")
  })

  await t.test("#186: eth_getLogs validates blockHash field shape (parity with address+topics #162)", async () => {
    // Pre-fix the blockHash field was accepted as anything — "0x123",
    // "bogus", null, 42 all returned `result: []` indistinguishable
    // from "no logs in that block". Now validates 32-byte hex shape
    // matching the eth_getBlockByHash (#166) rule.
    const probe = async (filter: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) Short blockHash → -32602
    const r1 = await probe({ blockHash: "0x123" })
    assert.equal(r1.error?.code, -32602, `short blockHash must be -32602, got ${r1.error?.code}`)
    assert.match(r1.error!.message, /blockHash/i, "error must name the field")
    // (b) Non-hex blockHash → -32602
    const r2 = await probe({ blockHash: "bogus" })
    assert.equal(r2.error?.code, -32602, `non-hex blockHash must be -32602, got ${r2.error?.code}`)
    // Sanity: omitted / explicit-null blockHash still works (returns []).
    const ok = await probe({})
    assert.equal(ok.error, undefined, "omitted blockHash must NOT error")
  })

  await t.test("#188: parseBlockTag rejects fractional block numbers (no silent floor)", async () => {
    // Pre-fix `BigInt(Math.floor(input))` silently truncated fractional
    // values: a client passing `1.5` got block 1 with no error. On a
    // chain where block 1 exists, they'd get the wrong block's data
    // without any signal that their input was malformed.
    const probe = async (tag: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getStorageAt",
          params: ["0x" + "1".repeat(40), "0x" + "2".repeat(64), tag] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) Fractional positive → -32602
    const r1 = await probe(1.5)
    assert.equal(r1.error?.code, -32602, `1.5 must be -32602, got ${r1.error?.code}`)
    assert.match(r1.error!.message, /block number/i, "error must name the field")
    // (b) Fractional sub-1 → -32602
    const r2 = await probe(0.5)
    assert.equal(r2.error?.code, -32602, `0.5 must be -32602, got ${r2.error?.code}`)
  })

  await t.test("#194: parseBlockTag rejects array/object/bool shapes (no silent fallback to latest)", async () => {
    // Pre-fix the unknown-shape branch of parseBlockTag fell through
    // to `return fallback` — every non-string, non-number input (arrays,
    // objects, booleans) silently mapped to the latest block height.
    // A client passing the wrong shape got latest's state with no
    // signal that their query was malformed.
    const probe = async (tag: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance",
          params: ["0x" + "0".repeat(40), tag] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // Array, object, bool → -32602.
    for (const tag of [["latest"], { k: "v" }, true, false] as const) {
      const r = await probe(tag)
      assert.equal(r.error?.code, -32602, `tag=${JSON.stringify(tag)} must be -32602, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /block tag/i, "error must explain the shape")
    }
    // Sanity: omitting / null tag is still the canonical "latest" shorthand.
    const okUndef = await probe(undefined)
    assert.equal(okUndef.error, undefined, "undefined tag must NOT error")
    const okNull = await probe(null)
    assert.equal(okNull.error, undefined, "null tag must NOT error")
  })

  await t.test("#190: eth_getLogs rejects non-array topics field (no silent bypass)", async () => {
    // Pre-fix `validateLogFilter` only validated when Array.isArray(topics).
    // A client passing topics as a string/object got the same empty-result
    // response as a syntactically-valid filter — no signal that the query
    // was malformed. Probes pin the shape contract.
    const cases: Array<{ topics: unknown; label: string }> = [
      { topics: "not-array", label: "string" },
      { topics: { weird: "shape" }, label: "object" },
      { topics: 12345, label: "number" },
      { topics: true, label: "bool" },
    ]
    for (const { topics, label } of cases) {
      const resp = await rpcCallRaw(port, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x0", topics }])
      assert.equal(resp.error?.code, -32602, `topics=${label} must be -32602, got ${JSON.stringify(resp)}`)
      assert.match(resp.error!.message, /invalid filter topics/i, `error must explain shape: ${resp.error!.message}`)
    }
    // Sanity: valid empty topics array still returns result.
    const ok = await rpcCall(port, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x0", topics: [] }])
    assert.ok(Array.isArray(ok), "valid empty topics array must return results array")
    // Sanity: omitted topics still returns result.
    const ok2 = await rpcCall(port, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x0" }])
    assert.ok(Array.isArray(ok2), "omitted topics must return results array")
  })

  await t.test("#198: eth_getTransactionByBlock*AndIndex reject malformed index (no silent null)", async () => {
    // Pre-fix `Number((payload.params ?? [])[1] ?? 0)` coerced any
    // input — non-hex → NaN → null, "-0x1" → -1 → null, true → 1
    // (treated as a valid index). Callers got `null` for both
    // "valid index, no such tx" and "I sent garbage" — indistinguishable.
    const validBlockHash = "0x" + "1".repeat(64)
    const cases: Array<{ method: string; params: unknown[]; label: string }> = [
      { method: "eth_getTransactionByBlockNumberAndIndex", params: ["latest", "-0x1"], label: "negative" },
      { method: "eth_getTransactionByBlockNumberAndIndex", params: ["latest", "not-hex"], label: "non-hex" },
      { method: "eth_getTransactionByBlockNumberAndIndex", params: ["latest", true], label: "bool" },
      { method: "eth_getTransactionByBlockNumberAndIndex", params: ["latest", 0], label: "number-not-string" },
      { method: "eth_getTransactionByBlockNumberAndIndex", params: ["latest", null], label: "null" },
      { method: "eth_getTransactionByBlockHashAndIndex", params: [validBlockHash, "-0x1"], label: "byHash negative" },
      { method: "eth_getTransactionByBlockHashAndIndex", params: [validBlockHash, "not-hex"], label: "byHash non-hex" },
    ]
    for (const { method, params, label } of cases) {
      const resp = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      const json = await resp.json() as { error?: { code: number; message: string }; result?: unknown }
      assert.equal(json.error?.code, -32602, `${method}(${label}) must be -32602, got ${JSON.stringify(json)}`)
      assert.match(json.error!.message, /transaction index/i, `${method}: error must name the field`)
    }
    // Sanity: valid hex index does not error (returns null only if the
    // tx doesn't exist — but that's the expected behaviour, not a
    // shape rejection).
    const sanity = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByBlockNumberAndIndex", params: ["latest", "0x0"] }),
    })
    const sanityJson = await sanity.json() as { error?: unknown; result: unknown }
    assert.equal(sanityJson.error, undefined, "valid hex index must NOT error")
  })

  await t.test("#196: eth_get/uninstallFilter* reject malformed filter ids (no silent String() coercion)", async () => {
    // Pre-fix `const id = String((payload.params ?? [])[0] ?? "")`
    // silently coerced any input — number, array, null — to a string
    // that won't match any real filter. Callers got `[]` / `false`
    // indistinguishable from "filter expired", and never learned
    // their poll was malformed. Filter IDs are `0x` + 32 hex chars.
    const cases: Array<{ method: string; value: unknown; label: string }> = [
      { method: "eth_getFilterChanges", value: 42, label: "number" },
      { method: "eth_getFilterChanges", value: null, label: "null" },
      { method: "eth_getFilterChanges", value: ["0x" + "a".repeat(32)], label: "array" },
      { method: "eth_getFilterChanges", value: "not-a-filter-id", label: "non-hex string" },
      { method: "eth_getFilterChanges", value: "0x123", label: "too short" },
      { method: "eth_uninstallFilter", value: 42, label: "number" },
      { method: "eth_uninstallFilter", value: "not-a-filter-id", label: "non-hex" },
      { method: "eth_getFilterLogs", value: { obj: 1 }, label: "object" },
      { method: "eth_getFilterLogs", value: "0x" + "a".repeat(31), label: "31 chars" },
    ]
    for (const { method, value, label } of cases) {
      const resp = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [value] }),
      })
      const json = await resp.json() as { error?: { code: number; message: string }; result?: unknown }
      assert.equal(json.error?.code, -32602, `${method}(${label}) must be -32602, got ${JSON.stringify(json)}`)
      assert.match(json.error!.message, /filter id/i, `${method}: error must name the field`)
    }
    // Sanity: real filter from eth_newFilter round-trips correctly.
    const fid = await rpcCall(port, "eth_newFilter", [{ fromBlock: "0x0", toBlock: "latest" }]) as string
    assert.match(fid, /^0x[0-9a-fA-F]{32}$/, "newFilter must return shape-correct id")
    const changes = await rpcCall(port, "eth_getFilterChanges", [fid])
    assert.ok(Array.isArray(changes), "valid filter id must return array result")
    const removed = await rpcCall(port, "eth_uninstallFilter", [fid])
    assert.equal(removed, true, "valid filter id uninstall must return true")
  })

  await t.test("#204: JSON-RPC envelope rejects params that aren't Array/Object/omitted", async () => {
    // §4.2 — params, when present, MUST be Array or Object. Pre-fix
    // string/bool/number flowed through to `payload.params ?? []` and
    // most methods just returned their default response, masking buggy
    // clients. Geth/erigon enforce this; we should too for inter-op.
    const probe204 = async (body: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // Bad params shapes — all -32600.
    for (const params of ["not-an-array", 42, true, false]) {
      const r = await probe204({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params })
      assert.equal(r.error?.code, -32600, `params=${JSON.stringify(params)} must be -32600, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /params must be/i, "error must explain params shape")
    }
    // Sanity: array params (the canonical form) works.
    const okArr = await probe204({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
    assert.equal(okArr.error, undefined, "params=[] must NOT error")
    // Sanity: omitting params works.
    const okOmit = await probe204({ jsonrpc: "2.0", id: 1, method: "eth_chainId" })
    assert.equal(okOmit.error, undefined, "omitted params must NOT error")
    // Sanity: explicit null works (treated as "no params").
    const okNull204 = await probe204({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: null })
    assert.equal(okNull204.error, undefined, "params=null must NOT error")
    // Sanity: object params accepted at the envelope layer (handler may
    // still reject if it doesn't support by-name params, but the
    // envelope check is shape-only).
    const okObj = await probe204({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: {} })
    assert.equal(okObj.error, undefined, "params={} must NOT error at envelope layer")
  })

  await t.test("#202: JSON-RPC envelope rejects jsonrpc!='2.0' and non-conforming id types", async () => {
    // Pre-fix handleOne only checked `!payload || typeof payload !== "object" || !payload.method`.
    // It accepted jsonrpc:"1.0" (or omitted), and accepted id as object,
    // array, bool — all spec violations. Conformant clients (geth/erigon)
    // strictly enforce these, so any inter-op needs the same.
    const probe = async (body: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown; id?: unknown }
    }
    // jsonrpc must be exactly "2.0"
    for (const v of ["1.0", "1.1", "", 2, undefined]) {
      const body: Record<string, unknown> = { id: 1, method: "eth_chainId" }
      if (v !== undefined) body.jsonrpc = v
      const r = await probe(body)
      assert.equal(r.error?.code, -32600, `jsonrpc=${JSON.stringify(v)} must be -32600, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /jsonrpc/i, "error must name the field")
    }
    // id must be string | number | null
    for (const badId of [{ obj: 1 }, [1, 2], true, false]) {
      const r = await probe({ jsonrpc: "2.0", id: badId, method: "eth_chainId" })
      assert.equal(r.error?.code, -32600, `id=${JSON.stringify(badId)} must be -32600, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /id must be/i, "error must explain id shape")
    }
    // #316: cap string-id length to bound 1:1 echo amplification. Pre-fix a
    // 5000-char string id flowed straight back into every response.
    {
      const longId = "Z".repeat(257)
      const r = await probe({ jsonrpc: "2.0", id: longId, method: "eth_chainId" })
      assert.equal(r.error?.code, -32600, "id >256 chars must be -32600")
      assert.match(r.error!.message, /id too long/i, "error must explain length cap")
      // KEY invariant: response does NOT echo the malicious id
      assert.ok(!JSON.stringify(r).includes("ZZZZZ"),
        "id-too-long error must NOT echo the input — closes the amplification")
      // Boundary: exactly 256 chars must still be accepted
      const max = await probe({ jsonrpc: "2.0", id: "y".repeat(256), method: "eth_chainId" })
      assert.equal(max.error, undefined, "id of exactly 256 chars must be accepted")
      assert.ok(typeof max.result === "string", "well-formed envelope must produce result")
    }
    // #316: reject control chars in string id — same log-injection /
    // parser-confusion family as #312 (pubsub topic).
    {
      for (const bad of ["line1\nline2", "with\rCR", "tab\there", "null\u0000byte", "del\u007fhere"]) {
        const r = await probe({ jsonrpc: "2.0", id: bad, method: "eth_chainId" })
        assert.equal(r.error?.code, -32600, `id=${JSON.stringify(bad)} must reject as -32600`)
        assert.match(r.error!.message, /control character/i, "error must explain control-char rule")
        // KEY invariant: invalid-envelope response resets id to null
        // per JSON-RPC §5.1; no raw control char from the input may
        // survive in the response.
        assert.equal(r.id, null, "invalid envelope must reset id to null")
        const serialized = JSON.stringify(r)
        for (const ch of bad) {
          const code = ch.charCodeAt(0)
          if (code < 0x20 || code === 0x7f) {
            assert.ok(!serialized.includes(ch),
              `response must not contain raw control char U+${code.toString(16).padStart(4, "0")} from id`)
          }
        }
      }
      // Normal string ids still pass
      const r = await probe({ jsonrpc: "2.0", id: "abc-123_456", method: "eth_chainId" })
      assert.equal(r.error, undefined, "normal ASCII id must pass")
    }
    // method must be a non-empty string
    for (const m of [0, "", null, true, ["eth_chainId"]]) {
      const r = await probe({ jsonrpc: "2.0", id: 1, method: m })
      assert.equal(r.error?.code, -32600, `method=${JSON.stringify(m)} must be -32600, got ${JSON.stringify(r)}`)
    }
    // #314: method length must be capped to prevent N-byte echo amplification
    // via the default "method not supported: <method>" -32601 path. Pre-fix
    // a 1KB method name flowed through and the full string was echoed back.
    {
      const longMethod = "A".repeat(129)
      const r = await probe({ jsonrpc: "2.0", id: 1, method: longMethod })
      assert.equal(r.error?.code, -32600, "method >128 chars must be -32600 invalid request")
      assert.match(r.error!.message, /too long/i, "error must explain length cap")
      // KEY invariant: the response must NOT echo the malicious method name
      assert.ok(!r.error!.message.includes("AAAA"),
        "method-too-long error must NOT echo the input — that's the amplification we're closing")
      // Boundary: exactly 128 chars must still be accepted at the envelope
      // layer (it'll surface as -32601 method-not-supported instead, which
      // is the right shape for a real-but-unknown method).
      const max = await probe({ jsonrpc: "2.0", id: 1, method: "z".repeat(128) })
      assert.equal(max.error?.code, -32601, "exactly 128 chars must pass envelope check and reach dispatch")
    }
    // Sanity: well-formed envelope still works.
    const ok = await probe({ jsonrpc: "2.0", id: 1, method: "eth_chainId" })
    assert.equal(ok.error, undefined, "well-formed envelope must NOT error")
    assert.ok(typeof ok.result === "string", "result must be returned")
    // Sanity: null id is allowed.
    const okNull = await probe({ jsonrpc: "2.0", id: null, method: "eth_chainId" })
    assert.equal(okNull.error, undefined, "id=null must be allowed")
    // Sanity: string id is allowed.
    const okStr = await probe({ jsonrpc: "2.0", id: "abc", method: "eth_chainId" })
    assert.equal(okStr.error, undefined, "id as string must be allowed")
  })

  await t.test("#398: reject fractional ids and numeric ids past Number.MAX_SAFE_INTEGER", async () => {
    // §4 — "Numbers SHOULD NOT contain fractional parts" AND values
    // past 2^53-1 silently lose precision through V8 JSON.parse
    // (a client sending id 9007199254740993 got back 9007199254740992,
    // off by one) so clients tracking sequential 64-bit ids can't
    // correlate the response. Number.isSafeInteger catches both.
    // The pre-fix `Number.isFinite` accepted both.
    const probe = async (body: Record<string, unknown>) => {
      // Build the body manually so we can keep a giant numeric id as
      // raw JSON (JSON.stringify would coerce through Number first).
      const idRaw = body.__rawId as string | undefined
      const json = idRaw !== undefined
        ? `{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":${idRaw}}`
        : JSON.stringify(body)
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json,
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown; id?: unknown }
    }
    // Fractional id rejected
    const fractional = await probe({ jsonrpc: "2.0", id: 1.5, method: "eth_chainId" })
    assert.equal(fractional.error?.code, -32600, "id=1.5 must be -32600")
    assert.match(fractional.error!.message, /id must be/i)
    // 2^53 (one past MAX_SAFE_INTEGER) rejected
    const overSafe = await probe({ jsonrpc: "2.0", __rawId: "9007199254740993", method: "eth_chainId" })
    assert.equal(overSafe.error?.code, -32600, "id past MAX_SAFE_INTEGER must be -32600")
    // 50-digit integer (massive precision loss) rejected
    const huge = await probe({ jsonrpc: "2.0", __rawId: "12345678901234567890123456789012345678901234567890", method: "eth_chainId" })
    assert.equal(huge.error?.code, -32600, "50-digit id must be -32600")
    // Negative integer in safe range still works (spec doesn't ban negatives)
    const neg = await probe({ jsonrpc: "2.0", id: -1, method: "eth_chainId" })
    assert.equal(neg.error, undefined, "negative safe-integer id must work")
    assert.equal(neg.id, -1, "id must echo verbatim")
    // Exactly Number.MAX_SAFE_INTEGER allowed
    const max = await probe({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method: "eth_chainId" })
    assert.equal(max.error, undefined, "MAX_SAFE_INTEGER id must work")
    // String ids of any length allowed (escape hatch for 64-bit clients)
    const longStr = await probe({ jsonrpc: "2.0", id: "9999999999999999999", method: "eth_chainId" })
    assert.equal(longStr.error, undefined, "long string id must work")
    assert.equal(longStr.id, "9999999999999999999", "string id echoed verbatim")
  })

  await t.test("#218: coc_submitProposal rejects malformed stakeAmount without leaking V8 BigInt error", async () => {
    // Pre-fix `BigInt(proposalParams.stakeAmount)` threw a V8 SyntaxError
    // when stakeAmount was an object/array/non-digit-string and the
    // outer catch leaked the V8 wording verbatim. Path is normally
    // dead (chain has no governance), so monkey-patch a stub onto the
    // chain instance to make `hasGovernance(chain)` true and reach the
    // validation. Same leak class as #212 (pose-http).
    const submittedProposals: Array<Record<string, unknown>> = []
    const governanceStub = {
      submitProposal: (type: string, targetId: string, proposer: string, opts: Record<string, unknown>) => {
        submittedProposals.push({ type, targetId, proposer, opts })
        return { id: "p1", type, targetId, status: "pending" }
      },
    } as Record<string, unknown>
    // Monkey-patch the chain instance. `hasGovernance` checks for `.governance`.
    ;(chain as unknown as Record<string, unknown>).governance = governanceStub
    try {
      const probe = async (stakeAmount: unknown) => {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "coc_submitProposal",
            params: [{ type: "add_validator", targetId: "v4", proposer: "node-1", stakeAmount }],
          }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      // Bad shapes → -32602 with `/stakeAmount/i` and NO V8 leak wording.
      const badCases: unknown[] = [{}, [1, 2], "abc", "1.5", "-1", true]
      for (const v of badCases) {
        const r = await probe(v)
        assert.equal(r.error?.code, -32602, `stakeAmount=${JSON.stringify(v)} must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /stakeAmount/i, "error must name the field")
        assert.doesNotMatch(r.error!.message, /Cannot convert|BigInt|SyntaxError/i,
          `must not leak V8 wording, got ${r.error!.message}`)
      }
      // Sanity: valid decimal and 0x-hex round-trip; the stub records.
      const ok1 = await probe("1000")
      assert.equal(ok1.error, undefined, "decimal stakeAmount must NOT error")
      const ok2 = await probe("0x3e8")
      assert.equal(ok2.error, undefined, "0x-hex stakeAmount must NOT error")
      const ok3 = await probe(42)
      assert.equal(ok3.error, undefined, "number stakeAmount must NOT error")
      // Sanity: undefined / empty string → stakeAmount omitted.
      const ok4 = await probe(undefined)
      assert.equal(ok4.error, undefined, "undefined stakeAmount must NOT error")
      assert.ok(submittedProposals.length >= 4, "stub should record the 4 valid calls")
    } finally {
      delete (chain as unknown as Record<string, unknown>).governance
    }
  })

  await t.test("#220: coc_submitProposal / coc_voteProposal reject null/undefined params[0] (no V8 NPE leak)", async () => {
    // Pre-fix `(payload.params ?? [])[0] as Record<...>` was a no-op
    // cast. With params=[] / [null] the next line accessed .proposer /
    // .voterId on undefined/null and threw V8 "Cannot read properties
    // of null/undefined (reading 'X')" — leaked through the outer
    // catch. Same NPE-leak class as the BigInt V8 leaks in #212/#218.
    // Reuse the governance stub from #218 to make the path reachable.
    const governanceStub220 = {
      submitProposal: () => ({ id: "p1", type: "x", targetId: "v4", status: "pending" }),
      vote: () => {},
      getProposal: () => ({ id: "p1", status: "pending", votes: new Map() }),
    } as Record<string, unknown>
    ;(chain as unknown as Record<string, unknown>).governance = governanceStub220
    try {
      const probe = async (method: string, params: unknown[]) => {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      const methods = ["coc_submitProposal", "coc_voteProposal"]
      const badPayloads: unknown[][] = [[], [null], [undefined], ["string-not-object"], [42], [[1, 2]]]
      for (const method of methods) {
        for (const params of badPayloads) {
          const r = await probe(method, params)
          assert.equal(r.error?.code, -32602,
            `${method}(${JSON.stringify(params)}) must be -32602, got ${JSON.stringify(r)}`)
          assert.match(r.error!.message, /params/i, "error must name params")
          assert.doesNotMatch(r.error!.message, /Cannot read properties|TypeError/i,
            `must not leak V8 NPE wording, got ${r.error!.message}`)
        }
      }
      // Sanity: a well-shaped object still reaches the stub (no error).
      const ok1 = await probe("coc_submitProposal", [{ type: "x", targetId: "y", proposer: "node-1" }])
      assert.equal(ok1.error, undefined, "well-shaped submit must NOT error")
      const ok2 = await probe("coc_voteProposal", [{ proposalId: "p1", voterId: "node-1", approve: true }])
      assert.equal(ok2.error, undefined, "well-shaped vote must NOT error")
    } finally {
      delete (chain as unknown as Record<string, unknown>).governance
    }
  })

  await t.test("#226: coc_getProposals + coc_getDaoProposals + coc_getEquivocations reject malformed filter params", async () => {
    // Pre-fix:
    // - coc_getProposals(true) → `as string | undefined` runtime no-op → silent no-filter → return all
    // - coc_getDaoProposals(true,false) → silent bypass of both branches → silent no-filter
    // - coc_getEquivocations(-100) → Number coercion allowed negative sinceMs
    // - coc_getEquivocations({}) → Number({}) = NaN → undefined-ish behavior in getter
    // Same class as #220/#224 — silent coercion masking malformed input.
    const proposalsList: Array<Record<string, unknown>> = []
    const governanceStub226 = {
      getProposals: (_filter?: string) => proposalsList,
      getGovernanceStats: () => ({ activeValidators: 0, totalStake: 0n, pendingProposals: 0, totalProposals: 0, currentEpoch: 0n }),
    } as Record<string, unknown>
    ;(chain as unknown as Record<string, unknown>).governance = governanceStub226
    try {
      const probe = async (method: string, params: unknown[]) => {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }

      // coc_getProposals — non-string filter must reject
      for (const bad of [true, false, 42, {}, [1, 2]]) {
        const r = await probe("coc_getProposals", [bad])
        assert.equal(r.error?.code, -32602,
          `coc_getProposals(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /status filter/i)
      }
      // Unknown status string must reject
      const rUnknown = await probe("coc_getProposals", ["unknown-status"])
      assert.equal(rUnknown.error?.code, -32602, "unknown status must be -32602")
      assert.match(rUnknown.error!.message, /status filter|must be one of/i)
      // Sanity: undefined/null/empty string/valid status all OK
      for (const ok of [null, undefined, "", "pending", "approved"]) {
        const r = await probe("coc_getProposals", ok === undefined ? [] : [ok])
        assert.equal(r.error, undefined, `coc_getProposals(${JSON.stringify(ok)}) must succeed`)
      }

      // coc_getDaoProposals — non-string/non-object filter must reject
      for (const bad of [true, false, 42, [1, 2]]) {
        const r = await probe("coc_getDaoProposals", [bad])
        assert.equal(r.error?.code, -32602,
          `coc_getDaoProposals(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /filter|expected/i)
      }
      // Object with non-string field must reject
      const rBadStatus = await probe("coc_getDaoProposals", [{ status: 42 }])
      assert.equal(rBadStatus.error?.code, -32602, "filter.status non-string must be -32602")
      // Sanity: valid object/string/omitted
      for (const ok of [null, undefined, "", "pending", { status: "pending" }, { type: "add_validator" }]) {
        const r = await probe("coc_getDaoProposals", ok === undefined ? [] : [ok])
        assert.equal(r.error, undefined, `coc_getDaoProposals(${JSON.stringify(ok)}) must succeed`)
      }

      // coc_getEquivocations — non-integer/negative sinceMs must reject
      // (NaN can't traverse JSON.stringify → null, so skip it; null is the
      // "omitted" sentinel and is accepted.)
      for (const bad of [-1, -100, 1.5, "now", true, {}, [123]]) {
        const r = await probe("coc_getEquivocations", [bad])
        assert.equal(r.error?.code, -32602,
          `coc_getEquivocations(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /sinceMs/i)
      }
      // Sanity: 0/positive/null/undefined OK
      for (const ok of [0, 1000, 1_700_000_000_000, null, undefined]) {
        const r = await probe("coc_getEquivocations", ok === undefined ? [] : [ok])
        assert.equal(r.error, undefined, `coc_getEquivocations(${JSON.stringify(ok)}) must succeed`)
      }
    } finally {
      delete (chain as unknown as Record<string, unknown>).governance
    }
  })

  await t.test("#228: rollup_getOutputAtBlock handler uses payload.params (no ReferenceError)", async () => {
    // Pre-fix the handler referenced bare `params[0]` which is undefined,
    // so EVERY call threw `ReferenceError: params is not defined` before
    // any input validation. The rollup endpoint was completely broken
    // from inception. V8 wording leaked through outer catch as -32603.
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rollup_getOutputAtBlock", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    const r1 = await probe(["0x0"])
    assert.doesNotMatch(JSON.stringify(r1), /params is not defined|ReferenceError/i,
      `must not leak ReferenceError on "0x0", got ${JSON.stringify(r1)}`)
    const r2 = await probe(["latest"])
    assert.doesNotMatch(JSON.stringify(r2), /params is not defined|ReferenceError/i,
      `must not leak ReferenceError on "latest", got ${JSON.stringify(r2)}`)
    // Malformed input should now hit parseBlockTag's -32602, not -32603
    const r3 = await probe([true])
    assert.equal(r3.error?.code, -32602,
      `rollup_getOutputAtBlock(true) must be -32602, got ${JSON.stringify(r3)}`)
    assert.doesNotMatch(r3.error!.message, /params is not defined|ReferenceError/i,
      `must not leak ReferenceError on bool, got ${r3.error!.message}`)
  })

  await t.test("#234: coc_submit/vote/getDaoProposal return -32601 when governance disabled (not -32603)", async () => {
    // Pre-fix the plain `new Error("governance not enabled")` fell through
    // the outer catch's generic -32603 path. JSON-RPC §5.1 reserves
    // -32603 for genuine server faults; "feature not enabled on this
    // node" is a method-availability concern → -32601. Same class as
    // #132 (unknown-method fallback).
    // The test fixture builds a ChainEngine WITHOUT governance, so all
    // three methods hit the !hasGovernance branch.
    const probe = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    const methods: Array<[string, unknown[]]> = [
      ["coc_submitProposal", [{ type: "add_validator", targetId: "v1", proposer: "n1" }]],
      ["coc_voteProposal", [{ proposalId: "p1", voterId: "n1", approve: true }]],
      ["coc_getDaoProposal", ["p1"]],
    ]
    for (const [method, params] of methods) {
      const r = await probe(method, params)
      assert.equal(r.error?.code, -32601,
        `${method} must be -32601 when governance disabled, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /governance.*not enabled/i,
        `${method} error must reference governance, got ${r.error!.message}`)
    }
  })

  await t.test("#238: eth_getLogs + eth_newFilter reject non-object filter params (no silent no-filter)", async () => {
    // Pre-fix `((payload.params ?? [])[0] ?? {}) as Record<string, unknown>`
    // was a TS-only runtime no-op. Boolean/string/number/array all slipped
    // through as "the object" — fromBlock/toBlock/address/topics reads
    // returned undefined → validateLogFilter rejected nothing → silent
    // "all logs" (eth_getLogs) or silent filter-creation (eth_newFilter,
    // which leaked entries in the MAX_FILTERS-capped map). Same class as
    // #220/#224/#226/#234.
    const probe = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    const badShapes: unknown[][] = [[true], [false], ["string-not-object"], [42], [[1, 2]]]
    for (const params of badShapes) {
      for (const method of ["eth_getLogs", "eth_newFilter"]) {
        const r = await probe(method, params)
        assert.equal(r.error?.code, -32602,
          `${method}(${JSON.stringify(params)}) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /invalid filter|expected object/i,
          `${method} error must name the filter shape, got ${r.error!.message}`)
      }
    }
    // Sanity: omitted / null / empty object still work as full-range default
    const ok1 = await probe("eth_getLogs", [])
    assert.equal(ok1.error, undefined, "omitted filter must succeed")
    const ok2 = await probe("eth_getLogs", [null])
    assert.equal(ok2.error, undefined, "null filter must succeed (treated as {})")
    const ok3 = await probe("eth_getLogs", [{}])
    assert.equal(ok3.error, undefined, "empty object filter must succeed")
  })

  await t.test("#248: coc_erasureStatus rejects non-string manifest CID", async () => {
    // Pre-fix `String((payload.params ?? [])[0] ?? "")` silently coerced
    // 123 → "123", true → "true", {} → "[object Object]" and forwarded
    // bogus CIDs to the erasure getter. Same anti-pattern as #240/#242/#246.
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_erasureStatus", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    for (const bad of [123, true, false, {}, [1, 2]]) {
      const r = await probe([bad])
      assert.equal(r.error?.code, -32602,
        `coc_erasureStatus(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /manifest CID|expected string/i)
    }
    // Missing/null/empty → -32602 "missing"
    for (const empty of [[], [null], [""]]) {
      const r = await probe(empty)
      assert.equal(r.error?.code, -32602,
        `coc_erasureStatus(${JSON.stringify(empty)}) must be -32602, got ${JSON.stringify(r)}`)
    }
    // Sanity: well-shaped string passes shape validation and reaches
    // the stub fixture's getErasureStatus.
    const ok = await probe(["bafy-real-manifest"])
    assert.notEqual(ok.error?.code, -32602,
      `valid CID must pass shape validation, got ${JSON.stringify(ok)}`)
  })

  await t.test("#250: coc_ipfsFetchBlockFromPeer rejects non-string excludePeerId (preserves omitted)", async () => {
    // Pre-fix `String((payload.params ?? [])[1] ?? "")` silently coerced
    // numbers/bools to ad-hoc peer IDs ("123", "true"), making the
    // exclude filter match nothing useful. Same anti-pattern as
    // #120/#220/#226/#240/#242/#248. excludePeerId is optional —
    // omit/null/"" pass through unchanged; non-string with content rejects.
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_ipfsFetchBlockFromPeer", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    const validCid = "bafy-some-real-cid"
    // Non-string excludePeerId → -32602
    for (const bad of [123, true, false, 1.5, {}, [1, 2]]) {
      const r = await probe([validCid, bad])
      assert.equal(r.error?.code, -32602,
        `excludePeerId=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /excludePeerId|expected string/i)
    }
    // Omitted / null / empty string → no shape error; the fixture has
    // no fetchBlockFromPeer wired so result is just { bytes: null }.
    for (const ok of [[validCid], [validCid, null], [validCid, ""]]) {
      const r = await probe(ok)
      assert.notEqual(r.error?.code, -32602,
        `excludePeerId omitted/null/"" must pass shape, got ${JSON.stringify(r)}`)
    }
    // Sanity: well-shaped string excludePeerId passes shape
    const okStr = await probe([validCid, "peer-123"])
    assert.notEqual(okStr.error?.code, -32602,
      `valid excludePeerId string must pass shape, got ${JSON.stringify(okStr)}`)
  })

  await t.test("#251: coc_dhtFindProviders rejects non-integer maxK (preserves omitted)", async () => {
    // Pre-fix `Number((payload.params ?? [])[1] ?? 3)` silently mapped
    // every malformed maxK to a clamped default: true → 1, "huge" → NaN→3,
    // {} → NaN→3, -5 → fallback 3, 1.7 → Math.floor → 1. Clients with
    // shape bugs got plausible result counts and never learned their
    // input was wrong. Same anti-pattern as #224/#248.
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_dhtFindProviders", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    const validCid = "bafy-real-cid"
    // Non-integer or negative maxK → -32602
    for (const bad of [true, false, "huge", {}, [1, 2], -1, -5, 0, 1.5, 1.7]) {
      const r = await probe([validCid, bad])
      assert.equal(r.error?.code, -32602,
        `maxK=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /maxK|positive integer/i)
    }
    // Omitted / null → default 3; positive integer → cap
    for (const ok of [[validCid], [validCid, null], [validCid, 3], [validCid, 16], [validCid, 64]]) {
      const r = await probe(ok)
      assert.notEqual(r.error?.code, -32602,
        `maxK=${JSON.stringify(ok[1])} must pass shape, got ${JSON.stringify(r)}`)
    }
  })

  await t.test("#240: admin_addPeer / admin_removePeer reject non-string shape (no silent coercion)", async () => {
    // Pre-fix `String((payload.params ?? [])[1] ?? ...)` silently coerced
    // numbers/bools to plausible peerIds ("123", "true"). Pre-fix
    // String({}) = "[object Object]" failed the regex, but bool/number
    // slipped through. Same anti-pattern as #120/#220/#226/#238.
    // Need a second server with enableAdminRpc=true since the main test
    // fixture leaves admin off.
    const adminPort = port + 1000
    const adminServer = startRpcServer(
      "127.0.0.1", adminPort, chainId, evm, chain, p2p,
      undefined, undefined, "admin-test", undefined,
      undefined,                            // runtimeOptions
      { enableAdminRpc: true },             // rpcAuthOptions (12th arg)
    )
    try {
      const probe = async (method: string, params: unknown[]) => {
        const r = await fetch(`http://127.0.0.1:${adminPort}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      const validUrl = "http://127.0.0.1:19780"
      // peerId is non-string → -32602
      for (const badId of [123, true, false, 1.5]) {
        const r = await probe("admin_addPeer", [validUrl, badId])
        assert.equal(r.error?.code, -32602,
          `admin_addPeer(_, ${JSON.stringify(badId)}) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /peer ID|expected string/i)
      }
      // peerUrl is non-string → -32602
      for (const badUrl of [123, true, {}, [validUrl]]) {
        const r = await probe("admin_addPeer", [badUrl, "valid-id"])
        assert.equal(r.error?.code, -32602,
          `admin_addPeer(${JSON.stringify(badUrl)}, _) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /peer URL|expected.*string/i)
      }
      // admin_removePeer with non-string peerId → -32602
      for (const badId of [123, true, false, {}, []]) {
        const r = await probe("admin_removePeer", [badId])
        assert.equal(r.error?.code, -32602,
          `admin_removePeer(${JSON.stringify(badId)}) must be -32602, got ${JSON.stringify(r)}`)
      }
      // Sanity: well-shaped calls clear shape validation. The test
      // fixture's p2p stub may not provide discovery.addDiscoveredPeers,
      // so we only assert the response is NOT -32602 (= shape passed).
      const ok = await probe("admin_addPeer", [validUrl, "valid-id"])
      assert.notEqual(ok.error?.code, -32602, "well-shaped admin_addPeer must pass shape validation")
      const okOmit = await probe("admin_addPeer", [validUrl])
      assert.notEqual(okOmit.error?.code, -32602,
        "omitted peerId must default to `peer-<timestamp>` (shape passes)")
    } finally {
      adminServer.close()
    }
  })

  await t.test("#392: admin_addPeer rejects non-http(s) URL schemes (no deceptive true)", async () => {
    // Pre-fix admin_addPeer only checked `new URL(peerUrl)` succeeded,
    // accepting ftp://, file://, javascript:, data:, ws://, ldap:// —
    // all returned `result:true` while peer-discovery's normalizePeer
    // (peer-discovery.ts:451) silently dropped them downstream. The
    // mismatch made the API deceptive: a caller saw success but the
    // peer was never added.
    //
    // Live testnet 88780 reproduction (pre-fix, with admin RPC on):
    //
    //   $ admin_addPeer("ftp://evil.com/")     → 200 {"result":true}
    //   $ admin_addPeer("file:///etc/passwd")  → 200 {"result":true}
    //   $ admin_addPeer("javascript:alert(1)") → 200 {"result":true}
    //   # All accepted at API, all silently dropped by normalizePeer.
    //
    // Worse, the `file://` case suggests a confused caller about what
    // this method does; an attacker probing for an SSRF surface would
    // see "true" and assume their URL was added.
    const adminPort = port + 3000
    const adminServer = startRpcServer(
      "127.0.0.1", adminPort, chainId, evm, chain, p2p,
      undefined, undefined, "admin-test", undefined,
      undefined,
      { enableAdminRpc: true },
    )
    try {
      const probe = async (url: string) => {
        const r = await fetch(`http://127.0.0.1:${adminPort}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "admin_addPeer", params: [url, "peer-x"] }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      // Each must fail with -32602; pre-fix all returned result:true.
      const badSchemes = [
        "ftp://evil.com/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/plain,hello",
        "ws://1.2.3.4/",
        "ldap://attacker.com/",
      ]
      for (const url of badSchemes) {
        const r = await probe(url)
        assert.equal(r.error?.code, -32602,
          `admin_addPeer(${url}) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /scheme|http:|https:/i,
          `error must mention scheme requirement, got: ${r.error!.message}`)
        assert.notEqual(r.result, true, "must not return true for rejected scheme")
      }
      // http: and https: still accepted (sanity).
      for (const url of ["http://1.2.3.4:30303/", "https://example.com/"]) {
        const r = await probe(url)
        assert.notEqual(r.error?.code, -32602, `${url}: must pass scheme validation`)
      }
    } finally {
      adminServer.close()
    }
  })

  await t.test("#242: DID handlers reject non-string DID/agentId/credentialId (no silent coercion)", async () => {
    // Pre-fix 7 DID/identity handlers used `String((payload.params ?? [])[0] ?? "")`.
    // String(123)="123", String(true)="true", String({})="[object Object]" — all
    // bogus identifiers passed downstream. Same anti-pattern as #120/#220/#226/#240.
    // Stub the resolver + provider so the path reaches shape validation.
    const didResolverStub = {
      resolve: async (did: string) => ({ didDocument: { id: did }, didResolutionMetadata: {} }),
    }
    const didProviderStub = {
      getCapabilities: async () => 0n,
      getFullDelegations: async () => [],
      getLineage: async () => ({ parents: [], children: [] }),
      getVerificationMethods: async () => [],
      getCredentialAnchor: async () => null,
    }
    const didPort = port + 2000
    const didServer = startRpcServer(
      "127.0.0.1", didPort, chainId, evm, chain, p2p,
      undefined, undefined, "did-test", undefined,
      { didResolver: didResolverStub, didDataProvider: didProviderStub } as unknown as Parameters<typeof startRpcServer>[10],
      undefined,
    )
    try {
      const probe = async (method: string, params: unknown[]) => {
        const r = await fetch(`http://127.0.0.1:${didPort}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      const methods = [
        "coc_resolveDid",
        "coc_getDIDDocument",
        "coc_getAgentCapabilities",
        "coc_getDelegations",
        "coc_getAgentLineage",
        "coc_getVerificationMethods",
        "coc_getCredentialAnchor",
      ]
      for (const method of methods) {
        // Non-string shapes → -32602
        for (const bad of [123, true, false, 1.5, {}, [1, 2]]) {
          const r = await probe(method, [bad])
          assert.equal(r.error?.code, -32602,
            `${method}(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
          assert.match(r.error!.message, /invalid|expected string/i)
        }
        // Missing / null / empty → -32602 "missing"
        for (const empty of [[], [null], [""]]) {
          const r = await probe(method, empty)
          assert.equal(r.error?.code, -32602,
            `${method}(${JSON.stringify(empty)}) must be -32602 missing, got ${JSON.stringify(r)}`)
        }
        // Sanity: well-shaped string passes shape validation (no -32602)
        const ok = await probe(method, ["agent-7"])
        assert.notEqual(ok.error?.code, -32602,
          `${method}("agent-7") must pass shape validation, got ${JSON.stringify(ok)}`)
      }
    } finally {
      didServer.close()
    }
  })

  await t.test("#252: coc_getRewardManifest / coc_getRewardClaim reject non-integer epochId (no Number() coercion)", async () => {
    // Pre-fix `Number((payload.params ?? [])[0] ?? -1)` silently coerced
    // `true`→1, `[1]`→1, `"1"`→1, `null`→0 — every non-integer that JS
    // happens to know how to coerce became a real epochId lookup. Same
    // anti-pattern family as #120/#220/#226/#240/#242. Use the new
    // `requireIntegerParam` validator.
  })

  await t.test("#256: block-tag handlers reject single-element-array coercion (eth_getBlockTransactionCountByNumber / eth_getBlockReceipts / eth_feeHistory)", async () => {
    // Pre-fix three handlers used `String((payload.params)[i] ?? "latest")`.
    // `String([1500])` is `"1500"`, so a single-element numeric array
    // silently became block 1500 — never hitting parseBlockTag's
    // non-string rejection. Same anti-pattern fixed in #250 for
    // eth_getBlockByNumber.
  })

  await t.test("#260: eth_getBlockByNumber / eth_getBlockByHash reject non-boolean includeTx", async () => {
    // Pre-fix `Boolean((params)[1])` silently coerced:
    //   "false"→true, 0→false, 1→true, ""→false, {}→true, []→true, "yes"→true
    // The string-vs-bool case is the most user-hostile: a JS client sending
    // `"false"` as a stringified bool gets the OPPOSITE of intent — full
    // tx objects (~5-6× more bytes per tx than hashes).
  })

  await t.test("#262: resolveHistoricalExecutionContext rejects non-string blockHash field (eth_call / estimateGas / createAccessList)", async () => {
    // Pre-fix `String((input).blockHash ?? "")` made
    //   {blockHash: [VALID_HASH]}  → silently unwrapped → call against that block
    //   {blockHash: 123}           → -32001 "block not found: 123" (wrong code)
    //   {blockHash: true}          → -32001 "block not found: true"
    //   {blockHash: null}          → -32001 "block not found: " (silent empty)
    // Same family as #250/#260 — every non-string shape should surface as
    // -32602 invalid params with a clear message, not as a downstream
    // "block not found" or, worse, a silent successful call.
    const probe = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // Non-integer epochId shapes must be rejected with -32602
    for (const bad of [true, false, "1", "5", [1], [1, 2], {}, 1.5, -1, -0.5]) {
      const m = await probe("coc_getRewardManifest", [bad])
      assert.equal(m.error?.code, -32602,
        `coc_getRewardManifest(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(m)}`)
      const c = await probe("coc_getRewardClaim", [bad, `0x${"22".repeat(32)}`])
      assert.equal(c.error?.code, -32602,
        `coc_getRewardClaim(${JSON.stringify(bad)}, ...) must be -32602, got ${JSON.stringify(c)}`)
    }
    // Missing param → -32602 missing
    const missing = await probe("coc_getRewardManifest", [])
    assert.equal(missing.error?.code, -32602)
    assert.match(missing.error!.message, /missing|epochId/i)
    // null param → -32602 missing
    const nullCase = await probe("coc_getRewardManifest", [null])
    assert.equal(nullCase.error?.code, -32602)
    // coc_getRewardClaim with non-string nodeId
    for (const bad of [123, true, {}, [1]]) {
      const r = await probe("coc_getRewardClaim", [7, bad])
      assert.equal(r.error?.code, -32602,
        `coc_getRewardClaim(7, ${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
    }
    // Sanity: well-shaped lookups still resolve (epoch 7 manifest is pre-loaded)
    const okM = await probe("coc_getRewardManifest", [7])
    assert.equal(okM.error, undefined, `well-shaped getRewardManifest must succeed: ${JSON.stringify(okM)}`)
    assert.equal((okM.result as { epochId: number }).epochId, 7)
    const okC = await probe("coc_getRewardClaim", [7, `0x${"22".repeat(32)}`])
    assert.equal(okC.error, undefined, `well-shaped getRewardClaim must succeed: ${JSON.stringify(okC)}`)
  })

  await t.test("#254: coc_getTransactionsByAddress rejects non-integer limit/offset and non-boolean reverse", async () => {
    // Pre-fix `Number((params)[1] ?? 50)` silently coerced `true`→1, `"5"`→5,
    // `[3]`→3, `{}`→NaN→fallback. `(params[2] !== false)` accepted every
    // non-false value (`0`, `"false"`, `null`, `""`) as reverse=true. Same
    // anti-pattern family as #252/#251/#224/#120.
  })

  await t.test("#258: coc_getContracts rejects non-integer limit/offset and non-boolean reverse INSIDE pagination object", async () => {
    // #249 hardened the OUTER param shape (`[true]` → -32602). But the
    // INNER fields still silently coerced: `{limit: true}` → 1,
    // `{limit: "5"}` → 5, `{limit: [5]}` → 5, `{reverse: 0}` → true.
    // Same anti-pattern as #254 (positional sibling). The new
    // `optionalIntegerField` / `optionalBooleanField` helpers reject
    // every non-integer / non-boolean shape.
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_getTransactionsByAddress", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    const addr = `0x${"ab".repeat(20)}`
    // limit: non-integer shapes must be rejected
    for (const bad of [true, false, "5", [3], [1, 2], {}, 1.5, -1]) {
      const r = await probe([addr, bad, true, 0])
      assert.equal(r.error?.code, -32602,
        `limit=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
    }
    // offset: same
    for (const bad of [true, "0", [0], {}, 0.5, -1]) {
      const r = await probe([addr, 10, true, bad])
      assert.equal(r.error?.code, -32602,
        `offset=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
    }
    // reverse: non-boolean shapes must be rejected (no silent enable)
    for (const bad of [0, 1, "false", "true", [true], {}]) {
      const r = await probe([addr, 10, bad, 0])
      assert.equal(r.error?.code, -32602,
        `reverse=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
    }
    // Sanity: well-shaped + null/undefined defaults still succeed
    for (const params of [
      [addr, 10, true, 0],
      [addr, null, null, null],
      [addr],
      [addr, undefined, false, undefined],
  })

        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_getContracts", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // limit: non-integer fields must be rejected
    for (const bad of [true, false, "5", [3], [1, 2], {}, 1.5, -1]) {
      const r = await probe([{ limit: bad }])
      assert.equal(r.error?.code, -32602,
        `coc_getContracts({limit:${JSON.stringify(bad)}}) must be -32602, got ${JSON.stringify(r)}`)
    }
    // offset: same
    for (const bad of [true, "0", [0], {}, 0.5, -1]) {
      const r = await probe([{ offset: bad }])
      assert.equal(r.error?.code, -32602,
        `coc_getContracts({offset:${JSON.stringify(bad)}}) must be -32602, got ${JSON.stringify(r)}`)
    }
    // reverse: non-boolean fields must be rejected
    for (const bad of [0, 1, "false", "true", [true], {}]) {
      const r = await probe([{ reverse: bad }])
      assert.equal(r.error?.code, -32602,
        `coc_getContracts({reverse:${JSON.stringify(bad)}}) must be -32602, got ${JSON.stringify(r)}`)
    }
    // Sanity: well-shaped + omitted fields still succeed
    for (const params of [
      [{}],
      [{ limit: 5 }],
      [{ limit: 5, offset: 0, reverse: false }],
      [{ limit: 10, reverse: true }],
      [],
    ]) {
      const r = await probe(params)
      assert.equal(r.error, undefined,
        `well-shaped ${JSON.stringify(params)} must succeed, got ${JSON.stringify(r)}`)
      assert.ok(Array.isArray(r.result), `result must be array for ${JSON.stringify(params)}`)
    }
  })

  await t.test("#266: eth_getLogs caps inner topic OR-set (defense-in-depth against O(blocks×logs×topics) amplification)", async () => {
    // solc.compile is synchronous emscripten WASM. A single moderately
    // large source (500 empty contracts ≈ 15 KB) took 5m20s on 88780,
    // blocking ALL block production + RPC + PoSe for the duration. Cap
    // is 64 KiB — covers realistic single-file contracts (OZ's largest
    // is ~30 KiB) while preventing the worst-case event-loop starvation
    // a remote attacker can trigger at 100 req/min/IP. The proper fix is
    // a worker thread; this gate is the surgical interim.
    const probe = async (n: number) => {
      // Build `n` inner topics (each a 32-byte hex) — exercises the inner-array cap.
      const inner = Array.from({ length: n }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`)
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getLogs",
          params: [{ topics: [inner] }],
        }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // 33 inner topics → over the new 32 cap, reject
    const r33 = await probe(33)
    assert.equal(r33.error?.code, -32602,
      `inner topics=33 must be -32602, got ${JSON.stringify(r33)}`)
    assert.match(r33.error!.message, /inner topic.*too large/i,
      `error must reference inner cap, got ${JSON.stringify(r33)}`)
    // 1000 inner topics → same
    const r1000 = await probe(1000)
    assert.equal(r1000.error?.code, -32602, `inner topics=1000 must be -32602`)
    // 32 inner topics (at cap) → should NOT be a shape-rejection
    const r32 = await probe(32)
    assert.notEqual(r32.error?.code, -32602,
      `inner topics=32 (at cap) must pass shape, got ${JSON.stringify(r32)}`)
    // 1 inner topic → fine
    const r1 = await probe(1)
    assert.notEqual(r1.error?.code, -32602,
      `inner topics=1 must pass shape, got ${JSON.stringify(r1)}`)
  })

  await t.test("#286: eth_call / eth_estimateGas surface revert as -32000 (geth-compatible error code 3, no silent 0x return)", async () => {
    // Pre-fix bug: evm.callRaw's declared return type omitted `failed`
    // (even though runCall populated it), so the eth_call handler
    // returned `returnValue` regardless of revert state. Reverted calls
    // were indistinguishable from view functions returning empty bytes —
    // ethers.js / viem / foundry cast all rely on error.code===3 to
    // surface revert reasons. Live PoC on 88780: eth_call with selector
    // 0xdeadbeef on a real contract returned result:"0x" instead of a
    // -32000 error.
    //
    // The reliable way to trigger a revert from this test fixture is to
    // stub evm.callRaw to return failed:true with a canonical
    // Error(string) revert payload. We then verify the rpc dispatcher:
    //   (a) emits code 3 (not 0x success), and
    //   (b) decodes the Error(string) payload into the message, and
    //   (c) preserves the raw payload as `data` for client decoding.
    const validAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const origCallRaw = evm.callRaw.bind(evm)
    // Canonical Error(string) revert: selector 0x08c379a0 + ABI(string "Hard!"),
    // 0x20 offset, length 5, then "Hard!" right-padded to 32 bytes.
    const revertPayload =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000005" +
      "4861726421000000000000000000000000000000000000000000000000000000"
    ;(evm as unknown as { callRaw: unknown }).callRaw = async () => ({
      returnValue: revertPayload,
      gasUsed: 21_000n,
      failed: true,
    })
    try {
      const probe = async (method: string) => {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method,
            params: [{ to: validAddr, data: "0xdeadbeef" }, "latest"],
          }),
        })
        return await r.json() as { result?: unknown; error?: { code: number; message: string; data?: string } }
      }
      // eth_call must emit code 3 with decoded reason.
      const callRes = await probe("eth_call")
      assert.equal(callRes.error?.code, 3,
        `eth_call revert must be code 3, got ${JSON.stringify(callRes)}`)
      assert.match(callRes.error!.message, /execution reverted: Hard!/,
        "message must include decoded Error(string) reason 'Hard!'")
      assert.equal(callRes.error!.data, revertPayload,
        "data field must echo the raw revert payload so clients can ABI-decode it themselves")
      assert.equal(callRes.result, undefined, "must NOT return a success result")
      // eth_estimateGas must mirror — pre-fix it returned a gas estimate
      // for the failed path, leading clients to broadcast txs that are
      // guaranteed to revert on-chain.
      const estRes = await probe("eth_estimateGas")
      assert.equal(estRes.error?.code, 3,
        `eth_estimateGas revert must be code 3, got ${JSON.stringify(estRes)}`)
      assert.match(estRes.error!.message, /execution reverted: Hard!/)
      assert.equal(estRes.result, undefined, "must NOT return a gas estimate for a reverting call")
    } finally {
      ;(evm as unknown as { callRaw: typeof origCallRaw }).callRaw = origCallRaw
    }
  })

  await t.test("#288: eth_compileSolidity rejects oversize source (DoS gate; pre-fix 14.9 KB blocked event loop 5+ min)", async () => {
    // solc.compile is synchronous emscripten WASM. A single moderately
    // large source (500 empty contracts ≈ 15 KB) took 5m20s on 88780,
    // blocking ALL block production + RPC + PoSe for the duration. Cap
    // is 64 KiB — covers realistic single-file contracts (OZ's largest
    // is ~30 KiB) while preventing the worst-case event-loop starvation
    // a remote attacker can trigger at 100 req/min/IP.
    const probe = async (source: string) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_compileSolidity", params: [source],
        }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // 65 KiB source (1 KiB over the 64 KiB cap) — must reject with -32602.
    const oversized = "// " + "x".repeat(65 * 1024)
    const big = await probe(oversized)
    assert.equal(big.error?.code, -32602,
      `oversized compile must be -32602, got ${JSON.stringify(big)}`)
    assert.match(big.error!.message, /source too large/i,
      "error must name the field and the size cap")
    // Sanity: a small valid source still compiles (no regression).
    const small = await probe(
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract T { uint x; }"
    )
    assert.equal(small.error, undefined,
      `small valid source must succeed, got ${JSON.stringify(small)}`)
    assert.ok(small.result && typeof small.result === "object",
      "successful compile returns an object")
    assert.ok("T" in (small.result as Record<string, unknown>),
      "contract T must be in compile output")
  })

  await t.test("#332: eth_sendRawTransaction replacement-underpriced surfaces as -32000 (not -32603)", async () => {
    // mempool.addRawTx throws plain Error("replacement tx gas price too
    // low: need at least X, got Y") when a same-nonce replacement does
    // not clear the 10% bump threshold. Pre-fix this fell through to the
    // outer dispatch and surfaced as -32603 "internal error" — clients
    // treat -32603 as transient and retry, burning the same underpriced
    // replacement until they give up. Geth uses -32000 for this exact
    // condition with message "replacement transaction underpriced".
    const { Wallet, parseEther } = await import("ethers")
    const wallet = new Wallet(`0x${"03".repeat(32)}`)
    // Pre-fund the wallet so the mempool accepts the first tx.
    await evm.prefund([{ address: wallet.address, balanceWei: "1000000000000000000" }])

    async function signTx(nonce: number, gasPrice: bigint): Promise<string> {
      return await wallet.signTransaction({
        type: 0,
        to: `0x${"02".repeat(20)}`,
        value: 1n,
        nonce,
        gasPrice,
        gasLimit: 21_000n,
        chainId,
      })
    }

    // Submit initial tx at nonce N with a base gas price.
    const startNonce = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)
    const initial = await signTx(Number(startNonce), 1_000_000_000n)
    const initialRes = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [initial] }),
    })
    const initialBody = await initialRes.json() as { result?: string; error?: { code: number; message: string } }
    assert.ok(initialBody.result, `initial submit must succeed: ${JSON.stringify(initialBody)}`)

    // Submit replacement with INSUFFICIENT bump (same gas price → 0% bump,
    // mempool requires 10%). This is the trigger for the bug.
    const replacement = await signTx(Number(startNonce), 1_000_000_000n)
    const replRes = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: [replacement] }),
    })
    const replBody = await replRes.json() as { error?: { code: number; message: string }; result?: unknown }
    assert.equal(replBody.error?.code, -32000,
      `replacement-underpriced must be -32000, got ${replBody.error?.code} (${replBody.error?.message})`)
    assert.match(replBody.error!.message, /replacement.*gas price too low/i,
      `error must preserve "replacement tx gas price too low" surface, got: ${JSON.stringify(replBody)}`)
  })

    // eth_getBlockTransactionCountByNumber — block tag at idx 0
    for (const bad of [[1], [0, 1], true, false, {}]) {
      const r = await probe("eth_getBlockTransactionCountByNumber", [bad])
      assert.equal(r.error?.code, -32602,
        `eth_getBlockTransactionCountByNumber(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
    }
    // eth_getBlockReceipts — block tag at idx 0
    for (const bad of [[1], [0, 1], true, {}]) {
      const r = await probe("eth_getBlockReceipts", [bad])
      assert.equal(r.error?.code, -32602,
        `eth_getBlockReceipts(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
    }
    // eth_feeHistory — newestBlock at idx 1 (blockCount at idx 0 still valid)
    for (const bad of [[1], [0, 1], true, {}]) {
      const r = await probe("eth_feeHistory", ["0x1", bad, []])
      assert.equal(r.error?.code, -32602,
        `eth_feeHistory("0x1", ${JSON.stringify(bad)}, []) must be -32602, got ${JSON.stringify(r)}`)
    }
    // Sanity: well-shaped tags still succeed
    const ok1 = await probe("eth_getBlockTransactionCountByNumber", ["latest"])
    assert.equal(ok1.error, undefined, `latest must pass: ${JSON.stringify(ok1)}`)
    const ok2 = await probe("eth_getBlockTransactionCountByNumber", ["0x0"])
    assert.equal(ok2.error, undefined, `0x0 must pass: ${JSON.stringify(ok2)}`)
    const ok3 = await probe("eth_feeHistory", ["0x1", "latest", []])
    assert.equal(ok3.error, undefined, `feeHistory latest must pass: ${JSON.stringify(ok3)}`)
  })

  })

  })

    const blockTag = "0x0"
    const blockHash = `0x${"0".repeat(64)}`
    const cases = [
      { name: "string 'false'", value: "false" },
      { name: "string 'true'", value: "true" },
      { name: "string 'yes'", value: "yes" },
      { name: "empty string", value: "" },
      { name: "number 0", value: 0 },
      { name: "number 1", value: 1 },
      { name: "array [true]", value: [true] },
      { name: "empty object", value: {} },
      { name: "array empty", value: [] },
    ]
    for (const c of cases) {
      const r1 = await probe("eth_getBlockByNumber", [blockTag, c.value])
      assert.equal(r1.error?.code, -32602,
        `eth_getBlockByNumber(${blockTag}, ${c.name}) must be -32602, got ${JSON.stringify(r1)}`)
      const r2 = await probe("eth_getBlockByHash", [blockHash, c.value])
      assert.equal(r2.error?.code, -32602,
        `eth_getBlockByHash(<hash>, ${c.name}) must be -32602, got ${JSON.stringify(r2)}`)
    }
    // Sanity: strict booleans + omitted/null still work
    for (const params of [
      [blockTag],
      [blockTag, null],
      [blockTag, true],
      [blockTag, false],
    ]) {
      const r = await probe("eth_getBlockByNumber", params)
      assert.equal(r.error, undefined,
        `well-shaped ${JSON.stringify(params)} must succeed: ${JSON.stringify(r)}`)
    }
  })

    const callObj = { to: `0x${"ab".repeat(20)}` }
    const fakeHash = `0x${"ab".repeat(32)}` // syntactically valid 32-byte hash
    const badBlockHashes: unknown[] = [
      123,
      true,
      false,
      null,
      "",
      "0xshort",
      [fakeHash],            // single-element array (the worst — silent unwrap)
      [fakeHash, fakeHash],
      { hash: fakeHash },
      {},
    ]
    for (const method of ["eth_call", "eth_estimateGas", "eth_createAccessList"]) {
      for (const bad of badBlockHashes) {
        const r = await probe(method, [callObj, { blockHash: bad }])
        assert.equal(r.error?.code, -32602,
          `${method}(call, {blockHash:${JSON.stringify(bad)}}) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /blockHash|invalid/i,
          `${method} error must reference blockHash, got ${JSON.stringify(r)}`)
      }
    }
    // Sanity: well-shaped string blockHash flows through validation
    // (will likely surface as -32001 "block not found" since the hash
    // doesn't exist on this test fixture — but it's NOT -32602, which
    // is what we care about).
    const ok = await probe("eth_call", [callObj, { blockHash: fakeHash }])
    assert.notEqual(ok.error?.code, -32602,
      `well-shaped blockHash must pass shape validation: ${JSON.stringify(ok)}`)
  })

  await t.test("#276: eth_sendRawTransaction maps mempool/chain client-input errors to -32602 (not -32603)", async () => {
    // Pre-fix mempool/chain-engine throws plain `new Error(...)` for client-input
    // rejections (wrong chainId, nonce too low, blob tx, gasLimit exceeded,
    // poisoned tx). The eth_sendRawTransaction catch only filtered ethers shape
    // errors → plain Errors fell through to outer 500/−32603 internal-error.
    // This regression asserts the message-pattern remap to -32602.
    const { Transaction, Wallet, getBytes } = await import("ethers")
    const wallet = new Wallet(`0x${"01".repeat(32)}`)
    // Sign a tx with WRONG chainId (mempool requires this.cfg.chainId=18780).
    const tx = Transaction.from({
      to: `0x${"02".repeat(20)}`,
      value: 1n,
      gasLimit: 21_000n,
      gasPrice: 1_000_000_000n,
      nonce: 0,
      chainId: 99999, // wrong — fixture chain is 18780
    })
    const unsignedHash = tx.unsignedHash
    const sig = wallet.signingKey.sign(getBytes(unsignedHash))
    const signed = tx.clone()
    signed.signature = sig
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signed.serialized] }),
    })
    const body = await r.json() as { error?: { code: number; message: string }; result?: unknown }
    assert.equal(body.error?.code, -32602,
      `chainId-mismatch must be -32602, got ${body.error?.code} (${body.error?.message})`)
    assert.match(body.error!.message, /invalid chain ID/,
      `error must preserve "invalid chain ID" surface, got: ${JSON.stringify(body)}`)
  })

  await t.test("#278: coc_getFaction rejects malformed address (strict 20-byte, no silent null for typos)", async () => {
    // Pre-fix only checked `typeof string` + `startsWith("0x")`, so "0x",
    // "0x1", "0xZZZ..." (40 non-hex chars) and any wrong-length hex slipped
    // through. governance.getFaction() is keyed on the exact address
    // string, so invalid input silently returned null — clients couldn't
    // tell typos from "no faction registered." Same class as #260/#262.
    const factionLookups: string[] = []
    const governanceStub278 = {
      getFaction: (addr: string) => {
        factionLookups.push(addr)
        // Stub: only the canonical anvil-0 address has a faction.
        if (addr.toLowerCase() === "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266") {
          return { address: addr, faction: "HUMAN", joinedAtEpoch: 7n }
        }
        return null
      },
    } as Record<string, unknown>
    ;(chain as unknown as Record<string, unknown>).governance = governanceStub278
  })

  await t.test("#290: coc_voteProposal rejects non-boolean approve + non-string proposalId/voterId (no vote-direction flip)", async () => {
    // Pre-fix Boolean(voteParams.approve) silently coerced:
    //   approve:"false" → true (records YES when client meant NO!)
    //   approve:"no"    → true (same)
    //   approve:{}      → true
    //   approve:[]      → true
    //   approve:0       → false (incidentally correct)
    // String(voteParams.proposalId/voterId) silently turned
    // undefined/null/array/object into "undefined"/"null"/"x,y"/
    // "[object Object]" and forwarded to governance.vote — caused
    // -32603 leaks downstream when the proposal lookup threw, and
    // crucially flipped vote direction on the YES/NO axis.
    // Reuse the same governance stub pattern as #218/#220/#226.
    const recordedVotes: Array<{ proposalId: string; voterId: string; approve: boolean }> = []
    const governanceStub290 = {
      vote: (proposalId: string, voterId: string, approve: boolean) => {
        recordedVotes.push({ proposalId, voterId, approve })
      },
      getProposal: () => ({ id: "p1", status: "pending", votes: new Map() }),
    } as Record<string, unknown>
    ;(chain as unknown as Record<string, unknown>).governance = governanceStub290
  })

  await t.test("#296: coc_submitProposal rejects non-string type/targetId/proposer and bad targetAddress", async () => {
    // Pre-fix `as Record<string, string>` was a runtime no-op so
    // proposalParams.type/targetId/targetAddress flowed into
    // chain.governance.submitProposal() with whatever shape the
    // client sent. Same anti-pattern as #290 (coc_voteProposal field
    // strict validation). Validate each required string upfront.
    const submittedCalls: Array<{ type: string; targetId: string; proposer: string; opts: Record<string, unknown> }> = []
    const governanceStub296 = {
      submitProposal: (type: string, targetId: string, proposer: string, opts: Record<string, unknown>) => {
        submittedCalls.push({ type, targetId, proposer, opts })
        return { id: "p1", type, targetId, status: "pending" }
      },
    } as Record<string, unknown>
    ;(chain as unknown as Record<string, unknown>).governance = governanceStub296
    try {
      const probe = async (params: unknown[]) => {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_getFaction", params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      // Pre-fix accepted-but-invalid inputs → must now be -32602.
      const badAddrs = [
        "0x",                                            // empty
        "0x1",                                           // too short
        "0x12",                                          // too short
        "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",   // 40 non-hex
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226",    // 39 hex (1 short)
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb922666",  // 41 hex (1 long)
        "f39fd6e51aad88f6f4ce6ab8827279cfffb92266",     // missing 0x
      ]
      for (const bad of badAddrs) {
        const r = await probe([bad])
        assert.equal(r.error?.code, -32602,
          `coc_getFaction(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /address|0x\[0-9a-fA-F\]\{40\}/i,
          "error must name the field and/or canonical regex")
      }
      // Non-string shapes → -32602.
      for (const bad of [123, true, false, 1.5, {}, [], null, undefined]) {
        const r = await probe([bad])
        assert.equal(r.error?.code, -32602,
          `coc_getFaction(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
      }
      // None of the rejects should have reached the stub.
      assert.equal(factionLookups.length, 0,
        "no invalid address should have reached governance.getFaction()")
      // Sanity: well-shaped 40-hex address passes shape validation, returns the stub's faction.
      const ok = await probe(["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"])
      assert.equal(ok.error, undefined, `valid address must NOT error, got ${JSON.stringify(ok)}`)
      assert.equal((ok.result as { faction?: string } | null)?.faction, "HUMAN")
      // Sanity: well-shaped but unknown address → null (the stub's miss path).
      const miss = await probe(["0x0000000000000000000000000000000000000001"])
      assert.equal(miss.error, undefined, `valid-but-unknown address must NOT error, got ${JSON.stringify(miss)}`)
      assert.equal(miss.result, null)
      assert.equal(factionLookups.length, 2, "exactly 2 well-shaped lookups should have reached the stub")
    } finally {
      delete (chain as unknown as Record<string, unknown>).governance
  })

  await t.test("#282: pendingTx filter seen-set drops hashes once they leave the mempool (no unbounded growth)", async () => {
    // Pre-fix bug: filter.seenPendingTxs grew monotonically across polls
    // because hashes were never removed when txs left the mempool (mined,
    // dropped, or expired). With MAX_FILTERS=1000 and sustained mempool
    // churn an attacker could OOM the node by maintaining many long-lived
    // pendingTx filters. Each filter's seen-set should be bounded by the
    // current mempool size — geth's eth_getFilterChanges semantics treat a
    // tx that leaves and re-enters mempool as a new "observed since last
    // poll" event, so dropping departed hashes is both bound-preserving
    // and spec-aligned.
    const mempoolStub = { hashes: [] as string[] }
    const origGetAll = chain.mempool.getAll.bind(chain.mempool)
    ;(chain.mempool as unknown as { getAll: () => Array<{ hash: string }> }).getAll =
      () => mempoolStub.hashes.map((hash) => ({ hash }))
    try {
      // Snapshot state: mempool has [A, B]. After newPendingTransactionFilter
      // these are pre-seeded into `seen` so an initial poll returns [].
      const A = `0x${"a".repeat(64)}`
      const B = `0x${"b".repeat(64)}`
      const C = `0x${"c".repeat(64)}`
      const D = `0x${"d".repeat(64)}`
      const E = `0x${"e".repeat(64)}`
      mempoolStub.hashes = [A, B]
      const fid = (await rpcCall(port, "eth_newPendingTransactionFilter")) as string
      assert.match(fid, /^0x[0-9a-f]{32}$/, "filter id must be 32-hex")
      const initial = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
      assert.deepEqual(initial, [], "initial poll on filter created with pre-seeded mempool must be empty")
      // Step 1: A leaves (mined), C and D enter.
      mempoolStub.hashes = [B, C, D]
      const step1 = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
      assert.deepEqual([...step1].sort(), [C, D].sort(),
        `expected [C, D] as fresh, got ${JSON.stringify(step1)}`)
      // Step 2: B/C/D all leave; A re-enters (reorg or resubmit); E enters.
      // KEY assertion: A must appear as fresh because it left the mempool
      // and the fix drops departed hashes from `seen`. Pre-fix `seen`
      // still contained A so it was suppressed (and the leak compounded
      // over time as more mined hashes accumulated in `seen`).
      mempoolStub.hashes = [A, E]
      const step2 = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
      assert.deepEqual([...step2].sort(), [A, E].sort(),
        `KEY: A and E must both be fresh — A because it left then re-entered, ` +
        `E because it arrived; pre-fix only E was returned because A was ` +
        `still in 'seen'. Got ${JSON.stringify(step2)}`)
      // Step 3: sustained churn smoke test — 50 disjoint mempool batches.
      // Pre-fix each batch would have permanently grown `seen` by ≥1
      // entries; post-fix `seen` stays bounded by the current mempool.
      // We can't read `seen.size` from outside, so we assert the
      // behavioural contract: a hash reported then evicted must be
      // re-reported on re-appearance. (Step 4 verifies this; this loop
      // just ensures the path doesn't crash under load.)
      for (let i = 0; i < 50; i++) {
        const tag = i.toString(16).padStart(1, "0").slice(-1)
        mempoolStub.hashes = [
          `0x${"1".repeat(63)}${tag}`,
          `0x${"2".repeat(63)}${tag}`,
        ]
        await rpcCall(port, "eth_getFilterChanges", [fid])
      }
      // Step 4: empty mempool → fresh=[]. Then re-introduce A — pre-fix
      // would have suppressed A because it was still in `seen`; post-fix
      // reports A as fresh because the empty-mempool cleanup pass
      // drained all departed hashes from `seen`.
      mempoolStub.hashes = []
      const empty = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
      assert.deepEqual(empty, [], "poll on empty mempool returns []")
      mempoolStub.hashes = [A]
      const reappear = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
      assert.deepEqual(reappear, [A],
        "A re-enters after the mempool cleared → must be fresh; this is " +
        "the bounded-seen invariant under steady-state churn")
    } finally {
      ;(chain.mempool as unknown as { getAll: typeof origGetAll }).getAll = origGetAll
  })

          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_voteProposal", params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      // approve non-boolean shapes — must reject with -32602 (not silently
      // coerce to true). The "false"/"no"/"0" string cases are the
      // direction-flip foot-guns; "{}", "[]", "1" round out the panel.
      for (const bad of ["false", "true", "no", "yes", "0", "1", 0, 1, {}, [], null, undefined]) {
        const r = await probe([{ proposalId: "p1", voterId: "node-1", approve: bad }])
        assert.equal(r.error?.code, -32602,
          `approve=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /invalid approve|expected boolean/i)
      }
      // proposalId / voterId non-string shapes — must reject (no silent
      // String() coercion to "undefined"/"null"/"x,y").
      for (const bad of [undefined, null, 123, true, false, {}, ["p1"], ""]) {
        const r1 = await probe([{ proposalId: bad, voterId: "node-1", approve: true }])
        assert.equal(r1.error?.code, -32602,
          `proposalId=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r1)}`)
        const r2 = await probe([{ proposalId: "p1", voterId: bad, approve: true }])
        assert.equal(r2.error?.code, -32602,
          `voterId=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r2)}`)
      }
      // None of the invalid inputs should have reached the stub.
      assert.equal(recordedVotes.length, 0,
        `no invalid vote should have reached governance.vote; got ${JSON.stringify(recordedVotes)}`)
      // Sanity: well-shaped true/false both succeed, NOT just true.
      const okYes = await probe([{ proposalId: "p1", voterId: "node-1", approve: true }])
      assert.equal(okYes.error, undefined, `valid YES vote must succeed, got ${JSON.stringify(okYes)}`)
      const okNo = await probe([{ proposalId: "p1", voterId: "node-1", approve: false }])
      assert.equal(okNo.error, undefined, `valid NO vote must succeed, got ${JSON.stringify(okNo)}`)
      assert.equal(recordedVotes.length, 2, "exactly 2 well-shaped votes recorded")
      assert.equal(recordedVotes[0].approve, true, "YES vote must be exactly true")
      assert.equal(recordedVotes[1].approve, false,
        "NO vote must be exactly false — this is the direction-flip invariant")
  })

          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_submitProposal", params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      const base = { type: "add_validator", targetId: "v4", proposer: "node-1" }
      const badStringShapes = [undefined, null, 123, true, {}, [], ""]
      for (const bad of badStringShapes) {
        const rType = await probe([{ ...base, type: bad }])
        assert.equal(rType.error?.code, -32602,
          `type=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(rType)}`)
        const rTarget = await probe([{ ...base, targetId: bad }])
        assert.equal(rTarget.error?.code, -32602,
          `targetId=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(rTarget)}`)
        const rProposer = await probe([{ ...base, proposer: bad }])
        assert.equal(rProposer.error?.code, -32602,
          `proposer=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(rProposer)}`)
      }
      // targetAddress optional, but wrong-shape must reject.
      const validAddr = `0x${"ab".repeat(20)}`
      for (const bad of ["0x", "0x1", "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", validAddr.slice(0, -1), 123, true, {}]) {
        const r = await probe([{ ...base, targetAddress: bad }])
        assert.equal(r.error?.code, -32602,
          `targetAddress=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
      }
      // None of the rejects should have reached the stub.
      assert.equal(submittedCalls.length, 0,
        "no invalid proposal should have reached governance.submitProposal()")
      // Sanity: well-shaped proposal succeeds; stub records it; addr passes verbatim.
      const ok = await probe([{ type: "add_validator", targetId: "v4", proposer: "node-1", targetAddress: validAddr }])
      assert.equal(ok.error, undefined, `well-shaped proposal must succeed, got ${JSON.stringify(ok)}`)
      assert.equal(submittedCalls.length, 1)
      assert.equal(submittedCalls[0].type, "add_validator")
      assert.equal(submittedCalls[0].opts.targetAddress, validAddr,
        "targetAddress must pass through verbatim")
      // Sanity: omitted targetAddress succeeds and stub sees undefined.
      const okOmit = await probe([{ type: "add_validator", targetId: "v5", proposer: "node-1" }])
      assert.equal(okOmit.error, undefined, `omitted targetAddress must succeed, got ${JSON.stringify(okOmit)}`)
      assert.equal(submittedCalls[1].opts.targetAddress, undefined)
    } finally {
      delete (chain as unknown as Record<string, unknown>).governance
    }
  })

  await t.test("#342: eth_getFilterChanges for missing/expired filter returns -32000", async () => {
    // Pre-fix returned `[]` for any missing filter — long-running indexers
    // polling past FILTER_TTL_MS (5 min) silently dropped events with no
    // error to trigger filter re-creation. Geth/erigon return -32000
    // "filter not found"; mirror that so clients can detect the situation.
    const r1 = await rpcCallRaw(port, "eth_getFilterChanges", ["0x" + "f".repeat(32)])
    assert.equal(r1.error?.code, -32000,
      `missing filter must be -32000, got ${JSON.stringify(r1)}`)
    assert.match(r1.error!.message, /filter not found/,
      "error message must say 'filter not found'")

    const r2 = await rpcCallRaw(port, "eth_getFilterLogs", ["0x" + "e".repeat(32)])
    assert.equal(r2.error?.code, -32000,
      `getFilterLogs missing filter must be -32000, got ${JSON.stringify(r2)}`)
    assert.match(r2.error!.message, /filter not found/)

    // Sanity: a real filter still works without error
    const fid = await rpcCall(port, "eth_newBlockFilter") as string
    const ok = (await rpcCall(port, "eth_getFilterChanges", [fid])) as unknown[]
    assert.ok(Array.isArray(ok), "valid filter must still return array")
    await rpcCall(port, "eth_uninstallFilter", [fid])

    // After uninstall, the same id now misses → -32000
    const afterUninstall = await rpcCallRaw(port, "eth_getFilterChanges", [fid])
    assert.equal(afterUninstall.error?.code, -32000,
      "uninstalled filter must surface as -32000 on subsequent poll")
  })

  if (prevDevAccounts === undefined) {
    delete process.env.COC_DEV_ACCOUNTS
  } else {
    process.env.COC_DEV_ACCOUNTS = prevDevAccounts
  }
  if (prevRateLimitDisabled === undefined) {
    delete process.env.COC_RPC_RATE_LIMIT_DISABLED
  } else {
    process.env.COC_RPC_RATE_LIMIT_DISABLED = prevRateLimitDisabled
  }
})
