/**
 * Wire Protocol TCP Client
 *
 * Outbound TCP connection with handshake, exponential backoff reconnect,
 * and frame send capability.
 */

import net from "node:net"
import { FrameDecoder, MessageType, encodeJsonPayload, decodeJsonPayload } from "./wire-protocol.ts"
import type { WireFrame, FindNodePayload, FindNodeResponsePayload } from "./wire-protocol.ts"
import crypto from "node:crypto"
import { createLogger } from "./logger.ts"

const log = createLogger("wire-client")

const MIN_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000

interface HandshakePayload {
  nodeId: string
  chainId: number
  height: string
}

export interface WireClientConfig {
  host: string
  port: number
  nodeId: string
  chainId: number
  onConnected?: () => void
  onDisconnected?: () => void
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

  constructor(cfg: WireClientConfig) {
    this.cfg = cfg
  }

  connect(): void {
    this.stopped = false
    this.attemptConnect()
  }

  disconnect(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
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
        const hs: HandshakePayload = {
          nodeId: this.cfg.nodeId,
          chainId: this.cfg.chainId,
          height: "0", // client doesn't track height
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
          pending.resolve(resp.peers)
        }
        break
      }

      case MessageType.Pong: {
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
