/**
 * WebSocket JSON-RPC Server
 *
 * Implements eth_subscribe / eth_unsubscribe for real-time event streaming.
 * Supported subscription types:
 * - newHeads: new block headers
 * - newPendingTransactions: pending transaction hashes
 * - logs: filtered log events
 *
 * Shares the same JSON-RPC dispatch as the HTTP server for standard methods.
 */

import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import type http from "node:http"
import crypto from "node:crypto"
import type { IChainEngine } from "./chain-engine-types.ts"
import type { EvmChain } from "./evm.ts"
import type { P2PNode } from "./p2p.ts"
import type { ChainEventEmitter, BlockEvent, PendingTxEvent, LogEvent } from "./chain-events.ts"
import { formatNewHeadsNotification, formatLogNotification } from "./chain-events.ts"
import type { Hex } from "./blockchain-types.ts"
import type { IndexedLog } from "./storage/block-index.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("ws-rpc")

export interface WsRpcConfig {
  port: number
  bind: string
}

interface WsSubscription {
  id: string
  type: "newHeads" | "newPendingTransactions" | "logs"
  filter?: LogSubscriptionFilter
}

interface LogSubscriptionFilter {
  address?: string | string[]
  topics?: Array<string | string[] | null>
}

interface ClientState {
  subscriptions: Map<string, WsSubscription>
  handlers: Map<string, (...args: unknown[]) => void>
  alive: boolean
  connectedAt: number
}

/**
 * Start a WebSocket JSON-RPC server that handles eth_subscribe/eth_unsubscribe
 * and delegates standard RPC methods to the provided handler function.
 */
export function startWsRpcServer(
  config: WsRpcConfig,
  chainId: number,
  evm: EvmChain,
  chain: IChainEngine,
  p2p: P2PNode,
  events: ChainEventEmitter,
  handleRpcMethod: (method: string, params: unknown[], chainId: number, evm: EvmChain, chain: IChainEngine, p2p: P2PNode) => Promise<unknown>,
): WsRpcServer {
  const server = new WsRpcServer(config, chainId, evm, chain, p2p, events, handleRpcMethod)
  server.start()
  return server
}

const HEARTBEAT_INTERVAL_MS = 30_000
const MAX_CLIENTS = 100

export class WsRpcServer {
  private wss: WebSocketServer | null = null
  private clients = new Map<WebSocket, ClientState>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private readonly config: WsRpcConfig
  private readonly chainId: number
  private readonly evm: EvmChain
  private readonly chain: IChainEngine
  private readonly p2p: P2PNode
  private readonly events: ChainEventEmitter
  private readonly handleRpcMethod: (
    method: string,
    params: unknown[],
    chainId: number,
    evm: EvmChain,
    chain: IChainEngine,
    p2p: P2PNode,
  ) => Promise<unknown>

  constructor(
    config: WsRpcConfig,
    chainId: number,
    evm: EvmChain,
    chain: IChainEngine,
    p2p: P2PNode,
    events: ChainEventEmitter,
    handleRpcMethod: (
      method: string,
      params: unknown[],
      chainId: number,
      evm: EvmChain,
      chain: IChainEngine,
      p2p: P2PNode,
    ) => Promise<unknown>,
  ) {
    this.config = config
    this.chainId = chainId
    this.evm = evm
    this.chain = chain
    this.p2p = p2p
    this.events = events
    this.handleRpcMethod = handleRpcMethod
  }

