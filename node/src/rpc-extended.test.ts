import test from "node:test"
import assert from "node:assert/strict"
import type http from "node:http"
import net from "node:net"
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

  await t.test("#503: eth_signTypedData_v4 accepts JSON-stringified typedData (MetaMask/ethers convention)", async () => {
    // Per EIP-712 reference impl + MetaMask docs, the canonical browser-
    // wallet call shape is `params: [address, JSON.stringify(typedData)]`.
    // ethers.signTypedData, viem.signTypedData, web3.eth.signTypedDataV4,
    // and the MetaMask `ethereum.request` API all pass the typedData as
    // a stringified JSON. Pre-fix COC's handler required the object form
    // and rejected stringified payloads with -32602 "invalid typedData:
    // expected object" — every browser-wallet integration broke.
    //
    // Live testnet 88780 reproduction confirmed the rejection.
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

    // Stringified form (the canonical MetaMask/ethers call shape).
    const sigFromString = await rpcCall(port, "eth_signTypedData_v4", [
      accounts[0],
      JSON.stringify(typedData),
    ])
    assert.ok(typeof sigFromString === "string", "stringified typedData must produce a signature")
    assert.match(sigFromString as string, /^0x[0-9a-f]{130}$/i, "signature must be 65-byte hex")

    // Object form (legacy, but should still work — backwards compat).
    const sigFromObject = await rpcCall(port, "eth_signTypedData_v4", [accounts[0], typedData])
    // Both forms must produce IDENTICAL signatures over the same typedData.
    assert.equal(
      sigFromString,
      sigFromObject,
      "stringified and object forms must produce byte-identical signatures",
    )

    // Malformed JSON string → structured -32602 with "malformed JSON" hint
    // (NOT silent fallback / V8 SyntaxError leak).
    const bad = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_signTypedData_v4",
        params: [accounts[0], "{not valid json"],
      }),
    })
    const badJson = await bad.json() as { error?: { code: number; message: string } }
    assert.equal(badJson.error?.code, -32602, `malformed JSON string must be -32602, got ${JSON.stringify(badJson)}`)
    assert.match(badJson.error!.message, /malformed JSON|expected object/i)
    // Must not leak V8 SyntaxError internals.
    assert.doesNotMatch(badJson.error!.message, /SyntaxError|at JSON\.parse|line \d+|column \d+/)
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

  await t.test("#614: eth_createAccessList.gasUsed includes intrinsic gas (parity with geth)", async () => {
    // Pre-fix the handler returned result.gasUsed from evm.traceCall
    // directly, which is the EVM EXECUTION gas only. For a simple value
    // transfer (no contract code, no data) execution gas is 0, so
    // pre-fix the response was {accessList:[], gasUsed:"0x0"} — but the
    // tx WOULD actually cost 21000 (intrinsic). Tools wiring this number
    // into `gas:` on a subsequent eth_sendRawTransaction sent txs
    // guaranteed to fail with "intrinsic gas too low".
    //
    // Geth's eth_createAccessList returns the TOTAL tx-gas estimate
    // including intrinsic (21000 base + per-byte data + creation extras).
    // Sibling endpoint eth_estimateGas already did this (evm.ts:949);
    // eth_createAccessList must match.
    const valueTransfer = await rpcCall(port, "eth_createAccessList", [
      {
        from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        value: "0x1",
      },
    ]) as { accessList: unknown[]; gasUsed: string }
    // 21000 = 0x5208. Pre-fix this was "0x0".
    assert.ok(BigInt(valueTransfer.gasUsed) >= 21_000n,
      `value-transfer createAccessList.gasUsed must include intrinsic 21000+, got ${valueTransfer.gasUsed} = ${BigInt(valueTransfer.gasUsed)}`)
    assert.notEqual(valueTransfer.gasUsed, "0x0",
      "createAccessList.gasUsed must NEVER be 0x0 for a deliverable tx (the pre-fix bug)")
    // Parity with eth_estimateGas (which already adds intrinsic; the
    // two should be within ~10% of each other since estimateGas adds a
    // +10% buffer on top of the intrinsic + execution sum).
    const est = await rpcCall(port, "eth_estimateGas", [{
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: "0x1",
    }]) as string
    const aclGas = BigInt(valueTransfer.gasUsed)
    const estGas = BigInt(est)
    // estimateGas adds 10% buffer; createAccessList doesn't (it's a
    // simulation result, not an estimate). estGas should be ~aclGas * 1.1.
    assert.ok(estGas >= aclGas,
      `estimateGas (${estGas}) must be >= createAccessList gasUsed (${aclGas})`)
    assert.ok(estGas <= aclGas * 2n,
      `estimateGas (${estGas}) and createAccessList (${aclGas}) must be in the same order of magnitude`)
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

  await t.test("#260: eth_getBlockByNumber/Hash reject non-boolean includeTx (no Boolean() coercion)", async () => {
    // Pre-fix `Boolean((payload.params ?? [])[1])` accepted every shape:
    //   Boolean("false") === true  → client thinking "false" gets full txs
    //   Boolean([]) === true       → array silently treated as truthy
    //   Boolean({}) === true       → object silently treated as truthy
    //   Boolean(1) === true        → numeric truthy
    // Clients sending the wrong shape got the OPPOSITE of what they meant
    // (full tx objects ~5-6× bandwidth instead of hashes). Spec requires
    // strict boolean; geth rejects everything else with -32602.
    await chain.proposeNextBlock()
    const validHash = "0x" + "00".repeat(32)
    for (const method of ["eth_getBlockByNumber", "eth_getBlockByHash"]) {
      const arg0 = method === "eth_getBlockByNumber" ? "0x0" : validHash
      for (const bad of ["false", "true", [], {}, 0, 1, "yes", "no"]) {
        const r = await rpcCallRaw(port, method, [arg0, bad])
        assert.equal(r.error?.code, -32602,
          `${method}([${arg0}, ${JSON.stringify(bad)}]) must -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /includeTransactions/i,
          `${method} error must name the param, got ${r.error!.message}`)
      }
      // Sanity: strict booleans still work
      for (const good of [true, false, undefined, null]) {
        const params = good === undefined ? [arg0] : [arg0, good]
        const r = await rpcCallRaw(port, method, params)
        assert.equal(r.error, undefined,
          `${method}([${arg0}, ${JSON.stringify(good)}]) must succeed, got ${JSON.stringify(r.error)}`)
      }
    }
  })

  await t.test("eth_getUncleCountByBlockNumber returns zero", async () => {
    const count = await rpcCall(port, "eth_getUncleCountByBlockNumber", ["0x0"])
    assert.strictEqual(count, "0x0")
  })

  await t.test("#549: uncle handlers validate input shape (no silent 0x0/null for malformed args)", async () => {
    // Pre-fix every uncle handler short-circuited the result without
    // inspecting the input, so "0xbogus" / {} / bogus tag silently
    // succeeded indistinguishable from the well-formed "zero uncles"
    // case. Geth rejects each malformed shape with -32602.
    const badHashCount = await rpcCallRaw(port, "eth_getUncleCountByBlockHash", ["0xbogus"])
    assert.equal(badHashCount.error?.code, -32602, `bad hash for count must -32602, got ${JSON.stringify(badHashCount)}`)
    assert.match(badHashCount.error?.message ?? "", /block hash/i)

    const objHash = await rpcCallRaw(port, "eth_getUncleCountByBlockHash", [{}])
    assert.equal(objHash.error?.code, -32602, `object hash for count must -32602, got ${JSON.stringify(objHash)}`)

    const badTagCount = await rpcCallRaw(port, "eth_getUncleCountByBlockNumber", ["bogus"])
    assert.equal(badTagCount.error?.code, -32602, `bad tag for count must -32602, got ${JSON.stringify(badTagCount)}`)

    const badHashBy = await rpcCallRaw(port, "eth_getUncleByBlockHashAndIndex", ["0xbogus", "0x0"])
    assert.equal(badHashBy.error?.code, -32602, `bad hash for by-hash-and-index must -32602, got ${JSON.stringify(badHashBy)}`)

    const badIdx = await rpcCallRaw(port, "eth_getUncleByBlockNumberAndIndex", ["latest", "bogus"])
    assert.equal(badIdx.error?.code, -32602, `bad index for by-number-and-index must -32602, got ${JSON.stringify(badIdx)}`)

    // Well-formed inputs still return zero / null (no regression on the body)
    const validHash = "0x" + "00".repeat(32)
    const okCount = await rpcCall(port, "eth_getUncleCountByBlockHash", [validHash])
    assert.equal(okCount, "0x0", "well-formed hash still returns 0x0")
    const okBy = await rpcCall(port, "eth_getUncleByBlockHashAndIndex", [validHash, "0x0"])
    assert.equal(okBy, null, "well-formed hash+index still returns null")
    const okNumCount = await rpcCall(port, "eth_getUncleCountByBlockNumber", ["latest"])
    assert.equal(okNumCount, "0x0", "well-formed tag still returns 0x0")
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

    // Missing filter case: per the #342 fix landed in PR #573, missing
    // filter id now returns -32000 "filter not found" (geth semantic),
    // NOT silent []. Pre-fix this assertion expected `[]` which was the
    // OLD (pre-#342) behavior; the test fixture was stale since PR #573.
    const missing = "0x" + "00".repeat(16)
    const r4raw = await rpcCallRaw(port, "eth_getFilterLogs", [missing])
    assert.ok(r4raw.error, "missing filter must error (not silent [])")
    assert.equal(r4raw.error!.code, -32000, `expected -32000, got ${r4raw.error!.code}`)
    assert.match(r4raw.error!.message, /filter not found/i,
      `expected "filter not found", got: ${r4raw.error!.message}`)
  })

  await t.test("#360: oversize RPC body returns 413 + JSON-RPC error (no ECONNRESET race after res.end)", async () => {
    // Pre-fix: when the body exceeded MAX_RPC_BODY (1 MiB), the server
    // called req.destroy() synchronously after res.end(...). res.end
    // merely buffered the response in Node's http stream; the inline
    // destroy RST-ed the socket before the bytes reached the kernel TCP
    // stack. Clients saw ECONNRESET / "Connection reset by peer" instead
    // of the documented 413 + JSON-RPC -32600 error, non-deterministically
    // (depends on TCP send buffer + scheduler timing — the boundary scan
    // in #360 showed flapping across N=27000-32000 addresses in eth_getLogs).
    //
    // Fix: emit Connection:close + Content-Length, and run socket.destroy()
    // inside res.end's flush callback (guaranteed to fire AFTER the
    // buffered response reaches the wire).
    //
    // This test sends an oversize body (~2 MiB) via raw TCP and asserts
    // we receive the full 413 + JSON error body BEFORE any socket teardown.
    const PAYLOAD_SIZE = 2 * 1024 * 1024 // 2 MiB, well above 1 MiB cap
    const filler = "a".repeat(PAYLOAD_SIZE - 100)
    const jsonBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 360,
      method: "web3_sha3",
      params: ["0x" + filler],
    })
    const request =
      `POST / HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(jsonBody)}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      jsonBody

    const result = await new Promise<{ buffer: string; gotError: boolean; errorCode?: string }>((resolve) => {
      const sock = net.connect(port, "127.0.0.1")
      let buffer = ""
      let gotError = false
      let errorCode: string | undefined
      sock.on("data", (chunk) => { buffer += chunk.toString("utf8") })
      sock.on("error", (err) => {
        gotError = true
        errorCode = (err as NodeJS.ErrnoException).code
      })
      sock.on("close", () => resolve({ buffer, gotError, errorCode }))
      sock.write(request)
      // Safety: don't hang if the server never responds.
      setTimeout(() => sock.destroy(), 10_000)
    })

    // 1. We must have received the full HTTP 413 response with body.
    //    Pre-fix: buffer is empty or partial (RST arrived first).
    assert.match(result.buffer, /HTTP\/1\.1 413/,
      `must receive HTTP 413, got buffer (first 200 chars): "${result.buffer.slice(0, 200)}". ` +
      `gotError=${result.gotError} errorCode=${result.errorCode}. ` +
      `Pre-fix bug: req.destroy() RSTs the socket before res.end's bytes reach the wire.`)

    // 2. Connection:close header must be present (signals the client
    //    not to reuse the about-to-be-destroyed socket).
    assert.match(result.buffer, /Connection:\s*close/i,
      `413 response must include Connection:close header, got: "${result.buffer.slice(0, 400)}"`)

    // 3. JSON-RPC error body must be the documented -32600 payload.
    //    With Content-Length set in the fix, the response is identity-
    //    encoded — body starts right after the header terminator.
    const bodyStart = result.buffer.indexOf("\r\n\r\n")
    assert.notEqual(bodyStart, -1, "response must have a body separator")
    const body = result.buffer.slice(bodyStart + 4)
    const parsed = JSON.parse(body) as { jsonrpc: string; id: unknown; error?: { code: number; message: string } }
    assert.equal(parsed.jsonrpc, "2.0")
    assert.equal(parsed.id, null)
    assert.equal(parsed.error?.code, -32600)
    assert.match(parsed.error?.message ?? "", /request body too large/i,
      `error message must be the documented one, got: ${parsed.error?.message}`)

    // We deliberately don't assert gotError=false here. ECONNRESET on
    // the client's send side is acceptable post-fix: the server already
    // closed the read half via socket.destroy() after the flush, so any
    // remaining bytes the test client tries to send may fail. What's
    // NOT acceptable is an empty response buffer (caught by assert #1).
  })

  // (Original #94: eth_getFilterLogs-on-block-filter-returns-[] test removed —
  // superseded by #390 above, which asserts strict -32602 rejection instead.)

  await t.test("#282: eth_getFilterChanges pendingTx filter shrinks `seen` when txs leave mempool (no unbounded growth)", async () => {
    // Pre-fix: per-filter `seenPendingTxs` was add-only. A tx hash entered
    // on first observation and never left, regardless of whether the tx
    // was mined / dropped / replaced. At MAX_FILTERS=1000 and 100 tx/s
    // sustained churn this leaked ~360 MB/hour per filter — 8.6 GB/day
    // OOM ceiling. CWE-401 / CWE-770.
    //
    // The invariant we test: after a tx leaves the mempool, polling the
    // filter MUST drop it from `seen`, so resubmitting the same tx hash
    // surfaces as a fresh "newly observed" event. Pre-fix the resubmit
    // saw fresh=[] (because seen still carried the original hash); the
    // fix intersects seen with the current mempool every poll, bounding
    // seen.size by mempool.size (already capped).
    const { Wallet } = await import("ethers")
    const walletA = new Wallet(`0x${"08".repeat(32)}`)
    const walletB = new Wallet(`0x${"09".repeat(32)}`)
    await evm.prefund([
      { address: walletA.address, balanceWei: "1000000000000000000" },
      { address: walletB.address, balanceWei: "1000000000000000000" },
    ])
    const startNonceA = await evm.getNonce(walletA.address.toLowerCase() as `0x${string}`)
    const startNonceB = await evm.getNonce(walletB.address.toLowerCase() as `0x${string}`)
    const rawA = await walletA.signTransaction({
      type: 0, to: `0x${"02".repeat(20)}`, value: 1n,
      nonce: Number(startNonceA), gasPrice: 1_000_000_000n,
      gasLimit: 21_000n, chainId,
    })
    const rawB = await walletB.signTransaction({
      type: 0, to: `0x${"02".repeat(20)}`, value: 1n,
      nonce: Number(startNonceB), gasPrice: 1_000_000_000n,
      gasLimit: 21_000n, chainId,
    })

    const fid = (await rpcCall(port, "eth_newPendingTransactionFilter")) as string
    // Drain any pre-populated mempool entries.
    await rpcCall(port, "eth_getFilterChanges", [fid])

    // Step 1: submit A + B → poll → fresh contains both, seen = {A, B}.
    const hashA = (await rpcCall(port, "eth_sendRawTransaction", [rawA])) as string
    const hashB = (await rpcCall(port, "eth_sendRawTransaction", [rawB])) as string
    const poll1 = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
    assert.ok(poll1.includes(hashA), `poll1 must include hashA (got ${JSON.stringify(poll1)})`)
    assert.ok(poll1.includes(hashB), `poll1 must include hashB (got ${JSON.stringify(poll1)})`)

    // Step 2: remove A from mempool directly (mimics mined/dropped/replaced
    // without advancing the chain head — preserves the ability to resubmit
    // the exact same signed tx with the same nonce in step 4).
    chain.mempool.remove(hashA as `0x${string}`)

    // Step 3: poll → fresh = [] (no new arrivals). Pre-fix seen still
    // carries {A, B}; post-fix the intersect-with-mempool step prunes A.
    const poll2 = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
    assert.deepEqual(poll2, [], `poll2 must be empty between adds (got ${JSON.stringify(poll2)})`)

    // Step 4: resubmit A. Same raw tx → same hash → returns to mempool
    // (chain head didn't advance, so it's not "tx already confirmed").
    // Pre-fix: seen still carries hashA from step 1, so fresh = [] —
    // the resubmit silently disappears. Post-fix: seen was pruned in
    // step 3, so this is a fresh observation.
    const hashA2 = (await rpcCall(port, "eth_sendRawTransaction", [rawA])) as string
    assert.equal(hashA2, hashA, "resubmitted raw tx must have the same hash")
    const poll3 = (await rpcCall(port, "eth_getFilterChanges", [fid])) as string[]
    assert.deepEqual(poll3, [hashA],
      `poll3 must surface resubmitted hashA as fresh (got ${JSON.stringify(poll3)}). ` +
      `Pre-fix bug: seen never shrinks, so resubmit silently drops.`)
  })

  // (Original #94: eth_getFilterLogs-on-block-filter-returns-[] test removed —
  // superseded by #390 above, which asserts strict -32602 rejection instead.)

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

  await t.test("#523: eth_getBlockReceipts accepts all 5 EIP-1898 BlockNumberOrHash shapes (no [object Object] leak)", async () => {
    // Live testnet 88780 reproduction (pre-fix):
    //   eth_getBlockReceipts({"blockNumber":"latest"})
    //   → {"error":{"code":-32602,"message":"invalid block number: [object Object]"}}
    //   eth_getBlockReceipts({"blockHash":"0xca8d..."})
    //   → {"error":{"code":-32602,"message":"invalid block number: [object Object]"}}
    //
    // Same `[object Object]` leak family as #497/#499 — those PRs fixed
    // `eth_call`-family methods via `resolveHistoricalExecutionContext`
    // which handles all 5 EIP-1898 shapes. `eth_getBlockReceipts` was
    // missed because it doesn't need state-root resolution, so its
    // simpler `String(rawParam ?? "latest")` path silently coerced
    // objects to literal `"[object Object]"`.
    //
    // Tooling that batches receipts via EIP-1898 forms:
    //   - ethers.js `provider.getBlock(h).then(b => provider.send(
    //       "eth_getBlockReceipts", [{blockHash: b.hash}]))`
    //   - The Graph indexer's bulk-receipt fetcher
    //   - Etherscan-clones / block explorers
    // All silently got -32602 from this method.
    //
    // Fix: handle all 5 EIP-1898 shapes — bare tag, hex number, bare hash,
    // {blockNumber: …}, {blockHash: …}. Reject hybrid {both} per spec.
    await chain.proposeNextBlock()
    const blockByNumber = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as { hash: string } | null
    assert.ok(blockByNumber, "fixture must have block 0x1 after proposeNextBlock")
    const blockHash = blockByNumber!.hash
    const expectedReceipts = await rpcCall(port, "eth_getBlockReceipts", ["0x1"])

    // Shape (i): {blockNumber: "0x1"} — hex quantity in object
    const sBN = await rpcCall(port, "eth_getBlockReceipts", [{ blockNumber: "0x1" }])
    assert.deepEqual(sBN, expectedReceipts,
      `{blockNumber:"0x1"} must yield same receipts as "0x1", got ${JSON.stringify(sBN)}`)

    // Shape (ii): {blockNumber: "latest"} — named tag in object
    const sLatest = await rpcCall(port, "eth_getBlockReceipts", [{ blockNumber: "latest" }])
    assert.ok(Array.isArray(sLatest) || sLatest === null,
      `{blockNumber:"latest"} must return array or null, got ${JSON.stringify(sLatest)}`)

    // Shape (iii): {blockHash: "0x…"} — 32-byte hash in object
    const sBH = await rpcCall(port, "eth_getBlockReceipts", [{ blockHash }])
    assert.deepEqual(sBH, expectedReceipts,
      `{blockHash:"${blockHash}"} must yield same receipts as "0x1", got ${JSON.stringify(sBH)}`)

    // Reject hybrid {both} per EIP-1898 spec (geth + Erigon return -32602).
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockReceipts", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    const hybrid = await probe([{ blockNumber: "latest", blockHash }])
    assert.ok(hybrid.error, "EIP-1898 hybrid {blockNumber, blockHash} must error")
    assert.equal(hybrid.error!.code, -32602)
    assert.match(hybrid.error!.message, /EIP-1898 forbids.*together/,
      `hybrid message must explain the spec violation, got: ${hybrid.error!.message}`)

    // Defense against the regression: confirm pre-fix leak is gone.
    // ANY error message MUST NOT contain "[object Object]".
    const badObj = await probe([{ unrelated: "field" }])
    assert.ok(badObj.error, "object missing both blockNumber/blockHash must error")
    assert.doesNotMatch(badObj.error!.message, /\[object Object\]/,
      `must not leak [object Object] coercion, got: ${badObj.error!.message}`)
    assert.match(badObj.error!.message, /EIP-1898|blockNumber|blockHash/i,
      `must explain what's wrong, got: ${badObj.error!.message}`)

    // Malformed blockHash in object form must surface as -32602 with a
    // specific blockHash-shape error (not the generic block-number message).
    const badHash = await probe([{ blockHash: "0xshort" }])
    assert.ok(badHash.error)
    assert.equal(badHash.error!.code, -32602)
    assert.match(badHash.error!.message, /invalid blockHash/i,
      `must complain about blockHash shape, got: ${badHash.error!.message}`)
  })

  await t.test("#527: eth_sendRawTransaction checks chainId BEFORE nonce (no misleading 'nonce too low' for wrong-chain tx)", async () => {
    // Live testnet 88780 reproduction (pre-fix):
    //   wallet.signTransaction({chainId: 99999, nonce: 0, ...})
    //   eth_sendRawTransaction(raw)
    //   → {"error":{"code":-32000,"message":"nonce too low: tx nonce 0, on-chain nonce 282"}}
    //
    // With nonce=500 (above on-chain), the SAME wrong-chain tx instead
    // returned the correct chainId error:
    //   → {"error":{"code":-32602,"message":"invalid chain ID: expected 88780, got 99999"}}
    //
    // The validation order pre-fix was: parse → tx-hash dedup → nonce →
    // chainId (inside mempool.addRawTx). ChainId is STRUCTURAL (signed
    // into the tx via EIP-155 / EIP-2930), nonce is DYNAMIC (state).
    // Geth + Erigon both check structural properties first because
    // dynamic-state errors are misleading when the tx is structurally
    // unacceptable. A wrong-chain tx will NEVER be valid on this chain
    // regardless of nonce; reporting "nonce too low" suggests bumping
    // the nonce would help, which is wrong.
    //
    // Fix: chainId check pulled from mempool.addRawTx up to the start
    // of chain-engine{,-persistent}.ts addRawTx. Both engines now check
    // chainId first.
    const { Wallet } = await import("ethers")
    const wallet = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
    const probe = async (raw: string) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // The fixture's chain config exposes its chainId; pick something obviously
    // different so the chainId check fires.
    const fixtureChainId = await rpcCall(port, "eth_chainId", []) as string
    const wrongChainId = Number(BigInt(fixtureChainId)) + 12345
    const wrongChain = await wallet.signTransaction({
      chainId: wrongChainId,
      nonce: 0,  // intentionally low — bug case is low-nonce + wrong-chain
      gasLimit: 21000n,
      gasPrice: 1_000_000_000n,
      to: "0x0000000000000000000000000000000000000001",
      value: 1n,
    })
    const r1 = await probe(wrongChain)
    assert.ok(r1.error, `wrong-chain tx must be rejected, got result=${JSON.stringify(r1.result)}`)
    // Must mention chainId, NOT nonce — the bug shape.
    assert.match(r1.error!.message, /chain ID|chainId/i,
      `wrong-chain tx error must mention chainId, got: ${r1.error!.message}`)
    assert.doesNotMatch(r1.error!.message, /nonce too low/i,
      `wrong-chain tx must NOT be misreported as nonce too low (the pre-fix bug), got: ${r1.error!.message}`)
    // Geth wire convention: chainId errors are -32602 (structural shape
    // failure) per the existing #332 rpc.ts mapping at line ~1112.
    assert.equal(r1.error!.code, -32602,
      `wrong-chain tx must be -32602 (invalid params), got ${r1.error!.code}`)
    // #604: pre-fix the message echoed `this.cfg.chainId` directly,
    // which is undefined when the ChainEngine was constructed without
    // an explicit chainId (rpc layer falls back to 18780 in the
    // BigInt comparison via `?? 18780`). Callers saw "expected
    // undefined, got 99999" — same info-quality family as #156/#176/
    // #182/#505/#507/#601. The fixture sets chainId to fixtureChainId,
    // so the message must echo that number rather than the literal
    // word "undefined".
    assert.doesNotMatch(r1.error!.message, /expected undefined/i,
      `chainId error must echo the actual expected ID, not "undefined": ${r1.error!.message}`)
    assert.match(r1.error!.message, new RegExp(`expected ${Number(BigInt(fixtureChainId))}`),
      `chainId error must name the actual expected ID (${Number(BigInt(fixtureChainId))}), got: ${r1.error!.message}`)
  })

  await t.test("#533: eth_getLogs blockHash resolves to the correct block (non-existent → -32000 'unknown block')", async () => {
    // Live testnet 88780 reproduction (pre-fix):
    //   eth_getLogs({"blockHash":"0xdeadbeef...deadbeef"})  // valid shape, doesn't exist
    //   → {"result":[]}
    //   eth_getLogs({"blockHash":"0x2a020dbc...latest"})    // valid AND exists
    //   → {"result":[]}    // INDISTINGUISHABLE from above
    //
    // Upstream validation (#186 shape, #464 fromBlock/toBlock mutex)
    // existed, but `queryLogs` (rpc.ts:4093) NEVER read `query.blockHash`.
    // It always fell through to `parseBlockTag(query.fromBlock, height)`
    // which returned `height` for undefined → fromBlock=toBlock=latest.
    // A `{blockHash: "<hash>"}` filter silently queried the LATEST block
    // instead of the block at that hash.
    //
    // EIP-234 batched fetchers (ethers.js provider.getLogs({blockHash:...}),
    // viem getLogs({blockHash:...}), The Graph indexer, every block-explorer
    // implementing reorg-aware retrieval) need:
    //   1. Resolution to the SPECIFIC block (not latest)
    //   2. A `-32000 "unknown block"` signal so a hash that's been reorged
    //      out is detectable. Pre-fix `[]` masks reorgs.
    //
    // Fix: queryLogs reads query.blockHash, resolves to block.number for
    // fromBlock=toBlock, throws -32000 "unknown block" if the hash doesn't
    // match a known block.
    const probe = async (filter: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) Non-existent blockHash → -32000 "unknown block" (geth parity)
    const nonexistent = await probe({ blockHash: "0xdeadbeef000000000000000000000000000000000000000000000000deadbeef" })
    assert.ok(nonexistent.error,
      `non-existent blockHash must error (not silent []), got result=${JSON.stringify(nonexistent.result)}`)
    assert.equal(nonexistent.error!.code, -32000,
      `non-existent blockHash must be -32000, got ${nonexistent.error!.code}`)
    assert.match(nonexistent.error!.message, /unknown block/i,
      `error must mention "unknown block", got: ${nonexistent.error!.message}`)
    assert.equal(nonexistent.result, undefined,
      "must NOT carry a result alongside the error")

    // (b) Existing blockHash (the fixture's genesis stub or block 0x1 if any
    // were proposed) → must succeed (no -32000), regardless of log count.
    // First, propose a block to ensure block 0x1 exists.
    if (typeof chain.proposeNextBlock === "function") {
      await chain.proposeNextBlock()
    }
    const blockByNum = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as { hash: string } | null
    if (blockByNum) {
      const existing = await probe({ blockHash: blockByNum.hash })
      assert.equal(existing.error, undefined,
        `existing blockHash must succeed, got error: ${JSON.stringify(existing.error)}`)
      assert.ok(Array.isArray(existing.result),
        `existing blockHash must return array, got ${typeof existing.result}`)
    }
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

  await t.test("#464: eth_newFilter rejects blockHash + fromBlock/toBlock too (sibling of #116)", async () => {
    // EIP-234's mutex applies to every endpoint that takes a log-filter shape.
    // #116 fixed eth_getLogs; eth_newFilter and eth_subscribe("logs") were
    // missed by that audit and silently accepted both fields, taking the
    // blockHash path and ignoring fromBlock/toBlock. Centralize the check
    // inside validateLogFilter so all three callsites reject identically.
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_newFilter", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: string }
    }
    // blockHash + fromBlock → reject
    const r1 = await probe([{ blockHash: "0x" + "00".repeat(32), fromBlock: "0x0" }])
    assert.equal(r1.error?.code, -32602,
      `eth_newFilter blockHash+fromBlock must be -32602 (got ${JSON.stringify(r1)})`)
    assert.match(r1.error!.message, /mutually exclusive|EIP-234/i)

    // blockHash + toBlock → reject
    const r2 = await probe([{ blockHash: "0x" + "00".repeat(32), toBlock: "latest" }])
    assert.equal(r2.error?.code, -32602,
      `eth_newFilter blockHash+toBlock must be -32602 (got ${JSON.stringify(r2)})`)

    // blockHash + both → reject
    const r3 = await probe([{ blockHash: "0x" + "00".repeat(32), fromBlock: "0x0", toBlock: "latest" }])
    assert.equal(r3.error?.code, -32602, "blockHash+fromBlock+toBlock must reject")

    // Sanity: blockHash alone is OK.
    const ok = await probe([{ blockHash: "0x" + "00".repeat(32) }])
    assert.ok(ok.result, `blockHash alone must succeed: ${JSON.stringify(ok)}`)
    // Sanity: fromBlock alone is OK.
    const ok2 = await probe([{ fromBlock: "0x0", toBlock: "latest" }])
    assert.ok(ok2.result, `fromBlock+toBlock alone must succeed: ${JSON.stringify(ok2)}`)
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

    // #462: EIP-1898 explicitly forbids both blockNumber AND blockHash in
    // the same object. Pre-fix the blockHash branch ran first and silently
    // ignored an accompanying blockNumber field — clients could submit
    // both shapes and get an answer keyed on whichever happened to win.
    // Geth + Erigon reject with -32602. Match them.
    const both = await probe({ blockHash, blockNumber: "0x1" })
    assert.equal(both.error?.code, -32602,
      `EIP-1898 forbids blockHash+blockNumber together; must be -32602 (got ${JSON.stringify(both)})`)
    assert.match(both.error?.message ?? "", /EIP-1898 forbids|blockNumber and blockHash/i,
      `error message must reference the spec rule, got: ${both.error?.message}`)
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

  await t.test("#501: txpool_inspect returns geth-style summary strings per tx", async () => {
    // Geth-standard method: returns same {pending, queued} shape as
    // txpool_content but each tx entry is a single descriptive string
    // ("<to>: <value> wei + <gas> gas × <gasPrice> wei"). Pre-fix
    // unsupported — wallets / explorers had to fetch the full
    // txpool_content and format client-side. Live testnet 88780 repro:
    //   curl ... txpool_inspect  → -32601 "method not supported"
    const { Wallet: EW501, Transaction: ETT501 } = await import("ethers")
    const TEST_PK_501 = "0x" + "11".repeat(32)
    const wallet = new EW501(TEST_PK_501)
    await evm.prefund([{ address: wallet.address, balanceWei: "1000000000000000000" }])
    const startNonce = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)

    // Inject one tx (pending) + one gap-queued.
    for (const offset of [0, 5]) {
      const tx = ETT501.from({
        to: "0x0000000000000000000000000000000000000001",
        value: 1n, gasLimit: 21000n, gasPrice: 1_000_000_000n,
        nonce: Number(startNonce) + offset, chainId: 18780,
      })
      const signed = await wallet.signTransaction(tx)
      await rpcCall(port, "eth_sendRawTransaction", [signed])
    }

    const inspect = await rpcCall(port, "txpool_inspect") as {
      pending: Record<string, Record<string, string>>
      queued: Record<string, Record<string, string>>
    }
    assert.equal(typeof inspect, "object", "result must be object")
    assert.ok("pending" in inspect, "must have pending field")
    assert.ok("queued" in inspect, "must have queued field")

    const senderLower = wallet.address.toLowerCase()
    const pendingBySender = inspect.pending[senderLower] ?? {}
    const queuedBySender = inspect.queued[senderLower] ?? {}

    // At least 1 entry in pending + 1 in queued.
    const pendingEntries = Object.values(pendingBySender)
    const queuedEntries = Object.values(queuedBySender)
    assert.ok(pendingEntries.length >= 1, `expected pending entries for ${senderLower}, got ${JSON.stringify(pendingBySender)}`)
    assert.ok(queuedEntries.length >= 1, `expected queued entries, got ${JSON.stringify(queuedBySender)}`)

    // Each entry must be a STRING (not an object).
    for (const entry of [...pendingEntries, ...queuedEntries]) {
      assert.equal(typeof entry, "string", `entry must be summary string, got ${typeof entry}`)
      assert.match(
        entry,
        /^0x[0-9a-fA-F]{40}: \d+ wei \+ \d+ gas × \d+ wei$/,
        `entry must match geth format "<to>: <value> wei + <gas> gas × <gasPrice> wei", got ${entry}`,
      )
    }
  })

  await t.test("#501: txpool_contentFrom filters per-sender + shape matches txpool_content", async () => {
    // Geth-standard variant of txpool_content scoped to one address.
    // Pre-fix unsupported.
    const { Wallet: EW501F, Transaction: ETT501F } = await import("ethers")
    const wallet = new EW501F("0x" + "31".repeat(32))
    const other = new EW501F("0x" + "32".repeat(32))
    await evm.prefund([
      { address: wallet.address, balanceWei: "1000000000000000000" },
      { address: other.address, balanceWei: "1000000000000000000" },
    ])
    const myNonce = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)
    const otherNonce = await evm.getNonce(other.address.toLowerCase() as `0x${string}`)

    // Inject 1 tx from each sender.
    for (const [w, n] of [[wallet, myNonce], [other, otherNonce]] as const) {
      const tx = ETT501F.from({
        to: "0x0000000000000000000000000000000000000001",
        value: 1n, gasLimit: 21000n, gasPrice: 1_000_000_000n,
        nonce: Number(n), chainId: 18780,
      })
      const signed = await w.signTransaction(tx)
      await rpcCall(port, "eth_sendRawTransaction", [signed])
    }

    const meLower = wallet.address.toLowerCase()
    const otherLower = other.address.toLowerCase()

    const fromMe = await rpcCall(port, "txpool_contentFrom", [meLower]) as {
      pending: Record<string, Record<string, unknown>>
      queued: Record<string, Record<string, unknown>>
    }
    // Must include this sender.
    assert.ok(fromMe.pending[meLower], `txpool_contentFrom must include ${meLower}, got ${JSON.stringify(fromMe)}`)
    // Must NOT include the other sender.
    assert.ok(!fromMe.pending[otherLower], `txpool_contentFrom must filter out other senders, got ${JSON.stringify(fromMe)}`)
    assert.ok(!fromMe.queued[otherLower])

    // Bad address shape → -32602 (uses requireAddressParam).
    const bad = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "txpool_contentFrom", params: ["not-an-address"] }),
    })
    const badJson = await bad.json() as { error?: { code: number; message: string } }
    assert.equal(badJson.error?.code, -32602, `bad address must be -32602, got ${JSON.stringify(badJson)}`)
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

  await t.test("#450: txpool_content entries carry full EIP-1559/EIP-2930 fields (parity with eth_getTransactionByHash)", async () => {
    // Live testnet 88780 reproduction:
    //   $ curl ...txpool_content
    //   {
    //     "queued": {
    //       "0xf39f...": {
    //         "411": {
    //           "hash": "0xf6094f...", "nonce": "0x19b", "from": "0xf39f...",
    //           "to": "0x70997970...", "value": "0x1", "gas": "0x5208",
    //           "gasPrice": "0x77359400", "input": "0x"
    //           // MISSING: maxFeePerGas, maxPriorityFeePerGas, accessList,
    //           //          type, chainId, v, r, s, blockHash, blockNumber,
    //           //          transactionIndex
    //         }
    //       }
    //     }
    //   }
    //
    // splitMempoolPendingQueued was hand-rolling a per-entry literal with
    // legacy fields only. Indexers that compare in-pool vs mined-tx shape
    // (etherscan-clones, mempool dashboards) saw mismatched fields. Reuse
    // formatRawTransaction so the entries match eth_getTransactionByHash.
    const { Wallet: EW, Transaction: ET } = await import("ethers")
    const wallet = new EW(`0x${"0b".repeat(32)}`)
    await evm.prefund([{ address: wallet.address, balanceWei: "1000000000000000000" }])
    const startNonce = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)

    // Send an EIP-1559 tx with a gap nonce so it lands in `queued`.
    const tx1559 = ET.from({
      type: 2,
      to: `0x${"0c".repeat(20)}`,
      value: 1n,
      nonce: Number(startNonce) + 3, // gap → queued bucket
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      gasLimit: 50_000n,
      chainId,
      data: "0x",
    })
    const sig = wallet.signingKey.sign(tx1559.unsignedHash)
    const clone = tx1559.clone()
    clone.signature = sig
    const raw = clone.serialized
    await rpcCall(port, "eth_sendRawTransaction", [raw])

    const content = await rpcCall(port, "txpool_content") as {
      pending: Record<string, Record<string, Record<string, unknown>>>
      queued: Record<string, Record<string, Record<string, unknown>>>
    }
    const senderAddr = wallet.address.toLowerCase()
    const queuedForSender = content.queued[senderAddr] ?? {}
    const entry = queuedForSender[String(Number(startNonce) + 3)]
    assert.ok(entry, `EIP-1559 tx must appear in queued bucket: ${JSON.stringify(Object.keys(queuedForSender))}`)

    // The full set of fields that geth's txpool_content includes (parity
    // with eth_getTransactionByHash):
    assert.equal(entry.type, "0x2", `type must be 0x2 for EIP-1559, got ${entry.type}`)
    assert.equal(entry.maxFeePerGas, "0x77359400", `maxFeePerGas must be present`)
    assert.equal(entry.maxPriorityFeePerGas, "0x5f5e100", `maxPriorityFeePerGas must be present`)
    assert.equal(entry.chainId, `0x${chainId.toString(16)}`)
    // Mempool txs report null for these three (per geth):
    assert.equal(entry.blockHash, null, "blockHash null for mempool")
    assert.equal(entry.blockNumber, null, "blockNumber null for mempool")
    assert.equal(entry.transactionIndex, null, "transactionIndex null for mempool")
    // Signature fields must be present:
    assert.ok(typeof entry.v === "string", `v must be present, got ${entry.v}`)
    assert.ok(typeof entry.r === "string", `r must be present, got ${entry.r}`)
    assert.ok(typeof entry.s === "string", `s must be present, got ${entry.s}`)
  })

  await t.test("coc_nodeInfo returns node metadata", async () => {
    const info = await rpcCall(port, "coc_nodeInfo")
    assert.ok(typeof info === "object")
    assert.strictEqual(info.clientVersion, "COC/0.2")
    // #561: chainId returned as 0x-prefixed hex quantity (parity with
    // eth_chainId + coc_chainStats.chainId; Ethereum JSON-RPC contract).
    assert.strictEqual(info.chainId, `0x${chainId.toString(16)}`)
    assert.ok(typeof info.blockHeight === "number" || typeof info.blockHeight === "string")
    assert.ok(typeof info.mempool === "object")
    assert.ok(typeof info.mempool.size === "number")
    assert.ok(typeof info.uptime === "number")
    // nodeVersion, platform, arch removed from public endpoint (info disclosure)
  })

  await t.test("#561: coc_nodeInfo.chainId is 0x-prefixed hex (parity with eth_chainId)", async () => {
    // Pre-fix coc_nodeInfo emitted chainId as a raw JS number (e.g. 88780)
    // while sibling methods returned hex ("0x15acc"). Clients aggregating
    // chainId from multiple endpoints saw `88780 !== "0x15acc"` and
    // concluded the node was misconfigured. Same format-drift family as
    // #517 (nextProposalBlock decimal vs hex on same response).
    //
    // Both coc_nodeInfo and eth_chainId derive from the same `chainId`
    // argument passed to handleRpc, so they must match exactly. The test
    // fixture's coc_chainStats reads from chain.cfg.chainId (a separate
    // source that may be unset in the fixture) — that cross-method
    // divergence is its own pre-existing concern; this regression pins
    // only the format and the eth_chainId<->coc_nodeInfo parity.
    const info = await rpcCall(port, "coc_nodeInfo")
    const ethId = await rpcCall(port, "eth_chainId")
    assert.equal(typeof info.chainId, "string", `coc_nodeInfo.chainId must be a string, got ${typeof info.chainId}`)
    assert.match(info.chainId, /^0x[0-9a-f]+$/i, `coc_nodeInfo.chainId must be 0x-prefixed hex, got ${JSON.stringify(info.chainId)}`)
    assert.strictEqual(info.chainId, ethId, `coc_nodeInfo.chainId (${info.chainId}) must match eth_chainId (${ethId})`)
  })

  await t.test("#607: coc_validators.nextProposalBlock is 0x-prefixed hex (closing #517 format drift)", async () => {
    // Pre-fix `nextProposalBlock: Number(h)` emitted a decimal JS number
    // (e.g. 88751) while every sibling block-height field on the same
    // response shape returned 0x-prefixed hex per Ethereum JSON-RPC
    // convention (`currentHeight: "0x15a8e"`, `coc_chainStats.blockHeight:
    // "0x15a8e"`, `eth_blockNumber: "0x15a8e"`).  Clients aggregating
    // block numbers from multiple fields saw the same height twice in
    // two different formats and concluded the response was corrupted.
    // Same format-drift family as #561 (chainId) and the historical
    // #517 (next-proposer decimal vs hex) — closes the remaining
    // instance the comment at #561 explicitly identified.
    const result = await rpcCall(port, "coc_validators") as {
      validators: Array<{ id: string; isCurrentProposer: boolean; nextProposalBlock: unknown }>
      currentHeight: string
      nextProposer: string
    }
    assert.ok(Array.isArray(result.validators), "validators must be array")
    assert.ok(result.validators.length > 0, "fixture has at least node-1")
    for (const v of result.validators) {
      assert.equal(typeof v.nextProposalBlock, "string",
        `nextProposalBlock must be a string (hex), got ${typeof v.nextProposalBlock}: ${JSON.stringify(v.nextProposalBlock)}`)
      assert.match(v.nextProposalBlock as string, /^0x[0-9a-f]+$/i,
        `nextProposalBlock must be 0x-prefixed hex, got ${JSON.stringify(v.nextProposalBlock)}`)
    }
    // Sanity: currentHeight (sibling field) is also hex — pre-fix it
    // already serialized correctly via the bigint→hex JSON replacer,
    // pin so a future change can't regress it.
    assert.match(result.currentHeight, /^0x[0-9a-f]+$/i,
      `currentHeight must be 0x-prefixed hex, got ${JSON.stringify(result.currentHeight)}`)
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

  await t.test("#436: coc_getProposals/getDaoProposals/getFaction validate input BEFORE backend-config short-circuit", async () => {
    // Same family as #432 / PR #431 but for the 3 handlers that return
    // a successful empty result (`[]` or `null`) instead of methodNotFound
    // when governance is off. Pre-fix, garbage input shapes silently got
    // the empty result on every read-only fullnode (the entire testnet 88780
    // RPC surface) — clients could not tell "I sent garbage" from
    // "no proposals exist." Validation must run unconditionally at the
    // RPC boundary; the config check only selects between "real lookup"
    // and "empty result" AFTER input passes shape validation.
    const probe = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }

    // coc_getProposals — non-string filter must reject even without governance.
    for (const bad of [true, false, 42, {}, [1, 2]]) {
      const r = await probe("coc_getProposals", [bad])
      assert.equal(r.error?.code, -32602,
        `coc_getProposals(${JSON.stringify(bad)}) must be -32602 (not silent []), got ${JSON.stringify(r)}`)
    }
    // Sanity: valid shape returns [] (not error) without governance.
    {
      const r = await probe("coc_getProposals", [])
      assert.equal(r.error, undefined, `coc_getProposals([]) without governance must return empty array, got ${JSON.stringify(r)}`)
      assert.deepEqual(r.result, [])
    }

    // coc_getDaoProposals — non-string/non-object filter must reject.
    for (const bad of [true, false, 42, [1, 2]]) {
      const r = await probe("coc_getDaoProposals", [bad])
      assert.equal(r.error?.code, -32602,
        `coc_getDaoProposals(${JSON.stringify(bad)}) must be -32602 (not silent []), got ${JSON.stringify(r)}`)
    }
    // Bad nested shape must also reject.
    {
      const r = await probe("coc_getDaoProposals", [{ status: 42 }])
      assert.equal(r.error?.code, -32602,
        `coc_getDaoProposals({status:42}) must reject, got ${JSON.stringify(r)}`)
    }
    {
      const r = await probe("coc_getDaoProposals", [])
      assert.equal(r.error, undefined, `coc_getDaoProposals([]) without governance must return empty array`)
      assert.deepEqual(r.result, [])
    }

    // coc_getFaction — non-string / non-0x-prefix address must reject.
    for (const bad of [[], [null], [42], [true], [{}], [[1, 2]], ["not-0x-prefixed"]]) {
      const r = await probe("coc_getFaction", bad)
      assert.equal(r.error?.code, -32602,
        `coc_getFaction(${JSON.stringify(bad)}) must be -32602 (not silent null), got ${JSON.stringify(r)}`)
    }
    // #505: malformed-but-0x-prefixed addresses must ALSO reject — pre-fix
    // the loose `startsWith("0x")` check accepted any prefixed string and
    // silently returned null (indistinguishable from "real address, no
    // faction"). requireAddressParam enforces the 40-char shape.
    for (const bad of ["0x", "0x123", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb9226", /* 39 chars */
                        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb922665", /* 41 chars */
                        "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"]) {
      const r = await probe("coc_getFaction", [bad])
      assert.equal(r.error?.code, -32602,
        `coc_getFaction("${bad}") must be -32602 (malformed address), got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /invalid address/i,
        `coc_getFaction error must mention "invalid address", got "${r.error!.message}"`)
    }
    // Sanity: valid address shape returns null (not error) without governance.
    {
      const r = await probe("coc_getFaction", ["0x0000000000000000000000000000000000000001"])
      assert.equal(r.error, undefined, `coc_getFaction(valid_address) without governance must return null`)
      assert.equal(r.result, null)
    }
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

  await t.test("#452: synthesised genesis block matches non-genesis block shape (Cancun fields + empty-trie roots)", async () => {
    // Pre-fix:
    //   - transactionsRoot / receiptsRoot were ZERO_HASH instead of the
    //     canonical empty-trie root (rlp(empty) keccak). Geth/erigon use
    //     EMPTY_TRIE_ROOT for empty blocks; some validity checkers reject
    //     zero roots, and shape diff vs block 1 broke ethers' block parser.
    //   - withdrawals / withdrawalsRoot / blobGasUsed / excessBlobGas /
    //     parentBeaconBlockRoot were missing entirely; every post-Cancun
    //     block on the chain has them. Shape bifurcation broke clients.
    //   - `uncles` was emitted only on genesis; non-genesis blocks omit it.
    //   - `finalized` was missing; genesis is by definition finalized.
    const proposed = await chain.proposeNextBlock()
    assert.ok(proposed, "need at least one real block")
    const genesis = await rpcCall(port, "eth_getBlockByNumber", ["earliest", false]) as Record<string, unknown>
    const block1 = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as Record<string, unknown>

    // 1. Empty-trie roots, not zero hash.
    const EMPTY_TRIE_ROOT = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
    assert.equal(
      genesis.transactionsRoot, EMPTY_TRIE_ROOT,
      "genesis transactionsRoot must be EMPTY_TRIE_ROOT (not zero hash) — required for spec-strict validators",
    )
    assert.equal(
      genesis.receiptsRoot, EMPTY_TRIE_ROOT,
      "genesis receiptsRoot must be EMPTY_TRIE_ROOT",
    )

    // 2. Cancun post-fork fields must be present on genesis (so the
    // response shape matches block 1+ — bifurcation breaks block parsers).
    assert.equal(genesis.blobGasUsed, "0x0", "genesis.blobGasUsed must be present (matches Cancun blocks)")
    assert.equal(genesis.excessBlobGas, "0x0", "genesis.excessBlobGas must be present")
    assert.deepEqual(genesis.withdrawals, [], "genesis.withdrawals must be present (empty)")
    assert.equal(
      genesis.withdrawalsRoot, EMPTY_TRIE_ROOT,
      "genesis.withdrawalsRoot must be present (empty trie root)",
    )
    assert.equal(
      genesis.parentBeaconBlockRoot, "0x" + "0".repeat(64),
      "genesis.parentBeaconBlockRoot must be present (zero hash)",
    )
    assert.equal(genesis.finalized, true, "genesis must be finalized=true (it's the oldest block)")

    // 3. Field-set parity with non-genesis (no `uncles` only on genesis).
    assert.ok(!("uncles" in genesis), "uncles must NOT be on genesis (chain is post-PoW)")
    assert.ok(!("uncles" in block1), "uncles must NOT be on non-genesis either (consistency)")

    // 4. Genesis must declare every field block 1 does. Difference set must
    // be empty modulo totalDifficulty (some chains omit it on later blocks).
    const block1Keys = new Set(Object.keys(block1))
    const genesisKeys = new Set(Object.keys(genesis))
    const missingFromGenesis = [...block1Keys].filter((k) => !genesisKeys.has(k))
    assert.deepEqual(
      missingFromGenesis, [],
      `genesis missing keys present in block 1: ${missingFromGenesis.join(", ")} (shape bifurcation)`,
    )
  })

  await t.test("#422: eth_getBlockByHash(ZERO_HASH) returns the same synthesised genesis (parity with eth_getBlockByNumber)", async () => {
    // Pre-fix: eth_getBlockByNumber("0x0") synthesised a genesis block
    // with hash = all-zeros (#112). Block 1's parentHash carried the
    // same all-zeros value. But eth_getBlockByHash lacked the
    // symmetric synthesis path — a client that grabbed block 1,
    // followed parentHash, and called `provider.getBlock(parentHash)`
    // got `null` and broke. Mirror #112 so both lookups agree.
    //
    // Live testnet 88780 reproduction (pre-fix):
    //   getBlockByNumber("0x0")  → hash 0x000…000 (synthesised)
    //   getBlockByHash(0x000…000) → null   (asymmetric!)
    const proposed = await chain.proposeNextBlock()
    assert.ok(proposed, "need at least one real block so height ≥ 1")
    const ZERO_HASH = "0x" + "0".repeat(64)
    const byNum = await rpcCall(port, "eth_getBlockByNumber", ["0x0", false]) as Record<string, unknown>
    assert.equal(byNum.hash, ZERO_HASH, "synthesised genesis hash must be all-zeros (sanity)")
    const byHash = await rpcCall(port, "eth_getBlockByHash", [ZERO_HASH, false]) as Record<string, unknown> | null
    assert.ok(byHash !== null, "eth_getBlockByHash(ZERO_HASH) must not be null when synth-genesis is on")
    assert.equal(byHash!.number, "0x0", "by-hash genesis must have number 0x0")
    assert.equal(byHash!.hash, ZERO_HASH, "by-hash genesis hash must match by-number")
    assert.equal(byHash!.parentHash, ZERO_HASH)
    assert.deepEqual(byHash!.transactions, [])
    // Sanity: a non-zero hash that doesn't exist still returns null
    const fakeHash = "0x" + "ab".repeat(32)
    const nullResult = await rpcCall(port, "eth_getBlockByHash", [fakeHash, false])
    assert.equal(nullResult, null, "non-zero non-existent hash must still return null")
    // Sanity: includeTx=true also works through synthesis
    const byHashWithTx = await rpcCall(port, "eth_getBlockByHash", [ZERO_HASH, true]) as Record<string, unknown>
    assert.ok(byHashWithTx !== null)
    assert.deepEqual(byHashWithTx.transactions, [])
    // Symmetric reachability: block 1's parentHash points to the
    // synthesised genesis and a client can follow it.
    const block1 = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as Record<string, unknown>
    assert.equal(block1.parentHash, ZERO_HASH, "block 1 parentHash anchors to synth genesis (sanity)")
    const parent = await rpcCall(port, "eth_getBlockByHash", [block1.parentHash, false]) as Record<string, unknown>
    assert.ok(parent !== null, "client following block1.parentHash must reach the genesis (not null)")
  })

  await t.test("#384: state-query RPCs return defaults at synth-genesis instead of -32001 block-not-found", async () => {
    // Pre-fix: #112 carved a synth-genesis path for eth_getBlockByNumber("earliest")
    // but the state-query RPCs (eth_getBalance/Code/TxCount/StorageAt/call/...)
    // still threw -32001 "block not found: earliest" because their helper
    // resolveHistoricalExecutionContext had no parallel fallback. Wallet
    // probes (ethers/viem) hitting earliest balance during the JSON-RPC
    // handshake broke immediately. Match geth/anvil at an empty-allocs
    // genesis: zero balance, no code, nonce 0, zero storage, "0x" return.
    const proposed = await chain.proposeNextBlock()
    assert.ok(proposed, "need at least one real block so height ≥ 1")

    const TEST_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const ZERO_HASH32 = "0x" + "0".repeat(64)
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000"

    // Cover all five shapes the issue calls out: "earliest", "0x0",
    // and the three EIP-1898 object forms ({blockNumber: "0x0"}). The
    // bare-hash and {blockHash} forms target a real block so they
    // legitimately fail at synth-genesis (no hash to look up) and are
    // not part of this fix.
    const SYNTH_GENESIS_TAGS: Array<string | { blockNumber: string }> = [
      "earliest",
      "0x0",
      { blockNumber: "0x0" },
    ]

    for (const tag of SYNTH_GENESIS_TAGS) {
      const label = typeof tag === "string" ? tag : JSON.stringify(tag)

      const balance = await rpcCall(port, "eth_getBalance", [TEST_ADDR, tag])
      assert.equal(balance, "0x0", `eth_getBalance @ ${label} must be 0x0 at synth-genesis`)

      const code = await rpcCall(port, "eth_getCode", [TEST_ADDR, tag])
      assert.equal(code, "0x", `eth_getCode @ ${label} must be "0x" at synth-genesis`)

      const nonce = await rpcCall(port, "eth_getTransactionCount", [TEST_ADDR, tag])
      assert.equal(nonce, "0x0", `eth_getTransactionCount @ ${label} must be 0x0 at synth-genesis`)

      const slot = await rpcCall(port, "eth_getStorageAt", [TEST_ADDR, "0x0", tag])
      assert.equal(slot, ZERO_HASH32, `eth_getStorageAt @ ${label} must be 32-byte zero at synth-genesis`)

      // eth_call against an empty-allocs genesis: no contracts deployed,
      // returns empty bytes (matches geth/anvil).
      const callResult = await rpcCall(port, "eth_call", [
        { to: ZERO_ADDR, data: "0x" },
        tag,
      ])
      assert.equal(callResult, "0x", `eth_call @ ${label} must return "0x" at synth-genesis`)

      // eth_estimateGas: intrinsic-gas floor (21k for value-transfer, 53k
      // for contract creation). Anvil returns the floor rather than -32001.
      const estimateGas = await rpcCall(port, "eth_estimateGas", [
        { to: ZERO_ADDR, value: "0x0" },
        tag,
      ])
      assert.equal(estimateGas, "0x5208", `eth_estimateGas @ ${label} must be intrinsic 21000 (0x5208)`)

      const estimateGasCreate = await rpcCall(port, "eth_estimateGas", [
        { data: "0x60006000fd" },
        tag,
      ])
      assert.equal(estimateGasCreate, "0xcf08", `eth_estimateGas (creation) @ ${label} must be intrinsic 53000 (0xcf08)`)

      // eth_createAccessList: empty list + intrinsic-gas at synth-genesis.
      const accessList = await rpcCall(port, "eth_createAccessList", [
        { to: ZERO_ADDR, data: "0x" },
        tag,
      ]) as { accessList: unknown[]; gasUsed: string }
      assert.deepEqual(accessList.accessList, [], `eth_createAccessList @ ${label} must be empty at synth-genesis`)
      assert.equal(accessList.gasUsed, "0x5208", `eth_createAccessList gasUsed @ ${label} must be 0x5208`)
    }

    // Sanity: eth_getBlockByNumber("earliest") still works (the #112 path
    // we're mirroring). Cross-method symmetry: state queries succeed at
    // the same tag that block lookups already do.
    const earliestBlock = await rpcCall(port, "eth_getBlockByNumber", ["earliest", false]) as Record<string, unknown> | null
    assert.ok(earliestBlock !== null, "eth_getBlockByNumber('earliest') still works")
    assert.equal(earliestBlock!.number, "0x0")
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

  await t.test("#471: eth_getProof slot regex parity with eth_getStorageAt — reject empty \"0x\"", async () => {
    // eth_getProof slot regex was /^[0-9a-fA-F]*$/ (note the *), so an
    // empty slot key "0x" silently normalized to slot 0. eth_getStorageAt
    // uses /^0x[0-9a-fA-F]{1,64}$/ and rejects "0x" with -32602. Two
    // sibling endpoints diverging on storage-slot validation is the same
    // class as #124/#128 (eth_call vs eth_estimateGas address-regex
    // divergence). Live testnet 88780 repro on /eth_getProof showed
    // status: result with slot 0 padding, masking ethers.toBeHex(undefined)
    // → "0x" bugs in clients.
    const validAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const probe = async (slot: string): Promise<{ error?: { code: number; message: string }; result?: unknown }> => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getProof",
          params: [validAddr, [slot], "latest"],
        }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }

    // Empty hex is invalid for both endpoints post-fix.
    const emptyProof = await probe("0x")
    assert.equal(emptyProof.error?.code, -32602, `eth_getProof("0x") must be -32602 (got ${JSON.stringify(emptyProof)})`)
    assert.match(emptyProof.error?.message ?? "", /invalid storage key/i)

    const emptyStor = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: [validAddr, "0x", "latest"] }),
    })
    const emptyStorJson = await emptyStor.json() as { error?: { code: number; message: string } }
    assert.equal(emptyStorJson.error?.code, -32602, "eth_getStorageAt(\"0x\") parity check")

    // Non-hex characters and overflow both stay rejected.
    const overflow = await probe("0x" + "0".repeat(65))
    assert.equal(overflow.error?.code, -32602, "65-char slot must be -32602")
    const nonHex = await probe("0xZZ")
    assert.equal(nonHex.error?.code, -32602, "non-hex slot must be -32602")

    // Sanity: well-shaped short hex passes the slot validator. The fixture's
    // in-memory EVM doesn't expose proofs — pre-#601 returned -32603
    // "requires proof-capable persistent state manager", post-#601 returns
    // -32601 "eth_getProof is not available" (anvil/erigon parity, no
    // internal class names leaked). Either way, NOT -32602 — the validator
    // gate let the request through.
    const shortValid = await probe("0x1")
    assert.notEqual(shortValid.error?.code, -32602, `shortValid must clear validator (got ${JSON.stringify(shortValid)})`)
    const mixedCase = await probe("0xAb")
    assert.notEqual(mixedCase.error?.code, -32602, "mixed-case hex must clear validator")
  })

  await t.test("#601: eth_getProof unsupported backend returns -32601 (was -32603 + class-name leak)", async () => {
    // Pre-fix: in-memory EVM (or any backend without proof-capable state
    // manager) threw a plain Error → -32603 internal error with message
    //   "eth_getProof requires proof-capable persistent state manager support"
    // which (a) misled clients into thinking the request itself broke
    // something internal, and (b) leaked the state-manager class name
    // (same info-disclosure family as #156/#176/#182/#505/#507).
    // anvil + erigon return -32601 ("method not available") when their
    // backend doesn't support a method; match that contract.
    const validAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_getProof",
        params: [validAddr, ["0x0"], "latest"],
      }),
    })
    const json = await r.json() as { error?: { code: number; message: string } }
    assert.equal(json.error?.code, -32601,
      `unsupported backend must be -32601 method-not-available, got ${json.error?.code}: ${json.error?.message}`)
    // Clean message — no class names, no implementation details.
    assert.doesNotMatch(json.error!.message,
      /persistent state manager|PersistentStateManager|StateManager/i,
      "must not leak internal class/type names")
    assert.match(json.error!.message, /eth_getProof|not available|not supported/i,
      "must name the method or the unavailability")
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
    // #432: shape-valid args still hit the -32601 path (DID resolver not
    // configured); garbage input (empty params) gets -32602 via the new
    // validate-before-config-check ordering.
    for (const method of ["coc_resolveDid", "coc_getDIDDocument"]) {
      const j = await probeError(method, ["did:coc:agent-shape-valid"])
      assert.ok(j.error)
      assert.equal(j.error!.code, -32601, `${method} with valid shape must be -32601 when not configured, got ${j.error!.code}`)
    }
  })

  await t.test("#432: DID/governance handlers validate input BEFORE the backend-not-configured check", async () => {
    // Pre-fix the `if (!didResolver) methodNotFound(...)` /
    // `if (!hasGovernance) methodNotFound(...)` short-circuit ran BEFORE
    // `requireStringParam` in 10 handlers. On every read-only fullnode
    // (the entire testnet 88780 RPC surface) garbage input got the
    // misleading -32601 "not configured" instead of -32602 "invalid
    // params". Same anti-pattern as #424 (reward handlers).
    //
    // This fixture has no didResolver / didDataProvider / governance
    // configured (the default test shape), so these handlers HIT the
    // backend-config check in the wild. With the fix, garbage gets
    // -32602 first; shape-valid input gets -32601 after.
    const probeError = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { result?: unknown; error?: { code: number; message: string } }
    }
    // (a) Single-string-arg handlers: empty/numeric/boolean → -32602
    const stringArgMethods = [
      "coc_resolveDid",
      "coc_getDIDDocument",
      "coc_getAgentCapabilities",
      "coc_getDelegations",
      "coc_getAgentLineage",
      "coc_getVerificationMethods",
      "coc_getCredentialAnchor",
    ]
    for (const method of stringArgMethods) {
      for (const bad of [[], [null], [42], [true], [{}], [[1, 2]]]) {
        const j = await probeError(method, bad)
        assert.ok(j.error, `${method}(${JSON.stringify(bad)}) must error`)
        assert.equal(j.error!.code, -32602,
          `${method}(${JSON.stringify(bad)}) must be -32602 (was -32601 pre-fix), got ${j.error!.code}`)
      }
      // Shape-valid → -32601 (backend not configured)
      const ok = await probeError(method, ["agent-shape-valid"])
      assert.equal(ok.error?.code, -32601,
        `${method}("agent-shape-valid") must be -32601 (not configured), got ${JSON.stringify(ok)}`)
    }
    // (b) coc_getDaoProposal: proposalId is string. Same garbage shapes.
    for (const bad of [[], [null], [42], [true], [""]]) {
      const j = await probeError("coc_getDaoProposal", bad)
      assert.equal(j.error?.code, -32602,
        `coc_getDaoProposal(${JSON.stringify(bad)}) must be -32602, got ${j.error?.code}`)
    }
    const okDao = await probeError("coc_getDaoProposal", ["valid-id"])
    assert.equal(okDao.error?.code, -32601,
      `coc_getDaoProposal("valid-id") must be -32601 (governance not enabled), got ${JSON.stringify(okDao)}`)
    // (c) coc_submitProposal / coc_voteProposal: first param must be object.
    for (const method of ["coc_submitProposal", "coc_voteProposal"]) {
      for (const bad of [[], [null], ["not-object"], [42], [[1, 2]]]) {
        const j = await probeError(method, bad)
        assert.equal(j.error?.code, -32602,
          `${method}(${JSON.stringify(bad)}) must be -32602, got ${j.error?.code}`)
      }
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

  await t.test("#563: eth_call/estimateGas/createAccessList honor input as data alias (viem/ethers v6 parity)", async () => {
    // Pre-fix `input` (the canonical Ethereum JSON-RPC field since 2019)
    // was silently dropped: every call-site read only `callParams.data`.
    // viem/ethers v6/web3.js v5+ emit only `input`, so every modern dApp
    // got eth_call executed against EMPTY calldata. Silent-param-drop
    // family with #174/#353/#553/#559 but worst impact (modern default).
    //
    // SHA-256 precompile lives at 0x…02; result == sha256(calldata).
    // sha256(0xdeadbeef) = 0x5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953
    const sha256Precompile = "0x0000000000000000000000000000000000000002"
    const from = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    const sha256Deadbeef = "0x5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953"
    const sha256Empty = "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    // (1) input alone is honored as the calldata
    const inputOnly = await rpcCall(port, "eth_call", [{ from, to: sha256Precompile, input: "0xdeadbeef" }, "latest"])
    assert.strictEqual(inputOnly, sha256Deadbeef,
      `input-only must compute sha256(0xdeadbeef), got ${inputOnly} (would be ${sha256Empty} if input was silently dropped)`)

    // (2) data alone still works (no regression)
    const dataOnly = await rpcCall(port, "eth_call", [{ from, to: sha256Precompile, data: "0xdeadbeef" }, "latest"])
    assert.strictEqual(dataOnly, sha256Deadbeef, `data-only must still compute sha256(0xdeadbeef), got ${dataOnly}`)

    // (3) matching values both set → accepted (no mismatch error)
    const both = await rpcCall(port, "eth_call", [{ from, to: sha256Precompile, input: "0xdeadbeef", data: "0xdeadbeef" }, "latest"])
    assert.strictEqual(both, sha256Deadbeef, `matching input+data must work, got ${both}`)

    // (4) mismatch → -32602 (geth parity, no silent "data wins")
    const r = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ from, to: sha256Precompile, input: "0xdeadbeef", data: "0x12345678" }, "latest"],
      }),
    })
    const mismatchJson = await r.json() as { error?: { code: number; message: string }; result?: unknown }
    assert.equal(mismatchJson.error?.code, -32602,
      `input/data mismatch must reject with -32602, got ${JSON.stringify(mismatchJson)}`)
    assert.match(mismatchJson.error!.message, /input.*data|data.*input|different/i,
      `error must name both fields, got ${mismatchJson.error!.message}`)

    // (5) malformed input gets the same validation gate as data
    const badInput = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ from, to: sha256Precompile, input: "not-hex" }, "latest"],
      }),
    })
    const badInputJson = await badInput.json() as { error?: { code: number; message: string } }
    assert.equal(badInputJson.error?.code, -32602, `malformed input must -32602, got ${JSON.stringify(badInputJson)}`)
    assert.match(badInputJson.error!.message, /invalid input/i, "error must name input field")

    // (6) parity covers eth_estimateGas + eth_createAccessList (every call-shape method)
    const estG = await rpcCall(port, "eth_estimateGas", [{ from, to: sha256Precompile, input: "0xdeadbeef" }])
    assert.match(estG as string, /^0x[0-9a-f]+$/i, "estimateGas with input only must succeed")
    const acl = await rpcCall(port, "eth_createAccessList", [{ from, to: sha256Precompile, input: "0xdeadbeef" }, "latest"]) as Record<string, unknown>
    assert.ok(Array.isArray(acl.accessList), "createAccessList with input only must succeed")
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

  await t.test("#521: eth_signTypedData_v4 validates typedData structure before keystore (parity with eth_sign)", async () => {
    // Live testnet 88780 reproduction (pre-fix):
    //   eth_sign(unauthorized_addr, "garbage-msg")              → -32602 (msg shape)
    //   eth_signTypedData_v4(unauthorized_addr, malformed_td)   → -32004 (keystore)
    //
    // Same problem space (signing), inconsistent validation order. Callers
    // can't reliably tell from the response code whether their typedData
    // shape is wrong — they'd need to ALSO verify keystore presence (which
    // varies between dev / test / prod environments). Pre-fix a script
    // probing typedData shape would get different errors depending on
    // whether the address happens to be in the dev keystore.
    //
    // Fix: do the cheap shape-validation upfront (mirroring eth_sign's
    // order). TypedDataEncoder.hash() is the canonical EIP-712 structural
    // validator; failed encoding signals malformed typedData. Keystore
    // lookup runs after.
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_signTypedData_v4", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    const unknownAddr = "0x" + "9".repeat(40)
    // (a) Malformed typedData (TypedDataEncoder rejects: no primaryType,
    // unresolvable type ref) — must surface as -32602 even though
    // the address isn't in the keystore. Pre-fix the keystore check
    // ran first → caller saw -32004 and never learned their typedData
    // shape was broken.
    const noPrimaryType = await probe([unknownAddr, { types: {}, domain: {}, message: {} }])
    assert.equal(noPrimaryType.error?.code, -32602,
      `malformed typedData on unauthorized addr must be -32602 (shape first), got ${noPrimaryType.error?.code} (${noPrimaryType.error?.message})`)
    assert.match(noPrimaryType.error!.message, /invalid typedData/i,
      `error must mention typedData, not keystore: ${noPrimaryType.error!.message}`)
    // (b) Shape-valid typedData + unauthorized addr → -32004 (keystore).
    // This is the post-shape-check path; ensures keystore check still runs.
    const okTd = {
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Message: [{ name: "x", type: "uint256" }],
      },
      primaryType: "Message",
      domain: { name: "test" },
      message: { x: 42 },
    }
    const goodTd = await probe([unknownAddr, okTd])
    assert.equal(goodTd.error?.code, -32004,
      `shape-valid typedData on unauthorized addr must be -32004 (keystore), got ${goodTd.error?.code} (${goodTd.error?.message})`)
    assert.match(goodTd.error!.message, /keystore/i,
      `error must mention keystore, not typedData: ${goodTd.error!.message}`)
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

  await t.test("#599: eth_feeHistory rejects newestBlock beyond chain head (was fabricating future-block data)", async () => {
    // Pre-fix: requesting newestBlock = 0xffffffffff (future) silently
    // produced `blockCount` entries labelled with the requested future
    // numbers, all carrying baseFeePerGas=baseline / gasUsedRatio=0 /
    // reward=[]. A client wiring this into a fee-prediction heuristic
    // would think mainnet had crashed into a deflation spiral. Geth
    // rejects unknown blocks; we reject with -32602 because the
    // request itself names a block that doesn't exist yet.
    const probe = async (newest: unknown, count: unknown = "0x4") => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_feeHistory", params: [count, newest, []] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // (a) Future block — reject.
    const future = await probe("0xffffffffff")
    assert.equal(future.error?.code, -32602, `future newestBlock must be -32602, got ${future.error?.code}: ${JSON.stringify(future.result)}`)
    assert.match(future.error!.message, /beyond chain head|newestBlock/i, "error must name newestBlock")
    // (b) "latest" / "pending" tags MUST still work (they're not "beyond" head).
    const ok1 = await probe("latest")
    assert.equal(ok1.error, undefined, `'latest' must not error: ${JSON.stringify(ok1.error)}`)
    const ok2 = await probe("pending")
    assert.equal(ok2.error, undefined, `'pending' must not error: ${JSON.stringify(ok2.error)}`)
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

  await t.test("#602: eth_call/eth_estimateGas reject non-empty stateOverride + bogus shapes", async () => {
    // Pre-fix `params[2]` (geth-style stateOverride) was silently
    // dropped at every shape:
    //   - non-empty object: result computed against UNMODIFIED state,
    //     and the response shape looked normal — Tenderly/viem
    //     `eth_call(..., overrides)` callers got authoritative-looking
    //     wrong answers.
    //   - string/array/garbage: same silent acceptance, same wrong-state
    //     simulation.
    // Same silent-success family as #172/#238/#192. anvil/erigon reject
    // backend-unsupported features with -32601; geth honours the param.
    // We don't (yet) honour overrides, so reject explicitly so callers
    // fall back rather than trust a misleading result.
    const validTx = { from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", to: "0x" + "ab".repeat(20) }
    const probe = async (method: string, override: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [validTx, "latest", override] }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    for (const method of ["eth_call", "eth_estimateGas"]) {
      // (a) Non-empty override → -32601 backend-not-supported.
      const nonEmpty = await probe(method, { [validTx.to]: { code: "0xab" } })
      assert.equal(nonEmpty.error?.code, -32601,
        `${method} non-empty override must be -32601, got ${nonEmpty.error?.code}: ${JSON.stringify(nonEmpty.error)}`)
      assert.match(nonEmpty.error!.message, /stateOverride|not supported/i,
        `${method} error must name stateOverride or unavailability`)
      // (b) String override (bogus shape) → -32602 invalid shape.
      const stringOverride = await probe(method, "not an object")
      assert.equal(stringOverride.error?.code, -32602,
        `${method} string override must be -32602, got ${stringOverride.error?.code}`)
      assert.match(stringOverride.error!.message, /expected object/i)
      // (c) Array override (bogus shape) → -32602.
      const arrayOverride = await probe(method, [1, 2, 3])
      assert.equal(arrayOverride.error?.code, -32602,
        `${method} array override must be -32602, got ${arrayOverride.error?.code}`)
      // (d) Empty object override → still allowed (spec-permissive).
      const emptyOverride = await probe(method, {})
      assert.notEqual(emptyOverride.error?.code, -32601,
        `${method} empty override must NOT reject as -32601`)
      assert.notEqual(emptyOverride.error?.code, -32602,
        `${method} empty override must NOT reject as -32602`)
      // (e) Missing 3rd param entirely → no error (back-compat).
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [validTx, "latest"] }),
      })
      const noOverride = await r.json() as { error?: { code: number; message: string } }
      assert.notEqual(noOverride.error?.code, -32601,
        `${method} without override (2-arg) must NOT reject`)
    }
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

  await t.test("#184/#606: coc_chainStats does not crash + chainId matches eth_chainId (no '0x1' lie)", async () => {
    // #184 (original): pre-fix `chain.cfg.chainId.toString(16)` assumed
    // chainId was always set, but ChainEngineConfig.chainId is optional
    // in the type. Bare undefined.toString() leaked as
    //   -32603 "Cannot read properties of undefined (reading 'toString')"
    // The fix landed `?? "1"` literal fallback.
    //
    // #606 (this PR): the "1" literal silently lied — same node returned
    // chainId `0x1` from coc_chainStats and the real chainId (e.g.
    // `0x495c` = 18780) from eth_chainId. Two endpoints disagreed about
    // which chain you're on, breaking client connection-validation
    // logic that compares the two. Replace the literal with the RPC
    // handler's `chainId` parameter (canonical source for eth_chainId).
    //
    // This fixture deliberately does NOT pass chainId to ChainEngine
    // (see line 38-48), so chain.cfg.chainId is undefined — direct
    // repro for both bugs.
    const stats = await rpcCall(port, "coc_chainStats") as Record<string, unknown>
    assert.ok(typeof stats === "object" && stats !== null, "must return an object")
    // The two endpoints must agree.
    const ethChainId = await rpcCall(port, "eth_chainId") as string
    assert.equal(stats.chainId, ethChainId,
      `coc_chainStats.chainId (${stats.chainId}) must match eth_chainId (${ethChainId}) — same node, same chain`)
    assert.notEqual(stats.chainId, "0x1",
      `chainId must NOT fall back to the literal "0x1" — that was the #184 bug fallback that lied`)
    assert.ok(typeof stats.blockHeight === "string", "blockHeight must be hex")
    assert.ok(typeof stats.validatorCount === "number", "validatorCount must be number")
    // Defend against V8 leak in error path.
    assert.doesNotMatch(JSON.stringify(stats), /Cannot read properties|undefined.*reading/, "must not leak TypeError")
  })

  await t.test("#479: coc_chainStats pendingTxCount matches txpool_status.pending semantic (not raw mempool size)", async () => {
    // Pre-fix `coc_chainStats.pendingTxCount = chain.mempool.stats().size`
    // returned the total mempool size — pending + queued lumped together.
    // Meanwhile txpool_status correctly split pending (contiguous-from-
    // onchain-nonce) and queued (gap-nonce) per #386. The two endpoints
    // from the same node disagreed on what "pending" meant.
    //
    // Live testnet 88780 reproduction (server-1):
    //   coc_chainStats → {"pendingTxCount":65,...}
    //   txpool_status  → {"pending":"0x0","queued":"0x41"}    (0x41 = 65)
    // → all 65 txs were stuck gap-queued, none includable now, yet the
    //   explorer dashboard showed "Pending Txs: 65" misleading users.
    //
    // Fix: pendingTxCount adopts geth semantic (includable-now only),
    // adds queuedTxCount + mempoolSize as separate fields. Build a gap-
    // queued tx in the fixture and verify the new split.
    const { Wallet: EthersWallet, Transaction: EthersTransaction } = await import("ethers")
    const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    const wallet = new EthersWallet(TEST_PK)

    const startNonce = parseInt(
      await rpcCall(port, "eth_getTransactionCount", [wallet.address, "latest"]) as string,
      16,
    )
    // Skip the next contiguous nonce, inject one at startNonce + 5 → gap-queued.
    const tx = EthersTransaction.from({
      to: "0x0000000000000000000000000000000000000001",
      value: 1n, gasLimit: 21000n, gasPrice: 1_000_000_000n,
      nonce: startNonce + 5, chainId: 18780,
    })
    const signed = await wallet.signTransaction(tx)
    await rpcCall(port, "eth_sendRawTransaction", [signed])

    const stats = await rpcCall(port, "coc_chainStats") as {
      pendingTxCount: number
      queuedTxCount: number
      mempoolSize: number
    }

    // The injected tx is gap-queued (nonce gap of 5), so:
    //   pendingTxCount  == 0  (nothing contiguous from on-chain nonce)
    //   queuedTxCount   >= 1  (at least our injected gap tx)
    //   mempoolSize     >= 1
    assert.equal(typeof stats.pendingTxCount, "number", "pendingTxCount must be number")
    assert.equal(typeof stats.queuedTxCount, "number", "queuedTxCount must be number (new field)")
    assert.equal(typeof stats.mempoolSize, "number", "mempoolSize must be number (new field)")
    assert.equal(stats.pendingTxCount, 0, `gap-queued tx must not count as pending, got ${stats.pendingTxCount}`)
    assert.ok(stats.queuedTxCount >= 1, `gap-queued tx must count as queued, got ${stats.queuedTxCount}`)
    assert.equal(
      stats.mempoolSize,
      stats.pendingTxCount + stats.queuedTxCount,
      "mempoolSize must equal pending + queued",
    )

    // Cross-check parity with txpool_status (both endpoints must agree
    // on the split now).
    const status = await rpcCall(port, "txpool_status") as { pending: string; queued: string }
    assert.equal(
      parseInt(status.pending, 16),
      stats.pendingTxCount,
      `coc_chainStats.pendingTxCount (${stats.pendingTxCount}) must match txpool_status.pending (${parseInt(status.pending, 16)})`,
    )
    assert.equal(
      parseInt(status.queued, 16),
      stats.queuedTxCount,
      `coc_chainStats.queuedTxCount (${stats.queuedTxCount}) must match txpool_status.queued (${parseInt(status.queued, 16)})`,
    )
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

  await t.test("#499: eth_getBlockTransactionCountByNumber / eth_feeHistory don't leak [object Object] from String() coercion", async () => {
    // Pre-fix both endpoints used `String((payload.params)[N] ?? "latest")`
    // which V8-stringifies any object to "[object Object]", surfacing as
    // -32602 "invalid block number: [object Object]" — both broken shape
    // handling AND leaks the V8 toString output (same anti-pattern as
    // #194/#220/#226/#497). debug_getRawBlock / debug_getRawReceipts
    // shared the same bug behind the COC_DEBUG_RPC gate.
    //
    // Live testnet 88780 repro:
    //   eth_getBlockTransactionCountByNumber [{"blockNumber":"0x1"}]
    //     → -32602 "invalid block number: [object Object]"  ← BUG
    //   eth_feeHistory ["0x5", {"blockNumber":"0x1"}, []]
    //     → -32602 "invalid block number: [object Object]"  ← BUG
    //
    // Fix routes the raw param through parseBlockTag (which already
    // handles unknown shapes properly, per #194).
    const probe = async (method: string, params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }

    // eth_getBlockTransactionCountByNumber: object input → structured -32602, no [object Object] leak.
    const tcByObj = await probe("eth_getBlockTransactionCountByNumber", [{ blockNumber: "0x1" }])
    assert.doesNotMatch(
      JSON.stringify(tcByObj),
      /\[object Object\]/,
      `eth_getBlockTransactionCountByNumber must NOT leak [object Object], got ${JSON.stringify(tcByObj)}`,
    )
    assert.equal(tcByObj.error?.code, -32602)
    assert.match(tcByObj.error!.message, /invalid block tag|must be hex/i)

    // eth_feeHistory: object as newestBlock — must reject with structured error, no leak.
    const fhByObj = await probe("eth_feeHistory", ["0x5", { blockNumber: "0x1" }, []])
    assert.doesNotMatch(
      JSON.stringify(fhByObj),
      /\[object Object\]/,
      `eth_feeHistory must NOT leak [object Object], got ${JSON.stringify(fhByObj)}`,
    )
    assert.equal(fhByObj.error?.code, -32602)

    // Sanity: hex quantity still works.
    const tcByHex = await probe("eth_getBlockTransactionCountByNumber", ["0x0"])
    assert.equal(tcByHex.error, undefined, `eth_getBlockTransactionCountByNumber("0x0") must succeed, got ${JSON.stringify(tcByHex)}`)

    // Sanity: tag still works.
    const tcByTag = await probe("eth_getBlockTransactionCountByNumber", ["latest"])
    assert.equal(tcByTag.error, undefined, "eth_getBlockTransactionCountByNumber(latest) must succeed")

    // Sanity: omitted/null param → "latest" (preserve prior contract).
    const tcByNull = await probe("eth_getBlockTransactionCountByNumber", [null])
    assert.equal(tcByNull.error, undefined, "eth_getBlockTransactionCountByNumber(null) must default to latest")

    // Array shape rejected with structured -32602, NO leak.
    const tcByArr = await probe("eth_getBlockTransactionCountByNumber", [["0x1"]])
    assert.doesNotMatch(JSON.stringify(tcByArr), /\[object Object\]/, "array input must not leak")
    assert.equal(tcByArr.error?.code, -32602, `array input must be -32602, got ${JSON.stringify(tcByArr)}`)

    // Bool shape rejected.
    const tcByBool = await probe("eth_getBlockTransactionCountByNumber", [true])
    assert.equal(tcByBool.error?.code, -32602)
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

  await t.test("#296: coc_submitProposal rejects non-string type/targetId/proposer/targetAddress (no Record-cast no-op)", async () => {
    // Pre-fix `rawParams as Record<string, string>` was a TypeScript
    // runtime no-op. Any field shape (number, boolean, array, object)
    // silently flowed through to chain.governance.submitProposal(). The
    // resulting proposal record stored non-string values in string slots;
    // downstream filters / serializers either rejected with -32603 V8
    // errors or echoed the coerced garbage back. Same anti-pattern as
    // #551 (coc_voteProposal field strict validation); same validation-
    // order rule as #432/#538.
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
        assert.match(rType.error!.message, /type/i)
        const rTarget = await probe([{ ...base, targetId: bad }])
        assert.equal(rTarget.error?.code, -32602,
          `targetId=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(rTarget)}`)
        const rProposer = await probe([{ ...base, proposer: bad }])
        assert.equal(rProposer.error?.code, -32602,
          `proposer=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(rProposer)}`)
      }
      // targetAddress is optional but when present must be a string
      for (const bad of [123, true, [], {}]) {
        const r = await probe([{ ...base, targetAddress: bad }])
        assert.equal(r.error?.code, -32602,
          `targetAddress=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
        assert.match(r.error!.message, /targetAddress/i)
      }
      // Sanity: well-shaped payload still reaches the stub
      submittedCalls.length = 0
      const ok = await probe([{ ...base, targetAddress: "0xabc" }])
      assert.equal(ok.error, undefined, `well-shaped submit must succeed, got ${JSON.stringify(ok)}`)
      assert.equal(submittedCalls.length, 1, "stub must be called for well-shaped input")
      assert.equal(submittedCalls[0].type, "add_validator")
      assert.equal(submittedCalls[0].targetId, "v4")
      assert.equal(submittedCalls[0].proposer, "node-1")
      assert.equal(submittedCalls[0].opts.targetAddress, "0xabc")
    } finally {
      delete (chain as unknown as Record<string, unknown>).governance
    }
  })

  await t.test("#551: coc_voteProposal validates inner fields (no silent Boolean/String coercion)", async () => {
    // Pre-fix the handler validated the outer-object shape but immediately
    // ran every inner field through `String()`/`Boolean()` — a missing
    // `approve` field silently coerced to `false` (a flipped NO vote),
    // a numeric `proposalId` to "123" (coerced ID), a string "yes" to
    // `true`. Same coercion-leak family as #260/#525, same validation-
    // order rule as #432/#538.
    const governanceStub551 = {
      vote: () => {},
      getProposal: () => ({ id: "p1", status: "pending", votes: new Map() }),
    } as Record<string, unknown>
    ;(chain as unknown as Record<string, unknown>).governance = governanceStub551
    try {
      const probe = async (params: unknown[]) => {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_voteProposal", params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      // Missing approve — pre-fix silently coerced to false (flipped NO vote)
      const noApprove = await probe([{ proposalId: "p1", voterId: "node-1" }])
      assert.equal(noApprove.error?.code, -32602, `missing approve must be -32602, got ${JSON.stringify(noApprove)}`)
      assert.match(noApprove.error!.message, /approve/i)
      // String approve — pre-fix Boolean("yes") = true
      const stringApprove = await probe([{ proposalId: "p1", voterId: "node-1", approve: "yes" }])
      assert.equal(stringApprove.error?.code, -32602, `string approve must be -32602, got ${JSON.stringify(stringApprove)}`)
      assert.match(stringApprove.error!.message, /approve/i)
      // Numeric proposalId — pre-fix String(123) = "123"
      const numId = await probe([{ proposalId: 123, voterId: "node-1", approve: true }])
      assert.equal(numId.error?.code, -32602, `numeric proposalId must be -32602, got ${JSON.stringify(numId)}`)
      assert.match(numId.error!.message, /proposalId/)
      // Null proposalId — pre-fix String(null) = "null"
      const nullId = await probe([{ proposalId: null, voterId: "node-1", approve: true }])
      assert.equal(nullId.error?.code, -32602, `null proposalId must be -32602, got ${JSON.stringify(nullId)}`)
      // Empty voterId
      const emptyVoter = await probe([{ proposalId: "p1", voterId: "", approve: true }])
      assert.equal(emptyVoter.error?.code, -32602, `empty voterId must be -32602, got ${JSON.stringify(emptyVoter)}`)
      assert.match(emptyVoter.error!.message, /voterId/)
      // Sanity: well-formed payload still reaches the stub
      const ok = await probe([{ proposalId: "p1", voterId: "node-1", approve: true }])
      assert.equal(ok.error, undefined, "well-formed vote must NOT error")
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

  await t.test("#424: coc_getRewardManifest / coc_getRewardClaim validate epochId/nodeId before the rewardManifestDir short-circuit", async () => {
    // Pre-fix the handler ran `if (!rewardManifestDir) return null` BEFORE
    // `requireIntegerParam` / `requireStringParam`, so any node where the
    // manifest dir wasn't configured (every read-only fullnode on
    // testnet 88780) silently returned `null` for garbage epochId
    // (`"1"`, `true`, `[1]`). Clients couldn't tell "input invalid" from
    // "feature not configured". Validation belongs at the boundary —
    // backend configuration is irrelevant to input shape.
    //
    // Spin up a second RPC server WITHOUT `rewardManifestDir` (the
    // unconfigured shape). Same validation rules must apply.
    const port2 = port + 1000
    const server2 = startRpcServer("127.0.0.1", port2, chainId, evm, chain, p2p, undefined, undefined, undefined, undefined, {
      // intentionally omit rewardManifestDir → unconfigured backend
      getBftEquivocations: () => [],
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const probe = async (method: string, params: unknown[]) => {
        const r = await fetch(`http://127.0.0.1:${port2}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
        return await r.json() as { error?: { code: number; message: string }; result?: unknown }
      }
      // Garbage epochId must still be -32602, NOT silent null,
      // even though the backend has no manifest dir configured.
      for (const bad of [true, false, "1", "5", [1], {}, 1.5, -1]) {
        const m = await probe("coc_getRewardManifest", [bad])
        assert.equal(m.error?.code, -32602,
          `unconfigured backend: getRewardManifest(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(m)}`)
        const c = await probe("coc_getRewardClaim", [bad, `0x${"22".repeat(32)}`])
        assert.equal(c.error?.code, -32602,
          `unconfigured backend: getRewardClaim(${JSON.stringify(bad)}, ...) must be -32602, got ${JSON.stringify(c)}`)
      }
      // Garbage nodeId on otherwise valid epoch must also reject.
      for (const bad of [123, true, {}, [1]]) {
        const r = await probe("coc_getRewardClaim", [7, bad])
        assert.equal(r.error?.code, -32602,
          `unconfigured backend: getRewardClaim(7, ${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
      }
      // Sanity: VALID input on unconfigured backend returns null (the
      // documented behaviour when no manifest dir is configured).
      const okM = await probe("coc_getRewardManifest", [7])
      assert.equal(okM.error, undefined, `valid input must not error, got ${JSON.stringify(okM)}`)
      assert.equal(okM.result, null, "valid input + unconfigured dir → null")
      const okC = await probe("coc_getRewardClaim", [7, `0x${"22".repeat(32)}`])
      assert.equal(okC.error, undefined, `valid input must not error, got ${JSON.stringify(okC)}`)
      assert.equal(okC.result, null, "valid input + unconfigured dir → null")
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()))
    }
  })

  await t.test("#254: coc_getTransactionsByAddress rejects non-integer limit/offset and non-boolean reverse", async () => {
    // Pre-fix `Number((params)[1] ?? 50)` silently coerced `true`→1, `"5"`→5,
    // `[3]`→3, `{}`→NaN→fallback. `(params[2] !== false)` accepted every
    // non-false value (`0`, `"false"`, `null`, `""`) as reverse=true. Same
    // anti-pattern family as #252/#251/#224/#120.
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
    ]) {
      const r = await probe(params)
      assert.equal(r.error, undefined,
        `well-shaped ${JSON.stringify(params)} must succeed, got ${JSON.stringify(r)}`)
      assert.ok(Array.isArray(r.result), `result must be array for ${JSON.stringify(params)}`)
    }
  })

  await t.test("#258: coc_getContracts rejects non-integer/non-bool fields inside the pagination object (no Number/!== coercion)", async () => {
    // Pre-fix the object-field variant of #254: `Number(opts.limit ?? 50)`
    // coerced `true`→1, `"5"`→5, `[5]`→5; `opts.reverse !== false`
    // accepted `0`/`"false"`/`null` as truthy → reverse=true (opposite
    // of the sloppy client's intent). Same anti-pattern as #254 (the
    // positional sibling), #252 (epochId), #224 (feeHistory blockCount).
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_getContracts", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    // limit: non-integer shapes must be rejected
    for (const bad of [true, false, "5", [3], [1, 2], {}, 1.5]) {
      const r = await probe([{ limit: bad }])
      assert.equal(r.error?.code, -32602,
        `limit=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /limit/i)
    }
    // offset: same
    for (const bad of [true, "0", [0], {}, 0.5]) {
      const r = await probe([{ offset: bad }])
      assert.equal(r.error?.code, -32602,
        `offset=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /offset/i)
    }
    // reverse: non-boolean shapes must be rejected
    for (const bad of [0, 1, "false", "true", [true], {}]) {
      const r = await probe([{ reverse: bad }])
      assert.equal(r.error?.code, -32602,
        `reverse=${JSON.stringify(bad)} must be -32602, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /reverse/i)
    }
    // Sanity: well-shaped values still succeed (result is array)
    for (const opts of [
      {},
      { limit: 10 },
      { offset: 0 },
      { reverse: false },
      { limit: 5, offset: 0, reverse: true },
    ]) {
      const r = await probe([opts])
      assert.equal(r.error, undefined,
        `well-shaped ${JSON.stringify(opts)} must succeed, got ${JSON.stringify(r)}`)
      assert.ok(Array.isArray(r.result), `result must be array for ${JSON.stringify(opts)}`)
    }
  })

  await t.test("#485: coc_getTransactionsByAddress logs have full wire shape (parity with eth_getTransactionReceipt.logs)", async () => {
    // Pre-fix the persistent layer stripped logs to {address, topics, data}
    // when writing the receipt (chain-engine-persistent.ts:1229), and this
    // endpoint passed them straight through. Clients got a 3-field log
    // while eth_getTransactionReceipt returned the full 9-field log
    // (blockNumber/blockHash/transactionHash/transactionIndex/logIndex/
    // removed). Live 88780 reproduction (this iteration):
    //   coc_getTransactionsByAddress.logs[0] = {address, topics, data}
    //   eth_getTransactionReceipt.logs[0]    = {address, topics, data,
    //     blockNumber, blockHash, transactionHash, transactionIndex,
    //     logIndex, removed}
    //
    // Deploy a log-emitting contract, call it, then fetch via both endpoints
    // and assert shape parity. Reuse the #454 deploy bytecode.
    const DEPLOY_BYTECODE = "0x6006600c60003960066000f360006000a000"
    const { Wallet: EW485 } = await import("ethers")
    const wallet = new EW485(`0x${"21".repeat(32)}`)
    await evm.prefund([{ address: wallet.address, balanceWei: "1000000000000000000" }])
    const startN = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)

    const deployTx = await wallet.signTransaction({
      type: 0, to: null, value: 0n, data: DEPLOY_BYTECODE,
      gasLimit: 500_000n, gasPrice: 1_000_000_000n,
      nonce: Number(startN), chainId,
    })
    const submit485 = async (raw: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
      })
      return await res.json() as { result?: string; error?: { code: number; message: string } }
    }
    const deployBody = await submit485(deployTx)
    if (!deployBody.result) return  // fixture skips persistent path
    if (chain.proposeNextBlock) await chain.proposeNextBlock()
    const deployReceipt = await rpcCall(port, "eth_getTransactionReceipt", [deployBody.result]) as { contractAddress: string }
    if (!deployReceipt.contractAddress) return

    const callTx = await wallet.signTransaction({
      type: 0, to: deployReceipt.contractAddress, value: 0n, data: "0x",
      gasLimit: 50_000n, gasPrice: 1_000_000_000n,
      nonce: Number(startN) + 1, chainId,
    })
    const callBody = await submit485(callTx)
    if (!callBody.result) return
    if (chain.proposeNextBlock) await chain.proposeNextBlock()

    const recViaHash = await rpcCall(port, "eth_getTransactionReceipt", [callBody.result]) as {
      logs: Array<Record<string, unknown>>
    }
    const txsByAddr = await rpcCall(port, "coc_getTransactionsByAddress", [wallet.address.toLowerCase(), 10, true, 0]) as Array<{
      hash: string
      logs: Array<Record<string, unknown>>
    }>

    // Locate the call tx in the address history.
    const callTxEntry = txsByAddr.find((tx) => tx.hash.toLowerCase() === callBody.result!.toLowerCase())
    if (!callTxEntry) return

    assert.equal(callTxEntry.logs.length, 1, "must have exactly 1 log")
    const cocLog = callTxEntry.logs[0]
    const recLog = recViaHash.logs[0]

    // The required wire shape: 9 fields, all present.
    for (const required of ["address", "topics", "data", "blockNumber", "blockHash", "transactionHash", "transactionIndex", "logIndex", "removed"]) {
      assert.ok(
        cocLog[required] !== undefined,
        `coc_getTransactionsByAddress log must include "${required}" (pre-fix only address/topics/data were present)`,
      )
    }

    // Type parity with eth_getTransactionReceipt.logs[].
    assert.equal(typeof cocLog.transactionIndex, "string", `transactionIndex must be hex string`)
    assert.equal(typeof cocLog.logIndex, "string", `logIndex must be hex string`)
    assert.equal(typeof cocLog.removed, "boolean", `removed must be boolean`)

    // Value parity for the same log via two endpoints.
    assert.equal(cocLog.address, recLog.address, "log.address parity")
    assert.equal(cocLog.transactionHash, recLog.transactionHash, "log.transactionHash parity")
    assert.equal(cocLog.logIndex, recLog.logIndex, "log.logIndex parity (block-global)")
    assert.equal(cocLog.transactionIndex, recLog.transactionIndex, "log.transactionIndex parity")
    assert.equal(cocLog.blockNumber, recLog.blockNumber, "log.blockNumber parity")
    assert.equal(cocLog.blockHash, recLog.blockHash, "log.blockHash parity")
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

  await t.test("#491: eth_call / eth_estimateGas distinguish insufficient-balance from revert (-32000 vs code 3)", async () => {
    // Pre-fix any callRaw failure (revert + insufficient-balance + out-of-
    // gas + invalid opcode) was lumped into code 3 "execution reverted".
    // geth distinguishes:
    //   - Real revert (RETURN ❌ / REVERT opcode) → code 3 "execution reverted"
    //   - Insufficient balance pre-execution check → -32000 "insufficient
    //     funds for gas * price + value"
    // ethers/viem surface different UIs for the two cases (contract bug vs
    // user needs to top up). Live 88780 reproduction: a poor address
    // calling eth_estimateGas for a value transfer got "execution
    // reverted" code 3 — totally misleading.
    //
    // Hijack callRaw to deterministically return the "insufficient balance"
    // exceptionError name (matches what EthereumJS-VM evm.js:949 throws
    // when caller.balance < value).
    const origCallRaw = (evm as unknown as {
      callRaw: (...args: unknown[]) => Promise<{ returnValue: string; gasUsed: bigint; failed: boolean; errorReason?: string }>
    }).callRaw
    ;(evm as unknown as { callRaw: typeof origCallRaw }).callRaw = async () => ({
      returnValue: "0x",
      gasUsed: 0n,
      failed: true,
      errorReason: "insufficient balance",
    })
    try {
      const probe = async (method: string) => {
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method,
            params: [{
              from: "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
              to: "0x0000000000000000000000000000000000000001",
              value: "0xde0b6b3a7640000",
            }],
          }),
        })
        return await r.json() as { error?: { code: number; message: string; data: string }; result?: unknown }
      }

      const call = await probe("eth_call")
      assert.equal(
        call.error?.code,
        -32000,
        `eth_call insufficient-balance must be -32000 (geth convention), got ${JSON.stringify(call)}`,
      )
      assert.match(
        call.error!.message,
        /insufficient funds for gas \* price \+ value/i,
        `eth_call message must say insufficient funds, got: ${call.error!.message}`,
      )
      assert.doesNotMatch(
        call.error!.message,
        /execution reverted/i,
        `eth_call must NOT use "execution reverted" wording for balance issues`,
      )

      const est = await probe("eth_estimateGas")
      assert.equal(
        est.error?.code,
        -32000,
        `eth_estimateGas insufficient-balance must be -32000, got ${JSON.stringify(est)}`,
      )
      assert.match(est.error!.message, /insufficient funds for gas \* price \+ value/i)

      // Sanity: a real revert still surfaces as code 3 (regression guard for #286).
      ;(evm as unknown as { callRaw: typeof origCallRaw }).callRaw = async () => ({
        returnValue: "0x", gasUsed: 21000n, failed: true,
        errorReason: "revert",
      })
      const revertCall = await probe("eth_call")
      assert.equal(revertCall.error?.code, 3, "real revert still uses code 3")
      assert.match(revertCall.error!.message, /execution reverted/i)
    } finally {
      ;(evm as unknown as { callRaw: typeof origCallRaw }).callRaw = origCallRaw
    }
  })

  await t.test("#493: eth_call non-revert EVM exceptions surface specific reason in message", async () => {
    // Pre-fix every EVM failure mode collapsed to bare "execution reverted":
    //   - stack underflow, invalid opcode, out of gas, invalid jump,
    //     refund exhausted, code size exceeds limit — all identical
    // ethers/viem surface this as "Transaction would revert (likely
    // require(false))" — totally wrong UX for OOG / OOPS / opcode bugs
    // where the user should bump gas limit or fix the contract logic.
    //
    // Live testnet 88780 reproduction (all returned same error):
    //   eth_call(0x50)         (POP, stack underflow)   → "execution reverted"
    //   eth_call(0xfe)         (INVALID opcode)         → "execution reverted"
    //   eth_call(...gas=0x10)  (out of gas)             → "execution reverted"
    //   eth_call(0x600056)     (invalid JUMP)           → "execution reverted"
    //
    // geth puts the specific reason in the message so wallets can show
    // a meaningful UI (e.g. "Out of gas — bump gas limit"). Match.
    const origCallRaw = (evm as unknown as {
      callRaw: (...args: unknown[]) => Promise<{ returnValue: string; gasUsed: bigint; failed: boolean; errorReason?: string }>
    }).callRaw

    const cases: Array<{ reason: string; expectMessage: RegExp }> = [
      { reason: "stack underflow",  expectMessage: /execution reverted: stack underflow/i },
      { reason: "invalid opcode",   expectMessage: /execution reverted: invalid opcode/i },
      { reason: "out of gas",        expectMessage: /execution reverted: out of gas/i },
      { reason: "invalid JUMP",      expectMessage: /execution reverted: invalid JUMP/i },
    ]

    try {
      for (const { reason, expectMessage } of cases) {
        ;(evm as unknown as { callRaw: typeof origCallRaw }).callRaw = async () => ({
          returnValue: "0x", gasUsed: 21000n, failed: true,
          errorReason: reason,
        })
        const r = await fetch(`http://127.0.0.1:${port}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_call",
            params: [{ from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), data: "0x" }, "latest"],
          }),
        })
        const body = await r.json() as { error?: { code: number; message: string; data: string } }
        assert.equal(body.error?.code, 3, `${reason} must still be code 3 (per geth), got ${JSON.stringify(body)}`)
        assert.match(body.error!.message, expectMessage,
          `${reason} must surface in message, got "${body.error!.message}"`)
      }

      // Sanity: bare revert (errorReason="revert") with no payload → bare
      // "execution reverted" (no extra suffix). Regression guard for #286.
      ;(evm as unknown as { callRaw: typeof origCallRaw }).callRaw = async () => ({
        returnValue: "0x", gasUsed: 21000n, failed: true,
        errorReason: "revert",
      })
      const bareRevert = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), data: "0x" }, "latest"],
        }),
      })
      const bareBody = await bareRevert.json() as { error?: { code: number; message: string } }
      assert.equal(bareBody.error?.code, 3)
      assert.equal(bareBody.error!.message, "execution reverted",
        `bare revert with no errorReason payload must be exactly "execution reverted", got "${bareBody.error!.message}"`)

      // Sanity: decoded Error(string) revert payload still works.
      // ABI-encoded `Error("Hard!")`:
      //   selector 08c379a0 + offset 0x20 + length 5 + "Hard!" padded to 32
      const revertPayload = "0x08c379a0" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000005" +
        "4861726421000000000000000000000000000000000000000000000000000000"
      ;(evm as unknown as { callRaw: typeof origCallRaw }).callRaw = async () => ({
        returnValue: revertPayload, gasUsed: 21000n, failed: true,
        errorReason: "revert",
      })
      const decoded = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20), data: "0x" }, "latest"],
        }),
      })
      const decodedBody = await decoded.json() as { error?: { code: number; message: string; data: string } }
      assert.equal(decodedBody.error?.code, 3)
      assert.match(decodedBody.error!.message, /execution reverted: Hard!/,
        "decoded revert reason takes precedence over errorReason")
      assert.equal(decodedBody.error!.data, revertPayload)
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

  await t.test("#446: eth_getTransactionReceipt computes effectiveGasPrice correctly for EIP-1559 (type 2) txs", async () => {
    // Live testnet 88780 reproduction:
    //   maxFeePerGas         = 0xa00000000    (42.95 Gwei)
    //   maxPriorityFeePerGas = 0x10000000     (0.27 Gwei)
    //   block baseFeePerGas  = 0x3b9aca00     (1 Gwei)
    //   expected effective   = min(maxFee, baseFee + maxPrio) = 0x4b9aca00
    //   pre-fix actual       = 0xa00000000   ← maxFeePerGas, wrong by 33×
    //
    // formatPersistentReceipt was setting effectiveGasPrice = parsed.gasPrice
    // from formatRawTransaction, which for type-2 txs falls back to
    // maxFeePerGas (ethers normalizes parsed.gasPrice = undefined for
    // EIP-1559). Indexers, block explorers, and fee-rebate calculators
    // saw the wrong number for every type-2 tx on COC.
    const { Wallet, parseEther } = await import("ethers")
    const wallet = new Wallet(`0x${"09".repeat(32)}`)
    await evm.prefund([{ address: wallet.address, balanceWei: parseEther("10").toString() }])
    const startN = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)

    const maxPriority = 200_000_000n     // 0.2 Gwei
    const maxFee = 50_000_000_000n        // 50 Gwei — way above baseFee+priority

    const tx1559 = await wallet.signTransaction({
      type: 2,
      to: `0x${"0a".repeat(20)}`,
      value: 1n,
      nonce: Number(startN),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxPriority,
      gasLimit: 50_000n,
      chainId,
    })

    const submit = async (raw: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
      })
      return await res.json() as { result?: string; error?: { code: number; message: string } }
    }
    const getReceipt = async (hash: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
      })
      return await res.json() as { result?: Record<string, unknown> }
    }

    const r = await submit(tx1559)
    assert.ok(r.result, `EIP-1559 submit must succeed: ${JSON.stringify(r)}`)

    // Force a block so the tx persists; needed for formatPersistentReceipt
    // path. The in-memory cache has a separate correctly-computed
    // effectiveGasPrice — this test specifically pins the persisted path.
    if (chain.proposeNextBlock) {
      await chain.proposeNextBlock()
    }

    const rec = await getReceipt(r.result!)
    assert.ok(rec.result, `receipt must be present after mining: ${JSON.stringify(rec)}`)
    assert.equal(rec.result!.type, "0x2", "type must be 0x2 for EIP-1559 receipt")

    const effective = BigInt(String(rec.result!.effectiveGasPrice))
    // effectiveGasPrice MUST NOT equal maxFeePerGas (the bug's signature).
    assert.notEqual(
      effective, maxFee,
      `effectiveGasPrice must NOT equal maxFeePerGas (${maxFee}); got ${effective} — this is the #446 regression`,
    )
    // Sanity: effective must be ≤ maxFeePerGas.
    assert.ok(
      effective <= maxFee,
      `effectiveGasPrice (${effective}) must be ≤ maxFeePerGas (${maxFee})`,
    )
  })

  await t.test("#448: eth_getBlockByNumber extraData is 20-byte address (not 42-byte ASCII string)", async () => {
    // Live testnet 88780 reproduction:
    //   $ curl ...eth_getBlockByNumber latest
    //   {
    //     "miner":     "0xde4e7889aa9007318ff261b1ee675f1305153590",
    //     "extraData": "0x307864653465373838396161393030373331386666323631623165653637356631333035313533353930"
    //   }
    //   ↑ 84 hex chars after 0x = 42 bytes — exceeds Ethereum's 32-byte
    //     extraData cap (consensus rule)
    //   ↑ ASCII decodes to the proposer address rendered as TEXT STRING:
    //     bytes.fromhex("307864...3530") = "0xde4e7889aa9007318ff261b1ee675f1305153590"
    //
    // formatBlockResponse used Buffer.from(proposer, "utf-8").toString("hex")
    // which encodes each ASCII character of the "0x..." string. The result
    // is wasteful AND a consensus-rule violation. External spec-strict
    // block validators (L2 fraud-proof generators, geth-strict block import)
    // reject any header with extraData > 32 bytes.
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
    })
    const body = await res.json() as { result?: Record<string, unknown> }
    assert.ok(body.result, "latest block must exist")
    const extraData = String(body.result!.extraData ?? "")
    const miner = String(body.result!.miner ?? "")

    // 1. extraData must be ≤ 32 bytes (Ethereum consensus rule).
    const extraBytes = (extraData.length - 2) / 2
    assert.ok(extraBytes <= 32,
      `extraData must be ≤ 32 bytes (Ethereum consensus rule), got ${extraBytes} bytes: ${extraData}`)

    // 2. extraData must NOT be the ASCII rendering of the address.
    // The pre-fix output, decoded as latin1, would start with "0x".
    if (extraData.length > 2) {
      const decoded = Buffer.from(extraData.slice(2), "hex").toString("latin1")
      assert.ok(!decoded.startsWith("0x"),
        `extraData must not be ASCII-encoded hex string (bug signature). Decoded as latin1: "${decoded}"`)
    }

    // 3. When proposer is a 20-byte hex address (production case),
    // extraData should equal the proposer byte-for-byte (which equals
    // miner when miner is hex). When proposer is a test-fixture node ID
    // (e.g. "node-1"), miner falls back to the zero address but extraData
    // still encodes the proposer as UTF-8 bytes (truncated to ≤32 bytes).
    //
    // Either way, the 32-byte cap (assertion 1) and the "no ASCII-encoded
    // 0x..." check (assertion 2) catch the original bug. Skip the
    // byte-for-byte equality check when miner is the zero address.
    if (miner !== "0x0000000000000000000000000000000000000000"
      && /^0x[0-9a-fA-F]{40}$/.test(miner)) {
      assert.equal(extraData.toLowerCase(), miner.toLowerCase(),
        `extraData should encode proposer address as raw bytes (matching miner field)`)
    }
  })

  await t.test("#466: receipt.contractAddress is lowercase (parity with from/to/log.address)", async () => {
    // Live testnet 88780 reproduction:
    //   $ curl ...eth_getTransactionReceipt <deploy-tx-hash>
    //   {
    //     "from":            "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    //     "contractAddress": "0xeF31027350Be2c7439C1b0BE022d49421488b72C",
    //     ...
    //   }
    //
    // viem.getCreateAddress returns EIP-55 mixed case; the formatter
    // relayed it without lowercasing while every other receipt address
    // field (from, to, log.address) was already lowercase. dApps that
    // string-compared `receipt.contractAddress === addr.toLowerCase()`
    // saw false-mismatch for deploy receipts and treated the contract
    // as undeployed. Same family as #456.
    const { Wallet: EW466, parseEther } = await import("ethers")
    const wallet = new EW466(`0x${"0f".repeat(32)}`)
    await evm.prefund([{ address: wallet.address, balanceWei: parseEther("10").toString() }])
    const startN = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)

    // 5-byte init that returns empty runtime — minimal valid CREATE.
    const deployTx = await wallet.signTransaction({
      type: 0, to: null, value: 0n, data: "0x60006000f3",
      gasLimit: 100_000n, gasPrice: 1_000_000_000n,
      nonce: Number(startN), chainId,
    })
    const submit = async (raw: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
      })
      return await res.json() as { result?: string; error?: { code: number; message: string } }
    }
    const deployRes = await submit(deployTx)
    assert.ok(deployRes.result, `deploy must succeed: ${JSON.stringify(deployRes)}`)
    if (chain.proposeNextBlock) await chain.proposeNextBlock()

    const receipt = await rpcCall(port, "eth_getTransactionReceipt", [deployRes.result]) as {
      contractAddress: string | null
      from: string
    }
    assert.ok(receipt.contractAddress, `deploy must yield a contractAddress: ${JSON.stringify(receipt)}`)
    assert.equal(
      receipt.contractAddress, receipt.contractAddress!.toLowerCase(),
      `contractAddress must be lowercase (parity with from), got ${receipt.contractAddress}`,
    )
    assert.equal(receipt.from, receipt.from.toLowerCase(), "from must be lowercase (sanity)")
  })

  await t.test("#456: eth_getTransactionByHash returns from/to in lowercase (parity with receipt + geth)", async () => {
    // Live testnet 88780 reproduction:
    //   eth_getTransactionReceipt → from = "0xf39fd6e51aad88..."   (lowercase)
    //   eth_getTransactionByHash  → from = "0xf39Fd6e51aad88..."   (EIP-55 mixed)
    //   eth_getBlockByNumber      → miner = "0xde4e7889aa..."     (lowercase)
    //
    // ethers v6 Transaction.from() returns parsed.from/to in EIP-55
    // checksum case; formatRawTransaction relayed it untouched. Geth +
    // Erigon always lowercase addresses in JSON-RPC responses; the rest
    // of COC's API (receipts, block.miner, eth_getLogs, eth_getBalance)
    // also lowercases. dApps that string-compare `tx.from === receipt.from`
    // fail for every non-all-lowercase address.
    const { Wallet: EW456 } = await import("ethers")
    const wallet = new EW456(`0x${"0e".repeat(32)}`)
    await evm.prefund([{ address: wallet.address, balanceWei: "1000000000000000000" }])
    const startN = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)
    // Use any 20-byte address. ethers.Transaction.from(rawTx).to returns
    // it in EIP-55 mixed case post-parse, so the normalization in
    // formatRawTransaction is what the test pins.
    const to = "0xabcdef0123456789abcdef0123456789abcdef01"

    const tx = await wallet.signTransaction({
      type: 0, to, value: 1n,
      nonce: Number(startN),
      gasPrice: 1_000_000_000n, gasLimit: 21_000n,
      chainId,
    })
    const submitRes = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [tx] }),
    })
    const submitBody = await submitRes.json() as { result?: string }
    assert.ok(submitBody.result, `submit must succeed: ${JSON.stringify(submitBody)}`)
    if (chain.proposeNextBlock) await chain.proposeNextBlock()

    const got = await rpcCall(port, "eth_getTransactionByHash", [submitBody.result]) as {
      from: string
      to: string | null
    }
    assert.ok(got, "tx must be findable by hash")
    assert.equal(got.from, got.from.toLowerCase(),
      `eth_getTransactionByHash from must be lowercase, got ${got.from}`)
    if (got.to) {
      assert.equal(got.to, got.to.toLowerCase(),
        `eth_getTransactionByHash to must be lowercase, got ${got.to}`)
    }

    // Cross-check: receipt for the same tx returns matching from/to.
    const receipt = await rpcCall(port, "eth_getTransactionReceipt", [submitBody.result]) as {
      from: string
      to: string | null
    }
    assert.equal(receipt.from, got.from,
      `receipt.from must equal tx.from byte-for-byte (post-lowercase): receipt=${receipt.from} tx=${got.from}`)
    if (receipt.to && got.to) {
      assert.equal(receipt.to, got.to, "receipt.to must equal tx.to byte-for-byte")
    }
  })

  await t.test("#454: receipt logIndex is block-global (running count across all prior txs in block)", async () => {
    // Per Ethereum spec: "logIndex: log index position in the BLOCK".
    // Pre-fix every tx's logs restarted logIndex at 0, so a block with
    // 2 txs each emitting 1 log reported [0, 0] instead of geth-spec
    // [0, 1]. Indexers / subgraphs keyed on (blockHash, logIndex) saw
    // duplicate keys and dropped entries.
    //
    // Minimal log-emitting contract (no constructor args, runtime emits
    // one LOG0 then stops). CODECOPY stack order (top first): destOffset,
    // codeOffset, size — so push size first (bottom), then codeOffset,
    // then destOffset (top).
    //   constructor (12 bytes):
    //     60 06    PUSH1 6     (runtime size, bottom)
    //     60 0c    PUSH1 12    (code offset where runtime starts)
    //     60 00    PUSH1 0     (memory dest, top)
    //     39       CODECOPY    (mem[0..6] = code[12..18])
    //     60 06    PUSH1 6     (return length)
    //     60 00    PUSH1 0     (return offset)
    //     f3       RETURN
    //   runtime (6 bytes):
    //     60 00    PUSH1 0     (data length)
    //     60 00    PUSH1 0     (data offset)
    //     a0       LOG0
    //     00       STOP
    const DEPLOY_BYTECODE = "0x6006600c60003960066000f360006000a000"

    const { Wallet: EW454 } = await import("ethers")
    const wallet = new EW454(`0x${"0d".repeat(32)}`)
    await evm.prefund([{ address: wallet.address, balanceWei: "1000000000000000000" }])
    const startN = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)

    // Deploy the contract.
    const deployTx = await wallet.signTransaction({
      type: 0, to: null, value: 0n, data: DEPLOY_BYTECODE,
      gasLimit: 500_000n, gasPrice: 1_000_000_000n,
      nonce: Number(startN), chainId,
    })
    const submit454 = async (raw: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
      })
      return await res.json() as { result?: string; error?: { code: number; message: string } }
    }
    const deployBody = await submit454(deployTx)
    assert.ok(deployBody.result, `deploy must succeed: ${JSON.stringify(deployBody)}`)
    if (chain.proposeNextBlock) await chain.proposeNextBlock()
    const deployReceipt = await rpcCall(port, "eth_getTransactionReceipt", [deployBody.result]) as {
      contractAddress: string
    }
    assert.ok(deployReceipt.contractAddress, "deploy must yield contract address")
    const contractAddr = deployReceipt.contractAddress

    // Submit two txs that each call the contract (each emits 1 LOG0).
    // They MUST land in the same block for the offset assertion to apply.
    const call1 = await wallet.signTransaction({
      type: 0, to: contractAddr, value: 0n, data: "0x",
      gasLimit: 50_000n, gasPrice: 1_000_000_000n,
      nonce: Number(startN) + 1, chainId,
    })
    const call2 = await wallet.signTransaction({
      type: 0, to: contractAddr, value: 0n, data: "0x",
      gasLimit: 50_000n, gasPrice: 1_000_000_000n,
      nonce: Number(startN) + 2, chainId,
    })
    const r1 = await submit454(call1)
    const r2 = await submit454(call2)
    assert.ok(r1.result && r2.result, "both calls must submit successfully")
    if (chain.proposeNextBlock) await chain.proposeNextBlock()

    const rec1 = await rpcCall(port, "eth_getTransactionReceipt", [r1.result]) as {
      logs: Array<{ logIndex: string }>
      blockNumber: string
    }
    const rec2 = await rpcCall(port, "eth_getTransactionReceipt", [r2.result]) as {
      logs: Array<{ logIndex: string }>
      blockNumber: string
    }

    assert.equal(rec1.blockNumber, rec2.blockNumber,
      "both calls must land in the same block (test pre-condition)")
    assert.equal(rec1.logs.length, 1, "call 1 must emit exactly 1 log")
    assert.equal(rec2.logs.length, 1, "call 2 must emit exactly 1 log")
    assert.equal(rec1.logs[0].logIndex, "0x0",
      `first tx's first log must have logIndex 0x0 (got ${rec1.logs[0].logIndex})`)
    assert.equal(rec2.logs[0].logIndex, "0x1",
      `second tx's first log must have logIndex 0x1 (block-global), not 0x0 (per-tx). got ${rec2.logs[0].logIndex} — this is the #454 regression`)

    // #483: eth_getLogs must return the SAME shape as receipt.logs[].
    // Pre-fix the persistent log index returned `transactionIndex` and
    // `logIndex` as JS numbers (0 / 1) and omitted `removed`. Receipt's
    // logs[] (going through formatPersistentReceipt) used hex strings
    // ("0x0" / "0x1") + included `removed: false`. Live 88780 reproduced
    // this with two different log shapes for the same emitted event.
    const logsViaFilter = await rpcCall(port, "eth_getLogs", [{
      address: contractAddr,
      fromBlock: rec1.blockNumber,
      toBlock: rec1.blockNumber,
    }]) as Array<Record<string, unknown>>

    assert.equal(logsViaFilter.length, 2, `eth_getLogs must return both logs (got ${logsViaFilter.length})`)

    for (const log of logsViaFilter) {
      assert.equal(typeof log.transactionIndex, "string",
        `eth_getLogs transactionIndex must be hex string, got ${typeof log.transactionIndex} (${log.transactionIndex})`)
      assert.match(log.transactionIndex as string, /^0x[0-9a-f]+$/,
        `eth_getLogs transactionIndex must match /^0x[0-9a-f]+$/`)
      assert.equal(typeof log.logIndex, "string",
        `eth_getLogs logIndex must be hex string, got ${typeof log.logIndex} (${log.logIndex})`)
      assert.match(log.logIndex as string, /^0x[0-9a-f]+$/,
        `eth_getLogs logIndex must match /^0x[0-9a-f]+$/`)
      assert.equal(typeof log.removed, "boolean",
        `eth_getLogs log.removed must be a boolean, got ${typeof log.removed}`)
    }

    // Cross-endpoint shape parity: the same log via eth_getLogs and
    // eth_getTransactionReceipt must have identical scalar field values.
    assert.equal(logsViaFilter[0].logIndex, rec1.logs[0].logIndex,
      "eth_getLogs[0].logIndex must equal receipt.logs[0].logIndex (same log, same shape)")
    assert.equal(logsViaFilter[1].logIndex, rec2.logs[0].logIndex,
      "eth_getLogs[1].logIndex must equal receipt.logs[0].logIndex of second tx")
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

  await t.test("#440: eth_sendRawTransaction maps every mempool/chain rejection to -32000 (not -32603)", async () => {
    // Live testnet 88780 reproduction: bursting 100 concurrent same-sender
    // txs (per-sender cap = 64) returned 100× -32603 "exceeds max pending
    // tx limit (64)". ethers.js wraps -32603 as opaque "could not coalesce
    // error", so callers see neither the cause nor an actionable code.
    //
    // Per geth, every well-formed-tx-but-server-won't-accept condition
    // maps to -32000. Per JSON-RPC, every replay/format problem maps to
    // -32602. Anything left becomes generic -32603. Pin the canonical map
    // so wallets + indexers can branch on error.code reliably.
    const { Wallet } = await import("ethers")

    const submit = async (rawTx: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [rawTx] }),
      })
      return await res.json() as { error?: { code: number; message: string }; result?: string }
    }

    // -32602: wrong chain id (replay protection — definitely a client error).
    const wallet440a = new Wallet(`0x${"04".repeat(32)}`)
    await evm.prefund([{ address: wallet440a.address, balanceWei: "1000000000000000000" }])
    const startNonce440a = await evm.getNonce(wallet440a.address.toLowerCase() as `0x${string}`)
    const wrongChain = await wallet440a.signTransaction({
      type: 0,
      to: `0x${"02".repeat(20)}`,
      value: 1n,
      nonce: Number(startNonce440a),
      gasPrice: 1_000_000_000n,
      gasLimit: 21_000n,
      chainId: chainId + 1, // wrong!
    })
    {
      const r = await submit(wrongChain)
      assert.equal(r.error?.code, -32602,
        `wrong-chain-id must be -32602 (invalid params), got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /invalid chain ID/i)
    }

    // -32000: stale nonce (the #438 family — chain-engine throws "nonce too low")
    const wallet440b = new Wallet(`0x${"05".repeat(32)}`)
    await evm.prefund([{ address: wallet440b.address, balanceWei: "1000000000000000000" }])
    const sign440b = (nonce: number) => wallet440b.signTransaction({
      type: 0, to: `0x${"02".repeat(20)}`, value: 1n, nonce,
      gasPrice: 1_000_000_000n, gasLimit: 21_000n, chainId,
    })
    // Mine the first tx so on-chain nonce advances.
    const first440b = await sign440b(0)
    {
      const r = await submit(first440b)
      assert.ok(r.result, `setup tx must mine: ${JSON.stringify(r)}`)
    }
    if (chain.proposeNextBlock) await chain.proposeNextBlock()
    const stale440b = await sign440b(0) // same nonce, now stale
    {
      const r = await submit(stale440b)
      // Either "nonce too low" (#438 wired) or "tx already confirmed"
      // (#438 hash dedup path); both must map to -32000.
      assert.equal(r.error?.code, -32000,
        `stale-nonce must be -32000, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /nonce too low|tx already confirmed/i)
    }

    // -32000: intrinsic gas too low (gasLimit < 21000 floor).
    const wallet440c = new Wallet(`0x${"06".repeat(32)}`)
    await evm.prefund([{ address: wallet440c.address, balanceWei: "1000000000000000000" }])
    const lowGas = await wallet440c.signTransaction({
      type: 0,
      to: `0x${"02".repeat(20)}`,
      value: 1n,
      nonce: Number(await evm.getNonce(wallet440c.address.toLowerCase() as `0x${string}`)),
      gasPrice: 1_000_000_000n,
      gasLimit: 100n, // way below 21000
      chainId,
    })
    {
      const r = await submit(lowGas)
      assert.equal(r.error?.code, -32000,
        `intrinsic-gas-too-low must be -32000, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /intrinsic gas too low/i)
    }
  })

  await t.test("#442: eth_getTransactionByHash includes accessList for EIP-2930/EIP-1559 txs", async () => {
    // Live testnet 88780 reproduction:
    //   1. Submit a type-1 (EIP-2930) tx carrying accessList=[{addr, [slot0,slot7]}].
    //   2. GET via eth_getTransactionByHash.
    //   3. Pre-fix the response omits the accessList field entirely; the
    //      formatRawTransaction helper never copied it from the parsed RLP.
    // Indexers, MEV bots, gas-cost tooling all silently saw `undefined` for
    // every type-1/2 tx on COC, treating them as if they had no access list.
    const { Wallet } = await import("ethers")
    const wallet = new Wallet(`0x${"07".repeat(32)}`)
    await evm.prefund([{ address: wallet.address, balanceWei: "1000000000000000000" }])
    const startN = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)

    const targetAddr = `0x${"08".repeat(20)}`
    const slot0 = `0x${"00".repeat(32)}`
    const slot7 = `0x${"00".repeat(31)}07`

    const submit = async (raw: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }),
      })
      return await res.json() as { result?: string; error?: { code: number; message: string } }
    }
    const get = async (hash: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }),
      })
      return await res.json() as { result?: Record<string, unknown> }
    }

    // EIP-2930 (type 1)
    const tx2930 = await wallet.signTransaction({
      type: 1,
      to: targetAddr,
      value: 1n,
      nonce: Number(startN),
      gasPrice: 1_000_000_000n,
      gasLimit: 50_000n,
      chainId,
      accessList: [{ address: targetAddr, storageKeys: [slot0, slot7] }],
    })
    const r2930 = await submit(tx2930)
    assert.ok(r2930.result, `EIP-2930 submit must succeed: ${JSON.stringify(r2930)}`)
    const g2930 = await get(r2930.result!)
    assert.ok(g2930.result, `EIP-2930 must be findable by hash: ${JSON.stringify(g2930)}`)
    assert.equal(g2930.result!.type, "0x1", "type field must be 0x1 for EIP-2930")
    const acl = g2930.result!.accessList as Array<{ address: string; storageKeys: string[] }> | undefined
    assert.ok(Array.isArray(acl),
      `accessList must be an array for EIP-2930 tx, got ${typeof acl} (${JSON.stringify(g2930.result)})`)
    assert.equal(acl!.length, 1, "accessList must have 1 entry")
    assert.equal(acl![0].address.toLowerCase(), targetAddr.toLowerCase())
    assert.deepEqual(
      acl![0].storageKeys.map((k) => k.toLowerCase()),
      [slot0, slot7],
    )

    // EIP-1559 (type 2)
    const tx1559 = await wallet.signTransaction({
      type: 2,
      to: targetAddr,
      value: 1n,
      nonce: Number(startN) + 1,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      gasLimit: 50_000n,
      chainId,
      accessList: [{ address: targetAddr, storageKeys: [slot0] }],
    })
    const r1559 = await submit(tx1559)
    assert.ok(r1559.result, `EIP-1559 submit must succeed: ${JSON.stringify(r1559)}`)
    const g1559 = await get(r1559.result!)
    assert.ok(g1559.result, `EIP-1559 must be findable by hash`)
    assert.equal(g1559.result!.type, "0x2", "type field must be 0x2 for EIP-1559")
    const acl1559 = g1559.result!.accessList as Array<{ address: string; storageKeys: string[] }> | undefined
    assert.ok(Array.isArray(acl1559), "accessList must be array for EIP-1559 too")
    assert.equal(acl1559!.length, 1)
    assert.equal(acl1559![0].address.toLowerCase(), targetAddr.toLowerCase())

    // Legacy (type 0) txs MUST NOT carry an accessList field (per geth).
    const txLegacy = await wallet.signTransaction({
      type: 0,
      to: targetAddr,
      value: 1n,
      nonce: Number(startN) + 2,
      gasPrice: 1_000_000_000n,
      gasLimit: 21_000n,
      chainId,
    })
    const rLegacy = await submit(txLegacy)
    assert.ok(rLegacy.result, "legacy tx submit must succeed")
    const gLegacy = await get(rLegacy.result!)
    assert.equal(
      gLegacy.result!.accessList, undefined,
      `legacy (type 0) tx must NOT have accessList field, got ${JSON.stringify(gLegacy.result!.accessList)}`,
    )
  })

  await t.test("#610: eth_getTransactionByHash includes accessList for MINED EIP-2930/EIP-1559 txs (in-memory engine path)", async () => {
    // #442 fixed the mempool path (formatRawTransaction is called when the
    // tx is still pending). But the post-mining fallback in rpc.ts (~873)
    // — `evm.getTransaction(hash)` — returns a TxInfo struct that doesn't
    // include accessList, so non-persistent ChainEngine setups (test
    // fixtures + single-node devnet) silently dropped the field once the
    // tx was mined. PersistentChainEngine routes through formatRawTransaction
    // via its blockIndex so production 88780 wasn't affected — but the
    // divergence meant in-memory engine returned a shape prod didn't.
    //
    // Repro: submit type-1, force a block proposal so the tx leaves mempool,
    // then GET via eth_getTransactionByHash. Pre-#610 accessList is undefined.
    const { Wallet } = await import("ethers")
    const wallet = new Wallet(`0x${"42".repeat(32)}`)
    await evm.prefund([{ address: wallet.address, balanceWei: "1000000000000000000" }])
    const startN = await evm.getNonce(wallet.address.toLowerCase() as `0x${string}`)
    const targetAddr = `0x${"19".repeat(20)}`
    const slot3 = `0x${"00".repeat(31)}03`

    // EIP-2930 (type 1) — sign, submit, mine.
    const tx2930 = await wallet.signTransaction({
      type: 1,
      to: targetAddr, value: 1n,
      nonce: Number(startN),
      gasPrice: 1_000_000_000n, gasLimit: 50_000n, chainId,
      accessList: [{ address: targetAddr, storageKeys: [slot3] }],
    })
    const rRes = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [tx2930] }),
    })
    const submitted = await rRes.json() as { result?: string }
    assert.ok(submitted.result, "tx must accept")
    // Force-mine so the tx leaves the mempool and lands in evm.txs.
    // chain.proposeNextBlock applies a block from currently pending txs.
    await chain.proposeNextBlock()

    const getRes = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [submitted.result] }),
    })
    const got = await getRes.json() as { result?: Record<string, unknown> }
    assert.ok(got.result, `mined tx must be findable: ${JSON.stringify(got)}`)
    assert.equal(got.result!.type, "0x1", "type field must be 0x1 for mined EIP-2930")
    // The bug: accessList missing after mining on the in-memory engine.
    const acl = got.result!.accessList as Array<{ address: string; storageKeys: string[] }> | undefined
    assert.ok(Array.isArray(acl),
      `accessList must be present on MINED EIP-2930 tx (got ${typeof acl}: ${JSON.stringify(got.result)})`)
    assert.equal(acl!.length, 1, "accessList must have 1 entry")
    assert.equal(acl![0].address.toLowerCase(), targetAddr.toLowerCase(),
      "accessList[0].address must match what was signed")
    assert.deepEqual(acl![0].storageKeys.map(k => k.toLowerCase()), [slot3],
      "accessList[0].storageKeys must round-trip the signed slot")

    // Sanity: legacy mined tx still has NO accessList (closing parity loop with #442's legacy assertion).
    const txLegacy = await wallet.signTransaction({
      type: 0, to: targetAddr, value: 1n,
      nonce: Number(startN) + 1, gasPrice: 1_000_000_000n, gasLimit: 21_000n, chainId,
    })
    const submitLegacy = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [txLegacy] }),
    }).then(r => r.json()) as { result?: string }
    await chain.proposeNextBlock()
    const getLegacy = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [submitLegacy.result] }),
    }).then(r => r.json()) as { result?: Record<string, unknown> }
    assert.equal(getLegacy.result!.accessList, undefined,
      "MINED legacy tx must NOT carry accessList field")
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
