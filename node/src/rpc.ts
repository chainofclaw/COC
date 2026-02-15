import http from "node:http"
import { SigningKey, keccak256, hashMessage, Transaction, TypedDataEncoder } from "ethers"
import type { IChainEngine } from "./chain-engine-types.ts"
import { hasGovernance, hasConfig, hasBlockIndex } from "./chain-engine-types.ts"
import type { EvmChain } from "./evm.ts"
import type { Hex, PendingFilter } from "./blockchain-types.ts"
import type { P2PNode } from "./p2p.ts"
import type { PoSeEngine } from "./pose-engine.ts"
import { registerPoseRoutes, handlePoseRequest } from "./pose-http.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import { calculateBaseFee, genesisBaseFee } from "./base-fee.ts"
import { traceTransaction, traceBlockByNumber, traceTransactionCalls } from "./debug-trace.ts"
import type { BftCoordinator } from "./bft-coordinator.ts"
import { RateLimiter } from "./rate-limiter.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("rpc")

// BigInt-safe JSON serializer for RPC responses
function jsonStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) =>
    typeof value === "bigint" ? `0x${value.toString(16)}` : value
  )
}

// RPC parameter validation helpers
function requireHexParam(params: unknown[], index: number, name: string): Hex {
  const value = (params ?? [])[index]
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw { code: -32602, message: `invalid ${name}: expected hex string` }
  }
  return value as Hex
}

function optionalHexParam(params: unknown[], index: number): Hex | undefined {
  const value = (params ?? [])[index]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !value.startsWith("0x")) return undefined
  return value as Hex
}

const MAX_RPC_BODY = 1024 * 1024 // 1 MB max request body for RPC
const rateLimiter = new RateLimiter()
// Cleanup expired buckets every 5 minutes
setInterval(() => rateLimiter.cleanup(), 300_000).unref()

// Test account feature gate: only enabled when COC_DEV_ACCOUNTS=1 or NODE_ENV=test
const DEV_ACCOUNTS_ENABLED = process.env.COC_DEV_ACCOUNTS === "1" ||
  process.env.NODE_ENV === "test"

// Debug/trace RPC feature gate: only enabled when COC_DEBUG_RPC=1
const DEBUG_RPC_ENABLED = process.env.COC_DEBUG_RPC === "1"

// Test account manager (dev/test only)
interface TestAccount {
  address: string
  privateKey: string
  signingKey: SigningKey
}

const testAccounts = new Map<string, TestAccount>()

// 初始化测试账户（仅用于开发/测试）
function initializeTestAccounts() {
  if (testAccounts.size > 0) return // 已初始化

  // 创建 10 个确定性测试账户
  const testPrivateKeys = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  ]

  for (const pk of testPrivateKeys) {
    const signingKey = new SigningKey(pk)
    const address = computeAddressFromPublicKey(signingKey.publicKey).toLowerCase()
    testAccounts.set(address, { address, privateKey: pk, signingKey })
  }

  log.info("initialized test accounts", { count: testAccounts.size })
}

function computeAddressFromPublicKey(publicKey: string): string {
  // publicKey = 0x04... (65 bytes uncompressed)
  // Ethereum address = keccak256(pubkey_without_04_prefix)[last 20 bytes]
  const pubkeyNoPrefix = Buffer.from(publicKey.slice(4), "hex")
  const hash = keccak256(pubkeyNoPrefix)
  return "0x" + hash.slice(-40)
}

interface JsonRpcRequest {
  id: string | number | null
  jsonrpc: string
  method: string
  params?: unknown[]
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { message: string }
}

export function startRpcServer(bind: string, port: number, chainId: number, evm: EvmChain, chain: IChainEngine, p2p: P2PNode, pose?: PoSeEngine, bftCoordinator?: BftCoordinator, nodeId?: string) {
  if (DEV_ACCOUNTS_ENABLED) {
    initializeTestAccounts()
  }

  const filters = new Map<string, PendingFilter>()
  const poseRoutes = pose ? registerPoseRoutes(pose) : []

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")

    if (req.method === "OPTIONS") {
      res.writeHead(200)
      res.end()
      return
    }

    // Rate limiting per IP
    const clientIp = req.socket.remoteAddress ?? "unknown"
    if (!rateLimiter.allow(clientIp)) {
      res.writeHead(429, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "rate limit exceeded" } }))
      return
    }

    // Handle PoSe routes first
    if (pose && handlePoseRequest(poseRoutes, req, res)) {
      return
    }

    if (req.method !== "POST") {
      res.writeHead(405)
      res.end()
      return
    }

    let body = ""
    let bodySize = 0
    let aborted = false
    req.on("data", (chunk: Buffer | string) => {
      bodySize += typeof chunk === "string" ? chunk.length : chunk.byteLength
      if (bodySize > MAX_RPC_BODY) {
        aborted = true
        res.writeHead(413, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } }))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on("end", async () => {
      if (aborted) return
      try {
        if (!body || body.trim().length === 0) {
          return sendError(res, null, "empty request")
        }

        const payload = JSON.parse(body)
        const rpcOpts = nodeId ? { nodeId } : undefined
        const response = Array.isArray(payload)
          ? await Promise.all(payload.map((item) => handleOne(item, chainId, evm, chain, p2p, filters, bftCoordinator, rpcOpts)))
          : await handleOne(payload, chainId, evm, chain, p2p, filters, bftCoordinator, rpcOpts)

        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "application/json" })
        }
        res.end(jsonStringify(response))
      } catch (error) {
        sendError(res, null, String(error))
      }
    })
  })

  server.listen(port, bind, () => {
    log.info("listening", { bind, port })
  })
}

