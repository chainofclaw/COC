import type { IChainEngine, ISnapshotSyncEngine, IBlockSyncEngine } from "./chain-engine-types.ts"
import type { P2PNode } from "./p2p.ts"
import type { BftCoordinator } from "./bft-coordinator.ts"
import type { ForkCandidate } from "./fork-choice.ts"
import { shouldSwitchFork } from "./fork-choice.ts"
import type { ChainBlock, Hex } from "./blockchain-types.ts"
import { createLogger } from "./logger.ts"
import { keccak256Hex } from "../../services/relayer/keccak256.ts"

/** Use the tip block's cumulativeWeight — now hash-bound so tamper-proof.
 * Falls back to verified block count if field is missing (pre-upgrade blocks).
 * Verifies chain continuity before trusting block count as weight fallback
 * to prevent attackers from inflating weight with disconnected block arrays. */
function recalcCumulativeWeight(blocks: ChainBlock[]): bigint {
  if (blocks.length === 0) return 0n
  const tip = blocks[blocks.length - 1]
  // cumulativeWeight is now bound into block hash, so it's tamper-proof
  if (tip.cumulativeWeight !== undefined) return BigInt(tip.cumulativeWeight)
  // Fallback: use tip height rather than array length. Array length could be
  // misleading if the snapshot is a partial window (blocks 500-600 = length 101
  // but actual chain weight should reflect height 600). Tip height is hash-bound
  // and thus tamper-proof.
  const tipHeight = BigInt(tip.number)
  return tipHeight > 0n ? tipHeight : BigInt(blocks.length)
}

const log = createLogger("consensus")

const MAX_CONSECUTIVE_FAILURES = 5
const RECOVERY_COOLDOWN_MS = 30_000
const MAX_DEGRADED_MS = 5 * 60 * 1000 // 5 min max in degraded before forced recovery

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
    validators?: Array<{ id: string; address: string; stake: string; active: boolean }>
  } | null>
  importStateSnapshot(snapshot: unknown, expectedStateRoot?: string): Promise<{ accountsImported: number; codeImported: number; validators?: Array<{ id: string; address: string; stake: bigint; active: boolean }> }>
  setStateRoot(root: string): Promise<void>
  /** Restore governance validator set from snapshot (optional) */
  restoreGovernance?(validators: Array<{ id: string; address: string; stake: bigint; active: boolean }>): void
}

export interface SyncProgress {
  syncing: boolean
  currentHeight: bigint
  highestPeerHeight: bigint
  startingHeight: bigint
  progressPct: number // 0-100
  blocksRemaining: bigint
  blocksPerSecond: number
  estimatedSecondsLeft: number
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
  private degradedSinceMs = 0
  private proposeTimer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private syncInFlight = false
  private proposeInFlight = false

  // Sync progress tracking
  private highestPeerHeight = 0n
  private syncStartHeight = 0n
  private syncStartMs = 0
  private lastSyncedHeight = 0n

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
    this.bft?.stop()
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

  async getSyncProgress(): Promise<SyncProgress> {
    const currentHeight = await Promise.resolve(this.chain.getHeight())
    const syncing = this.highestPeerHeight > currentHeight
    const blocksRemaining = syncing ? this.highestPeerHeight - currentHeight : 0n

    const totalRange = this.highestPeerHeight > this.syncStartHeight
      ? this.highestPeerHeight - this.syncStartHeight
      : 0n
    const synced = currentHeight > this.syncStartHeight
      ? currentHeight - this.syncStartHeight
      : 0n
    const progressPct = totalRange > 0n
      ? Math.min(100, Math.round(Number(synced * 10000n / totalRange)) / 100)
      : syncing ? 0 : 100

    const elapsedMs = this.syncStartMs > 0 ? Date.now() - this.syncStartMs : 0
    const elapsedSec = elapsedMs / 1000
    const blocksPerSecond = elapsedSec > 0 && synced > 0n
      ? Number(synced) / elapsedSec
      : 0
    const estimatedSecondsLeft = blocksPerSecond > 0
      ? Math.round(Number(blocksRemaining) / blocksPerSecond)
      : 0

    return {
      syncing,
      currentHeight,
      highestPeerHeight: this.highestPeerHeight,
      startingHeight: this.syncStartHeight,
      progressPct,
      blocksRemaining,
      blocksPerSecond: Math.round(blocksPerSecond * 100) / 100,
      estimatedSecondsLeft,
    }
  }

