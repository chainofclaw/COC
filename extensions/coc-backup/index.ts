import { CocBackupConfigSchema } from "./src/config-schema.ts"
import { SoulClient } from "./src/soul-client.ts"
import { IpfsClient } from "./src/ipfs-client.ts"
import { BackupScheduler } from "./src/backup/scheduler.ts"
import { registerBackupCommands } from "./src/cli/commands.ts"
import { restoreFromManifestCid } from "./src/recovery/state-restorer.ts"
import { autoRestore } from "./src/recovery/orchestrator.ts"
import { createCidResolver } from "./src/recovery/cid-resolver.ts"
import { CarrierDaemon, CarrierDaemonConfigSchema } from "./src/carrier/carrier-daemon.ts"
import { DIDClient } from "./src/did-client.ts"
import type { OpenClawPluginApi } from "./src/plugin-api.ts"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { buildDoctorReport, resolveRestorePlan } from "./src/lifecycle.ts"
import { patchBackupState, readBackupState } from "./src/local-state.ts"
import { resolveHomePath } from "./src/utils.ts"

async function checkRestoreMarker(dataDir: string, logger: { info(msg: string): void }): Promise<void> {
  try {
    const markerPath = join(dataDir, ".coc-backup", "restore-complete.json")
    const content = await readFile(markerPath, "utf8")
    const marker = JSON.parse(content)
    logger.info(
      `Restored from backup: ${marker.filesRestored} files, ` +
      `manifest ${marker.manifestCid}, agent ${marker.agentId}`,
    )
    await rm(markerPath)
  } catch {
    // No restore marker — normal startup
  }
}

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

  const soulClient = new SoulClient(config.rpcUrl, config.contractAddress, config.privateKey, config.rpcAuthToken)
  const ipfsClient = new IpfsClient(config.ipfsUrl)
  const scheduler = new BackupScheduler(config, soulClient, ipfsClient, logger)

  // Check for restore marker on startup (cold-start recovery acknowledgment)
  void checkRestoreMarker(resolveHomePath(config.dataDir), logger)

  // Register CLI commands (getDaemon is a lazy reference resolved after daemon creation below)
  let daemon: CarrierDaemon | null = null
  api.registerCli(
    async ({ program }: { program: Parameters<typeof registerBackupCommands>[0] }) => {
      const didClient = config.didRegistryAddress
        ? new DIDClient(config.rpcUrl, config.didRegistryAddress, config.privateKey, config.rpcAuthToken)
        : undefined
      registerBackupCommands(program, config, soulClient, ipfsClient, scheduler, logger, () => daemon, didClient)
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

  // Create CID resolver for automated recovery
  const dataDir = resolveHomePath(config.dataDir)
  const cidResolver = createCidResolver({
    dataDir,
    agentId: "", // Will be resolved lazily during operations
    ipfs: ipfsClient,
    logger,
  })

  // Register auto-restore tool (full automated recovery from agentId)
  api.registerTool({
    name: "soul-auto-restore",
    description: "Automatically restore agent from on-chain backup using agentId. " +
      "Resolves latest backup CID via local index, MFS, or on-chain registry, " +
      "then downloads, decrypts, and verifies all files.",
    parameters: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID (bytes32 hex). If omitted, resolves from wallet.",
        },
        targetDir: {
          type: "string",
          description: "Target directory for restoration (default: config dataDir)",
        },
        password: {
          type: "string",
          description: "Decryption password (for password-encrypted backups)",
        },
      },
    },
    async execute(params: { agentId?: string; targetDir?: string; password?: string }) {
      try {
        const agentId = params.agentId ?? await soulClient.getAgentIdForOwner()
        const targetPath = params.targetDir ? resolveHomePath(params.targetDir) : dataDir
        const key = params.password ?? config.encryptionPassword ?? config.privateKey
        const isPassword = params.password !== undefined || config.encryptionPassword !== undefined

        // Update resolver's agentId for MFS resolution
        const resolver = createCidResolver({
          dataDir: targetPath,
          agentId,
          ipfs: ipfsClient,
          logger,
        })

        const result = await autoRestore({
          agentId,
          targetDir: targetPath,
          soul: soulClient,
          ipfs: ipfsClient,
          cidResolver: resolver,
          privateKeyOrPassword: key,
          isPassword,
          logger,
        })

        return {
          success: true,
          agentId,
          filesRestored: result.recovery.filesRestored,
          totalBytes: result.recovery.totalBytes,
          backupsApplied: result.recovery.backupsApplied,
          merkleVerified: result.recovery.merkleVerified,
          anchorCheckPassed: result.recovery.anchorCheckPassed,
          markerPath: result.markerPath,
          agentNotified: result.agentNotified,
        }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  // Guardian-side tools (initiate + approve resurrection for watched agents)
  api.registerTool({
    name: "soul-guardian-initiate",
    description: "Guardian: initiate a resurrection request for an offline agent (requires guardian EOA)",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID (bytes32)" },
        carrierId: { type: "string", description: "Target carrier ID (bytes32)" },
      },
      required: ["agentId", "carrierId"],
    },
    async execute(params: { agentId: string; carrierId: string }) {
      try {
        const result = await soulClient.initiateGuardianResurrection(params.agentId, params.carrierId)
        return { success: true, ...result }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "soul-guardian-approve",
    description: "Guardian: approve a pending resurrection request (requires guardian EOA)",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Resurrection request ID (bytes32)" },
      },
      required: ["requestId"],
    },
    async execute(params: { requestId: string }) {
      try {
        const txHash = await soulClient.approveResurrection(params.requestId)
        return { success: true, txHash }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  // Guardian management tool
  api.registerTool({
    name: "soul-guardian-manage",
    description: "Manage guardians: add, remove, or list guardians for the agent's soul",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "list"], description: "Action to perform" },
        guardian: { type: "string", description: "Guardian address (required for add/remove)" },
        agentId: { type: "string", description: "Agent ID (defaults to wallet's agent)" },
      },
      required: ["action"],
    },
    async execute(params: { action: "add" | "remove" | "list"; guardian?: string; agentId?: string }) {
      try {
        const agentId = params.agentId ?? await soulClient.getAgentIdForOwner()
        if (params.action === "list") {
          const result = await soulClient.listGuardians(agentId)
          return { success: true, ...result }
        }
        if (!params.guardian) return { success: false, error: "guardian address required for add/remove" }
        if (params.action === "add") {
          const txHash = await soulClient.addGuardian(agentId, params.guardian)
          return { success: true, action: "added", guardian: params.guardian, txHash }
        }
        const txHash = await soulClient.removeGuardian(agentId, params.guardian)
        return { success: true, action: "removed", guardian: params.guardian, txHash }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  // Social recovery tools
  api.registerTool({
    name: "soul-recovery-initiate",
    description: "Guardian: initiate social recovery to transfer ownership of an agent's soul",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID (bytes32)" },
        newOwner: { type: "string", description: "New owner Ethereum address" },
      },
      required: ["agentId", "newOwner"],
    },
    async execute(params: { agentId: string; newOwner: string }) {
      try {
        const requestId = await soulClient.initiateRecovery(params.agentId, params.newOwner)
        return { success: true, requestId, agentId: params.agentId, newOwner: params.newOwner }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  api.registerTool({
    name: "soul-recovery-approve",
    description: "Guardian: approve a pending social recovery request",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Recovery request ID (bytes32)" },
      },
      required: ["requestId"],
    },
    async execute(params: { requestId: string }) {
      try {
        const txHash = await soulClient.approveRecovery(params.requestId)
        return { success: true, txHash }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },
  })

  // Start auto-backup scheduler (skip for pure carrier nodes that don't own a soul)
  if (config.autoBackupEnabled) {
    scheduler.start()
  }

  // Start carrier daemon if configured (carrier mode)
  if (config.carrier.enabled && config.carrier.carrierId && config.carrier.agentEntryScript) {
    const daemonConfig = CarrierDaemonConfigSchema.parse({
      carrierId: config.carrier.carrierId,
      watchedAgents: config.carrier.watchedAgents,
      pendingRequestIds: config.carrier.pendingRequestIds,
      pollIntervalMs: config.carrier.pollIntervalMs,
      readinessTimeoutMs: config.carrier.readinessTimeoutMs,
      readinessPollMs: config.carrier.readinessPollMs,
      agentEntryScript: config.carrier.agentEntryScript,
      workDir: config.carrier.workDir,
      privateKeyOrPassword: config.encryptionPassword ?? config.privateKey,
      isPassword: config.encryptionPassword !== undefined,
    })
    const carrierCidResolver = createCidResolver({
      dataDir,
      agentId: "",
      ipfs: ipfsClient,
      logger,
    })
    daemon = new CarrierDaemon(daemonConfig, soulClient, ipfsClient, carrierCidResolver, logger)
    daemon.start()
    logger.info(`Carrier daemon started: ${config.carrier.carrierId}`)
  }

  // Tool to dynamically submit a resurrection request to the carrier daemon
  api.registerTool({
    name: "soul-carrier-request",
    description: "Submit a pending resurrection request to the carrier daemon for processing",
    parameters: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Resurrection request ID (bytes32)" },
        agentId: { type: "string", description: "Agent ID (bytes32)" },
      },
      required: ["requestId", "agentId"],
    },
    async execute(params: { requestId: string; agentId: string }) {
      if (!daemon) {
        return { success: false, error: "Carrier daemon is not running. Enable carrier mode in config." }
      }
      const result = daemon.addRequest(params.requestId, params.agentId)
      if (!result.accepted) {
        return { success: false, error: `Request rejected: ${result.reason}` }
      }
      return { success: true, message: `Request ${params.requestId} accepted by carrier daemon` }
    },
  })

  // Register lifecycle hooks for backup (only when backup mode is active)
  if (config.backupOnSessionEnd && config.autoBackupEnabled) {
    api.registerHook?.("session_end", async (event) => {
      logger.info(`Session ending (${event?.reason ?? "unknown"}) — running backup...`)
      try {
        await scheduler.runBackup()
      } catch (error) {
        logger.error(`Session-end backup failed: ${String(error)}`)
      }
    })

    api.registerHook?.("before_compaction", async () => {
      logger.info("Context compaction imminent — running pre-compaction backup...")
      try {
        await scheduler.runBackup()
      } catch (error) {
        logger.error(`Pre-compaction backup failed: ${String(error)}`)
      }
    })
  }

  // Graceful shutdown: run final backup (if backup mode), then stop all timers
  api.registerHook?.("gateway_stop", async () => {
    logger.info("Gateway stopping — shutting down...")
    if (config.autoBackupEnabled) {
      try {
        await scheduler.runBackup()
      } catch (error) {
        logger.error(`Gateway-stop backup failed: ${String(error)}`)
      }
    }
    scheduler.stop()
    await daemon?.stop()
  })

  // Legacy stop hook
  api.registerHook?.("stop", async () => {
    if (config.autoBackupEnabled) {
      try {
        await scheduler.runBackup()
      } catch (error) {
        logger.error(`Stop-hook backup failed: ${String(error)}`)
      }
    }
    scheduler.stop()
    await daemon?.stop()
  })

  logger.info("COC Soul Backup extension loaded")
}
