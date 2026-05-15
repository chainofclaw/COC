import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Transaction, Wallet } from "ethers"
import { startRpcServer } from "./rpc.ts"
import http from "node:http"
import { BLOCK_GAS_LIMIT } from "./base-fee.ts"

const testWallet = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")

async function rpcCall(port: number, method: string, params: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    const req = http.request({ hostname: "127.0.0.1", port, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let data = ""
      res.on("data", (chunk) => { data += chunk })
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed.error) reject(new Error(parsed.error.message))
          else resolve(parsed.result)
        } catch (e) { reject(e) }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

function createMockChain(blocks: Array<{
  number: bigint
  hash: string
  parentHash: string
  proposer: string
  timestampMs: number
  txs: string[]
  gasUsed?: bigint
  baseFee?: bigint
  finalized?: boolean
}>) {
  const byNumber = new Map<bigint, (typeof blocks)[0]>()
  const byHash = new Map<string, (typeof blocks)[0]>()
  for (const b of blocks) {
    byNumber.set(b.number, b)
    byHash.set(b.hash, b)
  }
  return {
    getHeight: () => blocks.length > 0 ? blocks[blocks.length - 1].number : 0n,
    getBlockByNumber: (n: bigint) => byNumber.get(n) ?? null,
    getBlockByHash: (h: string) => byHash.get(h) ?? null,
    getReceiptsByBlock: () => [],
    expectedProposer: () => "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    addRawTx: async () => ({ hash: "0x" + "a".repeat(64) }),
    validators: [],
  }
}

function createMockP2P() {
  return {
    getPeers: () => [],
    receiveTx: async () => {},
    broadcast: async () => {},
    getStats: () => ({}),
  }
}

function createMockEvm() {
  return {
    getBalance: async () => 0n,
    getNonce: async () => 0n,
    getReceipt: () => null,
    getTransaction: () => null,
    estimateGas: async () => 21000n,
    call: async () => "0x",
    getCode: async () => "0x",
    getStorageAt: async () => "0x" + "0".repeat(64),
    getProof: async () => ({}),
  }
}

const KECCAK256_RLP = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"

// Pre-sign a transaction for test use
const signedTx1 = await testWallet.signTransaction({
  to: "0x" + "bb".repeat(20),
  value: 0n,
  nonce: 0,
  gasLimit: 21000n,
  maxFeePerGas: 3_000_000_000n,
  maxPriorityFeePerGas: 500_000_000n,
  chainId: 31337,
  type: 2,
})

describe("P8: Block/receipt format standardization", () => {
  const tx1 = signedTx1

  // #611: PR #596 gated Cancun fields (blobGasUsed/excessBlobGas/
  // parentBeaconBlockRoot) in formatBlock to only emit when stored on the
  // block. The pre-#596 test #481 mock blocks had NONE of these fields, so
  // post-#596 formatBlock correctly omits them — but #481's assertion that
  // genesis and regular blocks BOTH include them then fails. The assertion
  // is throwing BEFORE the test's `server.close()` runs → the server
  // leaks, keep-alive http sockets pin the event loop, and the WHOLE
  // node-test suite hangs until CI timeout.
  //
  // Two-part fix:
  //   (a) Set Cancun-era fields on both mock blocks so the genesis-vs-
  //       regular field-set parity check actually exercises the
  //       presence path the test was meant to cover.
  //   (b) Wrap all server.close() in try/finally so a failed assertion
  //       can never again leak a server and hang the suite.
  const blocks = [
    {
      number: 0n,
      hash: "0x" + "0".repeat(64),
      parentHash: "0x" + "0".repeat(64),
      proposer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      timestampMs: 1000000,
      txs: [],
      gasUsed: 0n,
      baseFee: 1_000_000_000n,
      finalized: true,
      blobGasUsed: 0n,
      excessBlobGas: 0n,
      parentBeaconBlockRoot: "0x" + "0".repeat(64),
    },
    {
      number: 1n,
      hash: "0x" + "1".repeat(64),
      parentHash: "0x" + "0".repeat(64),
      proposer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      timestampMs: 2000000,
      txs: [tx1],
      gasUsed: 21000n,
      baseFee: 1_000_000_000n,
      finalized: true,
      blobGasUsed: 0n,
      excessBlobGas: 0n,
      parentBeaconBlockRoot: "0x" + "0".repeat(64),
    },
  ]

  // #611: helper wraps each test body so the http server is ALWAYS closed,
  // even when an assertion fails. Pre-fix any failing assertion (e.g. the
  // #481 test post-PR-#596) skipped server.close() → keep-alive sockets
  // pinned the event loop → entire node-test suite hung at CI timeout.
  async function withTestServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
    const chain = createMockChain(blocks)
    const port = 38700 + Math.floor(Math.random() * 1000)
    const server = startRpcServer("127.0.0.1", port, 31337, createMockEvm() as any, chain as any, createMockP2P() as any)
    await new Promise((r) => setTimeout(r, 100))
    try {
      return await fn(port)
    } finally {
      await new Promise<void>((resolve) => {
        (server as any).close(() => resolve())
      })
    }
  }

  it("formatBlock includes mixHash field", async () => {
    await withTestServer(async (port) => {
      const block = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as Record<string, unknown>
      assert.ok("mixHash" in block, "block should have mixHash")
      assert.equal(block.mixHash, "0x" + "0".repeat(64))
    })
  })

  it("formatBlock includes withdrawals and withdrawalsRoot", async () => {
    await withTestServer(async (port) => {
      const block = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as Record<string, unknown>
      assert.ok("withdrawals" in block, "block should have withdrawals")
      assert.ok("withdrawalsRoot" in block, "block should have withdrawalsRoot")
      assert.deepEqual(block.withdrawals, [])
      assert.equal(block.withdrawalsRoot, KECCAK256_RLP)
    })
  })

  it("formatBlock gasLimit matches BLOCK_GAS_LIMIT constant", async () => {
    await withTestServer(async (port) => {
      const block = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as Record<string, unknown>
      assert.equal(block.gasLimit, `0x${BLOCK_GAS_LIMIT.toString(16)}`)
    })
  })

  it("#481: genesis block has identical field set to regular blocks (no uncles, full Cancun + finalized)", async () => {
    // Pre-fix formatBlock emitted `finalized: block.finalized` without a
    // fallback. For any chain block stored without an explicit finalized
    // flag (genesis-as-real-block on older chain versions, pre-BFT-
    // finalization blocks), the value was undefined and JSON.stringify
    // dropped the entire key. Result: same-endpoint shape drift — block
    // 0 omitted `finalized` while block N (finalized post-BFT) carried
    // it. Tools that introspect blocks (ethers/viem/hardhat-fork) trip.
    //
    // Live 88780 reproduction (pre-fix):
    //   eth_getBlockByNumber("0x0",false).keys() — no "finalized"
    //   eth_getBlockByNumber("0xb200",false).keys() — has "finalized"
    //
    // Sibling Cancun fields (blobGasUsed, parentBeaconBlockRoot, etc.)
    // all use `?? <default>` fallbacks; finalized was the only one missed.
    await withTestServer(async (port) => {
      const genesis = await rpcCall(port, "eth_getBlockByNumber", ["0x0", false]) as Record<string, unknown>
      const regular = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as Record<string, unknown>

      const gkeys = new Set(Object.keys(genesis))
      const rkeys = new Set(Object.keys(regular))

      // No uncles[] on either (deprecated post-merge); always finalized key.
      assert.equal(gkeys.has("uncles"), false, "genesis must not expose uncles[]")
      assert.equal(rkeys.has("uncles"), false, "regular block must not expose uncles[]")
      assert.equal(gkeys.has("finalized"), true, "genesis must always include finalized as a boolean")
      assert.equal(rkeys.has("finalized"), true, "regular block must always include finalized")
      assert.equal(typeof genesis.finalized, "boolean", "finalized must be a boolean")
      assert.equal(typeof regular.finalized, "boolean", "finalized must be a boolean")

      // Cancun fields must be present on both.
      for (const required of ["blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "withdrawals", "withdrawalsRoot", "mixHash"]) {
        assert.equal(gkeys.has(required), true, `genesis must include ${required}`)
        assert.equal(rkeys.has(required), true, `regular block must include ${required}`)
      }

      // Symmetric diff must be empty — exact field-set parity.
      const diff = [
        ...[...gkeys].filter((k) => !rkeys.has(k)),
        ...[...rkeys].filter((k) => !gkeys.has(k)),
      ]
      assert.deepEqual(
        diff,
        [],
        `genesis and regular block field sets must match exactly (symmetric diff: ${diff.join(",")})`,
      )
    })
  })

  it("formatBlock size varies with transaction count", async () => {
    await withTestServer(async (port) => {
      const block0 = await rpcCall(port, "eth_getBlockByNumber", ["0x0", false]) as Record<string, unknown>
      const block1 = await rpcCall(port, "eth_getBlockByNumber", ["0x1", false]) as Record<string, unknown>

      const size0 = BigInt(block0.size as string)
      const size1 = BigInt(block1.size as string)

      // Block with tx should be larger than empty block
      assert.ok(size1 > size0, `block with tx (${size1}) should be larger than empty block (${size0})`)
      // Empty block should be header overhead only (508)
      assert.equal(size0, 508n)
    })
  })

  it("formatBlock includes type field for transactions in full-tx mode", async () => {
    await withTestServer(async (port) => {
      const block = await rpcCall(port, "eth_getBlockByNumber", ["0x1", true]) as Record<string, unknown>
      const txs = block.transactions as Array<Record<string, unknown>>
      assert.ok(txs.length > 0, "should have transactions")
      assert.ok("type" in txs[0], "transaction should have type field")
      assert.equal(txs[0].type, "0x2") // EIP-1559
    })
  })

  it("eth_blobBaseFee returns minimum blob gas price (0x1) when no excess", async () => {
    await withTestServer(async (port) => {
      const result = await rpcCall(port, "eth_blobBaseFee")
      // EIP-4844: minimum blob gas price is 1 when excessBlobGas = 0
      assert.equal(result, "0x1")
    })
  })
})
