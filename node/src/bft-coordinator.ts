/**
 * BFT Coordinator
 *
 * Bridges BFT round logic with the consensus engine and P2P layer.
 * Manages round lifecycle: start round → collect votes → finalize.
 */

import { BftRound, EquivocationDetector } from "./bft.ts"
import type { BftMessage, BftRoundConfig, EquivocationEvidence } from "./bft.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import type { NodeSigner, SignatureVerifier } from "./crypto/signer.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("bft-coordinator")

const DEFAULT_PREPARE_TIMEOUT_MS = 2_000
const DEFAULT_COMMIT_TIMEOUT_MS = 2_000

export interface BftCoordinatorConfig {
  localId: string
  validators: Array<{ id: string; stake: bigint }>
  prepareTimeoutMs?: number
  commitTimeoutMs?: number
  /** Callback to broadcast a BFT message to peers */
  broadcastMessage: (msg: BftMessage) => Promise<void>
  /** Callback when a block is BFT-finalized */
  onFinalized: (block: ChainBlock) => Promise<void>
  /** Callback when equivocation is detected */
  onEquivocation?: (evidence: EquivocationEvidence) => void
  /** Node identity signer for signing BFT messages */
  signer?: NodeSigner
  /** Signature verifier for validating BFT messages */
  verifier?: SignatureVerifier
  /**
   * Speculatively execute `block` against the node's current state and return
   * the post-execution stateRoot. Called before emitting our prepare vote so
   * that the vote commits to a (blockHash, stateRoot) pair we can locally
   * reproduce — downstream BFT quorum then guarantees all finalizing
   * validators agreed on the same post-execution state.
   *
   * When omitted, BFT falls back to the legacy hash-only quorum behavior.
   * When the callback throws or returns undefined, the validator abstains
   * from voting this round (round will time out and a new proposer will try).
   */
  computeLocalStateRoot?: (block: ChainBlock) => Promise<Hex | undefined>
}

/**
 * Coordinates BFT rounds across the consensus lifecycle.
 */
export class BftCoordinator {
  private readonly cfg: BftCoordinatorConfig
  private activeRound: BftRound | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private commitRetryTimer: ReturnType<typeof setInterval> | null = null
  private lingerTimer: ReturnType<typeof setInterval> | null = null
  private pendingMessages: BftMessage[] = []
  private deferredBlock: ChainBlock | null = null
  private lastFinalizedHeight: bigint = 0n
  private lastFinalizedAtMs: number = Date.now()
  private warnedNoVerifier = false
  private livenessWatchdogTimer: ReturnType<typeof setInterval> | null = null
  readonly equivocationDetector = new EquivocationDetector()

  constructor(cfg: BftCoordinatorConfig) {
    this.cfg = cfg
    // Liveness watchdog: if no block finalizes for LIVENESS_TIMEOUT_MS while
    // we have an active round, the BFT state is likely deadlocked at a phase
    // mismatch (observed 2026-04-26: node-1 timed out in commit, node-3 in
    // prepare, node-2 retried propose forever — restart of node-2 was
    // required to recover). Force-resetting our local state mimics a
    // restart in-process, letting fresh proposals start clean.
    const LIVENESS_TIMEOUT_MS = 5 * 60 * 1000
    this.livenessWatchdogTimer = setInterval(() => {
      if (!this.activeRound) return
      const elapsedMs = Date.now() - this.lastFinalizedAtMs
      if (elapsedMs > LIVENESS_TIMEOUT_MS) {
        log.error("BFT liveness watchdog: forcing round + pendingMessages reset after stall", {
          elapsedMs,
          activeHeight: this.activeRound.state.height.toString(),
          activePhase: this.activeRound.state.phase,
          pendingCount: this.pendingMessages.length,
        })
        this.clearRound()
        this.pendingMessages.length = 0
        this.deferredBlock = null
        // Reset the timer baseline so we don't log on every tick after reset
        this.lastFinalizedAtMs = Date.now()
      }
    }, 30_000)
    if (this.livenessWatchdogTimer && typeof this.livenessWatchdogTimer.unref === "function") {
      this.livenessWatchdogTimer.unref()
    }
  }

