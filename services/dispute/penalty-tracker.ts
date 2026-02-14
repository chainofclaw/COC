/**
 * PenaltyTracker - Cumulative penalty tracking per node.
 *
 * Tracks penalty history over time, applies decay,
 * and determines if nodes should be suspended or ejected.
 */

import type { Hex32 } from "../common/pose-types.ts"
import type { EvidenceReasonCode } from "../verifier/anti-cheat-policy.ts"
import { EvidenceReason } from "../verifier/anti-cheat-policy.ts"

export interface PenaltyRecord {
  nodeId: Hex32
  reasonCode: EvidenceReasonCode
  points: number
  timestamp: number
  epochId: bigint
}

export interface NodePenaltyState {
  nodeId: Hex32
  totalPoints: number
  records: PenaltyRecord[]
  suspended: boolean
  suspendedUntil: number
}

export interface PenaltyConfig {
  suspendThreshold: number
  ejectThreshold: number
  decayRatePerHour: number
  suspendDurationMs: number
  maxRecordsPerNode: number
}

const DEFAULT_CONFIG: PenaltyConfig = {
  suspendThreshold: 50,
  ejectThreshold: 100,
  decayRatePerHour: 2,
  suspendDurationMs: 3_600_000, // 1 hour
  maxRecordsPerNode: 100,
}

// Points assigned per evidence reason
const PENALTY_POINTS: Record<number, number> = {
  [EvidenceReason.ReplayNonce]: 20,
  [EvidenceReason.InvalidSignature]: 15,
  [EvidenceReason.Timeout]: 5,
  [EvidenceReason.StorageProofInvalid]: 30,
  [EvidenceReason.MissingReceipt]: 10,
}

export class PenaltyTracker {
  private readonly config: PenaltyConfig
  private readonly nodes: Map<Hex32, NodePenaltyState> = new Map()
  private readonly ejectedNodes: Set<Hex32> = new Set()

  constructor(config?: Partial<PenaltyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Record a penalty for a node.
   */
  recordPenalty(nodeId: Hex32, reasonCode: EvidenceReasonCode, epochId: bigint): NodePenaltyState {
    if (this.ejectedNodes.has(nodeId)) {
      return this.getOrCreateState(nodeId)
    }

    const state = this.getOrCreateState(nodeId)
    const points = PENALTY_POINTS[reasonCode] ?? 10

    const record: PenaltyRecord = {
      nodeId,
      reasonCode,
      points,
      timestamp: Date.now(),
      epochId,
    }

    const updatedRecords = [...state.records, record].slice(-this.config.maxRecordsPerNode)
    const updatedState: NodePenaltyState = {
      ...state,
      totalPoints: state.totalPoints + points,
      records: updatedRecords,
    }

    // Check thresholds
    if (updatedState.totalPoints >= this.config.ejectThreshold) {
      this.ejectedNodes.add(nodeId)
      this.nodes.set(nodeId, { ...updatedState, suspended: true, suspendedUntil: Infinity })
    } else if (updatedState.totalPoints >= this.config.suspendThreshold) {
      this.nodes.set(nodeId, {
        ...updatedState,
        suspended: true,
        suspendedUntil: Date.now() + this.config.suspendDurationMs,
      })
    } else {
      this.nodes.set(nodeId, updatedState)
    }

    return this.nodes.get(nodeId)!
  }

  /**
   * Apply time-based decay to all penalty points.
   */
  applyDecay(): void {
    const now = Date.now()

    for (const [nodeId, state] of this.nodes) {
      if (this.ejectedNodes.has(nodeId)) continue

      // Decay points based on time since last record
      const lastRecord = state.records[state.records.length - 1]
      if (!lastRecord) continue

      const hoursSinceLastPenalty = (now - lastRecord.timestamp) / 3_600_000
      const decay = Math.floor(hoursSinceLastPenalty * this.config.decayRatePerHour)
      const newTotal = Math.max(0, state.totalPoints - decay)

      // Unsuspend if below threshold and past suspension time
      const suspended = newTotal >= this.config.suspendThreshold || now < state.suspendedUntil

      this.nodes.set(nodeId, {
        ...state,
        totalPoints: newTotal,
        suspended,
        suspendedUntil: suspended ? state.suspendedUntil : 0,
      })
    }
  }

  /**
   * Check if a node is currently penalized (suspended or ejected).
   */
  isPenalized(nodeId: Hex32): boolean {
    if (this.ejectedNodes.has(nodeId)) return true
    const state = this.nodes.get(nodeId)
    if (!state) return false
    return state.suspended && Date.now() < state.suspendedUntil
  }

  /**
   * Check if a node has been permanently ejected.
   */
  isEjected(nodeId: Hex32): boolean {
    return this.ejectedNodes.has(nodeId)
  }

  /**
   * Get penalty state for a node.
   */
  getState(nodeId: Hex32): NodePenaltyState | null {
    return this.nodes.get(nodeId) ?? null
  }

  /**
   * Get all currently penalized nodes.
   */
  getPenalizedNodes(): NodePenaltyState[] {
    const now = Date.now()
    return [...this.nodes.values()].filter(
      (s) => s.suspended && (now < s.suspendedUntil || this.ejectedNodes.has(s.nodeId)),
    )
  }

  /**
   * Get summary statistics.
   */
  stats(): { tracked: number; suspended: number; ejected: number } {
    const now = Date.now()
    let suspended = 0
    for (const state of this.nodes.values()) {
      if (state.suspended && now < state.suspendedUntil) suspended++
    }
    return {
      tracked: this.nodes.size,
      suspended,
      ejected: this.ejectedNodes.size,
    }
  }

  private getOrCreateState(nodeId: Hex32): NodePenaltyState {
    const existing = this.nodes.get(nodeId)
    if (existing) return existing

    const state: NodePenaltyState = {
      nodeId,
      totalPoints: 0,
      records: [],
      suspended: false,
      suspendedUntil: 0,
    }
    this.nodes.set(nodeId, state)
    return state
  }
}