  start(): void {
    this.wss = new WebSocketServer({
      port: this.config.port,
      host: this.config.bind,
    })

    this.wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
      // Reject if at max capacity
      if (this.clients.size >= MAX_CLIENTS) {
        log.warn("max clients reached, rejecting connection", { current: this.clients.size })
        ws.close(1013, "max connections reached")
        return
      }

      this.clients.set(ws, {
        subscriptions: new Map(),
        handlers: new Map(),
        alive: true,
        connectedAt: Date.now(),
      })

      ws.on("pong", () => {
        const client = this.clients.get(ws)
        if (client) client.alive = true
      })

      ws.on("message", (data: Buffer | string) => {
        this.handleMessage(ws, data.toString()).catch((err) => {
          log.error("message handler error", { error: String(err) })
        })
      })

      ws.on("close", () => {
        this.cleanupClient(ws)
      })

      ws.on("error", (err: Error) => {
        log.error("client error", { error: err.message })
        this.cleanupClient(ws)
      })
    })

    this.wss.on("listening", () => {
      log.info("WebSocket RPC listening", { bind: this.config.bind, port: this.config.port })
    })

    // Heartbeat: ping all clients every 30s, terminate unresponsive ones
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (!client.alive) {
          log.info("terminating unresponsive client")
          ws.terminate()
          this.cleanupClient(ws)
          continue
        }
        client.alive = false
        ws.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    for (const [ws] of this.clients) {
      this.cleanupClient(ws)
    }
    this.clients.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
  }

  getClientCount(): number {
    return this.clients.size
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let payload: {
      id: string | number | null
      jsonrpc: string
      method: string
      params?: unknown[]
    }

    try {
      payload = JSON.parse(raw)
    } catch {
      this.send(ws, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      })
      return
    }

    if (!payload || typeof payload !== "object" || !payload.method) {
      this.send(ws, {
        jsonrpc: "2.0",
        id: payload?.id ?? null,
        error: { code: -32600, message: "invalid request" },
      })
      return
    }

    try {
      const result = await this.dispatch(ws, payload.method, payload.params ?? [])
      this.send(ws, {
        jsonrpc: "2.0",
        id: payload.id ?? null,
        result,
      })
    } catch (err) {
      this.send(ws, {
        jsonrpc: "2.0",
        id: payload.id ?? null,
        error: { code: -32603, message: String(err) },
      })
    }
  }

  private async dispatch(ws: WebSocket, method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_subscribe":
        return this.handleSubscribe(ws, params)
      case "eth_unsubscribe":
        return this.handleUnsubscribe(ws, params)
      default:
        return this.handleRpcMethod(method, params, this.chainId, this.evm, this.chain, this.p2p)
    }
  }

  private handleSubscribe(ws: WebSocket, params: unknown[]): string {
    const type = String(params[0] ?? "")
    const subId = generateSubscriptionId()

    const client = this.clients.get(ws)
    if (!client) throw new Error("client not found")

    switch (type) {
      case "newHeads": {
        const handler = (event: BlockEvent) => {
          const notification = formatNewHeadsNotification(event.block)
          this.sendSubscription(ws, subId, notification)
        }
        this.events.onNewBlock(handler as (event: BlockEvent) => void)
        client.subscriptions.set(subId, { id: subId, type: "newHeads" })
        client.handlers.set(subId, handler as (...args: unknown[]) => void)
        break
      }
      case "newPendingTransactions": {
        const handler = (event: PendingTxEvent) => {
          this.sendSubscription(ws, subId, event.hash)
        }
        this.events.onPendingTx(handler as (event: PendingTxEvent) => void)
        client.subscriptions.set(subId, { id: subId, type: "newPendingTransactions" })
        client.handlers.set(subId, handler as (...args: unknown[]) => void)
        break
      }
      case "logs": {
        const filterParam = (params[1] ?? {}) as Record<string, unknown>
        const filter: LogSubscriptionFilter = {
          address: filterParam.address as string | string[] | undefined,
          topics: filterParam.topics as Array<string | string[] | null> | undefined,
        }

        const handler = (event: LogEvent) => {
          if (matchesSubscriptionFilter(event.log, filter)) {
            const notification = formatLogNotification(event.log)
            this.sendSubscription(ws, subId, notification)
          }
        }
        this.events.onLog(handler as (event: LogEvent) => void)
        client.subscriptions.set(subId, { id: subId, type: "logs", filter })
        client.handlers.set(subId, handler as (...args: unknown[]) => void)
        break
      }
      default:
        throw new Error(`unsupported subscription type: ${type}`)
    }

    log.info("subscription created", { type, subId })
    return subId
  }

  private handleUnsubscribe(ws: WebSocket, params: unknown[]): boolean {
    const subId = String(params[0] ?? "")
    const client = this.clients.get(ws)
    if (!client) return false

    const sub = client.subscriptions.get(subId)
    if (!sub) return false

    this.removeSubscription(client, subId, sub)
    return true
  }

  private removeSubscription(client: ClientState, subId: string, sub: WsSubscription): void {
    const handler = client.handlers.get(subId)
    if (handler) {
      switch (sub.type) {
        case "newHeads":
          this.events.offNewBlock(handler as (event: BlockEvent) => void)
          break
        case "newPendingTransactions":
          this.events.offPendingTx(handler as (event: PendingTxEvent) => void)
          break
        case "logs":
          this.events.offLog(handler as (event: LogEvent) => void)
          break
      }
    }
    client.subscriptions.delete(subId)
    client.handlers.delete(subId)
  }

  private cleanupClient(ws: WebSocket): void {
    const client = this.clients.get(ws)
    if (!client) return

    for (const [subId, sub] of client.subscriptions) {
      this.removeSubscription(client, subId, sub)
    }
    this.clients.delete(ws)
  }

  private sendSubscription(ws: WebSocket, subId: string, result: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return

    this.send(ws, {
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: {
        subscription: subId,
        result,
      },
    })
  }

  private send(ws: WebSocket, data: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return

    try {
      // Use BigInt-safe serializer to avoid "Do not know how to serialize a BigInt"
      ws.send(JSON.stringify(data, (_key, value) =>
        typeof value === "bigint" ? `0x${value.toString(16)}` : value
      ))
    } catch (err) {
      log.error("send failed", { error: String(err) })
    }
  }
}

function generateSubscriptionId(): string {
  return "0x" + crypto.randomBytes(16).toString("hex")
}

/**
 * Check if a log matches the subscription filter criteria
 */
function matchesSubscriptionFilter(logEntry: IndexedLog, filter: LogSubscriptionFilter): boolean {
  // Address filter
  if (filter.address) {
    const logAddr = logEntry.address.toLowerCase()
    if (Array.isArray(filter.address)) {
      const match = filter.address.some((a) => a.toLowerCase() === logAddr)
      if (!match) return false
    } else {
      if (filter.address.toLowerCase() !== logAddr) return false
    }
  }

  // Topics filter (Ethereum topic matching rules)
  if (filter.topics && filter.topics.length > 0) {
    for (let i = 0; i < filter.topics.length; i++) {
      const criterion = filter.topics[i]
      if (criterion === null || criterion === undefined) continue

      const logTopic = logEntry.topics[i]
      if (!logTopic) return false

      if (Array.isArray(criterion)) {
        // OR matching: log topic must match any one
        const match = criterion.some((t) => t.toLowerCase() === logTopic.toLowerCase())
        if (!match) return false
      } else {
        if (criterion.toLowerCase() !== logTopic.toLowerCase()) return false
      }
    }
  }

  return true
}
