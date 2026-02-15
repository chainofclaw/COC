import type { IChainEngine, ISnapshotSyncEngine, IBlockSyncEngine, resolveValue } from "./chain-engine-types.ts"
import type { P2PNode } from "./p2p.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("consensus")

const MAX_CONSECUTIVE_FAILURES = 5
const RECOVERY_COOLDOWN_MS = 30_000

export interface ConsensusConfig {
  blockTimeMs: number
  syncIntervalMs: number
}

export type ConsensusStatus = "healthy" | "degraded" | "recovering"

export class ConsensusEngine {
  private readonly chain: IChainEngine
  private readonly p2p: P2PNode
  private readonly cfg: ConsensusConfig
  private proposeFailures = 0
  private syncFailures = 0
  private status: ConsensusStatus = "healthy"
  private lastRecoveryMs = 0
  private proposeTimer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null

  constructor(chain: IChainEngine, p2p: P2PNode, cfg: ConsensusConfig) {
    this.chain = chain
    this.p2p = p2p
    this.cfg = cfg
  }

  start(): void {
    this.proposeTimer = setInterval(() => void this.tryPropose(), this.cfg.blockTimeMs)
    this.syncTimer = setInterval(() => void this.trySync(), this.cfg.syncIntervalMs)
    void this.trySync()
  }

  stop(): void {
    if (this.proposeTimer) { clearInterval(this.proposeTimer); this.proposeTimer = null }
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null }
  }

  getStatus(): { status: ConsensusStatus; proposeFailures: number; syncFailures: number } {
    return { status: this.status, proposeFailures: this.proposeFailures, syncFailures: this.syncFailures }
  }

  private async tryPropose(): Promise<void> {
    // Skip proposing in degraded mode (recovering is allowed as a test)
    if (this.status === "degraded") {
      return
    }

    try {
      const block = await this.chain.proposeNextBlock()
      if (!block) {
        return
      }

      // Block produced successfully — reset propose failures regardless of broadcast
      this.proposeFailures = 0

      // Broadcast to peers (best-effort, failure doesn't affect local state)
      try {
        await this.p2p.receiveBlock(block)
      } catch (broadcastErr) {
        log.warn("block produced but broadcast failed", { error: String(broadcastErr), block: block.number.toString() })
      }

      // Successful propose during recovery -> healthy
      if (this.status === "recovering") {
        this.status = "healthy"
        log.info("recovered from degraded mode via successful propose")
      }
    } catch (error) {
      this.proposeFailures++
      log.error("propose failed", { error: String(error), consecutive: this.proposeFailures })

      if (this.status === "recovering") {
        // Failed propose during recovery -> back to degraded
        this.enterDegradedMode("recovery-propose")
      } else if (this.proposeFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.enterDegradedMode("propose")
      }
    }
  }

  private async trySync(): Promise<void> {
    try {
      const snapshots = await this.p2p.fetchSnapshots()
      let adopted = false

      const snapshotEngine = this.chain as ISnapshotSyncEngine
      const blockEngine = this.chain as IBlockSyncEngine

      for (const snapshot of snapshots) {
        let ok = false
        if (typeof snapshotEngine.makeSnapshot === "function" && Array.isArray(snapshot.blocks)) {
          ok = await snapshotEngine.maybeAdoptSnapshot(snapshot)
        } else if (typeof blockEngine.maybeAdoptSnapshot === "function" && Array.isArray(snapshot.blocks)) {
          ok = await blockEngine.maybeAdoptSnapshot(snapshot.blocks)
        }
        adopted = adopted || ok
      }

      if (adopted) {
        const height = await Promise.resolve(this.chain.getHeight())
        log.info("sync adopted new tip", { height: height.toString() })
      }

      this.syncFailures = 0
      // Successful sync can recover from degraded mode
      if (this.status === "degraded" || this.status === "recovering") {
        this.tryRecover()
      }
    } catch (error) {
      this.syncFailures++
      log.error("sync failed", { error: String(error), consecutive: this.syncFailures })

      if (this.syncFailures >= MAX_CONSECUTIVE_FAILURES && this.status === "healthy") {
        this.enterDegradedMode("sync")
      }
    }
  }

  private enterDegradedMode(source: string): void {
    this.status = "degraded"
    log.warn("entering degraded mode", { source, proposeFailures: this.proposeFailures, syncFailures: this.syncFailures })
  }

  private tryRecover(): void {
    const now = Date.now()
    if (now - this.lastRecoveryMs < RECOVERY_COOLDOWN_MS) return

    this.lastRecoveryMs = now
    this.status = "recovering"
    this.proposeFailures = 0
    this.syncFailures = 0
    log.info("entering recovery mode, next propose will determine health")
  }
}
