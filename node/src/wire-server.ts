/**
 * Wire Protocol TCP Server
 *
 * Accepts inbound TCP connections, performs handshake,
 * and dispatches decoded frames to application handlers.
 */

import net from "node:net"
import { FrameDecoder, MessageType, encodeJsonPayload, decodeJsonPayload } from "./wire-protocol.ts"
import type { WireFrame } from "./wire-protocol.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import type { BftMessage } from "./bft.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("wire-server")

interface HandshakePayload {
  nodeId: string
  chainId: number
  height: string
}

export interface WireServerConfig {
  port: number
  bind?: string
  nodeId: string
  chainId: number
  onBlock: (block: ChainBlock) => Promise<void>
  onTx: (rawTx: Hex) => Promise<void>
  onBftMessage?: (msg: BftMessage) => Promise<void>
  getHeight: () => Promise<bigint | Promise<bigint>>
}

interface PeerConnection {
  socket: net.Socket
  decoder: FrameDecoder
  nodeId: string | null
  handshakeComplete: boolean
}

export class WireServer {
  private readonly cfg: WireServerConfig
  private readonly connections = new Map<string, PeerConnection>()
  private server: net.Server | null = null

  constructor(cfg: WireServerConfig) {
    this.cfg = cfg
  }

  start(): void {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket)
    })

    this.server.listen(this.cfg.port, this.cfg.bind ?? "0.0.0.0", () => {
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

  /** Broadcast a frame to all connected peers */
  broadcastFrame(data: Uint8Array): void {
    for (const [, conn] of this.connections) {
      if (conn.handshakeComplete) {
        conn.socket.write(data)
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

  private handleConnection(socket: net.Socket): void {
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
      try {
        const frames = conn.decoder.feed(new Uint8Array(data))
        for (const frame of frames) {
          void this.handleFrame(conn, frame)
        }
      } catch (err) {
        log.warn("frame decode error, closing connection", { remote: connId, error: String(err) })
        socket.destroy()
      }
    })

    socket.on("close", () => {
      this.connections.delete(connId)
      log.info("wire connection closed", { remote: connId, nodeId: conn.nodeId })
    })

    socket.on("error", (err) => {
      log.warn("wire socket error", { remote: connId, error: String(err) })
    })
  }

  private async sendHandshake(socket: net.Socket): Promise<void> {
    const height = await Promise.resolve(await this.cfg.getHeight())
    const payload: HandshakePayload = {
      nodeId: this.cfg.nodeId,
      chainId: this.cfg.chainId,
      height: height.toString(),
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
        conn.nodeId = hs.nodeId
        conn.handshakeComplete = true
        // Reply with ack if this was a handshake (not ack)
        if (frame.type === MessageType.Handshake) {
          const height = await Promise.resolve(await this.cfg.getHeight())
          const ack: HandshakePayload = {
            nodeId: this.cfg.nodeId,
            chainId: this.cfg.chainId,
            height: height.toString(),
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
        await this.cfg.onBlock(restored)
        break
      }

      case MessageType.Transaction: {
        if (!conn.handshakeComplete) return
        const { rawTx } = decodeJsonPayload<{ rawTx: Hex }>(frame)
        await this.cfg.onTx(rawTx)
        break
      }

      case MessageType.BftPrepare:
      case MessageType.BftCommit: {
        if (!conn.handshakeComplete || !this.cfg.onBftMessage) return
        const msg = decodeJsonPayload<{ type: string; height: string; blockHash: Hex; senderId: string }>(frame)
        await this.cfg.onBftMessage({
          type: msg.type as "prepare" | "commit",
          height: BigInt(msg.height),
          blockHash: msg.blockHash,
          senderId: msg.senderId,
        })
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
