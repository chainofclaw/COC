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
