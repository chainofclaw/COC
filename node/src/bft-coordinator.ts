/**
 * BFT Coordinator
 *
 * Bridges BFT round logic with the consensus engine and P2P layer.
 * Manages round lifecycle: start round → collect votes → finalize.
 */

import { BftRound } from "./bft.ts"
import type { BftMessage, BftRoundConfig } from "./bft.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("bft-coordinator")

const DEFAULT_PREPARE_TIMEOUT_MS = 5_000
const DEFAULT_COMMIT_TIMEOUT_MS = 5_000

export interface BftCoordinatorConfig {
  localId: string
  validators: Array<{ id: string; stake: bigint }>
  prepareTimeoutMs?: number
  commitTimeoutMs?: number
  /** Callback to broadcast a BFT message to peers */
  broadcastMessage: (msg: BftMessage) => Promise<void>
  /** Callback when a block is BFT-finalized */
  onFinalized: (block: ChainBlock) => Promise<void>
}

/**
 * Coordinates BFT rounds across the consensus lifecycle.
 */
export class BftCoordinator {
  private readonly cfg: BftCoordinatorConfig
  private activeRound: BftRound | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null

  constructor(cfg: BftCoordinatorConfig) {
    this.cfg = cfg
  }

  /**
   * Start a new BFT round for a proposed block.
   */
  async startRound(block: ChainBlock): Promise<void> {
    // Clean up any existing round
    this.clearRound()

    const roundCfg: BftRoundConfig = {
      validators: this.cfg.validators,
      localId: this.cfg.localId,
      prepareTimeoutMs: this.cfg.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
      commitTimeoutMs: this.cfg.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
    }

    this.activeRound = new BftRound(block.number, roundCfg)

    // Handle the propose phase
    const outgoing = this.activeRound.handlePropose(block, block.proposer)

    // Broadcast prepare votes
    for (const msg of outgoing) {
      await this.cfg.broadcastMessage(msg)
    }

    // Set timeout
    this.startTimeout()

    log.info("BFT round started", { height: block.number.toString(), proposer: block.proposer })
  }

  /**
   * Handle an incoming BFT message from a peer.
   */
  async handleMessage(msg: BftMessage): Promise<void> {
    if (!this.activeRound) {
      log.debug("no active round, ignoring message", { type: msg.type, height: msg.height.toString() })
      return
    }

    if (msg.height !== this.activeRound.state.height) {
      log.debug("message height mismatch", {
        expected: this.activeRound.state.height.toString(),
        got: msg.height.toString(),
      })
      return
    }

    switch (msg.type) {
      case "prepare": {
        const outgoing = this.activeRound.handlePrepare(msg.senderId, msg.blockHash)
        for (const out of outgoing) {
          await this.cfg.broadcastMessage(out)
        }
        break
      }
      case "commit": {
        const finalized = this.activeRound.handleCommit(msg.senderId, msg.blockHash)
        if (finalized && this.activeRound.state.proposedBlock) {
          log.info("BFT round finalized", { height: msg.height.toString() })
          const block = this.activeRound.state.proposedBlock
          this.clearRound()
          await this.cfg.onFinalized(block)
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
  } {
    if (!this.activeRound) {
      return { active: false, height: null, phase: null, prepareVotes: 0, commitVotes: 0 }
    }
    return {
      active: true,
      height: this.activeRound.state.height,
      phase: this.activeRound.state.phase,
      prepareVotes: this.activeRound.state.prepareVotes.size,
      commitVotes: this.activeRound.state.commitVotes.size,
    }
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
      }
    }, totalTimeout)
  }

  private clearRound(): void {
    this.activeRound = null
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
  }
}
