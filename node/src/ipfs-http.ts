import http from "node:http"
import { parse as parseUrl } from "node:url"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { IpfsBlockstore } from "./ipfs-blockstore.ts"
import { UnixFsBuilder, storeRawBlock, loadRawBlock } from "./ipfs-unixfs.ts"
import type { IpfsAddResult, UnixFsFileMeta } from "./ipfs-types.ts"
import type { IpfsMfs } from "./ipfs-mfs.ts"
import type { IpfsPubsub } from "./ipfs-pubsub.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("ipfs")

export interface IpfsServerConfig {
  bind: string
  port: number
  storageDir: string
  nodeId?: string
}

export class IpfsHttpServer {
  private readonly cfg: IpfsServerConfig
  private readonly store: IpfsBlockstore
  private readonly unixfs: UnixFsBuilder
  private mfs: IpfsMfs | null = null
  private pubsub: IpfsPubsub | null = null

  constructor(cfg: IpfsServerConfig, store: IpfsBlockstore, unixfs: UnixFsBuilder) {
    this.cfg = cfg
    this.store = store
    this.unixfs = unixfs
  }

  /**
   * Attach MFS and Pubsub subsystems.
   */
  attachSubsystems(opts: { mfs?: IpfsMfs; pubsub?: IpfsPubsub }): void {
    if (opts.mfs) this.mfs = opts.mfs
    if (opts.pubsub) this.pubsub = opts.pubsub
  }

  start(): void {
    const server = http.createServer(async (req, res) => {
      const url = parseUrl(req.url ?? "", true)
      if (req.method === "GET" && url.pathname?.startsWith("/ipfs/")) {
        const cid = url.pathname.replace("/ipfs/", "")
        const data = await this.unixfs.readFile(cid)
        res.writeHead(200)
        res.end(data)
        return
      }

      if (!url.pathname?.startsWith("/api/v0/")) {
        res.writeHead(404)
        res.end()
        return
      }

      if (url.pathname === "/api/v0/add") {
        await this.handleAdd(req, res)
        return
      }
      if (url.pathname === "/api/v0/version") {
        await this.handleVersion(res)
        return
      }
      if (url.pathname === "/api/v0/id") {
        await this.handleId(res)
        return
      }
      if (url.pathname === "/api/v0/stat") {
        await this.handleStat(res)
        return
      }
      if (url.pathname === "/api/v0/ls") {
        await this.handleLs(res, url.query.arg as string)
        return
      }
      if (url.pathname === "/api/v0/object/stat") {
        await this.handleObjectStat(res, url.query.arg as string)
        return
      }
      if (url.pathname === "/api/v0/cat") {
        await this.handleCat(req, res, url.query.arg as string)
        return
      }
      if (url.pathname === "/api/v0/get") {
        await this.handleGet(res, url.query.arg as string)
        return
      }
      if (url.pathname === "/api/v0/block/put") {
        await this.handleBlockPut(req, res)
        return
      }
      if (url.pathname === "/api/v0/block/get") {
        await this.handleBlockGet(req, res, url.query.arg as string)
        return
      }
      if (url.pathname === "/api/v0/block/stat") {
        await this.handleBlockStat(res, url.query.arg as string)
        return
      }
      if (url.pathname === "/api/v0/pin/add") {
        await this.handlePinAdd(req, res, url.query.arg as string)
        return
      }
      if (url.pathname === "/api/v0/pin/ls") {
        await this.handlePinLs(res)
        return
      }

      // MFS routes
      if (url.pathname?.startsWith("/api/v0/files/") && this.mfs) {
        await this.handleMfsRoute(req, res, url)
        return
      }

      // Pubsub routes
      if (url.pathname?.startsWith("/api/v0/pubsub/") && this.pubsub) {
        await this.handlePubsubRoute(req, res, url)
        return
      }

      res.writeHead(404)
      res.end(JSON.stringify({ error: "not found" }))
    })

    server.listen(this.cfg.port, this.cfg.bind, () => {
      log.info("listening", { bind: this.cfg.bind, port: this.cfg.port })
    })
  }

  private async handleAdd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { filename, bytes } = await readMultipartFile(req)
    const meta = await this.unixfs.addFile(filename ?? "file", bytes)
    await this.store.pin(meta.cid)
    await this.saveFileMeta(meta)

