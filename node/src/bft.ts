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
  /**
   * Post-execution stateRoot computed by the sender after speculatively
   * applying this block to its local state. Optional for backward
   * compatibility; when undefined, quorum falls back to hash-only voting.
   *
   * When set on both a validator's prepare and commit, BFT quorum requires
   * agreement on BOTH (blockHash, stateRoot). This prevents the pattern
   * where a proposer's local EVM apply produces a stateRoot other
   * validators can't reproduce — those validators would previously still
   * vote yes on block.hash (which doesn't include stateRoot), BFT
   * finalized anyway, and every follower's applyBlock then threw
   * stateRoot-mismatch, leaving exactly one node's state ahead of the
   * others forever.
   */
  stateRoot?: Hex
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
  /**
   * Phase H2 Track B: drop the `+1 wei` from the quorum threshold so a
   * 3-validator equal-stake cluster reaches quorum at 2-of-3 instead of
   * needing all 3. Loses Byzantine safety; ONLY for testnet/devnet where
   * the cluster has known divergent-but-non-malicious validators (e.g.
   * 2026-04-30 testnet's node-1 shadow state corruption). Production
   * deployments MUST leave this false.
   */
  relaxedQuorum?: boolean
}

/** Per-validator vote record: which (blockHash, stateRoot) pair they endorsed. */
export interface BftVote {
  blockHash: Hex
  /** undefined when the validator didn't ship a stateRoot — backward-compat path. */
  stateRoot?: Hex
}

export interface BftRoundState {
  height: bigint
  phase: BftPhase
  proposedBlock: ChainBlock | null
  prepareVotes: Map<string, BftVote> // validatorId -> vote
  commitVotes: Map<string, BftVote>  // validatorId -> vote
  startedAtMs: number
}

/**
 * Calculate quorum threshold.
 *
 * Default mode (Byzantine-safe): `floor(2/3 * totalStake) + 1` — strict
 * supermajority. With 3 equal-stake validators, this requires all 3 to
 * agree (2/3 = exactly 2 stake-units, threshold is 2 + 1 wei). Correct
 * for n=3 BFT (which can tolerate f=0 byzantine faults).
 *
 * Relaxed mode (`relaxedQuorum=true`, dev/testnet only):
 * `floor(2/3 * totalStake)` — drops the `+1`. With 3 equal-stake
 * validators, this allows 2-of-3 quorum (2 stake-units >= 2 threshold).
 * Loses Byzantine safety: 2 colluding validators can finalize a fork.
 * Used when the cluster has known divergent-but-non-malicious validators
 * (e.g. 2026-04-30 testnet's persistent node-1 shadow state corruption);
 * the chain advances past the divergent vote rather than stalling.
 *
 * The relaxed flag is plumbed through `BftRoundConfig` from
 * `BftCoordinatorConfig` and ultimately from `COC_DEV_RELAXED_QUORUM=1`
 * env. Production code paths must NEVER set it true on a non-dev chain.
 */
export function quorumThreshold(
  validators: Array<{ id: string; stake: bigint }>,
  relaxedQuorum = false,
): bigint {
  const total = validators.reduce((sum, v) => sum + v.stake, 0n)
  // Guard: if total stake is zero (all validators have stake=0), return MAX_SAFE to
  // prevent quorum from ever being reached. Without this, threshold would be 1n
  // but accumulatedStake always returns 0n, causing infinite timeout loops.
  if (total === 0n) return BigInt(Number.MAX_SAFE_INTEGER)
  if (relaxedQuorum) {
    // 2/3 floor — allows exactly-2/3 stake to reach quorum.
    return (total * 2n) / 3n
  }
  return (total * 2n) / 3n + 1n
}

/**
 * Group votes by (blockHash, stateRoot) pair and return the voter ids for the
 * group anchored on `anchorId` — i.e. whatever pair `anchorId` voted for, plus
 * any other validator who voted for the same pair. Only the anchored group is
 * eligible to reach quorum, so we never finalize a state the local node can't
 * reproduce.
 *
 * Votes without a stateRoot (legacy path / non-validator observers) cannot be
 * anchors themselves and are treated as "match any stateRoot" when the anchor
 * did set one, to preserve backward compatibility during rollout.
 *
 * Returns the grouping key so callers can log / diagnose which pair won.
 */
