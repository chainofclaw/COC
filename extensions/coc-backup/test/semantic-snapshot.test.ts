import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Dynamic import of node:sqlite (may not be available on all platforms)
let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null
try {
  const mod = await import("node:sqlite")
  DatabaseSync = mod.DatabaseSync
} catch {
  // node:sqlite not available — skip tests
}

import {
  captureSemanticSnapshot,
  readSemanticSnapshot,
} from "../src/backup/semantic-snapshot.ts"

const skipSqlite = DatabaseSync === null

function createTestDb(dbPath: string): void {
  if (!DatabaseSync) throw new Error("node:sqlite not available")

  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT,
      text TEXT,
      type TEXT,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER,
      created_at TEXT,
      created_at_epoch INTEGER,
      content_hash TEXT,
      generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER,
      created_at TEXT,
      created_at_epoch INTEGER
    );
  `)

  // Insert test observations
  const insertObs = db.prepare(`
    INSERT INTO observations (type, title, facts, narrative, concepts, project, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const now = Math.floor(Date.now() / 1000)

  insertObs.run("decision", "Added Redis caching", '["Reduced queries by 60%"]', "Implemented Redis to reduce DB load", '["redis","performance"]', "my-project", new Date().toISOString(), now)
  insertObs.run("discovery", "Found N+1 query bug", '["Dashboard loads 200 queries"]', "Discovered N+1 in user dashboard ORM", '["sql","orm"]', "my-project", new Date().toISOString(), now - 100)
  insertObs.run("pattern", "Repository pattern usage", '["All services use repos"]', "The codebase consistently uses repository pattern", '["architecture"]', "other-project", new Date().toISOString(), now - 200)

  // Insert test summaries
  const insertSum = db.prepare(`
    INSERT INTO session_summaries (request, learned, completed, next_steps, project, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  insertSum.run("Optimize database performance", "Redis caching + connection pool reduced latency 40%", "Implemented caching and pooling in production", "Monitor metrics, consider distributed caching", "my-project", new Date().toISOString(), now)
  insertSum.run("Fix dashboard loading", "N+1 query was caused by eager loading misconfiguration", "Added explicit includes to eliminate N+1", "Review other ORM queries for similar issues", "my-project", new Date().toISOString(), now - 100)

  db.close()
}

describe("semantic-snapshot", { skip: skipSqlite ? "node:sqlite not available" : false }, () => {
  let tmpDir: string

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coc-semantic-test-"))
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("captures observations and summaries from claude-mem database", async () => {
    const dbPath = join(tmpDir, "claude-mem.db")
    createTestDb(dbPath)

    const snapshot = await captureSemanticSnapshot(tmpDir, {
      enabled: true,
      tokenBudget: 8000,
      maxObservations: 50,
      maxSummaries: 10,
      claudeMemDbPath: dbPath,
    })

    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.observations.length, 3)
    assert.equal(snapshot.summaries.length, 2)
    assert.ok(snapshot.tokensUsed > 0)
    assert.ok(snapshot.tokensUsed <= snapshot.tokenBudget)

    // Verify observation structure
    const firstObs = snapshot.observations[0]
    assert.equal(firstObs.type, "decision")
    assert.equal(firstObs.title, "Added Redis caching")
    assert.deepEqual(firstObs.facts, ["Reduced queries by 60%"])
    assert.deepEqual(firstObs.concepts, ["redis", "performance"])

    // Verify summary structure
    const firstSum = snapshot.summaries[0]
    assert.equal(firstSum.request, "Optimize database performance")
    assert.ok(firstSum.learned?.includes("Redis"))

    // Verify active projects
    assert.ok(snapshot.activeProjects.includes("my-project"))
    assert.ok(snapshot.activeProjects.includes("other-project"))
  })

  it("respects token budget by truncating entries", async () => {
    const dbPath = join(tmpDir, "claude-mem-small-budget.db")
    createTestDb(dbPath)

    const snapshot = await captureSemanticSnapshot(tmpDir, {
      enabled: true,
      tokenBudget: 50, // Very small budget
      maxObservations: 50,
      maxSummaries: 10,
      claudeMemDbPath: dbPath,
    })

    // Should have fewer entries than the database contains
    const totalEntries = snapshot.observations.length + snapshot.summaries.length
    assert.ok(totalEntries < 5, `Expected fewer than 5 entries with tiny budget, got ${totalEntries}`)
    assert.ok(snapshot.tokensUsed <= 50)
  })

  it("writes snapshot to disk and reads it back", async () => {
    const dbPath = join(tmpDir, "claude-mem-rw.db")
    createTestDb(dbPath)

    const baseDir = join(tmpDir, "rw-test")
    await mkdir(baseDir, { recursive: true })

    await captureSemanticSnapshot(baseDir, {
      enabled: true,
      tokenBudget: 8000,
      maxObservations: 50,
      maxSummaries: 10,
      claudeMemDbPath: dbPath,
    })

    // Verify file exists
    const content = await readFile(join(baseDir, ".coc-backup", "semantic-snapshot.json"), "utf8")
    const parsed = JSON.parse(content)
    assert.equal(parsed.version, 1)

    // Read back via helper
    const readBack = await readSemanticSnapshot(baseDir)
    assert.ok(readBack !== null)
    assert.equal(readBack!.version, 1)
    assert.ok(readBack!.observations.length > 0)
  })

  it("degrades gracefully when database does not exist", async () => {
    const baseDir = join(tmpDir, "no-db-test")
    await mkdir(baseDir, { recursive: true })

    const snapshot = await captureSemanticSnapshot(baseDir, {
      enabled: true,
      tokenBudget: 8000,
      maxObservations: 50,
      maxSummaries: 10,
      claudeMemDbPath: "/nonexistent/path/to/db.sqlite",
    })

    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.observations.length, 0)
    assert.equal(snapshot.summaries.length, 0)
    assert.equal(snapshot.tokensUsed, 0)
  })

  it("returns empty snapshot when disabled", async () => {
    const baseDir = join(tmpDir, "disabled-test")
    await mkdir(baseDir, { recursive: true })

    const snapshot = await captureSemanticSnapshot(baseDir, {
      enabled: false,
      tokenBudget: 8000,
      maxObservations: 50,
      maxSummaries: 10,
      claudeMemDbPath: "",
    })

    assert.equal(snapshot.observations.length, 0)
    assert.equal(snapshot.summaries.length, 0)
  })

  it("readSemanticSnapshot returns null for missing file", async () => {
    const baseDir = join(tmpDir, "missing-snapshot-test")
    await mkdir(baseDir, { recursive: true })

    const result = await readSemanticSnapshot(baseDir)
    assert.equal(result, null)
  })
})