async function handleOne(
  payload: JsonRpcRequest,
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  filters: Map<string, PendingFilter>,
  bftCoordinator?: BftCoordinator,
  opts?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  if (!payload || typeof payload !== "object" || !payload.method) {
    return { jsonrpc: "2.0", id: payload?.id ?? null, error: { message: "invalid request" } }
  }

  try {
    const result = await handleRpc(payload, chainId, evm, chain, p2p, filters, bftCoordinator, opts)
    return { jsonrpc: "2.0", id: payload.id ?? null, result }
  } catch (error: unknown) {
    // Support structured RPC errors (e.g. { code, message } from param validation)
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      const rpcErr = error as { code: number; message: string }
      return { jsonrpc: "2.0", id: payload.id ?? null, error: { code: rpcErr.code, message: rpcErr.message } }
    }
    return { jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32603, message: String(error) } }
  }
}

function sendError(res: http.ServerResponse, id: string | number | null, message: string) {
  if (!res.headersSent) {
    res.writeHead(500, { "content-type": "application/json" })
  }
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { message } }))
}

/**
 * Exported RPC method handler for reuse by WebSocket server.
 * Handles all standard JSON-RPC methods except eth_subscribe/eth_unsubscribe.
 */
export async function handleRpcMethod(
  method: string,
  params: unknown[],
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  bftCoordinator?: BftCoordinator,
): Promise<unknown> {
  const payload = { method, params, id: null, jsonrpc: "2.0" as const }
  const filters = new Map<string, PendingFilter>()
  return handleRpc(payload, chainId, evm, chain, p2p, filters, bftCoordinator)
}

