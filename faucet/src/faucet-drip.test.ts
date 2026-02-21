/**
 * Faucet drip flow tests with mock RPC server.
 * Tests actual drip, cooldown, daily limit, and balance checks.
 */

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { keccak256 } from "ethers"
import { Faucet, FaucetError } from "./faucet.ts"

const FUNDED_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const VALID_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const FAKE_TX_HASH = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"

let mockNonce = 0

interface MockRpcOptions {
  balance?: bigint
  failSend?: boolean
}

function handleSingleRpc(body: { id: number; method: string; params?: unknown[] }, opts: MockRpcOptions) {
  const balance = opts.balance ?? 1000000000000000000000n // 1000 ETH default
  let result: unknown = null

  switch (body.method) {
    case "eth_chainId":
      result = "0x4964"
      break
    case "net_version":
      result = "18788"
      break
    case "eth_getBalance":
      result = "0x" + balance.toString(16)
      break
    case "eth_getTransactionCount":
      result = "0x" + mockNonce.toString(16)
      break
    case "eth_estimateGas":
      result = "0x5208"
      break
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
      result = "0x3b9aca00"
      break
    case "eth_getBlockByNumber":
      result = {
        number: "0x1",
        hash: "0x" + "ab".repeat(32),
        parentHash: "0x" + "00".repeat(32),
        timestamp: "0x60000000",
        baseFeePerGas: "0x3b9aca00",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        miner: "0x" + "00".repeat(20),
        difficulty: "0x0",
        totalDifficulty: "0x0",
        size: "0x100",
        extraData: "0x",
        nonce: "0x" + "00".repeat(8),
        transactions: [],
        uncles: [],
        sha3Uncles: "0x" + "00".repeat(32),
        logsBloom: "0x" + "00".repeat(256),
        transactionsRoot: "0x" + "00".repeat(32),
        stateRoot: "0x" + "00".repeat(32),
        receiptsRoot: "0x" + "00".repeat(32),
        mixHash: "0x" + "00".repeat(32),
      }
      break
    case "eth_sendRawTransaction": {
      if (opts.failSend) {
        return { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "tx failed" } }
      }
      mockNonce++
      // ethers.js verifies the returned hash matches keccak256(rawTx)
      const rawTx = (body.params ?? [])[0] as string
      result = keccak256(rawTx)
      break
    }
    case "eth_feeHistory":
      result = {
        baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
        gasUsedRatio: [0.5],
        oldestBlock: "0x1",
        reward: [["0x3b9aca00"]],
      }
      break
    case "eth_blockNumber":
      result = "0x1"
      break
    default:
      result = null
  }

  return { jsonrpc: "2.0", id: body.id, result }
}

function createMockRpcServer(opts: MockRpcOptions = {}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString()
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          res.writeHead(400)
          res.end("Invalid JSON")
          return
        }

        // Handle batch requests (ethers.js sends arrays)
        if (Array.isArray(parsed)) {
          const results = parsed.map((req: { id: number; method: string; params?: unknown[] }) =>
            handleSingleRpc(req, opts),
          )
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(results))
        } else {
          const result = handleSingleRpc(parsed as { id: number; method: string; params?: unknown[] }, opts)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(result))
        }
      })
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

let activeServer: Server | null = null

afterEach(() => {
  if (activeServer) {
    activeServer.close()
    activeServer = null
  }
  mockNonce = 0
})

