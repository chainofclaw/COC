/**
 * Wire Protocol TCP Server
 *
 * Accepts inbound TCP connections, performs handshake,
 * and dispatches decoded frames to application handlers.
 */

import net from "node:net"
import crypto from "node:crypto"
import { FrameDecoder, MessageType, encodeJsonPayload, decodeJsonPayload, buildWireHandshakeMessage } from "./wire-protocol.ts"
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
  /** Peer scoring callback for recording invalid data from peers */
  peerScoring?: { recordInvalidData: (ip: string) => void }
  /** Shared dedup sets from P2P layer — prevents cross-protocol amplification */
  sharedSeenTx?: BoundedSet<Hex>
  /** Shared dedup sets from P2P layer — prevents cross-protocol amplification */
  sharedSeenBlocks?: BoundedSet<Hex>
}

interface PeerConnection {
  socket: net.Socket
  decoder: FrameDecoder
  nodeId: string | null
  handshakeComplete: boolean
  msgCount: number
  msgWindowStartMs: number
  handshakeTimer?: ReturnType<typeof setTimeout>
}

const MAX_CONNECTIONS_PER_IP = 5
const MAX_MESSAGES_PER_WINDOW = 500
const MESSAGE_WINDOW_MS = 10_000 // 10 seconds
const IDLE_TIMEOUT_MS = 300_000 // 5 minutes

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
  private unknownFrameTypes = 0
  private readonly seenTx: BoundedSet<Hex>
  private readonly seenBlocks: BoundedSet<Hex>
  private readonly handshakeNonces = new BoundedSet<string>(10_000)

  constructor(cfg: WireServerConfig) {
    this.cfg = cfg
    this.seenTx = cfg.sharedSeenTx ?? new BoundedSet<Hex>(50_000)
    this.seenBlocks = cfg.sharedSeenBlocks ?? new BoundedSet<Hex>(10_000)
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
      if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer)
      conn.socket.destroy()
    }
    this.connections.clear()
    this.connsByIp.clear()
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
        // Check buffer BEFORE writing: account for the data about to be queued.
        // This prevents the buffer from exceeding the limit by one frame.
        const projectedLength = conn.socket.writableLength + data.byteLength
        if (projectedLength > 10 * 1024 * 1024) {
          log.warn("wire peer write buffer overflow, disconnecting", {
            peer: conn.nodeId,
            bufferedBytes: conn.socket.writableLength,
            dataSize: data.byteLength,
          })
          conn.socket.destroy()
          continue
        }
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
    unknownFrameTypes: number
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
      unknownFrameTypes: this.unknownFrameTypes,
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

    // Per-IP connection limit (normalize IPv4-mapped IPv6 to plain IPv4)
    // Atomically increment-then-check to prevent TOCTOU race where two connections
    // from the same IP both read the count before either increments.
    const rawIp = socket.remoteAddress ?? "unknown"
    const remoteIp = rawIp.startsWith("::ffff:") ? rawIp.slice(7) : rawIp
    const ipCount = (this.connsByIp.get(remoteIp) ?? 0) + 1
    this.connsByIp.set(remoteIp, ipCount)
    if (ipCount > MAX_CONNECTIONS_PER_IP) {
      // Rollback the increment
      this.connsByIp.set(remoteIp, ipCount - 1)
      this.connectionsRejected++
      log.warn("per-IP connection limit reached", { ip: remoteIp, count: ipCount })
      socket.destroy()
      return
    }

    this.totalConnectionsAccepted++
    const connId = `${socket.remoteAddress}:${socket.remotePort}`
    const conn: PeerConnection = {
      socket,
      decoder: new FrameDecoder(),
      nodeId: null,
      handshakeComplete: false,
      msgCount: 0,
      msgWindowStartMs: Date.now(),
    }
    this.connections.set(connId, conn)

    log.info("new wire connection", { remote: connId })

    // Send our handshake
    void this.sendHandshake(socket)

    // Handshake timeout: disconnect peers that don't complete handshake in time
    const HANDSHAKE_TIMEOUT_MS = 10_000
    conn.handshakeTimer = setTimeout(() => {
      if (!conn.handshakeComplete) {
        log.info("wire handshake timeout", { remote: connId })
        socket.destroy()
      }
    }, HANDSHAKE_TIMEOUT_MS)
    conn.handshakeTimer.unref()

    // Idle timeout: disconnect peers that send no data
    socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      log.info("wire connection idle timeout", { remote: connId })
      socket.destroy()
    })

    // Frame processing queue: process frames sequentially to avoid re-entrant
    // applyBlock errors when multiple Block frames arrive in the same TCP segment.
    // Always catch to prevent a rejected promise from breaking the chain.
    let frameQueue: Promise<void> = Promise.resolve()
    socket.on("data", (data: Buffer) => {
      this.bytesReceived += data.byteLength
      try {
        const frames = conn.decoder.feed(new Uint8Array(data))
        for (const frame of frames) {
          if (socket.destroyed) break
          this.framesReceived++
          frameQueue = frameQueue.then(async () => {
            if (socket.destroyed) return
            try {
              await this.handleFrame(conn, frame)
            } catch (err) {
              log.warn("handleFrame error, closing connection", { remote: connId, error: String(err) })
              socket.destroy()
            }
          }, () => {
            // Previous link rejected unexpectedly — absorb to keep the chain alive.
            // The connection may already be destroyed by the prior error handler.
          })
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
    const nonce = `${Date.now()}:${crypto.randomUUID()}`
    const payload: HandshakePayload = {
      nodeId: this.cfg.nodeId,
      chainId: this.cfg.chainId,
      height: height.toString(),
    }
    // Attach crypto identity if signer available
    if (this.cfg.signer) {
      const msg = buildWireHandshakeMessage(this.cfg.nodeId, this.cfg.chainId, nonce)
      payload.nonce = nonce
      payload.signature = this.cfg.signer.sign(msg)
    }
    const frame = encodeJsonPayload(MessageType.Handshake, payload)
    socket.write(frame)
  }

  private async handleFrame(conn: PeerConnection, frame: WireFrame): Promise<void> {
    // Per-connection message rate limiting
    const now = Date.now()
    if (now - conn.msgWindowStartMs > MESSAGE_WINDOW_MS) {
      conn.msgCount = 0
      conn.msgWindowStartMs = now
    }
    conn.msgCount++
    if (conn.msgCount > MAX_MESSAGES_PER_WINDOW) {
      log.warn("wire peer rate limited", { peer: conn.nodeId })
      conn.socket.destroy()
      return
    }

    switch (frame.type) {
      case MessageType.Handshake:
      case MessageType.HandshakeAck: {
        // Reject re-handshake: a peer that already completed handshake must not
        // be allowed to switch identity by sending another handshake frame.
        if (conn.handshakeComplete) {
          log.warn("rejecting re-handshake from already authenticated peer", { peer: conn.nodeId })
          conn.socket.destroy()
          return
        }
        const hs = decodeJsonPayload<HandshakePayload>(frame)
        if (hs.chainId !== this.cfg.chainId) {
          log.warn("chain ID mismatch, closing", { remote: hs.nodeId, expected: this.cfg.chainId, got: hs.chainId })
          conn.socket.destroy()
          return
        }
        // When verifier is enabled, handshake signature is mandatory.
        if (this.cfg.verifier) {
          if (!hs.signature || !hs.nonce) {
            log.warn("handshake missing signature", { peer: hs.nodeId })
            this.cfg.peerScoring?.recordInvalidData(conn.socket.remoteAddress ?? "unknown")
            conn.socket.destroy()
            return
          }
          // Nonce replay protection: in-memory dedup + timestamp window
          // Atomic check-then-add to prevent TOCTOU race on concurrent connections
          if (this.handshakeNonces.has(hs.nonce)) {
            log.warn("handshake nonce replay detected", { peer: hs.nodeId, nonce: hs.nonce })
            this.cfg.peerScoring?.recordInvalidData(conn.socket.remoteAddress ?? "unknown")
            conn.socket.destroy()
            return
          }
          this.handshakeNonces.add(hs.nonce)
          // Reject nonces with timestamps too far from current time (replay across restarts)
          // Fail-closed: invalid/missing timestamp → reject (legitimate clients always include timestamp)
          const nonceParts = hs.nonce.split(":")
          if (nonceParts.length < 2) {
            log.warn("handshake nonce format invalid (missing timestamp)", { peer: hs.nodeId })
            conn.socket.destroy()
            return
          }
          if (nonceParts.length >= 2) {
            const nonceTs = parseInt(nonceParts[0], 10)
            if (isNaN(nonceTs)) {
              log.warn("handshake nonce timestamp invalid", { peer: hs.nodeId, nonce: hs.nonce })
              conn.socket.destroy()
              return
            }
            if (Math.abs(Date.now() - nonceTs) > 300_000) { // 5 min window
              log.warn("handshake nonce timestamp stale", { peer: hs.nodeId, nonceTs })
              conn.socket.destroy()
              return
            }
          }
          const msg = buildWireHandshakeMessage(hs.nodeId, hs.chainId, hs.nonce)
          let recovered: string
          try {
            recovered = this.cfg.verifier.recoverAddress(msg, hs.signature)
          } catch {
            log.warn("handshake signature invalid format", { peer: hs.nodeId })
            this.cfg.peerScoring?.recordInvalidData(conn.socket.remoteAddress ?? "unknown")
            conn.socket.destroy()
            return
          }
          if (recovered.toLowerCase() !== hs.nodeId.toLowerCase()) {
            log.warn("handshake signature mismatch", { claimed: hs.nodeId, recovered })
            this.cfg.peerScoring?.recordInvalidData(conn.socket.remoteAddress ?? "unknown")
            conn.socket.destroy()
            return
          }
          // nonce already added atomically after has() check above
        }
        // Evict existing connection with same nodeId only when verifier is active
        // (nodeId was cryptographically authenticated). Without verifier, skip eviction
        // to prevent attackers from spoofing nodeId to disconnect legitimate peers.
        if (this.cfg.verifier) {
          // Collect duplicates first to avoid modifying connections Map during iteration
          const toEvict: { id: string; conn: typeof conn }[] = []
          for (const [existingId, existingConn] of this.connections) {
            if (existingConn.nodeId === hs.nodeId && existingConn !== conn) {
              toEvict.push({ id: existingId, conn: existingConn })
            }
          }
          for (const entry of toEvict) {
            log.warn("duplicate nodeId, closing old connection", { nodeId: hs.nodeId, old: entry.id })
            entry.conn.socket.destroy()
          }
        }
        conn.nodeId = hs.nodeId
        conn.handshakeComplete = true
        if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer)
        // Reply with ack if this was a handshake (not ack)
        if (frame.type === MessageType.Handshake) {
          const height = await Promise.resolve(await this.cfg.getHeight())
          const nonce = `${Date.now()}:${crypto.randomUUID()}`
          const ack: HandshakePayload = {
            nodeId: this.cfg.nodeId,
            chainId: this.cfg.chainId,
            height: height.toString(),
          }
          if (this.cfg.signer) {
            const ackMsg = buildWireHandshakeMessage(this.cfg.nodeId, this.cfg.chainId, nonce)
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
        // Restore BigInt fields lost during JSON serialization
        const restored: ChainBlock = {
          ...block,
          number: BigInt(block.number),
          ...(block.baseFee !== undefined ? { baseFee: BigInt(block.baseFee) } : {}),
          ...(block.cumulativeWeight !== undefined ? { cumulativeWeight: BigInt(block.cumulativeWeight) } : {}),
          ...(block.timestampMs !== undefined ? { timestampMs: Number(block.timestampMs) } : {}),
          ...(block.gasUsed !== undefined ? { gasUsed: BigInt(block.gasUsed) } : {}),
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
        // Derive BFT type from the wire frame type — never trust the JSON payload type field.
        // This prevents attackers from sending a BftPrepare frame with type:"commit" in payload.
        const bftType: "prepare" | "commit" = frame.type === MessageType.BftPrepare ? "prepare" : "commit"
        // Validate senderId matches authenticated connection identity
        if (msg.senderId !== conn.nodeId) {
          log.warn("BFT message senderId mismatch", { claimed: msg.senderId, authenticated: conn.nodeId })
          return
        }
        await this.cfg.onBftMessage({
          type: bftType,
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
        const allPeers = this.cfg.onFindNode?.(req.targetId) ?? []
        const peers = allPeers.slice(0, 20) // K-bucket limit: max 20 peers per response
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

      default: {
        // Log unknown frame types for anomaly detection (protocol mismatch,
        // fuzzing, or future protocol version probing)
        this.unknownFrameTypes++
        log.warn("unknown wire frame type", { type: `0x${frame.type.toString(16)}`, peer: conn.nodeId })
        break
      }
    }
  }
}
