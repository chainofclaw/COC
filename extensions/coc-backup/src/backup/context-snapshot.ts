// Capture active session context before backup
// Writes a lightweight snapshot of the current conversational state

import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

export interface ContextSnapshot {
  version: 1
  capturedAt: string
  activeSessions: ActiveSessionInfo[]
}

export interface ActiveSessionInfo {
  sessionId: string
  sessionKey: string
  messageCount: number
  lastMessageAt: string | null
  estimatedTokens: number
  sizeBytes: number
}

/**
 * Capture a snapshot of active session context and write to .coc-backup/context-snapshot.json.
 * This is called before each backup to preserve conversational state metadata.
 */
export async function captureContextSnapshot(baseDir: string): Promise<void> {
  const snapshotDir = join(baseDir, ".coc-backup")
  await mkdir(snapshotDir, { recursive: true })

  const snapshot: ContextSnapshot = {
    version: 1,
    capturedAt: new Date().toISOString(),
    activeSessions: [],
  }

  // Scan for agent session directories
  const agentsDir = join(baseDir, "agents")
  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true })

    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue

      const sessionsDir = join(agentsDir, agentEntry.name, "sessions")
      const registryPath = join(sessionsDir, "sessions.json")

      try {
        const registryContent = await readFile(registryPath, "utf8")
        const registry: Record<string, { sessionId: string; updatedAt?: string }> =
          JSON.parse(registryContent)

        for (const [sessionKey, entry] of Object.entries(registry)) {
          const sessionFile = join(sessionsDir, `${entry.sessionId}.jsonl`)
          try {
            const fileStat = await stat(sessionFile)
            const { messageCount, lastMessageAt, estimatedTokens } =
              await analyzeTranscript(sessionFile)

            snapshot.activeSessions.push({
              sessionId: entry.sessionId,
              sessionKey,
              messageCount,
              lastMessageAt,
              estimatedTokens,
              sizeBytes: fileStat.size,
            })
          } catch {
            // Session file missing or unreadable, skip
          }
        }
      } catch {
        // No sessions.json, skip this agent
      }
    }
  } catch {
    // No agents directory, that's fine
  }

  const snapshotPath = join(snapshotDir, "context-snapshot.json")
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2))
}

/**
 * Analyze a JSONL transcript to extract message count and token estimate.
 * Only reads the last portion to stay fast on large files.
 */
async function analyzeTranscript(
  filePath: string,
): Promise<{ messageCount: number; lastMessageAt: string | null; estimatedTokens: number }> {
  const content = await readFile(filePath, "utf8")
  const lines = content.trim().split("\n").filter(Boolean)

  let messageCount = 0
  let lastMessageAt: string | null = null
  let totalChars = 0

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.type === "session") continue // skip header
      messageCount++
      totalChars += line.length
      if (entry.timestamp) {
        lastMessageAt = entry.timestamp
      }
    } catch {
      // Malformed line, skip
    }
  }

  // Rough token estimate: ~4 chars per token
  const estimatedTokens = Math.ceil(totalChars / 4)

  return { messageCount, lastMessageAt, estimatedTokens }
}