describe("Faucet drip flow", () => {
  it("sends tokens successfully", async () => {
    const { server, port } = await createMockRpcServer()
    activeServer = server

    const faucet = new Faucet({
      rpcUrl: `http://127.0.0.1:${port}`,
      privateKey: FUNDED_PK,
      dripAmountEth: "10",
      dailyGlobalLimitEth: "10000",
      perAddressCooldownMs: 86_400_000,
    })

    const result = await faucet.requestDrip(VALID_ADDRESS)
    assert.ok(result.txHash, "should return a tx hash")
    assert.equal(result.amount, "10.0", "should return drip amount")
  })

  it("enforces per-address cooldown after drip", async () => {
    const { server, port } = await createMockRpcServer()
    activeServer = server

    const faucet = new Faucet({
      rpcUrl: `http://127.0.0.1:${port}`,
      privateKey: FUNDED_PK,
      dripAmountEth: "10",
      dailyGlobalLimitEth: "10000",
      perAddressCooldownMs: 60_000,
    })

    await faucet.requestDrip(VALID_ADDRESS)

    await assert.rejects(
      () => faucet.requestDrip(VALID_ADDRESS),
      (err: unknown) => {
        assert.ok(err instanceof FaucetError)
        assert.equal(err.statusCode, 429)
        assert.match(err.message, /Rate limited/)
        return true
      },
    )
  })

  it("allows drip to different addresses", async () => {
    const { server, port } = await createMockRpcServer()
    activeServer = server

    const faucet = new Faucet({
      rpcUrl: `http://127.0.0.1:${port}`,
      privateKey: FUNDED_PK,
      dripAmountEth: "10",
      dailyGlobalLimitEth: "10000",
      perAddressCooldownMs: 86_400_000,
    })

    const r1 = await faucet.requestDrip("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")
    assert.ok(r1.txHash)

    const r2 = await faucet.requestDrip("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")
    assert.ok(r2.txHash)
  })

  it("enforces daily global limit", async () => {
    const { server, port } = await createMockRpcServer()
    activeServer = server

    const faucet = new Faucet({
      rpcUrl: `http://127.0.0.1:${port}`,
      privateKey: FUNDED_PK,
      dripAmountEth: "10",
      dailyGlobalLimitEth: "15",
      perAddressCooldownMs: 0,
    })

    await faucet.requestDrip("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")

    await assert.rejects(
      () => faucet.requestDrip("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
      (err: unknown) => {
        assert.ok(err instanceof FaucetError)
        assert.equal(err.statusCode, 429)
        assert.match(err.message, /Daily faucet limit/)
        return true
      },
    )
  })

  it("rejects when faucet balance is too low", async () => {
    const { server, port } = await createMockRpcServer({
      balance: 1000000000000000000n, // Only 1 ETH, drip wants 10
    })
    activeServer = server

    const faucet = new Faucet({
      rpcUrl: `http://127.0.0.1:${port}`,
      privateKey: FUNDED_PK,
      dripAmountEth: "10",
      dailyGlobalLimitEth: "10000",
      perAddressCooldownMs: 86_400_000,
    })

    await assert.rejects(
      () => faucet.requestDrip(VALID_ADDRESS),
      (err: unknown) => {
        assert.ok(err instanceof FaucetError)
        assert.equal(err.statusCode, 503)
        assert.match(err.message, /balance too low/)
        return true
      },
    )
  })

  it("returns correct faucet status", async () => {
    const { server, port } = await createMockRpcServer({
      balance: 500000000000000000000n, // 500 ETH
    })
    activeServer = server

    const faucet = new Faucet({
      rpcUrl: `http://127.0.0.1:${port}`,
      privateKey: FUNDED_PK,
      dripAmountEth: "10",
      dailyGlobalLimitEth: "10000",
      perAddressCooldownMs: 0,
    })

    const status1 = await faucet.getStatus()
    assert.equal(status1.balance, "500.0")
    assert.equal(status1.totalDrips, 0)
    assert.equal(status1.dailyDrips, 0)
    assert.equal(status1.dripAmount, "10.0")
    assert.equal(status1.dailyLimit, "10000.0")

    await faucet.requestDrip(VALID_ADDRESS)

    const status2 = await faucet.getStatus()
    assert.equal(status2.totalDrips, 1)
    assert.equal(status2.dailyDrips, 1)
  })

  it("normalizes address case for cooldown tracking", async () => {
    const { server, port } = await createMockRpcServer()
    activeServer = server

    const faucet = new Faucet({
      rpcUrl: `http://127.0.0.1:${port}`,
      privateKey: FUNDED_PK,
      dripAmountEth: "10",
      dailyGlobalLimitEth: "10000",
      perAddressCooldownMs: 60_000,
    })

    await faucet.requestDrip("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")

    await assert.rejects(
      () => faucet.requestDrip("0x70997970c51812dc3a010c7d01b50e0d17dc79c8"),
      (err: unknown) => {
        assert.ok(err instanceof FaucetError)
        assert.equal(err.statusCode, 429)
        return true
      },
    )
  })
})
