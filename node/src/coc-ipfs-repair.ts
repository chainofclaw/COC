/**
 * Phase C3.3 — IPFS repair loop.
 *
 * Periodically sweeps the local blockstore's pin set, asks the DHT how
 * many peers currently claim to hold each CID, and if that count is
 * below `minReplicas` (default 2, same threshold the HTTP PUT handler
 * uses for its `X-COC-Replicas-Warning` header), calls `pushToK` to
 * top the replica count back up.
 *
 * This is the "self-healing" half of the Phase C design: C3.1 reports
 * under-replication at PUT time so operators see it early; C3.2 keeps
 * existing provider records alive across the 24 h TTL; C3.3 actively
 * fixes the replica count when peers churn and a CID falls below the
 * floor. The three together turn the network from "whoever PUT it,
 * holds it" into "the network keeps ≥ K copies as long as any node
 * still holds one."
 *
 * Kept as a plain class rather than a service so it can be new'd up
 * once in `index.ts` and stopped cleanly on node shutdown. The timer
 * is unref'd — a quiet repair loop never keeps the process alive on
 * its own.
 */

import { createRequire } from "node:module"
import { CID } from "multiformats/cid"
import type { IpfsBlockstore } from "./ipfs-blockstore.ts"
import type { DhtNetwork } from "./dht-network.ts"
import type { PushToKResult } from "./coc-ipfs-wiring.ts"
import type { CidString } from "./ipfs-types.ts"
import { decodeManifest, ErasureError, type ErasureManifest } from "./ipfs-erasure.ts"
import { createLogger } from "./logger.ts"

// Native binding required for parity reconstruction. Loaded the same way
// as in ipfs-erasure.ts.
const require = createRequire(import.meta.url)
const ReedSolomon = require("@ronomon/reed-solomon") as {
  create(k: number, m: number): unknown
  encode(
    context: unknown,
    sources: number,
    targets: number,
    buffer: Buffer,
    bufferOffset: number,
    bufferSize: number,
    parity: Buffer,
    parityOffset: number,
    paritySize: number,
    callback: (err: Error | null) => void,
  ): void
}

const CODEC_DAG_CBOR = 0x71

const log = createLogger("coc-ipfs-repair")

// Default sweep cadence. 10 min matches the plan's §C3.3 spec — short
// enough that a peer crash is repaired within one interval, long enough
// that the scan cost on a large blockstore (~100 k pins at 1 ms each
// per-CID DHT lookup is under 2 min, comfortably inside a tick) is
// amortized. Configurable via the constructor for tests.
const DEFAULT_TICK_INTERVAL_MS = 10 * 60 * 1000
// Minimum replica count before we trigger repair. Deliberately matches
// the HTTP `X-COC-Replicas-Warning` floor from C3.1 so operator
// thresholds stay consistent across the stack.
const DEFAULT_MIN_REPLICAS = 2
// Cap how many CIDs we repair per tick. A single long tick that tried
// to repair everything at once would flood the wire with push RPCs;
// the cap limits the outgoing burst. Remainder gets picked up on the
// next tick — repair converges in ceil(total / batch) ticks.
const DEFAULT_REPAIR_BATCH_SIZE = 50
// Phase Q.5: per-tick manifest batch. Manifest repair is much heavier than
// raw CID push (parse + walk + RS reconstruction per stripe), so we cap
// it lower than the plain repair batch. 20 manifests/tick × 4 stripes ×
// ~30 ms RS reconstruction = ~2.4 s of wall time, comfortably inside the
// 10-min tick window. Adjusts up cleanly as encoding speed improves.
const DEFAULT_ERASURE_MANIFEST_BATCH_SIZE = 20

export interface IpfsRepairDeps {
  /** Source of pinned CIDs to inspect. */
  blockstore: Pick<IpfsBlockstore, "listPins" | "get" | "has" | "put" | "pin">
  /** DHT we query for current replica counts (via findProviders). */
  dht: Pick<DhtNetwork, "findProviders">
  /** Push helper supplied by coc-ipfs-wiring. Repair calls this for each under-replicated CID. */
  pushToK: (cid: string, bytes: Uint8Array) => Promise<PushToKResult>
  /** Tick interval in ms. Default 10 min. */
  tickIntervalMs?: number
  /** Minimum replica floor before repair triggers. Default 2. */
  minReplicas?: number
  /** Max CIDs repaired per tick. Default 50. */
  repairBatchSize?: number
  /**
   * Phase Q.5: max erasure manifests inspected per tick. Manifests have
   * higher per-item cost than plain CIDs (parse + walk every stripe + RS
   * reconstruction), so we throttle them separately. Default 20.
   */
  erasureManifestBatchSize?: number
}