async function handleRpc(
  payload: JsonRpcRequest,
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  filters: Map<string, PendingFilter>,
  bftCoordinator?: BftCoordinator,
  opts?: Record<string, unknown>,
) {
  switch (payload.method) {
    case "web3_clientVersion":
      return "COC/0.2"
    case "net_version":
      return String(chainId)
    case "eth_chainId":
      return `0x${chainId.toString(16)}`
    case "eth_blockNumber": {
      const height = await Promise.resolve(chain.getHeight())
      return `0x${height.toString(16)}`
    }
    case "eth_getBalance": {
      const address = String((payload.params ?? [])[0] ?? "")
      const balance = await evm.getBalance(address)
      return `0x${balance.toString(16)}`
    }
    case "eth_getTransactionCount": {
      const address = String((payload.params ?? [])[0] ?? "")
      const nonce = await evm.getNonce(address)
      return `0x${nonce.toString(16)}`
    }
    case "eth_getTransactionReceipt": {
      const hash = requireHexParam(payload.params ?? [], 0, "transaction hash")
      // Try persistent index first, then fall back to EVM memory
      if (typeof chain.getTransactionByHash === "function") {
        const tx = await chain.getTransactionByHash(hash as Hex)
        if (tx?.receipt) {
          const r = tx.receipt
          return {
            transactionHash: r.transactionHash,
            blockNumber: `0x${r.blockNumber.toString(16)}`,
            blockHash: r.blockHash,
            from: r.from,
            to: r.to,
            gasUsed: `0x${r.gasUsed.toString(16)}`,
            status: r.status === 1n ? "0x1" : "0x0",
            logs: (r.logs ?? []).map((log, idx) => ({
              address: log.address,
              topics: log.topics,
              data: log.data,
              blockNumber: `0x${r.blockNumber.toString(16)}`,
              blockHash: r.blockHash,
              transactionHash: r.transactionHash,
              logIndex: `0x${idx.toString(16)}`,
              removed: false,
            })),
          }
        }
      }
      return evm.getReceipt(hash)
    }
    case "eth_getTransactionByHash": {
      const hash = requireHexParam(payload.params ?? [], 0, "transaction hash")
      // Try persistent index first, then fall back to EVM memory
      if (typeof chain.getTransactionByHash === "function") {
        const tx = await chain.getTransactionByHash(hash as Hex)
        if (tx) {
          return {
            hash: tx.receipt.transactionHash,
            from: tx.receipt.from,
            to: tx.receipt.to,
            blockNumber: `0x${tx.receipt.blockNumber.toString(16)}`,
            blockHash: tx.receipt.blockHash,
            input: tx.rawTx,
          }
        }
      }
      return evm.getTransaction(hash)
    }
    case "eth_getBlockByNumber": {
      const tag = String((payload.params ?? [])[0] ?? "latest")
      const includeTx = Boolean((payload.params ?? [])[1])
      const currentHeight = await Promise.resolve(chain.getHeight())
      const number = tag === "latest" ? currentHeight
        : tag === "earliest" ? 0n
        : tag === "pending" ? currentHeight
        : BigInt(tag)
      const block = await Promise.resolve(chain.getBlockByNumber(number))
      return formatBlock(block, includeTx, chain, evm)
    }
    case "eth_getBlockByHash": {
      const hash = String((payload.params ?? [])[0] ?? "") as Hex
      const includeTx = Boolean((payload.params ?? [])[1])
      const block = await Promise.resolve(chain.getBlockByHash(hash))
      return formatBlock(block, includeTx, chain, evm)
    }
    case "eth_gasPrice": {
      const baseFee = await computeCurrentBaseFee(chain)
      // Gas price = baseFee + suggested tip (1 gwei)
      const suggestedPrice = baseFee + 1_000_000_000n
      return `0x${suggestedPrice.toString(16)}`
    }
    case "eth_estimateGas": {
      const estParams = ((payload.params ?? [])[0] ?? {}) as Record<string, string>
      const estimated = await evm.estimateGas({
        from: estParams.from,
        to: estParams.to ?? "",
        data: estParams.data,
        value: estParams.value,
      })
      return `0x${estimated.toString(16)}`
    }
    case "eth_getCode": {
      const codeAddr = String((payload.params ?? [])[0] ?? "")
      return await evm.getCode(codeAddr)
    }
    case "eth_call": {
      const callParams = ((payload.params ?? [])[0] ?? {}) as Record<string, string>
      const callResult = await evm.callRaw({
        from: callParams.from,
        to: callParams.to ?? "",
        data: callParams.data,
        value: callParams.value,
        gas: callParams.gas,
      })
      return callResult.returnValue
    }
    case "eth_getStorageAt": {
      const storageAddr = String((payload.params ?? [])[0] ?? "")
      const storageSlot = String((payload.params ?? [])[1] ?? "0x0")
      return await evm.getStorageAt(storageAddr, storageSlot)
    }
    case "eth_syncing":
      return false
    case "net_listening":
      return true
    case "net_peerCount":
      return `0x${p2p ? "1" : "0"}`
    case "eth_accounts":
      if (!DEV_ACCOUNTS_ENABLED) return []
      return Array.from(testAccounts.keys())
    case "web3_sha3": {
      const hex = String((payload.params ?? [])[0] ?? "0x")
      const bytes = Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex")
      return `0x${keccak256Hex(bytes)}`
    }
    case "eth_sendRawTransaction": {
      const raw = String((payload.params ?? [])[0] ?? "") as Hex
      const tx = await chain.addRawTx(raw)
      await p2p.receiveTx(raw)
      return tx.hash
    }
    case "eth_getLogs": {
      const query = ((payload.params ?? [])[0] ?? {}) as Record<string, unknown>
      return await queryLogs(chain, query)
    }
    case "eth_newFilter": {
      const query = ((payload.params ?? [])[0] ?? {}) as Record<string, unknown>
      const id = `0x${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16)}`
      const fromBlock = parseBlockTag(query.fromBlock, 0n)
      const newFilterHeight = await Promise.resolve(chain.getHeight())
      const toBlock = query.toBlock !== undefined ? parseBlockTag(query.toBlock, newFilterHeight) : undefined
      const filter: PendingFilter = {
        id,
        fromBlock,
        toBlock,
        address: query.address ? String(query.address).toLowerCase() as Hex : undefined,
        topics: Array.isArray(query.topics) ? query.topics.map((t) => (t ? String(t) as Hex : null)) : undefined,
        lastCursor: fromBlock > 0n ? fromBlock - 1n : 0n,
      }
      filters.set(id, filter)
      return id
    }
    case "eth_getFilterChanges": {
      const id = String((payload.params ?? [])[0] ?? "")
      const filter = filters.get(id)
      if (!filter) return []
      const start = filter.lastCursor + 1n
      const filterHeight = await Promise.resolve(chain.getHeight())
      const logs = await collectLogs(chain, start, filter.toBlock ?? filterHeight, filter)
      filter.lastCursor = filterHeight
      return logs
    }
    case "eth_uninstallFilter": {
      const id = String((payload.params ?? [])[0] ?? "")
      return filters.delete(id)
    }
    case "eth_sendTransaction": {
      const txParams = ((payload.params ?? [])[0] ?? {}) as Record<string, string>
      const from = txParams.from?.toLowerCase()
      if (!from) throw new Error("missing from address")

      const account = testAccounts.get(from)
      if (!account) throw new Error(`account not found: ${from}. Use eth_accounts to list available test accounts.`)

      const onchainNonce = await evm.getNonce(from)
      const nonce = chain.mempool.getPendingNonce(from as Hex, onchainNonce)
      const gasPrice = txParams.gasPrice ?? "0x3b9aca00" // 1 gwei
      const gasLimitRaw = txParams.gas ?? "0x" + (await evm.estimateGas({
        from: txParams.from,
        to: txParams.to ?? "",
        data: txParams.data ?? "0x",
        value: txParams.value ?? "0x0",
      })).toString(16)

      const tx = Transaction.from({
        to: txParams.to,
        value: txParams.value ?? "0x0",
        data: txParams.data ?? "0x",
        nonce: Number(nonce),
        gasLimit: gasLimitRaw,
        gasPrice,
        chainId,
      })

      const sig = account.signingKey.sign(tx.unsignedHash)
      const signed = tx.clone()
      signed.signature = sig
      const serialized = signed.serialized as Hex
      const result = await chain.addRawTx(serialized)
      await p2p.receiveTx(serialized)
      return result.hash
    }
    case "eth_sign": {
      const address = String((payload.params ?? [])[0] ?? "").toLowerCase()
      const message = String((payload.params ?? [])[1] ?? "")

      const account = testAccounts.get(address)
      if (!account) throw new Error(`account not found: ${address}`)

      const messageHash = hashMessage(Buffer.from(message.startsWith("0x") ? message.slice(2) : message, "hex"))
      const signature = account.signingKey.sign(messageHash)
      return signature.serialized
    }
    case "eth_signTypedData_v4": {
      const address = String((payload.params ?? [])[0] ?? "").toLowerCase()
      const typedData = (payload.params ?? [])[1]

      const account = testAccounts.get(address)
      if (!account) throw new Error(`account not found: ${address}`)

      // EIP-712 compliant: use TypedDataEncoder for correct domain-separated hash
      const td = typedData as Record<string, unknown>
      const types = (td.types ?? {}) as Record<string, Array<{ name: string; type: string }>>
      const domain = (td.domain ?? {}) as Record<string, unknown>
      const message = (td.message ?? {}) as Record<string, unknown>
      // Remove EIP712Domain from types (TypedDataEncoder handles it internally)
      const filteredTypes = { ...types }
      delete filteredTypes.EIP712Domain
      const dataHash = TypedDataEncoder.hash(domain, filteredTypes, message)
      const signature = account.signingKey.sign(dataHash)
      return signature.serialized
    }
    case "eth_createAccessList": {
      const callParams = ((payload.params ?? [])[0] ?? {}) as Record<string, string>

      // 执行调用以追踪访问的存储槽
      await evm.callRaw({
        from: callParams.from,
        to: callParams.to ?? "",
        data: callParams.data,
        value: callParams.value,
        gas: callParams.gas,
      })

      // 简化实现：返回空访问列表（真实实现需要 EVM 追踪）
      return {
        accessList: [],
        gasUsed: "0x0"
      }
    }
    case "debug_traceTransaction": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const txHash = String((payload.params ?? [])[0] ?? "") as Hex
      const traceOpts = ((payload.params ?? [])[1] ?? {}) as Record<string, unknown>
      return await traceTransaction(txHash, chain, evm, {
        disableStorage: Boolean(traceOpts.disableStorage),
        disableMemory: Boolean(traceOpts.disableMemory),
        disableStack: Boolean(traceOpts.disableStack),
        tracer: traceOpts.tracer ? String(traceOpts.tracer) : undefined,
      })
    }
    case "debug_traceBlockByNumber": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const blockTag = String((payload.params ?? [])[0] ?? "latest")
      const traceHeight = await Promise.resolve(chain.getHeight())
      const traceBlockNum = blockTag === "latest" ? traceHeight : BigInt(blockTag)
      const traceOpts2 = ((payload.params ?? [])[1] ?? {}) as Record<string, unknown>
      return await traceBlockByNumber(traceBlockNum, chain, evm, {
        disableStorage: Boolean(traceOpts2.disableStorage),
        disableMemory: Boolean(traceOpts2.disableMemory),
        disableStack: Boolean(traceOpts2.disableStack),
      })
    }
    case "trace_transaction": {
      if (!DEBUG_RPC_ENABLED) throw { code: -32601, message: "debug methods disabled (set COC_DEBUG_RPC=1)" }
      const txHash = String((payload.params ?? [])[0] ?? "") as Hex
      return await traceTransactionCalls(txHash, chain, evm)
    }
    case "eth_getBlockTransactionCountByHash": {
      const hash = String((payload.params ?? [])[0] ?? "") as Hex
      const block = await Promise.resolve(chain.getBlockByHash(hash))
      return block ? `0x${block.txs.length.toString(16)}` : null
    }
    case "eth_getBlockTransactionCountByNumber": {
      const tag = String((payload.params ?? [])[0] ?? "latest")
      const height = await Promise.resolve(chain.getHeight())
      const num = tag === "latest" ? height : tag === "earliest" ? 0n : tag === "pending" ? height : BigInt(tag)
      const block = await Promise.resolve(chain.getBlockByNumber(num))
      return block ? `0x${block.txs.length.toString(16)}` : null
    }
    case "eth_getTransactionByBlockHashAndIndex": {
      const blockHash = String((payload.params ?? [])[0] ?? "") as Hex
      const txIndex = Number((payload.params ?? [])[1] ?? 0)
      const block = await Promise.resolve(chain.getBlockByHash(blockHash))
      if (!block || txIndex >= block.txs.length) return null
      const rawTx = block.txs[txIndex]
      try {
        const parsed = Transaction.from(rawTx)
        return {
          hash: parsed.hash,
          from: parsed.from,
          to: parsed.to,
          nonce: `0x${parsed.nonce.toString(16)}`,
          value: `0x${(parsed.value ?? 0n).toString(16)}`,
          gas: `0x${(parsed.gasLimit ?? 21000n).toString(16)}`,
          gasPrice: `0x${(parsed.gasPrice ?? 0n).toString(16)}`,
          input: parsed.data ?? "0x",
          blockHash: block.hash,
          blockNumber: `0x${block.number.toString(16)}`,
          transactionIndex: `0x${txIndex.toString(16)}`,
        }
      } catch { return null }
    }
    case "eth_getTransactionByBlockNumberAndIndex": {
      const tag = String((payload.params ?? [])[0] ?? "latest")
      const txIdx = Number((payload.params ?? [])[1] ?? 0)
      const height = await Promise.resolve(chain.getHeight())
      const num = tag === "latest" ? height : tag === "earliest" ? 0n : tag === "pending" ? height : BigInt(tag)
      const block = await Promise.resolve(chain.getBlockByNumber(num))
      if (!block || txIdx >= block.txs.length) return null
      const rawTx = block.txs[txIdx]
      try {
        const parsed = Transaction.from(rawTx)
        return {
          hash: parsed.hash,
          from: parsed.from,
          to: parsed.to,
          nonce: `0x${parsed.nonce.toString(16)}`,
          value: `0x${(parsed.value ?? 0n).toString(16)}`,
          gas: `0x${(parsed.gasLimit ?? 21000n).toString(16)}`,
          gasPrice: `0x${(parsed.gasPrice ?? 0n).toString(16)}`,
          input: parsed.data ?? "0x",
          blockHash: block.hash,
          blockNumber: `0x${block.number.toString(16)}`,
          transactionIndex: `0x${txIdx.toString(16)}`,
        }
      } catch { return null }
    }
    case "eth_getUncleCountByBlockHash":
    case "eth_getUncleCountByBlockNumber":
    case "eth_getUncleByBlockHashAndIndex":
    case "eth_getUncleByBlockNumberAndIndex":
      // COC uses PoSe consensus with no uncle blocks
      return payload.method.includes("Count") ? "0x0" : null
    case "eth_protocolVersion":
      return "0x41" // 65
    case "eth_feeHistory": {
      const blockCount = Number((payload.params ?? [])[0] ?? 1)
      const newestBlock = String((payload.params ?? [])[1] ?? "latest")
      const rewardPercentiles = ((payload.params ?? [])[2] ?? []) as number[]
      const height = await Promise.resolve(chain.getHeight())
      const newest = newestBlock === "latest" ? height : BigInt(newestBlock)
      const count = Math.min(blockCount, Number(newest), 1024)
      const baseFees: string[] = []
      const gasUsedRatios: number[] = []
      const rewards: string[][] = []
      for (let i = 0; i < count; i++) {
        baseFees.push("0x3b9aca00") // 1 gwei
        gasUsedRatios.push(0.5)
        if (rewardPercentiles.length > 0) {
          rewards.push(rewardPercentiles.map(() => "0x3b9aca00"))
        }
      }
      baseFees.push("0x3b9aca00") // extra entry for next block
      return {
        oldestBlock: `0x${(newest - BigInt(count) + 1n).toString(16)}`,
        baseFeePerGas: baseFees,
        gasUsedRatio: gasUsedRatios,
        ...(rewardPercentiles.length > 0 ? { reward: rewards } : {}),
      }
    }
    case "eth_newBlockFilter": {
      const id = `0x${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16)}`
      const height = await Promise.resolve(chain.getHeight())
      const filter: PendingFilter = {
        id,
        fromBlock: height,
        lastCursor: height,
      }
      filters.set(id, filter)
      return id
    }
    case "eth_newPendingTransactionFilter": {
      const id = `0x${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16)}`
      const filter: PendingFilter = {
        id,
        fromBlock: 0n,
        lastCursor: 0n,
      }
      filters.set(id, filter)
      return id
    }
    case "eth_getFilterLogs": {
      const id = String((payload.params ?? [])[0] ?? "")
      const filter = filters.get(id)
      if (!filter) return []
      const height = await Promise.resolve(chain.getHeight())
      return collectLogs(chain, filter.fromBlock, filter.toBlock ?? height, filter)
    }
    case "eth_maxPriorityFeePerGas":
      return "0x3b9aca00" // 1 gwei
    case "eth_mining":
      return false
    case "eth_hashrate":
      return "0x0"
    case "eth_coinbase":
      return "0x0000000000000000000000000000000000000000"
    case "eth_compileSolidity":
    case "eth_compileLLL":
    case "eth_compileSerpent":
    case "eth_getCompilers":
      throw new Error("compilation methods are not supported")
    case "eth_getBlockReceipts": {
      const tag = String((payload.params ?? [])[0] ?? "latest")
      const height = await Promise.resolve(chain.getHeight())
      const num = tag === "latest" ? height : tag === "earliest" ? 0n : tag === "pending" ? height : BigInt(tag)
      const block = await Promise.resolve(chain.getBlockByNumber(num))
      if (!block) return null
      const receipts: unknown[] = []
      for (let i = 0; i < block.txs.length; i++) {
        try {
          const parsed = Transaction.from(block.txs[i])
          if (typeof chain.getTransactionByHash === "function") {
            const tx = await chain.getTransactionByHash(parsed.hash as Hex)
            if (tx?.receipt) {
              const r = tx.receipt
              receipts.push({
                transactionHash: r.transactionHash,
                transactionIndex: `0x${i.toString(16)}`,
                blockNumber: `0x${block.number.toString(16)}`,
                blockHash: block.hash,
                from: r.from,
                to: r.to,
                gasUsed: `0x${r.gasUsed.toString(16)}`,
                status: r.status === 1n ? "0x1" : "0x0",
                logs: (r.logs ?? []).map((log: any, idx: number) => ({
                  address: log.address,
                  topics: log.topics,
                  data: log.data,
                  blockNumber: `0x${block.number.toString(16)}`,
                  blockHash: block.hash,
                  transactionHash: r.transactionHash,
                  transactionIndex: `0x${i.toString(16)}`,
                  logIndex: `0x${idx.toString(16)}`,
                  removed: false,
                })),
              })
            }
          }
        } catch { /* skip unparseable */ }
      }
      return receipts
    }
    case "txpool_status": {
      const stats = chain.mempool.stats()
      return {
        pending: `0x${stats.size.toString(16)}`,
        queued: "0x0",
      }
    }
    case "txpool_content": {
      const allTxs = chain.mempool.getAll()
      const pending: Record<string, Record<string, unknown>> = {}
      for (const mtx of allTxs) {
        const sender = mtx.from
        if (!pending[sender]) pending[sender] = {}
        const parsed = Transaction.from(mtx.rawTx)
        pending[sender][mtx.nonce.toString()] = {
          hash: mtx.hash,
          nonce: `0x${mtx.nonce.toString(16)}`,
          from: mtx.from,
          to: parsed.to ?? null,
          value: `0x${(parsed.value ?? 0n).toString(16)}`,
          gas: `0x${mtx.gasLimit.toString(16)}`,
          gasPrice: `0x${mtx.gasPrice.toString(16)}`,
          input: parsed.data ?? "0x",
        }
      }
      return { pending, queued: {} }
    }
    case "coc_getTransactionsByAddress": {
      const addr = String((payload.params ?? [])[0] ?? "").toLowerCase() as Hex
      const limit = Number((payload.params ?? [])[1] ?? 50)
      const reverse = (payload.params ?? [])[2] !== false
      const offset = Number((payload.params ?? [])[3] ?? 0)

      if (typeof chain.getTransactionsByAddress === "function") {
        const txs = await chain.getTransactionsByAddress(addr, { limit, reverse, offset })
        return txs.map((tx) => ({
          hash: tx.receipt.transactionHash,
          from: tx.receipt.from,
          to: tx.receipt.to,
          blockNumber: `0x${tx.receipt.blockNumber.toString(16)}`,
          blockHash: tx.receipt.blockHash,
          gasUsed: `0x${tx.receipt.gasUsed.toString(16)}`,
          status: `0x${tx.receipt.status.toString(16)}`,
          input: tx.rawTx,
          logs: tx.receipt.logs,
        }))
      }
      return []
    }
    case "coc_nodeInfo": {
      const height = await Promise.resolve(chain.getHeight())
      const mempoolStats = chain.mempool.stats()
      return {
        clientVersion: "COC/0.2",
        chainId,
        blockHeight: height,
        mempool: mempoolStats,
        uptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      }
    }
    case "coc_validators": {
      const height = await Promise.resolve(chain.getHeight())
      const nextHeight = height + 1n
      const currentProposer = chain.expectedProposer(nextHeight)
      // Return validator info from the chain engine's round-robin
      const validators: unknown[] = []
      const seen = new Set<string>()
      // Sample expected proposers to discover all validators
      for (let h = nextHeight; h < nextHeight + 200n; h++) {
        const v = chain.expectedProposer(h)
        if (seen.has(v)) continue
        seen.add(v)
        validators.push({
          id: v,
          isCurrentProposer: v === currentProposer,
          nextProposalBlock: Number(h),
        })
      }
      return { validators, currentHeight: height, nextProposer: currentProposer }
    }
    case "coc_prunerStats": {
      if (typeof chain.getPrunerStats === "function") {
        return await chain.getPrunerStats()
      }
      return { latestBlock: 0, pruningHeight: 0, retainedBlocks: 0 }
    }
    case "coc_getValidators": {
      if (hasGovernance(chain)) {
        const validators = chain.governance.getActiveValidators()
        return validators.map((v) => ({
          id: v.id,
          address: v.address,
          stake: `0x${v.stake.toString(16)}`,
          votingPower: v.votingPower,
          active: v.active,
          joinedAtEpoch: `0x${v.joinedAtEpoch.toString(16)}`,
        }))
      }
      // Fallback: return basic validator info from round-robin
      const height = await Promise.resolve(chain.getHeight())
      return chain.expectedProposer(height + 1n)
    }
    case "coc_submitProposal": {
      if (!hasGovernance(chain)) throw new Error("governance not enabled")
      const proposalParams = (payload.params ?? [])[0] as Record<string, string>
      // Only the local node can submit proposals via RPC
      const localNodeId = (opts as Record<string, unknown>)?.nodeId as string | undefined
      if (localNodeId && proposalParams.proposer !== localNodeId) {
        throw { code: -32003, message: "unauthorized: can only submit proposals as local node" }
      }
      const proposal = chain.governance.submitProposal(
        proposalParams.type,
        proposalParams.targetId,
        proposalParams.proposer,
        {
          targetAddress: proposalParams.targetAddress,
          stakeAmount: proposalParams.stakeAmount ? BigInt(proposalParams.stakeAmount) : undefined,
        },
      )
      return {
        id: proposal.id,
        type: proposal.type,
        targetId: proposal.targetId,
        status: proposal.status,
      }
    }
    case "coc_voteProposal": {
      if (!hasGovernance(chain)) throw new Error("governance not enabled")
      const voteParams = (payload.params ?? [])[0] as Record<string, unknown>
      // Only the local node can vote via RPC
      const localVoterId = (opts as Record<string, unknown>)?.nodeId as string | undefined
      if (localVoterId && String(voteParams.voterId) !== localVoterId) {
        throw { code: -32003, message: "unauthorized: can only vote as local node" }
      }
      chain.governance.vote(
        String(voteParams.proposalId),
        String(voteParams.voterId),
        Boolean(voteParams.approve),
      )
      const updated = chain.governance.getProposal(String(voteParams.proposalId))
      return {
        id: updated?.id,
        status: updated?.status,
        votes: updated?.votes ? Object.fromEntries(updated.votes) : {},
      }
    }
    case "coc_getGovernanceStats": {
      if (!hasGovernance(chain)) {
        return { enabled: false }
      }
      const gStats = chain.governance.getGovernanceStats()
      return {
        enabled: true,
        activeValidators: gStats.activeValidators,
        totalStake: `0x${gStats.totalStake.toString(16)}`,
        pendingProposals: gStats.pendingProposals,
        totalProposals: gStats.totalProposals,
        currentEpoch: `0x${gStats.currentEpoch.toString(16)}`,
      }
    }
    case "coc_getProposals": {
      if (!hasGovernance(chain)) return []
      const statusFilter = ((payload.params ?? [])[0] as string | undefined) ?? undefined
      const validStatuses = ["pending", "approved", "rejected", "expired"]
      const filter = statusFilter && validStatuses.includes(statusFilter) ? statusFilter as "pending" | "approved" | "rejected" | "expired" : undefined
      const proposals = chain.governance.getProposals(filter)
      return proposals.map((p) => ({
        id: p.id,
        type: p.type,
        targetId: p.targetId,
        targetAddress: p.targetAddress ?? null,
        stakeAmount: p.stakeAmount !== undefined ? `0x${p.stakeAmount.toString(16)}` : null,
        proposer: p.proposer,
        createdAtEpoch: `0x${p.createdAtEpoch.toString(16)}`,
        expiresAtEpoch: `0x${p.expiresAtEpoch.toString(16)}`,
        status: p.status,
        voteCount: p.votes.size,
      }))
    }
    case "coc_getBftStatus": {
      if (!bftCoordinator) {
        return { enabled: false, active: false }
      }
      const bftState = bftCoordinator.getRoundState()
      return {
        enabled: true,
        active: bftState.active,
        height: bftState.height ? `0x${bftState.height.toString(16)}` : null,
        phase: bftState.phase,
        prepareVotes: bftState.prepareVotes,
        commitVotes: bftState.commitVotes,
        equivocations: bftState.equivocations,
      }
    }
    case "coc_getNetworkStats": {
      const peerCount = p2p?.getPeers?.()?.length ?? 0
      const height = await Promise.resolve(chain.getHeight())

      // BFT status
      const bft = bftCoordinator
        ? { enabled: true, ...bftCoordinator.getRoundState() }
        : { enabled: false }

      // Wire protocol stats (if available via opts)
      const wireStats = (opts as Record<string, unknown>)?.wireConnectionManager
        ? (((opts as Record<string, unknown>).wireConnectionManager) as { getStats: () => unknown }).getStats()
        : null

      // DHT stats (if available via opts)
      const dhtStats = (opts as Record<string, unknown>)?.dhtNetwork
        ? (((opts as Record<string, unknown>).dhtNetwork) as { getStats: () => unknown }).getStats()
        : null

      return {
        blockHeight: `0x${height.toString(16)}`,
        peerCount,
        p2p: {
          peers: peerCount,
          protocol: "http-gossip",
        },
        wire: wireStats ? { enabled: true, ...wireStats } : { enabled: false },
        dht: dhtStats ? { enabled: true, ...dhtStats } : { enabled: false },
        bft,
        consensus: {
          state: "active",
        },
      }
    }
    case "coc_chainStats": {
      const height = await Promise.resolve(chain.getHeight())
      const latest = await Promise.resolve(chain.getBlockByNumber(height))
      const poolStats = chain.mempool.stats()
      const validators = hasConfig(chain) ? chain.cfg.validators : []

      // Calculate blocks per minute from last 10 blocks
      let blocksPerMin = 0
      if (height > 1n) {
        const lookback = height > 10n ? 10n : height
        const oldBlock = await Promise.resolve(chain.getBlockByNumber(height - lookback + 1n))
        if (oldBlock && latest) {
          const elapsed = (latest.timestampMs - oldBlock.timestampMs) / 1000
          blocksPerMin = elapsed > 0 ? Number(lookback) / elapsed * 60 : 0
        }
      }

      // Count total txs from last 100 blocks
      let recentTxCount = 0
      const scanFrom = height > 100n ? height - 99n : 1n
      for (let i = scanFrom; i <= height; i++) {
        const b = await Promise.resolve(chain.getBlockByNumber(i))
        if (b) recentTxCount += b.txs.length
      }

      return {
        blockHeight: `0x${height.toString(16)}`,
        latestBlockTime: latest?.timestampMs ?? 0,
        blocksPerMinute: Math.round(blocksPerMin * 100) / 100,
        pendingTxCount: poolStats.size,
        recentTxCount,
        validatorCount: validators.length,
        chainId: `0x${hasConfig(chain) ? chain.cfg.chainId.toString(16) : "1"}`,
      }
    }
    case "coc_getContracts": {
      if (hasBlockIndex(chain)) {
        const opts = (payload.params ?? [])[0] as Record<string, unknown> | undefined
        const contracts = await chain.blockIndex.getContracts({
          limit: Number(opts?.limit ?? 50),
          offset: Number(opts?.offset ?? 0),
          reverse: opts?.reverse !== false,
        })
        return contracts.map((c) => ({
          address: c.address,
          blockNumber: `0x${c.blockNumber.toString(16)}`,
          txHash: c.txHash,
          creator: c.creator,
          deployedAt: c.deployedAt,
        }))
      }
      return []
    }
    case "coc_getContractInfo": {
      const addr = (payload.params ?? [])[0] as string
      if (!addr) throw new Error("address required")
      if (hasBlockIndex(chain)) {
        const info = await chain.blockIndex.getContractInfo(addr as Hex)
        if (!info) return null
        return {
          address: info.address,
          blockNumber: `0x${info.blockNumber.toString(16)}`,
          txHash: info.txHash,
          creator: info.creator,
          deployedAt: info.deployedAt,
        }
      }
      return null
    }
    default:
      throw new Error(`method not supported: ${payload.method}`)
  }
}

