/**
 * Wire Protocol TCP Server
 *
 * Accepts inbound TCP connections, performs handshake,
 * and dispatches decoded frames to application handlers.
 */

import net from "node:net"
import crypto from "node:crypto"
import { FrameDecoder, MessageType, encodeJsonPayload, decodeJsonPayload } from "./wire-protocol.ts"
import type { WireFrame, FindNodePayload, FindNodeResponsePayload } from "./wire-protocol.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import type { BftMessage } from "./bft.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { BoundedSet } from "./p2p.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("wire-server")

interface HandshakePayload {
  nodeId: string
  chainId: number
  height: string
  publicKey?: string
  nonce?: string
  signature?: string
}

export interface WireServerConfig {
  port: number
  bind?: string
  nodeId: string
  chainId: number
  maxConnections?: number
  onBlock: (block: ChainBlock) => Promise<void>
  onTx: (rawTx: Hex) => Promise<void>
  onBftMessage?: (msg: BftMessage) => Promise<void>
  onFindNode?: (targetId: string) => Array<{ id: string; address: string }>
  getHeight: () => Promise<bigint | Promise<bigint>>
  /** Called after a new (non-duplicate) tx arrives via wire, for cross-protocol relay */
  onTxRelay?: (rawTx: Hex) => Promise<void>
  /** Called after a new (non-duplicate) block arrives via wire, for cross-protocol relay */
  onBlockRelay?: (block: ChainBlock) => Promise<void>
  /** Node identity signer (optional; enables authenticated handshakes) */
  signer?: NodeSigner
  /** Signature verifier (optional; enables authenticated handshakes) */
  verifier?: SignatureVerifier
}

interface PeerConnection {
  socket: net.Socket
  decoder: FrameDecoder
  nodeId: string | null
  handshakeComplete: boolean
}

const MAX_CONNECTIONS_PER_IP = 5

export class WireServer {
  private readonly cfg: WireServerConfig
  private readonly connections = new Map<string, PeerConnection>()
  private readonly connsByIp = new Map<string, number>()
  private server: net.Server | null = null
  private framesReceived = 0
  private framesSent = 0
  private bytesReceived = 0
  private bytesSent = 0
  private totalConnectionsAccepted = 0
  private connectionsRejected = 0
  private readonly seenTx = new BoundedSet<Hex>(50_000)
  private readonly seenBlocks = new BoundedSet<Hex>(10_000)

  constructor(cfg: WireServerConfig) {
    this.cfg = cfg
  }

