import type { IChainEngine, ISnapshotSyncEngine, IBlockSyncEngine, resolveValue } from "./chain-engine-types.ts"
import type { P2PNode } from "./p2p.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("consensus")

export interface ConsensusConfig {
  blockTimeMs: number
  syncIntervalMs: number
}

export class ConsensusEngine {
  private readonly chain: IChainEngine
  private readonly p2p: P2PNode
  private readonly cfg: ConsensusConfig

  constructor(chain: IChainEngine, p2p: P2PNode, cfg: ConsensusConfig) {
    this.chain = chain
    this.p2p = p2p
    this.cfg = cfg
  }

  start(): void {
    setInterval(() => void this.tryPropose(), this.cfg.blockTimeMs)
    setInterval(() => void this.trySync(), this.cfg.syncIntervalMs)
    void this.trySync()
  }

  private async tryPropose(): Promise<void> {
    try {
      const block = await this.chain.proposeNextBlock()
      if (!block) {
        return
      }
      await this.p2p.receiveBlock(block)
    } catch (error) {
      log.error("propose failed", { error: String(error) })
    }
  }

  private async trySync(): Promise<void> {
    try {
      const snapshots = await this.p2p.fetchSnapshots()
      let adopted = false

      // Support both snapshot-based and block-based sync
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
    } catch (error) {
      log.error("sync failed", { error: String(error) })
    }
  }
}
