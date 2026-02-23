/**
 * Validator Governance
 *
 * Manages the validator set with support for:
 * - Adding/removing validators via proposals and voting
 * - Stake-weighted voting power
 * - Proposal lifecycle (pending → approved/rejected)
 * - Epoch-based validator set transitions
 */

export interface ValidatorInfo {
  id: string
  address: string
  stake: bigint
  joinedAtEpoch: bigint
  active: boolean
  votingPower: number // 0-10000 basis points, proportional to stake
}

export type ProposalType = "add_validator" | "remove_validator" | "update_stake"

export type FactionId = "builders" | "guardians" | "explorers" | "neutral"

export interface FactionInfo {
  address: string
  faction: FactionId
  joinedAtEpoch: bigint
}

export interface GovernanceProposal {
  id: string
  type: ProposalType
  targetId: string
  targetAddress?: string
  stakeAmount?: bigint
  proposer: string
  createdAtEpoch: bigint
  expiresAtEpoch: bigint
  votes: Map<string, boolean> // validatorId -> approve/reject
  status: "pending" | "approved" | "rejected" | "expired"
}

export interface GovernanceConfig {
  minStake: bigint
  maxValidators: number
  proposalDurationEpochs: bigint
  approvalThresholdPercent: number // Percentage of voting power needed (e.g., 67)
  minVoterPercent: number // Minimum participation percentage (e.g., 50)
}

const DEFAULT_CONFIG: GovernanceConfig = {
  minStake: 1000000000000000000n, // 1 ETH
  maxValidators: 100,
  proposalDurationEpochs: 24n, // ~24 hours if 1 epoch/hour
  approvalThresholdPercent: 67,
  minVoterPercent: 50,
}

export class ValidatorGovernance {
  private readonly config: GovernanceConfig
  private readonly validators: Map<string, ValidatorInfo> = new Map()
  private readonly proposals: Map<string, GovernanceProposal> = new Map()
  private readonly factions: Map<string, FactionInfo> = new Map() // address -> faction
  private treasuryBalance = 0n
  private currentEpoch = 0n
  private nextProposalId = 1

