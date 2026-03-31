import { CocBackupConfigSchema } from "./src/config-schema.ts"
import { SoulClient } from "./src/soul-client.ts"
import { IpfsClient } from "./src/ipfs-client.ts"
import { BackupScheduler } from "./src/backup/scheduler.ts"
import { registerBackupCommands } from "./src/cli/commands.ts"
import { restoreFromManifestCid } from "./src/recovery/state-restorer.ts"
import type { OpenClawPluginApi } from "./src/plugin-api.ts"
import { buildDoctorReport, resolveRestorePlan } from "./src/lifecycle.ts"
import { patchBackupState, readBackupState } from "./src/local-state.ts"
import { resolveHomePath } from "./src/utils.ts"

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
    async ({ program }: { program: Parameters<typeof registerBackupCommands>[0] }) => {
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
        return {
          success: true,
          ...result,
          manifestCid: result.backup?.manifestCid ?? null,
          fileCount: result.backup?.fileCount ?? 0,
          totalBytes: result.backup?.totalBytes ?? 0,
          backupType: result.backup ? (result.backup.backupType === 0 ? "full" : "incremental") : null,
          txHash: result.backup?.txHash ?? null,
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
        packagePath: {
          type: "string",
          description: "Local path to a recovery package JSON file",
        },
        latestLocal: {
          type: "boolean",
          description: "Use the latest local recovery package",
        },
        targetDir: {
          type: "string",
          description: "Target directory for restoration (default: config dataDir)",
        },
        password: {
          type: "string",
          description: "Decryption password (required for password-encrypted recovery packages)",
        },
      },
    },
    async execute(params: { manifestCid?: string; packagePath?: string; latestLocal?: boolean; targetDir?: string; password?: string }) {
      const plan = await resolveRestorePlan(config, params)
      const result = await restoreFromManifestCid(
        plan.manifestCid,
        plan.targetDir,
        ipfsClient,
        plan.key,
        plan.isPassword,
        logger,
        soulClient,
      )
      return {
        success: true,
        source: plan.source,
        filesRestored: result.filesRestored,
        totalBytes: result.totalBytes,
        backupsApplied: result.backupsApplied,
        merkleVerified: result.merkleVerified,
        requestedManifestCid: result.requestedManifestCid,
        resolvedAgentId: result.resolvedAgentId,
        anchorCheckAttempted: result.anchorCheckAttempted,
        anchorCheckPassed: result.anchorCheckPassed,
        anchorCheckReason: result.anchorCheckReason,
      }
    },
  })

  api.registerTool({
    name: "soul-status",
    description: "Check the current soul backup status, including on-chain registration and backup history",
    parameters: { type: "object", properties: {} },
    async execute() {
      const report = await buildDoctorReport(config, soulClient, ipfsClient)
      return {
        success: true,
        registered: report.chain.registered,
        lifecycleState: report.state,
        doctor: report,
      }
    },
  })

  api.registerTool({
    name: "soul-doctor",
    description: "Run lifecycle checks for the current soul and recommend next actions",
    parameters: { type: "object", properties: {} },
    async execute() {
      const report = await buildDoctorReport(config, soulClient, ipfsClient)
      return {
        success: true,
        ...report,
      }
    },
  })

  api.registerTool({
    name: "soul-resurrection",
    description: "Manage owner-key resurrection requests for the current soul",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "status", "confirm", "complete", "cancel"],
        },
        requestId: {
          type: "string",
          description: "Resurrection request ID. Falls back to the locally tracked pending request.",
        },
        carrierId: {
          type: "string",
          description: "Carrier ID for the start action",
        },
        resurrectionKey: {
          type: "string",
          description: "Resurrection private key for the start action",
        },
        agentId: {
          type: "string",
          description: "Optional agentId override when relaying for another soul",
        },
      },
      required: ["action"],
    },
    async execute(params: {
      action: "start" | "status" | "confirm" | "complete" | "cancel"
      requestId?: string
      carrierId?: string
      resurrectionKey?: string
      agentId?: string
    }) {
      const dataDir = resolveHomePath(config.dataDir)
      const localState = await readBackupState(dataDir)
      const requestId = params.requestId ?? localState.pendingResurrectionRequestId ?? undefined

      if (params.action === "start") {
        if (!params.carrierId || !params.resurrectionKey) {
          throw new Error("start action requires carrierId and resurrectionKey")
        }
        const agentId = params.agentId ?? await soulClient.getAgentIdForOwner()
        const result = await soulClient.initiateResurrection(agentId, params.carrierId, params.resurrectionKey)
        await patchBackupState(dataDir, {
          latestAgentId: agentId,
          pendingCarrierId: params.carrierId,
          pendingResurrectionRequestId: result.requestId,
        })
        return { success: true, agentId, carrierId: params.carrierId, ...result }
      }

      if (!requestId) {
        throw new Error("No resurrection requestId provided and no local pending request is recorded")
      }

      if (params.action === "status") {
        const request = await soulClient.getResurrectionRequest(requestId)
        const readiness = await soulClient.getResurrectionReadiness(requestId)
        return { success: true, request, readiness }
      }

      if (params.action === "confirm") {
        const txHash = await soulClient.confirmCarrier(requestId)
        return { success: true, requestId, txHash }
      }

      if (params.action === "complete") {
        const txHash = await soulClient.completeResurrection(requestId)
        await patchBackupState(dataDir, {
          pendingResurrectionRequestId: null,
          pendingCarrierId: null,
        })
        return { success: true, requestId, txHash }
      }

      const txHash = await soulClient.cancelResurrection(requestId)
      await patchBackupState(dataDir, {
        pendingResurrectionRequestId: null,
        pendingCarrierId: null,
      })
      return { success: true, requestId, txHash }
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