  /**
   * Stop the coordinator: cancel all active timers so the process can exit cleanly.
   */
  stop(): void {
    this.clearRound()
    this.stopLinger()
    if (this.livenessWatchdogTimer) {
      clearInterval(this.livenessWatchdogTimer)
      this.livenessWatchdogTimer = null
    }
    this.pendingMessages.length = 0
    this.deferredBlock = null
  }

  /**
   * Start a new BFT round for a proposed block.
   */
  async startRound(block: ChainBlock): Promise<void> {
    // Auto-clear stale rounds in terminal state before evaluating defer logic
    if (this.activeRound) {
      const phase = this.activeRound.state.phase
      if (phase === "finalized" || phase === "failed") {
        this.clearRound()
      }
    }

    // Defer new block if an active round has voting progress (avoid killing in-flight rounds)
    if (this.activeRound) {
      const phase = this.activeRound.state.phase
      const hasProgress = this.activeRound.state.prepareVotes.size > 0
        || this.activeRound.state.commitVotes.size > 0
      if ((phase === "prepare" || phase === "commit") && hasProgress) {
        if (this.deferredBlock && this.deferredBlock.number < block.number) {
          log.warn("BFT overwriting deferred block (newer block arrived)", {
            droppedHeight: this.deferredBlock.number.toString(),
            newHeight: block.number.toString(),
          })
        }
        this.deferredBlock = block
        log.info("BFT deferring startRound (active round has progress)", {
          deferredHeight: block.number.toString(),
          activeHeight: this.activeRound.state.height.toString(),
          phase,
          prepareVotes: this.activeRound.state.prepareVotes.size,
        })
        return
      }
    }

    // Clean up any existing round (pendingMessages preserved across rounds)
    this.clearRound()
    this.deferredBlock = null

    const roundCfg: BftRoundConfig = {
      // Snapshot validators for this round — prevents mid-round mutation from
      // updateValidators() affecting quorum calculations in an active round.
      validators: this.cfg.validators.map(v => ({ id: v.id, stake: v.stake })),
      localId: this.cfg.localId,
      prepareTimeoutMs: this.cfg.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
      commitTimeoutMs: this.cfg.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
    }

    // Speculatively compute the stateRoot we'd produce if we applied this
    // block against our current state. Our prepare vote commits to that
    // pair, so quorum only finalizes blocks whose post-execution state
    // WE can reproduce — not just whose header hash we accept.
    //
    // CRITICAL: compute BEFORE creating activeRound. During the async
    // compute, inbound prepares must see activeRound=null so handleMessage
    // buffers them in pendingMessages (which this round later drains).
    // If activeRound existed but phase stayed "propose" during compute,
    // handlePrepare would silently drop inbound votes with `phase !== "prepare"`.
    const localStateRoot = await this.computeLocalStateRootSafe(block)

    this.activeRound = new BftRound(block.number, roundCfg)

    // Handle the propose phase
    const outgoing = this.activeRound.handlePropose(block, block.proposer, localStateRoot)

    // Sign and broadcast prepare votes
    for (const msg of outgoing) {
      this.signMessage(msg)
      await this.cfg.broadcastMessage(msg)
    }

    // Set timeout
    this.startTimeout()

    // Process buffered messages for this height; prune all stale entries (height <= current).
    // Track the round instance so we stop if handleMessage finalizes + starts a new round.
    const thisRound = this.activeRound
    const buffered = this.pendingMessages.filter(m => m.height === block.number)
    this.pendingMessages = this.pendingMessages.filter(m => m.height > block.number)
    const prepares = buffered.filter(m => m.type !== "commit")
    const commits = buffered.filter(m => m.type === "commit")
    for (const msg of prepares) {
      if (this.activeRound !== thisRound) break // round changed (finalized + deferred)
      await this.handleMessage(msg)
    }
    for (const msg of commits) {
      if (this.activeRound !== thisRound) break // round changed (finalized + deferred)
      await this.handleMessage(msg)
    }

    if (this.activeRound && this.activeRound === thisRound) {
      log.info("BFT round started", {
        height: block.number.toString(),
        phase: this.activeRound.state.phase,
        prepareVotes: this.activeRound.state.prepareVotes.size,
        commitVotes: this.activeRound.state.commitVotes.size,
        buffered: buffered.length,
      })
      // Start commit retry if we entered commit phase during buffered message processing
      if (this.activeRound.state.phase === "commit") {
        this.startCommitRetry()
      }
    }
  }

