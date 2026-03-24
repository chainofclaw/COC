import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { CocBackupConfigSchema } from "./src/config-schema.ts"
import { SoulClient } from "./src/soul-client.ts"
import { IpfsClient } from "./src/ipfs-client.ts"
import { BackupScheduler } from "./src/backup/scheduler.ts"
import { registerBackupCommands } from "./src/cli/commands.ts"
import { restoreFromManifestCid } from "./src/recovery/state-restorer.ts"

export function activate(api: OpenClawPluginApi) {
  const logger = api.logger
  logger.info("COC Soul Backup extension loading...")

  let config
  try {
    config = CocBackupConfigSchema.parse(api.pluginConfig ?? {})
  } catch (error) {
    logger.error(`COC backup config parse failed: ${String(error)}`)
    return
  }

  if (!config.enabled) {
    logger.info("COC Soul Backup extension disabled")
    return
  }

  const soulClient = new SoulClient(config.rpcUrl, config.contractAddress, config.privateKey)
  const ipfsClient = new IpfsClient(config.ipfsUrl)
  const scheduler = new BackupScheduler(config, soulClient, ipfsClient, logger)

  // Register CLI commands
  api.registerCli(
    async ({ program }) => {
      registerBackupCommands(program, config, soulClient, ipfsClient, scheduler, logger)
      logger.info("COC backup CLI commands registered")
    },
    { commands: ["coc-backup"] },
  )

  // Register Agent tools
  api.registerTool({
    name: "soul-backup",
    description: "Backup the current agent's soul (identity, memory, chat history) to IPFS with on-chain anchoring",
    parameters: {
      type: "object",
      properties: {
        full: {
          type: "boolean",
          description: "Force a full backup instead of incremental",
          default: false,
        },
      },
    },
    async execute(params: { full?: boolean }) {
      try {
        const result = await scheduler.runBackup(params.full ?? false)
        if (!result) {
          return { success: true, message: "No changes detected, backup skipped" }
        }
        return {
          success: true,
          manifestCid: result.manifestCid,
          fileCount: result.fileCount,
          totalBytes: result.totalBytes,
          backupType: result.backupType === 0 ? "full" : "incremental",
          txHash: result.txHash,
        }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "soul-restore",
    description: "Restore the agent's soul from an IPFS backup using a manifest CID",
    parameters: {
      type: "object",
      properties: {
        manifestCid: {
          type: "string",
          description: "IPFS CID of the backup manifest to restore from",
        },
        targetDir: {
          type: "string",
          description: "Target directory for restoration (default: config dataDir)",
        },
      },
      required: ["manifestCid"],
    },
    async execute(params: { manifestCid: string; targetDir?: string }) {
      const targetDir = (params.targetDir ?? config.dataDir).replace(/^~/, process.env.HOME ?? "")
      const result = await restoreFromManifestCid(
        params.manifestCid,
        targetDir,
        ipfsClient,
        config.privateKey,
        false,
        logger,
        soulClient,
      )
      return {
        success: true,
        filesRestored: result.filesRestored,
        totalBytes: result.totalBytes,
        backupsApplied: result.backupsApplied,
        merkleVerified: result.merkleVerified,
      }
    },
  })

  api.registerTool({
    name: "soul-status",
    description: "Check the current soul backup status, including on-chain registration and backup history",
    parameters: { type: "object", properties: {} },
    async execute() {
      const agentId = await soulClient.getAgentIdForOwner()
      const zeroId = "0x" + "0".repeat(64)

      if (agentId === zeroId) {
        return { registered: false, message: "No soul registered for this wallet" }
      }

      const soulInfo = await soulClient.getSoul(agentId)
      const ipfsReachable = await ipfsClient.ping()

      return {
        registered: true,
        ...soulInfo,
        ipfsReachable,
      }
    },
  })

  // Start auto-backup scheduler
  scheduler.start()

  // Register stop hook for session-end backup
  if (config.backupOnSessionEnd) {
    api.registerHook?.("stop", async () => {
      logger.info("Session ending — running final backup...")
      try {
        await scheduler.runBackup()
      } catch (error) {
        logger.error(`Session-end backup failed: ${String(error)}`)
      }
    })
  }

  logger.info("COC Soul Backup extension loaded")
}
