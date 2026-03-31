// CLI commands for COC Soul Backup extension

import { readFile } from "node:fs/promises"
import { keccak256, toUtf8Bytes } from "ethers"
import type { Command } from "commander"
import type { CocBackupConfig } from "../config-schema.ts"
import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { BackupScheduler } from "../backup/scheduler.ts"
import type { DoctorReport } from "../types.ts"
import { restoreFromManifestCid } from "../recovery/state-restorer.ts"
import { buildDoctorReport, resolveRestorePlan, runInitFlow } from "../lifecycle.ts"
import { patchBackupState, readBackupState } from "../local-state.ts"
import { deriveDefaultAgentId, formatBytes, resolveHomePath, ZERO_BYTES32 } from "../utils.ts"

interface Logger {
  info(msg: string): void
  error(msg: string): void
  warn(msg: string): void
}

function renderDoctorReport(report: DoctorReport): void {
  console.log(`Soul Doctor`)
  console.log(`  State:              ${report.state}`)
  console.log(`  Data dir:           ${report.local.dataDir}`)
  console.log(`  Data dir exists:    ${report.local.dataDirExists}`)
  console.log(`  IPFS reachable:     ${report.ipfs.reachable}`)
  console.log(`  Registered:         ${report.chain.registered}`)
  if (report.agentId) console.log(`  Agent ID:           ${report.agentId}`)
  if (report.chain.owner) console.log(`  Owner:              ${report.chain.owner}`)
  console.log(`  Backup count:       ${report.chain.backupCount}`)
  if (report.chain.lastBackupAt) {
    console.log(`  Last backup:        ${new Date(report.chain.lastBackupAt * 1000).toISOString()}`)
  }
  console.log(`  Backup overdue:     ${report.chain.backupOverdue}`)
  console.log(`  Restore available:  ${report.restore.available}`)
  console.log(`  Restore blocked:    ${report.restore.blocked}`)
  if (report.restore.reason) console.log(`  Restore reason:     ${report.restore.reason}`)
  console.log(`  Resurrection cfg:   ${report.resurrection.configured}`)
  console.log(`  Offline:            ${report.resurrection.offline}`)
  if (report.resurrection.pendingRequestId) {
    console.log(`  Pending request:    ${report.resurrection.pendingRequestId}`)
  }
  if (report.actions.length > 0) {
    console.log(``)
    console.log(`Recommended Actions`)
    for (const action of report.actions) {
      console.log(`  - ${action.label}: ${action.description}`)
      if (action.command) console.log(`    ${action.command}`)
    }
  }
}

async function resolvePendingRequestId(config: CocBackupConfig, explicitRequestId?: string): Promise<string> {
  if (explicitRequestId) return explicitRequestId
  const state = await readBackupState(resolveHomePath(config.dataDir))
  if (!state.pendingResurrectionRequestId) {
    throw new Error("No pending resurrection request recorded locally. Provide --request-id.")
  }
  return state.pendingResurrectionRequestId
}