  /**
   * Handle an incoming BFT message from a peer.
   */
  async handleMessage(msg: BftMessage): Promise<void> {
    if (!this.activeRound) {
      // Buffer messages that arrive before the round starts (race condition)
      // Dedup by sender+type+height to prevent buffer pollution from repeated messages
      if (this.pendingMessages.length < 50) {
        const isDup = this.pendingMessages.some(
          (m) => m.senderId === msg.senderId && m.type === msg.type && m.height === msg.height,
        )
        if (!isDup) this.pendingMessages.push(msg)
      }
      return
    }

    if (msg.height !== this.activeRound.state.height) {
      // Buffer future-height messages for later processing (cap gap to prevent buffer pollution).
      // Reject messages for past heights (already finalized) and extreme future heights.
      if (msg.height > this.activeRound.state.height && msg.height <= this.activeRound.state.height + 10n && this.pendingMessages.length < 50) {
        const isDup = this.pendingMessages.some(
          (m) => m.senderId === msg.senderId && m.type === msg.type && m.height === msg.height,
        )
        if (!isDup) this.pendingMessages.push(msg)
      }
      return
    }

    // Verify BFT message signature (mandatory for prepare/commit)
    if (msg.type === "prepare" || msg.type === "commit") {
      if (!msg.signature) {
        log.warn("BFT message missing signature, dropping", { sender: msg.senderId, type: msg.type })
        return
      }
      if (this.cfg.verifier) {
        const canonical = bftCanonicalMessage(msg.type, msg.height, msg.blockHash)
        if (!this.cfg.verifier.verifyNodeSig(canonical, msg.signature, msg.senderId)) {
          log.warn("BFT message signature invalid, dropping", { sender: msg.senderId, type: msg.type })
          return
        }
      } else if (this.cfg.signer) {
        // Fail-closed: signer is configured (production mode) but verifier is missing.
        // This is a misconfiguration — we can sign but cannot verify peers. Reject messages
        // to prevent accepting forged votes from unauthenticated sources.
        if (!this.warnedNoVerifier) {
          this.warnedNoVerifier = true
          log.warn("BFT signer configured but verifier missing — rejecting unverifiable messages (fail-closed)")
        }
        return
      } else if (!this.warnedNoVerifier) {
        // Neither signer nor verifier: test/dev mode. Warn once but allow.
        this.warnedNoVerifier = true
        log.warn("BFT crypto not configured — message signatures not verified (unsafe for production)")
      }
    }

    // Check for equivocation on prepare/commit votes — drop vote if detected
    if (msg.type === "prepare" || msg.type === "commit") {
      const evidence = this.equivocationDetector.recordVote(
        msg.senderId, msg.height, msg.type, msg.blockHash,
      )
      if (evidence) {
        this.cfg.onEquivocation?.(evidence)
        log.warn("equivocation detected, dropping vote", { sender: msg.senderId, type: msg.type })
        return
      }
    }

    switch (msg.type) {
      case "prepare": {
        const outgoing = this.activeRound.handlePrepare(msg.senderId, msg.blockHash, msg.stateRoot)
        // handlePrepare may finalize immediately if early commits already reached quorum
        if (this.activeRound.state.phase === "finalized" && this.activeRound.state.proposedBlock) {
          log.info("BFT round finalized (early commits)", { height: msg.height.toString() })
          const block = this.activeRound.state.proposedBlock
          this.lastFinalizedHeight = msg.height
          this.lastFinalizedAtMs = Date.now()
          this.startLingerBroadcast(msg.height, block.hash)
          this.clearRound()
          try {
            await this.cfg.onFinalized(block)
          } catch (err) {
            log.error("onFinalized callback failed (early commits path)", { height: msg.height.toString(), error: String(err) })
          }
          await this.processDeferredBlock()
          return
        }
        for (const out of outgoing) {
          this.signMessage(out)
          await this.cfg.broadcastMessage(out)
        }
        // Start commit retry when transitioning to commit phase
        if (this.activeRound?.state.phase === "commit") {
          this.startCommitRetry()
        }
        break
      }
      case "commit": {
        const finalized = this.activeRound.handleCommit(msg.senderId, msg.blockHash, msg.stateRoot)
        if (finalized && this.activeRound.state.proposedBlock) {
          log.info("BFT round finalized", { height: msg.height.toString() })
          const block = this.activeRound.state.proposedBlock
          this.lastFinalizedHeight = msg.height
          this.lastFinalizedAtMs = Date.now()
          this.startLingerBroadcast(msg.height, block.hash)
          this.clearRound()
          try {
            await this.cfg.onFinalized(block)
          } catch (err) {
            log.error("onFinalized callback failed", { height: msg.height.toString(), error: String(err) })
          }
          await this.processDeferredBlock()
        }
        break
      }
    }
  }

