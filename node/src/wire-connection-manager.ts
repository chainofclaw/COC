/**
 * Wire Connection Manager
 *
 * Manages outbound WireClient connections to peers. Handles:
 * - Adding/removing peer connections
 * - Maximum connection limits
 * - Connection state tracking
 * - Broadcasting messages to all connected peers
 */

import { WireClient } from "./wire-client.ts"
import type { WireClientConfig } from "./wire-client.ts"
import { MessageType, encodeJsonPayload } from "./wire-protocol.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("wire-conn-mgr")

const DEFAULT_MAX_CONNECTIONS = 25

export interface ConnectionManagerConfig {
  nodeId: string
  chainId: number
  maxConnections?: number
  signer?: NodeSigner
  verifier?: SignatureVerifier
}

interface ManagedConnection {
  client: WireClient
  host: string
  port: number
  connectedAtMs: number | null
}

export class WireConnectionManager {
  private readonly cfg: ConnectionManagerConfig
  private readonly connections = new Map<string, ManagedConnection>()
  private readonly maxConnections: number

  constructor(cfg: ConnectionManagerConfig) {
    this.cfg = cfg
    this.maxConnections = cfg.maxConnections ?? DEFAULT_MAX_CONNECTIONS
  }

  /** Add a peer connection. Returns false if at max capacity or already connected. */
  addPeer(host: string, port: number): boolean {
    const key = `${host}:${port}`
    if (this.connections.has(key)) return false
    if (this.connections.size >= this.maxConnections) {
      log.warn("max connections reached", { max: this.maxConnections })
      return false
    }

    const clientCfg: WireClientConfig = {
      host,
      port,
      nodeId: this.cfg.nodeId,
      chainId: this.cfg.chainId,
      signer: this.cfg.signer,
      verifier: this.cfg.verifier,
      onConnected: () => {
        const conn = this.connections.get(key)
        if (conn) conn.connectedAtMs = Date.now()
        log.info("peer connected", { key, remoteId: conn?.client.getRemoteNodeId() })
      },
      onDisconnected: () => {
        log.info("peer disconnected", { key })
        const conn = this.connections.get(key)
        if (conn) conn.connectedAtMs = null
      },
    }

    const client = new WireClient(clientCfg)
    this.connections.set(key, { client, host, port, connectedAtMs: null })
    client.connect()
    return true
  }

  /** Remove and disconnect a peer */
  removePeer(host: string, port: number): boolean {
    const key = `${host}:${port}`
    const conn = this.connections.get(key)
    if (!conn) return false
    conn.client.disconnect()
    this.connections.delete(key)
    return true
  }

  /** Get all connected WireClients */
  getConnectedClients(): WireClient[] {
    return [...this.connections.values()]
      .filter((c) => c.client.isConnected())
      .map((c) => c.client)
  }

  /** Broadcast a typed message to all connected peers */
  broadcast(type: (typeof MessageType)[keyof typeof MessageType], payload: unknown): number {
    const data = encodeJsonPayload(type, payload)
    let sent = 0
    for (const [, conn] of this.connections) {
      if (conn.client.send(data)) sent++
    }
    return sent
  }

  /** Get connection statistics */
  getStats(): {
    total: number
    connected: number
    connecting: number
    maxConnections: number
    peers: Array<{ key: string; connected: boolean; remoteId: string | null; uptimeMs: number | null }>
  } {
    const peers = [...this.connections.entries()].map(([key, conn]) => ({
      key,
      connected: conn.client.isConnected(),
      remoteId: conn.client.getRemoteNodeId(),
      uptimeMs: conn.connectedAtMs ? Date.now() - conn.connectedAtMs : null,
    }))

    return {
      total: this.connections.size,
      connected: peers.filter((p) => p.connected).length,
      connecting: peers.filter((p) => !p.connected).length,
      maxConnections: this.maxConnections,
      peers,
    }
  }

  /** Disconnect all peers and stop */
  stop(): void {
    for (const [, conn] of this.connections) {
      conn.client.disconnect()
    }
    this.connections.clear()
  }

  /** Find a client by remote node ID */
  findByNodeId(nodeId: string): WireClient | undefined {
    for (const [, conn] of this.connections) {
      if (conn.client.getRemoteNodeId() === nodeId && conn.client.isConnected()) {
        return conn.client
      }
    }
    return undefined
  }
}
