import { CID } from "multiformats/cid"
import type { Blockstore } from "interface-blockstore"
import type { IpfsBlockstore } from "./ipfs-blockstore.ts"

/**
 * Bridges COC's string-keyed {@link IpfsBlockstore} to the
 * `interface-blockstore` `Blockstore` that `ipfs-unixfs-importer` and
 * `ipfs-unixfs-exporter` expect.
 *
 * Only `get` / `put` / `has` are used by the importer/exporter path
 * (`ReadableStorage = Pick<Blockstore,'get'>`, `WritableStorage =
 * Pick<Blockstore,'put'>`); the remaining `Store` members are provided as
 * thin shims so the adapter is a structural superset and can be passed
 * wherever a `Blockstore` is wanted.
 *
 * The CID <-> string conversion is the only translation — block bytes pass
 * through verbatim. `get` routes through COC's `store.get`, which
 * transparently peer-fetches absent blocks (C1.3) and content-verifies
 * them, so directory-DAG navigation works even over a partially-local DAG.
 *
 * DoS guard: a per-adapter `get` budget. A single HTTP request constructs
 * one adapter, so capping `get` calls bounds the block fan-out a malicious
 * (deep / wide / diamond) DAG can trigger. Construct a fresh adapter per
 * request to reset the budget.
 */
export interface BlockstoreAdapterLimits {
  /** Max number of `get` calls over this adapter's lifetime. */
  maxBlockReads?: number
  /**
   * #8: when true, local-store misses do NOT trigger
   * {@link IpfsBlockstore.get}'s `fetchRemote` hook. Pass `true` on every
   * public-facing read path (anonymous gateway / cat / ls / get) so an
   * attacker cannot weaponize the node as a DHT-reflection / SSRF
   * amplifier via arbitrary unknown CIDs. Admin-authorized callers
   * (loopback / X-COC-IPFS-Admin-Token) leave it false / undefined so
   * operator tooling keeps the transparent peer-fetch behaviour.
   */
  localOnly?: boolean
}

/**
 * Thrown by {@link InterfaceBlockstoreAdapter.get} when the per-adapter
 * `maxBlockReads` budget is exhausted. A distinct type so callers can tell
 * a resource-limit abort apart from an ordinary "not a UnixFS node" miss
 * and surface it as a real error instead of silently degrading.
 */
export class BlockstoreReadBudgetError extends Error {
  constructor(budget: number) {
    super(`blockstore read budget exceeded (${budget})`)
    this.name = "BlockstoreReadBudgetError"
  }
}

export class InterfaceBlockstoreAdapter implements Pick<Blockstore, "get" | "put" | "has"> {
  private readonly inner: IpfsBlockstore
  private readonly maxBlockReads: number
  private readonly localOnly: boolean
  private blockReads = 0
  /**
   * #14 (audit follow-up): every CID we successfully `put` through the
   * adapter is recorded here so the caller can roll back a partial
   * import. The importer streams blocks to the blockstore as it builds
   * the DAG; when it throws mid-way (oversized inputs, malformed
   * candidates, etc.) the already-written blocks would otherwise sit
   * unpinned on disk until the next `repo/gc` cycle. handleAddDirectory
   * iterates this set inside its `catch` to issue best-effort
   * `removeBlock` calls and reclaim the space immediately.
   */
  private readonly _putCids = new Set<string>()

  constructor(inner: IpfsBlockstore, limits?: BlockstoreAdapterLimits) {
    this.inner = inner
    this.maxBlockReads = limits?.maxBlockReads ?? Number.POSITIVE_INFINITY
    this.localOnly = limits?.localOnly ?? false
  }

  /** Number of `get` calls served so far — exposed for tests / metrics. */
  get reads(): number {
    return this.blockReads
  }

  /** Whether this adapter suppresses remote-fetch on local miss. */
  get isLocalOnly(): boolean {
    return this.localOnly
  }

  /** #14: CIDs successfully put through this adapter — for partial-import rollback. */
  get putCids(): ReadonlySet<string> {
    return this._putCids
  }

  async get(cid: CID): Promise<Uint8Array> {
    if (++this.blockReads > this.maxBlockReads) {
      throw new BlockstoreReadBudgetError(this.maxBlockReads)
    }
    const block = await this.inner.get(cid.toString(), { localOnly: this.localOnly })
    return block.bytes
  }

  async put(cid: CID, bytes: Uint8Array): Promise<CID> {
    await this.inner.put({ cid: cid.toString(), bytes })
    // Record only after the inner put succeeded — a failed put didn't
    // actually allocate disk, so the rollback set must not include it.
    this._putCids.add(cid.toString())
    return cid
  }

  async has(cid: CID): Promise<boolean> {
    return this.inner.has(cid.toString())
  }

  async *putMany(
    source: AsyncIterable<{ cid: CID; block: Uint8Array }> | Iterable<{ cid: CID; block: Uint8Array }>,
  ): AsyncGenerator<CID> {
    for await (const { cid, block } of source) {
      yield await this.put(cid, block)
    }
  }

  async *getMany(
    source: AsyncIterable<CID> | Iterable<CID>,
  ): AsyncGenerator<{ cid: CID; block: Uint8Array }> {
    for await (const cid of source) {
      yield { cid, block: await this.get(cid) }
    }
  }

  // GC is owned by COC's IpfsBlockstore (pins.json + gc()); deletion through
  // the adapter is a no-op so the importer/exporter can never drop blocks.
  async delete(_cid: CID): Promise<void> {
    /* no-op — COC GC owns deletion */
  }

  async *deleteMany(source: AsyncIterable<CID> | Iterable<CID>): AsyncGenerator<CID> {
    for await (const cid of source) {
      yield cid
    }
  }

  // The exporter never enumerates the whole store during a path walk; only
  // implemented so the adapter satisfies the full Blockstore shape.
  async *getAll(): AsyncGenerator<{ cid: CID; block: Uint8Array }> {
    throw new Error("getAll is not supported by InterfaceBlockstoreAdapter")
  }
}
