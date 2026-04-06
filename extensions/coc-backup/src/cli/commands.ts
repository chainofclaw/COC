// CLI commands for COC Soul Backup extension

import { readFile } from "node:fs/promises"
import { keccak256, toUtf8Bytes } from "ethers"
import type { Command } from "commander"
import type { CocBackupConfig } from "../config-schema.ts"
import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { BackupScheduler } from "../backup/scheduler.ts"
import type { CarrierDaemon } from "../carrier/carrier-daemon.ts"
import type { DIDClient } from "../did-client.ts"
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
  getDaemon?: () => CarrierDaemon | null,
  didClient?: DIDClient,
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

  carrierCmd
    .command("submit-request")
    .description("Submit a pending resurrection request to the local carrier daemon")
    .requiredOption("--request-id <id>", "Resurrection request ID (bytes32)")
    .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
    .action(async (opts) => {
      const daemon = getDaemon?.()
      if (!daemon) {
        logger.error("Carrier daemon is not running. Enable carrier mode in plugin config (carrier.enabled = true).")
        process.exit(1)
      }
      const result = daemon.addRequest(opts.requestId, opts.agentId)
      if (!result.accepted) {
        logger.error(`Request rejected: ${result.reason}`)
        process.exit(1)
      }
      console.log(`Request accepted by carrier daemon:`)
      console.log(`  Request ID: ${opts.requestId}`)
      console.log(`  Agent ID:   ${opts.agentId}`)
    })

  // Guardian commands (separate from carrier commands)
  const guardianCmd = cmd.command("guardian").description("Guardian-side resurrection operations")

  guardianCmd
    .command("initiate")
    .description("Guardian: initiate resurrection for an offline agent")
    .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
    .requiredOption("--carrier-id <id>", "Target carrier ID (bytes32)")
    .action(async (opts) => {
      try {
        const result = await soul.initiateGuardianResurrection(opts.agentId, opts.carrierId)
        console.log("Guardian resurrection initiated!")
        console.log(`  Request ID: ${result.requestId}`)
        console.log(`  TX Hash:    ${result.txHash}`)
        console.log(`\nNext: other guardians should run 'coc-backup guardian approve --request-id ${result.requestId}'`)
      } catch (error) {
        logger.error(`Guardian initiation failed: ${String(error)}`)
        process.exit(1)
      }
    })

  guardianCmd
    .command("approve")
    .description("Guardian: approve a pending resurrection request")
    .requiredOption("--request-id <id>", "Resurrection request ID (bytes32)")
    .action(async (opts) => {
      try {
        const txHash = await soul.approveResurrection(opts.requestId)
        console.log("Resurrection approved!")
        console.log(`  Request ID: ${opts.requestId}`)
        console.log(`  TX Hash:    ${txHash}`)
      } catch (error) {
        logger.error(`Guardian approval failed: ${String(error)}`)
        process.exit(1)
      }
    })

  guardianCmd
    .command("status")
    .description("Check readiness of a resurrection request")
    .requiredOption("--request-id <id>", "Resurrection request ID (bytes32)")
    .action(async (opts) => {
      try {
        const readiness = await soul.getResurrectionReadiness(opts.requestId)
        console.log(`Request: ${opts.requestId}`)
        console.log(`  Exists:     ${readiness.exists}`)
        console.log(`  Trigger:    ${readiness.trigger}`)
        console.log(`  Approvals:  ${readiness.approvalCount}/${readiness.approvalThreshold}`)
        console.log(`  Carrier OK: ${readiness.carrierConfirmed}`)
        console.log(`  Offline:    ${readiness.offlineNow}`)
        console.log(`  Can Complete: ${readiness.canComplete}`)
      } catch (error) {
        logger.error(`Status check failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // Guardian management subcommands
  guardianCmd
    .command("add")
    .description("Add a guardian to the agent's soul")
    .option("--agent-id <id>", "Agent ID (bytes32). Defaults to wallet's agent.")
    .requiredOption("--guardian <address>", "Guardian Ethereum address")
    .action(async (opts) => {
      try {
        const agentId = opts.agentId ?? await soul.getAgentIdForOwner()
        const txHash = await soul.addGuardian(agentId, opts.guardian)
        console.log(`Guardian added!`)
        console.log(`  Agent:    ${agentId}`)
        console.log(`  Guardian: ${opts.guardian}`)
        console.log(`  TX Hash:  ${txHash}`)
      } catch (error) {
        logger.error(`Add guardian failed: ${String(error)}`)
        process.exit(1)
      }
    })

  guardianCmd
    .command("remove")
    .description("Remove a guardian from the agent's soul")
    .option("--agent-id <id>", "Agent ID (bytes32). Defaults to wallet's agent.")
    .requiredOption("--guardian <address>", "Guardian Ethereum address")
    .action(async (opts) => {
      try {
        const agentId = opts.agentId ?? await soul.getAgentIdForOwner()
        const txHash = await soul.removeGuardian(agentId, opts.guardian)
        console.log(`Guardian removed!`)
        console.log(`  Agent:    ${agentId}`)
        console.log(`  Guardian: ${opts.guardian}`)
        console.log(`  TX Hash:  ${txHash}`)
      } catch (error) {
        logger.error(`Remove guardian failed: ${String(error)}`)
        process.exit(1)
      }
    })

  guardianCmd
    .command("list")
    .description("List guardians for an agent")
    .option("--agent-id <id>", "Agent ID (bytes32). Defaults to wallet's agent.")
    .action(async (opts) => {
      try {
        const agentId = opts.agentId ?? await soul.getAgentIdForOwner()
        const { guardians, activeCount } = await soul.listGuardians(agentId)
        console.log(`Guardians for ${agentId} (${activeCount} active):`)
        for (const g of guardians) {
          const status = g.active ? "ACTIVE" : "INACTIVE"
          console.log(`  ${g.guardian} [${status}] added ${new Date(g.addedAt * 1000).toISOString()}`)
        }
      } catch (error) {
        logger.error(`List guardians failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // Social recovery subcommands
  const recoveryCmd = cmd.command("recovery").description("Social recovery (guardian-initiated owner migration)")

  recoveryCmd
    .command("initiate")
    .description("Guardian: initiate owner recovery for an agent")
    .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
    .requiredOption("--new-owner <address>", "New owner Ethereum address")
    .action(async (opts) => {
      try {
        const requestId = await soul.initiateRecovery(opts.agentId, opts.newOwner)
        console.log("Recovery initiated!")
        console.log(`  Request ID: ${requestId}`)
        console.log(`  Agent:      ${opts.agentId}`)
        console.log(`  New Owner:  ${opts.newOwner}`)
        console.log(`\nNext: other guardians should run 'coc-backup recovery approve --request-id ${requestId}'`)
      } catch (error) {
        logger.error(`Recovery initiation failed: ${String(error)}`)
        process.exit(1)
      }
    })

  recoveryCmd
    .command("approve")
    .description("Guardian: approve a pending recovery request")
    .requiredOption("--request-id <id>", "Recovery request ID (bytes32)")
    .action(async (opts) => {
      try {
        const txHash = await soul.approveRecovery(opts.requestId)
        console.log(`Recovery approved!`)
        console.log(`  Request ID: ${opts.requestId}`)
        console.log(`  TX Hash:    ${txHash}`)
      } catch (error) {
        logger.error(`Recovery approval failed: ${String(error)}`)
        process.exit(1)
      }
    })

  recoveryCmd
    .command("complete")
    .description("Complete a recovery after quorum + timelock satisfied")
    .requiredOption("--request-id <id>", "Recovery request ID (bytes32)")
    .action(async (opts) => {
      try {
        const txHash = await soul.completeRecovery(opts.requestId)
        console.log(`Recovery completed! Ownership transferred.`)
        console.log(`  Request ID: ${opts.requestId}`)
        console.log(`  TX Hash:    ${txHash}`)
      } catch (error) {
        logger.error(`Recovery completion failed: ${String(error)}`)
        process.exit(1)
      }
    })

  recoveryCmd
    .command("cancel")
    .description("Owner: cancel a pending recovery request")
    .requiredOption("--request-id <id>", "Recovery request ID (bytes32)")
    .action(async (opts) => {
      try {
        const txHash = await soul.cancelRecovery(opts.requestId)
        console.log(`Recovery cancelled.`)
        console.log(`  Request ID: ${opts.requestId}`)
        console.log(`  TX Hash:    ${txHash}`)
      } catch (error) {
        logger.error(`Recovery cancel failed: ${String(error)}`)
        process.exit(1)
      }
    })

  recoveryCmd
    .command("status")
    .description("Check status of a recovery request")
    .requiredOption("--request-id <id>", "Recovery request ID (bytes32)")
    .action(async (opts) => {
      try {
        const req = await soul.getRecoveryRequest(opts.requestId)
        console.log(`Recovery Request: ${opts.requestId}`)
        console.log(`  Agent:          ${req.agentId}`)
        console.log(`  New Owner:      ${req.newOwner}`)
        console.log(`  Initiator:      ${req.initiator}`)
        console.log(`  Approvals:      ${req.approvalCount}/${Math.ceil(req.guardianSnapshot * 2 / 3)}`)
        console.log(`  Executed:       ${req.executed}`)
        console.log(`  Initiated At:   ${new Date(req.initiatedAt * 1000).toISOString()}`)
      } catch (error) {
        logger.error(`Recovery status failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // DID management commands (requires DIDClient)
  if (didClient) {
    const didCmd = cmd.command("did").description("DID identity management (DIDRegistry operations)")

    didCmd
      .command("add-key")
      .description("Add a verification method to the DID Document")
      .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
      .requiredOption("--key-id <id>", "Key identifier (bytes32)")
      .requiredOption("--key-address <addr>", "Key Ethereum address")
      .requiredOption("--purpose <mask>", "Key purpose bitmask (1=auth, 2=assertion, 4=capInvoke, 8=capDelegate)")
      .action(async (opts) => {
        try {
          const txHash = await didClient.addVerificationMethod(
            opts.agentId, opts.keyId, opts.keyAddress, parseInt(opts.purpose),
          )
          console.log(`Verification method added!`)
          console.log(`  Key ID:   ${opts.keyId}`)
          console.log(`  TX Hash:  ${txHash}`)
        } catch (error) {
          logger.error(`Add key failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("revoke-key")
      .description("Revoke a verification method")
      .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
      .requiredOption("--key-id <id>", "Key identifier (bytes32)")
      .action(async (opts) => {
        try {
          const txHash = await didClient.revokeVerificationMethod(opts.agentId, opts.keyId)
          console.log(`Verification method revoked!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Revoke key failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("delegate")
      .description("Grant a delegation to another agent")
      .requiredOption("--delegator <id>", "Delegator agent ID (bytes32)")
      .requiredOption("--delegatee <id>", "Delegatee agent ID (bytes32)")
      .requiredOption("--scope <hash>", "Scope hash (bytes32)")
      .requiredOption("--expires <ts>", "Expiration unix timestamp")
      .option("--parent <id>", "Parent delegation ID (bytes32)", "0x" + "0".repeat(64))
      .option("--depth <n>", "Delegation depth (0-3)", "1")
      .action(async (opts) => {
        try {
          const txHash = await didClient.grantDelegation(
            opts.delegator, opts.delegatee, opts.parent,
            opts.scope, parseInt(opts.expires), parseInt(opts.depth),
          )
          console.log(`Delegation granted!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Delegate failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("revoke-delegation")
      .description("Revoke a delegation")
      .requiredOption("--delegation-id <id>", "Delegation ID (bytes32)")
      .action(async (opts) => {
        try {
          const txHash = await didClient.revokeDelegation(opts.delegationId)
          console.log(`Delegation revoked!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Revoke delegation failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("keys")
      .description("List active verification methods for an agent")
      .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
      .action(async (opts) => {
        try {
          const methods = await didClient.getVerificationMethods(opts.agentId)
          console.log(`Verification methods for ${opts.agentId}:`)
          for (const vm of methods) {
            console.log(`  ${vm.keyId} → ${vm.keyAddress} [purpose=${vm.keyPurpose}] ${vm.active ? "ACTIVE" : "REVOKED"}`)
          }
        } catch (error) {
          logger.error(`List keys failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("delegations")
      .description("List delegations for an agent")
      .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
      .action(async (opts) => {
        try {
          const delegations = await didClient.getDelegations(opts.agentId)
          console.log(`Delegations for ${opts.agentId}:`)
          for (const d of delegations) {
            const status = d.revoked ? "REVOKED" : "ACTIVE"
            console.log(`  ${d.delegationId} → ${d.delegatee} [scope=${d.scopeHash.slice(0, 10)}...] ${status}`)
          }
        } catch (error) {
          logger.error(`List delegations failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("update-doc")
      .description("Update the DID document CID on-chain")
      .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
      .requiredOption("--document-cid <hash>", "New document CID hash (bytes32)")
      .action(async (opts) => {
        try {
          const txHash = await didClient.updateDIDDocument(opts.agentId, opts.documentCid)
          console.log(`DID document updated!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Update DID document failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("revoke-all-delegations")
      .description("Emergency: revoke all delegations for an agent")
      .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
      .action(async (opts) => {
        try {
          const txHash = await didClient.revokeAllDelegations(opts.agentId)
          console.log(`All delegations revoked!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Revoke all delegations failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("anchor-credential")
      .description("Anchor a verifiable credential on-chain")
      .requiredOption("--credential-hash <hash>", "Credential hash (bytes32)")
      .requiredOption("--issuer <id>", "Issuer agent ID (bytes32)")
      .requiredOption("--subject <id>", "Subject agent ID (bytes32)")
      .requiredOption("--credential-cid <hash>", "Credential CID hash (bytes32)")
      .requiredOption("--expires <ts>", "Expiration unix timestamp")
      .action(async (opts) => {
        try {
          const txHash = await didClient.anchorCredential(
            opts.credentialHash, opts.issuer, opts.subject,
            opts.credentialCid, parseInt(opts.expires),
          )
          console.log(`Credential anchored!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Anchor credential failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("revoke-credential")
      .description("Revoke a verifiable credential")
      .requiredOption("--credential-id <id>", "Credential ID (bytes32)")
      .action(async (opts) => {
        try {
          const txHash = await didClient.revokeCredential(opts.credentialId)
          console.log(`Credential revoked!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Revoke credential failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("record-lineage")
      .description("Record agent lineage (fork relationship)")
      .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
      .requiredOption("--parent <id>", "Parent agent ID (bytes32)")
      .requiredOption("--fork-height <n>", "Fork block height")
      .requiredOption("--generation <n>", "Generation number")
      .action(async (opts) => {
        try {
          const txHash = await didClient.recordLineage(
            opts.agentId, opts.parent,
            parseInt(opts.forkHeight), parseInt(opts.generation),
          )
          console.log(`Lineage recorded!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Record lineage failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("update-capabilities")
      .description("Update capability bitmask for an agent")
      .requiredOption("--agent-id <id>", "Agent ID (bytes32)")
      .requiredOption("--capabilities <mask>", "Capability bitmask (uint16)")
      .action(async (opts) => {
        try {
          const txHash = await didClient.updateCapabilities(opts.agentId, parseInt(opts.capabilities))
          console.log(`Capabilities updated!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Update capabilities failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("create-ephemeral")
      .description("Create an ephemeral sub-identity")
      .requiredOption("--parent <id>", "Parent agent ID (bytes32)")
      .requiredOption("--ephemeral-id <id>", "Ephemeral identity ID (bytes32)")
      .requiredOption("--ephemeral-address <addr>", "Ephemeral address")
      .requiredOption("--scope <hash>", "Scope hash (bytes32)")
      .requiredOption("--expires <ts>", "Expiration unix timestamp")
      .action(async (opts) => {
        try {
          const txHash = await didClient.createEphemeralIdentity(
            opts.parent, opts.ephemeralId, opts.ephemeralAddress,
            opts.scope, parseInt(opts.expires),
          )
          console.log(`Ephemeral identity created!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Create ephemeral identity failed: ${String(error)}`)
          process.exit(1)
        }
      })

    didCmd
      .command("deactivate-ephemeral")
      .description("Deactivate an ephemeral sub-identity")
      .requiredOption("--ephemeral-id <id>", "Ephemeral identity ID (bytes32)")
      .action(async (opts) => {
        try {
          const txHash = await didClient.deactivateEphemeralIdentity(opts.ephemeralId)
          console.log(`Ephemeral identity deactivated!`)
          console.log(`  TX Hash: ${txHash}`)
        } catch (error) {
          logger.error(`Deactivate ephemeral failed: ${String(error)}`)
          process.exit(1)
        }
      })
  }
}