  /**
   * Get the current round state summary.
   */
  getRoundState(): {
    active: boolean
    height: bigint | null
    phase: string | null
    prepareVotes: number
    commitVotes: number
    equivocations: number
  } {
    // Report inactive when no round exists or round reached a terminal state.
    // This prevents tryPropose() from being permanently blocked by a stale round
    // that was finalized/failed but not yet cleared (race window).
    if (!this.activeRound || this.activeRound.state.phase === "finalized" || this.activeRound.state.phase === "failed") {
      return { active: false, height: null, phase: null, prepareVotes: 0, commitVotes: 0, equivocations: 0 }
    }
    return {
      active: true,
      height: this.activeRound.state.height,
      phase: this.activeRound.state.phase,
      prepareVotes: this.activeRound.state.prepareVotes.size,
      commitVotes: this.activeRound.state.commitVotes.size,
      equivocations: this.equivocationDetector.getEvidence().length,
    }
  }

  /**
   * Handle a block received via gossip (non-proposer path).
   * Joins the BFT round for the received block.
   */
  async handleReceivedBlock(block: ChainBlock): Promise<void> {
    // Proposer handles BFT via consensus engine, not gossip
    if (block.proposer.toLowerCase() === this.cfg.localId.toLowerCase()) return

    if (this.activeRound) {
      const phase = this.activeRound.state.phase
      // Auto-clear stale rounds in terminal state before checking height
      if (phase === "finalized" || phase === "failed") {
        this.clearRound()
      } else if (block.number <= this.activeRound.state.height) {
        return
      }
    }

    if (this.activeRound) {
      // Defer if current round is close to finalization (commit phase or prepare with votes)
      const phase = this.activeRound.state.phase
      const hasVotes = this.activeRound.state.prepareVotes.size > 1
        || this.activeRound.state.commitVotes.size > 0
      if (phase === "commit" || (phase === "prepare" && hasVotes)) {
        if (this.deferredBlock && this.deferredBlock.number < block.number) {
          log.warn("BFT overwriting deferred block via gossip (newer block arrived)", {
            droppedHeight: this.deferredBlock.number.toString(),
            newHeight: block.number.toString(),
          })
        }
        this.deferredBlock = block
        log.info("BFT deferring block (active round has progress)", {
          deferredHeight: block.number.toString(),
          activeHeight: this.activeRound.state.height.toString(),
          phase,
          prepareVotes: this.activeRound.state.prepareVotes.size,
        })
        return
      }
      this.clearRound()
    }

    await this.startRound(block)
  }

  /**
   * Update the validator set (e.g., after governance changes).
   */
  updateValidators(validators: Array<{ id: string; stake: bigint }>): void {
    // Defensive copy to prevent external mutation of the active validator set.
    // Without this, the caller could modify the array after passing it, potentially
    // corrupting quorum calculations in an active BFT round.
    this.cfg.validators = validators.map(v => ({ id: v.id, stake: v.stake }))
  }