  start(): void {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket)
    })

    this.server.listen(this.cfg.port, this.cfg.bind ?? "127.0.0.1", () => {
      log.info("wire server listening", { port: this.cfg.port })
    })

    this.server.on("error", (err) => {
      log.error("wire server error", { error: String(err) })
    })
  }

  stop(): void {
    for (const [, conn] of this.connections) {
      conn.socket.destroy()
    }
    this.connections.clear()
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /** Broadcast a frame to all connected peers, optionally excluding a specific node */
  broadcastFrame(data: Uint8Array, excludeNodeId?: string): void {
    for (const [, conn] of this.connections) {
      if (conn.handshakeComplete) {
        if (excludeNodeId && conn.nodeId === excludeNodeId) continue
        conn.socket.write(data)
        this.framesSent++
        this.bytesSent += data.byteLength
      }
    }
  }

  getConnectedPeers(): string[] {
    const peers: string[] = []
    for (const [, conn] of this.connections) {
      if (conn.handshakeComplete && conn.nodeId) {
        peers.push(conn.nodeId)
      }
    }
    return peers
  }

  getStats(): {
    connections: number; connectedPeers: number
    totalAccepted: number; rejected: number
    framesReceived: number; framesSent: number
    bytesReceived: number; bytesSent: number
    seenTxSize: number; seenBlocksSize: number
  } {
    return {
      connections: this.connections.size,
      connectedPeers: this.getConnectedPeers().length,
      totalAccepted: this.totalConnectionsAccepted,
      rejected: this.connectionsRejected,
      framesReceived: this.framesReceived,
      framesSent: this.framesSent,
      bytesReceived: this.bytesReceived,
      bytesSent: this.bytesSent,
      seenTxSize: this.seenTx.size,
      seenBlocksSize: this.seenBlocks.size,
    }
  }

  private handleConnection(socket: net.Socket): void {
    const maxConns = this.cfg.maxConnections ?? 50
    if (this.connections.size >= maxConns) {
      this.connectionsRejected++
      log.warn("max connections reached, rejecting", { current: this.connections.size, max: maxConns })
      socket.destroy()
      return
    }

    // Per-IP connection limit
    const remoteIp = socket.remoteAddress ?? "unknown"
    const ipCount = this.connsByIp.get(remoteIp) ?? 0
    if (ipCount >= MAX_CONNECTIONS_PER_IP) {
      this.connectionsRejected++
      log.warn("per-IP connection limit reached", { ip: remoteIp, count: ipCount })
      socket.destroy()
      return
    }
    this.connsByIp.set(remoteIp, ipCount + 1)

    this.totalConnectionsAccepted++
    const connId = `${socket.remoteAddress}:${socket.remotePort}`
    const conn: PeerConnection = {
      socket,
      decoder: new FrameDecoder(),
      nodeId: null,
      handshakeComplete: false,
    }
    this.connections.set(connId, conn)

    log.info("new wire connection", { remote: connId })

    // Send our handshake
    void this.sendHandshake(socket)

    socket.on("data", (data: Buffer) => {
      this.bytesReceived += data.byteLength
      try {
        const frames = conn.decoder.feed(new Uint8Array(data))
        for (const frame of frames) {
          this.framesReceived++
          void this.handleFrame(conn, frame)
        }
      } catch (err) {
        log.warn("frame decode error, closing connection", { remote: connId, error: String(err) })
        socket.destroy()
      }
    })

    socket.on("close", () => {
      this.connections.delete(connId)
      // Decrement per-IP counter
      const currentIpCount = this.connsByIp.get(remoteIp) ?? 1
      if (currentIpCount <= 1) {
        this.connsByIp.delete(remoteIp)
      } else {
        this.connsByIp.set(remoteIp, currentIpCount - 1)
      }
      log.info("wire connection closed", { remote: connId, nodeId: conn.nodeId })
    })

    socket.on("error", (err) => {
      log.warn("wire socket error", { remote: connId, error: String(err) })
    })
  }

  private async sendHandshake(socket: net.Socket): Promise<void> {
    const height = await Promise.resolve(await this.cfg.getHeight())
    const nonce = crypto.randomUUID()
    const payload: HandshakePayload = {
      nodeId: this.cfg.nodeId,
      chainId: this.cfg.chainId,
      height: height.toString(),
    }
    // Attach crypto identity if signer available
    if (this.cfg.signer) {
      const msg = `wire:handshake:${this.cfg.nodeId}:${nonce}`
      payload.nonce = nonce
      payload.signature = this.cfg.signer.sign(msg)
    }
    const frame = encodeJsonPayload(MessageType.Handshake, payload)
    socket.write(frame)
  }

  private async handleFrame(conn: PeerConnection, frame: WireFrame): Promise<void> {
    switch (frame.type) {
      case MessageType.Handshake:
      case MessageType.HandshakeAck: {
        const hs = decodeJsonPayload<HandshakePayload>(frame)
        if (hs.chainId !== this.cfg.chainId) {
          log.warn("chain ID mismatch, closing", { remote: hs.nodeId, expected: this.cfg.chainId, got: hs.chainId })
          conn.socket.destroy()
          return
        }
        // Verify handshake signature if verifier is available and signature present
        if (this.cfg.verifier && hs.signature && hs.nonce) {
          const msg = `wire:handshake:${hs.nodeId}:${hs.nonce}`
          const recovered = this.cfg.verifier.recoverAddress(msg, hs.signature)
          if (recovered.toLowerCase() !== hs.nodeId.toLowerCase()) {
            log.warn("handshake signature mismatch", { claimed: hs.nodeId, recovered })
            conn.socket.destroy()
            return
          }
        }
        conn.nodeId = hs.nodeId
        conn.handshakeComplete = true
        // Reply with ack if this was a handshake (not ack)
        if (frame.type === MessageType.Handshake) {
          const height = await Promise.resolve(await this.cfg.getHeight())
          const nonce = crypto.randomUUID()
          const ack: HandshakePayload = {
            nodeId: this.cfg.nodeId,
            chainId: this.cfg.chainId,
            height: height.toString(),
          }
          if (this.cfg.signer) {
            const ackMsg = `wire:handshake:${this.cfg.nodeId}:${nonce}`
            ack.nonce = nonce
            ack.signature = this.cfg.signer.sign(ackMsg)
          }
          conn.socket.write(encodeJsonPayload(MessageType.HandshakeAck, ack))
        }
        log.info("handshake complete", { peer: hs.nodeId, height: hs.height })
        break
      }

      case MessageType.Block: {
        if (!conn.handshakeComplete) return
        const block = decodeJsonPayload<ChainBlock>(frame)
        // Restore BigInt fields
        const restored: ChainBlock = {
          ...block,
          number: BigInt(block.number),
        }
        // Dedup: skip already-seen blocks
        if (this.seenBlocks.has(restored.hash)) return
        this.seenBlocks.add(restored.hash)
        await this.cfg.onBlock(restored)
        // Cross-protocol relay (Wire → HTTP gossip)
        try { await this.cfg.onBlockRelay?.(restored) } catch { /* relay errors are non-fatal */ }
        break
      }

      case MessageType.Transaction: {
        if (!conn.handshakeComplete) return
        const { rawTx } = decodeJsonPayload<{ rawTx: Hex }>(frame)
        // Dedup: skip already-seen transactions
        if (this.seenTx.has(rawTx)) return
        this.seenTx.add(rawTx)
        await this.cfg.onTx(rawTx)
        // Cross-protocol relay (Wire → HTTP gossip)
        try { await this.cfg.onTxRelay?.(rawTx) } catch { /* relay errors are non-fatal */ }
        break
      }

      case MessageType.BftPrepare:
      case MessageType.BftCommit: {
        if (!conn.handshakeComplete || !this.cfg.onBftMessage) return
        const msg = decodeJsonPayload<{ type: string; height: string; blockHash: Hex; senderId: string; signature?: string }>(frame)
        await this.cfg.onBftMessage({
          type: msg.type as "prepare" | "commit",
          height: BigInt(msg.height),
          blockHash: msg.blockHash,
          senderId: msg.senderId,
          signature: (msg.signature ?? "") as Hex,
        })
        break
      }

      case MessageType.FindNode: {
        if (!conn.handshakeComplete) return
        const req = decodeJsonPayload<FindNodePayload>(frame)
        const peers = this.cfg.onFindNode?.(req.targetId) ?? []
        const resp: FindNodeResponsePayload = {
          requestId: req.requestId,
          peers,
        }
        conn.socket.write(encodeJsonPayload(MessageType.FindNodeResponse, resp))
        break
      }

      case MessageType.FindNodeResponse: {
        // Handled by pending request callbacks (see WireClient)
        break
      }

      case MessageType.Ping: {
        conn.socket.write(encodeJsonPayload(MessageType.Pong, { ts: Date.now() }))
        break
      }

      case MessageType.Pong: {
        // latency tracking could be added here
        break
      }
    }
  }
}
