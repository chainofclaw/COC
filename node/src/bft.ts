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
  signature: Hex
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

    // Verify sender is a known validator
    if (!this.isKnownValidator(senderId)) {
      log.warn("propose from unknown validator", { senderId })
      return []
    }

    // Verify block.proposer matches senderId
    if (block.proposer !== senderId) {
      log.warn("propose block.proposer mismatch", { senderId, blockProposer: block.proposer })
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

        // Check if early-arriving commits already give us commit quorum (filter by blockHash)
        const commitVoters = [...this.state.commitVotes.entries()]
          .filter(([, hash]) => !this.state.proposedBlock || hash === this.state.proposedBlock.hash)
          .map(([id]) => id)
        if (hasQuorum(commitVoters, this.config.validators)) {
          this.state.phase = "finalized"
          return []
        }

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
   * Commits arriving during prepare phase are recorded for later evaluation.
   */
  handleCommit(senderId: string, blockHash: Hex): boolean {
    if (this.state.phase !== "commit" && this.state.phase !== "prepare") {
      return false
    }

    if (!this.isKnownValidator(senderId)) {
      return false
    }

    // Only accept commits for the proposed block
    if (this.state.proposedBlock && blockHash !== this.state.proposedBlock.hash) {
      log.warn("commit vote for wrong block", { senderId, expected: this.state.proposedBlock.hash, got: blockHash })
      return false
    }

    this.state.commitVotes.set(senderId, blockHash)

    // Only check quorum if already in commit phase
    if (this.state.phase === "commit") {
      // Filter commit votes to only count those matching the proposed block
      const matchingVoters = [...this.state.commitVotes.entries()]
        .filter(([, hash]) => !this.state.proposedBlock || hash === this.state.proposedBlock.hash)
        .map(([id]) => id)
      if (hasQuorum(matchingVoters, this.config.validators)) {
        this.state.phase = "finalized"
        return true
      }
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

/**
 * Equivocation evidence — a validator voted for two different blocks
 * at the same height and phase.
 */
export interface EquivocationEvidence {
  validatorId: string
  height: bigint
  phase: "prepare" | "commit"
  blockHash1: Hex
  blockHash2: Hex
  detectedAtMs: number
}

/**
 * BFT Equivocation Detector
 *
 * Tracks votes per validator per height and detects when a validator
 * signs conflicting votes (double-voting), which is a slashable offense.
 */
export class EquivocationDetector {
  /** height -> phase -> validatorId -> blockHash */
  private readonly votes = new Map<string, Map<string, Map<string, Hex>>>()
  private readonly evidence: EquivocationEvidence[] = []
  private readonly maxTrackedHeights: number

  constructor(maxTrackedHeights = 100) {
    this.maxTrackedHeights = maxTrackedHeights
  }

  /**
   * Record a vote and check for equivocation.
   * Returns the evidence if equivocation is detected, null otherwise.
   */
  recordVote(
    validatorId: string,
    height: bigint,
    phase: "prepare" | "commit",
    blockHash: Hex,
  ): EquivocationEvidence | null {
    const heightKey = height.toString()
    const phaseKey = phase

    if (!this.votes.has(heightKey)) {
      this.votes.set(heightKey, new Map())
    }

    const heightMap = this.votes.get(heightKey)!
    if (!heightMap.has(phaseKey)) {
      heightMap.set(phaseKey, new Map())
    }

    const phaseMap = heightMap.get(phaseKey)!
    const existingHash = phaseMap.get(validatorId)

    if (existingHash && existingHash !== blockHash) {
      // Equivocation detected!
      const ev: EquivocationEvidence = {
        validatorId,
        height,
        phase,
        blockHash1: existingHash,
        blockHash2: blockHash,
        detectedAtMs: Date.now(),
      }
      this.evidence.push(ev)
      log.warn("equivocation detected!", {
        validator: validatorId,
        height: height.toString(),
        phase,
        hash1: existingHash,
        hash2: blockHash,
      })
      return ev
    }

    phaseMap.set(validatorId, blockHash)
    this.pruneOldHeights()
    return null
  }

  /** Get all recorded equivocation evidence */
  getEvidence(): readonly EquivocationEvidence[] {
    return this.evidence
  }

  /** Get evidence for a specific validator */
  getEvidenceFor(validatorId: string): EquivocationEvidence[] {
    return this.evidence.filter((e) => e.validatorId === validatorId)
  }

  /** Clear evidence older than the given height */
  clearEvidenceBefore(height: bigint): number {
    const before = this.evidence.length
    const remaining = this.evidence.filter((e) => e.height >= height)
    this.evidence.length = 0
    this.evidence.push(...remaining)
    return before - this.evidence.length
  }

  private pruneOldHeights(): void {
    if (this.votes.size <= this.maxTrackedHeights) return
    const heights = [...this.votes.keys()].map(BigInt).sort((a, b) => (a < b ? -1 : 1))
    const toRemove = heights.length - this.maxTrackedHeights
    for (let i = 0; i < toRemove; i++) {
      this.votes.delete(heights[i].toString())
    }
  }
}