  /**
   * Invoke the optional `computeLocalStateRoot` callback with panic safety.
   * Errors are caught + logged; on error we return undefined, which leaves the
   * vote anchored on block hash only (legacy behavior). This matches the
   * historical contract while preferring the (hash, stateRoot) pair when
   * computation succeeds.
   */
  private async computeLocalStateRootSafe(block: ChainBlock): Promise<Hex | undefined> {
    const hook = this.cfg.computeLocalStateRoot
    if (!hook) return undefined
    try {
      return await hook(block)
    } catch (err) {
      log.warn("computeLocalStateRoot threw; voting without stateRoot", {
        height: block.number.toString(),
        hash: block.hash,
        error: String(err),
      })
      return undefined
    }
  }

  /**
   * Diagnostic-only dump: emit the full per-validator vote table at the
   * moment a round times out. Lets the operator see exactly which
   * (blockHash, stateRoot) pairs each validator endorsed, plus the
   * proposed block's tx hashes. Together these are sufficient to replay
   * the divergent block locally and identify the source of
   * non-determinism (Phase B pair-quorum rejection mode, observed
   * 2026-04-29 testnet at heights 137,965 and 139,021).
   *
   * Goes to log.warn (not error) — a timeout is unfortunate but expected
   * under the protocol's guarantees, and the log entry is a diagnostic
   * artifact, not a runtime error.
   */
  private dumpDivergenceDiagnostics(round: BftRound): void {
    const dumpVotes = (votes: Map<string, { blockHash: Hex; stateRoot?: Hex }>) =>
      [...votes.entries()].map(([id, v]) => ({
        id,
        blockHash: v.blockHash,
        stateRoot: v.stateRoot ?? "<unset>",
      }))
    const proposed = round.state.proposedBlock
    log.warn("BFT divergence diagnostic — Phase B pair-quorum rejected at timeout", {
      height: round.state.height.toString(),
      phase: round.state.phase,
      proposedBlockHash: proposed?.hash ?? "<no proposed block>",
      proposedTxCount: proposed?.txs.length ?? 0,
      // Tx hashes are the keccak of the raw bytes — we don't have a precomputed
      // hash on ChainBlock.txs (which is `string[]` of raw RLP). Skip per-tx
      // detail in the log to keep the entry compact; the raw txs are still
      // available via eth_getBlockByNumber if a deeper replay is needed.
      proposedProposer: proposed?.proposer ?? "<none>",
      prepareVotes: dumpVotes(round.state.prepareVotes),
      commitVotes: dumpVotes(round.state.commitVotes),
    })
  }

  private startTimeout(): void {
    if (!this.activeRound) return

    const totalTimeout = (this.cfg.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS)
      + (this.cfg.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS)

    this.timeoutTimer = setTimeout(() => {
      if (this.activeRound && !["finalized", "failed"].includes(this.activeRound.state.phase)) {
        log.warn("BFT round timed out", {
          height: this.activeRound.state.height.toString(),
          phase: this.activeRound.state.phase,
        })
        // Diagnostic dump for the recurring "Phase B pair-quorum rejection"
        // testnet stalls (2026-04-29 onward): when a round times out in
        // prepare phase with N≥2 prepare votes, the failure mode is almost
        // always "validators agree on blockHash but disagree on stateRoot",
        // i.e. deterministic execution divergence. Dump the full vote map
        // so we can spot the divergent triple, plus the proposed block's
        // tx hashes so we can replay locally and find the non-determinism
        // source. Cheap (a few hundred bytes per timeout); only fires on
        // actual timeouts so log volume stays bounded.
        this.dumpDivergenceDiagnostics(this.activeRound)
        this.activeRound.fail()
        this.clearRound()
        this.processDeferredBlock().catch((err) => {
          log.error("processDeferredBlock failed in timeout handler", { error: String(err) })
        })
      }
    }, totalTimeout)
    // Prevent BFT timeout timer from keeping the process alive during shutdown
    if (this.timeoutTimer && typeof this.timeoutTimer.unref === "function") {
      this.timeoutTimer.unref()
    }
  }

