import type { IChainEngine, ISnapshotSyncEngine, IBlockSyncEngine } from "./chain-engine-types.ts"
import type { P2PNode } from "./p2p.ts"
import type { BftCoordinator } from "./bft-coordinator.ts"
import type { ForkCandidate } from "./fork-choice.ts"
import { shouldSwitchFork } from "./fork-choice.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("consensus")

const MAX_CONSECUTIVE_FAILURES = 5
const RECOVERY_COOLDOWN_MS = 30_000

export interface ConsensusConfig {
  blockTimeMs: number
  syncIntervalMs: number
  enableSnapSync?: boolean
  snapSyncThreshold?: number
}

export type ConsensusStatus = "healthy" | "degraded" | "recovering"

export interface SnapSyncProvider {
  fetchStateSnapshot(peerUrl: string): Promise<{
    stateRoot: string
    blockHeight: string
    blockHash: string
    accounts: Array<{
      address: string
      nonce: string
      balance: string
      storageRoot: string
      codeHash: string
      storage: Array<{ slot: string; value: string }>
      code?: string
    }>
    version: number
    createdAtMs: number
  } | null>
  importStateSnapshot(snapshot: unknown): Promise<{ accountsImported: number; codeImported: number }>
  setStateRoot(root: string): Promise<void>
}

export interface ConsensusMetrics {
  blocksProposed: number
  blocksAdopted: number
  proposeFailed: number
  syncAttempts: number
  syncAdoptions: number
  snapSyncs: number
  avgProposeMs: number
  avgSyncMs: number
  lastProposeMs: number
  lastSyncMs: number
  startedAtMs: number
  uptimeMs: number
}

export class ConsensusEngine {
  private readonly chain: IChainEngine
  private readonly p2p: P2PNode
  private readonly cfg: ConsensusConfig
  private readonly bft: BftCoordinator | null
  private readonly snapSync: SnapSyncProvider | null
  private proposeFailures = 0
  private syncFailures = 0
  private status: ConsensusStatus = "healthy"
  private lastRecoveryMs = 0
  private proposeTimer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null

  // Metrics tracking
  private blocksProposed = 0
  private blocksAdopted = 0
  private proposeFailed = 0
  private syncAttempts = 0
  private syncAdoptions = 0
  private snapSyncs = 0
  private totalProposeMs = 0
  private totalSyncMs = 0
  private lastProposeMs = 0
  private lastSyncMs = 0
  private startedAtMs = 0

  /** Optional callback to broadcast blocks via wire protocol (TCP) */
  private readonly wireBroadcast: ((block: ChainBlock) => void) | null

  constructor(
    chain: IChainEngine,
    p2p: P2PNode,
    cfg: ConsensusConfig,
    opts?: { bft?: BftCoordinator; snapSync?: SnapSyncProvider; wireBroadcast?: (block: ChainBlock) => void },
  ) {
    this.chain = chain
    this.p2p = p2p
    this.cfg = cfg
    this.bft = opts?.bft ?? null
    this.snapSync = opts?.snapSync ?? null
    this.wireBroadcast = opts?.wireBroadcast ?? null
  }