function parseBlockTag(input: unknown, fallback: bigint): bigint {
  if (typeof input === "string") {
    if (input === "latest") return fallback
    return BigInt(input)
  }
  return fallback
}

async function formatBlock(block: Awaited<ReturnType<IChainEngine["getBlockByNumber"]>>, includeTx: boolean, chain?: IChainEngine, evm?: EvmChain) {
  if (!block) return null

  // Aggregate logsBloom and gasUsed from block receipts
  let aggregatedBloom = "0x" + "0".repeat(512)
  let totalGasUsed = BigInt(block.txs.length * 21_000) // fallback estimate
  if (chain && evm) {
    const receipts = await Promise.resolve(chain.getReceiptsByBlock(block.number))
    if (receipts.length > 0) {
      totalGasUsed = 0n
      for (const receipt of receipts) {
        totalGasUsed += receipt.gasUsed ?? 0n
        if (receipt.logsBloom && receipt.logsBloom !== "0x" + "0".repeat(512)) {
          aggregatedBloom = receipt.logsBloom
        }
      }
    }
  }

  // Parse raw txs directly instead of O(n*m) search through EVM receipts
  let transactions: unknown[]
  const blockNumHex = `0x${block.number.toString(16)}`
  if (includeTx) {
    transactions = block.txs.map((rawTx, i) => {
      try {
        const parsed = Transaction.from(rawTx)
        return {
          hash: parsed.hash,
          from: parsed.from,
          to: parsed.to ?? null,
          nonce: `0x${parsed.nonce.toString(16)}`,
          value: `0x${(parsed.value ?? 0n).toString(16)}`,
          gas: `0x${(parsed.gasLimit ?? 21000n).toString(16)}`,
          gasPrice: `0x${(parsed.gasPrice ?? parsed.maxFeePerGas ?? 0n).toString(16)}`,
          input: parsed.data ?? "0x",
          blockHash: block.hash,
          blockNumber: blockNumHex,
          transactionIndex: `0x${i.toString(16)}`,
          type: `0x${(parsed.type ?? 0).toString(16)}`,
          v: parsed.signature?.v !== undefined ? `0x${parsed.signature.v.toString(16)}` : "0x0",
          r: parsed.signature?.r ?? "0x0",
          s: parsed.signature?.s ?? "0x0",
        }
      } catch {
        return rawTx
      }
    })
  } else {
    transactions = block.txs.map((rawTx) => {
      try {
        return Transaction.from(rawTx).hash
      } catch {
        return keccak256Hex(Buffer.from(rawTx.slice(2), "hex"))
      }
    })
  }

  return {
    number: `0x${block.number.toString(16)}`,
    hash: block.hash,
    parentHash: block.parentHash,
    nonce: "0x0000000000000000",
    sha3Uncles: "0x" + "0".repeat(64),
    logsBloom: aggregatedBloom,
    transactionsRoot: "0x" + "0".repeat(64),
    stateRoot: block.stateRoot ?? ("0x" + "0".repeat(64)),
    receiptsRoot: "0x" + "0".repeat(64),
    miner: block.proposer.startsWith("0x") ? block.proposer : "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: `0x${Buffer.from(block.proposer, "utf-8").toString("hex")}`,
    size: `0x${(100 + block.txs.length * 200).toString(16)}`,
    gasLimit: "0x1c9c380",
    gasUsed: `0x${totalGasUsed.toString(16)}`,
    timestamp: `0x${Math.floor(block.timestampMs / 1000).toString(16)}`,
    baseFeePerGas: `0x${(await computeBaseFeeForBlock(block.number, chain)).toString(16)}`,
    finalized: block.finalized,
    transactions,
  }
}

