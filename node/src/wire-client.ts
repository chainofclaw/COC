/**
 * Wire Protocol TCP Client
 *
 * Outbound TCP connection with handshake, exponential backoff reconnect,
 * and frame send capability.
 */

import net from "node:net"
import { FrameDecoder, MessageType, encodeJsonPayload, decodeJsonPayload, buildWireHandshakeMessage } from "./wire-protocol.ts"
import type { WireFrame, FindNodePayload, FindNodeResponsePayload, BlockRequestPayload, BlockResponsePayload } from "./wire-protocol.ts"
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
  // DID extensions (optional, backward compatible)
  did?: string
  didProof?: string
}

export interface WireClientConfig {
  host: string
  port: number
  nodeId: string
  chainId: number
  onConnected?: () => void
  onDisconnected?: () => void
  /**
   * Issue #72: provide the local chain height so the outbound handshake
   * advertises a real value instead of "0". Without this, peers can't tell
   * when this client is behind, and a restarted validator stalls until the
   * 600 s no-progress watchdog fires. Returning a Promise is fine — the
   * handshake send awaits before writing the frame.
   */
  getHeight?: () => bigint | Promise<bigint>
  /**
   * Issue #72: called once per handshake completion with the remote's
   * advertised height. Wires up snap-sync triggers in higher layers
   * without coupling the wire client to the chain engine itself.
   */
  onPeerHeight?: (remoteHeight: bigint, peerId: string) => void
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
  // Issue #72: parsed remote height from handshake. -1n means "not yet
  // observed"; positive values are the peer's claimed chain height when
  // the handshake completed. Stored so callers (snap-sync trigger,
  // metrics) can ask after the fact rather than racing the onPeerHeight
  // callback.
  private remoteHeight: bigint = -1n
  private reconnectMs = MIN_RECONNECT_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly pendingFindNode = new Map<string, {
    resolve: (peers: Array<{ id: string; address: string }>) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  /**
   * Outstanding BlockRequest / push replies awaiting BlockResponse. Keyed by
   * the requestId the client sent; value resolves with the fetched bytes on
   * a successful pull or `null` otherwise (timeout, not-found, hash
   * mismatch on push, disconnect). Pull and push both use the same map —
   * a push resolves to `null` if `found:false`, `empty Uint8Array` if
   * `found:true`, letting callers distinguish acknowledgment from content.
   */
  private readonly pendingBlockRequest = new Map<string, {
    resolve: (bytes: Uint8Array | null) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  // Inbound message rate limiting
  private inboundMsgCount = 0
  private inboundWindowStart = 0
  private static readonly MAX_INBOUND_PER_SECOND = 200
  private static readonly MAX_PENDING_FIND_NODE = 50
  // Block requests can be pipelined but we still bound the in-flight set so a
  // compromised peer can't starve us by never replying. 100 is generous for
  // the replication fan-out ceiling (K=3) × simultaneous GETs.
  private static readonly MAX_PENDING_BLOCK = 100

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
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    // Clean up pending FindNode requests to prevent memory leak
    for (const entry of this.pendingFindNode.values()) {
      clearTimeout(entry.timer)
    }
    this.pendingFindNode.clear()
    // Resolve pending block requests to null so any awaiting caller returns
    // quickly instead of hitting its own timeout. The timer is cleared so we
    // don't double-invoke after the cascade.
    for (const entry of this.pendingBlockRequest.values()) {
      clearTimeout(entry.timer)
      entry.resolve(null)
    }
    this.pendingBlockRequest.clear()
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.connected = false
    this.handshakeComplete = false
    this.sendQueue.length = 0
    this.queuedBytes = 0
    this.drainAttached = false
  }

  // Queue used when socket.write() reports backpressure (returns false). We
  // hold the frames here until the kernel buffer drains; the socket's `'drain'`
  // event flushes them in order. Prior to issue #71's fix, large IPFS PUTs
  // (50 MB → ~200 chunks pushed in a tight loop) tripped a 10 MB write-buffer
  // ceiling that *destroyed* the socket — every receiving peer saw ECONNRESET
  // mid-burst and the leaf chunks never replicated. Queueing instead of
  // destroying preserves the connection; the cap below stops a stuck peer
  // from growing the queue forever.
  private readonly sendQueue: Uint8Array[] = []
  private queuedBytes = 0
  // 64 MiB ceiling. Beyond this we drop frames (return false) — a peer this
  // far behind is effectively dead and force-destroying preserves memory.
  // For comparison, K=3 × 50 MiB UnixFS file ≈ 150 MiB total write volume,
  // far higher than this cap; we rely on socket flow-control + the per-peer
  // concurrency cap in `pushToK` to keep us under the cap in practice.
  private static readonly SEND_QUEUE_HIGH_WATERMARK = 64 * 1024 * 1024
  private drainAttached = false

  /** Send a raw wire frame to the peer */
  send(data: Uint8Array): boolean {
    if (!this.socket || !this.handshakeComplete) return false
    // If a queue is already draining, append to it rather than racing
    // socket.write — preserves frame ordering when backpressure clears.
    if (this.sendQueue.length > 0) {
      if (this.queuedBytes + data.length > WireClient.SEND_QUEUE_HIGH_WATERMARK) {
        log.warn("wire client send queue overflow, dropping frame", {
          peer: this.remoteNodeId,
          queuedBytes: this.queuedBytes,
          frameLen: data.length,
        })
        return false
      }
      this.sendQueue.push(data)
      this.queuedBytes += data.length
      this.attachDrain()
      return true
    }
    const ok = this.socket.write(data)
    if (!ok) {
      // Kernel buffer full. Queue the frame and wait for `'drain'`.
      this.sendQueue.push(data)
      this.queuedBytes += data.length
      this.attachDrain()
    }
    return true
  }

  /** Resolves once the send queue is empty (or peer disconnects). */
  awaitDrain(timeoutMs = 30_000): Promise<boolean> {
    if (!this.socket || !this.handshakeComplete) return Promise.resolve(false)
    if (this.sendQueue.length === 0 && (this.socket.writableLength ?? 0) === 0) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      const check = () => {
        if (this.sendQueue.length === 0 && (this.socket?.writableLength ?? 0) === 0) {
          clearTimeout(timer)
          resolve(true)
          return
        }
        this.socket?.once("drain", check)
      }
      check()
    })
  }

  private attachDrain(): void {
    if (this.drainAttached || !this.socket) return
    this.drainAttached = true
    this.socket.on("drain", this.flushQueue)
  }

  private flushQueue = (): void => {
    if (!this.socket || !this.handshakeComplete) {
      this.sendQueue.length = 0
      this.queuedBytes = 0
      this.drainAttached = false
      return
    }
    while (this.sendQueue.length > 0) {
      const next = this.sendQueue[0]
      const ok = this.socket.write(next)
      this.sendQueue.shift()
      this.queuedBytes -= next.length
      if (!ok) {
        // Still backpressured — leave the rest queued, drain will fire again.
        return
      }
    }
    // Queue empty. Detach the drain handler so we don't accumulate listeners.
    this.socket.removeListener("drain", this.flushQueue)
    this.drainAttached = false
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

  /**
   * Issue #72: peer's chain height reported during the handshake. Returns
   * `-1n` if no handshake has completed yet (or peer's height was not
   * parseable). Callers driving snap-sync triggers should ignore the -1
   * sentinel rather than treating it as "behind genesis".
   */
  getRemoteHeight(): bigint {
    return this.remoteHeight
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
    this.pingTimer.unref()
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
      if (this.pendingFindNode.size >= WireClient.MAX_PENDING_FIND_NODE) {
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

  /**
   * Pull an IPFS block from this peer.
   *
   * Resolves with the block's bytes on success (peer had the CID and it
   * decoded cleanly), `null` on: not connected, over the pending-request
   * cap, peer response `found:false`, timeout (default 5s), or disconnect.
   * Never rejects — callers iterate through providers and stop at the
   * first non-null result, so throwing would just complicate that loop.
   */
  requestBlock(cid: string, timeoutMs = 5000): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      if (!this.isConnected()) {
        resolve(null)
        return
      }
      if (this.pendingBlockRequest.size >= WireClient.MAX_PENDING_BLOCK) {
        resolve(null)
        return
      }
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => {
        this.pendingBlockRequest.delete(requestId)
        resolve(null)
      }, timeoutMs)

      this.pendingBlockRequest.set(requestId, { resolve, timer })

      const payload: BlockRequestPayload = { requestId, cid, push: false }
      const sent = this.sendMessage(MessageType.BlockRequest, payload)
      if (!sent) {
        clearTimeout(timer)
        this.pendingBlockRequest.delete(requestId)
        resolve(null)
      }
    })
  }

  /**
   * Push an IPFS block to this peer for replication (C1.4's pushToK).
   *
   * Resolves `true` if the peer acknowledged the push with `found:true`
   * (stored it successfully), `false` otherwise — disconnect, timeout,
   * pending cap, or `found:false` which peers emit on hash mismatch,
   * oversize, or storage error. Bytes go over the wire base64-encoded
   * inside the same frame as the request so a push is a single round-trip;
   * at 256 KiB / chunk that's a 341 KiB frame, well under the 16 MiB cap.
   */
  /**
   * Phase C cross-node DHT gossip: tell this peer that the local node
   * holds `cid`. One-hop fire-and-forget — no response frame, no
   * pending-request tracking. Receiver's wire-server will treat the
   * authenticated handshake ID as the provider, so we don't send one
   * in the payload.
   */
  sendProviderAdvertise(cid: string, ttlMs?: number): boolean {
    if (!this.isConnected()) return false
    const payload: { cid: string; ttlMs?: number } = { cid }
    if (typeof ttlMs === "number") payload.ttlMs = ttlMs
    return this.sendMessage(MessageType.ProviderAdvertise, payload)
  }

  pushBlock(cid: string, bytes: Uint8Array, timeoutMs = 10_000): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.isConnected()) {
        resolve(false)
        return
      }
      if (this.pendingBlockRequest.size >= WireClient.MAX_PENDING_BLOCK) {
        resolve(false)
        return
      }
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => {
        this.pendingBlockRequest.delete(requestId)
        resolve(false)
      }, timeoutMs)

      // Convert the ack-or-error into a boolean for the caller. Empty-but-found
      // reply is success; anything else is failure.
      this.pendingBlockRequest.set(requestId, {
        resolve: (buf: Uint8Array | null) => resolve(buf !== null),
        timer,
      })

      const b64 = Buffer.from(bytes).toString("base64")
      const payload: BlockRequestPayload = { requestId, cid, push: true, bytes: b64 }
      const sent = this.sendMessage(MessageType.BlockRequest, payload)
      if (!sent) {
        clearTimeout(timer)
        this.pendingBlockRequest.delete(requestId)
        resolve(false)
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

        // Send handshake. Resolve height inside an async IIFE so we can
        // await `cfg.getHeight()` (the chain reads through LevelDB which
        // is async) without blocking the connect callback.
        ;(async () => {
          let heightStr = "0"
          if (this.cfg.getHeight) {
            try {
              const h = await Promise.resolve(this.cfg.getHeight())
              heightStr = h.toString()
            } catch (err) {
              log.warn("getHeight failed, advertising height=0", { error: String(err) })
            }
          }
          const nonce = `${Date.now()}:${crypto.randomUUID()}`
          const hs: HandshakePayload = {
            nodeId: this.cfg.nodeId,
            chainId: this.cfg.chainId,
            height: heightStr,
          }
          if (this.cfg.signer) {
            const msg = buildWireHandshakeMessage(this.cfg.nodeId, this.cfg.chainId, nonce)
            hs.nonce = nonce
            hs.signature = this.cfg.signer.sign(msg)
          }
          // Socket may have closed between connect callback and async
          // resolution — guard so we don't write into a destroyed socket.
          if (this.socket === socket && !socket.destroyed) {
            socket.write(encodeJsonPayload(MessageType.Handshake, hs))
          }
        })().catch((err) => {
          log.warn("handshake send failed", { error: String(err) })
          socket.destroy()
        })

        // Handshake timeout: disconnect if server doesn't complete handshake in time
        const HANDSHAKE_TIMEOUT_MS = 10_000
        this.handshakeTimer = setTimeout(() => {
          if (!this.handshakeComplete) {
            log.warn("wire client handshake timeout", { host: this.cfg.host, port: this.cfg.port })
            socket.destroy()
          }
        }, HANDSHAKE_TIMEOUT_MS)
        this.handshakeTimer.unref()
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
      // Reset remote height — next reconnect will re-handshake and refresh.
      this.remoteHeight = -1n
      // Clear handshake timer to prevent timer leak on rapid connect/disconnect cycles
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
      }
      // Drop any queued send frames — the socket is gone, they'd never go out.
      this.sendQueue.length = 0
      this.queuedBytes = 0
      this.drainAttached = false
      // Stop ping timer to prevent stale latency calculations after reconnect
      this.stopPing()
      this.lastPingSentMs = 0
      // Resolve all pending FindNode requests immediately on disconnect
      // to prevent callers from hanging until timeout and to free resources
      for (const entry of this.pendingFindNode.values()) {
        clearTimeout(entry.timer)
        entry.resolve([])
      }
      this.pendingFindNode.clear()
      // Same story for pending block requests: resolve to null so the
      // caller can retry a different provider instead of waiting for its
      // own timeout.
      for (const entry of this.pendingBlockRequest.values()) {
        clearTimeout(entry.timer)
        entry.resolve(null)
      }
      this.pendingBlockRequest.clear()
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
    // Inbound message rate limiting: disconnect peers that flood frames
    const now = Date.now()
    if (now - this.inboundWindowStart > 1000) {
      this.inboundMsgCount = 0
      this.inboundWindowStart = now
    }
    this.inboundMsgCount++
    if (this.inboundMsgCount > WireClient.MAX_INBOUND_PER_SECOND) {
      log.warn("inbound rate limit exceeded, disconnecting", { peer: this.remoteNodeId })
      this.socket?.destroy()
      return
    }

    switch (frame.type) {
      case MessageType.Handshake:
      case MessageType.HandshakeAck: {
        // Reject re-handshake: server already authenticated, ignore duplicate handshake frames.
        // We allow HandshakeAck after Handshake (both arrive in initial exchange) but reject
        // any handshake frame after the connection is fully established.
        if (this.handshakeComplete && frame.type === MessageType.Handshake) {
          log.warn("rejecting re-handshake from server", { peer: this.remoteNodeId })
          this.socket?.destroy()
          return
        }
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
          // Validate nonce timestamp (fail-closed: reject invalid format or stale nonces)
          const nonceParts = hs.nonce.split(":")
          if (nonceParts.length < 2) {
            log.warn("peer handshake nonce format invalid", { peer: hs.nodeId })
            this.socket?.destroy()
            return
          }
          const nonceTs = parseInt(nonceParts[0], 10)
          if (isNaN(nonceTs) || Math.abs(Date.now() - nonceTs) > 300_000) {
            log.warn("peer handshake nonce timestamp invalid or stale", { peer: hs.nodeId, nonceTs })
            this.socket?.destroy()
            return
          }
          const msg = buildWireHandshakeMessage(hs.nodeId, hs.chainId, hs.nonce)
          let recovered: string
          try {
            recovered = this.cfg.verifier.recoverAddress(msg, hs.signature)
          } catch {
            log.warn("peer handshake signature invalid format", { peer: hs.nodeId })
            this.socket?.destroy()
            return
          }
          if (recovered.toLowerCase() !== hs.nodeId.toLowerCase()) {
            log.warn("handshake signature mismatch", { claimed: hs.nodeId, recovered })
            this.socket?.destroy()
            return
          }
        }
        // Reject identity switch: if handshake already completed with a different nodeId,
        // this is either a re-handshake attack or protocol violation.
        if (this.handshakeComplete && this.remoteNodeId && hs.nodeId !== this.remoteNodeId) {
          log.warn("rejecting identity switch attempt", {
            existing: this.remoteNodeId,
            attempted: hs.nodeId,
          })
          this.socket?.destroy()
          return
        }
        this.remoteNodeId = hs.nodeId
        // Issue #72: parse and store remote height from the handshake.
        // Only fire onPeerHeight on the *first* completed handshake —
        // wire-server sends a Handshake frame (proactive on connect)
        // AND a HandshakeAck (reply to our outbound), and both reach
        // this branch with identical payloads. Without the gate the
        // callback fires twice and snap-sync triggers run double.
        // Defensive: malicious peer could send a non-numeric or negative
        // string. On parse failure, leave the previous value in place
        // rather than overwriting with garbage.
        const firstHandshake = !this.handshakeComplete
        try {
          const parsed = BigInt(hs.height)
          if (parsed >= 0n) {
            this.remoteHeight = parsed
            // Only fire onPeerHeight when we have a non-zero height so
            // honest fresh-genesis peers don't trigger spurious sync
            // attempts on the local side. Callers can read getRemoteHeight()
            // unconditionally if they want the zero too.
            if (firstHandshake && parsed > 0n) {
              try { this.cfg.onPeerHeight?.(parsed, hs.nodeId) } catch { /* swallow */ }
            }
          }
        } catch {
          // Non-numeric height field — ignore, leave remoteHeight as-is.
        }
        this.handshakeComplete = true
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer)
          this.handshakeTimer = null
        }
        this.cfg.onConnected?.()
        break
      }

      case MessageType.FindNodeResponse: {
        const resp = decodeJsonPayload<FindNodeResponsePayload>(frame)
        const pending = this.pendingFindNode.get(resp.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingFindNode.delete(resp.requestId)
          // Limit accepted peers to prevent routing table poisoning; validate structure + format
          const rawPeers = Array.isArray(resp.peers) ? resp.peers.slice(0, 20) : []
          const peers = rawPeers.filter((p: unknown): p is { id: string; address: string } => {
            if (!p || typeof p !== "object") return false
            const obj = p as Record<string, unknown>
            if (typeof obj.id !== "string" || typeof obj.address !== "string") return false
            // Validate node ID format (0x + hex, 3-66 chars)
            if (!obj.id.startsWith("0x") || obj.id.length < 3 || obj.id.length > 66) return false
            if (!/^[0-9a-fA-F]+$/.test(obj.id.slice(2))) return false
            // Validate address is not empty and does not contain control characters
            if (obj.address.length === 0 || obj.address.length > 256) return false
            if (/[\x00-\x1f]/.test(obj.address)) return false
            return true
          })
          pending.resolve(peers)
        }
        break
      }

      case MessageType.BlockResponse: {
        const resp = decodeJsonPayload<BlockResponsePayload>(frame)
        const pending = this.pendingBlockRequest.get(resp.requestId)
        if (!pending) break
        clearTimeout(pending.timer)
        this.pendingBlockRequest.delete(resp.requestId)
        if (!resp.found) {
          pending.resolve(null)
          break
        }
        // Push ack path: found=true but bytes absent/empty. Resolve with a
        // zero-length Uint8Array so the pushBlock() wrapper can distinguish
        // "peer acknowledged" from "peer said not-found".
        if (!resp.bytes) {
          pending.resolve(new Uint8Array(0))
          break
        }
        try {
          const bytes = new Uint8Array(Buffer.from(resp.bytes, "base64"))
          pending.resolve(bytes)
        } catch {
          pending.resolve(null)
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
    this.reconnectTimer.unref()

    // Exponential backoff with cap
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
  }
}