  start(): void {
    this.startedAtMs = Date.now()
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

  getMetrics(): ConsensusMetrics {
    const now = Date.now()
    const proposeCount = this.blocksProposed + this.proposeFailed
    const syncCount = this.syncAttempts
    return {
      blocksProposed: this.blocksProposed,
      blocksAdopted: this.blocksAdopted,
      proposeFailed: this.proposeFailed,
      syncAttempts: this.syncAttempts,
      syncAdoptions: this.syncAdoptions,
      snapSyncs: this.snapSyncs,
      avgProposeMs: proposeCount > 0 ? Math.round(this.totalProposeMs / proposeCount) : 0,
      avgSyncMs: syncCount > 0 ? Math.round(this.totalSyncMs / syncCount) : 0,
      lastProposeMs: this.lastProposeMs,
      lastSyncMs: this.lastSyncMs,
      startedAtMs: this.startedAtMs,
      uptimeMs: this.startedAtMs > 0 ? now - this.startedAtMs : 0,
    }
  }

  private async tryPropose(): Promise<void> {
    if (this.status === "degraded") {
      return
    }

    const t0 = Date.now()
    try {
      const block = await this.chain.proposeNextBlock()
      if (!block) {
        return
      }

      this.proposeFailures = 0
      this.blocksProposed++

      // If BFT is enabled, start a BFT round instead of directly broadcasting
      if (this.bft) {
        try {
          await this.bft.startRound(block)
        } catch (bftErr) {
          // BFT failed to start — fallback to direct broadcast
          log.warn("BFT round start failed, falling back to direct broadcast", {
            error: String(bftErr),
            block: block.number.toString(),
          })
          await this.broadcastBlock(block)
        }
      } else {
        await this.broadcastBlock(block)
      }

      this.lastProposeMs = Date.now() - t0
      this.totalProposeMs += this.lastProposeMs

      if (this.status === "recovering") {
        this.status = "healthy"
        log.info("recovered from degraded mode via successful propose")
      }
    } catch (error) {
      this.proposeFailed++
      this.proposeFailures++
      this.lastProposeMs = Date.now() - t0
      this.totalProposeMs += this.lastProposeMs
      log.error("propose failed", { error: String(error), consecutive: this.proposeFailures })

      if (this.status === "recovering") {
        this.enterDegradedMode("recovery-propose")
      } else if (this.proposeFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.enterDegradedMode("propose")
      }
    }
  }

  private async broadcastBlock(block: ChainBlock): Promise<void> {
    // HTTP gossip broadcast
    try {
      await this.p2p.receiveBlock(block)
    } catch (broadcastErr) {
      log.warn("block produced but HTTP broadcast failed", {
        error: String(broadcastErr),
        block: block.number.toString(),
      })
    }

    // Wire protocol TCP broadcast (if enabled)
    if (this.wireBroadcast) {
      try {
        this.wireBroadcast(block)
      } catch (wireErr) {
        log.warn("wire broadcast failed", {
          error: String(wireErr),
          block: block.number.toString(),
        })
      }
    }
  }

  private async trySync(): Promise<void> {
    const t0 = Date.now()
    this.syncAttempts++
    try {
      const snapshots = await this.p2p.fetchSnapshots()

      // Build local fork candidate
      const localHeight = await Promise.resolve(this.chain.getHeight())
      const localTip = await Promise.resolve(this.chain.getTip())
      const localCandidate: ForkCandidate = {
        height: localHeight,
        tipHash: localTip?.hash ?? ("0x0" as Hex),
        bftFinalized: localTip?.bftFinalized ?? false,
        cumulativeWeight: localHeight,
        peerId: "local",
      }

      let adopted = false

      const snapshotEngine = this.chain as ISnapshotSyncEngine
      const blockEngine = this.chain as IBlockSyncEngine

      for (const snapshot of snapshots) {
        if (!Array.isArray(snapshot.blocks) || snapshot.blocks.length === 0) continue

        // Build remote fork candidate from snapshot tip
        const remoteTip = snapshot.blocks[snapshot.blocks.length - 1]
        const remoteCandidate: ForkCandidate = {
          height: BigInt(remoteTip.number),
          tipHash: remoteTip.hash,
          bftFinalized: remoteTip.bftFinalized ?? false,
          cumulativeWeight: BigInt(remoteTip.number),
          peerId: "remote",
        }

        // Use fork choice rule to decide whether to switch
        const switchResult = shouldSwitchFork(localCandidate, remoteCandidate)
        if (!switchResult) continue

        log.info("fork choice: switching to remote chain", {
          reason: switchResult.reason,
          localHeight: localHeight.toString(),
          remoteHeight: remoteCandidate.height.toString(),
        })

        // Check if snap sync should be used (large gap)
        const gap = remoteCandidate.height - localHeight
        if (
          this.cfg.enableSnapSync &&
          this.snapSync &&
          gap > BigInt(this.cfg.snapSyncThreshold ?? 100)
        ) {
          const ok = await this.trySnapSync(snapshot)
          adopted = adopted || ok
          continue
        }

        let ok = false
        if (typeof snapshotEngine.makeSnapshot === "function") {
          ok = await snapshotEngine.maybeAdoptSnapshot(snapshot)
        } else if (typeof blockEngine.maybeAdoptSnapshot === "function") {
          ok = await blockEngine.maybeAdoptSnapshot(snapshot.blocks)
        }
        if (ok) this.blocksAdopted++
        adopted = adopted || ok
      }

      if (adopted) {
        this.syncAdoptions++
        const height = await Promise.resolve(this.chain.getHeight())
        log.info("sync adopted new tip", { height: height.toString() })
      }

      this.lastSyncMs = Date.now() - t0
      this.totalSyncMs += this.lastSyncMs
      this.syncFailures = 0
      if (this.status === "degraded" || this.status === "recovering") {
        this.tryRecover()
      }
    } catch (error) {
      this.lastSyncMs = Date.now() - t0
      this.totalSyncMs += this.lastSyncMs
      this.syncFailures++
      log.error("sync failed", { error: String(error), consecutive: this.syncFailures })

      if (this.syncFailures >= MAX_CONSECUTIVE_FAILURES && this.status === "healthy") {
        this.enterDegradedMode("sync")
      }
    }
  }

  private async trySnapSync(snapshot: { blocks: ChainBlock[] }): Promise<boolean> {
    if (!this.snapSync) return false

    const tip = snapshot.blocks[snapshot.blocks.length - 1]
    if (!tip) return false

    try {
      // Fetch state snapshot from the peer that provided this chain snapshot
      const peers = this.p2p.discovery.getActivePeers()
      for (const peer of peers) {
        try {
          const stateSnap = await this.snapSync.fetchStateSnapshot(peer.url)
          if (!stateSnap) continue

          await this.snapSync.importStateSnapshot(stateSnap)
          await this.snapSync.setStateRoot(stateSnap.stateRoot)
          this.snapSyncs++
          log.info("snap sync complete", {
            accounts: stateSnap.accounts.length,
            blockHeight: stateSnap.blockHeight,
          })
          return true
        } catch {
          // try next peer
        }
      }
    } catch (error) {
      log.warn("snap sync failed, falling back to block replay", { error: String(error) })
    }
    return false
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
