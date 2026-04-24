import { mkdir, readFile, writeFile, access, readdir, stat as statFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { IpfsBlock, CidString } from "./ipfs-types.ts"

const BLOCKS_DIR = "blocks"
const PINS_FILE = "pins.json"

/**
 * Optional hook contract for integrating the blockstore with P2P routing
 * (Phase C1.3 / C1.4).
 *
 *  - `fetchRemote(cid)`: called by `get()` when the CID is absent locally.
 *    Should return the block's bytes on success, or `null` to let the
 *    ENOENT propagate. Implementations typically consult DHT provider
 *    records (`DhtNetwork.findProviders`) and then pull via
 *    `WireConnectionManager.requestBlockFromAny`. Returned bytes are
 *    written to the local blockstore before the get result is returned,
 *    so the next access is free.
 *
 *  - `onPut(cid, bytes, opts)`: fired immediately after a successful
 *    write. `opts.source` distinguishes a caller-driven write
 *    (`"local"` — user PUT, push RPC) from a cache-back of a remotely
 *    fetched block (`"remote-cache"` — fallback in `get()`). C1.4 uses
 *    this to push to K nearest peers on local PUT only — firing on
 *    remote-cache would cause every fetch to amplify into K pushes,
 *    cascading into a traffic storm. Both sources self-announce into
 *    the DHT (provider discovery), which is cheap. Handlers must not
 *    throw: errors are swallowed so the put itself still reports
 *    success to the caller.
 */
export interface IpfsBlockstoreHooks {
  fetchRemote?: (cid: CidString) => Promise<Uint8Array | null>
  onPut?: (cid: CidString, bytes: Uint8Array, opts?: OnPutOptions) => void
}

export interface OnPutOptions {
  /** How the bytes arrived. Default "local" (caller-driven write). */
  source?: "local" | "remote-cache"
}

export class IpfsBlockstore {
  private readonly root: string
  private hooks: IpfsBlockstoreHooks = {}

  constructor(root: string, hooks?: IpfsBlockstoreHooks) {
    this.root = root
    if (hooks) this.hooks = hooks
  }

  /**
   * Inject routing hooks after construction. Useful when the DHT and wire
   * layer aren't ready yet at blockstore init time (the glue module
   * `coc-ipfs-wiring.ts` wires them up once all three are running).
   * Passing a partial object only overrides the provided keys.
   */
  setHooks(hooks: IpfsBlockstoreHooks): void {
    this.hooks = { ...this.hooks, ...hooks }
  }

  async init(): Promise<void> {
    await mkdir(this.blocksDir(), { recursive: true })
  }

  async put(block: IpfsBlock): Promise<void> {
    return this.doPut(block, "local")
  }

  /**
   * Store a block delivered by an inbound push RPC (wire-server's
   * `onBlockRequest` push path). Identical on-disk effect to `put()`
   * but tags the onPut hook with `source: "remote-cache"` so the C1.4
   * pushToK replicator doesn't cascade the push forward — the
   * upstream PUT already fanned the block out to its own K nearest
   * peers, and re-fanning would cause exponential traffic growth.
   *
   * The local node still self-announces as a provider (C1.3 snowball),
   * so discovery-based diffusion continues to work.
   */
  async putFromPeer(block: IpfsBlock): Promise<void> {
    return this.doPut(block, "remote-cache")
  }

  /**
   * Internal write path used by `put()`, `putFromPeer()`, and the
   * remote-cache path inside `get()`. Keeping the hook invocation here
   * gives us one chokepoint for the `source` discriminator.
   */
  private async doPut(block: IpfsBlock, source: "local" | "remote-cache"): Promise<void> {
    await this.init()
    const path = this.blockPath(block.cid)
    await writeFile(path, block.bytes)
    // Fire the onPut hook (C1.4 wires it to DHT announce + pushToK). Guard
    // against handler throws — a post-write side effect failure must not
    // surface to callers who just saw their put succeed to disk.
    if (this.hooks.onPut) {
      try {
        this.hooks.onPut(block.cid, block.bytes, { source })
      } catch {
        /* swallow; wiring layer logs its own errors */
      }
    }
  }

  async get(cid: CidString): Promise<IpfsBlock> {
    const path = this.blockPath(cid)
    try {
      const bytes = await readFile(path)
      return { cid, bytes }
    } catch (err) {
      // Only treat ENOENT as a cue for remote fetch. Other errors
      // (permissions, disk) should surface unmodified — a misconfigured
      // data dir shouldn't silently masquerade as a DHT lookup miss.
      if (!isNotFound(err)) throw err
      if (!this.hooks.fetchRemote) throw err

      // Ask providers. Returning null ⇒ no peer had the CID → let the
      // original ENOENT propagate so the caller gets the "block missing"
      // signal it already knows how to handle.
      let remote: Uint8Array | null = null
      try {
        remote = await this.hooks.fetchRemote(cid)
      } catch {
        remote = null
      }
      if (!remote) throw err

      // Cache locally BEFORE returning so the second GET is a hot path.
      // Routed through the private doPut with source="remote-cache" so the
      // onPut hook still fires for DHT self-announce (cheap, desirable —
      // see the snowball-provider note in C1.3) but so that C1.4's
      // pushToK can suppress the K-way replication push that a true
      // local PUT would trigger. Without this discriminator, every
      // fetch would fan out into K pushes and cascade into a storm.
      try {
        await this.doPut({ cid, bytes: remote }, "remote-cache")
      } catch {
        // Caching is best-effort. If write fails we still return the
        // fetched bytes so the caller's GET succeeds; the next GET
        // will re-fetch.
      }
      return { cid, bytes: remote }
    }
  }

  async has(cid: CidString): Promise<boolean> {
    try {
      await access(this.blockPath(cid))
      return true
    } catch {
      return false
    }
  }

  async pin(cid: CidString): Promise<void> {
    const pins = await this.readPins()
    pins.add(cid)
    await this.writePins(pins)
  }

  async listPins(): Promise<CidString[]> {
    const pins = await this.readPins()
    return [...pins]
  }

  async listBlocks(): Promise<CidString[]> {
    await this.init()
    const entries = await readdir(this.blocksDir())
    return entries
  }

  async stat(): Promise<{ numBlocks: number; repoSize: number; pins: number }> {
    await this.init()
    const entries = await readdir(this.blocksDir())
    let size = 0
    // Stat files in batches to avoid file descriptor exhaustion on large repos
    const BATCH_SIZE = 64
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map((entry) => {
          // Use join directly to avoid blockPath validation on readdir output
          // (readdir returns sanitized filesystem entries, not user input)
          const filePath = join(this.blocksDir(), entry)
          return statFile(filePath).catch(() => null)
        }),
      )
      for (const info of results) {
        if (info) size += info.size
      }
    }
    const pins = await this.readPins()
    return { numBlocks: entries.length, repoSize: size, pins: pins.size }
  }

  private blocksDir(): string {
    return join(this.root, BLOCKS_DIR)
  }

  private blockPath(cid: CidString): string {
    // Reject path traversal: CID must not contain directory separators, "..", or null bytes
    if (/[\/\\]|\.\./.test(cid) || cid.includes("\0")) {
      throw new Error(`invalid CID: ${cid}`)
    }
    return join(this.blocksDir(), cid)
  }

  private pinsPath(): string {
    return join(this.root, PINS_FILE)
  }

  private async readPins(): Promise<Set<CidString>> {
    try {
      const raw = await readFile(this.pinsPath(), "utf-8")
      const parsed = JSON.parse(raw) as { pins?: unknown }
      // Validate pins array structure to prevent prototype pollution or type confusion
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.pins)) {
        return new Set()
      }
      // Only accept string CIDs, reject objects/arrays that could carry __proto__
      const safe = parsed.pins.filter((p: unknown) => typeof p === "string")
      return new Set(safe as CidString[])
    } catch {
      return new Set()
    }
  }

  private async writePins(pins: Set<CidString>): Promise<void> {
    await mkdir(this.root, { recursive: true })
    // Atomic write: write to temp file then rename to prevent corruption on crash
    const tmpPath = this.pinsPath() + ".tmp"
    await writeFile(tmpPath, JSON.stringify({ pins: [...pins] }, null, 2))
    await rename(tmpPath, this.pinsPath())
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: string }).code === "ENOENT"
}
