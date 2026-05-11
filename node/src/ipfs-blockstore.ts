import { mkdir, readFile, writeFile, access, readdir, stat as statFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { IpfsBlock, CidString } from "./ipfs-types.ts"

const BLOCKS_DIR = "blocks"
const PINS_FILE = "pins.json"
// Phase S1: when an LRU evict pass runs, drop oldest non-pinned entries until
// total bytes is at most this fraction of maxBytes. Hysteresis vs. evicting
// exactly to maxBytes keeps us from re-evicting on every subsequent put.
const EVICT_TARGET_FRACTION = 0.9

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
  /**
   * How the bytes arrived. Default "local" (caller-driven write).
   *
   * - `"local"` — local PUT; wiring fires per-CID push-to-K via onPut.
   * - `"remote-cache"` — bytes arrived from a peer push (or remote
   *   fetch cache-back); wiring skips push-to-K to avoid cascading.
   * - `"local-stripe-deferred"` (Phase Q.6) — local PUT but the caller
   *   will fire a stripe-aware batch push afterwards. Wiring still
   *   self-announces + gossips the CID, but skips the per-CID push so
   *   the batch helper can choose distinct peers across shards in the
   *   same stripe instead of letting each shard pick independently.
   */
  source?: "local" | "remote-cache" | "local-stripe-deferred"
}

/**
 * Phase S1 — optional storage cap.
 *
 * `maxBytes` (default undefined): if set, the blockstore enforces a soft
 * cap by LRU-evicting non-pinned blocks once the on-disk total exceeds it.
 * Evictions trim back to {@link EVICT_TARGET_FRACTION} of the cap to avoid
 * thrashing on each subsequent put. Pinned CIDs (`pins.json`) are immune.
 *
 * Light-mode peers (`COC_NODE_MODE=light`) supply `maxBytes` to keep the
 * blockstore inside a tmpfs/quota envelope; archive nodes leave it
 * unbounded.
 */
export interface IpfsBlockstoreOpts {
  maxBytes?: number
}

interface BlockMeta {
  size: number
  accessSeq: number
}

export class IpfsBlockstore {
  private readonly root: string
  private hooks: IpfsBlockstoreHooks = {}
  private readonly maxBytes: number | undefined
  // Tracks per-CID size and last-access ordinal. Populated lazily on first
  // init() when maxBytes is set; left empty otherwise so unbounded-mode adds
  // zero memory overhead beyond the existing path.
  //
  // accessSeq is a monotonic counter, not a wall-clock time, because two
  // operations within the same millisecond can otherwise tie and be evicted
  // in arbitrary order.
  private readonly meta = new Map<CidString, BlockMeta>()
  private currentBytes = 0
  private accessSeqCounter = 0
  private metaLoaded = false
  // Serializes the read-modify-write cycle on pins.json. Two concurrent
  // pin() calls would otherwise:
  //   (a) both write to the same `pins.json.tmp` then race the rename —
  //       the second rename hits ENOENT because the first already moved
  //       the tmp file → HTTP 500 surfaces to the caller.
  //   (b) lost-update each other's added CID, because both read the same
  //       on-disk snapshot before either write lands.
  // Chaining writes through this promise gives every pin() a single
  // serialized critical section.
  private pinsLock: Promise<unknown> = Promise.resolve()
  private pinsTmpCounter = 0

  constructor(root: string, hooks?: IpfsBlockstoreHooks, opts?: IpfsBlockstoreOpts) {
    this.root = root
    if (hooks) this.hooks = hooks
    this.maxBytes = opts?.maxBytes
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
    if (this.maxBytes !== undefined && !this.metaLoaded) {
      await this.loadMetaFromDisk()
      this.metaLoaded = true
    }
  }

