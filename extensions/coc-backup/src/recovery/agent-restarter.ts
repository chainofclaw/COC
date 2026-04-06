// Agent restarter: signals OpenClaw to reload after state restoration

import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

export interface RestoreMarker {
  version: 1
  restoredAt: string
  manifestCid: string
  agentId: string
  filesRestored: number
  totalBytes: number
  backupsApplied: number
  merkleVerified: boolean
}

/**
 * Write a restore-complete marker file so the OpenClaw agent (or carrier daemon)
 * knows that a restore just happened and can reload state accordingly.
 */
export async function writeRestoreMarker(
  targetDir: string,
  marker: RestoreMarker,
): Promise<string> {
  const markerDir = join(targetDir, ".coc-backup")
  await mkdir(markerDir, { recursive: true })
  const markerPath = join(markerDir, "restore-complete.json")
  await writeFile(markerPath, JSON.stringify(marker, null, 2))
  return markerPath
}

/**
 * Attempt to notify a running OpenClaw gateway process that restoration is complete.
 * This is best-effort: if no process is listening, it silently succeeds.
 */
export async function notifyAgentRestart(
  targetDir: string,
  logger: { info(msg: string): void; warn(msg: string): void },
): Promise<void> {
  // Strategy 1: Write marker file (passive — agent checks on next startup)
  // Already done by writeRestoreMarker()

  // Strategy 2: Send IPC signal via pid file if the agent is running
  const pidPath = join(targetDir, ".coc-backup", "agent.pid")
  try {
    const { readFile } = await import("node:fs/promises")
    const pidStr = await readFile(pidPath, "utf8")
    const pid = parseInt(pidStr.trim(), 10)
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, "SIGUSR2") // USR2 = reload signal convention
      logger.info(`Sent SIGUSR2 to agent process ${pid}`)
    }
  } catch {
    logger.warn("No running agent process found to notify — agent will pick up restored state on next start")
  }
}