const MAX_LOG_BLOCK_RANGE = 10_000n
const MAX_LOG_RESULTS = 10_000

async function queryLogs(chain: IChainEngine, query: Record<string, unknown>): Promise<unknown[]> {
  const height = await Promise.resolve(chain.getHeight())
  const fromBlock = parseBlockTag(query.fromBlock, 0n)
  const toBlock = parseBlockTag(query.toBlock, height)

  // Enforce block range limit to prevent resource exhaustion
  if (toBlock - fromBlock > MAX_LOG_BLOCK_RANGE) {
    throw new Error(`block range too large: max ${MAX_LOG_BLOCK_RANGE} blocks, got ${toBlock - fromBlock}`)
  }

  // Normalize address filter: single string or array of strings
  let address: Hex | undefined
  let addresses: Hex[] | undefined
  if (query.address) {
    if (Array.isArray(query.address)) {
      addresses = (query.address as string[]).map((a) => a.toLowerCase() as Hex)
    } else {
      address = String(query.address).toLowerCase() as Hex
    }
  }

  // Normalize topics: each position can be null, single topic, or array of topics (OR)
  const topics = Array.isArray(query.topics)
    ? query.topics.map((t) => {
        if (t === null || t === undefined) return null
        if (Array.isArray(t)) return (t as string[]).map((s) => s.toLowerCase() as Hex)
        return String(t).toLowerCase() as Hex
      })
    : undefined

  // Use persistent log index when available
  if (typeof chain.getLogs === "function") {
    const results = await chain.getLogs({
      fromBlock,
      toBlock,
      address,
      addresses,
      topics: topics as Array<Hex | null> | undefined,
    })
    return results.slice(0, MAX_LOG_RESULTS)
  }

  // Fallback to receipt-based log collection
  return collectLogs(chain, fromBlock, toBlock, {
    id: "inline",
    fromBlock,
    toBlock,
    address,
    addresses,
    topics,
    lastCursor: fromBlock,
  })
}