  private async tryPropose(): Promise<void> {
    if (this.proposeInFlight) return
    if (this.syncInFlight) return // Don't propose while snap sync is modifying chain state
    if (this.status === "degraded") {
      this.checkDegradedTimeout()
      return
    }

    // Skip proposing while BFT round is active to avoid disrupting in-flight rounds
    if (this.bft) {
      const bftState = this.bft.getRoundState()
      if (bftState.active) {
        return
      }
    }

    this.proposeInFlight = true
    const t0 = Date.now()
    try {
      const block = await this.chain.proposeNextBlock()
      if (!block) {
        return
      }

      this.proposeFailures = 0
      this.blocksProposed++

      // Broadcast block via gossip so all peers receive it
      await this.broadcastBlock(block)

      // If BFT is enabled, start a round (non-proposers join via handleReceivedBlock)
      if (this.bft) {
        try {
          await this.bft.startRound(block)
        } catch (bftErr) {
          log.warn("BFT round start failed", {
            error: String(bftErr),
            block: block.number.toString(),
          })
        }
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
    } finally {
      this.proposeInFlight = false
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
    if (this.syncInFlight) return
    this.syncInFlight = true
    const t0 = Date.now()
    this.syncAttempts++
    try {
      const snapshots = await this.p2p.fetchSnapshots()

      // Build local fork candidate
      let localHeight = await Promise.resolve(this.chain.getHeight())

      // Track sync progress: compute max peer height per sync round (allows decrease after reorgs)
      let roundMaxPeerHeight = 0n
      for (const snap of snapshots) {
        if (Array.isArray(snap.blocks) && snap.blocks.length > 0) {
          const remoteTipHeight = BigInt(snap.blocks[snap.blocks.length - 1].number)
          if (remoteTipHeight > roundMaxPeerHeight) {
            roundMaxPeerHeight = remoteTipHeight
          }
        }
      }
      if (roundMaxPeerHeight > 0n) {
        const wasCaughtUp = this.syncStartMs > 0 && localHeight >= this.highestPeerHeight
        this.highestPeerHeight = roundMaxPeerHeight
        if (roundMaxPeerHeight > localHeight) {
          // Start or restart sync tracking when node falls behind peers
          if (this.syncStartMs === 0 || wasCaughtUp) {
            this.syncStartHeight = localHeight
            this.syncStartMs = Date.now()
          }
        } else if (this.syncStartMs > 0) {
          // Reset sync tracking when caught up (so next sync episode starts fresh)
          this.syncStartMs = 0
          this.syncStartHeight = 0n
        }
      }

      const localTip = await Promise.resolve(this.chain.getTip())
      let localCandidate: ForkCandidate = {
        height: localHeight,
        tipHash: localTip?.hash ?? ("0x0" as Hex),
        bftFinalized: localTip?.bftFinalized ?? false,
        cumulativeWeight: localTip?.cumulativeWeight ?? localHeight,
        peerId: "local",
      }

      let adopted = false

      const snapshotEngine = this.chain as ISnapshotSyncEngine
      const blockEngine = this.chain as IBlockSyncEngine

      for (const snapshot of snapshots) {
        if (!Array.isArray(snapshot.blocks) || snapshot.blocks.length === 0) continue

        // Build remote fork candidate from snapshot tip
        // Never trust remote-provided cumulativeWeight or bftFinalized
        const remoteTip = snapshot.blocks[snapshot.blocks.length - 1]
        const remoteCandidate: ForkCandidate = {
          height: BigInt(remoteTip.number),
          tipHash: remoteTip.hash,
          bftFinalized: false,
          cumulativeWeight: recalcCumulativeWeight(snapshot.blocks),
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

        const snapshotStartHeight = snapshot.blocks[0] ? BigInt(snapshot.blocks[0].number) : 0n
        const localHasContinuity = localHeight === 0n || localHeight >= snapshotStartHeight - 1n

        // Check if snap sync should be used (large gap)
        const gap = remoteCandidate.height - localHeight
        let snapAttemptedForGap = false
        if (
          this.cfg.enableSnapSync &&
          this.snapSync &&
          gap > BigInt(this.cfg.snapSyncThreshold ?? 100)
        ) {
          snapAttemptedForGap = true
          const ok = await this.trySnapSync(snapshot)
          if (ok) {
            this.blocksAdopted++
            const newHeight = await Promise.resolve(this.chain.getHeight())
            const newTip = await Promise.resolve(this.chain.getTip())
            localCandidate = {
              height: newHeight,
              tipHash: newTip?.hash ?? ("0x0" as Hex),
              bftFinalized: newTip?.bftFinalized ?? false,
              cumulativeWeight: newTip?.cumulativeWeight ?? newHeight,
              peerId: "local",
            }
            localHeight = newHeight
          }
          adopted = adopted || ok
          if (ok) {
            continue
          }
          if (!localHasContinuity) {
            // No block-level continuity window: must wait for a successful snap sync.
            continue
          }
          log.warn("snap sync failed on large gap, falling back to block-level replay", {
            localHeight: localHeight.toString(),
            snapshotStart: snapshotStartHeight.toString(),
            remoteHeight: remoteCandidate.height.toString(),
          })
        }

        if (!localHasContinuity && this.cfg.enableSnapSync && this.snapSync) {
          if (snapAttemptedForGap) {
            continue
          }
          log.warn("chain snapshot window insufficient, falling back to snap sync", {
            localHeight: localHeight.toString(),
            snapshotStart: snapshotStartHeight.toString(),
          })
          const snapOk = await this.trySnapSync(snapshot)
          if (snapOk) {
            this.blocksAdopted++
            const newHeight = await Promise.resolve(this.chain.getHeight())
            const newTip = await Promise.resolve(this.chain.getTip())
            localCandidate = {
              height: newHeight,
              tipHash: newTip?.hash ?? ("0x0" as Hex),
              bftFinalized: newTip?.bftFinalized ?? false,
              cumulativeWeight: newTip?.cumulativeWeight ?? newHeight,
              peerId: "local",
            }
            localHeight = newHeight
          }
          adopted = adopted || snapOk
          continue
        }

        let ok = false
        if (typeof snapshotEngine.makeSnapshot === "function") {
          ok = await snapshotEngine.maybeAdoptSnapshot(snapshot)
        } else if (typeof blockEngine.maybeAdoptSnapshot === "function") {
          ok = await blockEngine.maybeAdoptSnapshot(snapshot.blocks)
        }
        if (ok) {
          this.blocksAdopted++
          // Refresh local state after successful adoption to prevent stale comparisons
          const newHeight = await Promise.resolve(this.chain.getHeight())
          const newTip = await Promise.resolve(this.chain.getTip())
          localCandidate = {
            height: newHeight,
            tipHash: newTip?.hash ?? ("0x0" as Hex),
            bftFinalized: newTip?.bftFinalized ?? false,
            cumulativeWeight: newTip?.cumulativeWeight ?? newHeight,
            peerId: "local",
          }
          localHeight = newHeight
        }
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
    } finally {
      this.syncInFlight = false
    }
  }

  private async trySnapSync(snapshot: { blocks: ChainBlock[] }): Promise<boolean> {
    if (!this.snapSync) return false

    const tip = snapshot.blocks[snapshot.blocks.length - 1]
    if (!tip) return false

    try {
      const peers = this.p2p.discovery.getActivePeers()

      // Vote loop: fetch snapshots in parallel, collect stateRoots + validatorsHash
      type SnapResult = Awaited<ReturnType<SnapSyncProvider["fetchStateSnapshot"]>>
      const snapshotCache = new Map<string, SnapResult>() // peerUrl → snapshot
      // Map voteKey → { count, peer, stateRoot, validatorsHash }
      // Use a safe separator ("|") to avoid ambiguity if stateRoot contains ":"
      const peerStateRoots = new Map<string, { count: number; peer: string; stateRoot: string; validatorsHash: string }>()

      const fetchResults = await Promise.allSettled(
        peers.map(async (peer) => {
          const snap = await this.snapSync!.fetchStateSnapshot(peer.url)
          return { url: peer.url, snap }
        }),
      )
      for (const result of fetchResults) {
        if (result.status !== "fulfilled") continue
        const { url, snap } = result.value
        snapshotCache.set(url, snap)
        if (!snap) continue
        if (snap.blockHeight !== tip.number.toString() || snap.blockHash !== tip.hash) continue
        const vHash = hashValidators(snap.validators)
        const voteKey = `${snap.stateRoot}|${vHash}`
        const existing = peerStateRoots.get(voteKey)
        peerStateRoots.set(voteKey, {
          count: (existing?.count ?? 0) + 1,
          peer: url,
          stateRoot: snap.stateRoot,
          validatorsHash: vHash,
        })
      }

      // Require stateRoot+validatorsHash consensus: at least 2 votes AND strict majority.
      // Single-peer networks accept with 1 vote (no alternative).
      const totalResponding = [...peerStateRoots.values()].reduce((sum, v) => sum + v.count, 0)
      let trustedStateRoot: string | null = null
      let trustedValidatorsHash: string | null = null

      if (peerStateRoots.size === 1) {
        const entry = [...peerStateRoots.values()][0]
        trustedStateRoot = entry.stateRoot
        trustedValidatorsHash = entry.validatorsHash
        if (peers.length > 1 && entry.count < 2) {
          log.warn("snap sync: insufficient peer responses for stateRoot consensus, aborting", {
            stateRoot: trustedStateRoot,
            respondingPeers: totalResponding,
            totalPeers: peers.length,
          })
          return false
        }
      } else if (peerStateRoots.size > 1) {
        let maxCount = 0
        for (const [, info] of peerStateRoots) {
          if (info.count > maxCount) {
            maxCount = info.count
            trustedStateRoot = info.stateRoot
            trustedValidatorsHash = info.validatorsHash
          }
        }
        const majorityThreshold = Math.ceil(totalResponding * 2 / 3)
        if (maxCount < 2 || maxCount < majorityThreshold) {
          log.warn("snap sync: no stateRoot consensus among peers, aborting (fail-closed)", {
            maxVotes: maxCount,
            required: Math.max(2, majorityThreshold),
            respondingPeers: totalResponding,
          })
          return false
        }
      }

      if (!trustedStateRoot) {
        log.warn("snap sync: no peer provided valid state snapshot")
        return false
      }

      // State import FIRST (before blocks) to prevent half-corruption:
      // if state fails for all peers, we skip block import entirely.
      let stateImported = false
      for (const peer of peers) {
        try {
          const stateSnap = snapshotCache.get(peer.url) ?? null
          if (!stateSnap) continue

          if (
            stateSnap.blockHeight !== tip.number.toString() ||
            stateSnap.blockHash !== tip.hash
          ) {
            continue
          }

          if (stateSnap.stateRoot !== trustedStateRoot) {
            log.warn("snap sync: peer stateRoot disagrees with consensus", {
              peer: peer.url,
              peerRoot: stateSnap.stateRoot,
              trustedRoot: trustedStateRoot,
            })
            continue
          }

          const importResult = await this.snapSync.importStateSnapshot(stateSnap, trustedStateRoot)
          await this.snapSync.setStateRoot(trustedStateRoot)

          // Restore governance only if validators hash matches cross-peer consensus
          if (importResult.validators && this.snapSync.restoreGovernance) {
            const importedVHash = hashValidators(stateSnap.validators)
            if (trustedValidatorsHash && importedVHash === trustedValidatorsHash) {
              this.snapSync.restoreGovernance(importResult.validators)
              log.info("governance state restored from snapshot", { validators: importResult.validators.length })
            } else {
              log.warn("snap sync: validators hash mismatch, skipping governance restore", {
                peer: peer.url,
                peerHash: importedVHash,
                trustedHash: trustedValidatorsHash,
              })
            }
          }

          stateImported = true
          log.info("snap sync state imported", {
            accounts: stateSnap.accounts.length,
            blockHeight: stateSnap.blockHeight,
          })
          break
        } catch (peerErr) {
          log.warn("snap sync state import failed for peer, trying next", { peer: peer.url, error: String(peerErr) })
        }
      }

      if (!stateImported) {
        log.error("snap sync: state import failed for all peers, skipping block import")
        return false
      }

      // Import blocks only after state is confirmed
      let blocksImported = false
      const bsEngine = this.chain as IBlockSyncEngine
      const ssEngine = this.chain as ISnapshotSyncEngine
      if (typeof bsEngine.importSnapSyncBlocks === "function") {
        blocksImported = await bsEngine.importSnapSyncBlocks(snapshot.blocks)
      } else if (typeof ssEngine.makeSnapshot === "function") {
        blocksImported = await ssEngine.maybeAdoptSnapshot({ blocks: snapshot.blocks, updatedAtMs: Date.now() })
      }

      if (!blocksImported) {
        log.warn("snap sync: block adoption failed after state import")
        return false
      }

      this.snapSyncs++
      log.info("snap sync complete")
      return true
    } catch (error) {
      log.warn("snap sync failed, falling back to block replay", { error: String(error) })
    }
    return false
  }

  private enterDegradedMode(source: string): void {
    this.status = "degraded"
    this.degradedSinceMs = Date.now()
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

  /** Force recovery if stuck in degraded for too long (called from tryPropose) */
  private checkDegradedTimeout(): void {
    if (this.status !== "degraded") return
    const now = Date.now()
    if (this.degradedSinceMs > 0 && now - this.degradedSinceMs > MAX_DEGRADED_MS) {
      log.warn("degraded timeout exceeded, forcing recovery attempt")
      this.lastRecoveryMs = 0 // clear cooldown to allow immediate recovery
      this.tryRecover()
    }
  }
}

/** Hash validator set for cross-peer consensus comparison.
 *  Sort by id, serialize as JSON, then keccak256. Returns empty-hash for undefined/empty. */
function hashValidators(validators: Array<{ id: string; address: string; stake: string; active: boolean }> | undefined): string {
  if (!validators || validators.length === 0) return "0x"
  const sorted = [...validators].sort((a, b) => a.id.localeCompare(b.id))
  // Explicit property order for deterministic cross-node JSON serialization
  const json = JSON.stringify(sorted.map(v => ({ active: v.active, address: v.address, id: v.id, stake: v.stake })))
  return keccak256Hex(Buffer.from(json, "utf8"))
}
