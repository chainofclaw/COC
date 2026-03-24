// CLI commands for COC Soul Backup extension

import { keccak256, toUtf8Bytes } from "ethers"
import type { Command } from "commander"
import type { CocBackupConfig } from "../config-schema.ts"
import type { SoulClient } from "../soul-client.ts"
import type { IpfsClient } from "../ipfs-client.ts"
import type { BackupScheduler } from "../backup/scheduler.ts"
import { restoreFromManifestCid } from "../recovery/state-restorer.ts"

interface Logger {
  info(msg: string): void
  error(msg: string): void
  warn(msg: string): void
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

  // --- coc-backup register ---
  cmd
    .command("register")
    .description("Register soul identity on-chain")
    .option("--agent-id <id>", "Agent ID (bytes32 hex). Auto-derived from wallet if omitted")
    .option("--identity-cid <cid>", "IPFS CID of identity files")
    .action(async (opts) => {
      try {
        const agentId = opts.agentId ?? keccak256(toUtf8Bytes(soul.address))
        let identityCid = opts.identityCid

        if (!identityCid) {
          // Upload identity files to IPFS
          const { readFile } = await import("node:fs/promises")
          const baseDir = config.dataDir.replace(/^~/, process.env.HOME ?? "")

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

  // --- coc-backup backup ---
  cmd
    .command("backup")
    .description("Execute a backup now")
    .option("--full", "Force full backup (ignore incremental state)")
    .action(async (opts) => {
      try {
        const result = await scheduler.runBackup(opts.full)
        if (!result) {
          console.log("No backup needed (no changes detected)")
          return
        }
        console.log(`Backup complete!`)
        console.log(`  Files:      ${result.fileCount}`)
        console.log(`  Size:       ${formatBytes(result.totalBytes)}`)
        console.log(`  Type:       ${result.backupType === 0 ? "full" : "incremental"}`)
        console.log(`  CID:        ${result.manifestCid}`)
        console.log(`  Merkle:     ${result.dataMerkleRoot}`)
        if (result.txHash) {
          console.log(`  TX Hash:    ${result.txHash}`)
        }
      } catch (error) {
        logger.error(`Backup failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // --- coc-backup restore ---
  cmd
    .command("restore")
    .description("Restore soul from IPFS backup")
    .requiredOption("--manifest-cid <cid>", "Manifest IPFS CID to restore from")
    .option("--target-dir <dir>", "Target directory (default: config dataDir)")
    .option("--password <password>", "Decryption password (if using password-based encryption)")
    .action(async (opts) => {
      try {
        const targetDir = (opts.targetDir ?? config.dataDir).replace(/^~/, process.env.HOME ?? "")
        const isPassword = opts.password !== undefined
        const key = opts.password ?? config.privateKey

        const consoleLogger = {
          info: (msg: string) => console.log(`  ${msg}`),
          error: (msg: string) => console.error(`  ERROR: ${msg}`),
          warn: (msg: string) => console.warn(`  WARN: ${msg}`),
        }

        console.log(`Restoring to ${targetDir}...`)
        const result = await restoreFromManifestCid(
          opts.manifestCid,
          targetDir,
          ipfs,
          key,
          isPassword,
          consoleLogger,
        )

        console.log(`\nRestore complete!`)
        console.log(`  Files restored:   ${result.filesRestored}`)
        console.log(`  Total size:       ${formatBytes(result.totalBytes)}`)
        console.log(`  Backups applied:  ${result.backupsApplied}`)
        console.log(`  Merkle verified:  ${result.merkleVerified ? "YES" : "FAILED"}`)
      } catch (error) {
        logger.error(`Restore failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // --- coc-backup status ---
  cmd
    .command("status")
    .description("Show soul backup status")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        const agentId = await soul.getAgentIdForOwner()
        const zeroId = "0x" + "0".repeat(64)

        if (agentId === zeroId) {
          console.log("No soul registered for this wallet")
          console.log(`Run "openclaw coc-backup register" to register`)
          return
        }

        const soulInfo = await soul.getSoul(agentId)
        const ipfsReachable = await ipfs.ping()

        if (opts.json) {
          console.log(JSON.stringify({ ...soulInfo, ipfsReachable }, null, 2))
          return
        }

        console.log(`Soul Status`)
        console.log(`  Agent ID:     ${soulInfo.agentId}`)
        console.log(`  Owner:        ${soulInfo.owner}`)
        console.log(`  Active:       ${soulInfo.active}`)
        console.log(`  Version:      ${soulInfo.version}`)
        console.log(`  Registered:   ${new Date(soulInfo.registeredAt * 1000).toISOString()}`)
        console.log(`  Backups:      ${soulInfo.backupCount}`)
        if (soulInfo.lastBackupAt > 0) {
          console.log(`  Last backup:  ${new Date(soulInfo.lastBackupAt * 1000).toISOString()}`)
        }
        console.log(`  IPFS:         ${ipfsReachable ? "reachable" : "unreachable"}`)
      } catch (error) {
        logger.error(`Status failed: ${String(error)}`)
        process.exit(1)
      }
    })

  // --- coc-backup history ---
  cmd
    .command("history")
    .description("Show backup history")
    .option("--limit <n>", "Number of entries to show", "10")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        const agentId = await soul.getAgentIdForOwner()
        const zeroId = "0x" + "0".repeat(64)

        if (agentId === zeroId) {
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
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
