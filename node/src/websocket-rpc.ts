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

const IDLE_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour

const MAX_CONNECTIONS_PER_IP = 10
const MAX_MESSAGES_PER_MINUTE = 100
const WS_MAX_PAYLOAD = 1024 * 1024 // 1 MB

interface ClientState {
  subscriptions: Map<string, WsSubscription>
  handlers: Map<string, (...args: unknown[]) => void>
  alive: boolean
  connectedAt: number
  lastActivityMs: number
  messageCount: number
  messageWindowStart: number
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
const MAX_SUBSCRIPTIONS_PER_CLIENT = 10
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_TOPIC_RE = /^0x[0-9a-fA-F]{64}$/

export class WsRpcServer {
  private wss: WebSocketServer | null = null
  private clients = new Map<WebSocket, ClientState>()
  private connsByIp = new Map<string, number>()
  private clientIps = new Map<WebSocket, string>()
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
      maxPayload: WS_MAX_PAYLOAD,
    })

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      // Reject if at max capacity
      if (this.clients.size >= MAX_CLIENTS) {
        log.warn("max clients reached, rejecting connection", { current: this.clients.size })
        ws.close(1013, "max connections reached")
        return
      }

      // Per-IP connection limit
      const remoteIp = req.socket.remoteAddress ?? "unknown"
      const ipCount = this.connsByIp.get(remoteIp) ?? 0
      if (ipCount >= MAX_CONNECTIONS_PER_IP) {
        log.warn("per-IP connection limit reached", { ip: remoteIp, count: ipCount })
        ws.close(1013, "too many connections from this IP")
        return
      }
      this.connsByIp.set(remoteIp, ipCount + 1)
      this.clientIps.set(ws, remoteIp)

      const now = Date.now()
      this.clients.set(ws, {
        subscriptions: new Map(),
        handlers: new Map(),
        alive: true,
        connectedAt: now,
        lastActivityMs: now,
        messageCount: 0,
        messageWindowStart: now,
      })

      ws.on("pong", () => {
        const client = this.clients.get(ws)
        if (client) client.alive = true
      })

      ws.on("message", (data: Buffer | string) => {
        const clientState = this.clients.get(ws)
        if (!clientState) return
        const msgNow = Date.now()
        clientState.lastActivityMs = msgNow

        // Per-client message rate limiting
        if (msgNow - clientState.messageWindowStart > 60_000) {
          clientState.messageCount = 0
          clientState.messageWindowStart = msgNow
        }
        clientState.messageCount++
        if (clientState.messageCount > MAX_MESSAGES_PER_MINUTE) {
          this.send(ws, {
            jsonrpc: "2.0", id: null,
            error: { code: -32005, message: "rate limit exceeded" },
          })
          return
        }

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

    // Heartbeat: ping all clients every 30s, terminate unresponsive/idle ones
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      for (const [ws, client] of this.clients) {
        if (!client.alive) {
          log.info("terminating unresponsive client")
          ws.terminate()
          this.cleanupClient(ws)
          continue
        }
        // Close idle clients (no activity for IDLE_TIMEOUT_MS)
        if (now - client.lastActivityMs > IDLE_TIMEOUT_MS) {
          log.info("closing idle client", { idleMs: now - client.lastActivityMs })
          ws.close(1000, "idle timeout")
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

  getSubscriptionCount(): number {
    let total = 0
    for (const client of this.clients.values()) {
      total += client.subscriptions.size
    }
    return total
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
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("connection not open")
    }
    const type = String(params[0] ?? "")
    const subId = generateSubscriptionId()

    const client = this.clients.get(ws)
    if (!client) throw new Error("client not found")

    if (client.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
      throw new Error(`max subscriptions per client reached (${MAX_SUBSCRIPTIONS_PER_CLIENT})`)
    }

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
        const filter = validateLogFilter(filterParam)

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

    // Decrement per-IP counter
    const ip = this.clientIps.get(ws)
    if (ip) {
      const count = this.connsByIp.get(ip) ?? 1
      if (count <= 1) {
        this.connsByIp.delete(ip)
      } else {
        this.connsByIp.set(ip, count - 1)
      }
      this.clientIps.delete(ws)
    }
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
      ws.send(JSON.stringify(data, (_key, value) =>
        typeof value === "bigint" ? `0x${value.toString(16)}` : value
      ))
    } catch (err) {
      log.error("send failed, terminating client", { error: String(err) })
      try { ws.terminate() } catch { /* ignore */ }
      this.cleanupClient(ws)
    }
  }
}

function generateSubscriptionId(): string {
  return "0x" + crypto.randomBytes(16).toString("hex")
}

/**
 * Validate log subscription filter parameters
 */
function validateLogFilter(params: Record<string, unknown>): LogSubscriptionFilter {
  const filter: LogSubscriptionFilter = {}

  if (params.address !== undefined) {
    if (Array.isArray(params.address)) {
      for (const addr of params.address) {
        if (typeof addr !== "string" || !HEX_ADDRESS_RE.test(addr)) {
          throw new Error(`invalid address in filter: ${addr}`)
        }
      }
      filter.address = params.address as string[]
    } else if (typeof params.address === "string") {
      if (!HEX_ADDRESS_RE.test(params.address)) {
        throw new Error(`invalid address: ${params.address}`)
      }
      filter.address = params.address
    }
  }

  if (params.topics !== undefined) {
    if (!Array.isArray(params.topics)) {
      throw new Error("topics must be an array")
    }
    if (params.topics.length > 4) {
      throw new Error("topics array must have at most 4 elements")
    }
    const topics: Array<string | string[] | null> = []
    for (const t of params.topics) {
      if (t === null || t === undefined) {
        topics.push(null)
      } else if (Array.isArray(t)) {
        for (const item of t) {
          if (typeof item !== "string" || !HEX_TOPIC_RE.test(item)) {
            throw new Error(`invalid topic in OR-array: ${item}`)
          }
        }
        topics.push(t as string[])
      } else if (typeof t === "string") {
        if (!HEX_TOPIC_RE.test(t)) {
          throw new Error(`invalid topic: ${t}`)
        }
        topics.push(t)
      } else {
        throw new Error(`invalid topic type: ${typeof t}`)
      }
    }
    filter.topics = topics
  }

  return filter
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
