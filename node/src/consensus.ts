import type { IChainEngine, ISnapshotSyncEngine, IBlockSyncEngine } from "./chain-engine-types.ts"
import type { P2PNode } from "./p2p.ts"
import type { BftCoordinator } from "./bft-coordinator.ts"
import type { ForkCandidate } from "./fork-choice.ts"
import { shouldSwitchFork } from "./fork-choice.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import { createLogger } from "./logger.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"

/** Use the tip block's cumulativeWeight — now hash-bound so tamper-proof.
 * Falls back to verified block count if field is missing (pre-upgrade blocks).
 * Verifies chain continuity before trusting block count as weight fallback
 * to prevent attackers from inflating weight with disconnected block arrays. */
function recalcCumulativeWeight(blocks: ChainBlock[]): bigint {
  if (blocks.length === 0) return 0n
  const tip = blocks[blocks.length - 1]
  // cumulativeWeight is now bound into block hash, so it's tamper-proof
  if (tip.cumulativeWeight !== undefined) {
    let w: bigint
    try {
      w = BigInt(tip.cumulativeWeight)
    } catch {
      // Non-numeric cumulativeWeight — treat as missing
      return BigInt(tip.number) > 0n ? BigInt(tip.number) : BigInt(blocks.length)
    }
    // Sanity: reject negative weights (could come from malicious BigInt conversion)
    if (w < 0n) {
      return BigInt(tip.number) > 0n ? BigInt(tip.number) : BigInt(blocks.length)
    }
    // Sanity: cumulativeWeight should be >= tip height (at minimum 1 per block)
    const tipHeight = BigInt(tip.number)
    if (w < tipHeight && tipHeight > 0n) {
      return tipHeight // weight below height is suspicious, use safe fallback
    }
    return w
  }
  // Fallback: use tip height rather than array length. Array length could be
  // misleading if the snapshot is a partial window (blocks 500-600 = length 101
  // but actual chain weight should reflect height 600). Tip height is hash-bound
  // and thus tamper-proof.
  const tipHeight = BigInt(tip.number)
  return tipHeight > 0n ? tipHeight : BigInt(blocks.length)
}

const log = createLogger("consensus")

const MAX_CONSECUTIVE_FAILURES = 5
const RECOVERY_COOLDOWN_MS = 30_000
const MAX_DEGRADED_MS = 5 * 60 * 1000 // 5 min max in degraded before forced recovery

// Phase H7: timeout for the await on `p2p.fetchSnapshots()` inside trySync /
// forceSnapSync. Without this a slow/hung peer would never resolve and the
// `finally` block that releases syncInFlight never fires — observed 2026-04-30.
const FETCH_SNAPSHOTS_TIMEOUT_MS = 30_000

// Phase H7: hard ceiling on how long `syncInFlight` may stay true before the
// background watchdog force-releases it. Set above FETCH_SNAPSHOTS_TIMEOUT_MS
// + a tolerance for trySnapSync's per-peer fan-out so a normal slow sync
// completes naturally; only genuinely-stuck syncs trip the watchdog.
const SYNC_INFLIGHT_WATCHDOG_MS = 90_000

// Phase H15: how long without a BFT-finalized block before the fallback
// proposer fires the no-progress override. Primary fallback (+1 in rotation)
// fires at this threshold; secondary fallbacks stagger +30s per step so that
// at most one node activates per tick interval, preventing equivocation storms
// (observed 2026-05-02: all 3 nodes fired simultaneously → 3-way block split).
const NO_PROGRESS_TIMEOUT_MS = 120_000
const NO_PROGRESS_STAGGER_MS = 30_000
const NO_PROGRESS_MAX_VALIDATORS = 10

