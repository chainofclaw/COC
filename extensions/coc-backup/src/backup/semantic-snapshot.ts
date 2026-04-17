// Semantic snapshot: extract structured observations and summaries from claude-mem's SQLite database
// Writes a token-budgeted snapshot for backup, enabling context injection on recovery

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, basename } from "node:path"

const CHARS_PER_TOKEN = 4

export interface SemanticSnapshot {
  version: 1
  capturedAt: string
  tokenBudget: number
  tokensUsed: number
  observations: ObservationEntry[]
  summaries: SummaryEntry[]
  activeProjects: string[]
}

export interface ObservationEntry {
  id: number
  type: string
  title: string | null
  facts: string[]
  narrative: string | null
  concepts: string[]
  createdAt: string
}

export interface SummaryEntry {
  request: string | null
  learned: string | null
  completed: string | null
  next_steps: string | null
  createdAt: string
}

export interface SemanticSnapshotConfig {
  enabled: boolean
  tokenBudget: number
  maxObservations: number
  maxSummaries: number
  claudeMemDbPath: string
}

const DEFAULT_CONFIG: SemanticSnapshotConfig = {
  enabled: true,
  tokenBudget: 8000,
  maxObservations: 50,
  maxSummaries: 10,
  claudeMemDbPath: "",
}