    const result: IpfsAddResult = {
      Name: filename ?? "file",
      Hash: meta.cid,
      Size: meta.size.toString(),
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(`${JSON.stringify(result)}\n`)
  }

  private async handleVersion(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      Version: "0.1.0-coc",
      Commit: "",
      Repo: "coc-ipfs",
      System: process.platform,
      Golang: "n/a",
    }))
  }

  private async handleId(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      ID: this.cfg.nodeId ?? "coc-node",
      Addresses: [`/ip4/${this.cfg.bind}/tcp/${this.cfg.port}`],
      AgentVersion: "coc-ipfs/0.1.0",
      ProtocolVersion: "ipfs/0.1.0",
    }))
  }

  private async handleStat(res: http.ServerResponse): Promise<void> {
    const stats = await this.store.stat()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      RepoSize: stats.repoSize,
      StorageMax: "0",
      NumObjects: stats.numBlocks,
      RepoPath: this.cfg.storageDir,
      Version: "0.1.0-coc",
    }))
  }

  private async handleLs(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    const meta = await this.readFileMeta()
    const file = meta[cid]
    if (!file) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: "file not found" }))
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      Objects: [
        {
          Hash: cid,
          Links: file.leaves.map((leaf, index) => ({
            Name: String(index),
            Hash: leaf,
            Size: 0,
            Type: 2,
          })),
        }
      ],
    }))
  }

  private async handleObjectStat(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    const block = await this.store.get(cid)
    const meta = await this.readFileMeta()
    const file = meta[cid]
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      Hash: cid,
      NumLinks: file?.leaves.length ?? 0,
      BlockSize: block.bytes.length,
      LinksSize: 0,
      DataSize: 0,
      CumulativeSize: file?.size ?? block.bytes.length,
    }))
  }

  private async handleCat(req: http.IncomingMessage, res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    const data = await this.unixfs.readFile(cid)
    res.writeHead(200)
    res.end(data)
  }

  private async handleGet(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    const data = await this.unixfs.readFile(cid)
    res.writeHead(200, { "content-type": "application/octet-stream" })
    res.end(data)
  }

  private async handleBlockPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req)
    const block = await storeRawBlock(this.store, body)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Key: block.cid, Size: block.bytes.length }))
  }

  private async handleBlockGet(_req: http.IncomingMessage, res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    const block = await loadRawBlock(this.store, cid)
    res.writeHead(200)
    res.end(block.bytes)
  }

  private async handleBlockStat(res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    const block = await loadRawBlock(this.store, cid)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Key: block.cid, Size: block.bytes.length }))
  }

  private async handlePinAdd(_req: http.IncomingMessage, res: http.ServerResponse, cid?: string): Promise<void> {
    if (!cid) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: "missing cid" }))
      return
    }
    await this.store.pin(cid)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Pins: [cid] }))
  }

  private async handlePinLs(res: http.ServerResponse): Promise<void> {
    const pins = await this.store.listPins()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Keys: pins.reduce((acc, cid) => {
      acc[cid] = { Type: "recursive" }
      return acc
    }, {} as Record<string, { Type: string }>) }))
  }

  private metaPath(): string {
    return join(this.cfg.storageDir, "file-meta.json")
  }

  private async saveFileMeta(meta: UnixFsFileMeta): Promise<void> {
    await mkdir(this.cfg.storageDir, { recursive: true })
    const all = await this.readFileMeta()
    all[meta.cid] = meta
    await writeFile(this.metaPath(), JSON.stringify(all, null, 2))
  }

  async readFileMeta(): Promise<Record<string, UnixFsFileMeta>> {
    try {
      const raw = await readFile(this.metaPath(), "utf-8")
      return JSON.parse(raw) as Record<string, UnixFsFileMeta>
    } catch {
      return {}
    }
  }

  private async handleMfsRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: ReturnType<typeof parseUrl>,
  ): Promise<void> {
    if (!this.mfs) {
      res.writeHead(501)
      res.end(JSON.stringify({ error: "MFS not enabled" }))
      return
    }

    const route = url.pathname?.replace("/api/v0/files/", "") ?? ""
    const arg = (url.query?.arg as string) ?? ""

    try {
      switch (route) {
        case "mkdir": {
          const parents = url.query?.parents === "true"
          await this.mfs.mkdir(arg, { parents })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "write": {
          const body = await readBody(req)
          await this.mfs.write(arg, body, {
            create: url.query?.create === "true",
            truncate: url.query?.truncate === "true",
            parents: url.query?.parents === "true",
          })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "read": {
          const data = await this.mfs.read(arg)
          res.writeHead(200)
          res.end(data)
          break
        }
        case "ls": {
          const entries = await this.mfs.ls(arg || "/")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({
            Entries: entries.map((e) => ({
              Name: e.name,
              Type: e.type === "directory" ? 1 : 0,
              Size: e.size,
              Hash: e.cid,
            })),
          }))
          break
        }
        case "rm": {
          const recursive = url.query?.recursive === "true"
          await this.mfs.rm(arg, { recursive })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "mv": {
          const source = arg
          const dest = url.query?.dest as string ?? ""
          await this.mfs.mv(source, dest)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "cp": {
          const source = arg
          const dest = url.query?.dest as string ?? ""
          await this.mfs.cp(source, dest)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "stat": {
          const stat = await this.mfs.stat(arg || "/")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(stat))
          break
        }
        case "flush": {
          const cid = await this.mfs.flush(arg || "/")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ Cid: cid }))
          break
        }
        default:
          res.writeHead(404)
          res.end(JSON.stringify({ error: `unknown MFS command: ${route}` }))
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: String(err) }))
    }
  }

  private async handlePubsubRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: ReturnType<typeof parseUrl>,
  ): Promise<void> {
    if (!this.pubsub) {
      res.writeHead(501)
      res.end(JSON.stringify({ error: "Pubsub not enabled" }))
      return
    }

    const route = url.pathname?.replace("/api/v0/pubsub/", "") ?? ""
    const topic = (url.query?.arg as string) ?? ""

    try {
      switch (route) {
        case "pub": {
          const body = await readBody(req)
          await this.pubsub.publish(topic, body)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          break
        }
        case "sub": {
          // Long-polling: return recent messages and stream new ones via ndjson
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
            "transfer-encoding": "chunked",
          })

          const handler = (msg: { from: string; seqno: string; data: Uint8Array; topicIDs: string[] }) => {
            const encoded = Buffer.from(msg.data).toString("base64")
            res.write(JSON.stringify({
              from: msg.from,
              seqno: msg.seqno,
              data: encoded,
              topicIDs: msg.topicIDs,
            }) + "\n")
          }

          this.pubsub.subscribe(topic, handler)

          // Clean up on client disconnect
          req.on("close", () => {
            this.pubsub?.unsubscribe(topic, handler)
          })
          break
        }
        case "ls": {
          const topics = this.pubsub.getTopics()
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ Strings: topics }))
          break
        }
        case "peers": {
          const count = this.pubsub.getSubscribers(topic)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ Strings: [], count }))
          break
        }
        default:
          res.writeHead(404)
          res.end(JSON.stringify({ error: `unknown pubsub command: ${route}` }))
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: String(err) }))
    }
  }
}

async function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function readMultipartFile(req: http.IncomingMessage): Promise<{ filename?: string; bytes: Uint8Array }> {
  const contentType = req.headers["content-type"] ?? ""
  const boundaryMatch = /boundary=([^;]+)/.exec(contentType)
  if (!boundaryMatch) {
    const raw = await readBody(req)
    return { bytes: raw }
  }

  const boundary = `--${boundaryMatch[1]}`
  const raw = Buffer.from(await readBody(req))
  const parts = raw.toString("binary").split(boundary)
  for (const part of parts) {
    if (!part || part === "--\r\n") continue
    const [headerRaw, bodyRaw] = part.split("\r\n\r\n")
    if (!bodyRaw) continue
    const filenameMatch = /filename="([^"]+)"/.exec(headerRaw)
    const filename = filenameMatch ? filenameMatch[1] : undefined
    const body = bodyRaw.replace(/\r\n--$/, "")
    return { filename, bytes: Buffer.from(body, "binary") }
  }

  return { bytes: new Uint8Array() }
}
