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

import type { IpfsBlockstore } from "./ipfs-blockstore.ts"
import type { DhtNetwork } from "./dht-network.ts"
import type { PushToKResult } from "./coc-ipfs-wiring.ts"
import type { CidString } from "./ipfs-types.ts"
import { createLogger } from "./logger.ts"

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

export interface IpfsRepairDeps {
  /** Source of pinned CIDs to inspect. */
  blockstore: Pick<IpfsBlockstore, "listPins" | "get">
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
  }

  constructor(deps: IpfsRepairDeps) {
    this.deps = {
      blockstore: deps.blockstore,
      dht: deps.dht,
      pushToK: deps.pushToK,
      tickIntervalMs: deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
      minReplicas: deps.minReplicas ?? DEFAULT_MIN_REPLICAS,
      repairBatchSize: deps.repairBatchSize ?? DEFAULT_REPAIR_BATCH_SIZE,
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
      return this.getMetrics()
    } finally {
      this.running = false
    }
  }
}
