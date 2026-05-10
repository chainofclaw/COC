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
  /**
   * Phase H2 Track B (testnet/dev only): when true, BFT quorum threshold
   * drops the strict `+1 wei` requirement, allowing exactly-2/3 stake to
   * reach quorum. Loses Byzantine safety. Plumbed through BftRoundConfig
   * to BftRound.handlePrepare/handleCommit's hasQuorum() calls.
   *
   * Wiring: read from `COC_DEV_RELAXED_QUORUM=1` env in node/src/index.ts.
   * MUST be false on any production chain.
   */
  relaxedQuorum?: boolean
  /**
   * Phase H4: callback fired when a BFT round times out AND the divergence
   * diagnostic shows ≥2/3 of OTHER validators converged on a (hash,
   * stateRoot) pair the local node could not reproduce. This means peers
   * have advanced past us; the local node is silently behind. The parent
   * (coc-node) wires this to an immediate snap-sync request so the lagging
   * node catches up instead of waiting for the next syncIntervalMs tick
   * (which has been observed to leave nodes permanently stuck when the
   * proposer round-robin rotates back to a lagging validator).
   *
   * Optional — when omitted, the timeout handler simply clears the round
   * and continues (legacy behaviour).
   *
   * Return value (Phase J1.1 corner-case fix, 2026-05-06):
   *   - `false` ⇒ caller declined to act on this divergence (typically
   *     because forceSnapSync is on cooldown or sync-already-in-flight).
   *     The coordinator rolls back its per-height J1.1 dedup so the next
   *     prepare arriving at this height re-fires the gate.
   *   - `true` or `undefined` (back-compat) ⇒ caller accepted; coordinator
   *     keeps the dedup engaged, suppressing further fires for this height
   *     until a successful round finalize naturally advances past it.
   */
  onPeerQuorumDiverged?: (
    info: { height: bigint; peerBlockHash: Hex; peerStateRoot: Hex; localStateRoot?: Hex },
  ) => boolean | void
  /**
   * Phase H5: callback fired when peer-quorum divergence persists across
   * `persistentDivergenceThreshold` consecutive BFT rounds. The H4 snap-
   * sync didn't cure us — usually because local leveldb is on-disk
   * corrupted and incremental block replay re-produces the same divergent
   * state. Parent wires this to `consensus.forceSnapSync()` which imports
   * a full state snapshot from peers (overwrites local trie state),
   * eliminating the manual `rsync leveldb-state+leveldb-chain` recovery
   * we've been doing by hand. Rate limited at the parent (default 15 min).
   *
   * Counter resets on any successful round finalization (early or full
   * commit) so a transient divergence storm doesn't escalate.
   */
  onPersistentDivergence?: (info: {
    height: bigint
    consecutiveCount: number
    lastPeerBlockHash: Hex
    lastPeerStateRoot: Hex
  }) => void
  /**
   * Number of consecutive peer-quorum divergences before triggering
   * `onPersistentDivergence`. Default 3. Each successful finalize resets
   * the counter.
   */
  persistentDivergenceThreshold?: number
  /**
   * Issue #73: optional chain-tip query, used to gate `startRound` against
   * stale block proposals. Without it, a restarted validator that catches
   * up via gossip-block (rather than BFT-finalize) keeps `lastFinalizedHeight`
   * at its pre-restart value, lets stale blocks slip past the existing
   * `processDeferredBlock` guard, and produces phantom rounds at past-
   * finalized heights that generate false equivocation evidence.
   *
   * Returning a Promise is fine — the coordinator awaits before deciding.
   * When omitted, only the legacy `lastFinalizedHeight` guard applies.
   */
  getChainHeight?: () => bigint | Promise<bigint>
  /**
   * PR-1A (2026-05-10): callback fired when a BFT round times out and the
   * round's proposer was *not* the local node. The parent (consensus engine)
   * uses this signal to mark the proposer unreachable, which arms the fast-
   * path H15 fallback (~15s) instead of waiting for the conservative 600s
   * timeout. Repeat callbacks for the same proposer refresh the TTL,
   * keeping a persistently-down validator marked across many rounds.
   *
   * Optional — when omitted, only the slow 600s path applies.
   */
  onProposerStuck?: (proposerId: string, height: bigint) => void
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
  // Phase H5: counts consecutive BFT rounds where peers reached quorum on
  // a state we couldn't reproduce. Resets on any successful local finalize.
  // When the counter crosses persistentDivergenceThreshold, the parent is
  // notified to escalate from incremental sync (H4) to full state-snapshot
  // import (H5).
  private consecutivePeerDivergenceCount = 0
  // Phase J1.1: dedup early-divergence fires per height so a flood of
  // prepare messages from the same round doesn't spam onPeerQuorumDiverged.
  // Reset per height; cleared whenever a round at height >= last-fired
  // finalizes (lastFinalizedHeight bookkeeping).
  private lastEarlyDivergenceFireHeight: bigint | null = null
  // Phase J1.1: throttle to 1 fire per second across all heights to bound
  // callback rate when many adjacent heights diverge simultaneously.
  private lastEarlyDivergenceFireAtMs = 0
  readonly equivocationDetector = new EquivocationDetector()
  // Phase M1.2: cumulative count of detected equivocations. Cannot derive from
  // `equivocationDetector.getEvidence().length` because Phase H16 prunes finalized
  // heights' evidence; we need a monotonic counter for Prometheus.
  private equivocationsTotal = 0
  // Phase R (2026-05-06): BFT no-double-vote invariant. Records what we
  // ourselves prepared/committed at each height. If a later startRound call
  // arrives with a different blockHash at an already-prepared height (e.g.
  // mempool drift produced a new candidate after timeout), we refuse to
  // broadcast a second prepare — that would be self-equivocation and peers
  // would correctly drop both our votes via EquivocationDetector. Cleared
  // when the corresponding height is finalized (cleanLocalVoteLedger).
  private localPreparedAt = new Map<bigint, Hex>()
  private localCommittedAt = new Map<bigint, Hex>()
  // Phase R3 (2026-05-06): retain the full block we prepared so the
  // consensus.ts re-broadcast path can replay OUR vote rather than swap
  // to a freshly-built block (which Phase R correctly refuses, but then
  // the chain stalls because no one re-sends the original).
  private localPreparedBlock = new Map<bigint, ChainBlock>()

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
    // Issue #73: gate against stale heights. `lastFinalizedHeight` only
    // advances on local BFT finalize; a node that catches up via gossip-
    // block keeps it stuck and lets stale proposals through. Querying the
    // authoritative chain tip (when available) closes that gap.
    const stalenessFloor = await this.computeStalenessFloor()
    if (block.number <= stalenessFloor) {
      log.warn("BFT refusing startRound: block height ≤ chain tip / lastFinalized (stale)", {
        blockHeight: block.number.toString(),
        stalenessFloor: stalenessFloor.toString(),
        lastFinalized: this.lastFinalizedHeight.toString(),
      })
      return
    }
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

    // Phase R (2026-05-06): BFT no-double-vote invariant. If we have already
    // broadcast a prepare for this height with a DIFFERENT blockHash (e.g.
    // mempool drift produced a new candidate after the previous round timed
    // out), refuse to broadcast a second prepare. Self-equivocation would
    // have peers' EquivocationDetector drop both our votes and the chain
    // would stall.
    //
    // Idempotent retry (same hash) is allowed: liveness needs us to
    // re-broadcast our cached prepare so peers can collect quorum.
    const previouslyPreparedHash = this.localPreparedAt.get(block.number)
    if (previouslyPreparedHash !== undefined && previouslyPreparedHash !== block.hash) {
      log.warn("Phase R: refusing self-equivocation — already prepared a different block at this height", {
        height: block.number.toString(),
        previousHash: previouslyPreparedHash,
        newBlockHash: block.hash,
      })
      return
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
      relaxedQuorum: this.cfg.relaxedQuorum,
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

    // Phase R: record what we voted prepare on so a future startRound at
    // the same height with a different block can refuse self-equivocation.
    if (outgoing.length > 0) {
      this.localPreparedAt.set(block.number, block.hash)
      // Phase R3: stash the full block too so re-broadcast can replay it.
      this.localPreparedBlock.set(block.number, block)
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
        // Phase J1.1: try early divergence detect on every prepare message,
        // even retransmitted duplicates. The buffer dedup above only
        // prevents buffer bloat; the divergence gate itself must re-fire on
        // retransmits because Phase J1.1's per-height dedup may have been
        // rolled back by a previous rejected-callback path (see
        // docs/phase-j-stall-2026-05-06-corner-case.md).
        if (msg.type === "prepare") this.tryEarlyDivergenceDetect(msg.height)
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
        if (!isDup) {
          this.pendingMessages.push(msg)
          if (msg.type === "prepare") this.tryEarlyDivergenceDetect(msg.height)
        }
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

    // Check for equivocation on prepare/commit votes — drop vote if detected.
    // Phase I3b: pass msg.signature so the resulting evidence carries both
    // signatures and can be submitted to the on-chain EquivocationDetector
    // for permissionless slashing.
    if (msg.type === "prepare" || msg.type === "commit") {
      const evidence = this.equivocationDetector.recordVote(
        msg.senderId, msg.height, msg.type, msg.blockHash, msg.signature,
      )
      if (evidence) {
        this.equivocationsTotal++
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
          // Phase H5: successful finalize means peers and we agree —
          // reset the persistent-divergence counter.
          this.consecutivePeerDivergenceCount = 0
          this.startLingerBroadcast(msg.height, block.hash)
          this.clearRound()
          // Phase H16: prune equivocation evidence for heights ≤ H now that H
          // is finalized — prevents long-running nodes from accumulating stale
          // evidence that could interfere with vote processing at future heights.
          const evictedEarly = this.equivocationDetector.clearEvidenceBefore(msg.height + 1n)
          if (evictedEarly > 0) log.debug("H16: equivocation evidence pruned after finalization", { height: msg.height.toString(), evicted: evictedEarly })
          // Phase R: prune local-vote ledger entries at and below finalized
          // height so the maps stay bounded.
          this.pruneLocalVoteLedger(msg.height)
          try {
            await this.cfg.onFinalized(block)
          } catch (err) {
            log.error("onFinalized callback failed (early commits path)", { height: msg.height.toString(), error: String(err) })
          }
          await this.processDeferredBlock()
          return
        }
        for (const out of outgoing) {
          // Phase R no-double-vote on commits: refuse to broadcast a commit
          // for a blockHash differing from a previously-broadcast commit at
          // the same height. Idempotent retransmits (same hash) allowed.
          if (out.type === "commit") {
            const prevCommitHash = this.localCommittedAt.get(out.height)
            if (prevCommitHash !== undefined && prevCommitHash !== out.blockHash) {
              log.warn("Phase R: refusing self-equivocation on commit — already committed a different block at this height", {
                height: out.height.toString(),
                previousHash: prevCommitHash,
                newBlockHash: out.blockHash,
              })
              continue
            }
          }
          this.signMessage(out)
          await this.cfg.broadcastMessage(out)
          if (out.type === "commit") {
            this.localCommittedAt.set(out.height, out.blockHash)
          }
        }
        // Start commit retry when transitioning to commit phase
        if (this.activeRound?.state.phase === "commit") {
          this.startCommitRetry()
        }
        // Phase J1.1: every prepare vote into the active round may shift the
        // OTHER-validator stake aggregate over the 2/3 threshold. Probe early
        // so we don't have to wait for the round timeout (which is the H4
        // path) when peers form quorum on a state we cannot reproduce.
        if (this.activeRound) this.tryEarlyDivergenceDetect(this.activeRound.state.height)
        break
      }
      case "commit": {
        const finalized = this.activeRound.handleCommit(msg.senderId, msg.blockHash, msg.stateRoot)
        if (finalized && this.activeRound.state.proposedBlock) {
          log.info("BFT round finalized", { height: msg.height.toString() })
          const block = this.activeRound.state.proposedBlock
          this.lastFinalizedHeight = msg.height
          this.lastFinalizedAtMs = Date.now()
          // Phase H5: successful finalize means peers and we agree —
          // reset the persistent-divergence counter.
          this.consecutivePeerDivergenceCount = 0
          this.startLingerBroadcast(msg.height, block.hash)
          this.clearRound()
          // Phase H16: same evidence-pruning as the early-commits path above.
          const evicted = this.equivocationDetector.clearEvidenceBefore(msg.height + 1n)
          this.pruneLocalVoteLedger(msg.height)
          if (evicted > 0) log.debug("H16: equivocation evidence pruned after finalization", { height: msg.height.toString(), evicted })
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

  /**
   * Phase H4 — peer quorum divergence detection.
   *
   * Scan a round's prepare votes for a (blockHash, stateRoot) pair that
   * ≥2/3 of OTHER validators (not us) agree on but our local vote disagrees
   * with. Returns the peer-quorum pair when detected, null otherwise.
   *
   * The signal we trip on: peers reached relaxedQuorum on a stateRoot we
   * couldn't reproduce. That means peers will finalize and advance past us
   * via 2-of-3 voting (the 2026-04-30 testnet stall pattern); we'll be
   * silently behind unless we trigger an immediate snap-sync.
   */
  private detectPeerQuorumDivergence(round: BftRound): {
    peerBlockHash: Hex
    peerStateRoot: Hex
    localStateRoot?: Hex
  } | null {
    const localId = this.cfg.localId.toLowerCase()
    const localVote = round.state.prepareVotes.get(localId)
    const localStateRoot = localVote?.stateRoot

    // Build the OTHER-validator vote list from the active round's prepareVotes.
    const otherVotes: Array<{ id: string; blockHash: Hex; stateRoot?: Hex }> = []
    for (const v of this.cfg.validators) {
      if (v.id.toLowerCase() === localId) continue
      const vote = round.state.prepareVotes.get(v.id.toLowerCase())
      if (!vote || !vote.stateRoot) continue
      otherVotes.push({ id: v.id, blockHash: vote.blockHash, stateRoot: vote.stateRoot })
    }
    return this.computePeerQuorumDivergence(otherVotes, localStateRoot)
  }

  /**
   * Phase J1.1 — pure helper. Given a flat list of OTHER validators' prepare
   * votes (deduped by senderId by the caller) and our locally computed
   * stateRoot, return divergence info if ≥2/3 OTHER validator stake agrees
   * on a (blockHash, stateRoot) pair that disagrees with our local stateRoot.
   *
   * Reused by:
   *   - detectPeerQuorumDivergence (timeout-time, J's predecessor H4 path)
   *   - tryEarlyDivergenceDetect (every-prepare-message, J1.1 early path)
   *
   * Threshold semantics: relaxedQuorum 2/3 form because the signal we care
   * about is "peers CAN advance without us"; the strict +1 wei distinction
   * is irrelevant for divergence detection.
   */
  private computePeerQuorumDivergence(
    otherVotes: Array<{ id: string; blockHash: Hex; stateRoot?: Hex }>,
    localStateRoot: Hex | undefined,
  ): {
    peerBlockHash: Hex
    peerStateRoot: Hex
    localStateRoot?: Hex
  } | null {
    const stakeById = new Map(
      this.cfg.validators.map((v) => [v.id.toLowerCase(), v.stake] as const),
    )
    let totalStake = 0n
    for (const v of this.cfg.validators) totalStake += v.stake

    // Group OTHER validators' votes by (blockHash, stateRoot) and sum stake.
    // Caller guarantees one vote per senderId; defensive dedup via Set
    // protects against accidental double-pushes from the buffer + active
    // round merge in tryEarlyDivergenceDetect.
    const stakeByPair = new Map<string, { hash: Hex; root: Hex; stake: bigint }>()
    const counted = new Set<string>()
    for (const vote of otherVotes) {
      if (!vote.stateRoot) continue
      const id = vote.id.toLowerCase()
      if (counted.has(id)) continue
      counted.add(id)
      const stake = stakeById.get(id)
      if (!stake) continue
      const key = `${vote.blockHash}:${vote.stateRoot}`
      const e = stakeByPair.get(key)
      if (e) {
        e.stake += stake
      } else {
        stakeByPair.set(key, { hash: vote.blockHash, root: vote.stateRoot, stake })
      }
    }

    const twoThirds = (totalStake * 2n) / 3n
    let bestPair: { hash: Hex; root: Hex; stake: bigint } | null = null
    for (const e of stakeByPair.values()) {
      if (e.stake >= twoThirds && (!bestPair || e.stake > bestPair.stake)) bestPair = e
    }
    if (!bestPair) return null

    if (localStateRoot && localStateRoot === bestPair.root) return null

    return {
      peerBlockHash: bestPair.hash,
      peerStateRoot: bestPair.root,
      localStateRoot,
    }
  }

  /**
   * Phase J1.1 — early divergence detection.
   *
   * Called after every successfully-buffered prepare message (whether routed
   * to the active round or held in pendingMessages because no round is
   * active). Aggregates OTHER validators' (blockHash, stateRoot) pairs from
   * BOTH the active round's prepareVotes AND pendingMessages at the same
   * height. If ≥2/3 OTHER stake converges and we have no matching local
   * vote, fire onPeerQuorumDiverged immediately.
   *
   * Closes the H4/H5 deadzone where our local node never starts a BFT round
   * (chain-engine rejected the proposal at parent-state validation, so
   * activeRound stays null and detectPeerQuorumDivergence sees no votes to
   * scan even at timeout time). Today's testnet stall (block 206803→206804)
   * was exactly this: node-1's BFT had zero round activity for 7+ hours,
   * yet node-2/3 prepare votes carrying matching (blockHash, stateRoot)
   * were arriving at node-1 — those votes alone are enough signal.
   *
   * Throttling:
   *   - per-height dedup (lastEarlyDivergenceFireHeight) — fires at most once
   *     for a given height
   *   - 1s global cooldown (lastEarlyDivergenceFireAtMs) — bounds callback
   *     rate when adjacent heights diverge in lockstep
   */
  private tryEarlyDivergenceDetect(height: bigint): void {
    if (!this.cfg.onPeerQuorumDiverged && !this.cfg.onPersistentDivergence) return
    if (this.lastEarlyDivergenceFireHeight === height) return

    const nowMs = Date.now()
    if (nowMs - this.lastEarlyDivergenceFireAtMs < 1000) return

    const localId = this.cfg.localId.toLowerCase()
    const otherVotes: Array<{ id: string; blockHash: Hex; stateRoot?: Hex }> = []
    let localStateRoot: Hex | undefined

    // 1) Pull from active round if it matches the height we're checking.
    if (this.activeRound && this.activeRound.state.height === height) {
      const localVote = this.activeRound.state.prepareVotes.get(localId)
      localStateRoot = localVote?.stateRoot
      for (const v of this.cfg.validators) {
        const id = v.id.toLowerCase()
        if (id === localId) continue
        const vote = this.activeRound.state.prepareVotes.get(id)
        if (!vote || !vote.stateRoot) continue
        otherVotes.push({ id, blockHash: vote.blockHash, stateRoot: vote.stateRoot })
      }
    }

    // 2) Augment with prepare messages still in the buffer for this height.
    //    Prefer active-round votes when both have an entry for the same id.
    const seen = new Set(otherVotes.map((v) => v.id.toLowerCase()))
    for (const msg of this.pendingMessages) {
      if (msg.type !== "prepare") continue
      if (msg.height !== height) continue
      if (!msg.stateRoot) continue
      const id = msg.senderId.toLowerCase()
      if (id === localId) {
        if (!localStateRoot) localStateRoot = msg.stateRoot
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      otherVotes.push({ id, blockHash: msg.blockHash, stateRoot: msg.stateRoot })
    }

    const divergence = this.computePeerQuorumDivergence(otherVotes, localStateRoot)
    if (!divergence) return

    // Mark fired BEFORE invoking callback to prevent re-entry on synchronous
    // callbacks that themselves trigger more BFT message handling. We may
    // roll this back below if the callback explicitly returns false to
    // signal "I rejected this fire" (cooldown / sync-in-flight).
    const priorFireHeight = this.lastEarlyDivergenceFireHeight
    const priorFireAtMs = this.lastEarlyDivergenceFireAtMs
    this.lastEarlyDivergenceFireHeight = height
    this.lastEarlyDivergenceFireAtMs = nowMs

    log.warn("Phase J1.1: early peer-quorum divergence detected — triggering catch-up", {
      height: height.toString(),
      peerBlockHash: divergence.peerBlockHash,
      peerStateRoot: divergence.peerStateRoot,
      localStateRoot: divergence.localStateRoot ?? "<unset>",
      activeRound: this.activeRound !== null,
      bufferedCount: this.pendingMessages.filter(
        (m) => m.type === "prepare" && m.height === height,
      ).length,
    })

    if (this.cfg.onPeerQuorumDiverged) {
      let accepted: boolean | void
      try {
        accepted = this.cfg.onPeerQuorumDiverged({
          height,
          peerBlockHash: divergence.peerBlockHash,
          peerStateRoot: divergence.peerStateRoot,
          localStateRoot: divergence.localStateRoot,
        })
      } catch (err) {
        log.warn("Phase J1.1: onPeerQuorumDiverged callback threw", { error: String(err) })
        accepted = false
      }
      if (accepted === false) {
        // Callback declined (cooldown / sync-in-flight). Roll back the dedup
        // so the next prepare at this height re-evaluates. See
        // docs/phase-j-stall-2026-05-06-corner-case.md for the failure mode
        // this guards against.
        this.lastEarlyDivergenceFireHeight = priorFireHeight
        this.lastEarlyDivergenceFireAtMs = priorFireAtMs
        log.warn("Phase J1.1 corner-case: callback declined — clearing dedup for re-fire", {
          height: height.toString(),
        })
      }
    }
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

        // Phase H4: if ≥2/3 of OTHER validators converged on a
        // (blockHash, stateRoot) pair our local node couldn't reproduce,
        // peers WILL finalize via relaxedQuorum and advance past us. Fire
        // the onPeerQuorumDiverged callback so the parent (coc-node) can
        // trigger an immediate snap-sync to catch up — without it the
        // proposer round-robin eventually rotates back to the lagging
        // node and the chain deadlocks (2026-04-30 testnet stall at
        // height 146,668).
        //
        // Phase H5: also bump the consecutive-divergence counter; when it
        // crosses the threshold (default 3) we notify the parent to
        // escalate from incremental sync to full state-snapshot import
        // (the in-process equivalent of the manual leveldb rsync recovery
        // we've been doing by hand on the testnet).
        const divergence = (this.cfg.onPeerQuorumDiverged || this.cfg.onPersistentDivergence)
          ? (() => {
              try {
                return this.detectPeerQuorumDivergence(this.activeRound)
              } catch (err) {
                log.warn("BFT detectPeerQuorumDivergence threw", { error: String(err) })
                return null
              }
            })()
          : null
        if (divergence) {
          if (this.cfg.onPeerQuorumDiverged) {
            log.warn("BFT peer-quorum divergence detected — triggering catch-up", {
              height: this.activeRound.state.height.toString(),
              peerBlockHash: divergence.peerBlockHash,
              peerStateRoot: divergence.peerStateRoot,
              localStateRoot: divergence.localStateRoot ?? "<unset>",
            })
            try {
              this.cfg.onPeerQuorumDiverged({
                height: this.activeRound.state.height,
                peerBlockHash: divergence.peerBlockHash,
                peerStateRoot: divergence.peerStateRoot,
                localStateRoot: divergence.localStateRoot,
              })
            } catch (err) {
              log.warn("BFT onPeerQuorumDiverged callback threw", { error: String(err) })
            }
          }

          // Phase H5: track consecutive divergences and escalate at threshold.
          this.consecutivePeerDivergenceCount += 1
          const threshold = this.cfg.persistentDivergenceThreshold ?? 3
          if (
            this.cfg.onPersistentDivergence
            && this.consecutivePeerDivergenceCount >= threshold
          ) {
            log.error("BFT persistent peer-quorum divergence — escalating to full state-snapshot import", {
              height: this.activeRound.state.height.toString(),
              consecutiveCount: this.consecutivePeerDivergenceCount,
              threshold,
              lastPeerBlockHash: divergence.peerBlockHash,
              lastPeerStateRoot: divergence.peerStateRoot,
            })
            try {
              this.cfg.onPersistentDivergence({
                height: this.activeRound.state.height,
                consecutiveCount: this.consecutivePeerDivergenceCount,
                lastPeerBlockHash: divergence.peerBlockHash,
                lastPeerStateRoot: divergence.peerStateRoot,
              })
            } catch (err) {
              log.warn("BFT onPersistentDivergence callback threw", { error: String(err) })
            }
          }
        }

        // PR-1A: notify parent that this round's proposer is likely unreachable.
        // Skip when the proposer was local — `onProposerStuck` is for *peer*
        // unreachability evidence; self-stuck has its own J2.2 path.
        if (this.cfg.onProposerStuck && this.activeRound) {
          const proposerId = this.activeRound.state.proposedBlock?.proposer
          if (proposerId && proposerId.toLowerCase() !== this.cfg.localId.toLowerCase()) {
            try {
              this.cfg.onProposerStuck(proposerId, this.activeRound.state.height)
            } catch (err) {
              log.warn("BFT onProposerStuck callback threw", { error: String(err) })
            }
          }
        }

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

    // Guard: reject stale deferred blocks that are at or below the chain
    // tip (when known) or last BFT-finalized height. Issue #73: the
    // chain-height query catches the gap where local catch-up happened
    // outside of BFT (gossip-block) and lastFinalizedHeight stays stale.
    const stalenessFloor = await this.computeStalenessFloor()
    if (block.number <= stalenessFloor) {
      log.warn("BFT discarding stale deferred block", {
        deferredHeight: block.number.toString(),
        stalenessFloor: stalenessFloor.toString(),
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

  /**
   * Issue #73: combined staleness floor — `max(lastFinalizedHeight, chainTip)`.
   * `lastFinalizedHeight` only advances on local BFT finalize; `chainTip`
   * (when callback supplied) reflects authoritative chain progress including
   * gossip-block catch-up after a restart. A block at or below this floor
   * has already been finalized, so starting a BFT round for it is wasted
   * work and the proposed hash will conflict with what peers already
   * committed → false equivocation evidence.
   */
  private async computeStalenessFloor(): Promise<bigint> {
    let floor = this.lastFinalizedHeight
    if (this.cfg.getChainHeight) {
      try {
        const tip = await Promise.resolve(this.cfg.getChainHeight())
        if (tip > floor) floor = tip
      } catch (err) {
        // getChainHeight failure is non-fatal — fall back to lastFinalizedHeight.
        log.debug("BFT getChainHeight threw; using lastFinalizedHeight only", {
          error: String(err),
        })
      }
    }
    return floor
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

  /**
   * Phase J2.1 — public force-clear entrypoint.
   *
   * Resets activeRound + timeout + commit retry state without touching
   * pendingMessages or linger broadcast. Designed for the H15b
   * `noProgressWatchdog` self-stuck-proposer path: when this node IS the
   * stuck proposer (its own BFT round state has internal-deadlocked —
   * 2026-05-05 testnet had node-2 in this state, prepareVotes pinned to
   * 1 self-vote, buffered=0, no path to recovery short of `docker restart`).
   *
   * After this returns, the next consensus tick can call `tryPropose` and
   * start a fresh round at the same height. The discarded round's votes
   * are lost — that's the price of unwedging without restart. Callers must
   * throttle (≥ NO_PROGRESS_TIMEOUT_MS) to prevent permanent quorum starvation.
   *
   * No-op when no active round; idempotent.
   */
  forceClearRound(reason: string): void {
    if (!this.activeRound) return
    log.warn("Phase J2.1: BFT round force-cleared", {
      height: this.activeRound.state.height.toString(),
      phase: this.activeRound.state.phase,
      prepareVotes: this.activeRound.state.prepareVotes.size,
      commitVotes: this.activeRound.state.commitVotes.size,
      reason,
    })
    this.clearRound()
  }

  /**
   * Phase M1.2 — cumulative equivocation count for Prometheus emission.
   * Monotonic; survives Phase H16 evidence pruning.
   */
  getEquivocationsTotal(): number {
    return this.equivocationsTotal
  }

  /**
   * Phase R — drop local-vote ledger entries at and below the finalized
   * height. Once the chain has finalized height H, no honest validator
   * needs to retain its vote at H ≤ H' for double-vote prevention; safe
   * to free.
   */
  private pruneLocalVoteLedger(finalizedHeight: bigint): void {
    for (const h of this.localPreparedAt.keys()) {
      if (h <= finalizedHeight) this.localPreparedAt.delete(h)
    }
    for (const h of this.localCommittedAt.keys()) {
      if (h <= finalizedHeight) this.localCommittedAt.delete(h)
    }
    for (const h of this.localPreparedBlock.keys()) {
      if (h <= finalizedHeight) this.localPreparedBlock.delete(h)
    }
  }

  /**
   * Phase R3 — return the block we previously prepared at the given height,
   * if any. Used by consensus.ts's re-broadcast path so it can replay our
   * actual prepared block instead of a freshly-built one (which would be
   * refused by the no-double-vote guard, leaving the chain stalled).
   */
  getLocalPreparedBlock(height: bigint): ChainBlock | undefined {
    return this.localPreparedBlock.get(height)
  }
}

/** Build the canonical string for BFT message signing/verification */
export function bftCanonicalMessage(type: string, height: bigint, blockHash: Hex): string {
  return `bft:${type}:${height.toString()}:${blockHash}`
}
