/**
 * CidRegistryReader — Phase C2.2 challenge-target source.
 *
 * The PoSe challenger needs a universe of CIDs against which to issue
 * Storage challenges. Before this module existed, it picked from the
 * local agent's `file-meta.json`, which gave each agent a biased view
 * (challenges against CIDs only that agent had pre-pinned) and only
 * worked in single-node devnets.
 *
 * This module instead pulls the universe from the on-chain
 * `CidRegistry.sol` `CidRegistered(bytes32 indexed cidHash, string cid,
 * address indexed registrant)` event log. All agents indexing the same
 * chain end up with the same candidate pool — permissionless-but-
 * globally-consistent, matching the pool nodes actually replicate via
 * C1.4's push-to-K.
 *
 * Because CidRegistry is permissionless, the pool contains CIDs nobody
 * actually stores ("monopoly CIDs" registered for gas-wasting attacks,
 * or simply files that were garbage-collected off every node). Without
 * filtering, a random pick would skew storage challenges into guaranteed
 * failures and falsely tank honest nodes' storageBps. The solution: ask
 * the DHT `findProviders(cid)` before committing — if at least one peer
 * currently advertises the CID, it's a legitimate challenge target.
 * Retry up to `maxPickRetries` times before giving up, which protects
 * against transient DHT churn without letting the attacker dominate
 * the challenger's attention.
 *
 * The returned target also carries `merkleRoot` and `chunkCount`,
 * derived by walking the DAG through the same C1.3 fetch-or-serve
 * blockstore path the receipt handler uses. If the local node can't
 * resolve the CID at all (every provider is down), `pickRandomChallengeTarget`
 * treats that pick as another "monopoly CID" and tries the next one.
 */

import { buildMerkleRoot, hashLeaf } from "../../node/src/ipfs-merkle.ts"
import type { IpfsBlockstore } from "../../node/src/ipfs-blockstore.ts"
import { resolveChunks } from "../../node/src/ipfs-unixfs.ts"
import { createLogger } from "../../node/src/logger.ts"

const log = createLogger("cid-registry-reader")

/** Minimal shape of a ethers.js-style CidRegistry contract binding. */
export interface CidRegistryContractLike {
  filters: {
    CidRegistered(): unknown
  }
  queryFilter(
    filter: unknown,
    fromBlock?: number | string,
    toBlock?: number | string,
  ): Promise<CidRegisteredLogLike[]>
}

/** Shape of a `CidRegistered` event log after ethers.js parses it. */
export interface CidRegisteredLogLike {
  args?:
    | { cid?: string; cidHash?: string }
    | unknown[]
}

/**
 * Minimal DHT surface we need. Intentionally returns `string[] | Promise<string[]>`
 * so both in-process callers (node/src/dht-network.ts findProviders is sync)
 * and HTTP-proxy callers (the agent process talks to the node via
 * `coc_dhtFindProviders`) can satisfy it without adapters.
 */
export interface DhtLike {
  findProviders(cid: string, maxK?: number): string[] | Promise<string[]>
}

export interface ChallengeTarget {
  cid: string
  chunkIndex: number
  merkleRoot: string
  /** Byte length of the specific chunk at `chunkIndex`. */
  chunkSize: number
  /** Total chunk count in the file — useful for observability. */
  chunkCount: number
}

export interface CidRegistryReaderConfig {
  blockstore: IpfsBlockstore
  dht: DhtLike
  /**
   * Source of CidRegistered event logs. Production wiring passes an
   * ethers.js Contract; tests pass a canned list. We keep it async so
   * real contract reads don't have to synchronously yield a Promise
   * every refresh.
   */
  contractReader: () => Promise<string[]>
  /**
   * Ceiling on how many times `pickRandomChallengeTarget` will retry when
   * it picks a monopoly CID (no providers / unresolvable). Default 10 —
   * enough to tolerate 50% junk in the registry without dragging the
   * challenger into multi-second latency.
   */
  maxPickRetries?: number
  /** Max providers to require before accepting a CID. Default 1. */
  minProviders?: number
  /** For testing: inject a deterministic RNG. Default Math.random. */
  rng?: () => number
}

const DEFAULT_MAX_PICK_RETRIES = 10
const DEFAULT_MIN_PROVIDERS = 1

interface CachedFileMeta {
  merkleRoot: string
  chunkSizes: number[]
}

export class CidRegistryReader {
  private readonly cfg: Required<Omit<CidRegistryReaderConfig, "rng">> & { rng: () => number }
  private cids: string[] = []
  private readonly metaCache = new Map<string, CachedFileMeta>()

  constructor(cfg: CidRegistryReaderConfig) {
    this.cfg = {
      blockstore: cfg.blockstore,
      dht: cfg.dht,
      contractReader: cfg.contractReader,
      maxPickRetries: cfg.maxPickRetries ?? DEFAULT_MAX_PICK_RETRIES,
      minProviders: cfg.minProviders ?? DEFAULT_MIN_PROVIDERS,
      rng: cfg.rng ?? Math.random,
    }
  }