  private signMessage(msg: BftMessage): void {
    if (!this.cfg.signer) return
    const canonical = bftCanonicalMessage(msg.type, msg.height, msg.blockHash)
    msg.signature = this.cfg.signer.sign(canonical) as Hex
  }

  private async processDeferredBlock(): Promise<void> {
    const block = this.deferredBlock
    this.deferredBlock = null
    if (!block) return

    // Guard: reject stale deferred blocks that are at or below the last finalized height
    // (activeRound is null after clearRound, so we track finalized height separately)
    if (block.number <= this.lastFinalizedHeight) {
      log.warn("BFT discarding stale deferred block", {
        deferredHeight: block.number.toString(),
        lastFinalized: this.lastFinalizedHeight.toString(),
      })
      return
    }

    log.info("BFT processing deferred block", { height: block.number.toString() })
    try {
      await this.startRound(block)
    } catch (err) {
      // Isolate startRound failures so they don't propagate up to handleMessage
      // and break the BFT coordinator's ability to process future messages.
      log.error("BFT deferred startRound failed", {
        height: block.number.toString(),
        error: String(err),
      })
    }
  }

  /**
   * Periodically re-broadcast local commit vote so late-joining peers receive it.
   */
  private startCommitRetry(): void {
    if (this.commitRetryTimer) return
    const RETRY_INTERVAL_MS = 1_000

    this.commitRetryTimer = setInterval(() => {
      if (!this.activeRound || this.activeRound.state.phase !== "commit") {
        this.stopCommitRetry()
        return
      }
      const blockHash = this.activeRound.state.proposedBlock?.hash
      if (!blockHash) return
      const msg: BftMessage = {
        type: "commit",
        height: this.activeRound.state.height,
        blockHash,
        senderId: this.cfg.localId,
        signature: "" as Hex,
      }
      this.signMessage(msg)
      void this.cfg.broadcastMessage(msg)
    }, RETRY_INTERVAL_MS)
    // Prevent commit retry timer from keeping the process alive during shutdown
    if (this.commitRetryTimer && typeof this.commitRetryTimer.unref === "function") {
      this.commitRetryTimer.unref()
    }
  }

  private stopCommitRetry(): void {
    if (this.commitRetryTimer) {
      clearInterval(this.commitRetryTimer)
      this.commitRetryTimer = null
    }
  }

  /**
   * After finalization, keep broadcasting our commit vote for a few seconds
   * so late-joining peers can finalize their rounds too.
   */
  private startLingerBroadcast(height: bigint, blockHash: Hex): void {
    this.stopLinger()
    const LINGER_INTERVAL_MS = 500
    const LINGER_COUNT = 6 // 3 seconds of linger broadcasts
    let remaining = LINGER_COUNT

    this.lingerTimer = setInterval(() => {
      if (remaining <= 0) {
        this.stopLinger()
        return
      }
      remaining--
      const msg: BftMessage = {
        type: "commit",
        height,
        blockHash,
        senderId: this.cfg.localId,
        signature: "" as Hex,
      }
      this.signMessage(msg)
      void this.cfg.broadcastMessage(msg)
    }, LINGER_INTERVAL_MS)
    // Prevent linger timer from keeping the process alive during shutdown
    if (this.lingerTimer && typeof this.lingerTimer.unref === "function") {
      this.lingerTimer.unref()
    }
  }

  private stopLinger(): void {
    if (this.lingerTimer) {
      clearInterval(this.lingerTimer)
      this.lingerTimer = null
    }
  }

  private clearRound(): void {
    this.activeRound = null
    this.stopCommitRetry()
    // Keep pendingMessages — they may contain messages for future heights
    // Note: do NOT stop linger timer here — it intentionally outlives the round
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
  }
}

/** Build the canonical string for BFT message signing/verification */
export function bftCanonicalMessage(type: string, height: bigint, blockHash: Hex): string {
  return `bft:${type}:${height.toString()}:${blockHash}`
}
