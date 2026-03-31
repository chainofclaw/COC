// Backup scheduler: periodic + hook-triggered backup orchestration

import type { CocBackupConfig } from "../config-schema.ts"
import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type {
  BackupReceipt,
  BackupRecoveryPackage,
  SnapshotManifest,
} from "../types.ts"
import { detectChanges } from "./change-detector.ts"
import { uploadFiles, carryOverEntries } from "./uploader.ts"
import { buildManifest } from "./manifest-builder.ts"
import { anchorBackup } from "./anchor.ts"
import { readBackupState, writeBackupState, writeLatestRecoveryPackage } from "../local-state.ts"
import { resolveHomePath } from "../utils.ts"

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
  private lastManifestCid: string | null = null
  private consecutiveFailures = 0
  private initialized = false

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

    this.scheduleNext()

    this.logger.info(
      `Backup scheduler started (interval: ${this.config.autoBackupIntervalMs}ms)`,
    )
  }

  private scheduleNext(): void {
    if (this.timer) return
    const backoff = this.consecutiveFailures >= 3
      ? Math.min(this.config.autoBackupIntervalMs * 2 ** (this.consecutiveFailures - 2), 3_600_000)
      : this.config.autoBackupIntervalMs
    this.timer = setTimeout(() => {
      this.timer = null
      this.runBackup().then(() => {
        this.consecutiveFailures = 0
        if (this.config.autoBackupEnabled) this.scheduleNext()
      }).catch((error) => {
        this.consecutiveFailures++
        this.logger.error(`Auto-backup failed (${this.consecutiveFailures} consecutive): ${String(error)}`)
        if (this.config.autoBackupEnabled) this.scheduleNext()
      })
    }, backoff)
  }

  /** Stop periodic backup timer */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Run a single backup cycle (reentrance-guarded) */
  async runBackup(forceFullBackup = false): Promise<BackupReceipt> {
    await this.ensureInitialized()

    if (this.running) {
      this.logger.warn("Backup already in progress, skipping")
      return {
        status: "skipped",
        reason: "already_running",
        heartbeatStatus: "not_attempted",
        heartbeatError: null,
        backup: null,
      }
    }

    this.running = true
    try {
      return await this._executeBackup(forceFullBackup)
    } finally {
      this.running = false
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return

    const baseDir = resolveHomePath(this.config.dataDir)
    const persisted = await readBackupState(baseDir)
    this.lastManifestCid = persisted.lastManifestCid
    this.incrementalCount = persisted.incrementalCount

    if (persisted.lastManifestCid) {
      try {
        this.lastManifest = await this.ipfs.catManifest(persisted.lastManifestCid)
      } catch (error) {
        this.logger.warn(`Failed to hydrate previous manifest from IPFS, falling back to full backup: ${String(error)}`)
        this.lastManifest = null
        this.lastManifestCid = null
        this.incrementalCount = 0
      }
    }

    this.initialized = true
  }

  private buildRecoveryPackage(baseDir: string, manifest: SnapshotManifest, result: NonNullable<BackupReceipt["backup"]>): BackupRecoveryPackage {
    const hasEncryptedFiles = Object.values(manifest.files).some((entry) => entry.encrypted)
    const encryptionMode = !hasEncryptedFiles
      ? "none"
      : (this.config.encryptionPassword ? "password" : "privateKey")

    const recommendedRestoreCommand = encryptionMode === "password"
      ? "coc-backup restore --latest-local --password <password>"
      : "coc-backup restore --latest-local"

    void baseDir

    return {
      version: 1,
      agentId: manifest.agentId,
      latestManifestCid: result.manifestCid,
      anchoredAt: result.anchoredAt,
      txHash: result.txHash,
      dataMerkleRoot: result.dataMerkleRoot,
      backupType: result.backupType === 0 ? "full" : "incremental",
      encryptionMode,
      requiresPassword: encryptionMode === "password",
      recommendedRestoreCommand,
    }
  }

  private async persistState(
    baseDir: string,
    agentId: string,
    manifest: SnapshotManifest,
    result: NonNullable<BackupReceipt["backup"]>,
  ): Promise<void> {
    const recoveryPackage = this.buildRecoveryPackage(baseDir, manifest, result)
    const recoveryPackagePath = await writeLatestRecoveryPackage(baseDir, recoveryPackage)
    const anchoredAt = result.anchoredAt ?? Math.floor(Date.now() / 1000)

    await writeBackupState(baseDir, {
      version: 1,
      latestAgentId: agentId,
      lastManifestCid: result.manifestCid,
      incrementalCount: this.incrementalCount,
      lastBackupAt: anchoredAt,
      lastFullBackupAt: result.backupType === 0 ? anchoredAt : (await readBackupState(baseDir)).lastFullBackupAt,
      latestRecoveryPackagePath: recoveryPackagePath,
      pendingResurrectionRequestId: (await readBackupState(baseDir)).pendingResurrectionRequestId,
      pendingCarrierId: (await readBackupState(baseDir)).pendingCarrierId,
    })
  }

  private async _executeBackup(forceFullBackup: boolean): Promise<BackupReceipt> {
    const baseDir = resolveHomePath(this.config.dataDir)

    // Resolve agentId from on-chain
    const agentId = await this.soul.getAgentIdForOwner()
    if (agentId === `0x${"0".repeat(64)}`) {
      this.logger.warn("No soul registered for this wallet. Run 'coc-backup init' or 'coc-backup register' first.")
      return {
        status: "registration_required",
        reason: "soul_not_registered",
        heartbeatStatus: "not_attempted",
        heartbeatError: null,
        backup: null,
      }
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
      // Still send heartbeat even if no backup needed
      const heartbeat = await this._sendHeartbeat(agentId)
      return {
        status: "skipped",
        reason: "no_changes",
        heartbeatStatus: heartbeat.status,
        heartbeatError: heartbeat.error,
        backup: null,
      }
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

    await this.persistState(baseDir, agentId, manifest, result)

    this.logger.info(
      `Backup complete: ${result.fileCount} files, ${result.totalBytes} bytes, ` +
      `CID: ${result.manifestCid}, TX: ${result.txHash}`,
    )

    // Send heartbeat after successful backup
    const heartbeat = await this._sendHeartbeat(agentId)

    return {
      status: "completed",
      reason: null,
      heartbeatStatus: heartbeat.status,
      heartbeatError: heartbeat.error,
      backup: result,
    }
  }

  /** Send heartbeat if resurrection is configured */
  private async _sendHeartbeat(agentId: string): Promise<{
    status: "sent" | "not_configured" | "failed"
    error: string | null
  }> {
    try {
      const config = await this.soul.getResurrectionConfig(agentId)
      if (!config.configured) {
        return { status: "not_configured", error: null }
      }

      await this.soul.heartbeat(agentId)
      this.logger.info("Heartbeat sent")
      return { status: "sent", error: null }
    } catch (error) {
      const message = String(error)
      this.logger.warn(`Heartbeat failed (non-fatal): ${message}`)
      return { status: "failed", error: message }
    }
  }
}