export function pickWinningVoteGroup(
  votes: Map<string, BftVote>,
  anchorId: string,
): { ids: string[]; blockHash: Hex | null; stateRoot: Hex | undefined } {
  const anchor = votes.get(anchorId)
  if (!anchor) return { ids: [], blockHash: null, stateRoot: undefined }

  const ids: string[] = []
  for (const [voterId, v] of votes.entries()) {
    if (v.blockHash !== anchor.blockHash) continue
    // If anchor has a stateRoot, require the voter's stateRoot to match, OR
    // allow votes without a stateRoot (legacy compat).
    if (anchor.stateRoot !== undefined) {
      if (v.stateRoot !== undefined && v.stateRoot !== anchor.stateRoot) continue
    }
    ids.push(voterId)
  }
  return { ids, blockHash: anchor.blockHash, stateRoot: anchor.stateRoot }
}

/**
 * Calculate accumulated stake for a set of voter IDs.
 */
export function accumulatedStake(
  voterIds: string[],
  validators: Array<{ id: string; stake: bigint }>,
): bigint {
  const stakeMap = new Map(validators.map((v) => [v.id.toLowerCase(), v.stake]))
  return voterIds.reduce((sum, id) => sum + (stakeMap.get(id.toLowerCase()) ?? 0n), 0n)
}

/**
 * Check if a set of voters meets quorum.
 */