async function collectLogs(
  chain: IChainEngine,
  from: bigint,
  to: bigint,
  filter: PendingFilter & { addresses?: Hex[] },
): Promise<unknown[]> {
  const logs: unknown[] = []
  for (let n = from; n <= to; n += 1n) {
    const receipts = await Promise.resolve(chain.getReceiptsByBlock(n))
    for (const receipt of receipts) {
      const recLogs = Array.isArray(receipt.logs) ? receipt.logs : []
      for (const log of recLogs as Array<Record<string, unknown>>) {
        if (!matchesFilter(log, filter)) continue
        logs.push(log)
        if (logs.length >= MAX_LOG_RESULTS) return logs
      }
    }
  }
  return logs
}

/**
 * Compute the current base fee from the latest block's gas usage.
 */
async function computeCurrentBaseFee(chain: IChainEngine): Promise<bigint> {
  const height = await Promise.resolve(chain.getHeight())
  return computeBaseFeeForBlock(height, chain)
}

async function computeBaseFeeForBlock(blockNum: bigint, chain: IChainEngine): Promise<bigint> {
  if (blockNum <= 1n) return genesisBaseFee()

  const parentNum = blockNum - 1n
  const receipts = await Promise.resolve(chain.getReceiptsByBlock(parentNum))
  let parentGasUsed = 0n
  for (const r of receipts) {
    parentGasUsed += r.gasUsed ?? 0n
  }

  // For simplicity, use recursive formula from genesis base fee
  // In production, baseFee would be stored per block
  const parentBaseFee = genesisBaseFee()
  return calculateBaseFee({ parentBaseFee, parentGasUsed })
}

/**
 * Match a log entry against filter criteria.
 * Supports: single/multi address, null/single/OR-array per topic position.
 */
function matchesFilter(
  log: Record<string, unknown>,
  filter: PendingFilter & { addresses?: Hex[] },
): boolean {
  const logAddr = String(log.address ?? "").toLowerCase()

  // Address filter: single or array
  if (filter.address && logAddr !== filter.address.toLowerCase()) return false
  if (filter.addresses && filter.addresses.length > 0) {
    if (!filter.addresses.some((a) => a === logAddr)) return false
  }

  if (!filter.topics || filter.topics.length === 0) return true

  const logTopics = Array.isArray(log.topics) ? (log.topics as string[]) : []
  for (let i = 0; i < filter.topics.length; i++) {
    const expected = filter.topics[i]
    if (expected === null || expected === undefined) continue

    const logTopic = (logTopics[i] ?? "").toLowerCase()

    // OR-array: log topic must match any one
    if (Array.isArray(expected)) {
      if (!expected.some((e: string) => e.toLowerCase() === logTopic)) return false
    } else {
      if (String(expected).toLowerCase() !== logTopic) return false
    }
  }
  return true
}