async function printResurrectionStatus(
  config: CocBackupConfig,
  soul: SoulClient,
  requestId: string,
  json = false,
): Promise<void> {
  const request = await soul.getResurrectionRequest(requestId)
  const readiness = await soul.getResurrectionReadiness(requestId)
  const payload = { request, readiness }

  if (json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log(`Resurrection Request`)
  console.log(`  Request ID:         ${request.requestId}`)
  console.log(`  Agent ID:           ${request.agentId}`)
  console.log(`  Carrier ID:         ${request.carrierId}`)
  console.log(`  Trigger:            ${request.trigger}`)
  console.log(`  Initiator:          ${request.initiator}`)
  console.log(`  Initiated At:       ${new Date(request.initiatedAt * 1000).toISOString()}`)
  console.log(`  Executed:           ${request.executed}`)
  console.log(`  Carrier Confirmed:  ${request.carrierConfirmed}`)
  console.log(`  Approval Count:     ${readiness.approvalCount}/${readiness.approvalThreshold}`)
  console.log(`  Offline Now:        ${readiness.offlineNow}`)
  console.log(`  Ready At:           ${new Date(readiness.readyAt * 1000).toISOString()}`)
  console.log(`  Can Complete:       ${readiness.canComplete}`)

  void config
}

function printBackupReceipt(receipt: Awaited<ReturnType<BackupScheduler["runBackup"]>>): void {
  if (receipt.status === "registration_required") {
    console.log("Soul not registered. Run `coc-backup init` or `coc-backup register` first.")
    return
  }

  if (receipt.status === "skipped") {
    console.log(`Backup skipped: ${receipt.reason ?? "no reason"}`)
  } else if (receipt.backup) {
    console.log(`Backup complete!`)
    console.log(`  Files:      ${receipt.backup.fileCount}`)
    console.log(`  Size:       ${formatBytes(receipt.backup.totalBytes)}`)
    console.log(`  Type:       ${receipt.backup.backupType === 0 ? "full" : "incremental"}`)
    console.log(`  CID:        ${receipt.backup.manifestCid}`)
    console.log(`  Merkle:     ${receipt.backup.dataMerkleRoot}`)
    if (receipt.backup.txHash) {
      console.log(`  TX Hash:    ${receipt.backup.txHash}`)
    }
  }

  console.log(`  Heartbeat:  ${receipt.heartbeatStatus}`)
  if (receipt.heartbeatError) {
    console.log(`  Warning:    ${receipt.heartbeatError}`)
  }
}

function registerResurrectionStartCommand(
  command: Command,
  config: CocBackupConfig,
  soul: SoulClient,
  logger: Logger,
): void {
  command
    .description("Initiate resurrection using resurrection key")
    .requiredOption("--carrier-id <id>", "Target carrier ID (bytes32)")
    .requiredOption("--resurrection-key <key>", "Resurrection private key (hex)")
    .option("--agent-id <id>", "Agent ID (bytes32 hex). Required when relaying for another soul")
    .action(async (opts) => {
      try {
        const agentId = opts.agentId ?? await soul.getAgentIdForOwner()
        if (agentId === ZERO_BYTES32) {
          logger.error("No soul registered for this wallet")
          process.exit(1)
        }

        const result = await soul.initiateResurrection(
          agentId,
          opts.carrierId,
          opts.resurrectionKey,
        )
        await patchBackupState(resolveHomePath(config.dataDir), {
          pendingResurrectionRequestId: result.requestId,
          pendingCarrierId: opts.carrierId,
          latestAgentId: agentId,
        })

        console.log(`Resurrection initiated!`)
        console.log(`  Agent ID:   ${agentId}`)
        console.log(`  Carrier ID: ${opts.carrierId}`)
        console.log(`  Request ID: ${result.requestId}`)
        console.log(`  TX Hash:    ${result.txHash}`)
      } catch (error) {
        logger.error(`Resurrection failed: ${String(error)}`)
        process.exit(1)
      }
    })
}

export function registerBackupCommands(
  program: Command,
  config: CocBackupConfig,
  soul: SoulClient,
  ipfs: IpfsClient,
  scheduler: BackupScheduler,
  logger: Logger,
): void {
  const cmd = program.command("coc-backup").description("COC soul backup and recovery")

  cmd
    .command("init")
    .description("Register soul if needed, run first full backup, and write local recovery metadata")
    .option("--agent-id <id>", "Agent ID (bytes32 hex). Auto-derived from wallet if omitted")
    .option("--identity-cid <cid>", "Identity CID hash (bytes32 hex). Auto-upload if omitted")
    .option("--key-hash <hash>", "Configure resurrection after init using keccak256(abi.encodePacked(resurrectionKeyAddress))")
    .option("--max-offline <seconds>", "Max offline duration in seconds", "86400")
    .action(async (opts) => {
      try {
        const result = await runInitFlow(config, soul, ipfs, scheduler, {
          agentId: opts.agentId,
          identityCid: opts.identityCid,
          resurrectionKeyHash: opts.keyHash,
          maxOfflineDuration: parseInt(opts.maxOffline),
        })

        console.log(`Initialization complete!`)
        console.log(`  Agent ID:           ${result.agentId}`)
        console.log(`  Already registered: ${result.alreadyRegistered}`)
        if (result.registrationTxHash) {
          console.log(`  Registration TX:    ${result.registrationTxHash}`)
        }
        printBackupReceipt(result.backupReceipt)
        console.log(`  State file:         ${result.statePath}`)
        if (result.recoveryPackagePath) {
          console.log(`  Recovery package:   ${result.recoveryPackagePath}`)
        }
        if (result.resurrectionConfigured && result.resurrectionTxHash) {
          console.log(`  Resurrection TX:    ${result.resurrectionTxHash}`)
        }
      } catch (error) {
        logger.error(`Init failed: ${String(error)}`)
        process.exit(1)
      }
    })

  cmd
    .command("register")
    .description("Register soul identity on-chain")
    .option("--agent-id <id>", "Agent ID (bytes32 hex). Auto-derived from wallet if omitted")
    .option("--identity-cid <cid>", "Identity CID hash (bytes32 hex)")
    .action(async (opts) => {
      try {
        const agentId = opts.agentId ?? deriveDefaultAgentId(soul.address)
        let identityCid = opts.identityCid

        if (!identityCid) {
          const baseDir = resolveHomePath(config.dataDir)
          try {
            const identityData = await readFile(`${baseDir}/IDENTITY.md`)
            identityCid = keccak256(toUtf8Bytes(await ipfs.add(identityData)))
          } catch {
            identityCid = keccak256(toUtf8Bytes("empty-identity"))
            logger.warn("No IDENTITY.md found, using placeholder CID")
          }
        }

        const txHash = await soul.registerSoul(agentId, identityCid)
        console.log(`Soul registered successfully!`)
        console.log(`  Agent ID: ${agentId}`)
        console.log(`  Owner:    ${soul.address}`)
        console.log(`  TX Hash:  ${txHash}`)
      } catch (error) {
        logger.error(`Registration failed: ${String(error)}`)
        process.exit(1)
      }
    })

  cmd
    .command("backup")
    .description("Execute a backup now")
    .option("--full", "Force full backup (ignore incremental state)")
    .action(async (opts) => {
      try {
        const receipt = await scheduler.runBackup(opts.full)
        printBackupReceipt(receipt)
        if (receipt.status === "registration_required") {
          process.exit(1)
        }
      } catch (error) {
        logger.error(`Backup failed: ${String(error)}`)
        process.exit(1)
      }
    })

  cmd
    .command("restore")
    .description("Restore soul from IPFS backup")
    .option("--manifest-cid <cid>", "Manifest IPFS CID to restore from")
    .option("--package <path>", "Recovery package JSON path")
    .option("--latest-local", "Use the latest local recovery package")
    .option("--target-dir <dir>", "Target directory (default: config dataDir)")
    .option("--password <password>", "Decryption password (required when recovery package uses password mode)")
    .action(async (opts) => {
      try {
        const plan = await resolveRestorePlan(config, {
          manifestCid: opts.manifestCid,
          packagePath: opts.package,
          latestLocal: opts.latestLocal,
          targetDir: opts.targetDir,
          password: opts.password,
        })

        const consoleLogger = {
          info: (msg: string) => console.log(`  ${msg}`),
          error: (msg: string) => console.error(`  ERROR: ${msg}`),
          warn: (msg: string) => console.warn(`  WARN: ${msg}`),
        }

        console.log(`Restoring to ${plan.targetDir} from ${plan.source}...`)
        const result = await restoreFromManifestCid(
          plan.manifestCid,
          plan.targetDir,
          ipfs,
          plan.key,
          plan.isPassword,
          consoleLogger,
          soul,
        )

        console.log(`\nRestore complete!`)
        console.log(`  Files restored:         ${result.filesRestored}`)
        console.log(`  Total size:             ${formatBytes(result.totalBytes)}`)
        console.log(`  Backups applied:        ${result.backupsApplied}`)
        console.log(`  Merkle verified:        ${result.merkleVerified ? "YES" : "FAILED"}`)
        console.log(`  Anchor attempted:       ${result.anchorCheckAttempted}`)
        console.log(`  Anchor passed:          ${result.anchorCheckPassed}`)
        console.log(`  Anchor reason:          ${result.anchorCheckReason ?? "n/a"}`)
        console.log(`  Resolved agentId:       ${result.resolvedAgentId ?? "n/a"}`)
        console.log(`  Requested manifest CID: ${result.requestedManifestCid}`)
      } catch (error) {
        logger.error(`Restore failed: ${String(error)}`)
        process.exit(1)
      }
    })

  cmd
    .command("status")
    .description("Show soul backup status")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        const report = await buildDoctorReport(config, soul, ipfs)
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2))
          return
        }

        console.log(`Soul Status`)
        console.log(`  Lifecycle:     ${report.state}`)
        console.log(`  Registered:    ${report.chain.registered}`)
        if (report.agentId) console.log(`  Agent ID:      ${report.agentId}`)
        console.log(`  Backups:       ${report.chain.backupCount}`)
        if (report.chain.lastBackupAt) {
          console.log(`  Last backup:   ${new Date(report.chain.lastBackupAt * 1000).toISOString()}`)
        }
        console.log(`  IPFS:          ${report.ipfs.reachable ? "reachable" : "unreachable"}`)
        console.log(`  Restore:       ${report.restore.available ? "available" : "missing"}`)
        console.log(`  Resurrection:  ${report.resurrection.configured ? "configured" : "not configured"}`)
      } catch (error) {
        logger.error(`Status failed: ${String(error)}`)
        process.exit(1)
      }
    })

  cmd
    .command("doctor")
    .description("Run guided health checks and recommend next actions")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        const report = await buildDoctorReport(config, soul, ipfs)
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2))
          return
        }
        renderDoctorReport(report)
      } catch (error) {
        logger.error(`Doctor failed: ${String(error)}`)
        process.exit(1)
      }
    })

  cmd
    .command("history")
    .description("Show backup history")
    .option("--limit <n>", "Number of entries to show", "10")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        const agentId = await soul.getAgentIdForOwner()
        if (agentId === ZERO_BYTES32) {
          console.log("No soul registered")
          return
        }

        const count = await soul.getBackupCount(agentId)
        const limit = Math.min(parseInt(opts.limit), count)
        const offset = Math.max(0, count - limit)
        const backups = await soul.getBackupHistory(agentId, offset, limit)

        if (opts.json) {
          console.log(JSON.stringify(backups, null, 2))
          return
        }

        if (backups.length === 0) {
          console.log("No backups found")
          return
        }

        console.log(`Backup History (showing ${backups.length} of ${count})`)
        console.log("-".repeat(80))
        for (let i = backups.length - 1; i >= 0; i--) {
          const b = backups[i]
          const date = new Date(b.anchoredAt * 1000).toISOString()
          const type = b.backupType === 0 ? "FULL" : "INCR"
          console.log(
            `  #${offset + i + 1}  ${date}  ${type}  ${b.fileCount} files  ${formatBytes(b.totalBytes)}`,
          )
        }
      } catch (error) {
        logger.error(`History failed: ${String(error)}`)
        process.exit(1)
      }
    })

  cmd
    .command("configure-resurrection")
    .description("Configure resurrection key and offline timeout")
    .requiredOption("--key-hash <hash>", "keccak256(abi.encodePacked(resurrectionKeyAddress)) — address of the resurrection key wallet")
    .option("--max-offline <seconds>", "Max offline duration in seconds", "86400")
    .action(async (opts) => {
      try {
        const agentId = await soul.getAgentIdForOwner()
        if (agentId === ZERO_BYTES32) {
          logger.error("No soul registered for this wallet")
          process.exit(1)
        }

        const txHash = await soul.configureResurrection(
          agentId,
          opts.keyHash,
          parseInt(opts.maxOffline),
        )
        console.log(`Resurrection configured!`)
        console.log(`  Key Hash:    ${opts.keyHash}`)
        console.log(`  Max Offline: ${opts.maxOffline}s`)
        console.log(`  TX Hash:     ${txHash}`)
      } catch (error) {
        logger.error(`Configure resurrection failed: ${String(error)}`)
        process.exit(1)
      }
    })

  cmd
    .command("heartbeat")
    .description("Send heartbeat proving the agent is alive")
    .action(async () => {
      try {
        const agentId = await soul.getAgentIdForOwner()
        if (agentId === ZERO_BYTES32) {
          logger.error("No soul registered for this wallet")
          process.exit(1)
        }

        const txHash = await soul.heartbeat(agentId)
        console.log(`Heartbeat sent! TX: ${txHash}`)
      } catch (error) {
        logger.error(`Heartbeat failed: ${String(error)}`)
        process.exit(1)
      }
    })

  registerResurrectionStartCommand(
    cmd.command("resurrect"),
    config,
    soul,
    logger,
  )

  const resurrectionCmd = cmd.command("resurrection").description("Owner-key resurrection flow")
  registerResurrectionStartCommand(
    resurrectionCmd.command("start"),
    config,
    soul,
    logger,
  )

  resurrectionCmd
    .command("status")
    .description("Show readiness of the pending resurrection request")
    .option("--request-id <id>", "Resurrection request ID (defaults to local pending request)")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        const requestId = await resolvePendingRequestId(config, opts.requestId)
        await printResurrectionStatus(config, soul, requestId, opts.json)
      } catch (error) {
        logger.error(`Resurrection status failed: ${String(error)}`)
        process.exit(1)
      }
    })

  resurrectionCmd
    .command("confirm")
    .description("Confirm carrier readiness for the pending resurrection request")
    .option("--request-id <id>", "Resurrection request ID (defaults to local pending request)")
    .action(async (opts) => {
      try {
        const requestId = await resolvePendingRequestId(config, opts.requestId)
        const txHash = await soul.confirmCarrier(requestId)
        console.log(`Carrier confirmed! TX: ${txHash}`)
      } catch (error) {
        logger.error(`Resurrection confirm failed: ${String(error)}`)
        process.exit(1)
      }
    })

  resurrectionCmd
    .command("complete")
    .description("Complete the pending resurrection request")
    .option("--request-id <id>", "Resurrection request ID (defaults to local pending request)")
    .action(async (opts) => {
      try {
        const requestId = await resolvePendingRequestId(config, opts.requestId)
        const txHash = await soul.completeResurrection(requestId)
        await patchBackupState(resolveHomePath(config.dataDir), {
          pendingResurrectionRequestId: null,
          pendingCarrierId: null,
        })
        console.log(`Resurrection completed! TX: ${txHash}`)
      } catch (error) {
        logger.error(`Resurrection complete failed: ${String(error)}`)
        process.exit(1)
      }
    })

  resurrectionCmd
    .command("cancel")
    .description("Cancel the pending resurrection request")
    .option("--request-id <id>", "Resurrection request ID (defaults to local pending request)")
    .action(async (opts) => {
      try {
        const requestId = await resolvePendingRequestId(config, opts.requestId)
        const txHash = await soul.cancelResurrection(requestId)
        await patchBackupState(resolveHomePath(config.dataDir), {
          pendingResurrectionRequestId: null,
          pendingCarrierId: null,
        })
        console.log(`Resurrection cancelled! TX: ${txHash}`)
      } catch (error) {
        logger.error(`Resurrection cancel failed: ${String(error)}`)
        process.exit(1)
      }
    })

  const carrierCmd = cmd.command("carrier").description("Carrier management")

  carrierCmd
    .command("register")
    .description("Register as a carrier provider")
    .requiredOption("--carrier-id <id>", "Carrier ID (bytes32)")
    .requiredOption("--endpoint <url>", "Carrier communication endpoint")
    .option("--cpu <millicores>", "CPU millicores", "2000")
    .option("--memory <mb>", "Memory in MB", "4096")
    .option("--storage <mb>", "Storage in MB", "50000")
    .action(async (opts) => {
      try {
        const txHash = await soul.registerCarrier(
          opts.carrierId,
          opts.endpoint,
          parseInt(opts.cpu),
          parseInt(opts.memory),
          parseInt(opts.storage),
        )
        console.log(`Carrier registered!`)
        console.log(`  Carrier ID: ${opts.carrierId}`)
        console.log(`  Endpoint:   ${opts.endpoint}`)
        console.log(`  TX Hash:    ${txHash}`)
      } catch (error) {
        logger.error(`Carrier registration failed: ${String(error)}`)
        process.exit(1)
      }
    })

  carrierCmd
    .command("list")
    .description("List known carriers")
    .action(async () => {
      console.log("Carrier list requires an on-chain indexer (not yet implemented)")
    })
}