  constructor(config?: Partial<GovernanceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Initialize with genesis validators.
   */
  initGenesis(validators: Array<{ id: string; address: string; stake: bigint }>): void {
    for (const v of validators) {
      this.validators.set(v.id, {
        id: v.id,
        address: v.address,
        stake: v.stake,
        joinedAtEpoch: 0n,
        active: true,
        votingPower: 0,
      })
    }
    this.recalcVotingPower()
  }

  /**
   * Advance to a new epoch, processing expired proposals.
   */
  advanceEpoch(epoch: bigint): void {
    this.currentEpoch = epoch

    for (const [id, proposal] of this.proposals) {
      if (proposal.status === "pending" && epoch >= proposal.expiresAtEpoch) {
        this.proposals.set(id, { ...proposal, status: "expired" })
      }
    }

    // Auto-prune finalized proposals older than 100 epochs
    this.pruneProposals(100n)
  }

  /**
   * Remove finalized proposals older than a retention threshold.
   * Returns the number of proposals pruned.
   */
  pruneProposals(retentionEpochs: bigint): number {
    const cutoff = this.currentEpoch > retentionEpochs ? this.currentEpoch - retentionEpochs : 0n
    let pruned = 0

    for (const [id, proposal] of this.proposals) {
      if (proposal.status !== "pending" && proposal.createdAtEpoch < cutoff) {
        this.proposals.delete(id)
        pruned++
      }
    }
    return pruned
  }

  /**
   * Get governance stats summary.
   */
  getGovernanceStats(): {
    activeValidators: number
    totalStake: bigint
    pendingProposals: number
    totalProposals: number
    currentEpoch: bigint
  } {
    const active = this.getActiveValidators()
    const totalStake = active.reduce((sum, v) => sum + v.stake, 0n)
    const pending = [...this.proposals.values()].filter((p) => p.status === "pending").length

    return {
      activeValidators: active.length,
      totalStake,
      pendingProposals: pending,
      totalProposals: this.proposals.size,
      currentEpoch: this.currentEpoch,
    }
  }

  /**
   * Get treasury balance.
   */
  getTreasuryBalance(): bigint {
    return this.treasuryBalance
  }

  /**
   * Deposit into treasury (e.g., from block rewards or slashing).
   */
  depositTreasury(amount: bigint): void {
    if (amount <= 0n) throw new Error("deposit amount must be positive")
    this.treasuryBalance = this.treasuryBalance + amount
  }

  /**
   * Set faction for an address.
   */
  setFaction(address: string, faction: FactionId): void {
    const normalized = address.toLowerCase()
    this.factions.set(normalized, {
      address: normalized,
      faction,
      joinedAtEpoch: this.currentEpoch,
    })
  }

  /**
   * Get faction for an address.
   */
  getFaction(address: string): FactionInfo | null {
    return this.factions.get(address.toLowerCase()) ?? null
  }

  /**
   * Get faction member counts.
   */
  getFactionStats(): Record<FactionId, number> {
    const counts: Record<FactionId, number> = { builders: 0, guardians: 0, explorers: 0, neutral: 0 }
    for (const info of this.factions.values()) {
      counts[info.faction]++
    }
    return counts
  }

  /**
   * Submit a proposal to modify the validator set.
   */
  submitProposal(
    type: ProposalType,
    targetId: string,
    proposer: string,
    opts?: { targetAddress?: string; stakeAmount?: bigint },
  ): GovernanceProposal {
    // Proposer must be active validator
    const proposerInfo = this.validators.get(proposer)
    if (!proposerInfo?.active) {
      throw new Error("proposer is not an active validator")
    }

    // Validation
    if (type === "add_validator") {
      if (this.validators.has(targetId) && this.validators.get(targetId)!.active) {
        throw new Error("validator already active")
      }
      if (this.activeCount() >= this.config.maxValidators) {
        throw new Error("max validators reached")
      }
      if (!opts?.targetAddress) {
        throw new Error("target address required for add_validator")
      }
      const stake = opts?.stakeAmount ?? 0n
      if (stake < this.config.minStake) {
        throw new Error(`stake below minimum: ${this.config.minStake}`)
      }
    }

    if (type === "update_stake") {
      if (!this.validators.has(targetId) || !this.validators.get(targetId)!.active) {
        throw new Error("target validator not active")
      }
      if (opts?.stakeAmount === undefined) {
        throw new Error("stakeAmount required for update_stake")
      }
      if (opts.stakeAmount < this.config.minStake) {
        throw new Error(`stake below minimum: ${this.config.minStake}`)
      }
      // Reasonable upper bound: 1000x minimum stake
      const maxStake = this.config.minStake * 1000n
      if (opts.stakeAmount > maxStake) {
        throw new Error(`stake exceeds maximum: ${maxStake}`)
      }
    }

    if (type === "remove_validator") {
      if (!this.validators.has(targetId) || !this.validators.get(targetId)!.active) {
        throw new Error("target validator not active")
      }
      if (this.activeCount() <= 1) {
        throw new Error("cannot remove last validator")
      }
    }

    const id = `proposal-${this.nextProposalId++}`
    const proposal: GovernanceProposal = {
      id,
      type,
      targetId,
      targetAddress: opts?.targetAddress,
      stakeAmount: opts?.stakeAmount,
      proposer,
      createdAtEpoch: this.currentEpoch,
      expiresAtEpoch: this.currentEpoch + this.config.proposalDurationEpochs,
      votes: new Map(), // No auto-vote — proposer must explicitly vote
      status: "pending",
    }

    this.proposals.set(id, proposal)
    return proposal
  }

  /**
   * Vote on a proposal.
   */
  vote(proposalId: string, voterId: string, approve: boolean): void {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) throw new Error("proposal not found")
    if (proposal.status !== "pending") throw new Error("proposal not pending")

    const voter = this.validators.get(voterId)
    if (!voter?.active) throw new Error("voter is not an active validator")

    const updatedVotes = new Map(proposal.votes)
    updatedVotes.set(voterId, approve)
    this.proposals.set(proposalId, { ...proposal, votes: updatedVotes })

    // Check if we can resolve the proposal
    this.resolveProposal(proposalId)
  }

  /**
   * Get the current active validator set.
   */
  getActiveValidators(): ValidatorInfo[] {
    return [...this.validators.values()].filter((v) => v.active)
  }

  /**
   * Get validator by ID.
   */
  getValidator(id: string): ValidatorInfo | null {
    return this.validators.get(id) ?? null
  }

