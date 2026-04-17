// Memory search: enables semantic search across backed-up observations and summaries
// Two-layer strategy:
// 1. Proxy to claude-mem worker if available (http://127.0.0.1:37777)
// 2. Fall back to direct SQLite FTS5 queries on restored database

import { readdir } from "node:fs/promises"
import { join } from "node:path"

export interface MemorySearchResult {
  source: "claude-mem-worker" | "sqlite-fts" | "sqlite-like"
  results: MemoryHit[]
  totalCount: number
}

export interface MemoryHit {
  id: number
  type: string
  title: string | null
  narrative: string | null
  facts: string[]
  concepts: string[]
  createdAt: string
  score?: number
}

export interface SearchOptions {
  query: string
  limit?: number
  type?: string
  claudeMemWorkerUrl?: string
  dataDir?: string
}

/**
 * Search the agent's semantic memories.
 * Tries claude-mem worker first, falls back to SQLite.
 */
export async function searchMemories(options: SearchOptions): Promise<MemorySearchResult> {
  const { query, limit = 10, type, claudeMemWorkerUrl = "http://127.0.0.1:37777" } = options

  // Try claude-mem worker first
  try {
    const result = await searchViaWorker(claudeMemWorkerUrl, query, limit, type)
    if (result) return result
  } catch {
    // Worker not available, fall through to SQLite
  }

  // Fall back to direct SQLite search
  if (options.dataDir) {
    try {
      const result = await searchViaSqlite(options.dataDir, query, limit, type)
      if (result) return result
    } catch {
      // SQLite search failed
    }
  }

  return { source: "sqlite-like", results: [], totalCount: 0 }
}

/** Search via claude-mem worker HTTP API */
async function searchViaWorker(
  workerUrl: string,
  query: string,
  limit: number,
  type?: string,
): Promise<MemorySearchResult | null> {
  // Check health first (fast fail)
  const healthResponse = await fetch(`${workerUrl}/health`, {
    signal: AbortSignal.timeout(2000),
  })
  if (!healthResponse.ok) return null

  // Search observations
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  })
  if (type) params.set("type", type)

  const searchResponse = await fetch(`${workerUrl}/api/search?${params}`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!searchResponse.ok) return null

  const data = await searchResponse.json() as {
    observations?: Array<{
      id: number
      type: string
      title: string | null
      narrative: string | null
      facts: string | string[]
      concepts: string | string[]
      created_at: string
    }>
    total?: number
  }

  const results: MemoryHit[] = (data.observations ?? []).map((obs) => ({
    id: obs.id,
    type: obs.type ?? "unknown",
    title: obs.title,
    narrative: obs.narrative,
    facts: parseArrayField(obs.facts),
    concepts: parseArrayField(obs.concepts),
    createdAt: obs.created_at,
  }))

  return {
    source: "claude-mem-worker",
    results,
    totalCount: data.total ?? results.length,
  }
}

/** Search via direct SQLite FTS5 query on the restored database */
async function searchViaSqlite(
  dataDir: string,
  query: string,
  limit: number,
  type?: string,
): Promise<MemorySearchResult | null> {
  const dbPath = await findClaudeMemDb(dataDir)
  if (!dbPath) return null

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync
  try {
    const mod = await import("node:sqlite")
    DatabaseSync = mod.DatabaseSync
  } catch {
    return null
  }

  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  try {
    return searchWithFts(db, query, limit, type)
  } catch {
    // FTS5 table may not exist, try LIKE fallback
    return searchWithLike(db, query, limit, type)
  } finally {
    db.close()
  }
}

/** FTS5 full-text search */
function searchWithFts(
  db: InstanceType<typeof import("node:sqlite").DatabaseSync>,
  query: string,
  limit: number,
  type?: string,
): MemorySearchResult {
  // Sanitize query for FTS5 (escape special characters)
  const ftsQuery = sanitizeFtsQuery(query)

  const typeFilter = type ? "AND o.type = ?" : ""
  const params: unknown[] = [ftsQuery, limit]
  if (type) params.splice(1, 0, type)

  const sql = `
    SELECT o.id, o.type, o.title, o.narrative, o.facts, o.concepts, o.created_at,
           rank
    FROM observations_fts fts
    JOIN observations o ON o.rowid = fts.rowid
    WHERE observations_fts MATCH ? ${typeFilter}
    ORDER BY rank
    LIMIT ?
  `
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number
    type: string
    title: string | null
    narrative: string | null
    facts: string | null
    concepts: string | null
    created_at: string
    rank: number
  }>

  const results: MemoryHit[] = rows.map((row) => ({
    id: row.id,
    type: row.type ?? "unknown",
    title: row.title,
    narrative: row.narrative,
    facts: parseJsonArray(row.facts),
    concepts: parseJsonArray(row.concepts),
    createdAt: row.created_at,
    score: -row.rank, // FTS5 rank is negative (lower = better)
  }))

  return {
    source: "sqlite-fts",
    results,
    totalCount: results.length,
  }
}

/** LIKE-based fallback search */
function searchWithLike(
  db: InstanceType<typeof import("node:sqlite").DatabaseSync>,
  query: string,
  limit: number,
  type?: string,
): MemorySearchResult {
  const likePattern = `%${query}%`
  const typeFilter = type ? "AND type = ?" : ""
  const params: unknown[] = [likePattern, likePattern, likePattern, limit]
  if (type) params.splice(3, 0, type)

  const sql = `
    SELECT id, type, title, narrative, facts, concepts, created_at
    FROM observations
    WHERE (title LIKE ? OR narrative LIKE ? OR facts LIKE ?) ${typeFilter}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number
    type: string
    title: string | null
    narrative: string | null
    facts: string | null
    concepts: string | null
    created_at: string
  }>

  const results: MemoryHit[] = rows.map((row) => ({
    id: row.id,
    type: row.type ?? "unknown",
    title: row.title,
    narrative: row.narrative,
    facts: parseJsonArray(row.facts),
    concepts: parseJsonArray(row.concepts),
    createdAt: row.created_at,
  }))

  return {
    source: "sqlite-like",
    results,
    totalCount: results.length,
  }
}

/** Find claude-mem database file in data directory */
async function findClaudeMemDb(dataDir: string): Promise<string | null> {
  const { stat: fsStat } = await import("node:fs/promises")

  // Check dataDir's memory/ subdirectory first (restored databases take precedence)
  const memoryDir = join(dataDir, "memory")
  try {
    const entries = await readdir(memoryDir)
    for (const entry of entries) {
      if (entry.endsWith(".sqlite") || entry.endsWith(".db")) {
        const fullPath = join(memoryDir, entry)
        await fsStat(fullPath)
        return fullPath
      }
    }
  } catch {
    // No memory directory or no matching files
  }

  // Fall back to well-known global path
  const homedir = (await import("node:os")).homedir()
  const defaultPath = join(homedir, ".claude-mem", "claude-mem.db")
  try {
    await fsStat(defaultPath)
    return defaultPath
  } catch {
    return null
  }
}

/** Sanitize a query string for FTS5 (escape double quotes, wrap words) */
function sanitizeFtsQuery(query: string): string {
  // Remove special FTS5 operators and wrap each word in quotes
  return query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word}"`)
    .join(" OR ")
}

function parseJsonArray(value: unknown): string[] {
  if (!value || typeof value !== "string") return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

function parseArrayField(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string")
  if (typeof value === "string") return parseJsonArray(value)
  return []
}
