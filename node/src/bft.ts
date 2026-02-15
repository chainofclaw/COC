/**
 * BFT-lite Consensus Round
 *
 * Three-phase commit protocol: Propose → Prepare → Commit
 * Requires 2/3+ stake-weighted quorum for prepare and commit phases.
 * Each round is tied to a specific block height.
 */

import type { Hex, ChainBlock } from "./blockchain-types.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("bft")

export type BftPhase = "propose" | "prepare" | "commit" | "finalized" | "failed"

export interface BftMessage {
  type: "propose" | "prepare" | "commit"
  height: bigint
  blockHash: Hex
  senderId: string
  signature?: Hex
}

export interface BftRoundConfig {
  /** Validator set with stakes for this round */
  validators: Array<{ id: string; stake: bigint }>
  /** This node's validator ID */
  localId: string
  /** Timeout for prepare phase (ms) */
  prepareTimeoutMs: number
  /** Timeout for commit phase (ms) */
  commitTimeoutMs: number
}

export interface BftRoundState {
  height: bigint
  phase: BftPhase
  proposedBlock: ChainBlock | null
  prepareVotes: Map<string, Hex> // validatorId -> blockHash
  commitVotes: Map<string, Hex> // validatorId -> blockHash
  startedAtMs: number
}

/**
 * Calculate quorum threshold: floor(2/3 * totalStake) + 1
 */
export function quorumThreshold(validators: Array<{ id: string; stake: bigint }>): bigint {
  const total = validators.reduce((sum, v) => sum + v.stake, 0n)
  return (total * 2n) / 3n + 1n
}

/**
 * Calculate accumulated stake for a set of voter IDs.
 */
export function accumulatedStake(
  voterIds: string[],
  validators: Array<{ id: string; stake: bigint }>,
): bigint {
  const stakeMap = new Map(validators.map((v) => [v.id, v.stake]))
  return voterIds.reduce((sum, id) => sum + (stakeMap.get(id) ?? 0n), 0n)
}

/**
 * Check if a set of voters meets quorum.
 */
export function hasQuorum(
  voterIds: string[],
  validators: Array<{ id: string; stake: bigint }>,
): boolean {
  const threshold = quorumThreshold(validators)
  const accumulated = accumulatedStake(voterIds, validators)
  return accumulated >= threshold
}

/**
 * BFT Round Manager — manages a single consensus round for a block height.
 */
export class BftRound {
  readonly config: BftRoundConfig
  readonly state: BftRoundState

  constructor(height: bigint, config: BftRoundConfig) {
    this.config = config
    this.state = {
      height,
      phase: "propose",
      proposedBlock: null,
      prepareVotes: new Map(),
      commitVotes: new Map(),
      startedAtMs: Date.now(),
    }
  }

  /**
   * Handle a propose message from the block proposer.
   * Transitions to prepare phase if valid.
   */
  handlePropose(block: ChainBlock, senderId: string): BftMessage[] {
    if (this.state.phase !== "propose") {
      log.warn("ignoring propose in wrong phase", { phase: this.state.phase, height: this.state.height.toString() })
      return []
    }

    if (block.number !== this.state.height) {
      log.warn("propose height mismatch", { expected: this.state.height.toString(), got: block.number.toString() })
      return []
    }

    this.state.proposedBlock = block
    this.state.phase = "prepare"

    // If we are a validator, send prepare vote
    if (this.isValidator()) {
      this.state.prepareVotes.set(this.config.localId, block.hash)
      return [{
        type: "prepare",
        height: this.state.height,
        blockHash: block.hash,
        senderId: this.config.localId,
      }]
    }

    return []
  }

  /**
   * Handle a prepare vote from a validator.
   * If quorum is reached, transition to commit phase.
   */
  handlePrepare(senderId: string, blockHash: Hex): BftMessage[] {
    if (this.state.phase !== "prepare") {
      return []
    }

    if (!this.isKnownValidator(senderId)) {
      log.warn("prepare from unknown validator", { senderId })
      return []
    }

    // Only accept votes for the proposed block
    if (this.state.proposedBlock && blockHash !== this.state.proposedBlock.hash) {
      log.warn("prepare vote for wrong block", { senderId, expected: this.state.proposedBlock.hash, got: blockHash })
      return []
    }

    this.state.prepareVotes.set(senderId, blockHash)

    // Check quorum
    const voters = [...this.state.prepareVotes.keys()]
    if (hasQuorum(voters, this.config.validators)) {
      this.state.phase = "commit"

      // Send commit vote
      if (this.isValidator()) {
        this.state.commitVotes.set(this.config.localId, blockHash)
        return [{
          type: "commit",
          height: this.state.height,
          blockHash,
          senderId: this.config.localId,
        }]
      }
    }

    return []
  }

  /**
   * Handle a commit vote from a validator.
   * If quorum is reached, transition to finalized.
   */
  handleCommit(senderId: string, blockHash: Hex): boolean {
    if (this.state.phase !== "commit") {
      return false
    }

    if (!this.isKnownValidator(senderId)) {
      return false
    }

    this.state.commitVotes.set(senderId, blockHash)

    // Check quorum
    const voters = [...this.state.commitVotes.keys()]
    if (hasQuorum(voters, this.config.validators)) {
      this.state.phase = "finalized"
      return true
    }

    return false
  }

  /**
   * Handle a BFT message generically.
   */
  handleMessage(msg: BftMessage): { outgoing: BftMessage[]; finalized: boolean } {
    switch (msg.type) {
      case "propose": {
        if (!this.state.proposedBlock) {
          // Cannot process propose without block
          return { outgoing: [], finalized: false }
        }
        const out = this.handlePropose(this.state.proposedBlock, msg.senderId)
        return { outgoing: out, finalized: false }
      }
      case "prepare": {
        const out = this.handlePrepare(msg.senderId, msg.blockHash)
        return { outgoing: out, finalized: false }
      }
      case "commit": {
        const finalized = this.handleCommit(msg.senderId, msg.blockHash)
        return { outgoing: [], finalized }
      }
    }
  }

  /**
   * Check if the round has timed out.
   */
  isTimedOut(): boolean {
    const elapsed = Date.now() - this.state.startedAtMs
    if (this.state.phase === "prepare") {
      return elapsed >= this.config.prepareTimeoutMs
    }
    if (this.state.phase === "commit") {
      return elapsed >= this.config.prepareTimeoutMs + this.config.commitTimeoutMs
    }
    return false
  }

  /**
   * Mark the round as failed (e.g., on timeout).
   */
  fail(): void {
    this.state.phase = "failed"
  }

  private isValidator(): boolean {
    return this.config.validators.some((v) => v.id === this.config.localId)
  }

  private isKnownValidator(id: string): boolean {
    return this.config.validators.some((v) => v.id === id)
  }
}