export interface IpfsRepairMetrics {
  /** Total repair ticks that have executed since start. */
  ticks: number
  /** Total CIDs inspected across all ticks. */
  cidsInspected: number
  /** Total CIDs found under-replicated. */
  underReplicatedFound: number
  /** Total pushToK invocations kicked off. */
  repairsAttempted: number
  /** pushToK calls that hit at least one peer. */
  repairsSucceeded: number
  /** pushToK calls where every target peer failed. */
  repairsFailed: number
  /** Phase Q.5: erasure manifests inspected (across all ticks). */
  erasureManifestsScanned: number
  /** Stripes that had at least one missing shard reconstructed. */
  erasureStripesRepaired: number
  /** Individual data + parity shards regenerated via RS arithmetic. */
  erasureShardsReconstructed: number
  /** Stripes skipped because too many shards were missing to recover. */
  erasureStripesSkippedInsufficient: number
  /** Manifest fetches/parses that failed (counted as warnings, not aborts). */
  erasureManifestParseFailed: number
}

/**
 * Start the repair loop with `start()`; stop cleanly with `stop()`.
 * A single instance handles one blockstore. Runs `runOnce()` on a
 * timer; `runOnce()` is exposed publicly so tests can drive it
 * deterministically.
 */
export class IpfsRepairLoop {
  private readonly deps: Required<
    Pick<IpfsRepairDeps, "blockstore" | "dht" | "pushToK">
  > & {
    tickIntervalMs: number
    minReplicas: number
    repairBatchSize: number
    erasureManifestBatchSize: number
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private running = false
  private metrics: IpfsRepairMetrics = {
    ticks: 0,
    cidsInspected: 0,
    underReplicatedFound: 0,
    repairsAttempted: 0,
    repairsSucceeded: 0,
    repairsFailed: 0,
    erasureManifestsScanned: 0,
    erasureStripesRepaired: 0,
    erasureShardsReconstructed: 0,
    erasureStripesSkippedInsufficient: 0,
    erasureManifestParseFailed: 0,
  }

  constructor(deps: IpfsRepairDeps) {
    this.deps = {
      blockstore: deps.blockstore,
      dht: deps.dht,
      pushToK: deps.pushToK,
      tickIntervalMs: deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
      minReplicas: deps.minReplicas ?? DEFAULT_MIN_REPLICAS,
      repairBatchSize: deps.repairBatchSize ?? DEFAULT_REPAIR_BATCH_SIZE,
      erasureManifestBatchSize: deps.erasureManifestBatchSize ?? DEFAULT_ERASURE_MANIFEST_BATCH_SIZE,
    }
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        log.warn("repair tick failed", { error: String(err) })
      })
    }, this.deps.tickIntervalMs)
    this.timer.unref?.()
    log.info("repair loop started", {
      tickIntervalMs: this.deps.tickIntervalMs,
      minReplicas: this.deps.minReplicas,
      repairBatchSize: this.deps.repairBatchSize,
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getMetrics(): IpfsRepairMetrics {
    return { ...this.metrics }
  }

  /**
   * One repair pass. Public so tests can drive it without waiting
   * for the timer.
   *
   * Pass semantics:
   *  1. Pull the current pin list from the local blockstore.
   *  2. For each CID, ask the DHT how many peers claim to hold it.
   *  3. Collect CIDs with fewer than `minReplicas` claimants — these
   *     are "under-replicated" and need repair.
   *  4. Up to `repairBatchSize` CIDs: load local bytes, call pushToK
   *     to top the count back up.
   *
   * Tolerant of individual failures: a CID whose bytes are missing
   * (rare; indicates disk corruption or a pin-without-put race)
   * logs and is skipped rather than aborting the tick.
   *
   * `findProviders` counts include the local node's own entry (from
   * the C3.2 reannounce loop), so the effective threshold against
   * peer claimants is `minReplicas - 1` in normal operation. This
   * matches C3.1's PUT-time warning semantics: a lone claimant
   * (just us) counts as under-replicated.
   */
  async runOnce(): Promise<IpfsRepairMetrics> {
    if (this.stopped || this.running) return this.getMetrics()
    this.running = true
    try {
      this.metrics.ticks++
      const pins = await this.deps.blockstore.listPins()
      this.metrics.cidsInspected += pins.length

      // Step 1: collect under-replicated CIDs.
      const underReplicated: string[] = []
      for (const cid of pins) {
        // maxK=minReplicas so we return early once we know the count is
        // at least at floor. Saves iterating 64 provider entries when
        // only 2 matter.
        const providers = this.deps.dht.findProviders(cid, this.deps.minReplicas)
        if (providers.length < this.deps.minReplicas) {
          underReplicated.push(cid)
        }
      }
      this.metrics.underReplicatedFound += underReplicated.length

      if (underReplicated.length === 0) {
        log.debug("repair tick clean", { pinsChecked: pins.length })
        return this.getMetrics()
      }

      const batch = underReplicated.slice(0, this.deps.repairBatchSize)
      log.info("repair tick repairing", {
        pinsChecked: pins.length,
        underReplicated: underReplicated.length,
        repairing: batch.length,
      })

      // Step 2: top up each under-replicated CID via pushToK.
      for (const cid of batch) {
        this.metrics.repairsAttempted++
        try {
          const block = await this.deps.blockstore.get(cid as CidString)
          const result = await this.deps.pushToK(cid, block.bytes)
          if (result.succeeded.length > 0) {
            this.metrics.repairsSucceeded++
          } else {
            this.metrics.repairsFailed++
          }
        } catch (err) {
          log.warn("repair push failed for cid", { cid, error: String(err) })
          this.metrics.repairsFailed++
        }
      }

      // Step 3 (Phase Q.5): walk pinned erasure manifests and try to
      // restore any missing shards. We re-scan `pins` rather than the
      // deduped batch above because the under-replicated raw-shard repair
      // is independent of stripe-level erasure repair.
      await this.runErasureTick(pins)

      return this.getMetrics()
    } finally {
      this.running = false
    }
  }

  /**
   * Phase Q.5: scan the pin set for erasure manifest CIDs (dag-cbor
   * codec) and reconstruct any missing shards via RS arithmetic.
   *
   * For each manifest:
   *  1. Fetch + parse the manifest. Non-manifest dag-cbor blocks are
   *     skipped silently (not every dag-cbor pin is ours; safe default).
   *  2. For every stripe, count missing data + missing parity shards
   *     locally (`store.has`).
   *  3. If `missingData + missingParity > 0` and the count of available
   *     shards is ≥ N, regenerate the missing slots via the RS encoder
   *     and re-pin them locally + push-to-K so peers see the repair.
   *  4. If fewer than N shards survive, the stripe is unrecoverable —
   *     skip + bump the `erasureStripesSkippedInsufficient` counter.
   *
   * Network fetches are intentionally NOT used here for v1 — `store.has`
   * is local-only. If a peer holds a shard we don't, the regular
   * `store.get` pulls it on demand via the existing fetchRemote hook,
   * so we're focused on the harder case where the shard is genuinely
   * lost from the swarm and must be reconstructed from parity.
   */
  private async runErasureTick(pins: string[]): Promise<void> {
    // Filter pin set to dag-cbor CIDs (cheap codec inspection — no I/O).
    const candidateManifests: string[] = []
    for (const cid of pins) {
      try {
        if (CID.parse(cid).code === CODEC_DAG_CBOR) candidateManifests.push(cid)
      } catch {
        // Malformed pin — already logged elsewhere; skip silently here.
      }
    }
    if (candidateManifests.length === 0) return

    const batch = candidateManifests.slice(0, this.deps.erasureManifestBatchSize)
    for (const manifestCid of batch) {
      let manifest: ErasureManifest
      try {
        const block = await this.deps.blockstore.get(manifestCid as CidString)
        manifest = decodeManifest(block.bytes)
      } catch (err) {
        if (err instanceof ErasureError && err.code === "unsupported_manifest") {
          // Not one of ours (e.g. a future v2 manifest, or an arbitrary
          // dag-cbor block). Don't count as a parse failure.
          continue
        }
        log.debug("manifest parse skipped", { cid: manifestCid, error: String(err) })
        this.metrics.erasureManifestParseFailed++
        continue
      }
      this.metrics.erasureManifestsScanned++
      await this.repairManifest(manifest)
    }
  }

  private async repairManifest(manifest: ErasureManifest): Promise<void> {
    const { n, m, shardSize, stripes } = manifest
    const ctx = ReedSolomon.create(n, m)

    for (let s = 0; s < stripes.length; s++) {
      const stripe = stripes[s]

      // Probe local availability for every shard in this stripe.
      const dataPresent = await Promise.all(stripe.data.map((cid) => this.deps.blockstore.has(cid as CidString)))
      const parityPresent = await Promise.all(stripe.parity.map((cid) => this.deps.blockstore.has(cid as CidString)))

      const missingDataIdx: number[] = []
      const missingParityIdx: number[] = []
      for (let i = 0; i < n; i++) if (!dataPresent[i]) missingDataIdx.push(i)
      for (let j = 0; j < m; j++) if (!parityPresent[j]) missingParityIdx.push(j)

      if (missingDataIdx.length === 0 && missingParityIdx.length === 0) continue
      const presentCount = dataPresent.filter(Boolean).length + parityPresent.filter(Boolean).length
      if (presentCount < n) {
        log.warn("erasure stripe unrecoverable", {
          manifestStripe: s,
          present: presentCount,
          n,
          missingData: missingDataIdx.length,
          missingParity: missingParityIdx.length,
        })
        this.metrics.erasureStripesSkippedInsufficient++
        continue
      }

      // Build the working buffers: load every present shard into the
      // right slot, leave missing slots zero-filled. The RS encoder
      // fills targets in-place from the sources we mark.
      const stripeBuffer = Buffer.alloc(n * shardSize)
      const stripeParity = Buffer.alloc(m * shardSize)
      let sources = 0
      let dataTargets = 0
      let parityTargets = 0
      try {
        for (let i = 0; i < n; i++) {
          if (dataPresent[i]) {
            const block = await this.deps.blockstore.get(stripe.data[i] as CidString)
            if (block.bytes.byteLength !== shardSize) throw new Error(`data shard ${i} wrong size`)
            stripeBuffer.set(block.bytes, i * shardSize)
            sources |= 1 << i
          } else {
            dataTargets |= 1 << i
          }
        }
        for (let j = 0; j < m; j++) {
          if (parityPresent[j]) {
            const block = await this.deps.blockstore.get(stripe.parity[j] as CidString)
            if (block.bytes.byteLength !== shardSize) throw new Error(`parity shard ${j} wrong size`)
            stripeParity.set(block.bytes, j * shardSize)
            sources |= 1 << (n + j)
          } else {
            parityTargets |= 1 << (n + j)
          }
        }
      } catch (err) {
        log.warn("erasure repair shard load failed", { manifestStripe: s, error: String(err) })
        continue
      }

      const targets = dataTargets | parityTargets
      if (targets === 0) continue

      try {
        await new Promise<void>((resolve, reject) => {
          ReedSolomon.encode(
            ctx,
            sources,
            targets,
            stripeBuffer,
            0,
            n * shardSize,
            stripeParity,
            0,
            m * shardSize,
            (err) => err ? reject(err) : resolve(),
          )
        })
      } catch (err) {
        log.warn("erasure RS reconstruct failed", { manifestStripe: s, error: String(err) })
        continue
      }

      // Persist + republish the regenerated shards. Each block goes
      // through the standard put path so onPut fires push-to-K + DHT
      // self-announce — peers learn we're holding the shard again.
      let reconstructedThisStripe = 0
      for (const i of missingDataIdx) {
        const cid = stripe.data[i] as CidString
        const bytes = Uint8Array.prototype.slice.call(stripeBuffer.subarray(i * shardSize, (i + 1) * shardSize))
        try {
          await this.deps.blockstore.put({ cid, bytes })
          await this.deps.blockstore.pin(cid)
          reconstructedThisStripe++
        } catch (err) {
          log.warn("erasure shard write-back failed", { cid, error: String(err) })
        }
      }
      for (const j of missingParityIdx) {
        const cid = stripe.parity[j] as CidString
        const bytes = Uint8Array.prototype.slice.call(stripeParity.subarray(j * shardSize, (j + 1) * shardSize))
        try {
          await this.deps.blockstore.put({ cid, bytes })
          await this.deps.blockstore.pin(cid)
          reconstructedThisStripe++
        } catch (err) {
          log.warn("erasure shard write-back failed", { cid, error: String(err) })
        }
      }

      if (reconstructedThisStripe > 0) {
        this.metrics.erasureStripesRepaired++
        this.metrics.erasureShardsReconstructed += reconstructedThisStripe
        log.info("erasure stripe repaired", {
          stripe: s,
          reconstructed: reconstructedThisStripe,
          missingData: missingDataIdx.length,
          missingParity: missingParityIdx.length,
        })
      }
    }
  }
}
