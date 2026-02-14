/**
 * DisputeLogger - Event logging and query interface for disputes.
 *
 * Records all dispute-related events (challenges, slashes, resolutions)
 * and provides a query API for monitoring and debugging.
 */

import type { Hex32 } from "../common/pose-types.ts"
import type { EvidenceReasonCode } from "../verifier/anti-cheat-policy.ts"

export type DisputeEventType =
  | "challenge_issued"
  | "receipt_verified"
  | "receipt_failed"
  | "evidence_created"
  | "slash_submitted"
  | "slash_confirmed"
  | "batch_disputed"
  | "epoch_finalized"

export interface DisputeEvent {
  id: number
  type: DisputeEventType
  timestamp: number
  epochId: bigint
  nodeId?: Hex32
  batchId?: Hex32
  reasonCode?: EvidenceReasonCode
  txHash?: string
  details: Record<string, unknown>
}

export interface EventFilter {
  type?: DisputeEventType
  nodeId?: Hex32
  epochId?: bigint
  fromTimestamp?: number
  toTimestamp?: number
  limit?: number
}

export class DisputeLogger {
  private readonly events: DisputeEvent[] = []
  private readonly maxEvents: number
  private nextId = 1

  constructor(maxEvents = 10_000) {
    this.maxEvents = maxEvents
  }

  /**
   * Log a dispute event.
   */
  log(
    type: DisputeEventType,
    epochId: bigint,
    details: Record<string, unknown>,
    opts?: { nodeId?: Hex32; batchId?: Hex32; reasonCode?: EvidenceReasonCode; txHash?: string },
  ): DisputeEvent {
    const event: DisputeEvent = {
      id: this.nextId++,
      type,
      timestamp: Date.now(),
      epochId,
      nodeId: opts?.nodeId,
      batchId: opts?.batchId,
      reasonCode: opts?.reasonCode,
      txHash: opts?.txHash,
      details,
    }

    if (this.events.length >= this.maxEvents) {
      this.events.shift()
    }
    this.events.push(event)

    return event
  }

  /**
   * Query dispute events with filters.
   */
  query(filter: EventFilter): DisputeEvent[] {
    const limit = filter.limit ?? 100
    let results = this.events

    if (filter.type) {
      results = results.filter((e) => e.type === filter.type)
    }
    if (filter.nodeId) {
      results = results.filter((e) => e.nodeId === filter.nodeId)
    }
    if (filter.epochId !== undefined) {
      results = results.filter((e) => e.epochId === filter.epochId)
    }
    if (filter.fromTimestamp !== undefined) {
      results = results.filter((e) => e.timestamp >= filter.fromTimestamp!)
    }
    if (filter.toTimestamp !== undefined) {
      results = results.filter((e) => e.timestamp <= filter.toTimestamp!)
    }

    // Return newest first, limited
    return results.slice(-limit).reverse()
  }

  /**
   * Get event counts grouped by type.
   */
  summary(): Record<DisputeEventType, number> {
    const counts: Record<string, number> = {}
    for (const event of this.events) {
      counts[event.type] = (counts[event.type] ?? 0) + 1
    }
    return counts as Record<DisputeEventType, number>
  }

  /**
   * Get events for a specific node.
   */
  getNodeHistory(nodeId: Hex32, limit = 50): DisputeEvent[] {
    return this.query({ nodeId, limit })
  }

  /**
   * Get the total number of logged events.
   */
  get size(): number {
    return this.events.length
  }
}
