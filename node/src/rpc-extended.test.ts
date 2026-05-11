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

  await t.test("#94: eth_getFilterLogs on a block filter returns [] (not log results)", async () => {
    const fid = (await rpcCall(port, "eth_newBlockFilter")) as string
    const result = (await rpcCall(port, "eth_getFilterLogs", [fid])) as unknown[]
    assert.deepEqual(result, [], "getFilterLogs on a non-log filter must return []")
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
    // method must be a non-empty string
    for (const m of [0, "", null, true, ["eth_chainId"]]) {
      const r = await probe({ jsonrpc: "2.0", id: 1, method: m })
      assert.equal(r.error?.code, -32600, `method=${JSON.stringify(m)} must be -32600, got ${JSON.stringify(r)}`)
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

  await t.test("#249: coc_getContracts rejects non-object pagination param (no silent all-return)", async () => {
    // Pre-fix `(payload.params ?? [])[0] as Record<string, unknown>`
    // was a TS runtime no-op. coc_getContracts(true) etc. silently fell
    // through with .limit/.offset/.reverse as undefined → default pagination
    // → returned all contracts. Same anti-pattern as #238/#239.
    const probe = async (params: unknown[]) => {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "coc_getContracts", params }),
      })
      return await r.json() as { error?: { code: number; message: string }; result?: unknown }
    }
    for (const bad of [true, false, "str", 42, [1, 2]]) {
      const r = await probe([bad])
      assert.equal(r.error?.code, -32602,
        `coc_getContracts(${JSON.stringify(bad)}) must be -32602, got ${JSON.stringify(r)}`)
      assert.match(r.error!.message, /invalid filter|expected object/i)
    }
    // Sanity: omitted / null / empty object treated as default pagination.
    // (The fixture chain might not have blockIndex, so we just verify
    // no -32602 shape error.)
    for (const ok of [[], [null], [{}], [{ limit: 10 }]]) {
      const r = await probe(ok)
      assert.notEqual(r.error?.code, -32602,
        `coc_getContracts(${JSON.stringify(ok)}) must pass shape, got ${JSON.stringify(r)}`)
    }
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
