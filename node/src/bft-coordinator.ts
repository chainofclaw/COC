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
  private warnedNoVerifier = false
  readonly equivocationDetector = new EquivocationDetector()

  constructor(cfg: BftCoordinatorConfig) {
    this.cfg = cfg
  }

  /**
   * Start a new BFT round for a proposed block.
   */
  async startRound(block: ChainBlock): Promise<void> {
    // Defer new block if an active round has voting progress (avoid killing in-flight rounds)
    if (this.activeRound) {
      const phase = this.activeRound.state.phase
      const hasProgress = this.activeRound.state.prepareVotes.size > 0
        || this.activeRound.state.commitVotes.size > 0
      if ((phase === "prepare" || phase === "commit") && hasProgress) {
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
      validators: this.cfg.validators,
      localId: this.cfg.localId,
      prepareTimeoutMs: this.cfg.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
      commitTimeoutMs: this.cfg.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
    }

    this.activeRound = new BftRound(block.number, roundCfg)

    // Handle the propose phase
    const outgoing = this.activeRound.handlePropose(block, block.proposer)

    // Sign and broadcast prepare votes
    for (const msg of outgoing) {
      this.signMessage(msg)
      await this.cfg.broadcastMessage(msg)
    }

    // Set timeout
    this.startTimeout()

    // Process buffered messages for this height; prune all stale entries (height <= current)
    const buffered = this.pendingMessages.filter(m => m.height === block.number)
    this.pendingMessages = this.pendingMessages.filter(m => m.height > block.number)
    const prepares = buffered.filter(m => m.type !== "commit")
    const commits = buffered.filter(m => m.type === "commit")
    for (const msg of prepares) {
      await this.handleMessage(msg)
    }
    for (const msg of commits) {
      await this.handleMessage(msg)
    }

    if (this.activeRound) {
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
      if (this.pendingMessages.length < 50) {
        this.pendingMessages.push(msg)
      }
      return
    }

    if (msg.height !== this.activeRound.state.height) {
      // Buffer future-height messages for later processing (cap gap to prevent buffer pollution)
      const heightGap = msg.height - this.activeRound.state.height
      if (heightGap > 0n && heightGap <= 10n && this.pendingMessages.length < 50) {
        this.pendingMessages.push(msg)
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
      } else if (!this.warnedNoVerifier) {
        // Log once — verifier should be configured in production deployments
        this.warnedNoVerifier = true
        log.warn("BFT verifier not configured — message signatures not verified (unsafe for production)")
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
        const outgoing = this.activeRound.handlePrepare(msg.senderId, msg.blockHash)
        // handlePrepare may finalize immediately if early commits already reached quorum
        if (this.activeRound.state.phase === "finalized" && this.activeRound.state.proposedBlock) {
          log.info("BFT round finalized (early commits)", { height: msg.height.toString() })
          const block = this.activeRound.state.proposedBlock
          this.startLingerBroadcast(msg.height, block.hash)
          this.clearRound()
          await this.cfg.onFinalized(block)
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
        const finalized = this.activeRound.handleCommit(msg.senderId, msg.blockHash)
        if (finalized && this.activeRound.state.proposedBlock) {
          log.info("BFT round finalized", { height: msg.height.toString() })
          const block = this.activeRound.state.proposedBlock
          this.startLingerBroadcast(msg.height, block.hash)
          this.clearRound()
          await this.cfg.onFinalized(block)
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
    if (!this.activeRound) {
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
      if (block.number <= this.activeRound.state.height) {
        return
      }
      // Defer if current round is close to finalization (commit phase or prepare with votes)
      const phase = this.activeRound.state.phase
      const hasVotes = this.activeRound.state.prepareVotes.size > 1
        || this.activeRound.state.commitVotes.size > 0
      if (phase === "commit" || (phase === "prepare" && hasVotes)) {
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
    this.cfg.validators = validators
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
        this.activeRound.fail()
        this.clearRound()
        void this.processDeferredBlock()
      }
    }, totalTimeout)
  }

  private signMessage(msg: BftMessage): void {
    if (!this.cfg.signer) return
    const canonical = bftCanonicalMessage(msg.type, msg.height, msg.blockHash)
    msg.signature = this.cfg.signer.sign(canonical) as Hex
  }

  private async processDeferredBlock(): Promise<void> {
    const block = this.deferredBlock
    this.deferredBlock = null
    if (block) {
      log.info("BFT processing deferred block", { height: block.number.toString() })
      await this.startRound(block)
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