  /**
   * Refresh the in-memory CID pool from the contract. Call on agent
   * epoch boundary — fresh CIDs registered since the last refresh
   * become challengeable, and disappeared providers get the lazy
   * filter treatment at pick time. De-dupes and lowercases for
   * consistent comparisons.
   */
  async refresh(): Promise<void> {
    try {
      const list = await this.cfg.contractReader()
      const unique = new Set<string>()
      for (const c of list) {
        if (typeof c === "string" && c.length > 0) unique.add(c)
      }
      this.cids = [...unique]
      log.debug("refreshed CID pool", { count: this.cids.length })
    } catch (err) {
      log.warn("CidRegistry refresh failed, keeping prior pool", {
        error: String(err),
        priorCount: this.cids.length,
      })
    }
  }

  /** Current pool size — used by tests and diagnostics. */
  size(): number {
    return this.cids.length
  }

  /**
   * Pick a random registered CID that at least one peer advertises, and
   * resolve its Merkle metadata so a challenge can lock in a specific
   * chunk. Returns `null` if the pool is empty or every sampled pick
   * is unverifiable within `maxPickRetries`.
   */
  async pickRandomChallengeTarget(): Promise<ChallengeTarget | null> {
    if (this.cids.length === 0) return null

    // Iterate a shuffled prefix rather than a truly random dart throw so
    // repeated monopoly-CID rejects don't revisit the same index. Cap at
    // maxPickRetries so a hostile registry (99% squatted CIDs) still
    // returns promptly.
    const order = shuffle(this.cids.slice(), this.cfg.rng)
    const budget = Math.min(this.cfg.maxPickRetries, order.length)

    for (let i = 0; i < budget; i++) {
      const cid = order[i]
      const providers = await Promise.resolve(this.cfg.dht.findProviders(cid, 3))
      if (providers.length < this.cfg.minProviders) {
        log.debug("skipping CID without providers", { cid, providers: providers.length })
        continue
      }
      const meta = await this.resolveMeta(cid)
      if (!meta || meta.chunkSizes.length === 0) {
        log.debug("skipping CID that couldn't be resolved via blockstore", { cid })
        continue
      }
      const chunkIndex = Math.floor(this.cfg.rng() * meta.chunkSizes.length)
      return {
        cid,
        chunkIndex,
        merkleRoot: meta.merkleRoot,
        chunkSize: meta.chunkSizes[chunkIndex],
        chunkCount: meta.chunkSizes.length,
      }
    }

    log.warn("pickRandomChallengeTarget exhausted retries with no viable CID", {
      poolSize: this.cids.length,
      retries: budget,
    })
    return null
  }

  private async resolveMeta(cid: string): Promise<CachedFileMeta | null> {
    const cached = this.metaCache.get(cid)
    if (cached) return cached
    try {
      const hashes: string[] = []
      const sizes: number[] = []
      for await (const chunk of resolveChunks(this.cfg.blockstore, cid)) {
        hashes.push(hashLeaf(chunk.bytes))
        sizes.push(chunk.bytes.length)
      }
      if (hashes.length === 0) return null
      const meta: CachedFileMeta = {
        merkleRoot: buildMerkleRoot(hashes),
        chunkSizes: sizes,
      }
      this.metaCache.set(cid, meta)
      return meta
    } catch (err) {
      log.debug("resolveMeta threw", { cid, error: String(err) })
      return null
    }
  }
}

/**
 * Build an event-log reader function bound to a contract. Extracts
 * CID strings from every historical `CidRegistered` event; the shape
 * of `args` varies between ethers.js v6 (object with named keys) and
 * older test fixtures (array), so we handle both.
 */
export function makeCidRegistryEventReader(
  contract: CidRegistryContractLike,
  opts?: { blockChunk?: number; latestBlock?: () => Promise<number> },
): () => Promise<string[]> {
  // COC nodes cap eth_getLogs at 10 000 blocks per call, so a naive
  // `0..latest` scan fails once the chain passes 10 000 blocks. Chunk
  // the scan into windows and concat; each window still only returns
  // the contract's own CidRegistered events so the total bandwidth
  // is unchanged — just spread across more RPC round trips.
  const blockChunk = Math.max(100, opts?.blockChunk ?? 9000)
  return async () => {
    const getLatest = opts?.latestBlock
    let latest: number | "latest" = "latest"
    if (getLatest) {
      try { latest = await getLatest() } catch { latest = "latest" }
    }
    if (typeof latest === "number") {
      const out: string[] = []
      for (let from = 0; from <= latest; from += blockChunk) {
        const to = Math.min(latest, from + blockChunk - 1)
        const events = await contract.queryFilter(contract.filters.CidRegistered(), from, to)
        for (const event of events) {
          const cid = extractCid(event)
          if (cid) out.push(cid)
        }
      }
      return out
    }
    // Fallback (tests / small chains) — single call.
    const events = await contract.queryFilter(contract.filters.CidRegistered(), 0, "latest")
    const out: string[] = []
    for (const event of events) {
      const cid = extractCid(event)
      if (cid) out.push(cid)
    }
    return out
  }
}

function extractCid(log: CidRegisteredLogLike): string | null {
  if (!log.args) return null
  if (Array.isArray(log.args)) {
    // ethers.js v5 style: [cidHash, cid, registrant]
    const raw = log.args[1]
    return typeof raw === "string" ? raw : null
  }
  const raw = (log.args as { cid?: unknown }).cid
  return typeof raw === "string" ? raw : null
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  // Fisher-Yates in place — O(n) but we only care about the first
  // `maxPickRetries` entries so we could bail early. Keep it simple:
  // full shuffle keeps the code obvious and bounds at typical registry
  // scales (thousands of CIDs) are negligible.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}