  /**
   * Get a proposal by ID.
   */
  getProposal(id: string): GovernanceProposal | null {
    return this.proposals.get(id) ?? null
  }

  /**
   * Get all proposals with optional status filter.
   */
  getProposals(status?: GovernanceProposal["status"]): GovernanceProposal[] {
    const all = [...this.proposals.values()]
    return status ? all.filter((p) => p.status === status) : all
  }

  /**
   * Get validator set as ordered list of IDs for consensus.
   */
  getValidatorIds(): string[] {
    return this.getActiveValidators()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((v) => v.id)
  }

  /**
   * Count active validators.
   */
  activeCount(): number {
    let count = 0
    for (const v of this.validators.values()) {
      if (v.active) count++
    }
    return count
  }

  private resolveProposal(proposalId: string): void {
    const proposal = this.proposals.get(proposalId)
    if (!proposal || proposal.status !== "pending") return

    const activeValidators = this.getActiveValidators()
    const totalPower = activeValidators.reduce((sum, v) => sum + v.votingPower, 0)

    // Check minimum participation
    let votedPower = 0
    for (const [voterId] of proposal.votes) {
      const v = this.validators.get(voterId)
      if (v?.active) votedPower += v.votingPower
    }

    // votingPower is in basis points (0-10000); config thresholds are in percent (0-100)
    const participationPercent = totalPower > 0 ? (votedPower * 100) / totalPower : 0
    if (participationPercent < this.config.minVoterPercent) return

    // Count approval voting power
    let approvalPower = 0
    for (const [voterId, approve] of proposal.votes) {
      if (approve) {
        const v = this.validators.get(voterId)
        if (v?.active) approvalPower += v.votingPower
      }
    }

    const approvalPercent = totalPower > 0 ? (approvalPower * 100) / totalPower : 0

    if (approvalPercent >= this.config.approvalThresholdPercent) {
      this.executeProposal(proposal)
      this.proposals.set(proposalId, { ...proposal, status: "approved" })
    } else if (participationPercent >= 100) {
      // All voted but not enough approval
      this.proposals.set(proposalId, { ...proposal, status: "rejected" })
    }
  }

  private executeProposal(proposal: GovernanceProposal): void {
    switch (proposal.type) {
      case "add_validator": {
        this.validators.set(proposal.targetId, {
          id: proposal.targetId,
          address: proposal.targetAddress!,
          stake: proposal.stakeAmount ?? this.config.minStake,
          joinedAtEpoch: this.currentEpoch,
          active: true,
          votingPower: 0,
        })
        this.recalcVotingPower()
        break
      }
      case "remove_validator": {
        const v = this.validators.get(proposal.targetId)
        if (v) {
          this.validators.set(proposal.targetId, { ...v, active: false })
          this.recalcVotingPower()
        }
        break
      }
      case "update_stake": {
        const v = this.validators.get(proposal.targetId)
        if (v && proposal.stakeAmount !== undefined) {
          this.validators.set(proposal.targetId, { ...v, stake: proposal.stakeAmount })
          this.recalcVotingPower()
        }
        break
      }
    }
  }

  /**
   * Apply a slashing penalty to a validator's stake (direct reduction).
   * Used by BFT slashing handler for equivocation penalties.
   */
  applySlash(validatorId: string, amount: bigint): void {
    const v = this.validators.get(validatorId)
    if (!v || !v.active) return
    const newStake = v.stake > amount ? v.stake - amount : 0n
    this.validators.set(validatorId, { ...v, stake: newStake })
    this.recalcVotingPower()
  }

  /**
   * Deactivate a validator directly (e.g., after slash below minimum stake).
   */
  deactivateValidator(validatorId: string): void {
    const v = this.validators.get(validatorId)
    if (!v || !v.active) return
    this.validators.set(validatorId, { ...v, active: false })
    this.recalcVotingPower()
  }

  /**
   * Get the minimum stake threshold from config.
   */
  getMinStake(): bigint {
    return this.config.minStake
  }

  private recalcVotingPower(): void {
    const active = this.getActiveValidators()
    const totalStake = active.reduce((sum, v) => sum + v.stake, 0n)

    for (const v of active) {
      const power = totalStake > 0n ? Number((v.stake * 10000n) / totalStake) : 0
      this.validators.set(v.id, { ...v, votingPower: power })
    }
  }
}