export function hasQuorum(
  voterIds: string[],
  validators: Array<{ id: string; stake: bigint }>,
  relaxedQuorum = false,
): boolean {
  const threshold = quorumThreshold(validators, relaxedQuorum)
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
  handlePropose(block: ChainBlock, senderId: string, localStateRoot?: Hex): BftMessage[] {
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

    // Verify block.proposer matches senderId (case-insensitive for EIP-55 compatibility)
    if (block.proposer.toLowerCase() !== senderId.toLowerCase()) {
      log.warn("propose block.proposer mismatch", { senderId, blockProposer: block.proposer })
      return []
    }

    this.state.proposedBlock = block
    this.state.phase = "prepare"

    // If we are a validator, send prepare vote with our locally-computed stateRoot.
    // Quorum calculation requires (blockHash, stateRoot) to match — prevents the
    // case where proposer and followers compute different stateRoots and still
    // pass quorum because they all agreed on block.hash.
    if (this.isValidator()) {
      this.state.prepareVotes.set(this.config.localId.toLowerCase(), {
        blockHash: block.hash,
        stateRoot: localStateRoot,
      })
      const msg: BftMessage = {
        type: "prepare",
        height: this.state.height,
        blockHash: block.hash,
        senderId: this.config.localId,
        signature: "" as Hex, // placeholder — coordinator signs before broadcast
      }
      if (localStateRoot !== undefined) msg.stateRoot = localStateRoot
      return [msg]
    }

    return []
  }

  /**
   * Handle a prepare vote from a validator.
   * If quorum is reached, transition to commit phase.
   */
  handlePrepare(senderId: string, blockHash: Hex, stateRoot?: Hex): BftMessage[] {
    if (this.state.phase !== "prepare") {
      return []
    }

    // Guard: proposedBlock must exist during prepare phase (set by handlePropose).
    // If null, the round is in an inconsistent state — reject to avoid null dereference.
    if (!this.state.proposedBlock) {
      log.warn("prepare received but no proposed block", { senderId, height: this.state.height.toString() })
      return []
    }

    if (!this.isKnownValidator(senderId)) {
      log.warn("prepare from unknown validator", { senderId })
      return []
    }

    // Only accept votes for the proposed block
    if (blockHash !== this.state.proposedBlock.hash) {
      log.warn("prepare vote for wrong block", { senderId, expected: this.state.proposedBlock.hash, got: blockHash })
      return []
    }

    // Reject duplicate votes from the same validator (equivocation detector handles evidence)
    if (this.state.prepareVotes.has(senderId.toLowerCase())) return []

    this.state.prepareVotes.set(senderId.toLowerCase(), { blockHash, stateRoot })

    // Quorum requires agreement on BOTH (blockHash, stateRoot). Group votes by
    // that pair; find the winning group (must include our own vote when we
    // cast one, since we only commit to the state we can locally reproduce).
    const winningVoters = pickWinningVoteGroup(
      this.state.prepareVotes,
      this.config.localId.toLowerCase(),
    )
    if (hasQuorum(winningVoters.ids, this.config.validators, this.config.relaxedQuorum)) {
      this.state.phase = "commit"

      // Send commit vote
      if (this.isValidator()) {
        // Our own commit aligns with our prepare's stateRoot.
        const ownPrepare = this.state.prepareVotes.get(this.config.localId.toLowerCase())
        const ownStateRoot = ownPrepare?.stateRoot
        this.state.commitVotes.set(this.config.localId.toLowerCase(), {
          blockHash,
          stateRoot: ownStateRoot,
        })

        // Check if early-arriving commits already give us commit quorum on the
        // same (blockHash, stateRoot) pair.
        const commitWinner = pickWinningVoteGroup(
          this.state.commitVotes,
          this.config.localId.toLowerCase(),
        )
        if (hasQuorum(commitWinner.ids, this.config.validators, this.config.relaxedQuorum)) {
          this.state.phase = "finalized"
          return []
        }

        const msg: BftMessage = {
          type: "commit",
          height: this.state.height,
          blockHash,
          senderId: this.config.localId,
          signature: "" as Hex, // placeholder — coordinator signs before broadcast
        }
        if (ownStateRoot !== undefined) msg.stateRoot = ownStateRoot
        return [msg]
      }
    }

    return []
  }

  /**
   * Handle a commit vote from a validator.
   * If quorum is reached, transition to finalized.
   * Commits arriving during prepare phase are recorded for later evaluation.
   */
  handleCommit(senderId: string, blockHash: Hex, stateRoot?: Hex): boolean {
    if (this.state.phase !== "commit" && this.state.phase !== "prepare") {
      return false
    }

    if (!this.isKnownValidator(senderId)) {
      return false
    }

    // Guard: reject commits when proposedBlock is null — without a known proposal,
    // we cannot verify blockHash validity. Blindly storing commits could let an attacker
    // pre-load votes for arbitrary hashes that later match a crafted proposal.
    if (!this.state.proposedBlock) {
      log.warn("commit received but no proposed block", { senderId, height: this.state.height.toString() })
      return false
    }

    // Only accept commits for the proposed block
    if (blockHash !== this.state.proposedBlock.hash) {
      log.warn("commit vote for wrong block", { senderId, expected: this.state.proposedBlock.hash, got: blockHash })
      return false
    }

    // Reject duplicate commit votes from the same validator
    if (this.state.commitVotes.has(senderId.toLowerCase())) return false

    this.state.commitVotes.set(senderId.toLowerCase(), { blockHash, stateRoot })

    // Only check quorum if already in commit phase
    if (this.state.phase === "commit") {
      // Quorum must be on same (blockHash, stateRoot) group. Anchor on our own
      // vote so we only finalize a block whose state we can reproduce.
      const winner = pickWinningVoteGroup(
        this.state.commitVotes,
        this.config.localId.toLowerCase(),
      )
      if (hasQuorum(winner.ids, this.config.validators, this.config.relaxedQuorum)) {
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
        // `msg.stateRoot` on a propose is informational only (it's the
        // proposer's computed root). Followers compute their own before
        // voting, so don't forward the proposer's claim as our vote.
        const out = this.handlePropose(this.state.proposedBlock, msg.senderId)
        return { outgoing: out, finalized: false }
      }
      case "prepare": {
        const out = this.handlePrepare(msg.senderId, msg.blockHash, msg.stateRoot)
        return { outgoing: out, finalized: false }
      }
      case "commit": {
        const finalized = this.handleCommit(msg.senderId, msg.blockHash, msg.stateRoot)
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
    const localLower = this.config.localId.toLowerCase()
    return this.config.validators.some((v) => v.id.toLowerCase() === localLower)
  }

  private isKnownValidator(id: string): boolean {
    const normalized = id.toLowerCase()
    return this.config.validators.some((v) => v.id.toLowerCase() === normalized)
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
  /** Per-validator evidence count to prevent one validator from flushing another's evidence */
  private readonly evidenceCountByValidator = new Map<string, number>()
  private readonly maxTrackedHeights: number
  private readonly maxEvidence: number
  private readonly maxEvidencePerValidator: number

  constructor(maxTrackedHeights = 100, maxEvidence = 1000, maxEvidencePerValidator = 100) {
    this.maxTrackedHeights = maxTrackedHeights
    this.maxEvidence = maxEvidence
    this.maxEvidencePerValidator = maxEvidencePerValidator
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
    const normalizedId = validatorId.toLowerCase()
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
    const existingHash = phaseMap.get(normalizedId)

    if (existingHash && existingHash !== blockHash) {
      // Equivocation detected!
      // Use normalizedId for consistent case-insensitive evidence matching
      const ev: EquivocationEvidence = {
        validatorId: normalizedId,
        height,
        phase,
        blockHash1: existingHash,
        blockHash2: blockHash,
        detectedAtMs: Date.now(),
      }
      // Per-validator evidence cap: prevent one attacker from flushing another validator's evidence
      const validatorCount = this.evidenceCountByValidator.get(normalizedId) ?? 0
      if (validatorCount >= this.maxEvidencePerValidator) {
        // This validator already has max evidence; log but don't store to prevent flush attack
        log.warn("equivocation evidence cap reached for validator", { validator: normalizedId, cap: this.maxEvidencePerValidator })
      } else {
        // Global cap with per-validator fairness: evict oldest from the SAME validator if global is full
        if (this.evidence.length >= this.maxEvidence) {
          // Find and remove oldest evidence from the validator with the most entries
          let maxValidator = normalizedId
          let maxCount = validatorCount
          for (const [vid, cnt] of this.evidenceCountByValidator) {
            if (cnt > maxCount) { maxValidator = vid; maxCount = cnt }
          }
          const evictIdx = this.evidence.findIndex((e) => e.validatorId === maxValidator)
          if (evictIdx >= 0) {
            this.evidence.splice(evictIdx, 1)
            this.evidenceCountByValidator.set(maxValidator, (this.evidenceCountByValidator.get(maxValidator) ?? 1) - 1)
          }
        }
        this.evidence.push(ev)
        this.evidenceCountByValidator.set(normalizedId, validatorCount + 1)
      }
      log.warn("equivocation detected!", {
        validator: validatorId,
        height: height.toString(),
        phase,
        hash1: existingHash,
        hash2: blockHash,
      })
      return ev
    }

    phaseMap.set(normalizedId, blockHash)
    this.pruneOldHeights()
    return null
  }

  /** Get all recorded equivocation evidence */
  getEvidence(): readonly EquivocationEvidence[] {
    return this.evidence
  }

  /** Get evidence for a specific validator (case-insensitive match) */
  getEvidenceFor(validatorId: string): EquivocationEvidence[] {
    const normalized = validatorId.toLowerCase()
    return this.evidence.filter((e) => e.validatorId === normalized)
  }

  /** Clear evidence older than the given height (in-place to avoid intermediate allocation) */
  clearEvidenceBefore(height: bigint): number {
    let writeIdx = 0
    for (let i = 0; i < this.evidence.length; i++) {
      if (this.evidence[i].height >= height) {
        this.evidence[writeIdx++] = this.evidence[i]
      } else {
        // Decrement per-validator counter for removed evidence
        const vid = this.evidence[i].validatorId
        const cnt = this.evidenceCountByValidator.get(vid) ?? 1
        if (cnt <= 1) {
          this.evidenceCountByValidator.delete(vid)
        } else {
          this.evidenceCountByValidator.set(vid, cnt - 1)
        }
      }
    }
    const removed = this.evidence.length - writeIdx
    this.evidence.length = writeIdx
    return removed
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