/** Race a promise against a timeout. Throws on timeout, otherwise returns the value. */
async function withSyncTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timeout after ${FETCH_SNAPSHOTS_TIMEOUT_MS}ms`)),
      FETCH_SNAPSHOTS_TIMEOUT_MS,
    )
    if (typeof timer.unref === "function") timer.unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface ConsensusConfig {
  blockTimeMs: number
  syncIntervalMs: number
  enableSnapSync?: boolean
  snapSyncThreshold?: number
  sequencerMode?: boolean
}

export type ConsensusStatus = "healthy" | "degraded" | "recovering"

export interface SnapSyncProvider {
  fetchStateSnapshot(peerUrl: string): Promise<{
    stateRoot: string
    blockHeight: string
    blockHash: string
    accounts: Array<{
      address: string
      nonce: string
      balance: string
      storageRoot: string
      codeHash: string
      storage: Array<{ slot: string; value: string }>
      code?: string
    }>
    version: number
    createdAtMs: number
    validators?: Array<{ id: string; address: string; stake: string; active: boolean }>
  } | null>
  importStateSnapshot(snapshot: unknown, expectedStateRoot?: string): Promise<{ accountsImported: number; codeImported: number; validators?: Array<{ id: string; address: string; stake: bigint; active: boolean }> }>
  setStateRoot(root: string): Promise<void>
  /** Restore governance validator set from snapshot (optional) */
  restoreGovernance?(validators: Array<{ id: string; address: string; stake: bigint; active: boolean }>): void
}

export interface SyncProgress {
  syncing: boolean
  currentHeight: bigint
  highestPeerHeight: bigint
  startingHeight: bigint
  progressPct: number // 0-100
  blocksRemaining: bigint
  blocksPerSecond: number
  estimatedSecondsLeft: number
}

export interface ConsensusMetrics {
  blocksProposed: number
  blocksAdopted: number
  proposeFailed: number
  syncAttempts: number
  syncAdoptions: number
  snapSyncs: number
  avgProposeMs: number
  avgSyncMs: number
  lastProposeMs: number
  lastSyncMs: number
  startedAtMs: number
  uptimeMs: number
}

export class ConsensusEngine {
  private readonly chain: IChainEngine
  private readonly p2p: P2PNode
  private readonly cfg: ConsensusConfig
  private readonly bft: BftCoordinator | null
  private readonly snapSync: SnapSyncProvider | null
  private proposeFailures = 0
  private syncFailures = 0
  private status: ConsensusStatus = "healthy"
  private lastRecoveryMs = 0
  private degradedSinceMs = 0
  private proposeTimer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private degradedCheckTimer: ReturnType<typeof setInterval> | null = null
  private syncInFlight = false
  // Phase H7: tracks when syncInFlight was last set to true. The watchdog
  // (started in start()) force-releases the flag if held longer than
  // SYNC_INFLIGHT_WATCHDOG_MS — mitigates the 2026-04-30 testnet stall
  // where p2p.fetchSnapshots() hung inside trySync, leaving syncInFlight
  // permanently true and blocking ALL subsequent sync attempts (periodic
  // + manual + H4-triggered + H5-triggered).
  private syncInFlightSinceMs = 0
  private syncInFlightWatchdogTimer: ReturnType<typeof setInterval> | null = null
  private proposeInFlight = false
  private lastProposedHeight: bigint | undefined = undefined
  private lastProposedBlock: any | undefined = undefined // Cached for retry on BFT timeout

  // Phase H15: tracks the last time a BFT block was finalized. If no progress
  // for NO_PROGRESS_TIMEOUT_MS, the designated proposer is likely offline and
  // we force-override the round-robin so any node can unblock the chain.
  private lastBftProgressAtMs = 0
  private noProgressWatchdogTimer: ReturnType<typeof setInterval> | null = null
  // Set to true by the watchdog; cleared by tryPropose after it issues the
  // override proposal. Signals that the normal round-robin should be bypassed.
  private noProgressProposerOverride = false
  // Phase J2.2: throttle for self-stuck-proposer forceClearRound. Without
  // this, every tick of the watchdog (NO_PROGRESS_STAGGER_MS) would clear
  // the round again, preventing prepareVotes from ever accumulating once
  // peers send fresh ones. Required spacing: ≥ NO_PROGRESS_TIMEOUT_MS.
  private lastSelfClearRoundAtMs = 0

  // Sync progress tracking
  private highestPeerHeight = 0n
  private syncStartHeight = 0n
  private syncStartMs = 0
  private lastSyncedHeight = 0n

  // Metrics tracking
  private blocksProposed = 0
  private blocksAdopted = 0
  private proposeFailed = 0
  private syncAttempts = 0
  private syncAdoptions = 0
  private snapSyncs = 0
  private totalProposeMs = 0
  private totalSyncMs = 0
  private lastProposeMs = 0
  private lastSyncMs = 0
  private startedAtMs = 0
  // Phase M1.3: track maximum observed fork-choice reorg depth for Prometheus.
  // Updated when shouldSwitchFork triggers a switch to a remote chain;
  // depth = abs(remoteHeight - localHeight) at switch time.
  private forkChoiceMaxDepth = 0

  /** Optional callback to broadcast blocks via wire protocol (TCP) */
  private readonly wireBroadcast: ((block: ChainBlock) => void) | null
  // Phase H15 stagger: local validator ID used to identify which rotation slot
  // we occupy so only the designated fallback proposer arms the override.
  private readonly nodeId: string | null

  constructor(
    chain: IChainEngine,
    p2p: P2PNode,
    cfg: ConsensusConfig,
    opts?: { bft?: BftCoordinator; snapSync?: SnapSyncProvider; wireBroadcast?: (block: ChainBlock) => void; nodeId?: string },
  ) {
    this.chain = chain
    this.p2p = p2p
    this.cfg = cfg
    this.bft = opts?.bft ?? null
    this.snapSync = opts?.snapSync ?? null
    this.wireBroadcast = opts?.wireBroadcast ?? null
    this.nodeId = opts?.nodeId ?? null
  }

  start(): void {
    this.startedAtMs = Date.now()
    this.lastBftProgressAtMs = Date.now()
    this.proposeTimer = setInterval(() => void this.tryPropose(), this.cfg.blockTimeMs)
    this.proposeTimer.unref()

    // Sequencer mode: skip sync and degraded timers — single validator produces all blocks
    if (!this.cfg.sequencerMode) {
      this.syncTimer = setInterval(() => void this.trySync(), this.cfg.syncIntervalMs)
      this.degradedCheckTimer = setInterval(() => this.checkDegradedTimeout(), 10_000)
      this.syncTimer.unref()
      this.degradedCheckTimer.unref()
      // Phase H7 watchdog: every 10s, if syncInFlight has been held for
      // longer than SYNC_INFLIGHT_WATCHDOG_MS, force-release. Without this
      // a hung await inside trySync (observed 2026-04-30 when fetchSnapshots
      // never returned) deadlocks all subsequent sync attempts forever.
      this.syncInFlightWatchdogTimer = setInterval(() => this.checkSyncInFlightWatchdog(), 10_000)
      this.syncInFlightWatchdogTimer.unref()
      // Phase H15 watchdog: if BFT is enabled but no block has been finalized
      // for NO_PROGRESS_TIMEOUT_MS, the designated fallback proposer (next in
      // rotation after the stuck proposer) arms the override so the chain can
      // unblock without an equivocation storm. Secondary fallbacks stagger
      // NO_PROGRESS_STAGGER_MS apart so only one node fires per tick.
      if (this.bft) {
        this.noProgressWatchdogTimer = setInterval(() => { void this.checkNoProgressWatchdog() }, NO_PROGRESS_STAGGER_MS)
        this.noProgressWatchdogTimer.unref()
      }
      void this.trySync()
    }
  }

  stop(): void {
    if (this.proposeTimer) { clearInterval(this.proposeTimer); this.proposeTimer = null }
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null }
    if (this.degradedCheckTimer) { clearInterval(this.degradedCheckTimer); this.degradedCheckTimer = null }
    if (this.syncInFlightWatchdogTimer) { clearInterval(this.syncInFlightWatchdogTimer); this.syncInFlightWatchdogTimer = null }
    if (this.noProgressWatchdogTimer) { clearInterval(this.noProgressWatchdogTimer); this.noProgressWatchdogTimer = null }
    this.bft?.stop()
  }

  /**
   * Phase H15 watchdog: arm noProgressProposerOverride if BFT has been silent
   * for too long, but ONLY for the designated fallback proposer (next in
   * rotation after the stuck proposer). Secondary fallbacks stagger
   * NO_PROGRESS_STAGGER_MS further to prevent multiple nodes from proposing
   * different blocks for the same height (equivocation storm, 2026-05-02).
   *
   * If nodeId is not configured, the watchdog is disabled — without it we
   * can't identify which node is the fallback and every node would override.
   */
  private async checkNoProgressWatchdog(): Promise<void> {
    if (this.noProgressProposerOverride) return
    if (this.syncInFlight) return
    if (!this.bft) return
    const elapsed = Date.now() - this.lastBftProgressAtMs
    if (elapsed <= NO_PROGRESS_TIMEOUT_MS) return

    if (!this.nodeId) {
      // Cannot determine fallback proposer identity — skip to avoid storm
      return
    }

    let currentHeight: bigint
    try {
      currentHeight = await Promise.resolve(this.chain.getHeight())
    } catch {
      return
    }
    const stuckHeight = currentHeight + 1n
    const stuckProposerId = this.chain.expectedProposer(stuckHeight)

    // Phase J2.2: when we are the stuck proposer AND we hold an active
    // round whose state is internally deadlocked (no peers responding,
    // prepareVotes stuck at 1 self-vote — 2026-05-05 testnet pattern),
    // H15b's rotation-based override does NOT cover us — peers can only
    // ATTEMPT to override but their proposes are also rejected by the
    // active round we still hold. Self-clear our round so peers' next
    // propose has somewhere to land. Throttled ≥ NO_PROGRESS_TIMEOUT_MS
    // to give peers room to deliver fresh votes between clears.
    if (stuckProposerId === this.nodeId) {
      const roundState = this.bft.getRoundState()
      if (
        roundState.active
        && Date.now() - this.lastSelfClearRoundAtMs >= NO_PROGRESS_TIMEOUT_MS
      ) {
        log.error("Phase J2.2: self-stuck proposer — force-clearing local BFT round", {
          elapsedMs: elapsed,
          stuckHeight: stuckHeight.toString(),
          activeHeight: roundState.height?.toString() ?? "<null>",
          activePhase: roundState.phase ?? "<null>",
          prepareVotes: roundState.prepareVotes,
          commitVotes: roundState.commitVotes,
        })
        this.bft.forceClearRound("h15b-self-stuck-proposer")
        this.lastSelfClearRoundAtMs = Date.now()
        // Reset progress baseline so the next tick doesn't immediately
        // re-fire on the same elapsed window. We do NOT mark progress
        // (no block was finalized); this is just throttle bookkeeping.
        this.lastBftProgressAtMs = Date.now()
      }
      return
    }

    // Below this point: someone else is the stuck proposer, original H15b
    // rotation-based override path applies. Skip if our local BFT round is
    // still active (we shouldn't propose for a height already in progress).
    if (this.bft.getRoundState().active) return

    // Find how many rotation steps ahead of the stuck proposer we are.
    // Proposer for stuckHeight+1 is primary fallback (rotationOffset=1),
    // stuckHeight+2 is secondary (rotationOffset=2), etc.
    let rotationOffset = 0
    for (let i = 1; i <= NO_PROGRESS_MAX_VALIDATORS; i++) {
      if (this.chain.expectedProposer(stuckHeight + BigInt(i)) === this.nodeId) {
        rotationOffset = i
        break
      }
    }
    if (rotationOffset === 0) return // nodeId not in active validator set

    // Primary fallback fires at base timeout; each subsequent fallback adds
    // one stagger interval so at most one node fires per tick.
    const activationThresholdMs = NO_PROGRESS_TIMEOUT_MS + (rotationOffset - 1) * NO_PROGRESS_STAGGER_MS
    if (elapsed < activationThresholdMs) return

    log.error("Phase H15: no BFT progress — enabling proposer override (fallback proposer)", {
      elapsedMs: elapsed,
      activationThresholdMs,
      rotationOffset,
      stuckHeight: stuckHeight.toString(),
      stuckProposerId,
      localNodeId: this.nodeId,
    })
    this.noProgressProposerOverride = true
  }

  /**
   * Phase H7 watchdog: force-release `syncInFlight` if held longer than
   * SYNC_INFLIGHT_WATCHDOG_MS. The flag is normally cleared in trySync's /
   * forceSnapSync's `finally`, but if the awaited p2p.fetchSnapshots()
   * hangs (peer slow, network drop), the finally never fires and EVERY
   * subsequent sync attempt short-circuits on `if (this.syncInFlight) return`.
   *
   * Releasing here is safe: the hung promise's eventual resolution will
   * race the new sync attempt, but both branches re-check `syncInFlight`
   * and the worst case is one duplicate fetch — preferable to permanent
   * deadlock.
   */
  private checkSyncInFlightWatchdog(): void {
    if (!this.syncInFlight) return
    const elapsed = Date.now() - this.syncInFlightSinceMs
    if (elapsed > SYNC_INFLIGHT_WATCHDOG_MS) {
      log.error("Phase H7: syncInFlight held too long — force-releasing", {
        elapsedMs: elapsed,
        watchdogMs: SYNC_INFLIGHT_WATCHDOG_MS,
      })
      this.syncInFlight = false
      this.syncInFlightSinceMs = 0
    }
  }

  getStatus(): { status: ConsensusStatus; proposeFailures: number; syncFailures: number } {
    return { status: this.status, proposeFailures: this.proposeFailures, syncFailures: this.syncFailures }
  }

  /**
   * Phase M1.3 — maximum observed fork-choice reorg depth for Prometheus emission.
   * Monotonic; reset only on process restart.
   */
  getForkChoiceMaxDepth(): number {
    return this.forkChoiceMaxDepth
  }

  /**
   * Phase J1.1 corner-case fix (2026-05-06) — synchronous read of the
   * sync-in-flight gate so the BFT peer-quorum-diverged callback can
   * report a definitive `false` to the coordinator's dedup logic when
   * `forceSnapSync` would no-op.
   */
  isSnapSyncInFlight(): boolean {
    return this.syncInFlight
  }

  getMetrics(): ConsensusMetrics {
    const now = Date.now()
    const proposeCount = this.blocksProposed + this.proposeFailed
    const syncCount = this.syncAttempts
    return {
      blocksProposed: this.blocksProposed,
      blocksAdopted: this.blocksAdopted,
      proposeFailed: this.proposeFailed,
      syncAttempts: this.syncAttempts,
      syncAdoptions: this.syncAdoptions,
      snapSyncs: this.snapSyncs,
      avgProposeMs: proposeCount > 0 ? Math.round(this.totalProposeMs / proposeCount) : 0,
      avgSyncMs: syncCount > 0 ? Math.round(this.totalSyncMs / syncCount) : 0,
      lastProposeMs: this.lastProposeMs,
      lastSyncMs: this.lastSyncMs,
      startedAtMs: this.startedAtMs,
      uptimeMs: this.startedAtMs > 0 ? now - this.startedAtMs : 0,
    }
  }

  async getSyncProgress(): Promise<SyncProgress> {
    const currentHeight = await Promise.resolve(this.chain.getHeight())
    const syncing = this.highestPeerHeight > currentHeight
    const blocksRemaining = syncing ? this.highestPeerHeight - currentHeight : 0n

    const totalRange = this.highestPeerHeight > this.syncStartHeight
      ? this.highestPeerHeight - this.syncStartHeight
      : 0n
    const synced = currentHeight > this.syncStartHeight
      ? currentHeight - this.syncStartHeight
      : 0n
    const progressPct = totalRange > 0n
      ? Math.min(100, Math.round(Number(synced * 10000n / totalRange)) / 100)
      : syncing ? 0 : 100

    const elapsedMs = this.syncStartMs > 0 ? Date.now() - this.syncStartMs : 0
    const elapsedSec = elapsedMs / 1000
    const blocksPerSecond = elapsedSec > 0 && synced > 0n
      ? Number(synced) / elapsedSec
      : 0
    const estimatedSecondsLeft = blocksPerSecond > 0
      ? Math.round(Number(blocksRemaining) / blocksPerSecond)
      : 0

    return {
      syncing,
      currentHeight,
      highestPeerHeight: this.highestPeerHeight,
      startingHeight: this.syncStartHeight,
      progressPct,
      blocksRemaining,
      blocksPerSecond: Math.round(blocksPerSecond * 100) / 100,
      estimatedSecondsLeft,
    }
  }

  private async tryPropose(): Promise<void> {
    if (this.proposeInFlight) return

    if (!this.cfg.sequencerMode) {
      if (this.syncInFlight) return // Don't propose while snap sync is modifying chain state
      if (this.status === "degraded") {
        return // degraded timeout handled by independent degradedCheckTimer
      }

      // Skip proposing while BFT round is active to avoid disrupting in-flight rounds
      if (this.bft) {
        const bftState = this.bft.getRoundState()
        if (bftState.active) {
          return
        }
      }

      // Wall-clock slot alignment: each proposer runs its own 3s-interval
      // timer with an independent phase, so two adjacent proposers' ticks
      // can fall ~1s apart and produce back-to-back blocks. Gate proposing
      // on the chain tip's slot — if the tip was already produced in the
      // current slot, wait for the next one. This caps the whole network
      // to one block per `blockTimeMs` regardless of per-node timer phase.
      if (this.bft) {
        try {
          const tip = await Promise.resolve(this.chain.getTip())
          if (tip) {
            const currentSlot = Math.floor(Date.now() / this.cfg.blockTimeMs)
            const tipSlot = Math.floor(tip.timestampMs / this.cfg.blockTimeMs)
            if (tipSlot >= currentSlot) {
              return // Tip is from current (or future) slot — nothing to do yet
            }
          }
        } catch {
          // Best-effort; fall through if getTip throws.
        }
      }
    }

    this.proposeInFlight = true
    const t0 = Date.now()
    try {
      // When BFT is enabled, build the block without applying it locally.
      // The proposer stays at the same height as validators until BFT finalizes.
      // This prevents the fatal height divergence (proposer at N+1, others at N)
      // that occurs when a BFT round times out after the proposer already applied.
      const deferApply = !!this.bft

      // Guard: if we already proposed this height, check BFT round state.
      // If round is active, wait. If round timed out, re-broadcast the SAME
      // block (not a new one) to avoid equivocation.
      if (deferApply && this.lastProposedHeight !== undefined) {
        const currentHeight = await Promise.resolve(this.chain.getHeight())
        if (currentHeight < this.lastProposedHeight) {
          const bftState = this.bft!.getRoundState()
          if (bftState.active) {
            return // BFT round in progress
          }
          // BFT round timed out — re-broadcast cached block + restart BFT
          if (this.lastProposedBlock) {
            log.info("re-broadcasting timed-out proposal", { height: this.lastProposedHeight.toString() })
            // Clear seenBlocks cache for this block so receiveBlock accepts it again.
            // Without this, the gossip dedup cache blocks the re-broadcast.
            this.p2p.seenBlocks?.delete?.(this.lastProposedBlock.hash)
            await this.broadcastBlock(this.lastProposedBlock)
            try { await this.bft!.startRound(this.lastProposedBlock) } catch { /* ignore */ }
          }
          return
        }
        // Height caught up — clear cached block
        this.lastProposedBlock = undefined
      }

      // Phase H15: if the no-progress watchdog armed the override flag, bypass
      // the round-robin check so we can propose even if it's not "our turn".
      // This unblocks the chain when the designated proposer is offline/stuck
      // (observed 2026-05-02: node-1 stuck at 167,200, chain dead 26h because
      // node-2/3 are proposer for heights not in their round-robin slot).
      const forcePropose = this.noProgressProposerOverride && !!this.bft && !this.bft.getRoundState().active
      if (forcePropose) {
        this.noProgressProposerOverride = false
        log.warn("Phase H15: proposer override active — proposing regardless of round-robin", {})
      }
      const block = await this.chain.proposeNextBlock(deferApply, forcePropose)
      if (!block) {
        return
      }

      this.proposeFailures = 0
      this.blocksProposed++
      if (deferApply) {
        this.lastProposedHeight = block.number
        this.lastProposedBlock = block
      }

      // Broadcast block via gossip so all peers receive it
      await this.broadcastBlock(block)

      // If BFT is enabled, start a round (non-proposers join via handleReceivedBlock)
      if (this.bft) {
        try {
          await this.bft.startRound(block)
        } catch (bftErr) {
          this.proposeFailures++
          log.warn("BFT round start failed", {
            error: String(bftErr),
            block: block.number.toString(),
            consecutive: this.proposeFailures,
          })
          if (this.proposeFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.enterDegradedMode("bft-start")
          }
        }
      }

      this.lastProposeMs = Date.now() - t0
      this.totalProposeMs += this.lastProposeMs

      if (this.status === "recovering") {
        this.status = "healthy"
        log.info("recovered from degraded mode via successful propose")
      }
    } catch (error) {
      this.proposeFailed++
      this.proposeFailures++
      this.lastProposeMs = Date.now() - t0
      this.totalProposeMs += this.lastProposeMs
      log.error("propose failed", { error: String(error), consecutive: this.proposeFailures })

      if (this.status === "recovering") {
        this.enterDegradedMode("recovery-propose")
      } else if (this.proposeFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.enterDegradedMode("propose")
      }
    } finally {
      this.proposeInFlight = false
    }
  }

  private async broadcastBlock(block: ChainBlock): Promise<void> {
    // HTTP gossip broadcast
    try {
      await this.p2p.receiveBlock(block)
    } catch (broadcastErr) {
      log.warn("block produced but HTTP broadcast failed", {
        error: String(broadcastErr),
        block: block.number.toString(),
      })
    }

    // Wire protocol TCP broadcast (if enabled)
    if (this.wireBroadcast) {
      try {
        this.wireBroadcast(block)
      } catch (wireErr) {
        log.warn("wire broadcast failed", {
          error: String(wireErr),
          block: block.number.toString(),
        })
      }
    }
  }

  /**
   * Explicitly trigger a sync attempt now (as opposed to waiting for the
   * periodic syncTimer). Use this when the caller has reason to believe the
   * local chain has diverged and wants fast recovery — e.g. BFT onFinalized
   * applyBlock failed and the node is sitting behind quorum until the next
   * interval tick. Idempotent: if a sync is already in flight, this call
   * becomes a no-op.
   */
  async requestSyncNow(): Promise<void> {
    await this.trySync()
  }

  /**
   * Phase H15: called by the BFT onFinalized handler whenever a block is
   * successfully applied. Resets the no-progress watchdog so the proposer
   * override doesn't fire spuriously during normal operation.
   */
  notifyBftProgress(): void {
    this.lastBftProgressAtMs = Date.now()
    this.noProgressProposerOverride = false
  }

  /**
   * Phase H5: Force a state-snapshot import from peers, bypassing the
   * usual gap-based heuristics. Used when the BFT layer has detected
   * persistent divergence — i.e. snap-sync wouldn't trigger via
   * `requestSyncNow` because the gap is small (a few blocks), but the
   * local trie is corrupted at-rest and incremental block replay can't
   * recover it. Equivalent in effect to today's manual leveldb rsync
   * recovery, but in-process.
   *
   * Returns true when the snapshot import succeeded and the local tip
   * advanced; false when no peer responded with a usable snapshot.
   * Idempotent: a sync already in flight short-circuits to false rather
   * than racing.
   */
  async forceSnapSync(): Promise<boolean> {
    if (!this.cfg.enableSnapSync || !this.snapSync) {
      log.warn("forceSnapSync called but snap-sync disabled or unavailable")
      return false
    }
    if (this.syncInFlight) {
      log.info("forceSnapSync skipped — sync already in flight")
      return false
    }
    this.syncInFlight = true
    this.syncInFlightSinceMs = Date.now()
    try {
      // Phase H7: timeout-wrapped fetch so a hung peer doesn't deadlock the
      // sync flag. The watchdog (checkSyncInFlightWatchdog) is the
      // belt-and-suspenders if even this throws weird.
      const snapshots = await withSyncTimeout(this.p2p.fetchSnapshots(), "forceSnapSync.fetchSnapshots")
      // Pick the snapshot with the highest tip — that's the most-advanced
      // peer's view we can trust to import. Empty/equal heights still get
      // a chance via trySnapSync's per-peer voting downstream.
      let best: { blocks: ChainBlock[] } | null = null
      let bestHeight = -1n
      for (const snap of snapshots) {
        const tip = snap.blocks?.[snap.blocks.length - 1]
        if (!tip) continue
        const h = BigInt(tip.number)
        if (h > bestHeight) {
          bestHeight = h
          best = snap
        }
      }
      if (!best) {
        log.warn("forceSnapSync: no peer snapshot available")
        return false
      }
      log.warn("forceSnapSync: starting state-snapshot import from peers", {
        bestPeerTipHeight: bestHeight.toString(),
        localHeight: (await Promise.resolve(this.chain.getHeight())).toString(),
      })
      const ok = await this.trySnapSync(best)
      log.warn("forceSnapSync: complete", {
        ok,
        localHeightAfter: (await Promise.resolve(this.chain.getHeight())).toString(),
      })
      return ok
    } finally {
      this.syncInFlight = false
      this.syncInFlightSinceMs = 0
    }
  }

  private async trySync(): Promise<void> {
    if (this.syncInFlight) return
    this.syncInFlight = true
    this.syncInFlightSinceMs = Date.now()
    const t0 = Date.now()
    this.syncAttempts++
    try {
      // Phase H7: timeout-wrapped fetch — see forceSnapSync's note.
      const snapshots = await withSyncTimeout(this.p2p.fetchSnapshots(), "trySync.fetchSnapshots")

      // Build local fork candidate
      let localHeight = await Promise.resolve(this.chain.getHeight())

      // Track sync progress: compute max peer height per sync round (allows decrease after reorgs).
      // Cap accepted heights to prevent malicious peers from reporting extreme values that
      // break the progress display (showing 0% forever).
      // - Bootstrap phase (localHeight <= 100): accept up to 10M to allow new nodes to join
      //   a long-running chain via snap sync + block replay.
      // - Steady state (localHeight > 100): cap at 10x + 1000 buffer to detect malicious peers.
      const MAX_HEIGHT_MULTIPLIER = 10n
      const MAX_HEIGHT_BUFFER = 1000n
      const BOOTSTRAP_MAX_HEIGHT = 10_000_000n
      const maxAcceptableHeight = localHeight > 100n
        ? localHeight * MAX_HEIGHT_MULTIPLIER + MAX_HEIGHT_BUFFER
        : BOOTSTRAP_MAX_HEIGHT
      let roundMaxPeerHeight = 0n
      for (const snap of snapshots) {
        if (Array.isArray(snap.blocks) && snap.blocks.length > 0) {
          const remoteTipHeight = BigInt(snap.blocks[snap.blocks.length - 1].number)
          if (remoteTipHeight > maxAcceptableHeight) {
            log.warn("sync: ignoring unreasonable peer height", {
              peerHeight: remoteTipHeight.toString(),
              maxAcceptable: maxAcceptableHeight.toString(),
              localHeight: localHeight.toString(),
            })
            continue
          }
          if (remoteTipHeight > roundMaxPeerHeight) {
            roundMaxPeerHeight = remoteTipHeight
          }
        }
      }
      if (roundMaxPeerHeight > 0n) {
        const wasCaughtUp = this.syncStartMs > 0 && localHeight >= this.highestPeerHeight
        this.highestPeerHeight = roundMaxPeerHeight
        if (roundMaxPeerHeight > localHeight) {
          // Start or restart sync tracking when node falls behind peers
          if (this.syncStartMs === 0 || wasCaughtUp) {
            this.syncStartHeight = localHeight
            this.syncStartMs = Date.now()
          }
        } else if (this.syncStartMs > 0) {
          // Reset sync tracking when caught up (so next sync episode starts fresh)
          this.syncStartMs = 0
          this.syncStartHeight = 0n
        }
      }

      const localTip = await Promise.resolve(this.chain.getTip())
      let localCandidate: ForkCandidate = {
        height: localHeight,
        tipHash: localTip?.hash ?? ("0x0" as Hex),
        bftFinalized: localTip?.bftFinalized ?? false,
        cumulativeWeight: localTip?.cumulativeWeight ?? localHeight,
        peerId: "local",
      }

      let adopted = false

      const snapshotEngine = this.chain as ISnapshotSyncEngine
      const blockEngine = this.chain as IBlockSyncEngine

      for (const snapshot of snapshots) {
        if (!Array.isArray(snapshot.blocks) || snapshot.blocks.length === 0) continue

        // Build remote fork candidate from snapshot tip
        // Never trust remote-provided cumulativeWeight or bftFinalized
        const remoteTip = snapshot.blocks[snapshot.blocks.length - 1]
        const remoteCandidate: ForkCandidate = {
          height: BigInt(remoteTip.number),
          tipHash: remoteTip.hash,
          bftFinalized: false,
          cumulativeWeight: recalcCumulativeWeight(snapshot.blocks),
          peerId: "remote",
        }

        // Use fork choice rule to decide whether to switch
        const switchResult = shouldSwitchFork(localCandidate, remoteCandidate)
        if (!switchResult) continue

        // Phase M1.3: record max observed reorg depth for Prometheus.
        // Use absolute height delta at switch time as the depth proxy.
        const depthDelta = Number(
          remoteCandidate.height > localHeight
            ? remoteCandidate.height - localHeight
            : localHeight - remoteCandidate.height,
        )
        if (depthDelta > this.forkChoiceMaxDepth) {
          this.forkChoiceMaxDepth = depthDelta
        }

        log.info("fork choice: switching to remote chain", {
          reason: switchResult.reason,
          localHeight: localHeight.toString(),
          remoteHeight: remoteCandidate.height.toString(),
        })

        const snapshotStartHeight = snapshot.blocks[0] ? BigInt(snapshot.blocks[0].number) : 0n
        const localHasContinuity = localHeight === 0n || localHeight >= snapshotStartHeight - 1n

        // Check if snap sync should be used (large gap)
        const gap = remoteCandidate.height - localHeight
        let snapAttemptedForGap = false
        if (
          this.cfg.enableSnapSync &&
          this.snapSync &&
          gap > BigInt(this.cfg.snapSyncThreshold ?? 100)
        ) {
          log.info("snap sync path selected", {
            localHeight: localHeight.toString(),
            remoteHeight: remoteCandidate.height.toString(),
            gap: gap.toString(),
            threshold: String(this.cfg.snapSyncThreshold ?? 100),
          })
          snapAttemptedForGap = true
          const ok = await this.trySnapSync(snapshot)
          log.info("snap sync attempt finished", {
            ok,
            localHeightAfter: String(await Promise.resolve(this.chain.getHeight())),
          })
          if (ok) {
            this.blocksAdopted++
            const newHeight = await Promise.resolve(this.chain.getHeight())
            const newTip = await Promise.resolve(this.chain.getTip())
            localCandidate = {
              height: newHeight,
              tipHash: newTip?.hash ?? ("0x0" as Hex),
              bftFinalized: newTip?.bftFinalized ?? false,
              cumulativeWeight: newTip?.cumulativeWeight ?? newHeight,
              peerId: "local",
            }
            localHeight = newHeight
          }
          adopted = adopted || ok
          if (ok) {
            continue
          }
          if (!localHasContinuity) {
            // No block-level continuity window: must wait for a successful snap sync.
            continue
          }
          log.warn("snap sync failed on large gap, falling back to block-level replay", {
            localHeight: localHeight.toString(),
            snapshotStart: snapshotStartHeight.toString(),
            remoteHeight: remoteCandidate.height.toString(),
          })
        }

        if (!localHasContinuity && this.cfg.enableSnapSync && this.snapSync) {
          if (snapAttemptedForGap) {
            continue
          }
          log.warn("chain snapshot window insufficient, falling back to snap sync", {
            localHeight: localHeight.toString(),
            snapshotStart: snapshotStartHeight.toString(),
          })
          const snapOk = await this.trySnapSync(snapshot)
          if (snapOk) {
            this.blocksAdopted++
            const newHeight = await Promise.resolve(this.chain.getHeight())
            const newTip = await Promise.resolve(this.chain.getTip())
            localCandidate = {
              height: newHeight,
              tipHash: newTip?.hash ?? ("0x0" as Hex),
              bftFinalized: newTip?.bftFinalized ?? false,
              cumulativeWeight: newTip?.cumulativeWeight ?? newHeight,
              peerId: "local",
            }
            localHeight = newHeight
          }
          adopted = adopted || snapOk
          continue
        }

        let ok = false
        if (typeof snapshotEngine.makeSnapshot === "function") {
          ok = await snapshotEngine.maybeAdoptSnapshot(snapshot)
        } else if (typeof blockEngine.maybeAdoptSnapshot === "function") {
          ok = await blockEngine.maybeAdoptSnapshot(snapshot.blocks)
        }
        log.info("block-level snapshot adoption result", {
          ok,
          localHeightBefore: localHeight.toString(),
          localHeightAfter: String(await Promise.resolve(this.chain.getHeight())),
          snapshotStart: String(snapshot.blocks[0]?.number ?? "n/a"),
          snapshotEnd: String(snapshot.blocks[snapshot.blocks.length - 1]?.number ?? "n/a"),
        })
        if (ok) {
          this.blocksAdopted++
          // Refresh local state after successful adoption to prevent stale comparisons
          const newHeight = await Promise.resolve(this.chain.getHeight())
          const newTip = await Promise.resolve(this.chain.getTip())
          localCandidate = {
            height: newHeight,
            tipHash: newTip?.hash ?? ("0x0" as Hex),
            bftFinalized: newTip?.bftFinalized ?? false,
            cumulativeWeight: newTip?.cumulativeWeight ?? newHeight,
            peerId: "local",
          }
          localHeight = newHeight
        }
        adopted = adopted || ok
      }

      if (adopted) {
        this.syncAdoptions++
        const height = await Promise.resolve(this.chain.getHeight())
        log.info("sync adopted new tip", { height: height.toString() })
      }

      this.lastSyncMs = Date.now() - t0
      this.totalSyncMs += this.lastSyncMs
      this.syncFailures = 0
      if (this.status === "degraded" || this.status === "recovering") {
        this.tryRecover()
      }
    } catch (error) {
      this.lastSyncMs = Date.now() - t0
      this.totalSyncMs += this.lastSyncMs
      this.syncFailures++
      log.error("sync failed", { error: String(error), consecutive: this.syncFailures })

      if (this.syncFailures >= MAX_CONSECUTIVE_FAILURES && this.status === "healthy") {
        this.enterDegradedMode("sync")
      }
    } finally {
      this.syncInFlight = false
      this.syncInFlightSinceMs = 0
    }
  }

  private async trySnapSync(snapshot: { blocks: ChainBlock[] }): Promise<boolean> {
    if (!this.snapSync) return false

    const tip = snapshot.blocks[snapshot.blocks.length - 1]
    if (!tip) return false

    try {
      const peers = this.p2p.discovery.getActivePeers()

      // Vote loop: fetch snapshots in parallel, collect stateRoots + validatorsHash
      type SnapResult = Awaited<ReturnType<SnapSyncProvider["fetchStateSnapshot"]>>
      const snapshotCache = new Map<string, SnapResult>() // peerUrl → snapshot
      // Map voteKey → { count, peer, stateRoot, validatorsHash }
      // Use a safe separator ("|") to avoid ambiguity if stateRoot contains ":"
      const peerStateRoots = new Map<string, { count: number; peer: string; stateRoot: string; validatorsHash: string }>()

      const fetchResults = await Promise.allSettled(
        peers.map(async (peer) => {
          const snap = await this.snapSync!.fetchStateSnapshot(peer.url)
          return { url: peer.url, snap }
        }),
      )
      // On an actively-producing chain, state snapshots can be AHEAD of the chain
      // snapshot's tip by the time they return (fetch is ~100ms, block time is 3s).
      // Rejecting anything that doesn't exactly match tip.hash made bootstrap
      // impossible on a live testnet. We now accept any snapshot whose height
      // is at or ahead of the chain snapshot tip, and let peer-to-peer voting
      // on (stateRoot, validators) reject outliers.
      const tipHeight = BigInt(tip.number)
      for (const result of fetchResults) {
        if (result.status !== "fulfilled") continue
        const { url, snap } = result.value
        snapshotCache.set(url, snap)
        if (!snap) continue
        let snapHeight: bigint
        try {
          snapHeight = BigInt(snap.blockHeight)
        } catch {
          continue
        }
        // Reject snapshots from peers that are behind us (they can't help bootstrap).
        if (snapHeight < tipHeight) continue
        const vHash = hashValidators(snap.validators)
        // Group by (stateRoot, validatorsHash, blockHash). blockHash disambiguates
        // responses from peers that happen to be at different heights — they
        // shouldn't get aggregated into the same vote.
        const voteKey = `${snap.blockHash}|${snap.stateRoot}|${vHash}`
        const existing = peerStateRoots.get(voteKey)
        peerStateRoots.set(voteKey, {
          count: (existing?.count ?? 0) + 1,
          peer: url,
          stateRoot: snap.stateRoot,
          validatorsHash: vHash,
        })
      }

      // Require stateRoot+validatorsHash consensus across responding peers.
      // On an actively-producing chain, peer stateRoots differ by 1-2 blocks at any given moment.
      // We accept the most-voted root as long as it has strict majority (>50%) of responses,
      // OR all responding peers agree (common when responses are tightly clustered in time).
      // This enables bootstrap when only a subset of peers respond within the request window.
      const totalResponding = [...peerStateRoots.values()].reduce((sum, v) => sum + v.count, 0)
      let trustedStateRoot: string | null = null
      let trustedValidatorsHash: string | null = null

      if (peerStateRoots.size === 1) {
        // All responding peers agree on a single stateRoot — accept it.
        const entry = [...peerStateRoots.values()][0]
        trustedStateRoot = entry.stateRoot
        trustedValidatorsHash = entry.validatorsHash
        if (totalResponding === 0) {
          log.warn("snap sync: no peer responded with stateRoot")
          return false
        }
      } else if (peerStateRoots.size > 1) {
        let maxCount = 0
        for (const [, info] of peerStateRoots) {
          if (info.count > maxCount) {
            maxCount = info.count
            trustedStateRoot = info.stateRoot
            trustedValidatorsHash = info.validatorsHash
          }
        }
        // Require strict majority (>50%) of responding peers.
        if (maxCount * 2 <= totalResponding) {
          log.warn("snap sync: no stateRoot majority among peers, aborting (fail-closed)", {
            maxVotes: maxCount,
            respondingPeers: totalResponding,
            uniqueRoots: peerStateRoots.size,
          })
          return false
        }
      }

      if (!trustedStateRoot) {
        log.warn("snap sync: no peer provided valid state snapshot")
        return false
      }

      // State import FIRST (before blocks) to prevent half-corruption:
      // if state fails for all peers, we skip block import entirely.
      let stateImported = false
      let importedStateHeight: bigint = 0n
      for (const peer of peers) {
        try {
          const stateSnap = snapshotCache.get(peer.url) ?? null
          if (!stateSnap) continue

          // Ignore peers behind the chain tip — their state can't bootstrap us.
          let snapHeight: bigint
          try {
            snapHeight = BigInt(stateSnap.blockHeight)
          } catch {
            continue
          }
          if (snapHeight < tipHeight) continue

          if (stateSnap.stateRoot !== trustedStateRoot) {
            log.warn("snap sync: peer stateRoot disagrees with consensus", {
              peer: peer.url,
              peerRoot: stateSnap.stateRoot,
              trustedRoot: trustedStateRoot,
            })
            continue
          }

          // Validate governance hash BEFORE importing state + setting root.
          // This prevents the half-imported state where stateRoot is set but
          // governance is inconsistent (if hash fails, no state mutation occurs).
          if (this.snapSync.restoreGovernance && trustedValidatorsHash) {
            const importedVHash = hashValidators(stateSnap.validators)
            if (importedVHash !== trustedValidatorsHash) {
              log.error("snap sync: validators hash mismatch — skipping peer (pre-import check)", {
                peer: peer.url,
                peerHash: importedVHash,
                trustedHash: trustedValidatorsHash,
              })
              continue // try next peer without touching state
            }
          }

          const importResult = await this.snapSync.importStateSnapshot(stateSnap, trustedStateRoot)
          await this.snapSync.setStateRoot(trustedStateRoot)

          // Restore governance (hash already validated above)
          if (importResult.validators && this.snapSync.restoreGovernance) {
            this.snapSync.restoreGovernance(importResult.validators)
            log.info("governance state restored from snapshot", { validators: importResult.validators.length })
          }

          stateImported = true
          importedStateHeight = snapHeight
          log.info("snap sync state imported", {
            accounts: stateSnap.accounts.length,
            blockHeight: stateSnap.blockHeight,
          })
          break
        } catch (peerErr) {
          log.warn("snap sync state import failed for peer, trying next", { peer: peer.url, error: String(peerErr) })
        }
      }

      if (!stateImported) {
        log.error("snap sync: state import failed for all peers, skipping block import")
        return false
      }

      // Import blocks only after state is confirmed
      let blocksImported = false
      const bsEngine = this.chain as IBlockSyncEngine
      const ssEngine = this.chain as ISnapshotSyncEngine
      if (typeof bsEngine.importSnapSyncBlocks === "function") {
        blocksImported = await bsEngine.importSnapSyncBlocks(snapshot.blocks)
      } else if (typeof ssEngine.makeSnapshot === "function") {
        blocksImported = await ssEngine.maybeAdoptSnapshot({ blocks: snapshot.blocks, updatedAtMs: Date.now() })
      }

      if (!blocksImported) {
        log.warn("snap sync: block adoption failed after state import")
        return false
      }

      this.snapSyncs++
      log.info("snap sync complete")
      return true
    } catch (error) {
      log.warn("snap sync failed, falling back to block replay", { error: String(error) })
    }
    return false
  }

  private enterDegradedMode(source: string): void {
    this.status = "degraded"
    this.degradedSinceMs = Date.now()
    log.warn("entering degraded mode", { source, proposeFailures: this.proposeFailures, syncFailures: this.syncFailures })
  }

  private tryRecover(): void {
    const now = Date.now()
    if (now - this.lastRecoveryMs < RECOVERY_COOLDOWN_MS) return

    this.lastRecoveryMs = now
    this.status = "recovering"
    this.proposeFailures = 0
    this.syncFailures = 0
    log.info("entering recovery mode, next propose will determine health")
  }

  /** Force recovery if stuck in degraded for too long (called from tryPropose) */
  private checkDegradedTimeout(): void {
    if (this.status !== "degraded") return
    const now = Date.now()
    if (this.degradedSinceMs > 0 && now - this.degradedSinceMs > MAX_DEGRADED_MS) {
      log.warn("degraded timeout exceeded, forcing recovery attempt")
      this.lastRecoveryMs = 0 // clear cooldown to allow immediate recovery
      this.tryRecover()
    }
  }
}

/** Hash validator set for cross-peer consensus comparison.
 *  Sort by id, serialize as JSON, then keccak256. Returns empty-hash for undefined/empty. */
function hashValidators(validators: Array<{ id: string; address: string; stake: string; active: boolean }> | undefined): string {
  if (!validators || validators.length === 0) return "0x"
  const sorted = [...validators].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // Explicit property order for deterministic cross-node JSON serialization
  const json = JSON.stringify(sorted.map(v => ({ active: v.active, address: v.address, id: v.id, stake: v.stake })))
  return keccak256Hex(Buffer.from(json, "utf8"))
}
