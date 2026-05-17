/**
 * BFT Slashing Handler
 *
 * Connects equivocation detection to validator governance penalties:
 * - On equivocation: slash validator stake by configurable percentage
 * - Deposit slashed amount into treasury
 * - Remove validator if stake falls below minimum
 * - Emit slash event for monitoring
 */

import type { EquivocationEvidence } from "./bft.ts"
import type { ValidatorGovernance } from "./validator-governance.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("bft-slashing")

export interface SlashEvent {
  validatorId: string
  height: bigint
  phase: "prepare" | "commit"
  slashedAmount: bigint
  remainingStake: bigint
  removed: boolean
  evidence: EquivocationEvidence
  timestamp: number
}

export interface BftSlashingConfig {
  /** Percentage of stake to slash per equivocation (0-100). Default: 10 */
  slashPercent: number
  /** Minimum stake below which the validator is removed. Default: governance minStake */
  minStakeThreshold?: bigint
  /** Whether to remove validators when stake falls below threshold. Default: true */
  autoRemove: boolean
}

const DEFAULT_CONFIG: BftSlashingConfig = {
  slashPercent: 10,
  autoRemove: true,
}

export class BftSlashingHandler {
  private readonly config: BftSlashingConfig
  private readonly governance: ValidatorGovernance
  private readonly slashHistory: SlashEvent[] = []
  private readonly onSlash?: (event: SlashEvent) => void
  /**
   * Order-independent keys of equivocations already slashed. A single
   * equivocation must be slashed exactly once: peer-gossiped evidence
   * (issue #620) reaches handleEquivocation, so without dedup a malicious
   * peer could re-gossip one valid evidence repeatedly and drain a
   * validator's whole stake 10% at a time. Node-side analogue of the
   * on-chain EquivocationDetector replay fix (#651).
   */
  private readonly consumedEvidence = new Set<string>()
  private static readonly MAX_CONSUMED_EVIDENCE = 10_000

  constructor(
    governance: ValidatorGovernance,
    config?: Partial<BftSlashingConfig>,
    onSlash?: (event: SlashEvent) => void,
  ) {
    this.governance = governance
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.onSlash = onSlash

    if (this.config.slashPercent < 0 || this.config.slashPercent > 100) {
      throw new Error("slashPercent must be between 0 and 100")
    }
  }

  /**
   * Handle an equivocation evidence and apply slashing penalty.
   * Returns the slash event if penalty was applied, null if validator not found.
   */
  handleEquivocation(evidence: EquivocationEvidence): SlashEvent | null {
    const validator = this.governance.getValidator(evidence.validatorId)
    if (!validator || !validator.active) {
      log.warn("equivocation for unknown/inactive validator", {
        validatorId: evidence.validatorId,
      })
      return null
    }

    // Replay guard: one equivocation = one slash. The two block hashes are
    // sorted so swapping blockHash1/blockHash2 can't forge a fresh key.
    const evidenceKey = this.evidenceKey(evidence)
    if (this.consumedEvidence.has(evidenceKey)) {
      log.warn("equivocation evidence already slashed, ignoring replay", {
        validatorId: evidence.validatorId,
        height: evidence.height.toString(),
        phase: evidence.phase,
      })
      return null
    }
    // Evict oldest keys (Set preserves insertion order) before recording.
    while (this.consumedEvidence.size >= BftSlashingHandler.MAX_CONSUMED_EVIDENCE) {
      const oldest = this.consumedEvidence.values().next().value
      if (oldest === undefined) break
      this.consumedEvidence.delete(oldest)
    }
    this.consumedEvidence.add(evidenceKey)

    // Calculate slash amount
    const slashAmount = (validator.stake * BigInt(this.config.slashPercent)) / 100n
    const remainingStake = validator.stake - slashAmount

    // Apply stake reduction via governance
    this.governance.applySlash(evidence.validatorId, slashAmount)

    // Deposit slashed amount into treasury
    if (slashAmount > 0n) {
      this.governance.depositTreasury(slashAmount)
    }

    // Check if validator should be removed
    const minStake = this.config.minStakeThreshold ?? this.governance.getMinStake()
    const shouldRemove = this.config.autoRemove && remainingStake < minStake
    if (shouldRemove) {
      this.governance.deactivateValidator(evidence.validatorId)
    }

    const event: SlashEvent = {
      validatorId: evidence.validatorId,
      height: evidence.height,
      phase: evidence.phase,
      slashedAmount: slashAmount,
      remainingStake,
      removed: shouldRemove,
      evidence,
      timestamp: Date.now(),
    }

    if (this.slashHistory.length >= 10_000) {
      this.slashHistory.splice(0, this.slashHistory.length - 9_999)
    }
    this.slashHistory.push(event)
    log.warn("validator slashed", {
      validatorId: evidence.validatorId,
      slashAmount: slashAmount.toString(),
      remaining: remainingStake.toString(),
      removed: shouldRemove,
    })

    this.onSlash?.(event)
    return event
  }

  /**
   * Order-independent dedup key for one equivocation. The two conflicting
   * block hashes are lowercased and sorted so blockHash1/blockHash2 swap
   * cannot mint a fresh key for the same offence.
   */
  private evidenceKey(evidence: EquivocationEvidence): string {
    const [loHash, hiHash] = [evidence.blockHash1, evidence.blockHash2]
      .map((h) => h.toLowerCase())
      .sort()
    return `${evidence.validatorId.toLowerCase()}|${evidence.height}|${evidence.phase}|${loHash}|${hiHash}`
  }

  /** Get all slash events */
  getSlashHistory(): readonly SlashEvent[] {
    return this.slashHistory
  }

  /** Get slash events for a specific validator */
  getSlashesFor(validatorId: string): SlashEvent[] {
    return this.slashHistory.filter((e) => e.validatorId === validatorId)
  }

  /** Get total slashed amount across all validators */
  getTotalSlashed(): bigint {
    return this.slashHistory.reduce((sum, e) => sum + e.slashedAmount, 0n)
  }
}