/** Estimate token count for a string */
function estimateTokens(text: string | null): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Estimate tokens for an observation entry */
function observationTokens(obs: ObservationEntry): number {
  let chars = 0
  if (obs.title) chars += obs.title.length
  if (obs.narrative) chars += obs.narrative.length
  for (const fact of obs.facts) chars += fact.length
  for (const concept of obs.concepts) chars += concept.length
  chars += obs.type.length + (obs.createdAt?.length ?? 0)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Estimate tokens for a summary entry */
function summaryTokens(summary: SummaryEntry): number {
  let chars = 0
  if (summary.request) chars += summary.request.length
  if (summary.learned) chars += summary.learned.length
  if (summary.completed) chars += summary.completed.length
  if (summary.next_steps) chars += summary.next_steps.length
  chars += summary.createdAt?.length ?? 0
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Parse JSON array field from SQLite (stored as JSON string) */
function parseJsonArray(value: unknown): string[] {
  if (!value || typeof value !== "string") return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** Try to find and open the claude-mem SQLite database */
async function openClaudeMemDb(
  config: SemanticSnapshotConfig,
): Promise<{ db: InstanceType<typeof import("node:sqlite").DatabaseSync>; close: () => void } | null> {
  // Dynamic import node:sqlite (experimental in Node 22+)
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync
  try {
    const sqliteModule = await import("node:sqlite")
    DatabaseSync = sqliteModule.DatabaseSync
  } catch {
    return null
  }

  // Try explicit path first
  if (config.claudeMemDbPath) {
    try {
      const db = new DatabaseSync(config.claudeMemDbPath, { open: true, readOnly: true })
      return { db, close: () => db.close() }
    } catch {
      return null
    }
  }

  // Try well-known location: ~/.claude-mem/claude-mem.db
  const homedir = (await import("node:os")).homedir()
  const defaultPath = join(homedir, ".claude-mem", "claude-mem.db")
  try {
    const db = new DatabaseSync(defaultPath, { open: true, readOnly: true })
    return { db, close: () => db.close() }
  } catch {
    return null
  }
}

/** Query observations from claude-mem database */
function queryObservations(
  db: InstanceType<typeof import("node:sqlite").DatabaseSync>,
  maxRows: number,
): ObservationEntry[] {
  const rows = db
    .prepare(
      `SELECT id, type, title, facts, narrative, concepts, created_at
       FROM observations
       ORDER BY created_at_epoch DESC
       LIMIT ?`,
    )
    .all(maxRows) as Array<{
    id: number
    type: string
    title: string | null
    facts: string | null
    narrative: string | null
    concepts: string | null
    created_at: string
  }>

  return rows.map((row) => ({
    id: row.id,
    type: row.type ?? "unknown",
    title: row.title,
    facts: parseJsonArray(row.facts),
    narrative: row.narrative,
    concepts: parseJsonArray(row.concepts),
    createdAt: row.created_at,
  }))
}

/** Query session summaries from claude-mem database */
function querySummaries(
  db: InstanceType<typeof import("node:sqlite").DatabaseSync>,
  maxRows: number,
): SummaryEntry[] {
  const rows = db
    .prepare(
      `SELECT request, learned, completed, next_steps, created_at
       FROM session_summaries
       ORDER BY created_at_epoch DESC
       LIMIT ?`,
    )
    .all(maxRows) as Array<{
    request: string | null
    learned: string | null
    completed: string | null
    next_steps: string | null
    created_at: string
  }>

  return rows.map((row) => ({
    request: row.request,
    learned: row.learned,
    completed: row.completed,
    next_steps: row.next_steps,
    createdAt: row.created_at,
  }))
}

/** Query distinct active projects */
function queryProjects(
  db: InstanceType<typeof import("node:sqlite").DatabaseSync>,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT project FROM observations
       WHERE project IS NOT NULL AND project != ''
       ORDER BY created_at_epoch DESC
       LIMIT 20`,
    )
    .all() as Array<{ project: string }>

  return rows.map((r) => r.project)
}

/**
 * Capture a semantic snapshot from claude-mem's database.
 * Greedily packs observations and summaries within the token budget.
 * Writes result to .coc-backup/semantic-snapshot.json.
 */
export async function captureSemanticSnapshot(
  baseDir: string,
  config?: Partial<SemanticSnapshotConfig>,
): Promise<SemanticSnapshot> {
  const cfg: SemanticSnapshotConfig = { ...DEFAULT_CONFIG, ...config }

  const emptySnapshot: SemanticSnapshot = {
    version: 1,
    capturedAt: new Date().toISOString(),
    tokenBudget: cfg.tokenBudget,
    tokensUsed: 0,
    observations: [],
    summaries: [],
    activeProjects: [],
  }

  if (!cfg.enabled) {
    await writeSnapshot(baseDir, emptySnapshot)
    return emptySnapshot
  }

  const connection = await openClaudeMemDb(cfg)
  if (!connection) {
    // claude-mem database not found — graceful degradation
    await writeSnapshot(baseDir, emptySnapshot)
    return emptySnapshot
  }

  try {
    const allObservations = queryObservations(connection.db, cfg.maxObservations)
    const allSummaries = querySummaries(connection.db, cfg.maxSummaries)
    const activeProjects = queryProjects(connection.db)

    // Greedy packing: summaries first (higher information density), then observations
    let tokensUsed = 0
    const packedSummaries: SummaryEntry[] = []
    const packedObservations: ObservationEntry[] = []

    for (const summary of allSummaries) {
      const tokens = summaryTokens(summary)
      if (tokensUsed + tokens > cfg.tokenBudget) break
      packedSummaries.push(summary)
      tokensUsed += tokens
    }

    for (const obs of allObservations) {
      const tokens = observationTokens(obs)
      if (tokensUsed + tokens > cfg.tokenBudget) break
      packedObservations.push(obs)
      tokensUsed += tokens
    }

    const snapshot: SemanticSnapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      tokenBudget: cfg.tokenBudget,
      tokensUsed,
      observations: packedObservations,
      summaries: packedSummaries,
      activeProjects,
    }

    await writeSnapshot(baseDir, snapshot)
    return snapshot
  } finally {
    connection.close()
  }
}

async function writeSnapshot(baseDir: string, snapshot: SemanticSnapshot): Promise<void> {
  const snapshotDir = join(baseDir, ".coc-backup")
  await mkdir(snapshotDir, { recursive: true })
  const snapshotPath = join(snapshotDir, "semantic-snapshot.json")
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2))
}

/**
 * Read a previously written semantic snapshot from disk.
 * Returns null if file doesn't exist or is malformed.
 */
export async function readSemanticSnapshot(baseDir: string): Promise<SemanticSnapshot | null> {
  const snapshotPath = join(baseDir, ".coc-backup", "semantic-snapshot.json")
  try {
    const content = await readFile(snapshotPath, "utf8")
    const parsed = JSON.parse(content)
    if (parsed.version !== 1) return null
    return parsed as SemanticSnapshot
  } catch {
    return null
  }
}
