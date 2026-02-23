/**
 * Wire Protocol TCP Client
 *
 * Outbound TCP connection with handshake, exponential backoff reconnect,
 * and frame send capability.
 */

import net from "node:net"
import { FrameDecoder, MessageType, encodeJsonPayload, decodeJsonPayload, buildWireHandshakeMessage } from "./wire-protocol.ts"
import type { WireFrame, FindNodePayload, FindNodeResponsePayload } from "./wire-protocol.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import crypto from "node:crypto"
import { createLogger } from "./logger.ts"

const log = createLogger("wire-client")

const MIN_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000

interface HandshakePayload {
  nodeId: string
  chainId: number
  height: string
  publicKey?: string
  nonce?: string
  signature?: string
}

export interface WireClientConfig {
  host: string
  port: number
  nodeId: string
  chainId: number
  onConnected?: () => void
  onDisconnected?: () => void
  signer?: NodeSigner
  verifier?: SignatureVerifier
}

export class WireClient {
  private readonly cfg: WireClientConfig
  private socket: net.Socket | null = null
  private decoder = new FrameDecoder()
  private connected = false
  private handshakeComplete = false
  private remoteNodeId: string | null = null
  private reconnectMs = MIN_RECONNECT_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly pendingFindNode = new Map<string, {
    resolve: (peers: Array<{ id: string; address: string }>) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  // Ping/pong latency tracking
  private lastPingSentMs = 0
  private lastLatencyMs = -1
  private latencyHistory: number[] = []
  private readonly maxLatencySamples = 20
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(cfg: WireClientConfig) {
    this.cfg = cfg
  }

  connect(): void {
    this.stopped = false
    this.attemptConnect()
  }

  disconnect(): void {
    this.stopped = true
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Clean up pending FindNode requests to prevent memory leak
    for (const entry of this.pendingFindNode.values()) {
      clearTimeout(entry.timer)
    }
    this.pendingFindNode.clear()
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.connected = false
    this.handshakeComplete = false
  }

  /** Send a raw wire frame to the peer */
  send(data: Uint8Array): boolean {
    if (!this.socket || !this.handshakeComplete) return false
    this.socket.write(data)
    return true
  }

  /** Send a typed JSON payload */
  sendMessage(type: (typeof MessageType)[keyof typeof MessageType], payload: unknown): boolean {
    return this.send(encodeJsonPayload(type, payload))
  }

  isConnected(): boolean {
    return this.connected && this.handshakeComplete
  }

  getRemoteNodeId(): string | null {
    return this.remoteNodeId
  }

  /** Send a ping and measure round-trip latency */
  ping(): boolean {
    if (!this.isConnected()) return false
    this.lastPingSentMs = Date.now()
    return this.sendMessage(MessageType.Ping, { ts: this.lastPingSentMs })
  }

  /** Get last measured latency in ms (-1 if no measurement yet) */
  getLatencyMs(): number {
    return this.lastLatencyMs
  }

  /** Get average latency from recent samples */
  getAvgLatencyMs(): number {
    if (this.latencyHistory.length === 0) return -1
    const sum = this.latencyHistory.reduce((a, b) => a + b, 0)
    return Math.round(sum / this.latencyHistory.length)
  }

  /** Start periodic ping (default every 30s) */
  startPing(intervalMs = 30_000): void {
    this.stopPing()
    this.pingTimer = setInterval(() => { this.ping() }, intervalMs)
  }

  /** Stop periodic ping */
  stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /** Send a FIND_NODE request and await the response */
  findNode(targetId: string, timeoutMs = 5000): Promise<Array<{ id: string; address: string }>> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        resolve([])
        return
      }
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => {
        this.pendingFindNode.delete(requestId)
        resolve([]) // timeout returns empty
      }, timeoutMs)

      this.pendingFindNode.set(requestId, { resolve, timer })

      const payload: FindNodePayload = { targetId, requestId }
      const sent = this.sendMessage(MessageType.FindNode, payload)
      if (!sent) {
        clearTimeout(timer)
        this.pendingFindNode.delete(requestId)
        resolve([])
      }
    })
  }

  private attemptConnect(): void {
    if (this.stopped) return

    this.decoder.reset()
    const socket = net.createConnection(
      { host: this.cfg.host, port: this.cfg.port },
      () => {
        this.connected = true
        this.reconnectMs = MIN_RECONNECT_MS
        log.info("wire client connected", { host: this.cfg.host, port: this.cfg.port })

        // Send handshake
        const nonce = `${Date.now()}:${crypto.randomUUID()}`
        const hs: HandshakePayload = {
          nodeId: this.cfg.nodeId,
          chainId: this.cfg.chainId,
          height: "0", // client doesn't track height
        }
        if (this.cfg.signer) {
          const msg = buildWireHandshakeMessage(this.cfg.nodeId, this.cfg.chainId, nonce)
          hs.nonce = nonce
          hs.signature = this.cfg.signer.sign(msg)
        }
        socket.write(encodeJsonPayload(MessageType.Handshake, hs))
      },
    )

    this.socket = socket

    socket.on("data", (data: Buffer) => {
      try {
        const frames = this.decoder.feed(new Uint8Array(data))
        for (const frame of frames) {
          this.handleFrame(frame)
        }
      } catch (err) {
        log.warn("frame decode error", { error: String(err) })
        socket.destroy()
      }
    })

    socket.on("close", () => {
      const wasConnected = this.connected
      this.connected = false
      this.handshakeComplete = false
      this.remoteNodeId = null
      if (wasConnected) {
        this.cfg.onDisconnected?.()
      }
      this.scheduleReconnect()
    })

    socket.on("error", (err) => {
      log.debug("wire client error", { error: String(err), host: this.cfg.host })
    })
  }

  private handleFrame(frame: WireFrame): void {
    switch (frame.type) {
      case MessageType.Handshake:
      case MessageType.HandshakeAck: {
        const hs = decodeJsonPayload<HandshakePayload>(frame)
        if (hs.chainId !== this.cfg.chainId) {
          log.warn("chain ID mismatch", { expected: this.cfg.chainId, got: hs.chainId })
          this.socket?.destroy()
          return
        }
        // When verifier is enabled, peer handshake signature is mandatory.
        if (this.cfg.verifier) {
          if (!hs.signature || !hs.nonce) {
            log.warn("peer handshake missing signature", { peer: hs.nodeId })
            this.socket?.destroy()
            return
          }
          const msg = buildWireHandshakeMessage(hs.nodeId, hs.chainId, hs.nonce)
          const recovered = this.cfg.verifier.recoverAddress(msg, hs.signature)
          if (recovered.toLowerCase() !== hs.nodeId.toLowerCase()) {
            log.warn("handshake signature mismatch", { claimed: hs.nodeId, recovered })
            this.socket?.destroy()
            return
          }
        }
        this.remoteNodeId = hs.nodeId
        this.handshakeComplete = true
        this.cfg.onConnected?.()
        break
      }

      case MessageType.FindNodeResponse: {
        const resp = decodeJsonPayload<FindNodeResponsePayload>(frame)
        const pending = this.pendingFindNode.get(resp.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingFindNode.delete(resp.requestId)
          // Limit accepted peers to prevent routing table poisoning
          const peers = Array.isArray(resp.peers) ? resp.peers.slice(0, 20) : []
          pending.resolve(peers)
        }
        break
      }

      case MessageType.Pong: {
        if (this.lastPingSentMs > 0) {
          this.lastLatencyMs = Date.now() - this.lastPingSentMs
          this.latencyHistory.push(this.lastLatencyMs)
          if (this.latencyHistory.length > this.maxLatencySamples) {
            this.latencyHistory.shift()
          }
          this.lastPingSentMs = 0
        }
        break
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.attemptConnect()
    }, this.reconnectMs)

    // Exponential backoff with cap
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
  }
}
