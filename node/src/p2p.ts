import http from "node:http"
import { request as httpRequest } from "node:http"
import type { ChainBlock, ChainSnapshot, Hex, NodePeer } from "./blockchain-types.ts"
import { PeerScoring } from "./peer-scoring.ts"
import { PeerDiscovery } from "./peer-discovery.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("p2p")

export interface P2PHandlers {
  onTx: (rawTx: Hex) => Promise<void>
  onBlock: (block: ChainBlock) => Promise<void>
  onSnapshotRequest: () => ChainSnapshot
}

export interface P2PConfig {
  bind: string
  port: number
  peers: NodePeer[]
  nodeId?: string
  maxPeers?: number
  enableDiscovery?: boolean
}

export class BoundedSet<T> {
  private readonly maxSize: number
  private readonly items = new Set<T>()
  private readonly insertOrder: T[] = []

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  has(value: T): boolean {
    return this.items.has(value)
  }

  add(value: T): void {
    if (this.items.has(value)) return
    if (this.items.size >= this.maxSize) {
      const oldest = this.insertOrder.shift()
      if (oldest !== undefined) {
        this.items.delete(oldest)
      }
    }
    this.items.add(value)
    this.insertOrder.push(value)
  }

  get size(): number {
    return this.items.size
  }
}

export class P2PNode {
  private readonly cfg: P2PConfig
  private readonly handlers: P2PHandlers
  private readonly seenTx = new BoundedSet<Hex>(50_000)
  private readonly seenBlocks = new BoundedSet<Hex>(10_000)
  readonly scoring: PeerScoring
  readonly discovery: PeerDiscovery

  constructor(cfg: P2PConfig, handlers: P2PHandlers) {
    this.cfg = cfg
    this.handlers = handlers
    this.scoring = new PeerScoring()
    this.discovery = new PeerDiscovery(
      cfg.peers,
      this.scoring,
      {
        selfId: cfg.nodeId ?? "node-1",
        selfUrl: `http://${cfg.bind}:${cfg.port}`,
        maxPeers: cfg.maxPeers ?? 50,
      },
    )

    // Register static peers in scoring
    for (const peer of cfg.peers) {
      this.scoring.addPeer(peer.id, peer.url)
    }
  }

  start(): void {
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(serializeJson({ ok: true, ts: Date.now() }))
        return
      }

      if (req.method === "GET" && req.url === "/p2p/chain-snapshot") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(serializeJson(this.handlers.onSnapshotRequest()))
        return
      }

      if (req.method === "GET" && req.url === "/p2p/peers") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(serializeJson({ peers: this.discovery.getPeerListForExchange() }))
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
          if (req.url === "/p2p/gossip-tx") {
            const payload = JSON.parse(body || "{}") as { rawTx?: Hex }
            if (!payload.rawTx) throw new Error("missing rawTx")
            await this.receiveTx(payload.rawTx)
            res.writeHead(200)
            res.end(serializeJson({ ok: true }))
            return
          }

          if (req.url === "/p2p/gossip-block") {
            const payload = JSON.parse(body || "{}") as { block?: ChainBlock }
            if (!payload.block) throw new Error("missing block")
            await this.receiveBlock(payload.block)
            res.writeHead(200)
            res.end(serializeJson({ ok: true }))
            return
          }

          res.writeHead(404)
          res.end(serializeJson({ error: "not found" }))
        } catch (error) {
          res.writeHead(500)
          res.end(serializeJson({ error: String(error) }))
        }
      })
    })

    server.listen(this.cfg.port, this.cfg.bind, () => {
      log.info("listening", { bind: this.cfg.bind, port: this.cfg.port })
    })

    // Start peer discovery and scoring if enabled
    if (this.cfg.enableDiscovery !== false) {
      this.discovery.start()
      this.scoring.startDecay()
    }
  }

  async receiveTx(rawTx: Hex): Promise<void> {
    if (this.seenTx.has(rawTx)) return
    this.seenTx.add(rawTx)
    await this.handlers.onTx(rawTx)
    void this.broadcast("/p2p/gossip-tx", { rawTx })
  }

  async receiveBlock(block: ChainBlock): Promise<void> {
    if (this.seenBlocks.has(block.hash)) return
    this.seenBlocks.add(block.hash)
    await this.handlers.onBlock(block)
    void this.broadcast("/p2p/gossip-block", { block })
  }

  async fetchSnapshots(): Promise<ChainSnapshot[]> {
    const results: ChainSnapshot[] = []
    for (const peer of this.cfg.peers) {
      try {
        const snapshot = await requestJson<ChainSnapshot>(`${peer.url}/p2p/chain-snapshot`, "GET")
        results.push(snapshot)
      } catch {
        // ignore peer failures
      }
    }
    return results
  }

  private async broadcast(path: string, payload: unknown): Promise<void> {
    // Use discovered active peers if discovery is enabled, otherwise fall back to config
    const peers = this.cfg.enableDiscovery !== false
      ? this.discovery.getActivePeers()
      : this.cfg.peers

    await Promise.all(peers.map(async (peer) => {
      try {
        await requestJson(`${peer.url}${path}`, "POST", payload)
        this.scoring.recordSuccess(peer.id)
      } catch {
        this.scoring.recordFailure(peer.id)
      }
    }))
  }
}

async function requestJson<T = unknown>(url: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const endpoint = new URL(url)

  return await new Promise<T>((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        method,
        headers: {
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          try {
            const parsed = data.length > 0 ? JSON.parse(data) : {}
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`))
              return
            }
            resolve(parsed as T)
          } catch (error) {
            reject(error)
          }
        })
      },
    )

    req.on("error", reject)
    if (method === "POST") {
      req.write(serializeJson(body ?? {}))
    }
    req.end()
  })
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, input) => {
    if (typeof input === "bigint") {
      return input.toString()
    }
    return input
  })
}
