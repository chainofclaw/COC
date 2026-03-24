// Backup scheduler: periodic + hook-triggered backup orchestration

import type { CocBackupConfig } from "../config-schema.ts"
import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { BackupResult, SnapshotManifest } from "../types.ts"
import { detectChanges } from "./change-detector.ts"
import { uploadFiles, carryOverEntries } from "./uploader.ts"
import { buildManifest } from "./manifest-builder.ts"
import { anchorBackup } from "./anchor.ts"

interface Logger {
  info(msg: string): void
  error(msg: string): void
  warn(msg: string): void
}

export class BackupScheduler {
  private readonly config: CocBackupConfig
  private readonly soul: SoulClient
  private readonly ipfs: IpfsClient
  private readonly logger: Logger
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastManifest: SnapshotManifest | null = null
  private incrementalCount = 0

  constructor(
    config: CocBackupConfig,
    soul: SoulClient,
    ipfs: IpfsClient,
    logger: Logger,
  ) {
    this.config = config
    this.soul = soul
    this.ipfs = ipfs
    this.logger = logger
  }

  /** Start periodic backup timer */
  start(): void {
    if (!this.config.autoBackupEnabled) return
    if (this.timer) return

    this.timer = setInterval(() => {
      this.runBackup().catch((error) => {
        this.logger.error(`Auto-backup failed: ${String(error)}`)
      })
    }, this.config.autoBackupIntervalMs)

    this.logger.info(
      `Backup scheduler started (interval: ${this.config.autoBackupIntervalMs}ms)`,
    )
  }

  /** Stop periodic backup timer */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run a single backup cycle (reentrance-guarded) */
  async runBackup(forceFullBackup = false): Promise<BackupResult | null> {
    if (this.running) {
      this.logger.warn("Backup already in progress, skipping")
      return null
    }

    this.running = true
    try {
      return await this._executeBackup(forceFullBackup)
    } finally {
      this.running = false
    }
  }

  private async _executeBackup(forceFullBackup: boolean): Promise<BackupResult | null> {
    const baseDir = this.config.dataDir.replace(/^~/, process.env.HOME ?? "")

    // Resolve agentId from on-chain
    const agentId = await this.soul.getAgentIdForOwner()
    if (agentId === "0x" + "0".repeat(64)) {
      this.logger.error("No soul registered for this wallet. Run 'coc-backup register' first.")
      return null
    }

    // Determine if we should do full or incremental
    const isFullBackup = forceFullBackup ||
      !this.lastManifest ||
      this.incrementalCount >= this.config.maxIncrementalChain

    const previousManifest = isFullBackup ? null : this.lastManifest

    // 1. Detect changes
    const changes = await detectChanges(baseDir, this.config, previousManifest)
    const changedFiles = [...changes.added, ...changes.modified]

    if (changedFiles.length === 0 && changes.deleted.length === 0 && !isFullBackup) {
      this.logger.info("No changes detected, skipping backup")
      return null
    }

    this.logger.info(
      `Backup: ${changedFiles.length} changed, ${changes.deleted.length} deleted, ` +
      `${changes.unchanged.length} unchanged (${isFullBackup ? "full" : "incremental"})`,
    )

    // 2. Upload changed files to IPFS
    const uploaded = await uploadFiles(
      changedFiles,
      this.ipfs,
      this.config.privateKey,
      this.config.encryptionPassword,
    )

    // 3. Build manifest entries
    let allEntries = { ...uploaded.entries }

    if (!isFullBackup && previousManifest) {
      // For incremental: carry over unchanged files
      const carried = carryOverEntries(changes.unchanged, previousManifest.files)
      allEntries = { ...carried, ...uploaded.entries }
      // Remove deleted files (already excluded by not carrying them over)
    }

    // 4. Build manifest
    const parentCid = isFullBackup ? null : (this.lastManifestCid ?? null)
    const manifest = buildManifest(agentId, allEntries, parentCid)

    // 5. Anchor on-chain
    const result = await anchorBackup(manifest, this.ipfs, this.soul)

    // 6. Update state
    this.lastManifest = manifest
    this.lastManifestCid = result.manifestCid
    if (isFullBackup) {
      this.incrementalCount = 0
    } else {
      this.incrementalCount++
    }

    this.logger.info(
      `Backup complete: ${result.fileCount} files, ${result.totalBytes} bytes, ` +
      `CID: ${result.manifestCid}, TX: ${result.txHash}`,
    )

    return result
  }

  private lastManifestCid: string | null = null
}
