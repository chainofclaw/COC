// Agent spawner: launches a restored OpenClaw agent process on the carrier node

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"

interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface SpawnConfig {
  dataDir: string
  agentId: string
  entryScript: string
  runtimeArgs?: string[]
  env?: Record<string, string>
  healthCheckUrl?: string
  healthCheckIntervalMs?: number
  healthCheckTimeoutMs?: number
}

export interface SpawnResult {
  pid: number
  process: ChildProcess
}

/**
 * Spawn an OpenClaw agent process with the restored data directory.
 */
export function spawnAgent(config: SpawnConfig, logger: Logger): SpawnResult {
  const args = [
    "--experimental-strip-types",
    ...(config.runtimeArgs ?? []),
    config.entryScript,
  ]

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: config.dataDir,
    COC_AGENT_ID: config.agentId,
    ...config.env,
  }

  logger.info(`Spawning agent: node ${args.join(" ")}`)

  const child = spawn("node", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  child.stdout?.on("data", (data: Buffer) => {
    logger.info(`[agent:${config.agentId.slice(0, 10)}] ${data.toString().trim()}`)
  })

  child.stderr?.on("data", (data: Buffer) => {
    logger.warn(`[agent:${config.agentId.slice(0, 10)}] ${data.toString().trim()}`)
  })

  child.on("exit", (code) => {
    logger.info(`Agent process exited with code ${code}`)
  })

  child.unref()

  const pid = child.pid
  if (!pid) {
    throw new Error("Failed to spawn agent process: no PID returned")
  }

  logger.info(`Agent spawned with PID ${pid}`)
  return { pid, process: child }
}

/**
 * Wait for the spawned agent to become healthy.
 * Polls a health endpoint with exponential backoff.
 */
export async function waitForHealthy(
  config: SpawnConfig,
  logger: Logger,
  shutdownSignal?: AbortSignal,
): Promise<boolean> {
  const url = config.healthCheckUrl ?? `http://127.0.0.1:18789/health`
  const timeoutMs = config.healthCheckTimeoutMs ?? 120_000
  const intervalMs = config.healthCheckIntervalMs ?? 5_000
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    if (shutdownSignal?.aborted) return false

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      if (res.ok) {
        logger.info("Agent health check passed")
        return true
      }
    } catch {
      // Not ready yet
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs)
      shutdownSignal?.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  logger.warn(`Agent health check timed out after ${timeoutMs}ms`)
  return false
}

/**
 * Stop a running agent process gracefully.
 */
export function stopAgent(pid: number, logger: Logger): void {
  try {
    process.kill(pid, "SIGTERM")
    logger.info(`Sent SIGTERM to agent PID ${pid}`)
  } catch (error) {
    logger.warn(`Failed to stop agent PID ${pid}: ${String(error)}`)
  }
}
