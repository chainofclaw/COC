import http from "node:http"
import { SigningKey, keccak256, hashMessage, Transaction } from "ethers"
import type { IChainEngine } from "./chain-engine-types.ts"
import type { EvmChain } from "./evm.ts"
import type { Hex, PendingFilter } from "./blockchain-types.ts"
import type { P2PNode } from "./p2p.ts"
import type { PoSeEngine } from "./pose-engine.ts"
import { registerPoseRoutes, handlePoseRequest } from "./pose-http.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("rpc")

// 测试账户管理器（仅用于测试环境）
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
  const publicKeyBytes = Buffer.from(publicKey.slice(2), "hex")
  const hash = keccak256(publicKeyBytes)
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

export function startRpcServer(bind: string, port: number, chainId: number, evm: EvmChain, chain: IChainEngine, p2p: P2PNode, pose?: PoSeEngine) {
  initializeTestAccounts() // 初始化测试账户

  const filters = new Map<string, PendingFilter>()
  const poseRoutes = pose ? registerPoseRoutes(pose) : []

  const server = http.createServer(async (req, res) => {
    // 设置 CORS 头以允许浏览器访问
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")

    // 处理 OPTIONS 预检请求
    if (req.method === "OPTIONS") {
      res.writeHead(200)
      res.end()
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
    req.on("data", (chunk) => (body += chunk))
    req.on("end", async () => {
      try {
        if (!body || body.trim().length === 0) {
          return sendError(res, null, "empty request")
        }

        const payload = JSON.parse(body)
        const response = Array.isArray(payload)
          ? await Promise.all(payload.map((item) => handleOne(item, chainId, evm, chain, p2p, filters)))
          : await handleOne(payload, chainId, evm, chain, p2p, filters)

        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "application/json" })
        }
        res.end(JSON.stringify(response))
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
): Promise<JsonRpcResponse> {
  if (!payload || typeof payload !== "object" || !payload.method) {
    return { jsonrpc: "2.0", id: payload?.id ?? null, error: { message: "invalid request" } }
  }

  try {
    const result = await handleRpc(payload, chainId, evm, chain, p2p, filters)
    return { jsonrpc: "2.0", id: payload.id ?? null, result }
  } catch (error) {
    return { jsonrpc: "2.0", id: payload.id ?? null, error: { message: String(error) } }
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
): Promise<unknown> {
  const payload = { method, params, id: null, jsonrpc: "2.0" as const }
  const filters = new Map<string, PendingFilter>()
  return handleRpc(payload, chainId, evm, chain, p2p, filters)
}

async function handleRpc(
  payload: JsonRpcRequest,
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  filters: Map<string, PendingFilter>,
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
      const hash = String((payload.params ?? [])[0] ?? "")
      // Try persistent index first, then fall back to EVM memory
      if (typeof chain.getTransactionByHash === "function") {
        const tx = await chain.getTransactionByHash(hash as Hex)
        if (tx?.receipt) return tx.receipt
      }
      return evm.getReceipt(hash)
    }
    case "eth_getTransactionByHash": {
      const hash = String((payload.params ?? [])[0] ?? "")
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
    case "eth_gasPrice":
      return "0x3b9aca00"
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

      const nonce = await evm.getNonce(from)
      const gasPrice = txParams.gasPrice ?? "0x3b9aca00" // 1 gwei
      const gasLimit = txParams.gas ?? (await evm.estimateGas({
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
        gasLimit: `0x${gasLimit}`,
        gasPrice,
        chainId,
      })

      const signedTx = await account.signingKey.signTransaction(tx)
      const result = await chain.addRawTx(signedTx as Hex)
      await p2p.receiveTx(signedTx as Hex)
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

      // 简化实现：将 typedData 序列化后签名
      const dataHash = keccak256(JSON.stringify(typedData))
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

  // Aggregate logsBloom from block receipts
  let aggregatedBloom = "0x" + "0".repeat(512)
  if (chain && evm) {
    const receipts = await Promise.resolve(chain.getReceiptsByBlock(block.number))
    for (const receipt of receipts) {
      if (receipt.logsBloom && receipt.logsBloom !== "0x" + "0".repeat(512)) {
        aggregatedBloom = receipt.logsBloom
        break // use first non-zero bloom (simplified)
      }
    }
  }

  // Fix: includeTx=false should return only tx hashes
  let transactions: unknown[]
  if (includeTx) {
    transactions = block.txs.map((rawTx, i) => {
      if (evm) {
        // Try to get full tx info from evm
        const allTxs = [...evm.getAllReceipts().keys()]
        for (const hash of allTxs) {
          const info = evm.getTransaction(hash)
          if (info && info.blockNumber === `0x${block.number.toString(16)}`) {
            return info
          }
        }
      }
      return rawTx
    })
  } else {
    // Return tx hashes, not raw tx data
    transactions = block.txs.map((rawTx) => {
      if (evm) {
        for (const [hash, info] of evm.getAllReceipts().entries()) {
          if (info.blockNumber === `0x${block.number.toString(16)}`) {
            return hash
          }
        }
      }
      return keccak256Hex(Buffer.from(rawTx.slice(2), "hex"))
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
    stateRoot: "0x" + "0".repeat(64),
    receiptsRoot: "0x" + "0".repeat(64),
    miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: `0x${Buffer.from(block.proposer, "utf-8").toString("hex")}`,
    size: `0x${(100 + block.txs.length * 200).toString(16)}`,
    gasLimit: "0x1c9c380",
    gasUsed: `0x${(block.txs.length * 21_000).toString(16)}`,
    timestamp: `0x${Math.floor(block.timestampMs / 1000).toString(16)}`,
    baseFeePerGas: "0x3b9aca00",
    finalized: block.finalized,
    transactions,
  }
}

async function queryLogs(chain: IChainEngine, query: Record<string, unknown>): Promise<unknown[]> {
  const height = await Promise.resolve(chain.getHeight())
  const fromBlock = parseBlockTag(query.fromBlock, 0n)
  const toBlock = parseBlockTag(query.toBlock, height)
  const address = query.address ? String(query.address).toLowerCase() as Hex : undefined
  const topics = Array.isArray(query.topics)
    ? query.topics.map((t) => (t ? String(t) as Hex : null))
    : undefined

  // Use persistent log index when available
  if (typeof chain.getLogs === "function") {
    return chain.getLogs({
      fromBlock,
      toBlock,
      address,
      topics: topics ?? undefined,
    })
  }

  // Fallback to receipt-based log collection
  return collectLogs(chain, fromBlock, toBlock, {
    id: "inline",
    fromBlock,
    toBlock,
    address,
    topics,
    lastCursor: fromBlock,
  })
}

async function collectLogs(chain: IChainEngine, from: bigint, to: bigint, filter: PendingFilter): Promise<unknown[]> {
  const logs: unknown[] = []
  for (let n = from; n <= to; n += 1n) {
    const receipts = await Promise.resolve(chain.getReceiptsByBlock(n))
    for (const receipt of receipts) {
      const recLogs = Array.isArray(receipt.logs) ? receipt.logs : []
      for (const log of recLogs as Array<Record<string, unknown>>) {
        if (!matchesFilter(log, filter)) continue
        logs.push(log)
      }
    }
  }
  return logs
}

function matchesFilter(log: Record<string, unknown>, filter: PendingFilter): boolean {
  if (filter.address) {
    const addr = String(log.address ?? "").toLowerCase()
    if (addr !== filter.address.toLowerCase()) return false
  }
  if (!filter.topics || filter.topics.length === 0) return true
  const topics = Array.isArray(log.topics) ? (log.topics as string[]) : []
  for (let i = 0; i < filter.topics.length; i++) {
    const expected = filter.topics[i]
    if (!expected) continue
    if ((topics[i] ?? "").toLowerCase() !== expected.toLowerCase()) {
      return false
    }
  }
  return true
}