  /**
   * Phase S1 — populate the in-memory access map by walking the blocks
   * directory once at startup. Sets accessMs to "now" for everything we
   * find so that on-disk inventory inherited from a previous run will
   * sort by put order from this point forward (close enough for the
   * first eviction round; subsequent gets/puts refine the order).
   *
   * Skipped entirely when maxBytes is unset to keep the unbounded path
   * zero-cost.
   */
  private async loadMetaFromDisk(): Promise<void> {
    const dir = this.blocksDir()
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    const BATCH_SIZE = 64
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(batch.map(async (entry) => {
        try {
          const s = await statFile(join(dir, entry))
          return { cid: entry as CidString, size: s.size }
        } catch {
          return null
        }
      }))
      for (const r of results) {
        if (!r) continue
        // Inherited blocks all share the same baseline ordinal. They're
        // older than anything written by this process, so the relative
        // ordering between them doesn't matter — fresh puts will outrank.
        this.meta.set(r.cid, { size: r.size, accessSeq: this.accessSeqCounter })
        this.currentBytes += r.size
      }
    }
    this.accessSeqCounter++
  }

  async put(block: IpfsBlock, opts?: { deferStripePush?: boolean }): Promise<void> {
    return this.doPut(block, opts?.deferStripePush ? "local-stripe-deferred" : "local")
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
  private async doPut(block: IpfsBlock, source: "local" | "remote-cache" | "local-stripe-deferred"): Promise<void> {
    await this.init()
    const path = this.blockPath(block.cid)
    await writeFile(path, block.bytes)

    // Phase S1: track size + access time for LRU when maxBytes is set.
    // The unbounded path leaves meta empty so the existing zero-overhead
    // behaviour is preserved.
    if (this.maxBytes !== undefined) {
      const newSize = block.bytes.length
      const prev = this.meta.get(block.cid)
      if (prev) {
        // Replacing an existing block: adjust currentBytes by the size delta.
        this.currentBytes += newSize - prev.size
      } else {
        this.currentBytes += newSize
      }
      this.meta.set(block.cid, { size: newSize, accessSeq: ++this.accessSeqCounter })
      await this.evictIfNeeded()
    }

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

  /**
   * Phase S1 — drop oldest non-pinned entries until total size is at most
   * EVICT_TARGET_FRACTION × maxBytes. No-op when under the cap or when the
   * blockstore is in unbounded mode.
   *
   * Caller must already hold the maxBytes guard; we re-check here so we
   * stay safe if the method is invoked from a future code path that
   * doesn't.
   */
  private async evictIfNeeded(): Promise<void> {
    if (this.maxBytes === undefined) return
    if (this.currentBytes <= this.maxBytes) return

    const pins = await this.readPins()
    const target = this.maxBytes * EVICT_TARGET_FRACTION
    // Sort by access time ascending (oldest first). One-shot snapshot —
    // we don't expect concurrent mutation during the await chain.
    const candidates = [...this.meta.entries()].sort((a, b) => a[1].accessSeq - b[1].accessSeq)

    for (const [cid, info] of candidates) {
      if (this.currentBytes <= target) break
      if (pins.has(cid)) continue
      try {
        await unlink(this.blockPath(cid))
      } catch {
        // File already gone or unlink raced — drop from in-memory state
        // either way so we don't keep retrying it.
      }
      this.meta.delete(cid)
      this.currentBytes -= info.size
    }
  }

  async get(cid: CidString): Promise<IpfsBlock> {
    const path = this.blockPath(cid)
    try {
      const bytes = await readFile(path)
      // Phase S1: refresh LRU access time on local hit so subsequent
      // eviction passes treat this block as recently-used. Skipped in
      // unbounded mode to keep zero overhead.
      if (this.maxBytes !== undefined) {
        const prev = this.meta.get(cid)
        if (prev) {
          this.meta.set(cid, { ...prev, accessSeq: ++this.accessSeqCounter })
        }
      }
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
    const next = this.pinsLock.then(async () => {
      const pins = await this.readPins()
      pins.add(cid)
      await this.writePins(pins)
    })
    this.pinsLock = next.catch(() => {})
    await next
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
    // Atomic write: write to a per-call unique temp file then rename. The
    // unique suffix is defence-in-depth against any path that bypasses
    // pinsLock (e.g. multiple IpfsBlockstore instances sharing the same
    // root, or future call sites that mutate pins.json directly).
    const tmpPath = `${this.pinsPath()}.${process.pid}.${++this.pinsTmpCounter}.tmp`
    await writeFile(tmpPath, JSON.stringify({ pins: [...pins] }, null, 2))
    await rename(tmpPath, this.pinsPath())
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: string }).code === "ENOENT"
}
